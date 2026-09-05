import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RW, straightCourse, JST } from './_load.mjs';

const start = new Date(JST(2026, 9, 5, 6, 0));

test('仮眠なし：経過時間は距離／速度', () => {
  const p = { start, spd: 20, sleeps: [] };
  assert.equal(RW.plan.elapsedH(100, p), 5);
  assert.equal(RW.plan.timeAt(100, p).getTime(), JST(2026, 9, 5, 11, 0));
});

test('仮眠あり：仮眠地点以降は仮眠時間ぶん遅れる（到着は含まず、出発は含む）', () => {
  const p = { start, spd: 20, sleeps: RW.plan.normSleeps([{ d: 200, m: 120 }, { d: 100, m: 30 }], 600) };
  assert.deepEqual(JSON.parse(JSON.stringify(p.sleeps.map(s => s.d))), [100, 200], '距離順に並ぶ');
  assert.equal(RW.plan.elapsedH(50, p), 2.5);
  assert.equal(RW.plan.elapsedH(100, p, true), 5, '仮眠1 到着');
  assert.equal(RW.plan.elapsedH(100, p), 5.5, '仮眠1 出発');
  assert.equal(RW.plan.elapsedH(200, p, true), 10.5);
  assert.equal(RW.plan.elapsedH(200, p), 12.5);
  assert.equal(RW.plan.elapsedH(600, p), 32.5);
});

test('normSleeps：範囲外・0 分は捨てる', () => {
  const s = RW.plan.normSleeps([{ d: 0, m: 60 }, { d: 700, m: 60 }, { d: 300, m: 0 }, { d: 300, m: 90 }], 600);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), [{ d: 300, m: 90 }]); // vm 別レルムなので JSON 経由で比較
});

test('distAtElapsed は elapsedH の逆関数。仮眠中は null', () => {
  const p = { start, spd: 20, sleeps: RW.plan.normSleeps([{ d: 100, m: 60 }], 600) };
  for (const d of [0, 10, 99.9, 100, 250, 600]) {
    const h = RW.plan.elapsedH(d, p);
    assert.ok(Math.abs(RW.plan.distAtElapsed(h, p, 600) - d) < 1e-6, `d=${d}`);
  }
  assert.equal(RW.plan.distAtElapsed(5.5, p, 600), null, '仮眠中');
  assert.equal(RW.plan.distAtElapsed(40, p, 600), null, 'ゴール後');
});

test('サンプル間隔は総距離で決まる（F-1）', () => {
  assert.equal(RW.plan.sampleStep(600), 10);
  assert.equal(RW.plan.sampleStep(300), 5);
  assert.equal(RW.plan.sampleStep(200), 5);
  assert.equal(RW.plan.sampleStep(120), 2.5);
});

test('samplePoints：0 km とゴールを必ず含み、方位は北向き', () => {
  const c = straightCourse(61, 10);
  const S = RW.plan.samplePoints(c, { start, spd: 20, sleeps: [] }, 10);
  assert.equal(S[0].d, 0);
  assert.ok(Math.abs(S[S.length - 1].d - c.total) < 1e-9);
  assert.equal(S.length, 61);
  for (const s of S) assert.ok(s.hb < 1 || s.hb > 359, `方位 ${s.hb}`);
});
