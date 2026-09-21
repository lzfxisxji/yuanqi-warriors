/**
 * 程序化美术：全部角色 / 怪物 / Boss / 拾取物 / 图标都在运行时用 Canvas 2D 绘制。
 * 统一风格原则：暗底 + 厚描边 + 顶部高光 + 侧向轮廓光 + 地面投影，
 * 保证角色、怪物、建筑、道具看起来属于同一个世界。
 */
import { TAU, clamp, easeOutCubic, lerp } from '../core/math';
import { PLAYER_RADIUS, PLAYER_SPRITE_H } from '../data/config';
import type { CharacterDef, CharacterPalette } from '../data/characters';
import type { BossDef } from '../data/bosses';
import type { WeaponDef } from '../data/weapons';
import { getWeaponDef } from '../data/weapons';
import type { UpgradeIcon } from '../data/upgrades';
import type { Enemy } from '../entities/enemy';
import type { Boss } from '../entities/boss';
import type { Player } from '../entities/player';
import type { Pickup } from '../entities/pickup';
import { getCharacterSprite, getBossSprite } from './sprites';
import { BOSS_SPRITE_SCALE } from '../data/config';

// ------------------------------------------------------------------ 颜色工具

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function lighten(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
}

export function darken(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * (1 - amount), g * (1 - amount), b * (1 - amount));
}

export function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(lerp(r1, r2, t), lerp(g1, g2, t), lerp(b1, b2, t));
}

export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ------------------------------------------------------------------ 路径工具

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function ellipsePath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  rot = 0,
): void {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.2, rx), Math.max(0.2, ry), rot, 0, TAU);
}

/** 地面投影 */
export function drawShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  alpha = 0.32,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#07060c';
  ellipsePath(ctx, x, y, rx, ry);
  ctx.fill();
  ctx.restore();
}

/** 侧向轮廓光：让角色在暗底上"出边"，统一风格的关键。 */
function rimLight(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  color: string,
  alpha = 0.5,
  rot = 0,
  startAngle = Math.PI * 0.85,
  endAngle = Math.PI * 1.85,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, startAngle, endAngle);
  ctx.stroke();
  ctx.restore();
}

function bodyGradient(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  base: string,
): CanvasGradient {
  const g = ctx.createLinearGradient(x, y - ry, x, y + ry);
  g.addColorStop(0, lighten(base, 0.34));
  g.addColorStop(0.45, base);
  g.addColorStop(1, darken(base, 0.38));
  return g;
}

// ------------------------------------------------------------------ 武器造型

/** 以 (0,0) 为握把、朝 +X 方向绘制武器。 */
export function drawWeaponShape(
  ctx: CanvasRenderingContext2D,
  def: WeaponDef,
  scale = 1,
  tint?: string,
): void {
  ctx.save();
  ctx.scale(scale, scale);
  const metal = tint ?? '#5a6070';
  const metalLight = tint ?? '#8b93a6';
  const dark = tint ?? '#2b2f3a';
  const accent = tint ?? def.colors.glow;

  const fill = (c: string) => {
    ctx.fillStyle = tint ?? c;
  };
  const stroke = (c: string) => {
    ctx.strokeStyle = tint ?? c;
  };

  // 握把
  fill(dark);
  roundedRectPath(ctx, -7, 2, 8, 13, 3);
  ctx.fill();

  switch (def.id) {
    case 'pulse_pistol':
      fill(metal);
      roundedRectPath(ctx, -2, -6, 24, 10, 3);
      ctx.fill();
      fill(metalLight);
      roundedRectPath(ctx, 16, -4, 10, 5, 2);
      ctx.fill();
      fill(accent);
      ctx.fillRect(4, -3, 5, 3);
      break;
    case 'assault_rifle':
      fill(metal);
      roundedRectPath(ctx, -6, -7, 40, 11, 3);
      ctx.fill();
      fill(metalLight);
      roundedRectPath(ctx, 28, -4, 16, 5, 2);
      ctx.fill();
      fill(dark);
      roundedRectPath(ctx, 4, 3, 8, 12, 2);
      ctx.fill();
      fill(accent);
      ctx.fillRect(10, -10, 12, 4);
      break;
    case 'smg':
      fill(metal);
      roundedRectPath(ctx, -4, -7, 28, 11, 3);
      ctx.fill();
      fill(metalLight);
      roundedRectPath(ctx, 20, -4, 12, 5, 2);
      ctx.fill();
      fill(dark);
      roundedRectPath(ctx, 2, 3, 7, 15, 2);
      ctx.fill();
      break;
    case 'shotgun':
      fill(metal);
      roundedRectPath(ctx, -6, -6, 44, 9, 2);
      ctx.fill();
      fill(dark);
      roundedRectPath(ctx, 20, -4, 26, 7, 2);
      ctx.fill();
      fill(metalLight);
      roundedRectPath(ctx, -6, 3, 16, 7, 2);
      ctx.fill();
      fill(accent);
      ctx.fillRect(2, -9, 10, 3);
      break;
    case 'sniper':
      fill(metal);
      roundedRectPath(ctx, -8, -5, 56, 8, 2);
      ctx.fill();
      fill(dark);
      roundedRectPath(ctx, -14, -12, 22, 7, 3);
      ctx.fill();
      fill(metalLight);
      roundedRectPath(ctx, 44, -4, 16, 4, 2);
      ctx.fill();
      fill(accent);
      ctx.fillRect(2, -13, 6, 3);
      break;
    case 'laser':
      fill(metal);
      roundedRectPath(ctx, -4, -8, 30, 13, 4);
      ctx.fill();
      fill(accent);
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(26, -5);
      ctx.lineTo(40, 0);
      ctx.lineTo(26, 5);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = tint ?? '#ffffff';
      ellipsePath(ctx, 8, -1, 3.4, 3.4);
      ctx.fill();
      break;
    case 'flame':
      fill(dark);
      roundedRectPath(ctx, -8, -9, 20, 16, 6);
      ctx.fill();
      fill(metalLight);
      roundedRectPath(ctx, 8, -5, 24, 9, 3);
      ctx.fill();
      fill(accent);
      ctx.beginPath();
      ctx.moveTo(32, -3);
      ctx.lineTo(40, 0);
      ctx.lineTo(32, 3);
      ctx.closePath();
      ctx.fill();
      break;
    case 'grenade':
      fill(metal);
      roundedRectPath(ctx, -4, -7, 30, 12, 4);
      ctx.fill();
      fill(dark);
      ellipsePath(ctx, 6, 2, 7, 7);
      ctx.fill();
      fill(accent);
      ctx.beginPath();
      ctx.arc(6, 2, 2.6, 0, TAU);
      ctx.fill();
      ctx.fillStyle = tint ?? '#ffffff';
      ctx.fillRect(26, -4, 10, 6);
      break;
    // ---------------------------------------------------------- 近战武器（需求 21）
    // 全部沿用"握把在原点、朝 +X 伸展"的同一套约定，所以挥砍动画 / 拾取展示 /
    // 图鉴图标都不需要为近战写第二套变换。
    case 'salted_fish': {
      // 咸鱼：尾鳍就是握把，鱼身朝前 —— 甩起来像一把很敷衍的钝器。
      // 配色直接用武器自身的 colors（浅蓝鱼身 + 白肚 + 亮鳍）：通用的灰铁色在暗色地板上
      // 只剩一团影子，而这是唯一一把"一眼要认出是条鱼"的武器。
      const fishFin = def.colors.glow;
      // 尾鳍
      fill(fishFin);
      ctx.beginPath();
      ctx.moveTo(4, 0);
      ctx.lineTo(-11, -9);
      ctx.lineTo(-6.5, 0);
      ctx.lineTo(-11, 9);
      ctx.closePath();
      ctx.fill();
      // 鱼身 + 描边（描边负责把它从同色系的地板上拉出来）
      fill(def.colors.trail);
      ellipsePath(ctx, 19, 0, 18, 9.2);
      ctx.fill();
      ctx.strokeStyle = tint ?? '#16202c';
      ctx.lineWidth = 1.6;
      ellipsePath(ctx, 19, 0, 18, 9.2);
      ctx.stroke();
      // 白肚
      fill(def.colors.core);
      ellipsePath(ctx, 18, 3.4, 13.5, 4);
      ctx.fill();
      // 背鳍
      fill(fishFin);
      ctx.beginPath();
      ctx.moveTo(12, -7.6);
      ctx.lineTo(20, -16);
      ctx.lineTo(27, -6.8);
      ctx.closePath();
      ctx.fill();
      // 头部 + 眼
      fill(fishFin);
      ellipsePath(ctx, 34, -0.6, 5, 6);
      ctx.fill();
      ctx.fillStyle = tint ?? '#141b25';
      ctx.beginPath();
      ctx.arc(33.5, -2.6, 1.9, 0, TAU);
      ctx.fill();
      // 鳃线
      ctx.strokeStyle = tint ?? '#2a4055';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(28, 0, 7, -1.15, 1.15);
      ctx.stroke();
      break;
    }
    case 'spiked_mace': {
      // 狼牙棒：木柄 + 布满尖刺的铁球头，视觉重心全在锤头（因此击退最猛）。
      fill(tint ?? '#6b4a2a');
      roundedRectPath(ctx, -5, -4.4, 26, 8.8, 3);
      ctx.fill();
      fill(tint ?? '#9a6d3d');
      roundedRectPath(ctx, -5, -4.4, 26, 3.2, 1.5);
      ctx.fill();
      // 缠绳握位
      fill(accent);
      for (let i = 0; i < 3; i++) ctx.fillRect(-1 + i * 5.4, -4.4, 2.2, 8.8);
      // 锤头：暗铁球 + 顶部高光，让后面的亮刺有对比
      fill(tint ?? '#3b414d');
      ellipsePath(ctx, 28, 0, 10.5, 10.5);
      ctx.fill();
      fill(tint ?? '#6f7787');
      ellipsePath(ctx, 24.6, -3.4, 4.8, 4.4);
      ctx.fill();
      // 尖刺（用武器自身的强调色，暗底上一眼看出是狼牙棒）
      fill(accent);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + 0.22;
        const bx = 28 + Math.cos(a) * 7.6;
        const by = Math.sin(a) * 7.6;
        const tx = 28 + Math.cos(a) * 15.5;
        const ty = Math.sin(a) * 15.5;
        const nx = Math.cos(a + Math.PI / 2) * 2.7;
        const ny = Math.sin(a + Math.PI / 2) * 2.7;
        ctx.beginPath();
        ctx.moveTo(bx + nx, by + ny);
        ctx.lineTo(tx, ty);
        ctx.lineTo(bx - nx, by - ny);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 'wood_stick': {
      // 木棍：最朴素的一根，前端略收细，缠了一小段藤条并带两片叶子。
      // 木头用暖棕色（不是通用的灰），否则和灰色石板地面糊在一起。
      fill(tint ?? '#4a3420');
      roundedRectPath(ctx, -9, -3.6, 20, 7.2, 2.4);
      ctx.fill();
      fill(tint ?? '#8a6237');
      ctx.beginPath();
      ctx.moveTo(-6, -3.9);
      ctx.lineTo(43, -2.4);
      ctx.quadraticCurveTo(49, -1.5, 49, 0);
      ctx.quadraticCurveTo(49, 1.5, 43, 2.4);
      ctx.lineTo(-6, 3.9);
      ctx.closePath();
      ctx.fill();
      fill(tint ?? '#b98a4e');
      ctx.beginPath();
      ctx.moveTo(-6, -3.2);
      ctx.lineTo(43, -2.1);
      ctx.lineTo(43, -0.4);
      ctx.lineTo(-6, -0.9);
      ctx.closePath();
      ctx.fill();
      // 木纹
      ctx.strokeStyle = tint ?? '#5c4026';
      ctx.lineWidth = 0.9;
      for (const oy of [1, 2.4]) {
        ctx.beginPath();
        ctx.moveTo(2, oy);
        ctx.lineTo(40, oy * 0.6);
        ctx.stroke();
      }
      // 藤条 + 叶
      fill(tint ?? '#6f8f3a');
      ctx.fillRect(6, -5, 12, 2);
      fill(tint ?? '#7fbf46');
      ellipsePath(ctx, 30, -6.6, 5.4, 2.4, -0.6);
      ctx.fill();
      ellipsePath(ctx, 37.5, -9.2, 4.6, 2.1, -0.35);
      ctx.fill();
      break;
    }
    case 'long_spear': {
      // 长枪：全场最长的一把，护环之后是叶形枪刃，柄上挂一面旗（史诗感来源）。
      // 旗先画，压在枪杆下面。
      fill(accent);
      ctx.globalAlpha = tint ? 1 : 0.9;
      ctx.beginPath();
      ctx.moveTo(50, -3.2);
      ctx.quadraticCurveTo(26, -16, 4, -9.4);
      ctx.quadraticCurveTo(24, -5.4, 50, 2.4);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      // 枪杆
      fill(dark);
      roundedRectPath(ctx, -12, -2.8, 66, 5.6, 2.4);
      ctx.fill();
      fill(metalLight);
      roundedRectPath(ctx, -12, -2.8, 66, 2.2, 1.1);
      ctx.fill();
      // 缠绳握位
      fill(accent);
      for (let i = 0; i < 3; i++) ctx.fillRect(-7 + i * 5.5, -3.6, 2.2, 7.2);
      // 护环
      fill(metal);
      roundedRectPath(ctx, 49, -4.6, 7, 9.2, 2.4);
      ctx.fill();
      // 枪刃
      fill(metalLight);
      ctx.beginPath();
      ctx.moveTo(56, -5);
      ctx.quadraticCurveTo(72, -7, 84, 0);
      ctx.quadraticCurveTo(72, 7, 56, 5);
      ctx.closePath();
      ctx.fill();
      fill(metal);
      ctx.beginPath();
      ctx.moveTo(58, -3.2);
      ctx.quadraticCurveTo(70, -4.4, 79, 0);
      ctx.quadraticCurveTo(70, 0.6, 58, 1.2);
      ctx.closePath();
      ctx.fill();
      // 血槽
      ctx.strokeStyle = tint ?? dark;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(58, 0);
      ctx.lineTo(80, 0);
      ctx.stroke();
      break;
    }
    default:
      fill(metal);
      roundedRectPath(ctx, -2, -6, 26, 10, 3);
      ctx.fill();
      break;
  }
  void stroke;
  ctx.restore();
}

// -------------------------------------------------------------- 近战挥砍姿态

/**
 * 近战武器的持械姿态（需求 21）。
 *
 * - **横扫类**（咸鱼 / 狼牙棒 / 木棍）：绕手部旋转，从「抬到身后」扫到「收在身前」。
 * - **突刺类**（`swingArc` 很窄的长枪）：不旋转，而是沿瞄准方向先回撤蓄力、再猛地前推。
 *
 * 判定依据是数据里的 `swingArc` —— 想把某把武器改成突刺，把它的张角压窄即可，
 * 渲染这边不需要再加特例。
 */
function meleeWeaponPose(player: Player): { rotate: number; push: number } {
  const p = player.meleeSwingProgress;
  if (p === null) return { rotate: 0, push: 0 };
  const def = player.currentWeapon.def;
  if (def.kind !== 'melee') return { rotate: 0, push: 0 };
  if ((def.swingArc ?? 1.2) < 0.8) {
    // 突刺：0~0.22 回撤，0.22~0.62 前推到底，之后缓慢收回
    const back = p < 0.22 ? -0.5 * (p / 0.22) : 0;
    const out = p <= 0.22 ? 0 : p < 0.62 ? easeOutCubic((p - 0.22) / 0.4) : 1 - (p - 0.62) / 0.38;
    return { rotate: 0, push: (back + out) * 26 };
  }
  return { rotate: lerp(-1.32, 0.92, easeOutCubic(p)), push: 0 };
}

/**
 * 把「挥砍姿态」叠到已经 `rotate(aim)` 过的手部坐标系上。
 * 枪械的 `pose` 恒为零，等于什么都没做 —— 原有 8 把武器的绘制路径完全不变。
 */
function applyWeaponPose(ctx: CanvasRenderingContext2D, player: Player): void {
  const pose = meleeWeaponPose(player);
  if (pose.push !== 0) ctx.translate(pose.push, 0);
  if (pose.rotate !== 0) ctx.rotate(pose.rotate);
}

/**
 * 近战挥砍的弧光：横扫画一瓣"气浪"扇面 + 一道前缘亮线，突刺画一道向前收窄的尖光。
 *
 * 只在挥砍窗口内出现（`meleeSwingProgress === null` 时立刻返回，非近战零开销），
 * 并用 `lighter` 叠加 —— 目的是让它看起来像光线而不是一块实心色块。
 * 必须在**玩家已 translate 到原点**、且尚未按朝向旋转的坐标系里调用。
 */
function drawMeleeSwingArc(ctx: CanvasRenderingContext2D, player: Player, aim: number): void {
  const def = player.currentWeapon.def;
  if (def.kind !== 'melee') return;
  const p = player.meleeSwingProgress;
  if (p === null) return;

  const fade = 1 - p;
  const inner = player.radius * 0.5;
  const outer = (def.range + player.radius * 0.45) * player.mods.rangeMul;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  if ((def.swingArc ?? 1.2) < 0.8) {
    const reach = inner + (outer - inner) * easeOutCubic(clamp((p - 0.18) / 0.44, 0, 1));
    const ex = Math.cos(aim) * reach;
    const ey = Math.sin(aim) * reach;
    const g = ctx.createLinearGradient(Math.cos(aim) * inner, Math.sin(aim) * inner, ex, ey);
    g.addColorStop(0, withAlpha(def.colors.glow, 0));
    g.addColorStop(0.6, withAlpha(def.colors.glow, 0.3 * fade));
    g.addColorStop(1, withAlpha(def.colors.core, 0.62 * fade));
    ctx.strokeStyle = g;
    ctx.lineCap = 'round';
    ctx.lineWidth = 10 * (0.45 + fade * 0.75);
    ctx.beginPath();
    ctx.moveTo(Math.cos(aim) * inner, Math.sin(aim) * inner);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  } else {
    const half = (def.swingArc ?? 1.2) * 0.5 + 0.2;
    const a0 = aim - half;
    const cur = a0 + half * 2 * easeOutCubic(p);
    const g = ctx.createRadialGradient(0, 0, inner, 0, 0, outer);
    g.addColorStop(0, withAlpha(def.colors.glow, 0));
    g.addColorStop(0.5, withAlpha(def.colors.glow, 0.26 * fade));
    g.addColorStop(1, withAlpha(def.colors.core, 0.08 * fade));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, outer, a0, cur);
    ctx.arc(0, 0, inner, cur, a0, true);
    ctx.closePath();
    ctx.fill();
    // 前缘亮线：挥到哪儿一目了然
    ctx.strokeStyle = withAlpha(def.colors.core, 0.8 * fade);
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.moveTo(Math.cos(cur) * inner, Math.sin(cur) * inner);
    ctx.lineTo(Math.cos(cur) * outer, Math.sin(cur) * outer);
    ctx.stroke();
  }
  ctx.restore();
}

// ------------------------------------------------------------------ 玩家

const FLASH_PAL: CharacterPalette = {
  primary: '#ffffff',
  secondary: '#ffffff',
  accent: '#ffffff',
  skin: '#ffffff',
  cape: '#ffffff',
  glow: '#ffffff',
};

export function drawPlayer(
  ctx: CanvasRenderingContext2D,
  player: Player,
  time: number,
  paletteOverride?: CharacterPalette,
  alphaOverride?: number,
): void {
  const def = player.def;
  const pal = paletteOverride ?? def.palette;
  const r = player.radius;
  const x = player.x;
  const y = player.y;

  const flash = player.hitFlash > 0;
  const blink = player.iframe > 0 && !player.dead && Math.floor(time * 22) % 2 === 0;

  ctx.save();
  if (alphaOverride !== undefined) ctx.globalAlpha = alphaOverride;
  if (blink) ctx.globalAlpha *= 0.45;

  const dead = player.dead;
  const deathT = clamp(player.deathTimer / 0.9, 0, 1);

  ctx.save();
  ctx.translate(x, y);
  if (dead) {
    ctx.rotate(deathT * 0.9);
    ctx.globalAlpha *= 1 - deathT * 0.55;
  }

  // 影子
  drawShadow(ctx, 0, r * 0.78, r * 0.95, r * 0.42, dead ? 0.18 : 0.34);

  const bounce = player.moving ? Math.sin(player.walkPhase * 2) * 1.6 : Math.sin(time * 2.4) * 0.8;
  const aim = player.visualAimAngle;

  // 近战挥砍弧光：贴在影子之上、身体之下，看起来就是"从角色身前扫出去的一道光"。
  // 非近战武器在这里直接返回，等于没有这一段。
  if (!dead) drawMeleeSwingArc(ctx, player, aim);

  // ---------------------------------------------------------------- 立绘分支
  // 配了 `sprite` 的角色（噜噜 / 肥嘟袋鼠）直接画抠好背景的位图。
  // 立绘还没加载完时 `getCharacterSprite` 返回 null → 落到下面的矢量分支，
  // 所以不会出现"半透明空档"。武器 / 轮廓光 / 护盾 / 受击闪白仍然照常叠加。
  const sprite = paletteOverride ? null : getCharacterSprite(def);
  if (sprite && !flash) {
    // 立绘只用"正面站姿"这一张。朝向、走动、呼吸全靠变换做，
    // 目的是让它和矢量角色**看起来是同一个游戏里的单位**，而不是一张贴纸。
    const facing = Math.cos(aim) < 0 ? -1 : 1;
    // 竖向：和矢量角色对齐 —— 脚底落在影子处（y = r*0.78），头顶取统一的 PLAYER_SPRITE_H。
    // 宽度**按图片自身宽高比**算，绝不写死，否则不同体型的角色会被拉扁/拉长。
    const footY = r * 0.82;
    const scaleK = r / PLAYER_RADIUS;
    const h = PLAYER_SPRITE_H * scaleK;
    const w = h * (sprite.img.naturalWidth / sprite.img.naturalHeight);

    ctx.save();
    ctx.translate(0, bounce * 0.6);
    ctx.scale(facing, 1);

    // 走动时：轻微的"压缩-拉伸"呼吸感（squash & stretch），静止时缓慢起伏。
    const step = Math.sin(player.walkPhase * 2);
    const squash = player.moving ? 1 - step * 0.035 : 1 + Math.sin(time * 2.4) * 0.012;
    const lean = player.moving ? step * 0.055 : Math.sin(time * 1.8) * 0.02;
    ctx.rotate(lean);
    ctx.scale(1 / squash, squash);

    ctx.drawImage(sprite.img, -w / 2, footY - h, w, h);
    ctx.restore();

    // 手里那把枪也要画 —— 否则立绘角色开枪时看不出武器。
    // 用和矢量分支一样的锚点，保证两种渲染方式下手感一致。
    const recoilOffset = -player.currentWeapon.recoil * (5 + player.currentWeapon.def.recoil * 10);
    const handDist = r * 0.86 + recoilOffset;
    // 立绘的"手"大约在身体下方 0.35h 处，所以武器挂在略低一点的位置。
    const hx = Math.cos(aim) * handDist;
    const hy = Math.sin(aim) * handDist * 0.9 + bounce + r * 0.12;
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(aim);
    applyWeaponPose(ctx, player);
    drawWeaponShape(ctx, player.currentWeapon.def, 0.92, flash ? '#ffffff' : undefined);
    ctx.restore();

    ctx.restore(); // translate

    // 轮廓光（沿用角色配色，让立绘和场景融进同一个光照里）
    if (!dead) {
      rimLight(ctx, x, y + bounce, r * 0.95, r * 1.05, pal.glow, flash ? 0.85 : 0.3, 0, Math.PI * 0.75, Math.PI * 1.6);
    }
    drawPlayerOverlays(ctx, player, x, y, r, pal, time, flash, dead);
    ctx.restore();
    return;
  }
  // ------------------------------------------------------------ 立绘分支结束

  // 披风 / 背包（在身体后方）
  ctx.save();
  ctx.rotate(aim + Math.PI);
  const capeSway = Math.sin(time * 4.6 + player.walkPhase) * 0.16 + (player.moving ? 0.22 : 0);
  ctx.rotate(-capeSway);
  ctx.fillStyle = flash ? pal.cape : darken(pal.cape, 0.12);
  ctx.beginPath();
  ctx.moveTo(-r * 0.5, -r * 0.78);
  ctx.quadraticCurveTo(-r * 1.5, 0, -r * 0.35, r * 0.86);
  ctx.quadraticCurveTo(-r * 0.1, r * 0.2, -r * 0.5, -r * 0.78);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 腿
  const legSwing = player.moving ? Math.sin(player.walkPhase * 2) * r * 0.42 : 0;
  const perp = aim + Math.PI / 2;
  ctx.fillStyle = flash ? '#ffffff' : darken(pal.secondary, 0.28);
  for (const side of [-1, 1]) {
    const off = legSwing * side;
    const lx = Math.cos(perp) * r * 0.42 + Math.cos(aim) * off;
    const ly = Math.sin(perp) * r * 0.42 + Math.sin(aim) * off + r * 0.5;
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(aim);
    roundedRectPath(ctx, -r * 0.26, -r * 0.24, r * 0.62, r * 0.48, r * 0.2);
    ctx.fill();
    ctx.restore();
  }

  // 躯干
  ctx.save();
  ctx.translate(0, bounce);
  ctx.fillStyle = flash ? '#ffffff' : bodyGradient(ctx, 0, 0, r, r * 1.02, pal.primary);
  ellipsePath(ctx, 0, 0, r * 0.9, r * 1.02);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = flash ? '#ffffff' : darken(pal.secondary, 0.42);
  ctx.stroke();

  // 胸甲高光
  ctx.globalAlpha = 0.42;
  ctx.fillStyle = lighten(pal.primary, 0.6);
  ellipsePath(ctx, -r * 0.2, -r * 0.34, r * 0.44, r * 0.3, -0.4);
  ctx.fill();
  ctx.globalAlpha = 1;

  // 肩甲
  ctx.fillStyle = flash ? '#ffffff' : pal.secondary;
  for (const side of [-1, 1]) {
    const sx = Math.cos(perp) * r * 0.72 * side;
    const sy = Math.sin(perp) * r * 0.72 * side + r * 0.06;
    ellipsePath(ctx, sx, sy, r * 0.34, r * 0.3, aim);
    ctx.fill();
  }

  // 头
  const headY = -r * 0.62 + bounce * 0.3;
  ctx.fillStyle = flash ? '#ffffff' : bodyGradient(ctx, 0, headY, r * 0.5, r * 0.5, pal.skin);
  ellipsePath(ctx, 0, headY, r * 0.5, r * 0.5);
  ctx.fill();
  ctx.strokeStyle = flash ? '#ffffff' : darken(pal.skin, 0.5);
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // 头盔
  ctx.fillStyle = flash ? '#ffffff' : bodyGradient(ctx, 0, headY - 2, r * 0.52, r * 0.42, pal.secondary);
  ctx.beginPath();
  ctx.ellipse(0, headY - r * 0.06, r * 0.53, r * 0.46, 0, Math.PI, TAU);
  ctx.closePath();
  ctx.fill();

  // 面罩（朝向瞄准方向）
  ctx.save();
  ctx.translate(0, headY);
  ctx.rotate(aim);
  ctx.fillStyle = flash ? '#ffffff' : pal.accent;
  ctx.globalAlpha = flash ? 1 : 0.95;
  roundedRectPath(ctx, r * 0.12, -r * 0.14, r * 0.42, r * 0.28, r * 0.1);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  ctx.arc(r * 0.42, 0, r * 0.06, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();

  // 头盔顶饰
  ctx.fillStyle = flash ? '#ffffff' : pal.accent;
  ctx.beginPath();
  ctx.moveTo(-r * 0.1, headY - r * 0.5);
  ctx.quadraticCurveTo(-r * 0.5, headY - r * 0.85, -r * 0.62, headY - r * 0.3);
  ctx.quadraticCurveTo(-r * 0.36, headY - r * 0.5, -r * 0.1, headY - r * 0.36);
  ctx.closePath();
  ctx.fill();

  ctx.restore(); // 躯干

  // 持枪手臂 + 武器
  const recoilOffset = -player.currentWeapon.recoil * (5 + player.currentWeapon.def.recoil * 10);
  const handDist = r * 0.86 + recoilOffset;
  const hx = Math.cos(aim) * handDist;
  const hy = Math.sin(aim) * handDist * 0.9 + bounce;
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(aim);
  applyWeaponPose(ctx, player);
  drawWeaponShape(ctx, player.currentWeapon.def, 0.92 * (player.currentWeapon.def.heldScale ?? 1), flash ? '#ffffff' : undefined);
  ctx.restore();

  // 前臂
  ctx.fillStyle = flash ? '#ffffff' : darken(pal.skin, 0.18);
  ctx.save();
  ctx.translate(hx * 0.5, hy * 0.5 + bounce * 0.4);
  ctx.rotate(aim);
  roundedRectPath(ctx, -r * 0.3, -r * 0.17, r * 0.62, r * 0.34, r * 0.16);
  ctx.fill();
  ctx.restore();

  // 后臂
  ctx.fillStyle = flash ? '#ffffff' : darken(pal.skin, 0.3);
  ctx.save();
  ctx.translate(Math.cos(aim - 1.1) * r * 0.5, Math.sin(aim - 1.1) * r * 0.5 + bounce * 0.6);
  ctx.rotate(aim);
  roundedRectPath(ctx, -r * 0.24, -r * 0.15, r * 0.52, r * 0.3, r * 0.14);
  ctx.fill();
  ctx.restore();

  ctx.restore(); // translate

  // 轮廓光
  if (!dead) {
    rimLight(ctx, x, y + bounce, r * 0.9, r * 1.0, pal.glow, flash ? 0.85 : 0.36, 0, Math.PI * 0.75, Math.PI * 1.6);
  }

  drawPlayerOverlays(ctx, player, x, y, r, pal, time, flash, dead);

  ctx.restore();
  void FLASH_PAL;
}

/**
 * 角色身上的"附加层"：护盾 / 壁垒光环、超载特效、受击闪白。
 * 矢量小人和立绘两条渲染路径共用 —— 抽出来是为了让两条路都别忘了画护盾。
 */
function drawPlayerOverlays(
  ctx: CanvasRenderingContext2D,
  player: Player,
  x: number,
  y: number,
  r: number,
  pal: CharacterPalette,
  time: number,
  flash: boolean,
  dead: boolean,
): void {
  void pal;
  // 护盾 / 壁垒
  const totalShield = player.shield + player.barrier;
  if (totalShield > 0.5) {
    const pulse = 0.28 + Math.sin(time * 5) * 0.06;
    ctx.save();
    const barrierVisible = player.barrier > 0.5;
    const shieldColor = barrierVisible ? '#7ef2c0' : '#9fd8ff';
    ctx.globalAlpha = clamp(pulse + totalShield / 320, 0.18, 0.62);
    ctx.strokeStyle = shieldColor;
    ctx.lineWidth = 2.6;
    ellipsePath(ctx, x, y, r * 1.5, r * 1.6);
    ctx.stroke();
    const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 1.6);
    g.addColorStop(0, withAlpha(shieldColor, 0));
    g.addColorStop(0.72, withAlpha(shieldColor, 0.18));
    g.addColorStop(1, withAlpha(shieldColor, 0));
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ellipsePath(ctx, x, y, r * 1.6, r * 1.7);
    ctx.fill();
    ctx.restore();
  }

  // 技能生效特效
  if (player.skillActiveTimer > 0 && player.def.skill.kind === 'overdrive') {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#ffd070';
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      const rr = r * (1.2 + i * 0.28) + Math.sin(time * 9 + i) * 2;
      ellipsePath(ctx, x, y - i * 3, rr, rr * 0.55);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 受击闪白
  if (flash && !dead) {
    ctx.save();
    ctx.globalAlpha = clamp(player.hitFlash / 0.24, 0, 1) * 0.5;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#ffffff';
    ellipsePath(ctx, x, y, r * 1.0, r * 1.14);
    ctx.fill();
    ctx.restore();
  }
}

// ------------------------------------------------------------------ 敌人

export function drawEnemy(ctx: CanvasRenderingContext2D, enemy: Enemy, time: number): void {
  const def = enemy.def;
  const r = enemy.radius;
  const pal = def.palette;
  const flash = enemy.hitFlash > 0;
  const spawnT = clamp(enemy.spawnTimer / 0.45, 0, 1);
  const deadT = clamp(enemy.deathTimer / 0.55, 0, 1);

  ctx.save();
  ctx.translate(enemy.x, enemy.y);
  if (enemy.dead) {
    ctx.globalAlpha = 1 - deadT;
    ctx.scale(1 + deadT * 0.35, 1 - deadT * 0.35);
    ctx.rotate(deadT * 0.5);
  } else if (spawnT > 0) {
    // 刷怪时的召唤动画
    const s = 1 - spawnT;
    ctx.scale(0.4 + s * 0.6, 0.4 + s * 0.6);
    ctx.globalAlpha = 0.35 + s * 0.65;
  } else {
    ctx.scale(1 + (1 - clamp(enemy.telegraph, 0, 1)) * 0 + enemy.telegraph * 0.05, 1 + enemy.telegraph * 0.05);
  }

  const bob = Math.sin(enemy.animTime * 3.4) * 1.5;
  const bobY = def.shape === 'sentinel' || def.shape === 'orbiter' || def.shape === 'gazer' ? bob * 2 : bob * 0.4;

  drawShadow(ctx, 0, r * 0.8, r * 0.98, r * 0.4, enemy.dead ? 0.15 : 0.34);

  ctx.save();
  ctx.translate(0, bobY);
  // 位图分支：带 sprite 的敌人（豆包召唤的"伙伴"等）直接画抠好的角色立绘，跳过矢量绘制
  const spriteEntry = def.sprite ? getCharacterSprite({ sprite: def.sprite } as CharacterDef) : null;
  if (spriteEntry) {
    const drawH = r * 2.25;
    const drawW = drawH * (spriteEntry.img.naturalWidth / spriteEntry.img.naturalHeight);
    ctx.drawImage(spriteEntry.img, -drawW / 2, -drawH / 2, drawW, drawH);
    if (flash) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = clamp(enemy.hitFlash / 0.16, 0, 1) * 0.5;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-drawW / 2, -drawH / 2, drawW, drawH);
      ctx.restore();
    }
  } else {
    switch (def.shape) {
    case 'grub':
      drawGrub(ctx, r, pal, enemy, flash, time);
      break;
    case 'sentinel':
      drawSentinel(ctx, r, pal, enemy, flash, time);
      break;
    case 'triad':
      drawTriad(ctx, r, pal, enemy, flash, time);
      break;
    case 'weaver':
      drawWeaver(ctx, r, pal, enemy, flash, time);
      break;
    case 'orbiter':
      drawOrbiter(ctx, r, pal, enemy, flash, time);
      break;
    case 'charger':
      drawCharger(ctx, r, pal, enemy, flash, time);
      break;
    case 'gazer':
      drawGazer(ctx, r, pal, enemy, flash, time);
      break;
    case 'brute':
      drawBrute(ctx, r, pal, enemy, flash, time);
      break;
  }
  }
  ctx.restore();

  // 前摇预警光环（给玩家反应时间）
  if (enemy.state === 'windup' && enemy.telegraph > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.25 + enemy.telegraph * 0.45;
    ctx.strokeStyle = pal.glow;
    ctx.lineWidth = 2.4;
    const rr = r * (1.35 + (1 - enemy.telegraph) * 0.9);
    ellipsePath(ctx, 0, r * 0.2, rr, rr * 0.62);
    ctx.stroke();
    ctx.restore();
  }

  // 燃烧状态
  if (enemy.burnTimer > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5 + Math.sin(time * 20) * 0.14;
    ctx.strokeStyle = '#ff9a3c';
    ctx.lineWidth = 2;
    ellipsePath(ctx, 0, 0, r * 1.2, r * 1.15);
    ctx.stroke();
    ctx.restore();
  }

  // 精英标记
  if (def.elite && !enemy.dead) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.35 + Math.sin(time * 3) * 0.1;
    ctx.strokeStyle = pal.glow;
    ctx.lineWidth = 2.4;
    ellipsePath(ctx, 0, r * 0.1, r * 1.5, r * 1.42);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();

  // 受击闪白
  if (flash && !enemy.dead) {
    ctx.save();
    ctx.globalAlpha = clamp(enemy.hitFlash / 0.16, 0, 1) * 0.55;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#ffffff';
    ellipsePath(ctx, enemy.x, enemy.y, r * 1.02, r * 1.05);
    ctx.fill();
    ctx.restore();
  }

  // 妖物血条（需求 23）：小怪与精英统一在头顶显示；精英条更粗、描金边区分。
  if (!enemy.dead && enemy.spawnTimer <= 0) {
    drawEnemyHealthBar(ctx, enemy.x, enemy.y, r, clamp(enemy.hp / Math.max(1, enemy.maxHp), 0, 1), def.elite);
  }
}

/**
 * 敌人头顶血条。
 * 小怪：细红条；精英：更粗 + 金色描边 + 金色血量（和场上的精英光环同色系）。
 * 位置随 `radius` 上浮，保证不同体型敌人都贴在"头顶"。
 */
function drawEnemyHealthBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  ratio: number,
  elite: boolean,
): void {
  const w = Math.max(24, r * 2.1);
  const h = elite ? 5 : 3.5;
  const left = x - w / 2;
  const top = y - r * (elite ? 1.95 : 1.7);
  ctx.save();
  // 背板
  ctx.fillStyle = 'rgba(6,8,14,0.72)';
  ctx.fillRect(left - 1, top - 1, w + 2, h + 2);
  // 边框
  ctx.lineWidth = 1;
  ctx.strokeStyle = elite ? 'rgba(255,206,90,0.9)' : 'rgba(255,255,255,0.28)';
  ctx.strokeRect(left - 1.5, top - 1.5, w + 3, h + 3);
  // 血量
  if (ratio > 0) {
    ctx.fillStyle = elite ? '#ffce4d' : '#ff5140';
    ctx.fillRect(left, top, w * ratio, h);
  }
  ctx.restore();
}

type Pal = { body: string; dark: string; accent: string; glow: string };

function drawGrub(
  ctx: CanvasRenderingContext2D,
  r: number,
  pal: Pal,
  e: Enemy,
  flash: boolean,
  time: number,
): void {
  const wiggle = Math.sin(e.animTime * 9) * 0.14;
  const segs = 3;
  for (let i = 0; i < segs; i++) {
    const t = i / (segs - 1);
    const rr = r * (1 - t * 0.32);
    const off = i * r * 0.52;
    ctx.save();
    ctx.translate(-off, Math.sin(e.animTime * 9 + i * 0.9) * r * 0.16);
    ctx.fillStyle = flash ? '#ffffff' : bodyGradient(ctx, 0, 0, rr, rr, mixHex(pal.body, pal.dark, t * 0.7));
    ellipsePath(ctx, 0, 0, rr, rr * 0.92, wiggle);
    ctx.fill();
    ctx.strokeStyle = flash ? '#ffffff' : darken(pal.dark, 0.3);
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  }
  // 头
  ctx.save();
  ctx.translate(r * 0.55, 0);
  ctx.fillStyle = flash ? '#ffffff' : bodyGradient(ctx, 0, 0, r * 0.86, r * 0.8, pal.body);
  ellipsePath(ctx, 0, 0, r * 0.86, r * 0.8);
  ctx.fill();
  ctx.strokeStyle = darken(pal.dark, 0.4);
  ctx.lineWidth = 1.6;
  ctx.stroke();
  // 口器
  ctx.fillStyle = flash ? '#ffffff' : pal.accent;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(r * 0.6, s * r * 0.3);
    ctx.lineTo(r * 1.3, s * r * 0.05);
    ctx.lineTo(r * 0.6, s * r * 0.62);
    ctx.closePath();
    ctx.fill();
  }
  // 眼睛
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = pal.glow;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(r * 0.34, s * r * 0.32, r * 0.15, 0, TAU);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
  // 尖刺
  ctx.fillStyle = flash ? '#ffffff' : darken(pal.accent, 0.2);
  for (let i = 0; i < 4; i++) {
    const a = -0.9 + i * 0.6;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5);
    ctx.lineTo(Math.cos(a) * r * 1.35, Math.sin(a) * r * 1.35);
    ctx.lineTo(Math.cos(a + 0.28) * r * 0.6, Math.sin(a + 0.28) * r * 0.6);
    ctx.closePath();
    ctx.fill();
  }
  void time;
}

function drawSentinel(
  ctx: CanvasRenderingContext2D,
  r: number,
  pal: Pal,
  e: Enemy,
  flash: boolean,
  time: number,
): void {
  // 悬浮石座
  ctx.fillStyle = flash ? '#ffffff' : bodyGradient(ctx, 0, 0, r, r * 1.1, pal.body);
  ctx.beginPath();
  ctx.moveTo(-r * 0.9, -r * 0.5);
  ctx.lineTo(r * 0.9, -r * 0.5);
  ctx.lineTo(r * 0.66, r * 0.8);
  ctx.lineTo(0, r * 1.05);
  ctx.lineTo(-r * 0.66, r * 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = flash ? '#ffffff' : darken(pal.dark, 0.35);
  ctx.lineWidth = 2;
  ctx.stroke();
  // 肩甲
  ctx.fillStyle = flash ? '#ffffff' : darken(pal.body, 0.28);
  for (const s of [-1, 1]) {
    ellipsePath(ctx, s * r * 0.95, -r * 0.2, r * 0.42, r * 0.34, s * 0.3);
    ctx.fill();
  }
  // 单眼
  const pulse = 0.72 + Math.sin(time * 5) * 0.2 + e.telegraph * 0.5;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(0, -r * 0.05, 0, 0, -r * 0.05, r * 0.85);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.3, pal.glow);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = clamp(pulse, 0, 1);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, -r * 0.05, r * 0.85, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = pal.accent;
  ellipsePath(ctx, 0, -r * 0.05, r * 0.26, r * 0.2);
  ctx.fill();
  ctx.restore();
  // 裂纹
  ctx.strokeStyle = flash ? '#ffffff' : darken(pal.dark, 0.5);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-r * 0.4, r * 0.1);
  ctx.lineTo(-r * 0.1, r * 0.36);
  ctx.lineTo(r * 0.2, r * 0.2);
  ctx.lineTo(r * 0.5, r * 0.5);
  ctx.stroke();
  // 悬浮碎石
  for (let i = 0; i < 3; i++) {
    const a = e.animTime * 1.4 + (i / 3) * TAU;
    ctx.fillStyle = flash ? '#ffffff' : darken(pal.body, 0.15);
    ctx.beginPath();
    ctx.arc(Math.cos(a) * r * 1.35, Math.sin(a) * r * 0.5 + r * 0.5, r * 0.14, 0, TAU);
    ctx.fill();
  }
}

function drawTriad(
  ctx: CanvasRenderingContext2D,
  r: number,
  pal: Pal,
  e: Enemy,
  flash: boolean,
  time: number,
): void {
  // 底座
  ctx.fillStyle = flash ? '#ffffff' : bodyGradient(ctx, 0, 0, r * 0.8, r * 1.2, pal.dark);
  roundedRectPath(ctx, -r * 0.62, -r * 0.9, r * 1.24, r * 1.9, r * 0.24);
  ctx.fill();
  ctx.strokeStyle = flash ? '#ffffff' : darken(pal.dark, 0.4);
  ctx.lineWidth = 1.8;
  ctx.stroke();
  // 三张脸
  const active = Math.floor((e.animTime * 2.2) % 3);
  for (let i = 0; i < 3; i++) {
    const y = -r * 0.5 + i * r * 0.55;
    ctx.save();
    ctx.translate(0, y);
    ctx.fillStyle = flash ? '#ffffff' : bodyGradient(ctx, 0, 0, r * 0.42, r * 0.36, pal.body);
    ellipsePath(ctx, 0, 0, r * 0.46, r * 0.4);
    ctx.fill();
    ctx.strokeStyle = darken(pal.dark, 0.35);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    const lit = i === active && !e.dead;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = lit ? 0.9 : 0.35;
    ctx.fillStyle = pal.glow;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * r * 0.17, -r * 0.04, r * 0.1, 0, TAU);
      ctx.fill();
    }
    if (lit) {
      ctx.globalAlpha = 0.6 + Math.sin(time * 12) * 0.2;
      ctx.beginPath();
      ctx.arc(0, r * 0.14, r * 0.11, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    ctx.restore();
  }
  // 手臂 + 小炮
  ctx.save();
  ctx.rotate(Math.sin(e.animTime * 2) * 0.1);
  ctx.fillStyle = flash ? '#ffffff' : darken(pal.body, 0.2);
  for (const s of [-1, 1]) {
    ctx.save();
    ctx.translate(s * r * 0.72, r * 0.1);
    roundedRectPath(ctx, s > 0 ? 0 : -r * 0.5, -r * 0.12, r * 0.5, r * 0.24, r * 0.1);
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = flash ? '#ffffff' : pal.dark;
  roundedRectPath(ctx, r * 1.0, -r * 0.16, r * 0.6, r * 0.32, r * 0.1);
  ctx.fill();
  ctx.restore();
}

function drawWeaver(
  ctx: CanvasRenderingContext2D,
  r: number,
  pal: Pal,
  e: Enemy,
  flash: boolean,
  time: number,
): void {
  // 腿
  ctx.strokeStyle = flash ? '#ffffff' : darken(pal.dark, 0.3);
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + Math.sin(e.animTime * 6 + i) * 0.16;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.5 + Math.sin(e.animTime * 8 + i) * 2);
    ctx.lineTo(Math.cos(a) * r * 1.7, Math.sin(a) * r * 0.95 + r * 0.3);
    ctx.stroke();
  }
  // 腹部
  ctx.fillStyle = flash ? '#ffffff' : bodyGradient(ctx, 0, 0, r * 1.15, r * 1.0, pal.body);
  ellipsePath(ctx, -r * 0.2, r * 0.1, r * 1.1, r * 0.92);
  ctx.fill();
  ctx.strokeStyle = darken(pal.dark, 0.35);
  ctx.lineWidth = 1.8;
  ctx.stroke();
  // 花纹
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = pal.accent;
  for (let i = 0; i < 3; i++) {
    ellipsePath(ctx, -r * 0.4 + i * r * 0.34, r * 0.05 + i * r * 0.12, r * 0.16, r * 0.1, 0.4);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // 前部发射器
  ctx.save();
  ctx.translate(r * 0.72, -r * 0.1);
  ctx.fillStyle = flash ? '#ffffff' : darken(pal.dark, 0.2);
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.5);
  ctx.lineTo(r * 0.9, -r * 0.9);
  ctx.lineTo(r * 0.9, r * 0.9);
  ctx.lineTo(0, r * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // 眼
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = pal.glow;
  const eyePulse = 0.7 + Math.sin(time * 7) * 0.25 + e.telegraph * 0.6;
  ctx.globalAlpha = clamp(eyePulse, 0, 1);
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(r * 0.3, -r * 0.3 + i * r * 0.22, r * 0.1, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawOrbiter(
  ctx: CanvasRenderingContext2D,
  r: number,
  pal: Pal,
  e: Enemy,
  flash: boolean,
  time: number,
): void {
  const rot = e.animTime * (e.state === 'windup' ? 3.4 : e.state === 'attack' ? 6 : 1.2);
  // 外环
  ctx.save();
  ctx.rotate(rot);
  ctx.strokeStyle = flash ? '#ffffff' : bodyGradient(ctx, 0, -r, r, r, pal.body);
  ctx.lineWidth = r * 0.42;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 1.25, r * 1.25, 0, 0, TAU);
  ctx.stroke();
  ctx.strokeStyle = darken(pal.dark, 0.3);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 1.46, r * 1.46, 0, 0, TAU);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 1.04, r * 1.04, 0, 0, TAU);
  ctx.stroke();
  // 卫星
  ctx.fillStyle = flash ? '#ffffff' : pal.accent;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    ellipsePath(ctx, Math.cos(a) * r * 1.25, Math.sin(a) * r * 1.25, r * 0.22, r * 0.22);
    ctx.fill();
  }
  ctx.restore();
  // 内核
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const pulse = 0.6 + Math.sin(time * 6) * 0.18 + e.telegraph * 0.7;
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.95);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.35, pal.glow);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = clamp(pulse, 0, 1);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.95, 0, TAU);
  ctx.fill();
  ctx.restore();
  // 内核实体
  ctx.fillStyle = flash ? '#ffffff' : bodyGradient(ctx, 0, 0, r * 0.5, r * 0.5, pal.dark);
  ellipsePath(ctx, 0, 0, r * 0.52, r * 0.52);
  ctx.fill();
  // 眼缝
  ctx.strokeStyle = pal.accent;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.34, r * 0.14, 0, 0, TAU);
  ctx.stroke();
}

function drawCharger(
  ctx: CanvasRenderingContext2D,
  r: number,
  pal: Pal,
  e: Enemy,
  flash: boolean,
  time: number,
): void {
  const charging = e.state === 'attack';
  const legSwing = Math.sin(e.animTime * (charging ? 22 : 11)) * (charging ? 0.5 : 0.26);
  // 四肢
  ctx.strokeStyle = flash ? '#ffffff' : darken(pal.dark, 0.25);
  ctx.lineWidth = r * 0.24;
  ctx.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4 + legSwing * (i % 2 === 0 ? 1 : -1);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 0.4, Math.sin(a) * r * 0.3);
    ctx.lineTo(Math.cos(a) * r * 1.15, Math.sin(a) * r * 0.8);
    ctx.stroke();
  }
  // 躯干
  ctx.fillStyle = flash ? '#ffffff' : bodyGradient(ctx, 0, 0, r * 1.1, r * 0.85, pal.body);
  ellipsePath(ctx, 0, 0, r * 1.08, r * 0.86);
  ctx.fill();
  ctx.strokeStyle = darken(pal.dark, 0.35);
  ctx.lineWidth = 2;
  ctx.stroke();
  // 背甲
  ctx.fillStyle = flash ? '#ffffff' : darken(pal.accent, 0.35);
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(-r * 0.2 - i * r * 0.34, -r * 0.6 + i * r * 0.14);
    ctx.lineTo(-r * 0.42 - i * r * 0.34, -r * 0.95 + i * r * 0.16);
    ctx.lineTo(-r * 0.5 - i * r * 0.34, -r * 0.4 + i * r * 0.14);
    ctx.closePath();
    ctx.fill();
  }
  // 头
  ctx.save();
  ctx.translate(r * 0.85, -r * 0.05);
  ctx.fillStyle = flash ? '#ffffff' : bodyGradient(ctx, 0, 0, r * 0.56, r * 0.5, mixHex(pal.body, pal.dark, 0.3));
  ellipsePath(ctx, 0, 0, r * 0.56, r * 0.5);
  ctx.fill();
  ctx.strokeStyle = darken(pal.dark, 0.4);
  ctx.lineWidth = 1.6;
  ctx.stroke();
  // 双角
  ctx.fillStyle = flash ? '#ffffff' : pal.accent;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(r * 0.2, s * r * 0.3);
    ctx.lineTo(r * 0.95, s * r * 0.78);
    ctx.lineTo(r * 0.32, s * r * 0.52);
    ctx.closePath();
    ctx.fill();
  }
  // 眼
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = charging ? '#fff2b0' : pal.glow;
  ctx.globalAlpha = charging ? 1 : 0.8;
  ctx.beginPath();
  ctx.arc(r * 0.2, -r * 0.1, r * 0.12, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
  // 冲锋尾迹
  if (charging) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = pal.glow;
    ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      const off = -r * (1.2 + i * 0.5);
      ctx.beginPath();
      ctx.moveTo(off, -r * 0.4 + i * 6);
      ctx.lineTo(off - r * 0.7, -r * 0.4 + i * 6);
      ctx.stroke();
    }
    ctx.restore();
  }
  void time;
}

function drawGazer(
  ctx: CanvasRenderingContext2D,
  r: number,
  pal: Pal,
  e: Enemy,
  flash: boolean,
  time: number,
): void {
  // 触须
  ctx.strokeStyle = flash ? '#ffffff' : darken(pal.dark, 0.2);
  ctx.lineWidth = r * 0.16;
  ctx.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU;
    const wob = Math.sin(e.animTime * 3 + i) * 0.24;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7);
    ctx.quadraticCurveTo(
      Math.cos(a + wob) * r * 1.4,
      Math.sin(a + wob) * r * 1.4,
      Math.cos(a + wob * 2) * r * 1.95,
      Math.sin(a + wob * 2) * r * 1.95,
    );
    ctx.stroke();
  }
  // 主体
  ctx.fillStyle = flash ? '#ffffff' : bodyGradient(ctx, 0, 0, r * 1.1, r * 1.1, pal.body);
  ellipsePath(ctx, 0, 0, r * 1.08, r * 1.08);
  ctx.fill();
  ctx.strokeStyle = darken(pal.dark, 0.4);
  ctx.lineWidth = 2.4;
  ctx.stroke();
  // 眼白
  ctx.fillStyle = flash ? '#ffffff' : '#e9f6ff';
  ellipsePath(ctx, 0, 0, r * 0.72, r * 0.72);
  ctx.fill();
  // 瞳孔（跟随玩家方向）
  const px = Math.cos(e.facing) * r * 0.26;
  const py = Math.sin(e.facing) * r * 0.26;
  const g = ctx.createRadialGradient(px, py, 0, px, py, r * 0.4);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.35, pal.glow);
  g.addColorStop(1, darken(pal.dark, 0.2));
  ctx.fillStyle = g;
  ellipsePath(ctx, px, py, r * 0.4, r * 0.4);
  ctx.fill();
  // 瞳孔高光
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(px - r * 0.12, py - r * 0.12, r * 0.1, 0, TAU);
  ctx.fill();
  ctx.restore();
  // 外辉光
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.22 + e.telegraph * 0.4 + Math.sin(time * 4) * 0.05;
  const rg = ctx.createRadialGradient(0, 0, r * 0.8, 0, 0, r * 2.1);
  rg.addColorStop(0, pal.glow);
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rg;
  ctx.beginPath();
  ctx.arc(0, 0, r * 2.1, 0, TAU);
  ctx.fill();
  ctx.restore();
  // 冠饰
  ctx.fillStyle = flash ? '#ffffff' : pal.accent;
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i - 2) * 0.34;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95);
    ctx.lineTo(Math.cos(a) * r * 1.45, Math.sin(a) * r * 1.45);
    ctx.lineTo(Math.cos(a + 0.16) * r * 1.0, Math.sin(a + 0.16) * r * 1.0);
    ctx.closePath();
    ctx.fill();
  }
}

function drawBrute(
  ctx: CanvasRenderingContext2D,
  r: number,
  pal: Pal,
  e: Enemy,
  flash: boolean,
  time: number,
): void {
  const charging = e.state === 'attack' && e.chargeTimer > 0;
  // 双腿
  ctx.fillStyle = flash ? '#ffffff' : darken(pal.dark, 0.2);
  const stride = charging ? Math.sin(e.animTime * 24) * 0.4 : Math.sin(e.animTime * 6) * 0.14;
  for (const s of [-1, 1]) {
    ctx.save();
    ctx.translate(s * r * 0.5, r * 0.62);
    ctx.rotate(stride * s);
    roundedRectPath(ctx, -r * 0.26, 0, r * 0.52, r * 0.7, r * 0.16);
    ctx.fill();
    ctx.restore();
  }
  // 躯干
  ctx.fillStyle = flash ? '#ffffff' : bodyGradient(ctx, 0, 0, r * 1.05, r * 0.95, pal.body);
  ctx.beginPath();
  ctx.moveTo(-r * 1.0, -r * 0.55);
  ctx.lineTo(r * 1.0, -r * 0.55);
  ctx.lineTo(r * 1.15, r * 0.35);
  ctx.lineTo(r * 0.6, r * 0.85);
  ctx.lineTo(-r * 0.6, r * 0.85);
  ctx.lineTo(-r * 1.15, r * 0.35);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = darken(pal.dark, 0.4);
  ctx.lineWidth = 2.4;
  ctx.stroke();
  // 岩浆裂缝
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const glow = 0.5 + Math.sin(time * 5) * 0.16 + e.telegraph * 0.5;
  ctx.globalAlpha = clamp(glow, 0, 1);
  ctx.strokeStyle = pal.glow;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-r * 0.7, -r * 0.2);
  ctx.lineTo(-r * 0.25, r * 0.1);
  ctx.lineTo(-r * 0.4, r * 0.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(r * 0.5, -r * 0.4);
  ctx.lineTo(r * 0.2, 0);
  ctx.lineTo(r * 0.6, r * 0.3);
  ctx.stroke();
  ctx.restore();
  // 肩甲
  ctx.fillStyle = flash ? '#ffffff' : darken(pal.body, 0.32);
  for (const s of [-1, 1]) {
    ctx.save();
    ctx.translate(s * r * 1.0, -r * 0.5);
    ctx.rotate(s * 0.2);
    ellipsePath(ctx, 0, 0, r * 0.46, r * 0.36);
    ctx.fill();
    ctx.strokeStyle = darken(pal.dark, 0.4);
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.restore();
  }
  // 头
  ctx.save();
  ctx.translate(0, -r * 0.85);
  ctx.fillStyle = flash ? '#ffffff' : bodyGradient(ctx, 0, 0, r * 0.5, r * 0.42, mixHex(pal.body, pal.dark, 0.45));
  roundedRectPath(ctx, -r * 0.5, -r * 0.36, r * 1.0, r * 0.72, r * 0.16);
  ctx.fill();
  // 眼缝
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = clamp(0.65 + e.telegraph * 0.6 + Math.sin(time * 6) * 0.12, 0, 1);
  ctx.fillStyle = charging ? '#fff0a0' : pal.glow;
  roundedRectPath(ctx, -r * 0.34, -r * 0.08, r * 0.68, r * 0.14, r * 0.06);
  ctx.fill();
  ctx.restore();
  // 角
  ctx.fillStyle = flash ? '#ffffff' : pal.accent;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(s * r * 0.44, -r * 0.3);
    ctx.lineTo(s * r * 1.05, -r * 0.95);
    ctx.lineTo(s * r * 0.5, -r * 0.05);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // 重锤臂
  ctx.save();
  ctx.rotate(charging ? -0.5 : Math.sin(e.animTime * 4) * 0.14);
  ctx.fillStyle = flash ? '#ffffff' : darken(pal.body, 0.2);
  roundedRectPath(ctx, r * 0.8, -r * 0.2, r * 1.0, r * 0.42, r * 0.16);
  ctx.fill();
  ctx.fillStyle = flash ? '#ffffff' : pal.dark;
  roundedRectPath(ctx, r * 1.7, -r * 0.55, r * 0.62, r * 1.1, r * 0.14);
  ctx.fill();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.6 + e.telegraph * 0.4;
  ctx.strokeStyle = pal.glow;
  ctx.lineWidth = 2;
  roundedRectPath(ctx, r * 1.78, -r * 0.45, r * 0.46, r * 0.9, r * 0.1);
  ctx.stroke();
  ctx.restore();
  ctx.restore();
}

// ------------------------------------------------------------------ Boss

export function drawBoss(ctx: CanvasRenderingContext2D, boss: Boss, time: number): void {
  const r = boss.radius;
  const flash = boss.hitFlash > 0;
  const deadT = clamp(boss.deathTimer / 1.4, 0, 1);
  const introT = boss.state === 'intro' ? clamp(boss.stateTime / 1.5, 0, 1) : 1;

  ctx.save();
  ctx.translate(boss.x, boss.y);
  if (boss.dead) {
    ctx.globalAlpha = 1 - deadT * 0.85;
    ctx.scale(1 + deadT * 0.6, 1 + deadT * 0.6);
    ctx.rotate(deadT * 1.4);
  } else {
    ctx.globalAlpha = introT;
    ctx.scale(0.75 + introT * 0.25, 0.75 + introT * 0.25);
  }

  // 行走状态：用实际移动速度判断 Boss 是否在"走路"（而非仅坐标变化）。
  // 位图 Boss（豆包 / DeepSeek）据此播放像人一样的走路动画：步伐弹跳 + 左右摇摆 + 挤压拉伸。
  const bossSpeed = Math.hypot(boss.vx, boss.vy);
  const bossMoving = bossSpeed > 16 && !boss.dead && boss.state !== 'intro';
  const walkPhase = boss.animTime * 8;

  // 影子随步伐轻微缩放（身体抬起时影子变小）
  const shadowScale = bossMoving ? 1 - Math.abs(Math.sin(walkPhase)) * 0.12 : 1;
  drawShadow(ctx, 0, r * 0.8, r * (1.05 * shadowScale), r * (0.42 * shadowScale), 0.4);

  // 上下起伏：静止时缓慢呼吸，移动时叠加"每步一跳"的弹跳
  let bob = Math.sin(time * 2.2) * 4;
  if (bossMoving) bob -= Math.abs(Math.sin(walkPhase)) * r * 0.11;
  ctx.translate(0, bob);

  const sprite = boss.def.sprite ? getBossSprite(boss.def) : null;
  if (sprite) {
    // 走路姿态：左右摇摆 + 前倾 + 挤压拉伸（squash & stretch），让静态立绘"走起来"
    ctx.save();
    if (bossMoving) {
      const step = Math.sin(walkPhase);
      const swayX = Math.sin(walkPhase * 0.5) * r * 0.05;
      const lean = Math.cos(walkPhase) * 0.07;
      const squash = 1 - step * 0.06;
      ctx.translate(swayX, 0);
      ctx.rotate(lean);
      ctx.scale(1 / squash, squash);
    }
    drawBossBitmap(ctx, boss, sprite, r, flash, time);
    ctx.restore();
  } else {
    drawBossProgrammatic(ctx, boss, r, flash, time);
  }

  // 受击环
  if (boss.hitFlashRing > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = boss.hitFlashRing * 0.5;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ellipsePath(ctx, 0, 0, r * (1.2 + (1 - boss.hitFlashRing) * 1.2), r * (1.15 + (1 - boss.hitFlashRing) * 1.15));
    ctx.stroke();
    ctx.restore();
  }

  // 阶段切换护盾
  if (boss.invulnTimer > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.4 + Math.sin(time * 26) * 0.16;
    ctx.strokeStyle = '#9fe8ff';
    ctx.lineWidth = 3.4;
    ellipsePath(ctx, 0, 0, r * 1.75, r * 1.7);
    ctx.stroke();
    ctx.restore();
  }

  // 扫射激光
  if (boss.beamActive) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const len = 1500;
    const ex = Math.cos(boss.beamAngle) * len;
    const ey = Math.sin(boss.beamAngle) * len;
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(${boss.def.palette.glow},1)`;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 62;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 30;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = boss.def.palette.bullet;
    ctx.lineWidth = 13 + Math.sin(time * 40) * 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();

  // 受击闪白
  if (flash) {
    ctx.save();
    ctx.globalAlpha = clamp(boss.hitFlash / 0.14, 0, 1) * 0.32;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#ffffff';
    ellipsePath(ctx, boss.x, boss.y, r * 1.1, r * 1.06);
    ctx.fill();
    ctx.restore();
  }
}

/**
 * 位图 Boss：直接把 role 里抠好的正面立绘按 `半径 × BOSS_SPRITE_SCALE` 的尺寸居中绘制。
 * 立绘是透明 PNG（drawImage 不会覆盖背景），先补一层按 Boss 配色的轻辉光，再画本体，
 * 受击时叠一层闪白。宽高比取自图片自身，绝不写死宽度。
 */
function drawBossBitmap(
  ctx: CanvasRenderingContext2D,
  boss: Boss,
  sprite: { img: HTMLImageElement; ready: boolean; failed: boolean },
  r: number,
  flash: boolean,
  _time: number,
): void {
  const drawH = r * BOSS_SPRITE_SCALE;
  const drawW = drawH * (sprite.img.naturalWidth / sprite.img.naturalHeight);

  // 立绘背后的轻辉光（用 Boss 配色）
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const rg = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, r * 2.2);
  // ⚠️ palette.glow 是 "r,g,b" 字符串（不是十六进制），不能走 withAlpha()：
  // withAlpha 会按 hex 解析 "120,190,255" → parseInt 在逗号处截断 → 得到近黑色的 rgba。
  rg.addColorStop(0, `rgba(${boss.def.palette.glow},0.3)`);
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rg;
  ctx.beginPath();
  ctx.arc(0, 0, r * 2.2, 0, TAU);
  ctx.fill();
  ctx.restore();

  // 立绘本体
  ctx.drawImage(sprite.img, -drawW / 2, -drawH / 2, drawW, drawH);

  // 受击闪白覆盖
  if (flash) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp(boss.hitFlash / 0.14, 0, 1) * 0.5;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
  }
}

/**
 * 程序化 Boss 绘制真正读到的可视状态（就这三个字段）。
 *
 * 刻意用结构化类型而不是直接收 `Boss` 实体：**图鉴**只需要画一个静止的预览，
 * 为此 new 一个 `Boss` 出来没有意义（还要跟着实体的构造逻辑走）。
 * `Boss` 天然满足这个形状，所以场景内的调用点一行都不用改。
 */
export interface BossVisualState {
  phase: number;
  plateRotation: number;
  facing: number;
}

/**
 * 程序化 Boss 绘制（第 1 层「熔核·渊心」本体，以及位图 Boss 在 PNG 缺失时的兜底）。
 * 原本是 drawBoss 的内联逻辑，抽到这里方便两种分支共用外层的变换 / 受击环 / 护盾 / 激光。
 */
function drawBossProgrammatic(
  ctx: CanvasRenderingContext2D,
  boss: BossVisualState,
  r: number,
  flash: boolean,
  time: number,
): void {
  const enraged = boss.phase >= 3;
  const coreColor = enraged ? '#ff5a2b' : boss.phase >= 2 ? '#ff9a3c' : '#ffc46a';
  const glowColor = enraged ? '#ff3a1a' : '#ff8a3c';

  // 外辉光
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const rg = ctx.createRadialGradient(0, 0, r * 0.5, 0, 0, r * 2.6);
  rg.addColorStop(0, withAlpha(glowColor, 0.45));
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rg;
  ctx.beginPath();
  ctx.arc(0, 0, r * 2.6, 0, TAU);
  ctx.fill();
  ctx.restore();

  // 旋转护甲片
  for (let ring = 0; ring < 2; ring++) {
    const count = ring === 0 ? 6 : 4;
    const radius = ring === 0 ? r * 1.22 : r * 1.62;
    const rot = boss.plateRotation * (ring === 0 ? 1 : -0.62) + (enraged ? time * 0.5 : 0);
    ctx.save();
    ctx.rotate(rot);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU;
      ctx.save();
      ctx.translate(Math.cos(a) * radius, Math.sin(a) * radius);
      ctx.rotate(a + Math.PI / 2);
      const size = ring === 0 ? r * 0.42 : r * 0.3;
      const g = ctx.createLinearGradient(0, -size, 0, size);
      g.addColorStop(0, flash ? '#ffffff' : '#6a6474');
      g.addColorStop(0.5, flash ? '#ffffff' : '#403b4c');
      g.addColorStop(1, flash ? '#ffffff' : '#241f2e');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-size * 0.7, -size);
      ctx.lineTo(size * 0.7, -size);
      ctx.lineTo(size * 0.5, size);
      ctx.lineTo(-size * 0.5, size);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#181420';
      ctx.lineWidth = 2;
      ctx.stroke();
      // 甲片上的能量刻纹
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = clamp(0.4 + Math.sin(time * 3 + i) * 0.2 + (enraged ? 0.3 : 0), 0, 1);
      ctx.strokeStyle = glowColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-size * 0.4, 0);
      ctx.lineTo(size * 0.4, 0);
      ctx.stroke();
      ctx.restore();
      ctx.restore();
    }
    ctx.restore();
  }

  // 主体
  const bodyG = ctx.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.2, 0, 0, r * 1.3);
  bodyG.addColorStop(0, flash ? '#ffffff' : '#5d5568');
  bodyG.addColorStop(0.55, flash ? '#ffffff' : '#332c40');
  bodyG.addColorStop(1, flash ? '#ffffff' : '#1a1524');
  ctx.fillStyle = bodyG;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.PI / 8;
    const px = Math.cos(a) * r;
    const py = Math.sin(a) * r * 0.96;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#120e1c';
  ctx.lineWidth = 3;
  ctx.stroke();

  // 能量核心
  const pulse = 0.68 + Math.sin(time * 5.5) * 0.16 + (enraged ? 0.25 : 0);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.95);
  cg.addColorStop(0, '#ffffff');
  cg.addColorStop(0.28, coreColor);
  cg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = clamp(pulse, 0, 1);
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.95, 0, TAU);
  ctx.fill();
  ctx.restore();

  // 核心实体
  ctx.fillStyle = flash ? '#ffffff' : '#1c1728';
  ellipsePath(ctx, 0, 0, r * 0.44, r * 0.44);
  ctx.fill();
  ctx.strokeStyle = coreColor;
  ctx.lineWidth = 2.4;
  ctx.stroke();

  // 眼球
  const px = Math.cos(boss.facing) * r * 0.14;
  const py = Math.sin(boss.facing) * r * 0.14;
  const eg = ctx.createRadialGradient(px, py, 0, px, py, r * 0.3);
  eg.addColorStop(0, '#ffffff');
  eg.addColorStop(0.4, coreColor);
  eg.addColorStop(1, '#2a1220');
  ctx.fillStyle = eg;
  ellipsePath(ctx, px, py, r * 0.3, r * 0.3);
  ctx.fill();

  // 尖刺
  ctx.fillStyle = flash ? '#ffffff' : '#4a4358';
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.PI / 8;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.88);
    ctx.lineTo(Math.cos(a) * r * 1.3, Math.sin(a) * r * 1.28);
    ctx.lineTo(Math.cos(a + 0.24) * r * 0.95, Math.sin(a + 0.24) * r * 0.93);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * 图鉴用的 Boss 立绘预览（左列表选中 → 右面板那张图）。
 *
 * 缩放口径刻意和游戏内**同一套**：先按「世界尺寸」算包围盒
 * （位图 = 半径 × `BOSS_SPRITE_SCALE`，程序化 = 半径 × 2.6），
 * 再**等比**缩放进调用方给的框里。
 * 这样图鉴里看到的身体比例就是实战里的比例，不会出现"图鉴好看、进游戏变样"。
 * 宽高比一律取自素材自身，绝不写死宽度。
 */
export function drawBossPortrait(
  ctx: CanvasRenderingContext2D,
  def: BossDef,
  cx: number,
  cy: number,
  boxW: number,
  boxH: number,
  time: number,
): void {
  const r = def.radius;
  const sprite = getBossSprite(def);
  // 「世界尺寸」= 该 Boss 在游戏内的**包围盒全宽 / 全高**（不是半径，也与绘制高不同口径）：
  //   位图：drawBossBitmap 的绘制高就是半径 × BOSS_SPRITE_SCALE，宽按素材比例；
  //   程序化：碰撞半径只是**半径**，外形还会被旋转甲片撑到约 1.92r，故全尺寸取 4r。
  // 这两者以前混用过一次 —— 程序化 Boss 的甲片直接顶到简介文字上，图里能看到压字。
  const fullH = sprite ? r * BOSS_SPRITE_SCALE : r * 4;
  const fullW = sprite ? fullH * (sprite.img.naturalWidth / sprite.img.naturalHeight) : fullH;
  // 高和宽都要装得下：宽体型的 Boss 只按高度缩放会横向溢出面板
  const scale = Math.min(boxW / Math.max(1, fullW), boxH / Math.max(1, fullH));

  ctx.save();
  ctx.translate(cx, cy);
  ctx.translate(0, Math.sin(time * 1.6) * 3);
  ctx.scale(scale, scale);

  drawShadow(ctx, 0, r * 0.9, r * 1.05, r * 0.4, 0.34);

  // 背光：和场景内一样用 Boss 自己的配色，而不是统一暖色
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const rg = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, r * 2.2);
  // 同 drawBossBitmap：glow 是 "r,g,b" 而不是十六进制，直接拼 rgba()
  rg.addColorStop(0, `rgba(${def.palette.glow},0.32)`);
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rg;
  ctx.beginPath();
  ctx.arc(0, 0, r * 2.2, 0, TAU);
  ctx.fill();
  ctx.restore();

  if (sprite) {
    ctx.drawImage(sprite.img, -fullW / 2, -fullH / 2, fullW, fullH);
  } else {
    // 静止预览：固定 2 阶段（不狂暴），面向正下方，甲片缓慢自转
    drawBossProgrammatic(
      ctx,
      { phase: 2, plateRotation: time * 0.25, facing: Math.PI / 2 },
      r,
      false,
      time,
    );
  }

  ctx.restore();
}

// ------------------------------------------------------------------ 拾取物

export function drawPickup(ctx: CanvasRenderingContext2D, p: Pickup, time: number): void {
  const bob = Math.sin(time * 3 + p.bobPhase) * 3;
  const spawn = 1 - clamp(p.spawnTimer / 0.35, 0, 1);
  const scale = 0.5 + spawn * 0.5;
  const alpha = 0.3 + spawn * 0.7;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(p.x, p.y + bob);
  ctx.scale(scale, scale);

  switch (p.kind) {
    case 'gold': {
      const spin = Math.cos(time * 4 + p.bobPhase);
      drawShadow(ctx, 0, 12, 8, 4, 0.3);
      ctx.save();
      ctx.scale(Math.max(0.18, Math.abs(spin)), 1);
      const g = ctx.createLinearGradient(0, -10, 0, 10);
      g.addColorStop(0, '#ffeaa0');
      g.addColorStop(0.5, '#f2c14e');
      g.addColorStop(1, '#a9761c');
      ctx.fillStyle = g;
      ellipsePath(ctx, 0, 0, 9.5, 9.5);
      ctx.fill();
      ctx.strokeStyle = '#8a5c12';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.fillStyle = '#fff4c8';
      ctx.globalAlpha = alpha * 0.8;
      ellipsePath(ctx, -2.6, -3, 2.6, 2);
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'heart': {
      drawShadow(ctx, 0, 13, 9, 4.4, 0.3);
      const pulse = 1 + Math.sin(time * 6 + p.bobPhase) * 0.08;
      ctx.save();
      ctx.scale(pulse, pulse);
      ctx.fillStyle = '#ff5a6e';
      ctx.beginPath();
      ctx.moveTo(0, 10);
      ctx.bezierCurveTo(-14, 0, -9, -12, 0, -5);
      ctx.bezierCurveTo(9, -12, 14, 0, 0, 10);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#8e1f31';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ellipsePath(ctx, -3.6, -3.4, 2.4, 1.7, -0.5);
      ctx.fill();
      ctx.restore();
      // 十字
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = '#ffd0d8';
      ctx.globalAlpha = alpha * 0.9;
      ctx.fillRect(-7, -17, 14, 4);
      ctx.fillRect(-2, -22, 4, 14);
      ctx.restore();
      break;
    }
    case 'ammo': {
      drawShadow(ctx, 0, 12, 9, 4.2, 0.3);
      const g = ctx.createLinearGradient(0, -10, 0, 10);
      g.addColorStop(0, '#6d7a52');
      g.addColorStop(1, '#38402a');
      ctx.fillStyle = g;
      roundedRectPath(ctx, -11, -9, 22, 19, 3);
      ctx.fill();
      ctx.strokeStyle = '#20261a';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.fillStyle = '#c9b46a';
      for (let i = 0; i < 3; i++) ctx.fillRect(-7 + i * 5.4, -5, 3.4, 10);
      ctx.fillStyle = '#7ef2c0';
      ctx.fillRect(-11, -1.4, 22, 2.4);
      break;
    }
    case 'shield': {
      drawShadow(ctx, 0, 12, 9, 4.2, 0.3);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * (0.4 + Math.sin(time * 4) * 0.1);
      const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, 20);
      rg.addColorStop(0, '#9fd8ff');
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(0, 0, 20, 0, TAU);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#3f6f9c';
      ctx.beginPath();
      ctx.moveTo(0, -11);
      ctx.lineTo(9, -6);
      ctx.lineTo(9, 3);
      ctx.lineTo(0, 11);
      ctx.lineTo(-9, 3);
      ctx.lineTo(-9, -6);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#bfe8ff';
      ctx.lineWidth = 2;
      ctx.stroke();
      break;
    }
    case 'weapon': {
      drawShadow(ctx, 0, 20, 20, 8, 0.34);
      // 基座
      ctx.fillStyle = 'rgba(120,116,140,0.28)';
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const ring = ctx.createRadialGradient(0, 14, 4, 0, 14, 30);
      ring.addColorStop(0, '#ffd479');
      ring.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.45 + Math.sin(time * 3) * 0.1;
      ctx.fillStyle = ring;
      ellipsePath(ctx, 0, 14, 30, 13);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#4a4458';
      ellipsePath(ctx, 0, 16, 20, 8);
      ctx.fill();
      ctx.fillStyle = '#5d566e';
      ellipsePath(ctx, 0, 13, 20, 8);
      ctx.fill();
      ctx.strokeStyle = '#2a2536';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      // 悬浮的武器
      const def = p.data.weaponId ? getWeaponDef(p.data.weaponId) : null;
      ctx.save();
      ctx.translate(0, -6 + bob * 0.4);
      ctx.rotate(Math.sin(time * 1.6) * 0.06 - Math.PI * 0.5);
      if (def) drawWeaponShape(ctx, def, 1.05 * (def.heldScale ?? 1));
      ctx.restore();
      // 提示光柱
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const beam = ctx.createLinearGradient(0, -60, 0, 14);
      beam.addColorStop(0, 'rgba(255,212,121,0)');
      beam.addColorStop(1, 'rgba(255,212,121,0.28)');
      ctx.fillStyle = beam;
      ctx.globalAlpha = 0.5 + Math.sin(time * 3) * 0.14;
      ctx.beginPath();
      ctx.moveTo(-14, 14);
      ctx.lineTo(-7, -60);
      ctx.lineTo(7, -60);
      ctx.lineTo(14, 14);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'upgradeOrb': {
      drawShadow(ctx, 0, 16, 16, 6, 0.32);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, 30);
      rg.addColorStop(0, '#ffffff');
      rg.addColorStop(0.3, '#9fe8ff');
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.75 + Math.sin(time * 4) * 0.12;
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(0, 0, 30, 0, TAU);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#2b4d6e';
      ellipsePath(ctx, 0, 0, 13, 13);
      ctx.fill();
      ctx.strokeStyle = '#9fe8ff';
      ctx.lineWidth = 2.2;
      ctx.stroke();
      // 旋转符文
      ctx.save();
      ctx.rotate(time * 1.4);
      ctx.strokeStyle = '#bff3ff';
      ctx.lineWidth = 1.8;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 20, Math.sin(a) * 20, 3.4, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case 'chest': {
      drawShadow(ctx, 0, 18, 24, 9, 0.34);
      const open = !!p.data.sold;
      ctx.fillStyle = '#6b4a2c';
      roundedRectPath(ctx, -22, -6, 44, 24, 5);
      ctx.fill();
      ctx.strokeStyle = '#3a2616';
      ctx.lineWidth = 2.4;
      ctx.stroke();
      ctx.fillStyle = '#8a6238';
      ctx.fillRect(-22, -2, 44, 4);
      // 盖
      ctx.save();
      if (open) {
        ctx.translate(0, -8);
        ctx.rotate(-0.9);
      }
      ctx.fillStyle = '#7d5730';
      roundedRectPath(ctx, -22, -20, 44, 18, 6);
      ctx.fill();
      ctx.strokeStyle = '#3a2616';
      ctx.lineWidth = 2.4;
      ctx.stroke();
      ctx.fillStyle = '#c8a24a';
      roundedRectPath(ctx, -5, -14, 10, 12, 2);
      ctx.fill();
      ctx.restore();
      // 锁扣
      ctx.fillStyle = '#e0bd63';
      roundedRectPath(ctx, -5, -6, 10, 12, 2);
      ctx.fill();
      ctx.strokeStyle = '#7a5c1d';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      if (open) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.5 + Math.sin(time * 5) * 0.16;
        const rg = ctx.createRadialGradient(0, -10, 0, 0, -10, 40);
        rg.addColorStop(0, '#ffe9a8');
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.arc(0, -10, 40, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
      break;
    }
    case 'portal': {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const pulse = 1 + Math.sin(time * 2.4) * 0.08;
      ctx.scale(pulse, pulse);
      for (let i = 0; i < 3; i++) {
        const rr = 20 + i * 9 + Math.sin(time * 3 + i * 1.2) * 3;
        const g = ctx.createRadialGradient(0, 0, rr * 0.35, 0, 0, rr);
        g.addColorStop(0, 'rgba(190,150,255,0)');
        g.addColorStop(0.7, i === 1 ? 'rgba(180,120,255,0.55)' : 'rgba(120,200,255,0.4)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, rr, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
      ctx.fillStyle = '#1a1330';
      ellipsePath(ctx, 0, 0, 18, 22);
      ctx.fill();
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 5; i++) {
        const a = time * 2.4 + (i / 5) * TAU;
        ctx.fillStyle = i % 2 === 0 ? '#c8a2ff' : '#9fe8ff';
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 12, Math.sin(a) * 16, 2.4, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
      break;
    }
  }

  ctx.restore();
}

// ------------------------------------------------------------------ UI 图标

/** 图标里武器希望占用的本地长度 —— 和原有 8 把枪械的视觉长度同一个量级。 */
const ICON_WEAPON_SPAN = 52;

export function drawWeaponIcon(
  ctx: CanvasRenderingContext2D,
  def: WeaponDef,
  x: number,
  y: number,
  size: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  if (def.heldLength === undefined) {
    // 原有 8 把枪械：长度都在 40 上下，保持历史偏移与缩放，图标外观逐像素不变。
    const s = size / 60;
    ctx.scale(s, s);
    ctx.translate(-16, 0);
  } else {
    // 长柄武器（长枪有 84 长）：照枪械口径画会整根戳出图标框，
    // 所以按实际长度把它缩到框内再居中。近战武器的图标大小因此是统一的。
    const s = (size / 60) * (ICON_WEAPON_SPAN / def.heldLength);
    ctx.scale(s, s);
    ctx.translate(-(def.heldLength * 0.5 - 6), 0);
  }
  drawWeaponShape(ctx, def, 1.0);
  ctx.restore();
}

export function drawUpgradeIcon(
  ctx: CanvasRenderingContext2D,
  icon: UpgradeIcon,
  x: number,
  y: number,
  size: number,
  accent = '#ffd479',
): void {
  const s = size / 24;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  ctx.lineWidth = 2.4;
  switch (icon) {
    case 'heart':
      ctx.beginPath();
      ctx.moveTo(0, 8);
      ctx.bezierCurveTo(-11, 0, -7, -9, 0, -4);
      ctx.bezierCurveTo(7, -9, 11, 0, 0, 8);
      ctx.closePath();
      ctx.fill();
      break;
    case 'boot':
      ctx.beginPath();
      ctx.moveTo(-5, -9);
      ctx.lineTo(0, -9);
      ctx.lineTo(0, 2);
      ctx.lineTo(8, 4);
      ctx.lineTo(8, 8);
      ctx.lineTo(-5, 8);
      ctx.closePath();
      ctx.fill();
      break;
    case 'trigger':
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0.6, 5.4);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-9, 0);
      ctx.lineTo(-3, 0);
      ctx.moveTo(-6, -3);
      ctx.lineTo(-6, 3);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 2.4, 0, TAU);
      ctx.fill();
      break;
    case 'bullet':
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(4, -2);
      ctx.lineTo(4, 8);
      ctx.lineTo(-4, 8);
      ctx.lineTo(-4, -2);
      ctx.closePath();
      ctx.fill();
      break;
    case 'crit':
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const rr = i % 2 === 0 ? 9 : 3.6;
        if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
      break;
    case 'pierce':
      ctx.beginPath();
      ctx.moveTo(-9, 0);
      ctx.lineTo(9, 0);
      ctx.moveTo(4, -4);
      ctx.lineTo(9, 0);
      ctx.lineTo(4, 4);
      ctx.moveTo(-4, -6);
      ctx.lineTo(-4, 6);
      ctx.stroke();
      break;
    case 'bounce':
      ctx.beginPath();
      ctx.moveTo(-9, 6);
      ctx.quadraticCurveTo(-2, -10, 9, 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(7, 6, 2.6, 0, TAU);
      ctx.fill();
      break;
    case 'reap':
      ctx.beginPath();
      ctx.arc(0, 1, 6.5, 0.5, 5.6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(6, -6);
      ctx.lineTo(9, -9);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 1, 2.4, 0, TAU);
      ctx.fill();
      break;
    case 'regen':
      // 心跳脉冲线：一眼看出是「生命回复」
      ctx.beginPath();
      ctx.moveTo(-9.5, 1);
      ctx.lineTo(-4.5, 1);
      ctx.lineTo(-2, -6);
      ctx.lineTo(1.4, 6.5);
      ctx.lineTo(4, 1);
      ctx.lineTo(9.5, 1);
      ctx.stroke();
      break;
    case 'shield':
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(8, -5);
      ctx.lineTo(8, 2);
      ctx.lineTo(0, 9);
      ctx.lineTo(-8, 2);
      ctx.lineTo(-8, -5);
      ctx.closePath();
      ctx.fill();
      break;
    case 'cool':
      ctx.beginPath();
      ctx.arc(0, 0, 7.5, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -5);
      ctx.moveTo(0, 0);
      ctx.lineTo(4, 2);
      ctx.stroke();
      break;
    case 'reload':
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0.8, 5.0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(5, -6);
      ctx.lineTo(8, -2);
      ctx.lineTo(3, -1);
      ctx.closePath();
      ctx.fill();
      break;
    case 'mag':
      ctx.beginPath();
      ctx.rect(-5, -8, 10, 16);
      ctx.stroke();
      ctx.fillRect(-5, -3, 10, 3);
      break;
    case 'double':
      ctx.beginPath();
      ctx.moveTo(-7, -8);
      ctx.lineTo(-7, 8);
      ctx.moveTo(-3, -8);
      ctx.lineTo(-3, 8);
      ctx.moveTo(3, -8);
      ctx.lineTo(3, 8);
      ctx.moveTo(7, -8);
      ctx.lineTo(7, 8);
      ctx.stroke();
      break;
    case 'coin':
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#1a1524';
      ctx.beginPath();
      ctx.arc(0, 0, 4.4, 0, TAU);
      ctx.fill();
      break;
    case 'range':
      ctx.beginPath();
      ctx.arc(-2, 0, 7, -1.1, 1.1);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-2, -7);
      ctx.lineTo(-2, 7);
      ctx.stroke();
      ctx.fillRect(5, -1.4, 4.6, 2.8);
      break;
    case 'thorns':
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU - Math.PI / 2;
        const a2 = a + TAU / 12;
        ctx.moveTo(Math.cos(a) * 9, Math.sin(a) * 9);
        ctx.lineTo(Math.cos(a2) * 4, Math.sin(a2) * 4);
      }
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 3, 0, TAU);
      ctx.fill();
      break;
  }
  ctx.restore();
}

export function drawCharacterPortrait(
  ctx: CanvasRenderingContext2D,
  def: CharacterDef,
  x: number,
  y: number,
  scale: number,
  time: number,
  locked = false,
): void {
  const pal = locked
    ? { primary: '#4a4757', secondary: '#302d3c', accent: '#5b5768', skin: '#5a5666', cape: '#2a2734', glow: '#4a4757' }
    : def.palette;
  ctx.save();
  ctx.translate(x, y);
  const bob = Math.sin(time * 1.8) * 2;
  ctx.translate(0, bob);
  ctx.scale(scale, scale);
  drawShadow(ctx, 0, 30, 22, 8, locked ? 0.18 : 0.34);

  // 立绘分支：配了 sprite 的角色直接贴位图，然后叠加圆形光环/锁标。
  const sprite = locked ? null : getCharacterSprite(def);
  if (sprite) {
    // 这里是**角色卡插画**，不是场景内单位，尺寸按卡片框走（约 62 高），
    // 和 `PLAYER_SPRITE_H`（世界内 34）是两套口径，别混。
    // 宽度按图片宽高比算，避免角色被拉变形。
    const h = 62;
    const w = h * (sprite.img.naturalWidth / sprite.img.naturalHeight);
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 2, 34, 40, 0, 0, TAU);
    ctx.clip();
    ctx.drawImage(sprite.img, -w / 2, 30 - h, w, h);
    ctx.restore();
    rimLight(ctx, 0, 0, 24, 30, pal.glow, 0.4, 0, Math.PI * 0.7, Math.PI * 1.55);
    if (locked) drawLockBadge(ctx);
    ctx.restore();
    return;
  }

  // 披风
  ctx.fillStyle = darken(pal.cape, 0.1);
  ctx.beginPath();
  ctx.moveTo(0, -14);
  ctx.quadraticCurveTo(-34, 4, -12, 32);
  ctx.quadraticCurveTo(0, 16, 12, 32);
  ctx.quadraticCurveTo(34, 4, 0, -14);
  ctx.closePath();
  ctx.fill();

  // 躯干
  ctx.fillStyle = bodyGradient(ctx, 0, 0, 20, 26, pal.primary);
  ellipsePath(ctx, 0, 2, 20, 25);
  ctx.fill();
  ctx.strokeStyle = darken(pal.secondary, 0.45);
  ctx.lineWidth = 2.6;
  ctx.stroke();

  // 胸甲
  ctx.fillStyle = pal.secondary;
  ctx.beginPath();
  ctx.moveTo(-16, -14);
  ctx.lineTo(16, -14);
  ctx.lineTo(10, 8);
  ctx.lineTo(0, 14);
  ctx.lineTo(-10, 8);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = lighten(pal.primary, 0.65);
  ellipsePath(ctx, -6, -8, 9, 6, -0.4);
  ctx.fill();
  ctx.globalAlpha = 1;

  // 肩甲
  ctx.fillStyle = pal.secondary;
  for (const s of [-1, 1]) {
    ellipsePath(ctx, s * 21, -9, 9.5, 8.5);
    ctx.fill();
    ctx.strokeStyle = darken(pal.secondary, 0.4);
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }

  // 头
  ctx.fillStyle = bodyGradient(ctx, 0, -28, 14, 14, pal.skin);
  ellipsePath(ctx, 0, -30, 14, 14);
  ctx.fill();
  ctx.strokeStyle = darken(pal.skin, 0.5);
  ctx.lineWidth = 2;
  ctx.stroke();

  // 头盔
  ctx.fillStyle = bodyGradient(ctx, 0, -34, 15, 12, pal.secondary);
  ctx.beginPath();
  ctx.ellipse(0, -32, 15, 13, 0, Math.PI, TAU);
  ctx.closePath();
  ctx.fill();

  // 面罩
  ctx.fillStyle = pal.accent;
  roundedRectPath(ctx, -9, -31, 18, 7, 2.6);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.75;
  ctx.fillRect(-6, -30, 4, 2.4);
  ctx.globalAlpha = 1;

  // 顶饰
  ctx.fillStyle = pal.accent;
  ctx.beginPath();
  ctx.moveTo(-2, -44);
  ctx.quadraticCurveTo(-16, -52, -20, -38);
  ctx.quadraticCurveTo(-11, -44, -2, -40);
  ctx.closePath();
  ctx.fill();

  // 轮廓光
  rimLight(ctx, 0, 0, 20, 25, pal.glow, 0.45, 0, Math.PI * 0.7, Math.PI * 1.55);

  if (locked) {
    drawLockBadge(ctx);
  }

  ctx.restore();
}

/** 锁定态覆盖：一层暗罩 + 中间一把锁。矢量角色卡与立绘角色卡共用。 */
function drawLockBadge(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.globalAlpha = 0.62;
  ctx.fillStyle = '#0d0a16';
  ctx.fillRect(-60, -60, 120, 120);
  ctx.restore();
  // 锁
  ctx.save();
  ctx.strokeStyle = '#8b8496';
  ctx.fillStyle = '#8b8496';
  ctx.lineWidth = 3.4;
  ctx.beginPath();
  ctx.arc(0, -4, 8, Math.PI, TAU);
  ctx.stroke();
  roundedRectPath(ctx, -11, -4, 22, 18, 4);
  ctx.fill();
  ctx.restore();
}

export function drawEliteBadge(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = '#ffb14a';
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU - Math.PI / 2;
    const rr = i % 2 === 0 ? size : size * 0.46;
    if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export { roundedRectPath, ellipsePath };
