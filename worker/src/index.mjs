// Route-Weather.jp 中継（ADD_03）：Ride with GPS 公式 API v1 への転送だけを行う Cloudflare Worker。
// 役割は api_key と auth_token を端末に置かないことのみ。ルートの内容は保存・記録しない。
// GET /rwgps/routes/:id[?privacy_code=…] → https://ridewithgps.com/api/v1/routes/:id.json
// GET /health → ok
const DEFAULT_UPSTREAM = 'https://ridewithgps.com';
const DEFAULT_ORIGINS = 'https://route-weather.jp';

function allowedOrigins(env) { return String(env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(s => s.trim()).filter(Boolean); }
function json(status, body, extra) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(extra || {}) } });
}
function withCors(res, origin) {
  const h = new Headers(res.headers);
  h.set('access-control-allow-origin', origin); h.set('vary', 'Origin');
  h.set('access-control-allow-methods', 'GET, OPTIONS'); h.set('access-control-max-age', '600');
  return new Response(res.body, { status: res.status, headers: h });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const ok = allowedOrigins(env).includes(origin);
    if (url.pathname === '/health') return new Response('ok', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
    const m = url.pathname.match(/^\/rwgps\/routes\/(\d{1,12})$/);
    if (!m) return json(404, { errors: ['not found'] });
    if (req.method === 'OPTIONS') return ok ? withCors(new Response(null, { status: 204 }), origin) : json(403, { errors: ['origin not allowed'] });
    if (req.method !== 'GET') return json(405, { errors: ['method not allowed'] });
    if (!ok) return json(403, { errors: ['origin not allowed'] }); // ブラウザ以外（Origin 無し）からの利用も受けない
    // 公式 API はルート取得でも api_key と auth_token（API クライアント管理ページで作る、運用者アカウントのトークン）の両方が要る
    const apiKey = String(env.RWGPS_API_KEY || '').trim(), authToken = String(env.RWGPS_AUTH_TOKEN || '').trim(); // 貼り付け時の改行・空白を除く
    if (!apiKey || !authToken) return withCors(json(503, { errors: ['relay not configured'] }), origin);
    const up = new URL(`${env.UPSTREAM || DEFAULT_UPSTREAM}/api/v1/routes/${m[1]}.json`);
    const pc = url.searchParams.get('privacy_code'); if (pc && /^[A-Za-z0-9_-]{1,64}$/.test(pc)) up.searchParams.set('privacy_code', pc);
    // 同じルートの取り直しは 10 分キャッシュ（Cache API は独自ドメインでのみ有効。workers.dev では素通り）
    const cacheKey = new Request(up.toString(), { method: 'GET' });
    let cache = null; try { cache = typeof caches !== 'undefined' && caches.default ? caches.default : null; } catch (e) { cache = null; }
    let res = cache ? await cache.match(cacheKey) : null;
    if (!res) {
      let r;
      try { r = await fetch(up.toString(), { headers: { 'x-rwgps-api-key': apiKey, 'x-rwgps-auth-token': authToken, 'authorization': 'Basic ' + btoa(apiKey + ':' + authToken), 'accept': 'application/json', 'user-agent': 'route-weather.jp relay (+https://route-weather.jp/)' } }); }
      catch (e) { return withCors(json(502, { errors: ['upstream unreachable'] }), origin); }
      const body = await r.text();
      res = new Response(body, { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': r.ok ? 'public, max-age=600' : 'no-store' } });
      if (r.ok && cache && ctx && ctx.waitUntil) { try { ctx.waitUntil(cache.put(cacheKey, res.clone())); } catch (e) { /* noop */ } }
    }
    return withCors(res, origin);
  }
};
