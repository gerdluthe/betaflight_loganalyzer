/* UI: Renderer (Port der Python-HTML-Funktionen), Reiter, Datei-Auswahl, Worker-Anbindung */
(function () {
  'use strict';
  var $ = function (i) { return document.getElementById(i); };
  var SL = { warn: 'Handlungsbedarf', hint: 'Hinweis', ok: 'In Ordnung', info: 'Info' };
  var RANK = { warn: 0, hint: 1, ok: 2, info: 3 };
  var SEVO = { warn: 0, hint: 1, info: 2, ok: 3 };
  var AREAS = ['Heck', 'Governor', 'Antrieb', 'Akku', 'ESC', 'Servos', 'Hover', 'Vibration', 'Signal'];
  var PRIO = ['Heck', 'Governor', 'Antrieb', 'ESC/Telemetrie', 'Akku', 'ESC', 'Servos', 'Hover', 'Vibration', 'Signal', 'Log'];
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function nn(v) { return v === null || v === undefined || v !== v; }
  function fnum(v, d, suf) { return nn(v) ? '-' : v.toFixed(d) + (suf || ''); }

  function findingsHtml(F) {
    return F.slice().sort(function (a, b) { return SEVO[a.sev] - SEVO[b.sev]; }).map(function (f) {
      var todo = f.todo ? '<div class="todo"><b>Ansatz:</b> ' + esc(f.todo) + '</div>' : '';
      return '<div class="find ' + f.sev + '"><span class="badge b-' + f.sev + '">' + SL[f.sev] + '</span><b>' + esc(f.area) + ': ' + esc(f.title) + '</b><p>' + esc(f.obs) + '</p>' + todo + '</div>';
    }).join('');
  }
  function areaState(F, a) { var s = F.filter(function (f) { return f.area === a; }).map(function (f) { return f.sev; }); return s.length ? s.sort(function (x, y) { return RANK[x] - RANK[y]; })[0] : null; }
  function cardsFor(F) {
    return AREAS.map(function (a) {
      var st = areaState(F, a); if (!st) return '';
      var t = F.filter(function (f) { return f.area === a && f.sev === st; })[0].title;
      return '<div class="card ' + st + '"><b>' + esc(a) + '</b>' + esc(t) + '</div>';
    }).join('');
  }
  function fazitHtml(F) {
    var n = { warn: 0, hint: 0, ok: 0, info: 0 }; F.forEach(function (f) { n[f.sev]++; });
    var issues = F.filter(function (f) { return f.sev === 'warn' || f.sev === 'hint'; });
    if (!issues.length) return '<div class="fazit ok"><b>Fazit:</b> Keine Auffaelligkeiten - alle Bereiche in Ordnung.</div>';
    var pi = function (f) { var i = PRIO.indexOf(f.area); return i < 0 ? 99 : i; };
    var top = issues.slice().sort(function (a, b) { return SEVO[a.sev] - SEVO[b.sev] || pi(a) - pi(b); })[0], step = '';
    if (top.todo) step = '<br><b>Naechster Schritt:</b> ' + esc(top.todo.split(/(?<=[.!?])\s/)[0]);
    return '<div class="fazit ' + (n.warn ? 'warn' : 'hint') + '"><b>Fazit:</b> ' + n.warn + 'x Handlungsbedarf, ' + n.hint + 'x Hinweis, ' + n.ok + 'x in Ordnung. <b>Wichtigster Punkt:</b> ' + esc(top.area) + ' - ' + esc(top.title) + '.' + step + '</div>';
  }
  function block(F, areas) {
    var sub = F.filter(function (f) { return areas.indexOf(f.area) >= 0; });
    return sub.length ? findingsHtml(sub) : '<div class="find info">Keine Auswertung fuer diesen Bereich (Daten fehlen im Log).</div>';
  }
  function sevOf(F, areas) {
    var s = F.filter(function (f) { return areas.indexOf(f.area) >= 0; }).map(function (f) { return f.sev; });
    return s.length ? s.sort(function (a, b) { return RANK[a] - RANK[b]; })[0] : 'none';
  }
  function kpis(m) {
    var mo = m.mot, items = [
      ['Flugzeit', m.flight_s.toFixed(0) + ' s', 'Ziel ' + m.target.toFixed(0) + ' U/min'],
      m.hasElec ? ['Min. Spannung', m.v_min.toFixed(1) + ' V', m.v_min_cell.toFixed(2) + ' V/Zelle &middot; ' + m.cells + 'S'] : ['Min. Spannung', '&ndash;', 'nicht geloggt'],
      m.hasElec ? ['Verbrauch', m.mah.toFixed(0) + ' mAh', m.wh.toFixed(0) + ' Wh'] : ['Verbrauch', '&ndash;', 'nicht geloggt'],
      m.hasElec ? ['Spitzenstrom', m.i_peak.toFixed(0) + ' A', (m.p_peak / 1000).toFixed(1) + ' kW Spitze'] : ['Spitzenstrom', '&ndash;', 'nicht geloggt'],
      ['Antriebsreserve', mo ? mo.reserve.toFixed(0) + ' %' : '&ndash;', mo ? 'Ausgang &oslash; ' + mo.mean.toFixed(0) + ' %' : 'kein Gas-Wert'],
      ['ESC max.', nn(m.t_esc_max) ? '&ndash;' : m.t_esc_max.toFixed(0) + ' &deg;C', nn(m.t_esc_max) ? 'nicht geloggt' : 'Start ' + m.t_esc_start.toFixed(0) + ' &deg;C']];
    return '<div class="kpis">' + items.map(function (a) { return '<div class="kpi"><b>' + a[0] + '</b><span>' + a[1] + '</span><small>' + a[2] + '</small></div>'; }).join('') + '</div>';
  }
  function pidHtml(R) {
    if (!R.length) return '<div class="find ok"><span class="badge b-ok">In Ordnung</span><b>PID &amp; Filter</b><p>Keine konkreten Messhinweise auf PID- oder Filter-Probleme. Tracking, Governor und Spektrum sehen unauffaellig aus.</p></div>';
    return R.map(function (r) {
      var cli = r.cli && r.cli.length ? '<div class="todo"><b>CLI-Befehle (Rotorflight Configurator &rarr; CLI):</b><pre style="margin:6px 0 0;font-size:12px;background:#1e293b;color:#e2e8f0;padding:8px 12px;border-radius:6px;overflow-x:auto">' + esc(r.cli.join('\n')) + '</pre><span class="small">Einen Wert pro Flug aendern, danach erneut fliegen und vergleichen.</span></div>' : '';
      if (r.note) cli += '<div class="todo"><b>Hinweis:</b> ' + esc(r.note) + '</div>';
      return '<div class="find hint"><span class="badge b-hint">Empfehlung</span><b>' + esc(r.area) + ': ' + esc(r.title) + '</b><p>' + esc(r.obs) + '</p>' + cli + '</div>';
    }).join('');
  }
  function settingsTable(h) {
    var keys = ['Craft name', 'Firmware revision', 'Board name', 'govPID', 'rollPID', 'pitchPID', 'yawPID', 'yaw_stop_gain', 'yawBW', 'levelPID', 'rc_rates', 'rc_expo', 'motor_pwm_protocol', 'dshot_bidir'];
    var rows = keys.filter(function (k) { return k in h; }).map(function (k) { return '<tr><td>' + esc(k) + '</td><td>' + esc(h[k]) + '</td></tr>'; }).join('');
    return '<table>' + rows + '</table><div class="small">PID-Reihenfolge laut Rotorflight: P, I, D, F, B (Governor: P, I, D, F, Gesamt-Gain).</div>';
  }
  function detailTable(m) {
    var r = [['Flugphase (Drehzahl erreicht bis Gaskappung)', m.flight_s.toFixed(0) + ' s'],
      ['Zieldrehzahl', m.target.toFixed(0) + ' (' + (m.target_fixed ? 'fest' : 'variabel') + ')'],
      ['Hochlauf auf 95 %', fnum(m.spool_up_s, 1, ' s')], ['Auslauf bis < 50 U/min', fnum(m.spool_down_s, 1, ' s')],
      ['Strom Mittel / Spitze', !m.hasElec ? 'nicht geloggt' : m.i_mean.toFixed(0) + ' / ' + m.i_peak.toFixed(0) + ' A'],
      ['Leistung Mittel / Spitze', !m.hasElec ? 'nicht geloggt' : m.p_mean.toFixed(0) + ' / ' + m.p_peak.toFixed(0) + ' W'],
      ['Verbrauch', !m.hasElec ? 'nicht geloggt' : m.mah.toFixed(0) + ' mAh / ' + m.wh.toFixed(0) + ' Wh'],
      ['Spannung Start / Minimum / Ruhe nach Landung', !m.hasElec ? 'nicht geloggt' : m.v_start.toFixed(2) + ' V (' + (m.v_start / m.cells).toFixed(2) + ' V/Zelle) / ' + m.v_min.toFixed(2) + ' V (' + m.v_min_cell.toFixed(2) + ' V/Zelle) / ' + fnum(m.v_rest_cell, 2) + ' V/Zelle Ruhe'],
      ['ESC-Temperatur Start / Max', nn(m.t_esc_max) ? 'nicht geloggt' : m.t_esc_start.toFixed(0) + ' / ' + m.t_esc_max.toFixed(0) + ' C'],
      ['Stick-Aktivitaet Roll/Nick/Gier (mittl. |Auslenkung|)', m.stick_activity.toFixed(1) + ' (Skala 0-500)']];
    Object.keys(m.track).forEach(function (lab) { var t = m.track[lab]; r.push(['Regelabweichung ' + lab + ' (Soll>150 deg/s)', 'Median ' + t[0].toFixed(0) + ', 95 % ' + t[1].toFixed(0) + ' deg/s (' + t[2] + ' Samples)']); });
    return '<table>' + r.map(function (x) { return '<tr><td>' + esc(x[0]) + '</td><td>' + esc(x[1]) + '</td></tr>'; }).join('') + '</table>';
  }

  function vibTable(V) {
    if (!V || !V.ok) return '';
    var h = '<h3>Vibrationspegel je Frequenzband (deg/s, Effektivwert)</h3><table><tr><th>Achse</th>' + V.bands.map(function (b) { return '<th>' + b[0].toFixed(0) + '-' + (b[1] > 900 ? 'max' : b[1].toFixed(0)) + ' Hz</th>'; }).join('') + '</tr>';
    ['Roll', 'Nick', 'Gier'].forEach(function (a, k) { h += '<tr><td>' + a + (V.hasRaw ? ' (roh / gefiltert)' : ' (gefiltert)') + '</td>' + V.bands.map(function (b, i) { return '<td>' + (V.hasRaw ? V.rmsR[k][i].toFixed(1) + ' / ' : '') + V.rmsA[k][i].toFixed(1) + '</td>'; }).join('') + '</tr>'; });
    h += '</table>';
    if (V.peaks.length) {
      h += '<h3>Gefundene Spitzen</h3><table><tr><th>Frequenz</th><th>Zuordnung</th><th>Achse</th>' + (V.hasRaw ? '<th>roh</th>' : '') + '<th>gefiltert</th>' + (V.hasRaw ? '<th>D&auml;mpfung</th>' : '') + '</tr>';
      V.peaks.forEach(function (p) {
        h += '<tr><td>' + p.f.toFixed(1) + ' Hz</td><td>' + (p.n ? p.n + 'P Hauptrotor' : 'fest / unbekannt') + '</td><td>' + ['Roll', 'Nick', 'Gier'].filter(function (a, i) { return p.axes[i]; }).join('/') + '</td>' +
          (V.hasRaw ? '<td>' + p.ampR.toFixed(1) + '</td>' : '') + '<td>' + p.ampA.toFixed(1) + '</td>' + (V.hasRaw ? '<td>' + p.att.toFixed(0) + ' dB</td>' : '') + '</tr>';
      });
      h += '</table><div class="small">Amplituden in deg/s. Kopfdrehzahl ' + V.hs.toFixed(0) + ' U/min = ' + V.fh.toFixed(1) + ' Hz (1P). Spektrum aus ' + V.nWin + ' Fenstern mit stabiler Drehzahl, Aufl&ouml;sung ' + V.df.toFixed(2) + ' Hz.</div>';
    }
    return h;
  }
  /* Reiter: html = String, figs = [fn(el)] werden nach dem Einfuegen gezeichnet */
  function buildTabs(it) {
    var m = it.m;
    if (!m.ok) return [{ title: 'Info', sev: 'info', html: '<div class="find info">' + esc(m.error || '') + '</div>', figs: [] }];
    var F = it.F, R = it.R, P = it.P, Fg = Figures, tabs = [];
    function add(title, sev, html, figs) { tabs.push({ title: title, sev: sev, html: html, figs: figs || [] }); }
    var sub = '<div class="sub">Flugphase ' + m.flight_s.toFixed(0) + ' s | Ziel ' + m.target.toFixed(0) + ' U/min (' + (m.target_fixed ? 'fest' : 'variabel') + ')' + (m.hasElec ? ' | ' + m.mah.toFixed(0) + ' mAh' : '') + '</div>';
    var f = function (fn) { return function (el) { fn(el, m, P); }; };
    add('Übersicht', it.sev, sub + kpis(m) + fazitHtml(F) + '<div class="cards">' + cardsFor(F) + '</div><div class="figs"></div><h3>Signal / Telemetrie</h3>' + block(F, ['Signal', 'Log']), [f(Fg.overview)]);
    add('Heck', sevOf(F, ['Heck']), block(F, ['Heck']) + '<div class="figs"></div>', [f(Fg.yaw), f(Fg.spectro)]);
    add('Governor', sevOf(F, ['Governor', 'ESC/Telemetrie']), block(F, ['Governor', 'ESC/Telemetrie']) + (it.GR && it.GR.length ? '<h3>Governor-PID-Empfehlungen</h3>' + pidHtml(it.GR) : '') + '<div class="figs"></div>', [f(Fg.governor), f(Fg.load), f(Fg.govTerms)]);
    add('Antrieb', sevOf(F, ['Antrieb', 'ESC']), block(F, ['Antrieb', 'ESC']) + '<div class="figs"></div>', [f(Fg.power)]);
    if (m.hasElec) add('Akku', sevOf(F, ['Akku']), block(F, ['Akku']) + '<div class="figs"></div>', [f(Fg.battery)]);
    add('Servos', sevOf(F, ['Servos']), block(F, ['Servos']) + '<div class="figs"></div>', [f(Fg.servos)]);
    add('Vibration', sevOf(F, ['Hover', 'Vibration']), block(F, ['Vibration', 'Hover']) + (it.VR && it.VR.length ? '<h3>Filter-Empfehlungen</h3>' + pidHtml(it.VR) : '') + vibTable(m.vib) + '<div class="figs"></div>', [f(Fg.vibSpectrum), f(Fg.vibLevel), f(Fg.hover)]);
    add('PID & Filter', R.length ? 'hint' : 'ok', "<p class='small'>Basierend auf den gemessenen Werten dieses Fluges. Immer nur einen Parameter pro Flug aendern.</p>" + pidHtml(R));
    add('Einstellungen', 'none', '<h3>Einstellungen aus dem Log</h3>' + settingsTable(m.hdr || {}) + '<h3>Alle Kennzahlen</h3>' + detailTable(m));
    return tabs;
  }

  var DATA = null, CUR = 0, TAB = 0, TABS = null, ROTOR = window.__ROTOR__ || '', worker = null;
  function msg(t, err, spin) { $('hero').innerHTML = ''; $('body').innerHTML = '<div id="msg" class="' + (err ? 'err' : '') + '">' + (spin ? ROTOR : '') + t + '</div>'; $('tabs').innerHTML = ''; }
  function render() {
    var it = DATA[CUR]; TABS = buildTabs(it); if (TAB >= TABS.length) TAB = 0;
    $('tabs').innerHTML = TABS.map(function (x, i) { return '<button data-i="' + i + '" class="' + (i === TAB ? 'on' : '') + '"><i class="' + x.sev + '"></i>' + esc(x.title) + '</button>'; }).join('');
    $('hero').innerHTML = '<h2>' + esc(it.name) + '</h2><span class="badge b-' + (TABS[0].sev) + '">' + (SL[TABS[0].sev] || '') + '</span>';
    var t = TABS[TAB]; $('body').innerHTML = t.html;
    var box = $('body').querySelector('.figs');
    if (box) t.figs.forEach(function (fn) { try { fn(box); } catch (e) { var d = document.createElement('div'); d.className = 'small'; d.textContent = 'Diagramm uebersprungen (' + e.message + ')'; box.appendChild(d); console.error(e); } });
    window.scrollTo(0, 0);
  }
  $('tabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; TAB = +b.dataset.i; render(); });
  window.addEventListener('resize', function () { clearTimeout(window.__rz); window.__rz = setTimeout(function () { if (DATA) render(); }, 250); });

  function analyze(file) {
    $('fname').textContent = file.name;
    msg('Lese ' + esc(file.name) + ' ...', 0, 1);
    var rd = new FileReader();
    rd.onerror = function () { msg('Datei konnte nicht gelesen werden.', 1); };
    rd.onload = function () {
      msg('Dekodiere und analysiere ' + esc(file.name) + ' &ndash; das dauert je nach Loggroesse einige Sekunden ...', 0, 1);
      if (worker) worker.terminate();
      worker = new Worker(window.__WORKER_URL__);
      worker.onmessage = function (e) {
        var d = e.data;
        if (d.progress) { var s = document.querySelector('#msg'); if (s) s.lastChild.textContent = d.progress; return; }
        worker.terminate(); worker = null;
        if (d.error) { msg(esc(d.error), 1); return; }
        DATA = d.done; CUR = 0; TAB = 0;
        var s = $('flight'); s.innerHTML = DATA.map(function (x, i) { return '<option value="' + i + '">' + esc(x.name) + '</option>'; }).join('');
        s.style.display = DATA.length > 1 ? '' : 'none'; render();
      };
      worker.onerror = function (e) { msg('Fehler: ' + esc(e.message || e), 1); };
      worker.postMessage({ buf: rd.result, name: file.name, cells: +$('cells').value || 0 }, [rd.result]);
    };
    rd.readAsArrayBuffer(file);
  }
  $('file').onchange = function () { if (this.files[0]) analyze(this.files[0]); };
  $('flight').onchange = function () { CUR = +this.value; TAB = 0; render(); };
  $('cells').onchange = function () { var f = $('file').files[0]; if (f && DATA) analyze(f); };
  window.__rf = { analyze: analyze };
})();
