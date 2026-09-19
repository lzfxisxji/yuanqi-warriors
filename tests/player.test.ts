import { describe, expect, test } from 'vitest';
import { Player, createWeaponInstance } from '../src/entities/player';
import { getCharacter } from '../src/data/characters';
import { defaultMods } from '../src/data/upgrades';
import { defaultHitOptions } from '../src/systems/combat';

const wolf = () => getCharacter('wolfshade');
const sting = () => getCharacter('sting');
const bulwark = () => getCharacter('bulwark');

const hit = (over: Partial<ReturnType<typeof defaultHitOptions>> = {}) => defaultHitOptions(over);

/**
 * 关掉闪避，让伤害断言变确定。
 * 角色自带基础闪避率且 applyDamage 用 Math.random() 判定，
 * 不关掉的话这些测试会以百分之几的概率偶发失败。
 */
const noDodge = (p: Player): Player => {
  p.mods = { ...p.mods, dodgeAdd: -10 };
  return p;
};

describe('玩家：基础状态', () => {
  test('初始血量、护盾与武器槽正确', () => {
    const p = new Player(wolf());
    expect(p.hp).toBe(p.maxHp);
    expect(p.maxHp).toBe(wolf().maxHp);
    expect(p.shield).toBe(wolf().startShield);
    expect(p.maxShield).toBe(wolf().maxShield);
    expect(p.weapons.length).toBe(1);
    expect(p.currentWeapon.def.id).toBe(wolf().startWeapon);
    expect(p.currentWeapon.ammo).toBe(p.currentWeapon.magSize);
    expect(p.team).toBe('player');
    expect(p.dead).toBe(false);
  });

  test('三名角色在速度与血量上确实不同', () => {
    const a = new Player(wolf());
    const b = new Player(sting());
    const c = new Player(bulwark());
    expect(b.speed).toBeGreaterThan(a.speed);
    expect(a.speed).toBeGreaterThan(c.speed);
    expect(c.maxHp).toBeGreaterThan(a.maxHp);
    expect(a.maxHp).toBeGreaterThan(b.maxHp);
  });
});

describe('玩家：伤害与防御', () => {
  test('护盾先于生命承伤', () => {
    const p = noDodge(new Player(wolf()));
    p.addShield(30);
    const r = p.applyDamage(20, hit());
    expect(r.blocked).toBe(false);
    expect(p.shield).toBe(10);
    expect(p.hp).toBe(p.maxHp);

    p.applyDamage(40, hit());
    // 10 点由护盾吸收，其余 30 点进生命
    expect(p.shield).toBe(0);
    expect(p.hp).toBe(p.maxHp - 30);
  });

  test('壁垒（技能护盾）优先于普通护盾', () => {
    const p = noDodge(new Player(bulwark()));
    p.useSkill();
    expect(p.barrier).toBeGreaterThan(0);
    const barrier = p.barrier;
    const hpBefore = p.hp;
    p.applyDamage(20, hit());
    expect(p.barrier).toBe(barrier - 20);
    expect(p.hp).toBe(hpBefore);
  });

  test('无敌帧内伤害被完全格挡', () => {
    const p = new Player(wolf());
    p.iframe = 0.5;
    const r = p.applyDamage(50, hit());
    expect(r.blocked).toBe(true);
    expect(r.applied).toBe(0);
    expect(p.hp).toBe(p.maxHp);
  });

  test('冲刺技能期间免疫伤害', () => {
    const p = new Player(wolf());
    expect(p.useSkill()).toBe(true);
    expect(p.dashTimer).toBeGreaterThan(0);
    expect(p.invulnerable).toBe(true);
    const r = p.applyDamage(80, hit());
    expect(r.blocked).toBe(true);
    expect(p.hp).toBe(p.maxHp);
  });

  test('闪避率被夹取在 0..0.85', () => {
    const p = new Player(wolf());
    expect(p.dodgeChance).toBeGreaterThanOrEqual(0);
    p.mods = { ...defaultMods(), dodgeAdd: 5 };
    expect(p.dodgeChance).toBeCloseTo(0.85, 6);
    p.mods = { ...defaultMods(), dodgeAdd: -10 };
    expect(p.dodgeChance).toBe(0);
  });

  test('超载技能提升速度与闪避', () => {
    const p = new Player(sting());
    const baseSpeed = p.speed;
    const baseDodge = p.dodgeChance;
    p.useSkill();
    expect(p.speed).toBeGreaterThan(baseSpeed);
    expect(p.dodgeChance).toBeGreaterThan(baseDodge);
  });

  test('血量归零后进入死亡状态且不再受伤', () => {
    const p = noDodge(new Player(sting()));
    p.applyDamage(9999, hit());
    expect(p.dead).toBe(true);
    expect(p.hp).toBe(0);
    expect(p.state).toBe('dead');
    const before = p.hp;
    const r = p.applyDamage(50, hit());
    expect(r.blocked).toBe(true);
    expect(p.hp).toBe(before);
  });

  test('治疗不会超过生命上限', () => {
    const p = new Player(wolf());
    p.applyDamage(40, hit());
    p.heal(9999);
    expect(p.hp).toBe(p.maxHp);
  });

  test('生命上限提升会同步增长当前生命', () => {
    const p = new Player(wolf());
    const before = p.maxHp;
    p.addMaxHp(30);
    expect(p.maxHp).toBe(before + 30);
    expect(p.hp).toBeGreaterThan(before - 1);
  });
});

describe('玩家：脱战回复', () => {
  /** 推进 n 帧（1/60 秒一帧）。 */
  const tick = (p: Player, frames: number): void => {
    for (let i = 0; i < frames; i++) p.updateTimers(1 / 60);
  };

  test('受伤后 2 秒内不回血，跨过阈值才开始回复', () => {
    const p = noDodge(new Player(wolf()));
    p.mods = { ...p.mods, healthRegen: 12 };
    p.applyDamage(60, hit());
    const hurt = p.hp;
    expect(hurt).toBeLessThan(p.maxHp);

    // 0 → 1.9 秒：仍在脱战计时内
    tick(p, 114);
    expect(p.hp).toBeCloseTo(hurt, 5);
    expect(p.regening).toBe(false);
    expect(p.outOfCombat).toBe(false);

    // 跨过 2 秒后开始每秒 12 点地回血
    tick(p, 12);
    expect(p.outOfCombat).toBe(true);
    expect(p.regening).toBe(true);
    expect(p.hp).toBeGreaterThan(hurt);
  });

  test('回血不会超过上限，满血时不再触发', () => {
    const p = noDodge(new Player(wolf()));
    p.mods = { ...p.mods, healthRegen: 999 };
    p.hp = p.maxHp - 10;
    p.timeSinceDamage = 5;
    tick(p, 60);
    expect(p.hp).toBe(p.maxHp);
    // 满血后即使已脱战也不算「正在回血」
    expect(p.regening).toBe(false);
  });

  test('再次受伤会立刻打断回血', () => {
    const p = noDodge(new Player(bulwark()));
    p.mods = { ...p.mods, healthRegen: 12 };
    p.shield = 0;
    p.hp = p.maxHp - 40;
    p.timeSinceDamage = 5;
    tick(p, 30);
    expect(p.regening).toBe(true);

    p.applyDamage(10, hit());
    const after = p.hp;
    tick(p, 30);
    expect(p.hp).toBeCloseTo(after, 5);
    expect(p.regening).toBe(false);
    expect(p.outOfCombat).toBe(false);
  });

  test('护盾回复共用同一套脱战判定（2 秒）', () => {
    const p = noDodge(new Player(bulwark()));
    p.mods = { ...p.mods, shieldRegen: 6 };
    p.maxShield = 100;
    p.shield = 20;

    p.timeSinceDamage = 1.5;
    tick(p, 1);
    expect(p.shield).toBe(20);

    p.timeSinceDamage = 2.5;
    tick(p, 60);
    expect(p.shield).toBeGreaterThan(20);
  });
});

describe('玩家：武器与射击', () => {
  test('击发消耗弹药并进入冷却', () => {
    const p = new Player(wolf());
    const w = p.currentWeapon;
    const rate = w.def.fireRate;
    expect(p.canFire()).toBe(true);
    p.consumeShot();
    expect(w.ammo).toBe(w.magSize - 1);
    expect(w.cooldown).toBeCloseTo(1 / rate, 6);
    expect(p.canFire()).toBe(false);
  });

  test('弹匣打空会自动换弹，换弹完成后补满', () => {
    const p = new Player(wolf());
    const w = p.currentWeapon;
    for (let i = 0; i < w.magSize; i++) {
      w.cooldown = 0;
      p.consumeShot();
    }
    expect(w.ammo).toBe(0);
    expect(w.reloadTimer).toBeGreaterThan(0);
    expect(p.canFire()).toBe(false);

    p.updateTimers(w.def.reloadTime + 0.05);
    expect(w.reloadTimer).toBe(0);
    expect(w.ammo).toBe(w.magSize);
    expect(p.canFire()).toBe(true);
  });

  test('手动换弹在满弹时被拒绝', () => {
    const p = new Player(wolf());
    p.startReload();
    expect(p.currentWeapon.reloadTimer).toBe(0);
  });

  test('第二把武器进入副槽，第三把替换当前武器', () => {
    const p = new Player(wolf());
    p.addOrReplaceWeapon('shotgun');
    expect(p.weapons.length).toBe(2);
    expect(p.currentWeapon.def.id).toBe('shotgun');
    p.addOrReplaceWeapon('sniper');
    expect(p.weapons.length).toBe(2);
    expect(p.currentWeapon.def.id).toBe('sniper');
    expect(p.weapons[0]!.def.id).toBe(wolf().startWeapon);
  });

  test('数字键切枪生效，切换到同一槽位无效', () => {
    const p = new Player(wolf());
    p.addOrReplaceWeapon('smg');
    expect(p.weaponIndex).toBe(1);
    expect(p.swapWeapon(1)).toBe(false);
    expect(p.swapWeapon(0)).toBe(true);
    expect(p.weaponIndex).toBe(0);
    expect(p.swapWeapon(9)).toBe(false);
  });

  test('强化会放大弹匣容量（已有的枪同步扩容）', () => {
    const p = new Player(wolf());
    const base = p.currentWeapon.magSize;
    const mods = { ...defaultMods(), magMul: 2 };
    p.refreshFromMods(mods);
    expect(p.currentWeapon.magSize).toBe(Math.round(base * 2));
  });

  test('createWeaponInstance 依据 Mods 计算弹匣', () => {
    const inst = createWeaponInstance('shotgun', { ...defaultMods(), magMul: 2 });
    expect(inst.magSize).toBe(12);
    expect(inst.ammo).toBe(12);
    expect(inst.cooldown).toBe(0);
  });

  test('固定刷新把生命上限与护盾上限同步到 Mods', () => {
    const p = new Player(wolf());
    const before = p.maxShield;
    p.refreshFromMods({ ...defaultMods(), shieldAdd: 45, maxHpAdd: 60 });
    expect(p.maxShield).toBe(before + 45);
    expect(p.maxHp).toBe(wolf().maxHp + 60);
    // 生命比例被保留
    expect(p.hp).toBeGreaterThan(0);
  });
});

describe('玩家：技能冷却', () => {
  test('技能冷却期间无法再次释放', () => {
    const p = new Player(wolf());
    expect(p.useSkill()).toBe(true);
    expect(p.useSkill()).toBe(false);
    p.updateTimers(wolf().skill.cooldown + 0.05);
    expect(p.skillCooldown).toBe(0);
    expect(p.useSkill()).toBe(true);
  });

  test('冷却核心强化会缩短技能冷却', () => {
    const p = new Player(bulwark());
    p.refreshFromMods({ ...defaultMods(), skillCdMul: 0.5 });
    p.useSkill();
    expect(p.skillCooldown).toBeCloseTo(bulwark().skill.cooldown * 0.5, 6);
  });

  test('技能进度条百分比在 0..1 之间', () => {
    const p = new Player(wolf());
    expect(p.skillReadyPercent).toBe(1);
    p.useSkill();
    expect(p.skillReadyPercent).toBeGreaterThanOrEqual(0);
    expect(p.skillReadyPercent).toBeLessThan(1);
    expect(p.skillActivePercent).toBeGreaterThan(0);
    expect(p.skillActivePercent).toBeLessThanOrEqual(1);
  });
});
