import test from 'node:test';
import assert from 'node:assert/strict';
import { RW } from './_load.mjs';

test('parseUrl：URL 単体・共有文・privacy_code・編集画面の URL から番号を取り出す', () => {
  assert.deepEqual(RW.rwgps.parseUrl('https://ridewithgps.com/routes/12345678'), { id: '12345678', privacyCode: null });
  assert.deepEqual(RW.rwgps.parseUrl('https://ridewithgps.com/routes/12345678/'), { id: '12345678', privacyCode: null });
  assert.deepEqual(RW.rwgps.parseUrl('https://ridewithgps.com/routes/12345678/edit'), { id: '12345678', privacyCode: null });
  assert.deepEqual(RW.rwgps.parseUrl('http://RideWithGPS.com/routes/42?privacy_code=AbC-9_z'), { id: '42', privacyCode: 'AbC-9_z' });
  assert.deepEqual(RW.rwgps.parseUrl('ワンイチのルートです https://ridewithgps.com/routes/777?privacy_code=xyz&utm=1 よろしく'), { id: '777', privacyCode: 'xyz' });
  assert.equal(RW.rwgps.parseUrl('https://ridewithgps.com/trips/12345678'), null);
  assert.equal(RW.rwgps.parseUrl(''), null);
  assert.equal(RW.rwgps.parseUrl(null), null);
});

test('toCourse：track_points（x=経度, y=緯度, e=標高）を既存のコース構造にする', () => {
  const pts = [];
  for (let i = 0; i < 5; i++) pts.push({ x: 139.0, y: 35.0 + i * 0.01, e: 10 + i * 5, d: i * 1111.95 });
  const c = RW.rwgps.toCourse({ route: { id: 99, name: 'テスト', track_points: pts } });
  assert.equal(c.name, 'テスト');
  assert.equal(c.pts[0].lat, 35.0); assert.equal(c.pts[0].lon, 139.0); assert.equal(c.pts[0].ele, 10);
  assert.ok(Math.abs(c.total - 4.448) < 0.01, 'total km = ' + c.total); // 0.04° 緯度 ≒ 4.45 km
  assert.equal(c.hasEle, true); assert.equal(c.gain, 20);
  assert.deepEqual(c.source, { kind: 'rwgps', id: '99', url: 'https://ridewithgps.com/routes/99' });
  assert.equal(c.n, 5);
});

test('toCourse：標高なし・route 包み無し・点不足', () => {
  const c = RW.rwgps.toCourse({ track_points: [{ x: 139, y: 35 }, { x: 139.01, y: 35 }] });
  assert.equal(c.hasEle, false); assert.equal(c.name, 'Ride with GPS のルート'); assert.equal(c.source, undefined);
  assert.throws(() => RW.rwgps.toCourse({ route: { track_points: [{ x: 139, y: 35 }] } }), /track_points/);
  assert.throws(() => RW.rwgps.toCourse({ route: {} }), /track_points/);
  assert.throws(() => RW.rwgps.toCourse(null), /track_points/);
});
