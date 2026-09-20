/**
 * 检查 public/characters/*.png（以及任意输出图）的**边缘贴合**情况。
 *
 * 抠图时如果 box 裁得比角色本体窄，输出的 PNG 就会在左右边界上留下
 * "角色像素贴着图片边缘"的痕迹 —— 游戏里的表现就是角色被切掉一块。
 * 这个脚本逐行统计 alpha 极值，输出"贴边行数占比"。
 *
 * 判据：用 alpha >= ALPHA_MIN 才算墨迹（排除软过渡的极淡halo）。
 *
 * 用法：node tools/diag-edge.mjs [相对路径...]
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALPHA_MIN = 60;

const argv = process.argv.slice(2);
const list = argv.length
  ? argv
  : ['lulu', 'fatkangaroo', 'milkdragon', 'niulai'].map((s) => join('public', 'characters', `${s}.png`));

for (const rel of list) {
  const png = PNG.sync.read(readFileSync(join(ROOT, rel)));
  const { width, height, data } = png;
  const aAt = (x, y) => data[(y * width + x) * 4 + 3];

  let leftTouching = 0;
  let rightTouching = 0;
  let firstSolidRow = -1;
  let lastSolidRow = -1;
  let minXall = width;
  let maxXall = -1;
  const leftRows = [];
  for (let y = 0; y < height; y++) {
    let minX = -1;
    let maxX = -1;
    for (let x = 0; x < width; x++) {
      if (aAt(x, y) >= ALPHA_MIN) {
        if (minX < 0) minX = x;
        maxX = x;
      }
    }
    if (minX < 0) continue;
    if (firstSolidRow < 0) firstSolidRow = y;
    lastSolidRow = y;
    if (minX < minXall) minXall = minX;
    if (maxX > maxXall) maxXall = maxX;
    if (minX <= 1) {
      leftTouching++;
      leftRows.push(y);
    }
    if (maxX >= width - 2) rightTouching++;
  }

  const rows = lastSolidRow - firstSolidRow + 1;
  const pct = (n) => `${String(n).padStart(4)} 行 (${((n / rows) * 100).toFixed(1)}%)`;
  console.log(`\n=== ${rel}  ${width}x${height} ===`);
  console.log(`  墨迹外接框 x${minXall}..${maxXall}  y${firstSolidRow}..${lastSolidRow}`);
  console.log(`  左侧贴边(minX<=1): ${pct(leftTouching)}  ${leftTouching > rows * 0.03 ? '<== 左侧被裁!' : 'ok'}`);
  console.log(`  右侧贴边(maxX>=w-2): ${pct(rightTouching)} ${rightTouching > rows * 0.03 ? '<== 右侧被裁!' : 'ok'}`);
  if (leftRows.length) {
    const segs = [];
    let st = leftRows[0];
    let prev = leftRows[0];
    for (const y of leftRows.slice(1)) {
      if (y !== prev + 1) {
        segs.push([st, prev]);
        st = y;
      }
      prev = y;
    }
    segs.push([st, prev]);
    console.log(`  左侧贴边的 y 段: ${segs.map(([a, b]) => (a === b ? `${a}` : `${a}..${b}`)).join(', ')}`);
  }
  console.log(`  顶部贴边: ${firstSolidRow <= 0 ? '是' : '否'}   底部贴边: ${lastSolidRow >= height - 1 ? '是' : '否'}`);
}
