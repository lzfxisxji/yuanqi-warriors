/** 大厅界面：主菜单、角色选择、图鉴（武器 / 敌人）、设置入口。 */
import { TAU, clamp } from '../core/math';
import { MAX_PLAYERS, ROOM_CODE_LEN } from '../data/config';
import { CHARACTERS, getCharacter, isCharacterUnlocked, unlockHint, type CharacterDef } from '../data/characters';
import { WEAPONS, getWeaponDef, type WeaponDef } from '../data/weapons';
import { ENEMIES, getEnemyDef, type EnemyDef } from '../data/enemies';
import type { GameProgress, GameSettings } from '../systems/save';
import {
  UI_COLORS,
  drawButton,
  drawDim,
  drawDivider,
  drawHeading,
  drawKeyHint,
  drawPanel,
  drawSpinner,
  wrapText,
  type UiButton,
} from './widgets';
import { drawCharacterPortrait, drawEliteBadge, drawUpgradeIcon, drawWeaponIcon } from '../render/art';

export type MenuMode = 'main' | 'charselect' | 'settings' | 'codex' | 'multi';

/** 联机大厅阶段：idle 选模式/建房/加入；room 已在房间内。 */
export type LobbyPhase = 'idle' | 'room';

export interface LobbyMember {
  name: string;
  color: string;
  isHost: boolean;
  /** 角色 id（房主/中继在 join/peerJoined 里下发）。 */
  charId: string;
}

export interface LobbyInfo {
  phase: LobbyPhase;
  mode: 'coop' | 'pk';
  isHost: boolean;
  code: string;
  members: LobbyMember[];
  status: string;
  /** 正在输入房间号（加入流程）。 */
  joining: boolean;
  codeInput: string;
  /** 本地玩家设置的名字（建房/加入前可编辑）。 */
  name: string;
}

export function createLobbyInfo(): LobbyInfo {
  return {
    phase: 'idle',
    mode: 'coop',
    isHost: false,
    code: '',
    members: [],
    status: '',
    joining: false,
    codeInput: '',
    name: '',
  };
}

/**
 * 主菜单右侧「当前房间」面板外框。
 * **高度固定为半高卡片**（旧的 572 高整栏被用户否掉：空状态下大半屏是空的）。
 * 房间内成员最多 4 人，用紧凑行排得下，所以两种状态共用同一尺寸、不跳变。
 */
const ROOM_PANEL = { x: 640, y: 108, w: 560, h: 286 };

/** 大厅「身份」面板坐标（与 buildMenuButtons 共用，保证点击区与绘制一致）。 */
const NAME_BOX = { x: 296, y: 158, w: 372, h: 46 };
/**
 * 大厅里的角色小卡。数量必须跟着 `CHARACTERS` 走 —— 写死 3 个的话，
 * 角色增加到 5 个时 `CHAR_CARDS[3]` 会是 undefined，`buildMenuButtons` 直接崩。
 * 从 x=700 起向右排，间距由可用宽度均分。
 */
const CHAR_CARD_AREA = { x: 700, y: 158, w: 508, h: 112, gap: 8 };
const CHAR_CARDS: { x: number; y: number; w: number; h: number }[] = (() => {
  const n = Math.max(1, CHARACTERS.length);
  const w = Math.floor((CHAR_CARD_AREA.w - CHAR_CARD_AREA.gap * (n - 1)) / n);
  return Array.from({ length: n }, (_, i) => ({
    x: CHAR_CARD_AREA.x + i * (w + CHAR_CARD_AREA.gap),
    y: CHAR_CARD_AREA.y,
    w,
    h: CHAR_CARD_AREA.h,
  }));
})();

/** 图鉴分页：武器 / 敌人 / 角色（共用同一套「左列表 + 右详情」布局）。 */
export type CodexTab = 'weapon' | 'enemy' | 'character';

export interface MenuState {
  mode: MenuMode;
  previous: MenuMode;
  selectedChar: number;
  codexTab: CodexTab;
  codexIndex: number;
  confirmReset: boolean;
  lobby: LobbyInfo;
}

export function createMenuState(): MenuState {
  return {
    mode: 'main',
    previous: 'main',
    selectedChar: 0,
    codexTab: 'weapon',
    codexIndex: 0,
    confirmReset: false,
    lobby: createLobbyInfo(),
  };
}

export interface MenuData {
  progress: GameProgress;
  settings: GameSettings;
  discoveredWeapons: string[];
  unlockedCharacters: string[];
}

export function buildMenuButtons(state: MenuState): UiButton[] {
  const buttons: UiButton[] = [];
  switch (state.mode) {
    case 'main': {
      const w = 300;
      const x = 92;
      // 已在房间内：按钮变成「返回房间」（回到大厅等待，不会掉线）
      const inRoom = state.lobby.phase === 'room' && state.lobby.code.length > 0;
      buttons.push({ id: 'start', label: '开始远征', x, y: 356, w, h: 52, style: 'accent' });
      buttons.push({
        id: 'multi',
        label: inRoom ? '返回房间' : '联机模式',
        x,
        y: 416,
        w,
        h: 46,
        style: inRoom ? 'accent' : 'primary',
      });
      buttons.push({ id: 'codex', label: '图鉴', x, y: 470, w, h: 42, style: 'ghost' });
      buttons.push({ id: 'settings', label: '设置', x, y: 518, w, h: 42, style: 'ghost' });
      buttons.push({ id: 'reset', label: state.confirmReset ? '再次点击确认清除存档' : '清除存档', x, y: 566, w, h: 38, style: 'danger' });
      break;
    }
    case 'multi': {
      const lb = state.lobby;
      if (lb.joining) {
        buttons.push({ id: 'mm-join-confirm', label: '确认加入', x: 470, y: 486, w: 200, h: 54, style: 'accent' });
        buttons.push({ id: 'mm-join-cancel', label: '取消', x: 690, y: 486, w: 140, h: 54, style: 'ghost' });
        break;
      }
      if (lb.phase === 'idle') {
        // 身份面板：名字 + 角色（点击编辑名字 / 选角色）
        buttons.push({ id: 'mm-name', label: '', x: NAME_BOX.x, y: NAME_BOX.y, w: NAME_BOX.w, h: NAME_BOX.h, style: 'ghost' });
        for (let i = 0; i < CHARACTERS.length; i++) {
          buttons.push({
            id: `mm-char:${i}`,
            label: '',
            x: CHAR_CARDS[i]!.x,
            y: CHAR_CARDS[i]!.y,
            w: CHAR_CARDS[i]!.w,
            h: CHAR_CARDS[i]!.h,
            style: 'ghost',
            card: true,
          });
        }
        buttons.push({ id: 'mm-mode-coop', label: '合作闯关', x: 270, y: 270, w: 360, h: 120, style: lb.mode === 'coop' ? 'accent' : 'ghost' });
        buttons.push({ id: 'mm-mode-pk', label: '自由混战', x: 650, y: 270, w: 360, h: 120, style: lb.mode === 'pk' ? 'accent' : 'ghost' });
        buttons.push({ id: 'mm-create', label: '创建房间', x: 430, y: 420, w: 420, h: 56, style: 'accent' });
        buttons.push({ id: 'mm-join', label: '加入房间', x: 430, y: 486, w: 420, h: 50, style: 'primary' });
        buttons.push({ id: 'mm-back', label: '返回大厅', x: 540, y: 544, w: 200, h: 44, style: 'ghost' });
      } else {
        buttons.push({ id: 'mm-start', label: lb.isHost ? '开始远征' : '等待房主开始…', x: 430, y: 496, w: 420, h: 58, style: 'accent', enabled: lb.isHost });
        buttons.push({ id: 'mm-leave', label: '离开房间', x: 540, y: 566, w: 200, h: 46, style: 'danger' });
      }
      break;
    }
    case 'charselect': {
      const total = CHARACTERS.length;
      // 卡片宽度自适应：角色从 3 个涨到 5 个后，写死 320 会让总宽 1696 冲出 1280 画面。
      // 6 个角色时 210 的旧下限让总宽变成 1350 依然越界，所以**下限必须彻底去掉**，
      // 改成按可用宽度实算，只把间距一起压缩（4-5 人 gap=18，6 人及以上 gap=12）。
      // 实测：5 人 cardW=230 / 6 人 194 / 7 人 164 / 8 人 142，右边缘始终 ≤1252。
      const gap = total > 5 ? 12 : 18;
      const avail = 1280 - 56;
      const ideal = 320;
      const fit = Math.floor((avail - gap * (total - 1)) / total);
      const cardW = Math.min(ideal, fit);
      const startX = (1280 - (cardW * total + gap * (total - 1))) / 2;
      for (let i = 0; i < total; i++) {
        buttons.push({
          id: `char:${i}`,
          label: '',
          x: startX + i * (cardW + gap),
          y: 118,
          w: cardW,
          h: 428,
          style: 'ghost',
          card: true,
        });
      }
      buttons.push({ id: 'confirm-char', label: '进入地牢', x: 470, y: 584, w: 340, h: 60, style: 'accent' });
      buttons.push({ id: 'menu-back', label: '返回', x: (1280 - 200) / 2, y: 656, w: 200, h: 44, style: 'ghost' });
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
      const toggleY = 390;
      const toggleKeys = ['showDamageNumbers', 'showMinimap', 'showSystemCursor'];
      for (let i = 0; i < toggleKeys.length; i++) {
        buttons.push({
          id: `toggle:${toggleKeys[i]}`,
          label: '',
          x: x + w - 140,
          y: toggleY + i * 48,
          w: 120,
          h: 40,
          style: 'ghost',
        });
      }
      buttons.push({ id: 'menu-back', label: '返回', x: (1280 - 220) / 2, y: 560, w: 220, h: 48, style: 'accent' });
      break;
    }
    case 'codex': {
      buttons.push({ id: 'codex-tab-weapon', label: '武器图鉴', x: 92, y: 96, w: 156, h: 44, style: state.codexTab === 'weapon' ? 'accent' : 'ghost' });
      buttons.push({ id: 'codex-tab-enemy', label: '敌人图鉴', x: 256, y: 96, w: 156, h: 44, style: state.codexTab === 'enemy' ? 'accent' : 'ghost' });
      buttons.push({ id: 'codex-tab-character', label: '角色图鉴', x: 420, y: 96, w: 156, h: 44, style: state.codexTab === 'character' ? 'accent' : 'ghost' });
      const listLen = codexList(state.codexTab).length;
      for (let i = 0; i < listLen; i++) {
        buttons.push({
          id: `codex:${i}`,
          label: '',
          x: 92,
          y: 160 + i * 58,
          w: 340,
          h: 50,
          style: 'ghost',
          card: true,
        });
      }
      buttons.push({ id: 'menu-back', label: '返回大厅', x: (1280 - 220) / 2, y: 644, w: 220, h: 48, style: 'accent' });
      break;
    }
  }
  return buttons;
}

export function drawMenu(
  ctx: CanvasRenderingContext2D,
  state: MenuState,
  buttons: readonly UiButton[],
  hoverId: string | null,
  time: number,
  data: MenuData,
): void {
  drawBackground(ctx, time);
  switch (state.mode) {
    case 'main':
      drawMain(ctx, state, buttons, hoverId, time);
      break;
    case 'charselect':
      drawCharSelect(ctx, state, buttons, hoverId, time, data);
      break;
    case 'settings':
      drawSettingsPanel(ctx, buttons, hoverId, time, data.settings);
      break;
    case 'codex':
      drawCodex(ctx, state, buttons, hoverId, time, data);
      break;
    case 'multi':
      drawLobby(ctx, state, buttons, hoverId, time);
      break;
  }
  // 主菜单右侧面板已展示房间信息，其余页面用右上角徽标兜底
  if (state.lobby.code && state.mode !== 'main' && state.mode !== 'multi') {
    drawRoomBadge(ctx, state.lobby.code);
  }
}

function drawBackground(ctx: CanvasRenderingContext2D, time: number): void {
  // 地牢氛围背景：石墙 + 火把光晕 + 漂浮尘埃
  ctx.save();
  const g = ctx.createLinearGradient(0, 0, 0, 720);
  g.addColorStop(0, '#1a1526');
  g.addColorStop(0.55, '#130f1e');
  g.addColorStop(1, '#0a0812');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1280, 720);

  // 远景石砖
  ctx.globalAlpha = 0.35;
  for (let y = 0; y < 720; y += 48) {
    for (let x = ((y / 48) % 2) * 48 - 48; x < 1280; x += 96) {
      ctx.fillStyle = (x + y) % 192 === 0 ? '#221c31' : '#1c1729';
      ctx.fillRect(x, y, 94, 46);
      ctx.strokeStyle = 'rgba(10,8,16,0.8)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, 94, 46);
    }
  }
  ctx.globalAlpha = 1;

  // 中央光晕
  const lg = ctx.createRadialGradient(640, 300, 40, 640, 300, 620);
  lg.addColorStop(0, 'rgba(255,180,90,0.14)');
  lg.addColorStop(0.6, 'rgba(120,90,180,0.07)');
  lg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = lg;
  ctx.fillRect(0, 0, 1280, 720);

  // 两侧火把
  for (const tx of [140, 1140]) {
    const flicker = 1 + Math.sin(time * 6 + tx) * 0.12;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const fg = ctx.createRadialGradient(tx, 400, 4, tx, 400, 190 * flicker);
    fg.addColorStop(0, 'rgba(255,190,110,0.4)');
    fg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.arc(tx, 400, 190 * flicker, 0, TAU);
    ctx.fill();
    // 火焰
    for (let i = 0; i < 5; i++) {
      const t = time * 4 + i * 1.7;
      const fx = tx + Math.sin(t) * 5;
      const fy = 396 - Math.abs(Math.sin(t * 0.7)) * 16 - i * 3;
      const rr = 10 - i * 1.4;
      ctx.fillStyle = i < 2 ? 'rgba(255,240,190,0.85)' : i < 3 ? 'rgba(255,170,60,0.7)' : 'rgba(255,90,30,0.5)';
      ctx.beginPath();
      ctx.arc(fx, fy, rr, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    // 火把杆
    ctx.fillStyle = '#3b3040';
    ctx.fillRect(tx - 5, 400, 10, 96);
    ctx.fillStyle = '#5a4a34';
    ctx.fillRect(tx - 7, 388, 14, 18);
  }

  // 漂浮尘埃
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 40; i++) {
    const seed = i * 137.5;
    const x = (seed * 7.3 + time * 12 * (0.3 + (i % 5) * 0.14)) % 1280;
    const y = ((seed * 3.1 - time * 18 * (0.4 + (i % 3) * 0.2)) % 720 + 720) % 720;
    const a = 0.12 + (i % 4) * 0.05;
    ctx.fillStyle = `rgba(255,220,160,${a})`;
    ctx.beginPath();
    ctx.arc(x, y, 1 + (i % 3) * 0.7, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  ctx.restore();
}

function drawMain(
  ctx: CanvasRenderingContext2D,
  state: MenuState,
  buttons: readonly UiButton[],
  hoverId: string | null,
  time: number,
): void {
  // 标题
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '900 78px "PingFang SC","Segoe UI",sans-serif';
  ctx.shadowColor = 'rgba(255,170,60,0.55)';
  ctx.shadowBlur = 34;
  const tg = ctx.createLinearGradient(90, 180, 90, 268);
  tg.addColorStop(0, '#fff4d8');
  tg.addColorStop(0.5, '#ffd479');
  tg.addColorStop(1, '#e08a2a');
  ctx.fillStyle = tg;
  ctx.fillText('元气勇士', 92, 214);
  ctx.shadowBlur = 0;
  ctx.font = '700 18px "Segoe UI","PingFang SC",sans-serif';
  ctx.fillStyle = 'rgba(255,212,121,0.72)';
  ctx.fillText('Y U A N Q I   W A R R I O R S   ·   裂隙地牢', 96, 268);
  ctx.font = '500 14px "PingFang SC","Segoe UI",sans-serif';
  ctx.fillStyle = 'rgba(206,198,232,0.66)';
  wrapText(
    ctx,
    '原创俯视角地牢射击 Roguelike。每一次远征都会重新生成地牢，收集武器与强化，击碎深渊之心。',
    96,
    302,
    430,
    22,
  );
  ctx.restore();
  drawDivider(ctx, 92, 344, 420);

  for (const b of buttons) drawButton(ctx, b, hoverId === b.id, false, time);

  // 右侧：当前房间（房间号 + 模式 + 成员；未建房时给引导）
  drawRoomPanel(ctx, state, time);

  // 底部按键提示（分两行，避免压到右侧面板）
  drawKeyHint(ctx, 'WASD', '移动', 92, 624);
  drawKeyHint(ctx, '鼠标左键', '射击', 220, 624);
  drawKeyHint(ctx, 'Space', '技能', 392, 624);
  drawKeyHint(ctx, 'E', '交互', 92, 664);
  drawKeyHint(ctx, '1 / 2', '切换武器', 200, 664);
  drawKeyHint(ctx, 'R', '换弹', 330, 664);
  drawKeyHint(ctx, 'Esc', '暂停', 424, 664);
}

/** 右上角房间号徽标（主菜单之外的其他页面用，避免离开主菜单后丢失房间号）。 */
function drawRoomBadge(ctx: CanvasRenderingContext2D, code: string): void {
  const cw = 208;
  const chh = 48;
  const cx = 1280 - cw - 24;
  const cy = 24;
  ctx.save();
  ctx.fillStyle = 'rgba(12,10,20,0.72)';
  roundRect(ctx, cx, cy, cw, chh, 10);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,212,121,0.5)';
  ctx.lineWidth = 1.4;
  roundRect(ctx, cx, cy, cw, chh, 10);
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = UI_COLORS.textDim;
  ctx.font = '600 11px "PingFang SC","Segoe UI",sans-serif';
  ctx.fillText('房间号', cx + 14, cy + 17);
  ctx.fillStyle = UI_COLORS.gold;
  ctx.font = '800 20px Consolas, monospace';
  ctx.fillText(code, cx + 14, cy + 32);
  ctx.restore();
}

/** 等宽大字间距文本（房间号），不依赖 ctx.letterSpacing。 */
function drawSpacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  spacing: number,
): void {
  const chars = [...text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, chars.length - 1);
  let x = cx - total / 2;
  ctx.save();
  ctx.textAlign = 'left';
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i]!, x, cy);
    x += widths[i]! + spacing;
  }
  ctx.restore();
}

/**
 * 主菜单右侧「当前房间」面板（半高卡片，尺寸见 ROOM_PANEL）。
 * 未建房 → 只有虚线占位框；已在房间 → 房间号 + 模式 + 成员行。
 * 注意：本面板**不注册按钮**，所有点击区都在 buildMenuButtons 里（左侧按钮列负责操作）。
 */
function drawRoomPanel(ctx: CanvasRenderingContext2D, state: MenuState, time: number): void {
  const lb = state.lobby;
  const inRoom = lb.phase === 'room' && lb.code.length > 0;
  const left = 682;
  const right = 1158;
  const width = right - left;

  drawPanel(ctx, ROOM_PANEL.x, ROOM_PANEL.y, ROOM_PANEL.w, ROOM_PANEL.h, { radius: 16 });
  drawHeading(ctx, '当前房间', 920, 138, 22);
  drawDivider(ctx, left, 160, width);

  if (!inRoom) {
    // 空状态：只留一个占位框（面板半高，下半部分的说明文字已按要求去掉）
    ctx.save();
    ctx.strokeStyle = 'rgba(150,142,182,0.34)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([9, 7]);
    roundRect(ctx, left, 184, width, 172, 12);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = '600 18px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText('尚未创建或加入房间', 920, 258);
    ctx.font = '500 13px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillStyle = 'rgba(206,198,232,0.5)';
    ctx.fillText(`${ROOM_CODE_LEN} 位房间号会常驻显示在这里`, 920, 292);
    ctx.restore();
    return;
  }

  // 房间号
  ctx.save();
  ctx.fillStyle = 'rgba(10,8,18,0.82)';
  roundRect(ctx, left, 172, width, 66, 12);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,212,121,0.5)';
  ctx.lineWidth = 1.6;
  roundRect(ctx, left, 172, width, 66, 12);
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = UI_COLORS.textDim;
  ctx.font = '600 11px "PingFang SC","Segoe UI",sans-serif';
  ctx.fillText('房间号', left + 18, 188);
  ctx.font = '800 32px Consolas, "Segoe UI", monospace';
  ctx.shadowColor = 'rgba(255,170,60,0.5)';
  ctx.shadowBlur = 12 + Math.sin(time * 2.4) * 4;
  ctx.fillStyle = UI_COLORS.gold;
  drawSpacedText(ctx, lb.code, 920, 214, 12);
  ctx.restore();

  // 模式 + 人数
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = lb.mode === 'coop' ? UI_COLORS.mint : UI_COLORS.danger;
  ctx.font = '700 14px "PingFang SC","Segoe UI",sans-serif';
  ctx.fillText(lb.mode === 'coop' ? '合作闯关 · 友伤关闭' : '自由混战 · 最后存活者胜', left, 258);
  ctx.textAlign = 'right';
  ctx.fillStyle = UI_COLORS.text;
  ctx.font = '700 14px "Segoe UI",monospace';
  ctx.fillText(`${lb.members.length} / ${MAX_PLAYERS} 人`, right, 258);
  ctx.restore();
  drawDivider(ctx, left, 274, width);

  // 成员（最多 4 人，紧凑行高塞进半高面板）
  const rows = Math.max(MAX_PLAYERS, lb.members.length);
  for (let i = 0; i < rows; i++) {
    const ry = 294 + i * 28;
    const m = lb.members[i];
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.fillStyle = m ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.02)';
    roundRect(ctx, left, ry - 12, width, 24, 8);
    ctx.fill();

    if (!m) {
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(150,142,182,0.5)';
      ctx.font = '500 12px "PingFang SC","Segoe UI",sans-serif';
      ctx.fillText(`空位 ${i + 1} · 等待队友加入`, left + 26, ry);
      ctx.restore();
      continue;
    }

    ctx.fillStyle = m.color;
    ctx.beginPath();
    ctx.arc(left + 15, ry, 5, 0, TAU);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillStyle = UI_COLORS.text;
    ctx.font = '600 14px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText(m.name, left + 28, ry);

    // 右侧：角色名（+ 房主标签）
    const cname = getCharacter(m.charId).name;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(206,198,232,0.72)';
    ctx.font = '500 12px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText(cname, right - (m.isHost ? 52 : 0), ry);
    if (m.isHost) {
      ctx.fillStyle = 'rgba(255,212,121,0.16)';
      roundRect(ctx, right - 44, ry - 10, 44, 20, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,212,121,0.55)';
      ctx.lineWidth = 1.2;
      roundRect(ctx, right - 44, ry - 10, 44, 20, 6);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillStyle = UI_COLORS.gold;
      ctx.font = '700 11px "PingFang SC","Segoe UI",sans-serif';
      ctx.fillText('房主', right - 22, ry + 0.5);
    }
    ctx.restore();
  }
}

function drawLobby(
  ctx: CanvasRenderingContext2D,
  state: MenuState,
  buttons: readonly UiButton[],
  hoverId: string | null,
  time: number,
): void {
  const lb = state.lobby;
  drawHeading(ctx, '联机模式', 640, 56, 34);
  drawHeading(
    ctx,
    lb.mode === 'coop' ? '合作闯关 · 共享地牢，一起清理深渊' : '自由混战 · 各自为战，最后存活者胜',
    640,
    90,
    14,
    'center',
    UI_COLORS.textDim,
  );

  // 模式选择卡片（仅在 idle 阶段绘制，room 阶段由房间面板覆盖）
  if (lb.phase === 'idle') {
    for (const b of buttons) {
      if (b.id !== 'mm-mode-coop' && b.id !== 'mm-mode-pk') continue;
      const on = (b.id === 'mm-mode-coop') === (lb.mode === 'coop');
    ctx.save();
    ctx.fillStyle = on ? 'rgba(38,30,56,0.96)' : 'rgba(22,18,34,0.9)';
    roundRect(ctx, b.x, b.y, b.w, b.h, 16);
    ctx.fill();
    ctx.strokeStyle = on ? UI_COLORS.borderStrong : hoverId === b.id ? 'rgba(255,212,121,0.45)' : 'rgba(140,132,170,0.3)';
    ctx.lineWidth = on ? 2.6 : 1.6;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = UI_COLORS.text;
    ctx.font = '800 26px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText(b.label, b.x + b.w / 2, b.y + 50);
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = '500 13px "PingFang SC","Segoe UI",sans-serif';
    const desc = b.id === 'mm-mode-coop' ? '共享同一份地牢，敌人一起打，无友伤' : '互相可伤害，最后存活者胜，阵亡后可观战';
    wrapText(ctx, desc, b.x + 30, b.y + 82, b.w - 60, 18);
    ctx.restore();
    }
  }

  if (lb.joining) {
    drawPanel(ctx, 380, 230, 520, 220, { radius: 16 });
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = UI_COLORS.text;
    ctx.font = '700 18px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText('输入 4 位房间号', 640, 282);
    for (let i = 0; i < 4; i++) {
      const cx = 500 + i * 70;
      const ch = lb.codeInput[i] ?? '';
      ctx.fillStyle = 'rgba(10,8,18,0.85)';
      roundRect(ctx, cx - 26, 312, 52, 62, 8);
      ctx.fill();
      ctx.strokeStyle = i === lb.codeInput.length ? UI_COLORS.gold : 'rgba(140,132,170,0.4)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = UI_COLORS.text;
      ctx.font = '800 30px Consolas, monospace';
      ctx.fillText(ch || '—', cx, 344);
    }
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = '500 12px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText('直接用键盘输入字母 / 数字，回车确认', 640, 400);
    ctx.restore();
    for (const b of buttons) drawButton(ctx, b, hoverId === b.id, false, time);
    drawLobbyStatus(ctx, lb);
    return;
  }

  if (lb.phase === 'idle') {
    // 身份面板：名字（点击编辑）+ 角色（点击选择）
    drawPanel(ctx, 260, 96, 760, 156, { radius: 16 });
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = UI_COLORS.text;
    ctx.font = '700 16px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText('你的身份', 296, 130);

    // 名字
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = '600 13px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText('名字', 296, 150);
    {
      const b = NAME_BOX;
      const hovering = hoverId === 'mm-name';
      ctx.fillStyle = 'rgba(10,8,18,0.7)';
      roundRect(ctx, b.x, b.y, b.w, b.h, 12);
      ctx.fill();
      ctx.strokeStyle = hovering ? UI_COLORS.gold : 'rgba(140,132,170,0.4)';
      ctx.lineWidth = hovering ? 2.4 : 1.6;
      ctx.stroke();
      ctx.textBaseline = 'middle';
      ctx.font = '600 18px "PingFang SC","Segoe UI",sans-serif';
      ctx.fillStyle = lb.name ? UI_COLORS.text : 'rgba(206,198,232,0.4)';
      ctx.fillText(lb.name || '点击设置你的名字', b.x + 14, b.y + b.h / 2 + 1);
      if (!lb.name) {
        ctx.textAlign = 'right';
        ctx.fillStyle = UI_COLORS.textDim;
        ctx.font = '500 12px "PingFang SC","Segoe UI",sans-serif';
        ctx.fillText('点击直接打字 · 回车确认', b.x + b.w - 14, b.y + b.h / 2 + 1);
        ctx.textAlign = 'left';
      }
      ctx.textBaseline = 'alphabetic';
    }

    // 角色（全部可选，联机不要求解锁）
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = '600 13px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText('角色', 700, 150);
    for (let i = 0; i < CHARACTERS.length; i++) {
      const def = CHARACTERS[i]!;
      const c = CHAR_CARDS[i]!;
      const selected = state.selectedChar === i;
      const hovering = hoverId === `mm-char:${i}`;
      ctx.fillStyle = selected ? 'rgba(38,30,56,0.98)' : 'rgba(22,18,34,0.9)';
      roundRect(ctx, c.x, c.y, c.w, c.h, 10);
      ctx.fill();
      ctx.strokeStyle = selected ? UI_COLORS.gold : hovering ? 'rgba(255,212,121,0.5)' : 'rgba(140,132,170,0.3)';
      ctx.lineWidth = selected ? 2.4 : 1.4;
      ctx.stroke();
      ctx.fillStyle = def.palette.primary;
      roundRect(ctx, c.x + 8, c.y + 12, c.w - 16, 8, 4);
      ctx.fill();
      ctx.textAlign = 'center';
      // 角色数变多 → 卡片变窄，字号跟着缩，避免名字/技能名溢出到邻卡。
      const nameSize = c.w >= 92 ? 15 : c.w >= 80 ? 13 : 11;
      const subSize = c.w >= 92 ? 11 : c.w >= 80 ? 10 : 9;
      ctx.fillStyle = UI_COLORS.text;
      ctx.font = `700 ${nameSize}px "PingFang SC","Segoe UI",sans-serif`;
      ctx.fillText(def.name, c.x + c.w / 2, c.y + 48);
      ctx.fillStyle = UI_COLORS.textDim;
      ctx.font = `500 ${subSize}px "PingFang SC","Segoe UI",sans-serif`;
      ctx.fillText(def.skill.name, c.x + c.w / 2, c.y + 70);
      ctx.fillText(`HP ${def.maxHp}`, c.x + c.w / 2, c.y + 90);
      ctx.textAlign = 'left';
    }
    ctx.restore();

    for (const b of buttons) {
      if (b.id === 'mm-name' || b.id.startsWith('mm-char:')) continue;
      if (b.id === 'mm-mode-coop' || b.id === 'mm-mode-pk') continue; // 上面已自定义绘制
      drawButton(ctx, b, hoverId === b.id, false, time);
    }
    drawLobbyStatus(ctx, lb);
    return;
  }

  // 房间内：大号房间号 + 成员列表
  drawPanel(ctx, 300, 126, 680, 336, { radius: 16 });
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = UI_COLORS.textDim;
  ctx.font = '600 14px "PingFang SC","Segoe UI",sans-serif';
  ctx.fillText('房间号', 640, 168);
  ctx.fillStyle = UI_COLORS.gold;
  ctx.font = '900 56px Consolas, monospace';
  ctx.shadowColor = 'rgba(255,170,60,0.5)';
  ctx.shadowBlur = 22;
  ctx.fillText(lb.code || '----', 640, 216);
  ctx.shadowBlur = 0;
  ctx.fillStyle = UI_COLORS.textDim;
  ctx.font = '500 13px "PingFang SC","Segoe UI",sans-serif';
  ctx.fillText('把房间号告诉队友即可加入（最多 4 人）', 640, 258);
  ctx.restore();

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < lb.members.length; i++) {
    const m = lb.members[i]!;
    const ry = 296 + i * 34;
    ctx.fillStyle = m.color;
    ctx.beginPath();
    ctx.arc(360, ry, 7, 0, TAU);
    ctx.fill();
    ctx.fillStyle = UI_COLORS.text;
    ctx.font = '600 15px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText(m.name, 380, ry);
    let nx = 380 + ctx.measureText(m.name).width + 22;
    if (m.isHost) {
      ctx.fillStyle = UI_COLORS.gold;
      ctx.font = '700 12px "PingFang SC","Segoe UI",sans-serif';
      ctx.fillText('房主', nx, ry);
      nx += ctx.measureText('房主').width + 16;
    }
    const cdef = getCharacter(m.charId);
    if (cdef) {
      ctx.fillStyle = UI_COLORS.textDim;
      ctx.font = '500 13px "PingFang SC","Segoe UI",sans-serif';
      ctx.fillText(cdef.name, nx, ry);
    }
  }
  ctx.restore();

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(206,198,232,0.5)';
  ctx.font = '500 12px "PingFang SC","Segoe UI",sans-serif';
  ctx.fillText('按 Esc 回主菜单时房间会保留，可从主菜单「返回房间」随时回来', 640, 436);
  ctx.restore();

  for (const b of buttons) drawButton(ctx, b, hoverId === b.id, false, time);
  drawLobbyStatus(ctx, lb);
}

function drawLobbyStatus(ctx: CanvasRenderingContext2D, lb: LobbyInfo): void {
  if (!lb.status) return;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = lb.status.startsWith('错误') ? '#ff9a8a' : 'rgba(206,198,232,0.8)';
  ctx.font = '600 13px "PingFang SC","Segoe UI",sans-serif';
  ctx.fillText(lb.status, 640, 634);
  ctx.restore();
}

function drawCharSelect(
  ctx: CanvasRenderingContext2D,
  state: MenuState,
  buttons: readonly UiButton[],
  hoverId: string | null,
  time: number,
  data: MenuData,
): void {
  drawHeading(ctx, '选择角色', 640, 52, 34);
  drawHeading(
    ctx,
    `${CHARACTERS.length} 名角色在生命、速度与主动技能上差异明显`,
    640,
    86,
    14,
    'center',
    UI_COLORS.textDim,
  );

  /**
   * 卡片内文字统一按卡宽等比缩放。
   * 角色变多时卡宽会被压缩（5 人 230px / 6 人 194 / 7 人 164 / 8 人 142，原来 3 人是 320px），
   * 字号不跟着缩的话能力条标签会顶到进度条上、技能描述也会溢出行宽。
   * 以 250px 为基准宽（→ k=1）—— 注意 5 人时 cardW=230 所以 k≈0.92，
   * 只有 4 人及以下才真正是 k=1。
   */
  const k = Math.min(1, (buttons.find((b) => b.id === 'char:0')?.w ?? 250) / 250);
  const pad = Math.round(22 * k);

  for (let i = 0; i < CHARACTERS.length; i++) {
    const def = CHARACTERS[i]!;
    const btn = buttons.find((b) => b.id === `char:${i}`);
    if (!btn) continue;
    const unlocked = isCharacterUnlocked(def, data.progress);
    const selected = state.selectedChar === i;
    const hovered = hoverId === btn.id;

    ctx.save();
    ctx.globalAlpha = unlocked ? 1 : 0.72;
    ctx.fillStyle = selected ? 'rgba(38,30,56,0.96)' : 'rgba(22,18,34,0.9)';
    roundRect(ctx, btn.x, btn.y, btn.w, btn.h, 16);
    ctx.fill();
    ctx.strokeStyle = selected ? UI_COLORS.borderStrong : hovered ? 'rgba(255,212,121,0.45)' : 'rgba(140,132,170,0.3)';
    ctx.lineWidth = selected ? 2.6 : 1.6;
    ctx.stroke();
    if (selected) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.1 + Math.sin(time * 3) * 0.03;
      ctx.fillStyle = '#ffd479';
      roundRect(ctx, btn.x, btn.y, btn.w, btn.h, 16);
      ctx.fill();
      ctx.restore();
    }

    // 头像（卡窄了也要一起缩，否则立绘会左右顶出卡片）
    drawCharacterPortrait(ctx, def, btn.x + btn.w / 2, btn.y + 108, 1.5 * k, time, !unlocked);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = unlocked ? UI_COLORS.text : 'rgba(160,152,190,0.8)';
    ctx.font = `800 ${Math.round(26 * k)}px "PingFang SC","Segoe UI",sans-serif`;
    ctx.fillText(def.name, btn.x + btn.w / 2, btn.y + 196);
    ctx.fillStyle = unlocked ? UI_COLORS.gold : 'rgba(150,142,182,0.8)';
    ctx.font = `600 ${Math.round(14 * k)}px "PingFang SC","Segoe UI",sans-serif`;
    ctx.fillText(def.title, btn.x + btn.w / 2, btn.y + 222);

    // 能力条
    let by = btn.y + 248;
    const barX = btn.x + pad + Math.round(40 * k);
    for (const bar of def.bars) {
      ctx.textAlign = 'left';
      ctx.fillStyle = UI_COLORS.textDim;
      ctx.font = `600 ${Math.round(12 * k)}px "PingFang SC","Segoe UI",sans-serif`;
      ctx.fillText(bar.label, btn.x + pad, by);
      ctx.fillStyle = 'rgba(10,8,18,0.8)';
      roundRect(ctx, barX, by - 5, btn.x + btn.w - pad - barX, 10, 5);
      ctx.fill();
      const col = unlocked ? def.palette.accent : '#6a6478';
      ctx.fillStyle = col;
      roundRect(ctx, barX, by - 5, (btn.x + btn.w - pad - barX) * clamp(bar.value, 0, 1), 10, 5);
      ctx.fill();
      by += Math.round(24 * k) + 6;
    }

    // 技能
    ctx.textAlign = 'left';
    ctx.fillStyle = unlocked ? '#7ef2c0' : 'rgba(126,242,192,0.5)';
    ctx.font = `700 ${Math.round(14 * k)}px "PingFang SC","Segoe UI",sans-serif`;
    ctx.fillText(`技能：${def.skill.name}`, btn.x + pad, btn.y + 342);
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = `500 ${Math.round(12 * k)}px "PingFang SC","Segoe UI",sans-serif`;
    wrapText(ctx, def.skill.desc, btn.x + pad, btn.y + 362, btn.w - pad * 2, Math.round(18 * k) + 4);

    // 初始武器
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = `600 ${Math.round(12 * k)}px "PingFang SC","Segoe UI",sans-serif`;
    ctx.fillText('初始武器', btn.x + pad, btn.y + 404);
    const wdef = getWeaponDef(def.startWeapon);
    const iconSize = Math.round(40 * k);
    drawWeaponIcon(ctx, wdef, btn.x + pad + Math.round(74 * k), btn.y + 404, iconSize);
    ctx.fillStyle = UI_COLORS.text;
    ctx.font = `600 ${Math.round(13 * k)}px "PingFang SC","Segoe UI",sans-serif`;
    ctx.fillText(wdef.name, btn.x + pad + Math.round(104 * k), btn.y + 404);

    if (!unlocked) {
      ctx.save();
      ctx.fillStyle = 'rgba(10,8,18,0.82)';
      roundRect(ctx, btn.x + pad, btn.y + 176, btn.w - pad * 2, 60, 10);
      ctx.fill();
      ctx.strokeStyle = 'rgba(180,120,120,0.5)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.fillStyle = '#ff9a8a';
      ctx.font = `700 ${Math.round(13 * k)}px "PingFang SC","Segoe UI",sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(unlockHint(def), btn.x + btn.w / 2, btn.y + 206);
      ctx.restore();
    }
    ctx.restore();
  }

  const confirm = buttons.find((b) => b.id === 'confirm-char');
  if (confirm) {
    const def = CHARACTERS[state.selectedChar]!;
    const unlocked = isCharacterUnlocked(def, data.progress);
    const disabled: UiButton = unlocked ? confirm : { ...confirm, enabled: false, label: '角色尚未解锁' };
    drawButton(ctx, disabled, hoverId === confirm.id && unlocked, false, time);
  }
  const back = buttons.find((b) => b.id === 'menu-back');
  if (back) drawButton(ctx, back, hoverId === back.id, false, time);
}

function drawSettingsPanel(
  ctx: CanvasRenderingContext2D,
  buttons: readonly UiButton[],
  hoverId: string | null,
  time: number,
  settings: GameSettings,
): void {
  drawPanel(ctx, 284, 96, 712, 536, { radius: 18 });
  drawHeading(ctx, '设置', 640, 132, 30);
  drawDivider(ctx, 330, 158, 620);
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
    ctx.textAlign = 'left';
    ctx.fillStyle = UI_COLORS.text;
    ctx.font = '600 15px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText(label, x, y + 18);
    ctx.fillStyle = 'rgba(10,8,18,0.8)';
    roundRect(ctx, x, y + 30, w - 230, 12, 6);
    ctx.fill();
    ctx.fillStyle = UI_COLORS.gold;
    roundRect(ctx, x, y + 30, (w - 230) * clamp(value, 0, 1), 12, 6);
    ctx.fill();
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = '600 13px Consolas, monospace';
    ctx.fillText(`${Math.round(value * 100)}%`, x + w - 212, y + 18);
    y += 52;
  }
  const toggles: Array<[string, boolean, string]> = [
    ['showDamageNumbers', settings.showDamageNumbers, '显示伤害数字'],
    ['showMinimap', settings.showMinimap, '显示小地图'],
    ['showSystemCursor', settings.showSystemCursor, '始终显示系统鼠标光标'],
  ];
  y = 390;
  for (const [key, val, label] of toggles) {
    ctx.textAlign = 'left';
    ctx.fillStyle = UI_COLORS.text;
    ctx.font = '600 15px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText(label, x, y + 20);
    const btn = buttons.find((b) => b.id === `toggle:${key}`);
    if (btn) {
      ctx.fillStyle = val ? 'rgba(126,242,192,0.85)' : 'rgba(70,62,96,0.9)';
      roundRect(ctx, btn.x, btn.y, btn.w, btn.h, 20);
      ctx.fill();
      ctx.strokeStyle = val ? '#7ef2c0' : 'rgba(150,142,182,0.5)';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      const knobX = val ? btn.x + btn.w - 20 : btn.x + 20;
      ctx.beginPath();
      ctx.arc(knobX, btn.y + btn.h / 2, 13, 0, TAU);
      ctx.fillStyle = val ? '#0e2b22' : '#c9c1e0';
      ctx.fill();
    }
    y += 48;
  }
  ctx.restore();
  for (const b of buttons) {
    if (b.id.startsWith('toggle:')) continue;
    drawButton(ctx, b, hoverId === b.id, false, time);
  }
}

/** 图鉴当前分页的条目表（武器 / 敌人 / 角色共用）。 */
function codexList(tab: CodexTab): ReadonlyArray<{ id: string; name: string; desc: string }> {
  if (tab === 'weapon') return WEAPONS;
  if (tab === 'enemy') return ENEMIES;
  return CHARACTERS;
}

/** 角色技能的一行摘要（不同技能类型给不同的关键数值）。 */
function skillSummary(def: CharacterDef): string {
  const s = def.skill;
  const base = `持续 ${s.duration} 秒 · 冷却 ${s.cooldown} 秒`;
  if (s.kind === 'dash') return `${base} · 冲刺期间无敌`;
  if (s.kind === 'overdrive') return `${base} · 移速 ×${s.speedMul}`;
  return `${base} · 护盾 ${s.shieldAmount} 点`;
}

function drawCodex(
  ctx: CanvasRenderingContext2D,
  state: MenuState,
  buttons: readonly UiButton[],
  hoverId: string | null,
  time: number,
  data: MenuData,
): void {
  ctx.save();
  ctx.fillStyle = 'rgba(9,7,15,0.72)';
  ctx.fillRect(0, 0, 1280, 720);
  ctx.restore();
  drawHeading(ctx, '图鉴', 640, 52, 30);

  for (const b of buttons) {
    if (b.id.startsWith('codex:')) continue;
    drawButton(ctx, b, hoverId === b.id, false, time);
  }

  const tab = state.codexTab;
  const isWeapon = tab === 'weapon';
  const isEnemy = tab === 'enemy';
  const list = codexList(tab);

  // 左侧列表
  for (let i = 0; i < list.length; i++) {
    const btn = buttons.find((b) => b.id === `codex:${i}`);
    if (!btn) continue;
    const item = list[i]!;
    const known = isWeapon ? data.discoveredWeapons.includes(item.id) : true;
    const unlocked = !isWeapon && !isEnemy ? isCharacterUnlocked(item as CharacterDef, data.progress) : true;
    const selected = state.codexIndex === i;
    ctx.save();
    // 未解锁的条目只是稍微压暗；真正的"当前选中"用金色描边 + 左侧色条区分，
    // 否则「已解锁」那一条看起来就像被选中，和右侧详情对不上。
    ctx.globalAlpha = known ? (unlocked ? 1 : 0.74) : 0.68;
    ctx.fillStyle = selected ? 'rgba(60,48,86,0.98)' : 'rgba(22,18,34,0.86)';
    roundRect(ctx, btn.x, btn.y, btn.w, btn.h, 9);
    ctx.fill();
    ctx.strokeStyle = selected
      ? UI_COLORS.gold
      : known
        ? 'rgba(255,212,121,0.34)'
        : 'rgba(140,132,170,0.24)';
    ctx.lineWidth = selected ? 2.4 : 1.3;
    ctx.stroke();
    if (selected) {
      ctx.fillStyle = UI_COLORS.gold;
      roundRect(ctx, btn.x + 3, btn.y + 8, 4, btn.h - 16, 2);
      ctx.fill();
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = known ? UI_COLORS.text : 'rgba(150,142,182,0.7)';
    ctx.font = '700 15px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText(known ? item.name : '？？？', btn.x + 16, btn.y + 18);
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = '500 12px "PingFang SC","Segoe UI",sans-serif';
    const subtitle = isWeapon
      ? `层级 ${(item as WeaponDef).tier} · ${kindLabel((item as WeaponDef).kind)}`
      : isEnemy
        ? `${(item as EnemyDef).elite ? '精英敌人' : '普通敌人'} · 生命 ${(item as EnemyDef).hp}`
        : `${(item as CharacterDef).title} · ${unlocked ? '已解锁' : '未解锁'}`;
    ctx.fillText(known ? subtitle : '尚未发现', btn.x + 16, btn.y + 36);
    ctx.restore();
  }

  // 右侧详情
  const item = list[state.codexIndex] ?? list[0]!;
  const known = isWeapon ? data.discoveredWeapons.includes(item.id) : true;
  drawPanel(ctx, 456, 160, 732, 464, { radius: 16 });
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = UI_COLORS.text;
  ctx.font = '800 26px "PingFang SC","Segoe UI",sans-serif';
  ctx.fillText(known ? item.name : '？？？', 492, 202);
  drawDivider(ctx, 492, 228, 660);
  ctx.fillStyle = UI_COLORS.textDim;
  ctx.font = '500 15px "PingFang SC","Segoe UI",sans-serif';
  wrapText(ctx, known ? item.desc : '继续深入探索地牢以解锁该条目。', 492, 252, 660, 24);
  ctx.restore();

  if (!known) {
    // 未解锁：只给提示，不泄露数值（否则和「解锁该条目」的文案自相矛盾）
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = '600 14px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText('在地牢里拾取或购买该武器后即可解锁详细数据。', 640, 372);
    ctx.restore();
  } else if (isWeapon) {
    const def = item as WeaponDef;
    drawWeaponIcon(ctx, def, 500, 380, 76);
    const stats: Array<[string, string]> = [
      ['单发伤害', `${def.damage * def.pellets}`],
      ['射速', `${def.fireRate.toFixed(2)} 次/秒`],
      ['弹匣', `${def.mag}`],
      ['换弹', `${def.reloadTime.toFixed(2)} 秒`],
      ['弹速', `${def.bulletSpeed}`],
      ['射程', `${def.range}`],
      ['散布', `${(def.spread * 57.3).toFixed(1)}°`],
      ['贯穿 / 弹射', `${def.pierce} / ${def.bounce}`],
    ];
    ctx.save();
    ctx.textBaseline = 'middle';
    let sx = 560;
    let sy = 340;
    for (let i = 0; i < stats.length; i++) {
      const [k, v] = stats[i]!;
      const col = i % 2;
      const row = Math.floor(i / 2);
      ctx.textAlign = 'left';
      ctx.fillStyle = UI_COLORS.textDim;
      ctx.font = '600 13px "PingFang SC","Segoe UI",sans-serif';
      ctx.fillText(k, sx + col * 320 + 60, sy + row * 56);
      ctx.fillStyle = UI_COLORS.text;
      ctx.font = '700 16px "Segoe UI",monospace';
      ctx.fillText(v, sx + col * 320 + 60, sy + row * 56 + 22);
    }
    ctx.restore();
  } else if (isEnemy) {
    const def = item as EnemyDef;
    drawEliteBadge(ctx, 560, 330, def.elite ? 44 : 30);
    ctx.save();
    ctx.textBaseline = 'middle';
    const stats: Array<[string, string]> = [
      ['生命', `${def.hp}`],
      ['移动速度', `${def.speed}`],
      ['接触伤害', `${def.contactDamage}/秒`],
      ['攻击间隔', `${def.attackCooldown} 秒`],
      ['前摇', `${def.windup} 秒`],
      ['警戒半径', `${def.detectRange}`],
    ];
    let sx = 620;
    let sy = 300;
    for (let i = 0; i < stats.length; i++) {
      const [k, v] = stats[i]!;
      const col = i % 2;
      const row = Math.floor(i / 2);
      ctx.textAlign = 'left';
      ctx.fillStyle = UI_COLORS.textDim;
      ctx.font = '600 13px "PingFang SC","Segoe UI",sans-serif';
      ctx.fillText(k, sx + col * 300, sy + row * 56);
      ctx.fillStyle = UI_COLORS.text;
      ctx.font = '700 16px "Segoe UI",monospace';
      ctx.fillText(v, sx + col * 300, sy + row * 56 + 22);
    }
    ctx.restore();
  } else {
    // 角色图鉴：立绘 + 面板数值 + 技能 + 解锁状态
    const def = item as CharacterDef;
    const unlocked = isCharacterUnlocked(def, data.progress);
    drawCharacterPortrait(ctx, def, 560, 372, 1.8, time, !unlocked);

    ctx.save();
    ctx.textBaseline = 'middle';
    const stats: Array<[string, string]> = [
      ['生命上限', `${def.maxHp}`],
      ['护盾上限', `${def.maxShield}`],
      ['移动速度', `${def.speed}`],
      ['基础闪避', `${Math.round(def.baseDodge * 100)}%`],
      ['初始武器', getWeaponDef(def.startWeapon).name],
      ['技能冷却', `${def.skill.cooldown} 秒`],
    ];
    let sx = 660;
    let sy = 296;
    for (let i = 0; i < stats.length; i++) {
      const [k, v] = stats[i]!;
      const col = i % 2;
      const row = Math.floor(i / 2);
      ctx.textAlign = 'left';
      ctx.fillStyle = UI_COLORS.textDim;
      ctx.font = '600 13px "PingFang SC","Segoe UI",sans-serif';
      ctx.fillText(k, sx + col * 320, sy + row * 56);
      ctx.fillStyle = UI_COLORS.text;
      ctx.font = '700 16px "Segoe UI",monospace';
      ctx.fillText(v, sx + col * 320, sy + row * 56 + 22);
    }

    // 主动技能
    ctx.fillStyle = '#7ef2c0';
    ctx.font = '700 15px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText(`技能 · ${def.skill.name}`, 492, 470);
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = '500 14px "PingFang SC","Segoe UI",sans-serif';
    wrapText(ctx, def.skill.desc, 492, 496, 660, 20);
    ctx.fillStyle = 'rgba(206,198,232,0.7)';
    ctx.font = '600 13px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillText(skillSummary(def), 492, 546);

    // 解锁状态（未解锁时给出解锁条件，和角色选择页一致）
    ctx.font = '700 14px "PingFang SC","Segoe UI",sans-serif';
    ctx.fillStyle = unlocked ? UI_COLORS.gold : '#ff9a8a';
    ctx.fillText(unlocked ? '已解锁' : unlockHint(def), 492, 584);
    ctx.restore();
  }

  // 装饰
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.1;
  ctx.fillStyle = '#ffd479';
  ctx.fillRect(456, 160, 732, 3);
  ctx.restore();
  void drawSpinner;
  void drawUpgradeIcon;
  void getEnemyDef;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'bullet':
      return '实弹';
    case 'beam':
      return '能量束';
    case 'flame':
      return '火焰';
    case 'grenade':
      return '爆炸';
    default:
      return kind;
  }
}

export { drawDim, roundRect as menuRoundRect };

function roundRect(
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
