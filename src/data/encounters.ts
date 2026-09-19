/** 房间遭遇战编排：按房间类型与楼层生成波次。 */
import type { RNG } from '../core/math';
import { NORMAL_ENEMIES, ELITE_ENEMIES, getEnemyDef } from './enemies';

export interface WaveGroup {
  id: string;
  count: number;
}

export interface Wave {
  groups: WaveGroup[];
}

function pickNormalId(rng: RNG, floor: number, allowTier2: boolean): string {
  const pool = NORMAL_ENEMIES.filter((e) => (allowTier2 ? true : e.tier === 1));
  const list = pool.length ? pool : NORMAL_ENEMIES;
  const weights = list.map((e) => (e.tier === 1 ? 10 : 5));
  return list[rng.weightedIndex(weights)]!.id;
}

/** 生成普通战斗房的波次。 */
export function buildCombatWaves(rng: RNG, floor: number): Wave[] {
  const allowTier2 = floor >= 1;
  const waveCount = rng.chance(floor >= 2 ? 0.42 : 0.28) ? 2 : 1;
  const waves: Wave[] = [];
  for (let w = 0; w < waveCount; w++) {
    const total = 3 + floor + rng.int(0, 2);
    const groups: WaveGroup[] = [];
    let remaining = total;
    let guard = 0;
    while (remaining > 0 && guard < 12) {
      guard++;
      const id = pickNormalId(rng, floor, allowTier2);
      const def = getEnemyDef(id);
      const maxPerGroup = def.radius > 18 ? 2 : 4;
      const n = Math.min(remaining, rng.int(1, maxPerGroup));
      groups.push({ id, count: n });
      remaining -= n;
    }
    waves.push({ groups });
  }
  return waves;
}

/** 生成精英房波次：1 名精英 + 随从。 */
export function buildEliteWaves(rng: RNG, floor: number): Wave[] {
  const eliteId = rng.pick(ELITE_ENEMIES).id;
  const escort: WaveGroup[] = [];
  const escortTotal = 2 + rng.int(0, 2);
  for (let i = 0; i < escortTotal; i++) {
    const id = pickNormalId(rng, floor, true);
    const found = escort.find((g) => g.id === id);
    if (found) found.count += 1;
    else escort.push({ id, count: 1 });
  }
  const waves: Wave[] = [{ groups: [{ id: eliteId, count: 1 }, ...escort] }];
  if (floor >= 2 && rng.chance(0.5)) {
    const extra: WaveGroup[] = [];
    const total = 3 + rng.int(0, 2);
    for (let i = 0; i < total; i++) {
      const id = pickNormalId(rng, floor, true);
      const found = extra.find((g) => g.id === id);
      if (found) found.count += 1;
      else extra.push({ id, count: 1 });
    }
    waves.push({ groups: extra });
  }
  return waves;
}

export function waveEnemyCount(wave: Wave): number {
  return wave.groups.reduce((s, g) => s + g.count, 0);
}

/** 商店价格表。 */
export const SHOP_PRICES = {
  weapon: 68,
  upgrade: 55,
  heal: 30,
  ammo: 18,
  shield: 32,
  /** 首领房入口的「战前补给站」 */
  prepHeal: 40,
  prepMag: 60,
  prepAmmo: 20,
  prepShield: 45,
} as const;
