import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RW, straightCourse, syntheticSeries, JST } from './_load.mjs';

const T0 = JST(2026, 9, 5, 0, 0);

test('buildUrl：/v1/jma、気象庁モデルのみ、地点はカンマ区切り', () => {
  const u = RW.forecast.buildUrl([{ lat: 35.1, lon: 139.2 }, { lat: 36.12346, lon: 138.9 }], 'msm', 0);
  assert.ok(u.startsWith('https://api.open-meteo.com/v1/jma?'));
  assert.ok(u.includes('latitude=35.1000,36.1235'));
  assert.ok(u.includes('models=jma_msm'));
  assert.ok(u.includes('forecast_days=4'));
  assert.ok(u.includes('wind_speed_unit=ms'));
  assert.ok(!u.includes('past_days'));
  const g = RW.forecast.buildUrl([{ lat: 35, lon: 139 }], 'gsm', 1);
  assert.ok(g.includes('models=jma_gsm') && g.includes('forecast_days=11') && g.includes('past_days=1'));
});

test('parseSeries：体感温度・日照が無い旧データでも at は落ちない', () => {
  const loc = { latitude: 35, longitude: 139, hourly: { time: ['2026-09-05T00:00', '2026-09-05T01:00'], temperature_2m: [20, 21], relative_humidity_2m: [50, 50], precipitation: [0, 0], weather_code: [1, 1], cloud_cover: [0, 0], wind_speed_10m: [1, 1], wind_direction_10m: [0, 0] } };
  const s = RW.forecast.parseSeries(loc)[0];
  const v = RW.forecast.at(s, T0 + 30 * 60e3);
  assert.equal(v.feel, null); assert.equal(v.sun, null); assert.equal(v.temp, 20.5);
  assert.ok(RW.forecast.buildUrl([{ lat: 35, lon: 139 }], 'msm').includes('apparent_temperature,'));
});

test('parseSeries：単一地点（オブジェクト）も複数地点（配列）も同じ形にする。null の末尾は validUntil で切る', () => {
  const loc = { latitude: 35, longitude: 139, hourly: { time: ['2026-09-05T00:00', '2026-09-05T01:00', '2026-09-05T02:00'], temperature_2m: [20, 21, null], relative_humidity_2m: [50, 50, null], precipitation: [0, 0.5, null], weather_code: [1, 61, null], cloud_cover: [10, 90, null], wind_speed_10m: [1, 2, null], wind_direction_10m: [350, 10, null] } };
  const one = RW.forecast.parseSeries(loc), two = RW.forecast.parseSeries([loc, loc]);
  assert.equal(one.length, 1); assert.equal(two.length, 2);
  assert.equal(one[0].times[0], T0);
  assert.equal(one[0].validUntil, T0 + 3600e3);
  assert.equal(RW.forecast.horizon(two), T0 + 3600e3);
});

test('at：線形補間。風向は円周補間、降水はその時刻を含む 1 時間の値、範囲外は null', () => {
  const s = syntheticSeries(1, T0, 4, (p, h) => ({ temp: 20 + h, mm: h, ws: h, wd: h === 0 ? 350 : 10 }))[0];
  const v = RW.forecast.at(s, T0 + 30 * 60e3);
  assert.ok(Math.abs(v.temp - 20.5) < 1e-9);
  assert.ok(Math.abs(v.feel - 19.5) < 1e-9, '体感温度も補間');
  assert.equal(v.sun, 1800, '日照時間はその時刻を含む 1 時間の値');
  assert.ok(Math.abs(v.wd - 0) < 1e-9, `風向 ${v.wd}`);
  assert.equal(v.mm, 1, '00:30 は 00:00–01:00 の降水（01:00 の値）');
  assert.equal(RW.forecast.at(s, T0 + 3 * 3600e3).temp, 23, '末尾ちょうど');
  assert.equal(RW.forecast.at(s, T0 + 3 * 3600e3 + 1), null);
  assert.equal(RW.forecast.at(s, T0 - 1), null);
});

test('pick：MSM があれば MSM、なければ GSM、どちらも無ければ null（F-8）', () => {
  const msm = syntheticSeries(1, T0, 24, () => ({ temp: 10, mm: 0, ws: 1, wd: 0 }));
  const gsm = syntheticSeries(1, T0, 72, () => ({ temp: 99, mm: 0, ws: 1, wd: 0 }));
  assert.equal(RW.forecast.pick({ msm, gsm }, 0, T0 + 5 * 3600e3).model, 'msm');
  assert.equal(RW.forecast.pick({ msm, gsm }, 0, T0 + 30 * 3600e3).model, 'gsm');
  assert.equal(RW.forecast.pick({ msm, gsm }, 0, T0 + 100 * 3600e3), null);
  assert.equal(RW.forecast.pick({ msm, gsm: null }, 0, T0 + 30 * 3600e3), null);
});

test('computeRide + summarize：南風の直線北上コースは全区間追い風、雨は 0', () => {
  const c = straightCourse(61, 10);
  const p = { start: new Date(JST(2026, 9, 5, 6)), spd: 20, sleeps: RW.plan.normSleeps([{ d: 300, m: 120 }], c.total) };
  const series = { msm: syntheticSeries(61, T0, 96, (pt, h) => ({ temp: 15 + (h % 24), mm: 0, ws: 4, wd: 180 })), gsm: null };
  const { S, step } = RW.forecast.computeRide(c, p, series);
  assert.equal(step, 10);
  assert.ok(S.every(s => !s.na));
  assert.ok(S.every(s => s.cls === 'tail'), '全て追い風');
  const sm = RW.forecast.summarize(S, step);
  assert.equal(sm.headKm, 0); assert.equal(sm.rainKm, 0);
  assert.ok(Math.abs(sm.goal.getTime() - (JST(2026, 9, 5, 6) + (30 + 2) * 3600e3)) < 1000, '600km/20km/h + 仮眠 2h（総距離の丸め誤差 1 秒以内）');
  assert.equal(sm.naFrom, null);
  assert.ok(S.some(s => s.night), '夜間帯を含む');
});

test('予報範囲外の地点は na になり、summarize が最初の範囲外距離を返す', () => {
  const c = straightCourse(61, 10);
  const p = { start: new Date(JST(2026, 9, 5, 6)), spd: 20, sleeps: [] };
  const series = { msm: syntheticSeries(61, T0, 20, () => ({ temp: 10, mm: 1, ws: 2, wd: 0 })), gsm: null };
  const { S, step } = RW.forecast.computeRide(c, p, series);
  const sm = RW.forecast.summarize(S, step);
  // 19:00 まで有効 → 6:00 出走・20km/h → 13h → 260km まで
  assert.equal(sm.naFrom, 270);
  assert.ok(sm.rainKm > 0);
});

test('trendAggregate：50 km 区間×通過日に集約し、卓越風向はベクトル平均', () => {
  const c = straightCourse(61, 10);
  const p = { start: new Date(JST(2026, 9, 5, 6)), spd: 25, sleeps: [] };
  const series = { msm: null, gsm: syntheticSeries(61, T0, 264, (pt, h) => ({ temp: 20, mm: 0.6, ws: 3, wd: pt < 30 ? 350 : 90 })) };
  const { S, step } = RW.forecast.computeRide(c, p, series);
  const rows = RW.forecast.trendAggregate(S, step, c.total, p.spd, 50);
  assert.ok(rows.length >= 12);
  assert.equal(rows[0].from, 0); assert.equal(rows[0].to, 50);
  assert.ok(rows[0].wdPrev > 340 || rows[0].wdPrev < 5);
  assert.ok(rows.every(r => r.models.includes('gsm')));
  assert.ok(Math.abs(rows[0].mmSum - 0.6 * (50 / 25)) < 1e-6, '降水量は mm/h × 滞在時間');
});

test('startComparison：±3 時間で 7 行', () => {
  const c = straightCourse(13, 10);
  const p = { start: new Date(JST(2026, 9, 5, 6)), spd: 20, sleeps: [] };
  const series = { msm: syntheticSeries(13, T0, 96, () => ({ temp: 10, mm: 0, ws: 1, wd: 0 })), gsm: null };
  const rows = RW.forecast.startComparison(c, p, series);
  assert.equal(rows.length, 7);
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map(r => r.off))), [-3, -2, -1, 0, 1, 2, 3]); // vm 別レルムなので JSON 経由で比較
});

test('wmoText と fmt', () => {
  assert.equal(RW.forecast.wmoText(61), '小雨');
  assert.equal(RW.forecast.wmoText(null), '—');
  assert.equal(RW.fmt.fmtT(JST(2026, 9, 6, 3, 5)), '9/6 03:05');
  assert.equal(RW.fmt.dateKey(JST(2026, 9, 6, 0, 0)), '9/6');
  assert.equal(RW.fmt.fmtDT(JST(2026, 9, 5, 6, 0)), '9/5(土) 06:00');
});

test('wxClass：雨は降水 0.5 mm/h 以上または雨系コード、曇りは曇・霧、晴れは快晴・晴', () => {
  const w = RW.forecast.wxClass;
  assert.equal(w({ code: 0, mm: 0 }), 'sun');
  assert.equal(w({ code: 1, mm: 0.4 }), 'sun');
  assert.equal(w({ code: 1, mm: 0.5 }), 'rain', '晴れコードでも降水があれば雨');
  assert.equal(w({ code: 2, mm: 0 }), 'cloud');
  assert.equal(w({ code: 3, mm: 0 }), 'cloud');
  assert.equal(w({ code: 45, mm: 0 }), 'cloud', '霧は曇り扱い');
  assert.equal(w({ code: 51, mm: 0 }), 'rain', '霧雨');
  assert.equal(w({ code: 61, mm: 0.1 }), 'rain');
  assert.equal(w({ code: 71, mm: 0 }), 'rain', '雪も雨系');
  assert.equal(w({ code: 95, mm: 0 }), 'rain', '雷雨');
  assert.equal(w({ na: true }), null);
  assert.equal(w(null), null);
});
