/**
 * 诊断脚本 v2：自动检测 boss 设定图的 4 个格位，并打印每个格的
 * 紧密外接框（正格内角色的 y 范围）与种子点，供 cutout 复用。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'role');
const TOLERANCE = 14 * 14;

function sqDist(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}
function luminance(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

function estimateRowBg(png, y) {
  const { width, data } = png;
  const last = (y * width + width - 1) * 4;
  let lr = data[last], lg = data[last + 1], lb = data[last + 2];
  let r = 0, g = 0, b = 0, n = 0;
  for (let x = width - 1; x >= 0; x--) {
    const i = (y * width + x) * 4;
    if (sqDist(data[i], data[i + 1], data[i + 2], lr, lg, lb) > 900) break;
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    lr = data[i]; lg = data[i + 1]; lb = data[i + 2];
    if (n >= 96) break;
  }
  return { r: r / n, g: g / n, b: b / n };
}

function analyze(file) {
  const png = PNG.sync.read(readFileSync(join(SRC_DIR, file)));
  const { width, height, data } = png;
  const ink = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const bg = estimateRowBg(png, y);
    const bgl = luminance(bg.r, bg.g, bg.b);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const d = sqDist(data[i], data[i + 1], data[i + 2], bg.r, bg.g, bg.b);
      const tooBright = luminance(data[i], data[i + 1], data[i + 2]) > bgl + 6;
      ink[y * width + x] = d > TOLERANCE && !tooBright ? 1 : 0;
    }
  }
  // 每列墨迹占比
  const colFrac = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    let s = 0;
    for (let y = 0; y < height; y++) s += ink[y * width + x];
    colFrac[x] = s / height;
  }
  // 找墨迹段的 x 边界（占比 > 0.03 视为格内有内容）
  const segs = [];
  let inSeg = false, sx = 0;
  for (let x = 0; x < width; x++) {
    const on = colFrac[x] > 0.03;
    if (on && !inSeg) { inSeg = true; sx = x; }
    if (!on && inSeg) { segs.push([sx, x - 1]); inSeg = false; }
  }
  if (inSeg) segs.push([sx, width - 1]);

  const lines = [`=== ${file} (${width}x${height}) ===`];
  lines.push(`列段数=${segs.length}: ` + segs.map((s) => `x${s[0]}-${s[1]}`).join(' | '));
  segs.forEach((s, idx) => {
    let left = width, right = 0, top = height, bottom = 0, cnt = 0;
    for (let y = 0; y < height; y++) {
      for (let x = s[0]; x <= s[1]; x++) {
        if (ink[y * width + x]) {
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
          cnt++;
        }
      }
    }
    lines.push(
      `  段${idx}: x${s[0]}-${s[1]}  内容外接框 x${left}-${right} y${top}-${bottom} ` +
      `(${right - left + 1}x${bottom - top + 1}) seed≈(${Math.round((left + right) / 2)},${Math.round(top + (bottom - top) * 0.6)})`,
    );
  });
  return lines.join('\n');
}

const files = ['boss-豆包.png', 'boss-deepseek.png'];
const out = files.map(analyze).join('\n');
require('fs').writeFileSync(join(ROOT, '.diag-boss.txt'), out, 'utf8');
console.log('wrote');
