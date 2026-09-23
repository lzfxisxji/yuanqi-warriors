/**
 * 近战武器（需求 21）回归测试。
 *
 * 背景：`weapon/weapon.png` 是一张「近战武器 MELEE WEAPONS」设定表，
 * 里面列了 咸鱼 / 狼牙棒 / 木棍 / 长枪 四把近战武器。本作用 `kind: 'melee'` 实现：
 * 不产生弹丸，命中判定是「瞄准方向前方的一个扇形」。
 *
 * 这里锁死几条关键约束，破坏任何一条都会立刻变红：
 *   - 四把武器都在表里，id / 名称唯一，且都是近战；
 *   - 近战没有弹匣：连续挥砍不消耗弹药、不进换弹、永不 `startReload`；
 *   - 命中范围：点按轻挥 = 扇形（距离 ≤ range 且与瞄准方向夹角 ≤ swingArc/2），身后打不到；
 *     蓄力释放（需求 31）= 360° 全向，整圈敌人都能打到；超距的都打不到；
 *   - 长枪的张角明显比横扫类窄（"直线贯穿"），狼牙棒单次伤害最高，木棍攻速最快；
 *   - 一次挥砍命中扇形内**所有**目标（近战天然穿透）；
 *   - 冷却生效：同一次冷却窗口内不会重复结算伤害。
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Player, createWeaponInstance } from '../src/entities/player';
import { getCharacter } from '../src/data/characters';
import { MELEE_DAMAGE_SCALE, WEAPONS, getWeaponDef, rollWeaponId } from '../src/data/weapons';
import { RNG } from '../src/core/math';
import type { DamageContext } from '../src/systems/combat';
import type { HitEntity } from '../src/systems/combat';
import type { Projectile } from '../src/entities/projectile';
import { ProjectileSystem } from '../src/entities/projectile';
import type { Room } from '../src/dungeon/room';
import { updateWeapon, type WeaponFireContext } from '../src/systems/weaponSystem';
import type { DamageResult } from '../src/core/types';

// ---------------------------------------------------------------- 测试替身

/** 记录伤害的假目标。 */
interface FakeTarget extends HitEntity {
  taken: number;
  hits: number;
}

function makeTarget(x: number, y: number, radius = 14, team: string = 'enemy'): FakeTarget {
  return {
    x,
    y,
    radius,
    hp: 100000,
    dead: false,
    team,
    taken: 0,
    hits: 0,
    applyDamage(amount: number): DamageResult {
      this.taken += amount;
      this.hits += 1;
      return { applied: amount, crit: false, killed: false, blocked: false, dodged: false };
    },
  };
}

/**
 * 空转对象：访问任何属性都得到一个 no-op 函数。
 * 粒子系统 / 音效系统的方法很多，逐个写桩既啰嗦又容易漏（漏一个就 TypeError），
 * 这里直接用 Proxy 兜住。
 */
function noopBag<T>(): T {
  return new Proxy({} as Record<string, unknown>, {
    get: (t, k) => {
      const key = k as string;
      if (!(key in t)) t[key] = () => undefined;
      return t[key];
    },
  }) as T;
}

function makeDamageCtx(): DamageContext {
  return {
    particles: noopBag(),
    bus: noopBag(),
    shake: noopBag(),
    numbers: noopBag(),
    flash: noopBag(),
    time: noopBag(),
    audio: noopBag(),
  } as unknown as DamageContext;
}

/** 装备指定近战武器并朝向 +X。 */
function meleePlayer(weaponId: string): Player {
  const p = new Player(getCharacter('wolfshade'));
  p.weapons = [createWeaponInstance(weaponId, p.mods)];
  p.weaponIndex = 0;
  p.aimAngle = 0;
  return p;
}

/** 构造一帧开火上下文（默认用空转弹丸系统，不真实弹射）。 */
function swingCtx(p: Player, targets: FakeTarget[], extra: Partial<WeaponFireContext> = {}): WeaponFireContext {
  return {
    player: p,
    room: {} as Room,
    ctx: makeDamageCtx(),
    projectiles: { spawn: () => undefined } as unknown as ProjectileSystem,
    targets,
    dt: 1 / 60,
    time: 0,
    ...extra,
  };
}

/**
 * 跑一次"完整挥砍"：按下（蓄力 1 帧）→ 松开（释放挥砍）。
 * 需求 30 之后近战改为"按住蓄力、松开释放"，所以单次攻击必须由 press+release 组成；
 * 极短按压（< MELEE_CHARGE_MIN_HOLD）视为点按，伤害即为原伤害，从而旧测试语义不变。
 */
function fire(p: Player, targets: FakeTarget[], firing = true): { spawned: number } {
  const shots = { count: 0 };
  const ctx = swingCtx(p, targets, {
    projectiles: {
      spawn: () => {
        shots.count += 1;
      },
    } as unknown as ProjectileSystem,
  });
  if (firing) updateWeapon(ctx, true);
  updateWeapon(ctx, false);
  return { spawned: shots.count };
}

/** 让随机数不触发暴击，伤害断言变确定（暴击是 1.6 倍且靠 Math.random 判定）。 */
const noCrit = () => vi.spyOn(Math, 'random').mockReturnValue(0.999);

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- 数据

describe('近战武器数据', () => {
  const MELEE_IDS = ['salted_fish', 'spiked_mace', 'wood_stick', 'long_spear'];

  test('设定表里的四把近战武器都在，且都是 melee', () => {
    for (const id of MELEE_IDS) {
      const def = getWeaponDef(id);
      expect(def.id).toBe(id);
      expect(def.kind).toBe('melee');
      expect(def.swingArc).toBeGreaterThan(0);
      expect(def.range).toBeGreaterThan(0);
    }
    // 四把的名字与设定表一致
    expect(MELEE_IDS.map((id) => getWeaponDef(id).name)).toEqual(['咸鱼', '狼牙棒', '木棍', '长枪']);
  });

  test('近战没有弹匣概念，但基础 DPS 仍达到全表下限', () => {
    for (const id of MELEE_IDS) {
      const def = getWeaponDef(id);
      expect(def.mag).toBe(1);
      expect(def.reloadTime).toBe(0);
      expect(def.bulletSpeed).toBe(0);
      // 伤害已经过 meleeDmg() 换算：设定表数值 × MELEE_DAMAGE_SCALE × WEAPON_DAMAGE_MUL
      expect(def.damage / MELEE_DAMAGE_SCALE).toBeGreaterThan(0);
      expect(def.damage * def.fireRate).toBeGreaterThanOrEqual(60);
    }
  });

  test('四把彼此有真实差异（不是换皮）', () => {
    const fish = getWeaponDef('salted_fish');
    const mace = getWeaponDef('spiked_mace');
    const stick = getWeaponDef('wood_stick');
    const spear = getWeaponDef('long_spear');

    // 单次伤害：狼牙棒最高（设定表 40），木棍最低（20）
    expect(mace.damage).toBeGreaterThan(spear.damage);
    expect(spear.damage).toBeGreaterThan(fish.damage);
    expect(fish.damage).toBeGreaterThan(stick.damage);

    // 攻速：木棍最快（1.5），狼牙棒最慢（0.8）
    expect(stick.fireRate).toBeGreaterThan(fish.fireRate);
    expect(fish.fireRate).toBeGreaterThan(spear.fireRate);
    expect(spear.fireRate).toBeGreaterThan(mace.fireRate);

    // 攻击范围：长枪最远且张角最窄（= 直线突刺）
    expect(spear.range).toBeGreaterThan(mace.range);
    expect(spear.range).toBeGreaterThan(fish.range);
    expect(spear.range).toBeGreaterThan(stick.range);
    expect(spear.swingArc!).toBeLessThan(fish.swingArc!);
    expect(spear.swingArc!).toBeLessThan(mace.swingArc!);
    expect(spear.swingArc!).toBeLessThan(stick.swingArc!);

    // 击退：狼牙棒最猛（设定表「击退效果」）
    expect(mace.knockback).toBeGreaterThan(spear.knockback);
    expect(spear.knockback).toBeGreaterThan(fish.knockback);

    // 全部近战共用 'melee' 音效与 blade 造型，图鉴 / HUD 靠这两个字段分流
    for (const id of MELEE_IDS) {
      const def = getWeaponDef(id);
      expect(def.sound).toBe('melee');
      expect(def.shape).toBe('blade');
      expect(def.heldLength).toBeGreaterThan(0);
    }
  });

  test('近战武器进了掉落池（能被 rollWeaponId 抽到）', () => {
    expect(WEAPONS.filter((w) => w.kind === 'melee').length).toBe(4);
    const meleeIds = new Set(MELEE_IDS);
    const seen = new Set<string>();
    const rng = new RNG(20260919);
    for (let i = 0; i < 400; i++) seen.add(rollWeaponId((ws) => rng.weightedIndex(ws)));
    expect([...seen].some((id) => meleeIds.has(id))).toBe(true);
  });
});

// ---------------------------------------------------------------- 命中判定

describe('近战：扇形命中判定', () => {
  test('正前方的敌人被命中，身后的打不到', () => {
    noCrit();
    const p = meleePlayer('wood_stick');
    const front = makeTarget(40, 0);
    const back = makeTarget(-40, 0);
    fire(p, [front, back]);
    expect(front.hits).toBe(1);
    expect(back.hits).toBe(0);
  });

  test('超出攻击范围的敌人打不到', () => {
    noCrit();
    const p = meleePlayer('salted_fish'); // range 92
    const near = makeTarget(50, 0);
    const far = makeTarget(120, 0);
    fire(p, [near, far]);
    expect(near.hits).toBe(1);
    expect(far.hits).toBe(0);
  });

  test('同阵营（队友）不会被误伤', () => {
    noCrit();
    const p = meleePlayer('salted_fish');
    const ally = makeTarget(40, 0, 14, p.team);
    fire(p, [ally]);
    expect(ally.hits).toBe(0);
  });

  test('一次挥砍命中扇形内的全部目标（近战天然穿透）', () => {
    noCrit();
    const p = meleePlayer('wood_stick');
    const a = makeTarget(45, -8);
    const b = makeTarget(50, 2);
    const c = makeTarget(40, 10);
    fire(p, [a, b, c]);
    expect(a.hits).toBe(1);
    expect(b.hits).toBe(1);
    expect(c.hits).toBe(1);
  });

  test('长枪张角更窄：偏 40° 的目标长枪打不到、咸鱼打得到', () => {
    noCrit();
    // 偏 40°（≈0.698 rad），距离都在两把武器的射程内
    const angle = (40 * Math.PI) / 180;

    const spear = meleePlayer('long_spear');
    const spearTarget = makeTarget(Math.cos(angle) * 70, Math.sin(angle) * 70);
    fire(spear, [spearTarget]);
    expect(spearTarget.hits).toBe(0);

    const fish = meleePlayer('salted_fish');
    const fishTarget = makeTarget(Math.cos(angle) * 50, Math.sin(angle) * 50);
    fire(fish, [fishTarget]);
    expect(fishTarget.hits).toBe(1);
  });

  test('伤害 = 武器伤害（未暴击时），与设定表换算一致', () => {
    noCrit();
    const p = meleePlayer('spiked_mace');
    const t = makeTarget(40, 0);
    fire(p, [t]);
    expect(t.taken).toBeCloseTo(getWeaponDef('spiked_mace').damage, 6);
  });

  test('冷却生效：同一次冷却窗口内不会重复结算', () => {
    noCrit();
    const p = meleePlayer('spiked_mace'); // fireRate 0.8 → 冷却 1.25s
    const t = makeTarget(40, 0);
    fire(p, [t]);
    expect(t.hits).toBe(1);
    // 紧接着再"扣扳机"：还在冷却里，不该再打一下
    fire(p, [t]);
    expect(t.hits).toBe(1);
    // 推进超过一个冷却周期后可以再挥
    for (let i = 0; i < 90; i++) p.updateTimers(1 / 60);
    fire(p, [t]);
    expect(t.hits).toBe(2);
  });
});

// ---------------------------------------------------------------- 弹药 / 动画

describe('近战：弹药与挥砍动画', () => {
  test('连续挥砍不消耗弹药、不进换弹', () => {
    noCrit();
    const p = meleePlayer('wood_stick');
    const magBefore = p.currentWeapon.magSize;
    const ammoBefore = p.currentWeapon.ammo;
    const t = makeTarget(40, 0);
    for (let i = 0; i < 8; i++) {
      fire(p, [t]);
      for (let k = 0; k < 40; k++) p.updateTimers(1 / 60); // 跑完一次冷却
    }
    expect(p.currentWeapon.ammo).toBe(ammoBefore);
    expect(p.currentWeapon.magSize).toBe(magBefore);
    expect(p.currentWeapon.reloadTimer).toBe(0);
    expect(t.hits).toBe(8);
  });

  test('startReload 对近战是空操作', () => {
    const p = meleePlayer('salted_fish');
    p.startReload();
    expect(p.currentWeapon.reloadTimer).toBe(0);
  });

  test('挥砍时进入动画状态，计时结束后自动归零', () => {
    noCrit();
    const p = meleePlayer('wood_stick');
    expect(p.meleeSwingProgress).toBeNull();
    fire(p, [makeTarget(40, 0)]);
    const prog = p.meleeSwingProgress;
    expect(prog).not.toBeNull();
    expect(prog!).toBeGreaterThanOrEqual(0);
    expect(prog!).toBeLessThan(1);
    // 动画时长夹在 0.28~0.5 秒之间
    expect(p.meleeSwingDuration).toBeGreaterThanOrEqual(0.28);
    expect(p.meleeSwingDuration).toBeLessThanOrEqual(0.5);
    for (let i = 0; i < 60; i++) p.updateTimers(1 / 60);
    expect(p.meleeSwingProgress).toBeNull();
  });

  test('枪械不会进入挥砍状态（只有近战走这条分支）', () => {
    const p = new Player(getCharacter('wolfshade'));
    p.weapons = [createWeaponInstance('pulse_pistol', p.mods)];
    p.weaponIndex = 0;
    p.aimAngle = 0;
    const r = fire(p, [makeTarget(40, 0)]);
    expect(p.meleeSwingProgress).toBeNull();
    // 枪械走的是原来的弹丸分支，仍然正常出弹 + 扣弹药
    expect(r.spawned).toBe(1);
    expect(p.currentWeapon.ammo).toBe(p.currentWeapon.magSize - 1);
  });

  test('近战不产生任何弹丸', () => {
    noCrit();
    const p = meleePlayer('long_spear');
    const r = fire(p, [makeTarget(80, 0)]);
    expect(r.spawned).toBe(0);
  });

  test('不扣扳机时不会挥砍', () => {
    const p = meleePlayer('salted_fish');
    fire(p, [makeTarget(40, 0)], false);
    expect(p.meleeSwingProgress).toBeNull();
  });
});

// ---------------------------------------------------------------- 破坏障碍

describe('近战：可破坏障碍（需求 23）', () => {
  /** 跑一次完整挥砍并把 damageObstacles 收到的参数记下来。 */
  function fireRecording(p: Player, targets: FakeTarget[], firing = true): number[][] {
    const calls: number[][] = [];
    const ctx = swingCtx(p, targets, {
      damageObstacles: (x, y, angle, halfArc, range, damage) => calls.push([x, y, angle, halfArc, range, damage]),
    });
    if (firing) updateWeapon(ctx, true);
    updateWeapon(ctx, false);
    return calls;
  }

  test('挥砍时把扇形参数交给 damageObstacles（与命中敌人的判定同形）', () => {
    noCrit();
    const p = meleePlayer('salted_fish');
    const def = getWeaponDef('salted_fish');
    const calls = fireRecording(p, []);
    expect(calls.length).toBe(1);
    const [x, y, angle, halfArc, range, damage] = calls[0]!;
    expect(x).toBeCloseTo(p.x, 6);
    expect(y).toBeCloseTo(p.y, 6);
    expect(angle).toBeCloseTo(p.aimAngle, 6);
    expect(halfArc).toBeCloseTo(def.swingArc! * 0.5, 6);
    expect(range).toBeCloseTo(def.range * p.mods.rangeMul, 6);
    expect(damage).toBeCloseTo(def.damage * p.mods.damageMul, 6);
  });

  test('未扣扳机 / 冷却中都不会破坏障碍', () => {
    noCrit();
    const p = meleePlayer('spiked_mace'); // fireRate 0.8 → 冷却 1.25s
    expect(fireRecording(p, [], false).length).toBe(0);
    expect(fireRecording(p, []).length).toBe(1);
    expect(fireRecording(p, []).length).toBe(0);
  });

  test('枪械不触发 damageObstacles（只有近战走扇形破坏）', () => {
    const p = new Player(getCharacter('wolfshade'));
    p.weapons = [createWeaponInstance('pulse_pistol', p.mods)];
    p.weaponIndex = 0;
    p.aimAngle = 0;
    let called = 0;
    const ctx: WeaponFireContext = {
      player: p,
      room: {} as Room,
      ctx: makeDamageCtx(),
      projectiles: { spawn: () => undefined } as unknown as ProjectileSystem,
      targets: [],
      damageObstacles: () => {
        called += 1;
      },
      dt: 1 / 60,
      time: 0,
    };
    updateWeapon(ctx, true);
    expect(called).toBe(0);
  });
});

// ---------------------------------------------------------------- 蓄力（需求 30）

describe('近战：蓄力（需求 30）', () => {
  const DT = 1 / 60;

  test('点按（极短蓄力）伤害就是原伤害，不吃蓄力加成', () => {
    noCrit();
    const p = meleePlayer('spiked_mace'); // 狼牙棒单次伤害最高
    const t = makeTarget(40, 0);
    fire(p, [t]); // 默认 = 按下即松开 → 极短蓄力
    expect(t.taken).toBeCloseTo(getWeaponDef('spiked_mace').damage, 6);
  });

  test('满蓄力（按住 ≥ MELEE_CHARGE_TIME）释放 = 原伤害 × 2.5', () => {
    noCrit();
    const p = meleePlayer('spiked_mace');
    const t = makeTarget(40, 0);
    const ctx = swingCtx(p, [t]);
    for (let i = 0; i < 180; i++) updateWeapon(ctx, true); // 按住 3s（> 2.5s 封顶）
    updateWeapon(ctx, false); // 松开 → 重击
    expect(t.taken).toBeCloseTo(getWeaponDef('spiked_mace').damage * 2.5, 6);
  });

  test('半蓄力（按住 MELEE_CHARGE_TIME 的一半）≈ 原伤害 × 1.75', () => {
    noCrit();
    const p = meleePlayer('spiked_mace');
    const t = makeTarget(40, 0);
    const ctx = swingCtx(p, [t]);
    for (let i = 0; i < 75; i++) updateWeapon(ctx, true); // 1.25s = 2.5s 的一半
    updateWeapon(ctx, false);
    expect(t.taken).toBeCloseTo(getWeaponDef('spiked_mace').damage * 1.75, 6);
  });

  test('只有在"松开"那一刻才挥砍；按住期间不结算伤害', () => {
    noCrit();
    const p = meleePlayer('wood_stick');
    const t = makeTarget(40, 0);
    const ctx = swingCtx(p, [t]);
    for (let i = 0; i < 200; i++) {
      updateWeapon(ctx, true); // 全程按住，只蓄力
      expect(t.hits).toBe(0);
    }
    expect(p.meleeChargeRatio).toBe(1); // 已蓄满
    updateWeapon(ctx, false); // 松开 → 这一帧才打出去
    expect(t.hits).toBe(1);
  });

  test('蓄力过程中死亡会清空蓄力，不再释放', () => {
    const p = meleePlayer('wood_stick');
    const ctx = swingCtx(p, [makeTarget(40, 0)]);
    for (let i = 0; i < 30; i++) updateWeapon(ctx, true);
    expect(p.meleeChargeRatio).toBeGreaterThan(0);
    p.dead = true;
    updateWeapon(ctx, false); // 死亡后松开不应挥砍
    expect(p.meleeCharge).toBe(0);
  });
});

// ---------------------------------------------------------------- 打掉敌方光波（需求 30）

describe('近战：打掉敌方光波（需求 30）', () => {
  test('挥砍扇形内、非己方阵营的弹丸被清除', () => {
    const p = meleePlayer('wood_stick');
    const ps = new ProjectileSystem();
    ps.spawn({ kind: 'orb', team: 'enemy', x: p.x + 40, y: p.y, angle: 0, speed: 0, damage: 5, radius: 8, life: 3 });
    const ctx = swingCtx(p, [], { projectiles: ps });
    updateWeapon(ctx, true); // 按下蓄力
    updateWeapon(ctx, false); // 松开 → 挥砍 → 扇形内打掉光波
    const active: Projectile[] = [];
    ps.collect(active);
    expect(active.length).toBe(0);
  });

  test('友方（同阵营）弹丸不会被误清', () => {
    const p = meleePlayer('wood_stick');
    const ps = new ProjectileSystem();
    ps.spawn({ kind: 'orb', team: p.team, x: p.x + 40, y: p.y, angle: 0, speed: 0, damage: 5, radius: 8, life: 3 });
    const ctx = swingCtx(p, [], { projectiles: ps });
    updateWeapon(ctx, true);
    updateWeapon(ctx, false);
    const active: Projectile[] = [];
    ps.collect(active);
    expect(active.length).toBe(1);
    expect(active[0]!.team).toBe(p.team);
  });

  test('扇形外的敌方光波不会被打掉', () => {
    const p = meleePlayer('wood_stick'); // 朝 +X，扇形很宽但仍覆盖不到正上方
    const ps = new ProjectileSystem();
    ps.spawn({ kind: 'orb', team: 'enemy', x: p.x, y: p.y - 40, angle: 0, speed: 0, damage: 5, radius: 8, life: 3 });
    const ctx = swingCtx(p, [], { projectiles: ps });
    updateWeapon(ctx, true);
    updateWeapon(ctx, false);
    const active: Projectile[] = [];
    ps.collect(active);
    expect(active.length).toBe(1);
  });

  test('挥砍伤害敌人与打掉光波同时发生', () => {
    noCrit();
    const p = meleePlayer('wood_stick');
    const t = makeTarget(40, 0);
    const ps = new ProjectileSystem();
    ps.spawn({ kind: 'orb', team: 'enemy', x: p.x + 40, y: p.y, angle: 0, speed: 0, damage: 5, radius: 8, life: 3 });
    const ctx = swingCtx(p, [t], { projectiles: ps });
    updateWeapon(ctx, true);
    updateWeapon(ctx, false);
    expect(t.hits).toBe(1); // 敌人被打到
    const active: Projectile[] = [];
    ps.collect(active);
    expect(active.length).toBe(0); // 光波被打掉
  });
});

// ---------------------------------------------------------------- 蓄力全向（需求 31）

describe('近战：蓄力释放为 360° 全向（需求 31）', () => {
  /** 按住 holdFrames 帧蓄力后松开释放；extra 用来注入真实弹丸系统等。 */
  function chargeAndRelease(p: Player, targets: FakeTarget[], holdFrames: number, extra: Partial<WeaponFireContext> = {}): void {
    const ctx = swingCtx(p, targets, extra);
    for (let i = 0; i < holdFrames; i++) updateWeapon(ctx, true);
    updateWeapon(ctx, false);
  }

  test('点按轻挥仍是扇形：身后的敌人打不到', () => {
    noCrit();
    const p = meleePlayer('wood_stick');
    const front = makeTarget(40, 0);
    const back = makeTarget(-40, 0); // 正后方
    fire(p, [front, back]);
    expect(front.hits).toBe(1);
    expect(back.hits).toBe(0);
    expect(p.meleeSwingFullCircle).toBe(false);
  });

  test('蓄力释放是 360°：正后方（180°）的敌人也能打到', () => {
    noCrit();
    const p = meleePlayer('wood_stick');
    const front = makeTarget(40, 0);
    const back = makeTarget(-40, 0); // 正后方
    chargeAndRelease(p, [front, back], 10); // 按住约 0.17s > MIN_HOLD
    expect(front.hits).toBe(1);
    expect(back.hits).toBe(1); // 全向，背后也命中
    expect(p.meleeSwingFullCircle).toBe(true);
  });

  test('蓄力释放时整圈敌方光波都被清掉（含背后）', () => {
    const p = meleePlayer('wood_stick');
    const ps = new ProjectileSystem();
    ps.spawn({ kind: 'orb', team: 'enemy', x: p.x, y: p.y - 40, angle: 0, speed: 0, damage: 5, radius: 8, life: 3 }); // 背后（正上方）
    ps.spawn({ kind: 'orb', team: 'enemy', x: p.x + 40, y: p.y, angle: 0, speed: 0, damage: 5, radius: 8, life: 3 }); // 前方
    chargeAndRelease(p, [], 10, { projectiles: ps });
    const active: Projectile[] = [];
    ps.collect(active);
    expect(active.length).toBe(0); // 整圈清掉
  });

  test('蓄力释放时木箱破坏也覆盖整圈（halfArc = π）', () => {
    noCrit();
    const p = meleePlayer('wood_stick');
    const calls: number[][] = [];
    const ctx: WeaponFireContext = swingCtx(p, [], {
      damageObstacles: (x, y, angle, halfArc, range, damage) => calls.push([x, y, angle, halfArc, range, damage]),
    });
    for (let i = 0; i < 10; i++) updateWeapon(ctx, true);
    updateWeapon(ctx, false);
    expect(calls.length).toBe(1);
    expect(calls[0]![3]).toBeCloseTo(Math.PI, 6); // halfArc = π 表示全向
  });
});
