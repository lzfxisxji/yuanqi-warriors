/**
 * 房间：瓦片布局生成 + 运行期状态。
 *
 * 布局生成保证「一定可通行」的实现方式：
 *  1. 先计算「保护区」= 每个已存在门洞的 2 格宽内走廊 ∪ 房间中央 5x5 ∪ 门洞前 2 格空地。
 *  2. 障碍只在保护区之外的自由地砖上放置。
 *  3. 由于每个门的保护区走廊都与中央区连通，从中央出发必然可达所有门。
 *  4. 生成后再用 BFS 复核一次（安全网），失败则降低密度重试，最终兜底清空障碍。
 */
import {
  CRATE_HP,
  DOOR_GAP,
  DOOR_GAP_START_X,
  DOOR_GAP_START_Y,
  ROOM_COLS,
  ROOM_H,
  ROOM_ROWS,
  ROOM_W,
  TILE,
  Tile,
  isBlockingTile,
} from '../data/config';
import type { Rect } from '../core/math';
import { RNG } from '../core/math';
import type { Dir4, RoomType } from '../core/types';
import { DIR_VECTORS, OPPOSITE_DIR } from '../core/types';

export type DecorKind = 'crack' | 'pebbles' | 'moss' | 'inlay' | 'grate' | 'stain' | 'plate';

export interface DecorItem {
  kind: DecorKind;
  /** 瓦片坐标（浮点，允许偏移到瓦片内部任意位置） */
  col: number;
  row: number;
  seed: number;
  scale: number;
}

export interface LightDef {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  color: string;
  flicker: number;
  kind: 'torch' | 'brazier' | 'crystal';
}

export interface RoomLayout {
  tiles: Uint8Array;
  decor: DecorItem[];
  crates: number[];
  lights: LightDef[];
  spawnTiles: number[];
  obstacleTiles: number;
}

export interface RoomLayoutOptions {
  doors: readonly Dir4[];
  roomType: RoomType;
  /** 生成种子，同一房间每次生成结果一致 */
  seed: number;
}

export function tileIndex(col: number, row: number): number {
  return row * ROOM_COLS + col;
}

export function tileAt(tiles: Uint8Array, col: number, row: number): number {
  if (col < 0 || col >= ROOM_COLS || row < 0 || row >= ROOM_ROWS) return Tile.Wall;
  return tiles[tileIndex(col, row)]!;
}

export function setTile(tiles: Uint8Array, col: number, row: number, value: number): void {
  if (col < 0 || col >= ROOM_COLS || row < 0 || row >= ROOM_ROWS) return;
  tiles[tileIndex(col, row)] = value;
}

export function tileCenter(col: number, row: number): { x: number; y: number } {
  return { x: col * TILE + TILE / 2, y: row * TILE + TILE / 2 };
}

export function tileRect(col: number, row: number): Rect {
  return { x: col * TILE, y: row * TILE, w: TILE, h: TILE };
}

/** 各房间类型的障碍预算（按"占用瓦片数"计）。 */
const OBSTACLE_BUDGET: Record<RoomType, number> = {
  start: 10,
  combat: 30,
  elite: 27,
  treasure: 16,
  shop: 14,
  event: 15,
  boss: 8,
};

/** 门洞在房间坐标系中的矩形（位于边界的那一列/一行瓦片上）。 */
export function doorRect(dir: Dir4): Rect {
  const gapPx = DOOR_GAP * TILE;
  switch (dir) {
    case 'n':
      return { x: DOOR_GAP_START_X * TILE, y: 0, w: gapPx, h: TILE };
    case 's':
      return { x: DOOR_GAP_START_X * TILE, y: (ROOM_ROWS - 1) * TILE, w: gapPx, h: TILE };
    case 'w':
      return { x: 0, y: DOOR_GAP_START_Y * TILE, w: TILE, h: gapPx };
    case 'e':
      return { x: (ROOM_COLS - 1) * TILE, y: DOOR_GAP_START_Y * TILE, w: TILE, h: gapPx };
  }
}

export function doorCenter(dir: Dir4): { x: number; y: number } {
  const r = doorRect(dir);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * 门洞「已穿过」判定深度：玩家圆心进入房间边界内这么多像素即视为穿门。
 *
 * 这个值必须**小于** doorEntryPoint 的 inset，否则入场落点本身就落在触发区内，
 * 玩家一进入新房间就会被判定为"又穿了一次门"，和上一间房无限来回弹跳
 * （表现就是画面一直闪、楼层/房间切换错乱）。
 */
export const DOOR_TRIGGER_DEPTH = TILE * 0.6;

/** 玩家从某扇门进入房间时的落点（房内、离墙一定距离）。 */
export function doorEntryPoint(dir: Dir4): { x: number; y: number } {
  const c = doorCenter(dir);
  const inset = TILE * 1.15;
  switch (dir) {
    case 'n':
      return { x: c.x, y: inset };
    case 's':
      return { x: c.x, y: ROOM_H - inset };
    case 'w':
      return { x: inset, y: c.y };
    case 'e':
      return { x: ROOM_W - inset, y: c.y };
  }
}

/** 保护区：这些瓦片永远不会放障碍。 */
function buildProtectedMask(doors: readonly Dir4[]): Uint8Array {
  const mask = new Uint8Array(ROOM_COLS * ROOM_ROWS);
  const protect = (col: number, row: number) => {
    if (col < 0 || col >= ROOM_COLS || row < 0 || row >= ROOM_ROWS) return;
    mask[tileIndex(col, row)] = 1;
  };
  const protectRect = (c0: number, r0: number, c1: number, r1: number) => {
    for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) protect(c, r);
  };

  // 中央 5x5 保护区（玩家落点 + 战斗空间）
  protectRect(12, 7, 16, 11);

  for (const dir of doors) {
    if (dir === 'n' || dir === 's') {
      // 纵向走廊（2 格宽，正好落在门洞 4 格宽之内）
      protectRect(13, 1, 14, ROOM_ROWS - 2);
      // 门洞前 2 格空地
      protectRect(DOOR_GAP_START_X, dir === 'n' ? 1 : ROOM_ROWS - 3, DOOR_GAP_START_X + DOOR_GAP - 1, dir === 'n' ? 2 : ROOM_ROWS - 2);
    } else {
      protectRect(1, DOOR_GAP_START_Y, ROOM_COLS - 2, DOOR_GAP_START_Y + 1);
      protectRect(dir === 'w' ? 1 : ROOM_COLS - 3, DOOR_GAP_START_Y, dir === 'w' ? 2 : ROOM_COLS - 2, DOOR_GAP_START_Y + DOOR_GAP - 1);
    }
  }
  return mask;
}

/** BFS：从 start 出发能否到达所有 targets（4 邻接，只走非阻挡）。 */
export function bfsReachAll(
  tiles: Uint8Array,
  start: readonly [number, number],
  targets: ReadonlyArray<readonly [number, number]>,
): boolean {
  const visited = new Uint8Array(ROOM_COLS * ROOM_ROWS);
  const queue: number[] = [];
  const sIdx = tileIndex(start[0], start[1]);
  if (isBlockingTile(tiles[sIdx]!)) return false;
  visited[sIdx] = 1;
  queue.push(sIdx);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  while (queue.length) {
    const cur = queue.shift()!;
    const cc = cur % ROOM_COLS;
    const cr = Math.floor(cur / ROOM_COLS);
    for (const [dc, dr] of dirs) {
      const nc = cc + dc!;
      const nr = cr + dr!;
      if (nc < 0 || nc >= ROOM_COLS || nr < 0 || nr >= ROOM_ROWS) continue;
      const idx = tileIndex(nc, nr);
      if (visited[idx]) continue;
      if (isBlockingTile(tiles[idx]!)) continue;
      visited[idx] = 1;
      queue.push(idx);
    }
  }
  for (const [tc, tr] of targets) {
    if (!visited[tileIndex(tc, tr)]) return false;
  }
  return true;
}

/** 连通区域大小（用于测试：确保可达区域足够大）。 */
export function reachableCount(tiles: Uint8Array, start: readonly [number, number]): number {
  const visited = new Uint8Array(ROOM_COLS * ROOM_ROWS);
  const queue: number[] = [tileIndex(start[0], start[1])];
  if (isBlockingTile(tiles[tileIndex(start[0], start[1])]!)) return 0;
  visited[queue[0]!] = 1;
  let count = 1;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  while (queue.length) {
    const cur = queue.shift()!;
    const cc = cur % ROOM_COLS;
    const cr = Math.floor(cur / ROOM_COLS);
    for (const [dc, dr] of dirs) {
      const nc = cc + dc!;
      const nr = cr + dr!;
      if (nc < 0 || nc >= ROOM_COLS || nr < 0 || nr >= ROOM_ROWS) continue;
      const idx = tileIndex(nc, nr);
      if (visited[idx] || isBlockingTile(tiles[idx]!)) continue;
      visited[idx] = 1;
      count++;
      queue.push(idx);
    }
  }
  return count;
}

/** 门洞对应的自由瓦片（用于 BFS 目标）。 */
export function doorFreeTiles(dir: Dir4): Array<[number, number]> {
  if (dir === 'n') return [[13, 0], [14, 0]];
  if (dir === 's') return [[13, ROOM_ROWS - 1], [14, ROOM_ROWS - 1]];
  if (dir === 'w') return [[0, 8], [0, 9]];
  return [[ROOM_COLS - 1, 8], [ROOM_COLS - 1, 9]];
}

function carveBaseLayout(doors: readonly Dir4[]): Uint8Array {
  const tiles = new Uint8Array(ROOM_COLS * ROOM_ROWS).fill(Tile.Floor);
  // 外墙
  for (let c = 0; c < ROOM_COLS; c++) {
    setTile(tiles, c, 0, Tile.Wall);
    setTile(tiles, c, ROOM_ROWS - 1, Tile.Wall);
  }
  for (let r = 0; r < ROOM_ROWS; r++) {
    setTile(tiles, 0, r, Tile.Wall);
    setTile(tiles, ROOM_COLS - 1, r, Tile.Wall);
  }
  // 门洞
  for (const dir of doors) {
    if (dir === 'n' || dir === 's') {
      const row = dir === 'n' ? 0 : ROOM_ROWS - 1;
      for (let i = 0; i < DOOR_GAP; i++) setTile(tiles, DOOR_GAP_START_X + i, row, Tile.Floor);
    } else {
      const col = dir === 'w' ? 0 : ROOM_COLS - 1;
      for (let i = 0; i < DOOR_GAP; i++) setTile(tiles, col, DOOR_GAP_START_Y + i, Tile.Floor);
    }
  }
  return tiles;
}

interface ObstacleShape {
  name: string;
  weight: number;
  cells: Array<[number, number]>;
}

function shapeCellsFor(name: string, rng: RNG): Array<[number, number]> {
  switch (name) {
    case 'pillar':
      return [[0, 0]];
    case 'pillar2x2':
      return [[0, 0], [1, 0], [0, 1], [1, 1]];
    case 'line3':
      return rng.chance(0.5)
        ? [[0, 0], [1, 0], [2, 0]]
        : [[0, 0], [0, 1], [0, 2]];
    case 'crate_pair': {
      const horizontal = rng.chance(0.5);
      const n = rng.int(2, 3);
      const cells: Array<[number, number]> = [];
      for (let i = 0; i < n; i++) cells.push(horizontal ? [i, 0] : [0, i]);
      return cells;
    }
    case 'crate_single':
      return [[0, 0]];
    case 'statue':
      return [[0, 0]];
    default:
      return [[0, 0]];
  }
}

const SHAPE_POOL: ObstacleShape[] = [
  { name: 'pillar', weight: 5, cells: [] },
  { name: 'pillar2x2', weight: 2, cells: [] },
  { name: 'line3', weight: 2, cells: [] },
  { name: 'crate_pair', weight: 3, cells: [] },
  { name: 'crate_single', weight: 3, cells: [] },
  { name: 'statue', weight: 1, cells: [] },
];

function tryPlaceObstacles(
  tiles: Uint8Array,
  mask: Uint8Array,
  rng: RNG,
  budget: number,
  allowStatues: boolean,
  allowCrates: boolean,
): number {
  const pool = SHAPE_POOL.filter((s) => {
    if (!allowStatues && s.name === 'statue') return false;
    if (!allowCrates && (s.name === 'crate_pair' || s.name === 'crate_single')) return false;
    return true;
  });
  const weights = pool.map((s) => s.weight);
  let used = 0;
  let attempts = 0;
  const maxAttempts = budget * 14;

  while (used < budget && attempts < maxAttempts) {
    attempts++;
    const shape = pool[rng.weightedIndex(weights)]!;
    const cells = shapeCellsFor(shape.name, rng);
    // 随机锚点，保证全部在边界内 1 格
    const minC = 1;
    const maxC = ROOM_COLS - 2;
    const minR = 1;
    const maxR = ROOM_ROWS - 2;
    const width = Math.max(...cells.map((c) => c[0]));
    const height = Math.max(...cells.map((c) => c[1]));
    const anchorC = rng.int(minC, maxC - width);
    const anchorR = rng.int(minR, maxR - height);

    let ok = true;
    for (const [dc, dr] of cells) {
      const c = anchorC + dc;
      const r = anchorR + dr;
      const idx = tileIndex(c, r);
      if (mask[idx]) {
        ok = false;
        break;
      }
      if (tiles[idx] !== Tile.Floor) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const tileValue =
      shape.name === 'crate_pair' || shape.name === 'crate_single'
        ? Tile.Crate
        : shape.name === 'statue'
          ? Tile.Statue
          : Tile.Pillar;

    for (const [dc, dr] of cells) {
      setTile(tiles, anchorC + dc, anchorR + dr, tileValue);
    }
    used += cells.length;
  }
  return used;
}

function placeBraziers(tiles: Uint8Array, mask: Uint8Array, rng: RNG, enabled: boolean): LightDef[] {
  const lights: LightDef[] = [];
  if (!enabled) return lights;
  const spots: Array<[number, number]> = [
    [3, 3],
    [ROOM_COLS - 4, 3],
    [3, ROOM_ROWS - 4],
    [ROOM_COLS - 4, ROOM_ROWS - 4],
  ];
  for (const [c, r] of spots) {
    if (mask[tileIndex(c, r)]) continue;
    if (tiles[tileIndex(c, r)] !== Tile.Floor) continue;
    setTile(tiles, c, r, Tile.Brazier);
    const p = tileCenter(c, r);
    lights.push({
      x: p.x,
      y: p.y,
      radius: 168,
      intensity: 0.72,
      color: '#ff9a3c',
      flicker: rng.range(5, 8),
      kind: 'brazier',
    });
  }
  return lights;
}

function placeWallTorches(tiles: Uint8Array, doors: readonly Dir4[], rng: RNG): LightDef[] {
  const lights: LightDef[] = [];
  const isDoorGapCol = (c: number) => c >= DOOR_GAP_START_X - 1 && c < DOOR_GAP_START_X + DOOR_GAP + 1;
  const isDoorGapRow = (r: number) => r >= DOOR_GAP_START_Y - 1 && r < DOOR_GAP_START_Y + DOOR_GAP + 1;
  const hasN = doors.includes('n');
  const hasS = doors.includes('s');
  const hasW = doors.includes('w');
  const hasE = doors.includes('e');

  for (let c = 2; c < ROOM_COLS - 2; c += 5) {
    if (isDoorGapCol(c)) continue;
    if (!hasN && tileAt(tiles, c, 0) === Tile.Wall) {
      const p = { x: c * TILE + TILE / 2, y: TILE * 0.75 };
      lights.push({ x: p.x, y: p.y, radius: 132, intensity: 0.6, color: '#ffb055', flicker: rng.range(4, 9), kind: 'torch' });
    }
    if (!hasS && tileAt(tiles, c, ROOM_ROWS - 1) === Tile.Wall) {
      const p = { x: c * TILE + TILE / 2, y: ROOM_H - TILE * 0.75 };
      lights.push({ x: p.x, y: p.y, radius: 132, intensity: 0.6, color: '#ffb055', flicker: rng.range(4, 9), kind: 'torch' });
    }
  }
  for (let r = 3; r < ROOM_ROWS - 2; r += 5) {
    if (isDoorGapRow(r)) continue;
    if (!hasW && tileAt(tiles, 0, r) === Tile.Wall) {
      lights.push({
        x: TILE * 0.75,
        y: r * TILE + TILE / 2,
        radius: 132,
        intensity: 0.6,
        color: '#ffb055',
        flicker: rng.range(4, 9),
        kind: 'torch',
      });
    }
    if (!hasE && tileAt(tiles, ROOM_COLS - 1, r) === Tile.Wall) {
      lights.push({
        x: ROOM_W - TILE * 0.75,
        y: r * TILE + TILE / 2,
        radius: 132,
        intensity: 0.6,
        color: '#ffb055',
        flicker: rng.range(4, 9),
        kind: 'torch',
      });
    }
  }
  return lights;
}

function placeDecor(tiles: Uint8Array, rng: RNG, count: number): DecorItem[] {
  const decor: DecorItem[] = [];
  const kinds: DecorKind[] = ['crack', 'pebbles', 'moss', 'grate', 'stain', 'plate'];
  const weights = [3, 3, 2, 1, 2, 1];
  for (let i = 0; i < count; i++) {
    const c = rng.int(1, ROOM_COLS - 2);
    const r = rng.int(1, ROOM_ROWS - 2);
    if (tiles[tileIndex(c, r)] !== Tile.Floor) continue;
    decor.push({
      kind: kinds[rng.weightedIndex(weights)]!,
      col: c + rng.range(0.2, 0.8),
      row: r + rng.range(0.2, 0.8),
      seed: rng.int(0, 99999),
      scale: rng.range(0.7, 1.35),
    });
  }
  // 装饰性符文圆环，放在中央
  if (rng.chance(0.45)) {
    decor.push({ kind: 'inlay', col: 14, row: 9, seed: rng.int(0, 99999), scale: rng.range(0.9, 1.2) });
  }
  return decor;
}

function collectSpawnTiles(tiles: Uint8Array, mask: Uint8Array, doorTiles: Set<number>): number[] {
  const out: number[] = [];
  for (let r = 2; r < ROOM_ROWS - 2; r++) {
    for (let c = 2; c < ROOM_COLS - 2; c++) {
      const idx = tileIndex(c, r);
      if (tiles[idx] !== Tile.Floor) continue;
      if (mask[idx]) continue;
      if (doorTiles.has(idx)) continue;
      // 距离中央至少 3 格，避免贴脸刷怪
      if (Math.abs(c - 14) <= 2 && Math.abs(r - 9) <= 2) continue;
      out.push(idx);
    }
  }
  return out;
}

/** 生成一个房间的完整布局。 */
export function generateRoomLayout(opts: RoomLayoutOptions): RoomLayout {
  const { doors, roomType, seed } = opts;
  const allowCrates = roomType !== 'boss';
  const allowStatues = roomType === 'combat' || roomType === 'elite' || roomType === 'treasure' || roomType === 'start';
  const allowBraziers = roomType !== 'boss' || doors.length <= 2;

  const baseBudget = OBSTACLE_BUDGET[roomType];
  let layout: RoomLayout | null = null;

  for (let attempt = 0; attempt < 6; attempt++) {
    const rng = new RNG(seed + attempt * 7919);
    const tiles = carveBaseLayout(doors);
    const mask = buildProtectedMask(doors);
    const budget = Math.round(baseBudget * (1 - attempt * 0.15));
    tryPlaceObstacles(tiles, mask, rng, budget, allowStatues, allowCrates);
    const lights = [
      ...placeBraziers(tiles, mask, rng, allowBraziers),
      ...placeWallTorches(tiles, doors, rng),
    ];
    const decor = placeDecor(tiles, rng, roomType === 'boss' ? 6 : 20);

    const doorTileSet = new Set<number>();
    for (const d of doors) for (const [c, r] of doorFreeTiles(d)) doorTileSet.add(tileIndex(c, r));
    const spawnTiles = collectSpawnTiles(tiles, mask, doorTileSet);

    const targets: Array<[number, number]> = [];
    for (const d of doors) targets.push(...doorFreeTiles(d));

    const crates: number[] = [];
    for (let i = 0; i < tiles.length; i++) if (tiles[i] === Tile.Crate) crates.push(i);

    const candidate: RoomLayout = {
      tiles,
      decor,
      crates,
      lights,
      spawnTiles,
      obstacleTiles: countObstacles(tiles),
    };

    const passable = bfsReachAll(tiles, [14, 9], targets);
    const reach = reachableCount(tiles, [14, 9]);
    if (passable && reach >= 300 && spawnTiles.length >= 6) {
      layout = candidate;
      break;
    }
    layout = candidate;
  }

  if (!layout) {
    // 理论不可达，兜底：空房
    const tiles = carveBaseLayout(doors);
    layout = {
      tiles,
      decor: [],
      crates: [],
      lights: placeWallTorches(tiles, doors, new RNG(seed)),
      spawnTiles: collectSpawnTiles(tiles, new Uint8Array(ROOM_COLS * ROOM_ROWS), new Set()),
      obstacleTiles: 0,
    };
  }
  return layout;
}

export function countObstacles(tiles: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < tiles.length; i++) if (isBlockingTile(tiles[i]!)) n++;
  return n;
}

/** 房间运行期实例。 */
export class Room {
  readonly col: number;
  readonly row: number;
  readonly type: RoomType;
  readonly doors: Dir4[];
  layout: RoomLayout;
  /** 已锁住的门（战斗房进入后关闭） */
  lockedDoors = new Set<Dir4>();
  /** 静态图层缓存（地面/墙体/道具），首次进入时烘焙 */
  staticCanvas: HTMLCanvasElement | null = null;
  /** 木箱血量：tileIndex -> hp */
  crateHp = new Map<number, number>();
  /** 本房间已经刷出的波次 */
  wavesSpawned = 0;
  /** 触发器：是否已经发过奖励 */
  rewardDropped = false;
  /** 事件房/宝箱房是否已触发交互 */
  interacted = false;
  /** 首领房入口的「战前补给站」是否已经展示过（每次进房只弹一次） */
  prepShown = false;

  constructor(col: number, row: number, type: RoomType, doors: Dir4[], layout: RoomLayout) {
    this.col = col;
    this.row = row;
    this.type = type;
    this.doors = doors.slice();
    this.layout = layout;
    for (const c of layout.crates) this.crateHp.set(c, CRATE_HP);
  }

  get key(): string {
    return `${this.col},${this.row}`;
  }

  tileAt(col: number, row: number): number {
    return tileAt(this.layout.tiles, col, row);
  }

  /** 某点是否被静态几何阻挡（含锁住的门）。 */
  isBlockedPoint(x: number, y: number): boolean {
    const col = Math.floor(x / TILE);
    const row = Math.floor(y / TILE);
    if (isBlockingTile(this.tileAt(col, row))) return true;
    for (const d of this.lockedDoors) {
      const r = doorRect(d);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
    }
    return false;
  }

  /** 收集给定圆范围内的阻挡矩形（瓦片 + 已锁的门）。 */
  collectBlockers(cx: number, cy: number, radius: number, out: Rect[]): void {
    out.length = 0;
    const minC = Math.max(0, Math.floor((cx - radius) / TILE));
    const maxC = Math.min(ROOM_COLS - 1, Math.floor((cx + radius) / TILE));
    const minR = Math.max(0, Math.floor((cy - radius) / TILE));
    const maxR = Math.min(ROOM_ROWS - 1, Math.floor((cy + radius) / TILE));
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        if (isBlockingTile(this.tileAt(c, r))) out.push(tileRect(c, r));
      }
    }
    for (const d of this.lockedDoors) {
      const rect = doorRect(d);
      const nearX = cx + radius >= rect.x && cx - radius <= rect.x + rect.w;
      const nearY = cy + radius >= rect.y && cy - radius <= rect.y + rect.h;
      if (nearX && nearY) out.push(rect);
    }
  }

  /** 沿线段采样判断是否撞到静态几何，返回命中点或 null。 */
  raycastStatic(x0: number, y0: number, x1: number, y1: number, step = 12): { x: number; y: number } | null {
    const total = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(total / step));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      if (x < 0 || y < 0 || x > ROOM_W || y > ROOM_H) return { x, y };
      if (this.isBlockedPoint(x, y)) return { x, y };
    }
    return null;
  }

  /** 破坏一个木箱，返回是否成功。 */
  damageCrate(idx: number, dmg: number): boolean {
    if (this.layout.tiles[idx] !== Tile.Crate) return false;
    const hp = (this.crateHp.get(idx) ?? CRATE_HP) - dmg;
    if (hp <= 0) {
      this.layout.tiles[idx] = Tile.Floor;
      this.crateHp.delete(idx);
      const i = this.layout.crates.indexOf(idx);
      if (i >= 0) this.layout.crates.splice(i, 1);
      return true;
    }
    this.crateHp.set(idx, hp);
    return false;
  }

  allDoorsLocked(): boolean {
    return this.doors.length > 0 && this.lockedDoors.size === this.doors.length;
  }

  lockAllDoors(): void {
    for (const d of this.doors) this.lockedDoors.add(d);
  }

  unlockAllDoors(): void {
    this.lockedDoors.clear();
  }

  /** 随机取一个远离给定位置的刷怪点。 */
  pickSpawnPoint(avoidX: number, avoidY: number, minDist: number, rng: RNG, used: Set<number>): { x: number; y: number } | null {
    const candidates: number[] = [];
    for (const idx of this.layout.spawnTiles) {
      if (used.has(idx)) continue;
      const c = idx % ROOM_COLS;
      const r = Math.floor(idx / ROOM_COLS);
      const p = tileCenter(c, r);
      if (Math.hypot(p.x - avoidX, p.y - avoidY) < minDist) continue;
      candidates.push(idx);
    }
    if (!candidates.length) {
      // 放宽距离限制
      for (const idx of this.layout.spawnTiles) {
        if (used.has(idx)) continue;
        const c = idx % ROOM_COLS;
        const r = Math.floor(idx / ROOM_COLS);
        const p = tileCenter(c, r);
        if (Math.hypot(p.x - avoidX, p.y - avoidY) < minDist * 0.5) continue;
        candidates.push(idx);
      }
    }
    if (!candidates.length) return null;
    const chosen = rng.pick(candidates);
    used.add(chosen);
    const c = chosen % ROOM_COLS;
    const r = Math.floor(chosen / ROOM_COLS);
    return tileCenter(c, r);
  }
}

export { DIR_VECTORS, OPPOSITE_DIR };
