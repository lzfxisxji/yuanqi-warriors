/**
 * 粒子系统：对象池 + 分类渲染。
 * 所有战斗反馈（枪口火焰、命中火花、血雾、爆炸、碎块、燃烧余烬、冲击环、拾取闪光）都从这里出。
 */
import { TAU, clamp, easeOutCubic, lerp } from '../core/math';
import { MAX_PARTICLES } from '../data/config';

export type ParticleKind =
  | 'spark'
  | 'smoke'
  | 'blood'
  | 'debris'
  | 'ring'
  | 'glow'
  | 'ember'
  | 'muzzle'
  | 'shard'
  | 'dust'
  | 'flame';

export interface Particle {
  active: boolean;
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  sizeEnd: number;
  color: string;
  alpha0: number;
  alpha1: number;
  drag: number;
  gravity: number;
  rot: number;
  spin: number;
  additive: boolean;
  /** 用于烟雾 / 火焰的横向摆动相位 */
  wobble: number;
}

export interface ParticleSpawn {
  kind: ParticleKind;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  life?: number;
  size?: number;
  sizeEnd?: number;
  color?: string;
  alpha0?: number;
  alpha1?: number;
  drag?: number;
  gravity?: number;
  rot?: number;
  spin?: number;
  additive?: boolean;
  wobble?: number;
}

const ADDITIVE_KINDS: ParticleKind[] = ['spark', 'ring', 'glow', 'ember', 'muzzle', 'flame'];

export class ParticleSystem {
  private pool: Particle[] = [];
  private cursor = 0;
  /** 每帧统计，供调试面板查看 */
  activeCount = 0;

  constructor(capacity = MAX_PARTICLES) {
    for (let i = 0; i < capacity; i++) {
      this.pool.push({
        active: false,
        kind: 'spark',
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 1,
        size: 1,
        sizeEnd: 0,
        color: '#fff',
        alpha0: 1,
        alpha1: 0,
        drag: 0,
        gravity: 0,
        rot: 0,
        spin: 0,
        additive: false,
        wobble: 0,
      });
    }
  }

  clear(): void {
    for (const p of this.pool) p.active = false;
    this.activeCount = 0;
  }

  get capacity(): number {
    return this.pool.length;
  }

  spawn(opts: ParticleSpawn): void {
    // 环形分配：池满时覆盖最旧的粒子，保证不会无限增长
    let slot: Particle | null = null;
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
    const p = slot;
    p.active = true;
    p.kind = opts.kind;
    p.x = opts.x;
    p.y = opts.y;
    p.vx = opts.vx ?? 0;
    p.vy = opts.vy ?? 0;
    p.maxLife = opts.life ?? 0.4;
    p.life = p.maxLife;
    p.size = opts.size ?? 3;
    p.sizeEnd = opts.sizeEnd ?? 0;
    p.color = opts.color ?? '#ffffff';
    p.alpha0 = opts.alpha0 ?? 1;
    p.alpha1 = opts.alpha1 ?? 0;
    p.drag = opts.drag ?? 2.2;
    p.gravity = opts.gravity ?? 0;
    p.rot = opts.rot ?? 0;
    p.spin = opts.spin ?? 0;
    p.additive = opts.additive ?? ADDITIVE_KINDS.includes(opts.kind);
    p.wobble = opts.wobble ?? Math.random() * TAU;
  }

  update(dt: number): void {
    let count = 0;
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      const damp = Math.exp(-p.drag * dt);
      p.vx *= damp;
      p.vy *= damp;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      count++;
    }
    this.activeCount = count;
  }

  private progress(p: Particle): number {
    return clamp(1 - p.life / p.maxLife, 0, 1);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    // 先画非叠加，再画叠加，减少 composite 切换次数
    ctx.save();
    for (const p of this.pool) {
      if (!p.active || p.additive) continue;
      this.drawOne(ctx, p, false);
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.pool) {
      if (!p.active || !p.additive) continue;
      this.drawOne(ctx, p, true);
    }
    ctx.restore();
  }

  private drawOne(ctx: CanvasRenderingContext2D, p: Particle, additive: boolean): void {
    const t = this.progress(p);
    const alpha = lerp(p.alpha0, p.alpha1, t);
    if (alpha <= 0.004) return;
    const size = Math.max(0.4, lerp(p.size, p.sizeEnd, t));
    ctx.globalAlpha = alpha;

    switch (p.kind) {
      case 'spark': {
        const speed = Math.hypot(p.vx, p.vy);
        const len = clamp(speed * 0.022, 3, 22) * (1 - t * 0.5);
        const ang = Math.atan2(p.vy, p.vx);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(0.8, size * (1 - t * 0.6));
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - Math.cos(ang) * len, p.y - Math.sin(ang) * len);
        ctx.stroke();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size * 0.72, 0, TAU);
        ctx.fill();
        ctx.globalCompositeOperation = additive ? 'lighter' : 'source-over';
        break;
      }
      case 'flame':
      case 'ember': {
        const r = size * (1 + t * 0.8);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, p.color);
        g.addColorStop(0.55, p.color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, TAU);
        ctx.fill();
        break;
      }
      case 'glow': {
        const r = size * (1 + t * 0.5);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, p.color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, TAU);
        ctx.fill();
        break;
      }
      case 'muzzle': {
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        const s = size * (1 - t * 0.35);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.4, p.color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(s * 1.5, 0);
        ctx.lineTo(s * 0.2, s * 0.42);
        ctx.lineTo(-s * 0.5, s * 0.2);
        ctx.lineTo(-s * 0.35, 0);
        ctx.lineTo(-s * 0.5, -s * 0.2);
        ctx.lineTo(s * 0.2, -s * 0.42);
        ctx.closePath();
        ctx.fill();
        ctx.rotate(-p.rot);
        ctx.translate(-p.x, -p.y);
        break;
      }
      case 'ring': {
        const r = size * (1 + t * 2.4);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1, (1 - t) * size * 0.34);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, TAU);
        ctx.stroke();
        break;
      }
      case 'smoke':
      case 'dust': {
        const r = size * (1 + t * 1.6);
        const g = ctx.createRadialGradient(p.x, p.y, r * 0.1, p.x, p.y, r);
        g.addColorStop(0, p.color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, TAU);
        ctx.fill();
        break;
      }
      case 'blood': {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, size * (1 + t * 0.4), size * (0.6 + t * 0.3), p.rot, 0, TAU);
        ctx.fill();
        break;
      }
      case 'debris':
      case 'shard': {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.kind === 'debris') {
          ctx.fillRect(-size * 0.5, -size * 0.34, size, size * 0.68);
        } else {
          ctx.beginPath();
          ctx.moveTo(0, -size * 0.6);
          ctx.lineTo(size * 0.5, size * 0.4);
          ctx.lineTo(-size * 0.5, size * 0.4);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
        break;
      }
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------- 预制效果

  /** 枪口火焰 */
  muzzleFlash(x: number, y: number, angle: number, scale: number, color: string, glowColor: string): void {
    this.spawn({
      kind: 'muzzle',
      x,
      y,
      life: 0.075,
      size: 13 * scale,
      sizeEnd: 6 * scale,
      color,
      alpha0: 1,
      alpha1: 0,
      rot: angle,
      drag: 0,
    });
    this.spawn({
      kind: 'glow',
      x,
      y,
      life: 0.11,
      size: 22 * scale,
      sizeEnd: 9 * scale,
      color: glowColor,
      alpha0: 0.65,
      alpha1: 0,
      drag: 0,
    });
    for (let i = 0; i < 3; i++) {
      const a = angle + (Math.random() - 0.5) * 0.7;
      const sp = 130 + Math.random() * 210;
      this.spawn({
        kind: 'spark',
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.1 + Math.random() * 0.1,
        size: 2.2 * scale,
        sizeEnd: 0,
        color: glowColor,
      });
    }
    this.spawn({
      kind: 'smoke',
      x: x + Math.cos(angle) * 8,
      y: y + Math.sin(angle) * 8,
      vx: Math.cos(angle) * 46,
      vy: Math.sin(angle) * 46 - 16,
      life: 0.42,
      size: 6 * scale,
      sizeEnd: 16 * scale,
      color: 'rgba(190,190,205,0.5)',
      alpha0: 0.4,
      alpha1: 0,
      drag: 2.6,
    });
  }

  /** 抛壳 */
  shellCasing(x: number, y: number, angle: number): void {
    const a = angle + Math.PI / 2 + (Math.random() - 0.5) * 0.6;
    const sp = 90 + Math.random() * 90;
    this.spawn({
      kind: 'debris',
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 60,
      life: 0.7,
      size: 4.4,
      sizeEnd: 3,
      color: '#e6c168',
      drag: 1.4,
      gravity: 340,
      spin: (Math.random() - 0.5) * 22,
      additive: false,
    });
  }

  /** 命中火花 */
  hitSparks(x: number, y: number, angle: number, color: string, count = 6, power = 1): void {
    for (let i = 0; i < count; i++) {
      const a = angle + Math.PI + (Math.random() - 0.5) * 1.6;
      const sp = (150 + Math.random() * 260) * power;
      this.spawn({
        kind: 'spark',
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.14 + Math.random() * 0.2,
        size: 2.4 * power,
        sizeEnd: 0,
        color,
      });
    }
    this.spawn({
      kind: 'glow',
      x,
      y,
      life: 0.12,
      size: 15 * power,
      sizeEnd: 4,
      color,
      alpha0: 0.75,
      alpha1: 0,
      drag: 0,
    });
  }

  /** 血雾 / 黏液 */
  bloodSpray(x: number, y: number, angle: number, color: string, count = 8): void {
    for (let i = 0; i < count; i++) {
      const a = angle + (Math.random() - 0.5) * 1.1;
      const sp = 90 + Math.random() * 240;
      this.spawn({
        kind: 'blood',
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.32 + Math.random() * 0.34,
        size: 2 + Math.random() * 3.4,
        sizeEnd: 0.6,
        color,
        alpha0: 0.92,
        alpha1: 0,
        drag: 3.4,
        rot: Math.random() * TAU,
      });
    }
  }

  /** 爆炸 */
  explosion(x: number, y: number, radius: number, color: string, coreColor = '#fff3c4'): void {
    this.spawn({
      kind: 'ring',
      x,
      y,
      life: 0.34,
      size: radius * 0.35,
      sizeEnd: radius,
      color,
      alpha0: 0.9,
      alpha1: 0,
      drag: 0,
    });
    this.spawn({
      kind: 'glow',
      x,
      y,
      life: 0.3,
      size: radius * 0.95,
      sizeEnd: radius * 0.3,
      color: coreColor,
      alpha0: 0.85,
      alpha1: 0,
      drag: 0,
    });
    const n = Math.round(clamp(radius * 0.28, 10, 30));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = 120 + Math.random() * radius * 4.2;
      this.spawn({
        kind: 'flame',
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.24 + Math.random() * 0.34,
        size: 8 + Math.random() * 14,
        sizeEnd: 1,
        color: Math.random() < 0.45 ? coreColor : color,
        alpha0: 0.85,
        alpha1: 0,
        drag: 3.4,
      });
    }
    for (let i = 0; i < Math.round(n * 0.6); i++) {
      const a = Math.random() * TAU;
      const sp = 30 + Math.random() * radius * 1.4;
      this.spawn({
        kind: 'smoke',
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 26,
        life: 0.6 + Math.random() * 0.5,
        size: radius * 0.24,
        sizeEnd: radius * 0.75,
        color: 'rgba(70,62,60,0.75)',
        alpha0: 0.5,
        alpha1: 0,
        drag: 1.6,
      });
    }
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * TAU;
      const sp = 90 + Math.random() * 200;
      this.spawn({
        kind: 'debris',
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.5 + Math.random() * 0.4,
        size: 3 + Math.random() * 5,
        sizeEnd: 1.5,
        color: '#584a44',
        gravity: 420,
        spin: (Math.random() - 0.5) * 18,
        drag: 1.2,
      });
    }
  }

  /** 尘土（冲刺 / 落地） */
  dust(x: number, y: number, count = 5, color = 'rgba(196,182,160,0.6)'): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const sp = 24 + Math.random() * 70;
      this.spawn({
        kind: 'smoke',
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp * 0.6,
        life: 0.32 + Math.random() * 0.24,
        size: 4 + Math.random() * 5,
        sizeEnd: 13,
        color,
        alpha0: 0.55,
        alpha1: 0,
        drag: 3.2,
      });
    }
  }

  /** 拾取闪光 */
  sparkle(x: number, y: number, color: string, count = 6): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const sp = 40 + Math.random() * 130;
      this.spawn({
        kind: 'spark',
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 40,
        life: 0.24 + Math.random() * 0.24,
        size: 2.4,
        sizeEnd: 0,
        color,
        drag: 1.8,
      });
    }
  }

  /** 环形冲击（解锁门 / Boss 阶段切换） */
  shockwave(x: number, y: number, radius: number, color: string, life = 0.5): void {
    this.spawn({
      kind: 'ring',
      x,
      y,
      life,
      size: radius * 0.2,
      sizeEnd: radius,
      color,
      alpha0: 0.85,
      alpha1: 0,
      drag: 0,
    });
  }

  /** 持续火焰喷射的单帧粒子 */
  flameJet(x: number, y: number, angle: number, color: string, spread: number, speed: number): void {
    const a = angle + (Math.random() - 0.5) * spread;
    const sp = speed * (0.65 + Math.random() * 0.7);
    this.spawn({
      kind: 'flame',
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0.2 + Math.random() * 0.22,
      size: 7 + Math.random() * 7,
      sizeEnd: 1.5,
      color,
      alpha0: 0.8,
      alpha1: 0,
      drag: 3.6,
    });
  }
}

export function particleAlpha(p: Particle): number {
  return lerp(p.alpha0, p.alpha1, easeOutCubic(1 - p.life / p.maxLife));
}
