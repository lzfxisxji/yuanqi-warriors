import { describe, expect, test } from 'vitest';
import {
  Room,
  bfsReachAll,
  DOOR_TRIGGER_DEPTH,
  doorEntryPoint,
  doorFreeTiles,
  doorRect,
  generateRoomLayout,
  reachableCount,
  tileIndex,
  tileAt,
} from '../src/dungeon/room';
import { DIRS, type Dir4, type RoomType } from '../src/core/types';
import { RNG } from '../src/core/math';
import { ROOM_COLS, ROOM_H, ROOM_ROWS, ROOM_W, TILE, Tile } from '../src/data/config';

const ROOM_TYPES: RoomType[] = ['start', 'combat', 'elite', 'treasure', 'shop', 'event', 'boss'];

const DOOR_COMBOS: Dir4[][] = [
  [],
  ['n'],
  ['e'],
  ['n', 's'],
  ['e', 'w'],
  ['n', 'e'],
  ['n', 's', 'e', 'w'],
  ['n', 'e', 's'],
  ['w', 's', 'e'],
  ['n', 'w', 'e'],
];

describe('房间布局生成（可通行性保证）', () => {
  test('所有门组合 + 所有房间类型：中央一定可走到每一扇门', () => {
    for (const roomType of ROOM_TYPES) {
      for (const doors of DOOR_COMBOS) {
        for (let s = 0; s < 6; s++) {
          const seed = (s * 92821 + roomType.length * 131 + doors.length * 17) >>> 0;
          const layout = generateRoomLayout({ doors, roomType, seed });
          const targets = doors.flatMap((d) => doorFreeTiles(d));
          expect(bfsReachAll(layout.tiles, [14, 9], targets)).toBe(true);
        }
      }
    }
  });

  test('可行走区域面积足够，不会被障碍堵成小角落', () => {
    for (const roomType of ROOM_TYPES) {
      for (const doors of DOOR_COMBOS) {
        const layout = generateRoomLayout({ doors, roomType, seed: 20240918 });
        // 28x18 = 504 格，去掉外墙与障碍后仍应有充裕空间
        expect(reachableCount(layout.tiles, [14, 9])).toBeGreaterThan(250);
      }
    }
  });

  test('门洞永远是地面，且门洞前方两格不被阻挡', () => {
    for (const doors of DOOR_COMBOS) {
      const layout = generateRoomLayout({ doors, roomType: 'combat', seed: 777 });
      for (const d of doors) {
        for (const [c, r] of doorFreeTiles(d)) {
          expect(tileAt(layout.tiles, c, r)).toBe(Tile.Floor);
        }
        // 玩家入场落点必须可站立
        const p = doorEntryPoint(d);
        const col = Math.floor(p.x / TILE);
        const row = Math.floor(p.y / TILE);
        expect(tileAt(layout.tiles, col, row)).toBe(Tile.Floor);
      }
    }
  });

  test('战斗 / 精英房提供足够的刷怪点，且不贴脸中央', () => {
    for (const roomType of ['combat', 'elite'] as RoomType[]) {
      for (const doors of DOOR_COMBOS) {
        const layout = generateRoomLayout({ doors, roomType, seed: 31337 });
        expect(layout.spawnTiles.length).toBeGreaterThanOrEqual(6);
        for (const idx of layout.spawnTiles) {
          const c = idx % ROOM_COLS;
          const r = Math.floor(idx / ROOM_COLS);
          expect(tileAt(layout.tiles, c, r)).toBe(Tile.Floor);
          // 与中央保持距离
          expect(Math.abs(c - 14) + Math.abs(r - 9)).toBeGreaterThan(2);
        }
      }
    }
  });

  test('Boss 房障碍更少，保留开阔的战斗场地', () => {
    const boss = generateRoomLayout({ doors: ['n'], roomType: 'boss', seed: 99 });
    const combat = generateRoomLayout({ doors: ['n'], roomType: 'combat', seed: 99 });
    expect(boss.obstacleTiles).toBeLessThan(combat.obstacleTiles);
  });

  test('crates 列表与实际木箱瓦片一致', () => {
    const layout = generateRoomLayout({ doors: ['n', 's'], roomType: 'combat', seed: 5150 });
    let count = 0;
    for (let i = 0; i < layout.tiles.length; i++) if (layout.tiles[i] === Tile.Crate) count++;
    expect(layout.crates.length).toBe(count);
  });

  test('同一 seed 布局可复现', () => {
    const a = generateRoomLayout({ doors: ['n', 'e'], roomType: 'combat', seed: 123456 });
    const b = generateRoomLayout({ doors: ['n', 'e'], roomType: 'combat', seed: 123456 });
    expect(Array.from(a.tiles)).toEqual(Array.from(b.tiles));
    expect(a.decor.length).toBe(b.decor.length);
  });
});

describe('Room 运行期状态', () => {
  const makeRoom = (doors: Dir4[], type: RoomType = 'combat'): Room => {
    const layout = generateRoomLayout({ doors, roomType: type, seed: 24680 });
    return new Room(0, 0, type, doors, layout);
  };

  test('锁门后门洞变成阻挡，解锁后恢复', () => {
    const room = makeRoom(['n', 's']);
    expect(room.allDoorsLocked()).toBe(false);

    // 门洞瓦片中心（doorRect 内）
    const nRect = doorRect('n');
    const nDoor = { x: nRect.x + nRect.w / 2, y: nRect.y + nRect.h / 2 };
    expect(room.isBlockedPoint(nDoor.x, nDoor.y)).toBe(false);

    room.lockAllDoors();
    expect(room.allDoorsLocked()).toBe(true);
    expect(room.isBlockedPoint(nDoor.x, nDoor.y)).toBe(true);

    // 而被关在房内的玩家落点本身仍可站立（只是出不去）
    const inside = doorEntryPoint('n');
    expect(inside.y).toBeGreaterThan(nRect.y + nRect.h);
    expect(room.isBlockedPoint(inside.x, inside.y)).toBe(false);

    room.unlockAllDoors();
    expect(room.allDoorsLocked()).toBe(false);
    expect(room.isBlockedPoint(nDoor.x, nDoor.y)).toBe(false);
  });

  test('入场落点必须落在门触发区之外（否则会与上一间房来回弹跳）', () => {
    // 门触发区（游戏里判定「已穿门」的矩形）与入场落点如果重叠，
    // 玩家一进房间就会被判定为又穿了一次门，于是两间房无限来回切，
    // 表现为画面一直闪、关卡切换错乱。这里用几何不变量把它钉死。
    const zone = (dir: Dir4): { x: number; y: number; w: number; h: number } => {
      const r = doorRect(dir);
      const d = DOOR_TRIGGER_DEPTH;
      if (dir === 'n') return { x: r.x, y: 0, w: r.w, h: d };
      if (dir === 's') return { x: r.x, y: ROOM_H - d, w: r.w, h: d };
      if (dir === 'w') return { x: 0, y: r.y, w: d, h: r.h };
      return { x: ROOM_W - d, y: r.y, w: d, h: r.h };
    };
    for (const dir of ['n', 's', 'e', 'w'] as Dir4[]) {
      const d = DOOR_TRIGGER_DEPTH;
      const p = doorEntryPoint(dir);
      const z = zone(dir);
      const inside = p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h;
      expect(inside).toBe(false);

      // 落点到边界的距离必须严格大于触发深度，留出可感知的安全余量
      const depth = dir === 'n' ? p.y : dir === 's' ? ROOM_H - p.y : dir === 'w' ? p.x : ROOM_W - p.x;
      expect(depth).toBeGreaterThan(d);
    }
  });

  test('木箱可被破坏并同步移除', () => {
    const room = makeRoom(['n']);
    // 保证有木箱：反复尝试不同 seed
    let idx = -1;
    for (let s = 0; s < 40 && idx < 0; s++) {
      const layout = generateRoomLayout({ doors: ['n'], roomType: 'combat', seed: s * 331 + 7 });
      const r = new Room(0, 0, 'combat', ['n'], layout);
      if (r.layout.crates.length) {
        idx = r.layout.crates[0]!;
        const before = r.layout.crates.length;
        // 一击不死（CRATE_HP = 10）
        expect(r.damageCrate(idx, 4)).toBe(false);
        expect(r.layout.tiles[idx]).toBe(Tile.Crate);
        // 补刀后破坏
        expect(r.damageCrate(idx, 10)).toBe(true);
        expect(r.layout.tiles[idx]).toBe(Tile.Floor);
        expect(r.layout.crates.length).toBe(before - 1);
        expect(r.damageCrate(idx, 10)).toBe(false);
      }
    }
    expect(idx).toBeGreaterThanOrEqual(0);
  });

  test('collectBlockers 会把锁住的门一并计入', () => {
    const room = makeRoom(['n', 's', 'e', 'w']);
    const out: { x: number; y: number; w: number; h: number }[] = [];
    room.collectBlockers(ROOM_W / 2, ROOM_H / 2, 4000, out);
    const before = out.length;
    expect(before).toBeGreaterThan(0);

    room.lockAllDoors();
    out.length = 0;
    room.collectBlockers(ROOM_W / 2, ROOM_H / 2, 4000, out);
    // 四面门都被锁住 → 多出 4 个阻挡矩形
    expect(out.length).toBe(before + 4);
  });

  test('raycastStatic 在撞墙前停下', () => {
    const room = makeRoom(['n', 's']);
    // 从房间中心向上打，必定命中北墙或锁住的门
    const hit = room.raycastStatic(ROOM_W / 2, ROOM_H / 2, ROOM_W / 2, -200, 8);
    expect(hit).not.toBeNull();
    expect(hit!.y).toBeLessThanOrEqual(TILE * 2);
  });

  test('pickSpawnPoint 会避开给定位置并去重', () => {
    const room = makeRoom(['n', 's', 'e', 'w']);
    const used = new Set<number>();
    const rng = new RNG(20240918);
    const player = { x: ROOM_W / 2, y: ROOM_H / 2 };
    const picks: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 8; i++) {
      const p = room.pickSpawnPoint(player.x, player.y, 210, rng, used);
      if (!p) continue;
      picks.push(p);
      expect(Math.hypot(p.x - player.x, p.y - player.y)).toBeGreaterThan(100);
    }
    expect(picks.length).toBeGreaterThan(0);
    expect(used.size).toBe(picks.length);
  });

  test('房间尺寸常量自洽', () => {
    expect(ROOM_W).toBe(ROOM_COLS * TILE);
    expect(ROOM_H).toBe(ROOM_ROWS * TILE);
    expect(tileIndex(0, 0)).toBe(0);
    expect(tileIndex(ROOM_COLS - 1, ROOM_ROWS - 1)).toBe(ROOM_COLS * ROOM_ROWS - 1);
    expect(DIRS.length).toBe(4);
  });
});
