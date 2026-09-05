import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RW, JST } from './_load.mjs';

const minutesOff = (t, y, mo, d, h, mi) => Math.abs((+t - JST(y, mo, d, h, mi)) / 60e3);

test('碓氷峠 2026-09-05 の日の出・日の入り（Open-Meteo: 05:19 / 18:08）', () => {
  const s = RW.sun.sunTimes(new Date(JST(2026, 9, 5, 12)), 36.3457, 138.6511);
  assert.ok(minutesOff(s.sunrise, 2026, 9, 5, 5, 19) <= 3, `日の出 ${s.sunrise.toISOString()}`);
  assert.ok(minutesOff(s.sunset, 2026, 9, 5, 18, 8) <= 3, `日の入 ${s.sunset.toISOString()}`);
});

test('日付は JST の暦日で決まる（JST 深夜 0:30 も同じ日）', () => {
  const a = RW.sun.sunTimes(new Date(JST(2026, 9, 6, 0, 30)), 35.6, 139.7);
  const b = RW.sun.sunTimes(new Date(JST(2026, 9, 6, 23, 0)), 35.6, 139.7);
  assert.equal(+a.sunrise, +b.sunrise);
});

test('夜間判定', () => {
  assert.equal(RW.sun.isNight(new Date(JST(2026, 9, 5, 3, 0)), 35.6, 139.7), true);
  assert.equal(RW.sun.isNight(new Date(JST(2026, 9, 5, 12, 0)), 35.6, 139.7), false);
  assert.equal(RW.sun.isNight(new Date(JST(2026, 9, 5, 19, 0)), 35.6, 139.7), true);
  assert.equal(RW.sun.isNight(new Date(JST(2026, 9, 5, 5, 0)), 35.6, 139.7), true);
});
