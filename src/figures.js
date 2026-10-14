/* Baut die Diagramme (Charts.figure) aus Analyse-Ergebnis m und Plot-Daten P. */
(function (root) {
  'use strict';
  var Ch = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./charts.js') : root.Charts, C = Ch.C;
  var AXN = ['Roll', 'Nick', 'Gier'], AXC = [C.blue, C.green, C.purple], MOTC = [C.blue, C.orange, C.green, C.purple, C.red, C.yellow, C.grey, '#f472b6'];
  var CAP = {
    overview: 'Oben Gasstick (grau gestrichelt) und mittlerer Motor-Ausgang (blau), darunter Strom/Spannung und wie viel du an den Sticks gemacht hast. Gelb hinterlegt = ausgewertete Flugphase.',
    step: 'Sprungantwort je Achse: so reagiert der Copter auf einen ploetzlichen Stick-Sprung (berechnet aus dem ganzen Flug). Ideal: schneller Anstieg auf 1,0 mit hoechstens 5-10 % Ueberschwingen und ohne Nachschwingen. Gestrichelt: nur grosse Ausschlaege (ueber 500 deg/s).',
    tracking: 'Soll-Drehrate (orange, aus den Sticks) und tatsaechliche Drehrate (blau, Gyro) ueber den ganzen Flug. Liegen beide aufeinander, folgt der Copter den Sticks genau.',
    spectro: 'Zeit nach rechts, Frequenz nach oben, hell = starke Schwingung (gefiltertes Gyro). Waagrechte helle Linien sind feste Resonanzen; Linien, die mit dem Gas (unten) steigen und fallen, kommen von Motoren/Propellern. Senkrechte Streifen sind Manoever.',
    propwash: 'Links jede schnelle Gas-Ruecknahme als Punkt: wie stark Roll/Nick danach geschuettelt haben (Regelabweichung 10-90 Hz). Grau: Pegel im ruhigen Flug. Rechts das staerkste Ereignis im Detail mit Gas (grau).',
    motors: 'Ausgang aller Motoren ueber den Flug (0 % = Leerlauf, 100 % = Vollgas). Flache Spitzen an der roten Linie = Motor am Anschlag. Rechts der mittlere Ausgang je Motor bei ruhigen Sticks - ungleiche Balken zeigen Schwerpunkt- oder Propellerprobleme.',
    rpm: 'Mittlere Motordrehzahl (aus bidirektionalem DShot) als Frequenz. Das ist die Grundfrequenz, auf der Propeller-Unwucht und Motorrauschen liegen.',
    vib: 'Vibrations-Spektrum je Achse ueber den ganzen Flug. Orange = vor den Filtern, blau = nach den Filtern. Rote Linie: Gyro-Tiefpass 1, gelb: Bereich des dynamischen Notch, violett: mittlere Motorfrequenz (falls geloggt). Je weiter blau unter orange, desto besser filtern die Filter.',
    thrmap: 'Frequenz ueber Gas: jede Spalte ist ein Gasbereich, hell = starke Vibration. Schraege helle Baender, die mit dem Gas steigen = Motorrauschen (Fall fuer den RPM-Filter); waagrechte Baender = feste Resonanz (Rahmen, Notch). Punkte: gemessene Motorfrequenz.',
    viblevel: 'Vibrationspegel (Effektivwert oberhalb 20 Hz) ueber den Flug, vor und nach den Filtern, dazu der Gasstick. Ein Pegel, der mit dem Gas steigt, ist normal; dauerhaft hohe blaue Werte sind Restvibration.',
    dterm: 'Spektrum des D-Terms (Roll/Nick). Der D-Term verstaerkt hochfrequentes Rauschen; was hier rechts noch hoch ist, landet in den Motoren und macht sie warm.',
    hover: 'Gyro-Spektrum nur aus Phasen mit mittigen Sticks. Ein glatter Abfall nach rechts ist normale Bewegung/Wind. Eine echte Spitze (rot markiert) deutet auf eine Regelkreis-Schwingung hin.',
    battery: 'Links die Packspannung ueber den Flug, rechts die Spannung pro Zelle ueber der verbrauchten Kapazitaet.' };
  function hasData(a) { if (!a) return false; for (var i = 0; i < a.length; i += Math.max(1, a.length >> 6)) if (a[i] === a[i]) return true; return false; }
  function T() { return (root.RFA || require('./analysis.js')).THRESH; }
  function U() { return (root.RFA || require('./analysis.js')).util; }

  function overview(el, m, P) {
    var t = P.t, xl = [t[0], t[t.length - 1]], spans = [{ x0: m.t0, x1: m.t1, color: 'rgba(251,191,36,.10)' }];
    var base = { xlim: xl, spans: spans, xticks: false };
    function P1(o) { return Object.assign({}, base, o); }
    var rows = [{ h: 160, panels: [P1({ title: 'Flug auf einen Blick', ylabel: 'Gas / Motoren [%]', ylim: [0, 105], series: [{ x: t, y: P.mavg, color: C.blue, label: 'Motoren (Mittel)', width: .9 }, { x: t, y: P.thr, color: C.grey, dash: 'dash', label: 'Gasstick', width: .9 }], legend: 'left' })] }];
    if (hasData(P.V)) rows.push({ h: 120, panels: [P1({ ylabel: hasData(P.I) ? 'Strom [A]' : 'Spannung [V]', y2label: hasData(P.I) ? 'Spannung [V]' : null, y2: hasData(P.I), series: hasData(P.I) ? [{ x: t, y: P.I, color: C.red, width: .8 }, { x: t, y: P.V, color: C.green, axis: 'y2' }] : [{ x: t, y: P.V, color: C.green }] })] });
    rows.push({ h: 110, panels: [P1({ ylabel: 'Stick-Aktivitaet', xlabel: 'Zeit [s]', xticks: true, series: [{ x: t, y: P.stick, color: C.grey, fill: true }] })] });
    Ch.figure(el, { caption: CAP.overview, rows: rows });
  }
  function stepResp(el, m) {
    var S = m.step; if (!S || !S.ok) return; var panels = [];
    S.ax.forEach(function (a, k) {
      if (!a.ok) { panels.push({ title: AXN[k] + ': zu wenig Daten', xlim: [0, 500], ylim: [0, 1.6], series: [] }); return; }
      var x = Float64Array.from(a.step, function (_, i) { return i / S.fs * 1000; }), ser = [{ x: x, y: a.step, color: AXC[k], width: 2, label: 'alle Bewegungen' }];
      if (a.high) ser.push({ x: x, y: a.high, color: C.orange, width: 1.2, dash: 'dash', label: 'nur grosse' });
      panels.push({ title: AXN[k] + ' - Ueberschwingen ' + Math.max(0, a.over).toFixed(0) + ' %, 50 % nach ' + a.t50.toFixed(0) + ' ms', xlabel: 'Zeit nach dem Sprung [ms]', ylabel: k === 0 ? 'Antwort (1 = Soll)' : null, xlim: [0, 500], ylim: [0, Math.max(1.6, Math.min(2.2, a.peak * 1.1))], series: ser,
        hlines: [{ y: 1, color: '#d5dcee', dash: '' }, { y: 1.1, color: 'rgba(251,191,36,.6)' }], legend: k === 0 && a.high ? 'bottom' : false });
    });
    Ch.figure(el, { caption: CAP.step, rows: [{ h: 240, panels: panels }] });
  }
  function tracking(el, m, P) {
    var F = P.fl; if (!F.sp[0]) return; var rows = [], xl = [F.t[0], F.t[F.t.length - 1]];
    for (var k = 0; k < 3; k++) if (F.sp[k] && F.gy[k]) rows.push({ h: 125, panels: [{ title: k === 0 ? 'Soll gegen Ist' : null, xlim: xl, xticks: k === 2, xlabel: k === 2 ? 'Zeit [s]' : null, ylabel: AXN[k] + ' [deg/s]',
      series: [{ x: F.t, y: F.sp[k], color: C.orange, width: .9, label: k === 0 ? 'Soll' : null }, { x: F.t, y: F.gy[k], color: C.blue, width: .8, label: k === 0 ? 'Gyro' : null }], legend: k === 0 ? 'left' : false }] });
    Ch.figure(el, { caption: CAP.tracking, rows: rows });
  }
  function spectro(el, m, P) {
    var S = P.spectro; if (!S) return; var rows = [];
    for (var k = 0; k < 3; k++) rows.push({ h: 110, panels: [{ ylabel: AXN[k] + ' [Hz]', xticks: false, xlim: [S.t0, S.t1], ylim: [S.f0, S.f1], image: { canvas: Ch.heat(S.logs[k], S.nx, S.ny, S.vmin, S.vmax, Ch.MAGMA), x0: S.t0, x1: S.t1 } }] });
    rows.push({ h: 90, panels: [{ ylabel: 'Gas [%]', xlabel: 'Zeit [s]', xlim: [S.t0, S.t1], ylim: [0, 100], series: [{ x: S.thrT, y: S.thr, color: C.grey, fill: true }] }] });
    Ch.figure(el, { title: 'Schwingungs-Karte (hell = starke Schwingung bei dieser Frequenz)', caption: CAP.spectro, rows: rows });
  }
  function propwash(el, m, P) {
    var W = m.pw; if (!W || !W.ok || !W.n) return; var pw = (root.RFW || require('./propwash.js')).PW;
    var left = { title: 'Schuetteln nach Gas-Ruecknahme', xlabel: 'Zeit [s]', ylabel: 'deg/s (10-' + W.hi.toFixed(0) + ' Hz)', series: [{ x: Float64Array.from(W.events, function (e) { return e.t; }), y: Float64Array.from(W.events, function (e) { return e.v; }), vlines: true, color: C.red }],
      hlines: [{ y: pw.hint, color: C.orange }, { y: pw.warn, color: C.red }].concat(isFinite(W.base) ? [{ y: W.base, color: C.grey, dash: 'dot' }] : []), ylim: [0, Math.max(pw.warn * 1.3, W.worst.v * 1.1)], xlim: [m.t0, m.t1] };
    var rows = [{ h: 220, panels: [left] }];
    if (P.pwin) {
      var w = P.pwin, ser = [];
      [0, 1].forEach(function (k) { if (w.gy[k]) ser.push({ x: w.t, y: w.gy[k], color: AXC[k], width: 1.1, label: 'Gyro ' + AXN[k] }); if (w.sp[k]) ser.push({ x: w.t, y: w.sp[k], color: AXC[k], width: .8, dash: 'dash' }); });
      ser.push({ x: w.t, y: w.thr, color: C.grey, axis: 'y2', width: 1, label: 'Gas' });
      rows[0].widths = [1, 1.3];
      rows[0].panels.push({ title: 'Staerkstes Ereignis (t=' + W.worst.t.toFixed(1) + ' s)', xlabel: 'Zeit [s]', ylabel: 'deg/s', y2: true, y2label: 'Gas [%]', y2lim: [0, 100], series: ser, legend: 'left', vlines: [{ x: W.worst.t, color: C.red, dash: 'dot' }] });
    }
    Ch.figure(el, { caption: CAP.propwash, rows: rows });
  }
  function motors(el, m, P) {
    var F = P.fl; if (!F.mot.length) return; var xl = [F.t[0], F.t[F.t.length - 1]];
    var ser = F.mot.map(function (a, k) { return { x: F.t, y: a, color: MOTC[k], width: .7, label: 'M' + (k + 1) }; });
    var per = m.mot.per, bx = Float64Array.from(per, function (_, k) { return k + 1; });
    Ch.figure(el, { caption: CAP.motors, rows: [{ h: 240, widths: [2.2, 1], panels: [
      { title: 'Motor-Ausgang', xlim: xl, xlabel: 'Zeit [s]', ylabel: 'Ausgang [%]', ylim: [-2, 105], series: ser, hlines: [{ y: 100, color: C.red }], legend: 'left' },
      { title: 'Ruhiger Flug je Motor', xlabel: 'Motor', ylabel: '%', xlim: [0.4, per.length + 0.6], series: [{ x: bx, y: Float64Array.from(per, function (v) { return v === v ? v : 0; }), bars: true, bw: 0.7, color: C.blue }] }] }] });
    if (F.motHz && hasData(F.motHz)) Ch.figure(el, { caption: CAP.rpm, rows: [{ h: 170, panels: [{ title: 'Motorfrequenz (eRPM)', xlim: xl, xlabel: 'Zeit [s]', ylabel: 'Hz', series: [{ x: F.t, y: F.motHz, color: C.purple, width: .9 }] }] }] });
  }
  function vibSpectrum(el, m) {
    var V = m.vib; if (!V || !V.ok) return; var h = V.psdA[0].length, k, j, x = []; for (j = 1; j < h; j++) x.push(j * V.df); var fx = Float64Array.from(x), rows = [], S = V.set;
    var hz = m.mot && m.mot.rpm ? m.mot.rpm.hz_med : NaN;
    for (k = 0; k < 3; k++) {
      var ser = [];
      if (V.hasRaw) ser.push({ x: fx, y: Float64Array.from(x, function (_, i) { return Math.sqrt(V.psdR[k][i + 1]); }), color: C.orange, width: 1, label: k === 0 ? 'vor den Filtern' : null });
      ser.push({ x: fx, y: Float64Array.from(x, function (_, i) { return Math.sqrt(V.psdA[k][i + 1]); }), color: C.blue, width: 1.3, label: k === 0 ? 'nach den Filtern' : null });
      var vl = [];
      if (V.lp_on) vl.push({ x: S.lpf1_eff, color: C.red, dash: 'dash', label: 'Tiefpass 1', row: 0 });
      if (hz === hz) for (var q = 1; q <= 3 && q * hz < V.nyq; q++) vl.push({ x: q * hz, color: 'rgba(167,139,250,.7)', dash: 'dot', label: q === 1 ? 'Motor' : q + 'x', row: 1 });
      var sp = (S.dn_count > 0 && S.dn_max > S.dn_min) ? [{ x0: S.dn_min, x1: Math.min(S.dn_max, V.nyq), color: 'rgba(251,191,36,.08)' }] : [];
      rows.push({ h: 170, panels: [{ title: k === 0 ? 'Vibrations-Spektrum (Amplitude, log)' : null, ylabel: AXN[k] + ' [deg/s/√Hz]', xlabel: k === 2 ? 'Frequenz [Hz]' : null, xticks: k === 2, ylog: true, ylim: [1e-3, 1e2], xlim: [0, V.nyq], series: ser, vlines: vl, spans: sp, legend: k === 0 ? 'left' : false }] });
    }
    Ch.figure(el, { caption: CAP.vib, rows: rows });
  }
  function thrMap(el, m) {
    var V = m.vib; if (!V || !V.ok || !V.thrMap) return; var M = V.thrMap, nb = M.nb, h = Math.min(V.psdA[0].length, Math.floor(1000 / V.df) + 1), step = Math.max(1, Math.ceil(h / 220)), ny = Math.floor((h - 1) / step), panels = [];
    function build(src) {
      var d = new Float32Array(nb * ny), vals = [];
      for (var b = 0; b < nb; b++) for (var y = 0; y < ny; y++) { var s = 0; for (var q = 0; q < step; q++) s += src[b][1 + y * step + q] || 0; var v = M.n[b] ? Math.log10(Math.sqrt(s / step) + 1e-4) : NaN; d[b * ny + y] = v; if (v === v) vals.push(v); }
      var u = U(); return { d: d, lo: u.percentile(vals, 5), hi: u.percentile(vals, 99.5) };
    }
    var pts = { x: [], y: [] }; M.hz.forEach(function (hz, b) { if (hz === hz) for (var q = 1; q <= 3; q++) if (q * hz < V.nyq) { pts.x.push((b + 0.5) * 100 / nb); pts.y.push(q * hz); } });
    var srcs = V.hasRaw ? [['vor den Filtern', M.raw], ['nach den Filtern', M.adc]] : [['gefiltertes Gyro', M.adc]];
    srcs.forEach(function (s, i) {
      var H = build(s[1]), fmax = ny * step * V.df;
      for (var z = 0; z < H.d.length; z++) if (H.d[z] !== H.d[z]) H.d[z] = H.lo;
      panels.push({ title: 'Frequenz ueber Gas - ' + s[0], xlabel: 'Gas [%]', ylabel: i === 0 ? 'Hz' : null, xlim: [0, 100], ylim: [0, fmax], image: { canvas: Ch.heat(H.d, nb, ny, H.lo, H.hi, Ch.MAGMA), x0: 0, x1: 100 },
        series: pts.x.length ? [{ x: Float64Array.from(pts.x), y: Float64Array.from(pts.y), points: true, color: '#e6ebf5', r: 2.4 }] : [] });
    });
    Ch.figure(el, { caption: CAP.thrmap, rows: [{ h: 260, panels: panels }] });
  }
  function vibLevel(el, m) {
    var V = m.vib; if (!V || !V.ok) return; var L = V.lvl, ser = [];
    if (V.hasRaw) ser.push({ x: L.t, y: L.raw, color: C.orange, width: 1, label: 'vor den Filtern' });
    ser.push({ x: L.t, y: L.adc, color: C.blue, width: 1.3, label: 'nach den Filtern' }); ser.push({ x: L.t, y: L.thr, color: C.grey, width: .9, axis: 'y2', dash: 'dash', label: 'Gas' });
    Ch.figure(el, { caption: CAP.viblevel, rows: [{ h: 200, panels: [{ title: 'Vibrationspegel ueber den Flug', xlabel: 'Zeit [s]', ylabel: 'deg/s (> 20 Hz)', y2label: 'Gas [%]', y2: true, y2lim: [0, 100], series: ser, legend: 'left' }] }] });
  }
  function dterm(el, m) {
    var V = m.vib; if (!V || !V.ok || !V.psdD) return; var h = V.psdD[0].length, x = []; for (var j = 1; j < h; j++) x.push(j * V.df); var fx = Float64Array.from(x), S = V.set, vl = [];
    if (S.dlpf1_eff > 0) vl.push({ x: S.dlpf1_eff, color: C.red, dash: 'dash', label: 'D-Tiefpass 1', row: 0 });
    Ch.figure(el, { caption: CAP.dterm, rows: [{ h: 210, panels: [{ title: 'D-Term-Spektrum', xlabel: 'Frequenz [Hz]', ylabel: 'Amplitude (log)', ylog: true, xlim: [0, V.nyq], vlines: vl, legend: 'left',
      series: [0, 1].map(function (k) { return { x: fx, y: Float64Array.from(x, function (_, i) { return Math.sqrt(V.psdD[k][i + 1]); }), color: AXC[k], width: 1.1, label: AXN[k] }; }) }] }] });
  }
  function hover(el, m) {
    var H = m.hover_spec; if (!H) return; var x = [];
    for (var j = 0; j < H.axes[0].length; j++) { var f = j * H.df; if (f > 1 && f < 80) x.push(j); }
    var fx = Float64Array.from(x, function (j) { return j * H.df; }), ser = [];
    AXN.forEach(function (a, i) { ser.push({ x: fx, y: Float64Array.from(x, function (j) { return H.axes[i][j]; }), color: AXC[i], label: a, width: 1.4 }); });
    Ch.figure(el, { caption: CAP.hover, rows: [{ h: 230, panels: [{ title: 'Gyro-Spektrum bei ruhigen Sticks (' + m.hover_n + ' Fenster)', xlabel: 'Hz', ylabel: 'deg/s', ylog: true, series: ser, spans: [{ x0: 2, x1: 8, color: 'rgba(251,191,36,.18)' }],
      vlines: m.hover_peaks.slice(0, 3).map(function (p, i) { return { x: p[1], color: C.red, dash: 'dash', label: p[0] + ' ' + p[1].toFixed(1) + ' Hz', row: i }; }), xlim: [1, 80] }] }] });
  }
  function battery(el, m, P) {
    var F = P.fl; if (!hasData(F.V)) return; var vs = U().rollMedian(F.V, Math.max(5, Math.round(m.fs / 20))), panels = [
      { title: 'Spannung ueber den Flug', xlabel: 'Zeit [s]', ylabel: 'Packspannung [V]', legend: 'bottom', series: [{ x: F.t, y: F.V, color: C.grey, width: .5, label: 'roh' }, { x: F.t, y: vs, color: C.green, width: 1.4, label: 'geglaettet' }] }];
    if (m.curve) panels.push({ title: 'Entladekurve', xlabel: 'verbrauchte Kapazitaet [mAh]', ylabel: 'Spannung pro Zelle [V]', series: [{ x: Float64Array.from(m.curve[0]), y: Float64Array.from(m.curve[1]), color: C.blue, width: 1.6 }] });
    Ch.figure(el, { caption: CAP.battery, rows: [{ h: 220, widths: panels.length > 1 ? [1.6, 1] : null, panels: panels }] });
  }
  var api = { overview: overview, stepResp: stepResp, tracking: tracking, spectro: spectro, propwash: propwash, motors: motors, vibSpectrum: vibSpectrum, thrMap: thrMap, vibLevel: vibLevel, dterm: dterm, hover: hover, battery: battery, CAP: CAP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Figures = api;
})(typeof self !== 'undefined' ? self : this);
