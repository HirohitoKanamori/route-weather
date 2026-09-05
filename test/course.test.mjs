import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RW } from './_load.mjs';

test('hav / bearing', () => {
  const a = { lat: 35, lon: 139 }, b = { lat: 36, lon: 139 };
  assert.ok(Math.abs(RW.course.hav(a, b) - 111.2) < 0.3);
  assert.ok(Math.abs(RW.course.bearing(a, b)) < 1e-6);
  assert.ok(Math.abs(RW.course.bearing(a, { lat: 35, lon: 140 }) - 90) < 1);
});

test('fromPoints：累積距離・間引き（最大 600 点）・獲得標高（平滑化＋3 m ヒステリシス）', () => {
  // 約 20 m 間隔で 5000 点。前半 1250 m 登って後半下る台形に、±2 m の交互ノイズを乗せる
  const raw = [];
  for (let i = 0; i < 5000; i++) raw.push({ lat: 35 + i * 0.0002, lon: 139, ele: (i < 2500 ? i * 0.5 : (5000 - i) * 0.5) + (i % 2 ? 2 : -2) });
  const c = RW.course.fromPoints(raw, 'x');
  assert.ok(c.pts.length <= 601 && c.pts.length >= 300, `点数 ${c.pts.length}`); // 距離ベース間引き：上限 600、間隔は total/600 以上
  assert.ok(Math.abs(c.total - RW.course.hav(raw[0], raw[raw.length - 1])) < 0.01);
  assert.equal(c.n, 5000);
  assert.ok(Math.abs(c.gain - 1250) < 15, `獲得標高 ${c.gain}（ノイズを数えず約 1250 m）`);
  assert.equal(c.pts[c.pts.length - 1].d, c.total);
  const noisy = [];
  for (let i = 0; i < 100; i++) noisy.push({ lat: 35 + i * 0.0002, lon: 139, ele: 100 + (i % 2) * 6 }); // 交互 ±6 m のノイズは数えない
  assert.ok(RW.course.fromPoints(noisy, 'y').gain < 3, 'ノイズのみ');
});

test('fromPoints：標高なしでも動く', () => {
  const c = RW.course.fromPoints([{ lat: 35, lon: 139 }, { lat: 35.1, lon: 139 }], 'z');
  assert.equal(c.hasEle, false); assert.equal(c.gain, 0);
  assert.equal(RW.course.interp(c, 5).ele, null);
});

test('interp / headingAt', () => {
  const c = RW.course.fromPoints([{ lat: 35, lon: 139, ele: 0 }, { lat: 36, lon: 139, ele: 1000 }], 'w');
  const m = RW.course.interp(c, c.total / 2);
  assert.ok(Math.abs(m.lat - 35.5) < 1e-6); assert.ok(Math.abs(m.ele - 500) < 1e-6);
  assert.ok(RW.course.headingAt(c, 0) < 1e-6);
  assert.ok(RW.course.headingAt(c, c.total) < 1e-6);
  assert.equal(RW.course.hashCourse(c), RW.course.hashCourse(c));
});
