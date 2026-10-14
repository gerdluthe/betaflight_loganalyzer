/* Sprungantwort je Achse (Wiener-Dekonvolution Soll -> Ist, Verfahren wie PID-Analyzer/PIDtoolbox) und PID-Empfehlungen mit Betaflight-CLI */
(function (root) {
  'use strict';
  var A = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./analysis.js') : root.RFA, U = A.util;
  var median = U.median, fin = U.fin;
  var f0 = function (x) { return x.toFixed(0); }, f1 = function (x) { return x.toFixed(1); };
  var AX = ['Roll', 'Nick', 'Gier'], AXC = ['roll', 'pitch', 'yaw'];
  var ST = { cut_hz: 25, resp_s: 0.5, min_sp: 20, high_sp: 500, min_win: 6,
    over_hint: 15, over_warn: 25, slow_t50: [25, 25, 40], ss_low: 0.85, ring_hint: 2 };

  // Gleitender Blockmittelwert zum Herunterrechnen sehr hoher Lograten (8 kHz -> ~1 kHz)
  function decim(a, d) { if (d <= 1) return a; var n = Math.floor(a.length / d), o = new Float64Array(n); for (var i = 0; i < n; i++) { var s = 0; for (var j = 0; j < d; j++) s += a[i * d + j]; o[i] = s / d; } return o; }

  function axisResponse(sp, gy, fs) {
    var N = U.pow2near(fs * 1.0); if (N > sp.length / 2) N = U.pow2near(sp.length / 4);
    var hop = N >> 2, L = Math.min(N, Math.round(ST.resp_s * fs)), w = U.hann(N);
    var xr = new Float64Array(N), xi = new Float64Array(N), yr = new Float64Array(N), yi = new Float64Array(N), hr = new Float64Array(N), hi = new Float64Array(N);
    var lam = new Float64Array(N);
    for (var k = 0; k < N; k++) { var f = Math.min(k, N - k) * fs / N, c = ST.cut_hz; lam[k] = f <= c ? 0.1 : f >= 1.5 * c ? 1e9 : Math.pow(10, -1 + 10 * (f - c) / (0.5 * c)); }
    var lowR = [], highR = [], wl = [], wh = [];
    for (var s0 = 0; s0 + N <= sp.length; s0 += hop) {
      var mx = 0, i; for (i = s0; i < s0 + N; i++) { var a = Math.abs(sp[i]); if (a > mx) mx = a; }
      if (mx < ST.min_sp) continue;
      var ms = 0, mg = 0; for (i = 0; i < N; i++) { ms += sp[s0 + i]; mg += gy[s0 + i]; } ms /= N; mg /= N;
      for (i = 0; i < N; i++) { xr[i] = (sp[s0 + i] - ms) * w[i]; xi[i] = 0; yr[i] = (gy[s0 + i] - mg) * w[i]; yi[i] = 0; }
      U.fft(xr, xi); U.fft(yr, yi);
      for (i = 0; i < N; i++) { var den = xr[i] * xr[i] + xi[i] * xi[i] + lam[i]; hr[i] = (yr[i] * xr[i] + yi[i] * xi[i]) / den; hi[i] = (yi[i] * xr[i] - yr[i] * xi[i]) / den; }
      U.fft(hr, hi, true);
      var stp = new Float64Array(L), acc = 0; for (i = 0; i < L; i++) { acc += hr[i]; stp[i] = acc; }
      var a0 = Math.round(0.2 * fs), ss = 0; for (i = a0; i < L; i++) ss += stp[i]; ss /= Math.max(1, L - a0);
      if (!(ss > 0.5 && ss < 2)) continue;              // unbrauchbares Fenster (zu wenig Anregung, Saettigung)
      if (mx < ST.high_sp) { lowR.push(stp); wl.push(mx); } else { highR.push(stp); wh.push(mx); }
    }
    function avg(R) { if (!R.length) return null; var o = new Float64Array(L); R.forEach(function (r) { for (var i = 0; i < L; i++) o[i] += r[i] / R.length; }); return o; }
    var main = lowR.length >= ST.min_win ? avg(lowR) : (lowR.length + highR.length >= ST.min_win ? avg(lowR.concat(highR)) : null);
    if (!main) return { ok: false, n: lowR.length + highR.length };
    var r = metrics(main, fs); r.ok = true; r.step = main; r.n = lowR.length; r.nHigh = highR.length; r.high = highR.length >= ST.min_win ? avg(highR) : null;
    if (r.high) r.highM = metrics(r.high, fs);
    return r;
  }
  function metrics(s, fs) {
    var L = s.length, a0 = Math.round(0.15 * fs), i, ss = median(Array.prototype.slice.call(s, a0));
    var pk = -1e9, ipk = 0, lim = Math.min(L, Math.round(0.3 * fs)); for (i = 0; i < lim; i++) if (s[i] > pk) { pk = s[i]; ipk = i; }
    var t50 = NaN, t90 = NaN; for (i = 0; i < L; i++) { if (t50 !== t50 && s[i] >= 0.5 * ss) t50 = i / fs * 1000; if (s[i] >= 0.9 * ss) { t90 = i / fs * 1000; break; } }
    var ring = 0, lastSide = 0; for (i = ipk; i < lim; i++) { var d = s[i] - ss, side = d > 0.05 * ss ? 1 : d < -0.05 * ss ? -1 : 0; if (side && side !== lastSide) { if (lastSide) ring++; lastSide = side; } }
    return { ss: ss, peak: pk, t_peak: ipk / fs * 1000, over: (pk / ss - 1) * 100, t50: t50, t90: t90, ring: ring };
  }

  function analyze(m) {
    var R = { ok: false }, fl = m.fl; if (!fl || !m.ok) return R;
    var d = m.fs > 2000 ? Math.round(m.fs / 1000) : 1, fs = m.fs / d;
    R.fs = fs; R.ax = [];
    for (var k = 0; k < 3; k++) {
      if (!fl.has('setpoint[' + k + ']') || !fl.has('gyroADC[' + k + ']')) { R.ax.push({ ok: false, n: 0 }); continue; }
      R.ax.push(axisResponse(decim(fl.get('setpoint[' + k + ']'), d), decim(fl.get('gyroADC[' + k + ']'), d), fs));
    }
    R.ok = R.ax.some(function (a) { return a.ok; });
    R.synth = !!m.sp_synth;
    return R;
  }

  function verdict(a, k) {
    if (!a.ok) return null;
    if (a.over >= ST.over_warn) return 'warn';
    if (a.over >= ST.over_hint || a.ring >= ST.ring_hint || a.ss < ST.ss_low || (a.over < 3 && a.t50 > ST.slow_t50[k])) return 'hint';
    return 'ok';
  }
  function findings(R, m) {
    var F = [];
    function add(sev, title, obs, todo) { F.push({ sev: sev, area: 'Regelung', title: title, obs: obs, todo: todo || '' }); }
    if (!R || !R.ok) { add('info', 'Sprungantwort nicht berechenbar', m.fl && !m.fl.has('setpoint[0]') ? 'Im Log fehlt die Sollrate (setpoint).' : 'Zu wenig Stick-Bewegung im Flug (mindestens einige Sekunden mit Steuerausschlaegen ueber ' + ST.min_sp + ' deg/s je Achse noetig).', 'Fuer eine Tuning-Auswertung einen Flug mit kraeftigen Roll-/Nick-Bewegungen (Snaps, Flips) und ruhigen Phasen dazwischen loggen.'); return F; }
    if (R.synth) add('info', 'Sollrate aus Stickwerten berechnet', 'Dieses Log enthaelt keine setpoint-Werte (Betaflight vor 3.2). Die Sollrate wurde aus rcCommand und den Rates im Header nachgerechnet - die Sprungantwort ist dadurch etwas ungenauer.', '');
    R.ax.forEach(function (a, k) {
      if (!a.ok) { add('info', AX[k] + ': zu wenig Anregung', 'Nur ' + a.n + ' brauchbare Fenster fuer die Sprungantwort (mindestens ' + ST.min_win + ' noetig).', ''); return; }
      var sev = verdict(a, k), obs = AX[k] + ': Ueberschwingen ' + f0(Math.max(0, a.over)) + ' %, 50 % des Sollwerts nach ' + f0(a.t50) + ' ms, 90 % nach ' + fnum(a.t90) + ' ms, Endwert ' + a.ss.toFixed(2) + ' (ideal 1,0)' + (a.ring ? ', ' + a.ring + 'x Nachschwingen' : '') + '. Aus ' + a.n + ' Fenstern.';
      var todo = '', title;
      if (a.over >= ST.over_hint) { title = AX[k] + ' schiesst ueber'; todo = 'Zu viel P im Verhaeltnis zu D (oder zu viel Feedforward): D bzw. D-Min um 10 % erhoehen oder P um 10 % senken. Danach erneut loggen und vergleichen.'; }
      else if (a.ring >= ST.ring_hint) { title = AX[k] + ' schwingt nach'; todo = 'Nachschwingen deutet auf zu wenig Daempfung: D um 10 % erhoehen. Werden die Motoren dabei warm, zuerst Filter/Mechanik pruefen (Reiter Vibration).'; }
      else if (a.ss < ST.ss_low) { title = AX[k] + ' erreicht den Sollwert nicht ganz'; todo = 'Der Endwert bleibt unter dem Soll: I-Anteil um 10-15 % erhoehen; bei vielen Motor-Saettigungen ist es eine Leistungsgrenze.'; }
      else if (a.over < 3 && a.t50 > ST.slow_t50[k]) { title = AX[k] + ' reagiert traege'; todo = 'Kein Ueberschwingen, aber langsamer Anstieg: P (und ggf. Feedforward) um 10 % erhoehen, bis ein leichtes Ueberschwingen von 5-10 % sichtbar wird.'; }
      else title = AX[k] + ': saubere Sprungantwort';
      add(sev, title, obs, todo);
    });
    return F;
  }
  function fnum(x) { return fin(x) ? x.toFixed(0) : '-'; }

  // PID-Empfehlungen (Betaflight-CLI); je Achse hoechstens ein Schritt
  function recommendations(R, m) {
    var out = []; if (!R || !R.ok) return out;
    var hdr = m.hdr || {}, dmin = A.param(hdr, 'dmin'), ff = A.param(hdr, 'ff'), sat = m.mot && m.mot.sat_pct >= 5;
    R.ax.forEach(function (a, k) {
      var pid = A.nums(hdr[AXC[k] + 'PID']), P = pid[0], I = pid[1], D = pid[2], dm = dmin.v[k], fv = ff.v[k], cli = [], title, obs, note;
      var SM = A.simplified(hdr), simp = SM.pids > 0 && (k < 2 || SM.pids === 1);
      // Simplified-Tuning-Schieber statt Einzelwert (Schieber in %, 100 = Standard)
      function sset(kind, pct) {
        var key = { d: k === 1 && SM.pd > 0 ? 'simplified_pitch_d_gain' : 'simplified_d_gain', p: k === 1 && SM.ppi > 0 ? 'simplified_pitch_pi_gain' : 'simplified_pi_gain', i: 'simplified_i_gain', f: 'simplified_feedforward_gain' }[kind];
        var cur = { simplified_d_gain: SM.d, simplified_pitch_d_gain: SM.pd, simplified_pi_gain: SM.pi, simplified_pitch_pi_gain: SM.ppi, simplified_i_gain: SM.i, simplified_feedforward_gain: SM.ff }[key];
        if (!fin(cur)) return false; cli.push('set ' + key + ' = ' + Math.max(0, Math.round(cur + pct)) + '  # war ' + f0(cur) + ', Schieber ' + (pct > 0 ? '+' : '') + pct); return true;
      }
      function set(name, cur, pct) {
        if (simp) { var kind = /^d_/.test(name) ? 'd' : /^p_/.test(name) ? 'p' : /^i_/.test(name) ? 'i' : /^f_/.test(name) ? 'f' : null; if (kind && sset(kind, pct)) return; } if (!fin(cur)) return; var nv = Math.max(0, Math.round(cur * (1 + pct / 100))); if (nv === cur) nv = cur + (pct > 0 ? 1 : -1); cli.push('set ' + name + ' = ' + nv + '  # war ' + f0(cur) + ', ' + (pct > 0 ? '+' : '') + pct + ' %'); }
      if (!a.ok) return;
      var useDmin = dmin.key === 'd_min' && dm > 0 && dm < D;   // BF 4.0-4.5: D = Maximum, d_min = Grundwert
      if (a.over >= ST.over_hint || a.ring >= ST.ring_hint) {
        if (k === 2 && !(D > 0)) { set('p_yaw', P, -10); title = 'Gier: P senken'; }
        else { if (useDmin) set(dmin.cli[k], dm, 10); else set('d_' + AXC[k], D, 10); title = AX[k] + ': D erhoehen (' + (a.over >= ST.over_hint ? 'Ueberschwingen' : 'Nachschwingen') + ')'; }
        obs = AX[k] + ': Ueberschwingen ' + f0(Math.max(0, a.over)) + ' %, ' + a.ring + 'x Nachschwingen.';
        note = 'Alternative bei warmen Motoren: P um 10 % senken (' + (simp ? 'Schieber ' + (k === 1 && SM.ppi > 0 ? 'simplified_pitch_pi_gain' : 'simplified_pi_gain') + ' um 10 senken' : 'set p_' + AXC[k] + ' = ' + (fin(P) ? Math.round(P * 0.9) : '?')) + '). ' + (fin(fv) && fv > 0 && a.t_peak < 25 ? 'Die Spitze kommt sehr frueh (' + f0(a.t_peak) + ' ms) - das kann auch Feedforward sein: ' + ff.cli[k] + ' testweise um 10 % senken.' : '');
      } else if (a.ss < ST.ss_low && !sat) {
        set('i_' + AXC[k], I, 15); title = AX[k] + ': I erhoehen'; obs = AX[k] + ': Endwert der Sprungantwort ' + a.ss.toFixed(2) + ' - der Sollwert wird nicht ganz gehalten.';
      } else if (a.over < 3 && a.t50 > ST.slow_t50[k]) {
        set('p_' + AXC[k], P, 10); if (fin(fv) && fv > 0 && k < 2) set(ff.cli[k], fv, 10);
        title = AX[k] + ': P/Feedforward erhoehen (traege)'; obs = AX[k] + ': 50 % des Sollwerts erst nach ' + f0(a.t50) + ' ms, kein Ueberschwingen.';
      } else return;
      out.push({ area: 'PID ' + AX[k], title: title, obs: obs, cli: cli, note: (note ? note + ' ' : '') + 'Ein Wert pro Flug.' + (simp ? ' Simplified Tuning ist aktiv - deshalb werden die Schieber verstellt (wirken auf Roll und Nick gemeinsam, Nick ueber den eigenen Nick-Schieber zusaetzlich). Im Configurator (PID-Tuning) sieht man das Ergebnis.' : '') });
    });
    return out;
  }
  var api = { analyze: analyze, findings: findings, recommendations: recommendations, verdict: verdict, ST: ST, AX: AX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RFS = api;
})(typeof self !== 'undefined' ? self : this);
