/* Propwash: Schuetteln von Roll/Nick nach schneller Gas-Ruecknahme (Abstiege durch den eigenen Abwind).
   Gegenstueck zur Lastwechsel-Auswertung des Heli-Governors. */
(function (root) {
  'use strict';
  var A = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./analysis.js') : root.RFA, U = A.util;
  var median = U.median, fin = U.fin;
  var f0 = function (x) { return x.toFixed(0); }, f1 = function (x) { return x.toFixed(1); };
  var PW = { drop: 20, drop_s: 0.3, after_max: 40, win0: 0.05, win1: 0.8, lo: 10, hi: 90, min_ev: 3, hint: 3, warn: 6, p90_hint: 10, p90_warn: 20 };

  // Effektivwert von y[s..s+len) im Band lo..hi (Hann, Leistungskorrektur)
  function bandRms(y, s, len, fs, lo, hi, buf) {
    var N = U.pow2near(len); if (N > len) N >>= 1; if (N < 16) return NaN;
    var w = U.hann(N), re = buf.re.length === N ? buf.re : (buf.re = new Float64Array(N)), im = buf.im.length === N ? buf.im : (buf.im = new Float64Array(N)), i, mean = 0, u2 = 0;
    for (i = 0; i < N; i++) mean += y[s + i]; mean /= N;
    for (i = 0; i < N; i++) { re[i] = (y[s + i] - mean) * w[i]; im[i] = 0; u2 += w[i] * w[i]; }
    U.fft(re, im); var p = 0;
    for (var k = 1; k < N / 2; k++) { var f = k * fs / N; if (f >= lo && f <= hi) p += 2 * (re[k] * re[k] + im[k] * im[k]); }
    return Math.sqrt(p / (N * u2));
  }

  function analyze(m) {
    var P = { ok: false }, fl = m.fl, fs = m.fs; if (!fl || !m.ok) return P;
    var thr = fl.cols.thr, n = fl.n, t = fl.t, i, hi = Math.min(PW.hi, fs / 2 * 0.9);
    if (!thr || !fl.has('gyroADC[0]')) { P.reason = 'Gas oder Gyro fehlen im Log.'; return P; }
    if (hi <= PW.lo + 5) { P.reason = 'Lograte zu niedrig fuer die Propwash-Auswertung.'; return P; }
    var e0 = err(0), e1 = err(1), buf = { re: new Float64Array(0), im: new Float64Array(0) };
    var dN = Math.max(1, Math.round(PW.drop_s * fs)), w0 = Math.round(PW.win0 * fs), w1 = Math.round(PW.win1 * fs), len = w1 - w0;
    function metric(s) { return (bandRms(e0, s, len, fs, PW.lo, hi, buf) + bandRms(e1, s, len, fs, PW.lo, hi, buf)) / 2; }
    // Regelabweichung Soll - Ist: blendet gewollte Drehungen (Flips) aus
    function err(k) { var g = fl.get('gyroADC[' + k + ']'), o = new Float64Array(n); if (!fl.has('setpoint[' + k + ']')) return g; var sp = fl.get('setpoint[' + k + ']'); for (var q = 0; q < n; q++) o[q] = sp[q] - g[q]; return o; }
    // Gas-Ruecknahmen finden
    var ev = [], last = -1e9, mav = fl.cols.mavg, ga = fl.get('gyroADC[0]'), gb = fl.get('gyroADC[1]');
    for (i = dN; i < n - w1; i++) {
      if (thr[i - dN] - thr[i] < PW.drop || thr[i] > PW.after_max || i - last < w1) continue;
      var j = i; while (j + 1 < n - w1 && thr[j + 1] < thr[j]) j++;    // bis zum Tiefpunkt
      var land = false; for (var q = j; q < j + w1 + Math.round(0.5 * fs) && q < n; q++) if (mav[q] < A.THRESH.fly_motor_pct || Math.abs(ga[q]) > 1900 || Math.abs(gb[q]) > 1900) { land = true; break; }
      if (land || j + w1 + fs > n) { i = j; continue; }   // Landung/Aufprall, kein Propwash
      var v = metric(j + w0); if (!fin(v)) continue;
      ev.push({ t: t[j], i: j, drop: thr[i - dN] - thr[j], thr: thr[j], v: v }); last = j; i = j;
    }
    // Vergleich: ruhiger Vorwaertsflug/Schwebe ohne Gaswechsel
    var base = [], stepB = len;
    for (i = 0; i + len + dN < n; i += stepB) {
      var tmin = 1e9, tmax = -1e9; for (var q = i; q < i + len; q += 4) { if (thr[q] < tmin) tmin = thr[q]; if (thr[q] > tmax) tmax = thr[q]; }
      if (tmax - tmin < 8 && tmin > 10) { var b = metric(i); if (fin(b)) base.push(b); }
    }
    P.ok = true; P.hi = hi; P.events = ev; P.n = ev.length; P.base = base.length >= 3 ? median(base) : NaN;
    if (ev.length) {
      var vs = ev.map(function (e) { return e.v; }); P.med = median(vs); P.p90 = U.percentile(vs, 90);
      var w = ev[0]; ev.forEach(function (e) { if (e.v > w.v) w = e; }); P.worst = w;
      P.ratio = fin(P.base) && P.base > 0 ? P.med / P.base : NaN;
    }
    return P;
  }

  function findings(P, m) {
    var F = [];
    function add(sev, title, obs, todo) { F.push({ sev: sev, area: 'Propwash', title: title, obs: obs, todo: todo || '' }); }
    if (!P || !P.ok) { if (P && P.reason) add('info', 'Propwash nicht auswertbar', P.reason); return F; }
    if (P.n < PW.min_ev) { add('info', 'Kaum Gas-Ruecknahmen im Flug', 'Nur ' + P.n + ' schnelle Gas-Ruecknahmen gefunden (mindestens ' + PW.min_ev + ' noetig). Propwash zeigt sich vor allem bei Abstiegen und nach Flips/Rolls mit Gas weg.', 'Fuer eine Bewertung Manoever mit schneller Gas-Ruecknahme fliegen (Dives, Split-S, Gas-Stoesse).'); return F; }
    var obs = P.n + ' schnelle Gas-Ruecknahmen (um mindestens ' + PW.drop + ' %, danach unter ' + PW.after_max + ' %). Danach schwingen Roll/Nick im Band ' + PW.lo + '-' + f0(P.hi) + ' Hz typisch mit ' + f1(P.med) + ' deg/s (90-%-Wert ' + f1(P.p90) + ', staerkstes Ereignis ' + f1(P.worst.v) + ' deg/s bei ' + f0(P.worst.t) + ' s)' +
      (fin(P.base) ? '; im ruhigen Flug ohne Gaswechsel sind es ' + f1(P.base) + ' deg/s (Faktor ' + f1(P.ratio) + ').' : '.') + ' Richtwerte (typisch / 90-%-Wert): ab ' + PW.hint + ' / ' + PW.p90_hint + ' deg/s Hinweis, ab ' + PW.warn + ' / ' + PW.p90_warn + ' deutlich.';
    var todo = 'Propwash mildern, in dieser Reihenfolge: (1) RPM-Filter nutzen und andere Filter dafuer lockern - jede Filterverzoegerung verschlechtert Propwash. (2) D bzw. D-Min um 10 % erhoehen (bessere Daempfung), Motoren danach auf Waerme pruefen. (3) Dynamic Idle (dyn_idle_min_rpm) aktivieren bzw. erhoehen, damit die Motoren beim Gas-weg nicht zu weit abfallen. (4) Bei weiter Schuetteln: I-Term-Relax-Cutoff und Anti-Gravity pruefen.';
    if (P.med >= PW.warn || P.p90 >= PW.p90_warn) add('warn', 'Deutlicher Propwash nach Gas-Ruecknahme', obs, todo);
    else if (P.med >= PW.hint || P.p90 >= PW.p90_hint) add('hint', 'Spuerbarer Propwash', obs, todo);
    else add('ok', 'Propwash gering', obs);
    return F;
  }

  function recommendations(P, m) {
    var R = []; if (!P || !P.ok || P.n < PW.min_ev || !(P.med >= PW.hint || P.p90 >= PW.p90_hint)) return R;
    var hdr = m.hdr || {}, di = A.param(hdr, 'dyn_idle'), dmin = A.param(hdr, 'dmin'), cli = [], S = A.filterSettings(hdr);
    [0, 1].forEach(function (k) {
      var ax = ['roll', 'pitch'][k], pid = A.nums(hdr[ax + 'PID']), D = pid[2], dm = dmin.v[k];
      if (dmin.key === 'd_min' && dm > 0 && dm < D) cli.push('set ' + dmin.cli[k] + ' = ' + Math.round(dm * 1.1) + '  # war ' + f0(dm) + ', +10 %');
      else if (fin(D)) cli.push('set d_' + ax + ' = ' + Math.round(D * 1.1) + '  # war ' + f0(D) + ', +10 %');
    });
    if (di.key && S.bidir) { var cur = di.v[0]; cli.push('set dyn_idle_min_rpm = ' + (cur > 0 ? Math.round(cur * 1.15) : 25) + '  # war ' + f0(cur || 0) + (cur > 0 ? ', +15 %' : ', Wert x100 U/min, an den Motor anpassen')); }
    R.push({ area: 'PID Propwash', title: 'Propwash: mehr Daempfung' + (di.key && S.bidir ? ' und Dynamic Idle' : ''), obs: 'Nach Gas-Ruecknahmen schwingen Roll/Nick typisch mit ' + f1(P.med) + ' deg/s im Band ' + PW.lo + '-' + f0(P.hi) + ' Hz.', cli: cli,
      note: (S.rpm_on ? '' : 'Ohne RPM-Filter (bidirektionales DShot) ist die Filterverzoegerung meist der groesste Hebel gegen Propwash. ') + 'D-Erhoehungen nur in kleinen Schritten und danach die Motortemperatur pruefen.' });
    return R;
  }
  var api = { analyze: analyze, findings: findings, recommendations: recommendations, PW: PW };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RFW = api;
})(typeof self !== 'undefined' ? self : this);
