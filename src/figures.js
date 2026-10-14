/* Baut die Diagramme (Charts.figure) aus Analyse-Ergebnis m und Plot-Daten P. */
(function (root) {
  'use strict';
  var Ch = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./charts.js') : root.Charts, C = Ch.C;
  var CAP = {
    overview: 'Oben Drehzahl gegen Ziel, darunter Strom/Spannung, ESC-Temperatur und wie viel du an den Sticks gemacht hast. Gelb = Hochlauf. Gestrichelte Linien: staerkster Ueberschwinger (orange) und staerkste Heck-Schwingung (lila).',
    governor: 'Links der groesste Drehzahl-Ausreisser im Detail (grau = Kollektiv-Stick). Rechts, wie oft welche Abweichung vom Ziel vorkam - logarithmisch, jede Stufe nach oben ist zehnmal mehr. Je steiler der Berg an der Null, desto besser haelt der Governor.',
    load: 'Zeigt, bei welcher Kollektivstellung die Drehzahl vom Ziel abweicht. Hohe orange Maxima bei niedrigem/negativem Kollektiv = Drehzahl schiesst bei Lastabnahme hoch (Hinweis auf F-Gain/Vorsteuerung). Rote Einbrueche bei hohem Kollektiv = Last/Leistungsreserve.',
    yaw: 'Links: jeder Strich = eine Sekunde mit ruhigem Gier-Stick; Striche ueber der orangen Linie sind auffaellig. Rechts das Spektrum im schlimmsten Moment: eine Spitze nur bei Gier (lila) = Regelkreis des Hecks schwingt.',
    spectro: 'Zeit nach rechts, Frequenz nach oben, hell = stark. Die oberen drei Felder zeigen Roll, Nick und Gier; senkrechte helle Streifen in allen dreien sind Manoever und normal. Das rote Feld unten zeigt NUR, wo das Heck staerker schwingt als Roll/Nick.',
    hover: 'Gyro-Spektrum nur aus ruhigen Schwebeflug-Phasen. Ein glatter Abfall nach rechts ist normale Bewegung/Wind. Nur eine echte Spitze (rot markiert) deutet auf eine Resonanz hin.',
    servos: 'Wie oft welcher Stellwert vorkam (logarithmisch). Hohe Balken ganz am Rand = Servo laeuft am Anschlag.',
    vib: 'Vibrations-Spektrum je Achse (Schwebeflug/ruhiger Flug bei stabiler Drehzahl). Orange = Rohsignal vor den Filtern, blau = nach den Filtern. Violette Linien markieren Vielfache der Kopfdrehzahl (1P, 2P, ...), gelb unterlegt ist der Bereich des dynamischen Notch, die rote Linie der Tiefpass 1. Je weiter blau unter orange, desto besser filtern die Filter - eine blaue Spitze ist uebrig gebliebene Vibration.',
    viblevel: 'Vibrationspegel (Effektivwert oberhalb 20 Hz) ueber den Flug, vor und nach den Filtern, dazu die Kopfdrehzahl. Anstiege im Pegel bei Manoevern sind normal; ein dauerhaft hoher blauer Pegel deutet auf Restvibration hin.',
    govterms: 'Oben die Drehzahl-Abweichung vom Ziel (grau: +-20 U/min). Darunter die Anteile des Governors am Gas-Ausgang: P reagiert auf die Abweichung, F ist die Vorsteuerung aus Kollektiv und Zyklik, D daempft. Unten der I-Anteil, der die Grundlast traegt und langsam nachregelt.',
    power: 'Motor-Ausgang des Flugreglers, Strom, Spannung und ESC-Temperatur im Flug. Flache Spitzen an der roten Linie = Antrieb am Limit.',
    battery: 'Links die Packspannung, rechts die Spannung pro Zelle ueber der verbrauchten Kapazitaet.' };
  function masked(a, f) { var o = new Float64Array(a.length); for (var i = 0; i < a.length; i++) o[i] = f(a[i]) ? a[i] : NaN; return o; }
  function toArr(a) { return a; }
  function hasData(a) { if (!a) return false; for (var i = 0; i < a.length; i += Math.max(1, a.length >> 6)) if (a[i] === a[i]) return true; return false; }

  function overview(el, m, P) {
    var t = P.t, xl = [t[0], t[t.length - 1]], spans = [], vl = [];
    if (isFinite(m.spool_up_s)) spans.push({ x0: m.t0, x1: m.t0 + m.spool_up_s, color: 'rgba(251,191,36,.25)' });
    if (m.gov.t_worst !== undefined) vl.push({ x: m.gov.t_worst, color: C.orange, label: 'staerkster Ueberschwinger', row: 0 });
    if (m.yaw.t_max !== undefined) vl.push({ x: m.yaw.t_max, color: C.purple, label: 'staerkste Heck-Schwingung', row: 1 });
    var base = { xlim: xl, spans: spans, vlines: vl, xticks: false };
    function P1(o) { return Object.assign({}, base, o); }
    Ch.figure(el, { caption: CAP.overview, rows: [
      { h: 150, panels: [P1({ title: 'Flug auf einen Blick', ylabel: 'U/min', series: [{ x: t, y: P.hs, color: C.blue, label: 'Kopfdrehzahl' }, { x: t, y: masked(P.tgt, function (v) { return v > 0; }), color: C.orange, dash: 'dash', label: 'Governor-Ziel' }], legend: 'bottom' })] },
      { h: 120, panels: [P1({ ylabel: 'Strom [A]', y2label: 'Spannung [V]', series: [{ x: t, y: P.I, color: C.red, width: .8 }, { x: t, y: P.V, color: C.green, axis: 'y2' }], y2: true, ylim: null })] },
      { h: 100, panels: [P1({ ylabel: 'ESC [C]', series: [{ x: t, y: P.Tesc, color: C.purple }] })] },
      { h: 110, panels: [P1({ ylabel: 'Stick-Aktivitaet', xlabel: 'Zeit [s]', xticks: true, series: [{ x: t, y: P.stick, color: C.grey, fill: true }] })] }] });
  }
  function governor(el, m, P) {
    var g = m.gov, F = P.fl, left, right;
    if (P.gwin) {
      var w = P.gwin, ser = [{ x: w.t, y: w.hs, color: C.blue, label: 'Kopfdrehzahl' }, { x: w.t, y: w.tg, color: C.orange, dash: 'dash', label: 'Ziel' }];
      if (w.rc3) ser.push({ x: w.t, y: w.rc3, color: C.grey, axis: 'y2', width: .8 });
      left = { title: 'Groesster Ueberschwinger (+' + g.maxover.toFixed(0) + ' U/min)', xlabel: 'Zeit [s]', ylabel: 'U/min', y2label: w.rc3 ? 'Kollektiv-Stick' : null, y2: !!w.rc3, series: ser, legend: 'left' };
      var h = Ch.hist(P.gerr, -200, 300, 70);
      right = { title: 'Verteilung (log)', xlabel: 'Abweichung vom Ziel [U/min]', ylabel: 'Anzahl Samples (log)', ylog: true, series: [{ x: h.x, y: h.y, bars: true, bw: h.w, color: C.blue }], vlines: [{ x: 0, color: '#d5dcee', dash: '' }, { x: T().over_event_rpm, color: C.red, dash: 'dash' }], xlim: [-200, 300] };
    } else {
      left = { title: 'Variables Ziel - Ist (blau) und Ziel (orange)', xlabel: 'Zeit [s]', ylabel: 'U/min', series: [{ x: F.t, y: F.hs, color: C.blue, width: .8 }, { x: F.t, y: F.tg, color: C.orange, dash: 'dash', width: .8 }] };
      var h2 = Ch.hist(P.gerr, -100, 100, 60);
      right = { title: 'Abweichung Ist-Ziel', xlabel: 'U/min', series: [{ x: h2.x, y: h2.y, bars: true, bw: h2.w, color: C.blue }], xlim: [-100, 100] };
    }
    Ch.figure(el, { caption: CAP.governor, rows: [{ h: 230, widths: [1.6, 1], panels: [left, right] }] });
  }
  function T() { return (root.RFA || require('./analysis.js')).THRESH; }
  function load(el, m, P) {
    if (!P.load) return; var ok = P.load.filter(function (b) { return b.n > 50; }); if (ok.length < 2) return;
    function col(k) { return Float64Array.from(ok.map(function (b) { return b[k]; })); }
    var x = col('c');
    Ch.figure(el, { caption: CAP.load, rows: [{ h: 230, widths: [1.7, 1], panels: [
      { title: 'Drehzahlabweichung nach Kollektivstellung', xlabel: 'Kollektiv-Stick (negativ = Lastabnahme, positiv = Last)', ylabel: 'Abweichung vom Ziel [U/min]', legend: 'left',
        series: [{ x: x, y: col('q95'), color: C.blue, width: .7, dash: 'dash' }, { x: x, y: col('q05'), color: C.blue, width: .7, dash: 'dash' }, { x: x, y: col('q50'), color: C.blue, width: 2, label: 'Median (gestrichelt: 90 % der Zeit)' },
          { x: x, y: col('mx'), color: C.orange, label: 'Maximum (zu schnell)', width: 1.2 }, { x: x, y: col('mn'), color: C.red, label: 'Minimum (zu langsam)', width: 1.2 }], hlines: [{ y: 0, color: '#d5dcee', dash: '' }] },
      { title: 'So lange war der Stick dort', xlabel: 'Kollektiv-Stick', ylabel: 'Zeit [s]', series: [{ x: x, y: Float64Array.from(ok.map(function (b) { return b.n / m.fs; })), bars: true, bw: 85, color: C.grey }] }] }] });
  }
  function yaw(el, m, P) {
    var y = m.yaw; if (y.max === undefined) return; var th = T(), ys = P.yspec, ser = [];
    var right = { title: 'Spektrum im staerksten Fenster (t=' + y.t_max.toFixed(0) + ' s)', xlabel: 'Hz', series: [], spans: [{ x0: 8, x1: 20, color: 'rgba(251,191,36,.2)' }], xlim: [2, 40] };
    if (ys) [['Gier', 2, C.purple], ['Roll', 0, C.blue], ['Nick', 1, C.green]].forEach(function (a) { if (ys.sp[a[1]].length) right.series.push({ x: ys.f, y: ys.sp[a[1]], color: a[2], label: a[0], width: 1.4 }); });
    Ch.figure(el, { caption: CAP.yaw, rows: [{ h: 230, widths: [1.4, 1], panels: [
      { title: 'Heck-Schwingung bei ruhigem Gier-Stick (8-20 Hz)', xlabel: 'Zeit [s]', ylabel: 'Energie (a.u.)', series: [{ x: Float64Array.from(y.t), y: Float64Array.from(y.E), vlines: true, color: C.purple }],
        hlines: [{ y: th.yaw_spike_hint, color: C.orange }, { y: th.yaw_spike_warn, color: C.red }], ylim: [0, Math.max(th.yaw_spike_warn * 1.1, Math.max.apply(null, y.E) * 1.1)] }, right] }] });
  }
  function spectro(el, m, P) {
    var S = P.spectro; if (!S) return; var rows = [], names = ['Roll', 'Nick', 'Gier (Heck)'];
    for (var k = 0; k < 3; k++) rows.push({ h: 105, panels: [{ ylabel: names[k] + '\nHz', xticks: false, xlim: [S.t0, S.t1], ylim: [S.f0, S.f1], hlines: [{ y: 8, color: '#9fb0d8', dash: 'dot' }, { y: 20, color: '#9fb0d8', dash: 'dot' }], image: { canvas: Ch.heat(S.logs[k], S.nx, S.ny, S.vmin, S.vmax, Ch.MAGMA), x0: S.t0, x1: S.t1 } }] });
    rows.push({ h: 130, panels: [{ ylabel: 'nur Heck\nHz', xlabel: 'Zeit [s]', xlim: [S.t0, S.t1], ylim: [S.f0, S.f1], hlines: [{ y: 8, color: '#9fb0d8', dash: 'dot' }, { y: 20, color: '#9fb0d8', dash: 'dot' }], image: { canvas: Ch.heat(S.only, S.nx, S.ny, 0, S.dmax, Ch.REDS), x0: S.t0, x1: S.t1 } }] });
    Ch.figure(el, { title: 'Schwingungs-Karte (hell = starke Schwingung bei dieser Frequenz)', caption: CAP.spectro, rows: rows });
  }
  function hover(el, m, P) {
    var H = m.hover_spec; if (!H) return; var x = [], k;
    for (var j = 0; j < H.axes[0].length; j++) { var f = j * H.df; if (f > 1 && f < 60) x.push(j); }
    var fx = Float64Array.from(x.map(function (j) { return j * H.df; })), ser = [];
    [['Roll', C.blue], ['Nick', C.green], ['Gier', C.purple]].forEach(function (a, i) { ser.push({ x: fx, y: Float64Array.from(x.map(function (j) { return H.axes[i][j]; })), color: a[1], label: a[0], width: 1.4 }); });
    Ch.figure(el, { caption: CAP.hover, rows: [{ h: 230, panels: [{ title: 'Gyro-Spektrum bei ruhigen Sticks (' + m.hover_n + ' Fenster)', xlabel: 'Hz', ylog: true, series: ser, spans: [{ x0: 2, x1: 8, color: 'rgba(251,191,36,.18)' }],
      vlines: m.hover_peaks.slice(0, 3).map(function (p, i) { return { x: p[1], color: C.red, dash: 'dash', label: p[0] + ' ' + p[1].toFixed(1) + ' Hz', row: i }; }), xlim: [1, 60] }] }] });
  }
  function vibSpectrum(el, m, P) {
    var V = m.vib; if (!V || !V.ok) return; var h = V.psdA[0].length, x = [], k, j;
    for (j = 1; j < h; j++) x.push(j * V.df); var fx = Float64Array.from(x);
    var rows = [], S = V.set;
    for (k = 0; k < 3; k++) {
      var a = Float64Array.from(x.map(function (_, i) { return Math.sqrt(V.psdA[k][i + 1]); })), ser = [];
      if (V.hasRaw) ser.push({ x: fx, y: Float64Array.from(x.map(function (_, i) { return Math.sqrt(V.psdR[k][i + 1]); })), color: C.orange, width: 1, label: k === 0 ? 'vor den Filtern' : null });
      ser.push({ x: fx, y: a, color: C.blue, width: 1.3, label: k === 0 ? 'nach den Filtern' : null });
      var vl = []; for (var n = 1; n * V.fh < V.nyq; n++) vl.push({ x: n * V.fh, color: 'rgba(167,139,250,.55)', dash: 'dot', label: n <= 8 ? n + 'P' : null, row: 0 });
      if (V.lp_on) vl.push({ x: S.lpf1, color: C.red, dash: 'dash', label: 'Tiefpass 1', row: 1 });
      var sp = (S.dn_count > 0 && S.dn_max > S.dn_min) ? [{ x0: S.dn_min, x1: Math.min(S.dn_max, V.nyq), color: 'rgba(251,191,36,.08)' }] : [];
      rows.push({ h: 175, panels: [{ title: k === 0 ? 'Vibrations-Spektrum (Amplitude, log)' : null, ylabel: ['Roll', 'Nick', 'Gier'][k] + ' [deg/s/\u221aHz]', xlabel: k === 2 ? 'Frequenz [Hz]' : null, xticks: k === 2, ylog: true, ylim: [1e-2, 1e2], xlim: [0, V.nyq], series: ser, vlines: vl, spans: sp, legend: k === 0 ? 'left' : false }] });
    }
    Ch.figure(el, { caption: CAP.vib, rows: rows });
  }
  function vibLevel(el, m, P) {
    var V = m.vib; if (!V || !V.ok) return; var L = V.lvl, ser = [];
    if (V.hasRaw) ser.push({ x: L.t, y: L.raw, color: C.orange, width: 1, label: 'vor den Filtern' });
    ser.push({ x: L.t, y: L.adc, color: C.blue, width: 1.3, label: 'nach den Filtern' }); ser.push({ x: L.t, y: L.hs, color: C.grey, width: .9, axis: 'y2', dash: 'dash', label: 'Kopfdrehzahl' });
    Ch.figure(el, { caption: CAP.viblevel, rows: [{ h: 200, panels: [{ title: 'Vibrationspegel ueber den Flug', xlabel: 'Zeit [s]', ylabel: 'deg/s (> 20 Hz)', y2label: 'U/min', y2: true, series: ser, legend: 'left' }] }] });
  }
  function govTerms(el, m, P) {
    var G = m.gtune; if (!G || !G.internal || !G.series) return; var S = G.series, xl = [S.t[0], S.t[S.t.length - 1]];
    Ch.figure(el, { caption: CAP.govterms, rows: [
      { h: 140, panels: [{ title: 'Governor-Anteile', xlim: xl, xticks: false, ylabel: 'Abweichung [U/min]', ylim: [-150, 250], series: [{ x: S.t, y: S.e, color: C.blue, width: .9 }], hlines: [{ y: 20, color: C.grey }, { y: -20, color: C.grey }, { y: 0, color: '#d5dcee', dash: '' }] }] },
      { h: 130, panels: [{ xlim: xl, xticks: false, ylabel: 'P / D / F', series: [{ x: S.t, y: S.P, color: C.orange, width: .8, label: 'P' }, { x: S.t, y: S.F, color: C.green, width: 1.1, label: 'F (Vorsteuerung)' }, { x: S.t, y: S.D, color: C.purple, width: .8, label: 'D' }], legend: 'left' }] },
      { h: 110, panels: [{ xlim: xl, xlabel: 'Zeit [s]', ylabel: 'I-Anteil', series: [{ x: S.t, y: S.I, color: C.red, width: 1.1 }] }] }] });
  }
  function servos(el, m, P) {
    var panels = [], F = P.fl;
    for (var k = 0; k < 4; k++) { var a = F.servo[k]; if (!a || !m.servo[k]) continue; var s = m.servo[k], h = Ch.hist(a, s.lo, s.hi + 1e-6, 60);
      panels.push({ title: 'Servo ' + (k + 1) + (k === 3 ? ' (Heck)' : ''), xlabel: 'min ' + s.lo.toFixed(0) + '  max ' + s.hi.toFixed(0), ylog: true, series: [{ x: h.x, y: h.y, bars: true, bw: h.w, color: C.blue }], xlim: [s.lo, s.hi] }); }
    if (!panels.length) return; Ch.figure(el, { caption: CAP.servos, rows: [{ h: 190, panels: panels }] });
  }
  function power(el, m, P) {
    if (!m.mot) return; var F = P.fl, xl = [F.t[0], F.t[F.t.length - 1]];
    Ch.figure(el, { caption: CAP.power, rows: [
      { h: 150, panels: [{ title: 'Motor-Ausgang (rot = 95 %-Grenze), Strom und Spannung', xlim: xl, xticks: false, ylabel: 'Motor-Ausgang [%]', ylim: [0, 105], series: [{ x: F.t, y: F.mot, color: C.blue, width: .9 }], hlines: [{ y: 95, color: C.red }] }] },
      { h: 120, panels: [{ xlim: xl, xticks: false, ylabel: 'Strom [A]', series: [{ x: F.t, y: F.I, color: C.red, width: .8 }] }] },
      { h: 130, panels: [{ xlim: xl, xlabel: 'Zeit [s]', ylabel: 'Spannung [V]', y2label: 'ESC [C]', y2: true, series: [{ x: F.t, y: F.V, color: C.green }].concat(hasData(F.Tesc) ? [{ x: F.t, y: F.Tesc, color: C.purple, axis: 'y2', width: .9 }] : []) }] }] });
  }
  function battery(el, m, P) {
    var F = P.fl, vs = (root.RFA || require('./analysis.js')).util.rollMedian(F.V, 25);
    Ch.figure(el, { caption: CAP.battery, rows: [{ h: 220, widths: [1.6, 1], panels: [
      { title: 'Spannung ueber den Flug', xlabel: 'Zeit [s]', ylabel: 'Packspannung [V]', legend: 'bottom', series: [{ x: F.t, y: F.V, color: C.grey, width: .5, label: 'roh' }, { x: F.t, y: vs, color: C.green, width: 1.4, label: 'geglaettet' }] },
      { title: 'Entladekurve', xlabel: 'verbrauchte Kapazitaet [mAh]', ylabel: 'Spannung pro Zelle [V]', series: [{ x: Float64Array.from(m.curve[0]), y: Float64Array.from(m.curve[1]), color: C.blue, width: 1.6 }] }] }] });
  }
  var api = { overview: overview, governor: governor, load: load, yaw: yaw, spectro: spectro, hover: hover, vibSpectrum: vibSpectrum, vibLevel: vibLevel, govTerms: govTerms, servos: servos, power: power, battery: battery, CAP: CAP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Figures = api;
})(typeof self !== 'undefined' ? self : this);
