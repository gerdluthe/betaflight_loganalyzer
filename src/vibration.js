/* Vibrationsanalyse Betaflight: Welch-Spektrum von ungefiltertem und gefiltertem Gyro, Frequenz ueber Gas,
   Einordnung der Spitzen (feste Resonanz / drehzahlabhaengig), D-Term- und Motor-Rauschen, Filter-Empfehlungen mit CLI */
(function (root) {
  'use strict';
  var A = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./analysis.js') : root.RFA, U = A.util;
  var median = U.median, fin = U.fin;
  var f0 = function (x) { return x.toFixed(0); }, f1 = function (x) { return x.toFixed(1); };
  var AX = ['Roll', 'Nick', 'Gier'];
  var VT = { lvl_hint: 4, lvl_warn: 10, peak_prom: 6, peak_amp: 1.0, att_good: 15, att_poor: 10, fixed_share: 0.6, nbins: 10, motnoise_hint: 2.0, motnoise_warn: 4.0, dterm_hint: 6, dterm_warn: 15 };

  // einseitige Leistungsdichte eines Fensters (Hann, Mittelwert entfernt)
  function psd(y, off, N, fs, w, U2, re, im, out) {
    var i, mean = 0; for (i = 0; i < N; i++) mean += y[off + i]; mean /= N;
    for (i = 0; i < N; i++) { re[i] = (y[off + i] - mean) * w[i]; im[i] = 0; }
    U.fft(re, im);
    var h = N / 2, sc = 2 / (fs * U2);
    for (var k = 0; k <= h; k++) out[k] = (re[k] * re[k] + im[k] * im[k]) * sc * ((k === 0 || k === h) ? 0.5 : 1);
  }
  function bandRms(P, df, lo, hi) { var s = 0; for (var k = 1; k < P.length; k++) { var f = k * df; if (f >= lo && f < hi) s += P[k] * df; } return Math.sqrt(s); }
  function localBase(P, j) {
    var a = []; for (var d = 3; d <= 12; d++) { if (j - d >= 1) a.push(P[j - d]); if (j + d < P.length) a.push(P[j + d]); }
    return Math.max(median(a), 1e-12);
  }

  function analyze(m) {
    var V = { ok: false }, fl = m.fl, fs = m.fs, hdr = m.hdr || {}, i, k, j;
    if (!fl || !m.ok) return V;
    var raw = [0, 1, 2].map(function (q) { return fl.cols['gyroRaw[' + q + ']']; }), adc = [0, 1, 2].map(function (q) { return fl.cols['gyroADC[' + q + ']']; });
    var hasRaw = !!(raw[0] && raw[1] && raw[2]), hasAdc = !!(adc[0] && adc[1] && adc[2]);
    if (!hasAdc) { V.error = 'Keine Gyro-Daten im Log.'; return V; }
    var N = Math.max(256, Math.min(2048, U.pow2near(fs / 2))), n = fl.n, h = N / 2, df = fs / N, nyq = fs / 2;
    if (n < N * 4) { V.error = 'Flugphase zu kurz fuer eine Spektralanalyse.'; return V; }
    var w = U.hann(N), U2 = 0; for (i = 0; i < N; i++) U2 += w[i] * w[i];
    var re = new Float64Array(N), im = new Float64Array(N), tmp = new Float64Array(h + 1);
    var accR = [0, 1, 2].map(function () { return new Float64Array(h + 1); }), accA = [0, 1, 2].map(function () { return new Float64Array(h + 1); });
    var NB = VT.nbins, binR = [], binA = [], binN = new Float64Array(NB), binHz = []; for (j = 0; j < NB; j++) { binR.push(new Float64Array(h + 1)); binA.push(new Float64Array(h + 1)); binHz.push([]); }
    var hop = N >> 1, tt = [], lvR = [], lvA = [], lvT = [], nWin = 0, thr = fl.cols.thr, mHz = fl.cols.motHz, t = fl.t;
    var axD = [0, 1].map(function (q) { return fl.has('axisD[' + q + ']') ? fl.get('axisD[' + q + ']') : null; }), accD = [new Float64Array(h + 1), new Float64Array(h + 1)], hasD = !!(axD[0] && axD[1]);
    for (var s0 = 0; s0 + N <= n; s0 += hop) {
      var ta = 0; for (i = s0; i < s0 + N; i += 4) ta += thr[i]; ta /= Math.ceil(N / 4);
      var b = Math.min(NB - 1, Math.max(0, Math.floor(ta / (100 / NB)))), pr = 0, pa = 0;
      for (k = 0; k < 3; k++) {
        if (hasRaw) { psd(raw[k], s0, N, fs, w, U2, re, im, tmp); for (i = 0; i <= h; i++) { accR[k][i] += tmp[i]; if (k < 2) binR[b][i] += tmp[i] / 2; } var r = bandRms(tmp, df, 20, 1e9); pr += r * r; }
        psd(adc[k], s0, N, fs, w, U2, re, im, tmp); for (i = 0; i <= h; i++) { accA[k][i] += tmp[i]; if (k < 2) binA[b][i] += tmp[i] / 2; } var a = bandRms(tmp, df, 20, 1e9); pa += a * a;
      }
      if (hasD) for (k = 0; k < 2; k++) { psd(axD[k], s0, N, fs, w, U2, re, im, tmp); for (i = 0; i <= h; i++) accD[k][i] += tmp[i]; }
      binN[b]++; if (mHz) binHz[b].push(mHz[s0 + (N >> 1)]);
      tt.push(t[s0 + (N >> 1)]); lvR.push(hasRaw ? Math.sqrt(pr / 3) : NaN); lvA.push(Math.sqrt(pa / 3)); lvT.push(ta); nWin++;
    }
    if (nWin < 6) { V.error = 'Zu wenig Messfenster fuer eine Spektralanalyse (' + nWin + ').'; return V; }
    for (k = 0; k < 3; k++) for (i = 0; i <= h; i++) { accR[k][i] /= nWin; accA[k][i] /= nWin; }
    if (hasD) for (k = 0; k < 2; k++) for (i = 0; i <= h; i++) accD[k][i] /= nWin;
    for (j = 0; j < NB; j++) if (binN[j]) for (i = 0; i <= h; i++) { binR[j][i] /= binN[j]; binA[j][i] /= binN[j]; }
    V = { ok: true, fs: fs, N: N, df: df, nyq: nyq, nWin: nWin, hasRaw: hasRaw, rawSrc: m.rawSrc, psdR: hasRaw ? accR : null, psdA: accA,
      lvl: { t: Float64Array.from(tt), raw: Float64Array.from(lvR), adc: Float64Array.from(lvA), thr: Float64Array.from(lvT) } };
    // Frequenz ueber Gas (Heatmap-Daten) und Motorfrequenz je Gasbereich
    V.thrMap = { nb: NB, n: Array.from(binN), raw: hasRaw ? binR : null, adc: binA, hz: binHz.map(function (a) { return a.length ? median(a) : NaN; }) };
    // Pegel je Achse / Band
    var edges = [0, 20, 80, 200, 500, 1e9], bands = [];
    for (i = 0; i < edges.length - 1; i++) if (edges[i] < nyq - df) bands.push([edges[i], Math.min(edges[i + 1], nyq)]);
    V.bands = bands;
    V.rmsA = accA.map(function (P) { return bands.map(function (b) { return bandRms(P, df, b[0], b[1] + 1e-9); }); });
    V.rmsR = hasRaw ? accR.map(function (P) { return bands.map(function (b) { return bandRms(P, df, b[0], b[1] + 1e-9); }); }) : null;
    V.hfA = accA.map(function (P) { return bandRms(P, df, 20, 1e9); });
    V.hfR = hasRaw ? accR.map(function (P) { return bandRms(P, df, 20, 1e9); }) : null;
    // D-Term: Rauschen oberhalb 80 Hz (bzw. ab halber Nyquist bei niedriger Lograte)
    if (hasD) { var dlo = Math.min(80, nyq / 2); V.psdD = accD; V.dlo = dlo; V.dHF = accD.map(function (P) { return bandRms(P, df, dlo, 1e9); }); V.dLF = accD.map(function (P) { return bandRms(P, df, 1, dlo); }); }
    // Motor-Rauschen: hochfrequentes Zittern des Motor-Ausgangs (%)
    V.motNoise = null;
    if (m.nMot) {
      var mn = [], mlo = Math.min(50, nyq / 2);
      for (k = 0; k < m.nMot; k++) {
        var ma = fl.cols['mot' + k]; if (!ma) continue; var acc = 0, cnt = 0;
        for (var s1 = 0; s1 + N <= n; s1 += N * 2) { psd(ma, s1, N, fs, w, U2, re, im, tmp); var r2 = bandRms(tmp, df, mlo, 1e9); acc += r2 * r2; cnt++; }
        mn.push(cnt ? Math.sqrt(acc / cnt) : NaN);
      }
      V.motNoise = { per: mn, max: Math.max.apply(null, mn.filter(fin)), lo: mlo };
    }
    // Filter-Einstellungen
    var S = A.filterSettings(hdr); V.set = S;
    V.lp_on = fin(S.lpf1_eff) && S.lpf1_eff > 0;
    // Spitzen: im Rohsignal (falls vorhanden) sonst im gefilterten
    var base = hasRaw ? accR : accA, cand = [];
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
    var amp = function (P, jj) { return Math.sqrt((P[jj - 1] + P[jj] + P[jj + 1]) * df); };
    var binsB = hasRaw ? binR : binA, used = []; for (j = 0; j < NB; j++) if (binN[j] >= 3) used.push(j);
    peaks.forEach(function (p) {
      var jj = p.j;
      p.ampR = hasRaw ? Math.max(amp(accR[0], jj), amp(accR[1], jj), amp(accR[2], jj)) : NaN;
      p.ampA = Math.max(amp(accA[0], jj), amp(accA[1], jj), amp(accA[2], jj));
      var pk = p.axis; p.ampRax = hasRaw ? amp(accR[pk], jj) : NaN; p.ampAax = amp(accA[pk], jj);
      p.att = hasRaw ? 20 * Math.log10(Math.max(p.ampRax, 1e-9) / Math.max(p.ampAax, 1e-9)) : NaN;
      // feste Frequenz, wenn die Spitze in den meisten Gasbereichen an derselben Stelle hervortritt
      var hit = 0; used.forEach(function (b) { var Pb = binsB[b], mx = Math.max(Pb[jj - 1], Pb[jj], Pb[jj + 1]); if (mx / localBase(Pb, jj) >= 3) hit++; });
      p.fixed = used.length >= 3 ? hit / used.length >= VT.fixed_share : null;
      p.thrShare = used.length ? hit / used.length : NaN;
      // Motor-Grundfrequenz (eRPM) im Bereich der Spitze?
      p.mot = false; V.thrMap.hz.forEach(function (hz) { if (fin(hz) && Math.abs(p.f - hz) <= Math.max(3 * df, 0.06 * hz)) p.mot = true; });
      p.low = p.f < 40;   // darunter: eher Regelkreis/Flugbewegung als Vibration
      p.over_lpf = V.lp_on && p.f > 1.6 * S.lpf1_eff;
      p.in_dyn = S.dn_count > 0 && fin(S.dn_min) && fin(S.dn_max) && p.f >= S.dn_min && p.f <= S.dn_max;
    });
    peaks.sort(function (a, b) { return (hasRaw ? b.ampR - a.ampR : b.ampA - a.ampA); });
    V.peaks = peaks.slice(0, 12);
    return V;
  }

  function peakClass(p) { return p.mot ? 'auf der Motorfrequenz (Propeller-/Motor-Unwucht)' : p.fixed === true ? 'feste Frequenz bei jedem Gas (Rahmen- oder Bauteil-Resonanz)' : p.fixed === false ? 'nur in einzelnen Gasbereichen (drehzahlabhaengig, Motor/Propeller)' : 'Einordnung unsicher'; }

  // ---- Befunde ----
  function findings(V, m) {
    var F = [];
    function add(sev, title, obs, todo, area) { F.push({ sev: sev, area: area || 'Vibration', title: title, obs: obs, todo: todo || '' }); }
    if (!V || !V.ok) { if (V && V.error) add('info', 'Vibrationsanalyse nicht moeglich', V.error, ''); return F; }
    var S = V.set, lim = 'Das Log enthaelt Frequenzen bis ' + f0(V.nyq) + ' Hz (Abtastrate ' + f0(V.fs) + ' Hz).';
    if (V.fs < 1000) add('info', 'Log-Rate begrenzt die Analyse', lim + ' Motorrauschen liegt bei Quads meist zwischen 150 und 600 Hz und ist damit teilweise unsichtbar; Spitzen nahe der Grenze koennen Spiegelfrequenzen (Aliasing) sein.',
      'Fuer die Filter-Abstimmung im Betaflight Configurator (Reiter Blackbox) die Lograte auf 1-2 kHz stellen und einen Flug von 1-2 Minuten mit allen Gasstellungen loggen.');
    if (!V.hasRaw) add('info', 'Kein ungefiltertes Gyro im Log', 'Es wird nur das gefilterte Gyro ausgewertet. Damit sind nur uebrig gebliebene Schwingungen sichtbar, nicht deren Ursache und die Wirkung der Filter.',
      A.fwGe(m.fw, 4, 3) ? 'Ab Betaflight 4.3 wird gyroUnfilt mitgeloggt, wenn im Blackbox-Reiter das Feld "Gyro (ungefiltert)" aktiv ist.' : 'Vor Betaflight 4.3: debug_mode = GYRO_SCALED setzen (set debug_mode = GYRO_SCALED), dann steht das ungefilterte Gyro in debug[0..2].');
    else if (V.rawSrc && V.rawSrc.indexOf('debug') === 0) add('info', 'Ungefiltertes Gyro aus debug_mode GYRO_SCALED', 'Das Rohsignal vor den Filtern stammt aus debug[0..2].', '');
    // Gesamtpegel (gefiltert, > 20 Hz)
    var wi = 0; V.hfA.forEach(function (x, i) { if (x > V.hfA[wi]) wi = i; });
    var lv = V.hfA[wi], sev = lv >= VT.lvl_warn ? 'warn' : lv >= VT.lvl_hint ? 'hint' : 'ok';
    var lvTxt = V.hfA.map(function (x, i) { return AX[i] + ' ' + f1(x); }).join(', ');
    add(sev, sev === 'ok' ? 'Restvibration nach den Filtern niedrig' : 'Restvibration nach den Filtern erhoeht',
      'Verbleibende Vibration im gefilterten Gyro oberhalb 20 Hz (Effektivwert in deg/s): ' + lvTxt + '. Schwerpunkt: ' + AX[wi] + '. (Richtwerte: unter ' + VT.lvl_hint + ' ruhig, ab ' + VT.lvl_hint + ' Hinweis, ab ' + VT.lvl_warn + ' deutlich.)' +
      (V.hasRaw ? ' Vor den Filtern lag der Pegel bei ' + V.hfR.map(function (x, i) { return AX[i] + ' ' + f1(x); }).join(', ') + '.' : ''),
      sev === 'ok' ? '' : 'Zuerst die Mechanik pruefen (Propeller auf Macken/Unwucht, Motorlager, lockere Schrauben, Rahmenarme, FC-Softmounts, Kabel am Rahmen), erst danach die Filter verschaerfen - Filter verdecken Probleme und kosten Verzoegerung.');
    // Filterwirkung
    if (V.hasRaw) {
      var att = V.hfR.map(function (r, i) { return 20 * Math.log10(Math.max(r, 1e-9) / Math.max(V.hfA[i], 1e-9)); }), act = [];
      if (fin(S.lpf1_eff) && S.lpf1_eff > 0) act.push('Gyro-Tiefpass 1 ' + (S.lpf1_dyn ? 'dynamisch ' + f0(S.lpf1_dmin) + '-' + f0(S.lpf1_dmax) : 'bei ' + f0(S.lpf1)) + ' Hz');
      if (S.lpf2 > 0) act.push('Tiefpass 2 bei ' + f0(S.lpf2) + ' Hz');
      if (S.dn_count > 0) act.push('dynamischer Notch (' + f0(S.dn_count) + ' Stueck, ' + f0(S.dn_min) + '-' + f0(S.dn_max) + ' Hz)');
      if (S.rpm_on) act.push('RPM-Filter (' + f0(S.rpm_harm) + ' Harmonische)');
      if (S.notch.length) act.push('statischer Notch bei ' + S.notch.map(f0).join('/') + ' Hz');
      add('info', 'Filterwirkung', 'Die Filter daempfen die Vibration oberhalb 20 Hz um ' + att.map(function (a, i) { return AX[i] + ' ' + f0(a) + ' dB'; }).join(', ') + ' (6 dB = halbe Amplitude, 20 dB = ein Zehntel).' + (act.length ? ' Aktiv: ' + act.join(', ') + '.' : ''), '', 'Filter');
    }
    if (!S.rpm_on) add(S.bidir ? 'hint' : 'info', 'RPM-Filter nicht aktiv', S.bidir ? 'Bidirektionales DShot ist an, aber der RPM-Filter hat 0 Harmonische.' : 'Bidirektionales DShot ist aus - ohne Motordrehzahl kann der RPM-Filter nicht arbeiten.',
      'Der RPM-Filter entfernt Motorrauschen sehr genau und erlaubt deutlich lockerere Tiefpaesse (weniger Verzoegerung, weniger Propwash). Voraussetzung: ESC-Firmware mit bidirektionalem DShot (BLHeli_32, Bluejay, AM32) und die richtige Polzahl (motor_poles).', 'Filter');
    // Motor-RPM-Telemetrie
    if (m.mot && m.mot.rpm && m.mot.rpm.zero_pct > 1) add('hint', 'Luecken in der Motor-Drehzahl', f1(m.mot.rpm.zero_pct) + ' % der eRPM-Werte sind im Flug 0 - die RPM-Telemetrie hat Aussetzer, der RPM-Filter arbeitet dann kurz blind.', 'ESC-Firmware/Verkabelung pruefen; bei Bluejay/BLHeli_S: DShot-Rate (dshot300/600) und PID-Loop-Rate passend waehlen.', 'Filter');
    // Spitzen
    var P = V.peaks.filter(function (p) { return (V.hasRaw ? p.ampR : p.ampA) >= VT.peak_amp; }), shown = 0, good = 0;
    P.forEach(function (p) {
      var axs = AX.filter(function (a, i) { return p.axes[i]; }).join('/');
      if (p.low) {
        if (p.ampA >= 3) add('hint', 'Langsame Schwingung bei ' + f1(p.f) + ' Hz (' + axs + ')', 'Im gefilterten Gyro steht eine deutliche Spitze bei ' + f1(p.f) + ' Hz mit ' + f1(p.ampA) + ' deg/s. So tiefe Frequenzen kommen meist aus dem Regelkreis selbst, nicht von Motoren oder Propellern.',
          'Typisch fuer zu viel P oder zu wenig D (bei 10-30 Hz) bzw. zu viel I (unter 10 Hz). Sprungantwort im Reiter Regelung pruefen. Filter helfen hier nicht - sie wuerden die Regelung nur weiter verzoegern.', 'Regelung');
        return;
      }
      if (V.hasRaw && p.att >= VT.att_good) { good++; return; }
      if (shown >= 4) return; shown++;
      var ob = 'Spitze bei ' + f1(p.f) + ' Hz (' + axs + ') - ' + peakClass(p) + '. ' + (V.hasRaw ? 'Roh ' + f1(p.ampR) + ' deg/s, nach den Filtern ' + f1(p.ampA) + ' deg/s (Daempfung ' + f0(p.att) + ' dB).' : 'Amplitude ' + f1(p.ampA) + ' deg/s.');
      var sv = (p.ampA >= 3 && !p.over_lpf) ? 'hint' : 'info', todo;
      if (p.over_lpf) todo = 'Liegt klar oberhalb des Gyro-Tiefpasses (' + f0(S.lpf1_eff) + ' Hz) und wird davon gedaempft - keine Filteraenderung noetig.';
      else if (p.mot) todo = 'Liegt auf der Motor-Grundfrequenz: Propeller tauschen/wuchten, Motorglocke und -lager pruefen. Der RPM-Filter ' + (S.rpm_on ? 'sollte diese Spitze erfassen - pruefe rpm_filter_q.' : 'wuerde sie gezielt entfernen.');
      else if (p.fixed) todo = 'Feste Frequenz: typisch Rahmenresonanz, lockerer Arm, Antenne, Kabel oder FC-Halterung. Mechanisch suchen (abklopfen, Schrauben nachziehen). ' + (p.in_dyn ? 'Sie liegt im Bereich des dynamischen Notch (' + f0(S.dn_min) + '-' + f0(S.dn_max) + ' Hz).' : S.dn_count > 0 ? 'Sie liegt ausserhalb des dynamischen Notch-Bereichs (' + f0(S.dn_min) + '-' + f0(S.dn_max) + ' Hz): Bereich erweitern oder statischen Notch setzen.' : 'Dynamischer Notch ist aus: aktivieren oder einen statischen Notch auf diese Frequenz setzen.');
      else todo = 'Wandert mit dem Gas: Motor-/Propellerrauschen. ' + (S.rpm_on ? 'Der RPM-Filter sollte das abdecken - Harmonische (' + f0(S.rpm_harm) + ') und Q pruefen.' : 'Der RPM-Filter ist dafuer das beste Mittel.');
      add(sv, 'Spitze bei ' + f1(p.f) + ' Hz', ob, todo);
    });
    if (V.hasRaw && good) add('ok', good + ' Spitze' + (good > 1 ? 'n' : '') + ' im Rohsignal gut ausgefiltert', 'Diese Frequenzen sind im Rohsignal sichtbar, werden aber um mindestens ' + VT.att_good + ' dB gedaempft - die Filter arbeiten hier wie vorgesehen.', '');
    if (!P.filter(function (p) { return !p.low; }).length) add('ok', 'Keine auffaelligen Spitzen', 'Im Spektrum gibt es keine deutlichen Einzelspitzen oberhalb von 40 Hz.', '');
    // D-Term
    if (V.dHF) {
      var dh = Math.max(V.dHF[0], V.dHF[1]), ds = dh >= VT.dterm_warn ? 'warn' : dh >= VT.dterm_hint ? 'hint' : 'ok';
      add(ds, ds === 'ok' ? 'D-Term ruhig' : 'D-Term rauscht', 'Hochfrequenter Anteil des D-Terms oberhalb ' + f0(V.dlo) + ' Hz: Roll ' + f1(V.dHF[0]) + ', Nick ' + f1(V.dHF[1]) + ' (PID-Einheiten, Effektivwert; Richtwerte ab ' + VT.dterm_hint + ' Hinweis, ab ' + VT.dterm_warn + ' deutlich). D verstaerkt Rauschen am staerksten - es landet direkt in den Motoren.' +
        (fin(S.dlpf1_eff) ? ' D-Term-Tiefpass 1: ' + (S.dlpf1_dyn ? 'dynamisch ' + f0(S.dlpf1_dmin) + '-' + f0(S.dlpf1_dmax) : f0(S.dlpf1)) + ' Hz' + (S.dlpf2 > 0 ? ', Tiefpass 2: ' + f0(S.dlpf2) + ' Hz' : '') + '.' : ''),
        ds === 'ok' ? '' : 'Erst Gyro-Rauschen an der Quelle senken (Spitzen oben), dann D-Term-Tiefpass etwas senken - oder D reduzieren. Nach dem Flug die Motortemperatur fuehlen.', 'Filter');
    }
    // Motor-Rauschen
    if (V.motNoise && fin(V.motNoise.max)) {
      var mx = V.motNoise.max, ms = mx >= VT.motnoise_warn ? 'warn' : mx >= VT.motnoise_hint ? 'hint' : 'ok';
      add(ms, ms === 'ok' ? 'Motor-Ausgang ruhig' : 'Motor-Ausgang zittert (Waerme)', 'Hochfrequentes Zittern der Motorbefehle oberhalb ' + f0(V.motNoise.lo) + ' Hz: ' + V.motNoise.per.map(function (x, i) { return 'M' + (i + 1) + ' ' + f1(x); }).join(', ') + ' % (Effektivwert; Richtwerte ab ' + VT.motnoise_hint + ' % Hinweis, ab ' + VT.motnoise_warn + ' % deutlich).',
        ms === 'ok' ? '' : 'Dieses Zittern heizt die Motoren und kostet Akku. Ursache ist fast immer Rauschen im D-Term: Gyro-/D-Term-Filter verschaerfen oder D senken, Propeller und Motoren pruefen.', 'Motoren');
    }
    return F;
  }

  // ---- Filter-Empfehlungen (Betaflight-CLI, Namen je nach Firmware-Version) ----
  function recommendations(V, m) {
    var R = [];
    if (!V || !V.ok) return R;
    var S = V.set, hf = Math.max.apply(null, V.hfA), peaks = V.peaks.filter(function (p) { return (V.hasRaw ? p.ampR : p.ampA) >= VT.peak_amp; });
    var resid = peaks.filter(function (p) { return !p.low && !p.over_lpf && p.ampA >= 2.5 && (!V.hasRaw || p.att < VT.att_poor); });
    resid.slice(0, 2).forEach(function (p) {
      if (p.fixed && !p.mot) {
        if (S.dn_count > 0 && p.in_dyn) {
          if (S.dn_count_cli && S.dn_count < 5) R.push({ area: 'Filter', title: 'Dynamischen Notch erweitern (' + f1(p.f) + ' Hz)', obs: 'Feste Spitze bei ' + f1(p.f) + ' Hz bleibt mit ' + f1(p.ampA) + ' deg/s uebrig, obwohl sie im Notch-Bereich liegt.', cli: ['set dyn_notch_count = ' + (S.dn_count + 1)] });
          else R.push({ area: 'Filter', title: 'Statischen Notch setzen (' + f1(p.f) + ' Hz)', obs: 'Feste Spitze bei ' + f1(p.f) + ' Hz bleibt trotz dynamischem Notch mit ' + f1(p.ampA) + ' deg/s uebrig.', cli: ['set gyro_notch1_hz = ' + Math.round(p.f), 'set gyro_notch1_cutoff = ' + Math.round(p.f * 0.8)], note: 'Ein statischer Notch kostet dauerhaft Verzoegerung im Bereich darunter. Besser zuerst die mechanische Ursache suchen.' });
        } else if (S.dn_count > 0 && fin(S.dn_min)) R.push({ area: 'Filter', title: 'Notch-Bereich anpassen (' + f1(p.f) + ' Hz)', obs: 'Feste Spitze bei ' + f1(p.f) + ' Hz liegt ausserhalb des dynamischen Notch-Bereichs (' + f0(S.dn_min) + '-' + f0(S.dn_max) + ' Hz).',
          cli: [p.f > S.dn_max ? 'set dyn_notch_max_hz = ' + Math.ceil((p.f + 30) / 10) * 10 : 'set dyn_notch_min_hz = ' + Math.max(Math.floor((p.f - 15) / 10) * 10, 60)] });
        else R.push({ area: 'Filter', title: 'Dynamischen Notch aktivieren (' + f1(p.f) + ' Hz)', obs: 'Feste Spitze bei ' + f1(p.f) + ' Hz bleibt ungefiltert (' + f1(p.ampA) + ' deg/s).', cli: S.dn_count_cli || A.fwGe(m.fw, 4, 3) ? ['set dyn_notch_count = 1'] : A.fwGe(m.fw, 3, 3) ? ['feature DYNAMIC_FILTER'] : [], note: A.fwGe(m.fw, 3, 3) ? '' : 'Diese Firmware ist sehr alt und hat noch keinen dynamischen Notch - ein Update auf ein aktuelles Betaflight bringt hier am meisten.' });
      } else if (!S.rpm_on) R.push({ area: 'Filter', title: 'RPM-Filter einrichten (' + f1(p.f) + ' Hz)', obs: 'Drehzahlabhaengiges Rauschen bei ' + f1(p.f) + ' Hz bleibt mit ' + f1(p.ampA) + ' deg/s uebrig.', cli: ['set dshot_bidir = ON', 'set ' + A.param(m.hdr, 'rpm_harm').cli + ' = 3', 'set motor_poles = ' + S.poles], note: 'Nur mit ESC-Firmware, die bidirektionales DShot kann (BLHeli_32, Bluejay, AM32). motor_poles = Anzahl Magnete der Glocke (meist 14). Danach in den Motoren-Reiter schauen, ob Drehzahlen ankommen.' });
      else R.push({ area: 'Filter', title: 'RPM-Filter breiter einstellen (' + f1(p.f) + ' Hz)', obs: 'Drehzahlabhaengige Spitze bei ' + f1(p.f) + ' Hz bleibt trotz RPM-Filter mit ' + f1(p.ampA) + ' deg/s uebrig.', cli: fin(S.rpm_q) ? ['set ' + S.rpm_q_cli + ' = ' + Math.max(250, Math.round(S.rpm_q * 0.8))] : [], note: 'Kleinerer Q = breitere Notches. Pruefe auch, ob motor_poles stimmt (Spitze genau auf einem Vielfachen der Motorfrequenz?).' });
    });
    // Tiefpass-Reserve bzw. Verschaerfung (Gyro-Tiefpass 1)
    if (V.lp_on && fin(S.lpf1_eff)) {
      var cur = S.lpf1_eff, up = Math.round(cur * 1.2 / 10) * 10, H = function (f, fc) { return 1 / Math.sqrt(1 + (f / fc) * (f / fc)); };
      var pred = V.psdA.map(function (P) { var s = 0; for (var k = 1; k < P.length; k++) { var f = k * V.df; if (f >= 20) { var r = H(f, up) / H(f, cur); s += P[k] * r * r * V.df; } } return Math.sqrt(s); }), pMax = Math.max.apply(null, pred);
      var SM = A.simplified(m.hdr || {}), gm = function (r) { return ['set simplified_gyro_filter_multiplier = ' + Math.round(SM.gm * r / 5) * 5 + '  # war ' + f0(SM.gm)]; };
      var cli = SM.gyro && fin(SM.gm) ? gm(up / cur) : S.lpf1_dyn ? ['set ' + S.lpf1_dyn_cli[0] + ' = ' + up, 'set ' + S.lpf1_dyn_cli[1] + ' = ' + Math.round(S.lpf1_dmax * up / cur / 10) * 10] : ['set ' + S.lpf1_cli + ' = ' + up];
      if (pMax < Math.min(3, VT.lvl_hint * 0.75) && !resid.length && V.nyq > cur * 1.4 && V.hasRaw)
        R.push({ area: 'Filter', title: 'Gyro-Tiefpass kann hoeher (weniger Verzoegerung)', obs: 'Die Restvibration ist niedrig (' + f1(hf) + ' deg/s). Mit ' + f0(up) + ' Hz statt ' + f0(cur) + ' Hz ergibt eine Abschaetzung aus dem Spektrum nur ' + f1(pMax) + ' deg/s. Weniger Filterverzoegerung hilft gegen Propwash und strafft die Regelung.',
          cli: cli, note: 'Einen Schritt pro Flug, danach Motortemperatur fuehlen und die Restvibration hier vergleichen. Mit Simplified Tuning: Gyro-Filter-Schieber eine Stufe hoeher. Das Log reicht nur bis ' + f0(V.nyq) + ' Hz.' });
      else if (hf >= VT.lvl_warn && !peaks.length && cur >= 100 && V.nyq > cur * 1.2) {
        var dn = Math.round(cur * 0.8 / 10) * 10;
        R.push({ area: 'Filter', title: 'Breitband-Vibration: Gyro-Tiefpass senken oder Ursache suchen', obs: 'Die Restvibration ist erhoeht (' + f1(hf) + ' deg/s) ohne einzelne Spitzen - typisch fuer ein breites Rauschen (beschaedigte Propeller, Lager, weicher Rahmen).',
          cli: SM.gyro && fin(SM.gm) ? gm(0.8) : S.lpf1_dyn ? ['set ' + S.lpf1_dyn_cli[0] + ' = ' + dn, 'set ' + S.lpf1_dyn_cli[1] + ' = ' + Math.round(S.lpf1_dmax * 0.8 / 10) * 10] : ['set ' + S.lpf1_cli + ' = ' + dn], note: 'Eine Senkung erhoeht die Verzoegerung. Besser zuerst die mechanische Ursache beseitigen.' });
      }
    }
    // D-Term-Tiefpass
    if (V.dHF && Math.max(V.dHF[0], V.dHF[1]) >= VT.dterm_hint && fin(S.dlpf1_eff) && S.dlpf1_eff > 0 && V.nyq > S.dlpf1_eff * 1.2) {
      var dd = Math.round(S.dlpf1_eff * 0.85 / 5) * 5, SMd = A.simplified(m.hdr || {});
      R.push({ area: 'Filter', title: 'D-Term-Tiefpass senken', obs: 'Der D-Term rauscht oberhalb ' + f0(V.dlo) + ' Hz (Roll ' + f1(V.dHF[0]) + ', Nick ' + f1(V.dHF[1]) + ').',
        cli: SMd.dterm && fin(SMd.dm) ? ['set simplified_dterm_filter_multiplier = ' + Math.round(SMd.dm * 0.85 / 5) * 5 + '  # war ' + f0(SMd.dm)] : S.dlpf1_dyn ? ['set ' + S.dlpf1_dyn_cli[0] + ' = ' + dd, 'set ' + S.dlpf1_dyn_cli[1] + ' = ' + Math.round(S.dlpf1_dmax * 0.85 / 5) * 5] : ['set ' + S.dlpf1_cli + ' = ' + dd], note: 'Mit Simplified Tuning: D-Term-Filter-Schieber eine Stufe niedriger. Danach Propwash vergleichen - mehr D-Filter kostet Daempfung.' });
    }
    // Unwucht auf Motorfrequenz
    peaks.filter(function (p) { return p.mot && (V.hasRaw ? p.ampR : p.ampA) >= 3; }).slice(0, 1).forEach(function (p) {
      R.push({ area: 'Mechanik', title: 'Vibration auf der Motorfrequenz (' + f1(p.f) + ' Hz): Propeller/Motor', obs: 'Die Motor-Grundfrequenz ist mit ' + f1(V.hasRaw ? p.ampR : p.ampA) + ' deg/s deutlich ausgepraegt. Das ist keine Filter-, sondern eine Mechanik-Frage.',
        cli: [], note: 'Propeller auf Macken pruefen und tauschen, Motorglocken auf Spiel und Lager auf Rauheit pruefen (von Hand drehen), Motorschrauben kontrollieren.' });
    });
    return R;
  }
  var api = { analyze: analyze, findings: findings, recommendations: recommendations, VT: VT, AX: AX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RFV = api;
})(typeof self !== 'undefined' ? self : this);
