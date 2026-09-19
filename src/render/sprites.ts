/**
 * 角色立绘位图缓存。
 *
 * `role/` 里的设定图经 `tools/cutout.mjs` 抠掉背景、只留正面立绘，
 * 输出到 `public/characters/<slug>.png`（Vite 会原样拷进 dist，运行时按 URL 取）。
 *
 * 这里只做两件事：懒加载 + 缓存。**不和程序化美术混着写** ——
 * `art.ts` 负责"没有立绘时怎么用矢量画"，本文件负责"有立绘时怎么取到它"。
 *
 * 约定：
 * - 拿不到立绘（未加载完 / 404 / 无 slug）时一律返回 `null`，
 *   调用方必须回落到矢量绘制，绝不允许画一半或抛异常。
 * - 每帧调用 `getCharacterSprite()` 是安全的：只有第一次会真的建 `Image`。
 */
import type { CharacterDef } from '../data/characters';

export interface SpriteEntry {
  img: HTMLImageElement;
  /** 是否已经解码完成，可以直接 drawImage */
  ready: boolean;
  /** 加载失败（404 / 解码错误），永久置位，不再重试 */
  failed: boolean;
}

const cache = new Map<string, SpriteEntry>();

function loadInto(slug: string): SpriteEntry {
  const entry: SpriteEntry = {
    img: new Image(),
    ready: false,
    failed: false,
  };
  entry.img.onload = () => {
    entry.ready = true;
  };
  entry.img.onerror = () => {
    entry.failed = true;
  };
  entry.img.src = `characters/${slug}.png`;
  return entry;
}

/**
 * 取某个角色的立绘。返回 `null` 表示"这一帧还请用矢量画"。
 * 无头测试环境下 `Image` 永远不会 onload，所以天然走矢量分支，
 * 不会让 smoke test 崩掉。
 */
export function getCharacterSprite(def: CharacterDef): SpriteEntry | null {
  const slug = def.sprite;
  if (!slug) return null;
  let entry = cache.get(slug);
  if (!entry) {
    // Image 在伪造的 window 里可能不存在 —— 那就当作"永远拿不到立绘"。
    if (typeof Image !== 'function') return null;
    entry = loadInto(slug);
    cache.set(slug, entry);
  }
  if (entry.failed || !entry.ready) return null;
  if (entry.img.naturalWidth === 0) return null;
  return entry;
}

/** 该角色是否配置了立绘（不看加载进度，只看看有没有配）。 */
export function hasSprite(def: CharacterDef): boolean {
  return typeof def.sprite === 'string' && def.sprite.length > 0;
}
