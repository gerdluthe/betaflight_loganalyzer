/* Bereitet die Zeitreihen/Spektren fuer die Diagramme vor (laeuft im Worker). */
(function (root) {
  'use strict';
  var A = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./analysis.js') : root.RFA, U = A.util;
  function pct(a, q) { return U.percentile(a, q); }

  function plotData(df, m) {
    var n = df.n, fl = m.fl, fs = m.fs, i, k, P = { t: df.t, vdiv: m.vdiv, idiv: m.idiv };
    P.thr = df.cols.thr; P.mavg = df.cols.mavg;
    var vb = df.get('Vbat'), ib = df.get('Ibat'); P.V = new Float64Array(n); P.I = new Float64Array(n);
    for (i = 0; i < n; i++) { P.V[i] = m.hasVolt ? vb[i] / m.vdiv : NaN; P.I[i] = m.hasCurr ? ib[i] / m.idiv : NaN; }
    // Stick-Aktivitaet: gleitender Mittelwert (0,25 s) je Achse, dann Mittel ueber die Achsen
    P.stick = new Float64Array(n); var axes = 0, wl = Math.max(1, Math.round(fs / 4));
    for (k = 0; k < 3; k++) if (df.has('rcCommand[' + k + ']')) {
      axes++; var a = df.get('rcCommand[' + k + ']'), cs = new Float64Array(n + 1);
      for (i = 0; i < n; i++) cs[i + 1] = cs[i] + Math.abs(a[i]);
      for (i = 0; i < n; i++) { var s0 = Math.max(0, i - wl + 1); P.stick[i] += (cs[i + 1] - cs[s0]) / (i + 1 - s0); }
    }
    if (axes) for (i = 0; i < n; i++) P.stick[i] /= axes;
    // Flugphase
    var F = { t: fl.t, thr: fl.cols.thr, mavg: fl.cols.mavg, V: fl.cols.V, I: fl.cols.I };
    F.gy = [0, 1, 2].map(function (q) { return fl.has('gyroADC[' + q + ']') ? fl.get('gyroADC[' + q + ']') : null; });
    F.sp = [0, 1, 2].map(function (q) { return fl.has('setpoint[' + q + ']') ? fl.get('setpoint[' + q + ']') : null; });
    F.mot = []; for (k = 0; k < (m.nMot || 0); k++) F.mot.push(fl.cols['mot' + k]);
    F.motHz = fl.cols.motHz || null;
    P.fl = F;
    // Propwash: staerkstes Ereignis im Detail
    var W = m.pw;
    if (W && W.worst) {
      var tw = W.worst.t, a0 = 0, a1 = fl.n; for (i = 0; i < fl.n; i++) { if (F.t[i] > tw - 1.0) { a0 = i; break; } } for (i = a0; i < fl.n; i++) { if (F.t[i] >= tw + 1.5) { a1 = i; break; } }
      P.pwin = { t: F.t.subarray(a0, a1), thr: F.thr.subarray(a0, a1), gy: F.gy.map(function (g) { return g ? g.subarray(a0, a1) : null; }), sp: F.sp.map(function (s) { return s ? s.subarray(a0, a1) : null; }) };
    }
    // Schwingungs-Karte: Zeit x Frequenz je Achse (gefiltertes Gyro)
    if (F.gy[0] && F.gy[1] && F.gy[2]) {
      var N = Math.max(64, U.pow2near(fs / 4)), hop = Math.max(Math.floor(N / 2), Math.floor((fl.n - N) / 700)), nw = Math.floor((fl.n - N) / hop) + 1;
      if (nw >= 8) {
        var fmax = Math.min(fs / 2, 600), kmax = Math.floor(fmax * N / fs), kmin = Math.max(1, Math.ceil(2 * N / fs)), ny = kmax - kmin + 1;
        var re = new Float64Array(N), im = new Float64Array(N), sp = new Float64Array(N / 2 + 1), logs = [new Float32Array(nw * ny), new Float32Array(nw * ny), new Float32Array(nw * ny)];
        for (k = 0; k < 3; k++) for (var w = 0; w < nw; w++) { U.ampSpec(F.gy[k], w * hop, N, sp, re, im); for (var j = 0; j < ny; j++) logs[k][w * ny + j] = Math.log10(sp[kmin + j] + 0.01); }
        var all = []; for (k = 0; k < 3; k++) for (i = 0; i < logs[k].length; i += 3) all.push(logs[k][i]);
        var thrw = new Float64Array(nw); for (w = 0; w < nw; w++) thrw[w] = F.thr[w * hop + (N >> 1)];
        var t0 = F.t[0] + 0.5 * N / fs;
        P.spectro = { nx: nw, ny: ny, logs: logs, vmin: pct(all, 5), vmax: pct(all, 99.7), t0: t0, t1: t0 + (nw - 1) * hop / fs, f0: kmin * fs / N, f1: kmax * fs / N, thrT: Float64Array.from({ length: nw }, function (_, q) { return t0 + q * hop / fs; }), thr: thrw };
      }
    }
    return P;
  }
  var api = { plotData: plotData };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RFP = api;
})(typeof self !== 'undefined' ? self : this);
