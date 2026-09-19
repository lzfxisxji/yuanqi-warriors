/**
 * Roguelike 强化系统。
 * 强化只修改一个纯数据对象 Mods，玩家属性每帧从 Mods 推导，因此强化之间可以自由组合成不同 Build。
 */

export interface Mods {
  maxHpAdd: number;
  maxHpMul: number;
  speedMul: number;
  fireRateMul: number;
  damageMul: number;
  critAdd: number;
  pierceAdd: number;
  bounceAdd: number;
  /** 每次击杀回复生命 */
  lifesteal: number;
  /** 脱战（最后一次受伤后 2 秒）之后每秒回复的生命 */
  healthRegen: number;
  shieldAdd: number;
  /** 护盾每秒回复（与生命回复共用同一套脱战判定） */
  shieldRegen: number;
  skillCdMul: number;
  reloadMul: number;
  magMul: number;
  /** 额外弹丸数 */
  multishotAdd: number;
  goldMul: number;
  dodgeAdd: number;
  rangeMul: number;
  /** 受击反弹给接触者的伤害 */
  thorns: number;
}

export function defaultMods(): Mods {
  return {
    maxHpAdd: 0,
    maxHpMul: 1,
    speedMul: 1,
    fireRateMul: 1,
    damageMul: 1,
    critAdd: 0,
    pierceAdd: 0,
    bounceAdd: 0,
    lifesteal: 0,
    healthRegen: 0,
    shieldAdd: 0,
    shieldRegen: 0,
    skillCdMul: 1,
    reloadMul: 1,
    magMul: 1,
    multishotAdd: 0,
    goldMul: 1,
    dodgeAdd: 0,
    rangeMul: 1,
    thorns: 0,
  };
}

export type UpgradeIcon =
  | 'heart'
  | 'boot'
  | 'trigger'
  | 'bullet'
  | 'crit'
  | 'pierce'
  | 'bounce'
  | 'reap'
  | 'regen'
  | 'shield'
  | 'cool'
  | 'reload'
  | 'mag'
  | 'double'
  | 'coin'
  | 'range'
  | 'thorns';

export interface UpgradeDef {
  id: string;
  name: string;
  /** 单次叠加的效果文案 */
  perStack: string;
  maxStacks: number;
  weight: number;
  icon: UpgradeIcon;
  /** 每获得一层调用一次 */
  apply: (m: Mods) => void;
}

export const UPGRADES: UpgradeDef[] = [
  {
    id: 'heart',
    name: '生命刻痕',
    perStack: '生命上限 +22 并立即回复 22 点',
    maxStacks: 6,
    weight: 10,
    icon: 'heart',
    apply: (m) => {
      m.maxHpAdd += 22;
    },
  },
  {
    id: 'boot',
    name: '疾行靴',
    perStack: '移动速度 +12%',
    maxStacks: 4,
    weight: 9,
    icon: 'boot',
    apply: (m) => {
      m.speedMul *= 1.12;
    },
  },
  {
    id: 'trigger',
    name: '快速扳机',
    perStack: '射速 +15%',
    maxStacks: 5,
    weight: 10,
    icon: 'trigger',
    apply: (m) => {
      m.fireRateMul *= 1.15;
    },
  },
  {
    id: 'bullet',
    name: '锐化弹头',
    perStack: '子弹伤害 +18%',
    maxStacks: 6,
    weight: 10,
    icon: 'bullet',
    apply: (m) => {
      m.damageMul *= 1.18;
    },
  },
  {
    id: 'crit',
    name: '致命精准',
    perStack: '暴击率 +8%（暴击造成 2 倍伤害）',
    maxStacks: 5,
    weight: 8,
    icon: 'crit',
    apply: (m) => {
      m.critAdd += 0.08;
    },
  },
  {
    id: 'pierce',
    name: '贯穿弹',
    perStack: '子弹额外贯穿 1 个敌人',
    maxStacks: 3,
    weight: 7,
    icon: 'pierce',
    apply: (m) => {
      m.pierceAdd += 1;
    },
  },
  {
    id: 'bounce',
    name: '跳弹',
    perStack: '子弹额外弹射 1 次',
    maxStacks: 3,
    weight: 6,
    icon: 'bounce',
    apply: (m) => {
      m.bounceAdd += 1;
    },
  },
  {
    id: 'reap',
    name: '收割',
    perStack: '每次击杀回复 2 点生命',
    maxStacks: 5,
    weight: 8,
    icon: 'reap',
    apply: (m) => {
      m.lifesteal += 2;
    },
  },
  {
    id: 'shield',
    name: '能量护盾',
    perStack: '护盾上限 +30，脱战 2 秒后每秒回 3 点护盾',
    maxStacks: 4,
    weight: 7,
    icon: 'shield',
    apply: (m) => {
      m.shieldAdd += 30;
      m.shieldRegen += 3;
    },
  },
  {
    id: 'regen',
    name: '再生脉络',
    perStack: '脱战 2 秒后，每秒回复 2 点生命',
    maxStacks: 5,
    weight: 8,
    icon: 'regen',
    apply: (m) => {
      m.healthRegen += 2;
    },
  },
  {
    id: 'cool',
    name: '冷却核心',
    perStack: '技能冷却 -20%',
    maxStacks: 3,
    weight: 7,
    icon: 'cool',
    apply: (m) => {
      m.skillCdMul *= 0.8;
    },
  },
  {
    id: 'reload',
    name: '快速换弹',
    perStack: '换弹时间 -25%',
    maxStacks: 3,
    weight: 8,
    icon: 'reload',
    apply: (m) => {
      m.reloadMul *= 0.75;
    },
  },
  {
    id: 'mag',
    name: '弹匣扩容',
    perStack: '弹匣容量 +30%',
    maxStacks: 3,
    weight: 8,
    icon: 'mag',
    apply: (m) => {
      m.magMul *= 1.3;
    },
  },
  {
    id: 'double',
    name: '双管',
    perStack: '每次击发额外射出 1 颗子弹（散布略增）',
    maxStacks: 3,
    weight: 5,
    icon: 'double',
    apply: (m) => {
      m.multishotAdd += 1;
    },
  },
  {
    id: 'coin',
    name: '贪婪之心',
    perStack: '金币收益 +30%',
    maxStacks: 3,
    weight: 7,
    icon: 'coin',
    apply: (m) => {
      m.goldMul *= 1.3;
    },
  },
  {
    id: 'range',
    name: '猎手膛线',
    perStack: '射程 +22%，弹速 +8%',
    maxStacks: 3,
    weight: 7,
    icon: 'range',
    apply: (m) => {
      m.rangeMul *= 1.22;
    },
  },
  {
    id: 'thorns',
    name: '荆棘护甲',
    perStack: '被近身攻击时反弹 9 点伤害',
    maxStacks: 3,
    weight: 6,
    icon: 'thorns',
    apply: (m) => {
      m.thorns += 9;
    },
  },
];

export function getUpgrade(id: string): UpgradeDef | undefined {
  return UPGRADES.find((u) => u.id === id);
}

export interface UpgradeStack {
  id: string;
  stacks: number;
}

/** 汇总强化 → Mods。同一强化按层数重复 apply，天然支持组合与叠加。 */
export function computeMods(stacks: readonly UpgradeStack[]): Mods {
  const m = defaultMods();
  for (const s of stacks) {
    const def = getUpgrade(s.id);
    if (!def) continue;
    const n = Math.min(s.stacks, def.maxStacks);
    for (let i = 0; i < n; i++) def.apply(m);
  }
  return m;
}

export function addUpgrade(stacks: UpgradeStack[], id: string): UpgradeStack[] {
  const def = getUpgrade(id);
  if (!def) return stacks;
  const existing = stacks.find((s) => s.id === id);
  if (existing) {
    if (existing.stacks < def.maxStacks) existing.stacks += 1;
    return stacks;
  }
  stacks.push({ id, stacks: 1 });
  return stacks;
}

export function stacksOf(stacks: readonly UpgradeStack[], id: string): number {
  return stacks.find((s) => s.id === id)?.stacks ?? 0;
}

/** 随机抽取 count 个不重复、未满层的强化。 */
export function rollUpgradeChoices(
  stacks: readonly UpgradeStack[],
  count: number,
  pickWeighted: (weights: number[]) => number,
): string[] {
  const available = UPGRADES.filter((u) => stacksOf(stacks, u.id) < u.maxStacks);
  const chosen: string[] = [];
  const pool = available.slice();
  while (chosen.length < count && pool.length) {
    const weights = pool.map((u) => u.weight);
    const idx = pickWeighted(weights);
    chosen.push(pool[idx]!.id);
    pool.splice(idx, 1);
  }
  return chosen;
}

/** 汇总一条强化的展示文本。 */
export function upgradeSummary(stacks: readonly UpgradeStack[], id: string): string {
  const def = getUpgrade(id);
  if (!def) return '';
  const n = stacksOf(stacks, id);
  return n > 0 ? `${def.name} Lv.${n}/${def.maxStacks}` : def.name;
}
