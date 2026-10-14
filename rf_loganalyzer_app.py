#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rf_loganalyzer_app.py - Rotorflight Log Analyzer als lokale App mit Reitern
===========================================================================
Start:   python rf_loganalyzer_app.py
Dann oeffnet sich der Browser (nur lokal, 127.0.0.1). Dort BBL-Datei waehlen, "Analysieren" klicken,
anschliessend zwischen den Reitern Heck / Governor / Antrieb / Akku ... wechseln.

Benoetigt: rf_loganalyzer.py im selben Ordner, numpy, pandas, matplotlib und blackbox_decode(.exe).
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import traceback
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import rf_loganalyzer as rf

BG = "#0e1424"
plt.rcParams.update({"figure.facecolor": BG, "axes.facecolor": "#121a2e", "savefig.facecolor": BG, "axes.edgecolor": "#2a3552",
                     "axes.labelcolor": "#b6c0d9", "text.color": "#d5dcee", "xtick.color": "#8d98b3", "ytick.color": "#8d98b3",
                     "grid.color": "#9fb0d8", "grid.alpha": .13, "legend.facecolor": "#121a2e", "legend.edgecolor": "#2a3552",
                     "axes.titlecolor": "#e6ebf5", "axes.titlesize": 10})
rf.C.update(blue="#60a5fa", orange="#fb923c", green="#34d399", red="#f87171", grey="#94a3b8", purple="#a78bfa")

CONF = os.path.join(os.path.expanduser("~"), ".rf_loganalyzer_app.json")


def load_conf():
    try:
        return json.load(open(CONF, encoding="utf-8"))
    except Exception:
        return {}


def save_conf(c):
    try:
        json.dump(c, open(CONF, "w", encoding="utf-8"))
    except Exception:
        pass


# --------------------------------------------------------------------------------------
# Zusaetzliche Diagramme fuer die Reiter Antrieb und Akku
# --------------------------------------------------------------------------------------
def plot_power(m):
    mo = m.get("mot")
    if not mo:
        return None
    fl = m["fl"]
    x = rf.col(fl, mo["src"])
    x = x / (10.0 if x.max() > 100 else 1.0)
    fig, ax = plt.subplots(3, 1, figsize=(11, 7), sharex=True)
    ax[0].plot(fl["t"], x, color=rf.C["blue"], lw=.8)
    ax[0].axhline(95, color=rf.C["red"], ls="--", lw=1)
    ax[0].set_ylabel("Motor-Ausgang [%]"); ax[0].set_ylim(0, 105)
    ax[0].set_title("Motor-Ausgang (rot = 95 %-Grenze), Strom und Spannung")
    ax[1].plot(fl["t"], fl["I"], color=rf.C["red"], lw=.7); ax[1].set_ylabel("Strom [A]")
    ax[2].plot(fl["t"], fl["V"], color=rf.C["green"], lw=.8); ax[2].set_ylabel("Spannung [V]")
    te = rf.col(fl, "Tesc")
    if te.notna().any():
        a2 = ax[2].twinx(); a2.plot(fl["t"], te, color=rf.C["purple"], lw=.8); a2.set_ylabel("ESC [C]"); a2.grid(False)
    ax[2].set_xlabel("Zeit [s]")
    fig.tight_layout()
    return rf.fig_b64(fig)


def plot_battery(m):
    fl = m["fl"]
    fig, ax = plt.subplots(1, 2, figsize=(11, 3.8), gridspec_kw={"width_ratios": [1.6, 1]})
    v = fl["V"].rolling(25, center=True, min_periods=1).median()
    ax[0].plot(fl["t"], fl["V"], color=rf.C["grey"], lw=.5, alpha=.6, label="roh")
    ax[0].plot(fl["t"], v, color=rf.C["green"], lw=1.2, label="geglaettet")
    ax[0].set_xlabel("Zeit [s]"); ax[0].set_ylabel("Packspannung [V]"); ax[0].set_title("Spannung ueber den Flug"); ax[0].legend()
    x, vc = m["curve"]
    ax[1].plot(x, vc, color=rf.C["blue"])
    ax[1].set_xlabel("verbrauchte Kapazitaet [mAh]"); ax[1].set_ylabel("Spannung pro Zelle [V]"); ax[1].set_title("Entladekurve")
    fig.tight_layout()
    return rf.fig_b64(fig)


def safe(fn, *a):
    try:
        return fn(*a)
    except Exception as ex:
        return "ERR:" + str(ex)


def figs(items):
    out = []
    for b, cap, alt in items:
        if not b:
            continue
        if isinstance(b, str) and b.startswith("ERR:"):
            out.append(f'<div class="small">Diagramm "{rf.esc(alt)}" uebersprungen ({rf.esc(b[4:])}).</div>')
        else:
            out.append(rf.figure(b, cap, alt))
    return "".join(out)


def block(F, areas, empty="Keine Auswertung fuer diesen Bereich (Daten fehlen im Log)."):
    sub = [f for f in F if f["area"] in areas]
    return rf.findings_html(sub) if sub else f'<div class="find info">{rf.esc(empty)}</div>'


def sev_of(F, areas):
    sv = [f["sev"] for f in F if f["area"] in areas]
    return min(sv, key=lambda s: rf.RANK[s]) if sv else "none"


# --------------------------------------------------------------------------------------
def kpis(m):
    mo = m.get("mot")
    nan = lambda v: v is None or (isinstance(v, float) and np.isnan(v))
    items = [
        ("Flugzeit", f"{m['flight_s']:.0f} s", f"Ziel {m['target']:.0f} U/min"),
        ("Min. Spannung", f"{m['v_min']:.1f} V", f"{m['v_min_cell']:.2f} V/Zelle &middot; {m['cells']}S"),
        ("Verbrauch", f"{m['mah']:.0f} mAh", f"{m['wh']:.0f} Wh"),
        ("Spitzenstrom", f"{m['i_peak']:.0f} A", f"{m['p_peak'] / 1000:.1f} kW Spitze"),
        ("Antriebsreserve", f"{mo['reserve']:.0f} %" if mo else "&ndash;", f"Ausgang &oslash; {mo['mean']:.0f} %" if mo else "kein Gas-Wert"),
        ("ESC max.", "&ndash;" if nan(m["t_esc_max"]) else f"{m['t_esc_max']:.0f} &deg;C", "nicht geloggt" if nan(m["t_esc_max"]) else f"Start {m['t_esc_start']:.0f} &deg;C"),
    ]
    return '<div class="kpis">' + "".join(f"<div class='kpi'><b>{a}</b><span>{b}</span><small>{c}</small></div>" for a, b, c in items) + "</div>"


def build_flight(m, df):
    """Gibt Liste von Reitern [{id,title,sev,html}] zurueck."""
    if not m["ok"]:
        return [dict(id="info", title="Info", sev="info", html=f'<div class="find info">{rf.esc(m.get("error", ""))}</div>')]
    F = rf.make_findings(m)
    C = rf.CAPTIONS
    recs = rf.make_pid_recommendations(m)
    sub = (f'<div class="sub">Flugphase {m["flight_s"]:.0f} s | Ziel {m["target"]:.0f} U/min '
           f'({"fest" if m["target_fixed"] else "variabel"}) | {m["mah"]:.0f} mAh</div>')
    tabs = []

    def add(id_, title, sev, body):
        tabs.append(dict(id=id_, title=title, sev=sev, html=body))

    add("uebersicht", "Uebersicht", rf.overall_state(F),
        sub + kpis(m) + rf.fazit_html(F) + f'<div class="cards">{rf.cards_for(F)}</div>'
        + figs([(safe(rf.plot_overview, m, df), C["overview"], "Uebersicht")])
        + "<h3>Signal / Telemetrie</h3>" + block(F, ["Signal", "Log"]))
    add("heck", "Heck", sev_of(F, ["Heck"]),
        block(F, ["Heck"]) + figs([(safe(rf.plot_yaw, m, df), C["yaw"], "Heck"),
                                   (safe(rf.plot_spectrogram, m), C["spectro"], "Schwingungs-Karte")]))
    add("governor", "Governor", sev_of(F, ["Governor", "ESC/Telemetrie"]),
        block(F, ["Governor", "ESC/Telemetrie"]) + figs([(safe(rf.plot_governor, m, df), C["governor"], "Governor"),
                                                         (safe(rf.plot_load, m), C["load"], "Last")]))
    add("antrieb", "Antrieb", sev_of(F, ["Antrieb", "ESC"]),
        block(F, ["Antrieb", "ESC"]) + figs([(safe(plot_power, m),
                                              "Motor-Ausgang des Flugreglers, Strom, Spannung und ESC-Temperatur im Flug. "
                                              "Flache Spitzen an der roten Linie = Antrieb am Limit.", "Antrieb")]))
    add("akku", "Akku", sev_of(F, ["Akku"]),
        block(F, ["Akku"]) + figs([(safe(plot_battery, m), "Links die Packspannung, rechts die Spannung pro Zelle ueber der verbrauchten Kapazitaet.", "Akku")]))
    add("servos", "Servos", sev_of(F, ["Servos"]),
        block(F, ["Servos"]) + figs([(safe(rf.plot_servos, m), C["servos"], "Servos")]))
    add("vibration", "Vibration", sev_of(F, ["Hover"]),
        block(F, ["Hover"]) + figs([(safe(rf.plot_hover_spectrum, m), C["hover"], "Hover-Spektrum")]))
    add("pid", "PID & Filter", "hint" if recs else "ok",
        "<p class='small'>Basierend auf den gemessenen Werten dieses Fluges. Immer nur einen Parameter pro Flug aendern.</p>"
        + rf.pid_recommendations_html(recs))
    add("settings", "Einstellungen", "none",
        "<h3>Einstellungen aus dem Log</h3>" + rf.settings_table(m["hdr"]) + "<h3>Alle Kennzahlen</h3>" + rf.detail_table(m))
    return tabs


def analyze_upload(path, decoder, cells):
    try:
        dec = rf.find_decoder(decoder or None)
    except SystemExit:
        raise RuntimeError("blackbox_decode wurde nicht gefunden. Lege blackbox_decode(.exe) in denselben Ordner wie diese App "
                           "(oder baue die exe mit blackbox_decode.exe im Ordner, dann steckt er darin).")
    hdrs = rf.parse_headers(path)
    flights = []
    for i, csv in enumerate(rf.decode_bbl(path, dec)):
        df = rf.load_csv(csv)
        if df["t"].iloc[-1] < 20:
            continue
        name = os.path.basename(path)[:-4] + (f" (Log {i + 1})" if len(hdrs) > 1 else "")
        m = rf.analyze(df, hdrs[i] if i < len(hdrs) else {}, name, cells or None)
        flights.append(dict(name=name, tabs=build_flight(m, df)))
    if not flights:
        raise RuntimeError("Keine auswertbaren Logs gefunden (Decoder liefert keine CSV oder Log kuerzer als 20 s).")
    return flights


# --------------------------------------------------------------------------------------
APP_CSS = """
:root{--bg:#0a0f1e;--panel:rgba(255,255,255,.045);--line:rgba(255,255,255,.09);--txt:#e6ebf5;--mut:#8d98b3;--acc:#60a5fa;--acc2:#a78bfa;
--warn:#f87171;--hint:#fbbf24;--ok:#34d399;--info:#60a5fa}
html{background:var(--bg)}
body{background:radial-gradient(900px 520px at 10% -8%,rgba(96,165,250,.22),transparent 60%),radial-gradient(820px 520px at 100% 0,rgba(167,139,250,.20),transparent 55%),
radial-gradient(700px 500px at 50% 110%,rgba(52,211,153,.07),transparent 60%),var(--bg);background-attachment:fixed;color:var(--txt);
font-family:Inter,"Segoe UI",system-ui,sans-serif;min-height:100vh}
.wrap{max-width:1180px;padding:8px 24px 70px}
h2,h3{color:var(--txt)}h3{color:var(--mut);margin-top:30px;font-size:12px;letter-spacing:.14em}
.sub,.small,figcaption{color:var(--mut)}
.top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:14px 24px;border-bottom:1px solid var(--line);background:rgba(10,15,30,.6)}
.brand{display:flex;align-items:center;gap:12px;margin-right:12px}
.brand h1{margin:0;font-size:18px;font-weight:700;letter-spacing:-.01em;background:linear-gradient(90deg,#93c5fd,#c4b5fd);-webkit-background-clip:text;background-clip:text;color:transparent}
.brand small{display:block;color:var(--mut);font-size:11px;margin-top:1px}
.top label.l{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.08em}
.top input[type=text],.top input[type=number],.top select{padding:8px 11px;border-radius:10px;border:1px solid var(--line);background:rgba(255,255,255,.06);color:var(--txt);outline:none;font-size:13px}
.top input:focus,.top select:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(96,165,250,.2)}
.btn,.fbtn{padding:9px 18px;border-radius:10px;border:1px solid var(--line);background:rgba(255,255,255,.07);color:var(--txt);cursor:pointer;font-size:13px;font-weight:500;transition:.15s}
.fbtn:hover{background:rgba(255,255,255,.12)}
.btn.go{border:0;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;font-weight:600;box-shadow:0 6px 24px -6px rgba(99,102,241,.8)}
.btn.go:hover{filter:brightness(1.12);transform:translateY(-1px)}.btn.go:disabled{filter:grayscale(.6);cursor:wait;transform:none}
#tabs{position:sticky;top:0;z-index:20;display:flex;gap:6px;padding:12px 24px;flex-wrap:wrap;background:rgba(10,15,30,.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
#tabs:empty{display:none}
#tabs button{border:1px solid transparent;background:transparent;color:var(--mut);padding:8px 16px;border-radius:99px;cursor:pointer;font-size:13.5px;font-weight:500;transition:.15s}
#tabs button:hover{color:var(--txt);background:rgba(255,255,255,.06)}
#tabs button.on{color:#fff;background:linear-gradient(135deg,#3b82f6,#8b5cf6);box-shadow:0 6px 22px -6px rgba(99,102,241,.85)}
#tabs i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;background:#64748b}
#tabs i.warn{background:var(--warn);box-shadow:0 0 9px var(--warn)}#tabs i.hint{background:var(--hint);box-shadow:0 0 9px var(--hint)}
#tabs i.ok{background:var(--ok);box-shadow:0 0 9px var(--ok)}#tabs i.info{background:var(--info);box-shadow:0 0 9px var(--info)}
#hero{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:26px 0 4px}
#hero h2{border:0;margin:0;font-size:24px;letter-spacing:-.02em;padding:0}
#hero .badge{font-size:12px;padding:4px 14px}
#body>*,.wrap>*{animation:fade .4s ease both}@keyframes fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin:18px 0}
.kpi{position:relative;overflow:hidden;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:16px 18px 14px;backdrop-filter:blur(8px)}
.kpi:before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,var(--acc),var(--acc2))}
.kpi b{display:block;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);font-weight:600;margin-bottom:6px}
.kpi span{font-size:29px;font-weight:700;letter-spacing:-.02em;line-height:1.1}.kpi small{display:block;color:var(--mut);font-size:12px;margin-top:4px}
.card{background:var(--panel);border:1px solid var(--line);border-left:4px solid #64748b;border-radius:14px;color:var(--txt);box-shadow:none}
.card b{color:var(--mut)}
.card.warn{border-left-color:var(--warn);box-shadow:0 10px 30px -14px var(--warn)}.card.hint{border-left-color:var(--hint);box-shadow:0 10px 30px -16px var(--hint)}
.card.ok{border-left-color:var(--ok);box-shadow:0 10px 30px -18px var(--ok)}.card.info{border-left-color:var(--info)}
.find{background:var(--panel);border:1px solid var(--line);border-left:4px solid #64748b;border-radius:16px;padding:14px 18px;margin:12px 0;backdrop-filter:blur(8px);box-shadow:none}
.find.warn{border-left-color:var(--warn);box-shadow:0 14px 40px -20px var(--warn)}.find.hint{border-left-color:var(--hint);box-shadow:0 14px 40px -22px var(--hint)}
.find.ok{border-left-color:var(--ok)}.find.info{border-left-color:var(--info)}
.find b{font-size:15px}.find p{color:#c3cce0}
.badge{font-weight:600;letter-spacing:.02em;padding:2px 11px}
.b-warn{background:linear-gradient(135deg,#ef4444,#f87171)}.b-hint{background:linear-gradient(135deg,#f59e0b,#fbbf24);color:#1f1300}
.b-ok{background:linear-gradient(135deg,#10b981,#34d399);color:#03241a}.b-info{background:linear-gradient(135deg,#3b82f6,#60a5fa)}
.todo{background:rgba(255,255,255,.05);border:1px solid var(--line);color:#c3cce0;border-radius:10px}
.fazit{background:linear-gradient(135deg,rgba(96,165,250,.10),rgba(167,139,250,.10));border:1px solid var(--line);border-left:6px solid #64748b;border-radius:16px;color:var(--txt);padding:16px 20px}
.fazit.warn{border-left-color:var(--warn)}.fazit.hint{border-left-color:var(--hint)}.fazit.ok{border-left-color:var(--ok)}
.fazit.warn,.fazit.hint,.fazit.ok{background:linear-gradient(135deg,rgba(96,165,250,.10),rgba(167,139,250,.10))}
figure{background:#0e1424;border:1px solid var(--line);border-radius:18px;padding:12px;box-shadow:0 20px 50px -28px #000}
figure img{border-radius:10px}figcaption{font-size:12.5px;padding:10px 6px 2px}
table{background:transparent;color:var(--txt);border:1px solid var(--line);border-radius:14px;overflow:hidden}
th{background:rgba(255,255,255,.06);color:var(--mut);font-weight:600}th,td{border-bottom:1px solid var(--line)}
details.mini{background:var(--panel);border:1px solid var(--line)}
#msg{padding:70px 24px;color:var(--mut);text-align:center;font-size:15px}#msg.err{color:#fca5a5;white-space:pre-wrap;text-align:left}
.rotor{width:150px;height:150px;display:block;margin:0 auto 14px;filter:drop-shadow(0 0 18px rgba(96,165,250,.55))}
.mr{transform-origin:100px 100px;animation:spin .5s linear infinite}.tr{transform-origin:100px 186px;animation:spin .14s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.empty .mr{animation-duration:7s}.empty .tr{animation-duration:2.2s}.empty .rotor{opacity:.8}
.brand .mr{animation-duration:2.2s}.brand .tr{animation-duration:.6s}.brand svg{filter:drop-shadow(0 0 8px rgba(96,165,250,.6))}
pre{border:1px solid var(--line)}
"""

ROTOR = ('<svg class="rotor" viewBox="0 0 200 200" fill="none"><defs>'
         '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#60a5fa"/><stop offset="1" stop-color="#a78bfa"/></linearGradient>'
         '<radialGradient id="disc"><stop offset="0" stop-color="#60a5fa" stop-opacity=".02"/><stop offset=".8" stop-color="#8b5cf6" stop-opacity=".10"/>'
         '<stop offset="1" stop-color="#60a5fa" stop-opacity=".28"/></radialGradient></defs>'
         '<g stroke="url(#g)" stroke-width="3" stroke-linecap="round"><path d="M86 78 V122"/><path d="M114 78 V122"/><path d="M80 78 H92"/><path d="M108 78 H120"/>'
         '<path d="M80 122 H92"/><path d="M108 122 H120"/></g>'
         '<rect x="97.5" y="116" width="5" height="68" rx="2.5" fill="url(#g)"/><path d="M100 150 L109 176 L100 172 Z" fill="url(#g)" opacity=".8"/>'
         '<ellipse cx="100" cy="98" rx="15" ry="32" fill="url(#g)"/><ellipse cx="100" cy="84" rx="8" ry="13" fill="#0e1424" opacity=".55"/>'
         '<g class="tr"><rect x="98.8" y="170" width="2.4" height="30" rx="1.2" fill="#c4b5fd"/><rect x="85" y="184.8" width="30" height="2.4" rx="1.2" fill="#c4b5fd"/></g>'
         '<g class="mr"><circle cx="100" cy="100" r="92" fill="url(#disc)" stroke="#8da2ff" stroke-opacity=".35" stroke-dasharray="3 6"/>'
         '<rect x="8" y="96.5" width="184" height="7" rx="3.5" fill="url(#g)"/><rect x="8" y="96.5" width="26" height="7" rx="3.5" fill="#f472b6" opacity=".9"/>'
         '<rect x="166" y="96.5" width="26" height="7" rx="3.5" fill="#f472b6" opacity=".9"/><circle cx="100" cy="100" r="7" fill="#e6ebf5"/>'
         '<circle cx="100" cy="100" r="3" fill="#0e1424"/></g></svg>')

PAGE = """<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rotorflight Log Analyzer</title><style>__CSS__</style></head><body>
<div class="top"><div class="brand">__ROTOR_SMALL__<div><h1>Rotorflight Log Analyzer</h1><small>Blackbox-Auswertung</small></div></div>
<label class="fbtn"><input id="file" type="file" accept=".bbl,.BBL" style="display:none"><span id="fname">BBL-Datei waehlen ...</span></label>
<label class="l">Zellen</label><input id="cells" type="number" min="0" max="14" value="0" style="width:60px" title="0 = automatisch">
<button class="btn go" id="go">Analysieren</button><button class="btn" id="quit" title="App beenden" style="margin-left:auto">Beenden</button><select id="flight" style="display:none"></select></div>
<div id="tabs"></div><div class="wrap"><div id="hero"></div><div id="body"><div id="msg" class="empty">__ROTOR__Waehle eine .bbl-Datei und klicke auf &bdquo;Analysieren&ldquo;.</div></div></div>
<script>
var DATA=null,CUR=0,TAB=0,$=function(i){return document.getElementById(i)},ROTOR='__ROTOR__';
var SL={warn:'Handlungsbedarf',hint:'Hinweis',ok:'In Ordnung',info:'Info'};
$('file').onchange=function(){$('fname').textContent=this.files[0]?this.files[0].name:'BBL-Datei waehlen ...';};
function msg(t,err,spin){$('hero').innerHTML='';$('body').innerHTML='<div id="msg" class="'+(err?'err':'')+'">'+(spin?ROTOR:'')+t+'</div>';$('tabs').innerHTML='';}
$('go').onclick=function(){
  var f=$('file').files[0]; if(!f){msg('Bitte zuerst eine .bbl-Datei waehlen.',1);return;}
  $('go').disabled=true;$('go').textContent='Analysiere ...';msg('Dekodiere und analysiere '+f.name+' &ndash; das dauert je nach Loggroesse etwa 10&ndash;60 Sekunden ...',0,1);
  fetch('/analyze?name='+encodeURIComponent(f.name)+'&cells='+($('cells').value||0),{method:'POST',body:f})
   .then(r=>r.json()).then(function(d){
     $('go').disabled=false;$('go').textContent='Analysieren';
     if(d.error){msg(d.error,1);return;}
     DATA=d.flights;CUR=0;TAB=0;
     var s=$('flight');s.innerHTML='';DATA.forEach(function(x,i){var o=document.createElement('option');o.value=i;o.textContent=x.name;s.appendChild(o);});
     s.style.display=DATA.length>1?'':'none';render();
   }).catch(function(e){$('go').disabled=false;$('go').textContent='Analysieren';msg('Fehler: '+e,1);});
};
$('quit').onclick=function(){fetch('/quit').finally(function(){document.body.innerHTML='<div id="msg" style="padding-top:120px">App beendet. Du kannst dieses Fenster schliessen.</div>';});};
$('flight').onchange=function(){CUR=+this.value;TAB=0;render();};
function render(){
  var fl=DATA[CUR],t=fl.tabs,h='';
  t.forEach(function(x,i){h+='<button class="'+(i==TAB?'on':'')+'" onclick="TAB='+i+';render()"><i class="'+x.sev+'"></i>'+x.title+'</button>';});
  $('tabs').innerHTML=h;var sv=t[0].sev;
  $('hero').innerHTML='<h2>'+fl.name+'</h2><span class="badge b-'+sv+'">'+(SL[sv]||'')+'</span>';
  $('body').innerHTML=t[TAB].html;window.scrollTo(0,0);
}
</script></body></html>"""
PAGE = PAGE.replace("__ROTOR_SMALL__", ROTOR.replace('class="rotor"', 'style="width:44px;height:44px"')).replace("__ROTOR__", ROTOR.replace("'", "\\'"))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        b = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/quit":
            self._send(200, json.dumps(dict(ok=True)))
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if self.path == "/config":
            c = load_conf()
            dec = c.get("decoder", "")
            if not dec:
                try:
                    dec = rf.find_decoder(None)
                except SystemExit:
                    dec = ""
            self._send(200, json.dumps(dict(decoder=dec)))
        else:
            self._send(200, PAGE.replace("__CSS__", rf.CSS + APP_CSS), "text/html; charset=utf-8")

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        tmp = tempfile.mkdtemp(prefix="rfapp_")
        try:
            n = int(self.headers.get("Content-Length", 0))
            name = os.path.basename(q.get("name", ["log.bbl"])[0]) or "log.bbl"
            path = os.path.join(tmp, name)
            with open(path, "wb") as fh:
                left = n
                while left > 0:
                    chunk = self.rfile.read(min(1 << 20, left))
                    if not chunk:
                        break
                    fh.write(chunk)
                    left -= len(chunk)
            decoder = q.get("decoder", [""])[0].strip().strip('"')
            if decoder:
                c = load_conf(); c["decoder"] = decoder; save_conf(c)
            cells = int(q.get("cells", ["0"])[0] or 0)
            flights = analyze_upload(path, decoder, cells)
            self._send(200, json.dumps(dict(flights=flights)))
        except SystemExit as ex:
            self._send(200, json.dumps(dict(error=str(ex))))
        except Exception as ex:
            try:
                traceback.print_exc()
            except Exception:
                pass
            self._send(200, json.dumps(dict(error=f"{type(ex).__name__}: {ex}")))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


def main(port=8765, open_browser=True):
    srv = None
    for p in range(port, port + 20):
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", p), Handler)
            break
        except OSError:
            continue
    if srv is None:
        sys.exit("Kein freier Port gefunden.")
    url = f"http://127.0.0.1:{srv.server_address[1]}/"
    if sys.stdout:
        print(f"Rotorflight Log Analyzer laeuft auf {url}  (Beenden mit Strg+C)")
    if open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main(open_browser="--no-open" not in sys.argv)
