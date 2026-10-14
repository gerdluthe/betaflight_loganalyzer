VERSION = "1.5.1"  # naechste: 1.6.0, 1.7.0 ...
import sys, json, re
sys.path.insert(0, '.')
import matplotlib; matplotlib.use('Agg')
import rf_loganalyzer as rf, rf_loganalyzer_app as app
S = lambda f: open('src/' + f, encoding='utf-8').read()
css = rf.CSS + app.APP_CSS + """
canvas{max-width:100%}
.figwrap{margin:14px 0}
input,select,button{font-family:inherit}
@media(max-width:700px){
 .top{padding:10px 14px;gap:8px}.brand h1{font-size:16px}
 #tabs{padding:8px 10px;flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
 #tabs::-webkit-scrollbar{display:none}#tabs button{white-space:nowrap;padding:8px 13px;font-size:13px}
 .wrap{padding:6px 12px 60px}#hero h2{font-size:18px;word-break:break-all}
 .kpis{grid-template-columns:repeat(2,1fr);gap:10px}.kpi span{font-size:23px}.kpi{padding:12px 13px}
 figure{padding:6px;border-radius:14px}.find{padding:12px 14px}table{font-size:12px}
 .cards{grid-template-columns:repeat(2,1fr)}
}
.top{padding-top:max(14px,env(safe-area-inset-top))}
"""
workers = ''.join(S(f) + '\n' for f in ['bbl.js', 'analysis.js', 'findings.js', 'vibration.js', 'govtune.js', 'plotdata.js', 'worker_main.js'])
main = ''.join(S(f) + '\n' for f in ['analysis.js', 'findings.js', 'charts.js', 'figures.js', 'ui.js'])
# im Haupt-Thread: ROTOR global
rotor = app.ROTOR
small = rotor.replace('class="rotor"', 'style="width:44px;height:44px"')
for tag in ('</script>',):
    assert tag not in workers and tag not in main
html = f"""<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0a0f1e">
<title>Rotorflight Log Analyzer</title><style>{css}</style></head><body>
<div class="top"><div class="brand">{small}<div><h1>Rotorflight Log Analyzer</h1><small>Blackbox-Auswertung &middot; offline &middot; <span class="ver">v{VERSION}</span></small></div></div>
<label class="btn go" style="cursor:pointer"><input id="file" type="file" accept=".bbl,.BBL" style="display:none"><span id="fname">Log-Datei w&auml;hlen &hellip;</span></label>
<label class="l">Zellen</label><input id="cells" type="number" min="0" max="14" value="0" style="width:60px" title="0 = automatisch">
<select id="flight" style="display:none"></select></div>
<div id="tabs"></div><div class="wrap"><div id="hero"></div><div id="body"><div id="msg" class="empty">{rotor}Tippe oben auf &bdquo;Log-Datei w&auml;hlen&ldquo; (.bbl) &ndash; die Auswertung startet sofort. Alles l&auml;uft lokal auf dem Ger&auml;t.</div></div></div>
<script type="text/js-worker" id="wsrc">{workers}</script>
<script>
window.__ROTOR__={json.dumps(rotor)};
(function(){{var s=document.getElementById('wsrc').textContent;window.__WORKER_URL__=URL.createObjectURL(new Blob([s],{{type:'text/javascript'}}));}})();
</script>
<script>{main}</script></body></html>"""
open('dist_index.html', 'w', encoding='utf-8').write(html)
print(len(html) // 1024, 'KB')
