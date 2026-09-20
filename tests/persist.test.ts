/**
 * 续玩存档的**端到端**回归：复刻玩家的真实操作路径。
 *
 * 背景：需求 20 之后存档改成了「每角色一份」，底层 `SaveManager` 有 23 条单测，
 * 但那些测试全是**直接喂 `snapshotRun()`**，没人验证过玩家真的走一遍
 * 「打穿一层 → 进下一层 → 按 Esc → 关掉页面 → 重新打开 → 继续远征」会不会丢档。
 * 这个文件专门补上这一段：只走玩家会走的公开入口（真实按键 / 真实点按钮），
 * 并且**换一个新的 SaveManager 实例**来模拟刷新页面，而不是复用内存里的旧对象。
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { EventBus } from '../src/core/eventbus';
import { Input } from '../src/core/input';
import { DIRS, isCombatRoom, type Dir4 } from '../src/core/types';
import { ROOM_H, ROOM_W } from '../src/data/config';
import { doorRect } from '../src/dungeon/room';
import type { DungeonPlan } from '../src/dungeon/dungeon';
import type { Boss } from '../src/entities/boss';
import { WorldRenderer } from '../src/render/renderer';
import { GameplayScene, type GameHost } from '../src/scenes/gameplay';
import { AudioSystem } from '../src/systems/audio';
import { SaveManager, createMemoryStorage, defaultSettings, type StorageLike } from '../src/systems/save';
import type { RunResult } from '../src/systems/run';
import {
  buildOverlayButtons,
  createOverlayState,
  drawOverlay,
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

function runFrames(scene: GameplayScene, frames: number): void {
  for (let i = 0; i < frames; i++) {
    scene.update(1 / 60);
    scene.render();
  }
}

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

function clickAt(host: GameHost, scene: GameplayScene, x: number, y: number): void {
  const pointer = host.input.pointer;
  pointer.down = false;
  pointer.sx = x;
  pointer.sy = y;
  pointer.justDown = true;
  scene.update(1 / 60);
  pointer.justDown = false;
}

function pressKey(host: GameHost, scene: GameplayScene, code: string): void {
  const input = host.input as unknown as { pressedThisFrame: Set<string> };
  input.pressedThisFrame.add(code);
  scene.update(1 / 60);
  input.pressedThisFrame.delete(code);
}

const DISMISS_SPOTS: ReadonlyArray<[number, number]> = [
  [402, 364],
  [640, 379],
  [640, 627],
  [640, 644],
];

function dismissOverlays(host: GameHost, scene: GameplayScene, rounds = 4): void {
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

function walkThroughDoor(scene: GameplayScene, dir: Dir4): void {
  const p = scene.state.player;
  p.hp = p.maxHp;
  const rect = doorRect(dir);
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

function forceClearCurrentRoom(scene: GameplayScene): void {
  const node = scene.state.plan.nodes.get(scene.state.currentRoomKey);
  if (!node) return;
  if (!isCombatRoom(node.type)) return;
  node.cleared = true;
  scene.currentRoom.unlockAllDoors();
}

function standOnCenter(scene: GameplayScene): void {
  const p = scene.state.player;
  p.x = ROOM_W / 2;
  p.y = ROOM_H / 2;
  p.vx = 0;
  p.vy = 0;
  runBossFrames(scene, 30);
}

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

const PREP_START_BUTTON: [number, number] = [468, 591];

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

function marchToBoss(host: GameHost, scene: GameplayScene): void {
  walkPathToBoss(host, scene);
  if (scene.overlayMode === 'preboss') {
    clickAt(host, scene, PREP_START_BUTTON[0], PREP_START_BUTTON[1]);
  }
}

function killBoss(scene: GameplayScene): Boss {
  runBossFrames(scene, 120);
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
  runBossFrames(scene, 3);
  expect(boss!.dead).toBe(true);
  return boss!;
}

function slayBoss(scene: GameplayScene): void {
  killBoss(scene);
  runBossFrames(scene, 90);
  expect(scene.currentBoss).toBeNull();
}

/** 三层共用的「进入下一层」按钮（buildOverlayButtons: x 490..790 / y 452..506）。 */
const NEXT_FLOOR_BUTTON: [number, number] = [640, 479];

/**
 * 造一个 host。`storage` 可复用 —— 复用同一个 storage 造出来的第二个 host
 * 就等价于「关掉页面重新打开」：`SaveManager` 会从存储里重新反序列化。
 *
 * `hooks` 用来观察暂停菜单的两个"退出"出口到底走了哪一个
 * （`abandonRun` 会删档、`exitToLobby` 不会，这是需求 21 的关键区别）。
 */
function makeHost(
  storage?: StorageLike,
  hooks: { abandonRun?: () => void; exitToLobby?: () => void } = {},
): { host: GameHost; results: RunResult[] } {
  const { canvas } = makeCanvas();
  const results: RunResult[] = [];
  const host: GameHost = {
    renderer: new WorldRenderer(canvas as unknown as HTMLCanvasElement),
    input: new Input(canvas as unknown as HTMLCanvasElement),
    audio: new AudioSystem(),
    save: new SaveManager(storage ?? createMemoryStorage()),
    bus: new EventBus(),
    endRun: (r) => results.push(r),
    abandonRun: () => hooks.abandonRun?.(),
    exitToLobby: () => hooks.exitToLobby?.(),
  };
  return { host, results };
}

/** 打穿当前层：走到首领房 → 打死 → 走到传送门按 E → 进入下一层。 */
function clearFloor(host: GameHost, scene: GameplayScene): void {
  marchToBoss(host, scene);
  slayBoss(scene);
  dismissOverlays(host, scene);
  runFrames(scene, 5);
  expect(scene.portalReady).toBe(true);
  standOnCenter(scene);
  pressKey(host, scene, 'KeyE');
  expect(scene.overlayMode).toBe('floorclear');
  clickAt(host, scene, NEXT_FLOOR_BUTTON[0], NEXT_FLOOR_BUTTON[1]);
}

// ------------------------------------------------------------------ 测试

describe('需求 20/21：续玩存档的端到端回归', () => {
  test('奶龙打穿第一层 → 进入第二层：进度立刻落到存储里', () => {
    const storage = createMemoryStorage();
    const { host } = makeHost(storage);
    const scene = new GameplayScene(host, 'milkdragon', 20260920);
    expect(scene.state.floor).toBe(1);

    clearFloor(host, scene);
    expect(scene.state.floor).toBe(2);

    // 关键：**不经过任何额外操作**，进第二层这件事本身就该已经落盘
    const reloaded = new SaveManager(storage);
    const saved = reloaded.getRun('milkdragon');
    expect(saved).not.toBeNull();
    expect(saved!.floor).toBe(2);
    expect(saved!.characterId).toBe('milkdragon');
    expect(saved!.seed).toBe(20260920);
    expect(saved!.currentRoomKey).toBe(scene.state.currentRoomKey);
    expect(saved!.weapons.map((w) => w.id)).toEqual(
      scene.state.player.weapons.map((w) => w.def.id),
    );
    scene.dispose();
  });

  test('按 Esc 打开暂停菜单：会再落一次盘，且存档内容与当前状态一致', () => {
    const storage = createMemoryStorage();
    const { host } = makeHost(storage);
    const scene = new GameplayScene(host, 'milkdragon', 20260920);
    clearFloor(host, scene);
    dismissOverlays(host, scene);
    runFrames(scene, 5);
    expect(scene.overlayMode).toBe('none');

    pressKey(host, scene, 'Escape');
    expect(scene.overlayMode).toBe('pause');

    const saved = new SaveManager(storage).getRun('milkdragon');
    expect(saved).not.toBeNull();
    expect(saved!.floor).toBe(2);
    expect(saved!.hp).toBe(scene.state.player.hp);
    scene.dispose();
  });

  test('刷新页面后「继续远征」：回到第二层同一个房间，武器 / 强化 / 金币都在', () => {
    const storage = createMemoryStorage();
    const first = makeHost(storage);
    const scene = new GameplayScene(first.host, 'milkdragon', 20260920);
    clearFloor(first.host, scene);
    dismissOverlays(first.host, scene);
    runFrames(scene, 5);
    scene.state.addGold(123);
    scene.state.addUpgrade('damage');
    scene.state.player.addOrReplaceWeapon('sniper');
    pressKey(first.host, scene, 'Escape');

    const snapshot = {
      floor: scene.state.floor,
      roomKey: scene.state.currentRoomKey,
      gold: scene.state.gold,
      weapons: scene.state.player.weapons.map((w) => w.def.id),
      upgrades: scene.state.upgrades.map((u) => u.id),
    };
    scene.dispose();

    // ---- 等价于刷新页面：全新的 host + 全新的 SaveManager，只共享 localStorage ----
    const second = makeHost(storage);
    const saved = second.host.save.getRun('milkdragon');
    expect(saved).not.toBeNull();
    const resumed = new GameplayScene(second.host, saved!.characterId, saved!.seed, undefined, saved);

    expect(resumed.state.floor).toBe(snapshot.floor);
    expect(resumed.state.currentRoomKey).toBe(snapshot.roomKey);
    expect(resumed.state.gold).toBe(snapshot.gold);
    expect(resumed.state.player.weapons.map((w) => w.def.id)).toEqual(snapshot.weapons);
    expect(resumed.state.upgrades.map((u) => u.id)).toEqual(snapshot.upgrades);
    expect(resumed.state.player.hp).toBeGreaterThan(0);
    resumed.dispose();
  });

  test('续玩之后继续往下打第三层，存档不会退回第二层', () => {
    const storage = createMemoryStorage();
    const first = makeHost(storage);
    const scene = new GameplayScene(first.host, 'milkdragon', 20260920);
    clearFloor(first.host, scene);
    scene.dispose();

    const second = makeHost(storage);
    const saved = second.host.save.getRun('milkdragon')!;
    const resumed = new GameplayScene(second.host, saved.characterId, saved.seed, undefined, saved);
    expect(resumed.state.floor).toBe(2);

    clearFloor(second.host, resumed);
    expect(resumed.state.floor).toBe(3);

    const saved3 = new SaveManager(storage).getRun('milkdragon');
    expect(saved3).not.toBeNull();
    expect(saved3!.floor).toBe(3);
    resumed.dispose();
  });

  test('其它角色的存档不会被奶龙挤掉（每角色一份）', () => {
    const storage = createMemoryStorage();
    const a = makeHost(storage);
    const milk = new GameplayScene(a.host, 'milkdragon', 111);
    clearFloor(a.host, milk);
    milk.dispose();

    const b = makeHost(storage);
    const lulu = new GameplayScene(b.host, 'lulu', 222);
    runFrames(lulu, 10);
    lulu.dispose();

    const reloaded = new SaveManager(storage);
    expect(reloaded.getRun('milkdragon')!.floor).toBe(2);
    expect(reloaded.getRun('lulu')!.floor).toBe(1);
    expect(reloaded.listRuns().length).toBe(2);
  });

  test('存档里不写房间内的瞬时对象：续玩时当前房间重打，但已清的房间仍是清的', () => {
    const storage = createMemoryStorage();
    const first = makeHost(storage);
    const scene = new GameplayScene(first.host, 'milkdragon', 20260920);
    clearFloor(first.host, scene);
    dismissOverlays(first.host, scene);
    runFrames(scene, 5);

    const floor2Start = scene.state.currentRoomKey;
    scene.state.plan.nodes.get(floor2Start)!.cleared = true;
    pressKey(first.host, scene, 'Escape');
    scene.dispose();

    const saved = new SaveManager(storage).getRun('milkdragon')!;
    expect(saved.floor).toBe(2);
    expect(saved.cleared).toContain(floor2Start);
    // 地牢由 seed + floor 完全决定：只要种子与楼层对得上，房间布局必然一致
    const second = makeHost(storage);
    const resumed = new GameplayScene(second.host, saved.characterId, saved.seed, undefined, saved);
    expect(resumed.state.currentRoomKey).toBe(floor2Start);
    expect(resumed.state.plan.nodes.get(floor2Start)!.cleared).toBe(true);
    expect(resumed.enemyCount).toBe(0);
    resumed.dispose();
  });
});

// ------------------------------------------------------------------ 暂停面板

/**
 * 暂停面板五个出口的中心坐标（`buildOverlayButtons` 的 'pause' 分支：
 * x 490..790 / h 48 / startY 246 / gap 12 → 行中心 y = 246 + i*60 + 24）。
 * ⚠️ 这份坐标必须跟着布局一起改，否则「点了个空」的测试会静默通过。
 */
const PAUSE_ROW: ReadonlyArray<[number, number]> = [
  [640, 270], // 0 继续游戏
  [640, 330], // 1 保存进度
  [640, 390], // 2 保存并返回大厅
  [640, 450], // 3 设置
  [640, 510], // 4 放弃远征
];

const PAUSE_PANEL = { x: 380, y: 118, w: 520, h: 484 };

/**
 * 「确认放弃」紧凑对话框（`buildOverlayButtons` 里 confirm 分支单独排的位置：
 * y 302 / 362，h 48 → 行中心 326 / 386），面板是 380,190,520,330。
 */
const PAUSE_CONFIRM_ROW: ReadonlyArray<[number, number]> = [
  [640, 326], // 确认放弃远征
  [640, 386], // 取消，继续游戏
];
const PAUSE_CONFIRM_PANEL = { x: 380, y: 190, w: 520, h: 330 };

function pauseOverlayCtx(): OverlayContext {
  return {
    gold: 340,
    hp: 88,
    maxHp: 116,
    floor: 2,
    floorCount: 3,
    kills: 41,
    timeSec: 754,
    rooms: 9,
    score: 5120,
    settings: defaultSettings(),
    characterName: '奶龙',
  };
}

describe('需求 21：Esc 暂停面板的存档出口', () => {
  test('暂停面板提供「保存进度 / 保存并返回大厅」两个存档出口', () => {
    const overlay = createOverlayState();
    overlay.mode = 'pause';
    const buttons = buildOverlayButtons(overlay, pauseOverlayCtx());
    const ids = buttons.map((b) => b.id);
    expect(ids).toEqual(['resume', 'save', 'save-exit', 'settings', 'abandon']);

    // 所有按钮都必须落在面板里，且两两不重叠（否则点击区互相吃掉）
    for (const b of buttons) {
      expect(b.x).toBeGreaterThanOrEqual(PAUSE_PANEL.x);
      expect(b.y).toBeGreaterThanOrEqual(PAUSE_PANEL.y);
      expect(b.x + b.w).toBeLessThanOrEqual(PAUSE_PANEL.x + PAUSE_PANEL.w);
      expect(b.y + b.h).toBeLessThanOrEqual(PAUSE_PANEL.y + PAUSE_PANEL.h);
    }
    for (let i = 0; i < buttons.length; i++) {
      for (let j = i + 1; j < buttons.length; j++) {
        const a = buttons[i]!;
        const b = buttons[j]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    }
  });

  test('「放弃远征」二次确认时只剩两个出口，且不再是那个危险的删除键', () => {
    const overlay = createOverlayState();
    overlay.mode = 'pause';
    overlay.confirmAbandon = true;
    const buttons = buildOverlayButtons(overlay, pauseOverlayCtx());
    expect(buttons.map((b) => b.id)).toEqual(['abandon-confirm', 'abandon-cancel']);
    expect(buttons.map((b) => b.id)).not.toContain('save-exit');
    // 两个出口都必须落在紧凑确认框里，且不重叠
    for (const b of buttons) {
      expect(b.x).toBeGreaterThanOrEqual(PAUSE_CONFIRM_PANEL.x);
      expect(b.x + b.w).toBeLessThanOrEqual(PAUSE_CONFIRM_PANEL.x + PAUSE_CONFIRM_PANEL.w);
      expect(b.y).toBeGreaterThanOrEqual(PAUSE_CONFIRM_PANEL.y);
      expect(b.y + b.h).toBeLessThanOrEqual(PAUSE_CONFIRM_PANEL.y + PAUSE_CONFIRM_PANEL.h);
    }
    const [a, b] = buttons;
    const overlap = a!.x < b!.x + b!.w && b!.x < a!.x + a!.w && a!.y < b!.y + b!.h && b!.y < a!.y + a!.h;
    expect(overlap).toBe(false);
  });

  test('渲染：五个出口 + 存档状态字真的画在面板上（不是只有坐标命中了）', () => {
    const overlay = createOverlayState();
    overlay.mode = 'pause';
    overlay.saveNotice = '已保存 · 第 2 层 · 12:34 · 击杀 41 · 金币 340';
    const ctx = pauseOverlayCtx();
    const buttons = buildOverlayButtons(overlay, ctx);
    const drawn: string[] = [];
    drawOverlay(recordingCtx(drawn), overlay, buttons, null, 1, ctx);

    const joined = drawn.join('|');
    expect(drawn).toContain('已暂停');
    for (const label of ['继续游戏', '保存进度', '保存并返回大厅', '设置', '放弃远征']) {
      expect(joined).toContain(label);
    }
    // 关键：玩家要能一眼看见"存了"
    expect(joined).toContain('已保存 · 第 2 层');
  });

  test('渲染：没有状态字时给出"会自动保存"的说明，而不是留一片空白', () => {
    const overlay = createOverlayState();
    overlay.mode = 'pause';
    const ctx = pauseOverlayCtx();
    const buttons = buildOverlayButtons(overlay, ctx);
    const drawn: string[] = [];
    drawOverlay(recordingCtx(drawn), overlay, buttons, null, 1, ctx);
    expect(drawn.join('|')).toContain('进度会自动保存');
  });

  test('渲染：确认放弃时画出警告文案，并指向「保存并返回大厅」这条安全路径', () => {
    const overlay = createOverlayState();
    overlay.mode = 'pause';
    overlay.confirmAbandon = true;
    const ctx = pauseOverlayCtx();
    const buttons = buildOverlayButtons(overlay, ctx);
    const drawn: string[] = [];
    drawOverlay(recordingCtx(drawn), overlay, buttons, null, 1, ctx);
    const joined = drawn.join('|');
    expect(drawn).toContain('确认放弃？');
    expect(joined).toContain('删除该角色的存档');
    expect(joined).toContain('保存并返回大厅');
  });

  test('按 Esc 打开面板时，状态字就是当前进度（含所在楼层）', () => {
    const storage = createMemoryStorage();
    const { host } = makeHost(storage);
    const scene = new GameplayScene(host, 'milkdragon', 20260920);
    clearFloor(host, scene);
    dismissOverlays(host, scene);
    runFrames(scene, 5);

    pressKey(host, scene, 'Escape');
    expect(scene.overlayMode).toBe('pause');

    const drawn: string[] = [];
    const overlay = (scene as unknown as { overlay: OverlayState }).overlay;
    const ctx = (scene as unknown as { overlayContext: () => OverlayContext }).overlayContext();
    const buttons = buildOverlayButtons(overlay, ctx);
    drawOverlay(recordingCtx(drawn), overlay, buttons, null, 1, ctx);
    expect(drawn.join('|')).toContain('已保存 · 第 2 层');
    scene.dispose();
  });

  test('点「保存进度」把当前状态真落盘（金币刚变的也算数）', () => {
    const storage = createMemoryStorage();
    const { host } = makeHost(storage);
    const scene = new GameplayScene(host, 'milkdragon', 20260920);
    clearFloor(host, scene);
    dismissOverlays(host, scene);
    runFrames(scene, 5);
    pressKey(host, scene, 'Escape');

    scene.state.addGold(500);
    const expected = scene.state.gold;
    clickAt(host, scene, PAUSE_ROW[1][0], PAUSE_ROW[1][1]);
    // 存档面板不该被点关
    expect(scene.overlayMode).toBe('pause');

    const saved = new SaveManager(storage).getRun('milkdragon');
    expect(saved!.gold).toBe(expected);
    expect(saved!.floor).toBe(2);
    scene.dispose();
  });

  test('「放弃远征」第一次点击只切确认态，不删档；取消后按钮还原', () => {
    const storage = createMemoryStorage();
    let abandoned = 0;
    const { host } = makeHost(storage, { abandonRun: () => { abandoned += 1; } });
    const scene = new GameplayScene(host, 'milkdragon', 20260920);
    clearFloor(host, scene);
    dismissOverlays(host, scene);
    runFrames(scene, 5);
    pressKey(host, scene, 'Escape');

    clickAt(host, scene, PAUSE_ROW[4][0], PAUSE_ROW[4][1]);
    expect(abandoned).toBe(0);
    expect(scene.overlayMode).toBe('pause');
    expect(scene.overlayButtonIds).toContain('abandon-confirm');
    // 存档还在
    expect(new SaveManager(storage).getRun('milkdragon')).not.toBeNull();

    // 取消 → 回到正常面板
    clickAt(host, scene, PAUSE_CONFIRM_ROW[1][0], PAUSE_CONFIRM_ROW[1][1]);
    expect(scene.overlayButtonIds).toEqual(['resume', 'save', 'save-exit', 'settings', 'abandon']);
    expect(abandoned).toBe(0);

    // 再来一次并确认 → 才真的放弃
    clickAt(host, scene, PAUSE_ROW[4][0], PAUSE_ROW[4][1]);
    clickAt(host, scene, PAUSE_CONFIRM_ROW[0][0], PAUSE_CONFIRM_ROW[0][1]);
    expect(abandoned).toBe(1);
    scene.dispose();
  });

  test('「保存并返回大厅」走 exitToLobby，绝不作废存档', () => {
    const storage = createMemoryStorage();
    let abandoned = 0;
    let exited = 0;
    const { host } = makeHost(storage, {
      abandonRun: () => { abandoned += 1; },
      exitToLobby: () => { exited += 1; },
    });
    const scene = new GameplayScene(host, 'milkdragon', 20260920);
    clearFloor(host, scene);
    dismissOverlays(host, scene);
    runFrames(scene, 5);
    pressKey(host, scene, 'Escape');

    clickAt(host, scene, PAUSE_ROW[2][0], PAUSE_ROW[2][1]);
    expect(exited).toBe(1);
    expect(abandoned).toBe(0);
    // 这是关键：退场之后存档必须还在，否则"明天接着打"就成了空话
    const saved = new SaveManager(storage).getRun('milkdragon');
    expect(saved).not.toBeNull();
    expect(saved!.floor).toBe(2);
    scene.dispose();
  });

  test('真机路径：覆盖层里再按一次 Esc 能关掉暂停面板（走 update 轮询，不是 handleKey）', () => {
    const { host } = makeHost(createMemoryStorage());
    const scene = new GameplayScene(host, 'milkdragon', 20260920);
    runFrames(scene, 10);

    pressKey(host, scene, 'Escape');
    expect(scene.overlayMode).toBe('pause');
    // 生产环境没有任何地方调用 handleKey（只有测试在调），
    // 所以「Esc 关不掉暂停面板」这个真机 bug 必须靠这条用例守住。
    pressKey(host, scene, 'Escape');
    expect(scene.overlayMode).not.toBe('pause');

    pressKey(host, scene, 'Escape');
    expect(scene.overlayMode).toBe('pause');
    // 确认态下 Esc = 取消，而不是连面板一起关掉
    clickAt(host, scene, PAUSE_ROW[4][0], PAUSE_ROW[4][1]);
    pressKey(host, scene, 'Escape');
    expect(scene.overlayMode).toBe('pause');
    expect(scene.overlayButtonIds).toEqual([
      'resume',
      'save',
      'save-exit',
      'settings',
      'abandon',
    ]);
    scene.dispose();
  });
});

// ------------------------------------------------------------------ 记录型 ctx

const recordedTexts: string[] = [];

function recordingCtx(sink: string[] = recordedTexts): CanvasRenderingContext2D {
  const store: Record<string, unknown> = {
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
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
