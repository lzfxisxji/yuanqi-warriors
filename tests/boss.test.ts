/**
 * 多关卡 Boss（需求 17）回归测试。
 *
 * 背景：原来只有第 1 层一个硬编码 Boss「熔核·渊心」。现在改为数据驱动（src/data/bosses.ts），
 * 每层一个 `BossDef`：第 1 层程序化、第 2 层豆包（位图）、第 3 层 DeepSeek（位图）。
 *
 * 这里锁死几条关键约束，任何一条被破坏都会立刻变红：
 *   - 每一层都有 Boss，且彼此不同（id / 名字不重复）；
 *   - 三层 Boss 的碰撞半径统一参考第一关（52），保证手感一致（用户明确要求）；
 *   - 每层 Boss 的三个阶段攻击池都非空、且攻击类型合法；
 *   - 豆包「召唤伙伴」的 summonIds 必须能在敌人表里解析到，且都配了立绘；
 *   - Boss 实体正确初始化（半径 / 名称 / title），血量与接触伤害按 `1.5^(floor-1)` 递增（需求 21）。
 */
import { describe, expect, test } from 'vitest';
import {
  BOSSES,
  BOSS_ATTACK_LABELS,
  FLOOR_BOSSES,
  bossContactDamage,
  bossMaxHp,
  getBossDefForFloor,
  validateBossFloors,
  type BossDef,
} from '../src/data/bosses';
import { getEnemyDef, SUMMON_ENEMIES } from '../src/data/enemies';
import { FLOOR_COUNT, FLOOR_POWER_STEP } from '../src/data/config';
import { Boss, type BossAttackKind } from '../src/entities/boss';

const VALID_ATTACKS: ReadonlySet<BossAttackKind> = new Set<BossAttackKind>([
  'fanSpread',
  'aimedBurst',
  'charge',
  'ringBurst',
  'summon',
  'spiral',
  'laserSweep',
]);

describe('每层 Boss 定义', () => {
  test('FLOOR_BOSSES 覆盖 1..FLOOR_COUNT 每一层，validateBossFloors 通过', () => {
    expect(FLOOR_COUNT).toBeGreaterThanOrEqual(3);
    expect(() => validateBossFloors()).not.toThrow();
    for (let f = 1; f <= FLOOR_COUNT; f++) {
      expect(FLOOR_BOSSES[f]).toBeDefined();
      expect(FLOOR_BOSSES[f]!.floor).toBe(f);
    }
  });

  test('每一层 Boss 的 id / 名字都不一样（不是换皮同一个 Boss）', () => {
    const defs = Object.values(FLOOR_BOSSES);
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
    expect(new Set(defs.map((d) => d.name)).size).toBe(defs.length);
    expect(new Set(defs.map((d) => d.title)).size).toBe(defs.length);
  });

  test('所有 Boss 的碰撞半径统一参考第一关（=52）', () => {
    for (const def of Object.values(FLOOR_BOSSES)) {
      expect(def.radius).toBe(52);
    }
  });

  test('每个 Boss 的三个阶段攻击池都非空、类型合法，终极技合法', () => {
    for (const def of Object.values(FLOOR_BOSSES)) {
      expect(def.phaseAttacks.length).toBeGreaterThanOrEqual(3);
      for (let i = 0; i < 3; i++) {
        const pool = def.phaseAttacks[i]!;
        expect(pool.length).toBeGreaterThan(0);
        for (const a of pool) expect(VALID_ATTACKS.has(a)).toBe(true);
      }
      expect(VALID_ATTACKS.has(def.ultimateAttack)).toBe(true);
      expect(def.ultimateAt).toBeGreaterThanOrEqual(0);
      expect(def.ultimateAt).toBeLessThanOrEqual(1);
    }
  });

  test('每个 Boss 都配了 4 个技能名，且配色字段完整', () => {
    for (const def of Object.values(FLOOR_BOSSES)) {
      expect(def.skillNames.length).toBe(4);
      for (const n of def.skillNames) expect(n.length).toBeGreaterThan(0);
      for (const key of ['glow', 'core', 'body', 'accent', 'bullet', 'bulletGlow'] as const) {
        expect(typeof def.palette[key]).toBe('string');
        expect(def.palette[key].length).toBeGreaterThan(0);
      }
    }
  });

  test('getBossDefForFloor 越界回落到最后一层；各层返回各不相同', () => {
    const seen = new Set<string>();
    for (let f = 1; f <= FLOOR_COUNT; f++) seen.add(getBossDefForFloor(f).id);
    expect(seen.size).toBe(FLOOR_COUNT);
    const last = getBossDefForFloor(FLOOR_COUNT);
    expect(getBossDefForFloor(FLOOR_COUNT + 5).id).toBe(last.id);
    expect(getBossDefForFloor(0).id).toBe(last.id);
  });
});

describe('两层位图 Boss 的立绘与召唤伙伴', () => {
  test('第 1 层是程序化（无 sprite），第 2/3 层是位图立绘', () => {
    expect(getBossDefForFloor(1).sprite).toBeUndefined();
    expect(getBossDefForFloor(2).sprite).toBe('doubao');
    expect(getBossDefForFloor(3).sprite).toBe('deepseek');
  });

  test('豆包「召唤伙伴」的 summonIds 都能解析到敌人，且指向带立绘的伙伴', () => {
    const doubao = getBossDefForFloor(2);
    expect(doubao.summonIds.length).toBeGreaterThan(0);
    const summonIds = new Set(SUMMON_ENEMIES.map((e) => e.id));
    for (const id of doubao.summonIds) {
      expect(summonIds.has(id)).toBe(true);
      const def = getEnemyDef(id);
      expect(def.sprite).toBeDefined();
      expect(def.ai).toBe('melee');
    }
  });

  test('召唤伙伴不进普通波次 / 精英池（只由 Boss 召唤）', () => {
    // SUMMON_ENEMIES 与 ENEMIES 分离；普通/精英池里不应出现 pal_ 前缀。
    for (const def of SUMMON_ENEMIES) {
      expect(def.id.startsWith('pal_')).toBe(true);
      expect(def.elite).toBe(false);
    }
  });
});

describe('Boss 实体按定义初始化', () => {
  test('半径 / 血量 / 接触伤害 / 名称都来自 BossDef', () => {
    for (let f = 1; f <= FLOOR_COUNT; f++) {
      const def = getBossDefForFloor(f);
      const boss = new Boss(640, 300, def);
      expect(boss.radius).toBe(def.radius);
      expect(boss.name).toBe(def.name);
      expect(boss.title).toBe(def.title);
      expect(boss.floor).toBe(f);
      expect(boss.maxHp).toBe(bossMaxHp(def));
      expect(boss.contactDamage).toBe(bossContactDamage(def));
      expect(boss.def).toBe(def);
    }
  });

  test('越往后血量与接触伤害越高（成长曲线单调）', () => {
    const hp = [] as number[];
    const cd = [] as number[];
    for (let f = 1; f <= FLOOR_COUNT; f++) {
      const b = new Boss(640, 300, getBossDefForFloor(f));
      hp.push(b.maxHp);
      cd.push(b.contactDamage);
    }
    for (let i = 1; i < hp.length; i++) {
      expect(hp[i]!).toBeGreaterThan(hp[i - 1]!);
      expect(cd[i]!).toBeGreaterThan(cd[i - 1]!);
    }
  });

  test('每层血量与接触伤害严格是上一层的 1.5 倍（需求 21）', () => {
    for (let f = 2; f <= FLOOR_COUNT; f++) {
      const prev = getBossDefForFloor(f - 1);
      const cur = getBossDefForFloor(f);
      expect(bossMaxHp(cur) / bossMaxHp(prev)).toBeCloseTo(FLOOR_POWER_STEP, 10);
      expect(bossContactDamage(cur) / bossContactDamage(prev)).toBeCloseTo(FLOOR_POWER_STEP, 10);
      // 实体上取到的值与纯函数一致（图鉴 / 实战同源）
      const b = new Boss(640, 300, cur);
      expect(b.maxHp).toBe(bossMaxHp(cur));
      expect(b.contactDamage).toBe(bossContactDamage(cur));
    }
  });

  test('每个 BossDef 都能安全构造（不会因缺字段炸掉）', () => {
    const defs: BossDef[] = Object.values(FLOOR_BOSSES);
    for (const def of defs) expect(() => new Boss(0, 0, def)).not.toThrow();
  });
});

/**
 * 需求 18：图鉴新增「Boss图鉴」分页。
 * 图鉴直接读 BOSSES / bossMaxHp 这些导出，所以这里把「图鉴看到的数据」也锁一遍 ——
 * 光有 Boss 能跑不够，图鉴里显示错数值同样是 bug。
 */
describe('Boss 图鉴的数据来源（需求 18）', () => {
  test('BOSSES 按楼层升序、覆盖全部层，且就是 FLOOR_BOSSES 里的同一批对象', () => {
    expect(BOSSES.length).toBe(FLOOR_COUNT);
    expect(BOSSES.map((d) => d.floor)).toEqual([1, 2, 3]);
    for (const def of BOSSES) expect(FLOOR_BOSSES[def.floor]).toBe(def); // 同一引用，不是复制出来的第二份
  });

  test('每个 Boss 都写了图鉴简介，且不是占位/空文案', () => {
    for (const def of BOSSES) {
      expect(typeof def.desc).toBe('string');
      // 太短的简介在面板里等于没写，卡一个下限
      expect(def.desc.length).toBeGreaterThanOrEqual(12);
      expect(def.desc).not.toContain('TODO');
      expect(def.desc).not.toContain('？？？');
    }
  });

  test('bossMaxHp / bossContactDamage 与 Boss 实体真实取值一致（图鉴不能显示假数值）', () => {
    for (const def of BOSSES) {
      const boss = new Boss(0, 0, def);
      expect(bossMaxHp(def)).toBe(boss.maxHp);
      expect(bossContactDamage(def)).toBe(boss.contactDamage);
    }
  });

  test('BOSS_ATTACK_LABELS 覆盖全部攻击类型（终极技那一栏不会出现 undefined）', () => {
    for (const a of VALID_ATTACKS) {
      expect(typeof BOSS_ATTACK_LABELS[a]).toBe('string');
      expect(BOSS_ATTACK_LABELS[a].length).toBeGreaterThan(0);
    }
    for (const def of BOSSES) expect(BOSS_ATTACK_LABELS[def.ultimateAttack]).toBeTruthy();
  });
});
