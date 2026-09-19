/**
 * 无头冒烟测试：用 mock Canvas 真正跑一遍游戏主循环。
 *
 * 单元测试证明「算法正确」，这个文件证明「代码真的能跑起来」：
 *   - 渲染层（WorldRenderer / tiles / art / hud / overlays）在真实调用下不抛异常
 *   - 房间切换、波次刷新、锁门、Boss 生成、Boss 击破、通关结算整条闭环都能跑通
 * 不依赖 jsdom / 浏览器，因此能在 CI 里稳定执行。
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { EventBus } from '../src/core/eventbus';
import { Input } from '../src/core/input';
import { DIRS, isCombatRoom, type Dir4 } from '../src/core/types';
import { FLOOR_COUNT, ROOM_H, ROOM_W, TILE } from '../src/data/config';
import { doorEntryPoint, doorRect } from '../src/dungeon/room';
import type { DungeonPlan } from '../src/dungeon/dungeon';
import type { Boss } from '../src/entities/boss';
import { WorldRenderer } from '../src/render/renderer';
import { GameplayScene, type GameHost } from '../src/scenes/gameplay';
import { AudioSystem } from '../src/systems/audio';
import { SaveManager, createMemoryStorage } from '../src/systems/save';
import type { RunResult } from '../src/systems/run';

// ------------------------------------------------------------------ Canvas mock

function makeGradient(): { addColorStop: (o: number, c: string) => void } {
  return { addColorStop: () => undefined };
}

function makeCtx(): CanvasRenderingContext2D {
  const store: Record<string, unknown> = {
    // 需要返回对象的 API 必须真实实现
    createLinearGradient: makeGradient,
    createRadialGradient: makeGradient,
    createPattern: () => null,
    measureText: (text: string) => ({ width: [...String(text)].length * 8 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    isPointInPath: () => false,
    // 会被读取的标量属性
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
  return { canvas, ctx };
}

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    innerWidth: 1600,
    innerHeight: 900,
    devicePixelRatio: 1,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    // 同步执行，方便在测试里立刻观察「延迟演出 + 结算」的结果
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
  // AudioContext 缺失是正常情况（AudioSystem 内部会降级为静音）
  (g.window as Record<string, unknown>).AudioContext = undefined;
});

// ------------------------------------------------------------------ 工具

function runFrames(scene: GameplayScene, frames: number): void {
  for (let i = 0; i < frames; i++) {
    scene.update(1 / 60);
    scene.render();
  }
}

/**
 * 推进帧数，同时让玩家保持无敌。
 * Boss 战冒烟只关心「Boss 流程能否跑完」，不想被长时间站桩磨死打断，
 * 所以这里每帧补一次无敌帧（不影响 Boss 的攻击 / 弹幕 / 预警逻辑）。
 */
function runBossFrames(scene: GameplayScene, frames: number): void {
  const player = scene.state.player;
  for (let i = 0; i < frames; i++) {
    if (!player.dead) {
      player.hp = player.maxHp;
      player.iframe = Math.max(player.iframe, 0.2);
    }
    scene.update(1 / 60);
    scene.render();
  }
}

/** 在逻辑分辨率坐标上点一下某个 UI 按钮。 */
function clickAt(host: GameHost, scene: GameplayScene, x: number, y: number): void {
  const pointer = host.input.pointer;
  pointer.down = false;
  pointer.sx = x;
  pointer.sy = y;
  pointer.justDown = true;
  scene.update(1 / 60);
  pointer.justDown = false;
}

/** 结算界面的「再来一次」按钮（死 / 通关共用的坐标）。 */
const RETRY_BUTTON: [number, number] = [640, 523];

/**
 * 关掉当前可能打开的覆盖层（强化三选一 / 事件房 / 商店）。
 * 这些坐标刻意选在各覆盖层按钮的「公共区」或互相不重叠的空白处，
 * 因此在没有覆盖层打开时不会误触任何按钮。
 */
const DISMISS_SPOTS: ReadonlyArray<[number, number]> = [
  [402, 364], // 强化卡 0（同时也是商店行的间隙，不会误买）
  [640, 379], // 事件房选项 0
  [640, 627], // 商店「离开」/ 事件「继续前进」
  [640, 644], // 事件「继续前进」
];

function dismissOverlays(host: GameHost, scene: GameplayScene, rounds = 4): void {
  // 首领房入口的「战前补给站」必须玩家显式确认，不能被这里顺手点掉
  if (scene.overlayMode === 'preboss') return;
  const pointer = host.input.pointer;
  pointer.down = false;
  pointer.sx = ROOM_W / 2;
  pointer.sy = ROOM_H / 2;
  for (let r = 0; r < rounds; r++) {
    for (const [x, y] of DISMISS_SPOTS) {
      pointer.sx = x;
      pointer.sy = y;
      pointer.justDown = true;
      scene.update(1 / 60);
      pointer.justDown = false;
    }
  }
}

/** 把玩家瞬移到某扇门的触发区并推进若干帧，等待房间切换完成。 */
function walkThroughDoor(scene: GameplayScene, dir: Dir4): void {
  const rect = doorRect(dir);
  const p = scene.state.player;
  p.hp = p.maxHp;
  if (dir === 'n') {
    p.x = rect.x + rect.w / 2;
    p.y = rect.h * 0.5;
  } else if (dir === 's') {
    p.x = rect.x + rect.w / 2;
    p.y = ROOM_H - rect.h * 0.5;
  } else if (dir === 'w') {
    p.x = rect.w * 0.5;
    p.y = rect.y + rect.h / 2;
  } else {
    p.x = ROOM_W - rect.w * 0.5;
    p.y = rect.y + rect.h / 2;
  }
  runFrames(scene, 45);
}

/** 强制把当前房间标记为已清理，避免冒烟流程被锁门挡住。 */
function forceClearCurrentRoom(scene: GameplayScene): void {
  const node = scene.state.plan.nodes.get(scene.state.currentRoomKey);
  if (!node) return;
  if (!isCombatRoom(node.type)) return;
  node.cleared = true;
  scene.currentRoom.unlockAllDoors();
}

/** 把玩家直接放到房间正中央（也就是传送门的落点），并等它脱离出现动画。 */
function standOnCenter(scene: GameplayScene): void {
  const p = scene.state.player;
  p.x = ROOM_W / 2;
  p.y = ROOM_H / 2;
  p.vx = 0;
  p.vy = 0;
  runBossFrames(scene, 30);
}

/** 模拟按下一次按键（Input 的单帧按键集合是私有的，这里直接投喂）。 */
function pressKey(host: GameHost, scene: GameplayScene, code: string): void {
  const input = host.input as unknown as { pressedThisFrame: Set<string> };
  input.pressedThisFrame.add(code);
  scene.update(1 / 60);
  input.pressedThisFrame.delete(code);
}

/** 沿路径一路走到 Boss 房（自动处理战斗房锁门与事件 / 商店覆盖层）。 */
function walkPathToBoss(host: GameHost, scene: GameplayScene): void {
  const dirs = pathToBoss(scene.state.plan);
  expect(dirs.length).toBeGreaterThan(0);
  for (const dir of dirs) {
    dismissOverlays(host, scene);
    forceClearCurrentRoom(scene);
    walkThroughDoor(scene, dir);
    dismissOverlays(host, scene);
  }
}

/**
 * 「战前补给站」面板上两个出口按钮的中心（buildOverlayButtons 里 `prep:start` /
 * `prep:leave` 都在 y = 566..616，两个按钮左右并排）：
 *   prep:start  x 308..628 → 中心 468
 *   prep:leave  x 652..912 → 中心 782
 * ⚠️ 这两个坐标必须跟着 `buildOverlayButtons` 的 'preboss' 分支一起改 ——
 * 曾经这里写死 (640, 591)，后来按钮改成并排之后 640 正好落在 628..652 的空隙里，
 * 点了个空，于是 `expect(overlayMode).toBe('none')` 直接挂掉。
 */
const PREP_START_BUTTON: [number, number] = [468, 591];
/** 「再准备一下」：关掉面板但**不开打**（首领仍为 null，覆盖层归 none）。 */
const PREP_LEAVE_BUTTON: [number, number] = [782, 591];

/** 首领房入口会先弹补给站：点「进入首领房」才算真正开打。 */
function confirmBossPrep(host: GameHost, scene: GameplayScene): void {
  if (scene.overlayMode !== 'preboss') return;
  clickAt(host, scene, PREP_START_BUTTON[0], PREP_START_BUTTON[1]);
  expect(scene.overlayMode).toBe('none');
  expect(scene.currentBoss).not.toBeNull();
}

/** 走到 Boss 房并确认补给站，进入真正的首领战。 */
function marchToBoss(host: GameHost, scene: GameplayScene): void {
  walkPathToBoss(host, scene);
  confirmBossPrep(host, scene);
}

/** 把 Boss 打穿三个阶段直到死亡（**不**推进死亡演出）。 */
function killBoss(scene: GameplayScene): Boss {
  runBossFrames(scene, 120); // 等它脱离 intro 状态（intro 期间免疫伤害）
  const boss = scene.currentBoss;
  expect(boss).not.toBeNull();
  for (let step = 0; step < 60 && !boss!.dead; step++) {
    runBossFrames(scene, 110);
    boss!.applyDamage(boss!.maxHp * 0.12, {
      crit: false,
      source: 'bullet',
      dirX: 0,
      dirY: 0,
      knockback: 0,
    });
  }
  // 死亡事件由下一帧的 updateBossSequence 观测到
  runBossFrames(scene, 3);
  expect(boss!.dead).toBe(true);
  return boss!;
}

/** 击杀 Boss 并跑完约 1 秒的死亡演出（演出结束后才会出现传送门）。 */
function slayBoss(scene: GameplayScene): void {
  killBoss(scene);
  runBossFrames(scene, 90);
  expect(scene.currentBoss).toBeNull();
}

/** BFS 求从起点到 Boss 房的方向序列。 */
function pathToBoss(plan: DungeonPlan): Dir4[] {
  const from = plan.startKey;
  const to = plan.bossKey;
  if (from === to) return [];
  const prev = new Map<string, { key: string; dir: Dir4 }>();
  const seen = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length) {
    const key = queue.shift()!;
    const node = plan.nodes.get(key)!;
    for (const d of DIRS) {
      const nk = node.neighbors[d];
      if (!nk || seen.has(nk)) continue;
      seen.add(nk);
      prev.set(nk, { key, dir: d });
      if (nk === to) queue.length = 0;
      else queue.push(nk);
    }
  }
  const dirs: Dir4[] = [];
  let cur = to;
  let guard = 0;
  while (cur !== from && guard++ < 200) {
    const step = prev.get(cur);
    if (!step) return [];
    dirs.unshift(step.dir);
    cur = step.key;
  }
  return dirs;
}

function makeHost(): { host: GameHost; results: RunResult[] } {
  const { canvas } = makeCanvas();
  const results: RunResult[] = [];
  const host: GameHost = {
    renderer: new WorldRenderer(canvas as unknown as HTMLCanvasElement),
    input: new Input(canvas as unknown as HTMLCanvasElement),
    audio: new AudioSystem(),
    save: new SaveManager(createMemoryStorage()),
    bus: new EventBus(),
    endRun: (r) => results.push(r),
    abandonRun: () => undefined,
  };
  return { host, results };
}

// ------------------------------------------------------------------ 测试

describe('游戏主循环冒烟测试', () => {
  test('构造场景并连续运行 600 帧不抛异常（含渲染）', () => {
    const { host } = makeHost();
    const scene = new GameplayScene(host, 'wolfshade', 20240918);
    expect(scene.currentRoom.type).toBe('start');
    expect(scene.state.floor).toBe(1);
    expect(scene.enemyCount).toBe(0);
    expect(() => runFrames(scene, 600)).not.toThrow();
    scene.dispose();
  });

  test('按住左键射击 + 移动输入下依然稳定，弹药不越界', () => {
    const { host } = makeHost();
    const scene = new GameplayScene(host, 'sting', 777);
    host.input.pointer.down = true;
    expect(() => runFrames(scene, 400)).not.toThrow();
    host.input.pointer.down = false;

    const player = scene.state.player;
    expect(player.shotsFired).toBeGreaterThan(0);
    // 松开后自动换弹会补满弹匣
    runFrames(scene, 150);
    const w = player.currentWeapon;
    expect(w.ammo).toBeGreaterThan(0);
    expect(w.ammo).toBeLessThanOrEqual(w.magSize);
    scene.dispose();
  });

  test('穿过门可以切换房间，战斗房会锁门并刷新敌人波次', () => {
    const { host } = makeHost();
    const scene = new GameplayScene(host, 'wolfshade', 31337);
    const startKey = scene.state.currentRoomKey;
    const dir = scene.currentRoom.doors[0];
    expect(dir).toBeDefined();

    walkThroughDoor(scene, dir!);
    dismissOverlays(host, scene);

    expect(scene.state.currentRoomKey).not.toBe(startKey);
    expect(scene.state.visited.size).toBeGreaterThanOrEqual(2);

    const node = scene.state.plan.nodes.get(scene.state.currentRoomKey)!;
    if (isCombatRoom(node.type) && node.type !== 'boss') {
      runFrames(scene, 180);
      expect(scene.enemyCount).toBeGreaterThan(0);
      expect(scene.currentRoom.lockedDoors.size).toBeGreaterThan(0);
    }
    scene.dispose();
  });

  test('回到已清理的房间不会被立刻反弹（门触发区与入场落点不重叠）', () => {
    const { host } = makeHost();
    const scene = new GameplayScene(host, 'wolfshade', 31337);
    const startKey = scene.state.currentRoomKey;
    const dir = scene.currentRoom.doors[0];
    expect(dir).toBeDefined();

    // 先去邻居房
    walkThroughDoor(scene, dir!);
    dismissOverlays(host, scene);
    const neighborKey = scene.state.currentRoomKey;
    expect(neighborKey).not.toBe(startKey);

    // 把邻居房清掉（门解锁），然后原路返回起点房
    forceClearCurrentRoom(scene);
    runFrames(scene, 10);
    const back: Dir4 = dir === 'n' ? 's' : dir === 's' ? 'n' : dir === 'e' ? 'w' : 'e';
    walkThroughDoor(scene, back);
    expect(scene.state.currentRoomKey).toBe(startKey);

    // 站在门内落点上静置：不能再被反弹回邻居房（这正是"画面一直闪"的根因）
    for (let i = 0; i < 300; i++) {
      scene.update(1 / 60);
      expect(scene.state.currentRoomKey).toBe(startKey);
    }
    scene.dispose();
  });

  test('真的走进门洞（而不是瞬移）也能触发房间切换', () => {
    // 门的触发深度被调浅过（为了避免与入场落点重叠导致来回弹跳），
    // 所以必须验证"用正常移动走进门口"依然能触发，否则修好弹跳的同时会把门堵死。
    let host: GameHost | null = null;
    let scene: GameplayScene | null = null;
    let dir: 'n' | 's' | null = null;
    for (let s = 1; s <= 80; s++) {
      const made = makeHost();
      const candidate = new GameplayScene(made.host, 'wolfshade', s * 7919);
      const d = candidate.currentRoom.doors.find((x) => x === 'n' || x === 's');
      if (d === 'n' || d === 's') {
        host = made.host;
        scene = candidate;
        dir = d;
        break;
      }
      candidate.dispose();
    }
    expect(dir).not.toBeNull();
    expect(scene).not.toBeNull();

    const startKey = scene!.state.currentRoomKey;
    const mv = dir === 'n' ? { x: 0, y: -1 } : { x: 0, y: 1 };
    // 用真实的移动输入驱动玩家：走完整的加速 / 碰撞 / 触发流程
    (host!.input as unknown as { moveVector: () => { x: number; y: number } }).moveVector = () => mv;

    for (let i = 0; i < 420 && scene!.state.currentRoomKey === startKey; i++) {
      scene!.update(1 / 60);
    }
    expect(scene!.state.currentRoomKey).not.toBe(startKey);
    scene!.dispose();
  });

  test('沿地牢路径一路走到 Boss 房，Boss 会被正确创建并开打', () => {
    const { host } = makeHost();
    const scene = new GameplayScene(host, 'wolfshade', 24680);
    marchToBoss(host, scene);

    expect(scene.state.currentRoomKey).toBe(scene.state.plan.bossKey);
    expect(scene.currentRoom.type).toBe('boss');
    expect(scene.currentBoss).not.toBeNull();
    expect(scene.currentBoss!.maxHp).toBeGreaterThan(1000);
    expect(scene.currentBoss!.hp).toBe(scene.currentBoss!.maxHp);
    // Boss 会走完 intro → move → 各种攻击（含前摇预警），全程不应抛错
    expect(() => runBossFrames(scene, 900)).not.toThrow();
    expect(scene.currentBoss!.attackCount).toBeGreaterThan(0);
    scene.dispose();
  });

  test('击破 Boss：标记通关、Boss 死亡、刷出传送门，按 E 弹出楼层结算并可进入下一层', () => {
    const { host } = makeHost();
    const scene = new GameplayScene(host, 'wolfshade', 13579);
    marchToBoss(host, scene);
    slayBoss(scene);

    expect(scene.state.bossDefeated).toBe(true);
    expect(scene.roomCleared).toBe(true);

    // Boss 之后会给两次强化选择，先选掉
    dismissOverlays(host, scene);
    runFrames(scene, 5);

    // 关键回归：打完 Boss 必须真的有一扇"能走"的传送门（不是只有演出）
    expect(scene.portalReady).toBe(true);

    standOnCenter(scene);
    pressKey(host, scene, 'KeyE');
    expect(scene.overlayMode).toBe('floorclear');

    // 「进入下一层」按钮（buildOverlayButtons: x 490..790 / y 452..506）
    clickAt(host, scene, 640, 479);
    expect(scene.state.floor).toBe(2);
    expect(scene.state.currentRoomKey).toBe(scene.state.plan.startKey);
    expect(() => runFrames(scene, 60)).not.toThrow();
    scene.dispose();
  });

  test('最终层击破 Boss：同样刷出传送门，按 E 直接通关结算（endRun won = true）', () => {
    const { host, results } = makeHost();
    const scene = new GameplayScene(host, 'bulwark', 8642);
    // 直接置为最终层：只验证「最终层击破 → 传送门 → 按 E 通关」这段分支
    scene.state.floor = FLOOR_COUNT;

    marchToBoss(host, scene);
    slayBoss(scene);

    // 最终层不再自动弹结算、也不再给强化，而是把决定权交给玩家
    expect(scene.portalReady).toBe(true);
    expect(scene.overlayMode).toBe('none');

    standOnCenter(scene);
    expect(() => runFrames(scene, 120)).not.toThrow();

    pressKey(host, scene, 'KeyE');
    expect(scene.overlayMode).toBe('victory');

    // endRun 由结算界面的「再来一次」触发
    expect(results.length).toBe(0);
    clickAt(host, scene, RETRY_BUTTON[0], RETRY_BUTTON[1]);

    expect(results.length).toBe(1);
    const last = results[0]!;
    expect(last.won).toBe(true);
    expect(last.characterId).toBe('bulwark');
    expect(last.floor).toBe(FLOOR_COUNT);
    expect(last.score).toBeGreaterThan(0);
    scene.dispose();
  });

  test('最终层击破 Boss 后即使倒下也按通关结算（不会"赢了却被判失败"）', () => {
    const { host, results } = makeHost();
    const scene = new GameplayScene(host, 'wolfshade', 2468);
    scene.state.floor = FLOOR_COUNT;
    marchToBoss(host, scene);
    slayBoss(scene);
    runFrames(scene, 20);

    const player = scene.state.player;
    player.mods.dodgeAdd = -1;
    expect(player.dodgeChance).toBe(0);
    player.applyDamage(999999, { crit: false, source: 'contact', dirX: 0, dirY: 0, knockback: 0 });
    expect(player.dead).toBe(true);

    runFrames(scene, 200);
    expect(scene.overlayMode).toBe('victory');

    clickAt(host, scene, RETRY_BUTTON[0], RETRY_BUTTON[1]);
    expect(results.length).toBe(1);
    expect(results[0]!.won).toBe(true);
    scene.dispose();
  });

  test('「再准备一下」：只关面板不开打，走回门口按 E 能重新打开补给站', () => {
    const { host } = makeHost();
    const scene = new GameplayScene(host, 'wolfshade', 4242);
    walkPathToBoss(host, scene);

    expect(scene.overlayMode).toBe('preboss');

    // 点「再准备一下」→ 面板关掉，但首领**绝对不能**被叫醒
    clickAt(host, scene, PREP_LEAVE_BUTTON[0], PREP_LEAVE_BUTTON[1]);
    expect(scene.overlayMode).toBe('none');
    expect(scene.currentBoss).toBeNull();

    // 门仍然锁着（玩家没法把补给站和首领都绕过去）
    expect(scene.currentRoom.allDoorsLocked()).toBe(true);
    expect(() => runFrames(scene, 60)).not.toThrow();
    expect(scene.currentBoss).toBeNull();

    // 走回门口按 E → 补给站重新弹出。
    // 这是「再准备一下」的关键兜底：`prepShown` 已经是 true，
    // 进门分支不会再自动弹，没有这条路径玩家就永久卡在锁死的首领房里。
    // 用真实按键驱动（而不是直接调私有方法），确保走的是玩家实际会走的代码。
    const player = scene.state.player;
    const entry = doorEntryPoint(scene.currentRoom.doors[0]!);
    player.x = entry.x;
    player.y = entry.y;
    pressKey(host, scene, 'KeyE');
    expect(scene.overlayMode).toBe('preboss');

    // 这次真的进去
    clickAt(host, scene, PREP_START_BUTTON[0], PREP_START_BUTTON[1]);
    expect(scene.overlayMode).toBe('none');
    expect(scene.currentBoss).not.toBeNull();
    scene.dispose();
  });

  test('首领房入口会先弹出「战前补给站」：能回血、能扩容弹匣，确认后才开打', () => {
    const { host } = makeHost();
    const scene = new GameplayScene(host, 'wolfshade', 9090);
    walkPathToBoss(host, scene);

    expect(scene.currentRoom.type).toBe('boss');
    expect(scene.overlayMode).toBe('preboss');
    // 还没确认，所以首领根本还没登场
    expect(scene.currentBoss).toBeNull();

    const player = scene.state.player;
    scene.state.addGold(600);
    player.hp = 30;

    // 第 1 行：战地急救 —— 回复一半生命（行区间 y 196..276）
    const hpBefore = player.hp;
    clickAt(host, scene, 640, 236);
    expect(player.hp).toBeGreaterThan(hpBefore + 20);
    expect(scene.overlayMode).toBe('preboss');

    // 第 2 行：弹匣扩容 —— 走「弹匣扩容」强化，弹匣与弹药同步上涨（行区间 y 282..362）
    const magBefore = player.currentWeapon.magSize;
    clickAt(host, scene, 640, 322);
    expect(player.currentWeapon.magSize).toBeGreaterThan(magBefore);
    expect(scene.state.upgrades.some((u) => u.id === 'mag')).toBe(true);
    expect(player.currentWeapon.ammo).toBe(player.currentWeapon.magSize);

    // 确认进入：覆盖层关闭、首领登场
    clickAt(host, scene, PREP_START_BUTTON[0], PREP_START_BUTTON[1]);
    expect(scene.overlayMode).toBe('none');
    expect(scene.currentBoss).not.toBeNull();
    expect(() => runBossFrames(scene, 60)).not.toThrow();
    scene.dispose();
  });

  test('击败首领：死亡演出约 1 秒后才在场地中心开出传送门', () => {
    const { host } = makeHost();
    const scene = new GameplayScene(host, 'wolfshade', 5150);
    marchToBoss(host, scene);
    killBoss(scene);

    expect(scene.state.bossDefeated).toBe(true);

    // 演出进行中：遗体还在，但还没有传送门
    runBossFrames(scene, 30);
    expect(scene.currentBoss).not.toBeNull();
    expect(scene.portalReady).toBe(false);

    // 演出结束（1 秒 ≈ 60 帧）后：遗体散去、传送门出现在场地正中心
    runBossFrames(scene, 60);
    expect(scene.currentBoss).toBeNull();
    expect(scene.portalReady).toBe(true);
    const portal = scene.dropList.find((p) => p.kind === 'portal');
    expect(portal).toBeDefined();
    expect(Math.round(portal!.x)).toBe(ROOM_W / 2);
    expect(Math.round(portal!.y)).toBe(ROOM_H / 2);
    scene.dispose();
  });

  test('玩家阵亡 → 死因结算 → 确认后 endRun(won = false)', () => {
    const { host, results } = makeHost();
    const scene = new GameplayScene(host, 'sting', 4242);
    runFrames(scene, 10);

    const player = scene.state.player;
    // 关掉闪避，保证这一击一定命中（闪避是随机的，测试里要确定性）
    player.mods.dodgeAdd = -1;
    expect(player.dodgeChance).toBe(0);
    player.applyDamage(999999, {
      crit: false,
      source: 'contact',
      dirX: 0,
      dirY: 0,
      knockback: 0,
    });
    expect(player.dead).toBe(true);

    // 死亡演出结束后弹出结算界面
    runFrames(scene, 180);
    expect(results.length).toBe(0);
    clickAt(host, scene, RETRY_BUTTON[0], RETRY_BUTTON[1]);

    expect(results.length).toBe(1);
    expect(results[0]!.won).toBe(false);
    expect(results[0]!.characterId).toBe('sting');
  });

  test('暂停覆盖层可以打开、切换设置并关闭', () => {
    const { host } = makeHost();
    const scene = new GameplayScene(host, 'wolfshade', 555);
    runFrames(scene, 5);

    scene.handleKey('Escape');
    expect(() => runFrames(scene, 5)).not.toThrow();

    // 点击「设置」（暂停菜单里 设置 按钮位于 y 360..410）
    host.input.pointer.sx = 640;
    host.input.pointer.sy = 385;
    host.input.pointer.justDown = true;
    scene.update(1 / 60);
    host.input.pointer.justDown = false;

    // 切换「显示伤害数字」开关（开关在 x 840..960 / y 384..424）
    const before = host.save.data.settings.showDamageNumbers;
    host.input.pointer.sx = 900;
    host.input.pointer.sy = 400;
    host.input.pointer.justDown = true;
    scene.update(1 / 60);
    host.input.pointer.justDown = false;
    expect(host.save.data.settings.showDamageNumbers).toBe(!before);

    // Esc 关闭覆盖层，回到可玩状态
    scene.handleKey('Escape');
    scene.handleKey('Escape');
    expect(() => runFrames(scene, 30)).not.toThrow();
    scene.dispose();
  });

  test('房间渲染缓存被复用，失效后会重新烘焙', () => {
    const { host } = makeHost();
    const scene = new GameplayScene(host, 'wolfshade', 909);
    const room = scene.currentRoom;
    const layerA = host.renderer.staticLayer(room);
    const layerB = host.renderer.staticLayer(room);
    expect(layerA).toBe(layerB);

    host.renderer.invalidateRoom(room);
    const layerC = host.renderer.staticLayer(room);
    expect(layerC).not.toBe(layerA);
    scene.dispose();
  });

  test('dispose 后重复释放不会抛错', () => {
    const { host } = makeHost();
    const scene = new GameplayScene(host, 'wolfshade', 11111);
    runFrames(scene, 30);
    expect(() => {
      scene.dispose();
      scene.dispose();
    }).not.toThrow();
  });

  test('房间尺寸与门洞位置符合 28x18 / 48px 的瓦片假设', () => {
    expect(ROOM_W).toBe(28 * TILE);
    expect(ROOM_H).toBe(18 * TILE);
    const n = doorRect('n');
    const s = doorRect('s');
    const w = doorRect('w');
    const e = doorRect('e');
    expect(n.y).toBe(0);
    expect(s.y + s.h).toBe(ROOM_H);
    expect(w.x).toBe(0);
    expect(e.x + e.w).toBe(ROOM_W);
    for (const r of [n, s, w, e]) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
    }
  });
});
