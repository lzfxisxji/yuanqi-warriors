/**
 * 弹丸系统：对象池 + 分步连续碰撞检测 + 差异化出膛视觉。
 * 支持直线弹、霰弹弹丸、狙击曳光、榴弹（抛物线高度 + 阴影）、追踪球、尖刺弹、火焰喷射流。
 */
import { TAU, clamp, normalize } from '../core/math';
import type { Team } from '../core/types';
import { ROOM_H, ROOM_W } from '../data/config';
import type { Room } from '../dungeon/room';
import type { DamageContext, HitEntity } from '../systems/combat';
import { explode } from '../systems/combat';

export type ProjectileKind =
  | 'bullet'
  | 'orb'
  | 'bolt'
  | 'pellet'
  | 'shell'
  | 'grenade'
  | 'spike'
  | 'flameJet'
  | 'wave';

export interface ProjectileSpec {
  kind: ProjectileKind;
  team: Team;
  x: number;
  y: number;
  angle: number;
  speed: number;
  damage: number;
  radius: number;
  life: number;
  pierce?: number;
  bounce?: number;
  knockback?: number;
  crit?: boolean;
  color?: string;
  glow?: string;
  trail?: string;
  explosive?: { radius: number; damage: number };
  burn?: { dps: number; duration: number };
  homing?: number;
  /** 榴弹抛物线视觉高度（像素） */
  arc?: number;
  spin?: number;
}

export interface Projectile {
  active: boolean;
  kind: ProjectileKind;
  team: Team;
  x: number;
  y: number;
  angle: number;
  speed: number;
  damage: number;
  radius: number;
  life: number;
  pierce: number;
  bounce: number;
  knockback: number;
  crit: boolean;
  color: string;
  glow: string;
  trail: string;
  homing: number;
  arc: number;
  rot: number;
  spin: number;
  z: number;
  travelled: number;
  maxTravel: number;
  hitIds: Set<number>;
  explosive?: { radius: number; damage: number };
  burn?: { dps: number; duration: number };
}

export interface ProjectileWorld {
  room: Room;
  ctx: DamageContext;
  /** 玩家子弹的目标集合 */
  targets: HitEntity[];
  /** 环境可破坏物（木箱等）受伤 */
  damageEnvironment(x: number, y: number, radius: number, damage: number): void;
  /** 附加燃烧状态 */
  spawnBurn(target: HitEntity, dps: number, duration: number): void;
}

const SHAPE_DEFAULTS: Record<ProjectileKind, { radius: number; color: string; glow: string; trail: string }> = {
  bullet: { radius: 4.5, color: '#ffffff', glow: '#8fd0ff', trail: '#5aa8ff' },
  bolt: { radius: 4, color: '#fff6d8', glow: '#ffb347', trail: '#ff8a3c' },
  pellet: { radius: 4.2, color: '#fff2cc', glow: '#ffd06a', trail: '#ff9a3c' },
  shell: { radius: 5.5, color: '#ffffff', glow: '#a8f0ff', trail: '#5ce1ff' },
  orb: { radius: 8, color: '#cfeaff', glow: '#4b9bff', trail: '#2c6bff' },
  spike: { radius: 9, color: '#ffd6a8', glow: '#ff6a1f', trail: '#c73a00' },
  grenade: { radius: 7, color: '#fff0c2', glow: '#ffcf5a', trail: '#ff7a2f' },
  flameJet: { radius: 10, color: '#ffe0a0', glow: '#ff8a26', trail: '#ff4d1a' },
  wave: { radius: 10, color: '#9ff5e0', glow: '#25d6b0', trail: '#0f9c86' },
};

const idMap = new WeakMap<object, number>();
let idCounter = 1;
function entityId(o: object): number {
  let id = idMap.get(o);
  if (id === undefined) {
    id = idCounter++;
    idMap.set(o, id);
  }
  return id;
}

export class ProjectileSystem {
  private pool: Projectile[] = [];
  private cursor = 0;
  activeCount = 0;
  capacity: number;

  constructor(capacity = 460) {
    this.capacity = capacity;
    for (let i = 0; i < capacity; i++) {
      this.pool.push({
        active: false,
        kind: 'bullet',
        team: 'player',
        x: 0,
        y: 0,
        angle: 0,
        speed: 0,
        damage: 0,
        radius: 4,
        life: 0,
        pierce: 0,
        bounce: 0,
        knockback: 0,
        crit: false,
        color: '#ffffff',
        glow: '#ffffff',
        trail: '#ffffff',
        homing: 0,
        arc: 0,
        rot: 0,
        spin: 0,
        z: 0,
        travelled: 0,
        maxTravel: 600,
        hitIds: new Set<number>(),
      });
    }
  }

  clear(): void {
    for (const p of this.pool) {
      p.active = false;
      p.hitIds.clear();
    }
    this.activeCount = 0;
  }

  /** 收集当前所有活跃弹丸（只读引用，供联机快照序列化使用）。 */
  collect(out: Projectile[]): void {
    out.length = 0;
    for (const p of this.pool) if (p.active) out.push(p);
  }

  spawn(spec: ProjectileSpec): void {
    let slot: Projectile | null = null;
    for (let i = 0; i < this.pool.length; i++) {
      const idx = (this.cursor + i) % this.pool.length;
      if (!this.pool[idx]!.active) {
        slot = this.pool[idx]!;
        this.cursor = (idx + 1) % this.pool.length;
        break;
      }
    }
    if (!slot) {
      slot = this.pool[this.cursor]!;
      this.cursor = (this.cursor + 1) % this.pool.length;
    }
    const d = SHAPE_DEFAULTS[spec.kind];
    const p = slot;
    p.active = true;
    p.kind = spec.kind;
    p.team = spec.team;
    p.x = spec.x;
    p.y = spec.y;
    p.angle = spec.angle;
    p.speed = spec.speed;
    p.damage = spec.damage;
    p.radius = spec.radius > 0 ? spec.radius : d.radius;
    p.life = spec.life;
    p.pierce = spec.pierce ?? 0;
    p.bounce = spec.bounce ?? 0;
    p.knockback = spec.knockback ?? 0;
    p.crit = spec.crit ?? false;
    p.color = spec.color ?? d.color;
    p.glow = spec.glow ?? d.glow;
    p.trail = spec.trail ?? d.trail;
    p.homing = spec.homing ?? 0;
    p.arc = spec.arc ?? 0;
    p.spin = spec.spin ?? 0;
    p.rot = spec.angle;
    p.z = 0;
    p.travelled = 0;
    p.maxTravel = Math.max(24, spec.speed * spec.life);
    p.explosive = spec.explosive;
    p.burn = spec.burn;
    p.hitIds.clear();
  }

  private detonate(p: Projectile, world: ProjectileWorld, withExplosion: boolean): void {
    if (!p.active) return;
    p.active = false;
    if (p.explosive && withExplosion) {
      explode({
        x: p.x,
        y: p.y,
        radius: p.explosive.radius,
        damage: p.explosive.damage,
        team: p.team,
        targets: world.targets,
        ctx: world.ctx,
        color: p.trail,
        coreColor: '#fff3c4',
        knockback: 240,
      });
    } else {
      world.ctx.particles.hitSparks(p.x, p.y, p.angle + Math.PI, p.glow, 4, 0.7);
    }
  }

  update(dt: number, world: ProjectileWorld): void {
    let count = 0;
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        this.detonate(p, world, true);
        continue;
      }

      // 追踪弹
      if (p.homing > 0) {
        let best: HitEntity | null = null;
        let bestD = Infinity;
        for (const t of world.targets) {
          if (t.dead || t.team === p.team) continue;
          const d = (t.x - p.x) ** 2 + (t.y - p.y) ** 2;
          if (d < bestD) {
            bestD = d;
            best = t;
          }
        }
        if (best) {
          const want = Math.atan2(best.y - p.y, best.x - p.x);
          let diff = want - p.angle;
          while (diff > Math.PI) diff -= TAU;
          while (diff < -Math.PI) diff += TAU;
          p.angle += clamp(diff, -p.homing * dt, p.homing * dt);
        }
      }

      const total = p.speed * dt;
      p.travelled += total;
      if (p.travelled > p.maxTravel) {
        this.detonate(p, world, true);
        continue;
      }
      if (p.arc > 0) {
        const t = clamp(p.travelled / p.maxTravel, 0, 1);
        p.z = Math.sin(t * Math.PI) * p.arc;
      }

      const steps = Math.max(1, Math.ceil(total / 8));
      const stepLen = total / steps;
      for (let s = 0; s < steps && p.active; s++) {
        const nx = p.x + Math.cos(p.angle) * stepLen;
        const ny = p.y + Math.sin(p.angle) * stepLen;

        if (nx < 0 || ny < 0 || nx > ROOM_W || ny > ROOM_H) {
          this.detonate(p, world, true);
          break;
        }

        if (world.room.isBlockedPoint(nx, ny)) {
          if (p.bounce > 0) {
            p.bounce -= 1;
            const freeX = !world.room.isBlockedPoint(nx, p.y);
            const freeY = !world.room.isBlockedPoint(p.x, ny);
            if (freeX && !freeY) p.angle = Math.PI - p.angle;
            else if (freeY && !freeX) p.angle = -p.angle;
            else p.angle += Math.PI;
            world.ctx.particles.hitSparks(p.x, p.y, p.angle, p.glow, 6, 0.7);
            p.rot = p.angle;
            break;
          }
          const ex = p.x;
          const ey = p.y;
          const edmg = p.damage;
          const er = p.radius;
          this.detonate(p, world, true);
          world.damageEnvironment(ex, ey, er + 14, edmg);
          break;
        }

        p.x = nx;
        p.y = ny;

        for (const t of world.targets) {
          if (t.dead || t.team === p.team) continue;
          const id = entityId(t);
          if (p.hitIds.has(id)) continue;
          const dx = t.x - p.x;
          const dy = t.y - p.y;
          const reach = t.radius + p.radius;
          if (dx * dx + dy * dy > reach * reach) continue;

          p.hitIds.add(id);
          const n = normalize(dx, dy);
          const fallback = { x: Math.cos(p.angle), y: Math.sin(p.angle) };
          const result = t.applyDamage(p.damage, {
            crit: p.crit,
            source: p.kind === 'flameJet' ? 'burn' : 'bullet',
            dirX: n.x || fallback.x,
            dirY: n.y || fallback.y,
            knockback: p.knockback,
            color: p.glow,
          });
          if (p.burn && !t.dead) world.spawnBurn(t, p.burn.dps, p.burn.duration);

          if (p.kind === 'flameJet') p.damage *= 0.85;

          if (p.explosive && (p.pierce <= 0 || result.killed === false)) {
            // 榴弹类：任何直接命中都引爆
            this.detonate(p, world, true);
            break;
          }
          if (p.pierce > 0) {
            p.pierce -= 1;
          } else {
            p.active = false;
            break;
          }
        }
      }
      if (p.active) p.rot += p.spin * dt;
    }
    for (const p of this.pool) if (p.active) count++;
    this.activeCount = count;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    for (const p of this.pool) {
      if (!p.active || p.z <= 0) continue;
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.radius * 1.2, p.radius * 0.62, 0, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    for (const p of this.pool) {
      if (!p.active) continue;
      const y = p.y - p.z;
      switch (p.kind) {
        case 'orb':
        case 'wave':
          drawOrb(ctx, p.x, y, p.radius, p.color, p.glow, p.trail);
          break;
        case 'grenade':
        case 'spike':
          drawSpiky(ctx, p.x, y, p.radius, p.rot, p.color, p.glow, p.kind === 'grenade');
          break;
        case 'flameJet':
          drawFlame(ctx, p.x, y, p.radius, p.color, p.glow);
          break;
        default:
          drawBullet(ctx, p, y);
          break;
      }
    }
    ctx.restore();
  }
}

function drawBullet(ctx: CanvasRenderingContext2D, p: Projectile, y: number): void {
  const len = p.kind === 'shell' ? 34 : p.kind === 'pellet' ? 11 : 15;
  ctx.save();
  ctx.translate(p.x, y);
  ctx.rotate(p.angle);
  ctx.globalCompositeOperation = 'lighter';

  const g = ctx.createLinearGradient(-len, 0, p.radius * 1.6, 0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.45, p.trail);
  g.addColorStop(1, p.color);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(-len, -p.radius * 0.5);
  ctx.lineTo(0, -p.radius);
  ctx.lineTo(p.radius * 1.7, 0);
  ctx.lineTo(0, p.radius);
  ctx.lineTo(-len, p.radius * 0.5);
  ctx.closePath();
  ctx.fill();

  const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, p.radius * 3.2);
  rg.addColorStop(0, p.color);
  rg.addColorStop(0.34, p.glow);
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = 0.72;
  ctx.fillStyle = rg;
  ctx.beginPath();
  ctx.arc(0, 0, p.radius * 3.2, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawOrb(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  glow: string,
  trail: string,
): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const rg = ctx.createRadialGradient(x, y, 0, x, y, r * 3.1);
  rg.addColorStop(0, color);
  rg.addColorStop(0.3, glow);
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rg;
  ctx.beginPath();
  ctx.arc(x, y, r * 3.1, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 0.65;
  ctx.strokeStyle = trail;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, r * 1.15, 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawSpiky(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  rot: number,
  color: string,
  glow: string,
  isGrenade: boolean,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.globalCompositeOperation = 'lighter';
  const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 2.6);
  rg.addColorStop(0, glow);
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rg;
  ctx.beginPath();
  ctx.arc(0, 0, r * 2.6, 0, TAU);
  ctx.fill();

  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = isGrenade ? '#4c4a56' : color;
  ctx.strokeStyle = glow;
  ctx.lineWidth = 1.8;
  const spikes = isGrenade ? 6 : 8;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * TAU;
    const rr = i % 2 === 0 ? r * 1.35 : r * 0.7;
    const px = Math.cos(a) * rr;
    const py = Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  if (isGrenade) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.42, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawFlame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  glow: string,
): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const rg = ctx.createRadialGradient(x, y, 0, x, y, r * 1.7);
  rg.addColorStop(0, color);
  rg.addColorStop(0.45, glow);
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rg;
  ctx.beginPath();
  ctx.arc(x, y, r * 1.7, 0, TAU);
  ctx.fill();
  ctx.restore();
}
