/* Bereitet die Zeitreihen/Spektren fuer die Diagramme vor (laeuft im Worker). */
(function (root) {
  'use strict';
  var A = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./analysis.js') : root.RFA, U = A.util;
  function pct(a, q) { return U.percentile(a, q); }
  function copy(a) { return Float64Array.from(a); }

  function plotData(df, m) {
    var n = df.n, fl = m.fl, fs = m.fs, i, k, P = { t: df.t, vdiv: m.vdiv, idiv: m.idiv };
    P.hs = df.get('headspeed'); P.tgt = df.get('govTarget'); P.Tesc = df.get('Tesc');
    var vb = df.get('Vbat'), ib = df.get('Ibat'); P.V = new Float64Array(n); P.I = new Float64Array(n);
    for (i = 0; i < n; i++) { P.V[i] = vb[i] / m.vdiv; P.I[i] = ib[i] / m.idiv; }
    // Stick-Aktivitaet: trailing mean (250) je Achse, dann Mittel ueber die Achsen
    P.stick = new Float64Array(n); var axes = 0;
    for (k = 0; k < 3; k++) if (df.has('rcCommand[' + k + ']')) {
      axes++; var a = df.get('rcCommand[' + k + ']'), cs = new Float64Array(n + 1);
      for (i = 0; i < n; i++) cs[i + 1] = cs[i] + Math.abs(a[i]);
      for (i = 0; i < n; i++) { var s0 = Math.max(0, i - 249); P.stick[i] += (cs[i + 1] - cs[s0]) / (i + 1 - s0); }
    }
    if (axes) for (i = 0; i < n; i++) P.stick[i] /= axes;
    // Flugphase
    var F = {}; F.t = fl.t; F.hs = fl.get('headspeed'); F.tg = fl.get('govTarget'); F.rc3 = fl.has('rcCommand[3]') ? fl.get('rcCommand[3]') : null;
    F.V = fl.cols.V; F.I = fl.cols.I; F.Tesc = fl.get('Tesc'); F.gy = [0, 1, 2].map(function (q) { return fl.has('gyroADC[' + q + ']') ? fl.get('gyroADC[' + q + ']') : null; });
    F.servo = [0, 1, 2, 3].map(function (q) { return fl.has('servo[' + q + ']') ? fl.get('servo[' + q + ']') : null; });
    F.mot = m.mot ? m.mot.arr : null; P.fl = F;
    // Governor-Fenster um den groessten Ueberschwinger + Histogramm + Last-Aufschluesselung
    var g = m.gov, t = df.t;
    if (g.t_worst !== undefined) {
      var a0 = 0, a1 = n; for (i = 0; i < n; i++) { if (t[i] > g.t_worst - 3) { a0 = i; break; } } for (i = a0; i < n; i++) { if (t[i] >= g.t_worst + 3) { a1 = i; break; } }
      P.gwin = { t: t.subarray(a0, a1), hs: P.hs.subarray(a0, a1), tg: P.tgt.subarray(a0, a1), rc3: df.has('rcCommand[3]') ? df.get('rcCommand[3]').subarray(a0, a1) : null };
    }
    var ev = [], rcv = [];
    for (i = 0; i < fl.n; i++) if (m.target_fixed ? Math.abs(F.tg[i] - m.target) <= 2 : true) { ev.push(m.target_fixed ? F.hs[i] - m.target : F.hs[i] - F.tg[i]); if (F.rc3) rcv.push(F.rc3[i]); }
    P.gerr = Float64Array.from(ev);
    if (m.target_fixed && F.rc3 && ev.length >= 3000) {
      var bins = []; for (i = 0; i < 10; i++) bins.push([]);
      for (i = 0; i < ev.length; i++) { var r = rcv[i]; if (!(r >= -500 && r <= 500)) continue; var bi = Math.min(9, Math.max(0, Math.ceil((r + 500) / 100) - 1)); bins[bi].push(ev[i]); }
      P.load = bins.map(function (b, ix) { var s = b.slice().sort(function (x, y) { return x - y; }); return { c: -500 + ix * 100 + 50, n: b.length, q05: s.length ? pctS(s, 5) : NaN, q50: s.length ? pctS(s, 50) : NaN, q95: s.length ? pctS(s, 95) : NaN, mx: s.length ? s[s.length - 1] : NaN, mn: s.length ? s[0] : NaN }; });
    }
    function pctS(s, q) { var x = q / 100 * (s.length - 1), lo = Math.floor(x), hi = Math.ceil(x); return s[lo] + (s[hi] - s[lo]) * (x - lo); }
    // Heck-Spektrum im staerksten Fenster
    if (m.yaw.max !== undefined) {
      var tt = m.yaw.t_max, s1 = 0, s2 = fl.n; for (i = 0; i < fl.n; i++) { if (F.t[i] >= tt) { s1 = i; break; } } for (i = s1; i < fl.n; i++) { if (F.t[i] >= tt + 1.0) { s2 = i; break; } }
      var N = s2 - s1, kmax = Math.floor(40 * N / fs), ys = { f: [], sp: [[], [], []] };
      for (k = 0; k < 3; k++) if (F.gy[k]) { var d = U.dft(F.gy[k], s1, N, 0, kmax, true); for (var j = 0; j <= kmax; j++) { var fr = j * fs / N; if (fr > 2 && fr < 40) { if (k === 0) ys.f.push(fr); ys.sp[k].push(Math.hypot(d.re[j], d.im[j])); } } }
      P.yspec = ys;
    }
    // Schwingungs-Karte
    if (fl.n >= Math.floor(fs) * 4 && F.gy[0] && F.gy[1] && F.gy[2]) {
      var win = Math.floor(fs), hop = Math.max(Math.floor(fs / 4), 1), nw = Math.floor((fl.n - win) / hop) + 1, kl = [], kh = 0, f0 = 0;
      for (j = 0; j <= Math.floor(win / 2); j++) { var f = j * fs / win; if (f >= 2 && f <= 40) { if (!kl.length) f0 = f; kl.push(j); kh = f; } }
      var ny = kl.length, logs = [new Float32Array(nw * ny), new Float32Array(nw * ny), new Float32Array(nw * ny)];
      for (k = 0; k < 3; k++) for (var w = 0; w < nw; w++) { var dd = U.dft(F.gy[k], w * hop, win, kl[0], kl[ny - 1], true); for (j = 0; j < ny; j++) logs[k][w * ny + j] = Math.log10(Math.hypot(dd.re[kl[j]], dd.im[kl[j]]) + 1.0); }
      var all = []; for (k = 0; k < 3; k++) for (i = 0; i < logs[k].length; i++) all.push(logs[k][i]);
      var only = new Float32Array(nw * ny); for (i = 0; i < only.length; i++) only[i] = logs[2][i] - Math.max(logs[0][i], logs[1][i]);
      var t0 = F.t[0] + 0.5 * win / fs;
      P.spectro = { nx: nw, ny: ny, logs: logs, only: only, vmin: pct(all, 8), vmax: pct(all, 99.8), dmax: Math.max(pct(Array.from(only), 99.7), 0.3), t0: t0, t1: t0 + (nw - 1) * hop / fs, f0: f0, f1: kh };
    }
    return P;
  }
  var api = { plotData: plotData };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RFP = api;
})(typeof self !== 'undefined' ? self : this);
