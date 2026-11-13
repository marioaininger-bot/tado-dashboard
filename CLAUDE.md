# Hinweise für Claude

Persönliches Dashboard für Tado-Heizung, Panasonic-Klimaanlagen und Strom (Wiener Netze). Statisches Frontend (`index.html`, `strom.html`) auf GitHub Pages plus Cloudflare Worker `tado-dashboard-api` im Ordner `cloudflare/`. Live unter `tado.aininger.com`.

## README und Wiki aktuell halten (wichtig)

Die `README.md` ist die einzige Quelle für das interne Wiki (`marioaininger-bot/wiki`). Das Wiki zieht sie jede Nacht vom Branch `main`, schreibt sie aber nie selbst um. Veraltet die README, veraltet das Wiki.

**Passe die README im selben Commit an, wenn du Folgendes änderst:**

- **Worker-Routen** (`/api/...` in `cloudflare/tado-api.js`): neue, geänderte oder entfernte Endpunkte
- **Secrets oder Variablen** (`wrangler.toml`, `env.*` im Code): `DASHBOARD_KEY`, `PANASONIC_*`, `WN_*`, `ALLOWED_ORIGIN`, …
- **Externe Dienste oder Hosts** (Tado, Panasonic, Open-Meteo, Wiener Netze) und deren Login-Ablauf
- **KV-Schlüssel, Cron-Zeitplan** oder Speicherlogik (`runtime-log.js`, `ac-changes.js`)
- **Funktionen des Dashboards**, die in der README beschrieben sind
- **Domain, Deployment** oder Setup-Schritte

Bei **neuen Projekten, Workern oder Secrets** zusätzlich im Wiki-Repo ergänzen: `docs/architektur.md` und `docs/betrieb/accounts.md`.

## Regeln

- **Nie Geheimnisse in Dateien schreiben**, auch nicht in die README: nur den **Namen** eines Secrets nennen, nie den Wert. Secrets werden mit `wrangler secret put` gesetzt.
- Die README folgt dieser Gliederung: Zweck, auf einen Blick (Tabelle), Datenfluss, Secrets (nur Namen), Einrichtung/Deployment, Fallstricke. Das Diagramm in Mermaid.
- Free-Plan-Grenzen beachten: KV erlaubt 1000 Schreibzugriffe pro Tag, deshalb schreibt der Cron nur alle 5 Minuten.
- Tado und Panasonic Comfort Cloud sind **inoffizielle** Schnittstellen. Änderungen daran vorsichtig testen.
- `mockups/` enthält nur Design-Entwürfe, keinen Produktivcode.
- Sprache der Doku und der Oberfläche: Deutsch (Österreich).
