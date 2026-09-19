import { expect, test } from 'vitest';
import {
  RNG,
  TAU,
  angleDelta,
  approach,
  circleRectResolve,
  circleRectOverlap,
  clamp,
  dist,
  hashString,
  lerp,
  mulberry32,
  normalize,
  rectsOverlap,
  rotateTowards,
  segmentSamples,
} from '../src/core/math';

test('clamp / lerp 基本行为', () => {
  expect(clamp(5, 0, 10)).toBe(5);
  expect(clamp(-3, 0, 10)).toBe(0);
  expect(clamp(99, 0, 10)).toBe(10);
  expect(lerp(0, 10, 0.25)).toBe(2.5);
});

test('dist / normalize 数学正确', () => {
  expect(dist(0, 0, 3, 4)).toBeCloseTo(5, 6);
  const n = normalize(0, 0);
  expect(n.x).toBe(0);
  expect(n.y).toBe(0);
  const n2 = normalize(3, 4);
  expect(n2.x).toBeCloseTo(0.6, 6);
  expect(n2.y).toBeCloseTo(0.8, 6);
});

test('angleDelta 返回最短有向角差', () => {
  expect(angleDelta(0, 0)).toBeCloseTo(0, 6);
  expect(Math.abs(angleDelta(0.1, TAU - 0.1))).toBeCloseTo(0.2, 6);
  expect(Math.abs(angleDelta(TAU - 0.1, 0.1))).toBeCloseTo(0.2, 6);
  expect(angleDelta(0, Math.PI)).toBeCloseTo(Math.PI, 6);
});

test('rotateTowards / approach 收敛不失速', () => {
  const a = rotateTowards(0, Math.PI, 0.5);
  expect(a).toBeCloseTo(0.5, 6);
  expect(approach(0, 10, 3)).toBe(3);
  expect(approach(0, 10, 100)).toBe(10);
  expect(approach(0, -10, 100)).toBe(-10);
});

test('圆与矩形碰撞解析', () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  expect(circleRectOverlap(50, 50, 10, rect)).toBe(true);
  expect(circleRectOverlap(150, 50, 10, rect)).toBe(false);
  expect(circleRectOverlap(105, 50, 10, rect)).toBe(true);

  const res = circleRectResolve(105, 50, 10, rect);
  expect(res).not.toBeNull();
  expect(res!.x).toBeCloseTo(110, 4);
  expect(res!.nx).toBeCloseTo(1, 4);

  // 圆心在矩形内部时应沿最近边推出
  const inside = circleRectResolve(3, 50, 10, rect);
  expect(inside).not.toBeNull();
  expect(inside!.x).toBeCloseTo(-10, 4);
});

test('矩形重叠', () => {
  expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
  expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 })).toBe(false);
});

test('RNG 同种子完全可复现', () => {
  const a = new RNG(12345);
  const b = new RNG(12345);
  for (let i = 0; i < 50; i++) {
    expect(a.next()).toBe(b.next());
  }
  expect(mulberry32(7)()).toBe(mulberry32(7)());
});

test('RNG 分布范围合理', () => {
  const rng = new RNG(999);
  for (let i = 0; i < 2000; i++) {
    const v = rng.next();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  }
  const ints = new Set<number>();
  for (let i = 0; i < 500; i++) ints.add(rng.int(0, 4));
  expect([...ints].sort()).toEqual([0, 1, 2, 3, 4]);
  const arr = [1, 2, 3, 4, 5];
  const shuffled = rng.shuffle(arr);
  expect(shuffled.length).toBe(5);
  expect([...shuffled].sort()).toEqual([1, 2, 3, 4, 5]);
});

test('hashString 稳定且区分大小写', () => {
  expect(hashString('room')).toBe(hashString('room'));
  expect(hashString('room')).not.toBe(hashString('rooM'));
});

test('segmentSamples 均匀切分线段且覆盖端点', () => {
  const pts = segmentSamples(0, 0, 100, 0, 25);
  expect(pts.length).toBeGreaterThanOrEqual(4);
  expect(pts[0]).toEqual({ x: 0, y: 0 });
  const last = pts[pts.length - 1];
  expect(last.x).toBeCloseTo(100, 4);
});
