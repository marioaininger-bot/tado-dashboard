# Tado Dashboard

Persönliches Dashboard für Tado-Heizkörper (und später die Panasonic-Klimaanlage,
sobald sie über Tados "Smart AC Control" eingebunden ist). Zeigt alle Zonen mit
Ist-/Solltemperatur, Luftfeuchte, Heiz-/Kühlleistung, offenen Fenstern und
Außentemperatur – inklusive Verlauf (alle 5 Minuten, 24h Historie) pro Zone.
Die Kachel zeigt die letzten 3 Messpunkte, ein Klick auf die Kachel öffnet
einen Tages-Chart für Temperatur und Luftfeuchte. Zonen, die trotz aktivem
Heizen/Kühlen seit ≥30 Minuten keine Bewegung Richtung Zieltemperatur zeigen,
bekommen zusätzlich einen Warnhinweis ("Reagiert nicht wie erwartet"). Pro
Zone gibt's außerdem eine grobe Betriebsstunden-Schätzung ("X,Xh aktiv") aus
der aufgezeichneten Heiz-/Kühlleistung – keine echte kWh-/Kostenangabe, da
Tado keine Wattzahlen oder Strompreise liefert.

Architektur wie bei [bedtimestory](https://github.com/marioaininger-bot/bedtimestory):
statisches Frontend (`index.html`, gehostet via GitHub Pages) + ein Cloudflare
Worker als Proxy zur Tado-API. Der Worker übernimmt den Login (OAuth2
Device-Code-Flow) und verwaltet die Tokens in Cloudflare KV – im Browser landet
nie ein Tado-Passwort oder Access-Token.

⚠️ Tado hat keine offizielle öffentliche API. Die hier verwendeten Endpunkte
(`my.tado.com/api/v2/...`, `login.tado.com/oauth2/...`) sind seit Jahren stabil
und werden auch von Community-Projekten wie der Home-Assistant-Integration
genutzt, könnten sich aber theoretisch ohne Vorankündigung ändern.

## Setup

### 1. Cloudflare Worker deployen

```bash
cd cloudflare
npm install -g wrangler   # falls noch nicht vorhanden
wrangler login

# KV-Namespace für die Tokens anlegen
wrangler kv namespace create TADO_KV
# -> die zurückgegebene "id" in wrangler.toml bei [[kv_namespaces]] eintragen

wrangler deploy
```

Der Worker legt dabei auch einen Cron-Trigger an (alle 5 Minuten, siehe
`[triggers]` in `wrangler.toml`), der unabhängig vom geöffneten Dashboard
Temperatur, Luftfeuchte und Leistung je Zone in derselben KV-Namespace
aufzeichnet – Basis für Verlauf, Tages-Chart und Betriebsstunden-Schätzung.
Direkt nach dem ersten Deploy dauert es bis zu ~10 Minuten, bis genug
Messpunkte vorliegen. Kürzere Heiz-Tests (unter 5 Minuten) können trotzdem
zwischen zwei Aufzeichnungen durchrutschen und in der Betriebsstunden-
Schätzung fehlen - die aktuelle Heizleistung in der Kachel ist davon nicht
betroffen, die kommt live bei jedem Laden.

Nach dem Deploy ist der Worker unter
`https://tado-dashboard-api.<deine-subdomain>.workers.dev` erreichbar.

Optional: `ALLOWED_ORIGIN` in `wrangler.toml` auf deine GitHub-Pages-URL setzen
(z. B. `https://marioaininger-bot.github.io`), damit nur dein Dashboard die
API aufrufen darf.

### 2. Frontend konfigurieren

In `index.html` die Konstante `API_ENDPOINT` auf deine Worker-URL setzen.

### 3. GitHub Pages aktivieren

Repo-Settings → Pages → Branch `main`, Root-Verzeichnis. Optional eigene
Domain per `CNAME`-Datei.

### 4. Einloggen

Dashboard öffnen → „Verbinden“ klicken → Code auf der Tado-Seite bestätigen.
Danach bleibt die Verbindung bestehen (Token wird automatisch erneuert), bis
du dich aktiv abmeldest.

## Klimaanlage (Panasonic via Tado Smart AC Control)

Die Klimaanlage ist in Tado ein eigenes „Zuhause“ (neben dem tado-X-Zuhause
mit den Heizkörpern). Der Worker liest deshalb alle Homes des Accounts
(`/me` → `homes`) und zeigt die Zonen der weiteren Homes (Zonen-Typ
`AIR_CONDITIONING`, im Frontend `AC`) als Kacheln neben den Räumen an –
inklusive Modus (Kühlen/Heizen/…), Verlauf und Betriebsstunden. Direktes
Die Kachel bietet Temperatur ±1°, Ein/Aus und „Zeitplan“ (Modus und
Lüfterstufe bleiben erhalten; per Overlay-Endpunkt, bitte am echten Gerät
verifizieren).

## Weitere Klimaanlagen (Panasonic Comfort Cloud)

Panasonic-Geräte, die in der App „Panasonic Comfort Cloud“ eingerichtet sind,
lassen sich direkt einbinden – ohne Tado-Modul. Der Worker meldet sich dafür
mit deinem Comfort-Cloud-Login an (inoffizielle API, Ablauf wie in der App /
der Bibliothek `python-panasonic-comfort-cloud`). Die Zugangsdaten liegen nur
als Worker-Secrets, nie im Repo:

```bash
cd cloudflare
wrangler secret put PANASONIC_USER   # E-Mail der Comfort-Cloud-App
wrangler secret put PANASONIC_PASS
wrangler deploy
```

Jedes Gerät erscheint als Kachel mit Ist-/Zieltemperatur und Modus, plus
Temperatur ±1°, Ein/Aus. Panasonic liefert keine Verdichter-Leistung, daher
gibt es dort keinen Leistungsbalken und keine Betriebsstunden-Schätzung.
Schlägt der Login fehl (z. B. falsches Passwort), pausiert der Worker 30
Minuten, damit dein Panasonic-Konto nicht gesperrt wird; die Meldung steht
unter den Kacheln. Optional kann `PANASONIC_APP_VERSION` als Variable gesetzt
werden, falls Panasonic eine neuere App-Version verlangt.
