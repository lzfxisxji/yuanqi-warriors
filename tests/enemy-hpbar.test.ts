/**
 * 敌人血条（需求 23）渲染回归。
 *
 * 用户要求「小怪和精英怪出现血条」。血条画在 `drawEnemy` 末尾，
 * 这里用记录型 ctx 抓 `fillRect` 的 (fillStyle, 坐标/尺寸) 来确认：
 *   - 活着的小怪头顶有一根红条（#ff5140），且位于敌人上方；
 *   - 精英怪是金色条（#ffce4d），比小怪更粗；
 *   - 满血也照画（常驻），死亡 / 出场动画期间不画。
 */
import { describe, expect, test } from 'vitest';
import { Enemy } from '../src/entities/enemy';
import { getEnemyDef } from '../src/data/enemies';
import { drawEnemy } from '../src/render/art';

interface FillCall {
  style: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const fills: FillCall[] = [];

/** 记录型 ctx：把每次 fillRect 连同当时的 fillStyle 记下来，其余绘制一律空转。 */
function recordingCtx(): CanvasRenderingContext2D {
  const store: Record<string, unknown> = {
    canvas: { width: 1280, height: 720 },
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    createPattern: () => null,
    measureText: (t: string) => ({ width: String(t).length * 8 }),
    setLineDash: () => undefined,
    getLineDash: () => [],
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
  };
  return new Proxy(store, {
    get(target, key) {
      if (typeof key === 'symbol') return undefined;
      const k = key as string;
      if (k === 'fillRect') {
        return (x: number, y: number, w: number, h: number) => {
          fills.push({ style: String(target.fillStyle), x, y, w, h });
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
}

/** 造一个已经"出场完毕"的敌人，可选血量比例。 */
function makeEnemy(id: string, hpRatio = 1): Enemy {
  const e = new Enemy(getEnemyDef(id), 100, 100, 1);
  e.spawnTimer = 0;
  e.hp = e.maxHp * hpRatio;
  return e;
}

const NORMAL_BAR = '#ff5140';
const ELITE_BAR = '#ffce4d';

describe('敌人血条（需求 23）', () => {
  test('小怪头顶画出红色血条，且位于敌人上方', () => {
    fills.length = 0;
    const e = makeEnemy('grub', 0.5);
    drawEnemy(recordingCtx(), e, 0);
    const bars = fills.filter((f) => f.style === NORMAL_BAR);
    expect(bars.length).toBe(1);
    expect(bars[0]!.y).toBeLessThan(e.y);
    // 半血 → 填充宽度约为全长的一半
    expect(bars[0]!.w).toBeGreaterThan(0);
    expect(bars[0]!.w).toBeLessThan(Math.max(24, e.radius * 2.1) + 0.001);
  });

  test('精英怪是金色血条，且比小怪更粗', () => {
    fills.length = 0;
    drawEnemy(recordingCtx(), makeEnemy('gazer', 0.5), 0);
    const eliteBars = fills.filter((f) => f.style === ELITE_BAR);
    expect(eliteBars.length).toBe(1);
    expect(fills.filter((f) => f.style === NORMAL_BAR).length).toBe(0);
    const eliteH = eliteBars[0]!.h;

    fills.length = 0;
    drawEnemy(recordingCtx(), makeEnemy('grub', 0.5), 0);
    const normalBar = fills.find((f) => f.style === NORMAL_BAR)!;
    expect(eliteH).toBeGreaterThan(normalBar.h);
  });

  test('满血也照画（血条常驻，不使用「受伤才出现」的规则）', () => {
    fills.length = 0;
    const e = makeEnemy('grub', 1);
    drawEnemy(recordingCtx(), e, 0);
    const bars = fills.filter((f) => f.style === NORMAL_BAR);
    expect(bars.length).toBe(1);
    expect(bars[0]!.w).toBeCloseTo(Math.max(24, e.radius * 2.1), 5);
  });

  test('死亡 / 出场动画期间不画血条', () => {
    fills.length = 0;
    const dead = makeEnemy('grub', 0);
    dead.dead = true;
    drawEnemy(recordingCtx(), dead, 0);
    expect(fills.some((f) => f.style === NORMAL_BAR)).toBe(false);

    fills.length = 0;
    const spawning = makeEnemy('grub', 1);
    spawning.spawnTimer = 0.4;
    drawEnemy(recordingCtx(), spawning, 0);
    expect(fills.some((f) => f.style === NORMAL_BAR)).toBe(false);
  });
});
