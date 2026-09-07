import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RW, straightCourse, JST } from './_load.mjs';

const start = new Date(JST(2026, 9, 7, 6, 0));
const KM_PER_DEG = 111.195;
// 南→北の直線コース（10 km × 60）。lat0=35, lon=139
const c = straightCourse(61, 10);
const east = (km, lat = 35) => 139 + km / (KM_PER_DEG * Math.cos(lat * Math.PI / 180));

test('テスト 1：コース上の 1 点 → 候補 1 つ、距離が合う', () => {
  const lat = 35 + 30 / KM_PER_DEG; // 30 km 地点
  const loc = RW.locate.locateOnCourse(c, lat, east(0.2, lat)); // 200 m 東
  assert.equal(loc.candidates.length, 1);
  assert.ok(Math.abs(loc.candidates[0].d - 30) < 0.05, `d=${loc.candidates[0].d}`);
  assert.ok(Math.abs(loc.candidates[0].distM - 200) < 5, `dist=${loc.candidates[0].distM}`);
  const ch = RW.locate.chooseCandidate(loc.candidates, { prev: null, now: +start, spd: 20, plannedD: 0 });
  assert.equal(ch.kind, 'pick'); assert.equal(ch.by, 'single');
});

test('テスト 2：コースから 3 km 離れた点 → 候補なし、最寄り距離は約 3,000 m', () => {
  const lat = 35 + 30 / KM_PER_DEG;
  const loc = RW.locate.locateOnCourse(c, lat, east(3, lat));
  assert.equal(loc.candidates.length, 0);
  assert.ok(Math.abs(loc.nearest.distM - 3000) < 20, `nearest=${loc.nearest.distM}`);
  assert.equal(RW.locate.chooseCandidate(loc.candidates, { prev: null, now: +start, spd: 20, plannedD: 30 }).kind, 'none');
});

test('テスト 3：往復コースの重複区間 → 候補 2 つ。前回位置があれば絞れ、無ければ利用者に聞く', () => {
  // 北へ 50 km 行って同じ道を戻る（総距離 100 km）
  const raw = []; for (let i = 0; i <= 500; i++) raw.push({ lat: 35 + i * 0.1 / KM_PER_DEG, lon: 139 });
  for (let i = 499; i >= 0; i--) raw.push({ lat: 35 + i * 0.1 / KM_PER_DEG, lon: 139 });
  const ob = RW.course.fromPoints(raw, '往復');
  assert.ok(Math.abs(ob.total - 100) < 0.01);
  const lat = 35 + 20 / KM_PER_DEG; // 往路 20 km ＝ 復路 80 km の地点
  const loc = RW.locate.locateOnCourse(ob, lat, east(0.1, lat));
  assert.equal(loc.candidates.length, 2, JSON.stringify(loc.candidates));
  const ds = loc.candidates.map(x => x.d).sort((a, b) => a - b);
  assert.ok(Math.abs(ds[0] - 20) < 0.2 && Math.abs(ds[1] - 80) < 0.2, `候補 ${ds}`);
  // (c) 前回位置なし・候補が 20 km 以上離れている → 聞く
  const ask = RW.locate.chooseCandidate(loc.candidates, { prev: null, now: +start + 1 * 3600e3, spd: 20, plannedD: 20 });
  assert.equal(ask.kind, 'ask'); assert.deepEqual(JSON.parse(JSON.stringify(ask.cands.map(x => Math.round(x.d)))), [20, 80]);
  // (a) 1 時間前に 15 km にいた（20 km/h × 1.5 → 30 km 以内）→ 20 km を選ぶ
  const a1 = RW.locate.chooseCandidate(loc.candidates, { prev: { d: 15, t: +start }, now: +start + 3600e3, spd: 20, plannedD: 20 });
  assert.equal(a1.kind, 'pick'); assert.ok(Math.abs(a1.cand.d - 20) < 0.2); assert.equal(a1.by, 'prev');
  // (a) 30 分前に 70 km にいた → 80 km を選ぶ
  const a2 = RW.locate.chooseCandidate(loc.candidates, { prev: { d: 70, t: +start }, now: +start + 1800e3, spd: 20, plannedD: 20 });
  assert.equal(a2.kind, 'pick'); assert.ok(Math.abs(a2.cand.d - 80) < 0.2);
  // (b) 候補が 20 km 未満しか離れていなければ、計画上の距離に近い方を自動で選ぶ
  const near = [{ d: 40, distM: 100 }, { d: 55, distM: 120 }];
  assert.ok(Math.abs(RW.locate.chooseCandidate(near, { prev: null, now: +start, spd: 20, plannedD: 52 }).cand.d - 55) < 1e-9);
});

test('distAtTime は timeAt の逆関数（仮眠中はその地点）', () => {
  const p = { start, spd: 20, sleeps: RW.plan.normSleeps([{ d: 100, m: 60 }], c.total), segments: [], anchor: null };
  for (const d of [0, 10, 99, 100, 250, c.total]) assert.ok(Math.abs(RW.plan.distAtTime(c, p, RW.plan.timeAt(d, p)) - d) < 1e-3, `d=${d}`);
  assert.ok(Math.abs(RW.plan.distAtTime(c, p, +start + 5.5 * 3600e3) - 100) < 1e-3, '仮眠中');
  assert.equal(RW.plan.distAtTime(c, p, +start - 1), 0);
  assert.equal(RW.plan.distAtTime(c, p, +start + 100 * 3600e3), c.total);
});

test('geo：反転しても点列と距離が対応する', () => {
  assert.ok(c.geo && c.geo.length >= 2 && c.geo[c.geo.length - 1].d === c.total);
  const r = RW.course.reverseCourse(c);
  assert.equal(r.geo.length, c.geo.length); assert.equal(r.geo[0].d, 0);
  assert.ok(Math.abs(r.geo[0].lat - c.geo[c.geo.length - 1].lat) < 1e-12);
});
