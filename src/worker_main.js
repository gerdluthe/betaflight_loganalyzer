/* Worker: BBL parsen + analysieren + Plot-Daten berechnen */
function truncText(m, df) {
  var I = m.logInfo, mb = function (b) { return (b / 1048576).toFixed(1).replace('.', ',') + ' MB'; };
  return 'Die Aufzeichnung bricht nach ' + df.t[df.n - 1].toFixed(1).replace('.', ',') + ' s ab: Nur ' + mb(I.dataBytes) + ' der ' + mb(I.fileBytes) + ' grossen Datei enthalten Daten, der Rest ist leer (geloeschter Speicher), und die Ende-Markierung fehlt. ' +
    'Das Log wurde also nicht ordentlich geschlossen - typisch, wenn der Akku vor dem Disarmen abgezogen wird, die SD-Karte bzw. der Flash nicht mithaelt oder der Speicher waehrend des Flugs voll bzw. gestoert war.';
}
self.onmessage = function (e) {
  var d = e.data;
  function safe(fn, fb) { try { return fn(); } catch (err) { if (self.console) console.error(err); return fb; } }
  try {
    var logs = BBL.parse(d.buf), out = [];
    for (var i = 0; i < logs.length; i++) {
      self.postMessage({ progress: 'Analysiere Log ' + (i + 1) + ' von ' + logs.length + ' ...' });
      if (!logs[i].n) continue;
      var df = RFA.prepare(logs[i]);
      if (!df || df.n < 50 || df.t[df.n - 1] < 0.5) continue;
      var name = d.name.replace(/\.[^.]*$/, '') + (logs.length > 1 ? ' (Log ' + (i + 1) + ')' : '');
      var m = RFA.analyze(df, logs[i].header, name, d.cells || null), L = logs[i];
      m.logInfo = { endMarker: L.endMarker, dataBytes: L.dataBytes, tailBytes: L.tailBytes, tailBlank: L.tailBlank, fileBytes: L.fileBytes, last: i === logs.length - 1 };
      m.truncated = !L.endMarker && i === logs.length - 1 && L.tailBytes > 65536 && L.tailBlank > 0.9;
      if (!m.ok && m.truncated) m.error = (m.error ? m.error + ' ' : '') + truncText(m, df);
      var item = { name: name, m: m };
      if (m.ok) {
        item.F = RFF.makeFindings(m);
        if (m.short) item.F.unshift({ sev: 'warn', area: 'Log', title: 'Sehr kurzer Flug (' + m.flight_s.toFixed(1) + ' s)', obs: 'Ausgewertet werden nur ' + m.flight_s.toFixed(1) + ' s Flug. Sprungantwort, Propwash und Vibrationsspektrum brauchen mindestens 10-30 s mit Steuerbewegungen - diese Teile fallen aus oder sind nur grob.', todo: 'Fuer eine aussagekraeftige Auswertung 1-2 Minuten mit Flips, Rolls und Gas-Wechseln loggen.' });
        if (m.truncated) item.F.unshift({ sev: 'warn', area: 'Log', title: 'Aufzeichnung abgebrochen', obs: truncText(m, df),
          todo: 'Vor dem Abstecken immer disarmen. Bei SD-Karte: schnelle Karte (U3/V30) verwenden und im Configurator (Reiter Blackbox) neu formatieren; bei Onboard-Flash: vor dem Flug loeschen. Testweise die Lograte auf 1 kHz senken und einen Bodentest mit armen/disarmen loggen.' });
        // zu kurzer Flug: Sprungantwort/Propwash/Spektrum waeren Zufallswerte -> weglassen
        var S = m.short ? { ok: false } : safe(function () { return RFS.analyze(m); }, { ok: false }); m.step = S;
        var W = m.short ? { ok: false } : safe(function () { return RFW.analyze(m); }, { ok: false }); m.pw = W;
        var V = m.short ? { ok: false } : safe(function () { return RFV.analyze(m); }, { ok: false, error: 'Fehler in der Vibrationsanalyse' }); m.vib = V;
        item.SR = safe(function () { return RFS.recommendations(S, m); }, []);
        item.WR = safe(function () { return RFW.recommendations(W, m); }, []);
        item.VR = safe(function () { return RFV.recommendations(V, m); }, []);
        if (!m.short) item.F = item.F.concat(safe(function () { return RFS.findings(S, m); }, []), safe(function () { return RFW.findings(W, m); }, []), safe(function () { return RFV.findings(V, m); }, []));
        // Empfehlungen: Sprungantwort zuerst; je Achse nur eine PID-Empfehlung
        var seen = {}, setP = {}, R = [];
        (m.short ? [] : item.SR.concat(item.WR, RFF.makePidRecommendations(m), item.VR)).forEach(function (r) {
          if (/^PID (Roll|Nick|Gier)$/.test(r.area)) { if (seen[r.area]) return; seen[r.area] = true; }
          // denselben Parameter nicht doppelt aendern
          var cli = (r.cli || []).filter(function (c) { var k = /^set (\S+)/.exec(c); if (!k) return true; if (setP[k[1]]) return false; setP[k[1]] = true; return true; });
          if (cli.length < (r.cli || []).length) r = Object.assign({}, r, { cli: cli, note: (r.note ? r.note + ' ' : '') + 'Weitere Werte dieser Empfehlung stehen bereits weiter oben.' });
          R.push(r);
        });
        item.R = R;
        item.P = safe(function () { return RFP.plotData(df, m); }, {});
        item.sev = RFF.overallState(item.F);
      }
      delete m.fl;
      out.push(item);
    }
    if (!out.length) {
      var fw = logs.length ? String(logs[0].header['Firmware revision'] || logs[0].header['Firmware type'] || '') : '';
      throw new Error(fw && !/betaflight/i.test(fw) ? 'Dieses Log stammt von ' + fw.split(' (')[0] + ' - ausgewertet werden Betaflight-Logs.' : 'Keine auswertbaren Logs gefunden (Log zu kurz oder keine Daten dekodiert).');
    }
    self.postMessage({ done: out });
  } catch (err) { self.postMessage({ error: String(err && err.message || err) }); }
};
