# Betaflight Log Analyzer - Uebergabe (Stand v1.5.1)
Kopie des Rotorflight Log Analyzers (Stand v1.5.1) als eigenes Projekt.
- src/*.js: bbl.js (BBL-Parser), analysis.js, findings.js, vibration.js, govtune.js, plotdata.js, worker_main.js, charts.js, figures.js, ui.js
- build.py: baut dist_index.html (einzelne HTML, Version in VERSION oben). Danach nach bf_tauri/www/index.html kopieren.
- bf_tauri/: Tauri-2-Projekt + GitHub-Actions (Windows, macOS, Android, Release bei Tag vX.Y.Z)
- Versionsregel: v1.5.1 jetzt, jede Aenderung -> 1.6.0, 1.7.0 ... (VERSION in build.py + package.json, tauri.conf.json, Cargo.toml)
- Noch Rotorflight-spezifisch: Governor-Analyse, Governor-PID-Empfehlungen, RF-CLI-Parameter. Ziel: auf Betaflight umstellen (Filter, PID, D-Term, Motoren).
- Tests: shot.py <log.bbl> <breite> <tag> (Playwright-Screenshots je Tab).
