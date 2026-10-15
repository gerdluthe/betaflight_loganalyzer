/* Analyse-Kern fuer Betaflight-Logs (Multicopter): Flugphase, Gas/Motoren, Akku, Regelabweichung, Ruhephasen-Spektrum, Signal.
   Liefert das Ergebnis-Objekt m, auf dem findings/vibration/stepresp/propwash aufbauen. */
(function (root) {
  'use strict';
  var THRESH = {
    fly_motor_pct: 8,            // Mittel der Motoren ueber Leerlauf [%], ab dem "in der Luft" angenommen wird
    min_flight_s: 10,            // ab hier volle Analyse; darunter eingeschraenkt
    min_flight_short_s: 1,       // kuerzeste Flugphase ueberhaupt
    vcell_load_hint: 3.5, vcell_load_warn: 3.3, vcell_rest_low: 3.70,
    sat_pct_hint: 1.0, sat_pct_warn: 5.0,             // Anteil der Flugzeit mit einem Motor am oberen Anschlag
    idle_pct_hint: 2.0,                               // Anteil mit einem Motor am Leerlauf trotz Gas
    imbalance_hint: 8, imbalance_warn: 15,            // Motor-Ungleichgewicht im ruhigen Flug [Prozentpunkte]
    track_med_hint: 40, track_p95_hint: 150, track_sp_min: 100,
    peak_prominence: 3.0, wobble_hint: 6.0,
    rssi_low_pct: 30
  };
  var ALIASES = {
    Vbat: ['vbatLatest', 'vbat', 'Vbat'], Ibat: ['amperageLatest', 'amperage', 'Ibat'], time: ['time', 'time (us)'],
    failsafePhase: ['failsafePhase', 'failsafePhase (flags)'], rssi: ['rssi'], thr: ['rcCommand[3]'] };

  // ---------- Hilfsfunktionen ----------
  function Frame(cols, n) { this.cols = cols; this.n = n; this._nan = null; }
  Frame.prototype.has = function (name) { var a = ALIASES[name] || [name]; for (var i = 0; i < a.length; i++) if (this.cols[a[i]]) return true; return false; };
  Frame.prototype.get = function (name) {
    var a = ALIASES[name] || [name];
    for (var i = 0; i < a.length; i++) if (this.cols[a[i]]) return this.cols[a[i]];
    if (!this._nan) { this._nan = new Float64Array(this.n); this._nan.fill(NaN); }
    return this._nan;
  };
  Frame.prototype.slice = function (a, b) { var c = {}; for (var k in this.cols) c[k] = this.cols[k].subarray(a, b); return new Frame(c, b - a); };
  function fin(x) { return typeof x === 'number' && x === x && x !== Infinity && x !== -Infinity; }
  function sortedClean(a) { var o = []; for (var i = 0; i < a.length; i++) if (a[i] === a[i]) o.push(a[i]); o.sort(function (x, y) { return x - y; }); return o; }
  function medianSorted(s) { var n = s.length; if (!n) return NaN; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
  function median(a) { return medianSorted(sortedClean(a)); }
  function pctSorted(s, q) { var n = s.length; if (!n) return NaN; var x = q / 100 * (n - 1), lo = Math.floor(x), hi = Math.ceil(x); return s[lo] + (s[hi] - s[lo]) * (x - lo); }
  function percentile(a, q) { return pctSorted(sortedClean(a), q); }
  function nanmean(a) { var s = 0, c = 0; for (var i = 0; i < a.length; i++) if (a[i] === a[i]) { s += a[i]; c++; } return c ? s / c : NaN; }
  function nanmax(a) { var m = -Infinity, c = 0; for (var i = 0; i < a.length; i++) if (a[i] === a[i]) { c++; if (a[i] > m) m = a[i]; } return c ? m : NaN; }
  function nanmin(a) { var m = Infinity, c = 0; for (var i = 0; i < a.length; i++) if (a[i] === a[i]) { c++; if (a[i] < m) m = a[i]; } return c ? m : NaN; }
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
  // ---- FFT (Radix-2, in place) ----
  var _fft = {};
  function fftTab(N) {
    if (_fft[N]) return _fft[N];
    var c = new Float64Array(N / 2), s = new Float64Array(N / 2), rev = new Uint32Array(N), bits = Math.round(Math.log2(N)), i;
    for (i = 0; i < N / 2; i++) { c[i] = Math.cos(2 * Math.PI * i / N); s[i] = -Math.sin(2 * Math.PI * i / N); }
    for (i = 0; i < N; i++) { var r = 0, x = i; for (var b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
    return (_fft[N] = { c: c, s: s, rev: rev });
  }
  function fft(re, im, inverse) {
    var N = re.length, T = fftTab(N), i, j, k, len, half, step, t, sg = inverse ? -1 : 1;
    for (i = 0; i < N; i++) { j = T.rev[i]; if (j > i) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (len = 2; len <= N; len <<= 1) {
      half = len >> 1; step = N / len;
      for (i = 0; i < N; i += len) for (k = 0; k < half; k++) {
        var wr = T.c[k * step], wi = sg * T.s[k * step], a = i + k, b = a + half;
        var xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
    if (inverse) for (i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
  }
  var _hn = {};
  function hann(N) { if (_hn[N]) return _hn[N]; var w = new Float64Array(N); for (var i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); return (_hn[N] = w); }
  // Amplitudenspektrum (Hann, Mittelwert entfernt) eines Fensters, Bins 0..N/2, Ergebnis in deg/s-Amplitude
  function ampSpec(y, off, N, out, re, im) {
    var w = hann(N), i, mean = 0; for (i = 0; i < N; i++) mean += y[off + i]; mean /= N;
    for (i = 0; i < N; i++) { re[i] = (y[off + i] - mean) * w[i]; im[i] = 0; }
    fft(re, im);
    for (var k = 0; k <= N / 2; k++) out[k] = Math.hypot(re[k], im[k]) * 4 / N;   // Hann: Kohaerenzgewinn 0.5, einseitig x2
  }
  function pow2near(x) { return Math.pow(2, Math.round(Math.log2(Math.max(x, 2)))); }
  function fnum(x, nd, unit) { if (x === null || x === undefined || !fin(x)) return '-'; return x.toFixed(nd || 0) + (unit || ''); }
  function nums(s) { return String(s === undefined || s === null ? '' : s).split(',').map(function (x) { var v = parseFloat(x); return isNaN(v) ? NaN : v; }); }
  function firstNum(s) { return nums(s)[0]; }

  // ---------- Betaflight-Header: Firmware und Parameter je Version ----------
  function firmware(hdr) {
    var rev = String(hdr['Firmware revision'] || ''), m = /^(\S+)\s+(\d+)\.(\d+)\.(\d+)/.exec(rev);
    var name = m ? m[1] : (rev.split(' ')[0] || String(hdr['Firmware type'] || '')), ver = m ? [+m[2], +m[3], +m[4]] : [0, 0, 0];
    return { name: name, ver: ver, str: m ? m[1] + ' ' + m[2] + '.' + m[3] + '.' + m[4] : rev, isBF: /betaflight/i.test(name) };
  }
  function fwGe(fw, a, b) { var v = fw.ver; return v[0] > a || (v[0] === a && v[1] >= b); }
  // Logischer Parameter -> [Header-Schluessel, CLI-Name(n)] je Firmware-Generation (neu zuerst)
  var PMAP = {
    gyro_lpf1_hz: [['gyro_lpf1_static_hz', 'gyro_lpf1_static_hz'], ['gyro_lowpass_hz', 'gyro_lowpass_hz']],
    gyro_lpf1_dyn: [['gyro_lpf1_dyn_hz', ['gyro_lpf1_dyn_min_hz', 'gyro_lpf1_dyn_max_hz']], ['gyro_lowpass_dyn_hz', ['dyn_lpf_gyro_min_hz', 'dyn_lpf_gyro_max_hz']]],
    gyro_lpf2_hz: [['gyro_lpf2_static_hz', 'gyro_lpf2_static_hz'], ['gyro_lowpass2_hz', 'gyro_lowpass2_hz']],
    gyro_notch: [['gyro_notch_hz', ['gyro_notch1_hz', 'gyro_notch2_hz']]],
    dterm_lpf1_hz: [['dterm_lpf1_static_hz', 'dterm_lpf1_static_hz'], ['dterm_lowpass_hz', 'dterm_lowpass_hz']],
    dterm_lpf1_dyn: [['dterm_lpf1_dyn_hz', ['dterm_lpf1_dyn_min_hz', 'dterm_lpf1_dyn_max_hz']], ['dterm_lowpass_dyn_hz', ['dyn_lpf_dterm_min_hz', 'dyn_lpf_dterm_max_hz']]],
    dterm_lpf2_hz: [['dterm_lpf2_static_hz', 'dterm_lpf2_static_hz'], ['dterm_lowpass2_hz', 'dterm_lowpass2_hz']],
    dyn_notch_count: [['dyn_notch_count', 'dyn_notch_count']],
    dyn_notch_q: [['dyn_notch_q', 'dyn_notch_q']],
    dyn_notch_min: [['dyn_notch_min_hz', 'dyn_notch_min_hz']],
    dyn_notch_max: [['dyn_notch_max_hz', 'dyn_notch_max_hz']],
    dyn_notch_width: [['dyn_notch_width_percent', 'dyn_notch_width_percent']],
    rpm_harm: [['rpm_filter_harmonics', 'rpm_filter_harmonics'], ['gyro_rpm_notch_harmonics', 'gyro_rpm_notch_harmonics']],
    rpm_q: [['rpm_filter_q', 'rpm_filter_q'], ['gyro_rpm_notch_q', 'gyro_rpm_notch_q']],
    rpm_min: [['rpm_filter_min_hz', 'rpm_filter_min_hz'], ['gyro_rpm_notch_min', 'gyro_rpm_notch_min']],
    ff: [['ff_weight', ['f_roll', 'f_pitch', 'f_yaw']], ['feedforward_weight', ['f_roll', 'f_pitch', 'f_yaw']]],
    dmin: [['d_min', ['d_min_roll', 'd_min_pitch', 'd_min_yaw']], ['d_max', ['d_max_roll', 'd_max_pitch', 'd_max_yaw']]],
    dyn_idle: [['dyn_idle_min_rpm', 'dyn_idle_min_rpm']],
    motor_poles: [['motor_poles', 'motor_poles']]
  };
  function param(hdr, key) {
    var L = PMAP[key] || [[key, key]];
    for (var i = 0; i < L.length; i++) if (L[i][0] in hdr) return { key: L[i][0], cli: L[i][1], v: nums(hdr[L[i][0]]), raw: hdr[L[i][0]] };
    return { key: null, cli: L[0][1], v: [NaN], raw: undefined };
  }
  // Simplified Tuning (ab BF 4.3): aktive Schieber ueberschreiben Einzelwerte beim Speichern
  function simplified(hdr) {
    var g = function (k) { return firstNum(hdr[k]); };
    return { pids: g('simplified_pids_mode') > 0 ? g('simplified_pids_mode') : 0, gyro: g('simplified_gyro_filter') > 0, dterm: g('simplified_dterm_filter') > 0,
      d: g('simplified_d_gain'), pi: g('simplified_pi_gain'), i: g('simplified_i_gain'), ff: g('simplified_feedforward_gain'), pd: g('simplified_pitch_d_gain'), ppi: g('simplified_pitch_pi_gain'),
      gm: g('simplified_gyro_filter_multiplier'), dm: g('simplified_dterm_filter_multiplier') };
  }
  function filterSettings(hdr) {
    var S = {}, p;
    p = param(hdr, 'gyro_lpf1_hz'); S.lpf1 = p.v[0]; S.lpf1_cli = p.cli;
    p = param(hdr, 'gyro_lpf1_dyn'); S.lpf1_dmin = p.v[0]; S.lpf1_dmax = p.v[1]; S.lpf1_dyn_cli = p.cli;
    S.lpf1_dyn = S.lpf1_dmin > 0 && S.lpf1_dmax > 0;
    S.lpf1_eff = S.lpf1_dyn ? S.lpf1_dmin : S.lpf1;        // niedrigster wirksamer Wert (Leerlauf/Schwebe)
    p = param(hdr, 'gyro_lpf2_hz'); S.lpf2 = p.v[0]; S.lpf2_cli = p.cli;
    p = param(hdr, 'gyro_notch'); S.notch = p.v.filter(function (x) { return x > 0; });
    p = param(hdr, 'dterm_lpf1_hz'); S.dlpf1 = p.v[0]; S.dlpf1_cli = p.cli;
    p = param(hdr, 'dterm_lpf1_dyn'); S.dlpf1_dmin = p.v[0]; S.dlpf1_dmax = p.v[1]; S.dlpf1_dyn_cli = p.cli; S.dlpf1_dyn = S.dlpf1_dmin > 0 && S.dlpf1_dmax > 0;
    S.dlpf1_eff = S.dlpf1_dyn ? S.dlpf1_dmin : S.dlpf1;
    p = param(hdr, 'dterm_lpf2_hz'); S.dlpf2 = p.v[0]; S.dlpf2_cli = p.cli;
    p = param(hdr, 'dyn_notch_min'); S.dn_min = p.v[0]; p = param(hdr, 'dyn_notch_max'); S.dn_max = p.v[0];
    p = param(hdr, 'dyn_notch_q'); S.dn_q = p.v[0];
    p = param(hdr, 'dyn_notch_count');
    if (p.key) { S.dn_count = p.v[0]; S.dn_count_cli = true; }
    else if (fin(S.dn_min)) {          // bis BF 4.2: Feature DYNAMIC_FILTER (Bit 29), Breite > 0 = zwei Notches
      var feat = parseInt(hdr.features, 10), on = !fin(feat) || ((feat >>> 29) & 1) === 1, wid = firstNum(hdr.dyn_notch_width_percent);
      S.dn_count = on ? (wid > 0 ? 2 : 1) : 0; S.dn_count_cli = false;
    } else S.dn_count = NaN;
    p = param(hdr, 'rpm_harm'); S.rpm_harm = p.v[0]; S.rpm_harm_cli = p.cli;
    p = param(hdr, 'rpm_q'); S.rpm_q = p.v[0]; S.rpm_q_cli = p.cli;
    p = param(hdr, 'rpm_min'); S.rpm_min = p.v[0]; S.rpm_min_cli = p.cli;
    S.bidir = firstNum(hdr.dshot_bidir) > 0;
    S.rpm_on = S.bidir && S.rpm_harm > 0;
    S.poles = firstNum(hdr.motor_poles); if (!(S.poles > 0)) S.poles = 14;
    return S;
  }

  // ---------- Vorbereitung ----------
  function prepare(log) {
    var cols = {}, n = log.n, k;
    var SIGNED = ['gyro', 'axisP', 'axisI', 'axisD', 'axisF', 'axisS', 'setpoint[0]', 'setpoint[1]', 'setpoint[2]', 'rcCommand[0]', 'rcCommand[1]', 'rcCommand[2]', 'debug', 'accSmooth'];
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
    if (!v.length) return 100;
    var cv = nums((hdr || {}).vbatcellvoltage), refDiv = (fin(cv[2]) && cv[2] < 100) ? 10 : 100;   // BF < 3.2: vbatref in 0,1 V
    var head = v.slice(0, Math.max(Math.floor(v.length / 20), 1)), start = percentile(head, 90), ref = parseFloat((hdr || {}).vbatref) / refDiv;
    if (fin(ref) && ref > 0) { var best = 100, bd = Infinity; [1, 10, 100, 1000].forEach(function (d) { var e = Math.abs(Math.log((start / d) / ref)); if (e < bd) { bd = e; best = d; } }); return best; }
    var med = median(v); return med > 1000 ? 100 : (med > 60 ? 10 : 1);
  }
  // Motoren: Ausgang in % zwischen Leerlauf (motorOutput low) und Maximum
  function motorInfo(df, hdr) {
    var mo = String(hdr.motorOutput || '').split(','), lo = parseFloat(mo[0]), hi = parseFloat(mo[1]), names = [];
    for (var k = 0; k < 8; k++) if (df.has('motor[' + k + ']')) names.push('motor[' + k + ']');
    if (!(hi > lo)) { lo = parseFloat(hdr.minthrottle) || 1000; hi = parseFloat(hdr.maxthrottle) || 2000; }
    return { names: names, lo: lo, hi: hi };
  }
  // Ungefiltertes Gyro: gyroUnfilt (ab BF 4.3) oder debug[0..2] bei debug_mode GYRO_SCALED (Plausibilitaet gegen gyroADC)
  function rawGyro(df, hdr) {
    if (df.has('gyroUnfilt[0]') && df.has('gyroUnfilt[2]')) return { src: 'gyroUnfilt', a: [0, 1, 2].map(function (k) { return df.get('gyroUnfilt[' + k + ']'); }) };
    var dm = parseInt(hdr.debug_mode, 10), fw = firmware(hdr);
    if (dm !== 6 || !df.has('debug[2]') || !df.has('gyroADC[0]')) return null;
    var a = [0, 1, 2].map(function (k) { return df.get('debug[' + k + ']'); }), g = [0, 1, 2].map(function (k) { return df.get('gyroADC[' + k + ']'); });
    var dts = [], tt = df.get('time'); for (var q = 1; q < Math.min(df.n, 2000); q++) dts.push(tt[q] - tt[q - 1]);
    var W = Math.max(1, Math.round(20000 / Math.max(1, median(dts))));   // ~20 ms gleitender Mittelwert gegen Vibrationsrauschen
    for (var k = 0; k < 3; k++) {   // grobe Pruefung: tieffrequent stark korreliert, gleiche Groessenordnung
      var sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0, ax = 0, ay = 0, cnt = 0;
      for (var i = 0; i < a[k].length; i++) {
        ax += a[k][i]; ay += g[k][i]; cnt++;
        if (cnt === W) { var x = ax / W, y = ay / W; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; n++; ax = ay = cnt = 0; }
      }
      var vx = sxx / n - (sx / n) * (sx / n), vy = syy / n - (sy / n) * (sy / n), r = (sxy / n - sx * sy / n / n) / Math.sqrt(Math.max(vx * vy, 1e-12));
      if (!(r > 0.8) || !(vx > 0.25 * vy && vx < 4 * vy)) return null;
    }
    return { src: 'debug (GYRO_SCALED)', a: a };
  }

  // Sollrate aus Stickwert, wenn setpoint nicht geloggt ist (BF 3.x, Betaflight-Rates)
  function rateCurve(rc, rate, sup, expo) {
    var x = Math.min(1, Math.max(-1, rc / 500));
    if (expo) { var e = expo / 100; x = x * Math.pow(Math.abs(x), 3) * e + x * (1 - e); }
    var r = rate / 100; if (r > 2) r += 14.54 * (r - 2);
    var a = 200 * r * x;
    if (sup) a *= 1 / Math.min(1, Math.max(0.01, 1 - Math.abs(x) * sup / 100));
    return a;
  }
  function synthSetpoint(df, hdr) {
    if (df.has('setpoint[0]') || !('rcRate' in hdr) || !df.has('rcCommand[0]')) return false;
    var sr = nums(hdr.rates), rr = [firstNum(hdr.rcRate), firstNum(hdr.rcRate), firstNum(hdr.rcYawRate)], ex = [firstNum(hdr.rcExpo), firstNum(hdr.rcExpo), firstNum(hdr.rcYawExpo)];
    for (var k = 0; k < 3; k++) {
      var rc = df.get('rcCommand[' + k + ']'), o = new Float64Array(df.n), rate = fin(rr[k]) ? rr[k] : 100, sup = fin(sr[k]) ? sr[k] : 0, e = fin(ex[k]) ? ex[k] : 0;
      for (var i = 0; i < df.n; i++) o[i] = rateCurve(rc[i], rate, sup, e);
      df.cols['setpoint[' + k + ']'] = o;
    }
    return true;
  }

  // ---------- Analyse ----------
  function analyze(df, hdr, name, cellsArg) {
    var t = df.t, n = df.n, i, j, k;
    var m = { name: name, hdr: hdr, ok: false, fw: firmware(hdr) };
    m.sp_synth = synthSetpoint(df, hdr);
    var dts = []; for (i = 1; i < Math.min(n, 20001); i++) dts.push(t[i] - t[i - 1]);
    var fs = 1 / median(dts); m.fs = fs; m.log_s = t[n - 1];
    if (!df.has('gyroADC[0]')) { m.error = 'Keine Gyro-Daten im Log.'; return m; }
    // Gas und Motoren
    var MI = motorInfo(df, hdr); m.motorRange = [MI.lo, MI.hi]; m.nMot = MI.names.length;
    var rc3 = df.get('rcCommand[3]'), thr = new Float64Array(n);
    for (i = 0; i < n; i++) thr[i] = Math.min(100, Math.max(0, (rc3[i] - 1000) / 10));
    var mot = MI.names.map(function (nm) { var a = df.get(nm), o = new Float64Array(n); for (var q = 0; q < n; q++) o[q] = (a[q] - MI.lo) / (MI.hi - MI.lo) * 100; return o; });
    var mavg = new Float64Array(n); for (i = 0; i < n; i++) { var s = 0; for (k = 0; k < mot.length; k++) s += mot[k][i]; mavg[i] = mot.length ? s / mot.length : thr[i]; }
    df.cols.thr = thr; df.cols.mavg = mavg; mot.forEach(function (a, q) { df.cols['mot' + q] = a; });
    // Flugphase: Motoren deutlich ueber Leerlauf
    var mask = new Uint8Array(n); for (i = 0; i < n; i++) mask[i] = mavg[i] > THRESH.fly_motor_pct ? 1 : 0;
    var segs = mergedSegments(mask, t, 2.0);
    if (!segs.length) { m.error = 'Kein Flug im Log gefunden (Motoren nie deutlich ueber Leerlauf) - vermutlich ein Test am Boden.'; return m; }
    var best = segs[0]; segs.forEach(function (sg) { if (t[sg[1]] - t[sg[0]] > t[best[1]] - t[best[0]]) best = sg; });
    var i0 = best[0], i1 = best[1] + 1;
    m.n_segments = segs.length;
    if (t[i1 - 1] - t[i0] < THRESH.min_flight_short_s) { m.error = 'Flugphase nur ' + (t[i1 - 1] - t[i0]).toFixed(1) + ' s lang - zu kurz fuer eine Analyse.'; return m; }
    m.short = t[i1 - 1] - t[i0] < THRESH.min_flight_s;
    m.ok = true; m.t0 = t[i0]; m.t1 = t[i1 - 1]; m.i0 = i0; m.i1 = i1;
    var fl = df.slice(i0, i1); m.fl = fl; fl.t = fl.cols.t; var flt = fl.t;
    m.flight_s = flt[fl.n - 1] - flt[0];
    // Rohes Gyro (vor den Filtern) in die Flugphase uebernehmen
    var RG = rawGyro(df, hdr); m.rawSrc = RG ? RG.src : null;
    if (RG) for (k = 0; k < 3; k++) fl.cols['gyroRaw[' + k + ']'] = RG.a[k].subarray(i0, i1);
    // ---------- Elektrik ----------
    var vb = df.get('Vbat'), ib = df.get('Ibat'), vdiv = voltDiv(vb, hdr), idiv = 100;   // BF: amperageLatest in 0,01 A
    m.vdiv = vdiv; m.idiv = idiv;
    var V = new Float64Array(n), I = new Float64Array(n); for (i = 0; i < n; i++) { V[i] = vb[i] / vdiv; I[i] = ib[i] / idiv; }
    var flV = V.subarray(i0, i1), flI = I.subarray(i0, i1); fl.cols.V = flV; fl.cols.I = flI;
    var s2 = []; for (i = 0; i < n && t[i] < 2; i++) if (V[i] > 0.5) s2.push(V[i]);
    m.v_start = s2.length ? nanmean(s2) : percentile(Array.prototype.slice.call(V, 0, Math.min(n, Math.floor(fs * 5))), 90);
    m.cells = (cellsArg || Math.ceil(m.v_start / 4.35)); if (!(m.v_start > 3)) m.cells = 1;
    var vs = rollMedian(flV, 25); m.v_min = nanmin(vs); m.v_min_cell = m.v_min / m.cells;
    m.hasVolt = fin(m.v_min) && m.v_min > 1; m.hasCurr = fl.has('Ibat') && nanmax(flI) > 0.5;
    m.hasElec = m.hasVolt;
    m.i_peak = m.hasCurr ? nanmax(flI) : NaN; m.i_mean = m.hasCurr ? nanmean(flI) : NaN;
    if (m.hasCurr) {
      var Pw = new Float64Array(fl.n); for (i = 0; i < fl.n; i++) Pw[i] = flI[i] * flV[i];
      m.p_peak = nanmax(Pw); m.p_mean = nanmean(Pw);
      var segT = t, segI = I, segV = V;
      m.mah = trapz(segI, segT) / 3.6;
      var iv = new Float64Array(n); for (i = 0; i < n; i++) iv[i] = segI[i] * segV[i];
      m.wh = trapz(iv, segT) / 3600;
      var cum = new Float64Array(n), acc = 0; for (i = 1; i < n; i++) { acc += (segI[i] + segI[i - 1]) / 2 * (segT[i] - segT[i - 1]); cum[i] = acc / 3.6; }
      var step = Math.max(Math.floor(fs / 2), 1), cx = [], cv = []; for (i = 0; i < n; i += step) { cx.push(cum[i]); cv.push(rollMedianAt(segV, i, Math.round(fs)) / m.cells); }
      m.curve = [cx, cv];
    } else { m.p_peak = m.p_mean = m.mah = m.wh = NaN; m.curve = null; }
    var tailV = [], tEnd = t[n - 1]; for (i = i1; i < n; i++) if (t[i] > tEnd - 3 && mavg[i] < 3) tailV.push(V[i]);
    m.v_rest_cell = tailV.length > 20 ? nanmean(tailV) / m.cells : NaN;
    // ---------- Sticks ----------
    var rc = [0, 1, 2].map(function (q) { return fl.has('rcCommand[' + q + ']') ? fl.get('rcCommand[' + q + ']') : null; });
    var allst = new Float64Array(fl.n); for (i = 0; i < fl.n; i++) allst[i] = rc[0] ? (Math.abs(rc[0][i]) + Math.abs(rc[1][i]) + Math.abs(rc[2][i])) / 3 : 0;
    fl.cols.allst = allst; m.stick_activity = nanmean(allst);
    var flThr = fl.cols.thr, flM = fl.cols.mavg;
    // ---------- Gas / Schwebepunkt ----------
    var calm = []; for (i = 0; i < fl.n; i++) if (allst[i] < 25) calm.push(i);
    m.thr_mean = nanmean(flThr);
    m.hover_thr = calm.length > fs ? median(calm.map(function (q) { return flThr[q]; })) : NaN;
    m.hover_mot = calm.length > fs ? median(calm.map(function (q) { return flM[q]; })) : NaN;
    // ---------- Motoren ----------
    var nm = mot.length; m.mot = null;
    if (nm) {
      var flMot = mot.map(function (a) { return a.subarray(i0, i1); }), sat = 0, idle = 0, any = new Float64Array(fl.n), pk = 0, pki = 0, near = 0, per = [], perAll = [];
      for (i = 0; i < fl.n; i++) {
        var mx = -1e9, mn = 1e9; for (k = 0; k < nm; k++) { var v = flMot[k][i]; if (v > mx) mx = v; if (v < mn) mn = v; }
        any[i] = mx; if (mx >= 99) sat++; if (mx >= 95) near++; if (mn <= 0.5 && flThr[i] > 15) idle++; if (flM[i] > pk) { pk = flM[i]; pki = i; }
      }
      for (k = 0; k < nm; k++) { per.push(calm.length > fs ? median(calm.map(function (q) { return flMot[k][q]; })) : NaN); perAll.push(nanmean(flMot[k])); }
      var pm = per.filter(fin), pmean = pm.length ? pm.reduce(function (a, b) { return a + b; }, 0) / pm.length : NaN;
      var imb = pm.length ? Math.max.apply(null, pm) - Math.min.apply(null, pm) : NaN, hiM = 0, loM = 0;
      per.forEach(function (x, q) { if (x > per[hiM]) hiM = q; if (x < per[loM]) loM = q; });
      m.mot = { n: nm, mean: nanmean(flM), peak: pk, t_peak: flt[pki], sat_pct: sat / fl.n * 100, near: near / fl.n * 100, idle_pct: idle / fl.n * 100,
        per: per, perAll: perAll, hover_mean: pmean, imbalance: imb, imb_hi: hiM, imb_lo: loM, maxArr: any, reserve: 100 - nanmean(flM) };
      // eRPM (ab BF 4.3 im Log, Wert = eRPM/100)
      var er = []; for (k = 0; k < nm; k++) if (fl.has('eRPM[' + k + ']')) er.push(fl.get('eRPM[' + k + ']'));
      if (er.length === nm) {
        var poles = filterSettings(hdr).poles, hz = new Float64Array(fl.n), zero = 0;
        for (i = 0; i < fl.n; i++) { var se = 0; for (k = 0; k < nm; k++) { se += er[k][i]; if (er[k][i] <= 0 && flM[i] > 15) zero++; } hz[i] = se / nm * 100 / 60 / (poles / 2); }
        fl.cols.motHz = hz; m.mot.rpm = { hz_med: median(hz), hz_max: nanmax(hz), zero_pct: zero / (fl.n * nm) * 100, poles: poles };
      }
    }
    // ---------- Regelabweichung je Achse ----------
    var gy = [0, 1, 2].map(function (q) { return fl.get('gyroADC[' + q + ']'); });
    var trk = {}; ['Roll', 'Nick', 'Gier'].forEach(function (lab, kx) {
      if (fl.has('setpoint[' + kx + ']')) {
        var sp2 = fl.get('setpoint[' + kx + ']'), er2 = []; for (var q = 0; q < fl.n; q++) if (Math.abs(sp2[q]) > THRESH.track_sp_min) er2.push(Math.abs(sp2[q] - gy[kx][q]));
        if (er2.length > fs / 2) trk[lab] = [median(er2), percentile(er2, 95), er2.length];
      }
    });
    m.track = trk;
    // ---------- Ruhephasen: niederfrequentes Gyro-Spektrum (Wackeln, P/I-Schwingung) ----------
    var w2s = pow2near(2 * fs), wobble = [], hov = [], re = new Float64Array(w2s), im = new Float64Array(w2s), sp = new Float64Array(w2s / 2 + 1);
    var kmax = Math.min(w2s / 2, Math.ceil(80 * w2s / fs));
    for (var s0 = 0; s0 + w2s <= fl.n; s0 += w2s >> 1) {
      if (meanRange(allst, s0, s0 + w2s) < 25) {
        var accs = [], wb = 0;
        for (k = 0; k < 3; k++) { ampSpec(gy[k], s0, w2s, sp, re, im); accs.push(Float64Array.from(sp.subarray(0, kmax + 1))); }
        for (k = 0; k < 2; k++) { var ss = 0; for (j = 1; j <= kmax; j++) { var f = j * fs / w2s; if (f >= 2 && f <= 8) ss += accs[k][j] * accs[k][j] / 2; } wb += Math.sqrt(ss) / 2; }
        wobble.push(wb); hov.push(accs);
      }
    }
    m.wobble = wobble.length >= 3 ? median(wobble) : NaN; m.wobble_n = wobble.length; m.hover_peaks = []; m.hover_n = hov.length;
    if (hov.length >= 3) {
      var df2 = fs / w2s, labs = ['Roll', 'Nick', 'Gier']; m.hover_spec = { df: df2, axes: [] };
      for (k = 0; k < 3; k++) {
        var spk = new Float64Array(kmax + 1); for (var h = 0; h < hov.length; h++) for (j = 0; j <= kmax; j++) spk[j] += hov[h][k][j] / hov.length;
        m.hover_spec.axes.push(spk);
        for (j = Math.max(3, Math.floor(3 / df2)); j < Math.min(kmax - 9, Math.floor(60 / df2)); j++) {
          var loc = pySlice(spk, j - 8, j - 2).concat(pySlice(spk, j + 3, j + 9)), mxx = Math.max.apply(null, pySlice(spk, j - 2, j + 3));
          if (spk[j] === mxx && spk[j] > 0.15 && spk[j] / Math.max(median(loc), 1e-9) >= THRESH.peak_prominence) m.hover_peaks.push([labs[k], j * df2, spk[j] / Math.max(median(loc), 1e-9), spk[j]]);
        }
      }
      m.hover_peaks.sort(function (a, b) { return b[2] - a[2]; });
    }
    // ---------- Signal ----------
    m.rx_loss = 0; if (fl.has('rxSignalReceived')) { var rr = fl.get('rxSignalReceived'); for (i = 0; i < rr.length; i++) if (rr[i] === 0) m.rx_loss++; }
    m.failsafe_active = false; if (fl.has('failsafePhase')) { var fp = fl.get('failsafePhase'); for (i = 0; i < fp.length; i++) if (fp[i] !== 0) { m.failsafe_active = true; break; } }
    m.rssi = null;
    if (fl.has('rssi')) {
      var rs = fl.get('rssi'), rmax = nanmax(rs);
      if (rmax > 0 && !(nanmin(rs) === rmax && rmax >= 1023)) {   // konstant 1023 = kein RSSI konfiguriert
        var pc = Array.prototype.map.call(rs, function (x) { return x / 1023 * 100; }), low = pc.filter(function (x) { return x < THRESH.rssi_low_pct; }).length;
        m.rssi = { min: nanmin(pc), med: median(pc), low_pct: low / pc.length * 100 };
      }
    }
    m.v_zero = 0; if (m.hasVolt) for (i = 0; i < flV.length; i++) if (flV[i] <= 0.1) m.v_zero++;
    return m;
  }

  var api = { analyze: analyze, prepare: prepare, THRESH: THRESH, Frame: Frame, fnum: fnum, nums: nums, firstNum: firstNum, firmware: firmware, fwGe: fwGe, simplified: simplified, param: param, filterSettings: filterSettings,
    util: { median: median, percentile: percentile, nanmean: nanmean, nanmax: nanmax, nanmin: nanmin, rollMedian: rollMedian, hann: hann, fft: fft, ampSpec: ampSpec, pow2near: pow2near, fin: fin, pySlice: pySlice, voltDiv: voltDiv, meanRange: meanRange } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RFA = api;
})(typeof self !== 'undefined' ? self : this);
