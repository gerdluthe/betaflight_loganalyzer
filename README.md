# Betaflight Log Analyzer

Das ist mein Betaflight Log Analyzer, siehe UEBERGABE.md.

Offline-Auswertung von Betaflight-Blackbox-Logs: Sprungantwort und PID-Empfehlungen, Propwash, Motoren, Akku, Vibration/Filter mit Frequenz-über-Gas-Karte, fertige CLI-Befehle. Läuft komplett lokal als eine HTML-Datei bzw. als App für Windows, macOS und Android.

Bauen: `python3 build.py` (siehe UEBERGABE.md).

## Apps bauen (GitHub Actions)
Jeder Push auf `main` baut Windows, macOS und Android (Reiter *Actions*, Artefakte). Ein Release mit allen Dateien entsteht beim Setzen eines Tags:

```
git tag v1.8.0
git push origin v1.8.0
```
