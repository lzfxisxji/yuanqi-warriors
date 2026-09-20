/**
 * 联机 PK 的胜负判定回归。
 *
 * 背景（真机 bug）：房主跑权威模拟，结束时广播 `{ t:'gameover', won, winnerId }`。
 * 但 `won` 是**房主自己**的胜负——PK 是自由混战，房主赢时它发 `won=true`，
 * 客户端若照单全收就会陪着一块显示"胜利"；反过来客户端赢下 PK 时，
 * 房主发的是 `won=false`，客户端于是显示"失败"（玩家实际遇到的那条）。
 *
 * 正确判据只有一个：**最后的幸存者是不是我**（winnerId === localPeerId）。
 * 这个文件把两个方向、合作模式的不变量、以及快照兜底都钉死。
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { EventBus } from '../src/core/eventbus';
import { Input } from '../src/core/input';
import { ROOM_H, ROOM_W } from '../src/data/config';
import type { Player } from '../src/entities/player';
import { WorldRenderer } from '../src/render/renderer';
import { GameplayScene, type GameHost } from '../src/scenes/gameplay';
import { AudioSystem } from '../src/systems/audio';
import { SaveManager, createMemoryStorage, defaultSettings } from '../src/systems/save';
import type { ClientMsg, NetMode, PeerInfo, ServerMsg, Snapshot } from '../src/net/protocol';
import type { NetClient } from '../src/net/NetClient';
import {
  buildOverlayButtons,
  createOverlayState,
  drawOverlay,
  type DeathSummary,
  type OverlayContext,
  type OverlayState,
} from '../src/ui/overlays';

// ------------------------------------------------------------------ Canvas mock

function makeGradient(): { addColorStop: (o: number, c: string) => void } {
  return { addColorStop: () => undefined };
}

function makeCtx(): CanvasRenderingContext2D {
  const store: Record<string, unknown> = {
    createLinearGradient: makeGradient,
    createRadialGradient: makeGradient,
    createPattern: () => null,
    measureText: (text: string) => ({ width: [...String(text)].length * 8 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    isPointInPath: () => false,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowBlur: 0,
    shadowColor: '#000000',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    imageSmoothingEnabled: true,
    filter: 'none',
  };
  return new Proxy(store, {
    get(target, key) {
      const k = key as string;
      if (k in target) return target[k];
      const fn = () => undefined;
      target[k] = fn;
      return fn;
    },
    set(target, key, value) {
      target[key as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function makeCanvas(width = 1280, height = 720) {
  const ctx = makeCtx();
  const canvas = {
    width,
    height,
    style: {} as CSSStyleDeclaration,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: height, width, height }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return { canvas };
}

function recordingCtx(sink: string[]): CanvasRenderingContext2D {
  const store: Record<string, unknown> = {
    createLinearGradient: makeGradient,
    createRadialGradient: makeGradient,
    createPattern: () => null,
    measureText: (t: string) => ({ width: [...String(t)].length * 8 }),
    setLineDash: () => undefined,
    getLineDash: () => [],
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowBlur: 0,
    shadowColor: '#000000',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    imageSmoothingEnabled: true,
  };
  return new Proxy(store, {
    get(target, key) {
      const k = key as string;
      // drawSummary 会切换 textAlign，不拦截 fillText 就漏文案
      if (k === 'fillText' || k === 'strokeText') {
        return (text: unknown) => sink.push(String(text));
      }
      if (k in target) return target[k];
      const fn = () => undefined;
      target[k] = fn;
      return fn;
    },
    set(target, key, value) {
      target[key as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    innerWidth: 1600,
    innerHeight: 900,
    devicePixelRatio: 1,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: () => undefined,
  };
  g.document = {
    createElement: () => makeCanvas(ROOM_W, ROOM_H).canvas,
    getElementById: () => null,
    addEventListener: () => undefined,
  };
  (g.window as Record<string, unknown>).AudioContext = undefined;
});

// ------------------------------------------------------------------ 工具

const HOST_PEER: PeerInfo = {
  id: 'p-host',
  name: '房主',
  characterId: 'lulu',
  color: '#ffcc44',
  isHost: true,
  team: 'p-host',
};
const GUEST_PEER: PeerInfo = {
  id: 'p-guest',
  name: '挑战者',
  characterId: 'milkdragon',
  color: '#66e0ff',
  isHost: false,
  team: 'p-guest',
};
const PEERS: PeerInfo[] = [HOST_PEER, GUEST_PEER];

interface FakeNet {
  client: NetClient;
  sent: ClientMsg[];
  emit(msg: ServerMsg): void;
}

/** 一个只记消息、不做网络的 NetClient 替身（等价于中继服务器的两端）。 */
function fakeNet(): FakeNet {
  const handlers = new Map<string, Set<(m: ServerMsg) => void>>();
  const sent: ClientMsg[] = [];
  const client = {
    url: 'ws://fake',
    connected: true,
    peerId: '',
    on(t: string, cb: (m: ServerMsg) => void) {
      let set = handlers.get(t);
      if (!set) {
        set = new Set();
        handlers.set(t, set);
      }
      set.add(cb);
      return () => set!.delete(cb);
    },
    send(m: ClientMsg) {
      sent.push(m);
    },
    leave: () => undefined,
    close: () => undefined,
  } as unknown as NetClient;
  return {
    client,
    sent,
    emit(msg) {
      for (const h of handlers.get(msg.t) ?? []) h(msg);
    },
  };
}

function makeHost(): GameHost {
  const { canvas } = makeCanvas();
  return {
    renderer: new WorldRenderer(canvas as unknown as HTMLCanvasElement),
    input: new Input(canvas as unknown as HTMLCanvasElement),
    audio: new AudioSystem(),
    save: new SaveManager(createMemoryStorage()),
    bus: new EventBus(),
    endRun: () => undefined,
    abandonRun: () => undefined,
  };
}

function runFrames(scene: GameplayScene, frames: number): void {
  for (let i = 0; i < frames; i++) {
    scene.update(1 / 60);
    scene.render();
  }
}

function makeNetScene(
  mode: NetMode,
  role: 'host' | 'client',
  localPeerId: string,
  net: FakeNet,
  seed = 424242,
) {
  const host = makeHost();
  const scene = new GameplayScene(host, role === 'host' ? 'lulu' : 'milkdragon', seed, {
    client: net.client,
    role,
    mode,
    localPeerId,
    roomCode: 'PK01',
    peers: PEERS,
  });
  return { host, scene };
}

/** 让一名玩家当场阵亡（走真实扣血入口，不走 dodge）。 */
function slay(player: Player): void {
  player.mods.dodgeAdd = -1;
  player.applyDamage(999999, {
    crit: false,
    source: 'contact',
    dirX: 0,
    dirY: 0,
    knockback: 0,
  });
}

function summary(cause: string, won: boolean): DeathSummary {
  return {
    floor: 1,
    floorCount: 3,
    kills: 7,
    rooms: 3,
    gold: 233,
    timeSec: 96,
    score: 1200,
    won,
    characterName: '奶龙',
    cause,
  };
}

function summaryOverlayCtx(pk: boolean): OverlayContext {
  return {
    gold: 233,
    hp: 80,
    maxHp: 100,
    floor: 1,
    floorCount: 3,
    kills: 7,
    rooms: 3,
    timeSec: 96,
    score: 1200,
    settings: defaultSettings(),
    characterName: '奶龙',
    pk,
  };
}

// ------------------------------------------------------------------ 测试

describe('联机 PK：胜负必须按「本地视角」判定，而不是照抄房主的结果', () => {
  test('客户端赢下 PK —— 房主广播 won=false 也不能让它显示失败（本次 bug）', () => {
    const net = fakeNet();
    const { scene } = makeNetScene('pk', 'client', 'p-guest', net);
    expect(scene.overlayMode).toBe('none');

    // 房主输了，但它把胜者 id 一并发了出来
    net.emit({ t: 'gameover', won: false, winnerId: 'p-guest', reason: 'pk' });

    expect(scene.overlayMode).toBe('victory');
    const overlay = (scene as unknown as { overlay: OverlayState }).overlay;
    expect(overlay.death?.won).toBe(true);
    expect(overlay.death?.cause).toBe('你成为了最后的幸存者');
    scene.dispose();
  });

  test('客户端落败 —— 房主广播 won=true 也不会让它跟着显示胜利', () => {
    const net = fakeNet();
    const { scene } = makeNetScene('pk', 'client', 'p-guest', net);

    net.emit({ t: 'gameover', won: true, winnerId: 'p-host', reason: 'pk' });

    expect(scene.overlayMode).toBe('dead');
    const overlay = (scene as unknown as { overlay: OverlayState }).overlay;
    expect(overlay.death?.won).toBe(false);
    // 要说清是谁赢了，而不是一句含糊的"被未知力量击倒"
    expect(overlay.death?.cause).toBe('房主 成为最后的幸存者');
    scene.dispose();
  });

  test('PK 全员阵亡（无胜者）—— 一律判负，不能凭空判胜', () => {
    const net = fakeNet();
    const { scene } = makeNetScene('pk', 'client', 'p-guest', net);

    net.emit({ t: 'gameover', won: true, winnerId: null, reason: 'pk' });

    expect(scene.overlayMode).toBe('dead');
    const overlay = (scene as unknown as { overlay: OverlayState }).overlay;
    expect(overlay.death?.cause).toBe('全员阵亡');
    scene.dispose();
  });

  test('合作模式不受影响：房主的 won 就是全队的 won', () => {
    const winNet = fakeNet();
    const a = makeNetScene('coop', 'client', 'p-guest', winNet);
    winNet.emit({ t: 'gameover', won: true, winnerId: null, reason: 'coop' });
    expect(a.scene.overlayMode).toBe('victory');
    a.scene.dispose();

    const loseNet = fakeNet();
    const b = makeNetScene('coop', 'client', 'p-guest', loseNet);
    loseNet.emit({ t: 'gameover', won: false, winnerId: null, reason: 'coop' });
    expect(b.scene.overlayMode).toBe('dead');
    b.scene.dispose();
  });

  test('兜底：gameover 消息丢了，快照里的胜者也能判对', () => {
    const net = fakeNet();
    const { scene } = makeNetScene('pk', 'client', 'p-guest', net);
    const snap: Snapshot = {
      tick: 1,
      floor: scene.state.floor,
      roomKey: scene.state.currentRoomKey,
      transitioning: false,
      doorLocks: [],
      players: [],
      enemies: [],
      boss: null,
      projectiles: [],
      pickups: [],
      gold: 0,
      phase: 'dead', // 房主输了，所以它的 phase 是 dead
      winnerId: 'p-guest',
    };
    net.emit({ t: 'snapshot', s: snap });
    runFrames(scene, 2);

    expect(scene.overlayMode).toBe('victory');
    scene.dispose();
  });
});

describe('联机 PK：房主侧的判定与广播内容', () => {
  test('房主阵亡 → 判定胜者是对手，并广播 won=false + 对手 id', () => {
    const net = fakeNet();
    const { scene } = makeNetScene('pk', 'host', 'p-host', net);
    runFrames(scene, 2);

    slay(scene.state.player);
    runFrames(scene, 3);

    // 房主自己输了
    expect(scene.overlayMode).toBe('dead');
    const over = net.sent.filter((m) => m.t === 'gameover');
    expect(over.length).toBe(1);
    expect(over[0]).toMatchObject({ t: 'gameover', won: false, winnerId: 'p-guest' });
    scene.dispose();
  });

  test('端到端：房主阵亡 → 广播经中继 → 客户端结算为胜利', () => {
    const hostNet = fakeNet();
    const hostSide = makeNetScene('pk', 'host', 'p-host', hostNet);
    runFrames(hostSide.scene, 2);
    slay(hostSide.scene.state.player);
    runFrames(hostSide.scene, 3);
    expect(hostSide.scene.overlayMode).toBe('dead');

    // 把房主发出的消息原样喂给客户端（等价于中继服务器转发）
    const guestNet = fakeNet();
    const guestSide = makeNetScene('pk', 'client', 'p-guest', guestNet);
    for (const m of hostNet.sent) {
      if (m.t === 'gameover') guestNet.emit(m);
    }

    expect(guestSide.scene.overlayMode).toBe('victory');
    const overlay = (guestSide.scene as unknown as { overlay: OverlayState }).overlay;
    expect(overlay.death?.cause).toBe('你成为了最后的幸存者');

    hostSide.scene.dispose();
    guestSide.scene.dispose();
  });
});

describe('联机 PK：结算界面文案', () => {
  test('PK 胜/负用的是 PK 抬头，绝不写成「通关成功 / 深渊之心」', () => {
    const win = createOverlayState();
    win.mode = 'victory';
    win.death = summary('你成为了最后的幸存者', true);
    const winText: string[] = [];
    drawOverlay(
      recordingCtx(winText),
      win,
      buildOverlayButtons(win, summaryOverlayCtx(true)),
      null,
      1,
      summaryOverlayCtx(true),
    );
    expect(winText).toContain('PK 胜利');
    expect(winText.join('|')).toContain('你成为了最后的幸存者');
    expect(winText.join('|')).not.toContain('通关成功');
    expect(winText.join('|')).not.toContain('深渊之心');

    const lose = createOverlayState();
    lose.mode = 'dead';
    lose.death = summary('房主 成为最后的幸存者', false);
    const loseText: string[] = [];
    drawOverlay(
      recordingCtx(loseText),
      lose,
      buildOverlayButtons(lose, summaryOverlayCtx(true)),
      null,
      1,
      summaryOverlayCtx(true),
    );
    expect(loseText).toContain('PK 失败');
    expect(loseText.join('|')).toContain('房主 成为最后的幸存者');
    expect(loseText.join('|')).not.toContain('远征失败');
  });

  test('单机结算文案原样保留', () => {
    const win = createOverlayState();
    win.mode = 'victory';
    win.death = summary('击败了深渊之心', true);
    const text: string[] = [];
    drawOverlay(
      recordingCtx(text),
      win,
      buildOverlayButtons(win, summaryOverlayCtx(false)),
      null,
      1,
      summaryOverlayCtx(false),
    );
    expect(text).toContain('通关成功');
    expect(text.join('|')).toContain('深渊之心');
  });
});
