/* Worker: BBL parsen + analysieren + Plot-Daten berechnen */
self.onmessage = function (e) {
  var d = e.data;
  function safe(fn, fb) { try { return fn(); } catch (err) { if (self.console) console.error(err); return fb; } }
  try {
    var logs = BBL.parse(d.buf), out = [];
    for (var i = 0; i < logs.length; i++) {
      self.postMessage({ progress: 'Analysiere Log ' + (i + 1) + ' von ' + logs.length + ' ...' });
      if (!logs[i].n) continue;
      var df = RFA.prepare(logs[i]);
      if (!df || !df.n || df.t[df.n - 1] < 5) continue;
      var name = d.name.replace(/\.[^.]*$/, '') + (logs.length > 1 ? ' (Log ' + (i + 1) + ')' : '');
      var m = RFA.analyze(df, logs[i].header, name, d.cells || null);
      var item = { name: name, m: m };
      if (m.ok) {
        item.F = RFF.makeFindings(m);
        var S = safe(function () { return RFS.analyze(m); }, { ok: false }); m.step = S;
        var W = safe(function () { return RFW.analyze(m); }, { ok: false }); m.pw = W;
        var V = safe(function () { return RFV.analyze(m); }, { ok: false, error: 'Fehler in der Vibrationsanalyse' }); m.vib = V;
        item.SR = safe(function () { return RFS.recommendations(S, m); }, []);
        item.WR = safe(function () { return RFW.recommendations(W, m); }, []);
        item.VR = safe(function () { return RFV.recommendations(V, m); }, []);
        item.F = item.F.concat(safe(function () { return RFS.findings(S, m); }, []), safe(function () { return RFW.findings(W, m); }, []), safe(function () { return RFV.findings(V, m); }, []));
        // Empfehlungen: Sprungantwort zuerst; je Achse nur eine PID-Empfehlung
        var seen = {}, setP = {}, R = [];
        item.SR.concat(item.WR, RFF.makePidRecommendations(m), item.VR).forEach(function (r) {
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
