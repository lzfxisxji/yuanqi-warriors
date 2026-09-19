import { describe, expect, test } from 'vitest';
import { RunState } from '../src/systems/run';
import { getCharacter } from '../src/data/characters';
import { UPGRADES } from '../src/data/upgrades';
import { reachableRooms } from '../src/dungeon/dungeon';
import { FLOOR_COUNT } from '../src/data/config';

const makeRun = (seed = 20240918, characterId = 'wolfshade') =>
  new RunState(getCharacter(characterId), seed);

describe('远征状态 RunState', () => {
  test('初始状态：第 1 层、0 金币、出生于出生房', () => {
    const run = makeRun();
    expect(run.floor).toBe(1);
    expect(run.gold).toBe(0);
    expect(run.upgrades.length).toBe(0);
    expect(run.currentRoomKey).toBe(run.plan.startKey);
    expect(run.visited.has(run.plan.startKey)).toBe(true);
    expect(run.timeSec).toBe(0);
    expect(run.bossDefeated).toBe(false);
    expect(run.player.maxHp).toBe(run.character.maxHp);
  });

  test('每层地牢都 100% 连通（实际跑一遍）', () => {
    const run = makeRun();
    for (let f = 1; f <= FLOOR_COUNT + 1; f++) {
      if (f > 1) run.advanceFloor();
      expect(run.floor).toBe(f);
      expect(reachableRooms(run.plan).size).toBe(run.plan.nodes.size);
      expect(run.plan.floor).toBe(f);
    }
  });

  test('seedForFloor 确定且随楼层变化', () => {
    const run = makeRun(777);
    expect(run.seedForFloor(1)).toBe(run.seedForFloor(1));
    expect(run.seedForFloor(1)).not.toBe(run.seedForFloor(2));
    const other = makeRun(777);
    expect(other.seedForFloor(3)).toBe(run.seedForFloor(3));
  });

  test('advanceFloor 保留强化与武器，并给予层间补给', () => {
    const run = makeRun();
    run.addUpgrade('bullet');
    run.addUpgrade('heart');
    run.player.weapons[0]!.ammo = 0;
    run.player.hp = 10;
    run.player.barrier = 50;
    const oldPlan = run.plan;
    const upgradeCount = run.upgrades.length;

    run.advanceFloor();

    expect(run.floor).toBe(2);
    expect(run.upgrades.length).toBe(upgradeCount);
    expect(run.mods.damageMul).toBeGreaterThan(1);
    expect(run.mods.maxHpAdd).toBeGreaterThan(0);
    expect(run.plan).not.toBe(oldPlan);
    expect(run.plan.floor).toBe(2);
    expect(run.currentRoomKey).toBe(run.plan.startKey);
    expect(run.visited.size).toBe(1);
    // 层间补给：回血 + 护盾回满 + 壁垒清空
    expect(run.player.hp).toBeGreaterThan(10);
    expect(run.player.shield).toBe(run.player.maxShield);
    expect(run.player.barrier).toBe(0);
    expect(run.bossDefeated).toBe(false);
  });

  test('强化会重算派生属性，且生命上限提升时直接补血', () => {
    const run = makeRun();
    const beforeMax = run.player.maxHp;
    const beforeHp = run.player.hp;
    run.addUpgrade('heart');
    expect(run.player.maxHp).toBeGreaterThan(beforeMax);
    expect(run.player.hp).toBeGreaterThan(beforeHp);
    expect(run.mods.maxHpAdd).toBe(22);
  });

  test('强化叠加受 maxStacks 限制', () => {
    const run = makeRun();
    const max = UPGRADES.find((u) => u.id === 'boot')!.maxStacks;
    for (let i = 0; i < max + 4; i++) run.addUpgrade('boot');
    const stack = run.upgrades.find((u) => u.id === 'boot')!;
    expect(stack.stacks).toBe(max);
    expect(run.mods.speedMul).toBeCloseTo(Math.pow(1.12, max), 6);
  });

  test('金币收益受贪婪之心加成，且消费不能透支', () => {
    const run = makeRun();
    expect(run.addGold(10)).toBe(10);
    expect(run.gold).toBe(10);
    run.addUpgrade('coin');
    const gained = run.addGold(10);
    expect(gained).toBeGreaterThan(10);
    expect(run.gold).toBe(10 + gained);
    expect(run.stats.goldEarned).toBe(10 + gained);

    expect(run.spendGold(999999)).toBe(false);
    expect(run.gold).toBe(10 + gained);
    expect(run.spendGold(5)).toBe(true);
    expect(run.gold).toBe(10 + gained - 5);
  });

  test('rollUpgrades 每次给出互不重复的选项', () => {
    const run = makeRun();
    const opts = run.rollUpgrades(3);
    expect(opts.length).toBe(3);
    expect(new Set(opts).size).toBe(3);
    // 已满层的强化不会再次出现
    const maxed = UPGRADES.find((u) => u.id === opts[0]!)!;
    for (let i = 0; i < maxed.maxStacks + 2; i++) run.addUpgrade(maxed.id);
    for (let i = 0; i < 30; i++) {
      expect(run.rollUpgrades(3).includes(maxed.id)).toBe(false);
    }
  });

  test('得分随楼层、击杀、房间与通关提升', () => {
    const run = makeRun();
    const s0 = run.score;
    run.stats.kills += 10;
    const s1 = run.score;
    expect(s1).toBeGreaterThan(s0);
    run.stats.rooms += 3;
    expect(run.score).toBeGreaterThan(s1);
    const s2 = run.score;
    run.bossDefeated = true;
    expect(run.score).toBeGreaterThan(s2);
    run.floor = 2;
    expect(run.score).toBeGreaterThan(s2);
  });

  test('result 汇总本局结果', () => {
    const run = makeRun(31415, 'sting');
    run.addGold(50);
    run.stats.kills = 7;
    run.stats.rooms = 3;
    run.timeSec = 120;
    const r = run.result(true);
    expect(r.floor).toBe(1);
    expect(r.won).toBe(true);
    expect(r.kills).toBe(7);
    expect(r.rooms).toBe(3);
    expect(r.gold).toBe(50);
    expect(r.timeSec).toBe(120);
    expect(r.characterId).toBe('sting');
    expect(r.score).toBe(run.score);
  });

  test('同 seed 的两局结果完全一致（可复现）', () => {
    const a = makeRun(2468);
    const b = makeRun(2468);
    expect([...a.plan.nodes.keys()].sort()).toEqual([...b.plan.nodes.keys()].sort());
    expect([...a.plan.nodes.values()].map((n) => n.type)).toEqual(
      [...b.plan.nodes.values()].map((n) => n.type),
    );
    expect(a.rollUpgrades(3)).toEqual(b.rollUpgrades(3));
  });

  test('生成的地牢至少包含一个战斗房与 Boss 房', () => {
    for (let s = 0; s < 20; s++) {
      const run = makeRun((s * 8191 + 13) >>> 0);
      const types = [...run.plan.nodes.values()].map((n) => n.type);
      expect(types.filter((t) => t === 'boss').length).toBe(1);
      expect(types.filter((t) => t === 'start').length).toBe(1);
      expect(types.filter((t) => t === 'combat' || t === 'elite').length).toBeGreaterThan(0);
    }
  });
});
