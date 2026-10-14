/* Analyse-Kern: Port von analyze(), make_findings(), make_pid_recommendations() aus rf_loganalyzer.py */
(function (root) {
  'use strict';
  var THRESH = { yaw_spike_hint: 4000, yaw_spike_warn: 10000, yaw_axis_ratio: 3.0, over_event_rpm: 100, over_rate_hint: 20, over_rate_warn: 45,
    over_p99_hint: 110, under_p01_warn: -120, spool_down_loss_s: 1.0, vcell_load_hint: 3.5, vcell_load_warn: 3.3, vcell_rest_low: 3.70,
    esc_temp_hint: 70, esc_temp_warn: 85, servo_limit_pct_warn: 1.0, peak_prominence: 3.0, coupling_hs_rpm: 10.0, coupling_share: 0.7,
    osc_amp_rpm: 15.0, osc_pct_hint: 8.0 };
  var ALIASES = {
    govTarget: ['govTarget', 'governorTarget', 'governor_target'], Vbat: ['Vbat', 'vbatLatest', 'vbat', 'voltage'],
    Ibat: ['Ibat', 'amperageLatest', 'amperage', 'current'], Tesc: ['Tesc', 'escTemperature', 'ESC_Temp'],
    EscRPM: ['EscRPM', 'escRPM', 'motor_rpm'], EscThr: ['EscThr', 'escThrottle'], time: ['time', 'time (us)'],
    failsafePhase: ['failsafePhase', 'failsafePhase (flags)'] };
  var NaNv = NaN;

  // ---------- Hilfsfunktionen ----------
  function Frame(cols, n) { this.cols = cols; this.n = n; this._nan = null; }
  Frame.prototype.has = function (name) { var a = ALIASES[name] || [name]; for (var i = 0; i < a.length; i++) if (this.cols[a[i]]) return true; return false; };
  Frame.prototype.get = function (name) {
    var a = ALIASES[name] || [name];
    for (var i = 0; i < a.length; i++) if (this.cols[a[i]]) return this.cols[a[i]];
    if (!this._nan) { this._nan = new Float64Array(this.n); this._nan.fill(NaN); }
    return this._nan;
  };
  Frame.prototype.slice = function (a, b) { var c = {}, self = this; for (var k in this.cols) c[k] = this.cols[k].subarray(a, b); var f = new Frame(c, b - a); return f; };
  function fin(x) { return x === x && x !== Infinity && x !== -Infinity; }
  function sortedClean(a) { var o = []; for (var i = 0; i < a.length; i++) if (a[i] === a[i]) o.push(a[i]); o.sort(function (x, y) { return x - y; }); return o; }
  function medianSorted(s) { var n = s.length; if (!n) return NaN; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
  function median(a) { return medianSorted(sortedClean(a)); }
  function pctSorted(s, q) { var n = s.length; if (!n) return NaN; var x = q / 100 * (n - 1), lo = Math.floor(x), hi = Math.ceil(x); return s[lo] + (s[hi] - s[lo]) * (x - lo); }
  function percentile(a, q) { return pctSorted(sortedClean(a), q); }
  function nanmean(a) { var s = 0, c = 0; for (var i = 0; i < a.length; i++) if (a[i] === a[i]) { s += a[i]; c++; } return c ? s / c : NaN; }
  function nanmax(a) { var m = -Infinity, c = 0; for (var i = 0; i < a.length; i++) if (a[i] === a[i]) { c++; if (a[i] > m) m = a[i]; } return c ? m : NaN; }
  function nanmin(a) { var m = Infinity, c = 0; for (var i = 0; i < a.length; i++) if (a[i] === a[i]) { c++; if (a[i] < m) m = a[i]; } return c ? m : NaN; }
  function ptp(a, s, e) { var lo = Infinity, hi = -Infinity; for (var i = s; i < e; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; } return hi - lo; }
  function meanRange(a, s, e) { var t = 0; for (var i = s; i < e; i++) t += a[i]; return t / (e - s); }
  function rollMedianAt(a, i, w) { var off = Math.floor((w - 1) / 2), end = i + 1 + off, st = end - w; if (st < 0) st = 0; if (end > a.length) end = a.length; var t = []; for (var j = st; j < end; j++) if (a[j] === a[j]) t.push(a[j]); t.sort(function (x, y) { return x - y; }); return medianSorted(t); }
  function rollMedian(a, w) { var o = new Float64Array(a.length); for (var i = 0; i < a.length; i++) o[i] = rollMedianAt(a, i, w); return o; }
  function pySlice(a, s, e) { var n = a.length; if (s < 0) s += n; if (e < 0) e += n; s = Math.max(0, s); e = Math.min(n, e); return s < e ? Array.prototype.slice.call(a, s, e) : []; }
  function trapz(y, x) { var s = 0; for (var i = 1; i < y.length; i++) s += (y[i] + y[i - 1]) / 2 * (x[i] - x[i - 1]); return s; }
  function mergedSegments(mask, t, gap) {
    var idx = []; for (var i = 0; i < mask.length; i++) if (mask[i]) idx.push(i);
    if (!idx.length) return [];
    var segs = [], st = 0;
    for (var k = 1; k < idx.length; k++) if (t[idx[k]] - t[idx[k - 1]] > gap) { segs.push([idx[st], idx[k - 1]]); st = k; }
    segs.push([idx[st], idx[idx.length - 1]]); return segs;
  }
  // Teil-DFT (reelle Eingabe) fuer Bins k0..k1; optional Hann-Fenster
  var _tw = {};
  function twiddle(N) { if (_tw[N]) return _tw[N]; var c = new Float64Array(N), s = new Float64Array(N); for (var i = 0; i < N; i++) { c[i] = Math.cos(2 * Math.PI * i / N); s[i] = Math.sin(2 * Math.PI * i / N); } return (_tw[N] = { c: c, s: s }); }
  var _hn = {};
  function hann(N) { if (_hn[N]) return _hn[N]; var w = new Float64Array(N); for (var i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); return (_hn[N] = w); }
  function dft(y, off, N, k0, k1, win) {
    var tw = twiddle(N), mean = 0, i, k; for (i = 0; i < N; i++) mean += y[off + i]; mean /= N;
    var z = new Float64Array(N), w = win ? hann(N) : null;
    for (i = 0; i < N; i++) z[i] = (y[off + i] - mean) * (w ? w[i] : 1);
    var re = new Float64Array(k1 + 1), im = new Float64Array(k1 + 1);
    for (k = k0; k <= k1; k++) { var r = 0, m = 0, idx = 0; for (i = 0; i < N; i++) { r += z[i] * tw.c[idx]; m -= z[i] * tw.s[idx]; idx += k; if (idx >= N) idx %= N; } re[k] = r; im[k] = m; }
    return { re: re, im: im };
  }
  function bandBins(N, fs, lo, hi, strict) { var a = [], half = Math.floor(N / 2); for (var k = 0; k <= half; k++) { var f = k * fs / N; if (strict ? (f > lo && f < hi) : (f >= lo && f <= hi)) a.push(k); } return a; }
  function bandEnergy(y, off, N, fs, lo, hi) {   // -> [sum|X|, f_at_max, max|X|]
    var b = bandBins(N, fs, lo, hi, true); if (!b.length) return [0, 0, 0];
    var d = dft(y, off, N, b[0], b[b.length - 1], true), s = 0, mx = -1, fm = 0;
    for (var j = 0; j < b.length; j++) { var k = b[j], a = Math.hypot(d.re[k], d.im[k]); s += a; if (a > mx) { mx = a; fm = k * fs / N; } }
    return [s, fm, mx];
  }
  function bandRms(y, off, N, fs, lo, hi) {
    var b = bandBins(N, fs, lo, hi, false); if (!b.length) return 0;
    var d = dft(y, off, N, b[0], b[b.length - 1], false), s = 0, half = N / 2;
    for (var j = 0; j < b.length; j++) { var k = b[j]; if (k === 0) continue; var p = d.re[k] * d.re[k] + d.im[k] * d.im[k]; s += (k === half) ? p : 2 * p; }
    return Math.sqrt(s / (N * N));
  }
  function fnum(x, nd, unit) { if (x === null || x === undefined || !fin(x)) return '-'; return x.toFixed(nd || 0) + (unit || ''); }
  function pidParts(s) { var p = String(s || '').split(','), o = []; for (var i = 0; i < 5; i++) { var v = parseFloat(p[i]); o.push(isNaN(v) ? NaN : v); } return o; }
  function firstNum(s) { var v = parseFloat(String(s || '').split(',')[0]); return isNaN(v) ? NaN : v; }

  // ---------- Vorbereitung ----------
  function prepare(log) {
    var cols = {}, n = log.n, k;
    var SIGNED = ['gyro', 'axisP', 'axisI', 'axisD', 'axisF', 'axisO', 'setpoint[0]', 'setpoint[1]', 'setpoint[2]', 'rcCommand[0]', 'rcCommand[1]', 'rcCommand[2]'];
    for (k in log.cols) {
      var a = log.cols[k];
      var isS = SIGNED.some(function (p) { return k.indexOf(p) === 0; });
      if (isS && nanmax(a) > Math.pow(2, 30)) { var c = new Float64Array(n); for (var i = 0; i < n; i++) c[i] = a[i] > 2147483648 ? a[i] - 4294967296 : a[i]; a = c; }
      cols[k] = a;
    }
    var f = new Frame(cols, n), tt = f.get('time'), t = new Float64Array(n), t0 = tt[0];
    for (var i2 = 0; i2 < n; i2++) t[i2] = (tt[i2] - t0) / 1e6;
    cols.t = t; f.t = t; return f;
  }
  function voltDiv(vb, hdr) {
    var v = []; for (var i = 0; i < vb.length; i++) if (vb[i] > 0) v.push(vb[i]);
    if (!v.length) return 1.0;
    var head = v.slice(0, Math.max(Math.floor(v.length / 20), 1)), start = percentile(head, 90), ref = parseFloat((hdr || {}).vbatref) / 100;
    if (fin(ref) && ref > 0) { var best = 1, bd = Infinity; [1, 10, 100, 1000].forEach(function (d) { var e = Math.abs(Math.log((start / d) / ref)); if (e < bd) { bd = e; best = d; } }); return best; }
    var med = median(v); return med > 1000 ? 1000 : (med > 60 ? 10 : 1);
  }

  // ---------- Analyse ----------
  function analyze(df, hdr, name, cellsArg) {
    var t = df.t, n = df.n, i, j, k;
    var m = { name: name, hdr: hdr, ok: false };
    var dts = []; for (i = 1; i < Math.min(n, 20001); i++) dts.push(t[i] - t[i - 1]);
    var fs = 1 / median(dts); m.fs = fs;
    var hsRaw = df.get('headspeed'), hs = new Float64Array(n); for (i = 0; i < n; i++) hs[i] = hsRaw[i] === hsRaw[i] ? hsRaw[i] : 0;
    if (nanmax(hs) < 50) { var er = df.get('EscRPM'); for (i = 0; i < n; i++) hs[i] = er[i] === er[i] ? er[i] : 0; }
    var tgtRaw = df.get('govTarget'), tgt = new Float64Array(n); for (i = 0; i < n; i++) tgt[i] = tgtRaw[i] === tgtRaw[i] ? tgtRaw[i] : 0;
    var mask = new Uint8Array(n); for (i = 0; i < n; i++) mask[i] = hs[i] > 50 ? 1 : 0;
    var segs = mergedSegments(mask, t, 2.0);
    if (!segs.length) { m.error = 'Kein Rotorlauf im Log gefunden.'; return m; }
    var best = segs[0]; segs.forEach(function (s) { if (t[s[1]] - t[s[0]] > t[best[1]] - t[best[0]]) best = s; });
    var i0 = best[0], i1 = best[1];
    if (t[i1] - t[i0] < 20) { m.error = 'Rotorlauf kuerzer als 20 s - zu kurz fuer eine sinnvolle Analyse.'; return m; }
    m.ok = true; m.t0 = t[i0]; m.t1 = t[i1];
    // Ziel-Drehzahl
    var pos = []; for (i = i0; i <= i1; i++) if (tgt[i] > 50) pos.push(tgt[i]);
    var noTgt = !pos.length, tgtMed, fixedFrac = 0;
    if (noTgt) { var hv = []; for (i = i0; i <= i1; i++) hv.push(hs[i]); hv.sort(function (a, b) { return a - b; }); var p90 = hv[Math.floor(hv.length * 0.9)]; var hh = hv.filter(function (x) { return x > 0.9 * p90; }); tgtMed = hh.length ? median(hh) : nanmax(hs); }
    else tgtMed = median(pos);
    if (pos.length) { var c2 = 0; pos.forEach(function (x) { if (Math.abs(x - tgtMed) <= 2) c2++; }); fixedFrac = c2 / pos.length; }
    m.target = tgtMed; m.target_fixed = fixedFrac > 0.6;
    // Hochlauf / Gaskappung / Auslauf
    var iUp = i0, upFound = false; for (i = i0; i <= i1; i++) if (hs[i] >= 0.95 * tgtMed) { iUp = i; upFound = true; break; }
    m.spool_up_s = upFound ? t[iUp] - t[i0] : NaN;
    var s5 = i0 + Math.floor(5 * fs), iCut = i1;
    if (noTgt) { var low = 0; for (i = Math.max(s5, iUp); i <= i1; i++) { if (hs[i] < 0.9 * tgtMed) { if (++low > fs * 0.5) { iCut = i - low + 1; break; } } else low = 0; } }
    else for (i = s5; i <= i1; i++) if (tgt[i] === 0 && hs[i] > 50) { iCut = i; break; }
    m.t_cut = t[iCut]; var downT = NaN; for (i = iCut; i < n; i++) if (hs[i] < 50) { downT = t[i] - t[iCut]; break; }
    m.spool_down_s = downT; m.hs_at_cut = hs[Math.max(iCut - 1, 0)];
    var iFl = Math.min(iUp + Math.floor(2 * fs), iCut - 1);
    var fl = df.slice(iFl, iCut); m.fl = fl; m.iFl = iFl; m.iCut = iCut;
    var flt = fl.t = fl.cols.t; fl.n = iCut - iFl;
    m.flight_s = fl.n > 10 ? flt[fl.n - 1] - flt[0] : 0;
    if (m.flight_s < 15) { m.ok = false; m.error = 'Flugphase (Drehzahl erreicht bis Gaskappung) kuerzer als 15 s.'; return m; }
    // Elektrik
    var vb = df.get('Vbat'), ib = df.get('Ibat'), vdiv = voltDiv(vb, hdr);
    var ibv = []; for (i = 0; i < n; i++) if (ib[i] === ib[i] && ib[i] !== 0) ibv.push(ib[i]);
    var ibMed = ibv.length ? median(ibv) : NaN, idiv = (fin(ibMed) && ibMed > 500) ? 100 : 1;
    m.vdiv = vdiv; m.idiv = idiv;
    var V = new Float64Array(n), I = new Float64Array(n); for (i = 0; i < n; i++) { V[i] = vb[i] / vdiv; I[i] = ib[i] / idiv; }
    var flV = V.subarray(iFl, iCut), flI = I.subarray(iFl, iCut); fl.cols.V = flV; fl.cols.I = flI;
    var s2 = [], tc = 0; for (i = 0; i < n && t[i] < 2; i++) s2.push(V[i]);
    m.v_start = nanmean(s2);
    m.cells = (cellsArg || Math.ceil(m.v_start / 4.25)); if (!(m.v_start > 3)) m.cells = 1;
    var vs = rollMedian(flV, 25); m.v_min = nanmin(vs); m.v_min_cell = m.v_min / m.cells;
    m.hasElec = fin(m.v_min) && fin(nanmax(flI));
    m.i_peak = nanmax(flI); m.i_mean = nanmean(flI);
    var Pw = new Float64Array(fl.n); for (i = 0; i < fl.n; i++) Pw[i] = flI[i] * flV[i];
    m.p_peak = nanmax(Pw); m.p_mean = nanmean(Pw);
    var sA = 0, sB = 0; for (i = 0; i < n; i++) { if (t[i] >= t[i0]) { sA = i; break; } } for (i = n - 1; i >= 0; i--) { if (t[i] <= t[i1]) { sB = i + 1; break; } }
    var segT = t.subarray(sA, sB), segI = I.subarray(sA, sB), segV = V.subarray(sA, sB);
    m.mah = trapz(segI, segT) / 3.6;
    var iv = new Float64Array(segI.length); for (i = 0; i < iv.length; i++) iv[i] = segI[i] * segV[i];
    m.wh = trapz(iv, segT) / 3600;
    var cum = new Float64Array(segI.length), acc = 0; for (i = 1; i < segI.length; i++) { acc += (segI[i] + segI[i - 1]) / 2 * (segT[i] - segT[i - 1]); cum[i] = acc / 3.6; }
    var step = Math.max(Math.floor(fs), 1), cx = [], cv = []; for (i = 0; i < cum.length; i += step) { cx.push(cum[i]); cv.push(rollMedianAt(segV, i, 1000) / m.cells); }
    m.curve = [cx, cv];
    var tailV = [], tEnd = t[n - 1]; for (i = 0; i < n; i++) if (t[i] > tEnd - 3 && I[i] < 2) tailV.push(V[i]);
    m.v_rest_cell = tailV.length > 20 ? nanmean(tailV) / m.cells : NaN;
    var te = df.get('Tesc'), ts3 = []; for (i = 0; i < n && t[i] < 3; i++) ts3.push(te[i]);
    m.t_esc_start = nanmean(ts3); m.t_esc_max = nanmax(te);
    // Governor
    var flHs = fl.get('headspeed'), flTg = fl.get('govTarget'); m.gov = {};
    if (m.target_fixed) {
      var gi = []; for (i = 0; i < fl.n; i++) if (Math.abs(tgt[iFl + i] - tgtMed) <= 2) gi.push(i);
      var e = gi.map(function (ix) { return flHs[ix] - tgtMed; });
      if (e.length > 2000) {
        var evn = 0; for (i = 1; i < e.length; i++) if ((e[i] > THRESH.over_event_rpm ? 1 : 0) - (e[i - 1] > THRESH.over_event_rpm ? 1 : 0) === 1) evn++;
        var mins = e.length / fs / 60, es = sortedClean(e), am = 0, w20 = 0; e.forEach(function (x, ix) { if (x > e[am]) am = ix; if (Math.abs(x) <= 20) w20++; });
        m.gov = { rate: evn / mins, p99: pctSorted(es, 99), p01: pctSorted(es, 1), maxover: nanmax(e), median: medianSorted(es), within20: w20 / e.length * 100, t_worst: flt[gi[am]] };
      }
    } else {
      var e2 = new Float64Array(fl.n), w2 = 0, md = 0; for (i = 0; i < fl.n; i++) { e2[i] = flHs[i] - flTg[i]; if (Math.abs(e2[i]) <= 20) w2++; if (Math.abs(e2[i]) > md) md = Math.abs(e2[i]); }
      m.gov = { variable: true, within20: w2 / fl.n * 100, maxdev: md };
    }
    // Heck
    var gy = {}; for (k = 0; k < 3; k++) if (fl.has('gyroADC[' + k + ']')) gy[k] = fl.get('gyroADC[' + k + ']');
    var rc = [0, 1, 2].map(function (q) { return fl.has('rcCommand[' + q + ']') ? fl.get('rcCommand[' + q + ']') : null; });
    var hasRc2 = !!rc[2], ysp = new Float64Array(fl.n), allst = new Float64Array(fl.n);
    for (i = 0; i < fl.n; i++) { ysp[i] = hasRc2 ? Math.abs(rc[2][i]) : 0; allst[i] = hasRc2 ? (Math.abs(rc[0][i]) + Math.abs(rc[1][i]) + Math.abs(rc[2][i])) / 3 : ysp[i]; }
    var win = Math.floor(fs), stp = Math.floor(fs / 2), yE = [], yF = [], wT = [], yPk = [], yH = [];
    for (var s0 = 0; s0 < fl.n - win; s0 += stp) {
      if (meanRange(ysp, s0, s0 + win) < 30 && gy[2]) {
        var b2 = bandEnergy(gy[2], s0, win, fs, 8, 20), br = bandEnergy(gy[0], s0, win, fs, 8, 20), bp = bandEnergy(gy[1], s0, win, fs, 8, 20);
        yE.push(b2[0]); yF.push(b2[1]); wT.push(flt[s0]); yPk.push(b2[2] / Math.max(br[2], bp[2], 1.0));
        var fixedW = m.target_fixed && ptp(flTg, s0, s0 + win) <= 5;
        yH.push(fixedW ? bandRms(flHs, s0, win, fs, 5, 20) : NaN);
      }
    }
    m.yaw = { t: wT, E: yE, F: yF, ratio_arr: yPk, H: yH };
    var evIdx = []; for (i = 0; i < yE.length; i++) if (yE[i] >= THRESH.yaw_spike_hint && yH[i] === yH[i]) evIdx.push(i);
    if (evIdx.length >= 1) {
      var hv = evIdx.map(function (ix) { return yH[ix]; }), cnt = hv.filter(function (x) { return x >= THRESH.coupling_hs_rpm; }).length;
      m.yaw.coupling = { n: evIdx.length, share: cnt / evIdx.length, med_hs: median(hv), med_all: median(yH.filter(function (x) { return x === x; })) };
    } else m.yaw.coupling = null;
    if (yE.length) {
      var kk = 0; yE.forEach(function (x, ix) { if (x > yE[kk]) kk = ix; });
      var yes = sortedClean(yE);
      Object.assign(m.yaw, { median: medianSorted(yes), p95: pctSorted(yes, 95), max: yE[kk], f_max: yF[kk], ratio: yPk[kk], t_max: wT[kk], n: yE.length });
    }
    // Hover-Spektrum
    var w2s = Math.floor(2 * fs), wobble = [], hov = [];
    for (s0 = 0; s0 < fl.n - w2s; s0 += Math.floor(w2s / 2)) {
      if (meanRange(allst, s0, s0 + w2s) < 25 && gy[0]) {
        wobble.push((bandRms(gy[0], s0, w2s, fs, 2, 8) + bandRms(gy[1], s0, w2s, fs, 2, 8)) / 2);
        var kmax = Math.ceil(61 * w2s / fs), accs = [];
        for (k = 0; k < 3; k++) { var d = dft(gy[k], s0, w2s, 0, kmax, true), amp = new Float64Array(kmax + 1); for (j = 0; j <= kmax; j++) amp[j] = Math.hypot(d.re[j], d.im[j]) / w2s; accs.push(amp); }
        hov.push(accs);
      }
    }
    m.wobble = wobble.length >= 3 ? median(wobble) : NaN; m.wobble_n = wobble.length; m.hover_peaks = []; m.hover_n = hov.length;
    if (hov.length >= 3) {
      var df2 = fs / w2s, labs = ['Roll', 'Nick', 'Gier']; m.hover_spec = { df: df2, axes: [] };
      for (k = 0; k < 3; k++) {
        var sp = new Float64Array(hov[0][k].length); for (var h = 0; h < hov.length; h++) for (j = 0; j < sp.length; j++) sp[j] += hov[h][k][j] / hov.length;
        m.hover_spec.axes.push(sp);
        for (j = Math.floor(3 / df2); j < Math.floor(40 / df2); j++) {
          var loc = pySlice(sp, j - 8, j - 2).concat(pySlice(sp, j + 3, j + 9)), mx = Math.max.apply(null, pySlice(sp, j - 2, j + 3));
          if (sp[j] === mx && sp[j] / Math.max(median(loc), 1e-9) >= THRESH.peak_prominence) m.hover_peaks.push([labs[k], j * df2, sp[j] / Math.max(median(loc), 1e-9)]);
        }
      }
      m.hover_peaks.sort(function (a, b) { return b[2] - a[2]; });
    }
    // Drehzahl-Pendeln
    var osc = { n: 0, n_big: 0, f: [], worst: null };
    if (m.target_fixed) {
      var w3 = Math.floor(2 * fs), st3 = Math.floor(fs), wmax = 0;
      for (s0 = 0; s0 < fl.n - w3; s0 += st3) {
        if (ptp(flTg, s0, s0 + w3) > 5) continue;
        var amp2 = bandRms(flHs, s0, w3, fs, 2, 10); osc.n++;
        if (amp2 > THRESH.osc_amp_rpm) { osc.n_big++; osc.f.push(bandEnergy(flHs, s0, w3, fs, 2, 10)[1]); }
        if (amp2 > wmax) { wmax = amp2; osc.worst = flt[s0] + 1.0; }
      }
      osc.amp_max = wmax;
    }
    m.osc = osc;
    // Regelverhalten
    var trk = {}; ['Roll', 'Nick', 'Gier'].forEach(function (lab, kx) {
      if (fl.has('setpoint[' + kx + ']') && gy[kx]) {
        var sp2 = fl.get('setpoint[' + kx + ']'), er2 = []; for (var q = 0; q < fl.n; q++) if (Math.abs(sp2[q]) > 150) er2.push(Math.abs(sp2[q] - gy[kx][q]));
        if (er2.length > 200) trk[lab] = [median(er2), percentile(er2, 95), er2.length];
      }
    });
    m.track = trk;
    // Servos
    var sv = {}; for (k = 0; k < 4; k++) if (fl.has('servo[' + k + ']')) {
      var x = fl.get('servo[' + k + ']'), okAll = true; for (i = 0; i < x.length; i++) if (x[i] !== x[i]) { okAll = false; break; }
      if (!okAll) continue; var lo = nanmin(x), hi = nanmax(x), cl = 0, ch = 0; for (i = 0; i < x.length; i++) { if (x[i] <= lo + 1) cl++; if (x[i] >= hi - 1) ch++; }
      sv[k] = { lo: lo, hi: hi, pct_lo: cl / x.length * 100, pct_hi: ch / x.length * 100 };
    }
    m.servo = sv;
    // Antrieb / Reserve
    m.mot = null;
    var thr = fl.get('EscThr'), thrMax = 0; for (i = 0; i < thr.length; i++) if (thr[i] === thr[i] && Math.abs(thr[i]) > thrMax) thrMax = Math.abs(thr[i]);
    var src = thrMax > 0 ? 'EscThr' : 'motor[0]', mo = fl.get(src), mmax = nanmax(mo);
    if (fin(mmax) && mmax > 0) {
      var sc = mmax > 100 ? 10 : 1, ms = [], moArr = new Float64Array(fl.n);
      for (i = 0; i < fl.n; i++) { moArr[i] = mo[i] / sc; var stab = m.target_fixed ? Math.abs(flTg[i] - tgtMed) <= 2 : true; if (stab && moArr[i] > 0) ms.push(moArr[i]); }
      if (ms.length > 200) { var mean = nanmean(ms), pk = nanmax(moArr), pi2 = 0; for (i = 0; i < fl.n; i++) if (moArr[i] > moArr[pi2]) pi2 = i;
        var nearc = ms.filter(function (x) { return x >= 95; }).length; m.mot = { src: src, mean: mean, reserve: 100 - mean, peak: pk, near: nearc / ms.length * 100, t_peak: flt[pi2], arr: moArr }; }
    }
    // Signal
    m.rx_loss = 0; if (fl.has('rxSignalReceived')) { var rr = fl.get('rxSignalReceived'); for (i = 0; i < rr.length; i++) if (rr[i] === 0) m.rx_loss++; }
    m.failsafe_active = false; if (fl.has('failsafePhase')) { var fp = fl.get('failsafePhase'); for (i = 0; i < fp.length; i++) if (fp[i] !== 0) { m.failsafe_active = true; break; } }
    m.v_zero = 0; for (i = 0; i < flV.length; i++) if (flV[i] <= 0.1) m.v_zero++;
    m.escthr_dead = fl.has('EscThr') ? thrMax === 0 : null;
    m.stick_activity = nanmean(allst);
    return m;
  }

  var api = { analyze: analyze, prepare: prepare, THRESH: THRESH, Frame: Frame, fnum: fnum, pidParts: pidParts, firstNum: firstNum, util: { median: median, percentile: percentile, nanmean: nanmean, nanmax: nanmax, nanmin: nanmin, rollMedian: rollMedian, dft: dft, hann: hann, fin: fin, pySlice: pySlice, voltDiv: voltDiv } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RFA = api;
})(typeof self !== 'undefined' ? self : this);
