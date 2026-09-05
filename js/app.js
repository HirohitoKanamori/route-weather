// Route Weather JP — 画面・入力・ネットワーク（ui / view / 取得層）
import { RW } from './core.js';
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const F = RW.fmt, M = RW.const.MODELS, RAIN_MM = RW.const.RAIN_MM;
  const REL = { head: '向かい', tail: '追い', cross: '横' };
  const COL = { head: 'var(--head)', tail: 'var(--tail)', cross: 'var(--cross)' };
  const CACHE_MS = 30 * 60e3;
  const state = { course: null, series: null, result: null, pinned: false, busy: false, offlineNote: '', collapsed: false };

  // localStorage は私的ブラウズ等で例外になるので必ず握りつぶす
  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* noop */ } }
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n1 = v => v.toFixed(1);

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
    return { start, spd, sleeps: RW.plan.normSleeps(readSleeps(), total), segments: RW.plan.normSegments(readSegs(), total),
      anchor: anchor && anchor.d < total ? anchor : null };
  }
  function saveParams() {
    store.set('rw:params', { date: $('date').value, time: $('time').value, spd: $('spd').value, sleeps: readSleeps(), segs: readSegs(), ancD: $('ancD').value, ancT: $('ancT').value });
  }
  function loadParams() {
    const s = store.get('rw:params') || {};
    // 初期値は「現在時刻の翌日 06:00」。保存値があっても、前々日より前の日付なら初期値に戻す
    const tomorrow = F.ymd(Date.now() + 86400e3);
    const stale = !s.date || s.date < F.ymd(Date.now() - 86400e3);
    $('date').value = stale ? tomorrow : s.date;
    $('time').value = stale ? '06:00' : (s.time || '06:00');
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
  function updateSumLine(p) {
    const c = state.course;
    $('sumLine').textContent = c ? `${c.name} ・ ${F.fmtDT(p.start)} 出走 ・ ${p.spd} km/h${p.sleeps.length ? ' ・ 仮眠 ' + p.sleeps.length : ''}${p.segments.length ? ' ・ 区間速度 ' + p.segments.length : ''}${p.anchor ? ' ・ 現在 ' + Math.round(p.anchor.d) + ' km' : ''}` : '';
  }
  function setStatus(msg, cls) { const el = $('status'); el.textContent = msg || ''; el.className = 'status' + (cls ? ' ' + cls : ''); }
  function renderCourse() {
    const c = state.course;
    if (!c) return;
    $('cName').textContent = c.name;
    $('cMeta').textContent = `${n1(c.total)} km ・ 獲得標高 ${c.hasEle ? c.gain.toLocaleString() + ' m' : '不明'} ・ 地点数 ${c.n.toLocaleString()}`;
  }
  function onParamChange() { saveParams(); if (state.course) run(); }

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
  function setCourse(course) {
    state.course = course; state.series = null; state.result = null; state.offlineNote = '';
    renderCourse(); store.set('rw:course', course); rememberCourse(course); setStatus('');
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
  async function getSeries(model, pts, hash, pastDays, force) {
    const key = 'rw:fc2:' + hash + ':' + model + ':' + pastDays;
    if (!force) { const c = store.get(key); if (c && Date.now() - c.at < CACHE_MS) return c.series; }
    const res = await fetch(RW.forecast.buildUrl(pts, model, pastDays));
    if (!res.ok) { let msg = 'HTTP ' + res.status; try { const j = await res.json(); if (j.reason) msg += ' ' + j.reason; } catch (e) { /* noop */ } throw new Error(msg); }
    const series = RW.forecast.parseSeries(await res.json());
    if (series.length !== pts.length) throw new Error('地点数が一致しません（' + series.length + '/' + pts.length + '）');
    store.set(key, { at: Date.now(), series });
    return series;
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
    const p = params();
    if (isNaN(+p.start)) { setStatus('出走日時を入力してください', 'err'); return; }
    saveParams(); updateSumLine(p);
    const now = Date.now();
    const daysAhead = (+p.start - now) / 86400e3;
    if (daysAhead > 11) { state.result = null; renderOutOfRange(daysAhead); return; }
    const pts = RW.plan.samplePoints(state.course, p, RW.plan.sampleStep(state.course.total));
    const goalT = +pts[pts.length - 1].t;
    const hash = RW.course.hashCourse(state.course);
    const pastDays = Math.min(2, Math.max(0, Math.ceil((now - +p.start) / 86400e3)));
    let ser = state.series;
    const fresh = ser && ser.hash === hash && ser.pastDays === pastDays && now - ser.fetchedAt < CACHE_MS;
    const covered = s => { const hM = RW.forecast.horizon(s.msm); return (hM != null && goalT <= hM) || !!s.gsm; };
    if (force || !fresh || !covered(ser)) {
      if (state.busy) return;
      state.busy = true; $('run').disabled = true; setStatus('予報を取得中…');
      try {
        const msm = await getSeries('msm', pts, hash, pastDays, force);
        const hM = RW.forecast.horizon(msm);
        const gsm = (hM == null || goalT > hM) ? await getSeries('gsm', pts, hash, pastDays, force) : null;
        ser = { msm, gsm, hash, pastDays, fetchedAt: Date.now(), runs: {} };
        state.series = ser; state.offlineNote = '';
        store.set('rw:last', { course: state.course, series: ser });
        try { Object.keys(localStorage).filter(k => k.startsWith('rw:fc:')).forEach(k => localStorage.removeItem(k)); } catch (e) { /* 旧キャッシュの掃除 */ }
        setStatus('');
        fetchRuns(ser);
      } catch (e) {
        const last = store.get('rw:last');
        if (last && last.series && last.series.hash === hash) {
          ser = state.series = last.series;
          state.offlineNote = `予報を取得できませんでした（${e.message}）。${F.fmtDT(ser.fetchedAt)} に取得した予報を表示しています。`;
          setStatus('');
        } else {
          setStatus('予報を取得できませんでした：' + e.message, 'err');
          state.busy = false; $('run').disabled = false; return;
        }
      } finally { state.busy = false; $('run').disabled = false; }
    }
    recompute(p);
  }
  function recompute(p) {
    p = p || params();
    const { S, step } = RW.forecast.computeRide(state.course, p, state.series);
    const sm = RW.forecast.summarize(S, step);
    const hM = RW.forecast.horizon(state.series.msm);
    const trend = hM == null ? true : +p.start > hM;
    state.result = { S, step, sm, p, trend };
    renderAll();
  }

  // ===== 描画 =====
  function renderOutOfRange(daysAhead) {
    $('results').classList.add('hidden'); $('layout').classList.remove('has-results');
    const el = $('notice'); el.className = 'notice warn';
    el.innerHTML = `<div>出走まで ${Math.ceil(daysAhead)} 日。予報は 11 日前（気象庁 GSM の予報期間）から表示できます。</div>`;
    setStatus('');
  }
  function renderAll() {
    $('results').classList.remove('hidden'); $('layout').classList.add('has-results');
    renderNotice(); renderSummary(); renderRibbon(); renderTrend(); renderTable(); renderMap(); renderStarts(); renderModelInfo();
    if (window.innerWidth < 900 && !state.collapsed) { $('settings').open = false; state.collapsed = true; }
    if (navigator.onLine !== false) { loadWarnings(); loadAmedas(); } else { renderWarnings(); renderAmedas(); }
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
  function renderSummary() {
    const { sm, S, step, p } = state.result;
    const card = (cls, k, v, s) => `<div class="card ${cls}"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
    let h = card('', 'ゴール予定', F.fmtDT(sm.goal), `経過 ${n1(sm.totalH)} h（仮眠 ${p.sleeps.reduce((a, s) => a + s.m, 0)} 分を含む）`);
    if (sm.nOk === 0) { $('summary').innerHTML = h; return; }
    h += card('head', '向かい風区間', `${sm.headKm} km`, `${state.course.total > 0 ? Math.round(sm.headKm / state.course.total * 100) : 0}% ／ 最大風速 ${sm.wsMax ? n1(sm.wsMax.ws) + ' m/s（' + Math.round(sm.wsMax.d) + ' km）' : '—'}`);
    h += card('rain', '雨中走行', `${sm.rainKm} km`, sm.rainFirst ? `最初 ${Math.round(sm.rainFirst.d)} km（${F.fmtDT(sm.rainFirst.t)}）〜 最後 ${Math.round(Math.min(sm.rainLast.d + step, state.course.total))} km` : `${RAIN_MM} mm/h 以上の降水なし`);
    h += card('', '最低気温', `${n1(sm.tmin.temp)}℃${sm.tmin.feel != null ? '<small class="sub">（体感 ' + n1(sm.tmin.feel) + '℃）</small>' : ''}`, `${Math.round(sm.tmin.d)} km、${F.fmtDT(sm.tmin.t)}${sm.tmax ? ' ／ 最高 ' + n1(sm.tmax.temp) + '℃' : ''}`);
    h += card('', '夜間走行', `${sm.nightKm} km`, '日没〜日の出の区間');
    $('summary').innerHTML = h;
  }
  // SVG 断片
  const rect = (x, y, w, h, fill, op) => `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}"${op != null ? ` opacity="${op}"` : ''}/>`;
  const line = (x1, y1, x2, y2, stroke, w = 1, dash) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  const text = (x, y, s, cls, anchor, fill) => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="${cls || 'tick'}"${anchor ? ` text-anchor="${anchor}"` : ''}${fill ? ` fill="${fill}"` : ''}>${esc(s)}</text>`;
  const arrow = (x, y, angDeg, len, color, w = 2) =>
    `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angDeg.toFixed(1)})"><line x1="${(-len / 2).toFixed(1)}" y1="0" x2="${(len / 2).toFixed(1)}" y2="0" stroke="${color}" stroke-width="${w}"/><path d="M${(len / 2).toFixed(1)} 0 l-5 -3.5 v7 z" fill="${color}"/></g>`;

  function renderRibbon() {
    const host = $('ribbon'); const { S, step, p, trend } = state.result; const course = state.course;
    const W = Math.max(320, Math.floor(host.clientWidth || 360)); const L = 30, RM = 8, innerW = W - L - RM;
    const lanes = { time: { y: 2, h: 26 }, dist: { y: 30, h: 14 } }; let y = 48;
    const order = trend ? [['rain', 44], ['temp', 44], ['ele', 40]] : [['wind', 54], ['rain', 44], ['temp', 44], ['ele', 40]];
    for (const [k, h] of order) { lanes[k] = { y, h }; y += h + 4; }
    const H = y + 4, top = lanes[order[0][0]].y, bottom = H - 6;
    const xOf = d => L + d / course.total * innerW;
    const px = innerW / Math.max(1, S.length - 1);
    const stride = minPx => Math.max(1, Math.ceil(minPx / px));
    const ok = S.filter(s => !s.na);
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="コース上の天候タイムライン">`;
    // 夜間帯（全レーンを貫く）
    let ns = null;
    const band = (a, b, fill, op) => { s += rect(xOf(a), top, xOf(b) - xOf(a), bottom - top, fill, op); };
    S.forEach(pt => {
      if (pt.night && ns === null) ns = Math.max(0, pt.d - step / 2);
      if (!pt.night && ns !== null) { band(ns, Math.max(ns, pt.d - step / 2), 'var(--night)', .10); ns = null; }
    });
    if (ns !== null) band(ns, course.total, 'var(--night)', .10);
    // 予報範囲外（後半にまとまる）
    const naFirst = S.find(pt => pt.na);
    if (naFirst) { const a = Math.max(0, naFirst.d - step / 2); band(a, course.total, 'var(--na)', .5); s += text(xOf(a) + 4, top + 22, '予報範囲外', 'lane-label'); }
    // 仮眠帯
    for (const sl of p.sleeps) { const x = xOf(sl.d); s += rect(x - 3, top, 6, bottom - top, 'var(--sleep)', .45); s += text(x + 5, top + 10, `仮眠 ${sl.m}分`, 'lane-label', 'start', 'var(--sleep)'); }
    // 時刻目盛（正時。日付境界を強調。仮眠中の正時は距離が進まないので出さない）
    const spanH = Math.max(1, (+S[S.length - 1].t - +S[0].t) / 3600e3); const pxPerH = innerW / spanH;
    const hStep = [1, 2, 3, 6, 12].find(n => n * pxPerH >= 34) || 24;
    const longLabel = hStep * pxPerH >= 52;
    let lastDay = F.dateKey(S[0].t), lastX = -Infinity;
    s += text(xOf(0) + 2, lanes.time.y + 9, lastDay, 'tick day');
    for (const tk of RW.plan.hourTicks(RW.plan.timeNodes(S, p))) {
      const x = xOf(tk.d); const dk = F.dateKey(tk.t); const hr = F.jstParts(tk.t).h;
      if (dk !== lastDay) { lastDay = dk; s += text(x + 2, lanes.time.y + 9, dk, 'tick day'); s += line(x, lanes.time.y, x, bottom, 'var(--ink-3)', 1); }
      if (tk.sleep || hr % hStep !== 0 || x - lastX < 38) continue;
      lastX = x;
      s += line(x, lanes.time.y + 12, x, lanes.dist.y, 'var(--line)'); s += text(x, lanes.time.y + 22, longLabel ? F.fmtH(tk.t) : F.fmtH(tk.t).slice(0, 2), 'tick', 'middle');
    }
    // 現在地（走行中の再計算）
    if (p.anchor) { const x = xOf(p.anchor.d); s += line(x, top, x, bottom, 'var(--ink)', 1.5, '4 3'); s += text(x + 4, bottom - 4, '現在地 ' + F.fmtH(p.anchor.t), 'lane-label'); }
    // 距離目盛
    const dStep = [5, 10, 20, 25, 50, 100, 200].find(n => n / course.total * innerW >= 34) || 500;
    for (let d = 0; d <= course.total + 1e-9; d += dStep) { const x = xOf(d); s += text(x, lanes.dist.y + 11, String(d), 'tick', 'middle'); s += line(x, lanes.dist.y + 13, x, bottom, 'var(--line)', 1, '2 4'); }
    s += text(L - 4, lanes.dist.y + 11, 'km', 'tick', 'end');
    const lab = (k, t) => text(L - 4, lanes[k].y + lanes[k].h / 2 + 4, t, 'lane-label', 'end');
    if (!trend) s += lab('wind', '風');
    s += lab('rain', '雨') + lab('temp', '気温') + lab('ele', '標高');
    // 風レーン：進行方向基準の矢印（上＝追い風）
    if (!trend) {
      const wy = lanes.wind.y + lanes.wind.h / 2 - 4; const st = stride(16);
      S.forEach((pt, i) => {
        if (pt.na || i % st) return;
        const x = xOf(pt.d); const len = Math.min(26, 7 + pt.ws * 2.2);
        s += arrow(x, wy, -pt.rel - 90, len, COL[pt.cls]); // 上＝追い風、下＝向かい風
        if (pt.ws >= 5) s += text(x, lanes.wind.y + lanes.wind.h - 2, pt.ws.toFixed(0) + 'm', 'tick', 'middle', COL[pt.cls]);
      });
    }
    // 雨レーン：降水量の棒（降水確率は気象庁モデルでは提供されないため非表示）
    { const ry = lanes.rain.y, rh = lanes.rain.h; const mmMax = Math.max(3, ...ok.map(x => x.mm || 0)); const bw = Math.max(1.5, px * 0.7); const st = stride(22);
      S.forEach((pt, i) => {
        if (pt.na || !(pt.mm > 0)) return;
        const x = xOf(pt.d); const h = Math.max(1, pt.mm / mmMax * (rh - 12));
        s += rect(x - bw / 2, ry + rh - h, bw, h, 'var(--rain)', pt.mm >= RAIN_MM ? 1 : .45);
        if (pt.mm >= 1 && i % st === 0) s += text(x, ry + rh - h - 3, pt.mm.toFixed(pt.mm >= 10 ? 0 : 1), 'tick', 'middle', 'var(--rain)');
      });
      s += line(L, ry + rh, L + innerW, ry + rh, 'var(--line)');
    }
    // 気温レーン
    if (ok.length) {
      const temps = ok.map(x => x.temp); const tmin = Math.min(...temps) - 2, tmax = Math.max(...temps) + 2;
      const ty = v => lanes.temp.y + lanes.temp.h - 4 - (v - tmin) / (tmax - tmin) * (lanes.temp.h - 12);
      s += `<polyline fill="none" stroke="var(--ink)" stroke-width="1.5" points="${ok.map(x => xOf(x.d).toFixed(1) + ',' + ty(x.temp).toFixed(1)).join(' ')}"/>`;
      const st = stride(30); ok.forEach((pt, i) => { if (i % st === 0) s += text(xOf(pt.d), ty(pt.temp) - 4, pt.temp.toFixed(0) + '°', 'tick', 'middle'); });
    }
    // 標高レーン
    if (course.hasEle) {
      const eles = course.pts.map(q => q.ele ?? 0); const emax = Math.max(...eles), emin = Math.min(...eles);
      const ey = v => lanes.ele.y + lanes.ele.h - ((v ?? emin) - emin) / ((emax - emin) * 1.05 || 1) * lanes.ele.h;
      s += `<path d="M${xOf(0).toFixed(1)},${lanes.ele.y + lanes.ele.h} ${course.pts.map(q => 'L' + xOf(q.d).toFixed(1) + ',' + ey(q.ele).toFixed(1)).join(' ')} L${xOf(course.total).toFixed(1)},${lanes.ele.y + lanes.ele.h} Z" fill="var(--paper-2)" stroke="var(--ink-3)" stroke-width="1"/>`;
      s += text(L + innerW - 2, lanes.ele.y + 9, `最高 ${Math.round(emax)} m`, 'tick', 'end');
    } else s += text(L + 4, lanes.ele.y + lanes.ele.h / 2 + 4, '標高データなし', 'tick');
    // カーソルとヒット領域
    s += `<line id="cur" x1="0" y1="${top}" x2="0" y2="${bottom}" stroke="var(--ink)" stroke-width="1" opacity="0"/>`;
    s += `<rect id="hit" x="${L}" y="0" width="${innerW}" height="${H}" fill="transparent"/></svg>`;
    host.innerHTML = s;
    bindRibbon(host, S, xOf, L, innerW, W);
  }
  function tipHtml(pt) {
    const head = `<b>${pt.d.toFixed(0)} km</b>　${F.fmtDT(pt.t)}${pt.night ? '　夜間' : ''}`;
    if (pt.na) return head + '<br>予報範囲外';
    const ele = pt.ele != null ? `　標高 ${Math.round(pt.ele)} m` : '';
    const sun = pt.sun != null ? `　日照 ${Math.round(pt.sun / 36)}%` : '';
    return head + `<br>${esc(RW.forecast.wmoText(pt.code))}　${n1(pt.temp)}℃${pt.feel != null ? '（体感 ' + n1(pt.feel) + '℃）' : ''}　湿度 ${Math.round(pt.rh)}%${sun}${ele}` +
      `<br>${RW.wind.dir16(pt.wd)}の風 ${n1(pt.ws)} m/s → <b>${REL[pt.cls]}風</b>（進行方向成分 ${pt.comp >= 0 ? '+' : ''}${n1(pt.comp)} m/s）` +
      `<br>降水 ${n1(pt.mm)} mm/h${pt.model === 'gsm' ? '　<span class="tag" style="color:#fff;border-color:#fff">GSM</span>' : ''}`;
  }
  function bindRibbon(host, S, xOf, L, innerW, W) {
    const svg = host.querySelector('svg'), hit = svg.querySelector('#hit'), cur = svg.querySelector('#cur'), tip = $('tip'), wrap = $('ribbonWrap');
    const show = (clientX, clientY) => {
      const r = svg.getBoundingClientRect(); const x = (clientX - r.left) * (W / r.width);
      const d = (x - L) / innerW * state.course.total;
      let best = 0, bd = Infinity; S.forEach((pt, i) => { const dd = Math.abs(pt.d - d); if (dd < bd) { bd = dd; best = i; } });
      const pt = S[best]; const cx = xOf(pt.d);
      cur.setAttribute('x1', cx); cur.setAttribute('x2', cx); cur.setAttribute('opacity', '1');
      tip.innerHTML = tipHtml(pt); tip.style.display = 'block';
      const wr = wrap.getBoundingClientRect(); const tw = tip.offsetWidth;
      let left = clientX - wr.left + 12; if (left + tw > wr.width - 6) left = Math.max(6, clientX - wr.left - tw - 12);
      tip.style.left = left + 'px'; tip.style.top = Math.max(4, clientY - wr.top - tip.offsetHeight - 10) + 'px';
    };
    const hide = () => { cur.setAttribute('opacity', '0'); tip.style.display = 'none'; tip.classList.remove('pinned'); };
    hit.addEventListener('pointermove', e => { if (!state.pinned) show(e.clientX, e.clientY); });
    hit.addEventListener('pointerleave', () => { if (!state.pinned) hide(); });
    hit.addEventListener('pointerdown', e => { // iPhone：タップで固定、再タップで解除
      e.preventDefault();
      if (state.pinned) { state.pinned = false; hide(); } else { state.pinned = true; show(e.clientX, e.clientY); tip.classList.add('pinned'); }
    });
    state.pinned = false; hide();
  }
  function renderTrend() {
    const { S, step, p, trend } = state.result; const wrap = $('trendWrap');
    if (!trend) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    const rows = RW.forecast.trendAggregate(S, step, state.course.total, p.spd, 50);
    $('trend').querySelector('tbody').innerHTML = rows.map(r => `<tr>
      <td class="n">${Math.round(r.from)}–${Math.round(r.to)} km</td><td>${r.day}</td>
      <td>${RW.wind.dir16(r.wdPrev)}の風 ${n1(r.wsMean)} m/s</td>
      <td class="n">${r.headKm} km</td><td class="n">${n1(r.mmSum)} mm</td><td class="n">${n1(r.tmax)}℃ ／ ${n1(r.tmin)}℃</td></tr>`).join('') ||
      '<tr><td colspan="6">予報範囲内の区間がありません</td></tr>';
    $('trendNote').textContent = `${M.gsm.label}（${M.gsm.grid}）。山岳部の風向は地形の影響を反映しません。「降水量 目安」は各区間の滞在時間 × 予報降水強度の合計です。`;
  }
  function renderTable() {
    const { S, p } = state.result; const tb = $('segs').querySelector('tbody');
    const rows = [];
    let si = 0;
    for (const pt of S) {
      // この地点までに到達する仮眠を挟む
      while (si < p.sleeps.length && p.sleeps[si].d < pt.d) { rows.push(sleepRow(p.sleeps[si], p)); si++; }
      const cls = (pt.na ? 'na' : '') + (pt.night ? ' night' : '');
      if (pt.na) rows.push(`<tr class="${cls}"><td class="n">${pt.d.toFixed(0)} km</td><td>${F.fmtDT(pt.t)}</td><td colspan="4">予報範囲外</td></tr>`);
      else rows.push(`<tr class="${cls}"><td class="n">${pt.d.toFixed(0)} km</td><td>${F.fmtDT(pt.t)}${pt.night ? ' <span class="tag">夜</span>' : ''}</td><td>${esc(RW.forecast.wmoText(pt.code))}${pt.model === 'gsm' ? ' <span class="tag">GSM</span>' : ''}<br><small class="sub">湿度 ${Math.round(pt.rh)}%${pt.sun != null ? '・日照 ' + Math.round(pt.sun / 36) + '%' : ''}</small></td>
        <td>${RW.wind.dir16(pt.wd)} ${n1(pt.ws)} m/s <span class="rel ${pt.cls}">${REL[pt.cls]}風</span></td><td class="n">${n1(pt.mm)} mm/h</td><td class="n">${n1(pt.temp)}℃${pt.feel != null ? '<br><small class="sub">体感 ' + n1(pt.feel) + '℃</small>' : ''}</td></tr>`);
      while (si < p.sleeps.length && p.sleeps[si].d === pt.d) { rows.push(sleepRow(p.sleeps[si], p)); si++; }
    }
    tb.innerHTML = rows.join('');
  }
  function sleepRow(sl, p) {
    // 通過列の幅を広げないよう到着・出発は 2 行に分け、他の列は空セルで揃える
    return `<tr class="sleep"><td class="n">${Math.round(sl.d)} km</td><td>着 ${F.fmtDT(RW.plan.timeAt(sl.d, p, true))}<br>発 ${F.fmtDT(RW.plan.timeAt(sl.d, p))}</td><td>仮眠 ${sl.m} 分</td><td></td><td class="n"></td><td class="n"></td></tr>`;
  }
  // 略地図：OpenStreetMap の標準タイルを静的に敷き、その上に SVG でコース線と風矢印を重ねる（ライブラリ不使用）
  function renderMap() {
    const host = $('map'); const { S } = state.result; const P = state.course.pts;
    const W = Math.max(260, Math.floor(host.clientWidth || 300)); const H = Math.round(Math.min(W * 0.85, 400)); const pad = 26;
    const lats = P.map(q => q.lat), lons = P.map(q => q.lon);
    const minLa = Math.min(...lats), maxLa = Math.max(...lats), minLo = Math.min(...lons), maxLo = Math.max(...lons);
    // Web メルカトルの世界ピクセル座標（ズーム z）
    const proj = (lat, lon, z) => { const n = 256 * 2 ** z; const sn = Math.sin(lat * Math.PI / 180); return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * n]; };
    let z = 15;
    for (; z > 3; z--) { const a = proj(maxLa, minLo, z), b = proj(minLa, maxLo, z); if (b[0] - a[0] <= W - 2 * pad && b[1] - a[1] <= H - 2 * pad) break; }
    const c = proj((minLa + maxLa) / 2, (minLo + maxLo) / 2, z);
    const ox = Math.round(c[0] - W / 2), oy = Math.round(c[1] - H / 2);
    const px = (lat, lon) => { const q = proj(lat, lon, z); return [q[0] - ox, q[1] - oy]; };
    // タイル（表示範囲に必要な分だけ。読めなければ外して背景色のままにする）
    const n = 2 ** z; let tiles = '';
    for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + W - 1) / 256); tx++) {
      for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + H - 1) / 256); ty++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        tiles += `<img src="https://tile.openstreetmap.org/${z}/${wx}/${ty}.png" alt="" style="left:${tx * 256 - ox}px;top:${ty * 256 - oy}px" onerror="this.remove()">`;
      }
    }
    // SVG 重ね描き：コース線（白縁取り）、風矢印（実方位・白縁取り）、スタート／ゴール
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="コース地図と風向">`;
    const pts = P.map(q => { const v = px(q.lat, q.lon); return v[0].toFixed(1) + ',' + v[1].toFixed(1); }).join(' ');
    s += `<polyline fill="none" stroke="var(--card)" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" opacity=".9" points="${pts}"/>`;
    s += `<polyline fill="none" stroke="var(--ink)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/>`;
    const st = Math.max(1, Math.ceil(S.length / 28));
    S.forEach((pt, i) => {
      if (pt.na || i % st) return;
      const v = px(pt.lat, pt.lon); const ang = (pt.wd + 180) - 90; const len = 8 + pt.ws * 1.6; // 吹いていく向き
      s += arrow(v[0], v[1], ang, len, 'var(--card)', 4.5) + arrow(v[0], v[1], ang, len, COL[pt.cls], 2);
    });
    const s0 = px(P[0].lat, P[0].lon), g = px(P[P.length - 1].lat, P[P.length - 1].lon);
    s += `<circle cx="${s0[0].toFixed(1)}" cy="${s0[1].toFixed(1)}" r="5" fill="var(--ink)" stroke="var(--card)" stroke-width="2"/>`;
    s += `<circle cx="${g[0].toFixed(1)}" cy="${g[1].toFixed(1)}" r="4" fill="var(--card)" stroke="var(--ink)" stroke-width="2"/>`;
    s += `<text x="${(s0[0] + 8).toFixed(1)}" y="${(s0[1] + 4).toFixed(1)}" class="tick" fill="var(--ink)" stroke="var(--card)" stroke-width="3" paint-order="stroke">スタート</text></svg>`;
    host.innerHTML = `<div class="osm" style="width:${W}px;height:${H}px">${tiles}${s}<div class="attr">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors</div></div>` +
      '<div class="note">矢印＝風の吹いていく向き（実方位）。色は進行方向に対する相対風。●スタート ○ゴール</div>';
  }
  function renderStarts() {
    const { p } = state.result; const tb = $('starts').querySelector('tbody');
    $('startsWrap').classList.toggle('hidden', !!p.anchor); // 走行中の再計算では出走時刻の比較は意味を持たない
    if (p.anchor) return;
    const rows = RW.forecast.startComparison(state.course, p, state.series);
    const full = rows.filter(r => r.nOk === r.n);
    const best = (full.length ? full : rows).reduce((a, b) => b.score < a.score ? b : a);
    tb.innerHTML = rows.map(r => `<tr class="${r === best ? 'best' : ''}"><td>${F.fmtDT(r.start)}${r.off === 0 ? ' <span class="tag">設定</span>' : ''}${r.nOk < r.n ? ' <span class="tag">一部範囲外</span>' : ''}</td>
      <td class="n">${r.nOk ? r.headKm : '—'}</td><td class="n">${r.nOk ? r.rainKm : '—'}</td><td class="n">${r.tmin ? n1(r.tmin.temp) + '℃' : '—'}</td><td>${F.fmtDT(r.goal)}</td></tr>`).join('');
  }
  function renderModelInfo() {
    const ser = state.series; if (!ser) { $('modelInfo').textContent = ''; return; }
    const parts = [];
    if (ser.msm) parts.push('MSM 初期時刻 ' + (ser.runs.msm ? F.fmtDT(ser.runs.msm) : '取得中'));
    if (ser.gsm) parts.push('GSM 初期時刻 ' + (ser.runs.gsm ? F.fmtDT(ser.runs.gsm) : '取得中'));
    parts.push('予報取得 ' + F.fmtDT(ser.fetchedAt));
    $('modelInfo').textContent = '　' + parts.join(' ／ ') + '（JST）';
  }

  // ===== 注意報・警報（V-7）とアメダス実況：気象庁ホームページの JSON を直接取得 =====
  const JMA = 'https://www.jma.go.jp/bosai/';
  const WCODE = { '02': '大雨警報', '03': '洪水警報', '04': '暴風警報', '05': '暴風雪警報', '06': '大雪警報', '07': '波浪警報', '08': '高潮警報',
    '10': '大雨注意報', '12': '大雪注意報', '13': '風雪注意報', '14': '雷注意報', '15': '強風注意報', '16': '波浪注意報', '17': '融雪注意報', '18': '洪水注意報', '19': '高潮注意報',
    '20': '濃霧注意報', '21': '乾燥注意報', '22': 'なだれ注意報', '23': '低温注意報', '24': '霜注意報', '25': '着氷注意報', '26': '着雪注意報',
    '32': '暴風特別警報', '33': '大雨特別警報', '35': '暴風特別警報', '36': '暴風雪特別警報', '37': '大雪特別警報', '38': '波浪特別警報', '39': '高潮特別警報' };
  const wLevel = code => (+code >= 32 ? 'emg' : +code < 10 ? 'warn' : 'adv');
  const wName = code => WCODE[code] || ('警報・注意報 ' + code);
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
        segs.push({ key, codes, from: pt.d, to: pt.d, name: codes.length ? idx.c20[codes[0]][0] : '海上・判定不能', office: codes.length ? idx.c20[codes[0]][1] : null, warnings: [], reported: null });
      });
      for (let i = 0; i < segs.length - 1; i++) segs[i].to = segs[i + 1].from;
      if (segs.length > 1 && segs[segs.length - 1].from >= state.course.total - 1e-6) segs.pop(); // ゴール地点だけの空区間は前の区間に含める
      segs[segs.length - 1].to = state.course.total;
      const offices = [...new Set(segs.map(x => x.office).filter(Boolean))];
      const reports = {};
      await Promise.all(offices.map(async o => { try { reports[o] = await (await fetch(JMA + 'warning/data/warning/' + o + '.json')).json(); } catch (e) { reports[o] = null; } }));
      for (const sg of segs) {
        const rep = reports[sg.office]; if (!rep) continue;
        sg.reported = rep.reportDatetime; const areas = (rep.areaTypes || []).flatMap(t => t.areas || []);
        for (const code of sg.codes) { const a = areas.find(x => x.code === code); if (!a) continue; for (const w of (a.warnings || [])) { if (w.code && w.status !== '解除' && !sg.warnings.some(x => x.code === w.code)) sg.warnings.push({ code: w.code, status: w.status }); } }
      }
      state.warnings = { hash, at: Date.now(), segs, offices: offices.map(o => idx.offices[o] || o), failed: offices.filter(o => !reports[o]).length };
    } catch (e) { state.warnings = { hash, at: Date.now(), segs: [], error: e.message }; }
    renderWarnings();
  }
  function renderWarnings() {
    const w = state.warnings; const wrap = $('warnWrap');
    if (!w || !state.result) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    const tb = $('warnTable').querySelector('tbody');
    if (w.error || !w.segs.length) { tb.innerHTML = `<tr><td colspan="3">取得できませんでした${w.error ? '（' + esc(w.error) + '）' : ''}</td></tr>`; $('warnNote').textContent = ''; return; }
    tb.innerHTML = w.segs.map(sg => `<tr><td class="n">${Math.round(sg.from)}–${Math.round(sg.to)} km</td><td>${esc(sg.name)}</td><td class="wrap">${sg.warnings.length ? sg.warnings.map(x => `<span class="wtag ${wLevel(x.code)}">${esc(wName(x.code))}</span>`).join('') : '<span class="sub">なし</span>'}</td></tr>`).join('');
    const rep = w.segs.map(x => x.reported).filter(Boolean).sort().pop();
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
      state.amedas = { hash, at: Date.now(), latest, rows };
    } catch (e) { state.amedas = { hash, at: Date.now(), rows: [], error: e.message }; }
    renderAmedas();
  }
  function renderAmedas() {
    const a = state.amedas; const wrap = $('amedasWrap');
    if (!a || !state.result) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    const tb = $('amedasTable').querySelector('tbody');
    if (a.error || !a.rows.length) { tb.innerHTML = `<tr><td colspan="7">取得できませんでした${a.error ? '（' + esc(a.error) + '）' : ''}</td></tr>`; $('amedasNote').textContent = ''; return; }
    const val = (o, k) => (o && o[k] && o[k][1] === 0 && o[k][0] != null) ? o[k][0] : null;
    tb.innerHTML = a.rows.map(r => {
      if (r.err) return `<tr><td class="n">${Math.round(r.d)} km</td><td>${esc(r.st.name)}</td><td colspan="5">取得できませんでした</td></tr>`;
      const o = r.obs; const t = r.time; const temp = val(o, 'temp'), ws = val(o, 'wind'), wd = val(o, 'windDirection'), pr = val(o, 'precipitation1h'), rh = val(o, 'humidity');
      return `<tr><td class="n">${Math.round(r.d)} km</td><td>${esc(r.st.name)}<br><small class="sub">コースから約 ${r.dist.toFixed(0)} km・標高 ${r.st.alt} m</small></td><td>${t.slice(8, 10)}:${t.slice(10, 12)}</td><td class="n">${temp != null ? n1(temp) + '℃' : '—'}</td><td>${ws != null ? (wd != null ? AMEDAS_DIR[wd] + ' ' : '') + n1(ws) + ' m/s' : '—'}</td><td class="n">${pr != null ? n1(pr) + ' mm' : '—'}</td><td class="n">${rh != null ? Math.round(rh) + '%' : '—'}</td></tr>`;
    }).join('');
    $('amedasNote').textContent = `${state.result.p.anchor ? '現在地' : 'スタート'}から 50 km ごとに最寄りの観測所。観測 ${F.fmtDT(Date.parse(a.latest))}、確認 ${F.fmtH(a.at)}。`;
  }

  // ===== 画像で共有（V-9）：リボン SVG を canvas に描き、共有シート（無ければ保存）へ =====
  const FONT = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif';
  async function shareImage() {
    if (!state.result) return;
    const { p, sm } = state.result; const course = state.course;
    const svgEl = document.querySelector('#ribbon svg'); if (!svgEl) return;
    const cs = getComputedStyle(document.documentElement); const v = name => cs.getPropertyValue(name).trim();
    const clone = svgEl.cloneNode(true);
    ['#hit', '#cur'].forEach(sel => { const el = clone.querySelector(sel); if (el) el.remove(); });
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `text{font-family:${FONT}}.tick{font-size:10px;fill:${v('--ink-2')}}.tick.day{font-weight:700;fill:${v('--ink')}}.lane-label{font-size:10px;fill:${v('--ink-2')}}`;
    clone.insertBefore(style, clone.firstChild);
    const xml = new XMLSerializer().serializeToString(clone).replace(/var\((--[a-z0-9-]+)\)/g, (m, n) => v(n) || '#000');
    const W = +svgEl.getAttribute('width'), H = +svgEl.getAttribute('height');
    const scale = 2, head = 66, foot = 22, pad = 10;
    const canvas = document.createElement('canvas'); canvas.width = (W + pad * 2) * scale; canvas.height = (head + H + foot) * scale;
    const ctx = canvas.getContext('2d'); ctx.scale(scale, scale);
    ctx.fillStyle = v('--card'); ctx.fillRect(0, 0, W + pad * 2, head + H + foot);
    ctx.fillStyle = v('--ink'); ctx.font = 'bold 14px ' + FONT; ctx.fillText(course.name, pad, 20);
    ctx.fillStyle = v('--ink-2'); ctx.font = '12px ' + FONT;
    ctx.fillText(`${F.fmtDT(p.start)} 出走 ・ ${p.spd} km/h${p.sleeps.length ? ' ・ 仮眠 ' + p.sleeps.map(x => Math.round(x.d) + 'km/' + x.m + '分').join(', ') : ''} ・ ゴール予定 ${F.fmtDT(sm.goal)}`, pad, 40);
    ctx.fillText(`向かい風 ${sm.headKm} km ・ 雨中走行 ${sm.rainKm} km ・ 最低気温 ${sm.tmin ? n1(sm.tmin.temp) + '℃' : '—'} ・ 夜間 ${sm.nightKm} km`, pad, 57);
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('リボンの画像化に失敗しました')); img.src = url; });
      ctx.drawImage(img, pad, head, W, H);
    } finally { URL.revokeObjectURL(url); }
    ctx.fillStyle = v('--ink-3'); ctx.font = '10px ' + FONT;
    ctx.fillText('Route Weather JP ／ 出典：気象庁 数値予報（MSM/GSM）— Open-Meteo 経由 ／ 予報取得 ' + F.fmtDT(state.series.fetchedAt), pad, head + H + 14);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('PNG を作れませんでした');
    const file = new File([blob], `route-weather-${F.ymd(p.start)}.png`, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Route Weather JP' }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ===== 配線 =====
  $('share').addEventListener('click', async () => { try { await shareImage(); } catch (e) { setStatus('画像の共有に失敗しました：' + e.message, 'err'); } });
  $('theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || 'auto';
    const next = cur === 'auto' ? 'dark' : cur === 'dark' ? 'light' : 'auto';
    if (next === 'auto') { delete document.documentElement.dataset.theme; store.del('rw:theme'); } else { document.documentElement.dataset.theme = next; store.set('rw:theme', next); }
    renderTheme(); if (state.result) { renderRibbon(); renderMap(); }
  });
  function renderTheme() { const cur = document.documentElement.dataset.theme || 'auto'; $('theme').textContent = '表示：' + ({ auto: '自動', dark: 'ダーク', light: 'ライト' })[cur]; }
  renderTheme();
  if ('serviceWorker' in navigator && location.protocol === 'https:') { navigator.serviceWorker.register('./sw.js').catch(() => { /* 未対応・失敗時は通常動作 */ }); }
  $('file').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) loadFile(f); });
  const lb = $('loadBtn'); // PC 向けの補助：ドラッグ＆ドロップ
  ['dragenter', 'dragover'].forEach(ev => lb.addEventListener(ev, e => { e.preventDefault(); lb.classList.add('on'); }));
  ['dragleave', 'drop'].forEach(ev => lb.addEventListener(ev, e => { e.preventDefault(); lb.classList.remove('on'); }));
  lb.addEventListener('drop', e => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) loadFile(f); });
  $('sampleLink').addEventListener('click', async e => {
    e.preventDefault(); setStatus('サンプルを読み込み中…');
    try { const r = await fetch(e.currentTarget.getAttribute('href')); if (!r.ok) throw new Error('HTTP ' + r.status); setCourse(parseGPX(await r.text(), 'サンプルコース')); }
    catch (err) { setStatus('サンプルを読み込めませんでした：' + err.message, 'err'); }
  });
  $('recent').addEventListener('change', e => { const list = store.get('rw:courses') || []; const c = list[+e.target.value]; e.target.value = ''; if (c && c.course && c.course.pts) setCourse(c.course); });
  $('reverse').addEventListener('click', () => { if (state.course) setCourse(RW.course.reverseCourse(state.course)); });
  $('addSleep').addEventListener('click', () => { addSleepRow().querySelector('.sd').focus(); });
  $('addSeg').addEventListener('click', () => { addSegRow().querySelector('.sf').focus(); });
  ['ancD', 'ancT'].forEach(id => $(id).addEventListener('change', onParamChange));
  $('ancNow').addEventListener('click', () => { $('ancT').value = localDT(Date.now()); if (!$('ancD').value) { $('ancD').focus(); return; } onParamChange(); });
  $('ancClear').addEventListener('click', () => { $('ancD').value = ''; $('ancT').value = ''; onParamChange(); });
  ['date', 'time', 'spd'].forEach(id => $(id).addEventListener('change', onParamChange));
  $('run').addEventListener('click', () => { state.warnings = null; state.amedas = null; run({ force: true }); });
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (state.result) { renderRibbon(); renderMap(); } }, 150); });
  window.addEventListener('online', () => { if (state.course && state.offlineNote) run(); });

  // ===== 起動：前回のコース・予報を復元してから最新を取りに行く =====
  loadParams(); renderRecent();
  const last = store.get('rw:last');
  const savedCourse = (last && last.course) || store.get('rw:course');
  if (savedCourse && savedCourse.pts && savedCourse.pts.length > 1) {
    state.course = savedCourse; renderCourse();
    if (last && last.series && last.series.hash === RW.course.hashCourse(savedCourse)) state.series = last.series;
    if (window.innerWidth >= 900) $('settings').open = true;
    if (state.series) { try { recompute(); } catch (e) { /* 壊れた保存データは無視して再取得へ */ } }
    run();
  }
})();
