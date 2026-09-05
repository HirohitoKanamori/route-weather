import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RW, straightCourse, JST } from './_load.mjs';

const start = new Date(JST(2026, 9, 5, 6, 0));

test('仮眠なし：経過時間は距離／速度', () => {
  const p = { start, spd: 20, sleeps: [], segments: [] };
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

test('区間別速度（P-4）：指定区間はその速度、他はグロス速度。重なりは先の区間を優先', () => {
  const segs = RW.plan.normSegments([{ from: 300, to: 200, spd: 10 }, { from: 100, to: 200, spd: 10 }, { from: 150, to: 250, spd: 5 }, { from: 400, to: 900, spd: 40 }], 600);
  assert.deepEqual(JSON.parse(JSON.stringify(segs)), [{ from: 100, to: 200, spd: 10 }, { from: 400, to: 600, spd: 40 }]);
  const p = { start, spd: 20, sleeps: [], segments: segs };
  assert.equal(RW.plan.rideHours(50, p), 2.5);
  assert.equal(RW.plan.rideHours(150, p), 5 + 5);
  assert.equal(RW.plan.rideHours(300, p), 5 + 10 + 5);
  assert.equal(RW.plan.rideHours(600, p), 5 + 10 + 10 + 5);
  assert.equal(RW.plan.elapsedH(600, { ...p, sleeps: [{ d: 250, m: 60 }] }), 31);
});

test('走行中の再計算（P-5）：現在地点より先は現在時刻を起点に、手前は元の予定のまま', () => {
  const p = { start, spd: 20, sleeps: RW.plan.normSleeps([{ d: 300, m: 60 }], 600), segments: [], anchor: { d: 200, t: new Date(JST(2026, 9, 5, 18, 0)) } };
  // 予定では 200 km は 16:00 だが、実際は 18:00（2 時間遅れ）
  assert.equal(RW.plan.timeAt(100, p).getTime(), JST(2026, 9, 5, 11, 0), '手前は元の予定');
  assert.equal(RW.plan.timeAt(200, p).getTime(), JST(2026, 9, 5, 18, 0));
  assert.equal(RW.plan.timeAt(300, p, true).getTime(), JST(2026, 9, 5, 23, 0), '仮眠到着');
  assert.equal(RW.plan.timeAt(300, p).getTime(), JST(2026, 9, 6, 0, 0), '仮眠出発');
  assert.equal(RW.plan.timeAt(600, p).getTime(), JST(2026, 9, 6, 15, 0));
  // 現在地点が仮眠地点そのもののとき：到着＝現在時刻、出発＝現在時刻＋仮眠
  const q = { ...p, anchor: { d: 300, t: new Date(JST(2026, 9, 5, 22, 0)) } };
  assert.equal(RW.plan.timeAt(300, q, true).getTime(), JST(2026, 9, 5, 22, 0));
  assert.equal(RW.plan.timeAt(300, q).getTime(), JST(2026, 9, 5, 23, 0));
});

test('hourTicks：正時ごとの目盛。仮眠中の正時は sleep=true で距離が進まない', () => {
  const c = straightCourse(13, 10);
  const p = { start: new Date(JST(2026, 9, 5, 6, 30)), spd: 20, sleeps: RW.plan.normSleeps([{ d: 60, m: 120 }], c.total), segments: [] };
  const S = RW.plan.samplePoints(c, p, 10);
  const ticks = RW.plan.hourTicks(RW.plan.timeNodes(S, p));
  assert.equal(ticks[0].t, JST(2026, 9, 5, 7, 0));
  assert.ok(Math.abs(ticks[0].d - 10) < 1e-6, '06:30 出走・20 km/h → 07:00 は 10 km');
  const sleepTicks = ticks.filter(t => t.sleep);
  assert.equal(sleepTicks.length, 2, '09:30〜11:30 の仮眠中に 10:00 と 11:00');
  assert.ok(sleepTicks.every(t => Math.abs(t.d - 60) < 1e-6));
  const last = ticks[ticks.length - 1];
  assert.ok(last.t <= +S[S.length - 1].t && last.d <= c.total + 1e-6);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].t > ticks[i - 1].t && ticks[i].d >= ticks[i - 1].d - 1e-9, '時刻・距離とも単調');
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
