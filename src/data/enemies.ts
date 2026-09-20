/**
 * 敌人定义。6 种普通敌人 + 2 种精英敌人，每种拥有不同的 AI 行为与弹幕形态。
 * AI 通过状态机驱动：Idle → Detect → Chase/Position → Attack(前摇) → Cooldown → Hit → Dead
 */
import { floorPower } from './config';

export type EnemyAI =
  | 'melee' // 近战追击
  | 'single' // 远程单发
  | 'burst3' // 三连发
  | 'fan' // 扇形弹幕
  | 'ring' // 环形弹幕
  | 'charger' // 冲锋攻击
  | 'kiter' // 保持距离 + 召唤
  | 'brute'; // 重装：冲锋 + 环形爆发

export type EnemyShape =
  | 'grub'
  | 'sentinel'
  | 'triad'
  | 'weaver'
  | 'orbiter'
  | 'charger'
  | 'gazer'
  | 'brute';

export type EnemyState = 'idle' | 'detect' | 'chase' | 'position' | 'windup' | 'attack' | 'cooldown' | 'hit' | 'dead';

export interface EnemyProjectileDef {
  speed: number;
  radius: number;
  damage: number;
  /** 一次发射的弹丸数 */
  count: number;
  /** 总散布（弧度） */
  spread: number;
  /** 存活时间（秒） */
  life: number;
  color: string;
  glow: string;
  kind: 'orb' | 'bolt' | 'spike' | 'wave';
  /** 追踪强度（每秒转向弧度），0 为直线 */
  homing?: number;
}

export interface SummonDef {
  enemyId: string;
  count: number;
}

export interface EnemyDef {
  id: string;
  name: string;
  /** 图鉴描述 */
  desc: string;
  elite: boolean;
  tier: 1 | 2 | 3;
  hp: number;
  speed: number;
  /** 冲锋/突进速度 */
  dashSpeed?: number;
  radius: number;
  /** 接触伤害（每秒） */
  contactDamage: number;
  detectRange: number;
  /** 维持距离（远程单位） */
  keepRange: number;
  attackCooldown: number;
  /** 攻击前摇（秒），给玩家反应时间 */
  windup: number;
  recover: number;
  ai: EnemyAI;
  projectile?: EnemyProjectileDef;
  burstCount?: number;
  burstDelay?: number;
  summon?: SummonDef;
  gold: [number, number];
  score: number;
  knockbackResist: number;
  palette: { body: string; dark: string; accent: string; glow: string };
  shape: EnemyShape;
  /** 位图立绘 slug（public/characters/<slug>.png）；有值时 drawEnemy 优先画位图，跳过矢量绘制。
   *  用于 Boss 召唤的"伙伴"等复用角色立绘的敌人。 */
  sprite?: string;
  /** 索敌方式：'self' 自身感知，'room' 全房索敌（精英） */
  awareness: 'self' | 'room';
}

export const ENEMIES: EnemyDef[] = [
  {
    id: 'grub',
    name: '腐壤爬虫',
    desc: '成群出没的腐土幼虫，只会埋头直冲，被咬中会连续掉血。',
    elite: false,
    tier: 1,
    hp: 34,
    speed: 126,
    radius: 15,
    contactDamage: 24,
    detectRange: 900,
    keepRange: 0,
    attackCooldown: 0.6,
    windup: 0.12,
    recover: 0.3,
    ai: 'melee',
    gold: [2, 5],
    score: 8,
    knockbackResist: 0.1,
    palette: { body: '#7da24a', dark: '#3f5a26', accent: '#c8e07a', glow: '#b6ff6a' },
    shape: 'grub',
    awareness: 'room',
  },
  {
    id: 'sentinel',
    name: '石面哨兵',
    desc: '悬浮的旧石守卫，保持中距离后单发点射，弹道笔直而缓慢。',
    elite: false,
    tier: 1,
    hp: 52,
    speed: 66,
    radius: 17,
    contactDamage: 14,
    detectRange: 620,
    keepRange: 278,
    attackCooldown: 2.2,
    windup: 0.55,
    recover: 0.35,
    ai: 'single',
    projectile: { speed: 336, radius: 8, damage: 9, count: 1, spread: 0, life: 3.2, color: '#9fd6ff', glow: '#4b9bff', kind: 'orb' },
    gold: [3, 6],
    score: 12,
    knockbackResist: 0.4,
    palette: { body: '#8d93a6', dark: '#4a4f60', accent: '#7ef2c0', glow: '#9fe8ff' },
    shape: 'sentinel',
    awareness: 'self',
  },
  {
    id: 'triad',
    name: '三叉木偶',
    desc: '木质傀儡，三张脸轮流开火，会打出三连发短点射。',
    elite: false,
    tier: 1,
    hp: 62,
    speed: 74,
    radius: 18,
    contactDamage: 16,
    detectRange: 640,
    keepRange: 244,
    attackCooldown: 2.6,
    windup: 0.42,
    recover: 0.3,
    ai: 'burst3',
    projectile: { speed: 420, radius: 6.5, damage: 7, count: 1, spread: 0.04, life: 3, color: '#ffe1a8', glow: '#ffae3c', kind: 'bolt' },
    burstCount: 3,
    burstDelay: 0.16,
    gold: [3, 7],
    score: 15,
    knockbackResist: 0.35,
    palette: { body: '#b7885a', dark: '#6b4a2c', accent: '#ffcf6a', glow: '#ffb454' },
    shape: 'triad',
    awareness: 'self',
  },
  {
    id: 'weaver',
    name: '织网者',
    desc: '蛛形弹幕投射器，一次性洒出一整片扇形弹幕封锁走位。',
    elite: false,
    tier: 2,
    hp: 54,
    speed: 82,
    radius: 16,
    contactDamage: 15,
    detectRange: 660,
    keepRange: 258,
    attackCooldown: 3,
    windup: 0.55,
    recover: 0.45,
    ai: 'fan',
    projectile: { speed: 316, radius: 7, damage: 8, count: 5, spread: 0.66, life: 3.4, color: '#d3a8ff', glow: '#a45bff', kind: 'orb' },
    gold: [4, 8],
    score: 18,
    knockbackResist: 0.3,
    palette: { body: '#6b5a9e', dark: '#382c5c', accent: '#c8a2ff', glow: '#b07bff' },
    shape: 'weaver',
    awareness: 'self',
  },
  {
    id: 'orbiter',
    name: '环旋石环',
    desc: '不停自转的浮空石环，会向四周释放一整圈弹幕，逼你寻找缝隙。',
    elite: false,
    tier: 2,
    hp: 70,
    speed: 62,
    radius: 19,
    contactDamage: 16,
    detectRange: 560,
    keepRange: 210,
    attackCooldown: 3.6,
    windup: 0.7,
    recover: 0.5,
    ai: 'ring',
    projectile: { speed: 268, radius: 7, damage: 8, count: 12, spread: Math.PI * 2, life: 3.6, color: '#9ff5e0', glow: '#25d6b0', kind: 'orb' },
    gold: [4, 9],
    score: 22,
    knockbackResist: 0.5,
    palette: { body: '#7f8f96', dark: '#3f4b52', accent: '#9ff5e0', glow: '#42e0c0' },
    shape: 'orbiter',
    awareness: 'self',
  },
  {
    id: 'charger',
    name: '冲锋兽',
    desc: '四足冲撞者。锁定目标后会长距离突进，撞墙会陷入短暂的硬直。',
    elite: false,
    tier: 2,
    hp: 84,
    speed: 100,
    dashSpeed: 470,
    radius: 20,
    contactDamage: 34,
    detectRange: 720,
    keepRange: 0,
    attackCooldown: 2.4,
    windup: 0.62,
    recover: 0.85,
    ai: 'charger',
    gold: [4, 9],
    score: 24,
    knockbackResist: 0.55,
    palette: { body: '#b8553f', dark: '#6b2b20', accent: '#ffb066', glow: '#ff7a3c' },
    shape: 'charger',
    awareness: 'room',
  },
  {
    id: 'gazer',
    name: '幽蓝凝视者',
    desc: '精英。始终与玩家保持距离，发射缓慢的追踪球，并不断召唤腐壤爬虫。',
    elite: true,
    tier: 3,
    hp: 215,
    speed: 78,
    radius: 25,
    contactDamage: 22,
    detectRange: 1200,
    keepRange: 330,
    attackCooldown: 3.4,
    windup: 0.75,
    recover: 0.6,
    ai: 'kiter',
    projectile: { speed: 232, radius: 10, damage: 11, count: 3, spread: 0.5, life: 4.4, color: '#bff3ff', glow: '#3fb7ff', kind: 'orb', homing: 1.35 },
    summon: { enemyId: 'grub', count: 2 },
    gold: [12, 20],
    score: 90,
    knockbackResist: 0.75,
    palette: { body: '#3f6f9c', dark: '#20375a', accent: '#bff3ff', glow: '#5cc8ff' },
    shape: 'gazer',
    awareness: 'room',
  },
  {
    id: 'brute',
    name: '熔核重锤',
    desc: '精英。装甲极厚，会先以环形爆轰清场，再凭借巨躯直线冲锋碾碎一切。',
    elite: true,
    tier: 3,
    hp: 320,
    speed: 64,
    dashSpeed: 430,
    radius: 29,
    contactDamage: 38,
    detectRange: 1200,
    keepRange: 190,
    attackCooldown: 3.8,
    windup: 0.85,
    recover: 0.8,
    ai: 'brute',
    projectile: { speed: 300, radius: 9, damage: 10, count: 14, spread: Math.PI * 2, life: 3.8, color: '#ffd6a8', glow: '#ff6a1f', kind: 'spike' },
    gold: [16, 26],
    score: 120,
    knockbackResist: 0.9,
    palette: { body: '#7a4436', dark: '#3d1e18', accent: '#ffb066', glow: '#ff5a1a' },
    shape: 'brute',
    awareness: 'room',
  },
];

/**
 * 豆包（第 2 层 Boss）技能三「召唤伙伴」召唤的四个伙伴。
 * 它们复用角色立绘（role 里抠好的正面 PNG），用位图绘制，行为和普通近战小怪一致。
 * **它们不进 `ENEMIES`**（避免混进普通战斗波次与图鉴），而是单独的 `SUMMON_ENEMIES`，
 * 只由 Boss 的 `summonIds` 经 `getEnemyDef()` 取用。id 前缀 `pal_` 避免命名冲突。
 */
function palCompanion(
  id: string,
  name: string,
  sprite: string,
  glow: string,
): EnemyDef {
  return {
    id,
    name,
    desc: '豆包召唤来的伙伴，憨态可掬却会朝你直冲，被咬中会连续掉血。',
    elite: false,
    tier: 2,
    hp: 90,
    speed: 124,
    radius: 18,
    contactDamage: 18,
    detectRange: 760,
    keepRange: 0,
    attackCooldown: 1.4,
    windup: 0.3,
    recover: 0.4,
    ai: 'melee',
    gold: [3, 6],
    score: 18,
    knockbackResist: 0.3,
    palette: { body: '#f5c542', dark: '#c4881f', accent: '#ff8a3d', glow },
    shape: 'grub',
    sprite,
    awareness: 'room',
  };
}

/**
 * Boss 召唤的专属敌人池。**刻意与 ENEMIES 分开** —— 它们不进普通战斗波次、
 * 不进图鉴，只由 Boss 的 `summonIds` 经 `getEnemyDef()` 取用（见 ALL_ENEMIES）。
 */
export const SUMMON_ENEMIES: EnemyDef[] = [
  palCompanion('pal_lulu', '噜噜·伙伴', 'lulu', '#ffb454'),
  palCompanion('pal_fatkangaroo', '肥嘟袋鼠·伙伴', 'fatkangaroo', '#ffb454'),
  palCompanion('pal_milkdragon', '奶龙·伙伴', 'milkdragon', '#ffd84d'),
  palCompanion('pal_niulai', '牛来·伙伴', 'niulai', '#ffc933'),
];

/** 全部可被 getEnemyDef 解析的敌人（基础表 + 召唤专属）。 */
const ALL_ENEMIES: EnemyDef[] = [...ENEMIES, ...SUMMON_ENEMIES];

export function getEnemyDef(id: string): EnemyDef {
  const d = ALL_ENEMIES.find((e) => e.id === id);
  if (!d) throw new Error(`未知敌人 id: ${id}`);
  return d;
}

export const NORMAL_ENEMIES = ENEMIES.filter((e) => !e.elite);
export const ELITE_ENEMIES = ENEMIES.filter((e) => e.elite);

/**
 * 楼层强度缩放（需求 21）。
 *
 * **血量与攻击力都用同一个 1.5^(N-1) 系数**：第 2 层正好是第 1 层的 1.5 倍，
 * 第 3 层正好是第 2 层的 1.5 倍（= 第 1 层的 2.25 倍）。
 * 系数本身放在 `config.ts` 的 `floorPower()`，和 Boss 共用同一条曲线。
 */
export function enemyScale(floor: number): { hp: number; damage: number } {
  const p = floorPower(floor);
  return { hp: p, damage: p };
}

export function scaledHp(def: EnemyDef, floor: number): number {
  return Math.round(def.hp * enemyScale(floor).hp);
}

/** 接触伤害与弹丸伤害的楼层缩放。 */
export function scaledContactDamage(def: EnemyDef, floor: number): number {
  return Math.round(def.contactDamage * enemyScale(floor).damage * 10) / 10;
}

export function scaledProjectileDamage(def: EnemyDef, floor: number): number {
  if (!def.projectile) return 0;
  return Math.round(def.projectile.damage * enemyScale(floor).damage * 10) / 10;
}

