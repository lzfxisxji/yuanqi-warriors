/** 覆盖层 UI：暂停、强化三选一、商店、事件房、楼层结算、死亡/通关结算、设置。 */
import { TAU, clamp } from '../core/math';
import type { EventDef, EventOption } from '../data/events';
import { UPGRADES } from '../data/upgrades';
import type { UpgradeStack } from '../data/upgrades';
import type { GameSettings } from '../systems/save';
import {
  UI_COLORS,
  drawBar,
  drawButton,
  drawDim,
  drawDivider,
  drawHeading,
  drawKeyHint,
  drawPanel,
  formatTime,
  wrapText,
  type UiButton,
} from './widgets';
import { drawUpgradeIcon, drawWeaponIcon } from '../render/art';
import { getWeaponDef } from '../data/weapons';

export type OverlayMode =
  | 'none'
  | 'pause'
  | 'settings'
  | 'upgrade'
  | 'shop'
  | 'preboss'
  | 'event'
  | 'floorclear'
  | 'dead'
  | 'victory';

export interface ShopItem {
  /** heal 为固定数值治疗，healHalf 为「回复一半生命」，magPlus 为「弹匣扩容」 */
  kind: 'weapon' | 'upgrade' | 'heal' | 'healHalf' | 'magPlus' | 'ammo' | 'shield';
  price: number;
  label: string;
  desc: string;
  weaponId?: string;
  upgradeId?: string;
  sold: boolean;
  /** 售罄/不可购买时替代「已售出」的说明（例如「已达上限」） */
  note?: string;
}

export interface EventRuntime {
  def: EventDef;
  resolvedIndex: number;
  resultText: string | null;
}

export interface DeathSummary {
  floor: number;
  floorCount: number;
  kills: number;
  rooms: number;
  gold: number;
  timeSec: number;
  score: number;
  won: boolean;
  characterName: string;
  cause: string;
}

export interface OverlayState {
  mode: OverlayMode;
  previousMode: OverlayMode;
  upgradeOptions: string[];
  upgradeStacks: UpgradeStack[];
  shopItems: ShopItem[];
  /** 首领房入口的「战前补给站」商品（与普通商店分开保存） */
  prepItems: ShopItem[];
  event: EventRuntime | null;
  death: DeathSummary | null;
  summary: string | null;
}

export interface OverlayContext {
  gold: number;
  hp: number;
  maxHp: number;
  floor: number;
  floorCount: number;
  kills: number;
  timeSec: number;
  rooms: number;
  score: number;
  settings: GameSettings;
  characterName: string;
}

export function createOverlayState(): OverlayState {
  return {
    mode: 'none',
    previousMode: 'none',
    upgradeOptions: [],
    upgradeStacks: [],
    shopItems: [],
    prepItems: [],
    event: null,
    death: null,
    summary: null,
  };
}

// ------------------------------------------------------------------ 布局

export function buildOverlayButtons(overlay: OverlayState, ctx: OverlayContext): UiButton[] {
  const buttons: UiButton[] = [];
  switch (overlay.mode) {
    case 'pause': {
      const w = 260;
      const x = (1280 - w) / 2;
      buttons.push({ id: 'resume', label: '继续游戏', x, y: 300, w, h: 50 });
      buttons.push({ id: 'settings', label: '设置', x, y: 360, w, h: 50, style: 'ghost' });
      buttons.push({ id: 'abandon', label: '放弃远征', x, y: 420, w, h: 50, style: 'danger' });
      break;
    }
    case 'upgrade': {
      const cardW = 344;
      const gap = 26;
      const total = overlay.upgradeOptions.length;
      const startX = (1280 - (cardW * total + gap * (total - 1))) / 2;
      for (let i = 0; i < total; i++) {
        buttons.push({
          id: `upgrade:${i}`,
          label: '',
          x: startX + i * (cardW + gap),
          y: 230,
          w: cardW,
          h: 268,
          style: 'ghost',
          card: true,
        });
      }
      break;
    }
    case 'shop': {
      const panelX = 246;
      const panelW = 788;
      const rowH = 84;
      const startY = 178;
      for (let i = 0; i < overlay.shopItems.length; i++) {
        const item = overlay.shopItems[i]!;
        buttons.push({
          id: `shop:${i}`,
          label: '',
          x: panelX + 24,
          y: startY + i * (rowH + 10),
          w: panelW - 48,
          h: rowH,
          style: 'ghost',
          enabled: !item.sold && ctx.gold >= item.price,
          card: true,
        });
      }
      buttons.push({ id: 'shop:leave', label: '离开商店', x: (1280 - 200) / 2, y: 604, w: 200, h: 46, style: 'ghost' });
      break;
    }
    case 'preboss': {
      const panelX = 246;
      const panelW = 788;
      const rowH = 80;
      const startY = 196;
      for (let i = 0; i < overlay.prepItems.length; i++) {
        const item = overlay.prepItems[i]!;
        buttons.push({
          id: `prep:${i}`,
          label: '',
          x: panelX + 24,
          y: startY + i * (rowH + 6),
          w: panelW - 48,
          h: rowH,
          style: 'ghost',
          enabled: !item.sold && ctx.gold >= item.price,
          card: true,
        });
      }
      // 出口：主按钮「进入首领房」+ 次按钮「再准备一下」。
      // 必须给一个**不触发战斗**的出口 —— 补给站是玩家主动关的门，
      // 如果只有「进入首领房」一个按钮，玩家一旦想先看看地图/换武器就被锁死了。
      buttons.push({
        id: 'prep:start',
        label: '进入首领房',
        x: 640 - 320 - 12,
        y: 566,
        w: 320,
        h: 50,
        style: 'accent',
      });
      buttons.push({
        id: 'prep:leave',
        label: '再准备一下',
        x: 640 + 12,
        y: 566,
        w: 260,
        h: 50,
        style: 'ghost',
      });
      break;
    }
    case 'event': {
      const ev = overlay.event;
      if (ev) {
        const w = 620;
        const x = (1280 - w) / 2;
        const startY = 344;
        for (let i = 0; i < ev.def.options.length; i++) {
          const opt = ev.def.options[i]!;
          const affordable = isAffordable(opt, ctx);
          buttons.push({
            id: `event:${i}`,
            label: opt.label,
            hint: opt.detail,
            x,
            y: startY + i * 82,
            w,
            h: 70,
            style: 'ghost',
            enabled: ev.resolvedIndex < 0 && affordable,
            card: true,
          });
        }
        if (ev.resolvedIndex >= 0) {
          buttons.push({ id: 'event:leave', label: '继续前进', x: (1280 - 220) / 2, y: 620, w: 220, h: 48, style: 'accent' });
        }
      }
      break;
    }
    case 'floorclear': {
      buttons.push({ id: 'next-floor', label: '进入下一层', x: (1280 - 300) / 2, y: 452, w: 300, h: 54, style: 'accent' });
      buttons.push({ id: 'abandon', label: '返回大厅', x: (1280 - 300) / 2, y: 520, w: 300, h: 46, style: 'ghost' });
      break;
    }
    case 'dead':
    case 'victory': {
      buttons.push({ id: 'retry', label: '再来一次', x: (1280 - 300) / 2, y: 496, w: 300, h: 54, style: 'accent' });
      buttons.push({ id: 'abandon', label: '返回大厅', x: (1280 - 300) / 2, y: 562, w: 300, h: 46, style: 'ghost' });
      break;
    }
    case 'settings': {
      const x = 300;
      const w = 680;
      const rows = ['masterVolume', 'sfxVolume', 'musicVolume', 'screenShake'];
      let y = 176;
      for (const key of rows) {
        buttons.push({ id: `set:${key}:dec`, label: '−', x: x + w - 152, y, w: 44, h: 36, style: 'ghost' });
        buttons.push({ id: `set:${key}:inc`, label: '+', x: x + w - 96, y, w: 44, h: 36, style: 'ghost' });
        y += 52;
      }
      const toggleKeys = ['showDamageNumbers', 'showMinimap', 'showSystemCursor'];
      for (let i = 0; i < toggleKeys.length; i++) {
        buttons.push({
          id: `toggle:${toggleKeys[i]}`,
          label: '',
          x: x + w - 140,
          y: y + i * 48,
          w: 120,
          h: 40,
          style: 'ghost',
        });
      }
      buttons.push({ id: 'settings-back', label: '返回', x: (1280 - 220) / 2, y: 548, w: 220, h: 48, style: 'accent' });
      break;
    }
    case 'none':
      break;
  }
  return buttons;
}

function isAffordable(opt: EventOption, ctx: OverlayContext): boolean {
  if (opt.cost?.gold && ctx.gold < opt.cost.gold) return false;
  if (opt.cost?.hp && ctx.hp <= opt.cost.hp) return false;
  return true;
}

// ------------------------------------------------------------------ 绘制

export function drawOverlay(
  ctx2d: CanvasRenderingContext2D,
  overlay: OverlayState,
  buttons: readonly UiButton[],
  hoverId: string | null,
  time: number,
  ctx: OverlayContext,
): void {
  if (overlay.mode === 'none') return;
  drawDim(ctx2d, overlay.mode === 'pause' ? 0.6 : 0.78);

  switch (overlay.mode) {
    case 'pause':
      drawPause(ctx2d, buttons, hoverId, time);
      break;
    case 'settings':
      drawSettings(ctx2d, buttons, hoverId, time, ctx.settings);
      break;
    case 'upgrade':
      drawUpgradeSelect(ctx2d, overlay, buttons, hoverId, time);
      break;
    case 'shop':
      drawShop(ctx2d, overlay, buttons, hoverId, time, ctx);
      break;
    case 'preboss':
      drawPrepShop(ctx2d, overlay, buttons, hoverId, time, ctx);
      break;
    case 'event':
      drawEvent(ctx2d, overlay, buttons, hoverId, time, ctx);
      break;
    case 'floorclear':
      drawFloorClear(ctx2d, buttons, hoverId, time, ctx);
      break;
    case 'dead':
    case 'victory':
      drawSummary(ctx2d, overlay, buttons, hoverId, time, ctx);
      break;
  }
}

function drawPause(
  ctx: CanvasRenderingContext2D,
  buttons: readonly UiButton[],
  hoverId: string | null,
  time: number,
): void {
  drawPanel(ctx, 380, 190, 520, 320, { radius: 18 });
  drawHeading(ctx, '已暂停', 640, 240, 34);
  drawDivider(ctx, 430, 266, 420);
  for (const b of buttons) drawButton(ctx, b, hoverId === b.id, false, time);
  drawHeading(
    ctx,
    '操作：WASD 移动 · 鼠标瞄准 · 左键射击 · Space 技能 · E 交互 · 1/2 切枪 · R 换弹',
    640,
    492,
    12,
    'center',
    'rgba(206,198,232,0.6)',
  );
}

function drawSettings(
  ctx: CanvasRenderingContext2D,
  buttons: readonly UiButton[],
  hoverId: string | null,
  time: number,
  settings: GameSettings,
): void {
  drawPanel(ctx, 284, 118, 712, 496, { radius: 18 });
  drawHeading(ctx, '设置', 640, 156, 30);
  drawDivider(ctx, 330, 180, 620);

  const x = 300;
  const w = 680;
  const rows: Array<[string, number]> = [
    ['主音量', settings.masterVolume],
    ['音效音量', settings.sfxVolume],
    ['音乐音量', settings.musicVolume],
    ['屏幕震动强度', settings.screenShake],
  ];
  ctx.save();
  ctx.textBaseline = 'middle';
  let y = 176;
  for (const [label, value] of rows) {
    ctx.fillStyle = UI_COLORS.text;
    ctx.font = '600 15px "PingFang SC","Segoe UI",sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, x, y + 18);
    drawBar(ctx, x, y + 30, w - 230, 12, value, UI_COLORS.gold);
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = '600 13px Consolas, monospace';
    ctx.fillText(`${Math.round(value * 100)}%`, x + w - 212, y + 18);
    y += 52;
  }

  const toggleRow: Array<[string, boolean, string]> = [
    ['showDamageNumbers', settings.showDamageNumbers, '显示伤害数字'],
    ['showMinimap', settings.showMinimap, '显示小地图'],
    ['showSystemCursor', settings.showSystemCursor, '始终显示系统鼠标光标'],
  ];
  ctx.textAlign = 'left';
  ctx.font = '600 15px "PingFang SC","Segoe UI",sans-serif';
  for (const [key, val, label] of toggleRow) {
    ctx.fillStyle = UI_COLORS.text;
    ctx.fillText(label, x, y + 20);
    const btn = buttons.find((b) => b.id === `toggle:${key}`);
    if (btn) {
      const bx = btn.x;
      const by = btn.y;
      if (hoverId === btn.id) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = '#ffffff';
        roundRect(ctx, bx - 4, by - 4, btn.w + 8, btn.h + 8, 24);
        ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = val ? 'rgba(126,242,192,0.85)' : 'rgba(70,62,96,0.9)';
      roundRect(ctx, bx, by, btn.w, btn.h, 20);
      ctx.fill();
      ctx.strokeStyle = val ? '#7ef2c0' : 'rgba(150,142,182,0.5)';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      const knobX = val ? bx + btn.w - 20 : bx + 20;
      ctx.beginPath();
      ctx.arc(knobX, by + btn.h / 2, 13, 0, TAU);
      ctx.fillStyle = val ? '#0e2b22' : '#c9c1e0';
      ctx.fill();
      ctx.fillStyle = val ? '#7ef2c0' : '#cfc6e6';
      ctx.font = '700 12px "PingFang SC",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(val ? '开' : '关', knobX, by + btn.h / 2 + 0.5);
      ctx.textAlign = 'left';
    }
    y += 48;
  }
  ctx.restore();

  for (const b of buttons) {
    if (b.w <= 0 || b.id.startsWith('toggle:')) continue;
    drawButton(ctx, b, hoverId === b.id, false, time);
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
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

function drawUpgradeSelect(
  ctx: CanvasRenderingContext2D,
  overlay: OverlayState,
  buttons: readonly UiButton[],
  hoverId: string | null,
  time: number,
): void {
  drawHeading(ctx, '强化选择', 640, 138, 36);
  drawHeading(
    ctx,
    '清理房间后获得一次强化，强化可以叠加成完全不同的 Build',
    640,
    174,
    14,
    'center',
    UI_COLORS.textDim,
  );

  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i]!;
    const id = overlay.upgradeOptions[i];
    if (!id) continue;
    const def = UPGRADES.find((u) => u.id === id);
    if (!def) continue;
    const hovered = hoverId === b.id;
    const stacks = overlay.upgradeStacks.find((s) => s.id === id)?.stacks ?? 0;

    drawButton(ctx, b, hovered, false, time);
    ctx.save();
    // 顶部色条
    ctx.fillStyle = hovered ? 'rgba(255,212,121,0.9)' : 'rgba(255,212,121,0.45)';
    ctx.fillRect(b.x + 14, b.y + 12, b.w - 28, 3);
    // 图标
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = hovered ? 0.42 : 0.22;
    const g = ctx.createRadialGradient(b.x + b.w / 2, b.y + 96, 4, b.x + b.w / 2, b.y + 96, 62);
    g.addColorStop(0, '#ffd479');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x + b.w / 2, b.y + 96, 62, 0, TAU);
    ctx.fill();
    ctx.restore();
    drawUpgradeIcon(ctx, def.icon, b.x + b.w / 2, b.y + 96, 54, hovered ? '#fff2cc' : UI_COLORS.gold);

    // 名称
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = UI_COLORS.text;
    ctx.font = '800 22px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText(def.name, b.x + b.w / 2, b.y + 156);

    // 效果说明
    ctx.fillStyle = hovered ? '#fff2cc' : UI_COLORS.textDim;
    ctx.font = '600 13px "PingFang SC","Segoe UI",sans-serif';
    wrapTextCenter(ctx, def.perStack, b.x + b.w / 2, b.y + 190, b.w - 46, 19);

    // 当前层数
    ctx.font = '700 12px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillStyle = stacks > 0 ? UI_COLORS.mint : 'rgba(150,142,182,0.7)';
    ctx.fillText(`当前 Lv.${stacks} / ${def.maxStacks}`, b.x + b.w / 2, b.y + b.h - 26);
    ctx.restore();
  }
}

function wrapTextCenter(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): void {
  const chars = [...text];
  const lines: string[] = [];
  let line = '';
  for (const ch of chars) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  lines.forEach((l, i) => ctx.fillText(l, cx, y + i * lineHeight));
}

function drawShop(
  ctx: CanvasRenderingContext2D,
  overlay: OverlayState,
  buttons: readonly UiButton[],
  hoverId: string | null,
  time: number,
  oc: OverlayContext,
): void {
  drawShopPanel(
    ctx,
    buttons,
    overlay.shopItems,
    hoverId,
    time,
    oc,
    'shop',
    '补给商店',
    '「东西明码标价，童叟无欺。」',
  );
}

/** 首领房入口的「战前补给站」：回复一半生命 / 弹匣扩容，然后开打。 */
function drawPrepShop(
  ctx: CanvasRenderingContext2D,
  overlay: OverlayState,
  buttons: readonly UiButton[],
  hoverId: string | null,
  time: number,
  oc: OverlayContext,
): void {
  drawShopPanel(
    ctx,
    buttons,
    overlay.prepItems,
    hoverId,
    time,
    oc,
    // ⚠️ 这里必须和 `buildOverlayButtons` / `handleOverlayClick` 里用的
    // 按钮 id 前缀**完全一致**（都是 `prep`）。曾经这里写成 `'preboss'`（模式名），
    // 导致 `'prep:0'.startsWith('preboss:')` 恒为 false ——
    // 四行商品全被跳过、`prep:start` 也匹配不上，
    // 玩家看到的就是"面板一片空白、没有关闭按钮"。
    'prep',
    '战前补给站',
    '「深渊之心就在门后 —— 整备好，再进去。」',
  );
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(200,162,255,0.85)';
  ctx.font = '600 13px "PingFang SC","Segoe UI",sans-serif';
  ctx.fillText('确认整备完毕后进入首领房，房门会立刻封闭。', 640, 540);
  ctx.restore();
}

/** 商店与战前补给站共用的面板绘制（两者只差标题、副标题与按钮前缀）。 */
function drawShopPanel(
  ctx: CanvasRenderingContext2D,
  buttons: readonly UiButton[],
  items: readonly ShopItem[],
  hoverId: string | null,
  time: number,
  oc: OverlayContext,
  prefix: 'shop' | 'prep',
  title: string,
  subtitle: string,
): void {
  drawPanel(ctx, 230, 96, 820, 578, { radius: 18 });
  drawHeading(ctx, title, 640, 136, 30);
  drawHeading(ctx, subtitle, 640, 164, 13, 'center', UI_COLORS.textDim);
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = UI_COLORS.gold;
  ctx.font = '700 16px "Segoe UI","PingFang SC",sans-serif';
  ctx.fillText(`金币 ${oc.gold}`, 1020, 136);
  ctx.restore();
  drawDivider(ctx, 270, 182, 740);

  for (const b of buttons) {
    if (!b.id.startsWith(`${prefix}:`)) continue;
    const idx = Number(b.id.split(':')[1]);
    // `prep:start` 的 idx 是 NaN，这里必须跳过 —— 它是按钮不是商品行，
    // 由下面第二个循环用 drawButton 画。
    if (!Number.isInteger(idx)) continue;
    const item = items[idx];
    if (!item) continue;
    drawShopRow(ctx, b, item, hoverId === b.id, oc);
  }
  for (const b of buttons) {
    if (b.id === `${prefix}:leave` || b.id === `${prefix}:start`) {
      drawButton(ctx, b, hoverId === b.id, false, time);
    }
  }
}

function drawShopRow(
  ctx: CanvasRenderingContext2D,
  b: UiButton,
  item: ShopItem,
  hovered: boolean,
  oc: OverlayContext,
): void {
  const dim = item.sold || oc.gold < item.price;
  ctx.save();
  ctx.globalAlpha = item.sold ? 0.45 : 1;
  ctx.fillStyle = hovered && !dim ? 'rgba(60,50,88,0.95)' : 'rgba(32,26,48,0.9)';
  roundRect(ctx, b.x, b.y, b.w, b.h, 12);
  ctx.fill();
  ctx.strokeStyle = dim ? 'rgba(120,112,150,0.3)' : hovered ? UI_COLORS.borderStrong : 'rgba(255,212,121,0.28)';
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // 图标
  const iconX = b.x + 46;
  const iconY = b.y + b.h / 2;
  if (item.kind === 'weapon' && item.weaponId) {
    drawWeaponIcon(ctx, getWeaponDef(item.weaponId), iconX - 16, iconY, 42);
  } else if (item.kind === 'upgrade' && item.upgradeId) {
    const def = UPGRADES.find((u) => u.id === item.upgradeId);
    if (def) drawUpgradeIcon(ctx, def.icon, iconX, iconY, 34, UI_COLORS.gold);
  } else {
    const glyph =
      item.kind === 'heal' || item.kind === 'healHalf'
        ? 'heart'
        : item.kind === 'ammo' || item.kind === 'magPlus'
          ? 'mag'
          : 'shield';
    drawUpgradeIcon(ctx, glyph as never, iconX, iconY, 32, UI_COLORS.mint);
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = UI_COLORS.text;
  ctx.font = '700 16px "PingFang SC","Segoe UI",sans-serif';
  ctx.fillText(item.label, b.x + 92, b.y + 28);
  ctx.fillStyle = UI_COLORS.textDim;
  ctx.font = '500 13px "PingFang SC","Segoe UI",sans-serif';
  wrapText(ctx, item.desc, b.x + 92, b.y + 52, b.w - 240, 17);

  // 价格
  ctx.textAlign = 'right';
  const priceY = b.y + b.h / 2;
  if (item.sold) {
    ctx.fillStyle = 'rgba(150,142,182,0.8)';
    ctx.font = '700 14px "PingFang SC",sans-serif';
    ctx.fillText(item.note ?? '已售出', b.x + b.w - 22, priceY);
  } else {
    ctx.fillStyle = oc.gold >= item.price ? UI_COLORS.gold : UI_COLORS.danger;
    ctx.font = '800 18px "Segoe UI",sans-serif';
    ctx.fillText(`${item.price}`, b.x + b.w - 42, priceY);
    ctx.beginPath();
    ctx.arc(b.x + b.w - 26, priceY, 7, 0, TAU);
    ctx.fillStyle = oc.gold >= item.price ? '#f2c14e' : '#a05a4a';
    ctx.fill();
  }
  ctx.restore();
}

function drawEvent(
  ctx: CanvasRenderingContext2D,
  overlay: OverlayState,
  buttons: readonly UiButton[],
  hoverId: string | null,
  time: number,
  oc: OverlayContext,
): void {
  const ev = overlay.event;
  if (!ev) return;
  drawPanel(ctx, 300, 96, 680, 300, { radius: 18 });
  drawHeading(ctx, ev.def.title, 640, 140, 30);
  drawDivider(ctx, 350, 166, 580);
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = UI_COLORS.textDim;
  ctx.font = '500 15px "PingFang SC","Segoe UI",sans-serif';
  wrapText(ctx, ev.def.body, 348, 188, 584, 26);
  ctx.restore();

  if (ev.resolvedIndex >= 0 && ev.resultText) {
    drawPanel(ctx, 300, 250, 680, 96, { radius: 12, fill: 'rgba(52,40,74,0.95)' });
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = UI_COLORS.mint;
    ctx.font = '700 16px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText(ev.resultText, 640, 298);
    ctx.restore();
  }

  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = UI_COLORS.gold;
  ctx.font = '700 14px "Segoe UI","PingFang SC",sans-serif';
  ctx.fillText(`金币 ${oc.gold}　生命 ${Math.ceil(oc.hp)}/${Math.round(oc.maxHp)}`, 960, 140);
  ctx.restore();

  for (const b of buttons) {
    drawButton(ctx, b, hoverId === b.id, false, time);
  }
}

function drawFloorClear(
  ctx: CanvasRenderingContext2D,
  buttons: readonly UiButton[],
  hoverId: string | null,
  time: number,
  oc: OverlayContext,
): void {
  drawPanel(ctx, 340, 118, 600, 480, { radius: 18 });
  drawHeading(ctx, `第 ${oc.floor} 层 · 已清理`, 640, 168, 30);
  drawDivider(ctx, 390, 196, 500);
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const rows: Array<[string, string]> = [
    ['角色', oc.characterName],
    ['击倒敌人', `${oc.kills}`],
    ['清理房间', `${oc.rooms}`],
    ['累计金币', `${oc.gold}`],
    ['用时', formatTime(oc.timeSec)],
    ['当前得分', `${oc.score}`],
  ];
  let y = 236;
  for (const [k, v] of rows) {
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = '600 15px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText(k, 400, y);
    ctx.fillStyle = UI_COLORS.text;
    ctx.font = '700 16px "Segoe UI","PingFang SC",sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(v, 880, y);
    ctx.textAlign = 'left';
    y += 34;
  }
  ctx.restore();
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = UI_COLORS.mint;
  ctx.font = '600 13px "PingFang SC","Segoe UI",sans-serif';
  ctx.fillText('下一层敌人更强，但奖励也更丰厚。', 640, 424);
  ctx.restore();
  for (const b of buttons) drawButton(ctx, b, hoverId === b.id, false, time);
}

function drawSummary(
  ctx: CanvasRenderingContext2D,
  overlay: OverlayState,
  buttons: readonly UiButton[],
  hoverId: string | null,
  time: number,
  oc: OverlayContext,
): void {
  const won = overlay.mode === 'victory';
  drawPanel(ctx, 340, 96, 600, 540, { radius: 18 });
  drawHeading(ctx, won ? '通关成功' : '远征失败', 640, 148, 40, 'center', won ? '#7ef2c0' : '#ff8a7a');
  drawHeading(
    ctx,
    won ? '你击碎了深渊之心，地牢暂时安静下来。' : `被 ${overlay.death?.cause ?? '未知力量'} 击倒在第 ${oc.floor} 层`,
    640,
    182,
    13,
    'center',
    UI_COLORS.textDim,
  );
  drawDivider(ctx, 390, 206, 500);

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const rows: Array<[string, string]> = [
    ['角色', oc.characterName],
    ['抵达层数', `${oc.floor} / ${oc.floorCount}`],
    ['击倒敌人', `${oc.kills}`],
    ['清理房间', `${oc.rooms}`],
    ['金币', `${oc.gold}`],
    ['用时', formatTime(oc.timeSec)],
  ];
  let y = 248;
  for (const [k, v] of rows) {
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = '600 15px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText(k, 400, y);
    ctx.fillStyle = UI_COLORS.text;
    ctx.font = '700 16px "Segoe UI","PingFang SC",sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(v, 880, y);
    ctx.textAlign = 'left';
    y += 34;
  }
  ctx.restore();

  // 得分
  drawPanel(ctx, 400, 452, 480, 44, { radius: 10, fill: 'rgba(52,40,74,0.9)' });
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = UI_COLORS.gold;
  ctx.font = '700 15px "PingFang SC","Segoe UI",sans-serif';
  ctx.fillText('本局得分', 520, 474);
  ctx.font = '800 22px "Segoe UI",monospace';
  ctx.fillText(`${oc.score}`, 720, 474);
  ctx.restore();

  for (const b of buttons) drawButton(ctx, b, hoverId === b.id, false, time);
  void drawKeyHint;
  void clamp;
}

export { formatTime } from './widgets';
