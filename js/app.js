// Route-Weather.jp — 画面・入力・ネットワーク（ui / view / 取得層）
import { RW } from './core.js?v=3.0.1'; // 版を付けて、公開直後に新しい app.js と古い core.js（HTTP キャッシュ）が混ざらないようにする
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const F = RW.fmt, M = RW.const.MODELS, RAIN_MM = RW.const.RAIN_MM;
  const REL = { head: '向かい', tail: '追い', cross: '横' };
  const COL = { head: 'var(--head)', tail: 'var(--tail)', cross: 'var(--cross)' };
  const CACHE_MS = 30 * 60e3;
  const PAST_DAYS_MAX = RW.const.START_BACK_DAYS + 1; // 予報取得の過去日数。出走日時の下限（4 日前）を覆う
  // Ride with GPS 連携（ADD_03）：公式 API v1 への転送だけを行う中継（Cloudflare Workers）の URL。
  // 未設定（空）なら機能を案内文だけにする。確認用に ?relay=http://localhost:8787 で差し替えられる
  const RWGPS_RELAY = 'https://api.route-weather.jp'; // v1.5.4 から独自ドメイン（旧：route-weather-relay.route-weather.workers.dev）
  // Stage 2（OAuth）：client_id は秘密ではない（authorize の URL に載る値）。redirect_uri は API クライアントに登録した値と一致させる。
  // トークンは端末内（rw:rwgps）にのみ保持し、Ride with GPS の API 呼び出し以外には送らない
  const RWGPS_CLIENT_ID = 'utYdUEU0XPHVePXnKqqhDc7Aw_yxD4AK4hoif9SQTgA';
  const RWGPS_REDIRECT = 'https://route-weather.jp/';
  const RWGPS_API = 'https://ridewithgps.com';
  const state = { course: null, series: null, result: null, busy: false, offlineNote: '', lastPos: null, forecastStale: '', posTarget: 'gpsMsg', startNote: '', sheet: 'peek', active: null, open: new Set() };

  // localStorage は私的ブラウズ等で例外になるので必ず握りつぶす
  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* noop */ } }
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n1 = v => v.toFixed(1);
  const nv = (v, d = 1) => (v == null || Number.isNaN(v)) ? '—' : v.toFixed(d); // 欠測は「—」

  // ===== 設定欄 =====
  function addSleepRow(d = '', m = '') {
    const row = document.createElement('div'); row.className = 'sleep';
    row.innerHTML = '<input type="number" class="sd" inputmode="decimal" min="0" step="1" placeholder="km" aria-label="仮眠 距離 km">' +
      '<input type="number" class="sm" inputmode="numeric" min="0" step="10" placeholder="分" aria-label="仮眠 時間 分">' +
      '<button type="button" class="btn rm" aria-label="この仮眠を削除">−</button>';
    row.querySelector('.sd').value = d; row.querySelector('.sm').value = m;
    row.querySelector('.rm').addEventListener('click', () => { row.remove(); onParamChange(); });
    row.querySelectorAll('input').forEach(i => i.addEventListener('change', onParamChange));
    $('sleeps').appendChild(row);
    return row;
  }
  function readSleeps() {
    return [...document.querySelectorAll('#sleeps .sleep')].map(r => ({ d: +r.querySelector('.sd').value, m: +r.querySelector('.sm').value }));
  }
  function addSegRow(from = '', to = '', spd = '') {
    const row = document.createElement('div'); row.className = 'seg';
    row.innerHTML = '<input type="number" class="sf" inputmode="decimal" min="0" step="1" placeholder="開始 km" aria-label="区間の開始 km">' +
      '<input type="number" class="st" inputmode="decimal" min="0" step="1" placeholder="終了 km" aria-label="区間の終了 km">' +
      '<input type="number" class="ss" inputmode="decimal" min="1" step="0.5" placeholder="km/h" aria-label="区間の速度 km/h">' +
      '<button type="button" class="btn rm" aria-label="この区間を削除">−</button>';
    row.querySelector('.sf').value = from; row.querySelector('.st').value = to; row.querySelector('.ss').value = spd;
    row.querySelector('.rm').addEventListener('click', () => { row.remove(); onParamChange(); });
    row.querySelectorAll('input').forEach(i => i.addEventListener('change', onParamChange));
    $('segRows').appendChild(row);
    return row;
  }
  function readSegs() {
    return [...document.querySelectorAll('#segRows .seg')].map(r => ({ from: +r.querySelector('.sf').value, to: +r.querySelector('.st').value, spd: +r.querySelector('.ss').value }));
  }
  function readAnchor() {
    const d = +$('ancD').value, t = $('ancT').value;
    if (!(d >= 0) || !$('ancD').value || !t) return null;
    const tt = new Date(t + ':00+09:00'); if (isNaN(+tt)) return null;
    return { d, t: tt };
  }
  function params() {
    const date = $('date').value, time = $('time').value || '06:00';
    const start = new Date(date + 'T' + time + ':00+09:00');
    const spd = Math.min(60, Math.max(5, +$('spd').value || 18));
    const total = state.course ? state.course.total : Infinity;
    const anchor = readAnchor();
    const done = doneSleeps(); // R-17 で「仮眠しない」とした地点
    return { start, spd, sleeps: RW.plan.normSleeps(readSleeps().filter(x => !done.includes(+x.d)), total), segments: RW.plan.normSegments(readSegs(), total),
      anchor: anchor && anchor.d < total ? anchor : null };
  }
  function saveParams() {
    store.set('rw:params', { date: $('date').value, time: $('time').value, spd: $('spd').value, sleeps: readSleeps(), segs: readSegs(), ancD: $('ancD').value, ancT: $('ancT').value });
  }
  function loadParams() {
    const s = store.get('rw:params') || {};
    // 初期値は「現在時刻より先にある最も近い 06:00」。保存値が下限（前日 0:00）より過去なら初期値に戻す
    const nx = F.nextStart(Date.now());
    const savedMs = s.date ? Date.parse(s.date + 'T' + (s.time || '06:00') + ':00+09:00') : NaN;
    const past = !(savedMs >= F.minStart(Date.now()));
    $('date').value = past ? nx.date : s.date;
    $('time').value = past ? nx.time : (s.time || '06:00');
    $('date').min = F.ymd(F.minStart(Date.now()));
    $('spd').value = s.spd || 18;
    $('sleeps').innerHTML = '';
    (s.sleeps || []).forEach(x => addSleepRow(x.d, x.m));
    $('segRows').innerHTML = '';
    (s.segs || []).forEach(x => addSegRow(x.from, x.to, x.spd));
    // 現在地点の再計算は 1 日以上前のものなら捨てる
    const ancOld = s.ancT && (Date.parse(s.ancT + ':00+09:00') < Date.now() - 86400e3);
    $('ancD').value = (s.ancD && !ancOld) ? s.ancD : '';
    $('ancT').value = (s.ancT && !ancOld) ? s.ancT : '';
  }
  function localDT(t) { const x = F.jstParts(t); const p2 = n => String(n).padStart(2, '0'); return x.y + '-' + p2(x.mo) + '-' + p2(x.d) + 'T' + p2(x.h) + ':' + p2(x.mi); }
  // 走行計画の札（v2 段階 3）。押すと編集欄を開いてその項目へ
  function renderPlanChips(p) {
    const el = $('planChips'); if (!state.course || !p) { el.classList.add('hidden'); return; }
    const sleepMin = p.sleeps.reduce((a, x) => a + x.m, 0);
    const chips = [['date', `${F.fmtDT(p.start)} 出走`], ['spd', `${p.spd} km/h`], ['addSleep', p.sleeps.length ? `仮眠 ${p.sleeps.length} 回・${sleepMin} 分` : '仮眠なし']];
    if (p.segments.length) chips.push(['addSeg', `区間速度 ${p.segments.length}`]);
    el.innerHTML = chips.map(([f, t]) => `<button type="button" class="chip" data-focus="${f}">${esc(t)}</button>`).join('');
    el.classList.remove('hidden');
  }
  const isMap = () => document.documentElement.classList.contains('mapMode');
  function openEditor(focusId) {
    if (isMap()) openPlan();
    const el = focusId && $(focusId);
    setTimeout(() => { try { if (!el) return; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (el.tagName === 'INPUT') el.focus({ preventScroll: true }); } catch (e) { /* noop */ } }, 50);
  }
  // コースの読み込み：未読み込みなら画面に置き、読み込み後は「コースを変更」で開くシートにする
  const lockScroll = on => { if (isMap()) return; document.documentElement.classList.toggle('noScroll', on); document.body.classList.toggle('noScroll', on); };
  function openLoad() { if (!state.course) return; $('settings').classList.remove('open'); $('loadBox').classList.add('open'); $('sheetBack').classList.remove('hidden'); lockScroll(true); }
  function closeLoad() { $('loadBox').classList.remove('open'); $('loadStatus').textContent = ''; if (!$('settings').classList.contains('open')) { $('sheetBack').classList.add('hidden'); lockScroll(false); } }
  // v3：地図の画面では、走行計画は上の札から開くシート
  function openPlan() { if (!isMap()) return; $('loadBox').classList.remove('open'); $('settings').classList.add('open'); $('sheetBack').classList.remove('hidden'); }
  function closePlan() { $('settings').classList.remove('open'); if (!$('loadBox').classList.contains('open')) $('sheetBack').classList.add('hidden'); }
  function updateSumLine(p) {
    renderPlanChips(p);
    const c = state.course; if (!c) return;
    const sleepMin = p.sleeps.reduce((a, x) => a + x.m, 0);
    $('pillName').textContent = c.name;
    $('pillPlan').textContent = [`${F.fmtDT(p.start)} 出走`, `${p.spd} km/h`, p.sleeps.length ? `仮眠 ${p.sleeps.length} 回・${sleepMin} 分` : '仮眠なし', p.segments.length ? `区間速度 ${p.segments.length}` : '', p.anchor ? `現在地 ${Math.round(p.anchor.d)} km` : ''].filter(Boolean).join('　');
  }
  function setStatus(msg, cls) {
    for (const id of ['status', 'loadStatus', 'sheetStatus']) { const el = $(id); el.textContent = id === 'loadStatus' && !$('loadBox').classList.contains('open') ? '' : (msg || ''); el.className = 'status' + (cls ? ' ' + cls : ''); }
  }
  function renderCourse() {
    const c = state.course;
    $('layout').classList.toggle('hasCourse', !!c); $('courseBar').classList.toggle('hidden', !c);
    if (!c) { $('planChips').classList.add('hidden'); return; }
    $('cbName').textContent = c.name;
    $('cbMeta').textContent = `${n1(c.total)} km ・ 獲得標高 ${c.hasEle ? c.gain.toLocaleString() + ' m' : '不明'}${c.source && c.source.kind === 'rwgps' ? ' ・ Ride with GPS' : ''}`;
    $('cName').textContent = c.name; $('scName').textContent = c.name;
    $('scMeta').textContent = $('cbMeta').textContent;
    $('cMeta').textContent = `${n1(c.total)} km ・ 獲得標高 ${c.hasEle ? c.gain.toLocaleString() + ' m' : '不明'} ・ 地点数 ${c.n.toLocaleString()}${c.source && c.source.kind === 'rwgps' ? ' ・ Ride with GPS #' + c.source.id : ''}`;
  }
  // 出走日時は 4 日前の 0:00（JST）より過去にできない（1200 km・90 時間の走行中でも実際の出走時刻を入れられる）。下限より前なら次の 06:00 に戻して知らせる
  function enforceStart() {
    const lim = F.minStart(Date.now()); $('date').min = F.ymd(lim);
    const ms = Date.parse($('date').value + 'T' + ($('time').value || '06:00') + ':00+09:00');
    if (ms >= lim) { if (state.startNote && state.startNote.startsWith('出走日時は')) state.startNote = ''; return false; }
    const nx = F.nextStart(Date.now()); $('date').value = nx.date; $('time').value = nx.time;
    state.startNote = `出走日時は ${RW.const.START_BACK_DAYS} 日前の 0:00 より前にできません。${F.fmtDT(nx.ms)} に戻しました`; // 予報取得後も残るよう帯に出す
    setStatus(state.startNote);
    return true;
  }
  function onParamChange() { enforceStart(); saveParams(); if (state.course) run(); }

  // ===== コース読み込み =====
  function parseGPX(text, fallback) {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length) throw new Error('GPX（XML）として読めません');
    let nodes = xml.getElementsByTagName('trkpt');
    if (!nodes.length) nodes = xml.getElementsByTagName('rtept');
    if (!nodes.length) throw new Error('トラックポイント（trkpt / rtept）が見つかりません');
    const raw = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]; const e = n.getElementsByTagName('ele')[0];
      raw[i] = { lat: +n.getAttribute('lat'), lon: +n.getAttribute('lon'), ele: e ? +e.textContent : null };
    }
    const trk = xml.getElementsByTagName('trk')[0] || xml.getElementsByTagName('rte')[0];
    const meta = xml.getElementsByTagName('metadata')[0];
    const nm = (trk && trk.getElementsByTagName('name')[0] && trk.getElementsByTagName('name')[0].textContent) ||
      (meta && meta.getElementsByTagName('name')[0] && meta.getElementsByTagName('name')[0].textContent) || fallback;
    return RW.course.fromPoints(raw, (nm || '').trim() || fallback);
  }
  async function parseFIT(buf, fallback) {
    let sdk;
    try { sdk = await import('../vendor/fitsdk/src/index.js'); }
    catch (e) { throw new Error('FIT 読み込み用ライブラリを読み込めませんでした（圏外の可能性）。GPX をお使いください'); }
    const stream = sdk.Stream.fromArrayBuffer(buf);
    const dec = new sdk.Decoder(stream);
    if (!dec.isFIT()) throw new Error('FIT ファイルではありません');
    const { messages, errors } = dec.read({ convertTypesToStrings: true, convertDateTimesToDates: false, includeUnknownData: false, mergeHeartRates: false });
    const SC = 180 / 2 ** 31; // semicircles → 度
    const raw = (messages.recordMesgs || []).filter(r => r.positionLat != null && r.positionLong != null)
      .map(r => ({ lat: r.positionLat * SC, lon: r.positionLong * SC, ele: r.enhancedAltitude ?? r.altitude ?? null }));
    if (raw.length < 2) throw new Error('FIT に位置情報（record）が見つかりません' + (errors && errors.length ? '：' + errors[0] : ''));
    const cm = messages.courseMesgs && messages.courseMesgs[0];
    return RW.course.fromPoints(raw, (cm && cm.name) || fallback);
  }
  async function loadFile(f) {
    setStatus('コースを読み込み中…');
    try {
      const head = new Uint8Array(await f.slice(0, 12).arrayBuffer());
      const isFit = head.length >= 12 && String.fromCharCode(head[8], head[9], head[10], head[11]) === '.FIT';
      const base = f.name.replace(/\.(gpx|fit)$/i, '');
      const course = isFit ? await parseFIT(await f.arrayBuffer(), base) : parseGPX(await f.text(), base);
      setCourse(course);
    } catch (err) { setStatus('読み込みに失敗しました：' + err.message, 'err'); }
  }
  // ADD_03：貼り付けられた URL からルート番号を取り、中継経由で公式 API の JSON を受け取ってコースにする
  const RWGPS_MSG = {
    403: 'このルートは非公開のため取得できません。Ride with GPS でルートを「公開」にするか、共有リンク（privacy_code 付きの URL）を貼ってください',
    404: 'ルートが見つかりません。URL のルート番号を確認してください',
    401: '中継サーバーの認証設定に問題があります（管理者に連絡してください）',
    503: '中継サーバーが未設定のため、いまは使えません',
  };
  async function loadRwgps(text) {
    const relay = state.relay || RWGPS_RELAY;
    if (!relay) { setStatus('Ride with GPS 連携は準備中です（中継サーバーが未設定）。当面はファイルから読み込んでください', 'err'); return; }
    const ref = RW.rwgps.parseUrl(text);
    if (!ref) { setStatus('Ride with GPS のルート URL が見つかりません（例：https://ridewithgps.com/routes/12345678）', 'err'); $('rwgpsUrl').focus(); return; }
    const btn = $('rwgpsGo'); btn.disabled = true; setStatus('Ride with GPS からルートを取得中…');
    try {
      const u = new URL(relay.replace(/\/$/, '') + '/rwgps/routes/' + ref.id); if (ref.privacyCode) u.searchParams.set('privacy_code', ref.privacyCode);
      let r; try { r = await fetch(u.toString(), { cache: 'no-store' }); } catch (e) { throw new Error('取得できませんでした。通信状態を確認してください（圏外では使えません）'); }
      if (!r.ok) throw new Error(RWGPS_MSG[r.status] || `取得に失敗しました（HTTP ${r.status}）`);
      const course = RW.rwgps.toCourse(await r.json());
      $('rwgpsUrl').value = '';
      setCourse(course);
    } catch (err) { setStatus('読み込みに失敗しました：' + err.message, 'err'); }
    finally { btn.disabled = false; }
  }
  // ===== ADD_03 Stage 2：OAuth で連携し、自分のルート一覧から選ぶ =====
  const isStandalone = () => { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { return false; } };
  const rwgpsAuth = () => { const a = store.get('rw:rwgps'); return a && a.token ? a : null; };
  const rwgpsMsg = (html, cls) => { const el = $('rwgpsAuthMsg'); if (!html) { el.className = 'posMsg hidden'; el.innerHTML = ''; return; } el.className = 'posMsg' + (cls ? ' ' + cls : ''); el.innerHTML = html; };
  function rwgpsAuthStart() {
    if (!RWGPS_CLIENT_ID) { setStatus('Ride with GPS との連携は準備中です（client_id 未設定）', 'err'); return; }
    const st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    store.set('rw:oauthState', { st, at: Date.now(), standalone: isStandalone() });
    const u = new URL(RWGPS_API + '/oauth/authorize');
    u.searchParams.set('client_id', RWGPS_CLIENT_ID); u.searchParams.set('redirect_uri', RWGPS_REDIRECT); u.searchParams.set('response_type', 'code'); u.searchParams.set('state', st);
    location.assign(u.toString());
  }
  // 戻り先（?code=…）で呼ぶ。state を照合し、中継でトークンに交換して端末内に保持する。URL から code は消す
  async function rwgpsAuthReturn() {
    let q; try { q = new URLSearchParams(location.search); } catch (e) { return; }
    const code = q.get('code'), err = q.get('error'); if (!code && !err) return;
    const saved = store.get('rw:oauthState'); store.del('rw:oauthState');
    const st = q.get('state');
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* noop */ }
    openLoad(); // コースがあればシートを開いて結果を見せる（無ければ画面の読み込み欄に出る）
    setTimeout(() => { try { $('rwgpsAuthMsg').scrollIntoView({ block: 'center' }); } catch (e) { /* noop */ } }, 300);
    if (err) { rwgpsMsg(`Ride with GPS で連携が許可されませんでした（${esc(err)}${q.get('error_description') ? '：' + esc(q.get('error_description')) : ''}）`, 'err'); return; }
    if (!st || !saved || saved.st !== st) { rwgpsMsg('連携の照合（state）が合わないため中止しました。もう一度「Ride with GPS と連携」から始めてください', 'err'); return; }
    rwgpsMsg('Ride with GPS と連携しています…');
    const relay = state.relay || RWGPS_RELAY;
    try {
      if (!relay) throw new Error('中継サーバーが未設定です');
      let r; try { r = await fetch(relay.replace(/\/$/, '') + '/oauth/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }), cache: 'no-store' }); }
      catch (e) { throw new Error('中継サーバーに接続できませんでした。通信状態を確認してください'); }
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) throw new Error(r.status === 503 ? '中継サーバーが未設定のため、いまは連携できません' : (j.errors && j.errors[0]) || `HTTP ${r.status}`);
      store.set('rw:rwgps', { token: j.access_token, userId: j.user_id, at: Date.now() });
      rwgpsMsg('Ride with GPS と連携しました。トークンは端末内にのみ保持します');
      renderRwgpsAuth(); rwgpsList(true);
    } catch (e) { rwgpsMsg('連携に失敗しました：' + esc(e.message), 'err'); }
  }
  function renderRwgpsAuth() {
    const on = !!rwgpsAuth();
    $('rwgpsAuth').classList.toggle('hidden', on); $('rwgpsPick').classList.toggle('hidden', !on); $('rwgpsUnlink').classList.toggle('hidden', !on);
    if (!on) $('rwgpsList').classList.add('hidden');
  }
  function rwgpsUnlink(silent) {
    store.del('rw:rwgps'); rwgpsState.items = []; rwgpsState.page = 0; $('rwgpsItems').innerHTML = '';
    renderRwgpsAuth();
    if (!silent) rwgpsMsg('連携を解除しました（端末内のトークンを削除）。Ride with GPS 側の許可の取り消しは、Ride with GPS のアカウント設定から行えます');
  }
  // Bearer 付きで RwGPS を直接呼ぶ。401 なら連携切れとしてトークンを捨てる
  async function rwgpsFetch(path) {
    const a = rwgpsAuth(); if (!a) throw new Error('Ride with GPS と連携していません');
    let r; try { r = await fetch((state.rwgpsApi || RWGPS_API) + path, { headers: { authorization: 'Bearer ' + a.token, accept: 'application/json' }, cache: 'no-store' }); }
    catch (e) { throw new Error('Ride with GPS に接続できませんでした。通信状態を確認してください'); }
    if (r.status === 401) { rwgpsUnlink(true); throw new Error('連携が切れました。もう一度「Ride with GPS と連携」を行ってください'); }
    if (!r.ok) throw new Error(`Ride with GPS から取得できませんでした（HTTP ${r.status}）`);
    return r.json();
  }
  const rwgpsState = { page: 0, items: [], last: false, q: '', busy: false };
  const RWGPS_PAGE = 50;
  async function rwgpsList(reset) {
    if (rwgpsState.busy) return;
    const box = $('rwgpsList'); box.classList.remove('hidden');
    if (reset) { rwgpsState.page = 0; rwgpsState.items = []; rwgpsState.last = false; rwgpsState.q = $('rwgpsFilter').value.trim(); $('rwgpsItems').innerHTML = ''; }
    if (rwgpsState.last) return;
    rwgpsState.busy = true; const more = $('rwgpsMore'); more.disabled = true; more.textContent = '読み込み中…';
    try {
      const page = rwgpsState.page + 1;
      const qs = new URLSearchParams({ page: String(page), page_size: String(RWGPS_PAGE) }); if (rwgpsState.q) qs.set('name', rwgpsState.q);
      const j = await rwgpsFetch('/api/v1/routes.json?' + qs.toString());
      const routes = Array.isArray(j.routes) ? j.routes : [];
      const pg = (j.meta && (j.meta.pagination || j.meta)) || {};
      rwgpsState.page = page; rwgpsState.items = rwgpsState.items.concat(routes);
      rwgpsState.last = routes.length < RWGPS_PAGE || pg.next_page_url === null || (pg.page_count != null && page >= pg.page_count);
      renderRwgpsItems();
      if ($('rwgpsAuthMsg').classList.contains('err')) rwgpsMsg(''); // 連携完了の案内は残す
    } catch (e) { rwgpsMsg(esc(e.message), 'err'); }
    finally { rwgpsState.busy = false; more.disabled = false; more.textContent = 'さらに読み込む'; more.classList.toggle('hidden', rwgpsState.last); }
  }
  function renderRwgpsItems() {
    const items = rwgpsState.items.slice().sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0));
    const host = $('rwgpsItems');
    if (!items.length) { host.innerHTML = '<div class="howto">ルートがありません' + (rwgpsState.q ? '（絞り込み：' + esc(rwgpsState.q) + '）' : '') + '</div>'; return; }
    host.innerHTML = items.map(r => `<button type="button" class="item" data-id="${esc(r.id)}"><span class="nm">${esc(r.name || '（名称なし）')}</span><span class="sub">${n1((r.distance || 0) / 1000)} km ・ 獲得標高 ${Math.round(r.elevation_gain || 0).toLocaleString()} m ・ 更新 ${r.updated_at ? F.dateKey(Date.parse(r.updated_at)) : '—'}${r.visibility ? ' ・ 非公開' : ''}</span></button>`).join('');
    host.querySelectorAll('button.item').forEach(b => b.addEventListener('click', () => rwgpsPick(b.dataset.id, b)));
  }
  async function rwgpsPick(id, btn) {
    if (btn) btn.disabled = true; setStatus('Ride with GPS からルートを取得中…');
    try {
      const course = RW.rwgps.toCourse(await rwgpsFetch(`/api/v1/routes/${encodeURIComponent(id)}.json`));
      $('rwgpsList').classList.add('hidden'); rwgpsMsg('');
      setCourse(course);
    } catch (e) { setStatus('読み込みに失敗しました：' + e.message, 'err'); }
    finally { if (btn) btn.disabled = false; }
  }
  function setCourse(course) {
    state.course = course; state.series = null; state.result = null; state.offlineNote = '';
    store.del('rw:posHist'); state.lastPos = null; state.forecastStale = ''; state.startNote = ''; if ($('posMsg')) { posMsg(''); posMsg('', '', 'gpsMsg'); }
    $('ancD').value = ''; $('ancT').value = ''; // 前のコースの現在地固定は持ち越さない
    renderCourse(); store.set('rw:course', course); rememberCourse(course); closeLoad(); closePlan(); setStatus('');
    run();
  }
  // 最近のコース（C-8）：端末内に最大 5 件。同じコース（ハッシュ一致）は先頭に移す
  function rememberCourse(course) {
    const h = RW.course.hashCourse(course);
    const list = (store.get('rw:courses') || []).filter(c => c.hash !== h);
    list.unshift({ hash: h, savedAt: Date.now(), course });
    while (list.length > 5) list.pop();
    if (!store.set('rw:courses', list)) { list.length = Math.min(list.length, 2); store.set('rw:courses', list); }
    renderRecent();
  }
  function renderRecent() {
    const sel = $('recent'); const list = store.get('rw:courses') || [];
    sel.innerHTML = '<option value="">最近のコース…</option>' + list.map((c, i) => `<option value="${i}">${esc(c.course.name)}（${n1(c.course.total)} km・${F.dateKey(c.savedAt)}）</option>`).join('');
    sel.parentElement.classList.toggle('hidden', !list.length && !state.course);
  }

  // ===== 予報取得 =====
  async function fetchSeriesRaw(model, pts, pastDays) {
    const res = await fetch(RW.forecast.buildUrl(pts, model, pastDays));
    if (!res.ok) { let msg = 'HTTP ' + res.status; try { const j = await res.json(); if (j.reason) msg += ' ' + j.reason; } catch (e) { /* noop */ } throw new Error(msg); }
    const series = RW.forecast.parseSeries(await res.json());
    if (series.length !== pts.length) throw new Error('地点数が一致しません（' + series.length + '/' + pts.length + '）');
    return series;
  }
  async function getSeries(model, pts, hash, pastDays, force) {
    const key = 'rw:fc2:' + hash + ':' + model + ':' + pastDays;
    if (!force) { const c = store.get(key); if (c && Date.now() - c.at < CACHE_MS) return c.series; }
    const series = await fetchSeriesRaw(model, pts, pastDays);
    store.set(key, { at: Date.now(), series });
    return series;
  }
  // R-18/R-19：現在地より先のサンプル点だけ予報を取り直し、既存の時系列に差し込む。失敗時は前回値のまま false を返す
  async function refreshForecastFrom(d) {
    const p = params(); const step = RW.plan.sampleStep(state.course.total);
    const pts = RW.plan.samplePoints(state.course, p, step); const hash = RW.course.hashCourse(state.course);
    let idx = pts.findIndex(x => x.d >= d); if (idx < 0) idx = pts.length - 1;
    const sub = pts.slice(idx); const now = Date.now();
    const pastDays = Math.min(PAST_DAYS_MAX, Math.max(0, Math.ceil((now - +p.start) / 86400e3)));
    try {
      const msmSub = await fetchSeriesRaw('msm', sub, pastDays);
      const goalT = +pts[pts.length - 1].t; const hM = RW.forecast.horizon(msmSub);
      const gsmSub = (hM == null || goalT > hM) ? await fetchSeriesRaw('gsm', sub, pastDays) : null;
      if (!state.course || RW.course.hashCourse(state.course) !== hash) return false; // 取得中にコースが変わった
      const merge = (oldArr, subArr) => { const out = (oldArr || []).slice(0, pts.length); while (out.length < pts.length) out.push(null); subArr.forEach((x, i) => { out[idx + i] = x; }); return out; };
      let ser = state.series;
      if (!ser || ser.hash !== hash) ser = { msm: [], gsm: null, hash, pastDays, fetchedAt: now, runs: {} };
      ser.msm = merge(ser.msm, msmSub);
      if (gsmSub) ser.gsm = merge(ser.gsm, gsmSub);
      ser.fetchedAt = now; ser.pastDays = pastDays;
      state.series = ser; state.offlineNote = ''; state.forecastStale = '';
      store.set('rw:last', { course: state.course, series: ser });
      fetchRuns(ser);
      return true;
    } catch (e) {
      if (state.series) state.forecastStale = `予報は ${F.fmtH(state.series.fetchedAt)} 取得のものです（更新できませんでした）`;
      else state.forecastStale = '予報を取得できませんでした（圏外の可能性）';
      return false;
    }
  }
  async function fetchRuns(ser) {
    for (const m of ['msm', 'gsm']) {
      if (!ser[m]) continue;
      try { const r = await fetch('https://api.open-meteo.com/data/' + M[m].id + '/static/meta.json'); const j = await r.json(); ser.runs[m] = j.last_run_initialisation_time * 1000; }
      catch (e) { /* 表示だけの情報なので無視 */ }
    }
    if (state.series === ser) { store.set('rw:last', { course: state.course, series: ser }); renderModelInfo(); renderNotice(); }
  }
  async function run(opts) {
    const force = !!(opts && opts.force);
    if (!state.course) { setStatus('先にコースを読み込んでください', 'err'); return; }
    const seq = (state.runSeq = (state.runSeq || 0) + 1); // 取得中に設定・コースが変わったら、古い応答を捨てて最後の設定で取り直す
    const p = params();
    if (isNaN(+p.start)) { setStatus('出走日時を入力してください', 'err'); return; }
    saveParams(); updateSumLine(p);
    const now = Date.now();
    const daysAhead = (+p.start - now) / 86400e3;
    if (daysAhead > 11) { state.result = null; renderOutOfRange(daysAhead); return; }
    const pts = RW.plan.samplePoints(state.course, p, RW.plan.sampleStep(state.course.total));
    const goalT = +pts[pts.length - 1].t;
    const hash = RW.course.hashCourse(state.course);
    const pastDays = Math.min(PAST_DAYS_MAX, Math.max(0, Math.ceil((now - +p.start) / 86400e3)));
    let ser = state.series;
    const fresh = ser && ser.hash === hash && ser.pastDays === pastDays && now - ser.fetchedAt < CACHE_MS;
    const covered = s => { const hM = RW.forecast.horizon(s.msm); return (hM != null && goalT <= hM) || !!s.gsm; };
    if (force || !fresh || !covered(ser)) {
      if (state.busy) { state.rerun = true; return; } // 取得中の変更は捨てず、終わってから最後の設定で再実行
      state.busy = true; $('run').disabled = true; setStatus('予報を取得中…');
      let stale = false;
      try {
        const msm = await getSeries('msm', pts, hash, pastDays, force);
        const hM = RW.forecast.horizon(msm);
        const gsm = (hM == null || goalT > hM) ? await getSeries('gsm', pts, hash, pastDays, force) : null;
        stale = seq !== state.runSeq || !state.course || RW.course.hashCourse(state.course) !== hash;
        if (!stale) {
          ser = { msm, gsm, hash, pastDays, fetchedAt: Date.now(), runs: {} };
          state.series = ser; state.offlineNote = '';
          store.set('rw:last', { course: state.course, series: ser });
          try { Object.keys(localStorage).filter(k => k.startsWith('rw:fc:')).forEach(k => localStorage.removeItem(k)); } catch (e) { /* 旧キャッシュの掃除 */ }
          setStatus('');
          fetchRuns(ser);
        }
      } catch (e) {
        stale = seq !== state.runSeq || !state.course || RW.course.hashCourse(state.course) !== hash;
        if (!stale) {
          const last = store.get('rw:last');
          if (last && last.series && last.series.hash === hash) {
            ser = state.series = last.series;
            state.offlineNote = `予報を取得できませんでした（${e.message}）。${F.fmtDT(ser.fetchedAt)} に取得した予報を表示しています。`;
            setStatus('');
          } else {
            setStatus('予報を取得できませんでした：' + e.message, 'err');
            stale = true;
          }
        }
      } finally {
        state.busy = false; $('run').disabled = false;
        if (state.rerun) { state.rerun = false; stale = true; run(); }
      }
      if (stale) return;
    }
    recompute(p);
  }
  function recompute(p) {
    p = p || params();
    const { S, step } = RW.forecast.computeRide(state.course, p, state.series);
    const sm = RW.forecast.summarize(S, step, p.anchor ? p.anchor.d : null); // 再計算中は「残り」で集計（R-20）
    const hM = RW.forecast.horizon(state.series.msm);
    const trend = hM == null ? true : +p.start > hM;
    state.result = { S, step, sm, p, trend };
    updateSumLine(p); // 上の札に現在地の再計算を反映
    renderAll();
  }

  // ===== 描画 =====
  function renderOutOfRange(daysAhead) {
    $('results').classList.add('hidden'); setMapMode(false);
    const el = $('notice0'); el.className = 'notice warn';
    el.innerHTML = `<div>出走まで ${Math.ceil(daysAhead)} 日。予報は 11 日前（気象庁 GSM の予報期間）から表示できます。</div>`;
    setStatus('');
  }
  function renderAll() {
    $('results').classList.remove('hidden'); $('notice0').className = 'notice hidden'; setMapMode(true);
    renderNotice(); renderSummary(); renderStrip(); renderRows(); renderStarts(); renderModelInfo(); renderGpsPlace();
    sheetLayout(); renderMap();
    if (navigator.onLine !== false) { loadWarnings(); loadAmedas(); } else { renderWarnings(); renderAmedas(); }
  }
  // 「現在位置から予報を再取得」は走行中の可能性がある時間帯（出走 1 時間前〜ゴール 6 時間後）か、現在地を使っているときだけ画面に出す。それ以外はメニューから
  function renderGpsPlace() {
    const r = state.result; const now = Date.now();
    const riding = !!(r && (r.p.anchor || (now >= +r.p.start - 3600e3 && now <= +r.sm.goal + 6 * 3600e3)));
    $('gps').classList.toggle('hidden', !(riding || state.gpsShown));
    $('gpsWrap').classList.toggle('hidden', !(riding || state.gpsShown));
    $('menuGps').classList.toggle('hidden', !r || riding || !!state.gpsShown);
  }
  function staleNote() {
    const ser = state.series; if (!ser) return '';
    const { trend } = state.result;
    const fetchAge = Date.now() - ser.fetchedAt;
    if (fetchAge > 6 * 3600e3) return `前回の取得（${F.fmtDT(ser.fetchedAt)}）から ${Math.floor(fetchAge / 3600e3)} 時間経っています。「予報を取得する」で再取得してください。`;
    if (trend && ser.runs.gsm && Date.now() - ser.runs.gsm > 12 * 3600e3) return `GSM の発表（初期時刻 ${F.fmtDT(ser.runs.gsm)}）から半日以上経っています。「予報を取得する」で再取得してください。`;
    return '';
  }
  function renderNotice() {
    const { sm, p, trend, S } = state.result; const msgs = [];
    if (state.offlineNote) msgs.push(['warn', state.offlineNote]);
    if (state.startNote) msgs.push(['warn', state.startNote]);
    if (state.forecastStale) msgs.push(['warn', state.forecastStale]);
    const days = Math.max(0, Math.ceil((+p.start - Date.now()) / 86400e3));
    if (sm.nOk === 0) msgs.push(['warn', `出走まで ${days} 日。通過時刻が予報範囲（気象庁 GSM・11 日先まで）を超えています。出走が近づいてから再取得してください。`]);
    else if (trend) msgs.push(['info', `出走まで ${days} 日。傾向モード：予報は傾向としてお読みください（${M.gsm.label}・${M.gsm.grid}）。出走 4 日前を切ると MSM の詳細表示に切り替わります。`]);
    else if (sm.gsmFrom != null) msgs.push(['info', `${Math.round(sm.gsmFrom)} km 以降は MSM の予報期間を超えるため ${M.gsm.label}（${M.gsm.grid}）の値です。`]);
    if (sm.nOk > 0 && sm.naFrom != null) msgs.push(['warn', `${Math.round(sm.naFrom)} km 以降（${F.fmtDT(S.find(s => s.na).t)}〜）は予報範囲外です。`]);
    const st = staleNote(); if (st) msgs.push(['warn', st]);
    if (state.warnings && state.warnings.segs) {
      const hot = state.warnings.segs.filter(x => x.warnings.some(y => wLevel(y.code) !== 'adv'));
      if (hot.length) msgs.push(['warn', '通過区域に警報：' + hot.map(x => `${esc(x.name)}（${Math.round(x.from)}–${Math.round(x.to)} km）${x.warnings.filter(y => wLevel(y.code) !== 'adv').map(y => wName(y.code)).join('・')}`).join('、')]);
    }
    const el = $('notice');
    if (!msgs.length) { el.className = 'notice hidden'; el.innerHTML = ''; return; }
    el.className = 'notice ' + (msgs.some(m => m[0] === 'warn') ? 'warn' : 'info');
    el.innerHTML = msgs.map(m => '<div>' + esc(m[1]) + '</div>').join('');
  }
  // 要点のデータ（画面と共有画像で共用）。ゴール予定と 5 指標（向かい風・雨中・最高気温・最低気温・夜間）。v2 段階 3
  function summaryCards() {
    const { sm, step, p } = state.result;
    const A = !!p.anchor; const rest = A ? Math.max(0, state.course.total - p.anchor.d) : state.course.total;
    const sleepMin = p.sleeps.reduce((a, x) => a + x.m, 0);
    const cards = [{ id: 'goal', cls: '', k: 'ゴール予定', v: F.fmtDT(sm.goal), s: A ? `現在地 ${Math.round(p.anchor.d)} km（${F.fmtH(p.anchor.t)}）から残り ${n1(rest)} km・${n1(Math.max(0, (+sm.goal - +p.anchor.t) / 3600e3))} h` : `経過 ${n1(sm.totalH)} h${sleepMin ? '・うち仮眠 ' + sleepMin + ' 分' : ''}` }];
    if (sm.nOk === 0) return cards;
    const temp = x => x ? `${Math.round(x.d)} km・${F.fmtDT(x.t)}${x.feel != null ? '・体感 ' + n1(x.feel) + '℃' : ''}` : '—';
    cards.push({ id: 'head', cls: 'head', k: '向かい風', num: `${Math.round(sm.headKm)}`, unit: 'km', s: `${A ? '残り' : '全体'}の ${rest > 0 ? Math.round(sm.headKm / rest * 100) : 0}%・最大風速 ${sm.wsMax ? n1(sm.wsMax.ws) + ' m/s（' + Math.round(sm.wsMax.d) + ' km）' : '—'}` });
    cards.push({ id: 'rain', cls: 'rain', k: '雨中', num: `${Math.round(sm.rainKm)}`, unit: 'km', s: sm.rainFirst ? `${Math.round(sm.rainFirst.d)} km（${F.fmtDT(sm.rainFirst.t)}）〜 ${Math.round(Math.min(sm.rainLast.d + step, state.course.total))} km` : `降水 ${RAIN_MM} mm/h 以上の区間なし` });
    cards.push({ id: 'tmax', cls: '', k: '最高気温', num: sm.tmax ? n1(sm.tmax.temp) : '—', unit: sm.tmax ? '℃' : '', s: temp(sm.tmax) });
    cards.push({ id: 'tmin', cls: '', k: '最低気温', num: n1(sm.tmin.temp), unit: '℃', s: temp(sm.tmin) });
    cards.push({ id: 'night', cls: '', k: '夜間', num: `${Math.round(sm.nightKm)}`, unit: 'km', s: '日没〜日の出の区間' });
    const exact = { head: sm.headKm, rain: sm.rainKm, night: sm.nightKm };
    for (const c of cards) if (c.num != null) c.v = (exact[c.id] != null ? exact[c.id] : c.num) + (c.unit ? (c.unit === '℃' ? '' : ' ') + c.unit : '');
    if (A) cards.slice(1).forEach(c => { c.s = '現在地より先・' + c.s; });
    return cards;
  }
  function renderSummary() {
    const cards = summaryCards(); const g = cards[0];
    let h = `<div class="sumHead"><div class="goal"><span class="k">ゴール予定</span><b>${esc(g.v)}</b><span class="s">${esc(g.s)}</span></div><button type="button" class="btn small" id="share" title="地図と要点を画像にして共有・保存">画像で共有</button></div>`;
    if (cards.length > 1) {
      h += '<div class="kpis">' + cards.slice(1).map(c => `<button type="button" class="kpi ${c.cls}" data-id="${c.id}" aria-expanded="false" aria-controls="kpiDetail"><span class="k">${c.k}</span><b>${esc(c.num)}${c.unit ? '<small>' + c.unit + '</small>' : ''}</b></button>`).join('') + '</div>';
      h += '<div class="kpiDetail" id="kpiDetail" hidden></div>';
    }
    const el = $('summary'); el.innerHTML = h;
    $('share').addEventListener('click', async () => { const b = $('share'); b.disabled = true; try { await shareMapImage(); } catch (e) { setStatus('画像の共有に失敗しました：' + e.message, 'err'); } finally { b.disabled = false; } });
    el.querySelectorAll('.kpi').forEach(b => b.addEventListener('click', () => {
      if (state.sheet === 'peek' && !isWide()) setSheet('half'); // 下げた状態では詳細が隠れるので上げる
      const d = $('kpiDetail'); const open = b.getAttribute('aria-expanded') === 'true';
      el.querySelectorAll('.kpi').forEach(x => x.setAttribute('aria-expanded', 'false'));
      if (open) { d.hidden = true; return; }
      b.setAttribute('aria-expanded', 'true'); const c = cards.find(x => x.id === b.dataset.id) || {}; d.textContent = c.s ? `${c.k} ${c.unit === 'km' ? c.v + '・' : ''}${c.s}` : ''; d.hidden = false; // 要点の km は整数に丸めているので、詳細では小数まで出す
    }));
  }
  // SVG 断片
  const rect = (x, y, w, h, fill, op) => `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}"${op != null ? ` opacity="${op}"` : ''}/>`;
  const line = (x1, y1, x2, y2, stroke, w = 1, dash) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  const text = (x, y, s, cls, anchor, fill) => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="${cls || 'tick'}"${anchor ? ` text-anchor="${anchor}"` : ''}${fill ? ` fill="${fill}"` : ''}>${esc(s)}</text>`;
  const arrow = (x, y, angDeg, len, color, w = 2) =>
    `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angDeg.toFixed(1)})"><line x1="${(-len / 2).toFixed(1)}" y1="0" x2="${(len / 2).toFixed(1)}" y2="0" stroke="${color}" stroke-width="${w}"/><path d="M${(len / 2).toFixed(1)} 0 l-5 -3.5 v7 z" fill="${color}"/></g>`;

  // コース全体の帯（v3）：相対風の色と雨の棒、夜間・仮眠・現在地。押すとシートを上げる
  function renderStrip() {
    const host = $('strip'); const { S, p } = state.result; const total = state.course.total;
    const W = 360, top = 6, bandH = 11, base = 40, rainH = 22, H = 54; const x = d => d / total * W; state.stripW = W;
    let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="コース全体の相対風と雨。押すと区間表へ">`;
    S.forEach((pt, i) => {
      const a = i ? (S[i - 1].d + pt.d) / 2 : 0, b = i < S.length - 1 ? (pt.d + S[i + 1].d) / 2 : total;
      const fill = pt.na ? 'var(--na)' : pt.cls ? COL[pt.cls] : 'var(--line)';
      s += rect(x(a), top, x(b) - x(a) + 0.4, bandH, fill, pt.na ? .35 : null);
      if (pt.night) s += rect(x(a), top + bandH + 1, x(b) - x(a) + 0.4, 2.5, 'var(--night)', .55);
    });
    const ok = S.filter(pt => !pt.na && pt.mm > 0); const mmMax = Math.max(3, ...ok.map(pt => pt.mm)); const bw = Math.max(1.2, W / Math.max(1, S.length) * .7);
    for (const pt of ok) { const h = Math.max(1, pt.mm / mmMax * rainH); s += rect(x(pt.d) - bw / 2, base - h, bw, h, 'var(--rain)', pt.mm >= RAIN_MM ? 1 : .45); }
    s += line(0, base + .5, W, base + .5, 'var(--line)');
    for (const sl of p.sleeps) s += `<path d="M${x(sl.d).toFixed(1)},${top + bandH + 4} l-4,6 h8 z" fill="var(--sleep)"/>`;
    if (p.anchor) s += `<path d="M${x(p.anchor.d).toFixed(1)},${top} l-5,-6 h10 z" fill="var(--ink)"/>`;
    if (state.active != null) { const r = (state.rows || []).find(q => q.from === state.active); if (r) s += `<rect x="${x(r.from).toFixed(1)}" y="${top - 3}" width="${Math.max(2, x(r.to) - x(r.from)).toFixed(1)}" height="${base - top + 4}" fill="none" stroke="var(--ink)" stroke-width="1.5" rx="2"/>`; }
    const dStep = [10, 20, 25, 50, 100, 200, 500].find(n => n / total * W >= 56) || 1000;
    for (let d = 0; d <= total + 1e-9; d += dStep) { const xx = Math.min(W - 1, Math.max(1, x(d))); s += text(xx, H - 1, d ? String(d) : '0 km', 'tick', d ? (x(d) > W - 12 ? 'end' : 'middle') : 'start'); }
    host.innerHTML = s + '</svg>';
  }
  // ===== 区間表（v3）：10 km ごと（傾向モードは 50 km ごと）。左端の標高は相対風の色。注意報・仮眠・日付は行の間に入れる =====
  const rowSize = () => state.result && state.result.trend ? 50 : 10;
  const rowOf = d => { const rows = state.rows || []; return (rows.filter(r => r.from <= d + 1e-9).pop() || rows[0] || { from: 0 }).from; };
  // 地図や帯から選んだ地点が「現在地から」の表より手前なら、「スタートから」に切り替えてから行を探す
  function rowFor(d) { const a = state.result && state.result.p.anchor; if (a && state.fromHere !== false && d < a.d) { state.fromHere = false; renderRows(); } return rowOf(d); }
  const ARW = 'M0-8.5 5.6-1H1.8V8.5H-1.8V-1H-5.6Z';
  function spineSvg(r, emin, emax) {
    const P = state.course.pts.filter(q => q.d >= r.from && q.d <= r.to); const len = r.to - r.from || 1; const { S } = state.result;
    const colOf = d => { let best = null, bd = Infinity; for (const s of S) { const dd = d - s.d; if (dd >= -1e-9 && dd < bd) { bd = dd; best = s; } } return best && !best.na && best.cls ? COL[best.cls] : 'var(--line)'; };
    const h = 46 / Math.max(1, P.length);
    let g = P.map(q => { const w = 3 + ((q.ele ?? emin) - emin) / ((emax - emin) || 1) * 22; return `<rect x="${(27 - w).toFixed(1)}" y="${((q.d - r.from) / len * 46).toFixed(1)}" width="${w.toFixed(1)}" height="${(h + .6).toFixed(1)}" fill="${colOf(q.d)}" style="opacity:var(--ele-op)"/>`; }).join('');
    g += '<line x1="27.5" x2="27.5" y1="0" y2="46" stroke="var(--ink-3)"/>';
    return `<svg class="sp" viewBox="0 0 28 46" preserveAspectRatio="none" aria-hidden="true">${g}</svg>`;
  }
  const placeAt = d => { const w = state.warnings; const sg = w && w.segs && w.segs.find(x => d >= x.from && d < x.to); return sg && sg.status !== 'unknown' ? sg.name : null; };
  function rowDetail(r) {
    const m = r.mid; if (!m || r.na) return '';
    const P = state.course.pts.filter(q => q.d >= r.from && q.d <= r.to && q.ele != null); const eles = P.map(q => q.ele);
    const items = [];
    const place = placeAt((r.from + r.to) / 2); if (place) items.push(['場所', esc(place)]);
    items.push(['天気', `${esc(RW.forecast.wmoText(m.code))}　湿度 ${nv(m.rh, 0)}%${m.sun != null ? '　日照 ' + Math.round(m.sun / 36) + '%' : ''}`]);
    if (r.cls) items.push(['風', `${r.wd != null ? RW.wind.dir16(r.wd) + 'の風 ' : ''}最大 ${n1(r.ws)} m/s（<b style="color:${COL[r.cls]}">${REL[r.cls]}風</b> ${n1(r.headKm)} km）`]);
    items.push(['気温', `${n1(r.tmin)}〜${n1(r.tmax)}℃${m.feel != null ? '　体感 ' + n1(m.feel) + '℃' : ''}`]);
    if (eles.length) items.push(['標高', `${Math.round(Math.min(...eles))}〜${Math.round(Math.max(...eles))} m`]);
    if (r.models.includes('gsm')) items.push(['予報', `${M.gsm.label}（${M.gsm.grid}）`]);
    return `<div class="det">${items.map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('')}</div>`;
  }
  function renderRows() {
    const { S, p, trend } = state.result; const size = rowSize();
    const here = !!p.anchor && state.fromHere !== false; // 走行中の再計算をしているときは「現在地から」を既定にする
    const rows = state.rows = RW.forecast.tableRows(S, state.course.total, size, p, here ? p.anchor.d : 0);
    $('rowsTabs').classList.toggle('hidden', !p.anchor);
    if (p.anchor) { $('tabHere').textContent = `現在地から（${Math.round(p.anchor.d)} km）`; $('rowsTabs').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.here === '1') === here))); }
    if (state.active != null && !rows.some(r => r.from === state.active)) { state.active = null; state.open.clear(); }
    const eles = state.course.pts.map(q => q.ele ?? 0); const emin = Math.min(...eles), emax = Math.max(...eles);
    const sr = RW.forecast.sleepRain(p, state.series, S, state.result.step);
    const wsegs = warnNotes();
    let h = here ? `<div class="rnote here">現在地 ${Math.round(p.anchor.d)} km（${F.fmtH(p.anchor.t)}）から</div>` : '', lastDay = null;
    rows.forEach(r => {
      const day = F.dateKey(r.t);
      if (day !== lastDay) { const x = F.jstParts(r.t); h += `<div class="rnote day">${x.mo}/${x.d}(${'日月火水木金土'[x.dow]})</div>`; lastDay = day; }
      for (const w of wsegs) if (w.from >= r.from - 1e-9 && w.from < r.to) h += `<div class="rnote ${w.cls}">${esc(w.text)}　${Math.round(w.from)}〜${Math.round(w.to)} km（${esc(w.names[0])}${w.names.length > 1 ? '〜' + esc(w.names[w.names.length - 1]) : ''}）</div>`;
      const past = p.anchor && r.to <= p.anchor.d;
      const cls = 'row' + (r.night ? ' night' : '') + (state.active === r.from ? ' on' : '') + (past ? ' past' : '');
      let cells;
      if (r.na) cells = '<span class="na">予報範囲外</span>';
      else {
        const wind = r.cls ? `<svg viewBox="-10 -10 20 20" aria-hidden="true"><path transform="rotate(${(r.rel != null ? r.rel : 0).toFixed(0)})" d="${ARW}" fill="${COL[r.cls]}"/></svg><em style="color:${COL[r.cls]}">${REL[r.cls]}風</em>${r.ws != null ? Math.round(r.ws) + ' m' : ''}` : '<span class="sub">欠測</span>';
        const mm = r.mm || 0;
        const rain = mm >= 0.05 ? `<span class="r${mm < RAIN_MM ? ' light' : ''}"><i style="width:${Math.max(2, Math.round(Math.min(mm, 5) / 5 * 18))}px"></i>${mm.toFixed(mm >= 10 ? 0 : 1)}</span>` : '<span class="r none">—</span>';
        cells = `<span class="t">${F.fmtH(r.t)}</span><span class="w">${wind}</span>${rain}<span class="tp">${r.temp != null ? Math.round(r.temp) + '°' : '—'}</span>`;
      }
      h += `<button type="button" class="${cls}" data-k="${r.from}" aria-expanded="${state.open.has(r.from)}">${spineSvg(r, emin, emax)}<span class="km">${Math.round(r.from)}</span>${r.na ? '<span class="t">' + F.fmtH(r.t) + '</span>' : ''}${cells}</button>`;
      if (state.open.has(r.from)) h += rowDetail(r);
      for (const sl of p.sleeps) if (sl.d > r.from && sl.d <= r.to + 1e-9) {
        const rr = sr.filter(x => x.d === sl.d); const mx = rr.length ? Math.max(...rr.map(x => x.mm)) : null;
        h += `<div class="rnote sleep">仮眠 ${Math.round(sl.d)} km　${F.fmtH(RW.plan.timeAt(sl.d, p, true))}〜${F.fmtH(RW.plan.timeAt(sl.d, p))}（${sl.m} 分）${mx != null && mx >= 0.05 ? '　雨 最大 ' + n1(mx) + ' mm/h' : ''}</div>`;
      }
    });
    $('rows').innerHTML = h;
    $('rowsSum').textContent = `${size} km ごと${trend ? '（傾向モード）' : ''}`;
    drawSelection();
  }
  // 区間表に差し込む注意報・警報：発表のある市区町村が続く区間を 1 つにまとめ、名前は「強風・波浪・雷注意報」のように種別ごとにまとめる
  function warnNotes() {
    const segs = (state.warnings && state.warnings.segs) || []; const out = [];
    for (const sg of segs) {
      const codes = (sg.warnings || []).map(y => y.code); const last = out[out.length - 1];
      if (!codes.length) continue;
      // 続いている区間は 1 つにまとめ、種類は合わせて出す（市区町村ごとの内訳は「通過区域の注意報・警報」の表）
      if (last && Math.abs(last.to - sg.from) < 1e-6) { last.to = sg.to; codes.forEach(c => { if (!last.codes.includes(c)) last.codes.push(c); }); if (last.names[last.names.length - 1] !== sg.name) last.names.push(sg.name); continue; }
      out.push({ codes: codes.slice(), from: sg.from, to: sg.to, names: [sg.name] });
    }
    const KINDS = ['特別警報', '危険警報', '警報', '注意報'];
    const kindOf = n => KINDS.find(k => n.endsWith(k)) || '';
    for (const w of out) {
      const names = w.codes.map(wName);
      w.text = KINDS.map(k => { const ns = [...new Set(names.filter(n => kindOf(n) === k).map(n => n.slice(0, -k.length)))]; return ns.length ? ns.join('・') + k : ''; }).filter(Boolean).join('、');
      w.cls = wLevel(w.codes.reduce((a, c) => wLevelNum(c) > wLevelNum(a) ? c : a));
    }
    return out;
  }
  // 行・地図の矢印・全体の帯から区間を選ぶ。地図はその区間に寄せ、表はその行を見せる
  function selectRow(k, opt = {}) {
    state.active = k;
    if (opt.toggle) { if (state.open.has(k)) state.open.delete(k); else state.open.add(k); } else if (opt.open) state.open.add(k);
    const wasPeek = state.sheet === 'peek' && !isWide();
    const st = $('sheetBody').scrollTop; renderRows(); renderStrip(); $('sheetBody').scrollTop = st;
    if (wasPeek) setSheet('half');
    if (opt.scroll) requestAnimationFrame(() => scrollToRow(k));
    focusRow(k);
  }
  function scrollToRow(k) {
    const body = $('sheetBody'), r = body.querySelector(`.row[data-k="${k}"]`); if (!r) return;
    let el = r; while (el.previousElementSibling && el.previousElementSibling.classList.contains('rnote')) el = el.previousElementSibling; // 直前の注記ごと見せる
    const th = $('rowsThead').offsetHeight;
    const top = el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - th - 6;
    follow.lock = Date.now() + 1000;
    body.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  // 表のスクロールに地図を合わせる：スクロールが止まってから 1 回だけ（OSM のタイル取得を増やさない）
  const follow = { timer: 0, lock: 0 };
  function onRowsScroll() {
    if ((state.sheet === 'peek' && !isWide()) || !state.rows) return;
    clearTimeout(follow.timer);
    follow.timer = setTimeout(() => {
      if (Date.now() < follow.lock) return;
      const body = $('sheetBody'), th = $('rowsThead').getBoundingClientRect();
      if (th.top - body.getBoundingClientRect().top > 8) return; // 表の見出しが上に貼り付く前（要点を見ている間）は動かさない
      const rows = [...$('rows').querySelectorAll('.row')]; const r = rows.find(x => { const q = x.getBoundingClientRect(); return (q.top + q.bottom) / 2 > th.bottom; }); if (!r) return; // 見出しの下に半分以上見えている最初の行
      const k = +r.dataset.k; if (k === state.active) return;
      state.active = k; body.querySelectorAll('.row.on').forEach(x => x.classList.remove('on')); r.classList.add('on'); renderStrip();
      focusRow(k);
    }, 350);
  }
  // ===== 本地図（V-6）：Leaflet + OSM タイル。Leaflet が読めない場合は静的な略地図にフォールバック =====
  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  let lmap = null, lmapHash = null, lmapLayers = null, lmapTheme = null;
  const WXVAR = { rain: '--wx-rain', cloud: '--wx-cloud', sun: '--wx-sun' };
  // 進行方向の記号（>>）を置く位置：経路に沿って画素間隔 spacing ごと。px(lat, lon) → [x, y]
  function chevronSpots(P, px, spacing, max = 250) {
    const out = []; let acc = spacing * 0.5, prev = null;
    for (const q of P) {
      const v = px(q.lat, q.lon);
      if (prev) {
        const dx = v[0] - prev[0], dy = v[1] - prev[1], d = Math.hypot(dx, dy); acc += d;
        if (acc >= spacing && d > 0) { out.push({ x: v[0], y: v[1], ang: Math.atan2(dy, dx) * 180 / Math.PI, lat: q.lat, lon: q.lon }); acc = 0; if (out.length >= max) break; }
      }
      prev = v;
    }
    return out;
  }
  // 地図用の風矢印：矢じりを大きくし、白の縁取りを付ける
  const MAP_ARROW_K = 1.7;
  const mapArrow = (x, y, angDeg, len, color) => {
    const k = MAP_ARROW_K, L2 = len / 2, hl = 8 * k, hw = 5.5 * k;
    const shaft = `M${(-L2).toFixed(1)} 0 L${(L2 - hl * 0.6).toFixed(1)} 0`;
    const head = `M${L2.toFixed(1)} 0 L${(L2 - hl).toFixed(1)} ${(-hw).toFixed(1)} L${(L2 - hl * 0.55).toFixed(1)} 0 L${(L2 - hl).toFixed(1)} ${hw.toFixed(1)} Z`;
    return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angDeg.toFixed(1)})" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="${shaft}" stroke="#fff" stroke-width="${(3.2 * k + 3).toFixed(1)}" fill="none"/><path d="${head}" fill="#fff" stroke="#fff" stroke-width="3"/>` +
      `<path d="${shaft}" stroke="${color}" stroke-width="${(3.2 * k).toFixed(1)}" fill="none"/><path d="${head}" fill="${color}"/></g>`;
  };
  const CHEV_PATH = 'M-6,-5 L-1,0 L-6,5 M0,-5 L5,0 L0,5';
  const chevSvg = (color, halo) => `<svg width="16" height="14" viewBox="-8 -7 16 14" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${CHEV_PATH}" stroke="${halo}" stroke-width="4.5"/><path d="${CHEV_PATH}" stroke="${color}" stroke-width="2"/></g></svg>`;
  // 経路をサンプル間で区切り、各区間に通過時刻の天気分類を付ける（線の色分け用）
  function routeSegments(course, S) {
    const segs = [];
    for (let i = 1; i < S.length; i++) {
      const a = S[i - 1], b = S[i];
      const pts = [RW.course.interp(course, a.d), ...course.pts.filter(q => q.d > a.d && q.d < b.d), RW.course.interp(course, b.d)];
      segs.push({ pts, cls: RW.forecast.wxClass(a) });
    }
    return segs;
  }
  // 地図タイルを端末内でモノクロ（ダークでは反転）に描き直す。CSS の filter で見せるだけだと、iPhone Safari の
  // フルページのスクリーンショット（PDF として描き直す）でカラーに戻るため。見た目は従来の --map-filter と同じ計算
  const isDarkNow = () => { const t = document.documentElement.dataset.theme; if (t) return t === 'dark'; try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; } };
  function paintMono(canvas, img, dark) {
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const im = ctx.getImageData(0, 0, canvas.width, canvas.height), d = im.data; // CORS が通らないとここで例外（呼び出し側で CSS の filter に戻す）
    const bri = dark ? 0.85 : 1.08, con = 0.85;
    for (let i = 0; i < d.length; i += 4) {
      let l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; // grayscale(1)
      if (dark) l = 255 - l;                                         // invert(1)
      l = (l * bri - 127.5) * con + 127.5;                           // brightness → contrast
      d[i] = d[i + 1] = d[i + 2] = l < 0 ? 0 : l > 255 ? 255 : l;
    }
    ctx.putImageData(im, 0, 0);
  }
  function monoTile(url, canvas, dark, done) {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => { try { paintMono(canvas, img, dark); } catch (e) { const c = canvas.getContext('2d'); c.drawImage(img, 0, 0, canvas.width, canvas.height); canvas.classList.add('rawTile'); } done(null); };
    img.onerror = e => done(e || new Error('tile'));
    img.src = url;
  }
  // タイルの URL は 1 か所にまとめる（別の地図に替えるときはここだけ直す。OSM の利用ポリシーの推奨）
  const TILE_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  let MonoTileLayer = null;
  function monoTileLayer(dark) {
    if (!MonoTileLayer) MonoTileLayer = L.GridLayer.extend({
      createTile(coords, done) {
        const c = document.createElement('canvas'); c.width = c.height = 256;
        monoTile(TILE_URL(coords.z, coords.x, coords.y), c, this.options.dark, err => done(err, c));
        return c;
      }
    });
    return new MonoTileLayer({ maxZoom: 19, dark });
  }
  function renderMap() {
    const host = $('map');
    if (typeof L === 'undefined') { renderMapStatic(); return; }
    if (!host.clientWidth) { setTimeout(() => { if (state.result) renderMap(); }, 80); return; } // レイアウト前なら少し待って描く（非表示タブでも動くよう rAF は使わない）
    const P = state.course.pts; const hash = RW.course.hashCourse(state.course);
    const theme = isDarkNow() ? 'dark' : 'light'; // 実際の見え方で持つ（自動のまま OS の設定が変わったときも描き直す）
    if (!lmap || lmapHash !== hash || lmapTheme !== theme) {
      if (lmap) { lmap.remove(); lmap = null; }
      host.innerHTML = '<div class="leaflet" id="leaflet"></div>';
      // 出典は凡例の下に常に出すので Leaflet の出典欄は使わない。拡大縮小のボタンは PC だけ（スマホは 2 本指）
      lmap = L.map($('leaflet'), { zoomControl: false, attributionControl: false, scrollWheelZoom: true, zoomSnap: 0.25, zoomDelta: 0.5 });
      if (isWide()) L.control.zoom({ position: 'bottomright' }).addTo(lmap);
      monoTileLayer(theme === 'dark').addTo(lmap);
      lmap.createPane('chev'); lmap.getPane('chev').style.zIndex = 450; // 経路線（400）の上、風矢印など通常マーカー（600）の下
      lmap.createPane('sel'); lmap.getPane('sel').style.zIndex = 390; // 選んだ区間の縁取りは経路線の下に敷き、両側にだけ見せる
      lmapLayers = { sel: L.layerGroup().addTo(lmap), route: L.layerGroup().addTo(lmap), chev: L.layerGroup().addTo(lmap), arrows: L.layerGroup().addTo(lmap), marks: L.layerGroup().addTo(lmap), label: L.layerGroup().addTo(lmap) };
      lmap.on('zoomend moveend', updateMapArrows);
      lmapHash = hash; lmapTheme = theme;
      fitCourse();
    } else lmap.invalidateSize();
    drawMapRoute();
    updateMapArrows();
    drawSelection();
    $('mapLegend').querySelector('.lgNa').classList.toggle('hidden', !state.result.S.some(s => s.na));
  }
  // 地図の見えている範囲（上の札と凡例の下、シートの上。PC は左の欄の右）にコース全体を収める
  function mapInsets() {
    if (isWide()) return { t: 104, l: 432, r: 56, b: 24 };
    const lg = $('mapLegend').getBoundingClientRect();
    return { t: Math.round(lg.bottom) + 12, l: 20, r: 20, b: sheetH(state.sheet) + 20 };
  }
  // 選んだ区間を地図で縁取る（下げた状態では出さない）
  function drawSelection() {
    if (!lmap || !lmapLayers || !lmapLayers.sel) return;
    lmapLayers.sel.clearLayers(); lmapLayers.label.clearLayers();
    const r = (state.rows || []).find(q => q.from === state.active);
    if (!r || (state.sheet === 'peek' && !isWide())) return;
    const pts = [RW.course.interp(state.course, r.from), ...state.course.pts.filter(q => q.d > r.from && q.d < r.to), RW.course.interp(state.course, r.to)];
    L.polyline(pts.map(q => [q.lat, q.lon]), { pane: 'sel', color: cssVar('--ink'), weight: 14, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(lmapLayers.sel);
    const c = RW.course.interp(state.course, (r.from + r.to) / 2);
    const label = `${Math.round(r.from)}〜${Math.round(r.to)} km`;
    L.marker([c.lat, c.lon], { icon: L.divIcon({ className: 'selLabel', html: `<span>${label}</span>`, iconSize: [0, 0], iconAnchor: [0, 26] }), interactive: false, keyboard: false }).addTo(lmapLayers.label);
  }
  // 選んだ区間を地図の見えている範囲の中央に。拡大率はシートの状態ごとに 1 つに固定し、移動は横にずらすだけ（タイルを使い回す）
  function focusRow(k) {
    drawSelection();
    if (!lmap || !state.course) return;
    const r = (state.rows || []).find(q => q.from === k); if (!r) return;
    const m = mapInsets(), W = window.innerWidth, H = window.innerHeight;
    const vh = Math.max(120, H - m.t - m.b), vw = Math.max(120, W - m.l - m.r);
    const c = RW.course.interp(state.course, (r.from + r.to) / 2);
    const span = (r.to - r.from) * 3 * 1000; // 区間の約 3 倍の範囲が収まる拡大率
    const z = Math.min(14, Math.max(5, Math.floor(Math.log2(156543.03 * Math.cos(c.lat * Math.PI / 180) * Math.min(vh, vw) / span) * 2) / 2));
    const pt = lmap.project([c.lat, c.lon], z).add([W / 2 - (m.l + vw / 2), H / 2 - (m.t + vh / 2)]);
    lmap.setView(lmap.unproject(pt, z), z, { animate: true });
  }
  function fitCourse() {
    if (!lmap || !state.course) return;
    const m = mapInsets();
    lmap.fitBounds(L.latLngBounds(state.course.pts.map(q => [q.lat, q.lon])), { paddingTopLeft: [m.l, m.t], paddingBottomRight: [m.r, m.b], animate: false });
  }
  // 経路線：通過時刻の予報で色分け（雨＝青、曇り＝グレー、晴れ＝オレンジ、予報範囲外＝細い点線）
  function drawMapRoute() {
    if (!lmap || !state.result || !lmapLayers) return;
    lmapLayers.route.clearLayers();
    const halo = cssVar('--card');
    L.polyline(state.course.pts.map(q => [q.lat, q.lon]), { color: halo, weight: 8, opacity: .9, interactive: false }).addTo(lmapLayers.route);
    for (const sg of routeSegments(state.course, state.result.S)) {
      const ll = sg.pts.map(q => [q.lat, q.lon]);
      if (sg.cls) L.polyline(ll, { color: cssVar(WXVAR[sg.cls]), weight: 4, interactive: false }).addTo(lmapLayers.route);
      else L.polyline(ll, { color: cssVar('--na'), weight: 2, dashArray: '4 6', interactive: false }).addTo(lmapLayers.route);
    }
  }
  // 風矢印：ズームに応じて 30px 以上離れた地点だけを描く（重なり防止）。タップで詳細
  function updateMapArrows() {
    if (!lmap || !state.result || !lmapLayers) return;
    const { S, p } = state.result; const P = state.course.pts;
    lmapLayers.arrows.clearLayers(); lmapLayers.marks.clearLayers(); lmapLayers.chev.clearLayers();
    const halo = cssVar('--card'); const cols = { head: cssVar('--head'), tail: cssVar('--tail'), cross: cssVar('--cross') };
    // 進行方向の記号（>>）：一定の画素間隔で経路に沿って置く。風矢印の下に描く
    const ink = cssVar('--ink-2'); // 風矢印より控えめな色
    for (const c of chevronSpots(P, (lat, lon) => { const q = lmap.latLngToLayerPoint([lat, lon]); return [q.x, q.y]; }, 90)) {
      const icon = L.divIcon({ html: `<div style="transform:rotate(${c.ang.toFixed(1)}deg)">${chevSvg(ink, halo)}</div>`, className: 'chevIcon', iconSize: [16, 14], iconAnchor: [8, 7] });
      L.marker([c.lat, c.lon], { icon, pane: 'chev', interactive: false, keyboard: false }).addTo(lmapLayers.chev);
    }
    let last = null;
    for (const pt of S) {
      if (pt.na || !pt.cls) continue;
      const pos = lmap.latLngToLayerPoint([pt.lat, pt.lon]);
      if (last && pos.distanceTo(last) < 46) continue;
      last = pos;
      const ang = (pt.wd + 180) - 90; const len = (10 + pt.ws * 1.6) * MAP_ARROW_K; const box = len + 20;
      const html = `<svg width="${box}" height="${box}" viewBox="${-box / 2} ${-box / 2} ${box} ${box}" xmlns="http://www.w3.org/2000/svg">${mapArrow(0, 0, ang, len, cols[pt.cls])}</svg>`;
      const icon = L.divIcon({ html, className: 'windIcon', iconSize: [box, box], iconAnchor: [box / 2, box / 2] });
      L.marker([pt.lat, pt.lon], { icon, keyboard: false, title: `${Math.round(pt.d)} km ${REL[pt.cls]}風` }).on('click', () => selectRow(rowFor(pt.d), { open: true, scroll: true })).addTo(lmapLayers.arrows);
    }
    const s0 = P[0], g = P[P.length - 1];
    L.circleMarker([s0.lat, s0.lon], { radius: 12, color: halo, weight: 3, fillColor: cssVar('--ink'), fillOpacity: 1 }).bindTooltip('スタート').addTo(lmapLayers.marks);
    L.circleMarker([g.lat, g.lon], { radius: 10, color: cssVar('--ink'), weight: 3, fillColor: halo, fillOpacity: 1 }).bindTooltip('ゴール').addTo(lmapLayers.marks);
    if (p.anchor) { const q = RW.course.interp(state.course, p.anchor.d); L.circleMarker([q.lat, q.lon], { radius: 12, color: cssVar('--ink'), weight: 2.5, dashArray: '4 3', fillColor: cssVar('--sleep'), fillOpacity: .8 }).bindTooltip('現在地 ' + Math.round(p.anchor.d) + ' km').addTo(lmapLayers.marks); }
  }
  // 略地図（静的）：OpenStreetMap の標準タイルを並べ、その上に SVG でコース線と風矢印を重ねる。Leaflet 非読込時のフォールバック
  function renderMapStatic() {
    const host = $('map'); const { S } = state.result; const P = state.course.pts;
    const W = Math.max(260, Math.floor(host.clientWidth || 300)), H = Math.max(200, Math.floor(host.clientHeight || 400)); const m = mapInsets(); const pad = 26;
    const lats = P.map(q => q.lat), lons = P.map(q => q.lon);
    const minLa = Math.min(...lats), maxLa = Math.max(...lats), minLo = Math.min(...lons), maxLo = Math.max(...lons);
    // Web メルカトルの世界ピクセル座標（ズーム z）
    const proj = (lat, lon, z) => { const n = 256 * 2 ** z; const sn = Math.sin(lat * Math.PI / 180); return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * n]; };
    let z = 15;
    const vw = W - m.l - m.r, vh = H - m.t - m.b; // 札・凡例・シートに隠れない範囲に収める
    for (; z > 3; z--) { const a = proj(maxLa, minLo, z), b = proj(minLa, maxLo, z); if (b[0] - a[0] <= vw - 2 * pad && b[1] - a[1] <= vh - 2 * pad) break; }
    const c = proj((minLa + maxLa) / 2, (minLo + maxLo) / 2, z);
    const ox = Math.round(c[0] - (m.l + vw / 2)), oy = Math.round(c[1] - (m.t + vh / 2));
    const px = (lat, lon) => { const q = proj(lat, lon, z); return [q[0] - ox, q[1] - oy]; };
    // タイル（表示範囲に必要な分だけ。読めなければ外して背景色のままにする）
    const n = 2 ** z; let tiles = '';
    for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + W - 1) / 256); tx++) {
      for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + H - 1) / 256); ty++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        tiles += `<img src="${TILE_URL(z, wx, ty)}" alt="" style="left:${tx * 256 - ox}px;top:${ty * 256 - oy}px" onerror="this.remove()">`;
      }
    }
    // SVG 重ね描き：コース線（白縁取り）、風矢印（実方位・白縁取り）、スタート／ゴール
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="コース地図と風向">`;
    const toPts = arr => arr.map(q => { const v = px(q.lat, q.lon); return v[0].toFixed(1) + ',' + v[1].toFixed(1); }).join(' ');
    s += `<polyline fill="none" stroke="var(--card)" stroke-width="6" stroke-linejoin="round" stroke-linecap="round" opacity=".9" points="${toPts(P)}"/>`;
    for (const sg of routeSegments(state.course, S)) {
      if (sg.cls) s += `<polyline fill="none" stroke="var(${WXVAR[sg.cls]})" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" points="${toPts(sg.pts)}"/>`;
      else s += `<polyline fill="none" stroke="var(--na)" stroke-width="1.5" stroke-dasharray="3 5" points="${toPts(sg.pts)}"/>`;
    }
    for (const c of chevronSpots(P, px, 70)) s += `<g transform="translate(${c.x.toFixed(1)} ${c.y.toFixed(1)}) rotate(${c.ang.toFixed(1)})" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${CHEV_PATH}" stroke="var(--card)" stroke-width="4.5"/><path d="${CHEV_PATH}" stroke="var(--ink-2)" stroke-width="2"/></g>`;
    const st = Math.max(1, Math.ceil(S.length / 28));
    S.forEach((pt, i) => {
      if (pt.na || !pt.cls || i % st) return;
      const v = px(pt.lat, pt.lon); const ang = (pt.wd + 180) - 90; const len = (10 + pt.ws * 1.6) * MAP_ARROW_K; // 吹いていく向き
      s += mapArrow(v[0], v[1], ang, len, COL[pt.cls]);
    });
    const s0 = px(P[0].lat, P[0].lon), g = px(P[P.length - 1].lat, P[P.length - 1].lon);
    s += `<circle cx="${s0[0].toFixed(1)}" cy="${s0[1].toFixed(1)}" r="10" fill="var(--ink)" stroke="var(--card)" stroke-width="3"/>`;
    s += `<circle cx="${g[0].toFixed(1)}" cy="${g[1].toFixed(1)}" r="8" fill="var(--card)" stroke="var(--ink)" stroke-width="3"/>`;
    s += `<text x="${(s0[0] + 8).toFixed(1)}" y="${(s0[1] + 4).toFixed(1)}" class="tick" fill="var(--ink)" stroke="var(--card)" stroke-width="3" paint-order="stroke">スタート</text></svg>`;
    host.innerHTML = `<div class="osm" style="width:${W}px;height:${H}px">${tiles}${s}</div>`;
    const dark = isDarkNow();
    host.querySelectorAll('.osm img').forEach(im => {
      const c = document.createElement('canvas'); c.width = c.height = 256; c.className = 'tile'; c.style.cssText = im.style.cssText;
      monoTile(im.src, c, dark, err => { if (!err && !c.classList.contains('rawTile')) im.replaceWith(c); });
    });
  }
  function renderStarts() {
    const { p } = state.result; const tb = $('starts').querySelector('tbody');
    $('startsWrap').classList.toggle('hidden', !!p.anchor); // 走行中の再計算では出走時刻の比較は意味を持たない
    if (p.anchor) return;
    const rows = RW.forecast.startComparison(state.course, p, state.series);
    const full = rows.filter(r => r.n > 0 && r.nOk === r.n); // 全区間に予報がある候補だけを比べる
    const best = full.length ? full.reduce((a, b) => b.score < a.score ? b : a) : null;
    $('startsSum').textContent = best ? `おすすめ ${F.fmtDT(best.start)}（向かい風 ${best.headKm} km・雨 ${best.rainKm} km）` : '比較できる予報が不足しています（予報範囲外の候補があります）';
    tb.innerHTML = rows.map(r => `<tr class="${r === best ? 'best' : ''}"><td>${F.fmtDT(r.start)}${r.off === 0 ? ' <span class="tag">設定</span>' : ''}${r.nOk < r.n ? ' <span class="tag">一部範囲外</span>' : ''}</td>
      <td class="n">${r.nOk ? r.headKm : '—'}</td><td class="n">${r.nOk ? r.rainKm : '—'}</td><td class="n">${r.tmin ? n1(r.tmin.temp) + '℃' : '—'}</td><td>${F.fmtDT(r.goal)}</td></tr>`).join('');
  }
  function renderModelInfo() {
    const ser = state.series; if (!ser) { $('modelInfo').textContent = ''; return; }
    const parts = [];
    if (ser.msm) parts.push('MSM 初期時刻 ' + (ser.runs.msm ? F.fmtDT(ser.runs.msm) : '取得中'));
    if (ser.gsm) parts.push('GSM 初期時刻 ' + (ser.runs.gsm ? F.fmtDT(ser.runs.gsm) : '取得中'));
    parts.push('予報取得 ' + F.fmtDT(ser.fetchedAt));
    $('modelInfo').textContent = parts.join(' ／ ') + '（JST）';
  }

  // ===== 注意報・警報（V-7）とアメダス実況：気象庁ホームページの JSON を直接取得 =====
  const JMA = 'https://www.jma.go.jp/bosai/';
  // 令和 8 年（2026 年 5 月）改正後の気象庁コード表 [名称, 警戒レベル]。気象庁ページの内部表（elem × level）から転記。
  // 旧表とは番号の意味が変わっている（例：03 は旧「洪水警報」→ 新「大雨警報」、05 は旧「暴風雪警報」→ 新「暴風警報」）
  const WCODE = {
    '10': ['大雨注意報', 2], '03': ['大雨警報', 3], '43': ['大雨危険警報', 4], '33': ['大雨特別警報', 5],
    '29': ['土砂災害注意報', 2], '09': ['土砂災害警報', 3], '49': ['土砂災害危険警報', 4], '39': ['土砂災害特別警報', 5],
    '19': ['高潮注意報', 2], '08': ['高潮警報', 3], '48': ['高潮危険警報', 4], '38': ['高潮特別警報', 5],
    '15': ['強風注意報', 2], '05': ['暴風警報', 3], '35': ['暴風特別警報', 5],
    '13': ['風雪注意報', 2], '02': ['暴風雪警報', 3], '32': ['暴風雪特別警報', 5],
    '12': ['大雪注意報', 2], '06': ['大雪警報', 3], '36': ['大雪特別警報', 5],
    '16': ['波浪注意報', 2], '07': ['波浪警報', 3], '37': ['波浪特別警報', 5],
    '14': ['雷注意報', 2], '17': ['融雪注意報', 2], '20': ['濃霧注意報', 2], '21': ['乾燥注意報', 2], '22': ['なだれ注意報', 2],
    '23': ['低温注意報', 2], '24': ['霜注意報', 2], '25': ['着氷注意報', 2], '26': ['着雪注意報', 2],
    '30': ['氾濫警報', 3], '31': ['氾濫警報', 3], '40': ['氾濫危険警報', 4], '41': ['氾濫危険警報', 4], '51': ['氾濫特別警報', 5], '53': ['氾濫特別警報', 5]
  };
  // 未知のコードは番号の規則（0X＝警報、1X/2X＝注意報、3X＝特別警報、4X＝危険警報、5X＝特別警報）で仮に分類する
  const wInfo = code => WCODE[code] || ['警報・注意報 ' + code, +code >= 50 ? 5 : +code >= 40 ? 4 : +code >= 30 ? 5 : +code < 10 ? 3 : 2];
  const wLevelNum = code => wInfo(code)[1];
  // 表示クラス：adv＝注意報（レベル 2）、warn＝警報（3）、danger＝危険警報（4）、emg＝特別警報（5）
  const wLevel = code => ({ 2: 'adv', 3: 'warn', 4: 'danger', 5: 'emg' })[wLevelNum(code)] || 'adv';
  // 気象庁の警報 JSON（2026 年改正後の r8 形式は報告種別ごとの配列。旧形式のオブジェクトにも対応）→ { areas: {class20 code: [{code,status}]}, reported }
  function parseWarningReport(rep) {
    const reps = Array.isArray(rep) ? rep : [rep];
    const areas = {}; let reported = null;
    const add = (areaCode, k) => { if (!k || !k.code || k.status === '解除') return; const arr = areas[areaCode] || (areas[areaCode] = []); if (!arr.some(x => x.code === k.code)) arr.push({ code: k.code, status: k.status }); };
    for (const r of reps) {
      if (!r) continue;
      if (r.reportDatetime && (!reported || r.reportDatetime > reported)) reported = r.reportDatetime;
      if (r.warning) { for (const a of (r.warning.class20Items || [])) for (const k of (a.kinds || [])) add(a.areaCode, k); }
      else if (r.areaTypes) { for (const t of r.areaTypes) for (const a of (t.areas || [])) for (const w of (a.warnings || [])) add(a.code, w); }
    }
    return { areas, reported };
  }
  const wName = code => wInfo(code)[0];
  const AMEDAS_DIR = ['静穏', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西', '北'];
  const p2 = n => String(n).padStart(2, '0');
  async function mapLimit(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
  // 気象庁の区域表（class20 → 名前と府県予報区）。初回だけ取得して端末内に保持
  let areaIdx = null;
  async function getAreaIndex() {
    if (areaIdx) return areaIdx;
    const cached = store.get('rw:areaIdx'); if (cached && cached.v === 1) return (areaIdx = cached);
    const a = await (await fetch(JMA + 'common/const/area.json')).json();
    const idx = { v: 1, c20: {}, offices: {} };
    for (const [code, o] of Object.entries(a.offices)) idx.offices[code] = o.name;
    for (const [code, c] of Object.entries(a.class20s)) {
      let cur = c.parent; const c15 = a.class15s[cur]; cur = c15 ? c15.parent : cur; const c10 = a.class10s[cur]; cur = c10 ? c10.parent : cur;
      idx.c20[code] = [c.name, cur];
    }
    store.set('rw:areaIdx', idx); return (areaIdx = idx);
  }
  // 市区町村コード（国土地理院 逆ジオコーダ）。0.01 度単位で端末内に保持
  let muniCache = null; // 並列取得で上書きし合わないよう、メモリ上の 1 つのオブジェクトを保存する
  async function muniOf(lat, lon) {
    if (!muniCache) muniCache = store.get('rw:muni') || {};
    const key = lat.toFixed(2) + ',' + lon.toFixed(2);
    if (key in muniCache) return muniCache[key];
    const r = await fetch('https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=' + lat.toFixed(5) + '&lon=' + lon.toFixed(5));
    const j = await r.json(); const m = (j.results && j.results.muniCd) || null;
    const keys = Object.keys(muniCache); if (keys.length > 600) keys.slice(0, 200).forEach(k => delete muniCache[k]);
    muniCache[key] = m; store.set('rw:muni', muniCache); return m;
  }
  // 市区町村コード → 気象庁 class20 コード（政令市の区は市に、細分された市は複数に）
  function c20For(idx, muni) {
    if (!muni) return [];
    if (idx.c20[muni + '00']) return [muni + '00'];
    const city = muni.slice(0, 3) + '0000'; if (idx.c20[city]) return [city];
    return Object.keys(idx.c20).filter(k => k.startsWith(muni));
  }
  async function loadWarnings() {
    if (!state.result || !state.course) return;
    const { S, step } = state.result; const hash = RW.course.hashCourse(state.course);
    if (state.warnings && state.warnings.hash === hash && Date.now() - state.warnings.at < 10 * 60e3) { renderWarnings(); return; }
    const stride = Math.max(1, Math.ceil(15 / step));
    const pts = S.filter((x, i) => i % stride === 0 || i === S.length - 1);
    try {
      const idx = await getAreaIndex();
      const munis = await mapLimit(pts, 4, pt => muniOf(pt.lat, pt.lon).catch(() => null));
      const segs = [];
      pts.forEach((pt, i) => {
        const codes = c20For(idx, munis[i]); const key = codes.join('|'); const last = segs[segs.length - 1];
        if (last && last.key === key) { last.to = pt.d; return; }
        segs.push({ key, codes, from: pt.d, to: pt.d, name: codes.length ? idx.c20[codes[0]][0] : '海上・判定不能', office: codes.length ? idx.c20[codes[0]][1] : null, warnings: [], reported: null, status: codes.length ? 'pending' : 'unknown' });
      });
      for (let i = 0; i < segs.length - 1; i++) segs[i].to = segs[i + 1].from;
      if (segs.length > 1 && segs[segs.length - 1].from >= state.course.total - 1e-6) segs.pop(); // ゴール地点だけの空区間は前の区間に含める
      segs[segs.length - 1].to = state.course.total;
      const offices = [...new Set(segs.map(x => x.office).filter(Boolean))];
      const reports = {};
      await Promise.all(offices.map(async o => { try { reports[o] = parseWarningReport(await (await fetch(JMA + 'warning/data/r8/' + o + '.json')).json()); } catch (e) { reports[o] = null; } }));
      if (!state.course || RW.course.hashCourse(state.course) !== hash) return; // 取得中にコースが変わった
      for (const sg of segs) {
        if (sg.status === 'unknown') continue;
        const rep = reports[sg.office]; if (!rep) { sg.status = 'failed'; continue; } // 取得失敗は「なし」と区別する
        sg.status = 'ok'; sg.reported = rep.reported;
        for (const code of sg.codes) for (const w of (rep.areas[code] || [])) { if (!sg.warnings.some(x => x.code === w.code)) sg.warnings.push(w); }
      }
      state.warnings = { hash, at: Date.now(), segs, offices: offices.map(o => idx.offices[o] || o), failed: offices.filter(o => !reports[o]).length, total: offices.length };
    } catch (e) { state.warnings = { hash, at: Date.now(), segs: [], error: e.message }; }
    renderWarnings();
  }
  function renderWarnings() {
    const w = state.warnings; const wrap = $('warnWrap');
    if (!w || !state.result) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    const tb = $('warnTable').querySelector('tbody');
    if (w.error || !w.segs.length) { tb.innerHTML = `<tr><td colspan="3">取得できませんでした${w.error ? '（' + esc(w.error) + '）' : ''}</td></tr>`; $('warnNote').textContent = ''; $('warnSum').textContent = '取得できませんでした'; return; }
    const allFailed = w.total > 0 && w.failed === w.total;
    { // 折りたたみ時の要約：発表中の種類を列挙（警報以上を先に）。未取得は「なし」と言わない
      const names = [...new Set(w.segs.flatMap(x => x.warnings.map(y => y.code)))].sort((c1, c2) => wLevelNum(c2) - wLevelNum(c1) || (+c1) - (+c2)).map(wName);
      const okSegs = w.segs.some(x => x.status === 'ok');
      $('warnSum').textContent = allFailed || !okSegs ? '確認できませんでした（取得失敗）' : (names.length ? '発表中：' + names.join('・') : '発表中の注意報・警報なし') + (w.failed ? '　※一部未取得' : '');
    }
    const cell = sg => sg.status === 'failed' ? '<span class="sub">取得できませんでした</span>' : sg.status === 'unknown' ? '<span class="sub">判定できません</span>' :
      (sg.warnings.length ? sg.warnings.map(x => `<span class="wtag ${wLevel(x.code)}">${esc(wName(x.code))}</span>`).join('') : '<span class="sub">なし</span>');
    tb.innerHTML = w.segs.map(sg => `<tr><td class="n">${Math.round(sg.from)}–${Math.round(sg.to)} km</td><td>${esc(sg.name)}</td><td class="wrap">${cell(sg)}</td></tr>`).join('');
    const rep = w.segs.map(x => x.reported).filter(Boolean).sort().pop();
    if (state.rows) { const st = $('sheetBody').scrollTop; renderRows(); $('sheetBody').scrollTop = st; }
    $('warnNote').textContent = `対象：${w.offices.join('・')}${rep ? '　発表 ' + F.fmtDT(Date.parse(rep)) : ''}　確認 ${F.fmtH(w.at)}。約 15 km ごとの地点で市区町村を判定しています（海上・河川上は判定できないことがあります）。${w.failed ? ' 一部の府県で取得に失敗しました。' : ''}`;
    renderNotice();
  }
  // アメダス：現在地（無ければスタート）から 50 km ごとに最寄りの観測所の最新値
  let amedasTbl = null;
  async function getAmedasTable() {
    if (amedasTbl) return amedasTbl;
    const cached = store.get('rw:amedas'); if (cached && cached.v === 1 && Date.now() - cached.at < 30 * 86400e3) return (amedasTbl = cached.list);
    const t = await (await fetch(JMA + 'amedas/const/amedastable.json')).json();
    const list = Object.entries(t).filter(([id, v]) => v.type !== 'E' && v.lat && v.lon).map(([id, v]) => ({ id, name: v.kjName, lat: v.lat[0] + v.lat[1] / 60, lon: v.lon[0] + v.lon[1] / 60, alt: v.alt, elems: v.elems }));
    store.set('rw:amedas', { v: 1, at: Date.now(), list }); return (amedasTbl = list);
  }
  async function loadAmedas() {
    if (!state.result || !state.course) return;
    const { p } = state.result; const hash = RW.course.hashCourse(state.course) + ':' + (p.anchor ? Math.round(p.anchor.d) : 0);
    if (state.amedas && state.amedas.hash === hash && Date.now() - state.amedas.at < 10 * 60e3) { renderAmedas(); return; }
    try {
      const latest = (await (await fetch(JMA + 'amedas/data/latest_time.txt')).text()).trim();
      const x = F.jstParts(Date.parse(latest)); const bucket = `${x.y}${p2(x.mo)}${p2(x.d)}_${p2(Math.floor(x.h / 3) * 3)}`;
      const tbl = await getAmedasTable();
      const d0 = p.anchor ? p.anchor.d : 0; const targets = [];
      for (let d = d0; d <= state.course.total && targets.length < 4; d += 50) targets.push({ d, pt: RW.course.interp(state.course, d) });
      const seen = new Set(); const picks = [];
      for (const tg of targets) {
        let best = null, bd = Infinity;
        for (const st of tbl) { if (st.elems[1] !== '1' && st.elems[2] !== '1') continue; const dd = RW.course.hav(tg.pt, st); if (dd < bd) { bd = dd; best = st; } }
        if (best && !seen.has(best.id)) { seen.add(best.id); picks.push({ d: tg.d, st: best, dist: bd }); }
      }
      const rows = await Promise.all(picks.map(async pk => {
        try { const j = await (await fetch(JMA + `amedas/data/point/${pk.st.id}/${bucket}.json`)).json(); const ks = Object.keys(j).sort(); const k = ks[ks.length - 1]; return Object.assign({ time: k, obs: j[k] }, pk); }
        catch (e) { return Object.assign({ err: true }, pk); }
      }));
      if (!state.course || RW.course.hashCourse(state.course) + ':' + (p.anchor ? Math.round(p.anchor.d) : 0) !== hash) return; // 取得中にコースが変わった
      state.amedas = { hash, at: Date.now(), latest, rows };
    } catch (e) { state.amedas = { hash, at: Date.now(), rows: [], error: e.message }; }
    renderAmedas();
  }
  function renderAmedas() {
    const a = state.amedas; const wrap = $('amedasWrap');
    if (!a || !state.result) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    const tb = $('amedasTable').querySelector('tbody');
    if (a.error || !a.rows.length) { tb.innerHTML = `<tr><td colspan="7">取得できませんでした${a.error ? '（' + esc(a.error) + '）' : ''}</td></tr>`; $('amedasNote').textContent = ''; $('amedasSum').textContent = '取得できませんでした'; return; }
    const val = (o, k) => (o && o[k] && o[k][1] === 0 && o[k][0] != null) ? o[k][0] : null;
    { // 折りたたみ時の要約：先頭（現在地に最も近い）観測所の値
      const r0 = a.rows.find(r => !r.err);
      if (r0) { const o = r0.obs; const temp = val(o, 'temp'), ws = val(o, 'wind'), wd = val(o, 'windDirection'), pr = val(o, 'precipitation1h');
        $('amedasSum').textContent = `${r0.st.name} ${r0.time.slice(8, 10)}:${r0.time.slice(10, 12)}　${temp != null ? n1(temp) + '℃' : ''}　${ws != null ? (wd != null ? AMEDAS_DIR[wd] + ' ' : '') + n1(ws) + ' m/s' : ''}${pr ? '　' + n1(pr) + ' mm' : ''}`; }
      else $('amedasSum').textContent = '';
    }
    tb.innerHTML = a.rows.map(r => {
      if (r.err) return `<tr><td class="n">${Math.round(r.d)} km</td><td>${esc(r.st.name)}</td><td colspan="5">取得できませんでした</td></tr>`;
      const o = r.obs; const t = r.time; const temp = val(o, 'temp'), ws = val(o, 'wind'), wd = val(o, 'windDirection'), pr = val(o, 'precipitation1h'), rh = val(o, 'humidity');
      return `<tr><td class="n">${Math.round(r.d)} km</td><td>${esc(r.st.name)}<br><small class="sub">コースから約 ${r.dist.toFixed(0)} km・標高 ${r.st.alt} m</small></td><td>${t.slice(8, 10)}:${t.slice(10, 12)}</td><td class="n">${temp != null ? n1(temp) + '℃' : '—'}</td><td>${ws != null ? (wd != null ? AMEDAS_DIR[wd] + ' ' : '') + n1(ws) + ' m/s' : '—'}</td><td class="n">${pr != null ? n1(pr) + ' mm' : '—'}</td><td class="n">${rh != null ? Math.round(rh) + '%' : '—'}</td></tr>`;
    }).join('');
    $('amedasNote').textContent = `${state.result.p.anchor ? '現在地' : 'スタート'}から 50 km ごとに最寄りの観測所。観測 ${F.fmtDT(Date.parse(a.latest))}、確認 ${F.fmtH(a.at)}。`;
  }

  const FONT = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif';
  // canvas 用の折り返し（日本語は文字単位で折る）
  function wrapText(ctx, str, maxW) {
    const out = []; let cur = '', brk = -1; const BR = ' 、／・）〜';
    for (const ch of String(str)) {
      if (ctx.measureText(cur + ch).width > maxW && cur) {
        if (brk > 0) { out.push(cur.slice(0, brk).trimEnd()); cur = cur.slice(brk).trimStart() + ch; } else { out.push(cur); cur = ch; }
        brk = -1;
      } else cur += ch;
      if (BR.includes(ch)) brk = cur.length; // 区切りの直後で折る
    }
    if (cur) out.push(cur);
    return out;
  }
  const SHARE_TAG = '#routeweatherjp';
  // canvas → PNG → 共有シート（共有非対応なら保存）
  async function deliverPng(canvas, name) {
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('PNG を作れませんでした');
    const file = new File([blob], name, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      // SNS に貼られる文言はハッシュタグ（X などは text を、他は title を使うので両方に入れる）
      try { await navigator.share({ files: [file], title: SHARE_TAG, text: SHARE_TAG }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  // ===== 画像で共有（v3）：地図と要点を 1 枚に。1080×1350（上＝コース名と走行計画、中＝地図、下＝ゴール予定と 5 指標・出典） =====
  const IMG_W = 1080, IMG_H = 1350, IMG_HEAD = 172, IMG_MAP_H = 830;
  // 地図の部分：モノクロのタイル＋天気で色分けした経路＋進行方向＋風矢印。画像は常にライトの色で描く
  async function drawShareMap(W, H) {
    const { S, p } = state.result; const P = state.course.pts; const pad = 64, padBot = 120; // 下＝凡例
    const lats = P.map(q => q.lat), lons = P.map(q => q.lon);
    const minLa = Math.min(...lats), maxLa = Math.max(...lats), minLo = Math.min(...lons), maxLo = Math.max(...lons);
    const proj = (lat, lon, z) => { const n = 256 * 2 ** z; const sn = Math.sin(lat * Math.PI / 180); return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * n]; };
    let z = 17;
    for (; z > 3; z--) { const a = proj(maxLa, minLo, z), b = proj(minLa, maxLo, z); if (b[0] - a[0] <= W - 2 * pad && b[1] - a[1] <= H - pad - padBot) break; }
    const c = proj((minLa + maxLa) / 2, (minLo + maxLo) / 2, z);
    const ox = Math.round(c[0] - W / 2), oy = Math.round(c[1] - pad - (H - pad - padBot) / 2);
    const px = (lat, lon) => { const q = proj(lat, lon, z); return [q[0] - ox, q[1] - oy]; };
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#EDEDED'; ctx.fillRect(0, 0, W, H);
    // タイル（画像の範囲の分だけ。cross-origin で読み、読めないタイルは背景のまま）
    const n = 2 ** z; const jobs = [];
    for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + W - 1) / 256); tx++) {
      for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + H - 1) / 256); ty++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        jobs.push(new Promise(res => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res({ im, x: tx * 256 - ox, y: ty * 256 - oy }); im.onerror = () => res(null); im.src = TILE_URL(z, wx, ty); }));
      }
    }
    for (const t of await Promise.all(jobs)) if (t) ctx.drawImage(t.im, t.x, t.y);
    try { // モノクロ・淡めに（画面の地図と同じ見え方）
      const img = ctx.getImageData(0, 0, W, H); const d = img.data;
      for (let i = 0; i < d.length; i += 4) { let l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); l = ((l - 128) * 0.85 + 128) * 1.08; l = l < 0 ? 0 : l > 255 ? 255 : l; d[i] = d[i + 1] = d[i + 2] = l; }
      ctx.putImageData(img, 0, 0);
    } catch (e) { /* CORS が通らなかったときはそのまま */ }
    const v = name => IMG_COL[name] || '#000';
    const line = (pts, color, w, dash) => { ctx.beginPath(); pts.forEach((q, i) => { const a = px(q.lat, q.lon); if (i) ctx.lineTo(a[0], a[1]); else ctx.moveTo(a[0], a[1]); }); ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]); };
    line(P, '#FFFFFF', 14);
    for (const sg of routeSegments(state.course, S)) { if (sg.cls) line(sg.pts, v(WXVAR[sg.cls]), 7); else line(sg.pts, v('--na'), 3, [8, 10]); }
    const chevC = (c, color, w, k) => { ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.ang * Math.PI / 180); ctx.scale(k, k); ctx.strokeStyle = color; ctx.lineWidth = w / k; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(-6, -5); ctx.lineTo(-1, 0); ctx.lineTo(-6, 5); ctx.moveTo(0, -5); ctx.lineTo(5, 0); ctx.lineTo(0, 5); ctx.stroke(); ctx.restore(); };
    for (const c of chevronSpots(P, px, 110)) { chevC(c, '#FFFFFF', 8, 2); chevC(c, '#4A5B50', 3.5, 2); }
    const arrowC = (x, y, angDeg, len, color, w) => { ctx.save(); ctx.translate(x, y); ctx.rotate(angDeg * Math.PI / 180); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(-len / 2, 0); ctx.lineTo(len / 2, 0); ctx.stroke(); ctx.beginPath(); ctx.moveTo(len / 2 + 3, 0); ctx.lineTo(len / 2 - 14, -9); ctx.lineTo(len / 2 - 14, 9); ctx.closePath(); ctx.fill(); ctx.restore(); };
    let last = null;
    for (const pt of S) {
      if (pt.na || !pt.cls) continue;
      const a = px(pt.lat, pt.lon);
      if (last && Math.hypot(a[0] - last[0], a[1] - last[1]) < 56) continue;
      last = a; const ang = (pt.wd + 180) - 90; const len = (20 + pt.ws * 2.6) * 1.4;
      arrowC(a[0], a[1], ang, len, '#FFFFFF', 12); arrowC(a[0], a[1], ang, len, v('--' + pt.cls), 5.5);
    }
    const dot = (q, r, fill, stroke) => { const a = px(q.lat, q.lon); ctx.beginPath(); ctx.arc(a[0], a[1], r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = stroke; ctx.stroke(); };
    dot(P[0], 18, v('--ink'), '#FFFFFF'); dot(P[P.length - 1], 15, '#FFFFFF', v('--ink'));
    if (p.anchor) dot(RW.course.interp(state.course, p.anchor.d), 18, '#6E5A8E', '#FFFFFF');
    // 凡例（左下）と出典（右下。OSM の利用条件）
    const box = (x, y, w, h) => { ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, 10); else ctx.rect(x, y, w, h); ctx.fill(); };
    ctx.font = '20px ' + FONT;
    const items = [['line', v('--wx-sun'), '晴れ'], ['line', v('--wx-cloud'), '曇り'], ['line', v('--wx-rain'), '雨'], ['arrow', v('--head'), '向かい風'], ['arrow', v('--cross'), '横風'], ['arrow', v('--tail'), '追い風']];
    if (S.some(s => s.na)) items.splice(3, 0, ['dash', v('--na'), '範囲外']);
    const lw = items.reduce((a, it) => a + 32 + ctx.measureText(it[2]).width + 16, 0) + 12, lh = 44, ly = H - 16 - lh;
    box(16, ly, lw, lh);
    let x = 28; const yy = ly + 29;
    for (const [kind, color, label] of items) {
      if (kind === 'arrow') { arrowC(x + 12, yy - 7, -90, 22, '#FFFFFF', 8); arrowC(x + 12, yy - 7, -90, 22, color, 3.5); }
      else { ctx.strokeStyle = color; ctx.lineWidth = kind === 'dash' ? 3 : 7; ctx.lineCap = 'round'; ctx.setLineDash(kind === 'dash' ? [6, 7] : []); ctx.beginPath(); ctx.moveTo(x, yy - 7); ctx.lineTo(x + 24, yy - 7); ctx.stroke(); ctx.setLineDash([]); }
      x += 32; ctx.fillStyle = '#102A1E'; ctx.fillText(label, x, yy); x += ctx.measureText(label).width + 16;
    }
    const attr = '© OpenStreetMap contributors'; const tw = ctx.measureText(attr).width;
    box(W - tw - 40, ly, tw + 24, lh); ctx.fillStyle = '#4A5B50'; ctx.fillText(attr, W - tw - 28, yy);
    return canvas;
  }
  // 共有画像は画面の表示モードによらずライトの色で描く
  const IMG_COL = { '--wx-rain': '#6E9AD6', '--wx-cloud': '#A6AEB3', '--wx-sun': '#F0B36B', '--na': '#6F7A80', '--ink': '#102A1E', '--ink-2': '#4A5B50', '--ink-3': '#85918A', '--line': '#D2DACF', '--head': '#C8462B', '--tail': '#2E7D5B', '--cross': '#C79A2F', '--rain': '#3B6FB6' };
  async function shareMapImage() {
    if (!state.result) return;
    const { p } = state.result; const W = IMG_W, H = IMG_H, padX = 48;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
    const fit = (s, maxW) => { if (ctx.measureText(s).width <= maxW) return s; let t = s; while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; };
    // 上：サイト名・コース名・走行計画
    ctx.fillStyle = '#11532C'; ctx.font = 'bold 26px ' + FONT; ctx.fillText('Route-Weather.jp', padX, 52);
    ctx.fillStyle = IMG_COL['--ink']; ctx.font = 'bold 42px ' + FONT; ctx.fillText(fit(state.course.name, W - padX * 2), padX, 108);
    const sleepMin = p.sleeps.reduce((a, x) => a + x.m, 0);
    const plan = [`${F.fmtDT(p.start)} 出走`, `${p.spd} km/h`, `${n1(state.course.total)} km`, p.sleeps.length ? `仮眠 ${p.sleeps.length} 回・${sleepMin} 分` : '', p.anchor ? `現在地 ${Math.round(p.anchor.d)} km（${F.fmtH(p.anchor.t)}）から` : ''].filter(Boolean).join('　');
    ctx.fillStyle = IMG_COL['--ink-2']; ctx.font = '26px ' + FONT; ctx.fillText(fit(plan, W - padX * 2), padX, 150);
    // 中：地図
    ctx.drawImage(await drawShareMap(W, IMG_MAP_H), 0, IMG_HEAD);
    // 下：ゴール予定と 5 指標（画面の要点と同じ形）
    const cards = summaryCards(); const goal = cards[0], kpis = cards.slice(1);
    let y = IMG_HEAD + IMG_MAP_H + 56;
    ctx.fillStyle = IMG_COL['--ink-2']; ctx.font = '26px ' + FONT; ctx.fillText('ゴール予定', padX, y);
    y += 56; ctx.fillStyle = IMG_COL['--ink']; ctx.font = 'bold 50px ' + FONT; ctx.fillText(goal.v, padX, y);
    const gw = ctx.measureText(goal.v).width; ctx.fillStyle = IMG_COL['--ink-2']; ctx.font = '28px ' + FONT; ctx.fillText(fit(goal.s || '', W - padX * 2 - gw - 20), padX + gw + 20, y);
    if (kpis.length) {
      const ky = y + 26, cw = (W - padX * 2) / kpis.length, vcol = { head: IMG_COL['--head'], rain: IMG_COL['--rain'] };
      ctx.fillStyle = IMG_COL['--ink']; ctx.fillRect(padX, ky, W - padX * 2, 3);
      ctx.fillStyle = IMG_COL['--line']; ctx.fillRect(padX, ky + 112, W - padX * 2, 2);
      kpis.forEach((c, i) => {
        const x = padX + i * cw;
        ctx.fillStyle = IMG_COL['--ink-2']; ctx.font = '24px ' + FONT; ctx.fillText(c.k, x, ky + 40);
        ctx.fillStyle = vcol[c.cls] || IMG_COL['--ink']; ctx.font = 'bold 46px ' + FONT; ctx.fillText(c.num, x, ky + 94);
        if (c.unit) { const w = ctx.measureText(c.num).width; ctx.fillStyle = IMG_COL['--ink-2']; ctx.font = '600 24px ' + FONT; ctx.fillText(c.unit, x + w + 2, ky + 94); }
      });
      y = ky + 112;
    }
    ctx.fillStyle = IMG_COL['--ink-3']; ctx.font = '20px ' + FONT;
    wrapText(ctx, '出典：気象庁 数値予報（MSM/GSM）— Open-Meteo 経由 ／ 予報取得 ' + F.fmtDT(state.series.fetchedAt), W - padX * 2).slice(0, 2).forEach((ln, i) => ctx.fillText(ln, padX, Math.min(H - 16, y + 40 + i * 28)));
    await deliverPng(canvas, `route-weather-${F.ymd(p.start)}.png`);
  }

  // ===== 現在位置 → コース上の距離 → 走行中の再計算（ADD_01） =====
  const fmtM = m => m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
  function posMsg(html, cls, target) {
    const el = $(target || state.posTarget); if (!el) return;
    if (!html) { el.className = 'posMsg hidden'; el.innerHTML = ''; return; }
    el.className = 'posMsg' + (cls ? ' ' + cls : ''); el.innerHTML = html;
  }
  function posStore() { const h = store.get('rw:posHist'); return (h && state.course && h.hash === RW.course.hashCourse(state.course)) ? h : { hash: state.course ? RW.course.hashCourse(state.course) : '', list: [], done: [] }; }
  function posHistory() { return posStore().list || []; }
  function doneSleeps() { return posStore().done || []; }
  const R4 = '位置情報の利用が許可されていません。iPhone の 設定 → プライバシーとセキュリティ → 位置情報サービス → Safari で許可してください';
  const R5 = '位置を取得できませんでした。空が開けた場所で再度お試しください';
  // 位置取得に失敗したときだけ出す、現在キロ数の手入力欄（v1.1.1：設定欄の P-5 入力は非表示にした）
  const manualForm = '<div class="manual"><span class="lbl">代わりに現在のキロ数を入力して再計算できます</span><input type="number" class="manualKm" inputmode="decimal" min="0" step="0.1" placeholder="現在 km" aria-label="現在のキロ数"><button type="button" class="btn small manualGo">再計算</button></div>';
  function bindManual(scope) {
    scope.querySelectorAll('.clearAnchor').forEach(x => x.addEventListener('click', e => { e.preventDefault(); clearAnchor(); }));
    const btn = scope.querySelector('.manualGo'), inp = scope.querySelector('.manualKm'); if (!btn || !inp) return;
    const go = () => { const km = +inp.value; if (!inp.value || !(km >= 0) || km > state.course.total) { inp.focus(); return; } commitManual(km); };
    btn.addEventListener('click', go); inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  }
  function clearAnchor() {
    $('ancD').value = ''; $('ancT').value = ''; state.lastPos = null; state.forecastStale = '';
    posMsg('', '', 'posMsg'); posMsg('', '', 'gpsMsg'); onParamChange();
  }
  async function commitManual(km) {
    const t = Date.now();
    $('ancD').value = km.toFixed(1); $('ancT').value = localDT(t);
    state.lastPos = { d: km, t, acc: null, distM: null, clock: null, posT: null, source: 'manual' };
    saveParams();
    posMsg(`${Math.round(km)} km 地点として再計算しました`);
    await refreshForecastFrom(km);
    state.fromHere = true; recompute(); showHere();
    setTimeout(renderPosStatus, 3000);
  }

  // R-12〜R-14：NICT の時刻。3 秒で諦めて端末時計にする（2026-09-07 時点で NICT の JSON は 404 のため実質フォールバック）
  async function serverTime() {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 3000); const t0 = Date.now();
    try {
      const r = await fetch('https://ntp-a1.nict.go.jp/cgi-bin/json', { signal: ctrl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(); const t1 = Date.now();
      if (!j || typeof j.st !== 'number') throw new Error('bad json');
      const st = j.st * 1000 + (t1 - t0) / 2;
      return { t: st, source: 'nict', skew: st - t1 };
    } catch (e) { return { t: Date.now(), source: 'device', skew: 0 }; }
    finally { clearTimeout(timer); }
  }
  // R-1〜R-2：getCurrentPosition を 1 回だけ
  function getPosition() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) { rej({ code: 0, message: 'geolocation unsupported' }); return; }
      navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    });
  }
  async function gpsRefresh() {
    state.posTarget = 'gpsMsg';
    if (!state.course || !state.result) { posMsg('先にコースを読み込み、出走日時と速度を設定してください', 'err'); return; }
    const btn = $('gps'); if (btn.disabled) return;
    const label = btn.querySelector('.lbl'); btn.disabled = true; label.textContent = '位置を取得中…'; posMsg('');
    try {
      const [posR, timeR] = await Promise.allSettled([getPosition(), serverTime()]); // R-15：並行取得
      if (posR.status === 'rejected') {
        const e = posR.reason; posMsg((e && e.code === 1 ? R4 : R5) + manualForm, 'err'); bindManual($('gpsMsg')); return;
      }
      const pos = posR.value; const tm = timeR.status === 'fulfilled' ? timeR.value : { t: Date.now(), source: 'device', skew: 0 };
      label.textContent = '予報を更新中…';
      await applyPosition({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, t: tm.t, posT: pos.timestamp, clock: tm, source: 'gps' });
    } finally { btn.disabled = false; label.textContent = '現在位置から予報を再取得'; }
  }
  // pos = { lat, lon, accuracy(m), t(ms), posT?, clock?, source }
  async function applyPosition(pos) {
    if (!state.course || !state.result) { posMsg('先にコースを読み込み、出走日時と速度を設定してください', 'err'); return; }
    const p = params();
    const loc = RW.locate.locateOnCourse(state.course, pos.lat, pos.lon);
    if (!loc.candidates.length) { // R-8：1 km 超は走行中とみなさない
      posMsg(`コースから約 ${fmtM(loc.nearest ? loc.nearest.distM : Infinity)} 離れています。コース上で再取得するか、距離を手入力してください` + manualForm, 'err'); bindManual($(state.posTarget));
      return;
    }
    const hist = posHistory(); const prev = hist.length ? hist[hist.length - 1] : null;
    const plannedD = RW.plan.distAtTime(state.course, Object.assign({}, p, { anchor: null }), pos.t);
    const ch = RW.locate.chooseCandidate(loc.candidates, { prev, now: pos.t, spd: p.spd, plannedD });
    if (ch.kind === 'ask') { // R-10 (c)：利用者に選ばせる
      posMsg('現在地に近いコース上の地点が複数あります。どちらですか？<div class="choices">' +
        ch.cands.map((c, i) => `<button type="button" class="btn small" data-i="${i}">${Math.round(c.d)} km 付近（コースから ${fmtM(c.distM)}）</button>`).join('') + '</div>');
      $(state.posTarget).querySelectorAll('button').forEach(b => b.addEventListener('click', () => commitPosition(ch.cands[+b.dataset.i], pos)));
      return;
    }
    await commitPosition(ch.cand, pos);
  }
  // R-11：確定した距離と時刻を P-5 の欄に書き込み、予報を取り直してから同じ再計算を通す。履歴（R-21）は端末内に最大 50 件
  async function commitPosition(cand, pos) {
    $('ancD').value = cand.d.toFixed(1); $('ancT').value = localDT(pos.t);
    const ps = posStore(); ps.list = (ps.list || []).concat([{ d: cand.d, t: pos.t, acc: pos.accuracy, distM: cand.distM, source: pos.source }]).slice(-50);
    store.set('rw:posHist', ps);
    state.lastPos = { d: cand.d, t: pos.t, acc: pos.accuracy, distM: cand.distM, clock: pos.clock || null, posT: pos.posT || null, source: pos.source };
    saveParams();
    posMsg(`${Math.round(cand.d)} km 地点として再計算しました`); // R-23
    await refreshForecastFrom(cand.d); // R-18/R-19
    state.fromHere = true; recompute(); showHere();
    setTimeout(renderPosStatus, 3000);
  }
  function showHere() { const a = state.result && state.result.p.anchor; if (a && state.rows && state.rows.length) selectRow(state.rows[0].from, { scroll: true }); }
  // ステータス行（R-3, R-9, R-13〜R-15, R-17, R-19）
  function renderPosStatus() {
    const lp = state.lastPos; if (!lp || !state.result) return;
    const p = state.result.p; const manual = lp.source === 'manual';
    const parts = [`現在地 ${Math.round(lp.d)} km`, manual ? `${F.fmtH(lp.t)} 手入力` : `${F.fmtH(lp.t)} 取得`];
    if (!manual) parts.push(`GPS 精度 ±${Math.round(lp.acc)} m`);
    const run = state.series && state.series.runs && state.series.runs.msm; if (run) parts.push(`予報 ${F.fmtH(run)} 発表`);
    if (!lp.clock || lp.clock.source !== 'nict') parts.push('端末時計');
    let html = parts.join(' ・ '); let cls = '';
    if (!manual && lp.acc > 500) { html += `<br>GPS 精度が ±${Math.round(lp.acc)} m と低いため、位置がずれている可能性があります`; cls = 'warn'; }
    if (lp.clock && lp.clock.source === 'nict' && Math.abs(lp.clock.skew) > 60e3) html += `<br>端末の時計が ${Math.round(Math.abs(lp.clock.skew) / 1000)} 秒ずれています`;
    if (lp.posT && Math.abs(lp.t - lp.posT) > 30e3) html += `<br>位置は ${Math.round(Math.abs(lp.t - lp.posT) / 1000)} 秒前のものです`;
    if (state.forecastStale) { html += '<br>' + esc(state.forecastStale); cls = 'warn'; }
    const near = p.sleeps.find(x => x.d >= lp.d && x.d - lp.d <= 2); // R-17：±2 km 先の仮眠は確認（既定は「する」）
    if (near) html += `<br>仮眠ポイント（${Math.round(near.d)} km・${near.m} 分）が近くにあります。これから仮眠しますか？<div class="choices"><button type="button" class="btn small" data-sleep="keep">する（既定）</button><button type="button" class="btn small" data-sleep="skip">しない</button></div>`;
    html += '<br><a href="#" class="clearAnchor">再計算を解除して計画に戻す</a>';
    posMsg(html, cls);
    const el = $(state.posTarget); bindManual(el);
    el.querySelectorAll('[data-sleep]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.sleep === 'skip') { const ps = posStore(); ps.done = [...new Set((ps.done || []).concat([+near.d]))]; store.set('rw:posHist', ps); }
      recompute(); renderPosStatus();
    }));
  }

  // ===== 配線 =====
  // ===== v3：下から引き出すシート（下げた状態・半分・全部）。PC では左の欄で常に開く =====
  const isWide = () => window.innerWidth >= 900;
  function sheetH(st) {
    if (isWide()) return 0;
    const H = window.innerHeight;
    if (st === 'half') return Math.round(H * 0.6);
    if (st === 'full') { const b = document.querySelector('.bar').getBoundingClientRect(); return Math.round(H - b.bottom - 8); }
    // 下げた状態：要点とコース全体の帯まで（下端の安全領域を足す）
    const body = $('sheetBody'), strip = $('strip');
    const safe = Math.max(0, parseFloat(getComputedStyle(body).paddingBottom) - 16);
    return Math.min(Math.round(H * 0.5), Math.round(strip.offsetTop + strip.offsetHeight + 12 + safe));
  }
  function setSheet(st) {
    state.sheet = st; const sh = $('sheet'); sh.dataset.state = st;
    document.documentElement.classList.toggle('sheetFull', st === 'full');
    if (st === 'peek') $('sheetBody').scrollTop = 0;
    sheetLayout(); drawSelection();
    if (st === 'peek') setTimeout(fitCourse, 300); else if (state.active != null) setTimeout(() => focusRow(state.active), 300);
  }
  function sheetLayout() { if (isMap()) document.documentElement.style.setProperty('--sheet-h', sheetH(state.sheet) + 'px'); }
  function setMapMode(on) {
    const was = isMap();
    document.documentElement.classList.toggle('mapMode', on);
    if (on && !was) { state.sheet = 'peek'; $('sheet').dataset.state = 'peek'; }
    if (!on) { closePlan(); document.documentElement.classList.remove('sheetFull'); }
  }
  { // シートの上げ下げ。取っ手を押すと 下げた → 半分 → 全部 → 下げた。上下に引くと近い段階へ（v3.0.1）
    // 下げた状態ではシートのどこを引いても動かす。半分・全部では取っ手か、中身がいちばん上までスクロールしてあるときの引き下げで動かす（それ以外は中身のスクロール）
    const sh = $('sheet'), grab = $('grab'), body = $('sheetBody'); const ORDER = ['peek', 'half', 'full'];
    let drag = null, quietUntil = 0;
    const start = (y, target) => {
      if (isWide() || !isMap()) return;
      const onGrab = !!target.closest('#grab');
      if (!onGrab && state.sheet !== 'peek' && body.scrollTop > 0) return;
      drag = { y0: y, h0: sh.offsetHeight, onGrab, moved: false, d: 0 };
    };
    const move = (y, ev) => {
      if (!drag) return; const d = drag.y0 - y; // 上向きが正
      if (!drag.moved) {
        if (Math.abs(d) < 8) return;
        if (!drag.onGrab && state.sheet !== 'peek' && d > 0) { drag = null; return; } // 中身を上へスクロールする操作
        drag.moved = true; sh.classList.add('drag');
      }
      if (ev.cancelable) ev.preventDefault();
      drag.d = d; document.documentElement.style.setProperty('--sheet-h', Math.max(120, Math.min(sheetH('full'), drag.h0 + d)) + 'px');
    };
    const end = () => {
      if (!drag) return; const dr = drag; drag = null;
      if (!dr.moved) return; // 押しただけ（取っ手は click で段階を送る）
      sh.classList.remove('drag'); quietUntil = Date.now() + 400; // 引いた直後の click（行や指標）は無視する
      const h = sh.offsetHeight, cur = ORDER.indexOf(state.sheet);
      let next = ORDER.slice().sort((x, y) => Math.abs(sheetH(x) - h) - Math.abs(sheetH(y) - h))[0];
      if (next === state.sheet && Math.abs(dr.d) > 40) next = ORDER[Math.max(0, Math.min(2, cur + (dr.d > 0 ? 1 : -1)))]; // 少し引いただけでも向きに合わせて 1 段動かす
      setSheet(next);
    };
    // 指は touch で扱う（下げた状態は本文のスクロールが無いので、preventDefault で画面ごと動くのを止める）
    sh.addEventListener('touchstart', e => { if (e.touches.length === 1) start(e.touches[0].clientY, e.target); else drag = null; }, { passive: true });
    sh.addEventListener('touchmove', e => { if (drag && e.touches.length === 1) move(e.touches[0].clientY, e); }, { passive: false });
    sh.addEventListener('touchend', end); sh.addEventListener('touchcancel', end);
    // マウス（PC でスマホ幅にしたとき）
    sh.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' && e.button === 0) start(e.clientY, e.target); });
    window.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') move(e.clientY, e); });
    window.addEventListener('pointerup', e => { if (e.pointerType === 'mouse') end(); });
    sh.addEventListener('click', e => { if (Date.now() < quietUntil) { e.stopPropagation(); e.preventDefault(); } }, true);
    grab.addEventListener('click', () => { if (!isWide()) setSheet(ORDER[(ORDER.indexOf(state.sheet) + 1) % 3]); });
    $('strip').addEventListener('click', e => { const svg = e.target.closest('svg'); if (!svg || !state.rows) return; const r = svg.getBoundingClientRect(); const d = Math.max(0, Math.min(state.course.total, (e.clientX - r.left) / r.width * state.course.total)); selectRow(rowFor(d), { scroll: true }); });
    $('rowsTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || !state.result) return; state.fromHere = b.dataset.here === '1'; state.active = null; state.open.clear(); renderRows(); renderStrip(); });
    $('rows').addEventListener('click', e => { const b = e.target.closest('.row'); if (b) selectRow(+b.dataset.k, { toggle: true, scroll: state.sheet === 'peek' && !isWide() }); });
    $('sheetBody').addEventListener('scroll', onRowsScroll, { passive: true });
  }
  // ヘッダーのメニュー（v2 段階 3）：表示モード・現在位置から再取得（走行時間帯以外）・コース削除・このサイトについて
  const menu = $('menu'), menuBtn = $('menuBtn');
  const setMenu = open => { menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); };
  menuBtn.addEventListener('click', e => { e.stopPropagation(); setMenu(menu.hidden); });
  document.addEventListener('click', e => { if (!menu.hidden && !e.target.closest('#menu')) setMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!menu.hidden) { setMenu(false); menuBtn.focus(); } else if ($('loadBox').classList.contains('open')) closeLoad(); else if ($('settings').classList.contains('open')) closePlan(); } });
  menu.querySelectorAll('[data-theme-set]').forEach(b => b.addEventListener('click', () => {
    const next = b.dataset.themeSet;
    if (next === 'auto') { delete document.documentElement.dataset.theme; store.del('rw:theme'); } else { document.documentElement.dataset.theme = next; store.set('rw:theme', next); }
    renderTheme(); if (state.result) { renderStrip(); renderMap(); }
  }));
  function renderTheme() { const cur = document.documentElement.dataset.theme || 'auto'; menu.querySelectorAll('[data-theme-set]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeSet === cur))); }
  renderTheme();
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.result && !document.documentElement.dataset.theme) renderMap(); }); } catch (e) { /* 古い Safari は無視 */ }
  $('menuGps').addEventListener('click', () => { setMenu(false); state.gpsShown = true; renderGpsPlace(); sheetLayout(); gpsRefresh(); });
  $('changeCourse').addEventListener('click', openLoad);
  $('loadClose').addEventListener('click', closeLoad);
  $('sheetBack').addEventListener('click', () => { closeLoad(); closePlan(); });
  $('planPill').addEventListener('click', openPlan);
  $('planClose').addEventListener('click', closePlan);
  $('planCourse').addEventListener('click', openLoad);
  $('planChips').addEventListener('click', e => { const b = e.target.closest('.chip'); if (b) openEditor(b.dataset.focus); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') { navigator.serviceWorker.register('./sw.js').catch(() => { /* 未対応・失敗時は通常動作 */ }); }
  // ⓘ：aria-controls の説明を開閉する（v2 段階 2）
  document.addEventListener('click', e => {
    const b = e.target.closest('button.info'); if (!b) return;
    e.preventDefault(); // ラベル内に置いたときに入力欄へフォーカスが移らないよう
    const el = document.getElementById(b.getAttribute('aria-controls')); if (!el) return;
    el.hidden = !el.hidden; b.setAttribute('aria-expanded', String(!el.hidden));
  });
  $('rwgpsGo').addEventListener('click', () => loadRwgps($('rwgpsUrl').value));
  $('rwgpsAuth').addEventListener('click', rwgpsAuthStart);
  $('rwgpsPick').addEventListener('click', () => { const box = $('rwgpsList'); if (box.classList.contains('hidden') || !rwgpsState.items.length) rwgpsList(true); else box.classList.add('hidden'); });
  $('rwgpsUnlink').addEventListener('click', () => rwgpsUnlink(false));
  $('rwgpsMore').addEventListener('click', () => rwgpsList(false));
  $('rwgpsClose').addEventListener('click', () => $('rwgpsList').classList.add('hidden'));
  $('rwgpsFilterGo').addEventListener('click', () => rwgpsList(true));
  $('rwgpsFilter').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); rwgpsList(true); } });
  $('rwgpsUrl').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); loadRwgps(e.target.value); } });
  $('file').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) loadFile(f); });
  const lb = $('loadBtn'); // PC 向けの補助：ドラッグ＆ドロップ
  ['dragenter', 'dragover'].forEach(ev => lb.addEventListener(ev, e => { e.preventDefault(); lb.classList.add('on'); }));
  ['dragleave', 'drop'].forEach(ev => lb.addEventListener(ev, e => { e.preventDefault(); lb.classList.remove('on'); }));
  lb.addEventListener('drop', e => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) loadFile(f); });
  const C_META_DEFAULT = $('cMeta').innerHTML; // サンプルリンク入りの初期表示（コース削除時に戻す）
  $('cMeta').addEventListener('click', async e => { // サンプルリンクは再描画されるので親で受ける
    const a = e.target.closest('#sampleLink'); if (!a) return;
    e.preventDefault(); setStatus('サンプルを読み込み中…');
    try { const r = await fetch(a.getAttribute('href')); if (!r.ok) throw new Error('HTTP ' + r.status); setCourse(parseGPX(await r.text(), 'サンプルコース')); }
    catch (err) { setStatus('サンプルを読み込めませんでした：' + err.message, 'err'); }
  });
  // コース削除：読み込んだコース・最近のコース・予報キャッシュ・注意報／アメダスの保持分を端末から消す（設定値は残す）
  $('clearData').addEventListener('click', () => {
    setMenu(false);
    if (!confirm('読み込んだコースと予報のキャッシュを端末から削除します。よろしいですか？\n（出走日時・速度などの設定は残ります）')) return;
    ['rw:course', 'rw:last', 'rw:courses', 'rw:rwgps', 'rw:oauthState'].forEach(k => store.del(k));
    try { Object.keys(localStorage).filter(k => k.startsWith('rw:fc')).forEach(k => localStorage.removeItem(k)); } catch (e) { /* noop */ }
    state.course = null; state.series = null; state.result = null; state.warnings = null; state.amedas = null; state.offlineNote = '';
    if (lmap) { lmap.remove(); lmap = null; lmapHash = null; lmapLayers = null; }
    $('map').innerHTML = ''; renderRwgpsAuth(); rwgpsMsg('');
    $('results').classList.add('hidden'); $('notice').className = 'notice hidden'; $('notice').innerHTML = ''; $('notice0').className = 'notice hidden';
    setMapMode(false);
    $('cName').textContent = 'コース未読み込み'; $('cMeta').innerHTML = C_META_DEFAULT;
    closeLoad(); state.gpsShown = false; renderCourse(); renderRecent(); ['gps', 'gpsWrap', 'menuGps'].forEach(id => $(id).classList.add('hidden'));
    setStatus('コースと予報のキャッシュを削除しました');
  });
  $('recent').addEventListener('change', e => { const list = store.get('rw:courses') || []; const c = list[+e.target.value]; e.target.value = ''; if (c && c.course && c.course.pts) setCourse(c.course); });
  $('reverse').addEventListener('click', () => { if (state.course) setCourse(RW.course.reverseCourse(state.course)); });
  $('addSleep').addEventListener('click', () => { addSleepRow().querySelector('.sd').focus(); });
  $('addSeg').addEventListener('click', () => { addSegRow().querySelector('.sf').focus(); });
  ['ancD', 'ancT'].forEach(id => $(id).addEventListener('change', onParamChange));
  $('gps').addEventListener('click', gpsRefresh);
  $('spd').addEventListener('change', onParamChange);
  // 出走日時を変えたら、現在位置からの再計算（隠れた現在地の固定）は解除する。残したままだと以降の通過時刻が更新されず「予報が変わらない」ように見えるため
  ['date', 'time'].forEach(id => $(id).addEventListener('change', () => {
    if (readAnchor()) {
      $('ancD').value = ''; $('ancT').value = ''; state.lastPos = null; state.forecastStale = '';
      store.del('rw:posHist'); posMsg('', '', 'posMsg'); posMsg('', '', 'gpsMsg');
      state.startNote = '出走日時を変更したため、現在位置からの再計算を解除しました。走行中なら「現在位置から予報を再取得」を押し直してください';
      onParamChange(); return;
    }
    if (state.startNote && state.startNote.startsWith('出走日時を変更')) state.startNote = '';
    onParamChange();
  }));
  $('run').addEventListener('click', () => { state.warnings = null; state.amedas = null; run({ force: true }); });
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (state.result) { sheetLayout(); renderMap(); if (state.sheet === 'peek' || isWide()) fitCourse(); } }, 150); });
  window.addEventListener('online', () => { if (state.course && state.offlineNote) run(); });

  // 前回の現在地（P-5 の欄は非表示なので）が残っていれば、解除できるようステータス行を出す
  function restorePosStatus() {
    const d = +$('ancD').value, t = $('ancT').value; if (!$('ancD').value || !t || !state.result) return;
    const h = posHistory(); const lastH = h.length ? h[h.length - 1] : null; // GPS 由来なら精度も復元
    state.lastPos = state.lastPos || (lastH && Math.abs(lastH.d - d) < 0.05 ? { d, t: lastH.t, acc: lastH.acc, distM: lastH.distM, clock: null, posT: null, source: lastH.source || 'gps' } : { d, t: Date.parse(t + ':00+09:00'), acc: null, source: 'manual' });
    state.posTarget = 'gpsMsg'; renderPosStatus();
  }
  // ===== 起動：前回のコース・予報を復元してから最新を取りに行く =====
  // 開発・確認用：?theme=dark|light で表示モードを指定、?sample=1 でサンプルコースを自動で読む（通常利用では使わない）
  try {
    const q = new URLSearchParams(location.search);
    const th = q.get('theme'); if (th === 'dark' || th === 'light') document.documentElement.dataset.theme = th;
    if (q.get('sample') === '1') setTimeout(() => { const l = $('sampleLink'); if (l && !state.course) l.click(); }, 50);
    const rl = q.get('relay'); if (rl && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(rl)) state.relay = rl; // 中継のローカル確認用（localhost のみ）
    const ra = q.get('rwgpsapi'); if (ra && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(ra)) state.rwgpsApi = ra; // RwGPS API のモック（localhost のみ）
  } catch (e) { /* noop */ }
  loadParams(); renderRecent();
  renderRwgpsAuth();
  const last = store.get('rw:last');
  const savedCourse = (last && last.course) || store.get('rw:course');
  if (savedCourse && savedCourse.pts && savedCourse.pts.length > 1) {
    state.course = savedCourse; renderCourse();
    if (last && last.series && last.series.hash === RW.course.hashCourse(savedCourse)) state.series = last.series;
    if (state.series) { try { recompute(); restorePosStatus(); } catch (e) { /* 壊れた保存データは無視して再取得へ */ } }
    run();
  }
  rwgpsAuthReturn(); // OAuth の戻り先ならトークンに交換して連携状態にする（コースの復元後に。コースがあればシートで結果を見せる）
})();
