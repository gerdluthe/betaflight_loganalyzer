/* Governor-Abstimmung (interner Rotorflight-Governor): Anteile, Lastwechsel-Reaktion, Empfehlungen */
(function (root) {
  'use strict';
  var A = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./analysis.js') : root.RFA, U = A.util, T = A.THRESH;
  var median = U.median, fin = U.fin, pctl = U.percentile;
  var f0 = function (x) { return x.toFixed(0); }, f1 = function (x) { return x.toFixed(1); };
  var GT = { ev_min: 8, err_hint: 15, rec_slow: 0.6, offset: 8, dip_p01: -60 };

  function moments(a, idx) { var s = 0, s2 = 0, c = 0; for (var k = 0; k < idx.length; k++) { var v = a[idx[k]]; if (v === v) { s += v; s2 += v * v; c++; } } if (!c) return { mean: NaN, std: NaN }; var mu = s / c; return { mean: mu, std: Math.sqrt(Math.max(0, s2 / c - mu * mu)) }; }

  function analyze(m) {
    var G = { ok: false, internal: null }, fl = m.fl, fs = m.fs, hdr = m.hdr || {}, i;
    if (!fl || !m.ok) return G;
    G.gains = A.pidParts(hdr.govPID);
    var need = ['govSum', 'govP', 'govI', 'govD', 'govF'];
    if (!need.every(function (k) { return fl.has(k); })) { G.reason = 'Die Governor-Anteile (govP, govI, ...) sind im Log nicht enthalten.'; return G; }
    var sum = fl.get('govSum'), gp = fl.get('govP'), gi = fl.get('govI'), gd = fl.get('govD'), gf = fl.get('govF'), hs = fl.get('headspeed'), tg = fl.get('govTarget'), rc = fl.get('rcCommand[3]');
    var act = Math.max(U.nanmax(sum), 0) > 0 && (Math.max(U.nanmax(gp), -U.nanmin(gp)) + Math.max(U.nanmax(gi), -U.nanmin(gi)) + U.nanmax(gf)) > 0;
    G.internal = act; G.ok = true;
    if (!act) { G.reason = 'Die Governor-Anteile sind im ganzen Flug 0 - die Drehzahl wird nicht vom internen Rotorflight-Governor geregelt (z. B. ESC-Governor oder Gaskurve).'; return G; }
    var n = fl.n, idx = []; for (i = 0; i < n; i++) if (Math.abs(tg[i] - m.target) <= 2 || !m.target_fixed) idx.push(i);
    G.terms = { P: moments(gp, idx), I: moments(gi, idx), D: moments(gd, idx), F: moments(gf, idx), S: moments(sum, idx) };
    var e = new Float64Array(n); for (i = 0; i < n; i++) e[i] = hs[i] - tg[i];
    G.series = { t: fl.t, e: e, P: gp, I: gi, D: gd, F: gf };
    // Lastwechsel: schneller Kollektiv-Anstieg / -Abfall
    G.ev = null;
    if (m.target_fixed && rc && fs > 100) {
      var w = Math.max(3, Math.round(0.2 * fs)), cs = new Float64Array(n), dc = new Float64Array(n), h = Math.floor(w / 2);
      for (i = 0; i < n; i++) { var s = 0, c = 0; for (var j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) { s += rc[j]; c++; } cs[i] = s / c; }
      for (i = 1; i < n - 1; i++) dc[i] = (cs[i + 1] - cs[i - 1]) * fs / 2;
      var ad = Array.prototype.map.call(dc, Math.abs), thr = pctl(ad, 90), win0 = Math.round(0.1 * fs), win1 = Math.round(0.8 * fs), gap = Math.round(0.6 * fs), last = -1e9, up = [], dn = [];
      for (i = w; i < n - Math.round(3 * fs); i++) {
        if (ad[i] < thr || i - last < gap) continue;
        var lo = Math.max(0, i - w), hi = Math.min(n, i + w), isMax = true;
        for (var q = lo; q < hi; q++) if (ad[q] > ad[i] && Math.sign(dc[q]) === Math.sign(dc[i])) { isMax = false; break; }
        if (!isMax) continue; last = i;
        var sm = 0, mx = -1e9, mn = 1e9; for (q = i + win0; q < i + win1; q++) sm += e[q]; sm /= (win1 - win0);
        for (q = i; q < i + win1; q++) { if (e[q] > mx) mx = e[q]; if (e[q] < mn) mn = e[q]; }
        var seg = e.subarray(i, i + Math.round(3 * fs)), k0 = 0, ab = 0; for (q = 0; q < seg.length; q++) if (Math.abs(seg[q]) > ab) { ab = Math.abs(seg[q]); k0 = q; }
        var jq = k0; while (jq < seg.length && Math.abs(seg[jq]) >= 20) jq++;
        (dc[i] > 0 ? up : dn).push({ mean: sm, max: mx, min: mn, rec: (jq - k0) / fs });
      }
      var med = function (a, k) { return median(a.map(function (x) { return x[k]; })); };
      if (up.length >= GT.ev_min && dn.length >= GT.ev_min) G.ev = { nUp: up.length, nDn: dn.length, upMean: med(up, 'mean'), dnMean: med(dn, 'mean'), upMax: med(up, 'max'), upMin: med(up, 'min'), dnMax: med(dn, 'max'), dnMin: med(dn, 'min'), recUp: med(up, 'rec'), recDn: med(dn, 'rec') };
    }
    return G;
  }

  function findings(G, m) {
    var F = [];
    function add(sev, title, obs, todo) { F.push({ sev: sev, area: 'Governor', title: title, obs: obs, todo: todo || '' }); }
    if (!G || !G.ok) { if (G && G.reason) add('info', 'Governor-Abstimmung nicht moeglich', G.reason, ''); return F; }
    if (!G.internal) { add('info', 'Interner Governor nicht aktiv', G.reason, 'Governor-PID-Empfehlungen entfallen. Bei ESC-Governor die Drehzahlregelung im ESC abstimmen.'); return F; }
    var t = G.terms, g = G.gains, gtxt = (g[0] === g[0] ? 'P ' + f0(g[0]) + ', I ' + f0(g[1]) + ', D ' + f0(g[2]) + ', F ' + f0(g[3]) : '');
    add('info', 'Governor-Anteile', 'Mittlerer Gas-Ausgang ' + f0(t.S.mean) + ' (Skala 0-1000). Den Grundanteil traegt der I-Anteil (Mittel ' + f0(t.I.mean) + '); P schwankt um +-' + f0(t.P.std) + ', F um +-' + f0(t.F.std) + ', D um +-' + f1(t.D.std) + '. Eingestellt laut Log: ' + gtxt + ' (Reihenfolge laut Header).', '');
    if (G.ev) {
      var ev = G.ev, big = Math.max(Math.abs(ev.upMean), Math.abs(ev.dnMean)) >= GT.err_hint, slow = Math.max(ev.recUp, ev.recDn) > GT.rec_slow;
      add(big || slow ? 'hint' : 'ok', 'Reaktion auf Kollektiv-Aenderungen',
        'Nach ' + ev.nUp + ' schnellen Kollektiv-Anstiegen liegt die Drehzahl im Mittel ' + (ev.upMean >= 0 ? '+' : '') + f0(ev.upMean) + ' U/min vom Ziel entfernt (groesster Ausschlag ' + f0(ev.upMax) + ' / ' + f0(ev.upMin) + '), nach ' + ev.nDn + ' schnellen Abfaellen ' + (ev.dnMean >= 0 ? '+' : '') + f0(ev.dnMean) + ' U/min (' + f0(ev.dnMax) + ' / ' + f0(ev.dnMin) + '). Rueckkehr in +-20 U/min nach median ' + f1(Math.max(ev.recUp, ev.recDn)) + ' s.' +
        ' Richtung: zu wenig Vorsteuerung (F) zeigt sich als Einbruch beim Anstieg, zu viel als Ueberschwingen beim Anstieg.', '');
    }
    return F;
  }

  function recommendations(G, m) {
    var R = [];
    if (!G || !G.ok || !G.internal) return R;
    var g = G.gains, P = g[0], I = g[1], D = g[2], Fv = g[3], gv = m.gov || {}, ev = G.ev, osc = m.osc || {}, seen = {}, cands = [];
    var oscPct = osc.n ? osc.n_big / osc.n * 100 : 0, oscF = osc.f && osc.f.length ? median(osc.f) : NaN, powerLimit = m.mot && (m.mot.near >= 10 || m.mot.peak >= 99);
    function step(v, pct) { return Math.max(2, Math.round(Math.abs(v) * pct / 100)); }
    function cand(prio, param, name, cur, dir, pct, why, title) {
      if (!(cur === cur) || seen[param + dir]) return;
      var nv = Math.max(0, cur + dir * step(cur, pct));
      cands.push({ prio: prio, param: param, title: title, why: why, cli: ['set ' + param + ' = ' + nv + '  # war ' + f0(cur) + ', ' + (dir > 0 ? '+' : '-') + pct + ' %'], name: name });
      seen[param + dir] = true;
    }
    if (powerLimit) { R.push({ area: 'PID Governor', title: 'Governor-PIDs erst nach der Leistungsreserve beurteilen', obs: 'Der Gas-Ausgang laeuft zeitweise am Limit. Einbrueche der Drehzahl sind dann eine Antriebsgrenze, keine Gain-Frage - zuerst Antrieb (Ritzel, Akku, Headspeed) pruefen.', cli: [], note: 'Siehe Reiter Antrieb.' }); return R; }
    if (gv.p01 !== undefined && gv.p01 <= GT.dip_p01) {
      if (ev && ev.upMean <= -GT.err_hint) cand(1, 'gov_f_gain', 'F', Fv, 1, 12, 'Beim Kollektiv-Anstieg bricht die Drehzahl im Mittel um ' + f0(-ev.upMean) + ' U/min ein: die Vorsteuerung (F) reagiert zu schwach.', 'F erhoehen (Einbruch bei Lastaufnahme)');
      else if (ev && Math.max(ev.recUp, ev.recDn) > GT.rec_slow) cand(2, 'gov_i_gain', 'I', I, 1, 10, 'Die Drehzahl kehrt nach einem Einbruch erst nach ' + f1(Math.max(ev.recUp, ev.recDn)) + ' s zurueck: der Integralanteil arbeitet zu langsam.', 'I erhoehen (langsame Rueckkehr)');
      else cand(3, 'gov_p_gain', 'P', P, 1, 10, 'Der 1-%-Wert der Abweichung liegt bei ' + f0(gv.p01) + ' U/min unter dem Ziel, ohne klares F- oder I-Muster: P etwas erhoehen.', 'P erhoehen (Einbruch unter Last)');
    }
    if (gv.p99 !== undefined && (gv.p99 >= T.over_p99_hint || gv.rate >= T.over_rate_hint)) {
      if (ev && ev.upMean >= GT.err_hint) cand(1, 'gov_f_gain', 'F', Fv, -1, 10, 'Beim Kollektiv-Anstieg liegt die Drehzahl im Mittel +' + f0(ev.upMean) + ' U/min ueber dem Ziel: die Vorsteuerung (F) gibt zu viel Gas.', 'F senken (Ueberschwingen bei Lastaufnahme)');
      else if (ev && ev.dnMean >= GT.err_hint) cand(1, 'gov_f_gain', 'F', Fv, 1, 10, 'Nach schnellem Kollektiv-Abfall liegt die Drehzahl im Mittel +' + f0(ev.dnMean) + ' U/min ueber dem Ziel: das Gas wird bei Lastabnahme nicht schnell genug zurueckgenommen.', 'F erhoehen (Ueberschwingen bei Lastabnahme)');
      else if (!(oscPct >= T.osc_pct_hint)) cand(3, 'gov_p_gain', 'P', P, -1, 10, 'Ueberschwinger (99-%-Wert +' + f0(gv.p99) + ' U/min, ' + f0(gv.rate) + ' pro Minute) ohne klares F-Muster bei den Lastwechseln: der Regler korrigiert zu hart - P etwas senken.', 'P senken (Ueberschwinger)');
    }
    if (oscPct >= T.osc_pct_hint) {
      var slow = oscF === oscF && oscF < 1.2;
      if (slow) cand(2, 'gov_i_gain', 'I', I, -1, 10, 'In ' + f0(oscPct) + ' % der Fenster pendelt die Drehzahl langsam (' + f1(oscF) + ' Hz): typisch fuer einen zu hohen Integralanteil.', 'I senken (langsames Pendeln)');
      else cand(2, 'gov_p_gain', 'P', P, -1, 10, 'In ' + f0(oscPct) + ' % der Fenster pendelt die Drehzahl' + (oscF === oscF ? ' mit ' + f1(oscF) + ' Hz' : '') + ': typisch fuer ein zu hohes P (Doku-Regel: P bis zu leichten Schwingungen erhoehen, dann um ein Drittel zurueck).', 'P senken (Pendeln)');
    }
    if (gv.median !== undefined && Math.abs(gv.median) >= GT.offset) cand(4, 'gov_i_gain', 'I', I, gv.median < 0 ? 1 : -1, 10, 'Die mittlere Abweichung vom Ziel betraegt ' + (gv.median >= 0 ? '+' : '') + f0(gv.median) + ' U/min: der Integralanteil gleicht den Dauerfehler nicht aus.', 'I anpassen (Dauerabweichung)');
    cands.sort(function (a, b) { return a.prio - b.prio; });
    var params = {}, firstDone = false;
    cands.forEach(function (c) {
      if (params[c.param]) { params[c.param].why += ' ' + c.why; return; }
      params[c.param] = c; c.order = R.length;
      R.push({ area: 'PID Governor', title: (firstDone ? 'Danach: ' : 'Erster Schritt: ') + c.title, obs: c.why, cli: c.cli, note: firstDone ? 'Erst nach dem Test des ersten Schritts, jeweils nur ein Wert pro Flug.' : 'Ein Wert pro Flug, danach gleiche Manoever (Pitch-Pumps, Funnel) fliegen und die Werte hier vergleichen. Reihenfolge der Governor-Werte im Header: P, I, D, F - bitte im Configurator (Reiter Governor) gegenpruefen.' });
      firstDone = true;
      c.ref = R[R.length - 1];
    });
    Object.keys(params).forEach(function (k) { var c = params[k]; c.ref.obs = c.why; });
    return R;
  }
  var api = { analyze: analyze, findings: findings, recommendations: recommendations, GT: GT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RFG = api;
})(typeof self !== 'undefined' ? self : this);
