/**
 * 原创 Boss「熔核·渊心」。
 * 三阶段战斗，所有强力攻击都有明显前摇（地面预警环 / 直线预警），玩家可以靠观察躲避。
 *   阶段一：扇形弹幕 + 定向三连射
 *   阶段二：追加冲锋、环形弹幕、召唤腐壤爬虫
 *   阶段三：强化状态，追加旋转螺旋弹幕与扫射激光，攻击频率整体提高
 */
import { TAU, RNG, clamp, dist, normalize } from '../core/math';
import type { DamageResult } from '../core/types';
import type { ProjectileSpec } from './projectile';
import type { Player } from './player';
import type { Room } from '../dungeon/room';
import { moveCircle, steerAroundObstacles } from '../systems/collision';
import type { HitOptions } from '../systems/combat';
import { GameEvents } from '../core/eventbus';
import { Entity } from './entity';
import type { EnemyWorld } from './enemy';
import type { BossDef } from '../data/bosses';

export type BossState = 'intro' | 'move' | 'windup' | 'attack' | 'recover' | 'transition' | 'dead';

export type BossAttackKind =
  | 'fanSpread'
  | 'aimedBurst'
  | 'charge'
  | 'ringBurst'
  | 'summon'
  | 'spiral'
  | 'laserSweep';

export interface TelegraphInfo {
  kind: 'none' | 'circle' | 'line';
  x: number;
  y: number;
  radius: number;
  angle: number;
  length: number;
  width: number;
  progress: number;
  color: string;
}

const PHASE_THRESHOLDS = [0.66, 0.33];

export class Boss extends Entity {
  override team = 'enemy' as const;
  /** 数据定义（每一层一个，见 src/data/bosses.ts）。 */
  readonly def: BossDef;
  get name(): string {
    return this.def.name;
  }
  get title(): string {
    return this.def.title;
  }
  floor: number;
  state: BossState = 'intro';
  stateTime = 0;
  phase = 1;
  maxPhase = 3;
  /** 阶段切换无敌 */
  invulnTimer = 0;
  /** 当前攻击 */
  attack: BossAttackKind = 'fanSpread';
  /** 终极技是否已触发（每个 Boss 只触发一次） */
  private usedUltimate = false;
  attackCooldown = 2.2;
  telegraph: TelegraphInfo = {
    kind: 'none',
    x: 0,
    y: 0,
    radius: 0,
    angle: 0,
    length: 0,
    width: 0,
    progress: 0,
    color: '255,90,70',
  };
  /** 攻击子步骤 */
  private stepLeft = 0;
  private stepTimer = 0;
  private chargeDirX = 0;
  private chargeDirY = 0;
  private chargeTimer = 0;
  private spiralAngle = 0;
  private laserAngle = 0;
  private laserDir = 1;
  beamActive = false;
  beamAngle = 0;
  beamLength = 1200;
  /** 死亡演出 */
  deathTimer = 0;
  deathHandled = false;
  /** 视觉：旋转的护甲片 */
  plateRotation = 0;
  hitFlashRing = 0;
  /** 已进行的攻击轮数 */
  attackCount = 0;

  constructor(x: number, y: number, def: BossDef) {
    super();
    this.def = def;
    this.floor = def.floor;
    this.x = x;
    this.y = y;
    this.radius = def.radius;
    this.maxHp = Math.round(def.baseHp + def.hpPerFloor * (def.floor - 1));
    this.hp = this.maxHp;
    this.knockbackResist = 1;
    this.facing = Math.PI / 2;
    this.attackCooldown = 2.6;
  }

  get healthPercent(): number {
    return clamp(this.hp / this.maxHp, 0, 1);
  }

  /** 接触伤害（每秒），由场景按节拍结算。 */
  get contactDamage(): number {
    return this.def.contactDamageBase + this.def.contactDamagePerFloor * (this.def.floor - 1);
  }

  get phaseThresholds(): number[] {
    return PHASE_THRESHOLDS;
  }

  applyDamage(amount: number, opts: HitOptions): DamageResult {
    if (this.dead) return { applied: 0, crit: opts.crit, killed: false, blocked: true, dodged: false };
    if (this.invulnTimer > 0 || this.state === 'intro' || this.state === 'transition') {
      return { applied: 0, crit: opts.crit, killed: false, blocked: true, dodged: false };
    }
    this.hp -= amount;
    this.hitFlash = Math.max(this.hitFlash, 0.14);
    this.hitFlashRing = 1;
    const p = this.healthPercent;
    if (this.phase < this.maxPhase) {
      const threshold = PHASE_THRESHOLDS[this.phase - 1] ?? 0;
      if (p <= threshold) {
        this.enterPhase(this.phase + 1);
      }
    }
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      this.state = 'dead';
      this.deathTimer = 0;
      // 死亡瞬间必须清掉正在蓄力的预警与激光，否则遗体会把红色预警圈一直留在场上
      this.telegraph.kind = 'none';
      this.telegraph.progress = 0;
      this.beamActive = false;
      return { applied: amount, crit: opts.crit, killed: true, blocked: false, dodged: false };
    }
    return { applied: amount, crit: opts.crit, killed: false, blocked: false, dodged: false };
  }

  private enterPhase(next: number): void {
    this.phase = next;
    this.state = 'transition';
    this.stateTime = 0;
    this.invulnTimer = 1.35;
    this.beamActive = false;
    this.telegraph.kind = 'none';
    this.attackCooldown = 1.1;
  }

  update(dt: number, world: EnemyWorld): void {
    this.updateCommon(dt, 3);
    this.plateRotation += dt * (1.1 + this.phase * 0.5);
    this.hitFlashRing = Math.max(0, this.hitFlashRing - dt * 2.4);

    if (this.dead) {
      // 遗体只做「放大 + 旋转 + 淡出」的消散，爆炸由场景按真实时间驱动
      this.deathTimer += dt;
      this.vx *= 0.9;
      this.vy *= 0.9;
      moveCircle(this, world.room, this.vx * dt, this.vy * dt);
      return;
    }

    if (this.invulnTimer > 0) this.invulnTimer = Math.max(0, this.invulnTimer - dt);
    if (this.attackCooldown > 0) this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.stateTime += dt;
    const focus = world.focusAt(this.x, this.y);
    this.facing = Math.atan2(focus.y - this.y, focus.x - this.x);

    switch (this.state) {
      case 'intro': {
        this.vx *= 0.9;
        this.vy *= 0.9;
        this.telegraph.kind = 'none';
        if (this.stateTime > 1.5) {
          this.state = 'move';
          this.stateTime = 0;
        }
        break;
      }

      case 'transition': {
        this.vx *= 0.86;
        this.vy *= 0.86;
        if (this.stateTime < 0.1) {
          world.ctx.particles.shockwave(this.x, this.y, 420, this.def.palette.accent, 0.7);
          world.ctx.shake.add(0.6);
          world.ctx.audio.play('bossRoar', 1);
          world.ctx.bus.emit(GameEvents.BossPhase, { phase: this.phase });
        }
        if (this.stateTime > 1.35) {
          this.state = 'recover';
          this.stateTime = 0;
          this.attackCooldown = Math.max(this.attackCooldown, this.phase >= 3 ? 0.5 : 0.9);
        }
        break;
      }

      case 'move': {
        this.telegraph.kind = 'none';
        // 与玩家保持中距离并缓慢环绕
        const target = world.focusAt(this.x, this.y);
        const d = dist(this.x, this.y, target.x, target.y);
        const ideal = this.phase >= 3 ? 250 : 320;
        const ang = Math.atan2(target.y - this.y, target.x - this.x);
        let dx = 0;
        let dy = 0;
        if (d > ideal + 50) {
          dx += Math.cos(ang);
          dy += Math.sin(ang);
        } else if (d < ideal - 70) {
          dx -= Math.cos(ang) * 1.2;
          dy -= Math.sin(ang) * 1.2;
        }
        const perp = ang + Math.PI / 2;
        const strafe = Math.sin(this.animTime * 0.55) > 0 ? 1 : -1;
        dx += Math.cos(perp) * strafe * 0.66;
        dy += Math.sin(perp) * strafe * 0.66;
        const n = normalize(dx, dy);
        const speed = 108 + this.phase * 16;
        const dir = steerAroundObstacles(world.room, this.x, this.y, this.x + n.x * 120, this.y + n.y * 120, this.radius);
        this.vx += (dir.x * speed - this.vx) * (1 - Math.exp(-3.4 * dt));
        this.vy += (dir.y * speed - this.vy) * (1 - Math.exp(-3.4 * dt));

        if (this.attackCooldown <= 0) {
          this.chooseAttack(world);
        }
        break;
      }

      case 'windup': {
        const dur = this.windupDuration();
        this.telegraph.progress = clamp(this.stateTime / dur, 0, 1);
        this.vx *= 0.9;
        this.vy *= 0.9;
        if (this.stateTime >= dur) {
          this.telegraph.kind = 'none';
          this.state = 'attack';
          this.stateTime = 0;
          this.beginAttack(world);
        }
        break;
      }

      case 'attack':
        this.runAttack(dt, world);
        break;

      case 'recover': {
        this.vx *= 0.88;
        this.vy *= 0.88;
        if (this.stateTime > this.recoverDuration()) {
          this.state = 'move';
          this.stateTime = 0;
        }
        break;
      }

      case 'dead':
        break;
    }

    moveCircle(this, world.room, this.vx * dt, this.vy * dt);
  }

  private windupDuration(): number {
    switch (this.attack) {
      case 'charge':
        return this.phase >= 3 ? 0.62 : 0.86;
      case 'laserSweep':
        return 0.95;
      case 'spiral':
        return 0.6;
      case 'ringBurst':
        return this.phase >= 3 ? 0.42 : 0.6;
      default:
        return this.phase >= 3 ? 0.3 : 0.45;
    }
  }

  private recoverDuration(): number {
    switch (this.attack) {
      case 'charge':
        return 0.85;
      case 'laserSweep':
        return 1;
      case 'spiral':
        return 0.9;
      default:
        return 0.5;
    }
  }

  private chooseAttack(world: EnemyWorld): void {
    const pool: BossAttackKind[] = [...(this.def.phaseAttacks[this.phase - 1] ?? [])];
    if (pool.length === 0) pool.push('fanSpread');

    // 终极技：血量低于阈值且本场尚未触发过，强制放一次大招
    let pick: BossAttackKind;
    if (this.def.ultimateAt > 0 && !this.usedUltimate && this.healthPercent <= this.def.ultimateAt) {
      this.usedUltimate = true;
      pick = this.def.ultimateAttack;
    } else {
      // 避免连续两次相同的蓄力型大招，让节奏有起伏
      pick = pool[world.rng.weightedIndex(pool.map(() => 1))]!;
      let guard = 0;
      while (pick === this.attack && (pick === 'charge' || pick === 'laserSweep') && guard < 8) {
        pick = pool[world.rng.weightedIndex(pool.map(() => 1))]!;
        guard++;
      }
    }
    this.attack = pick;
    this.attackCount++;

    const player = world.focusAt(this.x, this.y);
    const ang = Math.atan2(player.y - this.y, player.x - this.x);
    switch (pick) {
      case 'charge':
        this.chargeDirX = Math.cos(ang);
        this.chargeDirY = Math.sin(ang);
        this.telegraph = {
          kind: 'line',
          x: this.x,
          y: this.y,
          radius: 0,
          angle: ang,
          length: 900,
          width: this.radius * 1.7,
          progress: 0,
          color: this.def.palette.glow,
        };
        break;
      case 'ringBurst':
        this.telegraph = {
          kind: 'circle',
          x: this.x,
          y: this.y,
          radius: 300,
          angle: 0,
          length: 0,
          width: 0,
          progress: 0,
          color: this.def.palette.glow,
        };
        break;
      case 'summon':
        this.telegraph = {
          kind: 'circle',
          x: this.x,
          y: this.y,
          radius: 190,
          angle: 0,
          length: 0,
          width: 0,
          progress: 0,
          color: this.def.palette.glow,
        };
        break;
      case 'laserSweep':
        this.laserAngle = ang + (world.rng.chance(0.5) ? -0.85 : 0.85);
        this.laserDir = world.rng.chance(0.5) ? 1 : -1;
        this.telegraph = {
          kind: 'line',
          x: this.x,
          y: this.y,
          radius: 0,
          angle: this.laserAngle,
          length: 1500,
          width: 26,
          progress: 0,
          color: this.def.palette.glow,
        };
        break;
      case 'spiral':
        this.spiralAngle = ang;
        this.telegraph = {
          kind: 'circle',
          x: this.x,
          y: this.y,
          radius: 150,
          angle: 0,
          width: 0,
          length: 0,
          progress: 0,
          color: this.def.palette.glow,
        };
        break;
      default:
        this.telegraph.kind = 'none';
        break;
    }
    this.state = 'windup';
    this.stateTime = 0;
  }

  private beginAttack(world: EnemyWorld): void {
    const player = world.focusAt(this.x, this.y);
    const ang = Math.atan2(player.y - this.y, player.x - this.x);
    switch (this.attack) {
      case 'fanSpread':
        this.stepLeft = this.phase >= 3 ? 3 : 2;
        this.stepTimer = 0;
        this.fireFan(world, ang, 0);
        break;
      case 'aimedBurst':
        this.stepLeft = this.phase >= 3 ? 5 : 3;
        this.stepTimer = 0;
        this.fireAimed(world, ang);
        break;
      case 'charge':
        this.chargeTimer = 0.62;
        world.ctx.audio.play('dash', 0.7);
        break;
      case 'ringBurst':
        this.stepLeft = this.phase >= 3 ? 3 : 2;
        this.stepTimer = 0;
        this.fireRing(world, 0);
        break;
      case 'summon':
        this.stepLeft = 0;
        this.doSummon(world);
        break;
      case 'spiral':
        this.stepLeft = Math.round(26 + this.phase * 6);
        this.stepTimer = 0;
        break;
      case 'laserSweep':
        this.beamActive = true;
        this.stepTimer = 0;
        world.ctx.audio.play('laser', 0.9);
        break;
    }
  }

  private runAttack(dt: number, world: EnemyWorld): void {
    const player = world.focusAt(this.x, this.y);
    switch (this.attack) {
      case 'fanSpread': {
        this.stepTimer -= dt;
        if (this.stepTimer <= 0 && this.stepLeft > 0) {
          this.stepLeft -= 1;
          this.stepTimer = 0.24;
          const ang = Math.atan2(player.y - this.y, player.x - this.x);
          this.fireFan(world, ang, this.stepLeft * 0.22);
        }
        if (this.stepLeft <= 0 && this.stepTimer <= 0) this.finishAttack();
        break;
      }
      case 'aimedBurst': {
        this.stepTimer -= dt;
        if (this.stepTimer <= 0 && this.stepLeft > 0) {
          this.stepLeft -= 1;
          this.stepTimer = 0.12;
          const ang = Math.atan2(player.y - this.y, player.x - this.x);
          this.fireAimed(world, ang);
        }
        if (this.stepLeft <= 0 && this.stepTimer <= 0) this.finishAttack();
        break;
      }
      case 'charge': {
        this.chargeTimer -= dt;
        const speed = this.phase >= 3 ? 780 : 620;
        this.vx = this.chargeDirX * speed;
        this.vy = this.chargeDirY * speed;
        world.ctx.particles.spawn({
          kind: 'smoke',
          x: this.x + (Math.random() - 0.5) * this.radius,
          y: this.y + (Math.random() - 0.5) * this.radius,
          vx: -this.chargeDirX * 90,
          vy: -this.chargeDirY * 90,
          life: 0.4,
          size: 14,
          sizeEnd: 34,
          color: `rgba(${this.def.palette.glow},0.55)`,
          alpha0: 0.5,
          alpha1: 0,
          drag: 2,
        });
        if (this.chargeTimer <= 0) {
          this.vx *= 0.2;
          this.vy *= 0.2;
          this.finishAttack();
        }
        break;
      }
      case 'ringBurst': {
        this.stepTimer -= dt;
        if (this.stepTimer <= 0 && this.stepLeft > 0) {
          this.stepLeft -= 1;
          this.stepTimer = 0.42;
          this.fireRing(world, this.stepLeft * 0.19);
        }
        if (this.stepLeft <= 0 && this.stepTimer <= 0) this.finishAttack();
        break;
      }
      case 'summon':
        this.finishAttack();
        break;
      case 'spiral': {
        this.stepTimer -= dt;
        if (this.stepTimer <= 0 && this.stepLeft > 0) {
          this.stepLeft -= 1;
          this.stepTimer = 0.055;
          const arms = this.phase >= 3 ? 3 : 2;
          const speed = 250 + this.phase * 22;
          for (let a = 0; a < arms; a++) {
            const ang = this.spiralAngle + (a / arms) * TAU;
            world.spawnProjectile({
              kind: 'orb',
              team: 'enemy',
              x: this.x + Math.cos(ang) * (this.radius + 8),
              y: this.y + Math.sin(ang) * (this.radius + 8),
              angle: ang,
              speed,
              damage: 9 + this.floor * 3,
              radius: 8,
              life: 4.6,
              color: this.def.palette.bullet,
              glow: this.def.palette.bulletGlow,
            });
          }
          this.spiralAngle += 0.34;
        }
        if (this.stepLeft <= 0 && this.stepTimer <= 0) this.finishAttack();
        break;
      }
      case 'laserSweep': {
        this.stepTimer += dt;
        const sweepTotal = this.phase >= 3 ? 1.7 : 1.35;
        const sweepRange = this.phase >= 3 ? 2.3 : 1.7;
        this.laserAngle += (this.laserDir * sweepRange) / sweepTotal * dt;
        this.beamAngle = this.laserAngle;
        this.hitPlayerWithBeam(world, dt);
        if (Math.random() < dt * 60) {
          world.ctx.particles.spawn({
            kind: 'ember',
            x: this.x + Math.cos(this.laserAngle) * this.radius,
            y: this.y + Math.sin(this.laserAngle) * this.radius,
            life: 0.25,
            size: 7,
            sizeEnd: 1,
            color: this.def.palette.bulletGlow,
            alpha0: 0.8,
            alpha1: 0,
            drag: 0,
          });
        }
        if (this.stepTimer > sweepTotal) {
          this.beamActive = false;
          this.finishAttack();
        }
        break;
      }
    }
  }

  private finishAttack(): void {
    this.beamActive = false;
    this.telegraph.kind = 'none';
    this.state = 'recover';
    this.stateTime = 0;
    const base = this.phase >= 3 ? 0.85 : this.phase >= 2 ? 1.25 : 1.6;
    this.attackCooldown = base;
  }

  private fireFan(world: EnemyWorld, angle: number, angleOffset: number): void {
    const count = this.phase >= 3 ? 7 : 5;
    const spread = 0.95;
    const dmg = 9 + this.floor * 2.5;
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1) - 0.5;
      const ang = angle + angleOffset + t * spread;
      world.spawnProjectile({
        kind: 'orb',
        team: 'enemy',
        x: this.x + Math.cos(ang) * (this.radius + 6),
        y: this.y + Math.sin(ang) * (this.radius + 6),
        angle: ang,
        speed: 290 + this.phase * 22,
        damage: dmg,
        radius: 9,
        life: 4,
        color: this.def.palette.bullet,
        glow: this.def.palette.bulletGlow,
      });
    }
    world.ctx.audio.play('enemyHit', 0.45);
  }

  private fireAimed(world: EnemyWorld, angle: number): void {
    const dmg = 11 + this.floor * 2.5;
    world.spawnProjectile({
      kind: 'bolt',
      team: 'enemy',
      x: this.x + Math.cos(angle) * (this.radius + 6),
      y: this.y + Math.sin(angle) * (this.radius + 6),
      angle,
      speed: 560,
      damage: dmg,
      radius: 7,
      life: 3.2,
      color: this.def.palette.bullet,
      glow: this.def.palette.bulletGlow,
      trail: this.def.palette.bulletGlow,
    });
    world.ctx.audio.play('rifle', 0.4);
  }

  private fireRing(world: EnemyWorld, offset: number): void {
    const count = this.phase >= 3 ? 22 : 16;
    const dmg = 9 + this.floor * 2;
    for (let i = 0; i < count; i++) {
      const ang = offset + (i / count) * TAU;
      world.spawnProjectile({
        kind: 'spike',
        team: 'enemy',
        x: this.x + Math.cos(ang) * (this.radius + 10),
        y: this.y + Math.sin(ang) * (this.radius + 10),
        angle: ang,
        speed: 262,
        damage: dmg,
        radius: 9,
        life: 4,
        color: this.def.palette.bullet,
        glow: this.def.palette.bulletGlow,
        spin: 4,
      });
    }
    world.ctx.particles.shockwave(this.x, this.y, this.radius * 5.4, this.def.palette.accent, 0.42);
    world.ctx.shake.add(0.22);
    world.ctx.audio.play('launcher', 0.55);
  }

  private doSummon(world: EnemyWorld): void {
    const ids = this.def.summonIds;
    const n = this.phase >= 3 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const ang = world.rng.next() * TAU;
      const r = this.radius + 64 + world.rng.range(0, 40);
      const x = clamp(this.x + Math.cos(ang) * r, 60, 1284);
      const y = clamp(this.y + Math.sin(ang) * r, 60, 804);
      world.spawnMinion(ids[i % ids.length]!, x, y);
    }
    world.ctx.particles.shockwave(this.x, this.y, 260, '#7fd8ff', 0.55);
    world.ctx.audio.play('summon', 1);
  }

  private hitPlayerWithBeam(world: EnemyWorld, dt: number): void {
    const dx = Math.cos(this.laserAngle);
    const dy = Math.sin(this.laserAngle);
    // 横扫激光对直线路径上的所有玩家生效（联机时不再只打一个人）
    for (const player of world.players) {
      if (player.dead) continue;
      const relX = player.x - this.x;
      const relY = player.y - this.y;
      const along = relX * dx + relY * dy;
      if (along < 0 || along > this.beamLength) continue;
      const perp = Math.abs(relX * dy - relY * dx);
      if (perp > player.radius + 16) continue;
      // 距离越远伤害略有衰减
      const falloff = 1 - clamp(along / this.beamLength, 0, 1) * 0.35;
      player.applyDamage(46 * dt * falloff, {
        crit: false,
        source: 'burn',
        dirX: dx,
        dirY: dy,
        knockback: 0,
        color: '#ff5a3c',
      });
      world.ctx.particles.spawn({
        kind: 'ember',
        x: player.x,
        y: player.y,
        life: 0.2,
        size: 10,
        sizeEnd: 2,
        color: '#ff8a5a',
        alpha0: 0.9,
        alpha1: 0,
        drag: 0,
      });
    }
  }
}

export function createBossRng(seed: number): RNG {
  return new RNG(seed);
}
