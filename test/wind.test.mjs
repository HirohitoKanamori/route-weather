import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RW } from './_load.mjs';

const rel = RW.wind.relative;

test('真後ろからの風は追い風、正面は向かい風、真横は横風', () => {
  // 進行方位 0°（北）。南風（180° から吹く）は追い風
  let r = rel(180, 5, 0); assert.equal(r.cls, 'tail'); assert.ok(Math.abs(r.comp - 5) < 1e-9);
  r = rel(0, 5, 0); assert.equal(r.cls, 'head'); assert.ok(Math.abs(r.comp + 5) < 1e-9);
  r = rel(90, 5, 0); assert.equal(r.cls, 'cross'); assert.ok(Math.abs(r.comp) < 1e-9);
  r = rel(270, 5, 0); assert.equal(r.cls, 'cross');
});

test('閾値：±45° 以内が追い風、±135° 以上が向かい風（F-3）', () => {
  const heading = 90; // 東向き
  // 風の吹いていく向き = heading + rel。吹いてくる向きはその逆
  const from = relDeg => (heading + relDeg + 180) % 360;
  assert.equal(rel(from(45), 3, heading).cls, 'tail');
  assert.equal(rel(from(-45), 3, heading).cls, 'tail');
  assert.equal(rel(from(46), 3, heading).cls, 'cross');
  assert.equal(rel(from(134), 3, heading).cls, 'cross');
  assert.equal(rel(from(135), 3, heading).cls, 'head');
  assert.equal(rel(from(-135), 3, heading).cls, 'head');
  assert.equal(rel(from(180), 3, heading).cls, 'head');
});

test('方位の折り返し（359° と 1°）を正しく扱う', () => {
  const r = rel(181, 4, 359); // 北向き進行、ほぼ南からの風
  assert.equal(r.cls, 'tail');
  assert.ok(Math.abs(r.rel) < 3);
});

test('16 方位', () => {
  assert.equal(RW.wind.dir16(0), '北');
  assert.equal(RW.wind.dir16(359), '北');
  assert.equal(RW.wind.dir16(90), '東');
  assert.equal(RW.wind.dir16(225), '南西');
  assert.equal(RW.wind.dir16(-90), '西');
});
