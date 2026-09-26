/**
 * 天赋系统（需求 37）单元测试。
 *
 * 覆盖：applyTalents 各天赋的 Mods 叠加、talentStartGold（初始金币）、
 * talentPointCap（点数预算）、talentSpent、clampLevel，以及存档解析回落
 * 与「RunState 构造时把天赋注入初始属性」的集成校验。
 */
import { describe, expect, it } from 'vitest';
import { CHARACTERS } from '../src/data/characters';
import { defaultMods } from '../src/data/upgrades';
import { RunState } from '../src/systems/run';
import { parseSave } from '../src/systems/save';
import {
  TALENTS,
  applyTalents,
  clampLevel,
  talentLevel,
  talentPointCap,
  talentSpent,
  talentStartGold,
} from '../src/data/talents';

describe('天赋：纯函数与数值', () => {
  it('vitality 提升最大生命（每级 +25）', () => {
    const m = applyTalents(defaultMods(), { vitality: 5 });
    expect(m.maxHpAdd).toBe(125);
  });

  it('barrier 提升护盾（每级 +15）', () => {
    const m = applyTalents(defaultMods(), { barrier: 3 });
    expect(m.shieldAdd).toBe(45);
  });

  it('swiftness 提升移速（每级 ×1.05）', () => {
    const m = applyTalents(defaultMods(), { swiftness: 2 });
    expect(m.speedMul).toBeCloseTo(1.1, 5);
  });

  it('precision 提升暴击（每级 +0.03）', () => {
    const m = applyTalents(defaultMods(), { precision: 1 });
    expect(m.critAdd).toBeCloseTo(0.03, 5);
  });

  it('pierce 提升穿透（每级 +1）', () => {
    const m = applyTalents(defaultMods(), { pierce: 2 });
    expect(m.pierceAdd).toBe(2);
  });

  it('recovery 提升脱战回血（每级 +1）', () => {
    const m = applyTalents(defaultMods(), { recovery: 3 });
    expect(m.healthRegen).toBe(3);
  });

  it('multishot 提升弹丸数（每级 +1）', () => {
    const m = applyTalents(defaultMods(), { multishot: 1 });
    expect(m.multishotAdd).toBe(1);
  });

  it('fortune 只给初始金币，不动 Mods', () => {
    const base = defaultMods();
    const m = applyTalents(base, { fortune: 4 });
    expect(talentStartGold({ fortune: 4 })).toBe(240);
    // fortune 的 apply 是 no-op，Mods 不应被改动
    expect(m.maxHpAdd).toBe(0);
    expect(m.speedMul).toBe(1);
  });

  it('未投入的天赋不改变任何 Mods', () => {
    const m = applyTalents(defaultMods(), {});
    expect(m).toEqual(defaultMods());
  });

  it('talentPointCap 随历史最佳层数增长（基础 8 + 每层 1）', () => {
    expect(talentPointCap(1)).toBe(8);
    expect(talentPointCap(3)).toBe(10);
    expect(talentPointCap(0)).toBe(8); // 非有限/异常层数按 1 处理
  });

  it('talentSpent 累加所有天赋层级', () => {
    expect(talentSpent({ vitality: 5, barrier: 3, fortune: 2 })).toBe(10);
    expect(talentSpent({})).toBe(0);
  });

  it('clampLevel 夹取 0..maxLevel，脏数据归 0', () => {
    expect(clampLevel(3, 5)).toBe(3);
    expect(clampLevel(-1, 5)).toBe(0);
    expect(clampLevel(99, 5)).toBe(5);
    expect(clampLevel(NaN, 5)).toBe(0);
    expect(clampLevel('x', 5)).toBe(0);
  });

  it('talentLevel 与 clampLevel 行为一致', () => {
    expect(talentLevel({ barrier: 99 }, 'barrier')).toBe(5);
    expect(talentLevel({}, 'vitality')).toBe(0);
  });

  it('每个天赋都有唯一 id 与合法 maxLevel', () => {
    const ids = TALENTS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TALENTS) {
      expect(t.maxLevel).toBeGreaterThan(0);
      expect(typeof t.apply).toBe('function');
    }
  });
});

describe('天赋：存档解析回落', () => {
  it('合法天赋被保留，未知 id 与超限层级被丢弃/夹取', () => {
    const save = parseSave({
      version: 3,
      talents: { vitality: 3, barrier: 99, bogus: 5, precision: -1 },
    });
    expect(save.talents.vitality).toBe(3);
    expect(save.talents.barrier).toBe(5); // 上限 5
    expect(save.talents.precision).toBeUndefined(); // 负数→0 级→不写入（紧凑存储）
    expect(save.talents.bogus).toBeUndefined();
  });

  it('旧档缺 talents 字段回落默认空表', () => {
    const save = parseSave({ version: 3 });
    expect(save.talents).toEqual({});
  });
});

describe('天赋：RunState 注入初始属性（集成）', () => {
  it('生命天赋提升玩家初始最大生命', () => {
    const base = new RunState(CHARACTERS[0]!, 12345);
    const buffed = new RunState(CHARACTERS[0]!, 12345, { vitality: 5 });
    expect(buffed.player.maxHp).toBe(base.player.maxHp + 125);
  });

  it('护盾天赋提升初始护盾（不影响最大生命）', () => {
    const base = new RunState(CHARACTERS[0]!, 999);
    const buffed = new RunState(CHARACTERS[0]!, 999, { barrier: 4 });
    expect(buffed.player.maxShield).toBe(base.player.maxShield + 60);
    expect(buffed.player.maxHp).toBe(base.player.maxHp);
  });

  it('财运天赋注入初始金币', () => {
    const buffed = new RunState(CHARACTERS[0]!, 555, { fortune: 3 });
    expect(buffed.gold).toBe(180);
  });

  it('recomputeMods 后仍保留天赋（捡强化不洗掉天赋）', () => {
    const run = new RunState(CHARACTERS[0]!, 777, { vitality: 5 });
    const before = run.player.maxHp;
    run.addUpgrade('max_hp'); // 任意一次强化都会触发 recomputeMods
    // 生命上限 = (基础 + 天赋25*5) * (强化倍率)；只要大于无天赋基线即可证明天赋仍在
    expect(run.player.maxHp).toBeGreaterThan(before - 1);
    expect(run.mods.maxHpAdd).toBeGreaterThanOrEqual(125);
  });
});
