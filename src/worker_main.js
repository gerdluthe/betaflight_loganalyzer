/* Worker: BBL parsen + analysieren + Plot-Daten berechnen */
self.onmessage = function (e) {
  var d = e.data;
  try {
    var logs = BBL.parse(d.buf), out = [];
    for (var i = 0; i < logs.length; i++) {
      self.postMessage({ progress: 'Analysiere Log ' + (i + 1) + ' von ' + logs.length + ' ...' });
      var df = RFA.prepare(logs[i]);
      if (!df || !df.n || df.t[df.n - 1] < 20) continue;
      var name = d.name.replace(/\.[^.]*$/, '') + (logs.length > 1 ? ' (Log ' + (i + 1) + ')' : '');
      var m = RFA.analyze(df, logs[i].header, name, d.cells || null);
      var item = { name: name, m: m };
      if (m.ok) { item.F = RFF.makeFindings(m); item.R = RFF.makePidRecommendations(m); item.P = RFP.plotData(df, m); try { var V = RFV.analyze(m); m.vib = V; item.VR = RFV.recommendations(V, m); item.F = item.F.concat(RFV.findings(V, m)); item.R = item.R.concat(item.VR); } catch (e) { m.vib = { ok: false, error: String(e) }; item.VR = []; }
        try { var G = RFG.analyze(m); m.gtune = G; item.GR = RFG.recommendations(G, m); if (G.internal && G.ev) item.F.forEach(function (x) { if (x.area === 'Governor' && /Ueberschwinger|schiesst/.test(x.title) && x.todo) x.todo += ' Ob F wirklich die Ursache ist, zeigt die Lastwechsel-Auswertung weiter unten - massgeblich sind die Governor-PID-Empfehlungen.'; }); item.F = item.F.concat(RFG.findings(G, m)); item.R = item.R.filter(function (r) { return r.area !== 'PID Governor'; }).concat(item.GR); } catch (e2) { m.gtune = { ok: false }; item.GR = []; }
        item.sev = RFF.overallState(item.F); }
      delete m.fl; if (m.mot) delete m.mot.arr;
      out.push(item);
    }
    if (!out.length) throw new Error('Keine auswertbaren Logs gefunden (Log kuerzer als 20 s oder keine Daten dekodiert).');
    self.postMessage({ done: out });
  } catch (err) { self.postMessage({ error: String(err && err.message || err) }); }
};
