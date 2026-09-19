/** 小地图：随探索逐步点亮，标记已进入过的房间、当前房间与房间类型。 */
import { TAU, clamp } from '../core/math';
import type { DungeonPlan, RoomNode } from '../dungeon/dungeon';
import { DIR_VECTORS } from '../core/types';
import { darken, roundedRectPath } from './art';

export interface MinimapState {
  /** 已被玩家"发现"的房间（进入过 或 与进入过的房间相邻） */
  discovered: Set<string>;
}

const CELL = 20;
const GAP = 5;

export function buildDiscovered(plan: DungeonPlan, visited: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const key of visited) {
    out.add(key);
    const node = plan.nodes.get(key);
    if (!node) continue;
    for (const d of node.doors) {
      const nk = node.neighbors[d];
      if (nk) out.add(nk);
    }
  }
  // 出生房永远可见
  out.add(plan.startKey);
  return out;
}

export function minimapSize(plan: DungeonPlan): { w: number; h: number } {
  const cols = plan.bounds.maxX - plan.bounds.minX + 1;
  const rows = plan.bounds.maxY - plan.bounds.minY + 1;
  return { w: cols * (CELL + GAP), h: rows * (CELL + GAP) };
}

export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  plan: DungeonPlan,
  currentKey: string,
  discovered: Set<string>,
  right: number,
  top: number,
  time: number,
): void {
  const { w, h } = minimapSize(plan);
  const pad = 12;
  const boxW = w + pad * 2;
  const boxH = h + pad * 2 + 20;

  ctx.save();
  // 背景板
  ctx.fillStyle = 'rgba(14,11,22,0.78)';
  roundedRectPath(ctx, right - boxW, top, boxW, boxH, 10);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,212,121,0.28)';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,212,121,0.75)';
  ctx.font = '600 12px "Segoe UI", "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('地牢地图', right - boxW + pad, top + 14);

  const originX = right - boxW + pad;
  const originY = top + 24;

  for (const node of plan.nodes.values()) {
    const cx = originX + (node.gx - plan.bounds.minX) * (CELL + GAP);
    const cy = originY + (node.gy - plan.bounds.minY) * (CELL + GAP);
    const isCurrent = node.key === currentKey;
    const isVisited = node.visited;
    const isDiscovered = discovered.has(node.key);

    // 连接走廊
    for (const d of node.doors) {
      const nk = node.neighbors[d];
      if (!nk) continue;
      const other = plan.nodes.get(nk);
      if (!other) continue;
      if (!discovered.has(node.key) || !discovered.has(nk)) continue;
      const ox = originX + (other.gx - plan.bounds.minX) * (CELL + GAP);
      const oy = originY + (other.gy - plan.bounds.minY) * (CELL + GAP);
      const midX = (cx + ox) / 2 + CELL / 2;
      const midY = (cy + oy) / 2 + CELL / 2;
      ctx.strokeStyle = isVisited || other.visited ? 'rgba(180,168,210,0.55)' : 'rgba(120,112,150,0.22)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx + CELL / 2, cy + CELL / 2);
      ctx.lineTo(midX, midY);
      ctx.lineTo(ox + CELL / 2, oy + CELL / 2);
      ctx.stroke();
    }
  }

  for (const node of plan.nodes.values()) {
    const cx = originX + (node.gx - plan.bounds.minX) * (CELL + GAP);
    const cy = originY + (node.gy - plan.bounds.minY) * (CELL + GAP);
    const isCurrent = node.key === currentKey;
    const isVisited = node.visited;
    const isDiscovered = discovered.has(node.key);

    if (!isDiscovered && !node.visited) {
      ctx.strokeStyle = 'rgba(90,84,116,0.16)';
      ctx.lineWidth = 1.2;
      roundedRectPath(ctx, cx, cy, CELL, CELL, 4);
      ctx.stroke();
      continue;
    }

    if (isVisited) {
      ctx.fillStyle = 'rgba(96,88,128,0.92)';
    } else {
      ctx.fillStyle = 'rgba(44,39,62,0.75)';
    }
    roundedRectPath(ctx, cx, cy, CELL, CELL, 4);
    ctx.fill();
    ctx.strokeStyle = isCurrent ? '#ffd479' : 'rgba(180,170,210,0.42)';
    ctx.lineWidth = isCurrent ? 2.4 : 1.4;
    ctx.stroke();

    if (!isVisited && isDiscovered) {
      // 未探索：只显示一个问号
      ctx.fillStyle = 'rgba(190,182,214,0.55)';
      ctx.font = '700 12px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('?', cx + CELL / 2, cy + CELL / 2 + 0.5);
      ctx.textAlign = 'left';
      continue;
    }

    drawRoomGlyph(ctx, node, cx, cy, time);

    if (isCurrent) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.35 + Math.sin(time * 5) * 0.15;
      ctx.strokeStyle = '#ffd479';
      ctx.lineWidth = 2;
      roundedRectPath(ctx, cx - 3, cy - 3, CELL + 6, CELL + 6, 6);
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.restore();
}

function drawRoomGlyph(
  ctx: CanvasRenderingContext2D,
  node: RoomNode,
  cx: number,
  cy: number,
  time: number,
): void {
  const mx = cx + CELL / 2;
  const my = cy + CELL / 2;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  switch (node.type) {
    case 'start':
      ctx.fillStyle = '#7ef2c0';
      ctx.beginPath();
      ctx.moveTo(mx, my - 6);
      ctx.lineTo(mx + 5.5, my);
      ctx.lineTo(mx, my + 6);
      ctx.lineTo(mx - 5.5, my);
      ctx.closePath();
      ctx.fill();
      break;
    case 'boss':
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.6 + Math.sin(time * 4) * 0.25;
      ctx.fillStyle = '#ff5a4a';
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU - Math.PI / 2;
        const rr = i % 2 === 0 ? 7.4 : 3.4;
        if (i === 0) ctx.moveTo(mx + Math.cos(a) * rr, my + Math.sin(a) * rr);
        else ctx.lineTo(mx + Math.cos(a) * rr, my + Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    case 'elite':
      ctx.fillStyle = '#ffb14a';
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU - Math.PI / 2;
        const rr = i % 2 === 0 ? 7 : 3.2;
        if (i === 0) ctx.moveTo(mx + Math.cos(a) * rr, my + Math.sin(a) * rr);
        else ctx.lineTo(mx + Math.cos(a) * rr, my + Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
      break;
    case 'treasure':
      ctx.fillStyle = '#ffd479';
      ctx.fillRect(mx - 6, my - 4, 12, 9);
      ctx.fillStyle = darken('#ffd479', 0.35);
      ctx.fillRect(mx - 6, my - 1, 12, 2);
      ctx.fillStyle = '#5c4718';
      ctx.fillRect(mx - 1.4, my - 1.6, 2.8, 3.2);
      break;
    case 'shop':
      ctx.fillStyle = '#9ff5e0';
      ctx.beginPath();
      ctx.arc(mx, my, 6, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#16403a';
      ctx.font = '700 9px "Segoe UI", sans-serif';
      ctx.fillText('$', mx, my + 0.5);
      break;
    case 'event':
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55 + Math.sin(time * 3.5) * 0.2;
      ctx.fillStyle = '#c8a2ff';
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        const rr = i % 2 === 0 ? 7 : 3;
        if (i === 0) ctx.moveTo(mx + Math.cos(a) * rr, my + Math.sin(a) * rr);
        else ctx.lineTo(mx + Math.cos(a) * rr, my + Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    default:
      // 普通战斗房：一个小点
      ctx.fillStyle = node.cleared ? 'rgba(160,152,190,0.5)' : 'rgba(220,210,240,0.85)';
      ctx.beginPath();
      ctx.arc(mx, my, 3.2, 0, TAU);
      ctx.fill();
      break;
  }
  ctx.restore();
}

/** 开门指示：当前房间可通往但尚未清理的方向（用于 HUD 提示）。 */
export function availableDirections(node: RoomNode): number {
  return node.doors.length;
}

export function clampCell(v: number): number {
  return clamp(v, 0, 1);
}

export { DIR_VECTORS };
