/**
 * 房间静态图层烘焙：地板、墙体（2.5D 正面 + 顶面）、石柱、木箱、雕像、火盆、地裂、碎石、苔藓等。
 * 只在进入房间时烘焙一次，之后每帧直接 drawImage，是保证性能的关键。
 */
import { TAU, RNG, clamp } from '../core/math';
import {
  DOOR_GAP,
  DOOR_GAP_START_X,
  DOOR_GAP_START_Y,
  ROOM_COLS,
  ROOM_H,
  ROOM_ROWS,
  ROOM_W,
  TILE,
  Tile,
} from '../data/config';
import type { DecorItem, LightDef, Room } from '../dungeon/room';
import { darken, drawShadow, ellipsePath, lighten, mixHex, roundedRectPath, withAlpha } from './art';

const WALL_FRONT = 17;

function tileNoise(rng: RNG, col: number, row: number): number {
  const local = new RNG(((col * 73856093) ^ (row * 19349663)) >>> 0);
  return local.next() * 0 + rng.next();
}

export function bakeRoomCanvas(room: Room): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ROOM_W;
  canvas.height = ROOM_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const rng = new RNG(((room.col + 97) * 2654435761) ^ ((room.row + 31) * 40503) ^ 0x9e3779b9);

  drawFloor(ctx, room, rng);
  drawDecorLayer(ctx, room, rng);
  drawWallTops(ctx, room, rng);
  drawWallFronts(ctx, room);
  drawProps(ctx, room, rng);
  drawTorchBrackets(ctx, room);
  return canvas;
}

// ------------------------------------------------------------------ 地板

function drawFloor(ctx: CanvasRenderingContext2D, room: Room, rng: RNG): void {
  const base = new RNG(1337);
  // 底色
  ctx.fillStyle = '#241f2e';
  ctx.fillRect(0, 0, ROOM_W, ROOM_H);

  for (let r = 0; r < ROOM_ROWS; r++) {
    for (let c = 0; c < ROOM_COLS; c++) {
      const x = c * TILE;
      const y = r * TILE;
      const jitter = base.next();
      const tintMix = 0.06 + jitter * 0.1;
      const col = mixHex('#3d3547', '#4a4155', tintMix);
      ctx.fillStyle = col;
      ctx.fillRect(x, y, TILE, TILE);

      // 石板分割线
      ctx.strokeStyle = withAlpha('#15111e', 0.6);
      ctx.lineWidth = 1.4;
      ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);

      // 顶面高光（左上）
      ctx.strokeStyle = withAlpha('#6b6079', 0.22);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x + 2, y + TILE - 2);
      ctx.lineTo(x + 2, y + 2);
      ctx.lineTo(x + TILE - 2, y + 2);
      ctx.stroke();

      // 部分瓦片随机铺两块小砖，打破规则感
      if (base.next() < 0.14) {
        const half = TILE / 2;
        const ox = base.next() < 0.5 ? 0 : half;
        const oy = base.next() < 0.5 ? 0 : half;
        ctx.fillStyle = withAlpha('#4f4760', 0.5);
        ctx.fillRect(x + ox + 3, y + oy + 3, half - 6, half - 6);
        ctx.strokeStyle = withAlpha('#15111e', 0.55);
        ctx.strokeRect(x + ox + 3, y + oy + 3, half - 6, half - 6);
      }

      // 轻微污渍
      if (base.next() < 0.2) {
        const sx = x + base.next() * TILE;
        const sy = y + base.next() * TILE;
        const rr = 8 + base.next() * 18;
        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, rr);
        g.addColorStop(0, withAlpha('#1b1626', 0.42));
        g.addColorStop(1, withAlpha('#1b1626', 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(sx, sy, rr, 0, TAU);
        ctx.fill();
      }
    }
  }

  // 房间中央的低调光晕，强化"聚焦战斗区域"的观感
  const cg = ctx.createRadialGradient(ROOM_W / 2, ROOM_H / 2, 40, ROOM_W / 2, ROOM_H / 2, 520);
  cg.addColorStop(0, 'rgba(120,110,150,0.09)');
  cg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = cg;
  ctx.fillRect(0, 0, ROOM_W, ROOM_H);
  void rng;
}

function drawDecorLayer(ctx: CanvasRenderingContext2D, room: Room, rng: RNG): void {
  for (const d of room.layout.decor) {
    drawDecorItem(ctx, d, rng);
  }
}

function drawDecorItem(ctx: CanvasRenderingContext2D, d: DecorItem, rng: RNG): void {
  const x = d.col * TILE;
  const y = d.row * TILE;
  const s = d.scale;
  const local = new RNG(d.seed);
  switch (d.kind) {
    case 'crack': {
      ctx.save();
      ctx.strokeStyle = withAlpha('#120e1c', 0.72);
      ctx.lineWidth = 2 * s;
      ctx.lineCap = 'round';
      ctx.beginPath();
      let px = x;
      let py = y;
      ctx.moveTo(px, py);
      const branches = 3 + Math.floor(local.next() * 4);
      for (let i = 0; i < branches; i++) {
        px += (local.next() - 0.5) * 26 * s;
        py += (local.next() - 0.3) * 22 * s;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.strokeStyle = withAlpha('#5c5270', 0.28);
      ctx.lineWidth = 1 * s;
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'pebbles': {
      const n = 3 + Math.floor(local.next() * 4);
      for (let i = 0; i < n; i++) {
        const px = x + (local.next() - 0.5) * 30;
        const py = y + (local.next() - 0.5) * 30;
        const rr = 2.6 + local.next() * 4.2 * s;
        ctx.fillStyle = mixHex('#4b4358', '#6a5f78', local.next());
        ellipsePath(ctx, px, py, rr, rr * 0.72, local.next() * TAU);
        ctx.fill();
        ctx.strokeStyle = withAlpha('#15111e', 0.5);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      break;
    }
    case 'moss': {
      const g = ctx.createRadialGradient(x, y, 2, x, y, 26 * s);
      g.addColorStop(0, 'rgba(88,126,72,0.5)');
      g.addColorStop(0.6, 'rgba(60,92,52,0.28)');
      g.addColorStop(1, 'rgba(60,92,52,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 26 * s, 0, TAU);
      ctx.fill();
      for (let i = 0; i < 5; i++) {
        const px = x + (local.next() - 0.5) * 30;
        const py = y + (local.next() - 0.5) * 30;
        ctx.fillStyle = `rgba(${90 + local.next() * 40},${130 + local.next() * 40},70,0.5)`;
        ellipsePath(ctx, px, py, 4 + local.next() * 5, 3 + local.next() * 3.6, local.next() * TAU);
        ctx.fill();
      }
      break;
    }
    case 'grate': {
      ctx.save();
      ctx.fillStyle = '#1c1726';
      roundedRectPath(ctx, x - 20 * s, y - 20 * s, 40 * s, 40 * s, 4);
      ctx.fill();
      ctx.strokeStyle = '#4d4459';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.strokeStyle = '#5d5470';
      ctx.lineWidth = 2;
      for (let i = 1; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(x - 20 * s + (i * 40 * s) / 4, y - 18 * s);
        ctx.lineTo(x - 20 * s + (i * 40 * s) / 4, y + 18 * s);
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case 'stain': {
      ctx.save();
      ctx.globalAlpha = 0.5;
      const g = ctx.createRadialGradient(x, y, 2, x, y, 30 * s);
      g.addColorStop(0, 'rgba(70,40,60,0.6)');
      g.addColorStop(1, 'rgba(70,40,60,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, 30 * s, 22 * s, local.next() * TAU, 0, TAU);
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'plate': {
      ctx.save();
      ctx.fillStyle = withAlpha('#5a5169', 0.65);
      roundedRectPath(ctx, x - 22 * s, y - 22 * s, 44 * s, 44 * s, 5);
      ctx.fill();
      ctx.strokeStyle = withAlpha('#191524', 0.8);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.strokeStyle = withAlpha('#8478a0', 0.4);
      ctx.lineWidth = 1.2;
      roundedRectPath(ctx, x - 17 * s, y - 17 * s, 34 * s, 34 * s, 4);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'inlay': {
      ctx.save();
      ctx.translate(x, y);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = '#ffd479';
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.ellipse(0, 0, 60 - i * 15, 60 - i * 15, 0, 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.22;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 30, Math.sin(a) * 30);
        ctx.lineTo(Math.cos(a) * 58, Math.sin(a) * 58);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = '#ffd479';
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU - Math.PI / 2;
        const rr = i % 2 === 0 ? 34 : 14;
        if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
  }
}

// ------------------------------------------------------------------ 墙体

function drawWallTops(ctx: CanvasRenderingContext2D, room: Room, rng: RNG): void {
  const tiles = room.layout.tiles;
  const local = new RNG(4242);
  for (let r = 0; r < ROOM_ROWS; r++) {
    for (let c = 0; c < ROOM_COLS; c++) {
      if (tiles[r * ROOM_COLS + c] !== Tile.Wall) continue;
      const x = c * TILE;
      const y = r * TILE;
      const shade = mixHex('#5b536b', '#6d647d', local.next() * 0.7);
      const g = ctx.createLinearGradient(x, y, x, y + TILE);
      g.addColorStop(0, lighten(shade, 0.22));
      g.addColorStop(0.5, shade);
      g.addColorStop(1, darken(shade, 0.32));
      ctx.fillStyle = g;
      ctx.fillRect(x, y, TILE, TILE);

      // 砖缝
      ctx.strokeStyle = withAlpha('#1a1526', 0.7);
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      if ((c + r) % 2 === 0) {
        ctx.moveTo(x + TILE / 2, y + 1);
        ctx.lineTo(x + TILE / 2, y + TILE / 2);
        ctx.moveTo(x + TILE / 2, y + TILE / 2);
        ctx.lineTo(x + TILE / 2, y + TILE - 1);
      }
      ctx.moveTo(x + 1, y + TILE / 2);
      ctx.lineTo(x + TILE - 1, y + TILE / 2);
      ctx.stroke();

      // 顶面高光边
      ctx.strokeStyle = withAlpha('#9d92b5', 0.35);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 1.5, y + TILE - 1.5);
      ctx.lineTo(x + 1.5, y + 1.5);
      ctx.lineTo(x + TILE - 1.5, y + 1.5);
      ctx.stroke();
    }
  }
  void rng;
}

function drawWallFronts(ctx: CanvasRenderingContext2D, room: Room): void {
  const tiles = room.layout.tiles;
  for (let r = 0; r < ROOM_ROWS; r++) {
    for (let c = 0; c < ROOM_COLS; c++) {
      if (tiles[r * ROOM_COLS + c] !== Tile.Wall) continue;
      const below = r + 1 >= ROOM_ROWS ? -1 : tiles[(r + 1) * ROOM_COLS + c];
      if (below === Tile.Wall) continue;
      const x = c * TILE;
      const y = r * TILE;
      const fy = y + TILE - 2;
      const g = ctx.createLinearGradient(x, fy, x, fy + WALL_FRONT);
      g.addColorStop(0, '#39324a');
      g.addColorStop(0.35, '#2c263a');
      g.addColorStop(1, '#1a1526');
      ctx.fillStyle = g;
      ctx.fillRect(x, fy, TILE, WALL_FRONT);
      ctx.strokeStyle = withAlpha('#0f0b18', 0.85);
      ctx.lineWidth = 1.6;
      ctx.strokeRect(x + 0.8, fy + 0.8, TILE - 1.6, WALL_FRONT);
      // 底部投影，让墙体"浮"在地板上
      const sg = ctx.createLinearGradient(x, fy + WALL_FRONT, x, fy + WALL_FRONT + 10);
      sg.addColorStop(0, 'rgba(0,0,0,0.42)');
      sg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(x, fy + WALL_FRONT, TILE, 10);
    }
  }
  // 门洞装饰：门框
  for (const dir of room.doors) {
    drawDoorFrame(ctx, dir);
  }
}

function drawDoorFrame(ctx: CanvasRenderingContext2D, dir: 'n' | 'e' | 's' | 'w'): void {
  const gapPx = DOOR_GAP * TILE;
  ctx.save();
  const pillarW = 10;
  const drawPillar = (x: number, y: number, w: number, h: number) => {
    const g = ctx.createLinearGradient(x, y, x + w, y);
    g.addColorStop(0, '#6b6178');
    g.addColorStop(0.5, '#4d4560');
    g.addColorStop(1, '#2c263a');
    ctx.fillStyle = g;
    roundedRectPath(ctx, x, y, w, h, 3);
    ctx.fill();
    ctx.strokeStyle = withAlpha('#141020', 0.9);
    ctx.lineWidth = 1.6;
    ctx.stroke();
  };
  if (dir === 'n' || dir === 's') {
    const y = dir === 'n' ? 0 : ROOM_H - TILE;
    drawPillar(DOOR_GAP_START_X * TILE - pillarW, y, pillarW, TILE);
    drawPillar((DOOR_GAP_START_X + DOOR_GAP) * TILE, y, pillarW, TILE);
  } else {
    const x = dir === 'w' ? 0 : ROOM_W - TILE;
    const g = ctx.createLinearGradient(x, DOOR_GAP_START_Y * TILE - pillarW, x, DOOR_GAP_START_Y * TILE);
    g.addColorStop(0, '#6b6178');
    g.addColorStop(1, '#2c263a');
    ctx.fillStyle = g;
    roundedRectPath(ctx, x, DOOR_GAP_START_Y * TILE - pillarW, TILE, pillarW, 3);
    ctx.fill();
    roundedRectPath(ctx, x, (DOOR_GAP_START_Y + DOOR_GAP) * TILE, TILE, pillarW, 3);
    ctx.fill();
    ctx.strokeStyle = withAlpha('#141020', 0.9);
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  void gapPx;
  ctx.restore();
}

// ------------------------------------------------------------------ 房间内道具

function drawProps(ctx: CanvasRenderingContext2D, room: Room, rng: RNG): void {
  const tiles = room.layout.tiles;
  // 按行排序，保证近处的道具覆盖远处的
  for (let r = 0; r < ROOM_ROWS; r++) {
    for (let c = 0; c < ROOM_COLS; c++) {
      const t = tiles[r * ROOM_COLS + c];
      const x = c * TILE;
      const y = r * TILE;
      const seed = ((c * 31 + r * 17) * 2654435761) >>> 0;
      if (t === Tile.Pillar) drawPillar(ctx, x, y, seed);
      else if (t === Tile.Crate) drawCrate(ctx, x, y, seed);
      else if (t === Tile.Statue) drawStatue(ctx, x, y, seed);
      else if (t === Tile.Brazier) drawBrazier(ctx, x, y, seed);
      void rng;
    }
  }
}

function drawPillar(ctx: CanvasRenderingContext2D, x: number, y: number, seed: number): void {
  const cx = x + TILE / 2;
  const baseY = y + TILE;
  const rng = new RNG(seed);
  drawShadow(ctx, cx, baseY - 6, TILE * 0.46, TILE * 0.2, 0.42);

  // 基座
  ctx.fillStyle = '#3b3450';
  ellipsePath(ctx, cx, baseY - 8, TILE * 0.46, TILE * 0.19);
  ctx.fill();
  ctx.strokeStyle = withAlpha('#15111e', 0.85);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#4d4560';
  ellipsePath(ctx, cx, baseY - 12, TILE * 0.44, TILE * 0.18);
  ctx.fill();

  // 柱身
  const shaftW = TILE * 0.56;
  const shaftTop = y + 2;
  const shaftBottom = baseY - 10;
  const g = ctx.createLinearGradient(cx - shaftW / 2, 0, cx + shaftW / 2, 0);
  g.addColorStop(0, '#332c46');
  g.addColorStop(0.32, '#6f6684');
  g.addColorStop(0.6, '#5a5270');
  g.addColorStop(1, '#2b2539');
  ctx.fillStyle = g;
  roundedRectPath(ctx, cx - shaftW / 2, shaftTop, shaftW, shaftBottom - shaftTop, 4);
  ctx.fill();
  ctx.strokeStyle = withAlpha('#15111e', 0.9);
  ctx.lineWidth = 2.2;
  ctx.stroke();

  // 凹槽
  ctx.strokeStyle = withAlpha('#241f34', 0.6);
  ctx.lineWidth = 1.6;
  for (let i = 1; i <= 2; i++) {
    const fx = cx - shaftW / 2 + (shaftW / 3) * i;
    ctx.beginPath();
    ctx.moveTo(fx, shaftTop + 6);
    ctx.lineTo(fx, shaftBottom - 6);
    ctx.stroke();
  }

  // 柱头
  ctx.fillStyle = '#5f5675';
  roundedRectPath(ctx, cx - shaftW * 0.72, shaftTop - 8, shaftW * 1.44, 12, 4);
  ctx.fill();
  ctx.strokeStyle = withAlpha('#15111e', 0.9);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#7d7395';
  ellipsePath(ctx, cx, shaftTop - 8, shaftW * 0.72, 5);
  ctx.fill();

  // 裂纹
  if (rng.next() < 0.55) {
    ctx.strokeStyle = withAlpha('#231d33', 0.75);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let px = cx + (rng.next() - 0.5) * shaftW * 0.5;
    let py = shaftTop + 8 + rng.next() * 10;
    ctx.moveTo(px, py);
    for (let i = 0; i < 3; i++) {
      px += (rng.next() - 0.5) * 12;
      py += 6 + rng.next() * 10;
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  // 顶部高光
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#cbbfe8';
  roundedRectPath(ctx, cx - shaftW / 2 + 3, shaftTop + 2, 5, shaftBottom - shaftTop - 12, 3);
  ctx.fill();
  ctx.restore();
}

function drawCrate(ctx: CanvasRenderingContext2D, x: number, y: number, seed: number): void {
  const rng = new RNG(seed);
  const pad = 3;
  const w = TILE - pad * 2;
  drawShadow(ctx, x + TILE / 2, y + TILE - 6, TILE * 0.44, TILE * 0.16, 0.4);

  // 正面
  const g = ctx.createLinearGradient(x, y, x, y + TILE);
  g.addColorStop(0, '#8a6238');
  g.addColorStop(0.6, '#6b4a2c');
  g.addColorStop(1, '#42291a');
  ctx.fillStyle = g;
  roundedRectPath(ctx, x + pad, y + pad + 5, w, w - 5, 4);
  ctx.fill();
  ctx.strokeStyle = '#2b1a10';
  ctx.lineWidth = 2.2;
  ctx.stroke();

  // 顶面（2.5D）
  ctx.fillStyle = '#a37a48';
  ctx.beginPath();
  ctx.moveTo(x + pad, y + pad + 5);
  ctx.lineTo(x + pad + 6, y + pad - 1);
  ctx.lineTo(x + pad + w, y + pad - 1);
  ctx.lineTo(x + pad + w, y + pad + 5);
  ctx.closePath();
  ctx.fill();

  // 木板
  ctx.strokeStyle = withAlpha('#311f12', 0.7);
  ctx.lineWidth = 1.4;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(x + pad + 2, y + pad + 5 + ((w - 5) / 4) * i);
    ctx.lineTo(x + pad + w - 2, y + pad + 5 + ((w - 5) / 4) * i);
    ctx.stroke();
  }
  // 金属角
  ctx.fillStyle = '#8c8fa0';
  const s = 7;
  for (const [ox, oy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    ctx.fillRect(x + pad + ox! * (w - s), y + pad + 5 + oy! * (w - 5 - s), s, s);
  }
  ctx.strokeStyle = '#2b1a10';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // 木质纹理
  if (rng.next() < 0.6) {
    ctx.strokeStyle = withAlpha('#3d2716', 0.55);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x + pad + 6, y + pad + 10);
    ctx.quadraticCurveTo(x + pad + w / 2, y + pad + w / 2, x + pad + w - 6, y + pad + 12);
    ctx.stroke();
  }
}

function drawStatue(ctx: CanvasRenderingContext2D, x: number, y: number, seed: number): void {
  const cx = x + TILE / 2;
  const baseY = y + TILE;
  const rng = new RNG(seed);
  drawShadow(ctx, cx, baseY - 6, TILE * 0.44, TILE * 0.18, 0.44);
  // 基座
  ctx.fillStyle = '#413a52';
  roundedRectPath(ctx, cx - TILE * 0.36, baseY - 20, TILE * 0.72, 16, 3);
  ctx.fill();
  ctx.strokeStyle = withAlpha('#15111e', 0.9);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#514868';
  ellipsePath(ctx, cx, baseY - 20, TILE * 0.36, 5);
  ctx.fill();

  // 兜帽雕像
  const g = ctx.createLinearGradient(cx - 14, y, cx + 14, baseY - 20);
  g.addColorStop(0, '#655b7d');
  g.addColorStop(0.55, '#4a4260');
  g.addColorStop(1, '#2e2840');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(cx - 15, baseY - 20);
  ctx.quadraticCurveTo(cx - 17, y + 8, cx, y + 2);
  ctx.quadraticCurveTo(cx + 17, y + 8, cx + 15, baseY - 20);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = withAlpha('#15111e', 0.9);
  ctx.lineWidth = 2;
  ctx.stroke();
  // 兜帽阴影
  ctx.fillStyle = '#1c1728';
  ctx.beginPath();
  ctx.ellipse(cx, y + 17, 8.5, 10, 0, 0, TAU);
  ctx.fill();
  // 幽光眼
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.55 + Math.sin(rng.next() * 6) * 0.1;
  ctx.fillStyle = '#7ef2c0';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(cx + s * 3.4, y + 17, 1.7, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  // 手持长杖
  ctx.strokeStyle = '#6b6a80';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx + 16, baseY - 22);
  ctx.lineTo(cx + 19, y - 2);
  ctx.stroke();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = '#9fe8ff';
  ctx.beginPath();
  ctx.arc(cx + 19, y - 4, 4, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawBrazier(ctx: CanvasRenderingContext2D, x: number, y: number, seed: number): void {
  const cx = x + TILE / 2;
  const cy = y + TILE / 2 + 4;
  const rng = new RNG(seed);
  drawShadow(ctx, cx, cy + 12, 20, 8, 0.45);
  // 三脚
  ctx.strokeStyle = '#2e2839';
  ctx.lineWidth = 3.4;
  ctx.lineCap = 'round';
  for (const s of [-1, 0, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + s * 9, cy + 6);
    ctx.lineTo(cx + s * 14, cy + 15);
    ctx.stroke();
  }
  // 盆
  const g = ctx.createLinearGradient(cx, cy - 10, cx, cy + 8);
  g.addColorStop(0, '#6d647d');
  g.addColorStop(0.5, '#4a4358');
  g.addColorStop(1, '#282232');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(cx - 17, cy - 8);
  ctx.lineTo(cx + 17, cy - 8);
  ctx.lineTo(cx + 12, cy + 8);
  ctx.lineTo(cx - 12, cy + 8);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = withAlpha('#15111e', 0.9);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#8d8399';
  ellipsePath(ctx, cx, cy - 8, 17, 5.4);
  ctx.fill();
  // 炭火
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = '#ff7a2f';
  ellipsePath(ctx, cx, cy - 8, 12, 3.6);
  ctx.fill();
  ctx.restore();
  void rng;
}

function drawTorchBrackets(ctx: CanvasRenderingContext2D, room: Room): void {
  for (const light of room.layout.lights) {
    if (light.kind !== 'torch') continue;
    drawTorchBracket(ctx, light);
  }
}

function drawTorchBracket(ctx: CanvasRenderingContext2D, light: LightDef): void {
  ctx.save();
  ctx.translate(light.x, light.y);
  const onTopWall = light.y < ROOM_H / 2;
  ctx.rotate(onTopWall ? Math.PI : 0);
  // 支架
  ctx.strokeStyle = '#3a3448';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-6, -4);
  ctx.lineTo(-6, 8);
  ctx.stroke();
  // 火把杆
  ctx.fillStyle = '#5a4a34';
  roundedRectPath(ctx, -3, -12, 6, 20, 2);
  ctx.fill();
  ctx.strokeStyle = '#2d2318';
  ctx.lineWidth = 1.6;
  ctx.stroke();
  // 火把顶端的布
  ctx.fillStyle = '#6b4a2c';
  ellipsePath(ctx, 0, -12, 5, 4);
  ctx.fill();
  ctx.restore();
}

/** 中心光晕（供参考，实际光照在 renderer 中动态绘制） */
export function lightGlowRadius(light: LightDef): number {
  return clamp(light.radius * (0.85 + light.intensity * 0.3), 60, 320);
}
