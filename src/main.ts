/**
 * 应用入口：装配渲染器 / 输入 / 音效 / 存档 / 事件总线，
 * 并驱动「大厅 ↔ 地牢」两个场景的状态机与主循环。
 *
 * 主循环职责：
 *   计算 dt → 分发到当前场景 → 渲染 → 清理单帧输入状态 → 统计 FPS
 */
import { EventBus } from './core/eventbus';
import { Input } from './core/input';
import { clamp } from './core/math';
import { DEFAULT_NET_URL, FLOOR_COUNT, PLAYER_COLORS, VIEW_H, VIEW_W } from './data/config';
import { CHARACTERS, isCharacterUnlocked } from './data/characters';
import { WorldRenderer } from './render/renderer';
import { AudioSystem } from './systems/audio';
import { SaveManager } from './systems/save';
import type { RunResult, SavedRun } from './systems/run';
import { GameplayScene, type GameHost } from './scenes/gameplay';
import { NetClient } from './net/NetClient';
import type { NetMode, PeerInfo } from './net/protocol';
import {
  buildMenuButtons,
  createLobbyInfo,
  createMenuState,
  drawMenu,
  type MenuData,
  type MenuState,
} from './ui/screens';
import { UI_COLORS, hitTest, type UiButton } from './ui/widgets';

type Scene = 'menu' | 'game';

/** 房间号可用字符（与大写字母 / 数字一致，去掉易混字符）。 */
const KEY_CHARS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') out[`Key${c}`] = c;
  for (let d = 0; d < 10; d++) out[`Digit${d}`] = String(d);
  out['Numpad0'] = '0';
  return out;
})();

/** dt 上限，避免切后台回来时物理直接穿透。 */
const MAX_DT = 1 / 20;

class App implements GameHost {
  readonly renderer: WorldRenderer;
  readonly input: Input;
  readonly audio = new AudioSystem();
  readonly save = new SaveManager();
  readonly bus = new EventBus();

  private readonly canvas: HTMLCanvasElement;
  private scene: Scene = 'menu';
  private menuState: MenuState = createMenuState();
  private menuButtons: UiButton[] = [];
  private hoverId: string | null = null;
  private game: GameplayScene | null = null;

  // 联机大厅状态（大厅期间由本类持有 NetClient；开局后转交给 GameplayScene）
  private lobbyNet: NetClient | null = null;
  private netLocalPeerId = '';
  private netRoomCode = '';
  private playerName: string;
  /** 联机名字编辑时临时挂载的 DOM 输入框（关闭即清空）。 */
  private nameInputEl: HTMLInputElement | null = null;

  private lastTime = 0;
  private time = 0;
  private fps = 60;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private running = false;
  private audioUnlocked = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.playerName = `玩家${10 + Math.floor(Math.random() * 90)}`;
    this.renderer = new WorldRenderer(canvas);
    this.input = new Input(canvas);
    this.applyAudioSettings();
    this.unlockAudioOnFirstGesture();
    this.syncCursor();

    // 菜单初始按钮
    this.menuButtons = buildMenuButtons(this.menuState, this.save.savedRun);

    // 玩家在浏览器里经常先点一下才能出声：任何输入都尝试初始化音频上下文
    window.addEventListener('pointerdown', () => this.audio.init(), { once: false });
    window.addEventListener('keydown', () => this.audio.init(), { once: false });
  }

  // ------------------------------------------------------------- 生命周期

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    const dtRaw = (now - this.lastTime) / 1000;
    this.lastTime = now;
    const dt = clamp(Number.isFinite(dtRaw) ? dtRaw : 0, 0, MAX_DT);
    this.time += dt;

    try {
      if (this.scene === 'menu') this.updateMenu(dt);
      else this.game?.update(dt);

      if (this.scene === 'menu') this.renderMenu();
      else this.game?.render();

      this.syncCursor();
      this.input.endFrame();
    } catch (err) {
      this.fatal(err);
      return;
    }

    this.trackFps(dtRaw);
    requestAnimationFrame(this.frame);
  };

  private trackFps(dtRaw: number): void {
    this.fpsAccum += Number.isFinite(dtRaw) ? dtRaw : 0;
    this.fpsFrames += 1;
    if (this.fpsAccum >= 0.5) {
      const measured = this.fpsFrames / this.fpsAccum;
      this.fps = this.fps + (measured - this.fps) * 0.6;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
    this.game?.setFps(Math.round(this.fps));
  }

  /**
   * 光标策略：
   *   地牢内操控角色 → 隐藏系统光标，用自绘准星代替（准星画在 HUD 之上，不会被过渡黑场盖住）
   *   大厅 / 暂停 / 商店 / 设置 → 显示系统光标，方便点按钮
   * 之前这里一律 cursor:none，但只有地牢里画准星，于是菜单和图鉴页完全看不到指针。
   */
  private syncCursor(): void {
    const hide = this.scene === 'game' && this.game?.hidesSystemCursor === true;
    const next = hide ? 'none' : 'default';
    if (this.canvas.style.cursor !== next) this.canvas.style.cursor = next;
  }

  private fatal(err: unknown): void {
    this.running = false;
    const el = document.getElementById('fatal');
    const msg = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
    if (el) {
      el.textContent = `游戏发生错误：\n${msg}`;
      el.style.display = 'block';
    }
    console.error(err);
  }

  private unlockAudioOnFirstGesture(): void {
    const unlock = () => {
      if (this.audioUnlocked) return;
      this.audioUnlocked = true;
      this.audio.init();
      this.applyAudioSettings();
    };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
  }

  private applyAudioSettings(): void {
    const s = this.save.data.settings;
    this.audio.setSettings({ master: s.masterVolume, sfx: s.sfxVolume, music: s.musicVolume });
  }

  // ------------------------------------------------------------- 大厅

  private menuData(): MenuData {
    return {
      progress: this.save.data.progress,
      settings: this.save.data.settings,
      discoveredWeapons: this.save.data.discoveredWeapons,
      unlockedCharacters: this.save.data.unlockedCharacters,
    };
  }

  private updateMenu(_dt: number): void {
    const lb = this.menuState.lobby;
    if (this.menuState.mode === 'multi' && lb.joining) this.handleLobbyKeyInput();
    this.menuButtons = buildMenuButtons(this.menuState, this.save.savedRun);
    const p = this.input.pointer;
    const hovered = hitTest(this.menuButtons, p.sx, p.sy);
    this.hoverId = hovered ? hovered.id : null;

    // 键盘快速开战
    if (this.input.wasPressed('Enter') && this.menuState.mode === 'main') {
      this.menuState.mode = 'charselect';
      return;
    }
    if (this.input.wasPressed('Escape') && this.menuState.mode !== 'main') {
      // 加入房间输入中：Esc 先退出输入
      if (this.menuState.mode === 'multi' && lb.joining) {
        lb.joining = false;
        lb.codeInput = '';
        return;
      }
      this.menuState.mode = this.menuState.previous === this.menuState.mode ? 'main' : this.menuState.previous;
      return;
    }

    if (!p.justDown || !hovered) return;
    this.audio.init();
    this.audio.play('click', 0.6);
    this.handleMenuAction(hovered.id);
  }

  private handleMenuAction(id: string): void {
    const st = this.menuState;

    if (id.startsWith('char:')) {
      st.selectedChar = Number(id.split(':')[1]);
      return;
    }
    if (id.startsWith('codex:')) {
      st.codexIndex = Number(id.split(':')[1]);
      return;
    }
    if (id.startsWith('set:')) {
      this.adjustSetting(id);
      return;
    }
    if (id.startsWith('mm-char:')) {
      st.selectedChar = Number(id.split(':')[1]);
      this.audio.play('click', 0.5);
      return;
    }
    if (id.startsWith('toggle:')) {
      const key = id.split(':')[1] as 'showDamageNumbers' | 'showMinimap' | 'showSystemCursor';
      const settings = { ...this.save.data.settings };
      settings[key] = !settings[key];
      this.save.updateSettings(settings);
      this.syncCursor();
      return;
    }

    switch (id) {
      case 'multi':
        this.openMultiLobby();
        break;
      case 'mm-mode-coop':
        st.lobby.mode = 'coop';
        break;
      case 'mm-mode-pk':
        st.lobby.mode = 'pk';
        break;
      case 'mm-create':
        this.createRoom();
        break;
      case 'mm-join':
        st.lobby.joining = true;
        st.lobby.codeInput = '';
        st.lobby.status = '';
        break;
      case 'mm-join-cancel':
        st.lobby.joining = false;
        st.lobby.codeInput = '';
        break;
      case 'mm-join-confirm':
        this.joinRoom();
        break;
      case 'mm-start':
        this.lobbyNet?.send({ t: 'start' });
        break;
      case 'mm-back':
      case 'mm-leave':
        this.closeLobby();
        st.mode = 'main';
        break;
      case 'mm-name':
        this.openNameEditor();
        break;
      case 'start':
        st.previous = 'main';
        st.mode = 'charselect';
        break;
      case 'resume-run':
        this.resumeRun();
        break;
      case 'codex':
        st.previous = 'main';
        st.mode = 'codex';
        st.codexIndex = 0;
        break;
      case 'settings':
        st.previous = 'main';
        st.mode = 'settings';
        break;
      case 'menu-back':
        st.confirmReset = false;
        st.mode = st.previous === 'main' || st.previous === st.mode ? 'main' : st.previous;
        break;
      case 'confirm-char': {
        const def = CHARACTERS[st.selectedChar] ?? CHARACTERS[0]!;
        if (!isCharacterUnlocked(def, this.save.data.progress)) {
          this.audio.play('error', 0.8);
          return;
        }
        this.save.unlockCharacter(def.id);
        this.startRun(def.id);
        break;
      }
      case 'codex-tab-weapon':
        st.codexTab = 'weapon';
        st.codexIndex = 0;
        break;
      case 'codex-tab-enemy':
        st.codexTab = 'enemy';
        st.codexIndex = 0;
        break;
      case 'codex-tab-character':
        st.codexTab = 'character';
        st.codexIndex = 0;
        break;
      case 'reset':
        if (!st.confirmReset) {
          st.confirmReset = true;
          this.audio.play('error', 0.6);
        } else {
          st.confirmReset = false;
          this.save.reset();
          this.applyAudioSettings();
          this.audio.play('doorLock', 0.8);
        }
        break;
      default:
        break;
    }
  }

  private adjustSetting(id: string): void {
    const parts = id.split(':');
    const key = parts[1] as keyof typeof this.save.data.settings;
    const dir = parts[2];
    const settings = { ...this.save.data.settings } as unknown as Record<string, unknown>;
    const current = settings[key];
    if (typeof current !== 'number') return;
    const next = clamp(current + (dir === 'inc' ? 0.1 : -0.1), 0, 1);
    settings[key] = Math.round(next * 100) / 100;
    this.save.updateSettings(settings as never);
    this.applyAudioSettings();
  }

  private renderMenu(): void {
    const ctx = this.renderer.ctx;
    this.renderer.beginFrame();
    drawMenu(ctx, this.menuState, this.menuButtons, this.hoverId, this.time, this.menuData());

    // 底部版本水印
    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.font = '600 12px "Segoe UI","PingFang SC",sans-serif';
    ctx.fillStyle = 'rgba(206,198,232,0.45)';
    ctx.fillText('元气勇士 v1.0 · 原创俯视角地牢射击', VIEW_W - 24, VIEW_H - 18);
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.restore();
  }

  // ------------------------------------------------------------- 地牢

  private startRun(characterId: string): void {
    // 开新局就意味着上一局的存档点作废（新局进第一个房间时会立刻写入自己的存档）
    this.save.clearRun();
    this.beginRun(characterId, null);
  }

  /** 继续未完成的远征：角色与种子都取自存档，按存档把玩家放回原房间。 */
  private resumeRun(): void {
    const saved = this.save.savedRun;
    if (!saved) return;
    this.beginRun(saved.characterId, saved);
  }

  private beginRun(characterId: string, resume: SavedRun | null): void {
    // 单机远征与联机房间互斥：先退房，避免房主开局时把本地玩家拽进联机局
    if (this.menuState.lobby.phase === 'room') this.closeLobby();
    const seed = resume ? resume.seed : (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    this.audio.init();
    this.audio.setMusicIntensity(0);
    this.game?.dispose();
    this.game = new GameplayScene(this, characterId, seed, undefined, resume);
    this.scene = 'game';
    this.audio.startMusic();
    this.audio.play('door', 0.9);
  }

  /** 一局结束（死亡 / 通关）后回大厅。 */
  endRun(result: RunResult): void {
    this.save.clearRun();
    this.save.recordRun({
      floor: result.floor,
      won: result.won,
      timeSec: result.timeSec,
      kills: result.kills,
      rooms: result.rooms,
      score: result.score,
    });
    this.refreshUnlocks();
    this.returnToMenu();
  }

  /** 主动放弃远征：同样计入统计，但不算通关。 */
  abandonRun(): void {
    this.save.clearRun();
    if (this.game) {
      const r = this.game.state.result(false);
      this.save.recordRun({
        floor: r.floor,
        won: false,
        timeSec: r.timeSec,
        kills: r.kills,
        rooms: r.rooms,
        score: r.score,
      });
      this.refreshUnlocks();
    }
    this.returnToMenu();
  }

  private refreshUnlocks(): void {
    const progress = this.save.data.progress;
    for (const c of CHARACTERS) {
      if (isCharacterUnlocked(c, progress)) this.save.unlockCharacter(c.id);
    }
  }

  private returnToMenu(): void {
    this.audio.stopMusic();
    this.audio.setMusicIntensity(0);
    this.game?.dispose();
    this.game = null;
    // 联机对局结束：关闭连接，避免残留房间
    this.lobbyNet?.close();
    this.lobbyNet = null;
    this.netRoomCode = '';
    this.scene = 'menu';
    this.menuState = createMenuState();
    this.menuButtons = buildMenuButtons(this.menuState, this.save.savedRun);
    this.hoverId = null;
  }

  /** GameplayScene 在联机断线 / 结束时回调（实现 GameHost.leaveNet）。 */
  leaveNet(): void {
    this.returnToMenu();
  }

  // ------------------------------------------------------------- 联机大厅

  private openMultiLobby(): void {
    // 已在房间内（从主菜单「返回房间」进来）：只切界面，绝不能重连 —— 否则会掉出房间
    if (this.menuState.lobby.phase === 'room' && this.lobbyNet) {
      this.menuState.mode = 'multi';
      return;
    }
    this.menuState.mode = 'multi';
    this.menuState.lobby = createLobbyInfo();
    this.menuState.lobby.name = this.playerName;
    this.menuState.lobby.status = `正在连接 ${DEFAULT_NET_URL} …`;
    this.closeNameEditor();
    this.lobbyNet?.close();
    const net = new NetClient(DEFAULT_NET_URL);
    this.lobbyNet = net;
    this.wireLobbyNet(net);
    net
      .connect()
      .then(() => {
        if (this.lobbyNet === net) this.menuState.lobby.status = '已连接服务器';
      })
      .catch(() => {
        if (this.lobbyNet === net) {
          this.menuState.lobby.status =
            '错误：无法连接中继服务器（免费云休眠时约 1 分钟后重试；本地联机请先运行 npm run server）';
        }
      });
  }

  private closeLobby(): void {
    this.closeNameEditor();
    this.lobbyNet?.leave();
    this.lobbyNet?.close();
    this.lobbyNet = null;
    this.netRoomCode = '';
    this.menuState.lobby = createLobbyInfo();
  }

  private myCharacterId(): string {
    return CHARACTERS[this.menuState.selectedChar]?.id ?? CHARACTERS[0]!.id;
  }

  private createRoom(): void {
    const net = this.lobbyNet;
    if (!net) return;
    // 未连上就点创建：send 会被静默丢弃，界面永远停在"正在创建房间…"——必须显式报错
    if (!net.connected) {
      this.menuState.lobby.status = '错误：尚未连接到服务器，等下方显示"已连接服务器"再创建';
      return;
    }
    this.closeNameEditor();
    this.menuState.lobby.status = '正在创建房间…';
    net.send({
      t: 'create',
      mode: this.menuState.lobby.mode,
      name: this.playerName,
      characterId: this.myCharacterId(),
      color: PLAYER_COLORS[0]!,
    });
  }

  private joinRoom(): void {
    const net = this.lobbyNet;
    if (!net) return;
    if (!net.connected) {
      this.menuState.lobby.status = '错误：尚未连接到服务器，等下方显示"已连接服务器"再加入';
      return;
    }
    this.closeNameEditor();
    const code = this.menuState.lobby.codeInput.trim().toUpperCase();
    if (code.length !== 4) {
      this.menuState.lobby.status = '错误：请输入 4 位房间号';
      return;
    }
    this.menuState.lobby.status = `正在加入 ${code} …`;
    net.send({
      t: 'join',
      code,
      name: this.playerName,
      characterId: this.myCharacterId(),
      color: PLAYER_COLORS[3]!,
    });
  }

  /** 大厅阶段：房间号输入框的键盘录入。 */
  private handleLobbyKeyInput(): void {
    const lb = this.menuState.lobby;
    if (this.input.wasPressed('Backspace')) {
      lb.codeInput = lb.codeInput.slice(0, -1);
      return;
    }
    if (this.input.wasPressed('Enter')) {
      if (lb.codeInput.length === 4) this.joinRoom();
      return;
    }
    for (const code in KEY_CHARS) {
      if (lb.codeInput.length >= 4) break;
      if (this.input.wasPressed(code)) lb.codeInput += KEY_CHARS[code];
    }
  }

  /** 打开一个覆盖在画布名字框上的 DOM 输入框（支持中文等任意字符）。 */
  private openNameEditor(): void {
    if (this.nameInputEl) return;
    this.closeLobbyKeyInputOnly();
    this.input.enabled = false;
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / VIEW_W;
    const scaleY = rect.height / VIEW_H;
    const x = 296;
    const y = 158;
    const w = 372;
    const h = 46;
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 12;
    input.value = this.playerName;
    input.placeholder = '输入你的名字';
    input.setAttribute('aria-label', '设置你的名字');
    const fs = Math.max(12, Math.round(18 * Math.min(scaleX, scaleY)));
    Object.assign(input.style, {
      position: 'fixed',
      left: `${rect.left + x * scaleX}px`,
      top: `${rect.top + y * scaleY}px`,
      width: `${w * scaleX}px`,
      height: `${h * scaleY}px`,
      boxSizing: 'border-box',
      padding: '0 12px',
      margin: '0',
      fontSize: `${fs}px`,
      fontFamily: '"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif',
      color: '#f4f0ff',
      background: 'rgba(10,8,18,0.94)',
      border: '2px solid #ffd479',
      borderRadius: '12px',
      outline: 'none',
      zIndex: '20',
    } as Partial<CSSStyleDeclaration>);
    input.addEventListener('input', () => {
      this.menuState.lobby.name = input.value;
    });
    const commit = () => {
      const v = input.value.trim();
      this.playerName = v.length ? v.slice(0, 12) : this.playerName;
      this.menuState.lobby.name = this.playerName;
      this.closeNameEditor();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeNameEditor();
      }
    });
    input.addEventListener('blur', commit);
    document.body.appendChild(input);
    input.focus();
    input.select();
    this.nameInputEl = input;
  }

  /** 关闭名字输入框并恢复游戏键盘输入。 */
  private closeNameEditor(): void {
    if (!this.nameInputEl) return;
    const el = this.nameInputEl;
    this.nameInputEl = null;
    if (el.parentElement) el.parentElement.removeChild(el);
    this.input.enabled = true;
  }

  /** 仅在加入房间输入态被外部打断时清理（名字框与房间号互斥，不会同时开）。 */
  private closeLobbyKeyInputOnly(): void {
    const lb = this.menuState.lobby;
    if (lb.joining) {
      lb.joining = false;
      lb.codeInput = '';
    }
  }

  private wireLobbyNet(net: NetClient): void {
    net.on('created', (m) => {
      if (m.t !== 'created' || this.lobbyNet !== net) return;
      this.netLocalPeerId = m.peerId;
      this.netRoomCode = m.code;
      const lb = this.menuState.lobby;
      lb.phase = 'room';
      lb.isHost = true;
      lb.code = m.code;
      lb.mode = m.mode;
      lb.status = '房间已创建，等待队友加入';
      lb.members = [{ name: this.playerName, color: PLAYER_COLORS[0]!, isHost: true, charId: this.myCharacterId() }];
    });

    net.on('joined', (m) => {
      if (m.t !== 'joined' || this.lobbyNet !== net) return;
      this.netLocalPeerId = m.peerId;
      this.netRoomCode = m.code;
      const lb = this.menuState.lobby;
      lb.phase = 'room';
      lb.isHost = false;
      lb.code = m.code;
      lb.mode = m.mode;
      lb.joining = false;
      lb.status = '已加入房间，等待房主开始';
      lb.members = m.peers.map((p) => ({ name: p.name, color: p.color, isHost: p.isHost, charId: p.characterId }));
    });

    net.on('peerJoined', (m) => {
      if (m.t !== 'peerJoined' || this.lobbyNet !== net) return;
      const lb = this.menuState.lobby;
      if (!lb.members.some((x) => x.name === m.peer.name && x.color === m.peer.color)) {
        lb.members = [...lb.members, { name: m.peer.name, color: m.peer.color, isHost: m.peer.isHost, charId: m.peer.characterId }];
      }
      lb.status = `${m.peer.name} 加入了房间`;
    });

    net.on('peerLeft', (m) => {
      if (m.t !== 'peerLeft' || this.lobbyNet !== net) return;
      this.menuState.lobby.status = '有队友离开了房间';
    });

    net.on('start', (m) => {
      if (m.t !== 'start' || this.lobbyNet !== net) return;
      this.startNetGame(m.seed, m.mode, m.peers, net);
    });

    net.on('error', (m) => {
      if (m.t !== 'error' || this.lobbyNet !== net) return;
      this.menuState.lobby.status = `错误：${m.message}`;
      this.menuState.lobby.joining = false;
    });

    net.on('closed', () => {
      if (this.lobbyNet !== net) return;
      this.menuState.lobby.status = '连接已断开';
      this.menuState.lobby.phase = 'idle';
      this.menuState.lobby.joining = false;
    });
  }

  private startNetGame(seed: number, mode: NetMode, peers: PeerInfo[], net: NetClient): void {
    this.closeNameEditor();
    const me = peers.find((p) => p.id === this.netLocalPeerId);
    const charId = me?.characterId ?? this.myCharacterId();
    const role: 'host' | 'client' = this.menuState.lobby.isHost ? 'host' : 'client';
    this.audio.init();
    this.audio.setMusicIntensity(0);
    this.game?.dispose();
    this.game = new GameplayScene(this, charId, seed, {
      client: net,
      role,
      mode,
      localPeerId: this.netLocalPeerId,
      roomCode: this.netRoomCode,
      peers,
    });
    this.scene = 'game';
    this.audio.startMusic();
    this.audio.play('door', 0.9);
  }

  /** 当前远征信息（调试 / 未来扩展用）。 */
  get currentFloor(): number {
    return this.game?.state.floor ?? 0;
  }

  get floorCount(): number {
    return FLOOR_COUNT;
  }
}

// ------------------------------------------------------------------ 启动

function bootstrap(): void {
  const canvas = document.getElementById('game') as HTMLCanvasElement | null;
  if (!canvas) {
    const el = document.getElementById('fatal');
    if (el) {
      el.textContent = '找不到画布元素 #game，页面结构可能已损坏。';
      el.style.display = 'block';
    }
    return;
  }

  const app = new App(canvas);
  app.start();

  const boot = document.getElementById('boot');
  if (boot) {
    boot.style.opacity = '0';
    window.setTimeout(() => boot.remove(), 420);
  }

  // 便于在浏览器控制台里做手动调试
  (window as unknown as { __yuanqi?: App }).__yuanqi = app;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

export { App };
