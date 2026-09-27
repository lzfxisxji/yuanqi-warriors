/**
 * 锻造系统（需求 38）回归测试。
 *
 * 覆盖三层：
 *   1. 数据（`src/data/forge.ts`）纯函数：倍率 / 花费 / 等级夹取 / 存档解析。
 *   2. 注入链路：`RunState` 构造把 `forge` 注入 `player.forgeLevels`，
 *      玩家 `forgeDamageMul` 据此换算（独立层，不随捡强化 / 进层被洗掉）。
 *   3. 两个新面板（背包 / 锻造）的渲染：背包列出全武器（已拥有显名、未获得灰显「？？？」），
 *      锻造只对已拥有的武器出金币 / 钻石双按钮，且余额不足 / 满级时对应按钮禁用。
 */
import { describe, expect, test } from 'vitest';
import {
  FORGE_BONUS_PER_LEVEL,
  FORGE_MAX_LEVEL,
  forgeCost,
  forgeDamageMul,
  forgeLevel,
  parseForge,
} from '../src/data/forge';
import { CHARACTERS, DEFAULT_OWNED_WEAPONS, getCharacter } from '../src/data/characters';
import { WEAPONS } from '../src/data/weapons';
import { RunState } from '../src/systems/run';
import {
  buildMenuButtons,
  createMenuState,
  drawMenu,
  type MenuData,
  type MenuState,
} from '../src/ui/screens';
import type { CheckInState, GameProgress, GameSettings, Wallet } from '../src/systems/save';

// ================================================================== 数据层

describe('锻造数据 · 倍率', () => {
  test('0 级 = 1.0，每级 +6%，满级 12 级 = 1.72', () => {
    expect(forgeDamageMul(0)).toBeCloseTo(1.0, 6);
    expect(forgeDamageMul(1)).toBeCloseTo(1 + FORGE_BONUS_PER_LEVEL, 6);
    expect(forgeDamageMul(FORGE_MAX_LEVEL)).toBeCloseTo(1 + FORGE_MAX_LEVEL * FORGE_BONUS_PER_LEVEL, 6);
  });

  test('负数等级回落到 1.0（不出现负加成）', () => {
    expect(forgeDamageMul(-3)).toBeCloseTo(1.0, 6);
  });
});

describe('锻造数据 · 花费（金币二选一 或 钻石二选一）', () => {
  test('0 级：金币 60、钻石 3', () => {
    expect(forgeCost(0)).toEqual({ coins: 60, diamonds: 3 });
  });

  test('1 级：金币随 1.3 指数增长、钻石线性增长', () => {
    const c1 = forgeCost(1);
    expect(c1.coins).toBe(Math.round(60 * 1.3));
    expect(c1.diamonds).toBe(4);
  });

  test('花费随等级单调递增（金币指数、钻石线性）', () => {
    let prevCoins = -1;
    let prevDiamonds = -1;
    for (let lvl = 0; lvl <= FORGE_MAX_LEVEL; lvl++) {
      const c = forgeCost(lvl);
      expect(c.coins).toBeGreaterThan(prevCoins);
      expect(c.diamonds).toBeGreaterThan(prevDiamonds);
      prevCoins = c.coins;
      prevDiamonds = c.diamonds;
    }
  });

  test('满级后仍能算出「下一发」花费（供 UI 显示，不强制禁止调用）', () => {
    const c = forgeCost(FORGE_MAX_LEVEL);
    expect(c.coins).toBeGreaterThan(0);
    expect(c.diamonds).toBe(3 + FORGE_MAX_LEVEL);
  });
});

describe('锻造数据 · 等级夹取与缺省', () => {
  test('缺省 / 非数字 → 0', () => {
    expect(forgeLevel({}, 'pulse_pistol')).toBe(0);
    expect(forgeLevel({ pulse_pistol: NaN }, 'pulse_pistol')).toBe(0);
    expect(forgeLevel({ pulse_pistol: undefined as unknown as number }, 'pulse_pistol')).toBe(0);
  });

  test('超出范围夹到 0..FORGE_MAX_LEVEL', () => {
    expect(forgeLevel({ pulse_pistol: -5 }, 'pulse_pistol')).toBe(0);
    expect(forgeLevel({ pulse_pistol: 999 }, 'pulse_pistol')).toBe(FORGE_MAX_LEVEL);
    expect(forgeLevel({ pulse_pistol: 999.9 }, 'pulse_pistol')).toBe(FORGE_MAX_LEVEL);
  });
});

describe('锻造数据 · 存档解析 parseForge', () => {
  test('只保留已知武器 id，层级夹取、非数字回落 0', () => {
    const parsed = parseForge({
      pulse_pistol: 3,
      laser: 50, // 超出上限 → 夹到 12
      ghost_gun: 'oops' as unknown as number, // 非数字 → 视为 0，但因 >0 才写，故丢弃
      unknown_weapon: 5, // 未知 id → 丢弃
    });
    expect(parsed.pulse_pistol).toBe(3);
    expect(parsed.laser).toBe(FORGE_MAX_LEVEL);
    expect(parsed.ghost_gun).toBeUndefined();
    expect(parsed.unknown_weapon).toBeUndefined();
  });

  test('脏数据（数组 / 非对象 / null）回落为 {}', () => {
    expect(parseForge(null)).toEqual({});
    expect(parseForge(undefined)).toEqual({});
    expect(parseForge([1, 2, 3])).toEqual({});
    expect(parseForge('nope')).toEqual({});
  });
});

// ================================================================== 注入链路

describe('注入 · RunState → Player.forgeLevels', () => {
  test('进入远征时锻造等级被注入玩家，forgeDamageMul 据此换算', () => {
    const character = getCharacter('wolfshade');
    const forge = { pulse_pistol: 5, laser: 2 };
    const run = new RunState(character, 12345, {}, forge);

    // run 上保留独立层
    expect(run.forgeLevels).toEqual(forge);
    // 玩家拿到一份拷贝（不共享同一引用，避免局内误改影响存档对象）
    expect(run.player.forgeLevels).toEqual(forge);
    expect(run.player.forgeLevels).not.toBe(forge);

    // 玩家伤害倍率 = 1 + 5 × 0.06 = 1.30（脉冲枪）/ 1 + 2 × 0.06 = 1.12（激光）
    expect(run.player.forgeDamageMul('pulse_pistol')).toBeCloseTo(1 + 5 * FORGE_BONUS_PER_LEVEL, 6);
    expect(run.player.forgeDamageMul('laser')).toBeCloseTo(1 + 2 * FORGE_BONUS_PER_LEVEL, 6);
    // 未锻造的武器倍率为 1.0
    expect(run.player.forgeDamageMul('sniper_rifle')).toBeCloseTo(1.0, 6);
  });

  test('不给 forge 时默认空表、倍率全 1.0（不崩、不误加成）', () => {
    const run = new RunState(getCharacter('niulai'), 1);
    expect(run.forgeLevels).toEqual({});
    expect(run.player.forgeDamageMul('assault_rifle')).toBeCloseTo(1.0, 6);
  });
});

// ================================================================== UI 层

// 录制整帧文字的 canvas（与 menu.test 同款，足以驱动面板渲染）。
function recordingCtx(): { ctx: CanvasRenderingContext2D; texts: string[] } {
  const texts: string[][] = [[]];
  const store: Record<string, unknown> = {
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
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
      if (k === 'fillText' || k === 'strokeText') return (t: unknown) => texts[0]!.push(String(t));
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
  return { ctx, texts: texts[0]! };
}

const PROGRESS: GameProgress = {
  bestFloor: 1, wins: 0, runs: 0, bestTimeSec: 0, totalKills: 0, totalRooms: 0, bestScore: 0,
};
const SETTINGS: GameSettings = {
  masterVolume: 1, sfxVolume: 1, musicVolume: 1, screenShake: 1,
  showDamageNumbers: true, showMinimap: true, showSystemCursor: false,
};
const CHECKIN: CheckInState = { lastDate: '', streak: 0 };

function menuData(overrides: Partial<MenuData> = {}): MenuData {
  return {
    progress: PROGRESS,
    settings: SETTINGS,
    discoveredWeapons: [],
    unlockedCharacters: CHARACTERS.map((c) => c.id),
    saves: [],
    wallet: { diamonds: 0, coins: 0 } as Wallet,
    checkIn: CHECKIN,
    talents: {},
    talentPointsAvailable: 0,
    forge: {},
    ...overrides,
  };
}

describe('UI · 背包面板（只读武器库）', () => {
  function bagState(): MenuState {
    const st = createMenuState();
    st.mode = 'bag';
    return st;
  }

  test('列出全部 12 把武器；已拥有显真名、未获得灰显「？？？」', () => {
    // 未拾取任何武器（discoveredWeapons 为空）→ 只有起始武器算「拥有」
    const data = menuData({ discoveredWeapons: [] });
    const st = bagState();
    const { ctx, texts } = recordingCtx();
    drawMenu(ctx, st, buildMenuButtons(st, data.saves, data), null, 0.5, data);

    const joined = texts.join('|');
    const owned = new Set<string>([...data.discoveredWeapons, ...DEFAULT_OWNED_WEAPONS]);
    for (const def of WEAPONS) {
      if (owned.has(def.id)) {
        expect(joined).toContain(def.name);
      } else {
        // 未拥有的武器名不能出现在卡上（卡上印「？？？」）
        expect(joined).not.toContain(def.name);
      }
    }
    // 未拥有武器占多数时，必然出现灰显占位
    expect(joined).toContain('？？？');
    expect(joined).toContain('尚未获得');
  });

  test('拾取过的武器显名、且有「前往锻造」入口', () => {
    const data = menuData({ discoveredWeapons: WEAPONS.map((w) => w.id), forge: { laser: 3 } });
    const { ctx, texts } = recordingCtx();
    const st = bagState();
    drawMenu(ctx, st, buildMenuButtons(st, data.saves, data), null, 0.5, data);
    const joined = texts.join('|');
    // 全拥有 → 不应再有「？？？」
    expect(joined).not.toContain('？？？');
    // 锻造过 3 级的激光会显示等级与加成百分比
    expect(joined).toContain('Lv 3');
    expect(joined).toContain('伤害 +');
    // 进出锻造的入口按钮存在且可点
    const btn = buildMenuButtons(st, data.saves, data).find((b) => b.id === 'bag-to-forge');
    expect(btn).toBeDefined();
    expect(btn!.enabled).not.toBe(false);
  });
});

describe('UI · 锻造面板（金币 / 钻石二选一强化）', () => {
  function forgeState(): MenuState {
    const st = createMenuState();
    st.mode = 'forge';
    return st;
  }

  test('只对「已拥有」武器出强化按钮；余额不足时金币 / 钻石按钮禁用', () => {
    // 起始武器作为已拥有；钱包为 0 → 两个按钮都应禁用但标签照常显示花费
    const data = menuData({ wallet: { coins: 0, diamonds: 0 } });
    const st = forgeState();
    const buttons = buildMenuButtons(st, data.saves, data);
    const owned = new Set<string>([...data.discoveredWeapons, ...DEFAULT_OWNED_WEAPONS]);

    // 每个已拥有武器各生成一对 forge-coin / forge-diamond 按钮
    for (const id of owned) {
      const coin = buttons.find((b) => b.id === `forge-coin:${id}`)!;
      const diamond = buttons.find((b) => b.id === `forge-diamond:${id}`)!;
      expect(coin).toBeDefined();
      expect(diamond).toBeDefined();
      expect(coin.enabled).toBe(false); // 0 金币 < 60
      expect(diamond.enabled).toBe(false); // 0 钻石 < 3
      // 0 级花费：金币 60、钻石 3
      expect(coin.label).toBe('金币 60');
      expect(diamond.label).toBe('钻石 3');
    }

    // 未拥有的武器绝不出锻造按钮
    const notOwned = WEAPONS.map((w) => w.id).filter((id) => !owned.has(id));
    for (const id of notOwned) {
      expect(buttons.find((b) => b.id === `forge-coin:${id}`)).toBeUndefined();
      expect(buttons.find((b) => b.id === `forge-diamond:${id}`)).toBeUndefined();
    }

    // 面板渲染不崩，且把花费标签画出来（金币 60 / 钻石 3 出现在画面里）
    const { ctx, texts } = recordingCtx();
    drawMenu(ctx, st, buttons, null, 0.5, data);
    const joined = texts.join('|');
    expect(joined).toContain('金币 60');
    expect(joined).toContain('钻石 3');
    expect(joined).toContain('锻造 · 强化武器');
  });

  test('金币充足 → 金币按钮可用、钻石不足 → 钻石按钮禁用', () => {
    const data = menuData({ wallet: { coins: 99999, diamonds: 0 } });
    const st = forgeState();
    const buttons = buildMenuButtons(st, data.saves, data);
    const owned = new Set<string>([...data.discoveredWeapons, ...DEFAULT_OWNED_WEAPONS]);
    for (const id of owned) {
      expect(buttons.find((b) => b.id === `forge-coin:${id}`)!.enabled).toBe(true);
      expect(buttons.find((b) => b.id === `forge-diamond:${id}`)!.enabled).toBe(false);
    }
  });

  test('满级武器：一对按钮都禁用并标「已满级」', () => {
    // 给第一把已拥有武器满级
    const owned = [...DEFAULT_OWNED_WEAPONS];
    const maxedId = owned[0]!;
    const data = menuData({
      wallet: { coins: 99999, diamonds: 99999 },
      forge: { [maxedId]: FORGE_MAX_LEVEL },
    });
    const st = forgeState();
    const buttons = buildMenuButtons(st, data.saves, data);
    const coin = buttons.find((b) => b.id === `forge-coin:${maxedId}`)!;
    const diamond = buttons.find((b) => b.id === `forge-diamond:${maxedId}`)!;
    expect(coin.enabled).toBe(false);
    expect(diamond.enabled).toBe(false);
    expect(coin.label).toBe('已满级');
    expect(diamond.label).toBe('已满级');
    // 面板里该武器显示「满级 Lv 12/12」
    const { ctx, texts } = recordingCtx();
    drawMenu(ctx, st, buttons, null, 0.5, data);
    expect(texts.join('|')).toContain(`满级 Lv ${FORGE_MAX_LEVEL}/${FORGE_MAX_LEVEL}`);
  });
});
