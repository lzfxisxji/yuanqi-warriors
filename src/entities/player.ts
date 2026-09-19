/** 玩家：移动、瞄准、射击状态、两名武器槽、主动技能、护盾/无敌帧。 */
import { TAU, clamp, normalize } from '../core/math';
import type { DamageResult, Team } from '../core/types';
import { OUT_OF_COMBAT_DELAY, PLAYER_ACCEL, PLAYER_FRICTION, PLAYER_IFRAME, PLAYER_RADIUS } from '../data/config';
import type { CharacterDef } from '../data/characters';
import type { Mods } from '../data/upgrades';
import { defaultMods } from '../data/upgrades';
import type { WeaponDef } from '../data/weapons';
import { getWeaponDef } from '../data/weapons';
import type { Room } from '../dungeon/room';
import type { HitOptions } from '../systems/combat';
import { moveCircle } from '../systems/collision';
import { Entity } from './entity';

export type PlayerState = 'idle' | 'run' | 'dash' | 'hurt' | 'dead';

export interface WeaponInstance {
  def: WeaponDef;
  ammo: number;
  magSize: number;
  /** 距离下次可击发的剩余时间 */
  cooldown: number;
  /** 换弹剩余时间，>0 表示正在换弹 */
  reloadTimer: number;
  /** 视觉后坐 0..1 */
  recoil: number;
  /** 累计发射数，用于交替抛壳等视觉细节 */
  shotsFired: number;
}

export function createWeaponInstance(defId: string, mods: Mods = defaultMods()): WeaponInstance {
  const def = getWeaponDef(defId);
  const magSize = Math.max(1, Math.round(def.mag * mods.magMul));
  return {
    def,
    ammo: magSize,
    magSize,
    cooldown: 0,
    reloadTimer: 0,
    recoil: 0,
    shotsFired: 0,
  };
}

export class Player extends Entity {
  readonly def: CharacterDef;
  mods: Mods = defaultMods();
  /** 阵营：单人/合作模式为 'player'（联机合作时为 'heroes'）；PK 模式为各自 peerId。 */
  override team: Team = 'player';

  /** 联机模式下用于渲染的身份信息（单人模式为 undefined）。 */
  netName?: string;
  netColor?: string;
  /** 联机记分（击杀 + 目标达成分）。 */
  score = 0;

  weapons: WeaponInstance[] = [];
  weaponIndex = 0;

  /** 护盾：由强化提供，脱战后自然回复 */
  shield = 0;
  maxShield = 0;
  /** 技能产生的临时壁垒 */
  barrier = 0;

  aimAngle = 0;
  moveAngle = -Math.PI / 2;
  moving = false;
  walkPhase = 0;
  state: PlayerState = 'idle';
  hurtTimer = 0;
  deathTimer = 0;
  iframe = 0;
  attackTimer = 0;
  /** 攻击前摇计时（用于美术的蓄力动作） */
  chargeTimer = 0;

  /** 技能状态 */
  skillCooldown = 0;
  skillActiveTimer = 0;
  dashTimer = 0;
  dashDirX = 0;
  dashDirY = 0;
  barrierActiveTimer = 0;

  timeSinceDamage = 99;
  /** 上一帧是否真的在靠「脱战回复」回血（HUD 用来显示提示） */
  regening = false;
  /** 本次远征统计 */
  kills = 0;
  damageDealt = 0;
  damageTaken = 0;
  shotsFired = 0;

  /** 由武器系统每帧写入，用于渲染激光束 */
  beamActive = false;
  beamEndX = 0;
  beamEndY = 0;
  beamWidth = 6;
  beamCore = '#ffffff';
  beamGlow = '#ff7ae0';

  /** 拾取物磁力范围加成 */
  pickupBonus = 0;

  constructor(def: CharacterDef) {
    super();
    this.def = def;
    this.radius = PLAYER_RADIUS;
    this.maxHp = def.maxHp;
    this.hp = def.maxHp;
    this.maxShield = def.maxShield;
    this.shield = def.startShield;
    this.weapons = [createWeaponInstance(def.startWeapon)];
    this.weaponIndex = 0;
  }

  get currentWeapon(): WeaponInstance {
    return this.weapons[this.weaponIndex]!;
  }

  /** 重新按 mods 计算派生属性（获得强化后调用）。 */
  refreshFromMods(mods: Mods, keepHpRatio = true): void {
    const ratio = this.maxHp > 0 ? this.hp / this.maxHp : 1;
    this.mods = mods;
    const newMaxHp = Math.round((this.def.maxHp + mods.maxHpAdd) * mods.maxHpMul);
    this.maxHp = newMaxHp;
    this.hp = keepHpRatio ? clamp(Math.round(newMaxHp * ratio), 1, newMaxHp) : clamp(this.hp, 1, newMaxHp);
    this.maxShield = this.def.maxShield + mods.shieldAdd;
    this.shield = clamp(this.shield, 0, this.maxShield);
    for (const w of this.weapons) {
      const target = Math.max(1, Math.round(w.def.mag * mods.magMul));
      if (target !== w.magSize) {
        const diff = target - w.magSize;
        w.magSize = target;
        w.ammo = clamp(w.ammo + Math.max(0, diff), 0, target);
      }
    }
  }

  get maxHpTotal(): number {
    return this.maxHp;
  }

  get speed(): number {
    let s = this.def.speed * this.mods.speedMul * this.currentWeapon.def.moveSpeedMul;
    if (this.skillActiveTimer > 0 && this.def.skill.kind === 'overdrive') {
      s *= this.def.skill.speedMul ?? 1;
    }
    return s;
  }

  get dodgeChance(): number {
    let d = this.def.baseDodge + this.mods.dodgeAdd;
    if (this.skillActiveTimer > 0 && this.def.skill.kind === 'overdrive') {
      d += this.def.skill.dodgeBonus ?? 0;
    }
    return clamp(d, 0, 0.85);
  }

  get invulnerable(): boolean {
    if (this.iframe > 0) return true;
    if (this.dashTimer > 0 && this.def.skill.invulnerable) return true;
    return false;
  }

  /** 总有效血量，用于 UI 上限展示。 */
  get totalShield(): number {
    return this.shield + this.barrier;
  }

  swapWeapon(index: number): boolean {
    if (index < 0 || index >= this.weapons.length) return false;
    if (index === this.weaponIndex) return false;
    this.weaponIndex = index;
    const w = this.currentWeapon;
    w.reloadTimer = 0;
    // 换枪有个很短的举枪时间，避免瞬切过强
    w.cooldown = Math.max(w.cooldown, 0.22);
    this.attackTimer = 0.2;
    return true;
  }

  addOrReplaceWeapon(defId: string): void {
    if (this.weapons.length < 2) {
      this.weapons.push(createWeaponInstance(defId, this.mods));
      this.swapWeapon(this.weapons.length - 1);
      return;
    }
    // 替换当前武器，新武器装满弹
    const inst = createWeaponInstance(defId, this.mods);
    this.weapons[this.weaponIndex] = inst;
    this.attackTimer = 0.25;
  }

  startReload(): void {
    const w = this.currentWeapon;
    if (w.reloadTimer > 0) return;
    if (w.ammo >= w.magSize) return;
    w.reloadTimer = Math.max(0.15, w.def.reloadTime * this.mods.reloadMul);
    w.recoil = 0;
  }

  canFire(): boolean {
    if (this.dead) return false;
    const w = this.currentWeapon;
    if (w.reloadTimer > 0) return false;
    if (w.cooldown > 0) return false;
    if (w.ammo <= 0) {
      this.startReload();
      return false;
    }
    return true;
  }

  consumeShot(cost = 1): void {
    const w = this.currentWeapon;
    w.ammo = Math.max(0, w.ammo - cost);
    const rate = w.def.fireRate * this.mods.fireRateMul;
    w.cooldown = 1 / Math.max(0.05, rate);
    w.recoil = 1;
    w.shotsFired += 1;
    this.attackTimer = Math.min(0.16, 0.06 + w.def.recoil * 0.09);
    this.shotsFired += 1;
    if (w.ammo <= 0) this.startReload();
  }

  /** 激光类持续消耗弹药，返回是否成功消耗。 */
  drainAmmoPerSecond(dt: number, perSecond: number): boolean {
    const w = this.currentWeapon;
    if (w.reloadTimer > 0) return false;
    const cost = perSecond * dt;
    if (w.ammo <= cost) {
      w.ammo = 0;
      this.startReload();
      return false;
    }
    w.ammo -= cost;
    w.recoil = Math.min(1, w.recoil + dt * 6);
    return true;
  }

  useSkill(): boolean {
    if (this.dead || this.skillCooldown > 0) return false;
    const s = this.def.skill;
    this.skillCooldown = Math.max(0.4, s.cooldown * this.mods.skillCdMul);
    this.skillActiveTimer = s.duration;
    switch (s.kind) {
      case 'dash': {
        const dir = this.moving ? { x: Math.cos(this.moveAngle), y: Math.sin(this.moveAngle) } : normalize(Math.cos(this.aimAngle), Math.sin(this.aimAngle));
        const n = normalize(dir.x, dir.y);
        this.dashDirX = n.x === 0 && n.y === 0 ? 1 : n.x;
        this.dashDirY = n.y;
        this.dashTimer = s.duration;
        this.iframe = Math.max(this.iframe, s.duration + 0.06);
        break;
      }
      case 'overdrive':
        break;
      case 'barrier':
        this.barrier += s.shieldAmount ?? 0;
        this.barrierActiveTimer = s.duration;
        break;
    }
    return true;
  }

  applyDamage(amount: number, opts: HitOptions): DamageResult {
    if (this.dead) {
      return { applied: 0, crit: opts.crit, killed: false, blocked: true, dodged: false };
    }
    if (this.invulnerable) {
      return { applied: 0, crit: opts.crit, killed: false, blocked: true, dodged: false };
    }
    const dodge = this.dodgeChance;
    if (dodge > 0 && Math.random() < dodge) {
      this.iframe = Math.max(this.iframe, 0.16);
      return { applied: 0, crit: false, killed: false, blocked: true, dodged: true };
    }

    let remaining = amount;
    if (this.barrier > 0) {
      const absorbed = Math.min(this.barrier, remaining);
      this.barrier -= absorbed;
      remaining -= absorbed;
    }
    if (remaining > 0 && this.shield > 0) {
      const absorbed = Math.min(this.shield, remaining);
      this.shield -= absorbed;
      remaining -= absorbed;
    }
    if (remaining > 0) {
      this.hp = Math.max(0, this.hp - remaining);
      this.iframe = Math.max(this.iframe, PLAYER_IFRAME);
      this.timeSinceDamage = 0;
    } else {
      this.timeSinceDamage = Math.min(this.timeSinceDamage, 0.6);
    }

    this.hitFlash = Math.max(this.hitFlash, 0.24);
    this.hitFlashColor = '#ffffff';
    this.hurtTimer = 0.34;
    this.damageTaken += amount;

    if (this.hp <= 0) {
      this.dead = true;
      this.state = 'dead';
      this.deathTimer = 0;
    }
    return { applied: amount - remaining, crit: false, killed: this.dead, blocked: false, dodged: false };
  }

  heal(amount: number): void {
    this.hp = clamp(this.hp + amount, 0, this.maxHp);
  }

  addShield(amount: number): void {
    this.shield = clamp(this.shield + amount, 0, this.maxShield);
  }

  addMaxHp(amount: number): void {
    this.def.maxHp += 0;
    this.mods = { ...this.mods, maxHpAdd: this.mods.maxHpAdd + amount };
    const newMax = Math.round((this.def.maxHp + this.mods.maxHpAdd) * this.mods.maxHpMul);
    this.maxHp = newMax;
    this.hp = clamp(this.hp + amount, 0, newMax);
  }

  /** 是否已脱离战斗（最后一次受伤后平静了 OUT_OF_COMBAT_DELAY 秒）。 */
  get outOfCombat(): boolean {
    return !this.dead && this.timeSinceDamage > OUT_OF_COMBAT_DELAY;
  }

  updateTimers(dt: number): void {
    if (this.dead) {
      this.deathTimer += dt;
      this.regening = false;
      this.updateCommon(dt);
      return;
    }
    this.iframe = Math.max(0, this.iframe - dt);
    this.skillCooldown = Math.max(0, this.skillCooldown - dt);
    this.skillActiveTimer = Math.max(0, this.skillActiveTimer - dt);
    this.attackTimer = Math.max(0, this.attackTimer - dt);
    this.hurtTimer = Math.max(0, this.hurtTimer - dt);
    this.chargeTimer = Math.max(0, this.chargeTimer - dt);
    this.timeSinceDamage += dt;
    for (const w of this.weapons) {
      w.cooldown = Math.max(0, w.cooldown - dt);
      w.recoil = Math.max(0, w.recoil - dt * 5.4);
      if (w.reloadTimer > 0) {
        w.reloadTimer -= dt;
        if (w.reloadTimer <= 0) {
          w.reloadTimer = 0;
          w.ammo = w.magSize;
        }
      }
    }
    if (this.barrierActiveTimer > 0) {
      this.barrierActiveTimer -= dt;
      if (this.barrierActiveTimer <= 0) this.barrier = 0;
    }
    // 脱战回复：生命与护盾共用同一套「脱战」判定
    const outOfCombat = this.outOfCombat;
    this.regening = false;
    if (outOfCombat && this.mods.healthRegen > 0 && this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + this.mods.healthRegen * dt);
      this.regening = true;
    }
    if (outOfCombat && this.mods.shieldRegen > 0 && this.shield < this.maxShield) {
      this.shield = Math.min(this.maxShield, this.shield + this.mods.shieldRegen * dt);
    }
    this.updateCommon(dt);
  }

  updateMovement(dt: number, input: { x: number; y: number }, room: Room): void {
    if (this.dead) {
      this.decayVelocity(dt);
      this.integrate(dt, room);
      return;
    }

    if (this.dashTimer > 0) {
      this.dashTimer = Math.max(0, this.dashTimer - dt);
      const dashSpeed = this.def.skill.dashSpeed ?? 900;
      const ease = this.dashTimer / Math.max(0.001, this.def.skill.duration);
      const speed = dashSpeed * (0.55 + 0.45 * ease);
      this.vx = this.dashDirX * speed;
      this.vy = this.dashDirY * speed;
      this.moving = true;
    } else {
      const wantX = input.x * this.speed;
      const wantY = input.y * this.speed;
      const accel = PLAYER_ACCEL * dt;
      if (input.x === 0 && input.y === 0) {
        const friction = PLAYER_FRICTION * dt;
        this.vx = this.vx > 0 ? Math.max(0, this.vx - friction) : Math.min(0, this.vx + friction);
        this.vy = this.vy > 0 ? Math.max(0, this.vy - friction) : Math.min(0, this.vy + friction);
      } else {
        const dx = wantX - this.vx;
        const dy = wantY - this.vy;
        const dl = Math.hypot(dx, dy);
        if (dl <= accel) {
          this.vx = wantX;
          this.vy = wantY;
        } else {
          this.vx += (dx / dl) * accel;
          this.vy += (dy / dl) * accel;
        }
        this.moveAngle = Math.atan2(input.y, input.x);
      }
      this.moving = Math.hypot(this.vx, this.vy) > 12;
    }

    this.walkPhase += dt * (this.moving ? Math.hypot(this.vx, this.vy) * 0.028 + 3.2 : 0);
    this.integrate(dt, room);
    this.updateState();
  }

  private decayVelocity(dt: number): void {
    const damp = Math.exp(-6 * dt);
    this.vx *= damp;
    this.vy *= damp;
  }

  private integrate(dt: number, room: Room): void {
    const mx = (this.vx + this.knockVx) * dt;
    const my = (this.vy + this.knockVy) * dt;
    moveCircle(this, room, mx, my);
  }

  private updateState(): void {
    if (this.dead) {
      this.state = 'dead';
      return;
    }
    if (this.hurtTimer > 0.12) {
      this.state = 'hurt';
      return;
    }
    if (this.dashTimer > 0) {
      this.state = 'dash';
      return;
    }
    this.state = this.moving ? 'run' : 'idle';
  }

  /** 是否处于技能的持续生效状态（HUD 用）。 */
  get skillActivePercent(): number {
    const s = this.def.skill;
    if (this.skillActiveTimer <= 0) return 0;
    return this.skillActiveTimer / s.duration;
  }

  get skillReadyPercent(): number {
    const s = this.def.skill;
    const cd = Math.max(0.4, s.cooldown * this.mods.skillCdMul);
    if (this.skillCooldown <= 0) return 1;
    return clamp(1 - this.skillCooldown / cd, 0, 1);
  }

  /** 枪口世界坐标（沿瞄准方向从身体中心偏移）。 */
  muzzlePosition(): { x: number; y: number } {
    const dist = this.radius + 20;
    return {
      x: this.x + Math.cos(this.aimAngle) * dist,
      y: this.y + Math.sin(this.aimAngle) * dist - 2,
    };
  }

  /** 供美术使用的枪口角度（含轻微摆动）。 */
  get visualAimAngle(): number {
    const sway = this.moving ? Math.sin(this.walkPhase * 0.5) * 0.035 : 0;
    return this.aimAngle + sway;
  }

  get angleToFacingBody(): number {
    return this.aimAngle;
  }
}

export const PLAYER_CONSTANTS = { TAU, PLAYER_RADIUS };
