import { describe, expect, test } from 'vitest';
import { RNG } from '../src/core/math';
import { CRATE_WEAPON_DROP_CHANCE } from '../src/data/config';
import { rollCrateWeapon, WEAPONS } from '../src/data/weapons';

describe('木箱武器掉落（需求 36）', () => {
  test('训练营不掉落武器', () => {
    const rng = new RNG(1);
    expect(rollCrateWeapon(rng, [], true, CRATE_WEAPON_DROP_CHANCE)).toBeNull();
  });

  test('概率命中（chance=1）掉落一把已定义的武器', () => {
    const rng = new RNG(7);
    const id = rollCrateWeapon(rng, [], false, 1);
    expect(id).not.toBeNull();
    expect(WEAPONS.some((w) => w.id === id)).toBe(true);
  });

  test('概率未命中（chance=0）不掉落', () => {
    const rng = new RNG(7);
    expect(rollCrateWeapon(rng, [], false, 0)).toBeNull();
  });

  test('已持有的武器不会重复掉落（排除 ownedIds）', () => {
    const rng = new RNG(3);
    const owned = WEAPONS.slice(0, WEAPONS.length - 1).map((w) => w.id);
    const last = WEAPONS[WEAPONS.length - 1]!.id;
    for (let i = 0; i < 20; i++) {
      expect(rollCrateWeapon(rng, owned, false, 1)).toBe(last);
    }
  });

  test('配置常量 CRATE_WEAPON_DROP_CHANCE 为 0.10（需求指定概率）', () => {
    expect(CRATE_WEAPON_DROP_CHANCE).toBe(0.1);
  });
});
