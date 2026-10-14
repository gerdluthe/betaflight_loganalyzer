VERSION = "1.6.0"  # naechste: 1.7.0, 1.8.0 ...
"""Baut dist_index.html (eine einzige HTML-Datei, laeuft offline) und kopiert sie nach bf_tauri/www/index.html.
Aufruf: python3 build.py   (nur Python-Standardbibliothek noetig)"""
import json, os, re, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
S = lambda f: open(os.path.join(HERE, 'src', f), encoding='utf-8').read()
css = S('style.css') + """
canvas{max-width:100%}
.figwrap{margin:14px 0}
input,select,button{font-family:inherit}
code{background:#1e293b;padding:1px 5px;border-radius:4px;font-size:.92em}
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
workers = ''.join(S(f) + '\n' for f in ['bbl.js', 'analysis.js', 'findings.js', 'vibration.js', 'stepresp.js', 'propwash.js', 'plotdata.js', 'worker_main.js'])
main = ''.join(S(f) + '\n' for f in ['analysis.js', 'findings.js', 'propwash.js', 'charts.js', 'figures.js', 'ui.js'])
logo = S('logo.svg').strip()
small = logo.replace('class="logo"', 'style="width:44px;height:44px"')
for tag in ('</script>',):
    assert tag not in workers and tag not in main
html = f"""<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0a0f1e">
<title>Betaflight Log Analyzer</title><style>{css}</style></head><body>
<div class="top"><div class="brand">{small}<div><h1>Betaflight Log Analyzer</h1><small>Blackbox-Auswertung &middot; offline &middot; <span class="ver">v{VERSION}</span></small></div></div>
<label class="btn go" style="cursor:pointer"><input id="file" type="file" accept=".bbl,.BBL,.bfl,.BFL,.txt,.TXT" style="display:none"><span id="fname">Log-Datei w&auml;hlen &hellip;</span></label>
<label class="l">Zellen</label><input id="cells" type="number" min="0" max="14" value="0" style="width:60px" title="0 = automatisch">
<select id="flight" style="display:none"></select></div>
<div id="tabs"></div><div class="wrap"><div id="hero"></div><div id="body"><div id="msg" class="empty">{logo}Tippe oben auf &bdquo;Log-Datei w&auml;hlen&ldquo; (.bbl / .bfl) &ndash; die Auswertung startet sofort. Alles l&auml;uft lokal auf dem Ger&auml;t.</div></div></div>
<script type="text/js-worker" id="wsrc">{workers}</script>
<script>
window.__LOGO__={json.dumps(logo)};
(function(){{var s=document.getElementById('wsrc').textContent;window.__WORKER_URL__=URL.createObjectURL(new Blob([s],{{type:'text/javascript'}}));}})();
</script>
<script>{main}</script></body></html>"""
open(os.path.join(HERE, 'dist_index.html'), 'w', encoding='utf-8').write(html)
www = os.path.join(HERE, 'bf_tauri', 'www', 'index.html')
if os.path.isdir(os.path.dirname(www)):
    shutil.copyfile(os.path.join(HERE, 'dist_index.html'), www)
# Version in den App-Konfigurationen nachziehen
for rel, pat, rep in [('bf_tauri/package.json', r'("version":\s*")[^"]+(")', r'\g<1>' + VERSION + r'\2'),
                      ('bf_tauri/src-tauri/tauri.conf.json', r'("version":\s*")[^"]+(")', r'\g<1>' + VERSION + r'\2'),
                      ('bf_tauri/src-tauri/Cargo.toml', r'(?m)^(version\s*=\s*")[^"]+(")', r'\g<1>' + VERSION + r'\2'),
                      ('bf_tauri/android-app/package.json', r'("version":\s*")[^"]+(")', r'\g<1>' + VERSION + r'\2')]:
    p = os.path.join(HERE, rel)
    if os.path.exists(p):
        t = open(p, encoding='utf-8').read(); t2 = re.sub(pat, rep, t, count=1)
        if t2 != t: open(p, 'w', encoding='utf-8').write(t2)
print(len(html) // 1024, 'KB, v' + VERSION)
