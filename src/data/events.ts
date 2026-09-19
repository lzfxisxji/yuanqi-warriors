/** 事件房模板。每个事件提供 2-3 个选项，选项有代价与收益。 */

export type EventEffect =
  | { kind: 'upgrade'; count: number }
  | { kind: 'weapon' }
  | { kind: 'heal'; amount: number }
  | { kind: 'healFull' }
  | { kind: 'gold'; amount: number }
  | { kind: 'goldRoll'; cost: number; mul: number; chance: number }
  | { kind: 'shield'; amount: number }
  | { kind: 'maxHp'; amount: number }
  | { kind: 'damage'; amount: number }
  | { kind: 'nothing' };

export interface EventOption {
  label: string;
  detail: string;
  /** 需要消耗的资源 */
  cost?: { gold?: number; hp?: number };
  /** 不满足条件时的禁用提示 */
  requiresGold?: number;
  effect: EventEffect;
}

export interface EventDef {
  id: string;
  title: string;
  body: string;
  options: EventOption[];
}

export const EVENTS: EventDef[] = [
  {
    id: 'sacrifice_altar',
    title: '献祭石台',
    body: '一座干涸的石台，凹槽里凝着暗色的痕迹。台面浮着两行刻痕：「以血换力，以力换血。」',
    options: [
      {
        label: '割开手掌，按上石台',
        detail: '失去 20 点生命，获得一次强化选择与一把随机武器',
        cost: { hp: 20 },
        effect: { kind: 'upgrade', count: 1 },
      },
      {
        label: '撬走供品',
        detail: '获得 45 金币',
        effect: { kind: 'gold', amount: 45 },
      },
      {
        label: '转身离开',
        detail: '什么都不发生',
        effect: { kind: 'nothing' },
      },
    ],
  },
  {
    id: 'broken_armory',
    title: '破损的军械库',
    body: '半塌的武器架上还挂着几件装备，地上散落着被砸碎的枪管与一堆还能用的配件。',
    options: [
      {
        label: '撬开完好的那口箱体',
        detail: '花费 30 金币，获得一把随机武器',
        cost: { gold: 30 },
        requiresGold: 30,
        effect: { kind: 'weapon' },
      },
      {
        label: '拆解残骸回收零件',
        detail: '回复 32 点生命，护盾 +20',
        effect: { kind: 'heal', amount: 32 },
      },
      {
        label: '搜刮散落的金币',
        detail: '获得 22 金币',
        effect: { kind: 'gold', amount: 22 },
      },
    ],
  },
  {
    id: 'azure_spring',
    title: '幽蓝泉眼',
    body: '一汪泛着冷光的泉水从石缝里渗出。水面下似乎沉着一个黑乎乎的东西在缓慢移动。',
    options: [
      {
        label: '整具浸入泉水',
        detail: '生命回满，护盾 +40',
        effect: { kind: 'healFull' },
      },
      {
        label: '伸手打捞沉物',
        detail: '获得 70 金币，但被咬伤 15 点生命',
        effect: { kind: 'goldRoll', cost: 15, mul: 1, chance: 1 },
      },
      {
        label: '舀一瓶带走',
        detail: '生命上限 +15',
        effect: { kind: 'maxHp', amount: 15 },
      },
    ],
  },
  {
    id: 'dice_table',
    title: '骰子赌桌',
    body: '一张无人看管的赌桌，三颗骨制骰子静静躺在绒布上。桌角刻着「押上你的命，或者你的钱」。',
    options: [
      {
        label: '押上 50 金币',
        detail: '六成概率翻倍为 110 金币，四成概率血本无归',
        cost: { gold: 50 },
        requiresGold: 50,
        effect: { kind: 'goldRoll', cost: 50, mul: 2.2, chance: 0.6 },
      },
      {
        label: '押上 18 点生命上限',
        detail: '生命上限 -18，换取两次强化选择',
        effect: { kind: 'upgrade', count: 2 },
      },
      {
        label: '掀桌子走人',
        detail: '获得 12 金币（桌角缝里的）',
        effect: { kind: 'gold', amount: 12 },
      },
    ],
  },
];

export function pickEvent(rngPick: <T>(arr: readonly T[]) => T): EventDef {
  return rngPick(EVENTS);
}
