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
import { PK_KILL_TARGET, PK_MATCH_SECONDS, PK_MIN_PLAYERS, ROOM_H, ROOM_W } from '../src/data/config';
import { getEnemyDef } from '../src/data/enemies';
import { Enemy } from '../src/entities/enemy';
import type { Player } from '../src/entities/player';
import { WorldRenderer } from '../src/render/renderer';
import { GameplayScene, type GameHost } from '../src/scenes/gameplay';
import { AudioSystem } from '../src/systems/audio';
import { SaveManager, createMemoryStorage, defaultSettings } from '../src/systems/save';
import type { RunResult } from '../src/systems/run';
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

/**
 * `makeCtx()` 的 Proxy 会优先读 store，所以预置 `fillText` 就能把整帧文字录下来，
 * 其余绘图接口（getImageData 等）仍沿用 `makeCtx` 的全量替身 —— 不用再抄一份。
 */
function makeRecordingCanvas(sink: string[], width = 1280, height = 720) {
  const { canvas } = makeCanvas(width, height);
  const ctx = canvas.getContext() as unknown as Record<string, unknown>;
  ctx.fillText = (text: unknown) => sink.push(String(text));
  ctx.strokeText = (text: unknown) => sink.push(String(text));
  return canvas;
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

/** 宿主被调用的联机收尾入口记录（需求 26/27 的断言就靠它）。 */
interface NetCallLog {
  dissolved: string[];
  leftNet: string[];
  ended: RunResult[];
}

function makeHost(log?: NetCallLog, sink?: string[]): GameHost {
  const canvas = sink ? makeRecordingCanvas(sink) : makeCanvas().canvas;
  const host: GameHost = {
    renderer: new WorldRenderer(canvas as unknown as HTMLCanvasElement),
    input: new Input(canvas as unknown as HTMLCanvasElement),
    audio: new AudioSystem(),
    save: new SaveManager(createMemoryStorage()),
    bus: new EventBus(),
    endRun: () => undefined,
    abandonRun: () => undefined,
  };
  if (log) {
    host.endRun = (result: RunResult) => {
      log.ended.push(result);
    };
    host.dissolveRoom = (reason: string) => {
      log.dissolved.push(reason);
    };
    host.leaveNet = (reason: string) => {
      log.leftNet.push(reason);
    };
  }
  return host;
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
  log?: NetCallLog,
  sink?: string[],
) {
  const host = makeHost(log, sink);
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

/** 裁判的私有状态（测试要观测阶段 / 直接改剩余时间）。 */
interface PkProbe {
  pk: { phase: string; timeLeft: number; countdown: number; killTarget: number };
}

function pkProbe(scene: GameplayScene): PkProbe {
  return scene as unknown as PkProbe;
}

/**
 * 让自由混战真正开打：等齐人 → 3 秒准备倒计时 → live。
 *
 * 只跑 3 帧模拟（把倒计时直接摁到 0），免得为了"等 3 秒"白跑 200 帧把玩家喂给怪物。
 */
function kickoff(scene: GameplayScene): void {
  runFrames(scene, 1); // waiting → starting
  pkProbe(scene).pk.countdown = 0.001;
  runFrames(scene, 2); // → live
  if (pkProbe(scene).pk.phase !== 'live') throw new Error(`比赛没进入 live（当前 ${pkProbe(scene).pk.phase}）`);
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

function summaryOverlayCtx(pk: boolean, net = false): OverlayContext {
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
    net,
  };
}

/** 结算面板两个出口的屏幕坐标（见 overlays.ts 的 dead/victory 布局）。 */
const RETRY_BTN: [number, number] = [640, 523];
const ROOM_EXIT_BTN: [number, number] = [640, 585];

function clickAt(host: GameHost, scene: GameplayScene, x: number, y: number): void {
  const pointer = host.input.pointer;
  pointer.down = false;
  pointer.sx = x;
  pointer.sy = y;
  pointer.justDown = true;
  scene.update(1 / 60);
  pointer.justDown = false;
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

  test('PK 无胜者（全员阵亡 / 时间到平局）—— 一律判负，不能凭空判胜', () => {
    const wipeNet = fakeNet();
    const wipe = makeNetScene('pk', 'client', 'p-guest', wipeNet);
    wipeNet.emit({ t: 'gameover', won: true, winnerId: null, reason: 'pk', pkReason: 'wipeout' });
    expect(wipe.scene.overlayMode).toBe('dead');
    expect((wipe.scene as unknown as { overlay: OverlayState }).overlay.death?.cause).toBe(
      '全员阵亡 · 无人幸存',
    );
    wipe.scene.dispose();

    const drawNet = fakeNet();
    const draw = makeNetScene('pk', 'client', 'p-guest', drawNet);
    drawNet.emit({ t: 'gameover', won: true, winnerId: null, reason: 'pk', pkReason: 'timeUp' });
    expect(draw.scene.overlayMode).toBe('dead');
    expect((draw.scene as unknown as { overlay: OverlayState }).overlay.death?.cause).toContain('平局');
    draw.scene.dispose();
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
    kickoff(scene);

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
    kickoff(hostSide.scene);
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

describe('联机房间生命周期：合作一局打完自动收房（需求 26）', () => {
  test('合作模式：全队阵亡 → 房间立刻解散，房间号与记分板从画面消失', () => {
    const net = fakeNet();
    const log: NetCallLog = { dissolved: [], leftNet: [], ended: [] };
    const sink: string[] = [];
    const { scene } = makeNetScene('coop', 'host', 'p-host', net, 424242, log, sink);

    runFrames(scene, 2);
    // 对局中：房间号 + 记分板的「合作闯关」抬头都在
    expect(sink.join('|')).toContain('房间 PK01');
    expect(sink.join('|')).toContain('合作闯关');
    expect(log.dissolved).toEqual([]);
    sink.length = 0;

    // 合作模式要全员倒下才算结束（单人阵亡不结束整局）
    const players = (scene as unknown as { allPlayers: Player[] }).allPlayers;
    for (const p of players) slay(p);
    runFrames(scene, 4);
    expect(scene.overlayMode).toBe('dead');

    expect(log.dissolved.length).toBe(1);
    expect(log.leftNet).toEqual([]);

    const after = sink.join('|');
    expect(after).not.toContain('房间 PK01');
    expect(after).not.toContain('合作闯关');
    // 但要说清楚「房间没了不是掉线」
    expect(after).toContain('房间已自动解散');

    scene.dispose();
  });

  test('客户端侧：房主解散房间后仍留在结算界面，不会被踢回大厅', () => {
    const net = fakeNet();
    const log: NetCallLog = { dissolved: [], leftNet: [], ended: [] };
    const { scene } = makeNetScene('pk', 'client', 'p-guest', net, 424242, log);

    net.emit({ t: 'gameover', won: false, winnerId: 'p-guest', reason: 'pk' });
    expect(scene.overlayMode).toBe('victory');

    // 房主离房 → 中继给成员发的就是这条
    net.emit({ t: 'closed' });

    expect(log.leftNet).toEqual([]); // 关键：不能因关房把结算界面顶掉
    expect(log.dissolved).toEqual([]); // 解散由房主负责，客户端不重复发起
    expect(scene.overlayMode).toBe('victory');
    expect((scene as unknown as { roomCode: string }).roomCode).toBe('');
    scene.dispose();
  });

  test('回归：对局中掉线仍然照旧回大厅（本次改动不能把这条也吃掉）', () => {
    const net = fakeNet();
    const log: NetCallLog = { dissolved: [], leftNet: [], ended: [] };
    const { scene } = makeNetScene('coop', 'client', 'p-guest', net, 424242, log);
    runFrames(scene, 2);
    expect(scene.overlayMode).toBe('none');

    net.emit({ t: 'closed' });

    expect(log.leftNet.length).toBe(1);
    scene.dispose();
  });
});

describe('自由混战：比赛时长与人头目标（需求 27）', () => {
  test('先到 10 人头即提前结束，且胜者是人头达标的那一位', () => {
    const net = fakeNet();
    const { scene } = makeNetScene('pk', 'host', 'p-host', net);
    kickoff(scene);

    scene.state.player.kills = PK_KILL_TARGET;
    runFrames(scene, 3);

    expect(scene.overlayMode).toBe('victory');
    const over = net.sent.filter((m) => m.t === 'gameover');
    expect(over.length).toBe(1);
    expect(over[0]).toMatchObject({ t: 'gameover', won: true, winnerId: 'p-host' });
    const overlay = (scene as unknown as { overlay: OverlayState }).overlay;
    expect(overlay.death?.cause).toContain(`率先击杀 ${PK_KILL_TARGET} 人`);
    scene.dispose();
  });

  test('差一个人头不算提前结束 —— 门槛是「达到」而不是「接近」', () => {
    const net = fakeNet();
    const { scene } = makeNetScene('pk', 'host', 'p-host', net);
    kickoff(scene);

    scene.state.player.kills = PK_KILL_TARGET - 1;
    runFrames(scene, 3);

    expect(scene.overlayMode).toBe('none');
    scene.dispose();
  });

  test('倒计时归零 → 按人头数排名判定胜负（不再只看"活到最后"）', () => {
    const net = fakeNet();
    const { scene } = makeNetScene('pk', 'host', 'p-host', net);
    kickoff(scene);

    scene.state.player.kills = 4; // 房主 4 杀，对手 0 杀
    pkProbe(scene).pk.timeLeft = 0.01;
    runFrames(scene, 3);

    expect(scene.overlayMode).toBe('victory');
    const over = net.sent.filter((m) => m.t === 'gameover');
    expect(over[0]).toMatchObject({ t: 'gameover', won: true, winnerId: 'p-host' });
    scene.dispose();
  });

  test('倒计时一路递减，并随快照下发给客户端（两边时钟不各算各的）', () => {
    const hostNet = fakeNet();
    const hostSide = makeNetScene('pk', 'host', 'p-host', hostNet);
    kickoff(hostSide.scene);
    runFrames(hostSide.scene, 40); // 约 0.67s

    const snaps = hostNet.sent.filter((m) => m.t === 'snapshot');
    expect(snaps.length).toBeGreaterThan(0);
    const last = snaps[snaps.length - 1]!;
    if (last.t !== 'snapshot') throw new Error('unreachable');
    expect(last.s.killTarget).toBe(PK_KILL_TARGET);
    expect(last.s.pkPhase).toBe('live');
    expect(last.s.matchTimeLeft).toBeLessThan(PK_MATCH_SECONDS);
    expect(last.s.matchTimeLeft).toBeGreaterThan(PK_MATCH_SECONDS - 5);

    // 客户端：照快照画倒计时 + 目标（阶段也照房主抄，不自己算）
    const sink: string[] = [];
    const guestNet = fakeNet();
    const guestSide = makeNetScene('pk', 'client', 'p-guest', guestNet, 424242, undefined, sink);
    guestNet.emit({ t: 'snapshot', s: { ...last.s, matchTimeLeft: 42 } });
    runFrames(guestSide.scene, 2);
    expect(sink.join('|')).toContain('0:42');
    expect(sink.join('|')).toContain(`击杀 ${PK_KILL_TARGET} 人提前结束`);

    hostSide.scene.dispose();
    guestSide.scene.dispose();
  });

  test('「等待玩家加入」阶段：HUD 与顶部提示都要说清比赛还没开始', () => {
    const net = fakeNet();
    const sink: string[] = [];
    // 只有房主自己的房间
    const solo = new GameplayScene(makeHost(undefined, sink), 'lulu', 424242, {
      client: net.client,
      role: 'host',
      mode: 'pk',
      localPeerId: 'p-host',
      roomCode: 'PK01',
      peers: [HOST_PEER],
    });
    runFrames(solo, 3);

    expect(pkProbe(solo).pk.phase).toBe('waiting');
    const text = sink.join('|');
    expect(text).toContain('等待玩家加入');
    expect(text).toContain(`比赛未开始 · 1/${PK_MIN_PLAYERS} 人`);
    solo.dispose();
  });

  test('时间到人头打平 → 判平局，且原因随 gameover 一起下发给客户端', () => {
    const net = fakeNet();
    const { scene } = makeNetScene('pk', 'host', 'p-host', net);
    kickoff(scene);

    pkProbe(scene).pk.timeLeft = 0.01;
    runFrames(scene, 3);

    expect(scene.overlayMode).toBe('dead');
    const over = net.sent.filter((m) => m.t === 'gameover');
    expect(over.length).toBe(1);
    if (over[0]?.t !== 'gameover') throw new Error('unreachable');
    expect(over[0].winnerId).toBe(null);
    expect(over[0].pkReason).toBe('timeUp');

    // 客户端用同样的结构化原因渲染自己的视角（绝不照抄房主的字符串）
    const sink: string[] = [];
    const guestNet = fakeNet();
    const guestSide = makeNetScene('pk', 'client', 'p-guest', guestNet, 424242, undefined, sink);
    guestNet.emit({ t: 'gameover', won: false, winnerId: null, reason: 'pk', pkReason: over[0].pkReason });
    runFrames(guestSide.scene, 2);

    expect(sink.join('|')).toContain('PK 平局');
    expect(sink.join('|')).not.toContain('全员阵亡');

    scene.dispose();
    guestSide.scene.dispose();
  });

  test('回归（真机 bug）：PK 房间只有自己一个人时，绝不能一进门就判「最后的幸存者」', () => {
    const net = fakeNet();
    const log: NetCallLog = { dissolved: [], leftNet: [], ended: [] };
    const host = makeHost(log);
    // 只有房主自己的房间 —— 玩家在 Render 上就是这样单人点了「开始」
    const scene = new GameplayScene(host, 'lulu', 424242, {
      client: net.client,
      role: 'host',
      mode: 'pk',
      localPeerId: 'p-host',
      roomCode: 'PK01',
      peers: [HOST_PEER],
    });
    runFrames(scene, 30); // 半秒；老代码在第 1 帧就直接结算了

    expect(scene.overlayMode).toBe('none');
    expect(log.ended).toEqual([]);
    expect(net.sent.filter((m) => m.t === 'gameover')).toEqual([]);
    scene.dispose();
  });

  test('人头归属：最后一下是谁打的就算谁的（否则 2 人局全记在房主头上）', () => {
    const net = fakeNet();
    const { scene } = makeNetScene('pk', 'host', 'p-host', net);
    kickoff(scene);

    const sc = scene as unknown as {
      enemies: Enemy[];
      onEnemyDeath(e: Enemy): void;
      playerByTeam(team: string): Player | null;
    };
    const enemy = new Enemy(getEnemyDef('grub'), ROOM_W / 2, ROOM_H / 2, 1);
    // 模拟"挑战者打出的最后一击"（弹丸/光束/近战都会带上 ownerTeam）
    enemy.killedByTeam = 'p-guest';
    enemy.dead = true;
    sc.onEnemyDeath(enemy);

    expect(sc.playerByTeam('p-guest')!.kills).toBe(1);
    expect(scene.state.player.kills).toBe(0);

    // 没人标记归属时（单机 / 合作）照旧记在本地玩家头上
    const plain = new Enemy(getEnemyDef('grub'), ROOM_W / 2, ROOM_H / 2, 1);
    plain.dead = true;
    sc.onEnemyDeath(plain);
    expect(scene.state.player.kills).toBe(1);
    scene.dispose();
  });
});

describe('自由混战：房间留到玩家主动关闭，「再来一次」重开一局（需求 27）', () => {
  test('一局打完房间**不**自动解散 —— 否则「再来一次」就无从谈起', () => {
    const net = fakeNet();
    const log: NetCallLog = { dissolved: [], leftNet: [], ended: [] };
    const sink: string[] = [];
    const { scene } = makeNetScene('pk', 'host', 'p-host', net, 424242, log, sink);

    kickoff(scene);
    slay(scene.state.player);
    runFrames(scene, 3);
    expect(scene.overlayMode).toBe('dead');

    expect(log.dissolved).toEqual([]);
    expect(log.leftNet).toEqual([]);
    expect((scene as unknown as { roomCode: string }).roomCode).toBe('PK01');

    // 两个出口都要如实说明：房间还在，可以再来一次
    const after = sink.join('|');
    expect(after).toContain('关闭房间');
    expect(after).toContain('在同一房间直接开下一局');
    scene.dispose();
  });

  test('房主点「再来一次」→ 发 rematch（新 start 会让所有人重建场景）', () => {
    const net = fakeNet();
    const log: NetCallLog = { dissolved: [], leftNet: [], ended: [] };
    const { host, scene } = makeNetScene('pk', 'host', 'p-host', net, 424242, log, []);
    kickoff(scene);
    slay(scene.state.player);
    runFrames(scene, 3);

    clickAt(host, scene, RETRY_BTN[0], RETRY_BTN[1]);

    expect(net.sent.filter((m) => m.t === 'rematch').length).toBe(1);
    expect(net.sent.filter((m) => m.t === 'rematchRequest').length).toBe(0);
    expect(log.dissolved).toEqual([]); // 重开一局 ≠ 解散房间
    scene.dispose();
  });

  test('客户端点「再来一次」→ 只发 rematchRequest（房主权威，不能自己开局）', () => {
    const net = fakeNet();
    const log: NetCallLog = { dissolved: [], leftNet: [], ended: [] };
    const { host, scene } = makeNetScene('pk', 'client', 'p-guest', net, 424242, log, []);
    net.emit({ t: 'gameover', won: false, winnerId: 'p-host', reason: 'pk' });

    clickAt(host, scene, RETRY_BTN[0], RETRY_BTN[1]);

    expect(net.sent.filter((m) => m.t === 'rematchRequest').length).toBe(1);
    expect(net.sent.filter((m) => m.t === 'rematch').length).toBe(0);
    scene.dispose();
  });

  test('房主收到 rematchRequest → 代客户端开下一局（对局中一律忽略）', () => {
    const net = fakeNet();
    const log: NetCallLog = { dissolved: [], leftNet: [], ended: [] };
    const { scene } = makeNetScene('pk', 'host', 'p-host', net, 424242, log);

    // 对局中：不接受重开请求，免得有人在中途把局强行重置
    kickoff(scene);
    net.emit({ t: 'rematchRequest', from: 'p-guest' });
    runFrames(scene, 1);
    expect(net.sent.filter((m) => m.t === 'rematch').length).toBe(0);

    // 本局结束后：受理
    slay(scene.state.player);
    runFrames(scene, 3);
    net.emit({ t: 'rematchRequest', from: 'p-guest' });
    expect(net.sent.filter((m) => m.t === 'rematch').length).toBe(1);
    scene.dispose();
  });

  test('「关闭房间」才真的解散房间并把玩家送走', () => {
    const net = fakeNet();
    const log: NetCallLog = { dissolved: [], leftNet: [], ended: [] };
    const { host, scene } = makeNetScene('pk', 'host', 'p-host', net, 424242, log, []);
    kickoff(scene);
    slay(scene.state.player);
    runFrames(scene, 3);

    clickAt(host, scene, ROOM_EXIT_BTN[0], ROOM_EXIT_BTN[1]);

    expect(log.dissolved.length).toBe(1);
    expect(log.ended.length).toBe(1);
    scene.dispose();
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

  test('联机结算的出口叫「关闭房间」，单机仍是「返回大厅」', () => {
    const netGame = createOverlayState();
    netGame.mode = 'victory';
    netGame.death = summary('你成为了最后的幸存者', true);
    const netButtons = buildOverlayButtons(netGame, summaryOverlayCtx(true, true));
    expect(netButtons.find((b) => b.id === 'abandon')?.label).toBe('关闭房间');

    const solo = createOverlayState();
    solo.mode = 'dead';
    solo.death = summary('被深渊吞噬', false);
    expect(buildOverlayButtons(solo, summaryOverlayCtx(false)).find((b) => b.id === 'abandon')?.label).toBe(
      '返回大厅',
    );

    // 两个出口各干什么，面板底部得写清楚
    const text: string[] = [];
    drawOverlay(recordingCtx(text), netGame, netButtons, null, 1, summaryOverlayCtx(true, true));
    expect(text.join('|')).toContain('在同一房间直接开下一局');
  });

  test('等房主开下一局时「再来一次」置灰换文案 —— 点了不像没反应', () => {
    const st = createOverlayState();
    st.mode = 'victory';
    st.death = summary('你成为了最后的幸存者', true);
    st.resultNotice = '正在开始下一局…';
    const btns = buildOverlayButtons(st, summaryOverlayCtx(true, true));
    const retry = btns.find((b) => b.id === 'retry')!;
    expect(retry.enabled).toBe(false);
    expect(retry.label).toBe('正在开始下一局…');

    const text: string[] = [];
    drawOverlay(recordingCtx(text), st, btns, null, 1, summaryOverlayCtx(true, true));
    expect(text.join('|')).toContain('正在开始下一局…');
  });

  test('房主关掉房间后，客户端的结算页要说清"房主已关闭房间"', () => {
    const net = fakeNet();
    const log: NetCallLog = { dissolved: [], leftNet: [], ended: [] };
    const sink: string[] = [];
    const { scene } = makeNetScene('pk', 'client', 'p-guest', net, 424242, log, sink);
    net.emit({ t: 'gameover', won: true, winnerId: 'p-guest', reason: 'pk' });
    sink.length = 0;

    net.emit({ t: 'closed' });
    runFrames(scene, 1);

    expect(sink.join('|')).toContain('房主已关闭房间');
    expect(scene.overlayMode).toBe('victory'); // 仍然留在结算界面
    scene.dispose();
  });
});
