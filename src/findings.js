/* Port von make_findings(), overall_state(), make_pid_recommendations() */
(function (root) {
  'use strict';
  var A = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./analysis.js') : root.RFA;
  var T = A.THRESH, fnum = A.fnum, firstNum = A.firstNum, fin = A.util.fin;
  var SEV_ORDER = { warn: 0, hint: 1, info: 2, ok: 3 };
  var SEV_LABEL = { warn: 'Handlungsbedarf', hint: 'Hinweis', info: 'Info', ok: 'In Ordnung' };
  var f0 = function (x) { return x.toFixed(0); }, f1 = function (x) { return x.toFixed(1); }, f2 = function (x) { return x.toFixed(2); };

  function makeFindings(m) {
    var F = [], hdr = m.hdr || {};
    function add(sev, area, title, obs, todo) { F.push({ sev: sev, area: area, title: title, obs: obs || '', todo: todo || '' }); }
    if (!m.ok) { add('info', 'Log', 'Log nicht ausgewertet', m.error || '', ''); return F; }
    // ---------- Heck ----------
    var y = m.yaw;
    if (y.max !== undefined) {
      var notch = firstNum(hdr.dyn_notch_min_hz), below = fin(notch) && y.f_max < notch, specific = y.ratio >= T.yaw_axis_ratio;
      var axis = specific ? 'fast nur auf der Gier-Achse (Peak ' + f1(y.ratio) + 'x hoeher als auf Roll/Nick) - typisch fuer eine Regelkreis-Schwingung des Hecks'
        : 'auch auf Roll/Nick sichtbar (Gier-Peak nur ' + f1(y.ratio) + 'x hoeher) - kann Gesamtstoerung oder Mechanik sein';
      var obs = 'Bei ruhigem Gier-Stick faellt die staerkste Schwingung bei ' + f1(y.f_max) + ' Hz auf, ' + axis + '. Spitzenwert ' + f0(y.max) + ', typischer Wert ' + f0(y.median) +
        ' (Richtwerte: ab ' + f0(T.yaw_spike_hint) + ' Hinweis, ab ' + f0(T.yaw_spike_warn) + ' Handlungsbedarf).';
      if (below) obs += ' Sie liegt unter der Notch-Filtergrenze (' + f0(notch) + ' Hz) - die Filter koennen hier nichts ausrichten, es muss an der Quelle behoben werden.';
      var todoPid = 'Yaw-P in Schritten von 10-15 % senken (nur einen Wert pro Flug aendern), danach Log vergleichen. Reicht das nicht: yaw_stop_gain senken (laut Rotorflight-Doku kann ein zu hoher Wert schnelle Schwingungen ausloesen) oder Yaw-D pruefen. Rotorflight-Tuning-Doku: schnelle Schwingungen sind typisch fuer zu hohes P bzw. D.';
      var todoMech = 'Mechanik pruefen: Heckantrieb (Riemenspannung/Zahnspiel), Heckrotorlager, Blattgriffe, Rahmenschrauben/Elektronikdaempfung. Zusaetzlich ist eine Yaw-P-Senkung um 10-15 % ein risikoarmer Test.';
      var todo = specific ? todoPid : todoMech;
      if (y.max >= T.yaw_spike_warn) add('warn', 'Heck', 'Heck schwingt bei ruhigem Stick', obs, todo);
      else if (y.max >= T.yaw_spike_hint) add('hint', 'Heck', 'Gelegentliche Heck-Schwingungsspitzen', obs, todo);
      else add('ok', 'Heck', 'Heck ruhig', obs);
    }
    var cp = y.coupling;
    if (cp && cp.n >= 3 && cp.share >= T.coupling_share) {
      add('hint', 'Heck', 'Heck und Drehzahl schwingen gemeinsam',
        'In ' + cp.n + ' Fenstern mit Heck-Schwingung schwingt gleichzeitig auch die Kopfdrehzahl (' + f0(cp.med_hs) + ' U/min RMS im Band 5-20 Hz, sonst typisch ' + f1(cp.med_all) + '); ' + f0(cp.share * 100) + ' % dieser Fenster zeigen das.',
        "Moegliche Kopplung: Laut Rotorflight-Quellcode mischt der Governor den Betrag des Heck-PID-Ausgangs (Gewicht 'Yaw-Vorsteuerung') in die Gas-Vorsteuerung. Schwingt das Heck, schwingt dadurch auch das Gas; bei mechanisch angetriebenem Heck wirkt die Drehzahl zusaetzlich direkt auf den Heckschub. Test: im Governor-Profil die Yaw-Vorsteuerung (und ggf. Cyclic-Vorsteuerung) senken, nur das in einem Flug aendern und vergleichen. Das ist eine Hypothese - belegt ist nur das gemeinsame Auftreten, nicht die Ursache.");
    }
    // ---------- Governor ----------
    var g = m.gov;
    if (g.variable) {
      add('info', 'Governor', 'Variables Drehzahlziel (Ziel folgt dem Gasstick/Kurve)', f0(g.within20) + ' % der Zeit innerhalb +-20 U/min, groesste Abweichung ' + f0(g.maxdev) + '. Ueberschwinger-Statistik ist bei variablem Ziel nicht aussagekraeftig.',
        'Fuer eine saubere Governor-Beurteilung ein festes Ziel fliegen (Gas auf Anschlag/Profilumschaltung).');
    } else if (g.rate !== undefined) {
      var o2 = 'Bei festem Ziel ' + f0(m.target) + ': ' + f0(g.within20) + ' % der Zeit innerhalb +-20 U/min; ' + f0(g.rate) + ' Ueberschwinger (>' + T.over_event_rpm + ' U/min) pro Minute, 99-%-Wert +' + f0(g.p99) + ', groesster +' + f0(g.maxover) + '; untere Seite (1-%-Wert) ' + f0(g.p01) + '.';
      var overDom = g.p99 > 2 * Math.abs(g.p01);
      var td = overDom ? "Die Drehzahl liegt deutlich haeufiger UEBER als UNTER dem Ziel. Laut Rotorflight-Governor-Doku fuehrt ein zu hohes F-Gain dazu, dass die Drehzahl kurzzeitig zu hoch ist (zu niedriges F: sie faellt bei Pitch-Pumps ein). Pruefe daher F-Gain und die Vorsteuerungs-Gewichte Collective/Cyclic/Yaw im Governor-Profil (stehen nicht im Log-Header) und senke sie in 10er-Schritten. Schaue dir die Form an: einmalige Spitze = Vorsteuerung zu hoch; periodisches Pendeln siehe Befund 'Drehzahl pendelt'."
        : 'Die Drehzahl bricht eher ein als sie ueberschiesst: F-Gain bzw. Vorsteuerung (Collective/Cyclic/Yaw) erhoehen (10er-Schritte), dann P/I pruefen und Leistungsreserve (Akku, ESC) kontrollieren.';
      td += ' Flugstil beeinflusst die Zahlen stark - vergleiche nur Fluege mit aehnlicher Belastung.';
      if (g.rate >= T.over_rate_warn || g.p99 >= T.over_p99_hint * 1.5) add('warn', 'Governor', 'Drehzahl schiesst bei Lastwechseln deutlich ueber das Ziel', o2, td);
      else if (g.rate >= T.over_rate_hint || g.p99 >= T.over_p99_hint) add('hint', 'Governor', 'Gelegentliche Drehzahl-Ueberschwinger', o2, td);
      else add('ok', 'Governor', 'Governor haelt die Drehzahl sauber', o2);
      if (g.p01 <= T.under_p01_warn) add('warn', 'Governor', 'Drehzahl bricht unter Last ein', '1-%-Wert der Abweichung ' + f0(g.p01) + ' U/min unter Ziel.',
        'Leistungsreserve pruefen: Akkuzustand/Spannungseinbruch, ESC-Strombegrenzung, Motor-/Uebersetzungsauslegung; F-Gain ggf. erhoehen.');
      var o = m.osc;
      if (o.n >= 20) {
        var pct = 100 * o.n_big / o.n, fmed = o.f.length ? A.util.median(o.f) : NaN;
        var ob = 'In ' + f1(pct) + ' % der 2-Sekunden-Fenster pendelt die Drehzahl periodisch (2-10 Hz, mehr als ' + f0(T.osc_amp_rpm) + ' U/min RMS), typische Frequenz ' + fnum(fmed, 1) + ' Hz, staerkste Episode ' + f0(o.amp_max) + ' U/min RMS.';
        if (pct >= T.osc_pct_hint) add('hint', 'Governor', 'Drehzahl pendelt zeitweise', ob, "Rotorflight-Doku: Zu hohes Governor-P bzw. Master-Gain laesst die Drehzahl pendeln/'surgen'. P-Gain in 10er-Schritten senken (Doku-Regel: P bis zu leichten Schwingungen erhoehen, dann um 1/3 zurueck). Pruefe auch Headspeed-Filter-Cutoff und die RPM-Signalqualitaet. Streut die Frequenz stark, kommt es eher von Lastwechseln als von einer festen Resonanz.");
        else add('ok', 'Governor', 'Kein nennenswertes Drehzahl-Pendeln', ob);
      }
    }
    // Hochlauf / Auslauf
    if (fin(m.spool_down_s) && m.spool_down_s < T.spool_down_loss_s && m.hs_at_cut > 500) {
      add('hint', 'ESC/Telemetrie', 'Drehzahl-Telemetrie bricht nach Gaskappung sofort ab', 'Von ' + f0(m.hs_at_cut) + ' auf 0 in ' + f1(m.spool_down_s) + ' s - ein freilaufender Rotor kann das physikalisch kaum. Entweder meldet der ESC nach der Gaskappung keine RPM mehr, oder er bremst den Rotor aktiv.',
        'Stoppuhr-Test am Boden: laeuft der Rotor mehrere Sekunden aus -> nur Telemetrie. Steht er in unter 1 s -> Bremse im ESC abschalten. Beachte: bei Autorotationsuebungen waere die RPM-Anzeige dann blind.');
    } else if (fin(m.spool_down_s)) {
      add('info', 'Governor', 'Hoch-/Auslauf', 'Hochlauf auf 95 % des Ziels: ' + fnum(m.spool_up_s, 1) + ' s; Auslauf nach Gaskappung: ' + fnum(m.spool_down_s, 1) + ' s.');
    }
    // ---------- Akku / ESC ----------
    var vc = m.v_min_cell;
    if (!m.hasElec) add('info', 'Akku', 'Keine Spannungs-/Stromdaten geloggt', 'In diesem Log fehlen Vbat/Ibat (Telemetrie-Felder nicht im Blackbox-Setup aktiv).', 'Optional: Blackbox-Felder fuer Spannung/Strom aktivieren, dann wird auch der Akku ausgewertet.');
    else {
    var ob2 = 'Start ' + f1(m.v_start) + ' V (' + m.cells + 'S angenommen), tiefster Wert unter Last ' + f1(m.v_min) + ' V (' + f2(vc) + ' V/Zelle), Spitzenstrom ' + f0(m.i_peak) + ' A, Spitzenleistung ' + f1(m.p_peak / 1000) + ' kW, Verbrauch ' + f0(m.mah) + ' mAh (' + f0(m.wh) + ' Wh).';
    if (vc < T.vcell_load_warn) add('warn', 'Akku', 'Starker Spannungseinbruch unter Last', ob2, 'Akku/Kabel/Stecker pruefen, groesseren oder frischeren Akku verwenden, Flugzeit kuerzen.');
    else if (vc < T.vcell_load_hint) add('hint', 'Akku', 'Spannung bricht unter Last spuerbar ein', ob2, 'Beobachten: verschlechtert sich der Wert ueber mehrere Fluege, ist der Akku am Ende.');
    else add('ok', 'Akku', 'Spannungseinbruch unkritisch', ob2);
    if (fin(m.v_rest_cell)) {
      var r = m.v_rest_cell;
      if (r < T.vcell_rest_low) add('hint', 'Akku', 'Akku tief entladen gelandet', 'Ruhespannung nach der Landung ' + f2(r) + ' V/Zelle.', 'Flugzeit kuerzen oder Akku frueher wechseln (Richtwert: ab etwa 3,7-3,8 V/Zelle Ruhespannung landen).');
      else add('ok', 'Akku', 'Landung mit Reserve', 'Ruhespannung nach der Landung ' + f2(r) + ' V/Zelle.');
    }
    }
    var te = m.t_esc_max;
    if (!fin(te)) add('info', 'ESC', 'ESC-Temperatur nicht geloggt', 'ESC-Temperatursensor nicht im Log vorhanden. Aktiviere ESC-Telemetrie fuer Temperaturueberwachung.');
    else {
      var ob3 = 'ESC-Temperatur: Start ' + f0(m.t_esc_start) + ' C, Maximum ' + f0(te) + ' C (Anstieg ' + f0(te - m.t_esc_start) + ' C).';
      if (te >= T.esc_temp_warn) add('warn', 'ESC', 'ESC sehr heiss', ob3, 'Kuehlung/Luftfuehrung verbessern, Flugzeit oder Last reduzieren. Grenzwerte haengen vom ESC ab - Datenblatt pruefen.');
      else if (te >= T.esc_temp_hint) add('hint', 'ESC', 'ESC wird warm', ob3, 'Trend ueber mehrere Fluege beobachten (Kuehlung, Aussentemperatur, mittlere Leistung).');
      else add('ok', 'ESC', 'ESC-Temperatur unkritisch', ob3);
    }
    // ---------- Antrieb ----------
    var mo = m.mot;
    if (mo) {
      var ob4 = 'Motor-Ausgang im stabilen Flug im Mittel ' + f1(mo.mean) + ' % (mittlere Reserve ' + f1(mo.reserve) + ' %), Spitze ' + f1(mo.peak) + ' % bei ' + f0(mo.t_peak) + ' s, ' + f1(mo.near) + ' % der Zeit ueber 95 % (Quelle: ' + mo.src + ').';
      if (mo.near >= 10 || mo.peak >= 99) add('warn', 'Antrieb', 'Antrieb am Limit', ob4, 'Der Governor verlangt mehr Leistung als der Antrieb liefert: Uebersetzung/Ritzel, Motor, Akku (Spannung/Strom) oder Headspeed pruefen.');
      else if (mo.near >= 2 || mo.reserve < 20) add('hint', 'Antrieb', 'Wenig Leistungsreserve', ob4, 'Reserve beobachten; bei Drehzahleinbruechen unter Last Uebersetzung/Akku pruefen.');
      else add('ok', 'Antrieb', 'Gesunde Leistungsreserve', ob4);
    }
    // ---------- Servos ----------
    var bad = [], names = { 0: 'Servo 1', 1: 'Servo 2', 2: 'Servo 3', 3: 'Heck-Servo/Servo 4' };
    Object.keys(m.servo).forEach(function (k) { var s = m.servo[k], w = Math.max(s.pct_lo, s.pct_hi); if (w >= T.servo_limit_pct_warn) bad.push([k, w]); });
    if (bad.length) add('warn', 'Servos', 'Servo laeuft laenger am Endanschlag', bad.map(function (b) { return names[b[0]] + ': ' + f1(b[1]) + ' % der Zeit'; }).join(', '), 'Servoweg/Mixer-Limits, Taumelscheiben-Geometrie und Kollektiv-Range pruefen; beim Heck: Hebelarm/Weg und Yaw-Gain.');
    else { var mx = 0; Object.keys(m.servo).forEach(function (k) { mx = Math.max(mx, m.servo[k].pct_lo, m.servo[k].pct_hi); }); add('ok', 'Servos', 'Kein Servo dauerhaft am Anschlag', 'Hoechster Wert: ' + f2(mx) + ' % der Zeit am Anschlag.'); }
    // ---------- Hover ----------
    if (m.hover_peaks.length) {
      var pk = m.hover_peaks.slice(0, 3).map(function (p) { return p[0] + ' ' + f1(p[1]) + ' Hz (' + f1(p[2]) + 'x ueber Grundpegel)'; }).join(', ');
      add('hint', 'Hover', 'Deutlicher Resonanzpeak im Schwebeflug', 'Bei ruhigen Sticks hebt sich im Gyro-Spektrum eine klare Spitze ab: ' + pk + '.',
        'Eine echte Resonanz zeigt sich als Spitze, nicht als glatter Anstieg zu tiefen Frequenzen. Tritt sie bei gleicher Frequenz in mehreren Fluegen auf, ist die Mechanik (Lager, Spiel, Blattspurlauf, Rahmen) der erste Verdaechtige.');
    } else if (fin(m.wobble)) {
      add('ok', 'Hover', 'Kein Resonanzpeak im Schwebeflug', 'Das Gyro-Spektrum bei ruhigen Sticks faellt glatt ab, ohne herausragende Spitze (Eigenbewegung im Band 2-8 Hz: ' + f1(m.wobble) + ' deg/s RMS). Das ist normale Flugbewegung/Wind, keine Resonanz.');
    }
    // ---------- Signal ----------
    var sig = [];
    if (m.rx_loss > 0) sig.push(m.rx_loss + ' Samples ohne Empfaengersignal im Flug');
    if (m.failsafe_active) sig.push('Failsafe war im Flug aktiv');
    if (m.v_zero > 0) sig.push(m.v_zero + ' Samples mit Spannung 0 (Telemetrie-Aussetzer)');
    if (sig.length) add('warn', 'Signal', 'Funk-/Telemetrieprobleme', sig.join('; '), 'Antennenposition, Empfaengerversorgung, Telemetrie-Verkabelung pruefen.');
    else add('ok', 'Signal', 'Funk und Telemetrie sauber', 'Keine Empfaengeraussetzer, kein Failsafe, keine Spannungs-Nullwerte.');
    if (m.escthr_dead && !m.mot) add('info', 'Antrieb', 'Kein Gas-Wert im Log', 'Weder der ESC noch der Flugregler (motor[0]) liefern einen Gas-Wert, daher ist keine Aussage zur Leistungsreserve moeglich.');
    return F;
  }
  function overallState(F) { var s = 3; F.forEach(function (f) { s = Math.min(s, SEV_ORDER[f.sev]); }); return { 0: 'warn', 1: 'hint', 2: 'ok', 3: 'ok' }[s]; }

  function makePidRecommendations(m) {
    var hdr = m.hdr || {}, recs = [], roll = A.pidParts(hdr.rollPID), pitch = A.pidParts(hdr.pitchPID), yaw = A.pidParts(hdr.yawPID), gov = A.pidParts(hdr.govPID);
    function rv(v) { return Math.round(v); }
    function adj(v, d) { return (isNaN(v)) ? null : Math.max(0, Math.round(v + d)); }
    var track = m.track || {};
    [['Roll', roll, 'roll'], ['Nick', pitch, 'pitch'], ['Gier', yaw, 'yaw']].forEach(function (ax) {
      var axis = ax[0], pid = ax[1], pfx = ax[2];
      if (!track[axis]) return;
      var med = track[axis][0], p95 = track[axis][1], n = track[axis][2], D = pid[2], Fv = pid[3], cli = [], obs;
      if (med > 80 || p95 > 200) {
        obs = 'Regelabweichung ' + axis + ': Median ' + f0(med) + ' deg/s, 95-%-Wert ' + f0(p95) + ' deg/s (' + n + ' Samples). Beides deutlich erhoeht: Feedforward zu schwach oder D zu niedrig.';
        if (!isNaN(Fv)) cli.push('set ' + pfx + '_f_gain = ' + adj(Fv, Math.max(5, Math.round(Fv * 0.15))) + '  # war ' + rv(Fv) + ', +15 % - Feedforward staerken');
        if (!isNaN(D) && D >= 5) cli.push('set ' + pfx + '_d_gain = ' + adj(D, Math.max(3, Math.round(D * 0.10))) + '  # war ' + rv(D) + ', +10 % - Daempfung erhoehen');
      } else if (p95 > 120) {
        obs = 'Regelabweichung ' + axis + ': Median ' + f0(med) + ' deg/s (OK), 95-%-Wert ' + f0(p95) + ' deg/s erhoeht (' + n + ' Samples). Spitzen deuten auf schwaches Feedforward hin.';
        if (!isNaN(Fv)) cli.push('set ' + pfx + '_f_gain = ' + adj(Fv, Math.max(3, Math.round(Fv * 0.10))) + '  # war ' + rv(Fv) + ', +10 % - Feedforward leicht staerken');
      } else return;
      recs.push({ area: 'PID ' + axis, title: axis + ': Feedforward/D-Gain anpassen', obs: obs, cli: cli });
    });
    var g = m.gov || {};
    if (g.rate !== undefined && g.p01 < -60) {
      var P = gov[0], Fv2 = gov[3], cli2 = [];
      if (!isNaN(Fv2)) cli2.push('set gov_f_gain = ' + adj(Fv2, Math.max(5, Math.round(Fv2 * 0.12))) + '  # war ' + rv(Fv2) + ', +12 % - Last-Vorsteuerung staerken');
      if (!isNaN(P)) cli2.push('set gov_p_gain = ' + adj(P, Math.max(3, Math.round(P * 0.10))) + '  # war ' + rv(P) + ', +10 % - falls F allein nicht reicht');
      recs.push({ area: 'PID Governor', title: 'Governor-Droop: Gain erhoehen', obs: 'Governor: 1-%-Wert der Drehzahlabweichung ' + f0(g.p01) + ' U/min unter Ziel (' + f0(m.target) + ' U/min). Einbrechen unter Last deutet auf zu niedrigen Governor-Gain oder Vorsteuerung (F-Gain / Precomp).', cli: cli2 });
    }
    if (g.rate !== undefined && g.p99 > T.over_p99_hint) {
      var F3 = gov[3], cli3 = [];
      if (!isNaN(F3) && g.p99 > T.over_p99_hint * 1.5) cli3.push('set gov_f_gain = ' + adj(F3, -Math.max(3, Math.round(F3 * 0.10))) + '  # war ' + rv(F3) + ', -10 % - Vorsteuerung zuruecknehmen');
      recs.push({ area: 'PID Governor', title: 'Governor-Ueberschwingen: Gain reduzieren', obs: 'Governor: 99-%-Wert der Drehzahlabweichung +' + f0(g.p99) + ' U/min ueber Ziel. Ueberschwingen nach Lastabnahme - Governor-F-Gain oder Vorsteuerung zu hoch.', cli: cli3 });
    }
    var y = m.yaw || {};
    if ((y.max || 0) >= T.yaw_spike_hint && (y.ratio || 0) >= T.yaw_axis_ratio) {
      var Py = yaw[0], cli4 = [];
      if (!isNaN(Py)) { var d = -Math.max(3, Math.round(Py * 0.12)); cli4.push('set yaw_p_gain = ' + Math.max(5, Math.round(Py + d)) + '  # war ' + rv(Py) + ', ' + (d >= 0 ? '+' : '') + d + ' - Yaw-P senken'); }
      var sg = parseFloat(hdr.yaw_stop_gain); if (!isNaN(sg)) cli4.push('set yaw_stop_gain = ' + Math.max(5, Math.round(sg * 0.88)) + '  # war ' + Math.trunc(sg) + ', -12 % - Stop-Gain senken');
      recs.push({ area: 'PID Heck', title: 'Yaw-P/Stop-Gain senken', obs: 'Heck-Schwingung bei ruhigem Stick: Maximum ' + f0(y.max) + ', Spitze bei ' + f1(y.f_max || 0) + ' Hz, achsenspezifisch (Yaw-Achse ' + f1(y.ratio || 0) + 'x staerker). Typisches Zeichen fuer zu hohes Yaw-P oder Yaw-Stop-Gain.', cli: cli4 });
    }
    var main = (m.target || 0) / 60;
    (m.hover_peaks || []).slice(0, 3).forEach(function (p) {
      var lab = p[0], freq = p[1], prom = p[2], cause, action, cli = [];
      var near1 = main > 0 && Math.abs(freq - main) <= 4, near2 = main > 0 && Math.abs(freq - 2 * main) <= 4;
      if (near1) { cause = 'nahe 1/rev des Hauptrotors (' + f1(main) + ' Hz bei ' + f0(m.target) + ' U/min) - typisch fuer Rotor-Unwucht oder Spurlauf-Fehler'; action = 'Zuerst Mechanik: Blatt-/Kopf-Wucht pruefen, dann erneut fliegen. Ist der Peak nach der Wuchtung weg, ist kein Filter noetig. Bleibt er: RPM-Filter auf diesen Bereich einstellen.'; }
      else if (near2) { cause = 'nahe 2/rev des Hauptrotors (' + f1(2 * main) + ' Hz) - kann Spurlauf-Fehler oder Taumelscheiben-Asymmetrie sein'; action = 'Spurlauf aller Blaetter ueberpruefen, dann Wucht-Test.'; }
      else if (freq >= 20 && freq <= 200) { cause = 'moeglicherweise Motorfrequenz oder Getriebe-Harmonie bei ' + f1(freq) + ' Hz'; action = 'Notch-Filter bei dieser Frequenz erwaegen: gyro_notch1_hz oder dyn_notch_min_hz pruefen. Erst Quelle identifizieren (drehzahlabhaengig?), dann filtern.';
        cli = ['# Vorschlag: Notch-Filter bei ' + f0(freq) + ' Hz (Q=3) - erst Ursache pruefen!', 'set gyro_notch1_hz = ' + Math.round(freq), 'set gyro_notch1_cutoff = ' + Math.round(freq / (1 + 1 / 3))]; }
      else return;
      recs.push({ area: 'Filter', title: 'Peak bei ' + f1(freq) + ' Hz (' + lab + ')', obs: 'Gyro-Spektrum-Peak (' + lab + ') bei ' + f1(freq) + ' Hz, ' + f1(prom) + 'x ueber Grundpegel. Ursache: ' + cause + '. ' + action, cli: cli });
    });
    return recs;
  }
  var api = { makeFindings: makeFindings, overallState: overallState, makePidRecommendations: makePidRecommendations, SEV_ORDER: SEV_ORDER, SEV_LABEL: SEV_LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RFF = api;
})(typeof self !== 'undefined' ? self : this);
