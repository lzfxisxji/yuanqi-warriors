/**
 * 主菜单右侧面板 + 图鉴的回归测试。
 *
 * 需求：
 *   1. 主菜单右侧展示**当前已创建 / 已加入的房间**（房间号 + 模式 + 成员），
 *      面板是**半高卡片**，空状态下只保留占位提示，下半部分的说明文字不再出现。
 *   2. 图鉴增加**角色图鉴**分页（与武器/敌人共用「左列表 + 右详情」）。
 *
 * 这里用假 ctx 记录所有 fillText 调用，断言：
 *   - 空状态：显示占位提示，旧的发现进度文案与下半部分说明彻底消失
 *   - 房间内：房间号画在面板区域内（水平居中）、模式/人数/成员/空位齐全
 *   - 面板内任何文字都不能越出半高面板的下边界
 *   - 主菜单按钮区不会侵入右侧面板（面板只展示、不注册点击区）
 *   - 房间号徽标只在主菜单之外的页面出现（避免与面板重复）
 *   - 角色图鉴分页：五个角色、数值、技能、解锁条件
 */
import { describe, expect, test } from 'vitest';
import {
  buildMenuButtons,
  createMenuState,
  drawMenu,
  type MenuData,
  type MenuState,
} from '../src/ui/screens';
import { CHARACTERS } from '../src/data/characters';
import type { GameProgress, GameSettings } from '../src/systems/save';

// ------------------------------------------------------------------ 脚手架

interface DrawnText {
  text: string;
  x: number;
  y: number;
}

function recordingCtx(): { ctx: CanvasRenderingContext2D; texts: DrawnText[] } {
  const texts: DrawnText[] = [];
  const store: Record<string, unknown> = {
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    createPattern: () => null,
    measureText: (t: string) => ({ width: [...String(t)].length * 8 }),
    setLineDash: () => undefined,
    getLineDash: () => [],
  };
  const ctx = new Proxy(store, {
    get(target, key) {
      const k = key as string;
      if (k === 'fillText') {
        return (text: unknown, x: number, y: number) => {
          texts.push({ text: String(text), x, y });
        };
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
  return { ctx, texts };
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

function menuData(): MenuData {
  return { progress: PROGRESS, settings: SETTINGS, discoveredWeapons: [], unlockedCharacters: [] };
}

/** 渲染一帧主菜单（或指定页面），返回所有被绘制的文字。 */
function render(state: MenuState): DrawnText[] {
  const { ctx, texts } = recordingCtx();
  drawMenu(ctx, state, buildMenuButtons(state), null, 0.5, menuData());
  return texts;
}

function toRoom(state: MenuState, mode: 'coop' | 'pk' = 'coop'): void {
  state.lobby.phase = 'room';
  state.lobby.isHost = true;
  state.lobby.code = 'AB12';
  state.lobby.mode = mode;
  state.lobby.members = [
    { name: 'winner', color: '#5cc8ff', isHost: true, charId: 'wolfshade' },
    { name: '队友', color: '#ff7ae0', isHost: false, charId: 'sting' },
  ];
}

/** 半高卡片：原 572 高整栏被否掉，两种状态共用同一尺寸（见 screens.ts 的 ROOM_PANEL）。 */
const PANEL = { x: 640, y: 108, w: 560, h: 286 };

/** 面板内绘制的文字必须落在这个纵向区间里。 */
function panelTexts(texts: DrawnText[]): DrawnText[] {
  return texts.filter((t) => t.x >= PANEL.x - 40);
}

// ------------------------------------------------------------------ 用例

describe('主菜单右侧面板', () => {
  test('未建房：只保留占位提示，下半部分说明文字已移除', () => {
    const texts = render(createMenuState());
    const joined = texts.map((t) => t.text).join('|');
    expect(joined).toContain('当前房间');
    expect(joined).toContain('尚未创建或加入房间');
    // 旧的「已发现内容」面板必须彻底移除
    expect(joined).not.toContain('已发现内容');
    expect(joined).not.toContain('已解锁');
    expect(joined).not.toContain('在地牢里拾取或购买武器后');
    // 面板下半部分的三段说明按需求去掉
    expect(joined).not.toContain('进入「联机模式」创建房间');
    expect(joined).not.toContain('房主开始远征后');
    expect(joined).not.toContain('房间号由服务器随机分配');
  });

  test('面板保持半高：面板内所有文字都落在 108..394 之间', () => {
    const empty = render(createMenuState());
    const state = createMenuState();
    toRoom(state);
    const room = render(state);
    for (const texts of [empty, room]) {
      const inside = panelTexts(texts);
      expect(inside.length).toBeGreaterThan(0);
      for (const t of inside) {
        expect(t.y).toBeGreaterThan(PANEL.y);
        expect(t.y).toBeLessThan(PANEL.y + PANEL.h);
      }
    }
  });

  test('房间内：房间号画在面板内且水平居中', () => {
    const state = createMenuState();
    toRoom(state);
    const texts = render(state);

    // 房间号用等宽大字逐字绘制（drawSpacedText）
    const codeChars = ['A', 'B', '1', '2'].map((ch) =>
      texts.filter((t) => t.text === ch && t.y > PANEL.y && t.y < PANEL.y + PANEL.h),
    );
    for (const hits of codeChars) {
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) {
        expect(hit.x).toBeGreaterThan(PANEL.x);
        expect(hit.x).toBeLessThan(PANEL.x + PANEL.w);
      }
    }
    const xs = codeChars.map((hits) => hits[0]!.x);
    // 依次从左到右
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    // 整体在面板中轴附近（面板 640..1200 → 中心 920）
    const center = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(Math.abs(center - (PANEL.x + PANEL.w / 2))).toBeLessThan(12);
  });

  test('房间内：模式 / 人数 / 成员 / 空位齐全', () => {
    const state = createMenuState();
    toRoom(state);
    const joined = render(state)
      .map((t) => t.text)
      .join('|');
    expect(joined).toContain('合作闯关 · 友伤关闭');
    expect(joined).toContain('2 / 4 人');
    expect(joined).toContain('winner');
    expect(joined).toContain('队友');
    expect(joined).toContain('房主');
    // 两名成员之后是两个空位
    expect(joined).toContain('空位 3');
    expect(joined).toContain('空位 4');
    expect(joined).not.toContain('空位 5');
  });

  test('房间内：PK 模式文案不同', () => {
    const state = createMenuState();
    toRoom(state, 'pk');
    const joined = render(state)
      .map((t) => t.text)
      .join('|');
    expect(joined).toContain('自由混战 · 最后存活者胜');
    expect(joined).not.toContain('合作闯关');
  });

  test('主菜单按钮全部落在左侧按钮列，不侵入右侧面板', () => {
    const idle = buildMenuButtons(createMenuState());
    const state = createMenuState();
    toRoom(state);
    const inRoom = buildMenuButtons(state);
    for (const b of [...idle, ...inRoom]) {
      expect(b.x + b.w).toBeLessThanOrEqual(PANEL.x);
    }
    // 房间内「联机模式」按钮改叫「返回房间」，点了只是回大厅（不掉线）
    const multi = inRoom.find((b) => b.id === 'multi');
    expect(multi?.label).toBe('返回房间');
    expect(idle.find((b) => b.id === 'multi')?.label).toBe('联机模式');
  });

  test('房间号徽标只在主菜单之外出现（不与右侧面板重复）', () => {
    const main = createMenuState();
    toRoom(main);
    const mainTexts = render(main).map((t) => t.text);
    // 主菜单用大字逐字画，不存在整串 'AB12'
    expect(mainTexts).not.toContain('AB12');

    const codex = createMenuState();
    toRoom(codex);
    codex.mode = 'codex';
    const codexTexts = render(codex).map((t) => t.text);
    expect(codexTexts).toContain('AB12');
  });
});

describe('图鉴分页', () => {
  function codexState(tab: MenuState['codexTab'], index = 0): MenuState {
    const state = createMenuState();
    state.mode = 'codex';
    state.codexTab = tab;
    state.codexIndex = index;
    return state;
  }

  test('新增「角色图鉴」分页：七个角色都列出，且同时只有一个分页高亮', () => {
    expect(CHARACTERS).toHaveLength(7);
    const state = codexState('character');
    const joined = render(state)
      .map((t) => t.text)
      .join('|');
    for (const c of CHARACTERS) expect(joined).toContain(c.name);

    const tabs = buildMenuButtons(state).filter((b) => b.id.startsWith('codex-tab-'));
    expect(tabs.map((b) => b.label)).toEqual(['武器图鉴', '敌人图鉴', '角色图鉴']);
    expect(tabs.filter((b) => b.style === 'accent')).toHaveLength(1);
    expect(tabs.find((b) => b.id === 'codex-tab-character')?.style).toBe('accent');
  });

  test('角色图鉴详情：数值 / 技能 / 解锁条件', () => {
    // 蜂针：需要抵达第 2 层，而 PROGRESS.bestFloor = 1 → 未解锁
    const joined = render(codexState('character', 1))
      .map((t) => t.text)
      .join('|');
    for (const label of ['生命上限', '护盾上限', '移动速度', '基础闪避', '初始武器', '技能冷却']) {
      expect(joined).toContain(label);
    }
    expect(joined).toContain('技能 · 超载引擎');
    expect(joined).toContain('解锁条件：抵达第 2 层');
  });

  test('武器 / 敌人分页不受影响', () => {
    const weapon = codexState('weapon');
    const weaponTabs = buildMenuButtons(weapon).filter((b) => b.id.startsWith('codex-tab-'));
    expect(weaponTabs.find((b) => b.id === 'codex-tab-weapon')?.style).toBe('accent');
    const weaponText = render(weapon).map((t) => t.text).join('|');
    // discoveredWeapons 为空 → 武器名还是 ？？？
    expect(weaponText).toContain('尚未发现');
    expect(weaponText).not.toContain('技能 · 影袭翻滚');

    const enemy = codexState('enemy');
    const enemyJoined = render(enemy).map((t) => t.text).join('|');
    expect(enemyJoined).not.toContain('技能 · 影袭翻滚');
    expect(enemyJoined).toContain('生命');
  });

  test('新增角色噜噜的图鉴详情：初始解锁 + 专属技能', () => {
    const idx = CHARACTERS.findIndex((c) => c.id === 'lulu');
    expect(idx).toBeGreaterThanOrEqual(0);
    const joined = render(codexState('character', idx))
      .map((t) => t.text)
      .join('|');
    expect(joined).toContain('噜噜');
    expect(joined).toContain('技能 · 橘皮滚滚');
    // 「直接解锁」→ 详情里显示「已解锁」，不出现解锁条件提示
    expect(joined).toContain('已解锁');
    expect(joined).not.toContain('解锁条件');
  });

  test('新增角色肥嘟袋鼠的图鉴详情', () => {
    const idx = CHARACTERS.findIndex((c) => c.id === 'fatkangaroo');
    expect(idx).toBeGreaterThanOrEqual(0);
    const joined = render(codexState('character', idx))
      .map((t) => t.text)
      .join('|');
    expect(joined).toContain('肥嘟袋鼠');
    expect(joined).toContain('技能 · 重拳突进');
  });

  test('新增角色奶龙的图鉴详情：初始解锁 + 专属技能', () => {
    const idx = CHARACTERS.findIndex((c) => c.id === 'milkdragon');
    expect(idx).toBeGreaterThanOrEqual(0);
    const joined = render(codexState('character', idx))
      .map((t) => t.text)
      .join('|');
    expect(joined).toContain('奶龙');
    expect(joined).toContain('技能 · 奶泡护体');
    // 「直接解锁」→ 详情里显示「已解锁」，不出现解锁条件提示
    expect(joined).toContain('已解锁');
    expect(joined).not.toContain('解锁条件');
  });

  test('新增角色牛来的图鉴详情：初始解锁 + 专属技能', () => {
    const idx = CHARACTERS.findIndex((c) => c.id === 'niulai');
    expect(idx).toBeGreaterThanOrEqual(0);
    const joined = render(codexState('character', idx))
      .map((t) => t.text)
      .join('|');
    expect(joined).toContain('牛来');
    expect(joined).toContain('技能 · 蛮牛冲撞');
    expect(joined).toContain('已解锁');
    expect(joined).not.toContain('解锁条件');
  });

  test('角色选择：7 张卡不越界，且都留在画面内', () => {
    const state = createMenuState();
    state.mode = 'charselect';
    const cards = buildMenuButtons(state).filter((b) => b.id.startsWith('char:'));
    expect(cards).toHaveLength(CHARACTERS.length);
    for (const c of cards) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(1280);
    }
    // 卡片之间不能重叠（角色变多后最容易出的问题就是压在一起）
    for (let i = 1; i < cards.length; i++) {
      expect(cards[i]!.x).toBeGreaterThanOrEqual(cards[i - 1]!.x + cards[i - 1]!.w);
    }
    // 卡片被压窄后，卡内还有能力条/武器图标要放 —— 留出可读宽度
    // （7 人时实测 cardW=164，所以下限卡在 160）
    for (const c of cards) expect(c.w).toBeGreaterThanOrEqual(160);
    // 所有卡等高（高度是"游戏内角色大小一致"之外的 UI 约束，防止改漏一个）
    const heights = new Set(cards.map((c) => c.h));
    expect(heights.size).toBe(1);
  });

  /**
   * 7 个角色时卡宽会被压到 164px。这里断言**卡内文字不会被画到卡片外**
   * （记录型 ctx 拿得到每个 fillText 的 x 坐标），
   * 因为"卡片按钮不越界"并不代表"卡里画的东西也不越界"。
   *
   * ⚠️ 所有卡的 y 区间完全相同，所以**不能按 y 去找"这张文字属于哪张卡"**
   * （那样每条都会匹配到第 0 张，编号靠后的卡一律误报溢出）。
   * 必须按 **x 落点**判定：文字起点落在哪张卡的横向范围内，就归它管。
   */
  test('角色选择：卡内文字不超出各自的卡片范围', () => {
    const state = createMenuState();
    state.mode = 'charselect';
    const cards = buildMenuButtons(state).filter((b) => b.id.startsWith('char:'));
    const texts = render(state);
    let checked = 0;
    for (const t of texts) {
      if (!t.text) continue;
      // 按 x 找归属卡（卡片互不重叠，所以最多命中一张）
      const card = cards.find((c) => t.x >= c.x && t.x < c.x + c.w);
      if (!card) continue;
      // 只统计卡内区域（纵向）的文字，避开底部「进入地牢」等按钮
      if (t.y < card.y || t.y > card.y + card.h) continue;
      checked++;
      expect(t.x).toBeGreaterThanOrEqual(card.x);
      expect(t.x).toBeLessThanOrEqual(card.x + card.w - 8);
    }
    // 确认真的检查到了东西（避免断言空转）：
    // 每张卡至少画出 名字/称号/3 个能力条标签/技能/描述/初始武器 等 8+ 条文字
    expect(checked).toBeGreaterThan(CHARACTERS.length * 8);
  });
});
