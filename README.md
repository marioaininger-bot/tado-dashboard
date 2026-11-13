# Tado Dashboard

Persönliches Dashboard für Tado-Heizkörper (und später die Panasonic-Klimaanlage,
sobald sie über Tados "Smart AC Control" eingebunden ist). Zeigt alle Zonen mit
Ist-/Solltemperatur, Luftfeuchte, Heiz-/Kühlleistung, offenen Fenstern und
Außentemperatur – inklusive Verlauf (alle 5 Minuten, 24h Historie) pro Zone.
Das Dashboard ist als helles Kachel-Layout (Bento-Stil) aufgebaut: oben eine
Begrüßung mit Kurzstatus (Räume heizen, Klima an, Hinweise), eine Außen-Kachel
mit Wetter und Stunden-Vorschau sowie Kacheln für Ø Innentemperatur und Ø
Luftfeuchte, darunter den Bereich „Klima“ (eine
Zeile mit Schalter je Klimaanlage, „Alle aus/an“) und den Bereich „Heizung“ (mit „Alle aus“ und „↺ Alle auf Zeitplan“, das alle manuell übersteuerten oder ausgeschalteten Räume zurück in den Zeitplan setzt; erscheint nur bei Abweichungen, auch als Hinweis in der Begrüßung; zusätzlich öffnet sich beim Laden und bei neuen Abweichungen ein Popup mit den betroffenen Räumen, je Raum mit „Zeitplan“ und „Später“ – „Später“ pausiert den Raum 4 Stunden)
mit kompakten Raum-Kacheln, die sich per Umschalter (Zifferblätter [Standard] / Kacheln / Thermo) als Thermostat-Zifferblätter oder als „Thermografie“-Kacheln darstellen lassen (Thermo: große Temperaturzahl, Kachelfarbe und Wärmeglühen nach Raumtemperatur, dazu oben eine gemeinsame Wärmeskala aller Räume) – auch die Klimaanlagen, dort färbt der Modus den Bogen (Bogen = Ist, Strich = Soll; hell oder dunkel – gilt für Zifferblätter und Thermo; die Auswahl wird im Browser gemerkt). Ein Klick auf eine Kachel oder Klima-Zeile öffnet
ein Fenster: bei Räumen der Tages-Chart für Temperatur und Luftfeuchte plus
eine Tabelle der letzten 2 Stunden (alle 15 Min.), bei Klimaanlagen zusätzlich
die volle Steuerung (Modus, Lüfter, Eco, Richtung). Zonen, die trotz aktivem
Heizen/Kühlen seit ≥30 Minuten keine Bewegung Richtung Zieltemperatur zeigen,
bekommen zusätzlich einen Warnhinweis ("Reagiert nicht wie erwartet"). Pro
Zone gibt's außerdem eine grobe Betriebsstunden-Schätzung ("X,Xh aktiv") aus
der aufgezeichneten Heiz-/Kühlleistung – keine echte kWh-/Kostenangabe, da
Tado keine Wattzahlen oder Strompreise liefert.

Hinter der Seite läuft ein dezenter animierter Hintergrund je nach Tageszeit
und Wetter (Sonnenaufgang, Sonne, Bewölkung, Regen, Schnee, Sonnenuntergang,
Nacht mit Sternen und Mond). Die Szene ergibt sich aus der Uhrzeit (Sonnenauf-
und -untergang werden für Österreich näherungsweise berechnet) und dem
Wetterzustand von Tado. Zum Ausprobieren lässt sie sich per URL erzwingen, z. B.
`?scene=rain` (Werte: `sunrise`, `day`, `cloudy`, `rain`, `snow`, `wintersun`,
`sunset`, `night`). Der Wind (km/h, aus den Tado-Wetterdaten) verstärkt die
Szenen: schnellere Wolken, schräger Regen, wehender Schnee, ab ca. 20 km/h
Windlinien und ab ca. 30 km/h wirbelnde Blätter; zum Ausprobieren z. B.
`?scene=rain&wind=45`. Bei aktivierter Systemeinstellung „Bewegung reduzieren" gibt
es nur ein statisches Bild, im Hintergrund-Tab pausiert die Animation.

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

### 2b. Zugriffsschutz (DASHBOARD_KEY)

Der Worker hält den Tado-/Panasonic-Login für alle, die ihn aufrufen. Damit
nicht jeder, der die Adresse kennt, deine Räume sieht oder steuert, verlangt
jeder `/api/`-Aufruf einen geheimen Schlüssel (Header `X-Dashboard-Key`). Das
Dashboard fragt beim ersten Öffnen einmal danach und merkt ihn sich im
Browser (localStorage). Ohne gesetztes Secret lehnt der Worker alles ab.

```bash
cd cloudflare
# Schlüssel erzeugen (PowerShell), mind. 24 Zeichen:
#   -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 32 | % {[char]$_})
wrangler secret put DASHBOARD_KEY
wrangler deploy
```

Schlüssel ändern: `wrangler secret put DASHBOARD_KEY` erneut ausführen; die
Dashboards fragen danach neu. Den Schlüssel gut aufbewahren (Passwort-Manager).
Der Cron-Trigger ist nicht betroffen.

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

Panasonic verlangt beim Login einen Bestätigungscode (Zwei-Faktor). Der
Worker meldet sich deshalb nie von selbst an: Im Dashboard erscheint unter den
Kacheln „Bei Panasonic anmelden“. Ein Klick startet den Login mit den Secrets,
danach gibst du einmal den Bestätigungscode ein (Authenticator-App bzw. wie
von Panasonic angezeigt). Danach hält ein Refresh-Token die Verbindung, bis
Panasonic sie widerruft - dann erscheint der Knopf wieder.

Jedes Gerät erscheint als Kachel mit Ist-/Zieltemperatur und Modus, plus
Temperatur ±1°, Ein/Aus sowie Auswahlfeldern für Modus (Auto/Kühlen/Heizen/
Entfeuchten/Lüften), Lüfterstufe, Eco (Auto/Leise/Turbo), nanoe™ X (Aus/An, nur bei Geräten mit nanoe) und - sofern das Gerät sie meldet -
Luftrichtung senkrecht/waagrecht - nur bei
eingeschaltetem Gerät; das Dashboard schaltet nie von selbst ein. „Einschalten“ startet im Modus
Kühlen mit der Zieltemperatur aus `PANASONIC_DEFAULT_TEMP` (`wrangler.toml`,
Standard 20). Tados
Smart-AC-Zonen werden nicht mehr angezeigt (die Klimaanlagen laufen über
Panasonic). Panasonic liefert keine Verdichter-Leistung, daher
gibt es dort keinen Leistungsbalken und keine Betriebsstunden-Schätzung.
Fehler stehen mit Panasonics Originalmeldung unter den Kacheln. Optional kann
`PANASONIC_APP_VERSION` als Variable gesetzt werden, falls Panasonic eine
neuere App-Version verlangt.

## Stromverbrauch (Wiener Netze Smart Meter)

Der Worker enthält die Anbindung an die offizielle Smart-Meter-API der Wiener
Netze (`cloudflare/smartmeter.js`), damit sich der echte Stromverbrauch der
Wohnung später mit den Tado-Laufzeiten abgleichen lässt. Die Anbindung ist
ausgeliefert, **nutzbar sobald die vier Secrets gesetzt sind**. Die Seite
`strom.html` zeigt dann automatisch echte Werte (bis dahin Beispieldaten):

1. Anwendung für die `WN_SMART_METER_API` im
   [Developer-Portal](https://api-portal.wienerstadtwerke.at/) anlegen und
   freigeben lassen (liefert den API-Key).
2. Den Smart-Meter-Support (`support.sm-portal@wienit.at`) bitten, die
   Anwendung mit dem Smart-Meter-Portal-Zugang zu verbinden (hat gedauert:
   6.10. bis 12.11.2026). Danach stehen Client-ID und Client-Secret im
   [Business-Portal unter Einstellungen](https://smartmeter-business.wienernetze.at/einstellungen).
3. Die vier Secrets setzen (siehe `cloudflare/wrangler.toml`; der Login läuft
   über den logwien-Token-Endpunkt
   `log.wien/auth/realms/logwien/protocol/openid-connect/token`, optional per
   Variable `WN_TOKEN_URL` überschreibbar; der API-Key steht im WSTW-API-Portal):
   `WN_CLIENT_ID`, `WN_CLIENT_SECRET`, `WN_API_KEY`, `WN_ZAEHLPUNKT`.

Die Seite `strom.html` zeigt, alles aus den Viertelstundenwerten der letzten
30 Tage (ein Abruf von `/api/strom/quarter-hours`) und, falls vorhanden, den
Laufzeiten der Klimaanlagen (`/api/klima/laufzeit`, fehlt sie, bleibt die Seite
trotzdem benutzbar):

- vier Kennzahlen: letzter Tag, Durchschnitt pro Tag, Kosten, Grundlast nachts
  (Median der Leistung zwischen 2 und 5 Uhr)
- **Tagesverlauf**: Leistung in kW über einen Tag, je Viertelstunde (92 bis 100
  Werte bei Zeitumstellung). Beim Öffnen steht der letzte vollständige Tag
  da; ein Klick auf einen Tagesbalken wechselt den Tag. Darstellung als Linie
  oder Balken umschaltbar (die Wahl merkt sich der Browser), die Grundlast ist
  gestrichelt eingezeichnet. Darunter steht je Klimaanlage ein Streifen, wann sie
  Strom brauchte (Stundenraster, kräftiger = mehr kWh in der Stunde; ohne
  Panasonic-Daten nach Betriebsminuten aus `/api/klima/laufzeit`). So lassen sich
  Strom-Spitzen den Anlagen zuordnen. Vor dem `since` des Protokolls gibt es keine
  Streifen
- Kachel **Klima heute**: je Klimaanlage der **gemessene** Stromverbrauch seit
  Mitternacht in kWh (aus `/api/klima/verbrauch`, Panasonic-Messwerte inklusive
  Standby), dazu Ø pro Tag samt Kosten, gestern, Betriebszeit heute (aus
  `/api/klima/laufzeit`) und Standby in Watt. Die Werte sind wenige Minuten bis
  eine halbe Stunde verzögert; die Kachel nennt den Stand. Ohne Panasonic-Daten
  (Route fehlt, nichts abgeholt) fällt die Seite auf den Betrieb nach Laufzeit
  zurück: Betriebszeit und eine **Schätzung** der Leistung per Regression im
  Browser (Verbrauch je Stunde = typischer Wert der Uhrzeit + Leistung der
  Anlage × Minuten, erst ab 7 Tagen Protokoll, sonst „noch nicht erkennbar“).
  Ohne beide Quellen bleibt die Kachel ausgeblendet
- Tagesbalken für 7, 14 oder 30 Tage, geteilt in Grundlast (schwarz), aktiven
  Verbrauch (blau, am Wochenende orange) und die Klimaanlage (grün, oben). Der
  grüne Teil ist der Panasonic-Messwert über dem Standby (`STANDBY_KWH_H`, rund
  4 W; der Standby steckt schon in der Grundlast) und wird aus dem aktiven Teil
  herausgerechnet, nicht zusätzlich gezeichnet. Für Tage ohne Panasonic-Daten
  gilt der Rückfall: Betriebsminuten × geschätzte Leistung, sonst die Annahme
  `AC_ASSUMED_KW` (0,8 kW im Betrieb, in `strom.html`), dann **schraffiert**.
  Legende, Titel und Hover-Text nennen jeweils die Quelle („gemessen“,
  „geschätzt“, „angenommen“). Vor Beginn des Protokolls gibt es keinen grünen Teil
- Durchschnitt je Wochentag und die Kostenrechnung (Tarif im Kopf der Datei)
- **CSV-Download** für den gewählten Zeitraum (7, 14 oder 30 Tage), direkt im
  Browser erzeugt, ohne zusätzlichen Abruf. Zwei Dateien: die Liste aller
  Viertelstunden (Datum, Uhrzeit, Wochentag, kW, kWh, dazu je Klimaanlage die
  gemessenen kWh der jeweiligen Stunde, ohne Panasonic-Daten die Minuten, die
  sie lief) und eine Tabelle Uhrzeit
  mal Tag mit Durchschnitt und Maximum je Uhrzeit, um wiederkehrende
  Verbraucher zu finden. Semikolon, Dezimalkomma und UTF-8 mit BOM, damit
  Excel sie direkt öffnet. Uhrzeiten in Wiener Zeit

Mit `?demo` in der Adresse zeigt die Seite Beispieldaten.

Endpunkte (alle mit `X-Dashboard-Key`, nur GET):

| Pfad | Inhalt |
| --- | --- |
| `/api/strom/status` | `configured` und die Liste fehlender Secrets |
| `/api/strom/anlage` | Stammdaten des Zählpunkts |
| `/api/strom/daily?von=JJJJ-MM-TT&bis=JJJJ-MM-TT` | Tageswerte (max. 366 Tage) |
| `/api/strom/quarter-hours?von=…&bis=…` | Viertelstundenwerte (max. 31 Tage) |
| `/api/strom/readings?von=…&bis=…` | Zählerstände (max. 366 Tage) |

Ohne `von`/`bis` werden die letzten 7 Tage geliefert. Die Daten stehen beim
Netzbetreiber erst am Folgetag bereit und müssen im Smart-Meter-Portal für
Viertelstundenwerte freigeschaltet sein. Antworten werden 15 Minuten in KV
gecacht (höchstens 96 Schreibzugriffe pro Tag und Abfrage; das Dashboard
fragt je Seitenaufruf nur eine Abfrage-Variante ab, der Cron nutzt den Cache
nicht). Je Zählwerk (`obis`) kommt eine Liste mit `from`, `to`, `value`,
`kwh` (aus Wh/kWh umgerechnet, sonst `null`) und `quality`. Die genaue Einheit
und die OBIS-Codes sind nach dem ersten echten Abruf zu prüfen.

## Laufzeit-Protokoll der Klimaanlagen

Der normale Verlauf (`zone_history`) hält nur 24 Stunden und kennt bei
Panasonic keine Leistung. Für den späteren Abgleich mit dem echten
Stromverbrauch führt der Cron-Trigger zusätzlich ein dauerhaftes Protokoll
(`cloudflare/runtime-log.js`, KV-Schlüssel `runtime_log`): je Anlage, Tag
(Wiener Zeit) und Stunde, wie viele 5-Minuten-Messungen sie eingeschaltet war,
getrennt nach Modus (Kühlen, Heizen, Entfeuchten, Lüften, Auto). Es wird nur
geschrieben, wenn eine Anlage läuft (schont das KV-Schreiblimit), 400 Tage
werden aufbewahrt.

`GET /api/klima/laufzeit?von=JJJJ-MM-TT&bis=JJJJ-MM-TT` (mit `X-Dashboard-Key`)
liefert je Anlage und Tag die Minuten insgesamt, je Stunde (`byHour`) und je
Modus. Tage ohne Eintrag heißen „aus“, gelten aber erst ab `since` (Tag, an dem
das Protokoll angelegt wurde). Fällt eine Cron-Messung aus, zählt die Zeit als
„aus“; die Werte sind also eine Untergrenze. Tados Heizkörper-Zonen werden
nicht protokolliert.

`GET /api/klima/geraete?datum=JJJJ-MM-TT` (mit `X-Dashboard-Key`, nur lesend,
ohne Datum gestern) ist ein **Diagnose-Abruf**: Je Klimaanlage liefert er die
Modell-Hinweise aus Geräteliste und Status (nur Feldnamen und einfache Werte,
nie IDs oder Anmeldedaten) und den Verlaufs-Abruf `deviceHistoryData` der
Comfort-Cloud für diesen Tag. So lässt sich prüfen, ob Panasonic echte
Verbrauchswerte (kWh) liefert. Das ist nur bei Modellen mit Energiemessung der
Fall. Die Seite `geraete.html` ruft ihn mit dem gespeicherten Zugangsschlüssel
auf und zeigt das Ergebnis. Der Abruf läuft nur auf Anfrage, nicht im Cron, und
schreibt nichts nach KV. Pro Aufruf sind es 1 + 2 Anfragen je Gerät an
Panasonic (Free-Plan: höchstens 50 pro Aufruf).

## Stromverbrauch der Klimaanlagen (Panasonic-Messwerte)

Die Panasonic-Geräte mit Energiemessung (`powerConsumptionFlg`, bei diesem
Haushalt alle drei: CS-TZ42CKEW und zweimal CS-TZ20CKEW) liefern über die
Comfort-Cloud den Verbrauch je Tag und Stunde in kWh (`deviceHistoryData`,
`dataMode` 0, inoffiziell). `-255` heißt dort „kein Wert“ (z. B. vor der
Registrierung des Geräts). Der Cron-Trigger holt die Werte in kleinen Portionen
und legt sie dauerhaft in KV ab (`cloudflare/ac-energy.js`, Schlüssel
`ac_energy`, 400 Tage). Das Dashboard liest nur aus KV, nie direkt von Panasonic.

- Je Lauf höchstens 3 Tage, je Gerät eine Anfrage (bei 3 Geräten also 10
  Anfragen mit der Geräteliste; zusammen mit Tado und Status bleibt der Lauf
  unter dem Free-Plan-Limit von 50 Subrequests).
- Reihenfolge: heute (höchstens alle 30 Minuten neu), gestern (nach 3 Uhr
  früh noch einmal, damit die letzte Stunde stimmt), dann rückwärts bis 60 Tage,
  was noch fehlt. Das Auffüllen dauert beim ersten Mal rund 20 Läufe
  (etwa 100 Minuten).
- Geschrieben wird nur, wenn etwas geholt wurde: rund 50 KV-Schreibzugriffe pro
  Tag zusätzlich (Limit im Free-Plan: 1000 pro Tag). Panasonic wird nicht
  dauernd abgefragt, das ist bei einer inoffiziellen Schnittstelle wichtig.
- Fehlt die Panasonic-Anmeldung, bleibt der Abgleich still stehen (wie die
  anderen Cron-Schritte); nach dem Login macht er weiter.

`GET /api/klima/verbrauch?von=JJJJ-MM-TT&bis=JJJJ-MM-TT` (mit `X-Dashboard-Key`)
liefert je Anlage und Tag `kwh` (Summe der bekannten Stunden), `hoursKnown`,
`byHour` (24 Werte, `null` = unbekannt) und `fetchedAt`. Ohne Daten ist `zones`
leer. `strom.html` nutzt das für Kachel, Tagesbalken, Tagesverlauf und CSV.

## Änderungs-Protokoll der Klimaanlagen

Zusätzlich hält der Cron-Trigger fest, *wann* sich Ein/Aus, Modus,
Solltemperatur, Lüfterstufe oder Eco-Modus einer Anlage geändert haben
(`cloudflare/ac-changes.js`, KV-Schlüssel `ac_changes`, die letzten 500
Änderungen). Geschrieben wird nur bei einer Änderung. Jeder Eintrag nennt
außerdem die Herkunft: `dashboard` (Befehl über dieses Dashboard, wird kurz
gemerkt) oder `extern` (Panasonic-App, Timer, Fernbedienung, Smart-Home-
Routine - Panasonic liefert dazu selbst keine Angabe).

`GET /api/klima/aenderungen?zone=wohnzimmer&limit=20` (mit `X-Dashboard-Key`)
liefert die neuesten Änderungen zuerst, je Eintrag `t`, `name`, `source` und
`changes` (z. B. `{"targetTemp": [20, 27]}`). `t` ist der Zeitpunkt der
Erkennung; die Änderung geschah in den davor liegenden 5 Minuten. Der erste
Lauf nach dem Deploy legt nur den Ausgangszustand an, Änderungen davor sind
nicht rekonstruierbar.

