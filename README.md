# HM Moodle Connector

Ein MCP-Server als Cloudflare Worker, mit dem Claude (claude.ai, Desktop, Mobile) lesend auf das Moodle der Hochschule München zugreifen kann. Er kann Kurse auflisten, den Inhalt eines Kurses anzeigen, Dateien und Seiten lesen und anstehende Abgaben zeigen. Schreiben, Abgeben oder Posten kann er nicht.

## Wie er an Moodle kommt

Die HM hat den Moodle Mobile Web Service abgeschaltet, ein API-Token gibt es also nicht. Der Connector benutzt stattdessen deine Browser-Session: Du gibst ihm einmal das Cookie `MoodleSession`, er speichert es in Cloudflare KV und ruft damit dieselben internen Endpunkte auf wie die Moodle-Weboberfläche. Alle 10 Minuten pingt er Moodle an (`core_session_touch`), damit die Session nicht wegen Inaktivität verfällt.

Die Session wird trotzdem irgendwann ungültig, etwa wenn du dich im Browser bei Moodle abmeldest oder Moodle neu startet. Dann meldet Claude, dass die Session abgelaufen ist, und du trägst auf der Setup-Seite ein neues Cookie ein. Neu deployen musst du dafür nicht.

## Tools

| Tool | Zweck |
|---|---|
| `list_courses` | eingeschriebene Kurse (laufend, alle, vergangen, zukünftig, Favoriten) |
| `get_course_contents` | Abschnitte und Aktivitäten eines Kurses mit URLs |
| `open_url` | beliebige Moodle-URL als Text lesen: Dateien (PDF, DOCX, PPTX, XLSX, ODF, Text, Bilder), Seiten, Foren, Aufgaben, Ordner |
| `get_file` | Datei als Datei holen: Download-Link (24 h gültig) zum Öffnen, Speichern und Drucken, PDFs bis 10 MB zusätzlich direkt angehängt |
| `upcoming_deadlines` | Abgaben und Termine aus der Zeitleiste, optional pro Kurs |
| `session_status` | prüft, ob das gespeicherte Cookie noch gilt |

## Passwortgeschützte PDFs

Manche Skripte sind mit einem Passwort verschlüsselt oder gegen Drucken gesperrt. Gib Claude das Passwort im Chat mit („Hol mir das Skript, Passwort ist …“). `get_file` und `open_url` entschlüsseln die Datei damit. Der Download-Link liefert danach ein PDF ohne Passwort und ohne Druck- oder Kopiersperre. PDFs, die nur eine Drucksperre und kein Öffnen-Passwort haben, werden automatisch freigeschaltet.

## Download-Links

Die Links von `get_file` sehen so aus: `https://moodle-connector.xuller4000.workers.dev/dl/<zufälliger Code>/<Dateiname>`. Sie funktionieren ohne das Connector-Secret und ohne Moodle-Login, aber nur 24 Stunden lang. Danach löscht Cloudflare die zwischengespeicherte Datei. Wer den Link in der Zeit hat, kann die Datei öffnen, also nicht weitergeben, wenn das Material nicht geteilt werden soll.

## Einrichtung

### 1. Cloudflare

1. Account auf cloudflare.com anlegen.
2. Im Dashboard einmal **Workers & Pages** öffnen und eine `workers.dev`-Subdomain wählen (hier `xuller4000`). Der Worker ist später unter `https://moodle-connector.xuller4000.workers.dev` erreichbar.
3. **Account-ID** kopieren (steht rechts auf der Workers-Übersicht oder unter *Account home*).
4. API-Token anlegen: *My Profile → API Tokens → Create Token →* Vorlage **Edit Cloudflare Workers**, als Account den eigenen wählen, Zone-Ressourcen auf *All zones* lassen. Token kopieren.

### 2. GitHub Secrets

Im Repo unter *Settings → Secrets and variables → Actions → New repository secret* drei Secrets anlegen:

| Name | Wert |
|---|---|
| `CLOUDFLARE_API_TOKEN` | das Token aus Schritt 1.4 |
| `CLOUDFLARE_ACCOUNT_ID` | die Account-ID aus Schritt 1.3 |
| `CONNECTOR_SECRET` | eine zufällige Zeichenkette aus Buchstaben und Ziffern, mindestens 32 Zeichen, z. B. von `openssl rand -hex 24` |

Das `CONNECTOR_SECRET` ist Teil der Connector-URL und schützt den Zugang. Wer die URL kennt, kann dein Moodle lesen. Also nicht teilen.

Danach unter *Actions → Deploy to Cloudflare → Run workflow* den ersten Deploy starten (jeder Push auf `main` deployt danach automatisch).

### 3. Cookie hinterlegen

1. Im Browser bei https://moodle.hm.edu anmelden.
2. Entwicklertools öffnen (F12), unter *Speicher* (Firefox) bzw. *Application → Cookies* (Chrome) bei `https://moodle.hm.edu` den Wert von `MoodleSession` kopieren.
3. `https://moodle-connector.xuller4000.workers.dev/<CONNECTOR_SECRET>/setup` öffnen, Wert einfügen, *Speichern und prüfen*.
4. Den Moodle-Tab einfach schließen, **nicht abmelden**. Abmelden macht die Session sofort ungültig.

### 4. In Claude einbinden

claude.ai → *Einstellungen → Connectors → Custom Connector hinzufügen*:

- Name: `HM Moodle`
- URL: `https://moodle-connector.xuller4000.workers.dev/<CONNECTOR_SECRET>/mcp`

OAuth-Felder leer lassen. Danach steht der Connector auch in der Desktop- und Mobile-App zur Verfügung.

## Cookie automatisch übertragen (Edge-Erweiterung)

Im Ordner `extension/` liegt eine Erweiterung für Microsoft Edge (geht genauso in Chrome). Sie liest das `MoodleSession`-Cookie von moodle.hm.edu und schickt es an den Connector, sobald du dich in Edge bei Moodle anmeldest. Alle 15 Minuten prüft sie zusätzlich, ob der Connector noch eine gültige Session hat. Der Connector speichert ein Cookie nur, wenn Moodle bestätigt, dass es angemeldet ist. Ein abgelaufenes oder nicht angemeldetes Cookie überschreibt also nie eine funktionierende Session.

Installation:

1. Den Ordner `extension` auf den Rechner kopieren und an einem festen Ort ablegen, z. B. `Dokumente\HM-Moodle-Cookie-Sync`. Nicht löschen, Edge lädt die Erweiterung von dort.
2. In Edge `edge://extensions` öffnen.
3. Links unten **Entwicklermodus** einschalten.
4. **Entpackte Erweiterung laden** klicken und den Ordner auswählen.
5. Auf das Puzzle-Symbol in der Symbolleiste klicken und **HM Moodle Cookie-Sync** anheften.
6. Auf das Symbol klicken, die Setup-Adresse des Connectors einfügen und **Speichern** klicken.
7. In Edge bei https://moodle.hm.edu anmelden. Nach ein paar Sekunden zeigt das Popup „Cookie übertragen“.

Das Symbol zeigt ein rotes „!“, wenn die Connector-Session abgelaufen ist. Dann reicht es, dich in Edge neu bei Moodle anzumelden. Nicht auf „Abmelden“ klicken, Tab einfach schließen.

## Grenzen

- Im kostenlosen Cloudflare-Plan darf ein Aufruf nur 10 ms Rechenzeit verbrauchen (Wartezeit auf Moodle zählt nicht). Kurslisten und Seiten passen da locker rein. Große PDFs oder Foliensätze in Text umzuwandeln kann das Limit sprengen, dann kommt ein Fehler. Abhilfe ist der Workers-Paid-Plan für 5 USD im Monat.
- Eingescannte PDFs ohne Textebene liefern keinen Text.
- Dateien über 30 MB lädt der Connector nicht, Download-Links gibt es bis 25 MB.
- Große verschlüsselte PDFs zu entschlüsseln kostet Rechenzeit und stößt im kostenlosen Plan schneller an das 10-ms-Limit als normale Downloads.
- Täglich zwischen 7 und 8 Uhr ist das HM-Moodle wegen Updates offline.

## Lokal entwickeln

```sh
npm install
echo 'CONNECTOR_SECRET=local-dev-secret-0123456789abcdef' > .dev.vars
npm run dev
```

Setup-Seite dann unter `http://localhost:8787/local-dev-secret-0123456789abcdef/setup`.
