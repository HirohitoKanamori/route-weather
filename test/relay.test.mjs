// 中継 Worker（worker/src/index.mjs）の振る舞い。fetch を差し替えて RwGPS には接続しない
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.mjs';

const ORIGIN = 'https://route-weather.jp';
const env = { RWGPS_API_KEY: 'k-test\n', RWGPS_AUTH_TOKEN: ' t-test ', ALLOWED_ORIGINS: ORIGIN + ',http://localhost:8766' };
const call = (path, init = {}, e = env) => worker.fetch(new Request('https://relay.example' + path, init), e, { waitUntil() {} });
const withUpstream = async (handler, fn) => { const orig = globalThis.fetch; globalThis.fetch = handler; try { return await fn(); } finally { globalThis.fetch = orig; } };

test('health は誰でも見られる', async () => { const r = await call('/health'); assert.equal(r.status, 200); assert.equal(await r.text(), 'ok'); });

test('Origin が許可外・無しなら 403、経路外は 404、GET 以外は 405', async () => {
  assert.equal((await call('/rwgps/routes/1')).status, 403);
  assert.equal((await call('/rwgps/routes/1', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/other', { headers: { Origin: ORIGIN } })).status, 404);
  assert.equal((await call('/rwgps/routes/abc', { headers: { Origin: ORIGIN } })).status, 404);
  assert.equal((await call('/rwgps/routes/1', { method: 'POST', headers: { Origin: ORIGIN } })).status, 405);
});

test('プリフライトは許可 Origin にだけ 204 と CORS ヘッダー', async () => {
  const r = await call('/rwgps/routes/1', { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
});

test('鍵を付けて公式 API に転送し、privacy_code を引き継ぎ、本文と状態をそのまま返す', async () => {
  let seen = null;
  const r = await withUpstream(async (u, init) => { seen = { u: String(u), h: init.headers }; return new Response('{"route":{"id":1,"track_points":[]}}', { status: 200 }); },
    () => call('/rwgps/routes/1?privacy_code=Ab-9_x&junk=1', { headers: { Origin: 'http://localhost:8766' } }));
  assert.equal(seen.u, 'https://ridewithgps.com/api/v1/routes/1.json?privacy_code=Ab-9_x');
  assert.equal(seen.h['x-rwgps-api-key'], 'k-test'); assert.equal(seen.h['x-rwgps-auth-token'], 't-test'); assert.equal(seen.h['authorization'], 'Basic ' + Buffer.from('k-test:t-test').toString('base64'));
  assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:8766');
  assert.deepEqual(await r.json(), { route: { id: 1, track_points: [] } });
});

test('上流の 403／404 はそのまま、接続失敗は 502、鍵・トークン未設定は 503', async () => {
  const st = async code => (await withUpstream(async () => new Response('{"errors":["x"]}', { status: code }), () => call('/rwgps/routes/2', { headers: { Origin: ORIGIN } }))).status;
  assert.equal(await st(403), 403); assert.equal(await st(404), 404);
  const bad = await withUpstream(async () => { throw new Error('down'); }, () => call('/rwgps/routes/2', { headers: { Origin: ORIGIN } }));
  assert.equal(bad.status, 502);
  assert.equal((await call('/rwgps/routes/2', { headers: { Origin: ORIGIN } }, { ALLOWED_ORIGINS: ORIGIN })).status, 503);
  assert.equal((await call('/rwgps/routes/2', { headers: { Origin: ORIGIN } }, { ALLOWED_ORIGINS: ORIGIN, RWGPS_API_KEY: 'k' })).status, 503);
});
