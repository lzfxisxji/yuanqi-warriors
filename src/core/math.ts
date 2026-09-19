/**
 * 基础数学 / 随机数 / 几何工具。
 * 纯函数、无副作用，供所有子系统复用，也是单元测试的主要目标。
 */

export const TAU = Math.PI * 2;

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return b === a ? 0 : (v - a) / (b - a);
}

export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function easeOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return 1 - Math.pow(1 - x, 3);
}

export function easeOutQuad(t: number): number {
  const x = clamp(t, 0, 1);
  return 1 - (1 - x) * (1 - x);
}

export function easeInCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * x;
}

export function easeInOutQuad(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function length(x: number, y: number): number {
  return Math.hypot(x, y);
}

export function normalize(x: number, y: number): Vec2 {
  const l = Math.hypot(x, y);
  if (l < 1e-6) return { x: 0, y: 0 };
  return { x: x / l, y: y / l };
}

export function angleTo(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax);
}

/** 返回 [-PI, PI] 范围内从 a 到 b 的最短有向角差。 */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function rotateTowards(current: number, target: number, maxDelta: number): number {
  const d = angleDelta(current, target);
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

export function approach(current: number, target: number, delta: number): number {
  if (current < target) return Math.min(current + delta, target);
  return Math.max(current - delta, target);
}

export function wrapAngle(a: number): number {
  let x = a % TAU;
  if (x < 0) x += TAU;
  return x;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function circleRectOverlap(cx: number, cy: number, r: number, rect: Rect): boolean {
  const nx = clamp(cx, rect.x, rect.x + rect.w);
  const ny = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

export interface CirclePush {
  x: number;
  y: number;
  nx: number;
  ny: number;
  depth: number;
}

/** 把圆推出矩形，返回修正后的圆心与法线；无碰撞返回 null。 */
export function circleRectResolve(cx: number, cy: number, r: number, rect: Rect): CirclePush | null {
  const nx = clamp(cx, rect.x, rect.x + rect.w);
  const ny = clamp(cy, rect.y, rect.y + rect.h);
  let dx = cx - nx;
  let dy = cy - ny;
  const d = Math.hypot(dx, dy);
  if (d >= r) return null;

  if (d < 1e-6) {
    // 圆心落在矩形内部：沿最近的一条边推出
    const left = cx - rect.x;
    const right = rect.x + rect.w - cx;
    const top = cy - rect.y;
    const bottom = rect.y + rect.h - cy;
    const m = Math.min(left, right, top, bottom);
    if (m === left) return { x: rect.x - r, y: cy, nx: -1, ny: 0, depth: left + r };
    if (m === right) return { x: rect.x + rect.w + r, y: cy, nx: 1, ny: 0, depth: right + r };
    if (m === top) return { x: cx, y: rect.y - r, nx: 0, ny: -1, depth: top + r };
    return { x: cx, y: rect.y + rect.h + r, nx: 0, ny: 1, depth: bottom + r };
  }

  dx /= d;
  dy /= d;
  const depth = r - d;
  return { x: cx + dx * depth, y: cy + dy * depth, nx: dx, ny: dy, depth };
}

export function pointInRect(px: number, py: number, rect: Rect): boolean {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

/** 沿线段均匀采样（用于高速子弹的连续碰撞检测）。 */
export function segmentSamples(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  step: number,
): Vec2[] {
  const out: Vec2[] = [];
  const total = Math.hypot(x1 - x0, y1 - y0);
  const safeStep = Math.max(1, step);
  const n = Math.max(1, Math.ceil(total / safeStep));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
  }
  return out;
}

/** 点到线段的最近点参数 t ∈ [0,1] */
export function closestPointOnSegment(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return 0;
  return clamp(((px - x0) * dx + (py - y0) * dy) / len2, 0, 1);
}

/** 点到线段的最短距离（激光束命中判定使用）。 */
export function distPointToSegment(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const t = closestPointOnSegment(px, py, x0, y0, x1, y1);
  const cx = x0 + (x1 - x0) * t;
  const cy = y0 + (y1 - y0) * t;
  return Math.hypot(px - cx, py - cy);
}

/** mulberry32：小而快的确定性 PRNG。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RNG {
  private fn: () => number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.fn = mulberry32(this.seed);
  }

  next(): number {
    return this.fn();
  }

  range(min: number, max: number): number {
    return min + this.fn() * (max - min);
  }

  int(min: number, max: number): number {
    if (max < min) return min;
    return Math.floor(min + this.fn() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.fn() < p;
  }

  sign(): number {
    return this.fn() < 0.5 ? -1 : 1;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.fn() * arr.length)] as T;
  }

  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.fn() * (i + 1));
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  }

  /** 按权重挑选下标。权重必须为非负，总和需大于 0。 */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return 0;
    let r = this.fn() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i]!);
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }
}

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
