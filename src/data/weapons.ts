/**
 * 武器定义。8 种武器在伤害、射速、弹速、散布、射程、弹匣、换弹、后坐、弹道上全部有真实差异，
 * 且射击反馈（枪口焰、弹道、命中音、屏幕震动）各不相同。
 */

export type WeaponKind = 'bullet' | 'beam' | 'flame' | 'grenade';
export type ProjectileShape = 'bolt' | 'pellet' | 'shell' | 'orb' | 'flameJet' | 'grenade';
export type WeaponSound = 'pistol' | 'rifle' | 'shotgun' | 'sniper' | 'smg' | 'laser' | 'flame' | 'launcher';

/**
 * 全武器基础伤害倍率 —— 「初始攻击力」的唯一调节点。
 * 表中填写的是设计基准值，实际生效值统一乘这个系数：
 * 上调它 = 所有武器一起变强，武器之间的强弱关系与相对差异保持不变。
 * 增伤强化（Mods.damageMul）作用在这之上，是独立的乘区。
 */
export const WEAPON_DAMAGE_MUL = 1.4;

/** 基础伤害按 WEAPON_DAMAGE_MUL 折算（保留一位小数，避免浮点噪声）。 */
function dmg(base: number): number {
  return Math.round(base * WEAPON_DAMAGE_MUL * 10) / 10;
}

export interface WeaponDef {
  id: string;
  name: string;
  kind: WeaponKind;
  /** 掉落层级：1 常见 / 2 稀有 / 3 史诗 */
  tier: 1 | 2 | 3;
  desc: string;
  /** 单发伤害 */
  damage: number;
  /** 每秒射击次数 */
  fireRate: number;
  bulletSpeed: number;
  /** 散布（弧度） */
  spread: number;
  /** 单次击发的弹丸数 */
  pellets: number;
  /** 有效射程（像素） */
  range: number;
  mag: number;
  reloadTime: number;
  /** 视觉后坐 0..1 */
  recoil: number;
  pierce: number;
  bounce: number;
  knockback: number;
  /** 激光：每秒伤害 / 光束宽度 */
  beamDps?: number;
  beamWidth?: number;
  explosive?: { radius: number; damage: number };
  burn?: { dps: number; duration: number };
  /** 是否按住自动连发 */
  auto: boolean;
  /** 持械移动速度倍率 */
  moveSpeedMul: number;
  crit: number;
  projectileRadius: number;
  shape: ProjectileShape;
  muzzleScale: number;
  shakeAmount: number;
  sound: WeaponSound;
  colors: { core: string; glow: string; trail: string };
  /** 弹药显示单位（能量/燃料等） */
  ammoLabel: string;
}

export const WEAPONS: WeaponDef[] = [
  {
    id: 'pulse_pistol',
    name: '脉冲手枪「节拍」',
    kind: 'bullet',
    tier: 1,
    desc: '起始装备。射速中等、弹道笔直，后坐轻微，是衡量其他武器的手感基准。',
    damage: dmg(16),
    fireRate: 5,
    bulletSpeed: 1020,
    spread: 0.018,
    pellets: 1,
    range: 620,
    mag: 12,
    reloadTime: 1.05,
    recoil: 0.22,
    pierce: 0,
    bounce: 0,
    knockback: 90,
    auto: false,
    moveSpeedMul: 1,
    crit: 0.06,
    projectileRadius: 4.5,
    shape: 'bolt',
    muzzleScale: 1,
    shakeAmount: 0.055,
    sound: 'pistol',
    colors: { core: '#ffffff', glow: '#8fd0ff', trail: '#5aa8ff' },
    ammoLabel: '弹药',
  },
  {
    id: 'assault_rifle',
    name: '突击步枪「连奏」',
    kind: 'bullet',
    tier: 2,
    desc: '全自动、弹速快、散布可控。按住左键即可持续压制。',
    damage: dmg(10),
    fireRate: 9.5,
    bulletSpeed: 1120,
    spread: 0.062,
    pellets: 1,
    range: 700,
    mag: 30,
    reloadTime: 1.65,
    recoil: 0.34,
    pierce: 0,
    bounce: 0,
    knockback: 70,
    auto: true,
    moveSpeedMul: 0.94,
    crit: 0.05,
    projectileRadius: 4,
    shape: 'bolt',
    muzzleScale: 0.85,
    shakeAmount: 0.045,
    sound: 'rifle',
    colors: { core: '#fff6d8', glow: '#ffb347', trail: '#ff8a3c' },
    ammoLabel: '弹药',
  },
  {
    id: 'shotgun',
    name: '霰弹枪「碎星」',
    kind: 'bullet',
    tier: 2,
    desc: '一次射出 7 颗弹丸，散布极大，近距离能打出恐怖的爆发并击退敌人。',
    damage: dmg(9),
    fireRate: 1.4,
    bulletSpeed: 840,
    spread: 0.3,
    pellets: 7,
    range: 330,
    mag: 6,
    reloadTime: 1.95,
    recoil: 0.85,
    pierce: 0,
    bounce: 0,
    knockback: 260,
    auto: false,
    moveSpeedMul: 0.88,
    crit: 0.04,
    projectileRadius: 4.2,
    shape: 'pellet',
    muzzleScale: 1.9,
    shakeAmount: 0.16,
    sound: 'shotgun',
    colors: { core: '#fff2cc', glow: '#ffd06a', trail: '#ff9a3c' },
    ammoLabel: '霰弹',
  },
  {
    id: 'sniper',
    name: '狙击枪「长瞳」',
    kind: 'bullet',
    tier: 3,
    desc: '射速极慢但单发致命、弹速极高，可贯穿 3 个目标。命中时会留下醒目的曳光。',
    damage: dmg(78),
    fireRate: 0.85,
    bulletSpeed: 2300,
    spread: 0.004,
    pellets: 1,
    range: 1200,
    mag: 5,
    reloadTime: 2.4,
    recoil: 1,
    pierce: 3,
    bounce: 0,
    knockback: 220,
    auto: false,
    moveSpeedMul: 0.82,
    crit: 0.14,
    projectileRadius: 5.5,
    shape: 'shell',
    muzzleScale: 1.5,
    shakeAmount: 0.22,
    sound: 'sniper',
    colors: { core: '#ffffff', glow: '#a8f0ff', trail: '#5ce1ff' },
    ammoLabel: '弹壳',
  },
  {
    id: 'smg',
    name: '冲锋枪「蜂群」',
    kind: 'bullet',
    tier: 1,
    desc: '射速最高的实弹武器，弹匣巨大但散布明显，适合近身泼洒火力。',
    damage: dmg(6.5),
    fireRate: 15,
    bulletSpeed: 900,
    spread: 0.13,
    pellets: 1,
    range: 480,
    mag: 45,
    reloadTime: 1.5,
    recoil: 0.18,
    pierce: 0,
    bounce: 0,
    knockback: 40,
    auto: true,
    moveSpeedMul: 0.9,
    crit: 0.05,
    projectileRadius: 3.4,
    shape: 'bolt',
    muzzleScale: 0.7,
    shakeAmount: 0.035,
    sound: 'smg',
    colors: { core: '#ffe9c0', glow: '#ffea8a', trail: '#ffc24a' },
    ammoLabel: '弹药',
  },
  {
    id: 'laser',
    name: '棱镜激光「棱镜」',
    kind: 'beam',
    tier: 3,
    desc: '持续能量束，穿透路径上的一切敌人。耗能高，需要频繁散热换弹。',
    damage: 0,
    fireRate: 1,
    bulletSpeed: 0,
    spread: 0,
    pellets: 1,
    range: 660,
    mag: 100,
    reloadTime: 1.9,
    recoil: 0,
    pierce: 99,
    bounce: 0,
    knockback: 12,
    beamDps: dmg(62),
    beamWidth: 9,
    auto: true,
    moveSpeedMul: 0.86,
    crit: 0.06,
    projectileRadius: 0,
    shape: 'flameJet',
    muzzleScale: 1.2,
    shakeAmount: 0.03,
    sound: 'laser',
    colors: { core: '#ffffff', glow: '#ff7ae0', trail: '#c04bff' },
    ammoLabel: '能量',
  },
  {
    id: 'flame',
    name: '火焰喷射「炉心」',
    kind: 'flame',
    tier: 2,
    desc: '极短射程的火舌，直伤之外还附加持续燃烧，把整条走廊烧成焦土。',
    damage: dmg(3.2),
    fireRate: 22,
    bulletSpeed: 520,
    spread: 0.24,
    pellets: 1,
    range: 250,
    mag: 140,
    reloadTime: 2,
    recoil: 0.08,
    pierce: 1,
    bounce: 0,
    knockback: 24,
    burn: { dps: dmg(9), duration: 3 },
    auto: true,
    moveSpeedMul: 0.84,
    crit: 0.03,
    projectileRadius: 11,
    shape: 'flameJet',
    muzzleScale: 1.1,
    shakeAmount: 0.03,
    sound: 'flame',
    colors: { core: '#fff3b0', glow: '#ff8a26', trail: '#ff4d1a' },
    ammoLabel: '燃料',
  },
  {
    id: 'grenade',
    name: '榴弹发射器「陨石」',
    kind: 'grenade',
    tier: 3,
    desc: '抛射一枚会弹跳的榴弹，命中后爆炸并造成范围伤害，可以清理成群敌人。',
    damage: dmg(30),
    fireRate: 1.6,
    bulletSpeed: 640,
    spread: 0.03,
    pellets: 1,
    range: 620,
    mag: 4,
    reloadTime: 2.3,
    recoil: 0.7,
    pierce: 0,
    bounce: 1,
    knockback: 130,
    explosive: { radius: 118, damage: dmg(55) },
    auto: false,
    moveSpeedMul: 0.9,
    crit: 0.05,
    projectileRadius: 7,
    shape: 'grenade',
    muzzleScale: 1.6,
    shakeAmount: 0.12,
    sound: 'launcher',
    colors: { core: '#fff0c2', glow: '#ffcf5a', trail: '#ff7a2f' },
    ammoLabel: '榴弹',
  },
];

export function getWeaponDef(id: string): WeaponDef {
  return WEAPONS.find((w) => w.id === id) ?? WEAPONS[0]!;
}

export function weaponById(id: string): WeaponDef | undefined {
  return WEAPONS.find((w) => w.id === id);
}

/** 掉落池：按层级加权，高 tier 更少见。 */
export function rollWeaponId(rngPick: (weights: number[]) => number, exclude: readonly string[] = []): string {
  const pool = WEAPONS.filter((w) => !exclude.includes(w.id));
  const list = pool.length ? pool : WEAPONS;
  const weights = list.map((w) => (w.tier === 1 ? 10 : w.tier === 2 ? 6 : 2.5));
  return list[rngPick(weights)]!.id;
}

/** 供 UI 展示的武器简评（三条属性条）。基准值随 WEAPON_DAMAGE_MUL 同步缩放，保证条长口径不变。 */
export function weaponStatBars(def: WeaponDef): { label: string; value: number }[] {
  const dps = def.kind === 'beam' ? (def.beamDps ?? 0) : def.damage * def.fireRate * def.pellets;
  const dpsRef = 160 * WEAPON_DAMAGE_MUL;
  return [
    { label: '伤害', value: Math.min(1, dps / dpsRef) },
    { label: '射速', value: Math.min(1, def.fireRate / 22) },
    { label: '射程', value: Math.min(1, def.range / 900) },
  ];
}
