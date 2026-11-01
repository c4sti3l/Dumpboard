# Share Inbox

Ein zentraler „Mülleimer“ für alles, was du dir selbst schicken willst. Unter Android erscheint die PWA im Teilen-Menü; am PC fügst du per Strg+V, Drag & Drop oder Dateiauswahl ein. Alles landet auf **deinem Server** und ist auf allen Geräten sofort sichtbar (Live-Update).

- Links, Text, Bilder (Vorschau), PDFs und beliebige Dateien
- Volltextsuche über Titel, Text, URLs und Dateinamen, dazu Filter nach Typ
- Link-Vorschau mit Bild, Favicon, Site-Name, Titel und Beschreibung. Sie erscheint schon beim Einfügen einer URL in die Eingabeleiste (ohne Enter). Der Server holt die Seite, Vorschauen werden gecacht und sind mit durchsuchbar.
- Datei-Icons nach Typ (PDF, Office, Archive, Code …), Video und Audio direkt abspielbar, PDFs mit „Öffnen“
- Dark Mode, mobil zuerst
- Passwortschutz (ein gemeinsames Passwort)
- Offline-Warteschlange: Was ohne Netz geteilt wird, wird später automatisch hochgeladen
- Android-Eigenheit: URLs, die in `text` oder `title` stehen, werden per Regex erkannt und als Link angezeigt
- Keine Abhängigkeiten: Node-Server (nur Standardbibliothek) + Vanilla JS

## Aufbau

```
server/server.js   Node-Server: statische App + API, Daten auf Platte
public/            App (Manifest, Service Worker, UI)
scripts/make-icons.js   PNG-Icons neu erzeugen
Dockerfile, docker-compose.yml, .env.example
```

Daten liegen in `DATA_DIR` (Standard `./data`, im Container `/data`): `items.json` plus ein Ordner `files/`.

## Konfiguration (Umgebungsvariablen)

| Variable | Bedeutung | Standard |
|---|---|---|
| `ACCESS_TOKEN` | Passwort für die App. **Ohne Wert ist alles offen!** | leer |
| `DATA_DIR` | Speicherort | `./data` |
| `PORT` | Port | `8080` |
| `MAX_UPLOAD_MB` | Maximale Dateigröße | `500` |

## Lokal starten

```bash
ACCESS_TOKEN=meinpasswort node server/server.js     # http://localhost:8080
```

(Windows PowerShell: `$env:ACCESS_TOKEN="meinpasswort"; node server/server.js`)

`localhost` zählt als sicherer Kontext, dort läuft auch der Service Worker.

## Docker

```bash
cp .env.example .env        # ACCESS_TOKEN setzen
docker compose up -d --build   # http://localhost:8080
```

Die Daten liegen im Volume `inbox_data` und überleben Updates (`docker compose up -d --build`). Backup: Volume sichern oder `/data` mounten (`./daten:/data`).

Mit automatischem HTTPS (Let's Encrypt über Caddy), wenn die Domain auf den Server zeigt und Port 80/443 offen sind:

```bash
# in .env: DOMAIN=inbox.example.com
docker compose --profile https up -d --build
```

Hinter einem eigenen Reverse Proxy (Traefik, nginx Proxy Manager …) leitest du die Domain auf Container-Port 8080 und lässt den Proxy TLS terminieren. Der Proxy darf Antworten für `/api/events` nicht puffern (Live-Updates, der Server sendet dafür `X-Accel-Buffering: no`) und muss große Uploads erlauben (z. B. nginx: `client_max_body_size 0;`).

## HTTPS ist Pflicht (Handy)

Android installiert PWAs und erlaubt Service Worker nur über HTTPS. Optionen:

| Variante | Geeignet? |
|---|---|
| Eigene Domain/Subdomain mit Docker + Caddy (Profil `https`) | Ja, empfohlen |
| Lokaler HTTPS-Tunnel zum Testen (`cloudflared tunnel --url http://localhost:8080` oder `ngrok http 8080`) | Ja, zum Ausprobieren |
| GitHub Pages | **Nein**, es gibt dort keinen Server für die API |

Die App muss **am Root eines Hosts** liegen (`start_url` und `scope` sind `/`, die Share-Action ist `/share-target`). Ein Unterpfad wie `example.com/inbox/` passt nicht.

## Testanleitung Android

**Installieren**: Seite in Chrome öffnen, anmelden, Menü (⋮) → *App installieren*.

**Aus der Galerie teilen**: Foto wählen → Teilen → *Share Inbox*. Erwartet: Eintrag *Bild* mit Vorschau, Name, Größe und Download.

**Aus Chrome teilen**: Seite öffnen → Menü → Teilen → *Share Inbox*. Erwartet: Seitentitel plus klickbarer Link (kommt meist aus `text`) und Link-Karte mit Domain.

**Aus dem Dateimanager teilen**: PDF oder Datei wählen → Teilen. Erwartet: *Datei* mit Name, Größe, Typ und Download.

**Text teilen**: Text markieren → Teilen. Erwartet: *Text*, bei enthaltener URL zusätzlich *Link*.

**Zwischen Geräten**: Am PC etwas einfügen und es erscheint am Handy ohne Neuladen (und umgekehrt). Im Flugmodus teilen: Der Eintrag zeigt „Wartet auf Upload“ und geht hoch, sobald wieder Netz da ist.

> Erscheint *Share Inbox* nicht im Teilen-Menü, ist die App noch nicht als PWA installiert oder das Manifest hat sich geändert.

## Nach Manifest-Änderungen

Android liest `share_target`, Icons, Name usw. **nur bei der Installation**. Nach jeder Änderung am Manifest: App **deinstallieren** (lange auf das Icon drücken), Seite in Chrome neu laden und **neu installieren**. Änderungen an `app.js`, CSS oder Server kommen dagegen automatisch an; erhöhe dafür `CACHE` in `public/sw.js`, damit der Precache erneuert wird.

## Sicherheit und Grenzen

- Ein gemeinsames Passwort, kein Mehrbenutzerbetrieb. Das Anmelde-Cookie ist `HttpOnly` und `SameSite=Strict`, hinter HTTPS zusätzlich `Secure`. Nutze ein langes Passwort; Fehlversuche werden verzögert, aber nicht gesperrt.
- Hochgeladene Dateien werden nur als Bild, Video, Audio oder PDF inline ausgeliefert. Alles andere (z. B. HTML) gibt es nur als Download, damit hochgeladene Dateien keinen Code in der App ausführen.
- Die Link-Vorschau ruft Webseiten vom Server aus ab. Adressen im internen Netz (localhost, 192.168.x.x, 10.x.x.x, Cloud-Metadaten …) sind gesperrt, auch nach Weiterleitungen. Vorschaubilder laufen über den Server und werden nur als echte Rasterbilder ausgeliefert (kein SVG). Manche Seiten (z. B. reine JavaScript-Apps oder solche mit Bot-Schutz) liefern keine Metadaten; dann bleibt die einfache Link-Karte.
- Dateien sind unverschlüsselt auf dem Server gespeichert. Wer Zugriff auf den Server hat, kann sie lesen.
- Offline zeigt die App die zuletzt gesehene Liste (ohne Dateiinhalte); neue Einträge werden hochgeladen, sobald wieder Netz da ist.
- Den Server nicht ohne `ACCESS_TOKEN` ins Internet stellen.
