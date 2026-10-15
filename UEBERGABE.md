# Betaflight Log Analyzer - Uebergabe (Stand v1.7.0)
Offline-Auswertung von Betaflight-Blackbox-Logs (.bbl/.bfl) als einzelne HTML-Datei; Apps fuer Windows/macOS (Tauri 2) und Android (Capacitor).
Hervorgegangen aus dem Rotorflight Log Analyzer v1.5.1; ab v1.6.0 komplett auf Betaflight (Multicopter) umgestellt.

## Aufbau (src/)
- bbl.js: BBL-Parser (Nachbau blackbox_decode; inkl. GPS-Frames und BF-Events). Gegen blackbox_decode 0.4.3 geprueft: identische Werte.
- analysis.js: Kern. Flugphase (Motoren > 8 % ueber Leerlauf), Gas/Motoren in %, Akku (vbatLatest/amperageLatest in 0,01 V/A), Motor-Saettigung/Balance, eRPM,
  Regelabweichung, Ruhephasen-Spektrum, Signal/RSSI. Header-Parameter je BF-Version (PMAP: 4.2-Namen und 4.3+-Namen), Simplified Tuning.
  Ungefiltertes Gyro: gyroUnfilt[] (ab 4.3, wenn geloggt) oder debug[0..2] bei debug_mode=6 GYRO_SCALED (mit Plausibilitaetspruefung).
  Fehlt setpoint (BF 3.x), wird es aus rcCommand + Rates nachgerechnet.
- stepresp.js: Sprungantwort je Achse (Wiener-Dekonvolution Soll->Gyro wie PID-Analyzer, 25-Hz-Grenze), Ueberschwingen/t50/t90/Nachschwingen, PID-Empfehlungen (p_/i_/d_/d_min_/f_ bzw. simplified_*-Schieber).
- propwash.js: Gas-Ruecknahmen finden, Regelabweichung Roll/Nick 10-90 Hz danach vs. ruhiger Flug; Empfehlungen D/D-Min, dyn_idle_min_rpm.
- vibration.js: Welch-Spektren roh/gefiltert, Frequenz ueber Gas, Spitzen (feste Resonanz / drehzahlabhaengig / Motorfrequenz / Regelkreis < 40 Hz), D-Term- und Motor-Rauschen, Filter-CLI je Version.
- findings.js: Befunde Motoren/Akku/Regelung/Ruhephasen/Signal + Empfehlungen aus Tracking/Ruhephasen.
- plotdata.js, worker_main.js (Worker-Pipeline, Empfehlungen dedupliziert), charts.js, figures.js, ui.js, style.css, logo.svg.

## Bauen / Testen
- python3 build.py -> dist_index.html, kopiert nach bf_tauri/www/index.html und setzt die Version in package.json, tauri.conf.json, Cargo.toml, android-app/package.json. Nur Python-Standardbibliothek.
- Versionsregel: jede Aenderung -> naechste Minor (1.7.0, 1.8.0 ...), nur VERSION oben in build.py aendern.
- Tests: shot.py <log> <breite> <tag> (Playwright-Screenshots je Reiter nach shots/).
- Release: Tag vX.Y.Z pushen (GitHub Actions in bf_tauri/.github).

## Aenderungen
- v1.7.0: Abgebrochene Aufzeichnungen erkennen (keine Ende-Markierung, Rest der Datei leer) und erklaeren; kurze Fluege (1-10 s) eingeschraenkt auswerten statt abweisen; neue Versionsnummern (Betaflight 2026.x, d_max, motor_idle) getestet.

## Getestete Logs
Betaflight 3.1.5, 4.2.0-4.2.11, 4.3.0, 2026.6.2 (gyroUnfilt im Log, 2 kHz) (1 kHz, 500 Hz, 250 Hz, 8 kHz). INAV/Rotorflight werden erkannt und abgewiesen bzw. als "kein Flug" gemeldet.
Noch ohne echtes Test-Log: BF 4.4-4.6 mit gyroUnfilt/eRPM-Feldern (nach Doku implementiert), d_max-Benennung ab 4.6.

## Offene Ideen
- Feedforward-Analyse (axisF), I-Term-Windup, Anti-Gravity.
- Vergleich zweier Logs (vorher/nachher).
