import { describe, expect, test } from 'vitest';
import {
  countByType,
  generateDungeon,
  reachableRooms,
  roomKey,
  targetRoomCount,
} from '../src/dungeon/dungeon';
import { DIR_VECTORS, OPPOSITE_DIR, DIRS } from '../src/core/types';

describe('地牢生成器', () => {
  test('任意种子 / 楼层下所有房间都从出生房可达（无孤岛）', () => {
    for (let floor = 1; floor <= 3; floor++) {
      for (let s = 0; s < 40; s++) {
        const seed = (s * 7919 + floor * 104729) >>> 0;
        const plan = generateDungeon({ seed, floor });
        const reachable = reachableRooms(plan);
        expect(reachable.size).toBe(plan.nodes.size);
      }
    }
  });

  test('生成结果包含唯一的出生房与 Boss 房', () => {
    const plan = generateDungeon({ seed: 4242, floor: 1 });
    const start = plan.nodes.get(plan.startKey);
    const boss = plan.nodes.get(plan.bossKey);
    expect(start).toBeDefined();
    expect(boss).toBeDefined();
    expect(start!.type).toBe('start');
    expect(boss!.type).toBe('boss');
    expect(start!.key).not.toBe(boss!.key);
    expect(plan.startKey).toBe(roomKey(0, 0));
    expect(countByType(plan).start).toBe(1);
    expect(countByType(plan).boss).toBe(1);
  });

  test('门是双向对称的，且邻居坐标与方向一致', () => {
    for (let s = 0; s < 25; s++) {
      const plan = generateDungeon({ seed: (s * 3121 + 11) >>> 0, floor: 2 });
      for (const node of plan.nodes.values()) {
        for (const dir of DIRS) {
          const nk = node.neighbors[dir];
          if (!nk) {
            expect(node.doors.includes(dir)).toBe(false);
            continue;
          }
          expect(node.doors.includes(dir)).toBe(true);
          const other = plan.nodes.get(nk);
          expect(other).toBeDefined();
          // 坐标必须严格相邻
          const v = DIR_VECTORS[dir];
          expect(other!.gx).toBe(node.gx + v.x);
          expect(other!.gy).toBe(node.gy + v.y);
          // 对方必须有一扇指向本房间的门
          expect(other!.neighbors[OPPOSITE_DIR[dir]]).toBe(node.key);
        }
      }
    }
  });

  test('房间数量符合楼层目标上限', () => {
    for (let floor = 1; floor <= 3; floor++) {
      const plan = generateDungeon({ seed: (floor * 99991) >>> 0, floor });
      expect(plan.nodes.size).toBeGreaterThanOrEqual(6);
      expect(plan.nodes.size).toBeLessThanOrEqual(targetRoomCount(floor));
      expect(plan.order.length).toBe(plan.nodes.size);
    }
  });

  test('Boss 房位于距出生房最远的深度上', () => {
    for (let s = 0; s < 20; s++) {
      const plan = generateDungeon({ seed: (s * 6151 + 3) >>> 0, floor: 2 });
      let maxDepth = -1;
      for (const n of plan.nodes.values()) maxDepth = Math.max(maxDepth, n.depth);
      const boss = plan.nodes.get(plan.bossKey)!;
      expect(boss.depth).toBe(maxDepth);
      expect(boss.depth).toBeGreaterThan(0);
      expect(boss.doors.length).toBeGreaterThan(0);
    }
  });

  test('功能房分配：至少包含一个精英房，且非战斗房类型齐全', () => {
    for (let s = 0; s < 20; s++) {
      const plan = generateDungeon({ seed: (s * 4423 + 97) >>> 0, floor: 3 });
      const counts = countByType(plan);
      expect(counts.elite ?? 0).toBeGreaterThanOrEqual(1);
      const special = (counts.treasure ?? 0) + (counts.shop ?? 0) + (counts.event ?? 0);
      expect(special).toBeGreaterThanOrEqual(1);
    }
  });

  test('同一 seed 生成结果完全一致（可复现）', () => {
    const a = generateDungeon({ seed: 20240918, floor: 2 });
    const b = generateDungeon({ seed: 20240918, floor: 2 });
    expect([...a.nodes.keys()].sort()).toEqual([...b.nodes.keys()].sort());
    expect(a.bossKey).toBe(b.bossKey);
    for (const key of a.nodes.keys()) {
      const na = a.nodes.get(key)!;
      const nb = b.nodes.get(key)!;
      expect(na.type).toBe(nb.type);
      expect([...na.doors].sort()).toEqual([...nb.doors].sort());
    }
  });

  test('小规模地牢（roomCount 覆盖）依旧保持连通', () => {
    for (let s = 0; s < 15; s++) {
      const plan = generateDungeon({ seed: (s * 7717 + 5) >>> 0, floor: 1, roomCount: 7 });
      expect(reachableRooms(plan).size).toBe(plan.nodes.size);
    }
  });
});
