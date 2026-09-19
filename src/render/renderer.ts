/**
 * 世界渲染器：相机跟随、静态图层缓存、地面预警、动态光照、暗角。
 * 逻辑分辨率固定 1280x720，画布按窗口尺寸等比缩放并按 DPR 提升清晰度。
 */
import { VIEW_H, VIEW_W, ROOM_H, ROOM_W, TILE, CAMERA_LERP, CAMERA_LOOKAHEAD, STATIC_CACHE_LIMIT } from '../data/config';
import { RNG, TAU, clamp } from '../core/math';
import type { Room } from '../dungeon/room';
import type { Enemy } from '../entities/enemy';
import type { Boss } from '../entities/boss';
import { bakeRoomCanvas } from './tiles';
import { drawWarningCircle, drawWarningRect } from '../systems/effects';
import { darken, withAlpha } from './art';

export interface CameraState {
  x: number;
  y: number;
}

export interface DynamicLight {
  x: number;
  y: number;
  radius: number;
  color: string;
  alpha: number;
}

export class WorldRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  camera: CameraState = { x: ROOM_W / 2, y: ROOM_H / 2 };
  private staticCache = new Map<string, HTMLCanvasElement>();
  private cacheOrder: string[] = [];
  private flickerSeed = new RNG(9182);
  private lightTime = 0;
  scale = 1;
  dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('无法创建 2D 渲染上下文');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const scale = Math.max(0.4, Math.min(w / VIEW_W, h / VIEW_H));
    this.scale = scale;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.style.width = `${Math.round(VIEW_W * scale)}px`;
    this.canvas.style.height = `${Math.round(VIEW_H * scale)}px`;
    const bw = Math.round(VIEW_W * this.dpr);
    const bh = Math.round(VIEW_H * this.dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
  }

  beginFrame(): void {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#0b0912';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const s = this.canvas.width / VIEW_W;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.imageSmoothingEnabled = true;
  }

  /** 相机跟随玩家，带前瞻与房间边界夹取。 */
  followPlayer(px: number, py: number, aimAngle: number, room: Room, dt: number): void {
    const targetX = px + Math.cos(aimAngle) * CAMERA_LOOKAHEAD * 0.55;
    const targetY = py + Math.sin(aimAngle) * CAMERA_LOOKAHEAD * 0.45;
    const k = 1 - Math.exp(-CAMERA_LERP * dt);
    this.camera.x += (targetX - this.camera.x) * k;
    this.camera.y += (targetY - this.camera.y) * k;

    const halfW = VIEW_W / 2;
    const halfH = VIEW_H / 2;
    const roomW = room.layout.tiles.length ? ROOM_W : ROOM_W;
    const roomH = ROOM_H;
    if (roomW <= VIEW_W) this.camera.x = roomW / 2;
    else this.camera.x = clamp(this.camera.x, halfW - 30, roomW - halfW + 30);
    if (roomH <= VIEW_H) this.camera.y = roomH / 2;
    else this.camera.y = clamp(this.camera.y, halfH - 30, roomH - halfH + 30);
  }

  snapCamera(x: number, y: number): void {
    const halfW = VIEW_W / 2;
    const halfH = VIEW_H / 2;
    this.camera.x = ROOM_W <= VIEW_W ? ROOM_W / 2 : clamp(x, halfW, ROOM_W - halfW);
    this.camera.y = ROOM_H <= VIEW_H ? ROOM_H / 2 : clamp(y, halfH, ROOM_H - halfH);
  }

  /** 世界坐标系：先平移使相机居中。 */
  pushWorld(shakeX = 0, shakeY = 0, shakeRot = 0): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(VIEW_W / 2 + shakeX, VIEW_H / 2 + shakeY);
    if (shakeRot !== 0) ctx.rotate(shakeRot);
    ctx.translate(-this.camera.x, -this.camera.y);
  }

  popWorld(): void {
    this.ctx.restore();
  }

  /** 静态房间图层（LRU 缓存，避免反复烘焙）。 */
  staticLayer(room: Room): HTMLCanvasElement {
    const key = room.key;
    let layer = this.staticCache.get(key);
    if (!layer) {
      layer = bakeRoomCanvas(room);
      this.staticCache.set(key, layer);
      this.cacheOrder.push(key);
      while (this.cacheOrder.length > STATIC_CACHE_LIMIT) {
        const old = this.cacheOrder.shift()!;
        if (old !== key) this.staticCache.delete(old);
      }
    }
    return layer;
  }

  invalidateRoom(room: Room): void {
    this.staticCache.delete(room.key);
    const i = this.cacheOrder.indexOf(room.key);
    if (i >= 0) this.cacheOrder.splice(i, 1);
    room.staticCanvas = null;
  }

  clearCache(): void {
    this.staticCache.clear();
    this.cacheOrder.length = 0;
  }

  drawRoomLayer(room: Room): void {
    const layer = this.staticLayer(room);
    const { ctx } = this;
    ctx.drawImage(layer, 0, 0);
  }

  // ------------------------------------------------------------- 地面预警

  drawTelegraphs(enemies: readonly Enemy[], boss: Boss | null): void {
    const { ctx } = this;
    for (const e of enemies) {
      if (e.dead) continue;
      if (e.def.ai !== 'charger' && e.def.ai !== 'brute') continue;
      if (e.state !== 'windup') continue;
      if (e.def.ai === 'charger') {
        drawWarningRect(
          ctx,
          e.x,
          e.y,
          Math.atan2(e.chargeDirY, e.chargeDirX),
          460,
          e.radius * 2,
          e.telegraph,
          '255,90,70',
        );
      }
    }
    if (boss && !boss.dead && boss.telegraph.kind !== 'none') {
      const t = boss.telegraph;
      if (t.kind === 'circle') {
        drawWarningCircle(ctx, t.x, t.y, t.radius, t.progress, t.color);
      } else if (t.kind === 'line') {
        drawWarningRect(ctx, t.x, t.y, t.angle, t.length, t.width, t.progress, t.color);
      }
    }
  }

  // ------------------------------------------------------------- 光照

  /** 动态光照层：火把闪烁 + 枪口/爆炸的额外光源（叠加混合）。 */
  drawLighting(room: Room, extra: readonly DynamicLight[], dt = 1 / 60): void {
    // 用真实 dt 推进，否则高刷新率屏幕上火光抖动会成倍加速，看起来像在"闪"
    this.lightTime += clamp(dt, 0, 0.1);
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const light of room.layout.lights) {
      const flick = 1 + Math.sin(this.lightTime * light.flicker + light.x * 0.01) * 0.09;
      const r = light.radius * flick;
      const g = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, r);
      g.addColorStop(0, withAlpha(light.color, 0.42 * light.intensity));
      g.addColorStop(0.4, withAlpha(light.color, 0.2 * light.intensity));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(light.x, light.y, r, 0, TAU);
      ctx.fill();
    }
    for (const l of extra) {
      if (l.alpha <= 0.004) continue;
      const g = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.radius);
      g.addColorStop(0, withAlpha(l.color, l.alpha));
      g.addColorStop(0.45, withAlpha(l.color, l.alpha * 0.4));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(l.x, l.y, l.radius, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /** 房间边缘的柔和压暗，强化"地牢"的封闭感。 */
  drawRoomEdgeDarkening(): void {
    const { ctx } = this;
    ctx.save();
    const d = 96;
    const bands: Array<{ x: number; y: number; w: number; h: number; g: CanvasGradient }> = [];

    const top = ctx.createLinearGradient(0, 0, 0, d);
    top.addColorStop(0, 'rgba(6,5,12,0.55)');
    top.addColorStop(1, 'rgba(6,5,12,0)');
    bands.push({ x: 0, y: 0, w: ROOM_W, h: d, g: top });

    const bottom = ctx.createLinearGradient(0, ROOM_H, 0, ROOM_H - d);
    bottom.addColorStop(0, 'rgba(6,5,12,0.55)');
    bottom.addColorStop(1, 'rgba(6,5,12,0)');
    bands.push({ x: 0, y: ROOM_H - d, w: ROOM_W, h: d, g: bottom });

    const left = ctx.createLinearGradient(0, 0, d, 0);
    left.addColorStop(0, 'rgba(6,5,12,0.5)');
    left.addColorStop(1, 'rgba(6,5,12,0)');
    bands.push({ x: 0, y: 0, w: d, h: ROOM_H, g: left });

    const right = ctx.createLinearGradient(ROOM_W, 0, ROOM_W - d, 0);
    right.addColorStop(0, 'rgba(6,5,12,0.5)');
    right.addColorStop(1, 'rgba(6,5,12,0)');
    bands.push({ x: ROOM_W - d, y: 0, w: d, h: ROOM_H, g: right });

    for (const b of bands) {
      ctx.fillStyle = b.g;
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
    ctx.restore();
  }

  drawVignette(): void {
    const { ctx } = this;
    ctx.save();
    const g = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.32, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.86);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.72, 'rgba(6,5,13,0.34)');
    g.addColorStop(1, 'rgba(4,3,10,0.76)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.restore();
  }

  /** 暗角之上的扫描线质感（很轻），提升"屏幕内"的完成度。 */
  drawScanlines(): void {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 0.045;
    ctx.fillStyle = '#000000';
    for (let y = 0; y < VIEW_H; y += 3) {
      ctx.fillRect(0, y, VIEW_W, 1);
    }
    ctx.restore();
  }
}

/** 判断某个世界坐标是否在视锥内（用于剔除）。 */
export function inView(camera: CameraState, x: number, y: number, pad = 80): boolean {
  return (
    Math.abs(x - camera.x) < VIEW_W / 2 + pad && Math.abs(y - camera.y) < VIEW_H / 2 + pad
  );
}

export function tileCenterPos(col: number, row: number): { x: number; y: number } {
  return { x: col * TILE + TILE / 2, y: row * TILE + TILE / 2 };
}

export { darken };
