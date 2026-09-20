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
  /** 图鉴简介（与 ENEMIES / WEAPONS / CHARACTERS 的 desc 同口径）。 */
  desc: string;
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
  desc: '地牢最深处自行拼合出的装甲造物，八枚甲片环绕着不熄的熔核，越受创越狂暴。',
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
  desc: '本该是并肩作战的伙伴，被地牢的能量泡坏了脾气；打急了还会把噜噜它们喊来帮忙。',
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
  desc: '盘踞在远征尽头的巨大造物，据说什么都能算到；它把每一步走位都当成待解的题。',
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

/**
 * 按楼层升序排列的全部 Boss —— **图鉴左列表的唯一出处**。
 * 故意从 `FLOOR_BOSSES` 派生而不是手写第二份清单：
 * 以后加一层只要往 FLOOR_BOSSES 里补一条，图鉴自动多一行，不会再出现"漏登记"。
 */
export const BOSSES: readonly BossDef[] = Object.keys(FLOOR_BOSSES)
  .map(Number)
  .sort((a, b) => a - b)
  .map((f) => FLOOR_BOSSES[f]!);

/** 攻击类型的图鉴中文名（终极技那一栏要用）。 */
export const BOSS_ATTACK_LABELS: Record<BossAttackKind, string> = {
  fanSpread: '扇形弹幕',
  aimedBurst: '定向连射',
  charge: '蓄力冲撞',
  ringBurst: '环状爆发',
  summon: '召唤伙伴',
  spiral: '螺旋弹幕',
  laserSweep: '扫射激光',
};

/** 取指定楼层的 Boss 定义；越界时回落到最后一层的 Boss。 */
export function getBossDefForFloor(floor: number): BossDef {
  return FLOOR_BOSSES[floor] ?? FLOOR_BOSSES[FLOOR_COUNT]!;
}

/**
 * Boss 在该层的实际血量。
 * **唯一出处**：实体（entities/boss.ts）和图鉴都从这里取，
 * 免得图鉴显示 2000、实战却是 2850 这种两处算法漂移。
 */
export function bossMaxHp(def: BossDef): number {
  return Math.round(def.baseHp + def.hpPerFloor * (def.floor - 1));
}

/** Boss 在该层的实际接触伤害（每秒）。唯一出处，理由同 bossMaxHp。 */
export function bossContactDamage(def: BossDef): number {
  return def.contactDamageBase + def.contactDamagePerFloor * (def.floor - 1);
}

/** 校验：FLOOR_BOSSES 必须覆盖 1..FLOOR_COUNT 每一层，且每层 id 唯一、图鉴字段齐备。 */
export function validateBossFloors(): void {
  const ids = new Set<string>();
  for (let f = 1; f <= FLOOR_COUNT; f++) {
    const def = FLOOR_BOSSES[f];
    if (!def) throw new Error(`缺少第 ${f} 层的 Boss 定义`);
    if (ids.has(def.id)) throw new Error(`Boss id 重复：${def.id}`);
    if (def.floor !== f) throw new Error(`Boss ${def.id} 的 floor=${def.floor} 与键 ${f} 不一致`);
    // 图鉴要直接展示这两项，空掉会画出空白行
    if (!def.desc) throw new Error(`Boss ${def.id} 缺少图鉴简介 desc`);
    if (def.skillNames.length !== 4 || def.skillNames.some((n) => !n)) {
      throw new Error(`Boss ${def.id} 的 skillNames 必须是 4 个非空技能名`);
    }
    ids.add(def.id);
  }
  if (BOSSES.length !== FLOOR_COUNT) {
    throw new Error(`BOSSES 条目数 ${BOSSES.length} 与 FLOOR_COUNT ${FLOOR_COUNT} 不一致`);
  }
}
