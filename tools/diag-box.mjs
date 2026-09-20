/**
 * 为 `tools/cutout.mjs` 的 LAYOUTS 定 box 用的**精测定格**工具。
 *
 * 用与 cutout.mjs 完全相同的去背景算法（pngjs + 同一套阈值），对指定源图做：
 *   1. 逐列墨迹数（细扫候选区间）→ 定 x0 / x1
 *   2. 逐行墨迹数（细扫候选区间）→ 定 y0 / y1
 *   3. 零墨迹列区间 → 找"干净走廊"（保证割断邻格/大立绘，避免洪泛串味）
 *
 * 用法：node tools/diag-box.mjs <源图相对路径> <y0> <y1> <x0> <x1> [细扫列a] [细扫列b] [细扫行a] [细扫行b]
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// —— 与 cutout.mjs 保持一致的常量 ——
const TOLERANCE = 14 * 14;
const SOFT = 30;
const BG_TOLERANCE = 16 * 16;
const BG_LUMA_BIAS = 6;

function sqDist(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}
const luminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

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

function buildAlpha(png) {
  const { width, height, data } = png;
  const dist = new Float64Array(width * height);
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
    if (isBg[k] || dist[k] > BG_TOLERANCE || tooBright[k]) return;
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
  for (let k = 0; k < width * height; k++) {
    if (isBg[k]) continue;
    const d = dist[k];
    alpha[k] = d >= TOLERANCE + SOFT * SOFT ? 255 : Math.round(255 * Math.max(0, (d - TOLERANCE) / (SOFT * SOFT)));
  }
  return alpha;
}

// ---------------------------------------------------------------- 主流程
const argv = process.argv.slice(2);
if (argv.length < 5) {
  console.error('用法: node tools/diag-box.mjs <源图相对路径> <y0> <y1> <x0> <x1> [列细扫a] [列细扫b] [行细扫a] [行细扫b]');
  process.exit(1);
}
const SRC = resolve(ROOT, argv[0]);
const [Y0, Y1, X0, X1] = argv.slice(1, 5).map(Number);
const CA = argv[5] ? Number(argv[5]) : X0;
const CB = argv[6] ? Number(argv[6]) : Math.min(X0 + 90, X1);
const RA = argv[7] ? Number(argv[7]) : Y0;
const RB = argv[8] ? Number(argv[8]) : Math.min(Y0 + 50, Y1);

const png = PNG.sync.read(readFileSync(SRC));
const { width, height } = png;
console.log(`源图 ${SRC}\n尺寸 ${width}x${height}   参考窗 y${Y0}..${Y1} / x${X0}..${X1}`);
const alpha = buildAlpha(png);

const colInk = (x, ya = Y0, yb = Y1) => {
  let n = 0;
  for (let y = ya; y <= yb; y++) if (alpha[y * width + x] > 60) n++;
  return n;
};
const rowInk = (y, xa = X0, xb = X1) => {
  let n = 0;
  for (let x = xa; x <= xb; x++) if (alpha[y * width + x] > 60) n++;
  return n;
};

console.log(`\n=== 列细扫 x${CA}..${CB}（每列：墨迹行数）===`);
{
  const parts = [];
  for (let x = CA; x <= CB; x++) parts.push(`${x}:${colInk(x)}`);
  for (let i = 0; i < parts.length; i += 8) console.log('  ' + parts.slice(i, i + 8).join('  '));
}

console.log(`\n=== 行细扫 y${RA}..${RB}（每行：墨迹列数，窗口 x${X0}..${X1}）===`);
{
  const parts = [];
  for (let y = RA; y <= RB; y++) parts.push(`${y}:${rowInk(y)}`);
  for (let i = 0; i < parts.length; i += 8) console.log('  ' + parts.slice(i, i + 8).join('  '));
}

console.log(`\n=== y${Y0}..${Y1} 内 x${X0}..${X1} 的「零墨迹」列区间（宽 >= 4）===`);
{
  const runs = [];
  let st = -1;
  for (let x = X0; x <= X1; x++) {
    const clean = colInk(x) === 0;
    if (clean && st < 0) st = x;
    if (!clean && st >= 0) {
      runs.push([st, x - 1]);
      st = -1;
    }
  }
  if (st >= 0) runs.push([st, X1]);
  const wide = runs.filter(([a, b]) => b - a + 1 >= 4);
  if (!wide.length) console.log('  （无）');
  for (const [a, b] of wide) console.log(`  x${a}..${b}  宽 ${b - a + 1}`);
}
