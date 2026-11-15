/* 星盘合盘 demo · 天文计算引擎（纯 JS，无依赖）
 * 覆盖：太阳/月亮/水金火木土 + 地球（换算地心）黄经、上升点、整宫制宫位、星座、合盘相位。
 * 精度（demo 足够）：太阳 ~0.01°，月亮 ~0.2°（Meeus 主项截断），行星 ~1′~2′（Standish 近似要素）。
 * 时区：输入一律按北京时间（UTC+8）处理。
 */
(function (root) {
  'use strict';
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const norm = a => ((a % 360) + 360) % 360;
  const norm180 = a => { a = norm(a); return a > 180 ? a - 360 : a; };
  const sin = d => Math.sin(d * D2R), cos = d => Math.cos(d * D2R), tan = d => Math.tan(d * D2R);

  /* ---------- 儒略日（输入北京时间） ---------- */
  function julianDay(y, mo, d, hh, mm) {
    // 用 Date.UTC 自动处理 -8h 跨日回退
    const utc = Date.UTC(y, mo - 1, d, (hh | 0) - 8, mm | 0, 0);
    return utc / 86400000 + 2440587.5;
  }

  /* ---------- 太阳（Meeus 低精度） ---------- */
  function sunLon(T) {
    const L0 = norm(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
    const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(M)
      + (0.019993 - 0.000101 * T) * sin(2 * M) + 0.000289 * sin(3 * M);
    return norm(L0 + C);
  }

  /* ---------- 月亮（Meeus 主周期项截断，~0.2°） ---------- */
  function moonLon(T) {
    const Lp = 218.3164477 + 481267.88123421 * T;
    const D = 297.8501921 + 445267.1114034 * T;
    const M = 357.5291092 + 35999.0502909 * T;
    const Mp = 134.9633964 + 477198.8675055 * T;
    const F = 93.272095 + 483202.0175233 * T;
    let lon = Lp
      + 6.288774 * sin(Mp) + 1.274027 * sin(2 * D - Mp) + 0.658314 * sin(2 * D)
      + 0.213618 * sin(2 * Mp) - 0.185116 * sin(M) - 0.114332 * sin(2 * F)
      + 0.058793 * sin(2 * D - 2 * Mp) + 0.057066 * sin(2 * D - M - Mp)
      + 0.053322 * sin(2 * D + Mp) + 0.045758 * sin(2 * D - M)
      - 0.040923 * sin(M - Mp) - 0.034720 * sin(D) - 0.030383 * sin(M + Mp)
      + 0.015327 * sin(2 * D - 2 * F) - 0.012528 * sin(Mp + 2 * F)
      + 0.010980 * sin(Mp - 2 * F) + 0.010675 * sin(4 * D - Mp)
      + 0.010034 * sin(3 * Mp) + 0.008548 * sin(4 * D - 2 * Mp);
    return norm(lon);
  }

  /* ---------- 行星（JPL Standish 近似开普勒要素，1800-2050） ---------- */
  /* [a, e, I, L, 长周期perihelion ϖ, 升交点 Ω, 及各自的每世纪变化率] */
  const ELEM = {
    mercury: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593,
      0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
    venus: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255,
      0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418],
    earth: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0,
      0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
    mars: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
      0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
    jupiter: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
      -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
    saturn: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448,
      -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]
  };

  function helioVec(name, T) {
    const c = ELEM[name];
    const a = c[0] + c[6] * T, e = c[1] + c[7] * T, I = (c[2] + c[8] * T) * D2R;
    const L = c[3] + c[9] * T, peri = c[4] + c[10] * T, node = c[5] + c[11] * T;
    const om = (peri - node) * D2R, O = node * D2R;
    let M = norm180(L - peri) * D2R;
    let E = M;
    for (let i = 0; i < 8; i++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const co = Math.cos(om), so = Math.sin(om), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
    return [
      (co * cO - so * sO * cI) * xp + (-so * cO - co * sO * cI) * yp,
      (co * sO + so * cO * cI) * xp + (-so * sO + co * cO * cI) * yp,
      so * sI * xp + co * sI * yp
    ];
  }

  function geoLon(name, T) {
    if (name === 'sun') return sunLon(T);
    if (name === 'moon') return moonLon(T);
    const p = helioVec(name, T), e = helioVec('earth', T);
    return norm(Math.atan2(p[1] - e[1], p[0] - e[0]) * R2D);
  }

  /* ---------- 上升点 / 天顶（整宫制配合） ---------- */
  function gmstDeg(JD) {
    const d = JD - 2451545.0, T = d / 36525;
    return norm(280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - T * T * T / 38710000);
  }
  function obliquity(T) { return 23.4392911 - 0.0130042 * T - 1.64e-7 * T * T; }
  function ascLon(JD, latDeg, lonEastDeg) {
    const T = (JD - 2451545.0) / 36525;
    const ramc = norm(gmstDeg(JD) + lonEastDeg), eps = obliquity(T);
    const y = -(sin(ramc) * cos(eps) + tan(latDeg) * sin(eps));
    return norm(Math.atan2(cos(ramc), y) * R2D);
  }
  function mcLon(JD, lonEastDeg) {
    const T = (JD - 2451545.0) / 36525;
    const ramc = norm(gmstDeg(JD) + lonEastDeg), eps = obliquity(T);
    return norm(Math.atan2(sin(ramc), cos(ramc) * cos(eps)) * R2D);
  }

  /* ---------- 星座 ---------- */
  const SIGNS = ['白羊', '金牛', '双子', '巨蟹', '狮子', '处女', '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼'];
  const SIGN_GLYPH = ['♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓'];
  const ELEMENTS = ['fire', 'earth', 'air', 'water'];
  const ELEMENT_CN = { fire: '火', earth: '土', air: '风', water: '水' };
  function signOf(lon) { return Math.floor(norm(lon) / 30); }

  function wrap(lon, hasTime, asc, house) {
    const si = signOf(lon);
    return {
      lon: Math.round(norm(lon) * 100) / 100,
      signIdx: si, sign: SIGNS[si], glyph: SIGN_GLYPH[si],
      degInSign: Math.round((norm(lon) - si * 30) * 100) / 100,
      house: hasTime ? ((signOf(lon) - signOf(asc)) + 12) % 12 + 1 : null,
      element: ELEMENTS[si % 4]
    };
  }

  /* ---------- 单人本命盘 ---------- */
  const PLANET_KEYS = ['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn'];
  function calcChart(p) {
    // p: {y, mo, d, hh, mm, lat, lon, name}
    const hasTime = p.hh !== null && p.hh !== undefined && !isNaN(p.hh);
    const hh = hasTime ? p.hh : 12, mm = hasTime ? (p.mm | 0) : 0;
    const JD = julianDay(p.y, p.mo, p.d, hh, mm);
    const T = (JD - 2451545.0) / 36525;
    const asc = hasTime ? ascLon(JD, p.lat, p.lon) : null;
    const planets = {};
    for (const k of PLANET_KEYS) planets[k] = wrap(geoLon(k, T), hasTime, asc);
    if (hasTime) planets.asc = wrap(asc, true, asc);
    return {
      name: p.name || '', hasTime, JD, T, asc, mc: hasTime ? mcLon(JD, p.lon) : null,
      planets,
      timeNote: hasTime ? '' : '未填出生时间，按当天中午 12:00 计算；月亮临界日可能差一档，上升与宫位不参与。'
    };
  }

  /* ---------- 合盘相位（A 全体 × B 全体） ---------- */
  const ASPECT_DEFS = [
    { k: 'conj', angle: 0, orb: 7, s: '☌', n: '合相' },
    { k: 'sextile', angle: 60, orb: 4.5, s: '⚹', n: '六合' },
    { k: 'square', angle: 90, orb: 6.5, s: '□', n: '刑' },
    { k: 'trine', angle: 120, orb: 7.5, s: '△', n: '拱' },
    { k: 'opp', angle: 180, orb: 7, s: '☍', n: '冲' }
  ];
  const isLum = k => k === 'sun' || k === 'moon';

  function findAspects(chartA, chartB) {
    const out = [];
    const keysA = Object.keys(chartA.planets), keysB = Object.keys(chartB.planets);
    for (const ka of keysA) {
      for (const kb of keysB) {
        const pa = chartA.planets[ka], pb = chartB.planets[kb];
        const diff = (() => { let d = Math.abs(pa.lon - pb.lon); return d > 180 ? 360 - d : d; })();
        for (const a of ASPECT_DEFS) {
          const orb = a.orb + (isLum(ka) || isLum(kb) ? 2 : 0);
          if (Math.abs(diff - a.angle) <= orb) {
            out.push({ a: ka, b: kb, asp: a.k, aspName: a.n, sym: a.s, orb: Math.round(Math.abs(diff - a.angle) * 10) / 10 });
            break;
          }
        }
      }
    }
    return out;
  }

  const api = { julianDay, sunLon, moonLon, geoLon, ascLon, mcLon, calcChart, findAspects, SIGNS, SIGN_GLYPH, ELEMENTS, ELEMENT_CN, PLANET_KEYS, ASPECT_DEFS, norm, signOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XPAstro = api;
})(this);
