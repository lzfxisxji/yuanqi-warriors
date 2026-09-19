/**
 * 抠图自检：读 `public/characters/*.png`，报告
 *  1) 四角是否干净（残留背景会让角色看起来"贴在一块白板上"）
 *  2) 半透明边缘像素比例（太高的半透明边 = 抠不干净，游戏里会显灰边）
 *  3) 主体外接框与留白（决定进游戏后的视觉重心）
 * 只读不写。
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'public', 'characters');

const lines = [];
if (!existsSync(DIR)) {
  lines.push('目录不存在: ' + DIR);
} else {
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.png'))) {
    const png = PNG.sync.read(readFileSync(join(DIR, f)));
    const { width, height, data } = png;
    let opaque = 0;
    let partial = 0;
    let transparent = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const a = data[(y * width + x) * 4 + 3];
        if (a === 0) transparent++;
        else if (a === 255) {
          opaque++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        } else partial++;
      }
    }
    const total = width * height;
    const corner = (x, y) => data[(y * width + x) * 4 + 3];
    const corners = [corner(0, 0), corner(width - 1, 0), corner(0, height - 1), corner(width - 1, height - 1)];
    // 边缘 2px 环带的平均 alpha（越接近 0 越好）
    let ringSum = 0;
    let ringN = 0;
    for (let x = 0; x < width; x++) {
      for (const y of [0, 1, height - 2, height - 1]) {
        ringSum += data[(y * width + x) * 4 + 3];
        ringN++;
      }
    }
    lines.push(`--- ${f}  ${width}x${height}`);
    lines.push(`  不透明 ${((opaque / total) * 100).toFixed(1)}%  半透明 ${((partial / total) * 100).toFixed(2)}%  透明 ${((transparent / total) * 100).toFixed(1)}%`);
    lines.push(`  四角 alpha = ${corners.join(', ')}`);
    lines.push(`  上下边缘平均 alpha = ${(ringSum / ringN).toFixed(1)}`);
    lines.push(`  主体 bbox = x${minX}-${maxX} y${minY}-${maxY}  (${maxX - minX + 1}x${maxY - minY + 1})`);
    lines.push(`  左右留白 = ${minX} / ${width - 1 - maxX}   上留白 = ${minY}   下留白 = ${height - 1 - maxY}`);
    lines.push(`  宽高比 = ${((maxX - minX + 1) / (maxY - minY + 1)).toFixed(3)}`);
  }
}
writeFileSync(join(ROOT, '.png-check.txt'), lines.join('\n'), 'utf8');
