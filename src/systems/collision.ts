/** 碰撞与移动：圆 vs 瓦片网格 / 门的轴分离求解，以及实体之间的分离。 */
import { ROOM_H, ROOM_W, TILE } from '../data/config';
import type { Room } from '../dungeon/room';
import { circleRectResolve, clamp } from '../core/math';
import type { Rect } from '../core/math';

export interface CircleBody {
  x: number;
  y: number;
  radius: number;
}

const buffer: Rect[] = [];

/** 把圆推出房间内的所有静态阻挡。返回是否发生过碰撞。 */
export function resolveStaticCollision(body: CircleBody, room: Room): boolean {
  let collided = false;
  room.collectBlockers(body.x, body.y, body.radius + 6, buffer);
  for (let pass = 0; pass < 3; pass++) {
    let any = false;
    for (const rect of buffer) {
      const res = circleRectResolve(body.x, body.y, body.radius, rect);
      if (res) {
        body.x = res.x;
        body.y = res.y;
        any = true;
        collided = true;
      }
    }
    if (!any) break;
  }
  const cx = clamp(body.x, body.radius, ROOM_W - body.radius);
  const cy = clamp(body.y, body.radius, ROOM_H - body.radius);
  if (cx !== body.x || cy !== body.y) collided = true;
  body.x = cx;
  body.y = cy;
  return collided;
}

/** 轴分离移动：先 X 后 Y，避免贴墙时被卡住。 */
export function moveCircle(
  body: CircleBody,
  room: Room,
  dx: number,
  dy: number,
): { hitX: boolean; hitY: boolean } {
  let hitX = false;
  let hitY = false;
  if (dx !== 0) {
    body.x += dx;
    hitX = resolveStaticCollision(body, room);
  }
  if (dy !== 0) {
    body.y += dy;
    hitY = resolveStaticCollision(body, room);
  }
  return { hitX, hitY };
}

export interface SeparateBody extends CircleBody {
  vx: number;
  vy: number;
}

/** 实体之间的软分离：避免大量敌人完全重叠而看起来像"叠在一起的一团"。 */
export function separateCircles(bodies: readonly SeparateBody[], strength = 0.5): void {
  const n = bodies.length;
  for (let i = 0; i < n; i++) {
    const a = bodies[i]!;
    for (let j = i + 1; j < n; j++) {
      const b = bodies[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const minD = a.radius + b.radius;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minD * minD || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const overlap = (minD - d) * strength;
      const nx = dx / d;
      const ny = dy / d;
      const push = overlap * 0.5;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
      // 顺带把速度也稍微分开，减少下一帧继续重叠
      a.vx -= nx * overlap * 2;
      a.vy -= ny * overlap * 2;
      b.vx += nx * overlap * 2;
      b.vy += ny * overlap * 2;
    }
  }
}

/** 玩家能否站在某点（用于 Enemy 判断是否需要绕路，以及出生点校验）。 */
export function canStandAt(room: Room, x: number, y: number, radius: number): boolean {
  if (x < radius || y < radius || x > ROOM_W - radius || y > ROOM_H - radius) return false;
  const collides = circleRectSample(room, x, y, radius);
  return !collides;
}

function circleRectSample(room: Room, x: number, y: number, radius: number): boolean {
  const minC = Math.max(0, Math.floor((x - radius) / TILE));
  const maxC = Math.min(27, Math.floor((x + radius) / TILE));
  const minR = Math.max(0, Math.floor((y - radius) / TILE));
  const maxR = Math.min(17, Math.floor((y + radius) / TILE));
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      if (!room.isBlockedPoint(c * TILE + TILE / 2, r * TILE + TILE / 2)) continue;
      const rect = { x: c * TILE, y: r * TILE, w: TILE, h: TILE };
      const nx = clamp(x, rect.x, rect.x + rect.w);
      const ny = clamp(y, rect.y, rect.y + rect.h);
      if ((x - nx) ** 2 + (y - ny) ** 2 < radius * radius) return true;
    }
  }
  return false;
}

/**
 * 简易寻路：当直接朝玩家移动被墙挡住时，沿垂直方向绕行。
 * 返回单位方向向量。
 */
export function steerAroundObstacles(
  room: Room,
  x: number,
  y: number,
  targetX: number,
  targetY: number,
  radius: number,
): { x: number; y: number } {
  const dx = targetX - x;
  const dy = targetY - y;
  const len = Math.hypot(dx, dy) || 1;
  const dirX = dx / len;
  const dirY = dy / len;
  const probe = radius + TILE * 0.85;
  if (!circleRectSample(room, x + dirX * probe, y + dirY * probe, radius)) {
    return { x: dirX, y: dirY };
  }
  // 尝试两个垂直方向
  const perpA = { x: -dirY, y: dirX };
  const perpB = { x: dirY, y: -dirX };
  for (const p of [perpA, perpB]) {
    if (!circleRectSample(room, x + p.x * probe, y + p.y * probe, radius)) {
      return { x: p.x * 0.85 + dirX * 0.5, y: p.y * 0.85 + dirY * 0.5 };
    }
  }
  return { x: dirX, y: dirY };
}
