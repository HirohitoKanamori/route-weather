// Route-Weather.jp — 純粋関数群（course / plan / wind / sun / forecast / fmt）。DOM・ネットワークに触れない。test/ から直接 import される。
// 純粋関数群（course / plan / wind / sun / forecast / fmt）。DOM・ネットワークに触れない。
// test/ から Node で評価されるので、ここにブラウザ専用 API を書かないこと。
export const RW = (function () {
  'use strict';
  const R = Math.PI / 180;
  const JST_MIN = 540;
  const RAIN_MM = 0.5;                 // これ以上の降水（mm/h）を「雨中走行」とみなす
  const TAIL_DEG = 45, HEAD_DEG = 135; // 相対風の分類閾値（F-3）
  const MAX_PTS = 600;                 // コースの間引き上限
  const HOURLY = ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'precipitation', 'weather_code', 'cloud_cover', 'wind_speed_10m', 'wind_direction_10m', 'sunshine_duration'];
  const MODELS = {
    msm: { id: 'jma_msm', days: 4, label: '気象庁 MSM', grid: '約 5 km 格子・1 時間値' },
    gsm: { id: 'jma_gsm', days: 11, label: '気象庁 GSM', grid: '約 55 km 格子・6 時間値を 1 時間に補間' }
  };

  // ---------- fmt：表示は端末のタイムゾーンによらず常に JST ----------
  function jstParts(t) {
    const d = new Date(+t + JST_MIN * 60e3);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() };
  }
  const DOW = ['日', '月', '火', '水', '木', '金', '土'];
  const p2 = n => String(n).padStart(2, '0');
  const fmtH = t => { const x = jstParts(t); return p2(x.h) + ':' + p2(x.mi); };
  const fmtT = t => { const x = jstParts(t); return x.mo + '/' + x.d + ' ' + p2(x.h) + ':' + p2(x.mi); };
  const fmtDT = t => { const x = jstParts(t); return x.mo + '/' + x.d + '(' + DOW[x.dow] + ') ' + p2(x.h) + ':' + p2(x.mi); };
  const dateKey = t => { const x = jstParts(t); return x.mo + '/' + x.d; };
  const ymd = t => { const x = jstParts(t); return x.y + '-' + p2(x.mo) + '-' + p2(x.d); };

  // ---------- course ----------
  function hav(a, b) {
    const dl = (b.lat - a.lat) * R, dn = (b.lon - a.lon) * R;
    const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin(dn / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    const y = Math.sin((b.lon - a.lon) * R) * Math.cos(b.lat * R);
    const x = Math.cos(a.lat * R) * Math.sin(b.lat * R) - Math.sin(a.lat * R) * Math.cos(b.lat * R) * Math.cos((b.lon - a.lon) * R);
    return (Math.atan2(y, x) / R + 360) % 360;
  }
  // 生の点列 [{lat,lon,ele?}] からコースを作る。累積距離は全点で計算し、保持する点は距離ベースで間引く。
  function fromPoints(raw, name, maxPts = MAX_PTS) {
    const src = raw.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (src.length < 2) throw new Error('有効な地点が 2 点未満です');
    const hasEle = src.some(p => Number.isFinite(p.ele));
    let d = 0;
    const cum = new Array(src.length);
    for (let i = 0; i < src.length; i++) { if (i > 0) d += hav(src[i - 1], src[i]); cum[i] = d; }
    const total = d;
    const gain = hasEle ? elevationGain(src, cum) : 0;
    // 下り量（反転時の獲得標高に使う）：点列を逆順にして同じ方法で計算
    const loss = hasEle ? elevationGain(src.slice().reverse(), cum.map(v => total - v).reverse()) : 0;
    const minGap = total / maxPts;
    const pts = []; let lastD = -Infinity;
    for (let i = 0; i < src.length; i++) {
      if (cum[i] - lastD >= minGap || i === src.length - 1) {
        pts.push({ lat: src[i].lat, lon: src[i].lon, ele: Number.isFinite(src[i].ele) ? src[i].ele : null, d: cum[i] });
        lastD = cum[i];
      }
    }
    if (hasEle) { // 標高の欠損は前後の値で埋める
      let prev = null; for (const p of pts) { if (p.ele == null) p.ele = prev; else prev = p.ele; }
      let next = null; for (let i = pts.length - 1; i >= 0; i--) { if (pts[i].ele == null) pts[i].ele = next; else next = pts[i].ele; }
    }
    return { name: name || 'コース', pts, total, gain: Math.round(gain), loss: Math.round(loss), n: src.length, hasEle };
  }
  // 獲得標高：標高を前後 ±100 m の距離窓で平滑化してから、3 m のヒステリシスで登りだけを積算する
  // （RwGPS/Garmin の標高ノイズをそのまま足すと 1.5 倍前後に膨らむため）
  function elevationGain(src, cum, winKm = 0.1, th = 3) {
    const n = src.length; const e = new Array(n);
    let lo = 0, hi = -1, sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      while (hi + 1 < n && cum[hi + 1] <= cum[i] + winKm) { hi++; const v = src[hi].ele; if (Number.isFinite(v)) { sum += v; cnt++; } }
      while (cum[lo] < cum[i] - winKm) { const v = src[lo].ele; if (Number.isFinite(v)) { sum -= v; cnt--; } lo++; }
      e[i] = cnt ? sum / cnt : null;
    }
    let gain = 0, base = null;
    for (const v of e) {
      if (v == null) continue;
      if (base === null) base = v;
      else if (v - base >= th) { gain += v - base; base = v; }
      else if (v < base) base = v;
    }
    return gain;
  }
  function interp(course, d) {
    const P = course.pts;
    if (d <= P[0].d) return { lat: P[0].lat, lon: P[0].lon, ele: P[0].ele, d: P[0].d };
    const last = P[P.length - 1];
    if (d >= last.d) return { lat: last.lat, lon: last.lon, ele: last.ele, d: last.d };
    let lo = 0, hi = P.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m].d <= d) lo = m; else hi = m; }
    const a = P[lo], b = P[hi], k = (d - a.d) / ((b.d - a.d) || 1);
    const ele = (a.ele == null || b.ele == null) ? (a.ele ?? b.ele ?? null) : a.ele + (b.ele - a.ele) * k;
    return { lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k, ele, d };
  }
  // 地点 d の進行方位：前後 win km の 2 点を結ぶ方位（曲がり角の揺れを抑える）
  function headingAt(course, d, win = 0.5) {
    const t = course.total;
    let a = interp(course, Math.max(0, d - win)), b = interp(course, Math.min(t, d + win));
    if (hav(a, b) < 1e-4) { a = interp(course, Math.max(0, d - 5)); b = interp(course, Math.min(t, d + 5)); }
    return bearing(a, b);
  }
  // コース反転（往復・復路確認用、C-7）
  function reverseCourse(course) {
    const total = course.total;
    const pts = course.pts.slice().reverse().map(q => ({ lat: q.lat, lon: q.lon, ele: q.ele, d: Math.max(0, total - q.d) }));
    pts[0].d = 0; pts[pts.length - 1].d = total;
    // 反転後の登りは元コースの下り。旧データで loss が無ければ間引き後の点列から概算する
    let gain = course.loss;
    if (gain == null) { gain = 0; if (course.hasEle) { let base = null; for (const q of pts) { if (q.ele == null) continue; if (base === null) base = q.ele; else if (q.ele - base >= 3) { gain += q.ele - base; base = q.ele; } else if (q.ele < base) base = q.ele; } } }
    const name = /（反転）$/.test(course.name) ? course.name.replace(/（反転）$/, '') : course.name + '（反転）';
    return { name, pts, total, gain: course.hasEle ? Math.round(gain) : 0, loss: course.gain, n: course.n, hasEle: course.hasEle };
  }
  function hashCourse(course) {
    const s = course.pts.map(p => p.lat.toFixed(4) + ',' + p.lon.toFixed(4)).join(';') + '|' + course.n;
    let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  // ---------- plan：距離 ⇄ 時刻 ----------
  // p = { start: Date, spd: km/h, sleeps: [{d, m}], segments: [{from, to, spd}], anchor: {d, t}|null }
  // sleeps / segments は norm* 済み。anchor は走行中の再計算用（現在 d km に時刻 t でいる）
  function normSleeps(sleeps, total) {
    return (sleeps || []).map(s => ({ d: +s.d, m: +s.m })).filter(s => s.d > 0 && s.d < total && s.m > 0).sort((a, b) => a.d - b.d);
  }
  // 区間別速度：不正・重なりを除き、距離順に並べる（重なった区間は先に始まる方を優先）
  function normSegments(segs, total) {
    return (segs || []).map(x => ({ from: +x.from, to: +x.to, spd: +x.spd }))
      .filter(x => x.spd > 0 && x.from >= 0 && x.from < total && x.to > x.from)
      .map(x => ({ from: x.from, to: Math.min(x.to, total), spd: x.spd }))
      .sort((a, b) => a.from - b.from)
      .filter((x, i, arr) => i === 0 || x.from >= arr[i - 1].to);
  }
  // 0 → d km の走行時間（停止を除く）。区間別速度がある区間はその速度、無い区間はグロス速度
  function rideHours(d, p) {
    let h = 0, pos = 0;
    for (const x of (p.segments || [])) {
      if (pos >= d) break;
      const a = Math.min(Math.max(x.from, pos), d), b = Math.min(x.to, d);
      if (a > pos) { h += (a - pos) / p.spd; pos = a; }
      if (b > a) { h += (b - a) / x.spd; pos = b; }
    }
    if (d > pos) h += (d - pos) / p.spd;
    return h;
  }
  // d km までに挟む仮眠時間。arrive=true なら d ちょうどの仮眠は含めない。fromD 以降の仮眠だけを数えることもできる
  function sleepHours(p, d, arrive = false, fromD = null) {
    let h = 0;
    for (const x of p.sleeps) { if (fromD != null && x.d < fromD) continue; if (arrive ? x.d < d : x.d <= d) h += x.m / 60; }
    return h;
  }
  // 出走からの経過時間（仮眠を含む）
  function elapsedH(d, p, arrive = false) { return rideHours(d, p) + sleepHours(p, d, arrive); }
  // d km の通過時刻。anchor があり d がその先なら、anchor の時刻を起点に計算し直す（P-5）
  function timeAt(d, p, arrive = false) {
    const a = p.anchor;
    if (a && d >= a.d) return new Date(+a.t + (rideHours(d, p) - rideHours(a.d, p) + sleepHours(p, d, arrive, a.d)) * 3600e3);
    return new Date(+p.start + elapsedH(d, p, arrive) * 3600e3);
  }
  function sampleStep(total) { return total > 300 ? 10 : total > 120 ? 5 : 2.5; }
  function samplePoints(course, p, step) {
    const out = [];
    const push = d => {
      const pt = interp(course, d); const t = timeAt(d, p);
      out.push({ d, lat: pt.lat, lon: pt.lon, ele: pt.ele, hb: headingAt(course, d), eh: (+t - +p.start) / 3600e3, t });
    };
    for (let d = 0; d < course.total - 1e-6; d += step) push(d);
    push(course.total);
    return out;
  }
  // リボンの時刻目盛用：サンプル列に仮眠の到着・出発を挟んだ (d, t) の節点列
  function timeNodes(S, p) {
    const nodes = S.map(x => ({ d: x.d, t: +x.t }));
    for (const sl of p.sleeps) nodes.push({ d: sl.d, t: +timeAt(sl.d, p, true) }, { d: sl.d, t: +timeAt(sl.d, p) });
    return nodes.sort((a, b) => a.d - b.d || a.t - b.t);
  }
  // 節点列から正時の目盛 [{t, d, sleep}] を作る。仮眠中（距離が進まない区間）の正時は sleep=true
  function hourTicks(nodes) {
    const out = [], H = 3600e3;
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1], b = nodes[i];
      if (b.t <= a.t) continue;
      const inSleep = b.d === a.d;
      for (let h = Math.ceil(a.t / H) * H; h <= b.t; h += H) {
        if (h === a.t && i > 1) continue;
        out.push({ t: h, d: a.d + (b.d - a.d) * ((h - a.t) / (b.t - a.t)), sleep: inSleep });
      }
    }
    return out;
  }

  // ---------- wind ----------
  // fromDeg：風の吹いてくる方位（気象慣例）。headingDeg：進行方位。
  // rel：吹いていく向きと進行方位の差（0 = 真後ろからの追い風、±180 = 正面）。comp：進行方向成分 m/s（+ 追い風 / − 向かい風）
  function relative(fromDeg, ms, headingDeg) {
    const to = (fromDeg + 180) % 360;
    const rel = ((to - headingDeg) + 540) % 360 - 180;
    const comp = Math.cos(rel * R) * ms;
    const a = Math.abs(rel);
    return { rel, comp, cls: a <= TAIL_DEG ? 'tail' : a >= HEAD_DEG ? 'head' : 'cross' };
  }
  const DIR16 = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
  function dir16(deg) { return DIR16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]; }

  // ---------- sun：NOAA の簡易式。t の JST 暦日について日の出・日の入り（JST）を返す ----------
  function sunTimes(t, lat, lon) {
    const x = jstParts(t);
    const dayStart = Date.UTC(x.y, x.mo - 1, x.d) - JST_MIN * 60e3;
    const JD = (dayStart + 12 * 3600e3) / 86400e3 + 2440587.5;
    const jc = (JD - 2451545) / 36525;
    const gmls = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
    const gmas = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
    const eeo = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
    const seoc = Math.sin(gmas * R) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + Math.sin(2 * gmas * R) * (0.019993 - 0.000101 * jc) + Math.sin(3 * gmas * R) * 0.000289;
    const omega = (125.04 - 1934.136 * jc) * R;
    const sal = gmls + seoc - 0.00569 - 0.00478 * Math.sin(omega);
    const moe = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
    const oc = moe + 0.00256 * Math.cos(omega);
    const decl = Math.asin(Math.sin(oc * R) * Math.sin(sal * R));
    const vy = Math.tan(oc / 2 * R) ** 2;
    const eqt = 4 / R * (vy * Math.sin(2 * gmls * R) - 2 * eeo * Math.sin(gmas * R) + 4 * eeo * vy * Math.sin(gmas * R) * Math.cos(2 * gmls * R) - 0.5 * vy * vy * Math.sin(4 * gmls * R) - 1.25 * eeo * eeo * Math.sin(2 * gmas * R));
    const cosHA = Math.cos(90.833 * R) / (Math.cos(lat * R) * Math.cos(decl)) - Math.tan(lat * R) * Math.tan(decl);
    if (cosHA > 1) return { sunrise: null, sunset: null, polar: 'night' };
    if (cosHA < -1) return { sunrise: null, sunset: null, polar: 'day' };
    const ha = Math.acos(cosHA) / R;
    const noon = 720 - 4 * lon - eqt + JST_MIN; // JST 0:00 からの分
    return { sunrise: new Date(dayStart + (noon - ha * 4) * 60e3), sunset: new Date(dayStart + (noon + ha * 4) * 60e3), polar: null };
  }
  function isNight(t, lat, lon) {
    const s = sunTimes(t, lat, lon);
    if (!s.sunrise) return s.polar === 'night';
    return +t < +s.sunrise || +t >= +s.sunset;
  }

  // ---------- forecast：Open-Meteo /v1/jma（気象庁 MSM / GSM のみ） ----------
  function buildUrl(points, model, pastDays = 0) {
    const m = MODELS[model]; const f = v => (+v).toFixed(4);
    return 'https://api.open-meteo.com/v1/jma?latitude=' + points.map(p => f(p.lat)).join(',') +
      '&longitude=' + points.map(p => f(p.lon)).join(',') +
      '&hourly=' + HOURLY.join(',') + '&models=' + m.id +
      '&wind_speed_unit=ms&timezone=Asia%2FTokyo&forecast_days=' + m.days + (pastDays > 0 ? '&past_days=' + pastDays : '');
  }
  function parseTime(s) { return Date.parse(s.length === 16 ? s + ':00+09:00' : s); }
  // レスポンス（単一地点はオブジェクト、複数地点は配列）→ 地点ごとの時系列
  function parseSeries(json) {
    const arr = Array.isArray(json) ? json : [json];
    return arr.map(loc => {
      const h = loc.hourly || {};
      const times = (h.time || []).map(parseTime);
      const temp = h.temperature_2m || [];
      let vf = -1, vu = -1;
      for (let i = 0; i < times.length; i++) if (temp[i] != null) { if (vf < 0) vf = i; vu = i; }
      return {
        times, temp, feel: h.apparent_temperature || [], rh: h.relative_humidity_2m || [], mm: h.precipitation || [], code: h.weather_code || [],
        cloud: h.cloud_cover || [], ws: h.wind_speed_10m || [], wd: h.wind_direction_10m || [], sun: h.sunshine_duration || [],
        validFrom: vf >= 0 ? times[vf] : null, validUntil: vu >= 0 ? times[vu] : null, lat: loc.latitude, lon: loc.longitude
      };
    });
  }
  // 全地点で値がある最終時刻（ms）。無ければ null
  function horizon(series) {
    if (!series || !series.length) return null;
    let m = null;
    for (const s of series) { if (s.validUntil == null) return null; m = m == null ? s.validUntil : Math.min(m, s.validUntil); }
    return m;
  }
  // 時刻 t（ms）の値。温度・風速は線形補間、風向は円周補間、降水は t を含む 1 時間の値、天気コードは近い方
  function at(s, t) {
    if (s.validFrom == null || t < s.validFrom || t > s.validUntil) return null;
    const T = s.times; if (T.length < 2) return null;
    let i = Math.floor((t - T[0]) / 3600e3); if (i < 0) i = 0; if (i >= T.length - 1) i = T.length - 2;
    const k = (t - T[i]) / 3600e3;
    const L = a => { const x = a[i], y = a[i + 1]; if (x == null && y == null) return null; if (x == null) return y; if (y == null) return x; return x + (y - x) * k; };
    let wd; { const x = s.wd[i], y = s.wd[i + 1]; if (x == null || y == null) wd = x ?? y ?? 0; else { const dd = ((y - x) + 540) % 360 - 180; wd = ((x + dd * k) % 360 + 360) % 360; } }
    const near = k < 0.5 ? i : i + 1;
    const sunArr = s.sun || [], feelArr = s.feel || [];
    return { temp: L(s.temp), feel: feelArr.length ? L(feelArr) : null, rh: L(s.rh) ?? 0, mm: s.mm[i + 1] ?? s.mm[i] ?? 0, code: s.code[near] ?? s.code[i] ?? null,
      cloud: L(s.cloud) ?? 0, ws: L(s.ws) ?? 0, wd, sun: sunArr.length ? (sunArr[i + 1] ?? sunArr[i] ?? null) : null };
  }
  // 地点 idx・時刻 t について MSM → GSM の順で採用（F-8）
  function pick(series, idx, t) {
    for (const m of ['msm', 'gsm']) {
      const arr = series[m]; const s = arr && arr[idx]; if (!s) continue;
      const v = at(s, t); if (v) return { v, model: m };
    }
    return null;
  }
  function computeRide(course, p, series) {
    const step = sampleStep(course.total);
    const S = samplePoints(course, p, step);
    S.forEach((s, i) => {
      s.night = isNight(s.t, s.lat, s.lon);
      const pk = pick(series, i, +s.t);
      if (!pk) { s.na = true; return; }
      Object.assign(s, pk.v); s.model = pk.model;
      Object.assign(s, relative(s.wd, s.ws, s.hb));
    });
    return { S, step };
  }
  // 要点（V-3）。km の集計はゴール地点を除く各サンプルが step km を代表するとみなす
  function summarize(S, step) {
    const body = S.slice(0, -1), ok = body.filter(s => !s.na), okAll = S.filter(s => !s.na);
    const last = S[S.length - 1];
    const rainS = ok.filter(s => s.mm >= RAIN_MM);
    const naFirst = S.find(s => s.na), gsmFirst = S.find(s => s.model === 'gsm');
    return {
      goal: last.t, totalH: last.eh,
      headKm: ok.filter(s => s.cls === 'head').length * step,
      rainKm: rainS.length * step, rainFirst: rainS[0] || null, rainLast: rainS[rainS.length - 1] || null,
      nightKm: body.filter(s => s.night).length * step,
      tmin: okAll.length ? okAll.reduce((a, b) => b.temp < a.temp ? b : a) : null,
      tmax: okAll.length ? okAll.reduce((a, b) => b.temp > a.temp ? b : a) : null,
      wsMax: okAll.length ? okAll.reduce((a, b) => b.ws > a.ws ? b : a) : null,
      naFrom: naFirst ? naFirst.d : null, gsmFrom: gsmFirst ? gsmFirst.d : null,
      nOk: okAll.length, n: S.length
    };
  }
  // 傾向モード（F-9）：segKm 区間 × 通過日 に集約
  function trendAggregate(S, step, total, spd, segKm = 50) {
    const map = new Map();
    for (const s of S) {
      if (s.na) continue;
      const seg = Math.floor(Math.min(s.d, total - 1e-6) / segKm); const day = dateKey(s.t); const key = seg + '|' + day;
      let r = map.get(key);
      if (!r) { r = { seg, from: seg * segKm, to: Math.min((seg + 1) * segKm, total), day, firstT: +s.t, n: 0, ux: 0, uy: 0, wsSum: 0, mmSum: 0, tmax: -Infinity, tmin: Infinity, headN: 0, models: new Set() }; map.set(key, r); }
      r.n++; r.ux += Math.sin(s.wd * R) * s.ws; r.uy += Math.cos(s.wd * R) * s.ws; r.wsSum += s.ws;
      r.mmSum += s.mm * (step / spd); r.tmax = Math.max(r.tmax, s.temp); r.tmin = Math.min(r.tmin, s.temp);
      if (s.cls === 'head') r.headN++; r.models.add(s.model);
    }
    return [...map.values()].sort((a, b) => a.seg - b.seg || a.firstT - b.firstT).map(r => ({
      seg: r.seg, from: r.from, to: r.to, day: r.day, n: r.n,
      wdPrev: (Math.atan2(r.ux, r.uy) / R + 360) % 360, wsMean: r.wsSum / r.n, mmSum: r.mmSum,
      tmax: r.tmax, tmin: r.tmin, headKm: r.headN * step, models: [...r.models]
    }));
  }
  // 出走時刻の比較（F-6）
  function startComparison(course, p, series, offsets = [-3, -2, -1, 0, 1, 2, 3]) {
    return offsets.map(off => {
      const q = Object.assign({}, p, { start: new Date(+p.start + off * 3600e3) });
      const { S, step } = computeRide(course, q, series);
      const sm = summarize(S, step);
      return Object.assign({ off, start: q.start, score: sm.headKm + sm.rainKm * 1.5 }, sm);
    });
  }
  const WMO = { 0: '快晴', 1: '晴', 2: '晴時々曇', 3: '曇', 45: '霧', 48: '霧（着氷）', 51: '霧雨', 53: '霧雨', 55: '霧雨（強）', 56: '着氷性霧雨', 57: '着氷性霧雨', 61: '小雨', 63: '雨', 65: '大雨', 66: '着氷性の雨', 67: '着氷性の雨', 71: '小雪', 73: '雪', 75: '大雪', 77: '霧雪', 80: 'にわか雨', 81: 'にわか雨', 82: '激しいにわか雨', 85: 'にわか雪', 86: 'にわか雪', 95: '雷雨', 96: '雷雨（雹）', 99: '雷雨（雹）' };
  function wmoText(c) { return c == null ? '—' : (WMO[c] || ('天気コード ' + c)); }
  // 地図の経路色分け用：雨（降水 RAIN_MM 以上、または霧雨・雨・雪・雷の天気コード）／曇り（曇・霧）／晴れ（快晴・晴）
  function wxClass(s) {
    if (!s || s.na || s.code == null && s.mm == null) return null;
    const code = s.code == null ? -1 : +s.code;
    if ((s.mm != null && s.mm >= RAIN_MM) || code >= 51) return 'rain';
    if (code === 2 || code === 3 || code === 45 || code === 48) return 'cloud';
    if (code === 0 || code === 1) return 'sun';
    return 'cloud';
  }

  return {
    const: { RAIN_MM, TAIL_DEG, HEAD_DEG, MAX_PTS, HOURLY, MODELS },
    fmt: { jstParts, fmtH, fmtT, fmtDT, dateKey, ymd },
    course: { hav, bearing, fromPoints, elevationGain, interp, headingAt, reverseCourse, hashCourse },
    plan: { normSleeps, normSegments, rideHours, sleepHours, elapsedH, timeAt, sampleStep, samplePoints, timeNodes, hourTicks },
    wind: { relative, dir16 },
    sun: { sunTimes, isNight },
    forecast: { buildUrl, parseSeries, horizon, at, pick, computeRide, summarize, trendAggregate, startComparison, wmoText, wxClass }
  };
})();
