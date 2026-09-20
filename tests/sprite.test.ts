/**
 * 立绘（sprite）与矢量角色的**视觉尺寸一致性**回归测试。
 *
 * 背景：噜噜 / 肥嘟袋鼠 / 奶龙 / 牛来 用的是 `public/characters/*.png` 位图立绘，
 * 狼影 / 蜂针 用的是 `art.ts` 里的矢量小人。
 * 如果两套渲染在屏幕上的**目视高度**不一致，换了角色就会像"换了游戏"。
 *
 * 这里把两个口径的常量都拉进来做数值断言 —— 一旦有人调了 `PLAYER_SPRITE_H`
 * 或改了矢量角色的比例而忘了同步，这个测试会立刻红。
 *
 * 矢量角色的墨迹范围（读 `art.ts`，r = PLAYER_RADIUS）：
 *   顶饰最高点 = headY - r*0.85，其中 headY = -r*0.62  →  -1.47r
 *   脚底（影子中心）                                        →  0.78r
 * 立绘的绘制范围（读 `drawPlayer` 的立绘分支）：
 *   脚底 y = 0.82r，顶端 y = 0.82r - PLAYER_SPRITE_H
 */
import { describe, expect, test } from 'vitest';
import { PLAYER_RADIUS, PLAYER_SPRITE_H } from '../src/data/config';
import { CHARACTERS, getCharacter } from '../src/data/characters';

/**
 * 四个位图立绘的**实际像素宽高比**（读 `public/characters/*.png` 量出来的）。
 *
 * ⚠️ 改了 `tools/cutout.mjs` 的 box 就要回来同步这里的数字 —— box 一变，
 *    输出的宽度就跟着变（奶龙修左臂时 200 → 236）。
 *    实际尺寸看 `.cutout-log.txt`（每次抠图都会打印 `-> characters/xx.png WxH`）。
 *
 * 为什么不直接在测试里读 PNG：读图要用 node 内置模块，而本项目没装 `@types/node`
 * （`tsconfig` 的 include 含 tests，`tsc --noEmit` 会直接报 TS2307）。
 * 为了一个宽高比断言去动依赖 + lockfile + CI 不划算，所以沿用硬编码表。
 */
const SPRITE_ASPECTS: Record<string, number> = {
  lulu: 233 / 320,
  fatkangaroo: 193 / 320,
  milkdragon: 236 / 320,
  niulai: 229 / 320,
};

/** 矢量角色的目视高度（px）。 */
function vectorVisualHeight(): number {
  const r = PLAYER_RADIUS;
  const top = -1.47 * r; // 顶饰
  const bottom = 0.78 * r; // 脚底
  return bottom - top;
}

describe('立绘与矢量角色的目视尺寸一致', () => {
  test('PLAYER_SPRITE_H 与矢量角色高度差在 3px 以内', () => {
    const vec = vectorVisualHeight();
    const diff = Math.abs(PLAYER_SPRITE_H - vec);
    expect(diff).toBeLessThanOrEqual(3);
  });

  test('立绘的顶点和脚底大致对齐矢量角色', () => {
    const r = PLAYER_RADIUS;
    const spriteFoot = r * 0.82;
    const spriteTop = spriteFoot - PLAYER_SPRITE_H;
    // 脚底：影子中心在 r*0.78，立绘允许略微下沉，但别超过 2px
    expect(Math.abs(spriteFoot - r * 0.78)).toBeLessThanOrEqual(2);
    // 顶点：不能比矢量角色高出 4px 以上（不然立绘显得"浮"在画面里）
    const vecTop = -1.47 * r;
    expect(spriteTop - vecTop).toBeLessThanOrEqual(4);
    expect(spriteTop - vecTop).toBeGreaterThanOrEqual(-4);
  });
});

describe('新增角色的立绘登记', () => {
  test('噜噜 / 肥嘟袋鼠 / 奶龙 / 牛来 都配了 sprite slug 且默认解锁', () => {
    const lulu = getCharacter('lulu');
    const roo = getCharacter('fatkangaroo');
    const milk = getCharacter('milkdragon');
    const niu = getCharacter('niulai');
    expect(lulu.sprite).toBe('lulu');
    expect(roo.sprite).toBe('fatkangaroo');
    expect(milk.sprite).toBe('milkdragon');
    expect(niu.sprite).toBe('niulai');
    for (const c of [lulu, roo, milk, niu]) expect(c.unlock.kind).toBe('default');
  });

  test('每个配了 sprite 的角色，其 slug 唯一', () => {
    const slugs = CHARACTERS.map((c) => c.sprite).filter((s): s is string => Boolean(s));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('原有矢量角色没有 sprite（继续走矢量渲染，不受位图影响）', () => {
    for (const id of ['wolfshade', 'sting']) {
      expect(getCharacter(id).sprite).toBeUndefined();
    }
    // 已取消的角色「磐垒」不得复活（它的 id 若重新出现，这条会红）
    expect(CHARACTERS.some((c) => c.id === 'bulwark')).toBe(false);
  });

  /**
   * 立绘宽度是按图片宽高比推出来的，所以不同角色的**横向占地**天然不同。
   * 这里断言四个位图角色都落在合理区间：
   * 太窄（<0.4）会像一根杆，太宽（>1.0）会糊成一片，
   * 而它们的高度都统一是 `PLAYER_SPRITE_H`，所以"游戏内大小差不多"这条需求靠它守住。
   *
   * 注：这里只管"横向占地是否合理 / 四个是否彼此接近"。
   *   「有没有被 box 裁掉一块」是像素级的，测试看不到 ——
   *   那由 `tools/cutout.mjs` 每次生成时的**边缘自检**负责（奶龙左臂事故的回归守卫）。
   */
  test('四个位图角色的宽高比都在合理区间（高度统一 → 视觉大小一致）', () => {
    for (const [slug, aspect] of Object.entries(SPRITE_ASPECTS)) {
      expect(aspect, `${slug} 宽高比 ${aspect.toFixed(3)} 过窄`).toBeGreaterThan(0.4);
      expect(aspect, `${slug} 宽高比 ${aspect.toFixed(3)} 过宽`).toBeLessThan(1.0);
      expect(getCharacter(slug).sprite).toBe(slug);
    }
    // 四个位图角色里最宽/最窄的横向占地之差不能太离谱（否则有一个会明显"胖出一圈"）
    const values = Object.values(SPRITE_ASPECTS);
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(1.5);
  });
});
