/**
 * 天赋系统（需求 37）。
 *
 * 天赋是**账户级、跨局持久化**的被动加成：玩家在主菜单「天赋」页把天赋点分配到各天赋，
 * 开新局时这些加成就叠到玩家的初始属性 / 强化（`Mods`）之上。
 *
 * 设计要点：
 * - 天赋只改一个纯数据对象 `Mods`（与 Roguelike 强化共用同一套派生属性机制），
 *   因此和局内捡到的强化可以自由叠加成不同 Build。
 * - 天赋是「独立层」：run 在 `computeMods(upgrades)` 之上再 `applyTalents`，
 *   所以每捡一次强化、每进一层都不会把天赋洗掉（若直接写进 base mods 就会被 recompute 覆盖）。
 * - 「初始生命 / 初始护盾 / 初始移速」是用户明确点名的三项；其余五项由本文件自选。
 */

import type { Mods } from './upgrades';

export interface TalentDef {
  id: string;
  name: string;
  desc: string;
  /** 每级效果的描述文本（UI 展示用）。 */
  perLevel: string;
  maxLevel: number;
  /** UI 用的主题色（画天赋图标 / 等级点）。 */
  color: string;
  /** 把 level 级效果叠加进 mods（mutate），用于生命/护盾/移速/暴击等 Mods 字段。 */
  apply: (mods: Mods, level: number) => void;
  /** 可选：进入新局时一次性加给 run.gold 的初始金币（不在 Mods 里）。 */
  startGold?: (level: number) => number;
}

/**
 * 8 项天赋：前 3 项是用户点名的「初始生命 / 初始护盾 / 初始移速」，
 * 后 5 项是自选的额外被动。数值为每级效果，maxLevel 控制上限。
 */
export const TALENTS: readonly TalentDef[] = [
  {
    id: 'vitality',
    name: '生命强化',
    desc: '提升初始最大生命',
    perLevel: '+25 最大生命',
    maxLevel: 5,
    color: '#ff5a6e',
    apply: (m, l) => {
      m.maxHpAdd += 25 * l;
    },
  },
  {
    id: 'barrier',
    name: '护盾强化',
    desc: '提升初始护盾',
    perLevel: '+15 护盾',
    maxLevel: 5,
    color: '#5ab0ff',
    apply: (m, l) => {
      m.shieldAdd += 15 * l;
    },
  },
  {
    id: 'swiftness',
    name: '疾风步',
    desc: '提升初始移动速度',
    perLevel: '+5% 移速',
    maxLevel: 5,
    color: '#7ef2c0',
    apply: (m, l) => {
      m.speedMul *= 1 + 0.05 * l;
    },
  },
  {
    id: 'fortune',
    name: '财运亨通',
    desc: '开局获得额外金币',
    perLevel: '+60 初始金币',
    maxLevel: 5,
    color: '#ffd479',
    apply: () => {
      /* 金币走 startGold，不进 Mods */
    },
    startGold: (l) => 60 * l,
  },
  {
    id: 'precision',
    name: '精准打击',
    desc: '提升暴击率',
    perLevel: '+3% 暴击',
    maxLevel: 5,
    color: '#c89bff',
    apply: (m, l) => {
      m.critAdd += 0.03 * l;
    },
  },
  {
    id: 'pierce',
    name: '穿透强化',
    desc: '子弹可多穿透一名敌人',
    perLevel: '+1 穿透',
    maxLevel: 3,
    color: '#ff9f5a',
    apply: (m, l) => {
      m.pierceAdd += l;
    },
  },
  {
    id: 'recovery',
    name: '生命再生',
    desc: '脱战（最后一次受伤 2 秒后）回复生命',
    perLevel: '+1 生命/秒',
    maxLevel: 5,
    color: '#8affb0',
    apply: (m, l) => {
      m.healthRegen += l;
    },
  },
  {
    id: 'multishot',
    name: '多重射击',
    desc: '每次射击额外发射弹丸',
    perLevel: '+1 弹丸',
    maxLevel: 3,
    color: '#ff7ae0',
    apply: (m, l) => {
      m.multishotAdd += l;
    },
  },
];

export function defaultTalents(): Record<string, number> {
  return {};
}

/** 把任意值夹成 0..maxLevel 的整数（脏数据 / 非有限值归 0）。 */
export function clampLevel(v: unknown, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.floor(n)));
}

/** 已投入的天赋点总数（用于和预算上限比较）。 */
export function talentSpent(talents: Record<string, number>): number {
  let total = 0;
  for (const t of TALENTS) total += clampLevel(talents[t.id], t.maxLevel);
  return total;
}

/** 单天赋当前层级（夹取后）。 */
export function talentLevel(talents: Record<string, number>, id: string): number {
  const def = TALENTS.find((t) => t.id === id);
  if (!def) return 0;
  return clampLevel(talents[id], def.maxLevel);
}

/**
 * 把天赋效果叠加到一份基础 mods 上（mutate 并返回）。
 * 调用方负责传「基础 mods」（默认空强化 或 computeMods 结果），天赋只做加法。
 */
export function applyTalents(base: Mods, talents: Record<string, number>): Mods {
  for (const t of TALENTS) {
    const lvl = talentLevel(talents, t.id);
    if (lvl > 0) t.apply(base, lvl);
  }
  return base;
}

/** 天赋提供的初始金币（进入新局时一次性加给 run.gold）。 */
export function talentStartGold(talents: Record<string, number>): number {
  let gold = 0;
  for (const t of TALENTS) {
    const lvl = talentLevel(talents, t.id);
    if (lvl > 0 && t.startGold) gold += t.startGold(lvl);
  }
  return gold;
}

// ------------------------------------------------------------- 天赋点预算

/** 初始天赋点：足够在前几层把核心天赋点几级。 */
export const TALENT_BASE_POINTS = 8;
/** 每打通一层（基于历史最佳层数）额外获得的天赋点。 */
export const TALENT_POINTS_PER_FLOOR = 1;

/** 天赋点总量上限：基础 + 随历史最佳层数增长，奖励越打越深。 */
export function talentPointCap(bestFloor: number): number {
  const floors = Number.isFinite(bestFloor) ? (bestFloor as number) : 1;
  return TALENT_BASE_POINTS + Math.max(0, floors - 1) * TALENT_POINTS_PER_FLOOR;
}
