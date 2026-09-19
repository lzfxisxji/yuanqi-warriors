/**
 * 战前补给站（preboss）面板的**渲染层**回归测试。
 *
 * 为什么需要它：`tests/smoke.test.ts` 里那条补给站用例是**点坐标**验证的
 * （`clickAt(host, scene, 640, 236)`），而坐标点击无论面板画没画都会命中按钮 ——
 * 所以「面板一片空白、只有标题」这种 bug 会被它完全放过（用户实际遇到了）。
 *
 * 这里直接把 `drawOverlay` 跑一遍，用记录型 ctx 抓出真的画了哪些文字，
 * 断言四行商品 + 「进入首领房」按钮确实被绘制。
 */
import { describe, expect, test } from 'vitest';
import {
  buildOverlayButtons,
  createOverlayState,
  drawOverlay,
  type OverlayContext,
  type ShopItem,
} from '../src/ui/overlays';

// ------------------------------------------------------------------ 记录型 ctx

const texts: string[] = [];

function recordingCtx(): CanvasRenderingContext2D {
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
        return (text: unknown) => texts.push(String(text));
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

// ------------------------------------------------------------------ 脚手架

const PREP_ITEMS: ShopItem[] = [
  { kind: 'healHalf', price: 60, label: '战地急救', desc: '立即回复一半生命（约 58 点）', sold: false },
  { kind: 'magPlus', price: 75, label: '弹匣扩容', desc: '本轮永久提升弹匣容量，并立刻把弹匣装满', sold: false },
  { kind: 'ammo', price: 40, label: '弹药补给', desc: '两把武器立刻装满弹药', sold: false },
  { kind: 'shield', price: 55, label: '护盾电池', desc: '护盾回满，并永久提升 15 点护盾上限', sold: false },
];

function ctxOf(gold = 277): OverlayContext {
  return {
    gold,
    hp: 100,
    maxHp: 116,
    shield: 0,
    maxShield: 70,
    weaponName: '突击步枪',
    ammo: 30,
    magSize: 30,
    upgrades: [],
    floor: 1,
    roomName: '',
    playerName: '',
    isMultiplayer: false,
  } as unknown as OverlayContext;
}

/** 渲染一次 preboss 面板，返回画出来的所有文字。 */
function renderPreboss(items: readonly ShopItem[] = PREP_ITEMS, gold = 277): string[] {
  const overlay = createOverlayState();
  overlay.prepItems = [...items];
  overlay.mode = 'preboss';
  const ctx = ctxOf(gold);
  const buttons = buildOverlayButtons(overlay, ctx);
  texts.length = 0;
  drawOverlay(recordingCtx(), overlay, buttons, null, 1, ctx);
  return [...texts];
}

// ------------------------------------------------------------------ 测试

describe('战前补给站面板渲染', () => {
  test('标题、副标题、金币都会画出来', () => {
    const t = renderPreboss();
    expect(t).toContain('战前补给站');
    expect(t.join('|')).toContain('深渊之心就在门后');
    expect(t.join('|')).toContain('金币 277');
  });

  test('四行商品全部绘制（标签 + 描述 + 价格）', () => {
    const t = renderPreboss();
    const joined = t.join('|');
    for (const item of PREP_ITEMS) {
      expect(joined).toContain(item.label);
      expect(joined).toContain(item.desc);
      expect(joined).toContain(String(item.price));
    }
    // 四条「行」确实各自画了（不是只画了第一行）
    expect(t.filter((s) => s === '战地急救')).toHaveLength(1);
    expect(t.filter((s) => s === '弹匣扩容')).toHaveLength(1);
    expect(t.filter((s) => s === '弹药补给')).toHaveLength(1);
    expect(t.filter((s) => s === '护盾电池')).toHaveLength(1);
  });

  test('「进入首领房」按钮必须画出来（不能只剩面板没有出口）', () => {
    const t = renderPreboss();
    expect(t).toContain('进入首领房');
    expect(t.join('|')).toContain('房门会立刻封闭');
  });

  test('「再准备一下」按钮也必须画出来 —— 玩家要有"不开打"的出口', () => {
    const t = renderPreboss();
    expect(t).toContain('再准备一下');
  });

  test('金币不足时价格与按钮仍然绘制（只是置灰）', () => {
    const t = renderPreboss(PREP_ITEMS, 0);
    const joined = t.join('|');
    for (const item of PREP_ITEMS) expect(joined).toContain(item.label);
    expect(t).toContain('进入首领房');
    expect(t).toContain('再准备一下');
  });

  test('商品按钮 id 用 prep:<数字>，而 prep:start / prep:leave 是独立按钮', () => {
    const overlay = createOverlayState();
    overlay.prepItems = [...PREP_ITEMS];
    overlay.mode = 'preboss';
    const buttons = buildOverlayButtons(overlay, ctxOf());
    const ids = buttons.map((b) => b.id);
    // 四行商品
    expect(ids.filter((id) => /^prep:\d+$/.test(id))).toHaveLength(4);
    // 两个出口按钮
    expect(ids).toContain('prep:start');
    expect(ids).toContain('prep:leave');
    // 关键：出口按钮绝不能被误当成商品行（这就是原来面板空白的根因）
    expect(ids.filter((id) => /^prep:\d+$/.test(id))).not.toContain('prep:start');
    expect(ids.filter((id) => /^prep:\d+$/.test(id))).not.toContain('prep:leave');
    // 两个出口按钮不能重叠（否则点击区会互相吃掉）
    const start = buttons.find((b) => b.id === 'prep:start')!;
    const leave = buttons.find((b) => b.id === 'prep:leave')!;
    const overlap = start.x < leave.x + leave.w && leave.x < start.x + start.w;
    expect(overlap).toBe(false);
  });
});
