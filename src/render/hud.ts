/** HUD：生命/护盾、武器与弹药、技能冷却、层数、金币、强化图标、Boss 血条、小地图、准星。 */
import { TAU, clamp } from '../core/math';
import type { Player } from '../entities/player';
import type { Boss } from '../entities/boss';
import type { DungeonPlan } from '../dungeon/dungeon';
import type { UpgradeStack } from '../data/upgrades';
import { UPGRADES } from '../data/upgrades';
import { drawMinimap } from './minimap';
import { drawUpgradeIcon, drawWeaponIcon, darken, lighten, roundedRectPath, withAlpha } from './art';

export interface HudParams {
  player: Player;
  plan: DungeonPlan;
  currentKey: string;
  discovered: Set<string>;
  upgrades: UpgradeStack[];
  floor: number;
  floorCount: number;
  gold: number;
  kills: number;
  timeSec: number;
  boss: Boss | null;
  mouseX: number;
  mouseY: number;
  time: number;
  interactHint: string | null;
  showMinimap: boolean;
  /** 是否绘制自绘准星（隐藏系统光标时才画，避免和系统箭头叠加） */
  showCrosshair: boolean;
  fps: number;
}

export function drawHud(ctx: CanvasRenderingContext2D, p: HudParams): void {
  const player = p.player;
  ctx.save();
  ctx.textBaseline = 'middle';

  drawVitals(ctx, p);
  drawStats(ctx, p);
  drawUpgradeStrip(ctx, p);
  drawWeaponPanel(ctx, p);
  drawSkill(ctx, p);
  if (p.showMinimap) {
    drawMinimap(ctx, p.plan, p.currentKey, p.discovered, 1260, 18, p.time);
  }
  if (p.boss && !p.boss.dead) drawBossBar(ctx, p.boss, p.time);
  if (p.interactHint) drawInteractHint(ctx, p.interactHint);
  if (p.showCrosshair) drawCrosshair(ctx, p.player, p.mouseX, p.mouseY);
  drawLowHealthWarning(ctx, p);
  ctx.restore();
}

// ---------------------------------------------------------------- 生命 / 护盾

function drawVitals(ctx: CanvasRenderingContext2D, p: HudParams): void {
  const player = p.player;
  const x = 24;
  const y = 26;
  const barW = 268;
  const barH = 17;

  // 角色头像
  ctx.save();
  const ax = x + 26;
  const ay = y + 22;
  const g = ctx.createLinearGradient(ax - 26, ay - 26, ax + 26, ay + 26);
  g.addColorStop(0, player.def.palette.primary);
  g.addColorStop(1, darken(player.def.palette.secondary, 0.3));
  ctx.fillStyle = 'rgba(14,11,22,0.8)';
  ctx.beginPath();
  ctx.arc(ax, ay, 27, 0, TAU);
  ctx.fill();
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(ax, ay, 23, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,212,121,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(ax, ay, 26, 0, TAU);
  ctx.stroke();
  ctx.fillStyle = '#0d0a16';
  ctx.font = '700 22px "PingFang SC","Segoe UI",sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(player.def.name.charAt(0), ax, ay + 1);
  ctx.restore();

  const bx = x + 62;
  const shieldMax = Math.max(1, player.maxShield);
  const barrierRatio = clamp(player.barrier / Math.max(1, shieldMax + 95), 0, 1);
  const shieldRatio = clamp(player.shield / shieldMax, 0, 1);

  // 护盾条（细）
  const shH = 8;
  ctx.fillStyle = 'rgba(10,8,18,0.82)';
  roundedRectPath(ctx, bx, y + barH + 5, barW, shH, 4);
  ctx.fill();
  if (shieldRatio > 0.001) {
    const sg = ctx.createLinearGradient(bx, 0, bx + barW, 0);
    sg.addColorStop(0, '#5cc8ff');
    sg.addColorStop(1, '#9fe8ff');
    ctx.fillStyle = sg;
    roundedRectPath(ctx, bx, y + barH + 5, barW * shieldRatio, shH, 4);
    ctx.fill();
  }
  if (player.barrier > 0.5) {
    ctx.fillStyle = withAlpha('#7ef2c0', 0.85);
    roundedRectPath(ctx, bx, y + barH + 5, barW * Math.max(barrierRatio, 0.04), shH, 4);
    ctx.fill();
  }

  // 生命条
  ctx.fillStyle = 'rgba(10,8,18,0.86)';
  roundedRectPath(ctx, bx, y, barW, barH, 5);
  ctx.fill();
  const hpRatio = clamp(player.hp / player.maxHp, 0, 1);
  const hg = ctx.createLinearGradient(bx, 0, bx + barW, 0);
  if (hpRatio > 0.55) {
    hg.addColorStop(0, '#5fd18a');
    hg.addColorStop(1, '#9ff0b6');
  } else if (hpRatio > 0.26) {
    hg.addColorStop(0, '#e8b64a');
    hg.addColorStop(1, '#ffd479');
  } else {
    hg.addColorStop(0, '#e05a4a');
    hg.addColorStop(1, '#ff8a72');
  }
  ctx.fillStyle = hg;
  roundedRectPath(ctx, bx, y, Math.max(2, barW * hpRatio), barH, 5);
  ctx.fill();
  // 高光
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#ffffff';
  roundedRectPath(ctx, bx + 2, y + 2, Math.max(2, barW * hpRatio - 4), 4, 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  // 脱战回血中：血条透出一层呼吸状绿光，让"正在回血"这件事看得见
  if (player.regening) {
    ctx.globalAlpha = 0.18 + 0.16 * (0.5 + 0.5 * Math.sin(p.time * 6));
    ctx.fillStyle = '#7ef2c0';
    roundedRectPath(ctx, bx, y, Math.max(2, barW * hpRatio), barH, 5);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = 'rgba(255,212,121,0.32)';
  ctx.lineWidth = 1.4;
  roundedRectPath(ctx, bx, y, barW, barH, 5);
  ctx.stroke();

  ctx.fillStyle = '#f3ecff';
  ctx.font = '700 12px "Segoe UI","PingFang SC",sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${Math.ceil(player.hp)} / ${Math.round(player.maxHp)}`, bx + 8, y + barH / 2 + 0.5);

  // 脱战回复速率提示（回血生效时才出现）
  if (player.regening && player.mods.healthRegen > 0) {
    ctx.fillStyle = withAlpha('#7ef2c0', 0.95);
    ctx.font = '700 12px "Segoe UI","PingFang SC",sans-serif';
    ctx.fillText(`+${Math.round(player.mods.healthRegen * 10) / 10}/s`, bx + barW + 10, y + barH / 2 + 0.5);
  }

  // 角色名与技能名
  ctx.fillStyle = 'rgba(226,218,246,0.9)';
  ctx.font = '600 12px "PingFang SC","Segoe UI",sans-serif';
  ctx.fillText(`${player.def.name} · ${player.def.title}`, bx, y + barH + shH + 18);
}

// ---------------------------------------------------------------- 统计信息

function drawStats(ctx: CanvasRenderingContext2D, p: HudParams): void {
  const y = 108;
  const x = 24;
  ctx.font = '600 13px "Segoe UI","PingFang SC",sans-serif';
  ctx.textAlign = 'left';
  // 层数
  ctx.fillStyle = 'rgba(255,212,121,0.95)';
  ctx.fillText(`第 ${p.floor} / ${p.floorCount} 层`, x, y);
  // 金币
  ctx.fillStyle = 'rgba(255,224,140,0.95)';
  ctx.beginPath();
  ctx.arc(x + 96, y, 6.5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(240,232,255,0.9)';
  ctx.fillText(`${p.gold}`, x + 108, y);
  // 击杀
  ctx.fillStyle = 'rgba(226,218,246,0.72)';
  ctx.fillText(`击杀 ${p.kills}`, x + 168, y);
  // 时间
  const t = Math.floor(p.timeSec);
  const mm = Math.floor(t / 60).toString().padStart(2, '0');
  const ss = (t % 60).toString().padStart(2, '0');
  ctx.fillText(`${mm}:${ss}`, x + 240, y);
  // 调试信息
  if (p.fps > 0) {
    ctx.globalAlpha = 0.4;
    ctx.font = '500 11px Consolas, monospace';
    ctx.fillText(`${p.fps.toFixed(0)} FPS`, x + 300, y);
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------- 强化图标

function drawUpgradeStrip(ctx: CanvasRenderingContext2D, p: HudParams): void {
  if (!p.upgrades.length) return;
  const size = 26;
  const gap = 4;
  const perRow = 8;
  const startX = 26;
  const baseY = 660;
  ctx.save();
  ctx.font = '600 10px "Segoe UI","PingFang SC",sans-serif';
  ctx.textAlign = 'center';
  for (let i = 0; i < p.upgrades.length; i++) {
    const st = p.upgrades[i]!;
    const def = UPGRADES.find((u) => u.id === st.id);
    if (!def) continue;
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const x = startX + col * (size + gap);
    const y = baseY + row * (size + gap);
    ctx.fillStyle = 'rgba(16,13,26,0.82)';
    roundedRectPath(ctx, x, y, size, size, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,212,121,0.35)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    drawUpgradeIcon(ctx, def.icon, x + size / 2, y + size / 2, 16, '#ffd479');
    if (st.stacks > 1) {
      ctx.fillStyle = '#ffd479';
      ctx.font = '700 10px "Segoe UI",sans-serif';
      ctx.fillText(`${st.stacks}`, x + size - 4, y + size - 2);
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------- 武器面板

function drawWeaponPanel(ctx: CanvasRenderingContext2D, p: HudParams): void {
  const player = p.player;
  const w = 320;
  const h = 52;
  const x = 24;
  const y0 = 560;
  ctx.save();
  for (let i = 0; i < player.weapons.length; i++) {
    const inst = player.weapons[i]!;
    const active = i === player.weaponIndex;
    const y = y0 + i * (h + 8);
    ctx.globalAlpha = active ? 1 : 0.62;
    ctx.fillStyle = active ? 'rgba(22,18,34,0.92)' : 'rgba(14,11,22,0.72)';
    roundedRectPath(ctx, x, y, w, h, 9);
    ctx.fill();
    ctx.strokeStyle = active ? 'rgba(255,212,121,0.62)' : 'rgba(140,132,170,0.3)';
    ctx.lineWidth = active ? 2 : 1.2;
    ctx.stroke();

    // 武器图标
    ctx.save();
    ctx.beginPath();
    roundedRectPath(ctx, x + 8, y + 8, 56, h - 16, 6);
    ctx.clip();
    ctx.fillStyle = 'rgba(60,54,84,0.55)';
    ctx.fillRect(x + 8, y + 8, 56, h - 16);
    drawWeaponIcon(ctx, inst.def, x + 22, y + h / 2, 44);
    ctx.restore();

    // 名称
    ctx.fillStyle = active ? '#fff4d8' : 'rgba(226,218,246,0.8)';
    ctx.font = '700 14px "PingFang SC","Segoe UI",sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(inst.def.name, x + 72, y + 19);

    // 弹药（近战武器没有弹匣，直接说明"无需弹药"）
    const melee = inst.def.kind === 'melee';
    const ammoText =
      melee
        ? '近战 · 无需弹药'
        : inst.reloadTimer > 0
          ? '换弹中…'
          : `${Math.ceil(inst.ammo)} / ${inst.magSize}`;
    ctx.fillStyle = melee
      ? '#ffd479'
      : inst.ammo <= inst.magSize * 0.25
        ? '#ff9a7a'
        : 'rgba(240,232,255,0.92)';
    ctx.font = '700 13px Consolas,"Segoe UI",monospace';
    ctx.fillText(ammoText, x + 72, y + 37);

    // 换弹进度
    if (inst.reloadTimer > 0) {
      const total = Math.max(0.01, inst.def.reloadTime * player.mods.reloadMul);
      const prog = clamp(1 - inst.reloadTimer / total, 0, 1);
      ctx.fillStyle = 'rgba(10,8,18,0.9)';
      roundedRectPath(ctx, x + 150, y + 33, 150, 8, 4);
      ctx.fill();
      ctx.fillStyle = '#ffd479';
      roundedRectPath(ctx, x + 150, y + 33, 150 * prog, 8, 4);
      ctx.fill();
    } else if (melee) {
      // 近战：这根条改成「挥砍就绪度」—— 满格 = 下一刀已经可以挥了。
      const total = 1 / Math.max(0.05, inst.def.fireRate * player.mods.fireRateMul);
      const ready = clamp(1 - inst.cooldown / total, 0, 1);
      ctx.fillStyle = 'rgba(10,8,18,0.9)';
      roundedRectPath(ctx, x + 150, y + 33, 150, 8, 4);
      ctx.fill();
      ctx.fillStyle = ready >= 1 ? '#8ef0b0' : '#ffd479';
      roundedRectPath(ctx, x + 150, y + 33, 150 * ready, 8, 4);
      ctx.fill();
    } else {
      // 弹匣点阵
      const maxDots = Math.min(inst.magSize, 22);
      const dotW = 150 / maxDots;
      const filled = Math.round((inst.ammo / inst.magSize) * maxDots);
      for (let d = 0; d < maxDots; d++) {
        ctx.fillStyle = d < filled ? 'rgba(255,212,121,0.85)' : 'rgba(90,82,116,0.6)';
        ctx.fillRect(x + 150 + d * dotW, y + 35, Math.max(1.4, dotW - 2), 5);
      }
    }

    // 槽位序号
    ctx.fillStyle = active ? '#ffd479' : 'rgba(160,152,190,0.7)';
    ctx.font = '700 11px "Segoe UI",sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${i + 1}`, x + w - 10, y + 14);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- 技能

function drawSkill(ctx: CanvasRenderingContext2D, p: HudParams): void {
  const player = p.player;
  const cx = 640;
  const cy = 654;
  const r = 32;
  const ready = player.skillCooldown <= 0;
  const active = player.skillActiveTimer > 0;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = 'rgba(14,11,22,0.88)';
  ctx.beginPath();
  ctx.arc(cx, cy, r + 4, 0, TAU);
  ctx.fill();

  // 冷却环
  ctx.strokeStyle = 'rgba(80,72,108,0.7)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.stroke();

  const prog = player.skillReadyPercent;
  const ringColor = ready ? (active ? '#7ef2c0' : '#ffd479') : '#9a8fd0';
  ctx.strokeStyle = ringColor;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + TAU * prog);
  ctx.stroke();

  if (active) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.35 + Math.sin(p.time * 10) * 0.15;
    ctx.strokeStyle = '#7ef2c0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 9, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // 图标：按技能类型
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = ready ? '#f3ecff' : 'rgba(200,192,226,0.5)';
  ctx.fillStyle = ctx.strokeStyle as string;
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  switch (player.def.skill.kind) {
    case 'dash':
      ctx.beginPath();
      ctx.moveTo(-9, 7);
      ctx.lineTo(2, -7);
      ctx.lineTo(2, 0);
      ctx.lineTo(9, 0);
      ctx.lineTo(-2, 8);
      ctx.stroke();
      break;
    case 'overdrive':
      ctx.beginPath();
      ctx.moveTo(-3, -10);
      ctx.lineTo(6, -1);
      ctx.lineTo(0, -1);
      ctx.lineTo(4, 10);
      ctx.lineTo(-6, 0);
      ctx.lineTo(0, 0);
      ctx.closePath();
      ctx.fill();
      break;
    case 'barrier':
      ctx.beginPath();
      ctx.moveTo(0, -10);
      ctx.lineTo(9, -5);
      ctx.lineTo(9, 3);
      ctx.lineTo(0, 10);
      ctx.lineTo(-9, 3);
      ctx.lineTo(-9, -5);
      ctx.closePath();
      ctx.stroke();
      break;
  }
  ctx.restore();

  ctx.fillStyle = ready ? 'rgba(255,212,121,0.9)' : 'rgba(170,162,200,0.75)';
  ctx.font = '700 10px "Segoe UI",sans-serif';
  ctx.fillText('SPACE', cx, cy + r + 16);
  if (!ready) {
    ctx.fillStyle = '#fff4d8';
    ctx.font = '700 13px "Segoe UI",monospace';
    ctx.fillText(player.skillCooldown.toFixed(1), cx, cy + 1);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- Boss 血条

function drawBossBar(ctx: CanvasRenderingContext2D, boss: Boss, time: number): void {
  const w = 560;
  const h = 15;
  const x = (1280 - w) / 2;
  const y = 88;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,180,150,0.92)';
  ctx.font = '700 13px "PingFang SC","Segoe UI",sans-serif';
  ctx.fillText(`${boss.name}　·　${boss.title}　·　第 ${boss.phase} 阶段`, 1280 / 2, y - 12);

  ctx.fillStyle = 'rgba(10,8,18,0.9)';
  roundedRectPath(ctx, x - 3, y - 3, w + 6, h + 6, 6);
  ctx.fill();

  const ratio = boss.healthPercent;
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  if (boss.phase >= 3) {
    g.addColorStop(0, '#ff3a2a');
    g.addColorStop(1, '#ff9a3c');
  } else if (boss.phase >= 2) {
    g.addColorStop(0, '#e0432a');
    g.addColorStop(1, '#ff7a45');
  } else {
    g.addColorStop(0, '#b8323c');
    g.addColorStop(1, '#e8623c');
  }
  ctx.fillStyle = g;
  roundedRectPath(ctx, x, y, Math.max(0, w * ratio), h, 4);
  ctx.fill();

  ctx.globalAlpha = 0.25;
  ctx.fillStyle = '#ffffff';
  roundedRectPath(ctx, x + 2, y + 2, Math.max(0, w * ratio - 4), 4, 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // 阶段分割线
  for (const t of boss.phaseThresholds) {
    const px = x + w * t;
    ctx.strokeStyle = 'rgba(255,240,200,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, y - 2);
    ctx.lineTo(px, y + h + 2);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255,150,110,0.6)';
  ctx.lineWidth = 1.6;
  roundedRectPath(ctx, x, y, w, h, 4);
  ctx.stroke();

  if (boss.invulnTimer > 0) {
    ctx.fillStyle = withAlpha('#9fe8ff', 0.6 + Math.sin(time * 18) * 0.3);
    ctx.font = '700 12px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText('相位护盾展开 — 无法造成伤害', 1280 / 2, y + h + 16);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- 交互提示

function drawInteractHint(ctx: CanvasRenderingContext2D, text: string): void {
  const cx = 640;
  const cy = 556;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = Math.max(190, ctx.measureText(text).width + 120);
  ctx.fillStyle = 'rgba(14,11,22,0.88)';
  roundedRectPath(ctx, cx - w / 2, cy - 19, w, 38, 9);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,212,121,0.5)';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.fillStyle = '#ffd479';
  ctx.font = '700 13px "Segoe UI",sans-serif';
  ctx.fillText('E', cx - w / 2 + 26, cy + 0.5);
  ctx.strokeStyle = 'rgba(255,212,121,0.7)';
  ctx.lineWidth = 1.4;
  roundedRectPath(ctx, cx - w / 2 + 15, cy - 10, 22, 20, 4);
  ctx.stroke();

  ctx.fillStyle = '#f3ecff';
  ctx.font = '600 14px "PingFang SC","Segoe UI",sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(text, cx - w / 2 + 48, cy + 0.5);
  ctx.restore();
}

// ---------------------------------------------------------------- 准星

/**
 * 自绘准星（游戏内隐藏系统光标后，它就是"鼠标"）。
 * 先描一圈深色轮廓再描亮色芯线，保证在地牢的明暗背景上都清楚可见。
 */
export function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  player: Player,
  x: number,
  y: number,
): void {
  const w = player.currentWeapon;
  const reloading = w.reloadTimer > 0;
  const spread = w.def.spread + (player.moving ? 0.03 : 0) + player.mods.multishotAdd * 0.02;
  const gap = 8 + spread * 130;
  const len = 11;

  ctx.save();
  ctx.lineCap = 'round';

  // 深色轮廓（保证亮背景上也看得见）
  ctx.strokeStyle = 'rgba(8,6,14,0.72)';
  ctx.lineWidth = 5.6;
  crosshairArms(ctx, x, y, gap, len);
  ctx.stroke();
  // 亮色芯线
  ctx.strokeStyle = reloading ? 'rgba(255,178,110,0.98)' : 'rgba(255,248,226,0.98)';
  ctx.lineWidth = 2.6;
  crosshairArms(ctx, x, y, gap, len);
  ctx.stroke();

  // 中心点
  ctx.beginPath();
  ctx.arc(x, y, 2.6, 0, TAU);
  ctx.fillStyle = 'rgba(8,6,14,0.85)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, 1.5, 0, TAU);
  ctx.fillStyle = '#ffd479';
  ctx.fill();

  if (reloading) {
    const total = Math.max(0.01, w.def.reloadTime * player.mods.reloadMul);
    const prog = clamp(1 - w.reloadTimer / total, 0, 1);
    ctx.strokeStyle = 'rgba(255,212,121,0.3)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 23, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = '#ffd479';
    ctx.beginPath();
    ctx.arc(x, y, 23, -Math.PI / 2, -Math.PI / 2 + TAU * prog);
    ctx.stroke();
  } else {
    // 静态细环：暗房间里帮忙定位
    ctx.strokeStyle = 'rgba(255,212,121,0.22)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
}

function crosshairArms(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  gap: number,
  len: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x - gap - len, y);
  ctx.lineTo(x - gap, y);
  ctx.moveTo(x + gap, y);
  ctx.lineTo(x + gap + len, y);
  ctx.moveTo(x, y - gap - len);
  ctx.lineTo(x, y - gap);
  ctx.moveTo(x, y + gap);
  ctx.lineTo(x, y + gap + len);
}

function drawLowHealthWarning(ctx: CanvasRenderingContext2D, p: HudParams): void {
  const ratio = p.player.hp / p.player.maxHp;
  if (ratio > 0.28 || p.player.dead) return;
  const intensity = (1 - ratio / 0.28) * 0.5;
  const pulse = 0.6 + Math.sin(p.time * 6) * 0.4;
  ctx.save();
  const g = ctx.createRadialGradient(640, 360, 220, 640, 360, 620);
  g.addColorStop(0, 'rgba(255,40,40,0)');
  g.addColorStop(1, `rgba(180,20,20,${intensity * pulse})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1280, 720);
  ctx.restore();
  void lighten;
}
