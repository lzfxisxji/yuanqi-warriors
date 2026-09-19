/**
 * 随机地牢生成器。
 *
 * 生成方式（保证 100% 连通）：
 *  1. 在网格上从出生房 (0,0) 出发做"随机扩展树"生长，每次挑一个还有空邻格的已存在房间再长一间，
 *     因此所有房间天然由门连通，绝不会出现孤岛。
 *  2. 有 28% 概率把新房间额外连到第二个相邻房间，制造回路（避免过于线性的走廊）。
 *  3. 对树做 BFS 求深度，最深的房间作为 Boss 房，保证 Boss 距起点足够远。
 *  4. 尽头房（叶子）按深度从远到近分配：宝箱房 / 商店 / 事件房 / 精英房，其余叶子按概率成为精英房。
 *  5. 门口房（Boss 前一个房间）提升为精英房，制造合理的战斗节奏。
 */
import { RNG } from '../core/math';
import type { Dir4, RoomType } from '../core/types';
import { DIRS, DIR_VECTORS, OPPOSITE_DIR } from '../core/types';

export interface RoomNode {
  id: number;
  key: string;
  gx: number;
  gy: number;
  type: RoomType;
  doors: Dir4[];
  neighbors: Partial<Record<Dir4, string>>;
  visited: boolean;
  cleared: boolean;
  /** 距出生房的最短步数 */
  depth: number;
  /** 是否为尽头房（仅一个门） */
  leaf: boolean;
}

export interface DungeonPlan {
  seed: number;
  floor: number;
  nodes: Map<string, RoomNode>;
  order: string[];
  startKey: string;
  bossKey: string;
  /** 网格包围盒，供小地图使用 */
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

export function roomKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}

export function targetRoomCount(floor: number): number {
  return Math.min(12, 7 + floor * 2);
}

function buildTree(rng: RNG, target: number): Map<string, RoomNode> {
  const nodes = new Map<string, RoomNode>();
  let nextId = 0;
  const create = (gx: number, gy: number): RoomNode => {
    const node: RoomNode = {
      id: nextId++,
      key: roomKey(gx, gy),
      gx,
      gy,
      type: 'combat',
      doors: [],
      neighbors: {},
      visited: false,
      cleared: false,
      depth: 0,
      leaf: true,
    };
    nodes.set(node.key, node);
    return node;
  };

  const start = create(0, 0);
  start.type = 'start';
  start.cleared = true;

  const connect = (a: RoomNode, b: RoomNode): void => {
    for (const dir of DIRS) {
      const v = DIR_VECTORS[dir];
      if (b.gx === a.gx + v.x && b.gy === a.gy + v.y) {
        a.neighbors[dir] = b.key;
        b.neighbors[OPPOSITE_DIR[dir]] = a.key;
        if (!a.doors.includes(dir)) a.doors.push(dir);
        if (!b.doors.includes(OPPOSITE_DIR[dir])) b.doors.push(OPPOSITE_DIR[dir]);
        return;
      }
    }
  };

  let guard = 0;
  while (nodes.size < target && guard < 400) {
    guard++;
    const all = [...nodes.values()];
    const growable = all.filter((n) =>
      DIRS.some((d) => {
        const v = DIR_VECTORS[d];
        return !nodes.has(roomKey(n.gx + v.x, n.gy + v.y));
      }),
    );
    if (!growable.length) break;
    const from = rng.pick(growable);
    const freeDirs = DIRS.filter((d) => {
      const v = DIR_VECTORS[d];
      return !nodes.has(roomKey(from.gx + v.x, from.gy + v.y));
    });
    if (!freeDirs.length) continue;
    const dir = rng.pick(freeDirs);
    const v = DIR_VECTORS[dir];
    const created = create(from.gx + v.x, from.gy + v.y);
    connect(from, created);

    // 额外连接：制造回路
    if (rng.chance(0.28)) {
      const extraDirs = DIRS.filter((d) => {
        const vv = DIR_VECTORS[d];
        const nk = roomKey(created.gx + vv.x, created.gy + vv.y);
        const other = nodes.get(nk);
        return other && other.key !== from.key && !created.neighbors[d];
      });
      if (extraDirs.length) {
        const ed = rng.pick(extraDirs);
        const vv = DIR_VECTORS[ed];
        const other = nodes.get(roomKey(created.gx + vv.x, created.gy + vv.y));
        if (other) connect(created, other);
      }
    }
  }

  // 更新叶子标记
  for (const n of nodes.values()) {
    const deg = n.doors.length;
    n.leaf = deg <= 1;
  }
  return nodes;
}

function computeDepth(nodes: Map<string, RoomNode>, startKey: string): number {
  for (const n of nodes.values()) n.depth = -1;
  const start = nodes.get(startKey);
  if (!start) return 0;
  start.depth = 0;
  const queue: string[] = [startKey];
  let maxDepth = 0;
  while (queue.length) {
    const k = queue.shift()!;
    const node = nodes.get(k)!;
    for (const d of node.doors) {
      const nk = node.neighbors[d];
      if (!nk) continue;
      const nb = nodes.get(nk);
      if (!nb || nb.depth >= 0) continue;
      nb.depth = node.depth + 1;
      maxDepth = Math.max(maxDepth, nb.depth);
      queue.push(nk);
    }
  }
  return maxDepth;
}

/**
 * 分配房间类型。
 * 导出以便单元测试直接验证分配逻辑。
 */
export function assignRoomTypes(nodes: Map<string, RoomNode>, startKey: string, bossKey: string, rng: RNG): void {
  for (const n of nodes.values()) {
    n.type = n.key === startKey ? 'start' : n.key === bossKey ? 'boss' : 'combat';
  }

  const others = [...nodes.values()].filter((n) => n.key !== startKey && n.key !== bossKey);
  const leaves = others.filter((n) => n.leaf).sort((a, b) => b.depth - a.depth);

  const need: RoomType[] = ['treasure', 'shop', 'event', 'elite'];
  const assigned: RoomNode[] = [];
  for (const t of need) {
    // 优先尽头房；不够时退回"最深的非出生/非Boss房"
    const pool = leaves.length ? leaves : others.slice().sort((a, b) => b.depth - a.depth);
    const target = pool.find((n) => n.type === 'combat');
    if (!target) break;
    target.type = t;
    assigned.push(target);
    const idx = leaves.indexOf(target);
    if (idx >= 0) leaves.splice(idx, 1);
  }

  // 其余尽头房：45% 精英
  for (const n of leaves) {
    if (n.type === 'combat' && rng.chance(0.45)) n.type = 'elite';
  }

  // Boss 门口房升级为精英，制造节奏
  const boss = nodes.get(bossKey);
  if (boss) {
    for (const d of boss.doors) {
      const nk = boss.neighbors[d];
      const nb = nk ? nodes.get(nk) : undefined;
      if (nb && nb.type === 'combat' && nb.depth >= 3) {
        nb.type = 'elite';
        break;
      }
    }
  }

  // 保底：至少 1 个精英房
  if (![...nodes.values()].some((n) => n.type === 'elite')) {
    const cand = others.filter((n) => n.type === 'combat').sort((a, b) => b.depth - a.depth)[0];
    if (cand) cand.type = 'elite';
  }
}

export interface GenerateDungeonOptions {
  seed: number;
  floor: number;
  /** 覆盖房间数量，测试用 */
  roomCount?: number;
}

export function generateDungeon(opts: GenerateDungeonOptions): DungeonPlan {
  const target = opts.roomCount ?? targetRoomCount(opts.floor);

  let best: { nodes: Map<string, RoomNode>; bossKey: string; maxDepth: number } | null = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const rng = new RNG(opts.seed + attempt * 104729 + opts.floor * 7919);
    const nodes = buildTree(rng, target);
    const startKey = roomKey(0, 0);
    const maxDepth = computeDepth(nodes, startKey);
    const leaves = [...nodes.values()].filter((n) => n.leaf && n.key !== startKey);
    const bossRng = new RNG(opts.seed + attempt * 31 + 5);
    // Boss 取最深的房间
    const sorted = [...nodes.values()].sort((a, b) => b.depth - a.depth);
    const bossCandidate = bossRng.pick(sorted.filter((n) => n.depth === maxDepth && n.key !== startKey));
    const bossKey = bossCandidate ? bossCandidate.key : sorted.find((n) => n.key !== startKey)!.key;

    const ok = nodes.size >= Math.min(target, 6) && leaves.length >= 5 && maxDepth >= 3;
    if (ok) {
      best = { nodes, bossKey, maxDepth };
      break;
    }
    if (!best || nodes.size > best.nodes.size) {
      best = { nodes, bossKey, maxDepth };
    }
  }

  const nodes = best!.nodes;
  const startKey = roomKey(0, 0);
  const bossKey = best!.bossKey;
  const typeRng = new RNG(opts.seed * 2654435761 + opts.floor * 97 + 13);
  assignRoomTypes(nodes, startKey, bossKey, typeRng);

  const order = [...nodes.values()].sort((a, b) => a.id - b.id).map((n) => n.key);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes.values()) {
    minX = Math.min(minX, n.gx);
    maxX = Math.max(maxX, n.gx);
    minY = Math.min(minY, n.gy);
    maxY = Math.max(maxY, n.gy);
  }

  return {
    seed: opts.seed,
    floor: opts.floor,
    nodes,
    order,
    startKey,
    bossKey,
    bounds: { minX, maxX, minY, maxY },
  };
}

/** 从 startKey 出发的 BFS，返回所有可达房间 key（用于测试连通性）。 */
export function reachableRooms(plan: DungeonPlan, fromKey: string = plan.startKey): Set<string> {
  const seen = new Set<string>();
  const queue = [fromKey];
  seen.add(fromKey);
  while (queue.length) {
    const k = queue.shift()!;
    const n = plan.nodes.get(k);
    if (!n) continue;
    for (const d of n.doors) {
      const nk = n.neighbors[d];
      if (!nk || seen.has(nk)) continue;
      seen.add(nk);
      queue.push(nk);
    }
  }
  return seen;
}

export function countByType(plan: DungeonPlan): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of plan.nodes.values()) {
    out[n.type] = (out[n.type] ?? 0) + 1;
  }
  return out;
}
