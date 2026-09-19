/**
 * 敌人：数据驱动的状态机 AI。
 * 状态流转：Idle → Detect → Chase/Position → Windup(前摇) → Attack → Cooldown → Hit → Dead
 * 每种 AI 行为都在 performAttack / updateMovement 中体现差异，而不是只改数值。
 */
import { TAU, RNG, angleTo, clamp, dist, normalize } from '../core/math';
import type { DamageResult } from '../core/types';
import type { EnemyDef, EnemyState } from '../data/enemies';
import { scaledHp, scaledProjectileDamage } from '../data/enemies';
import type { ProjectileSpec } from './projectile';
import type { Player } from './player';
import type { Room } from '../dungeon/room';
import { moveCircle, separateCircles, steerAroundObstacles } from '../systems/collision';
import type { DamageContext, HitOptions } from '../systems/combat';
import { Entity } from './entity';

export interface EnemyWorld {
  /** 场上所有玩家（单人模式长度为 1）。敌人/首领对全部玩家索敌、攻击。 */
  players: Player[];
  /** 选取距离 (x, y) 最近的存活玩家；若无存活玩家则返回玩家列表中的第一个。 */
  focusAt(x: number, y: number): Player;
  room: Room;
  ctx: DamageContext;
  rng: RNG;
  floor: number;
  spawnProjectile(spec: ProjectileSpec): void;
  spawnMinion(defId: string, x: number, y: number): void;
  enemies: Enemy[];
}

const CONTACT_RANGE_PAD = 6;

export class Enemy extends Entity {
  readonly def: EnemyDef;
  state: EnemyState = 'idle';
  stateTime = 0;
  /** 攻击冷却计时 */
  attackTimer = 0;
  /** 前摇进度 0..1（渲染预警用） */
  telegraph = 0;
  /** 是否已经触发过索敌 */
  aware = false;
  /** 命中后短暂硬直 */
  stagger = 0;
  /** 蓄力后的冲刺方向 */
  chargeDirX = 0;
  chargeDirY = 0;
  chargeTimer = 0;
  /** 本次攻击的连发计数 */
  burstLeft = 0;
  burstTimer = 0;
  /** 召唤计时 */
  summonTimer = 0;
  /** 保持距离时选择的环绕方向 */
  strafeDir = 1;
  strafeTimer = 0;
  /** 燃烧状态 */
  burnDps = 0;
  burnTimer = 0;
  /** 累计承受伤害（统计用） */
  damageTaken = 0;
  /** 死亡动画计时，由场景在动画结束后回收 */
  deathTimer = 0;
  deathHandled = false;
  /** 上一帧位置（用于判断冲锋是否撞墙） */
  private prevX = 0;
  private prevY = 0;
  /** 出场闪现（刷怪时的出现动画） */
  spawnTimer = 0.45;
  /** 特殊标记：精英/Boss 使用 */
  isElite: boolean;
  /** 联机快照用的稳定 id（由场景分配，仅用于远端匹配，不影响模拟）。 */
  netId = 0;

  constructor(def: EnemyDef, x: number, y: number, floor: number) {
    super();
    this.def = def;
    this.x = x;
    this.y = y;
    this.radius = def.radius;
    this.maxHp = scaledHp(def, floor);
    this.hp = this.maxHp;
    this.team = 'enemy';
    this.knockbackResist = def.knockbackResist;
    this.isElite = def.elite;
    this.attackTimer = def.attackCooldown * (0.35 + Math.random() * 0.5);
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeTimer = 1 + Math.random() * 1.5;
    this.facing = Math.PI / 2;
  }

  applyDamage(amount: number, opts: HitOptions): DamageResult {
    if (this.dead) return { applied: 0, crit: opts.crit, killed: false, blocked: true, dodged: false };
    this.hp -= amount;
    this.damageTaken += amount;
    this.hitFlash = Math.max(this.hitFlash, 0.16);
    this.hitFlashColor = '#ffffff';
    if (opts.knockback > 0) {
      this.applyKnockback(opts.dirX, opts.dirY, opts.knockback);
    }
    // 受伤硬直（精英与 Boss 抗性更高）
    const staggerTime = this.def.elite ? 0.04 : 0.1;
    if (this.state !== 'windup' || this.def.elite) {
      this.stagger = Math.max(this.stagger, staggerTime);
    }

    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      this.state = 'dead';
      this.deathTimer = 0;
      return { applied: amount, crit: opts.crit, killed: true, blocked: false, dodged: false };
    }
    return { applied: amount, crit: opts.crit, killed: false, blocked: false, dodged: false };
  }

  applyBurn(dps: number, duration: number): void {
    this.burnDps = Math.max(this.burnDps, dps);
    this.burnTimer = Math.max(this.burnTimer, duration);
  }

  get isRanged(): boolean {
    return !!this.def.projectile;
  }

  /** 中心到玩家的水平角 */
  angleToPlayer(player: Player): number {
    return angleTo(this.x, this.y, player.x, player.y);
  }

  update(dt: number, world: EnemyWorld): void {
    this.prevX = this.x;
    this.prevY = this.y;
    if (this.spawnTimer > 0) this.spawnTimer = Math.max(0, this.spawnTimer - dt);
    this.updateCommon(dt, this.def.elite ? 4.5 : 6.5);

    // 燃烧持续伤害
    if (this.burnTimer > 0 && !this.dead) {
      this.burnTimer -= dt;
      const tick = this.burnDps * dt;
      this.hp -= tick;
      this.damageTaken += tick;
      if (Math.random() < dt * 14) {
        world.ctx.particles.spawn({
          kind: 'flame',
          x: this.x + (Math.random() - 0.5) * this.radius * 1.4,
          y: this.y + (Math.random() - 0.5) * this.radius * 1.2,
          vx: (Math.random() - 0.5) * 24,
          vy: -46 - Math.random() * 40,
          life: 0.28,
          size: 5 + Math.random() * 5,
          sizeEnd: 1,
          color: '#ffb14a',
          alpha0: 0.8,
          alpha1: 0,
          drag: 2.2,
        });
      }
      if (this.hp <= 0) {
        this.hp = 0;
        this.dead = true;
        this.state = 'dead';
        this.deathTimer = 0;
      }
    }

    if (this.dead) {
      this.deathTimer += dt;
      this.decayVelocity(dt);
      this.integrate(dt, world.room);
      return;
    }

    if (this.stagger > 0) {
      this.stagger = Math.max(0, this.stagger - dt);
    }
    if (this.attackTimer > 0) this.attackTimer = Math.max(0, this.attackTimer - dt);
    if (this.strafeTimer > 0) this.strafeTimer -= dt;
    else {
      this.strafeTimer = 1.2 + world.rng.range(0, 1.6);
      this.strafeDir = world.rng.chance(0.5) ? 1 : -1;
    }
    if (this.summonTimer > 0) this.summonTimer -= dt;
    this.stateTime += dt;

    this.updateAI(dt, world);
    this.integrate(dt, world.room);
  }

  private decayVelocity(dt: number): void {
    const damp = Math.exp(-5 * dt);
    this.vx *= damp;
    this.vy *= damp;
  }

  private integrate(dt: number, room: Room): void {
    moveCircle(this, room, (this.vx + this.knockVx) * dt, (this.vy + this.knockVy) * dt);
  }

  private setState(next: EnemyState): void {
    if (this.state === next) return;
    this.state = next;
    this.stateTime = 0;
  }

  private updateAI(dt: number, world: EnemyWorld): void {
    const player = world.focusAt(this.x, this.y);
    const d = dist(this.x, this.y, player.x, player.y);

    switch (this.state) {
      case 'idle':
        this.vx *= 0.86;
        this.vy *= 0.86;
        if (this.detect(player, d)) {
          this.aware = true;
          this.setState('detect');
        }
        break;

      case 'detect': {
        this.vx *= 0.8;
        this.vy *= 0.8;
        this.facing = this.angleToPlayer(player);
        if (this.stateTime > 0.28) this.setState(this.isRanged ? 'position' : 'chase');
        break;
      }

      case 'chase':
        this.moveToward(player.x, player.y, this.def.speed, dt, world);
        this.facing = this.angleToPlayer(player);
        if (this.def.ai === 'melee') {
          if (d < this.radius + player.radius + CONTACT_RANGE_PAD && this.attackTimer <= 0) {
            this.setState('windup');
          }
        } else if (this.def.ai === 'charger') {
          if (d < 340 && this.attackTimer <= 0 && this.hasLineOfSight(world, player)) {
            this.chargeDirX = Math.cos(this.angleToPlayer(player));
            this.chargeDirY = Math.sin(this.angleToPlayer(player));
            this.setState('windup');
          }
        } else if (this.def.ai === 'brute') {
          if (d < 480 && this.attackTimer <= 0) this.setState('windup');
          if (d < this.radius + player.radius + CONTACT_RANGE_PAD && this.attackTimer <= 0) this.setState('windup');
        } else if (this.isRanged) {
          this.setState('position');
        }
        break;

      case 'position': {
        // 保持理想距离并环绕
        const keep = this.def.keepRange;
        const ang = this.angleToPlayer(player);
        const perp = ang + Math.PI / 2;
        let dirX = 0;
        let dirY = 0;
        if (keep > 0) {
          if (d > keep + 34) {
            dirX += Math.cos(ang);
            dirY += Math.sin(ang);
          } else if (d < keep - 44) {
            dirX -= Math.cos(ang) * 1.25;
            dirY -= Math.sin(ang) * 1.25;
          }
        } else if (d > 150) {
          dirX += Math.cos(ang);
          dirY += Math.sin(ang);
        }
        dirX += Math.cos(perp) * this.strafeDir * 0.72;
        dirY += Math.sin(perp) * this.strafeDir * 0.72;
        const n = normalize(dirX, dirY);
        this.applyVelocity(n.x * this.def.speed, n.y * this.def.speed, dt, 6);
        this.facing = ang;

        const inRange = d < Math.max(this.def.detectRange, keep + 130);
        if (this.attackTimer <= 0 && inRange && this.hasLineOfSight(world, player)) {
          this.setState('windup');
        }
        break;
      }

      case 'windup': {
        const w = this.def.windup;
        this.telegraph = clamp(this.stateTime / Math.max(0.05, w), 0, 1);
        // 前摇期间移动速度显著下降（重型敌人几乎停住），给玩家躲避窗口
        const slow = this.def.elite ? 0.16 : 0.3;
        this.vx *= 1 - slow * dt * 8;
        this.vy *= 1 - slow * dt * 8;
        if (this.isRanged || this.def.ai === 'brute') {
          this.facing = this.angleToPlayer(player);
        }
        if (this.def.ai === 'charger') {
          // 冲锋方向在蓄力前半段会缓慢跟随玩家，后半段锁定
          if (this.stateTime < w * 0.55) {
            const ang = this.angleToPlayer(player);
            this.chargeDirX = Math.cos(ang);
            this.chargeDirY = Math.sin(ang);
          }
          this.facing = Math.atan2(this.chargeDirY, this.chargeDirX);
        }
        if (this.stateTime >= w) {
          this.setState('attack');
          this.performAttack(world, player);
        }
        break;
      }

      case 'attack': {
        switch (this.def.ai) {
          case 'melee': {
            const ang = this.angleToPlayer(player);
            this.vx = Math.cos(ang) * this.def.speed * 2.05;
            this.vy = Math.sin(ang) * this.def.speed * 2.05;
            if (this.stateTime > 0.32) this.setState('cooldown');
            break;
          }
          case 'charger': {
            this.chargeTimer -= dt;
            const dash = this.def.dashSpeed ?? 420;
            this.vx = this.chargeDirX * dash;
            this.vy = this.chargeDirY * dash;
            const moved = Math.hypot(this.x - this.prevX, this.y - this.prevY);
            if (this.chargeTimer <= 0) {
              this.setState('cooldown');
              world.ctx.particles.dust(this.x, this.y, 6);
            } else if (moved < 0.35) {
              // 撞墙：进入更长的硬直，给玩家惩罚窗口
              this.setState('cooldown');
              this.stagger = 0.28;
              world.ctx.particles.dust(this.x, this.y, 9);
              world.ctx.particles.hitSparks(this.x, this.y, this.facing + Math.PI, '#ffcf8a', 7, 1.1);
              world.ctx.shake.add(0.16);
            }
            break;
          }
          case 'brute': {
            if (this.burstLeft > 0) {
              this.burstTimer -= dt;
              if (this.burstTimer <= 0) {
                this.burstTimer = 0.28;
                this.burstLeft -= 1;
                this.fireRing(world, this.burstLeft % 2 === 0 ? 0 : 0.26);
              }
            } else {
              this.setState('cooldown');
            }
            break;
          }
          default: {
            if (this.burstLeft > 0) {
              this.burstTimer -= dt;
              if (this.burstTimer <= 0) {
                this.burstTimer = this.def.burstDelay ?? 0.15;
                this.burstLeft -= 1;
                this.firePattern(world, player, this.burstLeft);
              }
            } else {
              this.setState('cooldown');
            }
            break;
          }
        }
        break;
      }

      case 'cooldown': {
        this.vx *= 0.9;
        this.vy *= 0.9;
        if (this.stateTime > this.def.recover) {
          this.attackTimer = this.def.attackCooldown * world.rng.range(0.85, 1.2);
          this.setState(this.isRanged ? 'position' : 'chase');
        }
        break;
      }

      case 'hit': {
        if (this.stateTime > 0.12) this.setState(this.isRanged ? 'position' : 'chase');
        break;
      }

      case 'dead':
        break;
    }

    // 短暂无敌帧闪避后重新索敌
    if (!this.aware && this.detect(player, d)) {
      this.aware = true;
      if (this.state === 'idle') this.setState('detect');
    }
  }

  private detect(player: Player, d: number): boolean {
    if (this.def.awareness === 'room') {
      // 全房索敌：进入房间即被激活
      return d < 2200;
    }
    if (d < this.def.detectRange) return true;
    // 被打了也会醒
    return this.hitFlash > 0;
  }

  private hasLineOfSight(world: EnemyWorld, player: Player): boolean {
    const hit = world.room.raycastStatic(this.x, this.y, player.x, player.y, 20);
    return hit === null;
  }

  private applyVelocity(wx: number, wy: number, dt: number, accel = 8): void {
    const k = 1 - Math.exp(-accel * dt);
    this.vx += (wx - this.vx) * k;
    this.vy += (wy - this.vy) * k;
  }

  private moveToward(tx: number, ty: number, speed: number, dt: number, world: EnemyWorld): void {
    const dir = steerAroundObstacles(world.room, this.x, this.y, tx, ty, this.radius);
    this.applyVelocity(dir.x * speed, dir.y * speed, dt, 7);
  }

  private performAttack(world: EnemyWorld, player: Player): void {
    switch (this.def.ai) {
      case 'melee':
        this.vx = Math.cos(this.angleToPlayer(player)) * this.def.speed * 1.6;
        this.vy = Math.sin(this.angleToPlayer(player)) * this.def.speed * 1.6;
        break;
      case 'charger':
        this.chargeTimer = 0.5;
        world.ctx.audio.play('dash', 0.5);
        break;
      case 'single':
        this.firePattern(world, player, 0);
        break;
      case 'burst3':
        this.burstLeft = this.def.burstCount ?? 3;
        this.burstTimer = 0;
        break;
      case 'fan':
        this.firePattern(world, player, 0);
        break;
      case 'ring':
        this.fireRing(world, 0);
        break;
      case 'kiter': {
        this.firePattern(world, player, 0);
        if (this.def.summon && this.summonTimer <= 0) {
          this.summonTimer = 6.5;
          for (let i = 0; i < this.def.summon.count; i++) {
            const ang = world.rng.next() * TAU;
            const sx = clamp(this.x + Math.cos(ang) * (this.radius + 34), 48, 1296);
            const sy = clamp(this.y + Math.sin(ang) * (this.radius + 34), 48, 816);
            world.spawnMinion(this.def.summon.enemyId, sx, sy);
          }
          world.ctx.audio.play('summon', 0.8);
          world.ctx.particles.shockwave(this.x, this.y, this.radius * 3.4, '#7fd8ff', 0.5);
        }
        break;
      }
      case 'brute': {
        const roll = world.rng.next();
        if (roll < 0.5) {
          this.burstLeft = 2;
          this.burstTimer = 0.3;
          this.fireRing(world, 0);
        } else {
          this.chargeDirX = Math.cos(this.angleToPlayer(player));
          this.chargeDirY = Math.sin(this.angleToPlayer(player));
          this.chargeTimer = 0.52;
          world.ctx.audio.play('dash', 0.6);
        }
        break;
      }
    }
  }

  /** 按定义发射一轮弹幕。burstIndex 用于三连发的轻微角度偏移。 */
  private firePattern(world: EnemyWorld, player: Player, burstIndex: number): void {
    const proj = this.def.projectile;
    if (!proj) return;
    const base = this.angleToPlayer(player) + burstIndex * 0.035;
    const dmg = scaledProjectileDamage(this.def, world.floor);
    const count = Math.max(1, proj.count);
    const spread = proj.spread;
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : i / (count - 1) - 0.5;
      const ang = base + t * spread + world.rng.range(-0.02, 0.02);
      world.spawnProjectile({
        kind: proj.kind,
        team: 'enemy',
        x: this.x + Math.cos(ang) * (this.radius + 6),
        y: this.y + Math.sin(ang) * (this.radius + 6),
        angle: ang,
        speed: proj.speed,
        damage: dmg,
        radius: proj.radius,
        life: proj.life,
        color: proj.color,
        glow: proj.glow,
        homing: proj.homing ?? 0,
        spin: proj.kind === 'spike' ? 6 : 0,
      });
    }
    world.ctx.audio.play('enemyHit', 0.24);
  }

  /** 环形弹幕。offset 让多轮之间有角度错位，更难躲。 */
  private fireRing(world: EnemyWorld, offset: number): void {
    const proj = this.def.projectile;
    if (!proj) return;
    const dmg = scaledProjectileDamage(this.def, world.floor);
    const count = Math.max(4, proj.count);
    const base = offset + world.rng.range(0, 0.4);
    for (let i = 0; i < count; i++) {
      const ang = base + (i / count) * TAU;
      world.spawnProjectile({
        kind: proj.kind,
        team: 'enemy',
        x: this.x + Math.cos(ang) * (this.radius + 8),
        y: this.y + Math.sin(ang) * (this.radius + 8),
        angle: ang,
        speed: proj.speed,
        damage: dmg,
        radius: proj.radius,
        life: proj.life,
        color: proj.color,
        glow: proj.glow,
        spin: proj.kind === 'spike' ? 5 : 0,
      });
    }
    world.ctx.audio.play('enemyHit', 0.3);
  }

  /** 渲染用的动画信息。 */
  get anim(): {
    state: EnemyState;
    walkPhase: number;
    telegraph: number;
    bob: number;
    facing: number;
  } {
    return {
      state: this.state,
      walkPhase: this.animTime * 6,
      telegraph: this.telegraph,
      bob: Math.sin(this.animTime * 3.2) * (this.isRanged ? 2.6 : 1.2),
      facing: this.facing,
    };
  }
}
