Betaflight Log Analyzer - Windows + macOS (Tauri 2) + Android (Capacitor)
====================================================
Eigenstaendige App ohne Server, Python oder Decoder: die Auswertung laeuft komplett in der App (WebView2 unter Windows, WebKit unter macOS).

Bauen ueber GitHub: Inhalt dieses Ordners per git pushen (der versteckte Ordner .github muss mit).
 - Jeder Push auf main baut beide Systeme (Actions > "Build Windows + macOS", Artifacts).
 - Ein Release entsteht beim Setzen eines Tags:   git tag v1.3.0 ; git push origin v1.3.0
   Dateien im Release: BFLogAnalyzer-portable.exe, BFLogAnalyzer-Setup.exe (Windows), BFLogAnalyzer-macOS.dmg (Mac), BFLogAnalyzer.apk (Android)

macOS-Hinweis: die App ist nicht von Apple notarisiert. Nach dem Herunterladen im Terminal einmal ausfuehren:
   xattr -cr /Applications/"Betaflight Log Analyzer.app"
oder per Rechtsklick > Oeffnen starten (bei neueren macOS: Systemeinstellungen > Datenschutz & Sicherheit > "Trotzdem oeffnen").

Lokal bauen: Node 18+, Rust (rustup), dann  npm install ; npx tauri icon icon.png ; npx tauri build

Android: Der Ordner android-app enthaelt nur die Capacitor-Konfiguration; die Web-App www/index.html wird im Workflow automatisch hineinkopiert (eine einzige Quelle fuer alle Plattformen).
