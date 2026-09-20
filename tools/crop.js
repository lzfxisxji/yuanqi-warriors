/**
 * 把一张 PNG 的指定区域裁剪 + 整数倍最近邻放大，用于肉眼复核像素级细节。
 *
 * 用法：node tools/crop.js <输入> <输出> <x> <y> <w> <h> <倍数>
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const [, , inPath, outPath, xs, ys, ws, hs, zs] = process.argv;
if (!inPath || !outPath) {
  console.error('用法: node tools/crop.js <输入> <输出> <x> <y> <w> <h> <倍数>');
  process.exit(1);
}
const X = Number(xs);
const Y = Number(ys);
const W = Number(ws);
const H = Number(hs);
const Z = Math.max(1, Math.round(Number(zs) || 1));

const src = PNG.sync.read(readFileSync(resolve(inPath)));
const ow = W * Z;
const oh = H * Z;
const dst = new PNG({ width: ow, height: oh });
for (let y = 0; y < oh; y++) {
  for (let x = 0; x < ow; x++) {
    const sx = Math.min(src.width - 1, X + Math.floor(x / Z));
    const sy = Math.min(src.height - 1, Y + Math.floor(y / Z));
    const si = (sy * src.width + sx) * 4;
    const di = (y * ow + x) * 4;
    dst.data[di] = src.data[si];
    dst.data[di + 1] = src.data[si + 1];
    dst.data[di + 2] = src.data[si + 2];
    dst.data[di + 3] = 255;
  }
}
writeFileSync(resolve(outPath), PNG.sync.write(dst));
console.log(`${outPath} ${ow}x${oh}（源 ${src.width}x${src.height} 的 ${X},${Y} ${W}x${H} × ${Z}）`);
