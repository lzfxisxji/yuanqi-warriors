/** 两名原创角色（狼影 / 蜂针）+ 四名位图立绘角色，共 6 名可选。数值、技能、配色全部原创。 */

export type SkillKind = 'dash' | 'overdrive' | 'barrier';

/**
 * 解锁规则。
 *
 * 注意：`wins`（通关 N 次解锁）目前**没有角色在用** —— 原「磐垒」取消后这条就空了出来。
 * 规则本身、`isCharacterUnlocked` 与 `unlockHint` 的分支都保留着，
 * 以后要加"通关才解锁"的角色，直接挂 `{ kind: 'wins', value: n }` 即可
 * （该分支由 `tests/data.test.ts` 的用例守着，不会因没人用而腐化）。
 */
export type UnlockRule =
  | { kind: 'default' }
  | { kind: 'bestFloor'; value: number }
  | { kind: 'wins'; value: number };

export interface CharacterPalette {
  primary: string;
  secondary: string;
  accent: string;
  skin: string;
  cape: string;
  glow: string;
}

export interface SkillDef {
  kind: SkillKind;
  name: string;
  desc: string;
  cooldown: number;
  duration: number;
  /** dash：冲刺速度 */
  dashSpeed?: number;
  /** dash：冲刺期间是否无敌 */
  invulnerable?: boolean;
  /** overdrive：移动速度倍率 */
  speedMul?: number;
  /** overdrive：额外闪避几率 */
  dodgeBonus?: number;
  /** barrier：护盾量 */
  shieldAmount?: number;
}

export interface CharacterDef {
  id: string;
  name: string;
  title: string;
  desc: string;
  maxHp: number;
  startShield: number;
  maxShield: number;
  speed: number;
  baseDodge: number;
  startWeapon: string;
  skill: SkillDef;
  palette: CharacterPalette;
  unlock: UnlockRule;
  /** 角色卡上的三条能力条，用于 UI 展示 */
  bars: { label: string; value: number }[];
  /**
   * 立绘 PNG 的 slug（放在 `public/characters/<slug>.png`）。
   * 有值时 `drawPlayer` / `drawCharacterPortrait` 会优先画这张位图，
   * 没有值时回落到 `palette` 程序化矢量小人。
   * 注意：位图只影响"看起来多大"（高度统一走 `PLAYER_SPRITE_H`，宽度按图片宽高比），
   * **不影响碰撞半径**。
   */
  sprite?: string;
}

export const CHARACTERS: CharacterDef[] = [
  {
    id: 'wolfshade',
    name: '狼影',
    title: '均衡型 · 游侠',
    desc: '血线与速度都属中游，靠翻滚穿梭于弹幕之间。适合新手与全能打法。',
    maxHp: 100,
    startShield: 0,
    maxShield: 60,
    speed: 238,
    baseDodge: 0.04,
    startWeapon: 'pulse_pistol',
    skill: {
      kind: 'dash',
      name: '影袭翻滚',
      desc: '向移动方向翻滚，翻滚全程无敌并能穿过敌人。',
      cooldown: 1.6,
      duration: 0.24,
      dashSpeed: 940,
      invulnerable: true,
    },
    palette: {
      primary: '#4a7fd4',
      secondary: '#2c4f8f',
      accent: '#ffd479',
      skin: '#f2c9a0',
      cape: '#d94f4f',
      glow: '#8fd0ff',
    },
    unlock: { kind: 'default' },
    bars: [
      { label: '生命', value: 0.5 },
      { label: '速度', value: 0.5 },
      { label: '技能', value: 0.6 },
    ],
  },
  {
    id: 'sting',
    name: '蜂针',
    title: '高速型 · 游猎',
    desc: '生命极薄但跑得飞快，超载时爆发性加速并大幅闪避来袭伤害。',
    maxHp: 74,
    startShield: 0,
    maxShield: 40,
    speed: 302,
    baseDodge: 0.08,
    startWeapon: 'smg',
    skill: {
      kind: 'overdrive',
      name: '超载引擎',
      desc: '1.8 秒内移动速度 +85%，并额外获得 45% 闪避。',
      cooldown: 7,
      duration: 1.8,
      speedMul: 1.85,
      dodgeBonus: 0.45,
    },
    palette: {
      primary: '#f0a83c',
      secondary: '#c46a1a',
      accent: '#7ef2c0',
      skin: '#e8b98c',
      cape: '#2e7d5b',
      glow: '#ffd070',
    },
    unlock: { kind: 'bestFloor', value: 2 },
    bars: [
      { label: '生命', value: 0.24 },
      { label: '速度', value: 0.9 },
      { label: '技能', value: 0.75 },
    ],
  },
  {
    id: 'lulu',
    name: '噜噜',
    title: '萌系型 · 橘猫',
    desc: '圆滚滚的橘子小兽，血线厚实、动作憨态，被打中时会炸开一圈橘皮护体。',
    maxHp: 116,
    startShield: 12,
    maxShield: 70,
    speed: 224,
    baseDodge: 0.05,
    startWeapon: 'assault_rifle',
    skill: {
      kind: 'barrier',
      name: '橘皮滚滚',
      desc: '蜷成一团橘皮护盾，吸收 78 点伤害并持续 6 秒。',
      cooldown: 11,
      duration: 6,
      shieldAmount: 78,
    },
    palette: {
      primary: '#f5c542',
      secondary: '#e07b25',
      accent: '#ff8a3d',
      skin: '#ffd97a',
      cape: '#e2701f',
      glow: '#ffe08a',
    },
    unlock: { kind: 'default' },
    bars: [
      { label: '生命', value: 0.66 },
      { label: '速度', value: 0.44 },
      { label: '技能', value: 0.7 },
    ],
    sprite: 'lulu',
  },
  {
    id: 'fatkangaroo',
    name: '肥嘟袋鼠',
    title: '机动型 · 拳击手',
    desc: '胖但极能蹦，一记冲刺把挡路的敌人整个撞开，冲完立刻回身补拳。',
    maxHp: 108,
    startShield: 0,
    maxShield: 55,
    speed: 268,
    baseDodge: 0.06,
    startWeapon: 'smg',
    skill: {
      kind: 'dash',
      name: '重拳突进',
      desc: '向瞄准方向猛冲一段，冲刺期间无敌并可穿过敌人。',
      cooldown: 1.4,
      duration: 0.22,
      dashSpeed: 1010,
      invulnerable: true,
    },
    palette: {
      primary: '#f7d046',
      secondary: '#d9a02a',
      accent: '#7ef2c0',
      skin: '#ffdf7a',
      cape: '#c98a1e',
      glow: '#ffe89a',
    },
    unlock: { kind: 'default' },
    bars: [
      { label: '生命', value: 0.58 },
      { label: '速度', value: 0.66 },
      { label: '技能', value: 0.72 },
    ],
    sprite: 'fatkangaroo',
  },
  {
    id: 'milkdragon',
    name: '奶龙',
    title: '重装型 · 幼龙',
    desc: '奶胖的黄色幼龙，血厚皮实、跑得不快，但一出场就能给自己套一层奶皮护盾。',
    maxHp: 132,
    startShield: 20,
    maxShield: 96,
    speed: 208,
    baseDodge: 0.02,
    startWeapon: 'grenade',
    skill: {
      kind: 'barrier',
      name: '奶泡护体',
      desc: '鼓起一层奶泡护盾，吸收 102 点伤害并持续 6.5 秒。',
      cooldown: 11.5,
      duration: 6.5,
      shieldAmount: 102,
    },
    palette: {
      primary: '#ffd84d',
      secondary: '#f0a828',
      accent: '#fff0b8',
      skin: '#ffe777',
      cape: '#d98f1c',
      glow: '#fff4c2',
    },
    unlock: { kind: 'default' },
    bars: [
      { label: '生命', value: 0.84 },
      { label: '速度', value: 0.32 },
      { label: '技能', value: 0.86 },
    ],
    sprite: 'milkdragon',
  },
  {
    id: 'niulai',
    name: '牛来',
    title: '平衡型 · 铁角牛',
    desc: '一身金毛的壮硕铁角牛，攻守都在水准之上；顶起牛角就能猛冲出去，把挡路的东西一起撞翻。',
    maxHp: 118,
    startShield: 16,
    maxShield: 80,
    speed: 232,
    baseDodge: 0.04,
    startWeapon: 'assault_rifle',
    skill: {
      kind: 'dash',
      name: '蛮牛冲撞',
      desc: '低头亮角向前猛冲，撞到的敌人受到 42 点伤害并被击退。',
      cooldown: 7.5,
      duration: 0.36,
      dashSpeed: 1020,
    },
    palette: {
      primary: '#ffc933',
      secondary: '#e09b1a',
      accent: '#fff0c0',
      skin: '#ffd75e',
      cape: '#c97f12',
      glow: '#fff6d0',
    },
    unlock: { kind: 'default' },
    bars: [
      { label: '生命', value: 0.68 },
      { label: '速度', value: 0.58 },
      { label: '技能', value: 0.62 },
    ],
    sprite: 'niulai',
  },
];

export function getCharacter(id: string): CharacterDef {
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0]!;
}

export function isCharacterUnlocked(
  def: CharacterDef,
  progress: { bestFloor: number; wins: number },
): boolean {
  switch (def.unlock.kind) {
    case 'default':
      return true;
    case 'bestFloor':
      return progress.bestFloor >= def.unlock.value;
    case 'wins':
      return progress.wins >= def.unlock.value;
  }
}

export function unlockHint(def: CharacterDef): string {
  switch (def.unlock.kind) {
    case 'default':
      return '初始解锁';
    case 'bestFloor':
      return `解锁条件：抵达第 ${def.unlock.value} 层`;
    case 'wins':
      return `解锁条件：通关 ${def.unlock.value} 次`;
  }
}
