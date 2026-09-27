/**
 * 锻造系统（需求 38）：用金币 / 钻石强化武器，每级提升**该武器**的伤害。
 *
 * 强化等级按武器 id 持久化在 `SaveData.forge` 中，跨局生效；
 * 进入远征时由 `RunState` 注入到 `Player.forgeLevels`，局内武器伤害据此换算。
 *
 * 数值（用户授权自定）：满级 12 级、每级 +6% 伤害（满级 +72%）；
 * 强化花费二选一 —— 金币随等级指数增长（长线养成），钻石线性且数量小（稀有货币，用来"跳"长线）。
 */
import { WEAPONS } from './weapons';

/** 单把武器最高锻造等级。 */
export const FORGE_MAX_LEVEL = 12;

/** 每级提升的伤害比例（+6% / 级，满级 +72%）。 */
export const FORGE_BONUS_PER_LEVEL = 0.06;

const WEAPON_IDS = new Set(WEAPONS.map((w) => w.id));

/** 取某武器的当前锻造等级（缺省 0，且夹取 0..FORGE_MAX_LEVEL）。 */
export function forgeLevel(forge: Record<string, number>, id: string): number {
  const v = Math.floor(forge[id] ?? 0);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(FORGE_MAX_LEVEL, v));
}

/** 锻造等级 → 伤害倍率（0 级 = 1.0，满级 = 1 + 12 × 0.06 = 1.72）。 */
export function forgeDamageMul(level: number): number {
  return 1 + Math.max(0, level) * FORGE_BONUS_PER_LEVEL;
}

/**
 * 将某武器从 `level` 锻到 `level+1` 的花费（二选一：金币 或 钻石）。
 * @param level 武器**当前**等级（即"要买下一发"的前置等级）。
 */
export function forgeCost(level: number): { coins: number; diamonds: number } {
  const coins = Math.round(60 * Math.pow(1.3, level));
  const diamonds = 3 + Math.max(0, level);
  return { coins, diamonds };
}

/** 校验一份 forge 存档：只保留已知武器 id，层级夹取 0..FORGE_MAX_LEVEL（旧档/脏数据回落 {}）。 */
export function parseForge(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!WEAPON_IDS.has(k)) continue;
      const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
      out[k] = Math.max(0, Math.min(FORGE_MAX_LEVEL, n));
    }
  }
  return out;
}
