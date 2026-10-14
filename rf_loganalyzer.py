#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rf_loganalyzer.py - Rotorflight-Blackbox-Logs einfach auswerten
================================================================

Aufruf:
    python rf_loganalyzer.py flug1.bbl                  # ein Flug
    python rf_loganalyzer.py logs/*.bbl                 # mehrere Fluege + Vergleich
    python rf_loganalyzer.py logs/*.bbl --summary       # nur Uebersicht/Vergleich, keine Einzeldiagramme

Ergebnis: ein HTML-Bericht (Standard: rf_report.html), der sich im Browser oeffnet.
    Aufbau: Navigation oben, bei mehreren Fluegen eine Ampel-Matrix (Fluege x Bereiche), ein Fazit mit naechstem
    Schritt pro Flug, Empfehlungen, Diagramme mit Erklaerung darunter und einklappbare Details.

Voraussetzungen:
    pip install numpy pandas matplotlib
    + das Programm "blackbox_decode" (aus dem blackbox-tools-Projekt, Windows: blackbox_decode.exe).
      Es wird automatisch gesucht (PATH, aktueller Ordner, Ordner des Skripts) oder per --decoder angegeben.

Wichtig zur Einordnung:
    Die Bewertungen unten sind REGELN MIT RICHTWERTEN (siehe THRESH), keine Wahrheit. Sie zeigen
    dir, wo du hinschauen sollst, und schlagen einen ersten Schritt vor. Aendere immer nur einen
    Parameter pro Flug und vergleiche danach - dafuer ist der Vergleichsmodus da.
"""
import argparse
import base64
import glob
import html
import io
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import webbrowser

import numpy as np
import pandas as pd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

# --------------------------------------------------------------------------------------
# Richtwerte - hier kannst du die Empfindlichkeit an dein Modell anpassen
# --------------------------------------------------------------------------------------
THRESH = dict(
    # Heck: selbst erregte Schwingung bei ruhigem Yaw-Stick (spektrale Energie 8-20 Hz, 1-s-Fenster)
    yaw_spike_hint=4000,
    yaw_spike_warn=10000,
    yaw_axis_ratio=3.0,          # Gier-Peak / staerkster Roll-/Nick-Peak im Band: darueber = achsenspezifisch (Regelkreis)
    # Governor (nur bei festem Ziel sinnvoll)
    over_event_rpm=100,          # Ueberschwinger = Headspeed mehr als X ueber Ziel
    over_rate_hint=20,           # Ereignisse pro Minute
    over_rate_warn=45,
    over_p99_hint=110,           # 99. Perzentil der Ueberdrehzahl
    under_p01_warn=-120,         # 1. Perzentil: Drehzahl bricht unter Ziel ein
    spool_down_loss_s=1.0,       # Auslauf kuerzer als das = Telemetrie bricht ab / Bremse
    # Akku / ESC
    vcell_load_hint=3.5,
    vcell_load_warn=3.3,
    vcell_rest_low=3.70,         # Ruhespannung nach der Landung pro Zelle
    esc_temp_hint=70,
    esc_temp_warn=85,
    # Servos
    servo_limit_pct_warn=1.0,    # Anteil der Zeit am Endanschlag
    # Hover-Spektrum: Resonanzpeak = Spitze, die X-mal ueber dem lokalen Grundpegel liegt
    peak_prominence=3.0,
    # Kopplung Heck <-> Drehzahl: Drehzahl-RMS (5-20 Hz, 1-s-Fenster) in Heck-Ausbruchfenstern
    coupling_hs_rpm=10.0,
    coupling_share=0.7,
    # Drehzahl-Pendeln: 2-10 Hz, RMS in 2-s-Fenstern
    osc_amp_rpm=15.0,
    osc_pct_hint=8.0,            # Anteil der Fenster, ab dem es einen Hinweis gibt
)

# Header-Werte, die im Vergleich als "Aenderung gegenueber dem vorigen Flug" gezeigt werden
DIFF_KEYS = ["govPID", "rollPID", "pitchPID", "yawPID", "yaw_stop_gain", "yawBW", "levelPID",
             "rc_rates", "rc_expo", "motor_pwm_protocol", "dshot_bidir", "gyro_lpf1_static_hz"]

SEV_ORDER = {"warn": 0, "hint": 1, "info": 2, "ok": 3}
SEV_LABEL = {"warn": "Handlungsbedarf", "hint": "Hinweis", "info": "Info", "ok": "In Ordnung"}


# --------------------------------------------------------------------------------------
# Decoder & Einlesen
# --------------------------------------------------------------------------------------
def find_decoder(user_path=None):
    cands = []
    if user_path:
        cands.append(user_path)
    here = os.path.dirname(os.path.abspath(__file__))
    exe_dir = os.path.dirname(os.path.abspath(sys.executable)) if getattr(sys, "frozen", False) else here
    for name in ("blackbox_decode", "blackbox_decode.exe"):
        w = shutil.which(name)
        if w:
            cands.append(w)
        cands += [os.path.join(os.getcwd(), name), os.path.join(here, name), os.path.join(exe_dir, name),
                  os.path.join(getattr(sys, "_MEIPASS", here), name),
                  os.path.join(here, "blackbox-tools", "obj", name)]
    for c in cands:
        if c and os.path.isfile(c):
            return c
    sys.exit("blackbox_decode nicht gefunden. Bitte aus dem blackbox-tools-Projekt besorgen "
             "(Windows: blackbox_decode.exe) und mit --decoder <Pfad> angeben oder neben dieses Skript legen.")


def decode_bbl(bbl, decoder):
    """Gibt Liste von CSV-Pfaden zurueck (ein .bbl kann mehrere Fluege enthalten)."""
    tmp = tempfile.mkdtemp(prefix="rfla_")
    dst = os.path.join(tmp, os.path.basename(bbl))
    shutil.copy(bbl, dst)
    subprocess.run([decoder, dst], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    csvs = sorted(p for p in glob.glob(os.path.join(tmp, "*.csv")) if ".gps." not in p)
    return csvs


def parse_headers(bbl):
    """Liest die 'H name:value'-Zeilen jedes Logs aus der .bbl (ein Dict pro Log)."""
    data = open(bbl, "rb").read()
    starts = [m.start() for m in re.finditer(rb"H Product:", data)]
    out = []
    for s in starts:
        pos, hdr = s, {}
        while data[pos:pos + 2] == b"H ":
            end = data.find(b"\n", pos)
            if end < 0:
                break
            line = data[pos + 2:end].decode("latin-1", "replace")
            if ":" in line:
                k, v = line.split(":", 1)
                hdr[k.strip()] = v.strip()
            pos = end + 1
        out.append(hdr)
    return out


def load_csv(path):
    df = pd.read_csv(path, low_memory=False)
    import re as _re
    def _clean_col(c):
        c = c.strip()
        c = _re.sub(r'\s*\([^)]+\)$', '', c)  # " (V)", " (A)", " (us)" etc entfernen
        return c
    df.columns = [_clean_col(c) for c in df.columns]
    # uint32 -> signed int32: blackbox_decode gibt negative Werte als grosse positive Zahlen aus
    # Betrifft: gyro, axis*, setpoint, rcCommand (nicht: motor, headspeed, vbat, time, rcCommand[3])
    _SIGNED_PREFIXES = ('gyro', 'axisP', 'axisI', 'axisD', 'axisF', 'axisO',
                        'setpoint[0]', 'setpoint[1]', 'setpoint[2]',
                        'rcCommand[0]', 'rcCommand[1]', 'rcCommand[2]')
    for _gcol in df.columns:
        if any(_gcol.startswith(p) for p in _SIGNED_PREFIXES):
            try:
                _vals = df[_gcol].astype(float)
                if _vals.max() > 2**30:
                    df[_gcol] = np.where(_vals > 2**31, _vals - 2**32, _vals)
            except Exception:
                pass
    _tcol = _resolve_col(df, "time (us)")
    df["t"] = (df[_tcol] - df[_tcol].iloc[0]) / 1e6
    return df


_COL_ALIASES = {
    'govTarget':  ['govTarget', 'governorTarget', 'governor_target'],
    'Vbat':       ['Vbat', 'vbatLatest', 'vbat', 'voltage'],
    'Ibat':       ['Ibat', 'amperageLatest', 'amperage', 'current'],
    'Tesc':       ['Tesc', 'escTemperature', 'ESC_Temp'],
    'EscRPM':     ['EscRPM', 'escRPM', 'motor_rpm'],
    'EscThr':     ['EscThr', 'escThrottle'],
    'time (us)':  ['time (us)', 'time'],
    'failsafePhase (flags)': ['failsafePhase (flags)', 'failsafePhase'],
    'energyCumulative': ['energyCumulative'],
}

def _resolve_col(df, name):
    """Gibt den ersten vorhandenen Alias-Namen zurueck, oder name selbst."""
    for candidate in _COL_ALIASES.get(name, [name]):
        if candidate in df.columns:
            return candidate
    return name

def volt_div(vb, hdr):
    """Teiler Rohwert -> Volt. Rotorflight loggt je nach Firmware Volt, Decivolt, Centivolt oder Millivolt.
    Mit 'vbatref' (Referenz-/Vollspannung in Centivolt) wird der Teiler gewaehlt, bei dem der Startwert am besten passt."""
    v = vb.dropna()
    v = v[v > 0]
    if len(v) == 0:
        return 1.0
    start = float(np.percentile(v.iloc[:max(len(v) // 20, 1)], 90))
    try:
        ref_v = float((hdr or {}).get("vbatref")) / 100.0
    except Exception:
        ref_v = np.nan
    if np.isfinite(ref_v) and ref_v > 0:
        return min((1.0, 10.0, 100.0, 1000.0), key=lambda d: abs(math.log((start / d) / ref_v)))
    med = float(np.median(v))
    return 1000.0 if med > 1000 else (10.0 if med > 60 else 1.0)


def col(df, name):
    real = _resolve_col(df, name)
    return df[real].astype(float) if real in df.columns else pd.Series(np.nan, index=df.index)


# --------------------------------------------------------------------------------------
# Hilfsfunktionen
# --------------------------------------------------------------------------------------
def trapezoid(y, x):
    f = getattr(np, "trapezoid", None) or np.trapz
    return f(y, x)


def merged_segments(mask, t, gap=2.0):
    idx = np.flatnonzero(mask)
    if len(idx) == 0:
        return []
    br = np.flatnonzero(np.diff(t[idx]) > gap)
    starts = np.r_[0, br + 1]
    ends = np.r_[br, len(idx) - 1]
    return [(idx[a], idx[b]) for a, b in zip(starts, ends)]


def band_energy(y, fs, lo, hi):
    y = y - y.mean()
    sp = np.abs(np.fft.rfft(y * np.hanning(len(y))))
    fr = np.fft.rfftfreq(len(y), 1 / fs)
    m = (fr > lo) & (fr < hi)
    if not m.any():
        return 0.0, 0.0, 0.0
    return float(sp[m].sum()), float(fr[m][np.argmax(sp[m])]), float(sp[m].max())


def band_rms(y, fs, lo, hi):
    """RMS (Einheit des Signals) im Frequenzband lo..hi per FFT-Filter."""
    y = y - y.mean()
    sp = np.fft.rfft(y)
    fr = np.fft.rfftfreq(len(y), 1 / fs)
    sp[(fr < lo) | (fr > hi)] = 0
    z = np.fft.irfft(sp, len(y))
    return float(np.sqrt(np.mean(z ** 2)))


def fnum(x, nd=0, unit=""):
    if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))):
        return "-"
    return f"{x:.{nd}f}{unit}"


def first_num(s, default=np.nan):
    try:
        return float(str(s).split(",")[0])
    except Exception:
        return default


def pid_part(s, i):
    try:
        return float(str(s).split(",")[i])
    except Exception:
        return np.nan


# --------------------------------------------------------------------------------------
# Analyse eines Fluges
# --------------------------------------------------------------------------------------
def analyze(df, hdr, name, cells_arg=None):
    t = df["t"].values
    fs = 1 / np.median(np.diff(t))
    hs = col(df, "headspeed").fillna(0).values
    if np.nanmax(hs) < 50:                       # Fallback, falls kein 'headspeed'-Feld
        hs = col(df, "EscRPM").fillna(0).values
    tgt = col(df, "govTarget").fillna(0).values

    m = dict(name=name, fs=fs, hdr=hdr, ok=False)
    segs = merged_segments(hs > 50, t)
    if not segs:
        m["error"] = "Kein Rotorlauf im Log gefunden."
        return m
    i0, i1 = max(segs, key=lambda s: t[s[1]] - t[s[0]])
    if t[i1] - t[i0] < 20:
        m["error"] = "Rotorlauf kuerzer als 20 s - zu kurz fuer eine sinnvolle Analyse."
        return m
    m["ok"] = True
    m["t0"], m["t1"] = t[i0], t[i1]

    # --- Ziel-Drehzahl, fest oder variabel? -------------------------------------------
    gt = tgt[i0:i1 + 1]
    pos = gt[gt > 50]
    tgt_med = float(np.median(pos)) if len(pos) else float(np.nanmax(hs))
    fixed_frac = float((np.abs(pos - tgt_med) <= 2).mean()) if len(pos) else 0.0
    m["target"], m["target_fixed"] = tgt_med, fixed_frac > 0.6

    # --- Hochlauf / Gaskappung / Auslauf ------------------------------------------------
    up = np.flatnonzero((hs[i0:i1 + 1] >= 0.95 * tgt_med))
    i_up = i0 + (up[0] if len(up) else 0)
    m["spool_up_s"] = t[i_up] - t[i0] if len(up) else np.nan
    cut = np.flatnonzero((tgt[i0 + int(5 * fs):i1 + 1] == 0) & (hs[i0 + int(5 * fs):i1 + 1] > 50))
    i_cut = i0 + int(5 * fs) + cut[0] if len(cut) else i1
    m["t_cut"] = t[i_cut]
    after = np.flatnonzero(hs[i_cut:] < 50)
    m["spool_down_s"] = t[i_cut + after[0]] - t[i_cut] if len(after) else np.nan
    m["hs_at_cut"] = float(hs[max(i_cut - 1, 0)])

    i_fl = min(i_up + int(2 * fs), i_cut - 1)
    fl = df.iloc[i_fl:i_cut].copy().reset_index(drop=True)
    m["fl"] = fl
    m["flight_s"] = float(fl["t"].iloc[-1] - fl["t"].iloc[0]) if len(fl) > 10 else 0
    if m["flight_s"] < 15:
        m["ok"] = False
        m["error"] = "Flugphase (Drehzahl erreicht bis Gaskappung) kuerzer als 15 s."
        return m
    flt = fl["t"].values

    # --- Elektrik ---------------------------------------------------------------------
    vb, ib = col(df, "Vbat"), col(df, "Ibat")
    vdiv = volt_div(vb, hdr)
    _ib_valid = ib.replace(0, np.nan).dropna()
    _ib_med = float(np.nanmedian(_ib_valid)) if len(_ib_valid) > 0 else np.nan
    idiv = 100.0 if np.isfinite(_ib_med) and _ib_med > 500 else 1.0
    V, I = vb / vdiv, ib / idiv
    fl["V"], fl["I"] = V.iloc[i_fl:i_cut].values, I.iloc[i_fl:i_cut].values
    m["v_start"] = float(V[df["t"] < 2].mean())
    cells = cells_arg or int(math.ceil(m["v_start"] / 4.25)) if m["v_start"] > 3 else 1
    m["cells"] = cells
    vs = fl["V"].rolling(25, center=True, min_periods=1).median()
    m["v_min"] = float(vs.min())
    m["v_min_cell"] = m["v_min"] / cells
    m["i_peak"] = float(fl["I"].max())
    m["i_mean"] = float(fl["I"].mean())
    P = fl["I"] * fl["V"]
    m["p_peak"], m["p_mean"] = float(P.max()), float(P.mean())
    seg = df[(df["t"] >= t[i0]) & (df["t"] <= t[i1])]
    m["mah"] = float(trapezoid(I.loc[seg.index].values, seg["t"].values) / 3.6)
    m["wh"] = float(trapezoid((I * V).loc[seg.index].values, seg["t"].values) / 3600)
    Is, ts = I.loc[seg.index].values, seg["t"].values
    cum = np.r_[0.0, np.cumsum((Is[1:] + Is[:-1]) / 2 * np.diff(ts))] / 3.6          # mAh
    vsm = pd.Series(V.loc[seg.index].values).rolling(1000, center=True, min_periods=1).median().values
    sel = np.arange(0, len(cum), max(int(fs), 1))                                        # ca. 1 Wert/s
    m["curve"] = (cum[sel], vsm[sel] / cells)
    tail = df[(df["t"] > t[-1] - 3) & (I < 2)]
    m["v_rest_cell"] = float(V[tail.index].mean() / cells) if len(tail) > 20 else np.nan
    te = col(df, "Tesc")
    m["t_esc_start"] = float(te[df["t"] < 3].mean())
    m["t_esc_max"] = float(te.max())

    # --- Governor ---------------------------------------------------------------------
    m["gov"] = {}
    if m["target_fixed"]:
        g = fl[np.abs(tgt[i_fl:i_cut] - tgt_med) <= 2]
        e = (col(g, "headspeed") - tgt_med).values
        if len(e) > 2000:
            ev = ((e > THRESH["over_event_rpm"]).astype(int)); ev_n = int((np.diff(ev) == 1).sum())
            mins = len(e) / fs / 60
            m["gov"] = dict(rate=ev_n / mins, p99=float(np.percentile(e, 99)), p01=float(np.percentile(e, 1)),
                            maxover=float(e.max()), median=float(np.median(e)),
                            within20=float((np.abs(e) <= 20).mean() * 100),
                            t_worst=float(g["t"].iloc[int(np.argmax(e))]))
    else:
        e = (col(fl, "headspeed") - col(fl, "govTarget")).values
        m["gov"] = dict(variable=True, within20=float((np.abs(e) <= 20).mean() * 100),
                        maxdev=float(np.abs(e).max()))

    # --- Heck: Schwingung bei ruhigem Yaw-Stick -----------------------------------------
    yE, yF, wT, yPk, yH = [], [], [], [], []
    hs_fl = col(fl, "headspeed").values
    tg_fl = col(fl, "govTarget").values
    wobble, hov_acc = [], []
    ysp = np.abs(fl["rcCommand[2]"].values) if "rcCommand[2]" in fl else np.zeros(len(fl))
    allst = sum(np.abs(fl[f"rcCommand[{k}]"].values) for k in range(3)) / 3 if "rcCommand[2]" in fl else ysp
    gy = {k: fl[f"gyroADC[{k}]"].values for k in range(3) if f"gyroADC[{k}]" in fl}
    win, step = int(fs), int(fs / 2)
    for s0 in range(0, len(fl) - win, step):
        if ysp[s0:s0 + win].mean() < 30 and 2 in gy:
            ey, fy, py = band_energy(gy[2][s0:s0 + win], fs, 8, 20)
            _, _, pr = band_energy(gy[0][s0:s0 + win], fs, 8, 20)
            _, _, pp = band_energy(gy[1][s0:s0 + win], fs, 8, 20)
            yE.append(ey); yF.append(fy); wT.append(flt[s0]); yPk.append(py / max(pr, pp, 1.0))
            fixed_w = m["target_fixed"] and np.ptp(tg_fl[s0:s0 + win]) <= 5
            yH.append(band_rms(hs_fl[s0:s0 + win], fs, 5, 20) if fixed_w else np.nan)
    # Hover-Spektrum (2-s-Fenster, alle Sticks ruhig) -> Resonanzpeaks mit Prominenz
    w2 = int(2 * fs)
    for s0 in range(0, len(fl) - w2, w2 // 2):
        if allst[s0:s0 + w2].mean() < 25 and 0 in gy:
            wobble.append((band_rms(gy[0][s0:s0 + w2], fs, 2, 8) + band_rms(gy[1][s0:s0 + w2], fs, 2, 8)) / 2)
            hov_acc.append([np.abs(np.fft.rfft((gy[k][s0:s0 + w2] - gy[k][s0:s0 + w2].mean()) * np.hanning(w2))) / w2
                            for k in range(3)])
    yE, yF, yPk = np.array(yE), np.array(yF), np.array(yPk)
    yH = np.array(yH)
    m["yaw"] = dict(t=np.array(wT), E=yE, F=yF, ratio_arr=yPk, H=yH)
    ev = (yE >= THRESH["yaw_spike_hint"]) & ~np.isnan(yH) if len(yE) else np.array([], dtype=bool)
    m["yaw"]["coupling"] = (dict(n=int(ev.sum()), share=float((yH[ev] >= THRESH["coupling_hs_rpm"]).mean()),
                                 med_hs=float(np.median(yH[ev])), med_all=float(np.nanmedian(yH)))
                            if ev.sum() >= 1 else None)
    if len(yE):
        k = int(np.argmax(yE))
        m["yaw"].update(median=float(np.median(yE)), p95=float(np.percentile(yE, 95)), max=float(yE.max()),
                        f_max=float(yF[k]), ratio=float(yPk[k]), t_max=float(wT[k]), n=len(yE))
    m["wobble"] = float(np.median(wobble)) if len(wobble) >= 3 else np.nan
    m["wobble_n"] = len(wobble)
    m["hover_peaks"] = []
    if len(hov_acc) >= 3:
        fr2 = np.fft.rfftfreq(w2, 1 / fs)
        for kk, lab in enumerate(["Roll", "Nick", "Gier"]):
            sp = np.mean([a[kk] for a in hov_acc], axis=0)
            for j in range(int(3 / (fr2[1])), int(40 / fr2[1])):
                loc = np.r_[sp[j - 8:j - 2], sp[j + 3:j + 9]]
                if sp[j] == sp[j - 2:j + 3].max() and sp[j] / max(np.median(loc), 1e-9) >= THRESH["peak_prominence"]:
                    m["hover_peaks"].append((lab, float(fr2[j]), float(sp[j] / np.median(loc))))
        m["hover_peaks"].sort(key=lambda p: -p[2])

    # --- Drehzahl-Pendeln (periodische Schwingung der Headspeed, nur bei festem Ziel) ---------
    osc = dict(n=0, n_big=0, f=[], worst=None)
    if m["target_fixed"]:
        hsv = col(fl, "headspeed").values; tgv = col(fl, "govTarget").values
        w3, st3 = int(2 * fs), int(fs)
        wmax = 0
        for s0 in range(0, len(fl) - w3, st3):
            if np.ptp(tgv[s0:s0 + w3]) > 5:
                continue
            y = hsv[s0:s0 + w3] - hsv[s0:s0 + w3].mean()
            amp = band_rms(y, fs, 2, 10)
            osc["n"] += 1
            if amp > THRESH["osc_amp_rpm"]:
                osc["n_big"] += 1
                _, f0, _ = band_energy(y, fs, 2, 10)
                osc["f"].append(f0)
            if amp > wmax:
                wmax, osc["worst"] = amp, float(flt[s0] + 1.0)
        osc["amp_max"] = wmax
    m["osc"] = osc

    # --- Regelverhalten (Soll/Ist bei groesseren Kommandos) --------------------------------
    trk = {}
    for k, lab in enumerate(["Roll", "Nick", "Gier"]):
        if f"setpoint[{k}]" in fl and k in gy:
            sp = fl[f"setpoint[{k}]"].values
            mk = np.abs(sp) > 150
            if mk.sum() > 200:
                er = np.abs(sp[mk] - gy[k][mk])
                trk[lab] = (float(np.median(er)), float(np.percentile(er, 95)), int(mk.sum()))
    m["track"] = trk

    # --- Servos -------------------------------------------------------------------------
    sv = {}
    for k in range(4):
        c = f"servo[{k}]"
        if c in fl and fl[c].notna().all():
            x = fl[c].values
            lo, hi = x.min(), x.max()
            sv[k] = dict(lo=float(lo), hi=float(hi),
                         pct_lo=float((x <= lo + 1).mean() * 100), pct_hi=float((x >= hi - 1).mean() * 100))
    m["servo"] = sv

    # --- Antrieb: Motor-Ausgang / Reserve (motor[0] ist 0..1000; EscThr nur, falls der ESC es meldet) ----------
    m["mot"] = None
    _thr = col(fl, "EscThr")
    _mo = _thr if (_thr.fillna(0).abs().max() > 0) else col(fl, "motor[0]")
    _src = "EscThr" if _mo is _thr else "motor[0]"
    if _mo.notna().any() and _mo.max() > 0:
        _mo = _mo / (10.0 if _mo.max() > 100 else 1.0)
        _stab = (col(fl, "govTarget") - m["target"]).abs() <= 2 if m["target_fixed"] else pd.Series(True, index=fl.index)
        _ms = _mo[_stab & (_mo > 0)]
        if len(_ms) > 200:
            m["mot"] = dict(src=_src, mean=float(_ms.mean()), reserve=float(100 - _ms.mean()), peak=float(_mo.max()),
                            near=float((_ms >= 95).mean() * 100), t_peak=float(fl["t"].iloc[int(np.argmax(_mo.values))]))

    # --- Signalqualitaet --------------------------------------------------------------------
    _rxcol = _resolve_col(fl, "rxSignalReceived")
    m["rx_loss"] = int((col(fl, "rxSignalReceived") == 0).sum()) if _rxcol in fl.columns else 0
    _fsp_col = _resolve_col(fl, "failsafePhase (flags)")
    fsp = fl[_fsp_col].astype(str).str.strip() if _fsp_col in fl.columns else pd.Series(["IDLE"])
    m["failsafe_active"] = bool((fsp != "IDLE").any())
    m["v_zero"] = int((fl["V"] <= 0.1).sum())
    m["escthr_dead"] = bool(col(fl, "EscThr").fillna(0).abs().max() == 0) if _resolve_col(fl, "EscThr") in fl.columns else None
    m["stick_activity"] = float(allst.mean())
    return m


# --------------------------------------------------------------------------------------
# Bewertung & Empfehlungen
# --------------------------------------------------------------------------------------
def make_findings(m):
    F = []
    hdr = m["hdr"]

    def add(sev, area, title, obs, todo=""):
        F.append(dict(sev=sev, area=area, title=title, obs=obs, todo=todo))

    if not m["ok"]:
        add("info", "Log", "Log nicht ausgewertet", m.get("error", ""), "")
        return F

    # ---------- Heck ----------
    y = m["yaw"]
    if "max" in y:
        notch = first_num(hdr.get("dyn_notch_min_hz"), np.nan)
        below = (not math.isnan(notch)) and y["f_max"] < notch
        specific = y["ratio"] >= THRESH["yaw_axis_ratio"]
        axis = (f"fast nur auf der Gier-Achse (Peak {y['ratio']:.1f}x hoeher als auf Roll/Nick) - typisch fuer eine Regelkreis-Schwingung des Hecks"
                if specific else
                f"auch auf Roll/Nick sichtbar (Gier-Peak nur {y['ratio']:.1f}x hoeher) - kann Gesamtstoerung oder Mechanik sein")
        obs = (f"Bei ruhigem Gier-Stick faellt die staerkste Schwingung bei {y['f_max']:.1f} Hz auf, {axis}. "
               f"Spitzenwert {y['max']:.0f}, typischer Wert {y['median']:.0f} (Richtwerte: ab {THRESH['yaw_spike_hint']:.0f} Hinweis, "
               f"ab {THRESH['yaw_spike_warn']:.0f} Handlungsbedarf).")
        if below:
            obs += f" Sie liegt unter der Notch-Filtergrenze ({notch:.0f} Hz) - die Filter koennen hier nichts ausrichten, es muss an der Quelle behoben werden."
        todo_pid = ("Yaw-P in Schritten von 10-15 % senken (nur einen Wert pro Flug aendern), danach Log vergleichen. Reicht das nicht: "
                    "yaw_stop_gain senken (laut Rotorflight-Doku kann ein zu hoher Wert schnelle Schwingungen ausloesen) oder Yaw-D pruefen. "
                    "Rotorflight-Tuning-Doku: schnelle Schwingungen sind typisch fuer zu hohes P bzw. D.")
        todo_mech = ("Mechanik pruefen: Heckantrieb (Riemenspannung/Zahnspiel), Heckrotorlager, Blattgriffe, Rahmenschrauben/Elektronikdaempfung. "
                     "Zusaetzlich ist eine Yaw-P-Senkung um 10-15 % ein risikoarmer Test.")
        todo = todo_pid if specific else todo_mech
        if y["max"] >= THRESH["yaw_spike_warn"]:
            add("warn", "Heck", "Heck schwingt bei ruhigem Stick", obs, todo)
        elif y["max"] >= THRESH["yaw_spike_hint"]:
            add("hint", "Heck", "Gelegentliche Heck-Schwingungsspitzen", obs, todo)
        else:
            add("ok", "Heck", "Heck ruhig", obs)

    cp = m["yaw"].get("coupling")
    if cp and cp["n"] >= 3 and cp["share"] >= THRESH["coupling_share"]:
        add("hint", "Heck", "Heck und Drehzahl schwingen gemeinsam",
            f"In {cp['n']} Fenstern mit Heck-Schwingung schwingt gleichzeitig auch die Kopfdrehzahl ({cp['med_hs']:.0f} U/min RMS im Band 5-20 Hz, "
            f"sonst typisch {cp['med_all']:.1f}); {cp['share'] * 100:.0f} % dieser Fenster zeigen das.",
            "Moegliche Kopplung: Laut Rotorflight-Quellcode mischt der Governor den Betrag des Heck-PID-Ausgangs (Gewicht 'Yaw-Vorsteuerung') in die "
            "Gas-Vorsteuerung. Schwingt das Heck, schwingt dadurch auch das Gas; bei mechanisch angetriebenem Heck wirkt die Drehzahl zusaetzlich direkt auf den "
            "Heckschub. Test: im Governor-Profil die Yaw-Vorsteuerung (und ggf. Cyclic-Vorsteuerung) senken, nur das in einem Flug aendern und vergleichen. "
            "Das ist eine Hypothese - belegt ist nur das gemeinsame Auftreten, nicht die Ursache.")

    # ---------- Governor ----------
    g = m["gov"]
    if g.get("variable"):
        add("info", "Governor", "Variables Drehzahlziel (Ziel folgt dem Gasstick/Kurve)",
            f"{g['within20']:.0f} % der Zeit innerhalb +-20 U/min, groesste Abweichung {g['maxdev']:.0f}. "
            "Ueberschwinger-Statistik ist bei variablem Ziel nicht aussagekraeftig.",
            "Fuer eine saubere Governor-Beurteilung ein festes Ziel fliegen (Gas auf Anschlag/Profilumschaltung).")
    elif g:
        obs = (f"Bei festem Ziel {m['target']:.0f}: {g['within20']:.0f} % der Zeit innerhalb +-20 U/min; "
               f"{g['rate']:.0f} Ueberschwinger (>{THRESH['over_event_rpm']} U/min) pro Minute, 99-%-Wert +{g['p99']:.0f}, "
               f"groesster +{g['maxover']:.0f}; untere Seite (1-%-Wert) {g['p01']:.0f}.")
        over_dom = g["p99"] > 2 * abs(g["p01"])
        todo = ("Die Drehzahl liegt deutlich haeufiger UEBER als UNTER dem Ziel. Laut Rotorflight-Governor-Doku fuehrt ein zu hohes F-Gain dazu, "
                "dass die Drehzahl kurzzeitig zu hoch ist (zu niedriges F: sie faellt bei Pitch-Pumps ein). Pruefe daher F-Gain und die "
                "Vorsteuerungs-Gewichte Collective/Cyclic/Yaw im Governor-Profil (stehen nicht im Log-Header) und senke sie in 10er-Schritten. "
                "Schaue dir die Form an: einmalige Spitze = Vorsteuerung zu hoch; periodisches Pendeln siehe Befund 'Drehzahl pendelt'."
                if over_dom else
                "Die Drehzahl bricht eher ein als sie ueberschiesst: F-Gain bzw. Vorsteuerung (Collective/Cyclic/Yaw) erhoehen (10er-Schritte), "
                "dann P/I pruefen und Leistungsreserve (Akku, ESC) kontrollieren.")
        todo += " Flugstil beeinflusst die Zahlen stark - vergleiche nur Fluege mit aehnlicher Belastung."
        if g["rate"] >= THRESH["over_rate_warn"] or g["p99"] >= THRESH["over_p99_hint"] * 1.5:
            add("warn", "Governor", "Drehzahl schiesst bei Lastwechseln deutlich ueber das Ziel", obs, todo)
        elif g["rate"] >= THRESH["over_rate_hint"] or g["p99"] >= THRESH["over_p99_hint"]:
            add("hint", "Governor", "Gelegentliche Drehzahl-Ueberschwinger", obs, todo)
        else:
            add("ok", "Governor", "Governor haelt die Drehzahl sauber", obs)
        if g["p01"] <= THRESH["under_p01_warn"]:
            add("warn", "Governor", "Drehzahl bricht unter Last ein",
                f"1-%-Wert der Abweichung {g['p01']:.0f} U/min unter Ziel.",
                "Leistungsreserve pruefen: Akkuzustand/Spannungseinbruch, ESC-Strombegrenzung, Motor-/Uebersetzungsauslegung; F-Gain ggf. erhoehen.")
        o = m["osc"]
        if o["n"] >= 20:
            pct = 100 * o["n_big"] / o["n"]
            fmed = float(np.median(o["f"])) if o["f"] else float("nan")
            obs = (f"In {pct:.1f} % der 2-Sekunden-Fenster pendelt die Drehzahl periodisch (2-10 Hz, mehr als {THRESH['osc_amp_rpm']:.0f} U/min RMS), "
                   f"typische Frequenz {fnum(fmed, 1)} Hz, staerkste Episode {o['amp_max']:.0f} U/min RMS.")
            if pct >= THRESH["osc_pct_hint"]:
                add("hint", "Governor", "Drehzahl pendelt zeitweise", obs,
                    "Rotorflight-Doku: Zu hohes Governor-P bzw. Master-Gain laesst die Drehzahl pendeln/'surgen'. P-Gain in 10er-Schritten senken "
                    "(Doku-Regel: P bis zu leichten Schwingungen erhoehen, dann um 1/3 zurueck). Pruefe auch Headspeed-Filter-Cutoff und die "
                    "RPM-Signalqualitaet. Streut die Frequenz stark, kommt es eher von Lastwechseln als von einer festen Resonanz.")
            else:
                add("ok", "Governor", "Kein nennenswertes Drehzahl-Pendeln", obs)

    # Hochlauf / Auslauf
    if not math.isnan(m["spool_down_s"]) and m["spool_down_s"] < THRESH["spool_down_loss_s"] and m["hs_at_cut"] > 500:
        add("hint", "ESC/Telemetrie", "Drehzahl-Telemetrie bricht nach Gaskappung sofort ab",
            f"Von {m['hs_at_cut']:.0f} auf 0 in {m['spool_down_s']:.1f} s - ein freilaufender Rotor kann das physikalisch kaum. "
            "Entweder meldet der ESC nach der Gaskappung keine RPM mehr, oder er bremst den Rotor aktiv.",
            "Stoppuhr-Test am Boden: laeuft der Rotor mehrere Sekunden aus -> nur Telemetrie. Steht er in unter 1 s -> Bremse im ESC abschalten. "
            "Beachte: bei Autorotationsuebungen waere die RPM-Anzeige dann blind.")
    elif not math.isnan(m["spool_down_s"]):
        add("info", "Governor", "Hoch-/Auslauf",
            f"Hochlauf auf 95 % des Ziels: {fnum(m['spool_up_s'], 1)} s; Auslauf nach Gaskappung: {fnum(m['spool_down_s'], 1)} s.")

    # ---------- Akku / ESC ----------
    vc = m["v_min_cell"]
    obs = (f"Start {m['v_start']:.1f} V ({m['cells']}S angenommen), tiefster Wert unter Last {m['v_min']:.1f} V "
           f"({vc:.2f} V/Zelle), Spitzenstrom {m['i_peak']:.0f} A, Spitzenleistung {m['p_peak'] / 1000:.1f} kW, "
           f"Verbrauch {m['mah']:.0f} mAh ({m['wh']:.0f} Wh).")
    if vc < THRESH["vcell_load_warn"]:
        add("warn", "Akku", "Starker Spannungseinbruch unter Last", obs,
            "Akku/Kabel/Stecker pruefen, groesseren oder frischeren Akku verwenden, Flugzeit kuerzen.")
    elif vc < THRESH["vcell_load_hint"]:
        add("hint", "Akku", "Spannung bricht unter Last spuerbar ein", obs,
            "Beobachten: verschlechtert sich der Wert ueber mehrere Fluege, ist der Akku am Ende.")
    else:
        add("ok", "Akku", "Spannungseinbruch unkritisch", obs)
    if not math.isnan(m["v_rest_cell"]):
        r = m["v_rest_cell"]
        if r < THRESH["vcell_rest_low"]:
            add("hint", "Akku", "Akku tief entladen gelandet",
                f"Ruhespannung nach der Landung {r:.2f} V/Zelle.",
                "Flugzeit kuerzen oder Akku frueher wechseln (Richtwert: ab etwa 3,7-3,8 V/Zelle Ruhespannung landen).")
        else:
            add("ok", "Akku", "Landung mit Reserve", f"Ruhespannung nach der Landung {r:.2f} V/Zelle.")
    te = m["t_esc_max"]
    if math.isnan(te):
        add("info", "ESC", "ESC-Temperatur nicht geloggt",
            "ESC-Temperatursensor nicht im Log vorhanden. Aktiviere ESC-Telemetrie fuer Temperaturueberwachung.")
    else:
        obs = f"ESC-Temperatur: Start {m['t_esc_start']:.0f} C, Maximum {te:.0f} C (Anstieg {te - m['t_esc_start']:.0f} C)."
        if te >= THRESH["esc_temp_warn"]:
            add("warn", "ESC", "ESC sehr heiss", obs, "Kuehlung/Luftfuehrung verbessern, Flugzeit oder Last reduzieren. Grenzwerte haengen vom ESC ab - Datenblatt pruefen.")
        elif te >= THRESH["esc_temp_hint"]:
            add("hint", "ESC", "ESC wird warm", obs, "Trend ueber mehrere Fluege beobachten (Kuehlung, Aussentemperatur, mittlere Leistung).")
        else:
            add("ok", "ESC", "ESC-Temperatur unkritisch", obs)

    # ---------- Antrieb / Reserve ----------
    mo = m.get("mot")
    if mo:
        obs = (f"Motor-Ausgang im stabilen Flug im Mittel {mo['mean']:.1f} % (mittlere Reserve {mo['reserve']:.1f} %), Spitze {mo['peak']:.1f} % "
               f"bei {mo['t_peak']:.0f} s, {mo['near']:.1f} % der Zeit ueber 95 % (Quelle: {mo['src']}).")
        if mo["near"] >= 10 or mo["peak"] >= 99:
            add("warn", "Antrieb", "Antrieb am Limit", obs,
                "Der Governor verlangt mehr Leistung als der Antrieb liefert: Uebersetzung/Ritzel, Motor, Akku (Spannung/Strom) oder Headspeed pruefen.")
        elif mo["near"] >= 2 or mo["reserve"] < 20:
            add("hint", "Antrieb", "Wenig Leistungsreserve", obs, "Reserve beobachten; bei Drehzahleinbruechen unter Last Uebersetzung/Akku pruefen.")
        else:
            add("ok", "Antrieb", "Gesunde Leistungsreserve", obs)

    # ---------- Servos ----------
    bad = []
    for k, s in m["servo"].items():
        worst = max(s["pct_lo"], s["pct_hi"])
        if worst >= THRESH["servo_limit_pct_warn"]:
            bad.append((k, worst))
    names = {0: "Servo 1", 1: "Servo 2", 2: "Servo 3", 3: "Heck-Servo/Servo 4"}
    if bad:
        add("warn", "Servos", "Servo laeuft laenger am Endanschlag",
            ", ".join(f"{names[k]}: {p:.1f} % der Zeit" for k, p in bad),
            "Servoweg/Mixer-Limits, Taumelscheiben-Geometrie und Kollektiv-Range pruefen; beim Heck: Hebelarm/Weg und Yaw-Gain.")
    else:
        mx = max([max(s["pct_lo"], s["pct_hi"]) for s in m["servo"].values()] or [0])
        add("ok", "Servos", "Kein Servo dauerhaft am Anschlag", f"Hoechster Wert: {mx:.2f} % der Zeit am Anschlag.")

    # ---------- Hover-Spektrum ----------
    if m["hover_peaks"]:
        pk = ", ".join(f"{lab} {f:.1f} Hz ({r:.1f}x ueber Grundpegel)" for lab, f, r in m["hover_peaks"][:3])
        add("hint", "Hover", "Deutlicher Resonanzpeak im Schwebeflug",
            f"Bei ruhigen Sticks hebt sich im Gyro-Spektrum eine klare Spitze ab: {pk}.",
            "Eine echte Resonanz zeigt sich als Spitze, nicht als glatter Anstieg zu tiefen Frequenzen. Tritt sie bei gleicher Frequenz in "
            "mehreren Fluegen auf, ist die Mechanik (Lager, Spiel, Blattspurlauf, Rahmen) der erste Verdaechtige.")
    elif not math.isnan(m["wobble"]):
        add("ok", "Hover", "Kein Resonanzpeak im Schwebeflug",
            f"Das Gyro-Spektrum bei ruhigen Sticks faellt glatt ab, ohne herausragende Spitze (Eigenbewegung im Band 2-8 Hz: {m['wobble']:.1f} deg/s RMS). "
            "Das ist normale Flugbewegung/Wind, keine Resonanz.")

    # ---------- Signal / Telemetrie ----------
    sig = []
    if m["rx_loss"] > 0:
        sig.append(f"{m['rx_loss']} Samples ohne Empfaengersignal im Flug")
    if m["failsafe_active"]:
        sig.append("Failsafe war im Flug aktiv")
    if m["v_zero"] > 0:
        sig.append(f"{m['v_zero']} Samples mit Spannung 0 (Telemetrie-Aussetzer)")
    if sig:
        add("warn", "Signal", "Funk-/Telemetrieprobleme", "; ".join(sig),
            "Antennenposition, Empfaengerversorgung, Telemetrie-Verkabelung pruefen.")
    else:
        add("ok", "Signal", "Funk und Telemetrie sauber", "Keine Empfaengeraussetzer, kein Failsafe, keine Spannungs-Nullwerte.")
    if m["escthr_dead"] and not m.get("mot"):
        add("info", "Antrieb", "Kein Gas-Wert im Log",
            "Weder der ESC noch der Flugregler (motor[0]) liefern einen Gas-Wert, daher ist keine Aussage zur Leistungsreserve moeglich.")
    return F


def overall_state(F):
    s = min((SEV_ORDER[f["sev"]] for f in F), default=3)
    return {0: "warn", 1: "hint", 2: "ok", 3: "ok"}[s]


# --------------------------------------------------------------------------------------
# PID- und Filter-Empfehlungen (messbasiert, Richtungsempfehlung mit CLI-Snippet)
# --------------------------------------------------------------------------------------
def parse_pid(s):
    """Gibt [P, I, D, F, B] als Floats zurueck (nan fuer fehlende Werte)."""
    parts = str(s).split(",") if s else []
    out = []
    for i in range(5):
        try:
            out.append(float(parts[i]))
        except Exception:
            out.append(float("nan"))
    return out


def make_pid_recommendations(m):
    """
    Erzeugt eine Liste von Empfehlungen mit CLI-Snippets basierend auf
    den gemessenen Werten. Jede Empfehlung ist ein dict mit:
      area, title, obs, cli (list of "set name=value" strings, kann leer sein)
    """
    hdr = m.get("hdr", {})
    recs = []

    roll_pid  = parse_pid(hdr.get("rollPID"))
    pitch_pid = parse_pid(hdr.get("pitchPID"))
    yaw_pid   = parse_pid(hdr.get("yawPID"))
    gov_pid   = parse_pid(hdr.get("govPID"))

    # Hilfsfunktion: runde auf ganze Zahl, gib "-" wenn nan
    def rv(v, step=None):
        if math.isnan(v):
            return None
        return int(round(v)) if step is None else int(round(v / step) * step)

    def adj(v, delta):
        """Addiere delta auf v, runde auf Integer; None wenn v nan."""
        if v is None or math.isnan(v):
            return None
        return max(0, int(round(v + delta)))

    # ---- Regelabweichung (Tracking) -----------------------------------------------
    track = m.get("track", {})
    for axis, pid, pfx in [
        ("Roll",  roll_pid,  "roll"),
        ("Nick",  pitch_pid, "pitch"),
        ("Gier",  yaw_pid,   "yaw"),
    ]:
        if axis not in track:
            continue
        med, p95, n = track[axis]
        P, I, D, F, B = pid
        cli = []

        if med > 80 or p95 > 200:
            # Stark: deutliche Regelabweichung -> F und D erhoehen
            obs = (f"Regelabweichung {axis}: Median {med:.0f} deg/s, 95-%-Wert {p95:.0f} deg/s "
                   f"({n} Samples). Beides deutlich erhoeht: Feedforward zu schwach oder D zu niedrig.")
            if not math.isnan(F):
                new_F = adj(F, +max(5, round(F * 0.15)))
                cli.append(f"set {pfx}_f_gain = {new_F}  # war {rv(F)}, +15 % - Feedforward staerken")
            if not math.isnan(D) and D >= 5:
                new_D = adj(D, +max(3, round(D * 0.10)))
                cli.append(f"set {pfx}_d_gain = {new_D}  # war {rv(D)}, +10 % - Daempfung erhoehen")
        elif p95 > 120:
            # Moderate Abweichung -> nur F
            obs = (f"Regelabweichung {axis}: Median {med:.0f} deg/s (OK), 95-%-Wert {p95:.0f} deg/s erhoeht "
                   f"({n} Samples). Spitzen deuten auf schwaches Feedforward hin.")
            if not math.isnan(F):
                new_F = adj(F, +max(3, round(F * 0.10)))
                cli.append(f"set {pfx}_f_gain = {new_F}  # war {rv(F)}, +10 % - Feedforward leicht staerken")
        else:
            continue   # Tracking in Ordnung - keine Empfehlung

        recs.append(dict(
            area=f"PID {axis}",
            title=f"{axis}: Feedforward/D-Gain anpassen",
            obs=obs,
            cli=cli,
        ))

    # ---- Governor-Droop (Einbrechen unter Last) ------------------------------------
    g = m.get("gov", {})
    if g and not g.get("variable") and g.get("p01", 0) < -60:
        P, I, D, F, B = gov_pid
        droop = abs(g["p01"])
        obs = (f"Governor: 1-%-Wert der Drehzahlabweichung {g['p01']:.0f} U/min unter Ziel "
               f"({m['target']:.0f} U/min). Einbrechen unter Last deutet auf zu niedrigen Governor-Gain "
               f"oder Vorsteuerung (F-Gain / Precomp).")
        cli = []
        if not math.isnan(F):
            new_F = adj(F, +max(5, round(F * 0.12)))
            cli.append(f"set gov_f_gain = {new_F}  # war {rv(F)}, +12 % - Last-Vorsteuerung staerken")
        if not math.isnan(P):
            new_P = adj(P, +max(3, round(P * 0.10)))
            cli.append(f"set gov_p_gain = {new_P}  # war {rv(P)}, +10 % - falls F allein nicht reicht")
        recs.append(dict(area="PID Governor", title="Governor-Droop: Gain erhoehen", obs=obs, cli=cli))

    # ---- Drehzahl-Ueberschwingen ---------------------------------------------------
    if g and not g.get("variable") and g.get("p99", 0) > THRESH["over_p99_hint"]:
        P, I, D, F, B = gov_pid
        obs = (f"Governor: 99-%-Wert der Drehzahlabweichung +{g['p99']:.0f} U/min ueber Ziel. "
               f"Ueberschwingen nach Lastabnahme - Governor-F-Gain oder Vorsteuerung zu hoch.")
        cli = []
        if not math.isnan(F) and g.get("p99", 0) > THRESH["over_p99_hint"] * 1.5:
            new_F = adj(F, -max(3, round(F * 0.10)))
            cli.append(f"set gov_f_gain = {new_F}  # war {rv(F)}, -10 % - Vorsteuerung zuruecknehmen")
        recs.append(dict(area="PID Governor", title="Governor-Ueberschwingen: Gain reduzieren", obs=obs, cli=cli))

    # ---- Heck schwingt (Yaw-P zu hoch) --------------------------------------------
    y = m.get("yaw", {})
    if y.get("max", 0) >= THRESH["yaw_spike_hint"]:
        P, I, D, F, B = yaw_pid
        specific = y.get("ratio", 0) >= THRESH["yaw_axis_ratio"]
        if specific:
            obs = (f"Heck-Schwingung bei ruhigem Stick: Maximum {y['max']:.0f}, Spitze bei "
                   f"{y.get('f_max', 0):.1f} Hz, achsenspezifisch (Yaw-Achse {y.get('ratio', 0):.1f}x staerker). "
                   f"Typisches Zeichen fuer zu hohes Yaw-P oder Yaw-Stop-Gain.")
            cli = []
            if not math.isnan(P):
                delta = -max(3, round(P * 0.12))
                new_P = max(5, int(round(P + delta)))
                cli.append(f"set yaw_p_gain = {new_P}  # war {rv(P)}, {delta:+d} - Yaw-P senken")
            sg = hdr.get("yaw_stop_gain")
            if sg:
                try:
                    sg_v = float(sg)
                    new_sg = max(5, int(round(sg_v * 0.88)))
                    cli.append(f"set yaw_stop_gain = {new_sg}  # war {int(sg_v)}, -12 % - Stop-Gain senken")
                except Exception:
                    pass
            recs.append(dict(area="PID Heck", title="Yaw-P/Stop-Gain senken", obs=obs, cli=cli))

    # ---- Vibrations-Peaks -> Filter-Empfehlung ------------------------------------
    peaks = m.get("hover_peaks", [])
    main_rotor_hz = m.get("target", 0) / 60.0   # 1/rev des Hauptrotors
    for lab, freq, prominence in peaks[:3]:
        near_1rev = main_rotor_hz > 0 and abs(freq - main_rotor_hz) <= 4
        near_2rev = main_rotor_hz > 0 and abs(freq - 2 * main_rotor_hz) <= 4
        if near_1rev:
            cause = (f"nahe 1/rev des Hauptrotors ({main_rotor_hz:.1f} Hz bei {m['target']:.0f} U/min) "
                     f"- typisch fuer Rotor-Unwucht oder Spurlauf-Fehler")
            action = ("Zuerst Mechanik: Blatt-/Kopf-Wucht pruefen, dann erneut fliegen. "
                      "Ist der Peak nach der Wuchtung weg, ist kein Filter noetig. "
                      "Bleibt er: RPM-Filter auf diesen Bereich einstellen.")
            cli = []  # Wucht-Problem - kein sinnvoller CLI-Wert
        elif near_2rev:
            cause = (f"nahe 2/rev des Hauptrotors ({2*main_rotor_hz:.1f} Hz) "
                     f"- kann Spurlauf-Fehler oder Taumelscheiben-Asymmetrie sein")
            action = "Spurlauf aller Blaetter ueberpruefen, dann Wucht-Test."
            cli = []
        elif 20 <= freq <= 200:
            cause = f"moeglicherweise Motorfrequenz oder Getriebe-Harmonie bei {freq:.1f} Hz"
            action = ("Notch-Filter bei dieser Frequenz erwaegen: "
                      f"gyro_notch1_hz oder dyn_notch_min_hz pruefen. "
                      "Erst Quelle identifizieren (drehzahlabhaengig?), dann filtern.")
            notch_q = 3
            cli = [f"# Vorschlag: Notch-Filter bei {freq:.0f} Hz (Q={notch_q}) - erst Ursache pruefen!",
                   f"set gyro_notch1_hz = {int(round(freq))}",
                   f"set gyro_notch1_cutoff = {int(round(freq / (1 + 1/notch_q)))}"]
        else:
            continue

        obs = (f"Gyro-Spektrum-Peak ({lab}) bei {freq:.1f} Hz, {prominence:.1f}x ueber Grundpegel. "
               f"Ursache: {cause}.")
        recs.append(dict(area="Filter", title=f"Peak bei {freq:.1f} Hz ({lab})", obs=obs + " " + action, cli=cli))

    return recs


def pid_recommendations_html(recs):
    """Erzeugt HTML fuer den PID/Filter-Empfehlungsblock."""
    if not recs:
        return ('<div class="find ok"><span class="badge b-ok">In Ordnung</span>'
                '<b>PID &amp; Filter</b><p>Keine konkreten Messhinweise auf PID- oder Filter-Probleme. '
                'Tracking, Governor und Spektrum sehen unauffaellig aus.</p></div>')
    out = []
    for r in recs:
        cli_block = ""
        if r["cli"]:
            lines = "\n".join(r["cli"])
            cli_block = (f'<div class="todo"><b>CLI-Befehle (Rotorflight Configurator &rarr; CLI):</b>'
                         f'<pre style="margin:6px 0 0;font-size:12px;background:#1e293b;color:#e2e8f0;'
                         f'padding:8px 12px;border-radius:6px;overflow-x:auto">{html.escape(lines)}</pre>'
                         f'<span class="small">Einen Wert pro Flug aendern, danach erneut fliegen und vergleichen.</span></div>')
        out.append(
            f'<div class="find hint">'
            f'<span class="badge b-hint">Empfehlung</span>'
            f'<b>{html.escape(r["area"])}: {html.escape(r["title"])}</b>'
            f'<p>{html.escape(r["obs"])}</p>'
            f'{cli_block}</div>'
        )
    return "".join(out)


# --------------------------------------------------------------------------------------
# Diagramme
# --------------------------------------------------------------------------------------
plt.rcParams.update({"font.size": 9, "axes.grid": True, "grid.alpha": .25, "axes.spines.top": False,
                     "axes.spines.right": False, "figure.dpi": 100})
C = dict(blue="#2563eb", orange="#ea580c", green="#16a34a", red="#dc2626", grey="#6b7280", purple="#7c3aed")


def fig_b64(fig, jpeg=False):
    buf = io.BytesIO()
    if jpeg:    # fuer flaechige Bilder (Schwingungs-Karte) deutlich kleiner als PNG
        fig.savefig(buf, format="jpeg", bbox_inches="tight", dpi=100, pil_kwargs={"quality": 82})
    else:
        fig.savefig(buf, format="png", bbox_inches="tight", dpi=100)
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode()


def plot_overview(m, df):
    t = df["t"].values
    fig, ax = plt.subplots(4, 1, figsize=(11, 9), sharex=True)
    hs = col(df, "headspeed"); tg = col(df, "govTarget")
    ax[0].plot(t, hs, color=C["blue"], lw=1, label="Kopfdrehzahl")
    ax[0].plot(t, tg.where(tg > 0), color=C["orange"], lw=1, ls="--", label="Governor-Ziel")
    ax[0].set_ylabel("U/min"); ax[0].legend(loc="lower right", ncol=2)
    ax[0].set_title("Flug auf einen Blick")
    _vb_plot = col(df, "Vbat")
    div = volt_div(_vb_plot, m.get("hdr", {}))
    _ib_plot = col(df, "Ibat")
    _ib_plot_valid = _ib_plot.replace(0, np.nan).dropna()
    _ib_plot_med = float(np.nanmedian(_ib_plot_valid)) if len(_ib_plot_valid) > 0 else np.nan
    idiv_plot = 100.0 if np.isfinite(_ib_plot_med) and _ib_plot_med > 500 else 1.0
    ax[1].plot(t, _ib_plot / idiv_plot, color=C["red"], lw=.7); ax[1].set_ylabel("Strom [A]")
    ax2 = ax[1].twinx(); ax2.plot(t, _vb_plot / div, color=C["green"], lw=1); ax2.set_ylabel("Spannung [V]")
    ax2.grid(False)
    ax[2].plot(t, col(df, "Tesc"), color=C["purple"]); ax[2].set_ylabel("ESC-Temp [C]")
    st = pd.concat([df[f"rcCommand[{k}]"].abs().rolling(250, min_periods=1).mean()
                    for k in range(3) if f"rcCommand[{k}]" in df], axis=1).mean(axis=1)
    ax[3].fill_between(t, st, color=C["grey"], alpha=.5); ax[3].set_ylabel("Stick-Aktivitaet\n(Cyclic+Yaw)")
    ax[3].set_xlabel("Zeit [s]")
    for a in ax:
        a.axvspan(m["t0"], m["t0"] + (m["spool_up_s"] if not math.isnan(m["spool_up_s"]) else 0), color="#fde68a", alpha=.5, lw=0)
    if "t_worst" in m["gov"]:
        for a in ax:
            a.axvline(m["gov"]["t_worst"], color=C["orange"], ls=":", lw=1.2)
        ax[0].text(m["gov"]["t_worst"], ax[0].get_ylim()[1], " staerkster\n Ueberschwinger", va="top", fontsize=7, color=C["orange"])
    if "t_max" in m["yaw"]:
        for a in ax:
            a.axvline(m["yaw"]["t_max"], color=C["purple"], ls=":", lw=1.2)
        ax[3].text(m["yaw"]["t_max"], ax[3].get_ylim()[1], " staerkste\n Heck-Schwingung", va="top", fontsize=7, color=C["purple"])
    ax[0].text(m["t0"], ax[0].get_ylim()[1], " Hochlauf", va="top", fontsize=7, color="#92400e")
    fig.tight_layout()
    return fig_b64(fig)


def plot_governor(m, df):
    g = m["gov"]
    fig, ax = plt.subplots(1, 2, figsize=(11, 3.6), gridspec_kw={"width_ratios": [1.6, 1]})
    if "t_worst" in g:
        tw = g["t_worst"]
        w = df[(df["t"] > tw - 3) & (df["t"] < tw + 3)]
        ax[0].plot(w["t"], col(w, "headspeed"), color=C["blue"], label="Kopfdrehzahl")
        ax[0].plot(w["t"], col(w, "govTarget"), color=C["orange"], ls="--", label="Ziel")
        a2 = ax[0].twinx(); a2.plot(w["t"], col(w, "rcCommand[3]"), color=C["grey"], lw=.8, alpha=.7); a2.set_ylabel("Kollektiv-Stick"); a2.grid(False)
        ax[0].set_title(f"Groesster Ueberschwinger (+{g['maxover']:.0f} U/min)"); ax[0].set_xlabel("Zeit [s]"); ax[0].set_ylabel("U/min")
        ax[0].legend(loc="upper left")
        fl = m["fl"]
        e = (col(fl, "headspeed") - col(fl, "govTarget"))
        e = e[(col(fl, "govTarget") - m["target"]).abs() <= 2]
        ax[1].hist(e.clip(-200, 300), bins=70, color=C["blue"], alpha=.8)
        ax[1].axvline(0, color=plt.rcParams["text.color"], lw=.8)
        ax[1].axvline(THRESH["over_event_rpm"], color=C["red"], ls="--", lw=1, label=f"+{THRESH['over_event_rpm']} U/min")
        ax[1].set_yscale("log"); ax[1].set_xlabel("Drehzahlabweichung vom Ziel [U/min]"); ax[1].set_title("Verteilung (log)")
        ax[1].legend(); ax[1].set_ylabel("Anzahl Samples (log)")
    else:
        fl = m["fl"]
        ax[0].plot(fl["t"], col(fl, "headspeed"), color=C["blue"], lw=.8); ax[0].plot(fl["t"], col(fl, "govTarget"), color=C["orange"], ls="--", lw=.8)
        ax[0].set_title("Variables Ziel - Ist (blau) und Ziel (orange)")
        ax[1].hist((col(fl, "headspeed") - col(fl, "govTarget")).clip(-100, 100), bins=60, color=C["blue"])
        ax[1].set_title("Abweichung Ist-Ziel")
    fig.tight_layout(); fig.subplots_adjust(wspace=0.5)
    return fig_b64(fig)


def plot_yaw(m, df):
    y = m["yaw"]
    if "max" not in y:
        return None
    fig, ax = plt.subplots(1, 2, figsize=(11, 3.6), gridspec_kw={"width_ratios": [1.4, 1]})
    ax[0].vlines(y["t"], 0, y["E"], color=C["purple"], lw=1.2, alpha=.7)
    ax[0].scatter(y["t"], y["E"], s=6, color=C["purple"])
    ax[0].axhline(THRESH["yaw_spike_hint"], color=C["orange"], ls="--", lw=1, label="Hinweis")
    ax[0].axhline(THRESH["yaw_spike_warn"], color=C["red"], ls="--", lw=1, label="Handlungsbedarf")
    ax[0].set_title("Heck-Schwingung bei ruhigem Gier-Stick (8-20 Hz, je ein Strich pro Sekunde)"); ax[0].set_xlabel("Zeit [s]"); ax[0].set_ylabel("Energie (a.u.)")
    ax[0].legend()
    fs = m["fs"]; fl = m["fl"]
    k = int(np.argmax(y["E"])); tt = y["t"][k]
    w = fl[(fl["t"] >= tt) & (fl["t"] < tt + 1.0)]
    for ax_i, lab, c in [(2, "Gier", C["purple"]), (0, "Roll", C["blue"]), (1, "Nick", C["green"])]:
        s = w[f"gyroADC[{ax_i}]"].values; s = s - s.mean()
        sp = np.abs(np.fft.rfft(s * np.hanning(len(s)))); fr = np.fft.rfftfreq(len(s), 1 / fs)
        mk = (fr > 2) & (fr < 40)
        ax[1].plot(fr[mk], sp[mk], color=c, label=lab, lw=1.2)
    ax[1].axvspan(8, 20, color="#fde68a", alpha=.4, lw=0)
    ax[1].set_title(f"Spektrum im staerksten Fenster (t={tt:.0f} s)"); ax[1].set_xlabel("Hz"); ax[1].legend()
    fig.tight_layout()
    return fig_b64(fig)


def plot_hover_spectrum(m):
    fl = m["fl"]; fs = m["fs"]
    win = int(2 * fs); acc = {k: [] for k in range(3)}
    st = sum(np.abs(fl[f"rcCommand[{k}]"].values) for k in range(3)) / 3
    for s in range(0, len(fl) - win, win // 2):
        if st[s:s + win].mean() < 25:
            for k in range(3):
                y = fl[f"gyroADC[{k}]"].values[s:s + win]; y = y - y.mean()
                acc[k].append(np.abs(np.fft.rfft(y * np.hanning(win))) / win)
    if len(acc[0]) < 3:
        return None
    fr = np.fft.rfftfreq(win, 1 / fs)
    fig, ax = plt.subplots(figsize=(11, 3.4))
    for k, lab, c in [(0, "Roll", C["blue"]), (1, "Nick", C["green"]), (2, "Gier", C["purple"])]:
        sp = np.mean(acc[k], axis=0)
        mk = (fr > 1) & (fr < 60)
        ax.plot(fr[mk], sp[mk], label=lab, color=c)
    ax.axvspan(2, 8, color="#fde68a", alpha=.4, lw=0, label="2-8 Hz")
    for lab, f, r in m.get("hover_peaks", [])[:3]:
        ax.axvline(f, color=C["red"], ls="--", lw=1)
        ax.text(f, ax.get_ylim()[1], f" {lab} {f:.1f} Hz", rotation=90, va="top", fontsize=7, color=C["red"])
    ax.set_yscale("log"); ax.set_xlabel("Hz"); ax.set_title(f"Gyro-Spektrum bei ruhigen Sticks ({len(acc[0])} Fenster) - echte Resonanz = Spitze, glatter Abfall = normale Bewegung")
    ax.legend(ncol=4)
    fig.tight_layout()
    return fig_b64(fig)


def plot_servos(m):
    fl = m["fl"]
    fig, ax = plt.subplots(1, 4, figsize=(11, 2.8))
    for k in range(4):
        c = f"servo[{k}]"
        if c in fl:
            ax[k].hist(fl[c], bins=60, color=C["blue"], alpha=.85)
            ax[k].set_yscale("log"); ax[k].set_title(f"Servo {k + 1}" + (" (Heck)" if k == 3 else ""))
            if k in m["servo"]:
                s = m["servo"][k]
                ax[k].set_xlabel(f"min {s['lo']:.0f}  max {s['hi']:.0f}")
    fig.suptitle("Servo-Auslastung (Haeufigkeit der Stellwerte, log) - Spitzen an den Raendern = Anschlag", y=1.04, fontsize=9)
    fig.tight_layout()
    return fig_b64(fig)


def plot_spectrogram(m):
    """Schwingungs-Karte: Zeit x Frequenz, je Achse. Zeigt Heck-Schwingungen auf einen Blick."""
    from numpy.lib.stride_tricks import sliding_window_view
    fl, fs = m["fl"], m["fs"]
    win, hop = int(fs), max(int(fs / 4), 1)
    if len(fl) < win * 4 or not all(f"gyroADC[{k}]" in fl for k in range(3)):
        return None
    fr = np.fft.rfftfreq(win, 1 / fs)
    sel = (fr >= 2) & (fr <= 40)
    w = np.hanning(win)
    logs = []
    for k in range(3):
        y = fl[f"gyroADC[{k}]"].values.astype(float)
        wv = sliding_window_view(y, win)[::hop]
        wv = wv - wv.mean(axis=1, keepdims=True)
        logs.append(np.log10(np.abs(np.fft.rfft(wv * w, axis=1))[:, sel] + 1.0))
    t0 = fl["t"].iloc[0] + 0.5 * win / fs
    t1 = t0 + (logs[0].shape[0] - 1) * hop / fs
    allv = np.concatenate([a.ravel() for a in logs])
    vmin, vmax = np.percentile(allv, 8), np.percentile(allv, 99.8)
    spec_only = logs[2] - np.maximum(logs[0], logs[1])          # Gier staerker als Roll/Nick (log-Einheiten)
    dmax = max(float(np.percentile(spec_only, 99.7)), 0.3)
    fig, ax = plt.subplots(4, 1, figsize=(11, 9), sharex=True, gridspec_kw={"height_ratios": [1, 1, 1, 1.25]})
    im = None
    for a, S, lab in zip(ax[:3], logs, ["Roll", "Nick", "Gier (Heck)"]):
        im = a.imshow(S.T, origin="lower", aspect="auto", cmap="magma", vmin=vmin, vmax=vmax,
                      extent=[t0, t1, fr[sel][0], fr[sel][-1]], interpolation="nearest")
        a.set_ylabel(f"{lab}\nHz"); a.grid(False)
    im2 = ax[3].imshow(spec_only.T, origin="lower", aspect="auto", cmap="Reds", vmin=0, vmax=dmax,
                       extent=[t0, t1, fr[sel][0], fr[sel][-1]], interpolation="nearest")
    ax[3].set_ylabel("nur Heck\nHz"); ax[3].grid(False)
    for a in ax:
        for hz in (8, 20):
            a.axhline(hz, color="grey", lw=.5, ls=":", alpha=.7)
    ax[3].set_xlabel("Zeit [s]")
    fig.suptitle("Schwingungs-Karte (hell = starke Schwingung bei dieser Frequenz)", y=0.995)
    fig.tight_layout()
    fig.colorbar(im, ax=ax[:3], label="Staerke (log)", fraction=.02, pad=.01)
    fig.colorbar(im2, ax=ax[3], label="Heck staerker als\nRoll/Nick", fraction=.02, pad=.01)
    return fig_b64(fig, jpeg=True)


def plot_load(m):
    """Wo entstehen Drehzahlabweichungen? Aufgeschluesselt nach Kollektivstellung."""
    if not m["target_fixed"]:
        return None
    fl, fs = m["fl"], m["fs"]
    g = fl[(col(fl, "govTarget") - m["target"]).abs() <= 2]
    if len(g) < 3000 or "rcCommand[3]" not in g:
        return None
    e = col(g, "headspeed") - m["target"]
    cat = pd.cut(g["rcCommand[3]"], np.linspace(-500, 500, 11), include_lowest=True)
    grp = e.groupby(cat, observed=False)
    q = grp.quantile([.05, .5, .95]).unstack()
    mx, mn, n = grp.max(), grp.min(), grp.size()
    ctr = np.array([(iv.left + iv.right) / 2 for iv in q.index])
    ok = n.values > 50
    fig, ax = plt.subplots(1, 2, figsize=(11, 3.6), gridspec_kw={"width_ratios": [1.7, 1]})
    ax[0].fill_between(ctr[ok], q[.05].values[ok], q[.95].values[ok], color=C["blue"], alpha=.25, label="90 % der Zeit")
    ax[0].plot(ctr[ok], q[.5].values[ok], color=C["blue"], lw=1.6, label="Median")
    ax[0].plot(ctr[ok], mx.values[ok], color=C["orange"], marker="o", ms=3, lw=1, label="Maximum (zu schnell)")
    ax[0].plot(ctr[ok], mn.values[ok], color=C["red"], marker="o", ms=3, lw=1, label="Minimum (zu langsam)")
    ax[0].axhline(0, color=plt.rcParams["text.color"], lw=.8)
    ax[0].set_xlabel("Kollektiv-Stick  (negativ = Lastabnahme / Rueckenflug, positiv = Last)")
    ax[0].set_ylabel("Abweichung vom Ziel [U/min]"); ax[0].set_title("Drehzahlabweichung nach Kollektivstellung"); ax[0].legend(fontsize=7)
    ax[1].bar(ctr, n.values / fs, width=85, color=C["grey"], alpha=.8)
    ax[1].set_xlabel("Kollektiv-Stick"); ax[1].set_ylabel("Zeit [s]"); ax[1].set_title("So lange war der Stick dort")
    fig.tight_layout()
    return fig_b64(fig)


def plot_discharge(ms):
    ok = [m for m in ms if m["ok"] and "curve" in m]
    if len(ok) < 2:
        return None
    fig, ax = plt.subplots(figsize=(11, 4.2))
    cmap = plt.get_cmap("viridis")
    for i, m in enumerate(ok):
        x, v = m["curve"]
        ax.plot(x, v, color=cmap(i / max(len(ok) - 1, 1)), lw=1.3, label=short_name(m["name"]))
    ax.set_xlabel("verbrauchte Kapazitaet [mAh]"); ax.set_ylabel("Spannung pro Zelle [V], geglaettet")
    ax.set_title("Entladekurven aller Fluege (frueh = dunkel, spaet = hell)")
    ax.legend(ncol=min(len(ok), 6), fontsize=7, loc="upper center", bbox_to_anchor=(.5, -.16), frameon=False)
    fig.tight_layout()
    return fig_b64(fig)


TUNE_KEYS = ("govPID", "yawPID", "rollPID", "pitchPID", "yaw_stop_gain", "yawBW")


def changed_keys(prev, cur):
    return [k for k in DIFF_KEYS if prev.get(k) != cur.get(k) and (prev.get(k) is not None or cur.get(k) is not None)]


def plot_compare(rows):
    n = len(rows)
    lab = [f"{r['short']}  |  Yaw-P {fnum(r['yawP'])}, Gov-D {fnum(r['govD'])}" for r in rows]
    fig, ax = plt.subplots(3, 1, figsize=(max(9, n * 0.9), 10), sharex=True)
    x = np.arange(n)

    def tl(v, hint, warn):
        return C["red"] if v >= warn else (C["orange"] if v >= hint else C["green"])

    yv = [0 if math.isnan(r["yaw_max"]) else r["yaw_max"] for r in rows]
    ax[0].bar(x, yv, color=[tl(v, THRESH["yaw_spike_hint"], THRESH["yaw_spike_warn"]) for v in yv])
    ax[0].axhline(THRESH["yaw_spike_warn"], color=C["red"], ls="--", lw=1); ax[0].axhline(THRESH["yaw_spike_hint"], color=C["orange"], ls="--", lw=1)
    ax[0].set_ylim(0, max(yv + [THRESH["yaw_spike_warn"]]) * 1.4)
    ax[0].set_title("Heck: staerkste Schwingungsspitze bei ruhigem Stick  (gruen = ok, orange = Hinweis, rot = Handlungsbedarf)"); ax[0].set_ylabel("Energie (a.u.)")
    ov = [0 if math.isnan(r["over_rate"]) else r["over_rate"] for r in rows]
    ax[1].bar(x, ov, color=[tl(v, THRESH["over_rate_hint"], THRESH["over_rate_warn"]) for v in ov])
    ax[1].axhline(THRESH["over_rate_hint"], color=C["orange"], ls="--", lw=1); ax[1].axhline(THRESH["over_rate_warn"], color=C["red"], ls="--", lw=1)
    for i, r in enumerate(rows):
        if math.isnan(r["over_rate"]):
            ax[1].text(i, 0.5, "variables\nZiel", ha="center", fontsize=7, color=C["grey"])
    ax[1].set_title("Governor: Ueberschwinger pro Minute (nur Fluege mit festem Ziel)"); ax[1].set_ylabel("pro Minute")
    ax[2].bar(x, [r["mah"] for r in rows], color=C["blue"]); ax[2].set_title("Verbrauch pro Flug"); ax[2].set_ylabel("mAh")
    ax[2].set_xticks(x); ax[2].set_xticklabels(lab, rotation=55, ha="right", fontsize=7)
    # senkrechte Linien dort, wo sich Tuning-Parameter gegenueber dem Vorflug geaendert haben
    for i in range(1, n):
        ch = [k for k in changed_keys(rows[i - 1]["hdr"], rows[i]["hdr"]) if k in TUNE_KEYS]
        if ch:
            for a in ax:
                a.axvline(i - 0.5, color=C["grey"], ls="--", lw=1)
            ax[0].text(i - 0.45, ax[0].get_ylim()[1], " geaendert: " + ", ".join(ch), rotation=90, va="top", ha="left", fontsize=7,
                       color="#111827", bbox=dict(facecolor="white", alpha=.85, edgecolor="none", pad=1.5))
    fig.tight_layout()
    return fig_b64(fig)


# --------------------------------------------------------------------------------------
# HTML
# --------------------------------------------------------------------------------------
CSS = """
*{box-sizing:border-box}
body{font-family:Segoe UI,Arial,sans-serif;margin:0;background:#f3f4f6;color:#111827;line-height:1.45}
.wrap{max-width:1120px;margin:0 auto;padding:18px 24px 60px}
header h1{margin:18px 0 2px}.sub{color:#6b7280;margin-bottom:10px}
nav{position:sticky;top:0;z-index:20;background:#111827;padding:8px 14px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
nav a{color:#e5e7eb;text-decoration:none;font-size:12px;padding:3px 10px;border-radius:99px;background:#374151}
nav a:hover{background:#4b5563}nav .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
nav .sep{color:#6b7280;margin:0 4px}
section{margin-top:26px}
h2{margin:0 0 10px;font-size:20px;border-bottom:2px solid #d1d5db;padding-bottom:4px}
h3{margin:22px 0 6px;font-size:15px;color:#374151;text-transform:uppercase;letter-spacing:.04em}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:12px 0}
.card{background:#fff;border-radius:10px;padding:10px 12px;border-left:6px solid #9ca3af;box-shadow:0 1px 2px #0001;font-size:13px}
.card b{display:block;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
.badge{display:inline-block;font-size:11px;padding:1px 9px;border-radius:99px;color:#fff;margin-right:6px;vertical-align:middle}
.b-warn{background:#dc2626}.b-hint{background:#f59e0b}.b-ok{background:#16a34a}.b-info{background:#2563eb}
.fazit{border-radius:10px;padding:12px 16px;margin:10px 0;background:#fff;border-left:8px solid #9ca3af;box-shadow:0 1px 2px #0001}
.fazit.warn{background:#fef2f2}.fazit.hint{background:#fffbeb}.fazit.ok{background:#f0fdf4}
.find{background:#fff;border-radius:10px;padding:10px 14px;margin:8px 0;border-left:6px solid #9ca3af;box-shadow:0 1px 2px #0001}
.find p{margin:4px 0}.todo{background:#f3f4f6;border-radius:6px;padding:6px 10px;margin-top:6px;font-size:13px}
figure{margin:10px 0;background:#fff;border-radius:10px;padding:8px;box-shadow:0 1px 2px #0001}
figure img{max-width:100%;display:block;margin:0 auto}
figcaption{font-size:12.5px;color:#4b5563;padding:6px 8px 2px}
.card.warn,.find.warn,.fazit.warn{border-left-color:#dc2626}.card.hint,.find.hint,.fazit.hint{border-left-color:#f59e0b}
.card.ok,.find.ok,.fazit.ok{border-left-color:#16a34a}.card.info,.find.info{border-left-color:#2563eb}
table{border-collapse:collapse;width:100%;background:#fff;font-size:13px;border-radius:8px;overflow:hidden}
th,td{padding:5px 8px;border-bottom:1px solid #e5e7eb;text-align:right}th:first-child,td:first-child{text-align:left}
th{background:#f3f4f6}
table.matrix td,table.matrix th{text-align:center;padding:4px 6px}table.matrix td:first-child{text-align:left}
td.st{width:70px}td.st a{display:block;height:22px;border-radius:5px}
td.st.warn a{background:#dc2626}td.st.hint a{background:#f59e0b}td.st.ok a{background:#16a34a}td.st.info a{background:#93c5fd}td.st.none a{background:#e5e7eb}
.legend span{display:inline-block;margin-right:14px;font-size:12px}.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:5px;vertical-align:-1px}
details.flight{background:#fff;border-radius:12px;margin:14px 0;box-shadow:0 1px 3px #0002}
details.flight>summary{cursor:pointer;font-size:17px;font-weight:600;padding:12px 16px;list-style:none}
details.flight>summary::-webkit-details-marker{display:none}
details.flight>summary:before{content:"\\25B8  ";color:#6b7280}details.flight[open]>summary:before{content:"\\25BE  "}
details.flight>.body{padding:0 16px 16px}
details.mini{background:#f9fafb;border-radius:8px;padding:6px 12px;margin:8px 0}details.mini summary{cursor:pointer;font-weight:600}
.small{font-size:12px;color:#6b7280}.chg{color:#b45309;font-weight:600;text-align:left}
@media print{nav{display:none}figure,.find,.fazit{break-inside:avoid}}
"""

AREAS = ["Heck", "Governor", "Antrieb", "Akku", "ESC", "Servos", "Hover", "Signal"]
AREA_PRIO = ["Heck", "Governor", "Antrieb", "ESC/Telemetrie", "Akku", "ESC", "Servos", "Hover", "Signal", "Log"]
RANK = {"warn": 0, "hint": 1, "ok": 2, "info": 3}     # Anzeige: Info zaehlt nur, wenn sonst nichts da ist

CAPTIONS = {
    "overview": "Oben Drehzahl gegen Ziel, darunter Strom/Spannung, ESC-Temperatur und wie viel du an den Sticks gemacht hast. "
                "Gelb = Hochlauf. Gestrichelte Linien: staerkster Ueberschwinger (orange) und staerkste Heck-Schwingung (lila).",
    "governor": "Links der groesste Drehzahl-Ausreisser im Detail (grau = Kollektiv-Stick). Rechts, wie oft welche Abweichung vom Ziel vorkam - "
                "logarithmisch, jede Stufe nach oben ist zehnmal mehr. Je steiler der Berg an der Null, desto besser haelt der Governor.",
    "load": "Zeigt, bei welcher Kollektivstellung die Drehzahl vom Ziel abweicht. Hohe orange Maxima bei niedrigem/negativem Kollektiv = Drehzahl "
            "schiesst bei Lastabnahme hoch (Hinweis auf F-Gain/Vorsteuerung). Rote Einbrueche bei hohem Kollektiv = Last/Leistungsreserve.",
    "yaw": "Links: jeder Strich = eine Sekunde mit ruhigem Gier-Stick; Striche ueber der orangen Linie sind auffaellig. "
           "Rechts das Spektrum im schlimmsten Moment: eine Spitze nur bei Gier (lila) = Regelkreis des Hecks schwingt.",
    "spectro": "Zeit nach rechts, Frequenz nach oben, hell = stark. Die oberen drei Felder zeigen Roll, Nick und Gier; senkrechte helle Streifen in allen "
               "dreien sind Manoever (alle Achsen bewegen sich) und normal. Das rote Feld unten zeigt NUR, wo das Heck staerker schwingt als Roll/Nick - "
               "dort faellt ein Heck-Problem sofort auf, Manoever verschwinden.",
    "hover": "Gyro-Spektrum nur aus ruhigen Schwebeflug-Phasen. Ein glatter Abfall nach rechts ist normale Bewegung/Wind. "
             "Nur eine echte Spitze (rot markiert) deutet auf eine Resonanz hin.",
    "servos": "Wie oft welcher Stellwert vorkam (logarithmisch). Hohe Balken ganz am Rand = Servo laeuft am Anschlag.",
    "compare": "Jeder Balken ein Flug. Gestrichelte graue Linien markieren, wo sich ein Tuning-Parameter gegenueber dem Vorflug geaendert hat. "
               "Vergleiche nur Fluege mit aehnlicher Belastung - der Flugstil verschiebt die Werte oft mehr als ein Parameter.",
    "discharge": "Spannung pro Zelle ueber dem Verbrauch. Die Kurven sollten uebereinander liegen; faellt eine frueher ab, war der Akku schwaecher "
                 "oder die Belastung hoeher.",
}


def esc(s):
    return html.escape(str(s))


def area_state(F, area):
    sv = [f["sev"] for f in F if f["area"] == area]
    return min(sv, key=lambda s: RANK[s]) if sv else None


def card(sev, label, text):
    return f'<div class="card {sev}"><b>{esc(label)}</b>{esc(text)}</div>'


def cards_for(F):
    out = []
    for a in AREAS:
        st = area_state(F, a)
        if st:
            title = [f["title"] for f in F if f["area"] == a and f["sev"] == st][0]
            out.append(card(st, a, title))
    return "".join(out)


def findings_html(F):
    out = []
    for f in sorted(F, key=lambda f: SEV_ORDER[f["sev"]]):
        todo = f'<div class="todo"><b>Ansatz:</b> {esc(f["todo"])}</div>' if f["todo"] else ""
        out.append(f'<div class="find {f["sev"]}"><span class="badge b-{f["sev"]}">{SEV_LABEL[f["sev"]]}</span>'
                   f'<b>{esc(f["area"])}: {esc(f["title"])}</b><p>{esc(f["obs"])}</p>{todo}</div>')
    return "".join(out)


def fazit_html(F):
    n = {s: sum(1 for f in F if f["sev"] == s) for s in SEV_ORDER}
    issues = [f for f in F if f["sev"] in ("warn", "hint")]
    if not issues:
        return '<div class="fazit ok"><b>Fazit:</b> Keine Auffaelligkeiten - alle Bereiche in Ordnung.</div>'
    top = sorted(issues, key=lambda f: (SEV_ORDER[f["sev"]], AREA_PRIO.index(f["area"]) if f["area"] in AREA_PRIO else 99))[0]
    step = ""
    if top["todo"]:
        first = re.split(r"(?<=[.!?])\s", top["todo"])[0]
        step = f'<br><b>Naechster Schritt:</b> {esc(first)}'
    cls = "warn" if n["warn"] else "hint"
    return (f'<div class="fazit {cls}"><b>Fazit:</b> {n["warn"]}x Handlungsbedarf, {n["hint"]}x Hinweis, {n["ok"]}x in Ordnung. '
            f'<b>Wichtigster Punkt:</b> {esc(top["area"])} - {esc(top["title"])}.{step}</div>')


def settings_table(hdr):
    keys = ["Craft name", "Firmware revision", "Board name", "govPID", "rollPID", "pitchPID", "yawPID", "yaw_stop_gain",
            "yawBW", "levelPID", "rc_rates", "rc_expo", "motor_pwm_protocol", "dshot_bidir"]
    rows = "".join(f"<tr><td>{esc(k)}</td><td>{esc(hdr.get(k, '-'))}</td></tr>" for k in keys if k in hdr)
    return f"<table>{rows}</table><div class='small'>PID-Reihenfolge laut Rotorflight: P, I, D, F, B (Governor: P, I, D, F, Gesamt-Gain).</div>"


def detail_table(m):
    r = [
        ("Flugphase (Drehzahl erreicht bis Gaskappung)", f"{m['flight_s']:.0f} s"),
        ("Zieldrehzahl", f"{m['target']:.0f} ({'fest' if m['target_fixed'] else 'variabel'})"),
        ("Hochlauf auf 95 %", fnum(m["spool_up_s"], 1, " s")), ("Auslauf bis < 50 U/min", fnum(m["spool_down_s"], 1, " s")),
        ("Strom Mittel / Spitze", f"{m['i_mean']:.0f} / {m['i_peak']:.0f} A"),
        ("Leistung Mittel / Spitze", f"{m['p_mean']:.0f} / {m['p_peak']:.0f} W"),
        ("Verbrauch", f"{m['mah']:.0f} mAh / {m['wh']:.0f} Wh"),
        ("Spannung Start / Minimum / Ruhe nach Landung",
         f"{m['v_start']:.2f} V ({m['v_start']/m['cells']:.2f} V/Zelle) / "
          f"{m['v_min']:.2f} V ({m['v_min_cell']:.2f} V/Zelle) / "
          f"{fnum(m['v_rest_cell'], 2)} V/Zelle Ruhe"),
        ("ESC-Temperatur Start / Max", f"{m['t_esc_start']:.0f} / {m['t_esc_max']:.0f} C" if not math.isnan(m['t_esc_max']) else "nicht geloggt"),
        ("Stick-Aktivitaet Roll/Nick/Gier (mittl. |Auslenkung|)", f"{m['stick_activity']:.1f} (Skala 0-500)"),
    ]
    for lab, (med, p95, n) in m["track"].items():
        r.append((f"Regelabweichung {lab} (Soll>150 deg/s)", f"Median {med:.0f}, 95 % {p95:.0f} deg/s ({n} Samples)"))
    rows = "".join(f"<tr><td>{esc(a)}</td><td>{esc(b)}</td></tr>" for a, b in r)
    return f"<table>{rows}</table>"


def figure(b64, caption, alt):
    mime = "jpeg" if b64.startswith("/9j/") else "png"
    return f'<figure><img alt="{esc(alt)}" src="data:image/{mime};base64,{b64}"><figcaption>{esc(caption)}</figcaption></figure>'


def flight_figures(m, df):
    groups = [
        ("Der Flug im Ueberblick", [("overview", "Uebersicht", lambda: plot_overview(m, df))]),
        ("Governor und Antrieb", [("governor", "Governor", lambda: plot_governor(m, df)), ("load", "Last", lambda: plot_load(m))]),
        ("Heck und Schwingungen", [("yaw", "Heck", lambda: plot_yaw(m, df)), ("spectro", "Schwingungs-Karte", lambda: plot_spectrogram(m)),
                                   ("hover", "Hover-Spektrum", lambda: plot_hover_spectrum(m))]),
        ("Servos", [("servos", "Servos", lambda: plot_servos(m))]),
    ]
    out = []
    for title, items in groups:
        body = []
        for key, alt, fn in items:
            try:
                b = fn()
            except Exception as ex:      # ein fehlendes Feld soll nicht den ganzen Bericht stoppen
                body.append(f'<div class="small">Diagramm "{esc(alt)}" uebersprungen ({esc(ex)}).</div>')
                continue
            if b:
                body.append(figure(b, CAPTIONS[key], alt))
        if body:
            out.append(f"<h3>{esc(title)}</h3>" + "".join(body))
    return "".join(out)


def flight_section(m, df, fid, with_plots=True, open_=False):
    F = make_findings(m)
    st = overall_state(F)
    head = f'<summary>{esc(m["name"])} <span class="badge b-{st}">{SEV_LABEL[st]}</span></summary>'
    if not m["ok"]:
        return f'<details class="flight" id="{fid}">{head}<div class="body"><div class="find info">{esc(m.get("error", ""))}</div></div></details>', [], st
    pid_recs = make_pid_recommendations(m)
    h = [f'<div class="sub">Flugphase {m["flight_s"]:.0f} s | Ziel {m["target"]:.0f} U/min '
         f'({"fest" if m["target_fixed"] else "variabel"}) | {m["mah"]:.0f} mAh</div>',
         fazit_html(F), f'<div class="cards">{cards_for(F)}</div>',
         "<h3>Empfehlungen</h3>" + findings_html(F),
         "<h3>PID- und Filter-Empfehlungen</h3>"
         "<p style='font-size:13px;color:#6b7280;margin:0 0 8px'>Basierend auf den gemessenen Werten dieses Fluges. "
         "Immer nur einen Parameter pro Flug aendern und das Ergebnis im naechsten Flug vergleichen.</p>"
         + pid_recommendations_html(pid_recs)]
    if with_plots:
        h.append(flight_figures(m, df))
    h.append(f"<details class='mini'><summary>Einstellungen aus dem Log</summary>{settings_table(m['hdr'])}</details>")
    h.append(f"<details class='mini'><summary>Alle Kennzahlen</summary>{detail_table(m)}</details>")
    return f'<details class="flight" id="{fid}"{" open" if open_ else ""}>{head}<div class="body">{"".join(h)}</div></details>', F, st


def short_name(name):
    mt = re.search(r"(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})\d{2}", name)
    return f"{mt.group(3)}.{mt.group(2)}. {mt.group(4)}:{mt.group(5)}" if mt else name[-14:]


def compare_rows(ms, ids):
    rows = []
    for m, fid in zip(ms, ids):
        if not m["ok"]:
            continue
        g, y = m["gov"], m["yaw"]
        rows.append(dict(name=m["name"], id=fid, short=short_name(m["name"]), hdr=m["hdr"],
                         yawP=pid_part(m["hdr"].get("yawPID"), 0), govD=pid_part(m["hdr"].get("govPID"), 2),
                         yaw_max=y.get("max", np.nan), over_rate=g.get("rate", np.nan),
                         mah=m["mah"], ipk=m["i_peak"], vmin=m["v_min"], tmax=m["t_esc_max"],
                         dur=m["flight_s"], fixed=m["target_fixed"], act=m["stick_activity"]))
    return rows


def matrix_html(entries):
    """entries: [(id, kurzname, F)] -> Ampel-Matrix Fluege x Bereiche"""
    head = "".join(f"<th>{a}</th>" for a in AREAS)
    body = []
    for fid, short, F in entries:
        cells = []
        for a in AREAS:
            st = area_state(F, a)
            tip = " | ".join(f["title"] for f in F if f["area"] == a) or "-"
            cells.append(f'<td class="st {st or "none"}" title="{esc(tip)}"><a href="#{fid}"></a></td>')
        body.append(f'<tr><td><a href="#{fid}">{esc(short)}</a></td>{"".join(cells)}</tr>')
    leg = ('<div class="legend"><span><i style="background:#16a34a"></i>in Ordnung</span><span><i style="background:#f59e0b"></i>Hinweis</span>'
           '<span><i style="background:#dc2626"></i>Handlungsbedarf</span><span><i style="background:#e5e7eb"></i>nicht bewertet</span></div>')
    return f'<table class="matrix"><tr><th>Flug</th>{head}</tr>{"".join(body)}</table>{leg}'


def compare_html(rows):
    h = [f'<div class="small">{CAPTIONS["compare"]}</div>',
         figure(plot_compare(rows), "Heck-Spitzen, Governor-Ueberschwinger und Verbrauch je Flug.", "Vergleich")]
    th = ("<tr><th>Flug</th><th>Dauer</th><th>Yaw-P</th><th>Gov-D</th><th>Heck-Spitze</th><th>Ueberschw./min</th>"
          "<th>Aktivitaet</th><th>mAh</th><th>I max</th><th>V min</th><th>ESC max</th><th>Aenderung ggue. Vorflug</th></tr>")
    body, prev = [], None
    for r in rows:
        chg = [f"{k}: {prev['hdr'].get(k)} -> {r['hdr'].get(k)}" for k in changed_keys(prev["hdr"], r["hdr"])] if prev else []
        body.append(
            f"<tr><td><a href='#{r['id']}'>{esc(r['short'])}</a></td><td>{r['dur']:.0f} s</td><td>{fnum(r['yawP'])}</td>"
            f"<td>{fnum(r['govD'])}</td><td>{fnum(r['yaw_max'])}</td><td>{fnum(r['over_rate'], 1) if r['fixed'] else 'var.'}</td>"
            f"<td>{r['act']:.0f}</td><td>{r['mah']:.0f}</td><td>{r['ipk']:.0f} A</td><td>{r['vmin']:.1f} V</td><td>{r['tmax']:.0f} C</td>"
            f"<td class='chg'>{esc('; '.join(chg))}</td></tr>")
        prev = r
    h.append(f"<table>{th}{''.join(body)}</table>")
    return "".join(h)


def build_report(ms, dfs, summary_only):
    ids = [f"flug{i + 1}" for i in range(len(ms))]
    multi = len(ms) > 1
    sections, allF, nav_items = [], [], []
    for i, (m, df) in enumerate(zip(ms, dfs)):
        sec, F, st = flight_section(m, df, ids[i], with_plots=not summary_only, open_=not multi)
        sections.append(sec)
        allF.append((ids[i], short_name(m["name"]), m, F))
        nav_items.append((ids[i], short_name(m["name"]), st))
    ok = [(fid, sh, m, F) for fid, sh, m, F in allF if m["ok"]]
    top = [f"<header><h1>Rotorflight Log-Bericht</h1><div class='sub'>{len(ms)} Flug/Fluege ausgewertet</div></header>"]
    if multi:
        chips = "".join(f'<a href="#{fid}"><span class="dot" style="background:'
                        f'{ {"warn": "#dc2626", "hint": "#f59e0b", "ok": "#16a34a", "info": "#93c5fd"}[st] }"></span>{esc(sh)}</a>'
                        for fid, sh, st in nav_items)
        nav = f'<nav><a href="#uebersicht">Uebersicht</a><a href="#vergleich">Vergleich</a><span class="sep">|</span>{chips}</nav>'
        top.append('<section id="uebersicht"><h2>Uebersicht: Ampel pro Flug und Bereich</h2>'
                   + matrix_html([(fid, sh, F) for fid, sh, m, F in ok]) + "</section>")
        worst = {}
        for fid, sh, m, F in ok:
            for f in F:
                if f["sev"] in ("warn", "hint"):
                    worst.setdefault((f["area"], f["title"]), []).append(f["sev"])
        if worst:
            lst = []
            for (a, t), lst_s in sorted(worst.items(), key=lambda kv: (-kv[1].count("warn"), -len(kv[1]))):
                nw = lst_s.count("warn")
                lst.append(f'<div class="find {"warn" if nw else "hint"}"><b>{esc(a)}: {esc(t)}</b>'
                           f'<p>in {len(lst_s)} von {len(ok)} Fluegen ({nw}x Handlungsbedarf)</p></div>')
            top.append("<section><h2>Was zuerst angehen?</h2>" + "".join(lst) + "</section>")
        if len(ok) > 1:
            cmp_html = compare_html(compare_rows([m for _, _, m, _ in ok], [fid for fid, _, _, _ in ok]))
            dis = plot_discharge([m for _, _, m, _ in ok])
            if dis:
                cmp_html += figure(dis, CAPTIONS["discharge"], "Entladekurven")
            top.append(f'<section id="vergleich"><h2>Vergleich aller Fluege</h2>{cmp_html}</section>')
        top.append("<section><h2>Einzelne Fluege</h2>" + "".join(sections) + "</section>")
    else:
        nav = ""
        top.append("".join(sections))
    foot = ("<p class='small'>Die Bewertungen basieren auf Richtwerten (THRESH im Skript) und sind keine Garantie. "
            "Aendere immer nur einen Parameter pro Flug und pruefe das Ergebnis im Vergleich.</p>")
    js = ("<script>function openHash(){var h=location.hash.slice(1);if(!h)return;var e=document.getElementById(h);if(!e)return;"
          "var d=e.tagName==='DETAILS'?e:e.closest('details');if(d)d.open=true;e.scrollIntoView();}"
          "window.addEventListener('hashchange',openHash);window.addEventListener('load',openHash);"
          "window.addEventListener('beforeprint',function(){document.querySelectorAll('details').forEach(function(d){d.open=true;});});</script>")
    return (f"<!doctype html><html lang='de'><head><meta charset='utf-8'><title>Rotorflight Log-Bericht</title>"
            f"<style>{CSS}</style></head><body>{nav}<div class='wrap'>{''.join(top)}{foot}</div>{js}</body></html>")


# --------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Rotorflight-Blackbox-Logs einfach auswerten")
    ap.add_argument("files", nargs="+", help=".bbl-Dateien (Wildcards ok)")
    ap.add_argument("-o", "--output", default="rf_report.html")
    ap.add_argument("--decoder", help="Pfad zu blackbox_decode(.exe)")
    ap.add_argument("--cells", type=int, help="Zellenzahl des Akkus (sonst aus der Startspannung geschaetzt)")
    ap.add_argument("--summary", action="store_true", help="keine Einzeldiagramme, nur Uebersicht/Vergleich")
    ap.add_argument("--no-open", action="store_true", help="Bericht nicht automatisch im Browser oeffnen")
    a = ap.parse_args()

    files = []
    for f in a.files:
        files += sorted(glob.glob(f)) or [f]
    files = [f for f in files if f.lower().endswith(".bbl")]
    if not files:
        sys.exit("Keine .bbl-Dateien gefunden.")
    dec = find_decoder(a.decoder)

    ms, dfs = [], []
    for f in files:
        print(f"Dekodiere {os.path.basename(f)} ...", flush=True)
        hdrs = parse_headers(f)
        for i, csv in enumerate(decode_bbl(f, dec)):
            df = load_csv(csv)
            if df["t"].iloc[-1] < 20:
                continue
            name = os.path.basename(f)[:-4] + (f" (Log {i + 1})" if len(hdrs) > 1 else "")
            hdr = hdrs[i] if i < len(hdrs) else {}
            print(f"  Analysiere {name} ...", flush=True)
            ms.append(analyze(df, hdr, name, a.cells)); dfs.append(df)
    if not ms:
        sys.exit("Keine auswertbaren Logs gefunden.")
    out = build_report(ms, dfs, a.summary)
    with open(a.output, "w", encoding="utf-8") as fh:
        fh.write(out)
    print(f"\nFertig: {os.path.abspath(a.output)}")
    if not a.no_open:
        webbrowser.open("file://" + os.path.abspath(a.output))


if __name__ == "__main__":
    main()
