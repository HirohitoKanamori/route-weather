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

test('OAuth のアクセストークンがあれば Bearer だけで転送する', async () => {
  let seen = null;
  const r = await withUpstream(async (u, init) => { seen = init.headers; return new Response('{"route":{}}', { status: 200 }); },
    () => call('/rwgps/routes/3', { headers: { Origin: ORIGIN } }, { ...env, RWGPS_ACCESS_TOKEN: ' at-1 ' }));
  assert.equal(r.status, 200); assert.equal(seen.authorization, 'Bearer at-1'); assert.equal(seen['x-rwgps-api-key'], undefined);
});

const envX = { ...env, RWGPS_CLIENT_ID: 'cid', RWGPS_CLIENT_SECRET: 'csec', OAUTH_REDIRECT_URI: 'https://route-weather.jp/' };
const post = (body, e = envX, origin = ORIGIN) => call('/oauth/exchange', { method: 'POST', headers: { Origin: origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }, e);

test('oauth/exchange：code に client_secret と redirect_uri を添えて token.json へ送り、トークンと利用者 ID だけ返す', async () => {
  let seen = null;
  const r = await withUpstream(async (u, init) => { seen = { u: String(u), body: JSON.parse(init.body), method: init.method }; return new Response(JSON.stringify({ access_token: 'AT', token_type: 'Bearer', scope: 'user', created_at: 1, user_id: 42 }), { status: 200 }); },
    () => post({ code: ' abc-123 ' }));
  assert.equal(seen.u, 'https://ridewithgps.com/oauth/token.json'); assert.equal(seen.method, 'POST');
  assert.deepEqual(seen.body, { grant_type: 'authorization_code', code: 'abc-123', client_id: 'cid', client_secret: 'csec', redirect_uri: 'https://route-weather.jp/' });
  assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  assert.deepEqual(await r.json(), { access_token: 'AT', user_id: 42, created_at: 1 });
});

test('oauth/exchange：上流の失敗はその状態と文言で返し、不正な code は 400、secret 未設定は 503、Origin 外は 403', async () => {
  const bad = await withUpstream(async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }), { status: 401 }), () => post({ code: 'abcd' }));
  assert.equal(bad.status, 401); assert.deepEqual(await bad.json(), { errors: ['expired'] });
  assert.equal((await post({ code: 'a b' })).status, 400); assert.equal((await post({})).status, 400);
  assert.equal((await post({ code: 'abcd' }, { ...env, RWGPS_CLIENT_ID: 'cid' })).status, 503);
  assert.equal((await post({ code: 'abcd' }, envX, 'https://evil.example')).status, 403);
  const pre = await call('/oauth/exchange', { method: 'OPTIONS', headers: { Origin: ORIGIN } }, envX);
  assert.equal(pre.status, 204); assert.match(pre.headers.get('access-control-allow-headers'), /content-type/);
});
