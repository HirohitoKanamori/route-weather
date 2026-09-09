// 2026-09-10 の Codex レビュー指摘に対する回帰テスト（core の範囲）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RW, straightCourse, JST } from './_load.mjs';

const start = new Date(JST(2026, 9, 10, 6, 0));

test('指摘 7：重なった速度区間は採用済みの末尾と比べる（有効な区間を消さない）', () => {
  const segs = RW.plan.normSegments([{ from: 0, to: 100, spd: 10 }, { from: 10, to: 180, spd: 5 }, { from: 120, to: 150, spd: 5 }], 200);
  assert.deepEqual(JSON.parse(JSON.stringify(segs)), [{ from: 0, to: 100, spd: 10 }, { from: 120, to: 150, spd: 5 }]);
});

test('指摘 5：距離の集計はサンプル間の実距離。現在地とゴールで切り詰める', () => {
  const S = [...Array.from({ length: 32 }, (_, i) => i * 10), 310.1].map(d => ({ d, t: new Date(+start + d / 20 * 3600e3), eh: d / 20, na: false, mm: 1, ws: 5, wd: 0, temp: 20, cls: 'head', night: true, model: 'gsm' }));
  const all = RW.forecast.summarize(S, 10);
  assert.ok(Math.abs(all.rainKm - 310.1) < 1e-6 && Math.abs(all.headKm - 310.1) < 1e-6 && Math.abs(all.nightKm - 310.1) < 1e-6, JSON.stringify([all.rainKm, all.headKm, all.nightKm]));
  const rest = RW.forecast.summarize(S, 10, 309);
  assert.ok(Math.abs(rest.rainKm - 1.1) < 1e-6, `残り 1.1 km のはずが ${rest.rainKm}`);
  const tr = RW.forecast.trendAggregate(S, 10, 310.1, 20);
  const headSum = tr.reduce((n, r) => n + r.headKm, 0);
  assert.ok(Math.abs(headSum - 310.1) < 1e-6, `傾向表の向かい風合計 ${headSum}`);
});

test('指摘 6：傾向表の降水量は実際の走行時間 × 降水強度（区間別速度を反映、ゴールには加算しない）', () => {
  const S = [0, 2.5, 5, 7.5, 10].map(d => ({ d, t: new Date(+start + d / 10 * 3600e3), eh: d / 10, na: false, mm: 1, ws: 5, wd: 0, temp: 20, cls: 'head', night: false, model: 'gsm' }));
  const p = { start, spd: 20, sleeps: [], segments: RW.plan.normSegments([{ from: 0, to: 10, spd: 10 }], 10), anchor: null };
  const rows = RW.forecast.trendAggregate(S, 2.5, 10, 20, 50, p);
  assert.ok(Math.abs(rows[0].mmSum - 1) < 1e-9, `10 km を 10 km/h で 1 時間、1 mm/h → 1 mm のはずが ${rows[0].mmSum}`);
  assert.ok(Math.abs(RW.forecast.trendAggregate(S, 2.5, 10, 20)[0].mmSum - 0.5) < 1e-9, 'p なしはグロス速度（20 km/h → 0.5 時間）');
});

test('指摘 8：欠測は 0 にせず null のまま。風の欠測は分類しない', () => {
  const t = JST(2026, 9, 10, 0, 0);
  const s = RW.forecast.parseSeries({ hourly: { time: ['2026-09-10T00:00', '2026-09-10T01:00'], temperature_2m: [20, 20], weather_code: [1, 1], precipitation: [null, null], wind_speed_10m: [null, null], wind_direction_10m: [null, null] } })[0];
  const v = RW.forecast.at(s, t);
  assert.equal(v.mm, null); assert.equal(v.ws, null); assert.equal(v.wd, null); assert.equal(v.rh, null);
  const c = straightCourse(3, 10);
  const series = { msm: [s, s, s], gsm: null };
  const { S } = RW.forecast.computeRide(c, { start: new Date(t), spd: 20, sleeps: [], segments: [] }, series);
  assert.equal(S[0].cls, null); assert.equal(S[0].comp, null);
  const sm = RW.forecast.summarize(S, 10);
  assert.equal(sm.headKm, 0); assert.equal(sm.rainKm, 0); assert.equal(sm.wsMax, null);
  assert.equal(RW.forecast.wxClass(S[0]), 'sun', '降水量が無ければ天気コードで分類（コード 1＝晴）');
});

test('指摘 4：出走時刻の比較は nOk と n を持ち、予報の無い候補を見分けられる', () => {
  const c = straightCourse(3, 10);
  const rows = RW.forecast.startComparison(c, { start, spd: 20, sleeps: [], segments: [] }, { msm: [], gsm: null });
  assert.ok(rows.every(r => r.nOk === 0 && r.n > 0), JSON.stringify(rows.map(r => [r.nOk, r.n])));
});
