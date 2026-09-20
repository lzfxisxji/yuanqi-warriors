/**
 * 角色立绘处理：把 `role/` 里的原始四格设定图（米白渐变背景 + 正面/侧面/背面/文字标板）
 * 转成游戏可用的**真 RGBA 透明 PNG**，输出到 `public/characters/`。
 *
 * 两步：
 *   1. 去背景 —— 为什么不用 chroma key 直接把"米白"抠掉：
 *      角色本体是奶白/浅黄（噜噜的肚子几乎是 #fff6e0），和背景 #faf7f2 极近，
 *      简单阈值会把角色一起抠穿。这里用两个更稳的信号组合：
 *        a) flood fill：从四边向内扩散的"连通背景"。背景是连通的、角色是封闭的，
 *           所以被角色包围的浅色肚子不会被误判；
 *        b) 局部背景色估计：背景是缓慢渐变的，所以阈值必须跟位置走 ——
 *           取该行最右端的连续像素作为"这一行的背景基准色"，和它比距离，
 *           而不是和一个全局常量比。
 *      两个条件都满足才判为背景，再对边界做软 alpha 过渡消除锯齿。
 *   2. 切格 —— 原图是横向排列的设定图（含大标题、角标文字、分隔线），
 *      直接整张塞进游戏会带上这些元素。这里按检测到的"格位"裁出**正面立绘**，
 *      再按统一高度缩放，保证两个角色在场上视觉大小一致。
 *
 * 用法：node tools/cutout.mjs
 */
import { createRequire } from 'node:module';
import { readdirSync, mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

// 用 fileURLToPath 而不是手撕 URL.pathname —— 后者会把中文路径转义成 %E5%85%83… 导致 ENOENT
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'role');
const OUT_DIR = join(ROOT, 'public', 'characters');
const BOSS_OUT_DIR = join(ROOT, 'public', 'bosses');

/** 与逐行背景基准色的允许距离（平方，越小越严格）。 */
const TOLERANCE = 14 * 14;
/** 软过渡带宽度：距离落在 [TOLERANCE, TOLERANCE + SOFT²) 的像素按比例给 alpha。 */
const SOFT = 30;
/** flood fill 的宽容度：只有和背景够像的像素才允许继续向外扩散。 */
const BG_TOLERANCE = 16 * 16;
/**
 * 亮度保护：角色身上的眼白/牙齿是**接近纯白**的，和米白背景颜色几乎一样，
 * 只靠"离背景基准色的距离"会把它一起抠掉（实测袋鼠右眼白 248,248,246 就被抠穿了）。
 * 所以额外要求背景像素必须"是暖色米白"：亮度和背景基准色接近。
 * 眼白比背景更亮更中性，靠这一条保住。
 */
const BG_LUMA_BIAS = 6;
/** 立绘统一输出高度（宽按比例）。两个角色共用，保证场上大小一致。 */
const OUT_H = 320;
/** Boss 立绘输出高度（比角色立绘稍大，Boss 在场上本来就更醒目）。 */
const BOSS_OUT_H = 360;

/**
 * 每张设定图只取**正面立绘**（用户要求：三视图里只要参考图，不需要侧面/背面）。
 *
 * 两张原图版式完全不同，自动切格不可靠，所以写死矩形边界 —— 这几个数字是用
 * 内容块探测（见 `inkRuns`）逐张量出来的，改动素材时必须重新量：
 * - lulu（1748×900）：正面格 x 568-890，人物 y 270-714；
 *   下方 y 743-791 是「正面」文字标板，必须排除。
 * - fatkangaroo（1747×900）：正面格 x 992-1325，人物 y 252-719；
 *   同样排除 y 745-791 的标板。
 * 矩形内仍可能有标板/邻格残留，所以裁完还要做一次"最大连通块"筛选（见 `keepLargestBlob`）。
 */
const LAYOUTS = {
  // 噜噜：**不是等宽四格**，最左还有一个比格子高的大立绘。
  // 用"离背景色明显不同"的阈值实测（见 tools/diag-bounds.mjs）：
  //   正面格 x567-890，角色 y270-713；下方 y744-791 是「正面」文字标板。
  // 所以 box 的 y1 必须停在 720（标板之前），否则会把标板一起抠进来。
  lulu: { slug: 'lulu', box: { x0: 560, x1: 898, y0: 255, y1: 720 }, seed: { x: 728, y: 520 } },
  // 肥嘟袋鼠：同样是"非等宽"，最左有超出格子的挥手大立绘。
  // y=520 处实测四格分段：160-435(挥手大图) | 603-869(正面) | 1012-1211(侧面) | 1404-1667(背面)。
  // 正面角色体实测 y250-712（y<246 是顶部标题文字，不是角色），标板在 y746-791。
  fatkangaroo: { slug: 'fatkangaroo', box: { x0: 596, x1: 876, y0: 244, y1: 718 }, seed: { x: 750, y: 520 } },
  // 奶龙（1747×900）：版式和前两张同源，但**格与格之间贴得更紧、没有分隔线**，
  // 侧面格的身体会一直延伸到 x≈500，和正面格在 x 上重叠 —— 所以 box 的 x0 必须
  // 卡在侧面身体与正面身体之间的空隙（实测 x≈556..602 是干净的背景走廊）。
  // 实测（tools/diag-milkdragon.mjs / diag-milk2.mjs / diag-milk3.mjs）：
  //   正面角色体 x604-881、y253-687；标板「正面」在 y716-760（中心色 rgb(173,137,106)）。
  //   顶部左上「奶龙」大标题在 x205-511 / y28-200，不在 box 内，天然排除。
  milkdragon: { slug: 'milkdragon', box: { x0: 610, x1: 888, y0: 250, y1: 700 }, seed: { x: 730, y: 520 } },
  // 牛来（1748×900）：四格 + 最左超出格子的抱臂大立绘 + 左上「牛来」大标题。
  // 实测（tools/diag-niulai.mjs / diag-niu2.mjs）：
  //   正面角色体 x560-904、y240-714（最宽处 y550-570 的 x560-904 是它张开的双臂）；
  //   侧面格身体从 x≈1030 起，而正面格右侧到 x≈905 就干净了 ——
  //   所以 x1 取 915 足够宽又不会碰到侧面格。
  //   下方 y740-790 是「正面」文字标板（实测 y720-730 / y800 是纯背景空档，正好卡开）。
  niulai: { slug: 'niulai', box: { x0: 548, x1: 915, y0: 228, y1: 720 }, seed: { x: 730, y: 520 } },
};

/** 文件名 -> { 布局, 显示名 }。 */
const SLUGS = {
  '角色-噜噜.png': { key: 'lulu', display: '噜噜' },
  '角色-肥嘟袋鼠.png': { key: 'fatkangaroo', display: '肥嘟袋鼠' },
  '角色-奶龙.png': { key: 'milkdragon', display: '奶龙' },
  '角色-牛来.png': { key: 'niulai', display: '牛来' },
};

/**
 * Boss 设定图（boss-豆包.png / boss-deepseek.png）沿用同一套四格模板：
 * [挥手大图] [正面] [侧面] [背面]，格间有细分隔线。
 * 下面只取「正面格」，box 与 seed 用 tools/diag-boss.mjs 量出：
 *   - 豆包（1747×900）：大图 x40-578；正面格 x676-892，角色 y197-857；seed 躯干中心 (784,540)。
 *   - DeepSeek（1748×900）：大图 x16-708；正面格 x714-1026，角色 y201-862；seed (870,545)。
 * 抠完由 keepSeededBlob 从种子收紧到主体，自动排除可能残留的「正面」文字标板。
 */
const LAYOUTS_BOSS = {
  doubao: { slug: 'doubao', box: { x0: 676, x1: 892, y0: 195, y1: 857 }, seed: { x: 784, y: 540 } },
  deepseek: { slug: 'deepseek', box: { x0: 714, x1: 1026, y0: 200, y1: 862 }, seed: { x: 870, y: 545 } },
};

/** Boss 文件名 -> { 布局, 显示名 }。 */
const SLUGS_BOSS = {
  'boss-豆包.png': { key: 'doubao', display: '豆包' },
  'boss-deepseek.png': { key: 'deepseek', display: 'DeepSeek' },
};

function sqDist(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}

/** 感知亮度（Rec.601），用来区分"米白背景"和"更亮的眼白/高光"。 */
function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** 逐行估计背景基准色：从该行最右端往左扫，取"连续同色"的那一段均值。 */
function estimateRowBg(png, y) {
  const { width, data } = png;
  const last = (y * width + width - 1) * 4;
  let lastR = data[last];
  let lastG = data[last + 1];
  let lastB = data[last + 2];
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let x = width - 1; x >= 0; x--) {
    const i = (y * width + x) * 4;
    const pr = data[i];
    const pg = data[i + 1];
    const pb = data[i + 2];
    if (sqDist(pr, pg, pb, lastR, lastG, lastB) > 900) break;
    r += pr;
    g += pg;
    b += pb;
    n++;
    lastR = pr;
    lastG = pg;
    lastB = pb;
    if (n >= 96) break;
  }
  return { r: r / n, g: g / n, b: b / n };
}

/** 去背景：返回逐像素 alpha（0..255）矩阵。 */
function buildAlpha(png) {
  const { width, height, data } = png;
  const dist = new Float64Array(width * height);
  /** 亮度保护位：候选像素比该行背景基准更亮（超过 BG_LUMA_BIAS）时置 1，永不当背景。 */
  const tooBright = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const { r, g, b } = estimateRowBg(png, y);
    const bgLuma = luminance(r, g, b);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const k = y * width + x;
      dist[k] = sqDist(data[i], data[i + 1], data[i + 2], r, g, b);
      tooBright[k] = luminance(data[i], data[i + 1], data[i + 2]) > bgLuma + BG_LUMA_BIAS ? 1 : 0;
    }
  }

  const isBg = new Uint8Array(width * height);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const k = y * width + x;
    if (isBg[k] || dist[k] > BG_TOLERANCE) return;
    // 比背景基准更亮的像素（眼白 / 牙齿 / 高光）一律不许当背景，
    // 否则洪泛会顺着"颜色像背景"把它们整块挖穿。
    if (tooBright[k]) return;
    isBg[k] = 1;
    stack.push(k);
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (stack.length) {
    const k = stack.pop();
    const x = k % width;
    const y = (k - x) / width;
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }

  const alpha = new Uint8Array(width * height);
  let bgCount = 0;
  for (let k = 0; k < width * height; k++) {
    if (isBg[k]) {
      alpha[k] = 0;
      bgCount++;
      continue;
    }
    const d = dist[k];
    alpha[k] = d >= TOLERANCE + SOFT * SOFT ? 255 : Math.round(255 * Math.max(0, (d - TOLERANCE) / (SOFT * SOFT)));
  }
  return { alpha, bgCount };
}

/**
 * 只保留与"种子点"连通的那一块墨迹，其余（邻格残留、下方「正面」文字标板、
 * 边框碎片）一律置为透明。
 *
 * 为什么用**种子洪泛**而不是"找最大连通块"：
 *   立绘是软 3D 渲染，角色身体存在细颈/细腿，全局形态学腐蚀会把主体打断成碎片，
 *   反而让邻格那一小撮赢下"最大块"。种子点放在角色躯干中心（一定能命中主体），
 *   从它出发沿墨迹 4 邻域扩散，既不会跑进隔着一片空白的文字标板，也不会跑到邻格，
 *   且完全不受细颈影响。
 */
function keepSeededBlob(alpha, width, box, seed) {
  const { x0, x1, y0, y1 } = box;
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const idx = (x, y) => (y - y0) * bw + (x - x0);
  const ink = new Uint8Array(bw * bh);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) ink[idx(x, y)] = alpha[y * width + x] > 60 ? 1 : 0;
  }

  // 种子：优先用给定点；若它恰好落在透明处（如 DeepSeek 正面角色中间有镂空），
  // 先退回 box 内**墨迹质心**（最稳，必然落在主体上），质心也落空再螺旋搜索（半径 80）。
  // DeepSeek 种子 (870,545) 原落在镂空，曾只抠出 19×9，靠质心兜底修复到完整主体。
  let sx = seed.x - x0;
  let sy = seed.y - y0;
  if (!ink[sy * bw + sx]) {
    let cx = 0;
    let cy = 0;
    let total = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (ink[idx(x, y)]) {
          cx += x - x0;
          cy += y - y0;
          total++;
        }
      }
    }
    if (total > 0) {
      sx = Math.round(cx / total);
      sy = Math.round(cy / total);
    }
    if (!ink[sy * bw + sx]) {
      let found = false;
      for (let r = 1; r <= 80 && !found; r++) {
        for (let dy = -r; dy <= r && !found; dy++) {
          for (let dx = -r; dx <= r && !found; dx++) {
            const px = sx + dx;
            const py = sy + dy;
            if (px < 0 || py < 0 || px >= bw || py >= bh) continue;
            if (ink[py * bw + px]) {
              sx = px;
              sy = py;
              found = true;
            }
          }
        }
      }
      if (!found) return null;
    }
  }

  const mask = new Uint8Array(bw * bh);
  const stack = [sy * bw + sx];
  mask[sy * bw + sx] = 1;
  let size = 1;
  while (stack.length) {
    const k = stack.pop();
    const x = k % bw;
    const y = (k - x) / bw;
    const nb = [x > 0 ? k - 1 : -1, x < bw - 1 ? k + 1 : -1, y > 0 ? k - bw : -1, y < bh - 1 ? k + bw : -1];
    for (const n of nb) {
      if (n >= 0 && ink[n] && !mask[n]) {
        mask[n] = 1;
        size++;
        stack.push(n);
      }
    }
  }

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!mask[idx(x, y)]) alpha[y * width + x] = 0;
    }
  }

  // 用掩码收紧外接框
  let left = x1;
  let right = x0;
  let top = y1;
  let bottom = y0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (mask[idx(x, y)]) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return { left, right, top, bottom, blobPixels: size };
}

/** 按外接框把 alpha 已经处理好的图裁出来。 */
function cropByBox(png, alpha, box) {
  const { width, data } = png;
  const w = box.right - box.left + 1;
  const h = box.bottom - box.top + 1;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((box.top + y) * width + (box.left + x)) * 4;
      const di = (y * w + x) * 4;
      out.data[di] = data[si];
      out.data[di + 1] = data[si + 1];
      out.data[di + 2] = data[si + 2];
      out.data[di + 3] = alpha[(box.top + y) * width + (box.left + x)];
    }
  }
  return out;
}

/** 双线性缩放（保持 RGBA/预乘无关的直通缩放，边缘已由 alpha 处理）。 */
function resize(src, outW, outH) {
  const dst = new PNG({ width: outW, height: outH });
  for (let y = 0; y < outH; y++) {
    const sy = ((y + 0.5) * src.height) / outH - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const fy = Math.max(0, sy - y0);
    for (let x = 0; x < outW; x++) {
      const sx = ((x + 0.5) * src.width) / outW - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const fx = Math.max(0, sx - x0);
      const di = (y * outW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = src.data[(y0 * src.width + x0) * 4 + c];
        const p10 = src.data[(y0 * src.width + x1) * 4 + c];
        const p01 = src.data[(y1 * src.width + x0) * 4 + c];
        const p11 = src.data[(y1 * src.width + x1) * 4 + c];
        const top = p00 + (p10 - p00) * fx;
        const bot = p01 + (p11 - p01) * fx;
        dst.data[di + c] = Math.round(top + (bot - top) * fy);
      }
    }
  }
  return dst;
}

/**
 * 处理一张设定图：去背景 → 只留正面格内最大的连通块 → 统一高度输出。
 * 侧面/背面按用户要求丢弃。
 */
function process(srcPath, layout, displayName, outDir, outH) {
  const png = PNG.sync.read(readFileSync(srcPath));
  const { alpha, bgCount } = buildAlpha(png);
  const log = [
    `${displayName}: ${png.width}x${png.height} 去背景 ${((bgCount / (png.width * png.height)) * 100).toFixed(1)}%`,
  ];

  const box = layout.box;
  const blob = keepSeededBlob(alpha, png.width, box, layout.seed);
  if (!blob) throw new Error(`${displayName}: 正面格内未找到有效立绘`);
  log.push(
    `   正面格 x${box.x0}-${box.x1} y${box.y0}-${box.y1} → 主体外接框 ` +
      `x${blob.left}-${blob.right} y${blob.top}-${blob.bottom} ` +
      `(${blob.right - blob.left + 1}x${blob.bottom - blob.top + 1})`,
  );

  const cut = cropByBox(png, alpha, blob);
  const scale = outH / cut.height;
  const outW = Math.max(1, Math.round(cut.width * scale));
  const scaled = resize(cut, outW, outH);
  const dst = join(outDir, `${layout.slug}.png`);
  writeFileSync(dst, PNG.sync.write(scaled));
  log.push(`   -> ${outDir.split(/[\\/]/).pop()}/${layout.slug}.png ${outW}x${outH} ${statSync(dst).size}B`);
  return log;
}

function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  if (!existsSync(BOSS_OUT_DIR)) mkdirSync(BOSS_OUT_DIR, { recursive: true });
  const only = (globalThis.process?.argv ?? []).slice(2);
  const lines = [];

  // 角色立绘
  const charFiles = readdirSync(SRC_DIR)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .filter((f) => only.length === 0 || only.includes(SLUGS[f]?.key ?? ''));
  for (const f of charFiles) {
    const info = SLUGS[f];
    if (!info) continue;
    lines.push(...process(join(SRC_DIR, f), LAYOUTS[info.key], info.display, OUT_DIR, OUT_H));
  }

  // Boss 立绘
  const bossFiles = readdirSync(SRC_DIR)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .filter((f) => only.length === 0 || only.includes(SLUGS_BOSS[f]?.key ?? ''));
  for (const f of bossFiles) {
    const info = SLUGS_BOSS[f];
    if (!info) {
      lines.push(`${f}: 未登记版式，跳过（如需处理请补 LAYOUTS_BOSS/SLUGS_BOSS）`);
      continue;
    }
    lines.push(...process(join(SRC_DIR, f), LAYOUTS_BOSS[info.key], info.display, BOSS_OUT_DIR, BOSS_OUT_H));
  }

  writeFileSync(join(ROOT, '.cutout-log.txt'), lines.join('\n'), 'utf8');
}

main();
void readFileSync;
