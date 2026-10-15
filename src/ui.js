/* UI: Renderer (Port der Python-HTML-Funktionen), Reiter, Datei-Auswahl, Worker-Anbindung */
(function () {
  'use strict';
  var $ = function (i) { return document.getElementById(i); };
  var SL = { warn: 'Handlungsbedarf', hint: 'Hinweis', ok: 'In Ordnung', info: 'Info' };
  var RANK = { warn: 0, hint: 1, ok: 2, info: 3 };
  var SEVO = { warn: 0, hint: 1, info: 2, ok: 3 };
  var AREAS = ['Regelung', 'Propwash', 'Motoren', 'Akku', 'Vibration', 'Filter', 'Ruhephasen', 'Signal'];
  var PRIO = ['Signal', 'Motoren', 'Akku', 'Regelung', 'Propwash', 'Vibration', 'Filter', 'Ruhephasen', 'Log'];
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
    var mo = m.mot, st = m.step && m.step.ok ? m.step.ax.filter(function (x) { return x.ok; }) : [], over = st.length ? Math.max.apply(null, st.map(function (x) { return x.over; })) : NaN;
    var items = [
      ['Flugzeit', m.flight_s.toFixed(m.flight_s < 10 ? 1 : 0) + ' s', m.fw.str || 'Firmware unbekannt'],
      m.hasVolt ? ['Min. Spannung', m.v_min.toFixed(1) + ' V', m.v_min_cell.toFixed(2) + ' V/Zelle &middot; ' + m.cells + 'S'] : ['Min. Spannung', '&ndash;', 'nicht geloggt'],
      m.hasCurr ? ['Verbrauch', m.mah.toFixed(0) + ' mAh', m.wh.toFixed(1) + ' Wh'] : ['Verbrauch', '&ndash;', 'kein Strom geloggt'],
      m.hasCurr ? ['Spitzenstrom', m.i_peak.toFixed(0) + ' A', m.p_peak.toFixed(0) + ' W Spitze'] : ['Spitzenstrom', '&ndash;', 'kein Strom geloggt'],
      ['Motor-Saettigung', mo ? mo.sat_pct.toFixed(1) + ' %' : '&ndash;', mo ? 'Schwebe bei ' + fnum(m.hover_mot, 0, ' %') : 'keine Motorwerte'],
      ['Ueberschwingen', nn(over) ? '&ndash;' : Math.max(0, over).toFixed(0) + ' %', nn(over) ? 'zu wenig Stickbewegung' : 'max. der Achsen (Sprungantwort)']];
    return '<div class="kpis">' + items.map(function (a) { return '<div class="kpi"><b>' + a[0] + '</b><span>' + a[1] + '</span><small>' + a[2] + '</small></div>'; }).join('') + '</div>';
  }
  function pidHtml(R) {
    if (!R.length) return '<div class="find ok"><span class="badge b-ok">In Ordnung</span><b>PID &amp; Filter</b><p>Keine konkreten Messhinweise auf PID- oder Filter-Probleme. Sprungantwort, Propwash und Spektrum sehen unauffaellig aus.</p></div>';
    return R.map(function (r) {
      var cli = r.cli && r.cli.length ? '<div class="todo"><b>CLI-Befehle (Betaflight Configurator &rarr; CLI, danach <code>save</code>):</b><pre style="margin:6px 0 0;font-size:12px;background:#1e293b;color:#e2e8f0;padding:8px 12px;border-radius:6px;overflow-x:auto">' + esc(r.cli.join('\n')) + '</pre><span class="small">Einen Wert pro Flug aendern, danach erneut fliegen und vergleichen.</span></div>' : '';
      if (r.note) cli += '<div class="todo"><b>Hinweis:</b> ' + esc(r.note) + '</div>';
      return '<div class="find hint"><span class="badge b-hint">Empfehlung</span><b>' + esc(r.area) + ': ' + esc(r.title) + '</b><p>' + esc(r.obs) + '</p>' + cli + '</div>';
    }).join('');
  }
  function settingsTable(h) {
    var keys = ['Firmware revision', 'Board information', 'Craft name', 'looptime', 'pid_process_denom', 'P interval', 'rollPID', 'pitchPID', 'yawPID', 'd_min', 'd_max', 'ff_weight', 'feedforward_weight', 'iterm_relax_cutoff', 'anti_gravity_gain', 'tpa_rate', 'tpa_breakpoint',
      'rates_type', 'rc_rates', 'rc_expo', 'rates', 'rcRate', 'rcExpo',
      'gyro_lpf1_static_hz', 'gyro_lpf1_dyn_hz', 'gyro_lpf2_static_hz', 'gyro_lowpass_hz', 'gyro_lowpass_dyn_hz', 'gyro_lowpass2_hz', 'gyro_notch_hz', 'dterm_lpf1_static_hz', 'dterm_lpf1_dyn_hz', 'dterm_lpf2_static_hz', 'dterm_lowpass_hz', 'dterm_lowpass_dyn_hz', 'dterm_lowpass2_hz',
      'dyn_notch_count', 'dyn_notch_q', 'dyn_notch_min_hz', 'dyn_notch_max_hz', 'dyn_notch_width_percent', 'rpm_filter_harmonics', 'rpm_filter_q', 'rpm_filter_min_hz', 'gyro_rpm_notch_harmonics', 'gyro_rpm_notch_q', 'gyro_rpm_notch_min',
      'motor_pwm_protocol', 'dshot_bidir', 'motor_poles', 'dshot_idle_value', 'motor_idle', 'dyn_idle_min_rpm', 'motorOutput', 'debug_mode'];
    var rows = keys.filter(function (k) { return k in h; }).map(function (k) { return '<tr><td>' + esc(k) + '</td><td>' + esc(h[k]) + '</td></tr>'; }).join('');
    return '<table>' + rows + '</table><div class="small">PID-Werte je Achse: P, I, D (bei Betaflight 4.x ist D der Hoechstwert, d_min der Grundwert). Feedforward und d_min: Roll, Nick, Gier.</div>';
  }
  function detailTable(m) {
    var mo = m.mot, r = [['Flugphase (Motoren ueber Leerlauf)', m.flight_s.toFixed(0) + ' s von ' + m.log_s.toFixed(0) + ' s Log'],
      ['Lograte', m.fs.toFixed(0) + ' Hz (Frequenzen bis ' + (m.fs / 2).toFixed(0) + ' Hz sichtbar)'],
      ['Gasstick Mittel / Schwebe', m.thr_mean.toFixed(0) + ' % / ' + fnum(m.hover_thr, 0, ' %')],
      ['Motoren Mittel / Spitze', mo ? mo.mean.toFixed(0) + ' / ' + mo.peak.toFixed(0) + ' %' : '-'],
      ['Motoren am Anschlag / am Leerlauf', mo ? mo.sat_pct.toFixed(2) + ' % / ' + mo.idle_pct.toFixed(2) + ' %' : '-'],
      ['Motoren im ruhigen Flug', mo ? mo.per.map(function (x, k) { return 'M' + (k + 1) + ' ' + fnum(x, 1); }).join(', ') + ' %' : '-'],
      ['Motorfrequenz Median / Max (eRPM)', mo && mo.rpm ? mo.rpm.hz_med.toFixed(0) + ' / ' + mo.rpm.hz_max.toFixed(0) + ' Hz (' + mo.rpm.poles + ' Pole)' : 'nicht geloggt'],
      ['Strom Mittel / Spitze', !m.hasCurr ? 'nicht geloggt' : m.i_mean.toFixed(1) + ' / ' + m.i_peak.toFixed(0) + ' A'],
      ['Leistung Mittel / Spitze', !m.hasCurr ? 'nicht geloggt' : m.p_mean.toFixed(0) + ' / ' + m.p_peak.toFixed(0) + ' W'],
      ['Verbrauch', !m.hasCurr ? 'nicht geloggt' : m.mah.toFixed(0) + ' mAh / ' + m.wh.toFixed(1) + ' Wh'],
      ['Spannung Start / Minimum / nach Landung', !m.hasVolt ? 'nicht geloggt' : m.v_start.toFixed(2) + ' V (' + (m.v_start / m.cells).toFixed(2) + ' V/Zelle) / ' + m.v_min.toFixed(2) + ' V (' + m.v_min_cell.toFixed(2) + ' V/Zelle) / ' + fnum(m.v_rest_cell, 2) + ' V/Zelle'],
      ['Stick-Aktivitaet Roll/Nick/Gier (mittl. |Auslenkung|)', m.stick_activity.toFixed(1) + ' (Skala 0-500)'],
      ['Ungefiltertes Gyro', m.rawSrc || 'nicht geloggt']];
    Object.keys(m.track).forEach(function (lab) { var t = m.track[lab]; r.push(['Regelabweichung ' + lab + ' (Soll > 100 deg/s)', 'Median ' + t[0].toFixed(0) + ', 95 % ' + t[1].toFixed(0) + ' deg/s (' + t[2] + ' Samples)']); });
    if (m.step && m.step.ok) m.step.ax.forEach(function (a, k) { if (a.ok) r.push(['Sprungantwort ' + ['Roll', 'Nick', 'Gier'][k], 'Ueberschwingen ' + Math.max(0, a.over).toFixed(0) + ' %, t50 ' + a.t50.toFixed(0) + ' ms, t90 ' + fnum(a.t90, 0) + ' ms, Endwert ' + a.ss.toFixed(2) + ' (' + a.n + ' Fenster)']); });
    if (m.pw && m.pw.ok && m.pw.n) r.push(['Propwash typisch / 90 % / Ruhe', m.pw.med.toFixed(1) + ' / ' + m.pw.p90.toFixed(1) + ' / ' + fnum(m.pw.base, 1) + ' deg/s (' + m.pw.n + ' Gas-Ruecknahmen)']);
    if (m.rssi) r.push(['RSSI Minimum / Median', m.rssi.min.toFixed(0) + ' / ' + m.rssi.med.toFixed(0) + ' %']);
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
        h += '<tr><td>' + p.f.toFixed(1) + ' Hz</td><td>' + (p.low ? 'Regelkreis (&lt; 40 Hz)' : p.mot ? 'Motorfrequenz' : p.fixed === true ? 'feste Resonanz' : p.fixed === false ? 'drehzahlabh&auml;ngig' : 'unklar') + '</td><td>' + ['Roll', 'Nick', 'Gier'].filter(function (a, i) { return p.axes[i]; }).join('/') + '</td>' +
          (V.hasRaw ? '<td>' + p.ampR.toFixed(1) + '</td>' : '') + '<td>' + p.ampA.toFixed(1) + '</td>' + (V.hasRaw ? '<td>' + p.att.toFixed(0) + ' dB</td>' : '') + '</tr>';
      });
      h += '</table><div class="small">Amplituden in deg/s. Spektrum aus ' + V.nWin + ' Fenstern &uuml;ber den ganzen Flug, Aufl&ouml;sung ' + V.df.toFixed(1) + ' Hz.' + (V.rawSrc ? ' Rohsignal: ' + esc(V.rawSrc) + '.' : '') + '</div>';
    }
    return h;
  }
  /* Reiter: html = String, figs = [fn(el)] werden nach dem Einfuegen gezeichnet */
  function buildTabs(it) {
    var m = it.m;
    if (!m.ok) return [{ title: 'Info', sev: 'info', html: '<div class="find info">' + esc(m.error || '') + '</div>', figs: [] }];
    var F = it.F, R = it.R, P = it.P, Fg = Figures, tabs = [];
    function add(title, sev, html, figs) { tabs.push({ title: title, sev: sev, html: html, figs: figs || [] }); }
    var sub = '<div class="sub">' + esc(m.fw.str || '') + (m.hdr['Craft name'] ? ' | ' + esc(m.hdr['Craft name']) : '') + ' | Flugphase ' + m.flight_s.toFixed(0) + ' s | Lograte ' + m.fs.toFixed(0) + ' Hz' + (m.hasCurr ? ' | ' + m.mah.toFixed(0) + ' mAh' : '') + '</div>';
    var f = function (fn) { return function (el) { fn(el, m, P); }; };
    add('Übersicht', it.sev, sub + kpis(m) + fazitHtml(F) + '<div class="cards">' + cardsFor(F) + '</div><div class="figs"></div><h3>Signal / Log</h3>' + block(F, ['Signal', 'Log']), [f(Fg.overview)]);
    add('Regelung', sevOf(F, ['Regelung', 'Ruhephasen']), block(F, ['Regelung', 'Ruhephasen']) + '<div class="figs"></div>', [f(Fg.stepResp), f(Fg.tracking), f(Fg.hover), f(Fg.spectro)]);
    add('Propwash', sevOf(F, ['Propwash']), block(F, ['Propwash']) + (it.WR && it.WR.length ? '<h3>Empfehlungen</h3>' + pidHtml(it.WR) : '') + '<div class="figs"></div>', [f(Fg.propwash)]);
    add('Motoren', sevOf(F, ['Motoren']), block(F, ['Motoren']) + '<div class="figs"></div>', [f(Fg.motors)]);
    if (m.hasVolt) add('Akku', sevOf(F, ['Akku']), block(F, ['Akku']) + '<div class="figs"></div>', [f(Fg.battery)]);
    add('Vibration', sevOf(F, ['Vibration', 'Filter']), block(F, ['Vibration', 'Filter']) + (it.VR && it.VR.length ? '<h3>Filter-Empfehlungen</h3>' + pidHtml(it.VR) : '') + vibTable(m.vib) + '<div class="figs"></div>', [f(Fg.vibSpectrum), f(Fg.thrMap), f(Fg.vibLevel), f(Fg.dterm)]);
    add('PID & Filter', R.length ? 'hint' : 'ok', "<p class='small'>Basierend auf den gemessenen Werten dieses Fluges. Immer nur einen Parameter pro Flug aendern und danach erneut loggen. Vor Aenderungen im CLI <code>diff all</code> sichern.</p>" + pidHtml(R));
    add('Einstellungen', 'none', '<h3>Einstellungen aus dem Log</h3>' + settingsTable(m.hdr || {}) + '<h3>Alle Kennzahlen</h3>' + detailTable(m));
    return tabs;
  }

  var DATA = null, CUR = 0, TAB = 0, TABS = null, LOGO = window.__LOGO__ || '', worker = null;
  function msg(t, err, spin) { $('hero').innerHTML = ''; $('body').innerHTML = '<div id="msg" class="' + (err ? 'err' : '') + '">' + (spin ? LOGO : '') + t + '</div>'; $('tabs').innerHTML = ''; }
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
  window.__bf = { analyze: analyze };
})();
