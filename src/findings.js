/* Befunde aus dem Analyse-Kern (Motoren, Akku, Regelabweichung, Ruhephasen, Signal) und daraus abgeleitete Empfehlungen */
(function (root) {
  'use strict';
  var A = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./analysis.js') : root.RFA;
  var T = A.THRESH, fnum = A.fnum, fin = A.util.fin;
  var SEV_ORDER = { warn: 0, hint: 1, info: 2, ok: 3 };
  var SEV_LABEL = { warn: 'Handlungsbedarf', hint: 'Hinweis', info: 'Info', ok: 'In Ordnung' };
  // Betaflight-Standardbelegung (Quad X): Motor 1 hinten rechts, 2 vorne rechts, 3 hinten links, 4 vorne links
  var MPOS = ['hinten rechts', 'vorne rechts', 'hinten links', 'vorne links'];
  var f0 = function (x) { return x.toFixed(0); }, f1 = function (x) { return x.toFixed(1); }, f2 = function (x) { return x.toFixed(2); };
  function mname(k, n) { return 'Motor ' + (k + 1) + (n === 4 ? ' (' + MPOS[k] + ')' : ''); }

  function makeFindings(m) {
    var F = [];
    function add(sev, area, title, obs, todo) { F.push({ sev: sev, area: area, title: title, obs: obs || '', todo: todo || '' }); }
    if (!m.ok) { add('info', 'Log', 'Log nicht ausgewertet', m.error || '', ''); return F; }
    if (!m.fw.isBF) add('info', 'Log', 'Kein Betaflight-Log', 'Firmware laut Header: ' + (m.fw.str || 'unbekannt') + '. Die Auswertung ist fuer Betaflight gebaut; Feldnamen und Einheiten anderer Firmwares (INAV, EmuFlight, Rotorflight) koennen abweichen.', '');
    if (m.n_segments > 1) add('info', 'Log', 'Mehrere Flugabschnitte', 'Das Log enthaelt ' + m.n_segments + ' Flugabschnitte; ausgewertet wird der laengste (' + f0(m.flight_s) + ' s).', '');
    // ---------- Motoren ----------
    var mo = m.mot;
    if (mo) {
      var ob = 'Motor-Ausgang im Flug im Mittel ' + f1(mo.mean) + ' % (mittlere Reserve ' + f1(mo.reserve) + ' %), Spitze ' + f1(mo.peak) + ' % bei ' + f0(mo.t_peak) + ' s. Mindestens ein Motor am oberen Anschlag: ' + f2(mo.sat_pct) + ' % der Flugzeit, ueber 95 %: ' + f1(mo.near) + ' %.';
      if (mo.sat_pct >= T.sat_pct_warn) add('warn', 'Motoren', 'Motoren oft am Anschlag', ob, 'Wenn ein Motor auf 100 % steht, kann die Regelung nicht mehr korrigieren (Wackeln bei Vollgas, Schlingern in Kurven). Ursachen: Akku zu schwach, Antrieb zu klein fuer das Gewicht, zu hohe Rates/PIDs. Hilfreich: staerkerer Akku, Propeller mit mehr Steigung/Blaettern, oder motor_output_limit/Throttle-Limit nicht zu hoch ansetzen.');
      else if (mo.sat_pct >= T.sat_pct_hint) add('hint', 'Motoren', 'Motoren zeitweise am Anschlag', ob, 'Kurze Saettigungen bei Vollgas-Manoevern sind normal. Haeufen sie sich, verliert der Copter in diesen Momenten die Lageregelung.');
      else add('ok', 'Motoren', 'Genug Motorreserve', ob);
      if (mo.idle_pct >= T.idle_pct_hint) add('hint', 'Motoren', 'Motoren fallen im Flug auf Leerlauf', 'In ' + f1(mo.idle_pct) + ' % der Flugzeit steht ein Motor trotz Gas auf dem Leerlaufwert - die Regelung hat dann nach unten keinen Spielraum mehr.', 'Airmode pruefen (sollte an sein), Leerlaufwert (dshot_idle_value, in neueren Versionen motor_idle) bzw. Dynamic Idle (dyn_idle_min_rpm) etwas erhoehen.');
      if (fin(mo.imbalance) && mo.per.length === 4) {
        var ob2 = 'Im ruhigen Flug (Sticks mittig) laufen die Motoren mit ' + mo.per.map(function (x, k) { return 'M' + (k + 1) + ' ' + f1(x); }).join(', ') + ' %. Unterschied ' + f1(mo.imbalance) + ' Prozentpunkte; am meisten arbeitet ' + mname(mo.imb_hi, 4) + ', am wenigsten ' + mname(mo.imb_lo, 4) + '.';
        var diag = (mo.imb_hi + mo.imb_lo === 3) ? ' Die beiden liegen diagonal - das spricht eher fuer ein Gier-Drehmoment (verdrehter Motor, unterschiedliche Propeller) als fuer den Schwerpunkt.' : ' Liegen die staerkeren Motoren auf einer Seite, ist meist der Schwerpunkt dorthin verschoben.';
        if (mo.imbalance >= T.imbalance_warn) add('warn', 'Motoren', 'Motoren deutlich ungleich belastet', ob2 + diag, 'Schwerpunkt (Akku-Position) pruefen, Propeller auf Beschaedigung/gleichen Typ, Motoren auf gleichmaessigen Lauf und Lagerspiel pruefen, Motorhalterungen auf Verdrehung.');
        else if (mo.imbalance >= T.imbalance_hint) add('hint', 'Motoren', 'Motoren ungleich belastet', ob2 + diag, 'Akku etwas in Richtung des schwaecher laufenden Motors verschieben bzw. Propeller tauschen und erneut vergleichen.');
        else add('ok', 'Motoren', 'Motoren gleichmaessig belastet', ob2);
      }
      if (fin(m.hover_thr)) add('info', 'Motoren', 'Schwebepunkt', 'Bei ruhigen Sticks steht der Gasstick im Mittel bei ' + f0(m.hover_thr) + ' %, die Motoren bei ' + f0(m.hover_mot) + ' %.' + (m.hover_mot < 20 ? ' Sehr niedrig - typisch fuer einen sehr starken Antrieb; ein Throttle-Limit oder flachere Gaskurve kann die Feinfuehligkeit verbessern.' : m.hover_mot > 55 ? ' Hoch - der Antrieb ist knapp fuer das Gewicht.' : ''), '');
    } else add('info', 'Motoren', 'Keine Motorwerte im Log', 'Das Log enthaelt keine motor[]-Felder.', '');
    // ---------- Akku ----------
    if (!m.hasVolt) add('info', 'Akku', 'Keine Spannungsdaten geloggt', 'In diesem Log fehlt vbatLatest (Feld im Blackbox-Setup nicht aktiv oder kein Spannungssensor).', 'Im Blackbox-Reiter das Feld Batterie aktivieren, dann wird auch der Akku ausgewertet.');
    else {
      var vc = m.v_min_cell;
      var ob3 = 'Start ' + f1(m.v_start) + ' V (' + m.cells + 'S angenommen), tiefster Wert unter Last ' + f1(m.v_min) + ' V (' + f2(vc) + ' V/Zelle)' + (m.hasCurr ? ', Spitzenstrom ' + f0(m.i_peak) + ' A, Spitzenleistung ' + f0(m.p_peak) + ' W, Verbrauch ' + f0(m.mah) + ' mAh (' + f1(m.wh) + ' Wh)' : '') + '.';
      if (vc < T.vcell_load_warn) add('warn', 'Akku', 'Starker Spannungseinbruch unter Last', ob3, 'Akku/Kabel/Stecker pruefen (Innenwiderstand), frischeren oder hoeher belastbaren Akku verwenden, Flugzeit kuerzen.');
      else if (vc < T.vcell_load_hint) add('hint', 'Akku', 'Spannung bricht unter Last spuerbar ein', ob3, 'Beobachten: verschlechtert sich der Wert ueber mehrere Fluege mit demselben Akku, ist er am Ende.');
      else add('ok', 'Akku', 'Spannungseinbruch unkritisch', ob3);
      if (fin(m.v_rest_cell)) {
        var r = m.v_rest_cell;
        if (r < T.vcell_rest_low) add('hint', 'Akku', 'Akku tief entladen gelandet', 'Spannung nach der Landung ' + f2(r) + ' V/Zelle.', 'Flugzeit kuerzen bzw. OSD-Warnung frueher setzen (Richtwert: bei etwa 3,7 V/Zelle Ruhespannung landen).');
        else add('ok', 'Akku', 'Landung mit Reserve', 'Spannung nach der Landung ' + f2(r) + ' V/Zelle.');
      }
      if (!m.hasCurr) add('info', 'Akku', 'Kein Strom geloggt', 'Strom und Verbrauch fehlen (kein Stromsensor oder amperageLatest nicht geloggt).', 'Stromsensor im Reiter Strom & Spannung kalibrieren, dann werden Verbrauch und Leistung berechnet.');
    }
    // ---------- Regelung: Regelabweichung ----------
    var tk = m.track || {}, bad = [], txt = [];
    Object.keys(tk).forEach(function (lab) { var v = tk[lab]; txt.push(lab + ' Median ' + f0(v[0]) + ' / 95 % ' + f0(v[1]) + ' deg/s'); if (v[0] > T.track_med_hint || v[1] > T.track_p95_hint) bad.push(lab); });
    if (txt.length) {
      var obt = 'Abweichung zwischen Soll- und Ist-Drehrate bei Steuerausschlaegen ueber ' + T.track_sp_min + ' deg/s: ' + txt.join('; ') + '.';
      if (bad.length) add('hint', 'Regelung', 'Copter folgt den Sticks nicht genau (' + bad.join(', ') + ')', obt, 'Grosse Abweichungen bei schnellen Bewegungen: Feedforward bzw. P erhoehen; tritt es nur bei Vollausschlag auf, kann es eine Motor-Saettigung sein (Reiter Motoren).');
      else add('ok', 'Regelung', 'Copter folgt den Sticks gut', obt);
    }
    // ---------- Ruhephasen ----------
    if (m.hover_peaks.length) {
      var pk = m.hover_peaks.slice(0, 3).map(function (p) { return p[0] + ' ' + f1(p[1]) + ' Hz (' + f1(p[2]) + 'x ueber Grundpegel)'; }).join(', ');
      add('hint', 'Ruhephasen', 'Schwingung bei ruhigen Sticks', 'Bei mittigen Sticks hebt sich im Gyro-Spektrum eine klare Spitze ab: ' + pk + '.',
        'Unter 10 Hz: meist zu viel I oder Wind/Turbulenz. 10-40 Hz: typisch zu viel P oder zu wenig D (Regelkreis schwingt). Tritt sie bei gleicher Frequenz in mehreren Fluegen auf, Sprungantwort im Reiter Regelung pruefen.');
    } else if (fin(m.wobble)) {
      add(m.wobble >= T.wobble_hint ? 'hint' : 'ok', 'Ruhephasen', m.wobble >= T.wobble_hint ? 'Unruhig bei mittigen Sticks' : 'Ruhig bei mittigen Sticks', 'Gyro-Spektrum bei ruhigen Sticks ohne herausragende Spitze; Eigenbewegung im Band 2-8 Hz: ' + f1(m.wobble) + ' deg/s (aus ' + m.hover_n + ' Fenstern).',
        m.wobble >= T.wobble_hint ? 'Langsames Wackeln ohne klare Frequenz kommt meist von Wind, Turbulenz oder einem zu niedrigen I-Anteil (Copter "driftet" in der Lage). Zuerst bei ruhigem Wetter vergleichen.' : '');
    }
    // ---------- Signal ----------
    var sig = [];
    if (m.rx_loss > 0) sig.push(m.rx_loss + ' Samples ohne Empfaengersignal im Flug');
    if (m.failsafe_active) sig.push('Failsafe war im Flug aktiv');
    if (m.v_zero > 0) sig.push(m.v_zero + ' Samples mit Spannung 0 (Messaussetzer)');
    if (sig.length) add('warn', 'Signal', 'Funk-/Messprobleme', sig.join('; '), 'Antennen (Ausrichtung, Beschaedigung), Empfaengerversorgung und Verkabelung pruefen.');
    else add('ok', 'Signal', 'Funkverbindung sauber', 'Keine Empfaengeraussetzer, kein Failsafe' + (m.hasVolt ? ', keine Spannungs-Nullwerte' : '') + '.');
    if (m.rssi) {
      var rs = m.rssi, o4 = 'RSSI im Flug: Minimum ' + f0(rs.min) + ' %, Median ' + f0(rs.med) + ' %, ' + f1(rs.low_pct) + ' % der Zeit unter ' + T.rssi_low_pct + ' %.';
      if (rs.low_pct >= 20 || rs.min < 10) add('hint', 'Signal', 'Schwaches Empfangssignal', o4, 'Reichweite/Antennen pruefen. Bei ELRS/Crossfire ist die Link-Qualitaet (LQ) aussagekraeftiger als RSSI; RSSI-Skalierung im Configurator (Reiter Empfaenger) kontrollieren.');
      else add('ok', 'Signal', 'Empfangssignal ausreichend', o4);
    }
    return F;
  }
  function overallState(F) { var s = 3; F.forEach(function (f) { s = Math.min(s, SEV_ORDER[f.sev]); }); return { 0: 'warn', 1: 'hint', 2: 'ok', 3: 'ok' }[s]; }

  // Empfehlungen aus Regelabweichung und Ruhephasen (Sprungantwort/Filter liefern eigene)
  function makePidRecommendations(m) {
    var hdr = m.hdr || {}, recs = [], ff = A.param(hdr, 'ff'), tk = m.track || {};
    [['Roll', 0, 'roll'], ['Nick', 1, 'pitch']].forEach(function (ax) {
      var v = tk[ax[0]]; if (!v || !(v[0] > T.track_med_hint || v[1] > T.track_p95_hint)) return;
      if (m.mot && m.mot.sat_pct >= T.sat_pct_hint) return;   // Saettigung erklaert die Abweichung
      var fv = ff.v[ax[1]], cli = [];
      if (fin(fv) && fv > 0) cli.push('set ' + ff.cli[ax[1]] + ' = ' + Math.round(fv * 1.15) + '  # war ' + f0(fv) + ', +15 %');
      recs.push({ area: 'PID ' + ax[0], title: ax[0] + ': Feedforward erhoehen', obs: 'Regelabweichung ' + ax[0] + ': Median ' + f0(v[0]) + ' deg/s, 95-%-Wert ' + f0(v[1]) + ' deg/s bei schnellen Bewegungen - der Copter laeuft dem Stick hinterher.', cli: cli,
        note: fin(fv) ? 'Mit Simplified Tuning: Feedforward-Schieber eine Stufe hoeher. Zu viel Feedforward zeigt sich als Ueberschwingen am Ende von Flips.' : 'Feedforward-Wert steht nicht im Header - im Configurator (PID-Tuning) eine Stufe hoeher stellen.' });
    });
    (m.hover_peaks || []).slice(0, 2).forEach(function (p) {
      var lab = p[0], freq = p[1], k = ['Roll', 'Nick', 'Gier'].indexOf(lab), ax = ['roll', 'pitch', 'yaw'][k], pid = A.nums(hdr[ax + 'PID']), cli = [], title, why;
      if (freq < 10) { if (fin(pid[1])) cli.push('set i_' + ax + ' = ' + Math.round(pid[1] * 0.9) + '  # war ' + f0(pid[1]) + ', -10 %'); title = lab + ': langsames Pendeln (' + f1(freq) + ' Hz)'; why = 'zu hoher I-Anteil oder Wind'; }
      else if (freq <= 40) { if (fin(pid[0])) cli.push('set p_' + ax + ' = ' + Math.round(pid[0] * 0.9) + '  # war ' + f0(pid[0]) + ', -10 %'); title = lab + ': Schwingung bei ' + f1(freq) + ' Hz'; why = 'P zu hoch im Verhaeltnis zu D'; }
      else return;
      recs.push({ area: 'PID ' + lab, title: title, obs: 'Bei ruhigen Sticks Spitze bei ' + f1(freq) + ' Hz (' + f1(p[2]) + 'x ueber Grundpegel) - typisch: ' + why + '.', cli: cli, note: 'Erst gegen die Sprungantwort im Reiter Regelung pruefen. Tritt die Spitze nur bei Wind auf, nichts aendern.' });
    });
    return recs;
  }
  var api = { makeFindings: makeFindings, overallState: overallState, makePidRecommendations: makePidRecommendations, SEV_ORDER: SEV_ORDER, SEV_LABEL: SEV_LABEL, MPOS: MPOS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RFF = api;
})(typeof self !== 'undefined' ? self : this);
