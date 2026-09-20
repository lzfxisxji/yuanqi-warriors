/**
 * 武器定义。8 种远程武器在伤害、射速、弹速、散布、射程、弹匣、换弹、后坐、弹道上全部有真实差异，
 * 且射击反馈（枪口焰、弹道、命中音、屏幕震动）各不相同。
 *
 * 另有 4 把**近战武器**（`kind: 'melee'`，需求 21 补）—— 设计取自 `weapon/weapon.png` 的
 * 「近战武器 MELEE WEAPONS」设定表（咸鱼 / 狼牙棒 / 木棍 / 长枪）：
 * 伤害值与攻速按表内数值填写，尺寸与攻击范围由本项目自行设定。
 * 近战不消耗弹药、不换弹，命中判定是「瞄准方向前方的一个扇形」（见 `swingArc`），
 * 因此 `bulletSpeed` / `spread` / `mag` / `reloadTime` 这些远程字段对它们不生效。
 */

export type WeaponKind = 'bullet' | 'beam' | 'flame' | 'grenade' | 'melee';
export type ProjectileShape = 'bolt' | 'pellet' | 'shell' | 'orb' | 'flameJet' | 'grenade' | 'blade';
export type WeaponSound = 'pistol' | 'rifle' | 'shotgun' | 'sniper' | 'smg' | 'laser' | 'flame' | 'launcher' | 'melee';

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

/**
 * 近战伤害换算系数：设定表（`weapon/weapon.png`）上的「伤害值」是**相对强度**
 * （咸鱼 25 / 狼牙棒 40 / 木棍 20 / 长枪 35），换算到本作要再乘这个数。
 *
 * 为什么不能照抄：本作近战每秒只挥 0.8~1.5 次，而远程是 5~22 次。
 * 照抄的话四把近战的基础 DPS 只有 42~49，远低于本项目「任何武器基础 DPS ≥ 60」
 * 的下限（`tests/data.test.ts` 锁死），近战会变成纯摆设。
 *
 * 取 2.6 的依据：近战必须站进敌人接触范围内输出（持续吃接触伤害），
 * 用射程换输出，所以它的 DPS 应当**略高于**手感基准「脉冲手枪」(≈112)。
 * 乘完之后四把的相对强弱与设定表完全一致，本系数只影响整体强弱、不影响排序。
 */
export const MELEE_DAMAGE_SCALE = 2.6;

/** 近战伤害：设定表数值 → 本作生效值。 */
function meleeDmg(tableValue: number): number {
  return dmg(tableValue * MELEE_DAMAGE_SCALE);
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
  /**
   * 近战专用：挥砍扇形的**总张角**（弧度）。`kind: 'melee'` 时生效 ——
   * 落在「瞄准方向 ± swingArc/2」、距离 ≤ `range` 范围内的敌人全部命中。
   * 长枪这种「直线突刺」把它压窄（≈0.45），木棍 / 咸鱼这种横扫就放大。
   */
  swingArc?: number;
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
  /**
   * 武器从握把到末端的**可视长度**（`drawWeaponShape` 的局部坐标单位）。
   *
   * 只用于**图鉴 / HUD 图标居中**：原来的 8 把枪械长度都在 40 上下，
   * 图标里统一 `translate(-16, 0)` 就能摆正；长枪有 84 长，照枪械的口径画会整根戳出图标框，
   * 所以配了本字段的武器会改成"按实际长度缩放到图标框内并居中"。
   * 不配（`undefined`）就沿用原来的画法，保证既有武器图标外观不变。
   */
  heldLength?: number;
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

  // ------------------------------------------------------------ 近战武器（需求 21）
  // 数值口径：伤害值取自 weapon/weapon.png 设定表，经 `meleeDmg()` 换算（见上方系数说明）；
  // 「攻击速度（次/秒）」直接取表内数值。攻击范围（range，像素）与武器造型长度由本项目设定 ——
  // 目标是「看得见的刃长 ≈ 打得到的距离」。近战统一 `auto: true`：按住左键按固定节奏连续挥砍。
  {
    id: 'salted_fish',
    name: '咸鱼',
    kind: 'melee',
    tier: 1,
    desc: '「看起来很咸，但打人真的很痛！」一条看似普通的咸鱼，没想到在关键时刻能掏出惊人的伤害。',
    damage: meleeDmg(25),
    fireRate: 1.2,
    bulletSpeed: 0,
    spread: 0,
    pellets: 1,
    range: 62,
    mag: 1,
    reloadTime: 0,
    recoil: 0.2,
    pierce: 0,
    bounce: 0,
    knockback: 70,
    swingArc: 1.55,
    auto: true,
    moveSpeedMul: 1,
    crit: 0.05,
    projectileRadius: 0,
    shape: 'blade',
    muzzleScale: 1,
    heldLength: 50,
    shakeAmount: 0.045,
    sound: 'melee',
    colors: { core: '#ffffff', glow: '#bfe6ff', trail: '#7fc8ef' },
    ammoLabel: '近战',
  },
  {
    id: 'spiked_mace',
    name: '狼牙棒',
    kind: 'melee',
    tier: 2,
    desc: '「简单粗暴，一棒解决！」布满尖刺的重型武器，每一次挥动都能带来毁灭性的打击。',
    damage: meleeDmg(40),
    fireRate: 0.8,
    bulletSpeed: 0,
    spread: 0,
    pellets: 1,
    range: 68,
    mag: 1,
    reloadTime: 0,
    recoil: 0.34,
    pierce: 0,
    bounce: 0,
    knockback: 260,
    swingArc: 1.3,
    auto: true,
    moveSpeedMul: 0.9,
    crit: 0.07,
    projectileRadius: 0,
    shape: 'blade',
    muzzleScale: 1,
    heldLength: 48,
    shakeAmount: 0.14,
    sound: 'melee',
    colors: { core: '#ffe6c2', glow: '#ffb15a', trail: '#c9762f' },
    ammoLabel: '近战',
  },
  {
    id: 'wood_stick',
    name: '木棍',
    kind: 'melee',
    tier: 1,
    desc: '「朴实无华，但足够可靠。」一根结实的木棍，陪伴了无数冒险者走过最初的旅程。',
    damage: meleeDmg(20),
    fireRate: 1.5,
    bulletSpeed: 0,
    spread: 0,
    pellets: 1,
    range: 60,
    mag: 1,
    reloadTime: 0,
    recoil: 0.18,
    pierce: 0,
    bounce: 0,
    knockback: 60,
    swingArc: 1.45,
    auto: true,
    moveSpeedMul: 1.02,
    crit: 0.05,
    projectileRadius: 0,
    shape: 'blade',
    muzzleScale: 1,
    heldLength: 58,
    shakeAmount: 0.035,
    sound: 'melee',
    colors: { core: '#ffeacb', glow: '#d9a86a', trail: '#a3763f' },
    ammoLabel: '近战',
  },
  {
    id: 'long_spear',
    name: '长枪',
    kind: 'melee',
    tier: 3,
    desc: '「一往无前，贯穿一切！」锋利的枪刃，象征着勇气与力量，能在战场上贯穿一切阻碍。',
    damage: meleeDmg(35),
    fireRate: 1,
    bulletSpeed: 0,
    spread: 0,
    pellets: 1,
    range: 108,
    mag: 1,
    reloadTime: 0,
    recoil: 0.26,
    pierce: 1,
    bounce: 0,
    knockback: 150,
    swingArc: 0.42,
    auto: true,
    moveSpeedMul: 0.94,
    crit: 0.08,
    projectileRadius: 0,
    shape: 'blade',
    muzzleScale: 1,
    heldLength: 96,
    shakeAmount: 0.08,
    sound: 'melee',
    colors: { core: '#ffffff', glow: '#9fd8ff', trail: '#4f8ff0' },
    ammoLabel: '近战',
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

/**
 * 近战武器「攻击范围」条的分母参考值 —— 取本作最长的一把（长枪 108）再留一点余量。
 * 远程武器用 900 当分母，近战的最远距离只有 100 出头，共用分母会让三条属性条全部贴地，
 * 看不出 咸鱼 / 狼牙棒 / 长枪 之间的差别。
 */
export const MELEE_RANGE_REF = 120;

/** 供 UI 展示的武器简评（三条属性条）。基准值随 WEAPON_DAMAGE_MUL 同步缩放，保证条长口径不变。 */
export function weaponStatBars(def: WeaponDef): { label: string; value: number }[] {
  const dps = def.kind === 'beam' ? (def.beamDps ?? 0) : def.damage * def.fireRate * def.pellets;
  const dpsRef = 160 * WEAPON_DAMAGE_MUL;
  const melee = def.kind === 'melee';
  return [
    { label: '伤害', value: Math.min(1, dps / dpsRef) },
    { label: melee ? '攻速' : '射速', value: Math.min(1, def.fireRate / 22) },
    { label: melee ? '攻击范围' : '射程', value: Math.min(1, def.range / (melee ? MELEE_RANGE_REF : 900)) },
  ];
}
