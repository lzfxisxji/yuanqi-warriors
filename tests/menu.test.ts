/**
 * 主菜单右侧面板 + 图鉴的回归测试。
 *
 * 需求：
 *   1. 主菜单右侧展示**当前已创建 / 已加入的房间**（房间号 + 模式 + 成员），
 *      面板是**半高卡片**，空状态下只保留占位提示，下半部分的说明文字不再出现。
 *   2. 图鉴增加**角色图鉴**分页（与武器/敌人共用「左列表 + 右详情」）。
 *   3. 图鉴增加**Boss 图鉴**分页（需求 18）：每层 Boss 一条，详情给称号 /
 *      战斗数值 / 四个技能名，且 Boss 条目不参与角色的解锁判定。
 *   4. 新增**存档管理**页（需求 20）：每名角色一行（有档的给「继续 / 删除」），
 *      删除走模态二次确认 —— 未确认时页面上其余按钮全部失效，点不出误删。
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
  CODEX_PAGE_SIZE,
  buildMenuButtons,
  createMenuState,
  drawMenu,
  type CodexTab,
  type MenuData,
  type MenuState,
  type SaveSlotInfo,
} from '../src/ui/screens';
import { WEAPONS } from '../src/data/weapons';
import { CHARACTERS } from '../src/data/characters';
import { BOSSES } from '../src/data/bosses';
import { hitTest } from '../src/ui/widgets';
import type { GameProgress, GameSettings } from '../src/systems/save';

// ------------------------------------------------------------------ 脚手架

interface DrawnText {
  text: string;
  x: number;
  y: number;
}

/** 一次 measureText 调用：文本 + 调用当时的 font + 返回的宽度。 */
interface MeasuredText {
  text: string;
  font: string;
  width: number;
}

function recordingCtx(): { ctx: CanvasRenderingContext2D; texts: DrawnText[]; measured: MeasuredText[] } {
  const texts: DrawnText[] = [];
  const measured: MeasuredText[] = [];
  const store: Record<string, unknown> = {
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    createPattern: () => null,
    // 宽度只用「字符数 × 8」估算，**故意与 font 无关** —— 这样坐标断言不会因为
    // 换字体而漂移。但会把调用当时的 font 记下来，供「量宽度时用错了字号」这类
    // 断言使用（那种 bug 靠坐标是抓不到的，见 Boss 图鉴的称号用例）。
    measureText: (t: string) => {
      const width = [...String(t)].length * 8;
      measured.push({ text: String(t), font: String(store.font ?? ''), width });
      return { width };
    },
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
  return { ctx, texts, measured };
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

function menuData(saves: SaveSlotInfo[] = []): MenuData {
  return { progress: PROGRESS, settings: SETTINGS, discoveredWeapons: [], unlockedCharacters: [], saves };
}

/** 造一条存档列表项（需求 20）。 */
function slot(characterId: string, floor: number, savedAt = 0): SaveSlotInfo {
  return { characterId, floor, timeSec: 0, score: 0, savedAt };
}

/** 渲染一帧主菜单（或指定页面），返回所有被绘制的文字。 */
function render(state: MenuState, saves: SaveSlotInfo[] = []): DrawnText[] {
  const { ctx, texts } = recordingCtx();
  drawMenu(ctx, state, buildMenuButtons(state, saves), null, 0.5, menuData(saves));
  return texts;
}

/** 同上，但把 measureText 的调用明细也带出来（要断言「用对字体量宽度」时用）。 */
function renderAll(
  state: MenuState,
  saves: SaveSlotInfo[] = [],
): { texts: DrawnText[]; measured: MeasuredText[] } {
  const { ctx, texts, measured } = recordingCtx();
  drawMenu(ctx, state, buildMenuButtons(state, saves), null, 0.5, menuData(saves));
  return { texts, measured };
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

/** 面板内绘制的文字必须落在这个矩形区间里（排除右上角房间号芯片）。 */
function panelTexts(texts: DrawnText[]): DrawnText[] {
  return texts.filter(
    (t) => t.x >= PANEL.x - 40 && t.y >= PANEL.y && t.y < PANEL.y + PANEL.h,
  );
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

  test('房间号在菜单页右上角与子页面都常驻显示', () => {
    // 需求：房主建房后，菜单页（主菜单）右上角也要显示「当前房间」房间号，
    // 与右侧面板形成双重可见，不再只在子页面出现。
    for (const mode of ['main', 'codex', 'settings', 'saves', 'charselect'] as const) {
      const st = createMenuState();
      toRoom(st);
      st.mode = mode;
      const texts = render(st).map((t) => t.text);
      expect(texts).toContain('AB12');
    }

    // 联机大厅（multi）本身居中大号显示房间号（非右上角徽标），同样包含房间号
    const multi = createMenuState();
    toRoom(multi);
    multi.mode = 'multi';
    expect(render(multi).map((t) => t.text)).toContain('AB12');
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

  test('新增「角色图鉴」分页：六个角色都列出，且同时只有一个分页高亮', () => {
    expect(CHARACTERS).toHaveLength(6);
    const state = codexState('character');
    const joined = render(state)
      .map((t) => t.text)
      .join('|');
    for (const c of CHARACTERS) expect(joined).toContain(c.name);

    const tabs = buildMenuButtons(state).filter((b) => b.id.startsWith('codex-tab-'));
    expect(tabs.map((b) => b.label)).toEqual(['武器图鉴', '敌人图鉴', '角色图鉴', 'Boss图鉴']);
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

  // ---------------------------------------------------------- 需求 18：Boss 图鉴
  test('新增「Boss图鉴」分页：每层 Boss 都列出，且同时只有一个分页高亮', () => {
    const state = codexState('boss');
    const joined = render(state)
      .map((t) => t.text)
      .join('|');
    for (const b of BOSSES) {
      expect(joined).toContain(b.name);
      expect(joined).toContain(b.title);
    }

    const tabs = buildMenuButtons(state).filter((b) => b.id.startsWith('codex-tab-'));
    expect(tabs.map((b) => b.label)).toEqual(['武器图鉴', '敌人图鉴', '角色图鉴', 'Boss图鉴']);
    expect(tabs.filter((b) => b.style === 'accent')).toHaveLength(1);
    expect(tabs.find((b) => b.id === 'codex-tab-boss')?.style).toBe('accent');
  });

  test('Boss 图鉴详情：称号 / 战斗数值 / 四个技能名都在', () => {
    const idx = BOSSES.findIndex((b) => b.id === 'doubao');
    expect(idx).toBeGreaterThanOrEqual(0);
    const def = BOSSES[idx]!;
    const joined = render(codexState('boss', idx))
      .map((t) => t.text)
      .join('|');

    expect(joined).toContain(def.name);
    expect(joined).toContain(def.title);
    expect(joined).toContain(def.desc);
    for (const label of ['生命', '接触伤害', '阶段数', '终极技', '召唤伙伴', '所在层']) {
      expect(joined).toContain(label);
    }
    for (const n of def.skillNames) expect(joined).toContain(n);
  });

  /**
   * 加 Boss 分页前，左列表的 `unlocked` 是 `!isWeapon && !isEnemy` 算的 ——
   * 直接加第四页的话，BossDef 会被当成 CharacterDef 送进 isCharacterUnlocked。
   * 这里锁死 Boss 页绝不出现角色专属文案。
   */
  test('Boss 图鉴不会被当成角色：不出现解锁条件等角色专属文案', () => {
    const joined = render(codexState('boss', 0))
      .map((t) => t.text)
      .join('|');
    expect(joined).not.toContain('未解锁');
    expect(joined).not.toContain('解锁条件');
    expect(joined).not.toContain('尚未发现');
    expect(joined).not.toContain('技能 · '); // 角色详情的技能标题格式
    expect(joined).toContain('技能 / 攻击方式');
  });

  test('Boss 图鉴分页按钮：不越界、互不重叠、且不侵入右侧详情面板', () => {
    const tabs = buildMenuButtons(codexState('boss')).filter((b) => b.id.startsWith('codex-tab-'));
    expect(tabs).toHaveLength(4);
    for (const t of tabs) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x + t.w).toBeLessThanOrEqual(1280);
      // 右详情面板从 y=160 起，四个分页按钮必须整个落在它上方
      expect(t.y + t.h).toBeLessThanOrEqual(160);
    }
    for (let i = 1; i < tabs.length; i++) {
      expect(tabs[i]!.x).toBeGreaterThanOrEqual(tabs[i - 1]!.x + tabs[i - 1]!.w);
    }
  });

  test('Boss 图鉴：称号必须用「标题字号」量过名字宽度后才落笔（否则会压字）', () => {
    const idx = BOSSES.findIndex((b) => b.id === 'doubao');
    const def = BOSSES[idx]!;
    const { texts, measured } = renderAll(codexState('boss', idx));

    // 信息：名字是 26px 标题字体画的，称号是 15px。若拿 15px 去量名字宽度，
    // 量出来只有一半，称号就会直接盖在名字上（真机截图里出现过）。
    const nameMeasure = measured.filter((m) => m.text === def.name);
    expect(nameMeasure.length).toBeGreaterThan(0);
    expect(nameMeasure.some((m) => m.font.includes('26px'))).toBe(true);

    const name = texts.find((t) => t.text === def.name);
    const title = texts.find((t) => t.text === def.title);
    expect(name).toBeDefined();
    expect(title).toBeDefined();
    expect(title!.x).toBeGreaterThanOrEqual(name!.x + nameMeasure[0]!.width);
  });

  test('切到 Boss 分页：左列表条目数等于 Boss 数（不是角色数）', () => {
    const bossItems = buildMenuButtons(codexState('boss')).filter((b) => /^codex:\d+$/.test(b.id));
    expect(bossItems).toHaveLength(BOSSES.length);
    const charItems = buildMenuButtons(codexState('character')).filter((b) => /^codex:\d+$/.test(b.id));
    expect(charItems).toHaveLength(CHARACTERS.length);
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

  test('角色选择：6 张卡不越界，且都留在画面内', () => {
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
    // （6 人时实测 cardW=194，所以下限卡在 160 留足余量）
    for (const c of cards) expect(c.w).toBeGreaterThanOrEqual(160);
    // 所有卡等高（高度是"游戏内角色大小一致"之外的 UI 约束，防止改漏一个）
    const heights = new Set(cards.map((c) => c.h));
    expect(heights.size).toBe(1);
  });

  /**
   * 6 个角色时卡宽 194px。这里断言**卡内文字不会被画到卡片外**
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

describe('主菜单：续玩入口（需求16-2）', () => {
  test('有未完成远征时首行拆成「继续远征 / 新的远征」', () => {
    const buttons = buildMenuButtons(createMenuState(), [slot('wolfshade', 3)]);
    const resume = buttons.find((b) => b.id === 'resume-run');
    expect(resume).toBeDefined();
    expect(resume!.label).toBe('继续远征 · 第 3 层');
    const start = buttons.find((b) => b.id === 'start');
    expect(start!.label).toBe('新的远征');
    // 续玩按钮落在左侧按钮列，不侵入右侧面板
    expect(resume!.x + resume!.w).toBeLessThanOrEqual(PANEL.x);
  });

  test('无远征存档时只有「开始远征」', () => {
    const buttons = buildMenuButtons(createMenuState());
    expect(buttons.find((b) => b.id === 'resume-run')).toBeUndefined();
    expect(buttons.find((b) => b.id === 'start')!.label).toBe('开始远征');
  });

  test('多份存档时「继续远征」取列表首项（= 最近落盘的那份）', () => {
    // 传进来的顺序就是 save.ts listRuns() 的顺序：新的在前
    const buttons = buildMenuButtons(createMenuState(), [slot('milkdragon', 2, 200), slot('lulu', 1, 100)]);
    expect(buttons.find((b) => b.id === 'resume-run')!.label).toBe('继续远征 · 第 2 层');
  });
});

describe('联机大厅：模式卡说明文字不溢出（需求16-3）', () => {
  function lobbyState(mode: 'coop' | 'pk'): MenuState {
    const state = createMenuState();
    state.mode = 'multi';
    state.lobby.phase = 'idle';
    state.lobby.mode = mode;
    return state;
  }

  test('合作卡说明文字水平居中在卡片内', () => {
    const texts = render(lobbyState('coop'));
    const desc = '共享同一份地牢，敌人一起打，无友伤';
    const lines = texts.filter((t) => desc.includes(t.text) && t.text.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    // 合作卡：x=270 w=360 → 中心 450。说明文字以中心点为锚，不应溢出到卡片左边界外
    for (const l of lines) {
      expect(l.x).toBeCloseTo(450, 0);
      expect(l.x).toBeGreaterThanOrEqual(270);
    }
  });

  test('混战卡说明文字水平居中在卡片内', () => {
    const texts = render(lobbyState('pk'));
    const desc = '互相可伤害，最后存活者胜，阵亡后可观战';
    const lines = texts.filter((t) => desc.includes(t.text) && t.text.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    // 混战卡：x=650 w=360 → 中心 830
    for (const l of lines) {
      expect(l.x).toBeCloseTo(830, 0);
      expect(l.x).toBeGreaterThanOrEqual(650);
    }
  });
});

// ------------------------------------------------------------------ 需求 20

describe('存档管理页（需求 20）', () => {
  function savesState(): MenuState {
    const state = createMenuState();
    state.mode = 'saves';
    state.previous = 'main';
    return state;
  }

  /** 两份档：奶龙第 2 层、噜噜第 1 层（顺序 = listRuns() 的「新的在前」）。 */
  const SAVES = [slot('milkdragon', 2, 200), slot('lulu', 1, 100)];

  test('每名角色一行；有档的行给「继续 / 删除」，没档的行一个按钮都不给', () => {
    const buttons = buildMenuButtons(savesState(), SAVES);
    // 行的顺序跟 CHARACTERS 走（列表里角色顺序是固定的），不是跟存档新旧走
    const withSave = CHARACTERS.filter((c) => SAVES.some((s) => s.characterId === c.id));
    expect(withSave.length).toBe(2);
    expect(buttons.filter((b) => b.id.startsWith('save-continue:')).map((b) => b.id)).toEqual(
      withSave.map((c) => `save-continue:${c.id}`),
    );
    expect(buttons.filter((b) => b.id.startsWith('save-delete:')).map((b) => b.id)).toEqual(
      withSave.map((c) => `save-delete:${c.id}`),
    );
    // 没有存档的角色一个按钮都没有（避免点到不存在的槽位）
    for (const c of CHARACTERS) {
      if (SAVES.some((s) => s.characterId === c.id)) continue;
      expect(buttons.find((b) => b.id === `save-continue:${c.id}`)).toBeUndefined();
      expect(buttons.find((b) => b.id === `save-delete:${c.id}`)).toBeUndefined();
    }
  });

  test('六名角色全部列出（含「暂无存档」的），有档的显示楼层/用时/得分/存档时间', () => {
    const joined = render(savesState(), SAVES)
      .map((t) => t.text)
      .join('|');
    for (const c of CHARACTERS) expect(joined).toContain(c.name);
    expect(joined).toContain('第 2 层 · 用时 0:00 · 得分 0 · 存档于');
    expect(joined).toContain('暂无存档');
    expect(joined).toContain('开始远征后自动保存');
  });

  test('行内按钮不越界，且同行不重叠、相邻行不叠罗汉', () => {
    const buttons = buildMenuButtons(savesState(), SAVES);
    const cont = buttons.filter((b) => b.id.startsWith('save-continue:'));
    const del = buttons.filter((b) => b.id.startsWith('save-delete:'));
    expect(cont).toHaveLength(2);
    for (let i = 0; i < cont.length; i++) {
      const c = cont[i]!;
      const d = del[i]!;
      for (const b of [c, d]) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(1280);
        expect(b.y + b.h).toBeLessThanOrEqual(720);
      }
      // 同行：继续在左、删除在右，不重叠
      expect(c.x + c.w).toBeLessThanOrEqual(d.x);
      // 跨行：两条同位置按钮纵向不重叠
      if (i > 0) expect(cont[i - 1]!.y + cont[i - 1]!.h).toBeLessThanOrEqual(c.y);
    }
  });

  test('未确认时不弹出任何对话框', () => {
    const joined = render(savesState(), SAVES)
      .map((t) => t.text)
      .join('|');
    expect(joined).not.toContain('删除后无法恢复。');
    expect(buildMenuButtons(savesState(), SAVES).find((b) => b.id === 'confirm-yes')).toBeUndefined();
  });

  test('点「删除」只挂起确认，不会直接落盘（模态：其余按钮全部失效）', () => {
    const state = savesState();
    state.confirm = { kind: 'delete-run', characterId: 'milkdragon' };
    const buttons = buildMenuButtons(state, SAVES);

    // 唯一可点的只剩弹窗那两个 —— 这是「删除必须确认」的结构性保证
    expect(buttons.filter((b) => b.enabled !== false).map((b) => b.id)).toEqual(['confirm-yes', 'confirm-no']);

    // 拿未弹窗时的「删除」坐标去点，什么也命中不到（不会误删）
    const delBtn = buildMenuButtons(savesState(), SAVES).find((b) => b.id === 'save-delete:milkdragon')!;
    expect(hitTest(buttons, delBtn.x + delBtn.w / 2, delBtn.y + delBtn.h / 2)).toBeNull();
    // 但弹窗自己的按钮是能命中的（避免上面那条断言空转）
    const yes = buttons.find((b) => b.id === 'confirm-yes')!;
    expect(hitTest(buttons, yes.x + yes.w / 2, yes.y + yes.h / 2)?.id).toBe('confirm-yes');
  });

  test('删除确认弹窗写明是哪名角色、当前进度与不可恢复', () => {
    const state = savesState();
    state.confirm = { kind: 'delete-run', characterId: 'milkdragon' };
    const joined = render(state, SAVES)
      .map((t) => t.text)
      .join('|');
    expect(joined).toContain('删除存档');
    expect(joined).toContain('确定要删除「奶龙」的存档吗？');
    expect(joined).toContain('当前进度：第 2 层');
    expect(joined).toContain('删除后无法恢复。');
    expect(joined).toContain('取消');
  });

  test('清空全部：文案带上真实份数，并说明不影响设置与统计', () => {
    const state = savesState();
    state.confirm = { kind: 'reset-all' };
    const joined = render(state, SAVES)
      .map((t) => t.text)
      .join('|');
    expect(joined).toContain('清空全部存档');
    expect(joined).toContain('确定要清空全部 2 份存档吗？');
    expect(joined).toContain('设置、已解锁角色与历史统计不受影响。');
    expect(buildMenuButtons(state, SAVES).find((b) => b.id === 'confirm-yes')!.label).toBe('确认清空');
  });

  test('主菜单「存档管理」按钮带份数角标；无存档时清空按钮禁用', () => {
    const withSaves = buildMenuButtons(createMenuState(), SAVES).find((b) => b.id === 'saves')!;
    expect(withSaves.label).toBe('存档管理 · 2');
    const empty = buildMenuButtons(createMenuState()).find((b) => b.id === 'saves')!;
    expect(empty.label).toBe('存档管理');
    expect(buildMenuButtons(savesState()).find((b) => b.id === 'clear-all-runs')!.enabled).toBe(false);
    expect(buildMenuButtons(savesState(), SAVES).find((b) => b.id === 'clear-all-runs')!.enabled).toBe(true);
  });
});

// ------------------------------------------------------------------ 图鉴分页（需求 21）

/**
 * 需求 21 往武器表里加了 4 把近战武器，条目数 8 → 12。
 *
 * 图鉴左列表原本是按 `160 + i * 58` 一路铺下去的：第 8 行（y=566..616）正好卡在
 * 底部「返回大厅」按钮（y=644）上方，所以** 8 条以内是设计好的**；12 条时会压到返回按钮、
 * 第 12 行（y=798）直接跑出 720 高的画面。因此加了 CODEX_PAGE_SIZE = 8 的分页。
 *
 * 这一组用例锁死：每页行数、行落在安全区间、翻页按钮的可用状态、以及翻页后
 * **只注册本页可点的行**（否则会出现"点到了看不见的行"）。
 */
describe('图鉴分页', () => {
  /** 底部「返回大厅」按钮的上边界。任何列表行都不能越过它。 */
  const BACK_BTN_Y = 644;

  function codexState(tab: CodexTab, page = 0): MenuState {
    const st = createMenuState();
    st.mode = 'codex';
    st.codexTab = tab;
    st.codexIndex = 0;
    st.codexPage = page;
    return st;
  }

  test('武器 12 条 → 分 2 页，第一页注册 8 行且全部落在返回按钮上方', () => {
    expect(WEAPONS.length).toBeGreaterThan(CODEX_PAGE_SIZE);
    const btns = buildMenuButtons(codexState('weapon'), []);
    const rows = btns.filter((b) => b.id.startsWith('codex:'));
    expect(rows.length).toBe(CODEX_PAGE_SIZE);
    expect(rows.map((b) => b.id)).toEqual(
      Array.from({ length: CODEX_PAGE_SIZE }, (_, i) => `codex:${i}`),
    );
    for (const r of rows) {
      expect(r.y + r.h).toBeLessThanOrEqual(BACK_BTN_Y);
      expect(r.y + r.h).toBeLessThanOrEqual(720);
    }
    // 行序号必须连续下排（不能被分页打乱成两段）
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.y - rows[i - 1]!.y).toBe(58);
    }
  });

  test('第二页只注册剩下的行，且位置回到第一页的行区间（不会跑到画面外）', () => {
    const st = codexState('weapon', 1);
    const rows = buildMenuButtons(st, []).filter((b) => b.id.startsWith('codex:'));
    expect(rows.map((b) => b.id)).toEqual(
      Array.from({ length: WEAPONS.length - CODEX_PAGE_SIZE }, (_, i) => `codex:${CODEX_PAGE_SIZE + i}`),
    );
    // 第二页第一行必须回到 y=160（和第一页首行同一位置），而不是继续往下堆
    expect(rows[0]!.y).toBe(160);
    for (const r of rows) expect(r.y + r.h).toBeLessThanOrEqual(BACK_BTN_Y);
  });

  test('翻页按钮：第一页「上一页」禁用、「下一页」可用；第二页反之', () => {
    const p0 = buildMenuButtons(codexState('weapon', 0), []);
    expect(p0.find((b) => b.id === 'codex-page-prev')!.enabled).toBe(false);
    expect(p0.find((b) => b.id === 'codex-page-next')!.enabled).toBe(true);

    const p1 = buildMenuButtons(codexState('weapon', 1), []);
    expect(p1.find((b) => b.id === 'codex-page-prev')!.enabled).toBe(true);
    expect(p1.find((b) => b.id === 'codex-page-next')!.enabled).toBe(false);
  });

  test('单页分页（敌人 8 条 / 角色 7 条 / Boss 3 条）不出现翻页按钮', () => {
    for (const tab of ['enemy', 'character', 'boss'] as const) {
      const ids = buildMenuButtons(codexState(tab), []).map((b) => b.id);
      expect(ids).not.toContain('codex-page-prev');
      expect(ids).not.toContain('codex-page-next');
    }
  });

  test('越界页码被夹回合法范围（不靠调用方保证）', () => {
    const over = buildMenuButtons(codexState('weapon', 99), []).filter((b) => b.id.startsWith('codex:'));
    // 99 页不存在 → 夹到最后一页（第 2 页），于是注册的是最后 4 条
    expect(over.length).toBe(WEAPONS.length - CODEX_PAGE_SIZE);
    expect(over[0]!.id).toBe(`codex:${CODEX_PAGE_SIZE}`);

    const under = buildMenuButtons(codexState('weapon', -5), []).filter((b) => b.id.startsWith('codex:'));
    expect(under[0]!.id).toBe('codex:0');
  });

  test('翻页指示文案真的被画出来（不是只注册了按钮）', () => {
    const joined = render(codexState('weapon', 0))
      .map((t) => t.text)
      .join('|');
    expect(joined).toContain(`第 1 / 2 页 · 共 ${WEAPONS.length} 条`);

    const joined2 = render(codexState('weapon', 1))
      .map((t) => t.text)
      .join('|');
    expect(joined2).toContain(`第 2 / 2 页 · 共 ${WEAPONS.length} 条`);
  });

  test('翻页后翻页按钮自己可点（hitTest 命中它们）', () => {
    const st = codexState('weapon', 0);
    const btns = buildMenuButtons(st, []);
    const next = btns.find((b) => b.id === 'codex-page-next')!;
    expect(hitTest(btns, next.x + next.w / 2, next.y + next.h / 2)?.id).toBe('codex-page-next');
    const prev = btns.find((b) => b.id === 'codex-page-prev')!;
    // 禁用的按钮必须点不到（否则会在第 1 页"往前翻"）
    expect(hitTest(btns, prev.x + prev.w / 2, prev.y + prev.h / 2)).toBe(null);
  });

  test('武器副标题显示的是中文形态名，内部 kind 字符串不会漏进界面', () => {
    // 需求 21 加了 kind: 'melee' 之后，kindLabel() 少一个 case 就会把 "melee" 直接
    // 印在图鉴列表副标题上（"层级 1 · melee"）—— 这类漏网只能靠"渲染出来看看"抓到。
    const st = codexState('weapon', 1);
    const { ctx, texts } = recordingCtx();
    const data: MenuData = { ...menuData(), discoveredWeapons: WEAPONS.map((w) => w.id) };
    drawMenu(ctx, st, buildMenuButtons(st, []), null, 0.5, data);
    const joined = texts.map((t) => t.text).join('|');
    for (const raw of ['melee', 'bullet', 'beam', 'flame', 'grenade']) {
      expect(joined).not.toContain(raw);
    }
    // 四把近战都在第二页，副标题必须是中文「近战」
    expect(joined).toContain('近战');
  });
});
