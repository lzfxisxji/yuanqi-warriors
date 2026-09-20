import { describe, expect, test } from 'vitest';
import { WEAPONS, getWeaponDef, rollWeaponId, weaponStatBars } from '../src/data/weapons';
import {
  ELITE_ENEMIES,
  ENEMIES,
  NORMAL_ENEMIES,
  getEnemyDef,
  scaledContactDamage,
  scaledHp,
  scaledProjectileDamage,
} from '../src/data/enemies';
import { UPGRADES, addUpgrade, computeMods, defaultMods, rollUpgradeChoices, stacksOf } from '../src/data/upgrades';
import { buildCombatWaves, buildEliteWaves, waveEnemyCount } from '../src/data/encounters';
import { CHARACTERS, getCharacter, isCharacterUnlocked, unlockHint, type CharacterDef } from '../src/data/characters';
import { EVENTS } from '../src/data/events';
import { RNG } from '../src/core/math';

describe('武器表', () => {
  test('至少 8 把武器，id / 名称唯一', () => {
    expect(WEAPONS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(WEAPONS.map((w) => w.id)).size).toBe(WEAPONS.length);
    expect(new Set(WEAPONS.map((w) => w.name)).size).toBe(WEAPONS.length);
  });

  test('武器形态覆盖实弹 / 能量 / 火焰 / 爆炸四类', () => {
    const kinds = new Set(WEAPONS.map((w) => w.kind));
    expect(kinds.has('bullet')).toBe(true);
    expect(kinds.has('beam')).toBe(true);
    expect(kinds.has('flame')).toBe(true);
    expect(kinds.has('grenade')).toBe(true);
  });

  test('关键属性确实彼此不同（不是换皮）', () => {
    const bulletLike = WEAPONS.filter((w) => w.damage > 0);
    const fireRates = new Set(bulletLike.map((w) => w.fireRate));
    const speeds = new Set(bulletLike.map((w) => w.bulletSpeed));
    const mags = new Set(WEAPONS.map((w) => w.mag));
    expect(fireRates.size).toBeGreaterThanOrEqual(5);
    expect(speeds.size).toBeGreaterThanOrEqual(5);
    expect(mags.size).toBeGreaterThanOrEqual(5);
  });

  test('特殊弹道被真实实现（霰弹 / 贯穿 / 激光 / 爆炸 / 燃烧）', () => {
    const shotgun = WEAPONS.find((w) => w.id === 'shotgun')!;
    expect(shotgun.pellets).toBeGreaterThan(1);
    expect(shotgun.spread).toBeGreaterThan(0.2);

    const sniper = WEAPONS.find((w) => w.id === 'sniper')!;
    expect(sniper.pierce).toBeGreaterThanOrEqual(1);

    const laser = WEAPONS.find((w) => w.kind === 'beam')!;
    expect(laser.beamDps).toBeGreaterThan(0);
    expect(laser.beamWidth).toBeGreaterThan(0);

    const grenade = WEAPONS.find((w) => w.kind === 'grenade')!;
    expect(grenade.explosive?.radius).toBeGreaterThan(0);
    expect(grenade.explosive?.damage).toBeGreaterThan(0);

    const flame = WEAPONS.find((w) => w.kind === 'flame')!;
    expect(flame.burn?.dps).toBeGreaterThan(0);
    expect(flame.burn?.duration).toBeGreaterThan(0);
  });

  test('每个武器都能生成合理的属性条，且数值在 0..1 内', () => {
    for (const w of WEAPONS) {
      const bars = weaponStatBars(w);
      expect(bars.length).toBe(3);
      for (const b of bars) {
        expect(b.value).toBeGreaterThanOrEqual(0);
        expect(b.value).toBeLessThanOrEqual(1);
      }
    }
  });

  test('getWeaponDef 未知 id 回退到首把武器', () => {
    expect(getWeaponDef('不存在的武器').id).toBe(WEAPONS[0]!.id);
  });

  test('基础攻击力已整体上调，没有哪把武器明显刮痧', () => {
    // 「初始攻击力」= 未强化时的基础值，任何武器都应在合理区间内
    const pistol = WEAPONS.find((w) => w.id === 'pulse_pistol')!;
    expect(pistol.damage).toBeGreaterThanOrEqual(20);

    for (const w of WEAPONS) {
      // 光束武器看 beamDps，其余按 伤害 × 射速 × 弹丸数 估算基础 DPS
      const dps = w.kind === 'beam' ? (w.beamDps ?? 0) : w.damage * w.fireRate * w.pellets;
      expect(dps).toBeGreaterThanOrEqual(60);
    }

    // 爆炸与燃烧的附加伤害同样享受这次上调
    const grenade = WEAPONS.find((w) => w.kind === 'grenade')!;
    expect(grenade.explosive!.damage).toBeGreaterThanOrEqual(70);
    const flame = WEAPONS.find((w) => w.kind === 'flame')!;
    expect(flame.burn!.dps).toBeGreaterThanOrEqual(10);
  });

  test('rollWeaponId 会尊重排除列表', () => {
    const rng = new RNG(7);
    const excluded = WEAPONS.slice(0, WEAPONS.length - 1).map((w) => w.id);
    for (let i = 0; i < 30; i++) {
      const id = rollWeaponId((ws) => rng.weightedIndex(ws), excluded);
      expect(excluded.includes(id)).toBe(false);
    }
  });
});

describe('敌人表', () => {
  test('至少 6 种普通敌人 + 2 种精英敌人', () => {
    expect(NORMAL_ENEMIES.length).toBeGreaterThanOrEqual(6);
    expect(ELITE_ENEMIES.length).toBeGreaterThanOrEqual(2);
    expect(NORMAL_ENEMIES.length + ELITE_ENEMIES.length).toBe(ENEMIES.length);
  });

  test('AI 行为种类足够多样（>= 6 种）', () => {
    const ais = new Set(ENEMIES.map((e) => e.ai));
    expect(ais.size).toBeGreaterThanOrEqual(6);
    expect(ais.has('melee')).toBe(true);
    expect(ais.has('charger')).toBe(true);
    expect(ais.has('kiter')).toBe(true);
  });

  test('每种敌人都配置了前摇，远程敌人必须有弹丸定义', () => {
    for (const e of ENEMIES) {
      expect(e.windup).toBeGreaterThan(0);
      expect(e.hp).toBeGreaterThan(0);
      expect(e.radius).toBeGreaterThan(0);
      const ranged = e.ai !== 'melee' && e.ai !== 'charger';
      if (ranged) expect(e.projectile).toBeDefined();
      if (e.ai === 'kiter') expect(e.summon).toBeDefined();
    }
  });

  test('精英敌人的血量与奖励明显高于普通敌人', () => {
    const maxNormalHp = Math.max(...NORMAL_ENEMIES.map((e) => e.hp));
    for (const e of ELITE_ENEMIES) {
      expect(e.hp).toBeGreaterThan(maxNormalHp);
      expect(e.gold[1]).toBeGreaterThan(Math.max(...NORMAL_ENEMIES.map((n) => n.gold[1])));
    }
  });

  test('楼层缩放让敌人越往后越强', () => {
    const def = getEnemyDef('grub');
    expect(scaledHp(def, 2)).toBeGreaterThan(scaledHp(def, 1));
    expect(scaledHp(def, 3)).toBeGreaterThan(scaledHp(def, 2));
    expect(scaledContactDamage(def, 3)).toBeGreaterThan(scaledContactDamage(def, 1));
    const sentinel = getEnemyDef('sentinel');
    expect(scaledProjectileDamage(sentinel, 3)).toBeGreaterThan(scaledProjectileDamage(sentinel, 1));
    // 无弹丸的敌人返回 0
    expect(scaledProjectileDamage(def, 2)).toBe(0);
  });

  test('getEnemyDef 对未知 id 抛错（避免静默失败）', () => {
    expect(() => getEnemyDef('nope')).toThrow();
  });
});

describe('强化系统', () => {
  test('至少 10 条强化，id 唯一', () => {
    expect(UPGRADES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(UPGRADES.map((u) => u.id)).size).toBe(UPGRADES.length);
  });

  test('默认 Mods 为中性值', () => {
    const m = defaultMods();
    expect(m.damageMul).toBe(1);
    expect(m.maxHpMul).toBe(1);
    expect(m.maxHpAdd).toBe(0);
    expect(m.critAdd).toBe(0);
  });

  test('叠加强化会按层数累积，且不会超过 maxStacks', () => {
    const stacks: { id: string; stacks: number }[] = [];
    const max = UPGRADES.find((u) => u.id === 'bullet')!.maxStacks;
    for (let i = 0; i < max + 5; i++) addUpgrade(stacks, 'bullet');
    expect(stacksOf(stacks, 'bullet')).toBe(max);
    const mods = computeMods(stacks);
    expect(mods.damageMul).toBeCloseTo(Math.pow(1.18, max), 6);
  });

  test('不同强化可自由组合出复合 Build', () => {
    const stacks: { id: string; stacks: number }[] = [];
    addUpgrade(stacks, 'bullet');
    addUpgrade(stacks, 'trigger');
    addUpgrade(stacks, 'boot');
    addUpgrade(stacks, 'double');
    const m = computeMods(stacks);
    expect(m.damageMul).toBeGreaterThan(1);
    expect(m.fireRateMul).toBeGreaterThan(1);
    expect(m.speedMul).toBeGreaterThan(1);
    expect(m.multishotAdd).toBe(1);
  });

  test('rollUpgradeChoices 抽出的选项互不重复且未满层', () => {
    const rng = new RNG(2026);
    const stacks: { id: string; stacks: number }[] = [];
    const chosen = rollUpgradeChoices(stacks, 3, (w) => rng.weightedIndex(w));
    expect(chosen.length).toBe(3);
    expect(new Set(chosen).size).toBe(3);
    for (const id of chosen) {
      expect(UPGRADES.some((u) => u.id === id)).toBe(true);
    }
  });

  test('满层强化不会再被抽到', () => {
    const rng = new RNG(11);
    const stacks: { id: string; stacks: number }[] = [];
    for (const u of UPGRADES) for (let i = 0; i < u.maxStacks; i++) addUpgrade(stacks, u.id);
    for (const u of UPGRADES) expect(stacksOf(stacks, u.id)).toBe(u.maxStacks);
    expect(rollUpgradeChoices(stacks, 3, (w) => rng.weightedIndex(w)).length).toBe(0);
  });

  test('未知强化 id 被安全忽略', () => {
    const stacks: { id: string; stacks: number }[] = [];
    addUpgrade(stacks, 'ghost_upgrade');
    expect(stacks.length).toBe(0);
    expect(computeMods([{ id: 'ghost_upgrade', stacks: 3 }])).toEqual(defaultMods());
  });

  test('再生脉络：叠加累积脱战回血，受 maxStacks 限制', () => {
    const stacks: { id: string; stacks: number }[] = [];
    expect(defaultMods().healthRegen).toBe(0);
    addUpgrade(stacks, 'regen');
    const one = computeMods(stacks);
    expect(one.healthRegen).toBeGreaterThan(0);

    const def = UPGRADES.find((u) => u.id === 'regen')!;
    for (let i = 0; i < def.maxStacks + 3; i++) addUpgrade(stacks, 'regen');
    expect(stacksOf(stacks, 'regen')).toBe(def.maxStacks);
    // 满层正好是单层效果的 maxStacks 倍
    expect(computeMods(stacks).healthRegen).toBeCloseTo(one.healthRegen * def.maxStacks, 6);
  });
});

describe('遭遇战编排', () => {
  test('普通战斗房波次包含敌人且数量随楼层上升', () => {
    for (let floor = 1; floor <= 3; floor++) {
      const rng = new RNG(floor * 1234 + 7);
      let total = 0;
      for (let i = 0; i < 40; i++) {
        const waves = buildCombatWaves(rng, floor);
        expect(waves.length).toBeGreaterThanOrEqual(1);
        for (const w of waves) {
          expect(w.groups.length).toBeGreaterThan(0);
          expect(waveEnemyCount(w)).toBeGreaterThan(0);
          for (const g of w.groups) {
            expect(NORMAL_ENEMIES.some((e) => e.id === g.id)).toBe(true);
          }
        }
        total += waves.reduce((s, w) => s + waveEnemyCount(w), 0);
      }
      expect(total).toBeGreaterThan(0);
    }
  });

  test('精英房必定包含一名精英敌人', () => {
    const rng = new RNG(4321);
    for (let i = 0; i < 30; i++) {
      const waves = buildEliteWaves(rng, 2);
      const ids = waves.flatMap((w) => w.groups.map((g) => g.id));
      expect(ids.some((id) => ELITE_ENEMIES.some((e) => e.id === id))).toBe(true);
    }
  });
});

describe('角色 / 事件数据', () => {
  test('提供 6 名差异明显的角色', () => {
    expect(CHARACTERS.length).toBe(6);
    // 三种技能类型都要有人用（影袭翻滚 / 超载引擎 / 奶泡护体 等）。
    const skills = new Set(CHARACTERS.map((c) => c.skill.kind));
    expect(skills.size).toBe(3);
    const hps = CHARACTERS.map((c) => c.maxHp);
    expect(Math.max(...hps) - Math.min(...hps)).toBeGreaterThan(50);
    const speeds = CHARACTERS.map((c) => c.speed);
    expect(Math.max(...speeds) - Math.min(...speeds)).toBeGreaterThan(60);
    for (const c of CHARACTERS) {
      expect(WEAPONS.some((w) => w.id === c.startWeapon)).toBe(true);
      expect(c.bars.length).toBe(3);
    }
  });

  test('新增角色噜噜 / 肥嘟袋鼠 / 奶龙 / 牛来默认解锁', () => {
    const lulu = getCharacter('lulu');
    const roo = getCharacter('fatkangaroo');
    const milk = getCharacter('milkdragon');
    const niu = getCharacter('niulai');
    expect(lulu.name).toBe('噜噜');
    expect(roo.name).toBe('肥嘟袋鼠');
    expect(milk.name).toBe('奶龙');
    expect(niu.name).toBe('牛来');
    // 「直接解锁」的判据：任何进度（包括全零）都能选中。
    const zero = { bestFloor: 0, wins: 0 };
    for (const c of [lulu, roo, milk, niu]) {
      expect(isCharacterUnlocked(c, zero)).toBe(true);
      expect(unlockHint(c)).toBe('初始解锁');
    }
  });

  test('四个新角色都配了立绘 slug，且 id 唯一', () => {
    expect(getCharacter('lulu').sprite).toBe('lulu');
    expect(getCharacter('fatkangaroo').sprite).toBe('fatkangaroo');
    expect(getCharacter('milkdragon').sprite).toBe('milkdragon');
    expect(getCharacter('niulai').sprite).toBe('niulai');
    const ids = new Set(CHARACTERS.map((c) => c.id));
    expect(ids.size).toBe(CHARACTERS.length);
  });

  test('解锁规则按进度正确判定', () => {
    const wolf = getCharacter('wolfshade');
    const sting = getCharacter('sting');
    expect(isCharacterUnlocked(wolf, { bestFloor: 1, wins: 0 })).toBe(true);
    expect(isCharacterUnlocked(sting, { bestFloor: 1, wins: 0 })).toBe(false);
    expect(isCharacterUnlocked(sting, { bestFloor: 2, wins: 0 })).toBe(true);

    // 「通关 N 次解锁」（wins）目前**没有角色在用** —— 原「磐垒」取消后这条就空了出来。
    // 规则与分支都保留（见 characters.ts 的 UnlockRule 注释），这里用一份合成定义
    // 守住该分支，免得它因为没人用而悄悄腐化。
    const byWins: CharacterDef = {
      ...wolf,
      id: 'synthetic-wins',
      unlock: { kind: 'wins', value: 3 },
    };
    expect(isCharacterUnlocked(byWins, { bestFloor: 9, wins: 2 })).toBe(false);
    expect(isCharacterUnlocked(byWins, { bestFloor: 9, wins: 3 })).toBe(true);
    expect(unlockHint(byWins)).toBe('解锁条件：通关 3 次');
  });

  test('未知角色 id 回退到首个角色', () => {
    expect(getCharacter('nobody').id).toBe(CHARACTERS[0]!.id);
  });

  test('事件房提供多个可选项', () => {
    expect(EVENTS.length).toBeGreaterThanOrEqual(3);
    for (const ev of EVENTS) {
      expect(ev.options.length).toBeGreaterThanOrEqual(2);
      expect(ev.title.length).toBeGreaterThan(0);
      expect(ev.body.length).toBeGreaterThan(0);
    }
  });
});
