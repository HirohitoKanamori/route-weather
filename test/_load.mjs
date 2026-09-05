// index.html 内の純粋関数ブロック（/*==CORE-BEGIN==*/ 〜 /*==CORE-END==*/）を
// 切り出して Node で評価し、RW 名前空間を返す。ビルド無しで単一 HTML を保つための仕組み。
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const m = html.match(/\/\*==CORE-BEGIN==\*\/([\s\S]*?)\/\*==CORE-END==\*\//);
if (!m) throw new Error('index.html に CORE ブロックが見つかりません');
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(m[1] + '\nthis.RW = RW;', ctx, { filename: 'index.html#core' });
export const RW = ctx.RW;

// 直線コース（南→北）を作る。step km ごとに n 点。
export function straightCourse(n = 61, stepKm = 10, lat0 = 35.0, lon = 139.0) {
  const raw = [];
  for (let i = 0; i < n; i++) raw.push({ lat: lat0 + (i * stepKm) / 111.195, lon, ele: 100 + 50 * Math.sin(i / 3) });
  return RW.course.fromPoints(raw, 'テスト直線');
}

// 全地点共通の合成時系列。from(JST ms) から hours 時間、値は関数で与える。
export function syntheticSeries(nPoints, fromMs, hours, fn) {
  const out = [];
  for (let p = 0; p < nPoints; p++) {
    const times = [], temp = [], feel = [], rh = [], mm = [], code = [], cloud = [], ws = [], wd = [], sun = [];
    for (let h = 0; h < hours; h++) {
      const v = fn(p, h);
      times.push(fromMs + h * 3600e3); temp.push(v.temp); feel.push(v.feel ?? v.temp - 1); rh.push(v.rh ?? 60); mm.push(v.mm);
      code.push(v.code ?? 1); cloud.push(v.cloud ?? 30); ws.push(v.ws); wd.push(v.wd); sun.push(v.sun ?? 1800);
    }
    out.push({ times, temp, feel, rh, mm, code, cloud, ws, wd, sun, validFrom: times[0], validUntil: times[times.length - 1], lat: 0, lon: 0 });
  }
  return out;
}

export const JST = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi);
