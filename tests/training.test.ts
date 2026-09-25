/**
 * 需求 29 回归：① 牛来技能「蛮牛冲撞」真的能造成伤害与击退；
 * ② 新增训练营模式（任意角色 / 任意武器 + 无限生命且无法移动的木桩）。
 *
 * 背景（真机 bug / 空头支票）：
 *   - 「蛮牛冲撞」的技能描述写着「撞到的敌人受到 42 点伤害并被击退」，
 *     但 `Player.useSkill()` 的 dash 分支只设了 `dashTimer / 方向 / iframe`，
 *     **全仓库没有任何"冲刺命中敌人"的判定** —— 撞上去一点反馈都没有。
 *     这里把 `SkillDef.damage / knockback` + `GameplayScene.updateDashDamage()`
 *     这条链路整个钉死。
 *   - 训练营的木桩不是普通敌人：它必须**打不死**（伤害照算、血量恒满）、
 *     **推不动**（连击退都不吃）、**不还手**（接触伤害为 0），
 *     而且整局**不落盘**（不能占掉玩家真正的远征存档）。
 *
 * 这一组用例刻意分成四层：数据 → 实体 → 场景 → UI（菜单页 / 暂停面板），
 * 因为这类需求的漏法恰恰是"数据改了但没人读"或"UI 加了但点不动"。
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { EventBus } from '../src/core/eventbus';
import { Input } from '../src/core/input';
import {
  DASH_HIT_PAD,
  PLAYER_RADIUS,
  ROOM_H,
  ROOM_W,
  TRAINING_DUMMY_ID,
  TRAINING_DUMMY_OFFSET_Y,
  TRAINING_SEED,
  VIEW_H,
  VIEW_W,
} from '../src/data/config';
import { CHARACTERS, getCharacter } from '../src/data/characters';
import { ENEMIES, TRAINING_ENEMIES, getEnemyDef } from '../src/data/enemies';
import { Enemy } from '../src/entities/enemy';
import type { Player } from '../src/entities/player';
import { WEAPONS, getWeaponDef } from '../src/data/weapons';
import { WorldRenderer } from '../src/render/renderer';
import { GameplayScene, type GameHost } from '../src/scenes/gameplay';
import { AudioSystem } from '../src/systems/audio';
import {
  SaveManager,
  createMemoryStorage,
  type GameProgress,
  type GameSettings,
} from '../src/systems/save';
import { buildOverlayButtons, createOverlayState, type OverlayContext } from '../src/ui/overlays';
import { buildMenuButtons, createMenuState, drawMenu, type MenuData, type MenuState } from '../src/ui/screens';
import type { CheckInState, Wallet } from '../src/systems/save';
import { hitTest } from '../src/ui/widgets';

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

/**
 * 记录整帧文字的 canvas：预置 `fillText` 就能把渲染出的文案收集起来，
 * 其余绘图接口仍走 `makeCtx` 的全量替身（不必再抄一份）。
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

function makeHost(sink?: string[]): GameHost {
  const canvas = sink ? makeRecordingCanvas(sink) : makeCanvas().canvas;
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

/** 起一局训练营（走与 main.ts `startTraining()` 完全相同的构造参数）。 */
function makeTrainingScene(
  characterId: string,
  weaponId: string,
  sink?: string[],
): { host: GameHost; scene: GameplayScene } {
  const host = makeHost(sink);
  const scene = new GameplayScene(host, characterId, TRAINING_SEED, undefined, null, { weaponId });
  return { host, scene };
}

function runFrames(scene: GameplayScene, frames: number): void {
  for (let i = 0; i < frames; i++) {
    scene.update(1 / 60);
    scene.render();
  }
}

function playerOf(scene: GameplayScene): Player {
  return scene.state.player;
}

/** 把玩家摆到木桩正左侧、面朝 +X（冲刺方向）。 */
function aimAtDummy(scene: GameplayScene): void {
  const p = playerOf(scene);
  const dummy = scene.trainingDummy!;
  p.x = dummy.x - 40;
  p.y = dummy.y;
  p.moving = false;
  p.aimAngle = 0;
  p.vx = 0;
  p.vy = 0;
}

/** 一个只满足"不会崩"的 EnemyWorld 替身（immobile 分支根本用不到它）。 */
function stubWorld(): Parameters<Enemy['update']>[1] {
  const noop = new Proxy({} as Record<string, unknown>, {
    get: (t, k) => {
      const key = k as string;
      if (!(key in t)) t[key] = () => undefined;
      return t[key];
    },
  });
  return {
    players: [],
    focusAt: () => null,
    room: {} as never,
    ctx: { particles: noop, bus: noop, shake: noop, numbers: noop, flash: noop, time: noop, audio: noop },
    rng: { range: () => 0, chance: () => false } as never,
    floor: 1,
    spawnProjectile: () => undefined,
    spawnMinion: () => undefined,
    enemies: [],
  } as unknown as Parameters<Enemy['update']>[1];
}

// ================================================================== 数据层

describe('数据 · 冲刺技能的伤害 / 击退（需求 29-1）', () => {
  test('牛来「蛮牛冲撞」：描述里承诺的 42 点伤害与击退都真的写在定义里', () => {
    const niulai = getCharacter('niulai');
    expect(niulai.skill.kind).toBe('dash');
    expect(niulai.skill.damage).toBe(42);
    expect(niulai.skill.knockback).toBeGreaterThan(0);
    // 描述与数值必须一致 —— 这条断言就是"描述别再好高骛远"的保险丝
    expect(niulai.skill.desc).toContain('42 点伤害');
    expect(niulai.skill.desc).toContain('击退');
  });

  test('肥嘟袋鼠「重拳突进」：只击退、不造成伤害', () => {
    const kangaroo = getCharacter('fatkangaroo');
    expect(kangaroo.skill.kind).toBe('dash');
    expect(kangaroo.skill.knockback).toBeGreaterThan(0);
    expect(kangaroo.skill.damage ?? 0).toBe(0);
  });

  test('狼影「影袭翻滚」：闪避技，既不伤害也不击退', () => {
    const wolfshade = getCharacter('wolfshade');
    expect(wolfshade.skill.kind).toBe('dash');
    expect(wolfshade.skill.invulnerable).toBe(true);
    // 1.6 秒冷却 + 全程无敌已经很强，再加输出会让别的角色失去存在意义
    expect(wolfshade.skill.damage ?? 0).toBe(0);
    expect(wolfshade.skill.knockback ?? 0).toBe(0);
  });

  test('伤害/击退是可选的：不填的冲刺不会被当成 0 伤害输出技', () => {
    const withDamage = CHARACTERS.filter((c) => (c.skill.damage ?? 0) > 0);
    // 目前只有牛来一个冲刺带伤害（有意识地保持稀缺）
    expect(withDamage.map((c) => c.id)).toEqual(['niulai']);
  });
});

describe('数据 · 训练营木桩（需求 29-2）', () => {
  test('木桩单独成表：不进普通波次、不进图鉴', () => {
    expect(TRAINING_ENEMIES.map((e) => e.id)).toContain(TRAINING_DUMMY_ID);
    expect(TRAINING_ENEMIES).toHaveLength(1);
    // 关键：混进 ENEMIES 会被 pickNormalId 抽进普通房间，还会污染敌人图鉴
    expect(ENEMIES.some((e) => e.id === TRAINING_DUMMY_ID)).toBe(false);
  });

  test('getEnemyDef 能解析木桩，且三个开关都开着', () => {
    const def = getEnemyDef(TRAINING_DUMMY_ID);
    expect(def.id).toBe(TRAINING_DUMMY_ID);
    expect(def.name).toBe('训练木桩');
    expect(def.infiniteHp).toBe(true);
    expect(def.immobile).toBe(true);
    expect(def.shape).toBe('dummy');
    // 不掉钱、不计分、不还手 —— 否则训练营会变成刷金币 / 刷分的后门
    expect(def.contactDamage).toBe(0);
    expect(def.gold).toEqual([0, 0]);
    expect(def.score).toBe(0);
  });
});

// ================================================================== 实体层

describe('实体 · 木桩打不死也推不动', () => {
  const HIT = { crit: false, source: 'dash' as const, dirX: 1, dirY: 0, knockback: 560 };

  test('无限生命：伤害照算（伤害数字/命中反馈正常），但血量恒满、永不死亡', () => {
    const d = new Enemy(getEnemyDef(TRAINING_DUMMY_ID), 100, 100, 1);
    const hp0 = d.hp;
    for (let i = 0; i < 5; i++) {
      const r = d.applyDamage(9999, HIT);
      expect(r.applied).toBe(9999);
      expect(r.killed).toBe(false);
    }
    expect(d.hp).toBe(hp0);
    expect(d.dead).toBe(false);
    // 统计仍然累加（训练营也要能看到"我打了多少伤害"）
    expect(d.damageTaken).toBe(9999 * 5);
  });

  test('无法移动：击退速度恒为 0，位置纹丝不动', () => {
    const d = new Enemy(getEnemyDef(TRAINING_DUMMY_ID), 100, 100, 1);
    d.applyDamage(42, HIT);
    expect(d.knockVx).toBe(0);
    expect(d.knockVy).toBe(0);
    const x0 = d.x;
    const y0 = d.y;
    const world = stubWorld();
    for (let i = 0; i < 30; i++) d.update(1 / 60, world);
    expect(d.x).toBe(x0);
    expect(d.y).toBe(y0);
    expect(d.moveVel.x).toBe(0);
    expect(d.moveVel.y).toBe(0);
  });

  test('普通妖怪吃得下同样的击退（说明上面那条不是空转的断言）', () => {
    const grub = new Enemy(getEnemyDef('grub'), 100, 100, 1);
    // 10 点伤害：保证打不死（grub 第 1 层只有三十几点血），只看血掉了、人被推了
    grub.applyDamage(10, { ...HIT, knockback: 560 });
    // grub 的 knockbackResist = 0.1 → 560 × 0.9
    expect(grub.knockVx).toBeGreaterThan(0);
    expect(grub.hp).toBe(grub.maxHp - 10);
    expect(grub.dead).toBe(false);
  });

  test('燃烧也烧不死木桩', () => {
    const d = new Enemy(getEnemyDef(TRAINING_DUMMY_ID), 100, 100, 1);
    const hp0 = d.hp;
    d.applyBurn(200, 3);
    const world = stubWorld();
    for (let i = 0; i < 120; i++) d.update(1 / 60, world);
    expect(d.hp).toBe(hp0);
    expect(d.dead).toBe(false);
  });
});

// ================================================================== 场景层

describe('场景 · 冲刺撞击结算', () => {
  test('牛来冲撞木桩：恰好结算一次 42 点（不是每帧一次）', () => {
    const { scene } = makeTrainingScene('niulai', 'pulse_pistol');
    const dummy = scene.trainingDummy!;
    aimAtDummy(scene);

    const p = playerOf(scene);
    expect(p.useSkill()).toBe(true);
    expect(p.dashTimer).toBeGreaterThan(0);

    // 冲刺持续 0.36s ≈ 22 帧，跑满它
    runFrames(scene, 40);
    expect(dummy.damageTaken).toBe(42);

    // 冲刺已结束，再跑一段也不该继续掉伤害
    runFrames(scene, 60);
    expect(dummy.damageTaken).toBe(42);
  });

  test('狼影翻滚撞到木桩：零伤害、零击退（纯位移技）', () => {
    const { scene } = makeTrainingScene('wolfshade', 'pulse_pistol');
    const dummy = scene.trainingDummy!;
    aimAtDummy(scene);
    expect(playerOf(scene).useSkill()).toBe(true);
    runFrames(scene, 60);
    expect(dummy.damageTaken).toBe(0);
  });

  test('肥嘟袋鼠重拳突进：撞上去不掉血（只推人）', () => {
    const { scene } = makeTrainingScene('fatkangaroo', 'pulse_pistol');
    const dummy = scene.trainingDummy!;
    aimAtDummy(scene);
    expect(playerOf(scene).useSkill()).toBe(true);
    runFrames(scene, 60);
    expect(dummy.damageTaken).toBe(0);
  });

  test('同一次冲刺对同一个目标只结算一次；下一次冲刺可以再结算', () => {
    const { scene } = makeTrainingScene('niulai', 'pulse_pistol');
    const dummy = scene.trainingDummy!;
    const p = playerOf(scene);

    aimAtDummy(scene);
    p.useSkill();
    runFrames(scene, 40);
    expect(dummy.damageTaken).toBe(42);

    // 等冷却（7.5s）—— 期间把视角重新对准木桩
    runFrames(scene, 60 * 8);
    aimAtDummy(scene);
    expect(p.useSkill()).toBe(true);
    runFrames(scene, 40);
    expect(dummy.damageTaken).toBe(84);
  });

  test('冲刺命中判定半径 = 玩家半径 + DASH_HIT_PAD（不是靠"擦到就算")', () => {
    const { scene } = makeTrainingScene('niulai', 'pulse_pistol');
    const dummy = scene.trainingDummy!;
    const p = playerOf(scene);
    // 放到刚好够不着的位置：再往外挪 1px 就打不到了
    const reach = PLAYER_RADIUS + DASH_HIT_PAD + dummy.radius;
    p.x = dummy.x - reach - 30;
    p.y = dummy.y;
    p.moving = false;
    p.aimAngle = 0;
    // 往 +X 冲，一帧位移 ≈ 1020/60 ≈ 17px，30px 外冲不进判定圈 → 不结算
    p.useSkill();
    scene.update(1 / 60);
    expect(dummy.damageTaken).toBe(0);
  });
});

describe('场景 · 训练营房间', () => {
  test('构造后就有一根木桩，位置在房间中线上方', () => {
    const { scene } = makeTrainingScene('niulai', 'assault_rifle');
    expect(scene.isTraining).toBe(true);
    const dummy = scene.trainingDummy;
    expect(dummy).not.toBeNull();
    expect(dummy!.x).toBeCloseTo(ROOM_W / 2, 6);
    expect(dummy!.y).toBeCloseTo(ROOM_H / 2 + TRAINING_DUMMY_OFFSET_Y, 6);
    expect(dummy!.def.infiniteHp).toBe(true);
    expect(dummy!.def.immobile).toBe(true);
  });

  test('房间是封闭的（门与邻居都被拿掉），而不是"锁门"', () => {
    // 锁门会挂着「消灭所有敌人」的目标，而木桩永远打不死 → 玩家被永久关在里面。
    // 所以训练营必须改房间类型 + 清空门，而不是 lockAllDoors()。
    const { scene } = makeTrainingScene('niulai', 'pulse_pistol');
    const node = scene.state.plan.nodes.get(scene.state.currentRoomKey)!;
    expect(node.type).toBe('start');
    expect(node.doors).toEqual([]);
    expect(Object.keys(node.neighbors)).toEqual([]);
    expect(node.cleared).toBe(true);
  });

  test('顶部目标提示说明这是练习场，绝不出现"消灭所有敌人"', () => {
    const sink: string[] = [];
    const { scene } = makeTrainingScene('niulai', 'pulse_pistol', sink);
    runFrames(scene, 3);
    const joined = sink.join('|');
    expect(joined).toContain('训练营');
    expect(joined).not.toContain('消灭所有敌人');
  });

  test('玩家拿的是所选武器，与角色初始武器无关（奶龙换成突击步枪）', () => {
    const { scene } = makeTrainingScene('milkdragon', 'assault_rifle');
    // 奶龙的初始武器是榴弹发射器 —— 训练营必须能把它换掉
    expect(getCharacter('milkdragon').startWeapon).not.toBe('assault_rifle');
    expect(scene.state.player.currentWeapon.def.id).toBe('assault_rifle');
    // 弹匣也按新武器重算，不会残留榴弹发射器的弹量
    const def = getWeaponDef('assault_rifle');
    expect(scene.state.player.currentWeapon.magSize).toBe(def.mag);
  });

  test('近战武器同样可选（木棍 → 无弹匣、子弹速度 0）', () => {
    const { scene } = makeTrainingScene('niulai', 'wood_stick');
    const w = scene.state.player.currentWeapon;
    expect(w.def.id).toBe('wood_stick');
    expect(w.def.kind).toBe('melee');
    expect(w.magSize).toBe(1);
  });

  test('整局不落盘：跑满自动存档周期后，存档列表仍是空的', () => {
    const { host, scene } = makeTrainingScene('niulai', 'pulse_pistol');
    // AUTOSAVE_INTERVAL = 4s，跑 5 秒足够触发至少一次自动存档
    runFrames(scene, 60 * 5);
    expect(host.save.listRuns()).toHaveLength(0);
    expect(host.save.getRun('niulai')).toBeNull();
  });

  test('训练局不进波次：房间里的敌人只有那一根木桩', () => {
    const { scene } = makeTrainingScene('niulai', 'pulse_pistol');
    runFrames(scene, 60 * 3);
    type Probe = { enemies: Enemy[] };
    const enemies = (scene as unknown as Probe).enemies;
    expect(enemies).toHaveLength(1);
    expect(enemies[0]!.def.infiniteHp).toBe(true);
  });
});

describe('场景 · 训练营伤害反馈（需求 33）', () => {
  /** 用棱镜激光长按木桩：每帧把指针摆到木桩屏幕坐标，强制 updateAim 对准。 */
  const beamDummyFor = (scene: GameplayScene, host: ReturnType<typeof makeTrainingScene>['host']) => {
    const dummy = scene.trainingDummy!;
    host.input.pointer.down = true;
    const cam = host.renderer.camera;
    for (let i = 0; i < 60; i++) {
      host.input.pointer.sx = VIEW_W / 2 + (dummy.x - cam.x);
      host.input.pointer.sy = VIEW_H / 2 + (dummy.y - cam.y);
      scene.update(1 / 60);
    }
    return dummy;
  };

  test('棱镜激光长按打木桩：既有伤害又有浮空数字', () => {
    const { host, scene } = makeTrainingScene('wolfshade', 'laser');
    const dummy = beamDummyFor(scene, host);
    // 根因回归：光束确实造成伤害（PROBE 实测 1 秒约 89 点）
    expect(dummy.damageTaken).toBeGreaterThan(0);
    // 需求 33 核心修复：伤害数字必须真的弹出来，否则训练营"看不见伤害"
    expect(scene.numbers.list.length).toBeGreaterThan(0);
  });

  test('顶部横幅实时显示累计伤害与 DPS', () => {
    const { host, scene } = makeTrainingScene('wolfshade', 'laser');
    const dummy = beamDummyFor(scene, host);
    const banner = (scene as unknown as { objectiveBanner(): { text: string; color: string } | null }).objectiveBanner();
    expect(banner).not.toBeNull();
    expect(banner!.text).toContain('训练营');
    expect(banner!.text).toContain('累计伤害');
    expect(banner!.text).toContain('DPS');
    // 横幅里的累计伤害应等于木桩实际承受值（四舍五入后）
    expect(banner!.text).toContain(String(Math.round(dummy.damageTaken)));
  });

  test('近战打木桩也弹伤害数字', () => {
    const { host, scene } = makeTrainingScene('niulai', 'wood_stick');
    const dummy = scene.trainingDummy!;
    const player = playerOf(scene);
    const cam = host.renderer.camera;
    // 近战射程短，把玩家挪到木桩边上（否则够不着 → 0 伤害）
    const wRange = player.currentWeapon.def.range;
    player.x = dummy.x - wRange * 0.6;
    player.y = dummy.y;
    // 近战是「按住蓄力、松开挥砍」：一直按住只会卡在蓄力阶段，从不下刀。
    // 所以每 10 帧做一个 按下(蓄力)→松开(挥砍) 的循环。
    for (let i = 0; i < 120; i++) {
      host.input.pointer.down = i % 10 < 5;
      host.input.pointer.sx = VIEW_W / 2 + (dummy.x - cam.x);
      host.input.pointer.sy = VIEW_H / 2 + (dummy.y - cam.y);
      scene.update(1 / 60);
    }
    expect(dummy.damageTaken).toBeGreaterThan(0);
    expect(scene.numbers.list.length).toBeGreaterThan(0);
  });
});

describe('场景 · 训练营暂停面板', () => {
  test('Esc 暂停面板只剩三个出口：继续训练 / 设置 / 返回大厅', () => {
    const { host, scene } = makeTrainingScene('niulai', 'pulse_pistol');
    runFrames(scene, 5);
    const input = host.input as unknown as { pressedThisFrame: Set<string> };
    input.pressedThisFrame.add('Escape');
    scene.update(1 / 60);
    input.pressedThisFrame.delete('Escape');

    expect(scene.overlayMode).toBe('pause');
    expect(scene.overlayButtonIds).toEqual(['resume', 'settings', 'save-exit']);
    // 训练营没有存档可存、没有远征可放弃
    expect(scene.overlayButtonIds).not.toContain('save');
    expect(scene.overlayButtonIds).not.toContain('abandon');
  });

  test('暂停面板抬头写明"训练营"，并说明不会保存进度', () => {
    // 记录型 canvas：从构造起就把整帧文字收进 sink（render() 里画的所有文案）
    const sink: string[] = [];
    const { host, scene } = makeTrainingScene('niulai', 'pulse_pistol', sink);
    runFrames(scene, 2);
    const input = host.input as unknown as { pressedThisFrame: Set<string> };
    input.pressedThisFrame.add('Escape');
    scene.update(1 / 60);
    input.pressedThisFrame.delete('Escape');
    scene.render();

    const joined = sink.join('|');
    expect(joined).toContain('训练营 · 已暂停');
    expect(joined).toContain('训练营不会保存进度，也不会记入战绩');
  });
});

// ================================================================== UI 层

describe('UI · 训练营选择页', () => {
  function trainState(char = 0, weapon = 0): MenuState {
    const st = createMenuState();
    st.mode = 'training';
    st.previous = 'main';
    st.trainingChar = char;
    st.trainingWeapon = weapon;
    return st;
  }

  const PROGRESS: GameProgress = {
    bestFloor: 1,
    wins: 0,
    runs: 0,
    bestTimeSec: 0,
    totalKills: 0,
    totalRooms: 0,
    bestScore: 0,
  };
  const SETTINGS: GameSettings = {
    masterVolume: 1,
    sfxVolume: 1,
    musicVolume: 1,
    screenShake: 1,
    showDamageNumbers: true,
    showMinimap: true,
    showSystemCursor: false,
  };
  const DATA: MenuData = {
    progress: PROGRESS,
    settings: SETTINGS,
    discoveredWeapons: [],
    unlockedCharacters: [],
    saves: [],
    wallet: { diamonds: 0, coins: 0 } as Wallet,
    checkIn: { lastDate: '', streak: 0 } as CheckInState,
  };

  function recordingCtx(): { ctx: CanvasRenderingContext2D; texts: string[] } {
    const texts: string[] = [];
    const store: Record<string, unknown> = {
      createLinearGradient: makeGradient,
      createRadialGradient: makeGradient,
      createPattern: () => null,
      measureText: (t: string) => ({ width: [...String(t)].length * 8 }),
      setLineDash: () => undefined,
      getLineDash: () => [],
      globalAlpha: 1,
      fillStyle: '#000000',
      strokeStyle: '#000000',
      lineWidth: 1,
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
    };
    const ctx = new Proxy(store, {
      get(target, key) {
        const k = key as string;
        if (k === 'fillText' || k === 'strokeText') return (t: unknown) => texts.push(String(t));
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
    return { ctx, texts };
  }

  function renderTrain(st: MenuState): string[] {
    const { ctx, texts } = recordingCtx();
    drawMenu(ctx, st, buildMenuButtons(st), null, 0.5, DATA);
    return texts;
  }

  test('主菜单：「训练营」与「联机模式」同行分列，都不侵入右侧面板', () => {
    const btns = buildMenuButtons(createMenuState(), []);
    const multi = btns.find((b) => b.id === 'multi')!;
    const train = btns.find((b) => b.id === 'training')!;
    expect(train.label).toBe('训练营');
    expect(train.y).toBe(multi.y);
    expect(train.w).toBe(multi.w);
    // 左右分列、不重叠
    expect(multi.x + multi.w).toBeLessThanOrEqual(train.x);
    // 两者都留在左侧按钮列（右侧面板从 x=640 起）
    expect(train.x + train.w).toBeLessThanOrEqual(640);
  });

  test('角色与武器全部可选：6 名角色 + 12 把武器各一张卡', () => {
    const btns = buildMenuButtons(trainState());
    const chars = btns.filter((b) => b.id.startsWith('train-char:'));
    const weapons = btns.filter((b) => b.id.startsWith('train-weapon:'));
    expect(chars).toHaveLength(CHARACTERS.length);
    expect(weapons).toHaveLength(WEAPONS.length);
    expect(chars.map((b) => b.id)).toEqual(CHARACTERS.map((_, i) => `train-char:${i}`));
    expect(weapons.map((b) => b.id)).toEqual(WEAPONS.map((_, i) => `train-weapon:${i}`));
  });

  test('页面写着"无需解锁 / 无需发现"，且不出现任何锁定文案', () => {
    const joined = renderTrain(trainState()).join('|');
    expect(joined).toContain('训练营');
    expect(joined).toContain('无限生命的木桩');
    expect(joined).toContain('无需解锁');
    expect(joined).toContain('无需发现');
    expect(joined).not.toContain('未解锁');
    expect(joined).not.toContain('解锁条件');
    // 未解锁的蜂针（需要抵达第 2 层）在训练营里也必须照常列出
    for (const c of CHARACTERS) expect(joined).toContain(c.name);
    for (const w of WEAPONS) expect(joined).toContain(w.name);
  });

  test('卡片几何：全部落在画面内、同行不重叠、不压到下方按钮', () => {
    const btns = buildMenuButtons(trainState());
    const cards = btns.filter((b) => b.id.startsWith('train-'));
    for (const c of cards) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(1280);
      expect(c.y + c.h).toBeLessThanOrEqual(720);
    }
    // 角色卡一行 6 张：从左到右依次排开、互不重叠
    const charCards = btns.filter((b) => b.id.startsWith('train-char:'));
    for (let i = 1; i < charCards.length; i++) {
      expect(charCards[i]!.x).toBeGreaterThanOrEqual(charCards[i - 1]!.x + charCards[i - 1]!.w);
    }
    // 武器前 6 张同在第一行；第 7 张折到第二行（y 更大）
    const w = btns.filter((b) => b.id.startsWith('train-weapon:'));
    expect(w[6]!.y).toBeGreaterThan(w[0]!.y);
    // 卡片最下沿不能压到「开始训练」
    const start = btns.find((b) => b.id === 'train-start')!;
    for (const c of cards) {
      if (c.y === start.y) continue;
      expect(c.y + c.h).toBeLessThanOrEqual(start.y);
    }
  });

  test('点得到：角色卡 / 武器卡 / 开始训练 / 返回大厅都能被命中', () => {
    const btns = buildMenuButtons(trainState());
    const center = (id: string) => {
      const b = btns.find((x) => x.id === id)!;
      return hitTest(btns, b.x + b.w / 2, b.y + b.h / 2)?.id;
    };
    expect(center('train-char:3')).toBe('train-char:3');
    expect(center('train-weapon:9')).toBe('train-weapon:9');
    expect(center('train-start')).toBe('train-start');
    expect(center('menu-back')).toBe('menu-back');
  });

  test('底部摘要跟着选择走（角色 + 武器 + 中文形态名）', () => {
    const st = trainState(4, 9);
    const joined = renderTrain(st).join('|');
    const cdef = CHARACTERS[4]!;
    const wdef = WEAPONS[9]!;
    expect(joined).toContain(`当前选择：${cdef.name}（${cdef.skill.name}）`);
    expect(joined).toContain(wdef.name);
    // 内部 kind 字符串不能漏进界面（如 "melee"）
    for (const raw of ['melee', 'bullet', 'beam', 'flame', 'grenade']) {
      expect(joined).not.toContain(raw);
    }
  });

  test('越界的选中索引被夹回合法范围（不靠调用方保证）', () => {
    const joined = renderTrain(trainState(99, 99)).join('|');
    expect(joined).toContain(`当前选择：${CHARACTERS[0]!.name}`);
    expect(joined).toContain(WEAPONS[0]!.name);
  });
});

describe('UI · 训练营暂停面板按钮（脱离场景直接构建）', () => {
  function pauseCtx(training: boolean): OverlayContext {
    return {
      gold: 0,
      hp: 100,
      maxHp: 100,
      floor: 1,
      floorCount: 3,
      kills: 0,
      rooms: 0,
      timeSec: 0,
      score: 0,
      settings: {
        masterVolume: 1,
        sfxVolume: 1,
        musicVolume: 1,
        screenShake: 1,
        showDamageNumbers: true,
        showMinimap: true,
        showSystemCursor: false,
      },
      characterName: '牛来',
      training,
    };
  }

  test('training=true 时是三个出口；=false 时仍是原来的五个', () => {
    const overlay = createOverlayState();
    overlay.mode = 'pause';

    const train = buildOverlayButtons(overlay, pauseCtx(true)).map((b) => b.id);
    expect(train).toEqual(['resume', 'settings', 'save-exit']);

    const normal = buildOverlayButtons(overlay, pauseCtx(false)).map((b) => b.id);
    expect(normal).toEqual(['resume', 'save', 'save-exit', 'settings', 'abandon']);
  });

  test('训练营面板三个按钮不重叠、都在画面内', () => {
    const overlay = createOverlayState();
    overlay.mode = 'pause';
    const btns = buildOverlayButtons(overlay, pauseCtx(true));
    expect(btns).toHaveLength(3);
    for (let i = 1; i < btns.length; i++) {
      expect(btns[i]!.y).toBeGreaterThanOrEqual(btns[i - 1]!.y + btns[i - 1]!.h);
    }
    for (const b of btns) {
      expect(b.x + b.w).toBeLessThanOrEqual(1280);
      expect(b.y + b.h).toBeLessThanOrEqual(720);
    }
  });
});
