/**
 * 每层 Boss 的数据定义。原先只有「熔核·渊心」一个硬编码 Boss，
 * 现在改为数据驱动：每一层一个 `BossDef`，攻击池 / 配色 / 召唤物 / 终极技
 * 全部在这里配，Boss 类（entities/boss.ts）只负责读表执行。
 *
 * 设计（需求 17）：
 *   - 第 1 层 熔核·渊心：沿用原程序化绘制（无 sprite），橙红配色。
 *   - 第 2 层 豆包：位图 Boss（role/boss-豆包.png 抠出的正面立绘），
 *     技能参考 role/豆包-技能.png —— 豆包弹幕 / AI 扫描激光 / 召唤伙伴 / 豆包风暴。
 *   - 第 3 层 DeepSeek：位图 Boss（role/boss-deepseek.png），配色深蓝，
 *     技能参考 role/deepseek-技能.png —— 深海弹幕 / 深度预测 / 代码矩阵 / 深度思考。
 *
 * 每层 Boss 的碰撞半径统一参考第一关（52），保证手感一致。
 */
import type { BossAttackKind } from '../entities/boss';
import { FLOOR_COUNT } from './config';

export interface BossPalette {
  /** 外辉光 / 预警主色（"r,g,b" 字符串，用于 telegraph 与辉光） */
  glow: string;
  /** 能量核心色（十六进制） */
  core: string;
  /** 主体基色（十六进制，程序化兜底绘制用） */
  body: string;
  /** 强调色（十六进制） */
  accent: string;
  /** 弹丸内芯色（十六进制） */
  bullet: string;
  /** 弹丸辉光色（十六进制） */
  bulletGlow: string;
}

export interface BossDef {
  id: string;
  name: string;
  title: string;
  /** 位图立绘 slug（public/bosses/<slug>.png）；无则走程序化绘制（第 1 层） */
  sprite?: string;
  /** 所在楼层（1 起） */
  floor: number;
  /** 碰撞半径（参考第一关 = 52） */
  radius: number;
  /** 第 1 层基准血量 */
  baseHp: number;
  /** 每多一层的血量增量 */
  hpPerFloor: number;
  /** 接触伤害基准（每秒） */
  contactDamageBase: number;
  contactDamagePerFloor: number;
  palette: BossPalette;
  /** 每个阶段可用的攻击类型池（index 0 = 阶段 1） */
  phaseAttacks: BossAttackKind[][];
  /** 召唤类攻击使用的敌人 id 列表 */
  summonIds: string[];
  /** 血量低于该比例（0..1）时触发一次终极技；0 表示不触发 */
  ultimateAt: number;
  ultimateAttack: BossAttackKind;
  /** 图鉴 / HUD 展示的四个技能名（对应 role 技能素材的 4 格） */
  skillNames: [string, string, string, string];
}

// 第 1 层：熔核·渊心（程序化，原版）
const YUANXIN: BossDef = {
  id: 'yuanxin',
  name: '熔核·渊心',
  title: '深渊构筑体',
  floor: 1,
  radius: 52,
  baseHp: 2100,
  hpPerFloor: 900,
  contactDamageBase: 32,
  contactDamagePerFloor: 7,
  palette: { glow: '255,90,70', core: '#ffc46a', body: '#332c40', accent: '#ff8a3c', bullet: '#ffd9a0', bulletGlow: '#ff8a2b' },
  phaseAttacks: [
    ['fanSpread', 'aimedBurst'],
    ['fanSpread', 'aimedBurst', 'charge', 'ringBurst', 'summon'],
    ['fanSpread', 'aimedBurst', 'charge', 'ringBurst', 'summon', 'spiral', 'laserSweep'],
  ],
  summonIds: ['grub', 'triad', 'sentinel'],
  ultimateAt: 0,
  ultimateAttack: 'ringBurst',
  skillNames: ['扇形弹幕', '定向三连', '冲撞 / 环爆 / 召唤', '螺旋 / 激光'],
};

// 第 2 层：豆包（位图，参考 role/豆包-技能.png）
const DOUBAO: BossDef = {
  id: 'doubao',
  name: '豆包',
  title: 'AI 伙伴 · 团宠',
  sprite: 'doubao',
  floor: 2,
  radius: 52,
  baseHp: 2000,
  hpPerFloor: 850,
  contactDamageBase: 30,
  contactDamagePerFloor: 6,
  palette: { glow: '120,190,255', core: '#ffe07a', body: '#cfe8ff', accent: '#3aa0ff', bullet: '#eaf7ff', bulletGlow: '#3aa0ff' },
  phaseAttacks: [
    ['fanSpread', 'aimedBurst'],
    ['fanSpread', 'aimedBurst', 'laserSweep', 'summon'],
    ['spiral', 'laserSweep', 'ringBurst', 'summon'],
  ],
  summonIds: ['pal_lulu', 'pal_fatkangaroo', 'pal_milkdragon', 'pal_niulai'],
  ultimateAt: 0.3,
  ultimateAttack: 'ringBurst',
  skillNames: ['豆包弹幕', 'AI 扫描激光', '召唤伙伴', '豆包风暴'],
};

// 第 3 层：DeepSeek（位图，参考 role/deepseek-技能.png）
const DEEPSEEK: BossDef = {
  id: 'deepseek',
  name: 'DeepSeek',
  title: '深度之眼',
  sprite: 'deepseek',
  floor: 3,
  radius: 52,
  baseHp: 2400,
  hpPerFloor: 950,
  contactDamageBase: 34,
  contactDamagePerFloor: 7,
  palette: { glow: '60,160,255', core: '#7fd8ff', body: '#1b3a5c', accent: '#2b7fff', bullet: '#d6ecff', bulletGlow: '#2b7fff' },
  phaseAttacks: [
    ['ringBurst', 'aimedBurst'],
    ['ringBurst', 'spiral', 'charge'],
    ['spiral', 'laserSweep', 'ringBurst', 'summon'],
  ],
  summonIds: ['grub', 'triad', 'sentinel'],
  ultimateAt: 0.3,
  ultimateAttack: 'spiral',
  skillNames: ['深海弹幕', '深度预测', '代码矩阵', '深度思考'],
};

/** 楼层 → Boss 定义。键即楼层号。 */
export const FLOOR_BOSSES: Record<number, BossDef> = {
  1: YUANXIN,
  2: DOUBAO,
  3: DEEPSEEK,
};

/** 取指定楼层的 Boss 定义；越界时回落到最后一层的 Boss。 */
export function getBossDefForFloor(floor: number): BossDef {
  return FLOOR_BOSSES[floor] ?? FLOOR_BOSSES[FLOOR_COUNT]!;
}

/** 校验：FLOOR_BOSSES 必须覆盖 1..FLOOR_COUNT 每一层，且每层 id 唯一。 */
export function validateBossFloors(): void {
  const ids = new Set<string>();
  for (let f = 1; f <= FLOOR_COUNT; f++) {
    const def = FLOOR_BOSSES[f];
    if (!def) throw new Error(`缺少第 ${f} 层的 Boss 定义`);
    if (ids.has(def.id)) throw new Error(`Boss id 重复：${def.id}`);
    ids.add(def.id);
  }
}
