/** UI 基础组件：面板、按钮、标题、进度条、滑块式的加减控件。 */
import { TAU, clamp } from '../core/math';
import { darken, lighten, roundedRectPath, withAlpha } from '../render/art';

export interface UiButton {
  id: string;
  label: string;
  hint?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  enabled?: boolean;
  style?: 'primary' | 'ghost' | 'danger' | 'accent';
  /** 卡片型按钮（用于强化/商店） */
  card?: boolean;
}

export const UI_COLORS = {
  panel: 'rgba(18,14,28,0.94)',
  panelLight: 'rgba(30,25,44,0.96)',
  border: 'rgba(255,212,121,0.32)',
  borderStrong: 'rgba(255,212,121,0.7)',
  text: '#f3ecff',
  textDim: 'rgba(206,198,232,0.72)',
  gold: '#ffd479',
  mint: '#7ef2c0',
  danger: '#ff7a6a',
};

export function drawPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  options: { radius?: number; fill?: string; border?: string; glow?: boolean } = {},
): void {
  const r = options.radius ?? 14;
  ctx.save();
  if (options.glow !== false) {
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 8;
  }
  ctx.fillStyle = options.fill ?? UI_COLORS.panel;
  roundedRectPath(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.restore();

  ctx.save();
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, 'rgba(255,255,255,0.06)');
  g.addColorStop(0.4, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  roundedRectPath(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.strokeStyle = options.border ?? UI_COLORS.border;
  ctx.lineWidth = 1.6;
  roundedRectPath(ctx, x, y, w, h, r);
  ctx.stroke();
  ctx.restore();
}

export function drawButton(
  ctx: CanvasRenderingContext2D,
  b: UiButton,
  hovered: boolean,
  pressed: boolean,
  time: number,
): void {
  const enabled = b.enabled !== false;
  const style = b.style ?? 'primary';
  ctx.save();

  let fill = 'rgba(38,31,56,0.96)';
  let border = 'rgba(255,212,121,0.4)';
  let text = UI_COLORS.text;
  if (style === 'primary') {
    fill = hovered && enabled ? 'rgba(70,56,102,0.98)' : 'rgba(46,38,68,0.96)';
    border = hovered && enabled ? UI_COLORS.borderStrong : 'rgba(255,212,121,0.4)';
  } else if (style === 'accent') {
    fill = hovered && enabled ? '#ffd479' : '#e8b64a';
    border = '#fff2cc';
    text = '#241a08';
  } else if (style === 'danger') {
    fill = hovered && enabled ? 'rgba(126,42,44,0.98)' : 'rgba(84,30,34,0.94)';
    border = hovered && enabled ? '#ff8a7a' : 'rgba(255,120,100,0.42)';
  } else {
    fill = hovered && enabled ? 'rgba(50,43,72,0.9)' : 'rgba(28,23,42,0.8)';
    border = 'rgba(170,160,208,0.36)';
  }
  if (!enabled) {
    fill = 'rgba(26,22,38,0.7)';
    border = 'rgba(120,112,150,0.28)';
    text = 'rgba(150,142,182,0.7)';
  }

  const lift = hovered && enabled ? -2 : 0;
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = hovered && enabled ? 18 : 8;
  ctx.shadowOffsetY = 4 + (hovered ? 2 : 0);
  ctx.fillStyle = fill;
  roundedRectPath(ctx, b.x, b.y + lift, b.w, b.h, b.card ? 12 : 10);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  if (hovered && enabled && style !== 'accent') {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.16 + Math.sin(time * 4) * 0.05;
    ctx.fillStyle = '#ffd479';
    roundedRectPath(ctx, b.x, b.y + lift, b.w, b.h, b.card ? 12 : 10);
    ctx.fill();
    ctx.restore();
  }

  ctx.strokeStyle = border;
  ctx.lineWidth = pressed ? 2.4 : 1.8;
  roundedRectPath(ctx, b.x, b.y + lift, b.w, b.h, b.card ? 12 : 10);
  ctx.stroke();

  ctx.fillStyle = text;
  ctx.textAlign = b.card ? 'left' : 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 16px "PingFang SC","Segoe UI",sans-serif';
  if (b.card) {
    ctx.fillText(b.label, b.x + 18, b.y + lift + (b.hint ? 24 : b.h / 2));
    if (b.hint) {
      ctx.fillStyle = enabled ? UI_COLORS.textDim : 'rgba(150,142,182,0.6)';
      ctx.font = '500 13px "PingFang SC","Segoe UI",sans-serif';
      wrapText(ctx, b.hint, b.x + 18, b.y + lift + 50, b.w - 36, 17);
    }
  } else {
    ctx.fillText(b.label, b.x + b.w / 2, b.y + lift + b.h / 2 + 0.5);
  }
  ctx.restore();
}

export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): void {
  const chars = [...text];
  let line = '';
  let ly = y;
  for (const ch of chars) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line.length) {
      ctx.fillText(line, x, ly);
      line = ch;
      ly += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, ly);
}

export function hitTest(buttons: readonly UiButton[], mx: number, my: number): UiButton | null {
  for (let i = buttons.length - 1; i >= 0; i--) {
    const b = buttons[i]!;
    if (b.enabled === false) continue;
    if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return b;
  }
  return null;
}

export function drawBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  value: number,
  color: string,
  bg = 'rgba(10,8,18,0.8)',
): void {
  ctx.save();
  ctx.fillStyle = bg;
  roundedRectPath(ctx, x, y, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = color;
  roundedRectPath(ctx, x, y, Math.max(0, w * clamp(value, 0, 1)), h, h / 2);
  ctx.fill();
  ctx.restore();
}

export function drawHeading(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  align: CanvasTextAlign = 'center',
  color = UI_COLORS.gold,
): void {
  ctx.save();
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.font = `800 ${size}px "PingFang SC","Segoe UI",sans-serif`;
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

export function drawKeyHint(
  ctx: CanvasRenderingContext2D,
  key: string,
  text: string,
  x: number,
  y: number,
  align: CanvasTextAlign = 'left',
): void {
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.font = '700 12px "Segoe UI",sans-serif';
  const kw = ctx.measureText(key).width + 14;
  ctx.font = '600 12px "PingFang SC","Segoe UI",sans-serif';
  const tw = ctx.measureText(text).width;
  const totalW = kw + 8 + tw;
  const startX = align === 'center' ? x - totalW / 2 : align === 'right' ? x - totalW : x;

  ctx.fillStyle = 'rgba(255,212,121,0.16)';
  roundedRectPath(ctx, startX, y - 10, kw, 20, 5);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,212,121,0.5)';
  ctx.lineWidth = 1.2;
  roundedRectPath(ctx, startX, y - 10, kw, 20, 5);
  ctx.stroke();
  ctx.fillStyle = UI_COLORS.gold;
  ctx.font = '700 12px "Segoe UI",sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(key, startX + kw / 2, y + 0.5);
  ctx.fillStyle = UI_COLORS.textDim;
  ctx.font = '600 12px "PingFang SC","Segoe UI",sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(text, startX + kw + 8, y + 0.5);
  ctx.restore();
}

/** 全屏暗化背景。 */
/**
 * 秒 → `m:ss`。结算面板与存档列表共用一份实现
 * （原先只长在 overlays.ts 里，需求 20 的存档页也要用，所以挪到公共组件层）。
 */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, '0');
  return `${m}:${ss}`;
}

export function drawDim(ctx: CanvasRenderingContext2D, alpha = 0.66): void {
  ctx.save();
  ctx.fillStyle = `rgba(6,5,13,${alpha})`;
  ctx.fillRect(0, 0, 1280, 720);
  ctx.restore();
}

/** 装饰性边框（标题栏用）。 */
export function drawDivider(ctx: CanvasRenderingContext2D, x: number, y: number, w: number): void {
  ctx.save();
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, 'rgba(255,212,121,0)');
  g.addColorStop(0.5, 'rgba(255,212,121,0.55)');
  g.addColorStop(1, 'rgba(255,212,121,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, 1.6);
  ctx.restore();
}

export function drawSpinner(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, time: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(time * 2.4);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {
    ctx.globalAlpha = 0.8 - i * 0.22;
    ctx.strokeStyle = UI_COLORS.gold;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, r - i * 5, (i / 3) * TAU, (i / 3) * TAU + 2);
    ctx.stroke();
  }
  ctx.restore();
}

export { darken, lighten, withAlpha, roundedRectPath };
