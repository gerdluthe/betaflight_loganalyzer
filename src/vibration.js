/* Vibrationsanalyse: Welch-Spektrum von Roh- und gefiltertem Gyro, Drehzahl-Harmonische, Filter-Empfehlungen */
(function (root) {
  'use strict';
  var A = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./analysis.js') : root.RFA, U = A.util;
  var median = U.median, fin = U.fin;
  var f0 = function (x) { return x.toFixed(0); }, f1 = function (x) { return x.toFixed(1); };
  var AX = ['Roll', 'Nick', 'Gier'];
  var VT = { lvl_hint: 4, lvl_warn: 10, peak_prom: 6, peak_amp: 1.0, att_good: 15, att_poor: 10, stable_pct: 0.04, unbal_amp: 8 };

  // ---- FFT (Radix-2) ----
  var _fft = {};
  function fftTab(N) {
    if (_fft[N]) return _fft[N];
    var c = new Float64Array(N / 2), s = new Float64Array(N / 2), rev = new Uint32Array(N), bits = Math.log2(N), i;
    for (i = 0; i < N / 2; i++) { c[i] = Math.cos(2 * Math.PI * i / N); s[i] = -Math.sin(2 * Math.PI * i / N); }
    for (i = 0; i < N; i++) { var r = 0, x = i; for (var b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
    return (_fft[N] = { c: c, s: s, rev: rev });
  }
  function fft(re, im) {
    var N = re.length, T = fftTab(N), i, j, k, len, half, step, t;
    for (i = 0; i < N; i++) { j = T.rev[i]; if (j > i) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (len = 2; len <= N; len <<= 1) {
      half = len >> 1; step = N / len;
      for (i = 0; i < N; i += len) for (k = 0; k < half; k++) {
        var wr = T.c[k * step], wi = T.s[k * step], a = i + k, b = a + half;
        var xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
  // einseitige Leistungsdichte eines Fensters (Hann, Mittelwert entfernt)
  function psd(y, off, N, fs, w, U2, re, im, out) {
    var i, mean = 0; for (i = 0; i < N; i++) mean += y[off + i]; mean /= N;
    for (i = 0; i < N; i++) { re[i] = (y[off + i] - mean) * w[i]; im[i] = 0; }
    fft(re, im);
    var h = N / 2, sc = 2 / (fs * U2);
    for (var k = 0; k <= h; k++) out[k] = (re[k] * re[k] + im[k] * im[k]) * sc * ((k === 0 || k === h) ? 0.5 : 1);
  }
  function bandRms(P, df, lo, hi) { var s = 0; for (var k = 1; k < P.length; k++) { var f = k * df; if (f >= lo && f < hi) s += P[k] * df; } return Math.sqrt(s); }
  function localBase(P, j) {
    var a = []; for (var d = 3; d <= 12; d++) { if (j - d >= 1) a.push(P[j - d]); if (j + d < P.length) a.push(P[j + d]); }
    return Math.max(median(a), 1e-12);
  }
  function parseHdrNums(s) { return String(s === undefined ? '' : s).split(',').map(function (x) { return parseFloat(x); }); }

  function analyze(m) {
    var V = { ok: false }, fl = m.fl, fs = m.fs, hdr = m.hdr || {}, i, k;
    if (!fl || !m.ok) return V;
    var raw = [fl.cols['gyroRAW[0]'], fl.cols['gyroRAW[1]'], fl.cols['gyroRAW[2]']], adc = [fl.cols['gyroADC[0]'], fl.cols['gyroADC[1]'], fl.cols['gyroADC[2]']];
    var hasRaw = !!(raw[0] && raw[1] && raw[2]), hasAdc = !!(adc[0] && adc[1] && adc[2]);
    if (!hasAdc && !hasRaw) { V.error = 'Keine Gyro-Daten im Log.'; return V; }
    if (!hasAdc) adc = raw;
    var N = Math.max(256, Math.min(2048, Math.pow(2, Math.round(Math.log2(fs))))), n = fl.n;
    if (n < N * 3) { V.error = 'Flugphase zu kurz fuer eine Spektralanalyse.'; return V; }
    var hsA = fl.get('headspeed'), hsv = []; for (i = 0; i < n; i++) if (hsA[i] > 50) hsv.push(hsA[i]);
    var hsMed = hsv.length ? median(hsv) : m.target, fh = hsMed / 60, df = fs / N, h = N / 2;
    var w = new Float64Array(N), U2 = 0; for (i = 0; i < N; i++) { w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); U2 += w[i] * w[i]; }
    var re = new Float64Array(N), im = new Float64Array(N), tmp = new Float64Array(h + 1);
    var accR = [0, 1, 2].map(function () { return new Float64Array(h + 1); }), accA = [0, 1, 2].map(function () { return new Float64Array(h + 1); });
    var nWin = 0, hop = N >> 1, tt = [], lvR = [], lvA = [], lvH = [];
    var hi = Math.max(20, 0), t = fl.t;
    for (var s0 = 0; s0 + N <= n; s0 += hop) {
      var hsAvg = 0, stable = true; for (i = s0; i < s0 + N; i++) { hsAvg += hsA[i]; if (Math.abs(hsA[i] - hsMed) > VT.stable_pct * hsMed) stable = false; } hsAvg /= N;
      var pr = 0, pa = 0;
      for (k = 0; k < 3; k++) {
        if (hasRaw) { psd(raw[k], s0, N, fs, w, U2, re, im, tmp); if (stable) for (i = 0; i <= h; i++) accR[k][i] += tmp[i]; var r = bandRms(tmp, df, 20, 1e9); pr += r * r; }
        psd(adc[k], s0, N, fs, w, U2, re, im, tmp); if (stable) for (i = 0; i <= h; i++) accA[k][i] += tmp[i]; var a = bandRms(tmp, df, 20, 1e9); pa += a * a;
      }
      tt.push(t[s0 + (N >> 1)]); lvR.push(hasRaw ? Math.sqrt(pr / 3) : NaN); lvA.push(Math.sqrt(pa / 3)); lvH.push(hsAvg);
      if (stable) nWin++;
    }
    if (nWin < 6) { V.error = 'Zu wenig Phasen mit stabiler Drehzahl fuer eine Spektralanalyse (' + nWin + ').'; return V; }
    for (k = 0; k < 3; k++) for (i = 0; i <= h; i++) { accR[k][i] /= nWin; accA[k][i] /= nWin; }
    var nyq = fs / 2;
    V = { ok: true, fs: fs, N: N, df: df, nyq: nyq, nWin: nWin, fh: fh, hs: hsMed, hasRaw: hasRaw, psdR: hasRaw ? accR : null, psdA: accA,
      lvl: { t: Float64Array.from(tt), raw: Float64Array.from(lvR), adc: Float64Array.from(lvA), hs: Float64Array.from(lvH) } };
    // Pegel je Achse / Band
    var edges = [0, 20, 60, 120, 250, 1e9], bands = [];
    for (i = 0; i < edges.length - 1; i++) if (edges[i] < nyq - df) bands.push([edges[i], Math.min(edges[i + 1], nyq)]);
    V.bands = bands;
    V.rmsA = accA.map(function (P) { return bands.map(function (b) { return bandRms(P, df, b[0], b[1] + 1e-9); }); });
    V.rmsR = hasRaw ? accR.map(function (P) { return bands.map(function (b) { return bandRms(P, df, b[0], b[1] + 1e-9); }); }) : null;
    V.hfA = accA.map(function (P) { return bandRms(P, df, 20, 1e9); });
    V.hfR = hasRaw ? accR.map(function (P) { return bandRms(P, df, 20, 1e9); }) : null;
    // Filter-Einstellungen
    var lp1t = parseFloat(hdr.gyro_lpf1_type), lp1 = parseFloat(hdr.gyro_lpf1_static_hz), lp2 = parseFloat(hdr.gyro_lpf2_static_hz);
    V.set = { lpf1_type: lp1t, lpf1: lp1, lpf2: lp2, dn_count: parseFloat(hdr.dyn_notch_count), dn_q: parseFloat(hdr.dyn_notch_q), dn_min: parseFloat(hdr.dyn_notch_min_hz), dn_max: parseFloat(hdr.dyn_notch_max_hz),
      rpm_preset: parseFloat(hdr.gyro_rpm_notch_preset), rpm_src: parseHdrNums(hdr.gyro_rpm_notch_source_pitch).filter(function (x) { return x > 0; }).length };
    V.lp_on = fin(lp1) && lp1 > 0 && lp1t > 0;
    // Spitzen: im Rohsignal (falls vorhanden) sonst im gefilterten
    var base = hasRaw ? accR : accA, cand = [], j;
    for (k = 0; k < 3; k++) {
      var P = base[k];
      for (j = Math.ceil(15 / df); j < h - 1; j++) {
        if (!(P[j] >= P[j - 1] && P[j] >= P[j + 1])) continue;
        var prom = P[j] / localBase(P, j);
        if (prom >= VT.peak_prom) cand.push({ ax: k, j: j, prom: prom, p: P[j] });
      }
    }
    cand.sort(function (a, b) { return b.p - a.p; });
    var peaks = [];
    cand.forEach(function (c) {
      for (var q = 0; q < peaks.length; q++) if (Math.abs(peaks[q].j - c.j) <= 2) { peaks[q].axes[c.ax] = true; return; }
      var ax = [false, false, false]; ax[c.ax] = true; peaks.push({ j: c.j, f: c.j * df, axis: c.ax, axes: ax, prom: c.prom });
    });
    var amp = function (P, j) { return Math.sqrt((P[j - 1] + P[j] + P[j + 1]) * df); };
    peaks.forEach(function (p) {
      var jj = p.j;
      p.ampR = hasRaw ? Math.max(amp(accR[0], jj), amp(accR[1], jj), amp(accR[2], jj)) : NaN;
      p.ampA = Math.max(amp(accA[0], jj), amp(accA[1], jj), amp(accA[2], jj));
      var pk = p.axis; p.ampRax = hasRaw ? amp(accR[pk], jj) : NaN; p.ampAax = amp(accA[pk], jj);
      p.att = hasRaw ? 20 * Math.log10(Math.max(p.ampRax, 1e-9) / Math.max(p.ampAax, 1e-9)) : NaN;
      var nn = p.f / fh, nr = Math.round(nn), tol = Math.max(1.5 * df, 0.02 * p.f);
      p.n = (nr >= 1 && nr <= 12 && Math.abs(p.f - nr * fh) <= tol) ? nr : 0;
      p.nfrac = nn;
      p.over_lpf = V.lp_on && p.f > 1.6 * lp1;
      p.in_dyn = fin(V.set.dn_min) && fin(V.set.dn_max) && V.set.dn_count > 0 && p.f >= V.set.dn_min && p.f <= V.set.dn_max;
    });
    peaks.sort(function (a, b) { return (hasRaw ? b.ampR - a.ampR : b.ampA - a.ampA); });
    V.peaks = peaks.slice(0, 12);
    return V;
  }

  // ---- Befunde ----
  function findings(V, m) {
    var F = [];
    function add(sev, title, obs, todo) { F.push({ sev: sev, area: 'Vibration', title: title, obs: obs, todo: todo || '' }); }
    if (!V || !V.ok) { if (V && V.error) add('info', 'Vibrationsanalyse nicht moeglich', V.error, ''); return F; }
    var S = V.set, lim = 'Das Log enthaelt Frequenzen bis ' + f0(V.nyq) + ' Hz (Abtastrate ' + f0(V.fs) + ' Hz).';
    if (V.fs < 1000) add('info', 'Log-Rate begrenzt die Analyse', lim + ' Schwingungen darueber sind nicht sichtbar, und Rohsignal-Spitzen oberhalb von ca. ' + f0(V.nyq * 0.6) + ' Hz koennen Spiegelfrequenzen (Aliasing) sein.',
      'Fuer eine genaue Filter-Abstimmung die Blackbox-Abtastrate im Rotorflight Configurator (Reiter Blackbox) auf mindestens 1 kHz erhoehen und einen ruhigen Schwebeflug von ca. 30 s loggen.');
    if (!V.hasRaw) add('info', 'Kein ungefiltertes Gyro im Log', 'Es wird nur das gefilterte Gyro ausgewertet. Damit sind nur uebrig gebliebene Schwingungen sichtbar, nicht deren Ursache und die Wirkung der Filter.',
      'Im Configurator (Blackbox) das ungefilterte Gyro (gyroRAW) mitloggen, falls die Option vorhanden ist.');
    // Gesamtpegel (gefiltert, > 20 Hz)
    var wi = 0; V.hfA.forEach(function (x, i) { if (x > V.hfA[wi]) wi = i; });
    var lv = V.hfA[wi], sev = lv >= VT.lvl_warn ? 'warn' : lv >= VT.lvl_hint ? 'hint' : 'ok';
    var lvTxt = V.hfA.map(function (x, i) { return AX[i] + ' ' + f1(x); }).join(', ');
    add(sev, sev === 'ok' ? 'Restvibration nach den Filtern niedrig' : 'Restvibration nach den Filtern erhoeht',
      'Verbleibende Vibration im gefilterten Gyro oberhalb 20 Hz (Effektivwert in deg/s): ' + lvTxt + '. Schwerpunkt: ' + AX[wi] + '. (Richtwerte: unter ' + VT.lvl_hint + ' ruhig, ab ' + VT.lvl_hint + ' Hinweis, ab ' + VT.lvl_warn + ' deutlich.)' +
      (V.hasRaw ? ' Vor den Filtern lag der Pegel bei ' + V.hfR.map(function (x, i) { return AX[i] + ' ' + f1(x); }).join(', ') + '.' : ''),
      sev === 'ok' ? '' : 'Zuerst die Mechanik pruefen (Blattspur und -gewicht, Rotorkopf-Spiel, Lager, Zahnraeder, Heckrotor, lockere Anbauteile), erst danach die Filter verschaerfen - Filter verdecken Probleme und kosten Phase.');
    // Filterwirkung
    if (V.hasRaw) {
      var att = V.hfR.map(function (r, i) { return 20 * Math.log10(Math.max(r, 1e-9) / Math.max(V.hfA[i], 1e-9)); });
      add('info', 'Filterwirkung', 'Die Filter daempfen die Vibration oberhalb 20 Hz um ' + att.map(function (a, i) { return AX[i] + ' ' + f0(a) + ' dB'; }).join(', ') + ' (6 dB = halbe Amplitude, 20 dB = ein Zehntel).' +
        (fin(S.lpf1) && S.lpf1 > 0 ? ' Aktiv: Tiefpass 1 bei ' + f0(S.lpf1) + ' Hz' + (S.lpf2 > 0 ? ', Tiefpass 2 bei ' + f0(S.lpf2) + ' Hz' : '') : '') +
        (S.dn_count > 0 ? ', dynamischer Notch (' + f0(S.dn_count) + ' Stueck, ' + f0(S.dn_min) + '-' + f0(S.dn_max) + ' Hz, Q ' + f0(S.dn_q) + ')' : '') + (S.rpm_preset > 0 ? ', RPM-Filter (' + f0(S.rpm_src) + ' Quellen)' : '') + '.', '');
    }
    // Spitzen
    var P = V.peaks.filter(function (p) { return (V.hasRaw ? p.ampR : p.ampA) >= VT.peak_amp; }), shown = 0, good = 0;
    P.forEach(function (p) {
      var cls = p.n ? (p.n + 'P (Hauptrotor-Drehzahl x ' + p.n + ')') : 'feste Frequenz, nicht an die Kopfdrehzahl gekoppelt', axs = AX.filter(function (a, i) { return p.axes[i]; }).join('/');
      var res = p.ampA >= VT.peak_amp && p.prom > 0, goodAtt = V.hasRaw && p.att >= VT.att_good;
      if (V.hasRaw && goodAtt) { good++; return; }
      if (shown >= 4) return; shown++;
      var ob = 'Spitze bei ' + f1(p.f) + ' Hz (' + axs + ') - ' + cls + '. ' + (V.hasRaw ? 'Roh ' + f1(p.ampR) + ' deg/s, nach den Filtern ' + f1(p.ampA) + ' deg/s (Daempfung ' + f0(p.att) + ' dB).' : 'Amplitude ' + f1(p.ampA) + ' deg/s.');
      var sv = (p.ampA >= 3 && !p.over_lpf) ? 'hint' : 'info';
      var todo = '';
      if (p.over_lpf) todo = 'Liegt klar oberhalb des Tiefpasses (' + f0(S.lpf1) + ' Hz) und wird davon gedaempft - keine Filteraenderung noetig.';
      else if (p.n) todo = 'Drehzahlgekoppelte Spitze: der RPM-Filter sollte sie erfassen. Im Configurator (Filter) pruefen, ob die ' + p.n + '. Harmonische des Hauptrotors abgedeckt ist ' + (S.rpm_src > 0 ? '(aktuell ' + f0(S.rpm_src) + ' RPM-Filter-Quellen) ' : '') + ' und deren Q-Wert verringern (breiterer Notch).' + (p.n === 1 && (V.hasRaw ? p.ampR >= VT.unbal_amp : p.ampA >= 3) ? ' Starke 1P-Spitze deutet zusaetzlich auf Unwucht oder Blattspur-Fehler hin: Blaetter wiegen/spuren, Rotorkopf pruefen.' : '');
      else todo = 'Feste Frequenz: typisch Resonanz (Heckrohr, Rahmen, Servohalter) oder Motor/Getriebe/Heckrotor. Test: Kopfdrehzahl aendern - wandert die Spitze mit, ist sie drehzahlgekoppelt, sonst eine Resonanz. ' + (p.in_dyn ? 'Sie liegt im Bereich des dynamischen Notch (' + f0(S.dn_min) + '-' + f0(S.dn_max) + ' Hz): Anzahl der Notches erhoehen.' : S.dn_count > 0 ? 'Sie liegt ausserhalb des dynamischen Notch-Bereichs (' + f0(S.dn_min) + '-' + f0(S.dn_max) + ' Hz): Bereich erweitern.' : 'Ein dynamischer Notch ist nicht aktiv: aktivieren (dyn_notch_count).');
      add(sv, 'Spitze bei ' + f1(p.f) + ' Hz' + (p.n ? ' (' + p.n + 'P)' : ''), ob, todo);
    });
    if (V.hasRaw && good) add('ok', good + ' Spitze' + (good > 1 ? 'n' : '') + ' im Rohsignal gut ausgefiltert', 'Diese Frequenzen sind im Rohsignal sichtbar, werden aber um mindestens ' + VT.att_good + ' dB gedaempft - die Filter arbeiten hier wie vorgesehen.', '');
    if (!P.length) add('ok', 'Keine auffaelligen Spitzen', 'Im Spektrum gibt es keine deutlichen Einzelspitzen oberhalb von 15 Hz.', '');
    return F;
  }

  // ---- Filter-Empfehlungen (mit CLI, falls Parameter im Header bekannt) ----
  function recommendations(V, m) {
    var R = [];
    if (!V || !V.ok) return R;
    var S = V.set, hf = Math.max.apply(null, V.hfA), peaks = V.peaks.filter(function (p) { return (V.hasRaw ? p.ampR : p.ampA) >= VT.peak_amp; });
    var resid = peaks.filter(function (p) { return !p.over_lpf && p.ampA >= 2.5 && (!V.hasRaw || p.att < VT.att_poor); });
    resid.slice(0, 2).forEach(function (p) {
      if (p.n) R.push({ area: 'Filter', title: 'RPM-Filter ' + p.n + 'P schaerfen (' + f1(p.f) + ' Hz)', obs: 'Die ' + p.n + '. Harmonische der Kopfdrehzahl bleibt nach den Filtern mit ' + f1(p.ampA) + ' deg/s uebrig' + (V.hasRaw ? ' (nur ' + f0(p.att) + ' dB gedaempft).' : '.'),
        cli: [], note: 'Rotorflight Configurator > Filter > RPM-Filter: die Quelle fuer diese Harmonische aktivieren bzw. ihren Q-Wert um etwa ein Drittel senken. Ein Parameter pro Flug.' });
      else if (S.dn_count > 0 && p.in_dyn && S.dn_count < 8) R.push({ area: 'Filter', title: 'Dynamischen Notch erweitern (' + f1(p.f) + ' Hz)', obs: 'Feste Spitze bei ' + f1(p.f) + ' Hz bleibt mit ' + f1(p.ampA) + ' deg/s uebrig, obwohl sie im Notch-Bereich liegt.', cli: ['set dyn_notch_count = ' + (S.dn_count + 1)] });
      else if (S.dn_count > 0 && !p.in_dyn && fin(S.dn_min)) R.push({ area: 'Filter', title: 'Notch-Bereich anpassen (' + f1(p.f) + ' Hz)', obs: 'Feste Spitze bei ' + f1(p.f) + ' Hz liegt ausserhalb des dynamischen Notch-Bereichs (' + f0(S.dn_min) + '-' + f0(S.dn_max) + ' Hz).',
        cli: [p.f > S.dn_max ? 'set dyn_notch_max_hz = ' + Math.min(Math.ceil((p.f + 20) / 10) * 10, V.nyq > 0 ? Math.floor(V.nyq / 10) * 10 + 200 : 400) : 'set dyn_notch_min_hz = ' + Math.max(Math.floor((p.f - 10) / 10) * 10, 10)] });
      else if (!(S.dn_count > 0)) R.push({ area: 'Filter', title: 'Dynamischen Notch aktivieren (' + f1(p.f) + ' Hz)', obs: 'Feste Spitze bei ' + f1(p.f) + ' Hz bleibt ungefiltert (' + f1(p.ampA) + ' deg/s).', cli: ['set dyn_notch_count = 2'] });
    });
    // Tiefpass-Reserve bzw. Verschaerfung
    if (V.lp_on && fin(S.lpf1)) {
      var up = Math.round(S.lpf1 / 10) * 10 + 20, H = function (f, fc) { return 1 / Math.sqrt(1 + (f / fc) * (f / fc)); };
      var pred = V.psdA.map(function (P) { var s = 0; for (var k = 1; k < P.length; k++) { var f = k * V.df; if (f >= 20) { var r = H(f, up) / H(f, S.lpf1); s += P[k] * r * r * V.df; } } return Math.sqrt(s); }), pMax = Math.max.apply(null, pred);
      if (pMax < Math.min(3, VT.lvl_hint * 0.75) && S.lpf1 <= 140 && !resid.length && V.nyq > S.lpf1 * 1.4)
        R.push({ area: 'Filter', title: 'Tiefpass 1 kann etwas hoeher (weniger Verzoegerung)', obs: 'Die Restvibration ist niedrig (' + f1(hf) + ' deg/s). Mit ' + f0(up) + ' Hz statt ' + f0(S.lpf1) + ' Hz ergibt eine Abschaetzung aus dem Spektrum nur ' + f1(pMax) + ' deg/s. Ein hoeherer Grenzwert verringert die Signalverzoegerung und kann die Regelung straffen.',
          cli: ['set gyro_lpf1_static_hz = ' + up], note: 'Nur testweise und einen Schritt pro Flug: danach Servos (Temperatur, Geraeusch) und Heck beobachten und die Restvibration erneut vergleichen. Das Log reicht nur bis ' + f0(V.nyq) + ' Hz - Anteile darueber sind nicht beurteilbar.' });
      else if (hf >= VT.lvl_warn && !peaks.length && S.lpf1 >= 60)
        R.push({ area: 'Filter', title: 'Breitband-Vibration: Tiefpass 1 senken oder Ursache suchen', obs: 'Die Restvibration ist erhoeht (' + f1(hf) + ' deg/s) ohne einzelne Spitzen - typisch fuer ein breites Rauschen (Lager, Zahnraeder, Servos, Verkabelung).',
          cli: ['set gyro_lpf1_static_hz = ' + (Math.round(S.lpf1 / 10) * 10 - 20)], note: 'Eine Senkung erhoeht die Verzoegerung. Besser zuerst die mechanische Ursache beseitigen.' });
    }
    // Unwucht (1P) unabhaengig von den Filtern
    peaks.filter(function (p) { return p.n === 1 && (V.hasRaw ? p.ampR >= VT.unbal_amp : p.ampA >= 3); }).slice(0, 1).forEach(function (p) {
      R.push({ area: 'Mechanik', title: 'Starke 1P-Vibration (' + f1(p.f) + ' Hz): Unwucht oder Blattspur', obs: 'Die Grundfrequenz des Hauptrotors ist mit ' + f1(V.hasRaw ? p.ampR : p.ampA) + ' deg/s deutlich ausgepraegt. Das ist keine Filter-, sondern eine Mechanik-Frage; Filter blenden sie nur aus.',
        cli: [], note: 'Blaetter auf gleiches Gewicht und gleichen Schwerpunkt pruefen, Blattspur kontrollieren, Rotorkopf/Blatthalter auf Spiel, Hauptwelle und Lager pruefen.' });
    });
    return R;
  }
  var api = { analyze: analyze, findings: findings, recommendations: recommendations, VT: VT, AX: AX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RFV = api;
})(typeof self !== 'undefined' ? self : this);
