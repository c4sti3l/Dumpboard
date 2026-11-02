# Dumpboard

[![Docker image](https://github.com/c4sti3l/Dumpboard/actions/workflows/docker.yml/badge.svg)](https://github.com/c4sti3l/Dumpboard/actions/workflows/docker.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**One big self-hosted clipboard for all your devices.**

Share a link, a text, a photo or any file from your Android phone straight into Dumpboard, paste a screenshot from your PC, and find it all again on every device, searchable and with rich link previews. No account, no cloud, no dependencies: a single small Node.js server and a PWA.

> Think "notes to self" meets "WeTransfer to myself", but on your own server.

## Features

- **Android share target**: after installing the PWA, *Dumpboard* shows up in the system share sheet (Chrome). Text, links, images, PDFs and arbitrary files are accepted.
- **Desktop input like a chat**: type, paste with <kbd>Ctrl</kbd>+<kbd>V</kbd> (screenshots and copied files too), drag & drop, or use the file picker.
- **Rich link previews**: title, description, image, favicon and site name, shown as soon as you paste a URL (no Enter needed). Fetched and cached by the server.
- **Full-text search** across titles, text, URLs, file names and the titles and descriptions of linked pages, plus filters for links, text, images and files.
- **Instant sync**: every device sees new entries live (Server-Sent Events).
- **Offline queue**: things shared without a connection are stored locally and uploaded automatically later.
- **Android quirk handled**: Android often puts the shared URL into `text` (sometimes `title`) and leaves `url` empty. Dumpboard extracts URLs with a regex and treats them as links.
- **Previews for everything**: image thumbnails with lightbox, inline video and audio players, colored file-type icons, PDF open button.
- **Modern UI**: mobile-first, dark mode, installable and works offline (app shell is precached).
- **Simple and private**: one shared password, files stored on your disk, zero npm dependencies.

The user interface is currently in German.

## Quick start

### Docker with the prebuilt image (recommended)

A GitHub Action builds a multi-arch image (`linux/amd64` and `linux/arm64`, so it also runs on a Raspberry Pi or ARM NAS) and publishes it to the GitHub Container Registry:

```
ghcr.io/c4sti3l/dumpboard:latest
```

Other tags: `1.2.3` and `1.2` for releases (git tag `v1.2.3`), and `sha-<commit>` for every build of `main`.

One-liner:

```bash
docker run -d --name dumpboard --restart unless-stopped \
  -p 8080:8080 \
  -e ACCESS_TOKEN='change-me-to-a-long-password' \
  -v dumpboard_data:/data \
  ghcr.io/c4sti3l/dumpboard:latest
```

Or as a stack. Save this as `docker-compose.yml`, set your password, then run `docker compose up -d`:

```yaml
services:
  dumpboard:
    image: ghcr.io/c4sti3l/dumpboard:latest
    container_name: dumpboard
    restart: unless-stopped
    environment:
      # Password: set ACCESS_TOKEN or DISABLE_AUTH (one of the two is required).
      ACCESS_TOKEN: change-me-to-a-long-password   # sign-in password, use a long one
      # DISABLE_AUTH: "true"                        # no password at all (trusted network only; remove ACCESS_TOKEN)

      # Optional (defaults shown):
      MAX_UPLOAD_MB: "500"                          # maximum size per file
      # PORT: "8080"                                # port inside the container, adjust "ports" below if you change it
      # DATA_DIR: /data                             # storage path inside the container, must match the volume below
    ports:
      - "8080:8080"            # host:container
    volumes:
      - dumpboard_data:/data   # entries, files, preview cache (or ./data:/data for direct access)

volumes:
  dumpboard_data:
```

Open <http://localhost:8080> and sign in. Data lives in the volume `dumpboard_data` and survives updates. The container runs as the unprivileged user `node` (uid 1000); if you use a bind mount like `./data:/data` instead of a named volume, make that folder writable for it: `sudo chown -R 1000:1000 ./data`. Update with `docker compose pull && docker compose up -d`.

#### Example stacks with HTTPS

The stack above is plain HTTP, which is fine on your own network. For your phone you need HTTPS, see [HTTPS and installing on Android](#https-and-installing-on-android). Ready-made stacks:

| File | Use it when |
|---|---|
| [`examples/docker-compose.yml`](examples/docker-compose.yml) | Same as the stack above (also fine as a Portainer / Dockge / Unraid stack) |
| [`examples/docker-compose.caddy.yml`](examples/docker-compose.caddy.yml) | You have a domain and want automatic HTTPS with zero config (Caddy + Let's Encrypt) |
| [`examples/docker-compose.traefik.yml`](examples/docker-compose.traefik.yml) | You already run Traefik |

> **Publishing the image (maintainers):** the first push creates the package as *private*. In GitHub, open the package → *Package settings* → *Change visibility* → *Public*, so others can pull it without logging in. The workflow in [`.github/workflows/docker.yml`](.github/workflows/docker.yml) runs a syntax check and a smoke test on every push and pull request, and only pushes images from `main` and `v*` tags.

### Build it yourself

```bash
git clone https://github.com/c4sti3l/Dumpboard.git && cd dumpboard
cp .env.example .env          # set ACCESS_TOKEN to a long password
docker compose up -d --build
```

The `docker-compose.yml` in the repository root builds from the local source.

### Without Docker

Requires Node.js 14 or newer, no `npm install` needed.

```bash
ACCESS_TOKEN=my-long-password node server/server.js
```

PowerShell: `$env:ACCESS_TOKEN="my-long-password"; node server/server.js`

Without a password (trusted network only): `DISABLE_AUTH=true node server/server.js`

## Configuration

All settings are environment variables:

| Variable | Description | Default |
|---|---|---|
| `ACCESS_TOKEN` | Password for the app. When set, a sign-in is required. | none |
| `DISABLE_AUTH` | `true` runs the app **without any password**. Only honored when `ACCESS_TOKEN` is empty. | `false` |
| `DATA_DIR` | Where entries, files and the preview cache are stored | `./data` (`/data` in Docker) |
| `PORT` | HTTP port | `8080` |
| `MAX_UPLOAD_MB` | Maximum size per file | `500` |
| `DOMAIN` | Only for the HTTPS profile (Caddy), see below | none |

**Password or no password: you choose, explicitly.** The server refuses to start unless you set either `ACCESS_TOKEN` (password required) or `DISABLE_AUTH=true` (no password, no login screen). This prevents an instance from being left open by accident. If both are set, the password wins.

Use `DISABLE_AUTH=true` only where everyone who can reach the server is trusted, for example on your home network or behind a VPN or an authenticating reverse proxy.

With a password, sign-ins are valid for **7 days**, then the password is requested again. Changing `ACCESS_TOKEN` signs out all devices.

## HTTPS and installing on Android

Chrome only installs PWAs and runs service workers over **HTTPS** (except on `localhost`). Pick one:

**1. Your own domain with automatic certificates (Caddy)**

Easiest with the prebuilt image: use [`examples/docker-compose.caddy.yml`](examples/docker-compose.caddy.yml) (or [`examples/docker-compose.traefik.yml`](examples/docker-compose.traefik.yml) if you already run Traefik). When building from source, point a (sub)domain at your server, open ports 80 and 443, then:

```bash
# .env
DOMAIN=dumpboard.example.com

docker compose --profile https up -d --build
```

**2. Behind your existing reverse proxy** (Traefik, nginx Proxy Manager, ...): forward the domain to container port `8080` and let the proxy terminate TLS. The proxy must not buffer `/api/events` (live updates; the server already sends `X-Accel-Buffering: no`) and must allow large uploads (nginx: `client_max_body_size 0;`).

**3. Quick test with a tunnel**

```bash
cloudflared tunnel --url http://localhost:8080   # or: ngrok http 8080
```

> The app must be served from the **root of a host** (`start_url` and `scope` are `/`, the share action is `/share-target`). A sub-path like `example.com/dumpboard/` does not work. Static hosts such as GitHub Pages are not suitable either, because there is no server for the API.

### Install and test on Android

1. Open your HTTPS URL in Chrome, sign in, then menu (⋮) → **Install app**.
2. Share from other apps:

| From | What to do | What should arrive |
|---|---|---|
| Gallery | Select a photo, Share → *Dumpboard* | Image entry with thumbnail, name, size, download |
| Chrome | Menu → Share → *Dumpboard* | Page title plus a clickable link with a rich preview |
| File manager | Select a PDF or any file, Share → *Dumpboard* | File entry with name, size, type and download |
| Any app | Select text, Share → *Dumpboard* | Text entry; URLs inside become links |

3. Try airplane mode: the entry shows *waiting for upload* and is sent as soon as you are online again.

> **After changing `manifest.webmanifest`** (name, icons, `share_target`, ...) you must **uninstall and reinstall** the app. Android reads the manifest only at installation time. Changes to JS, CSS or the server arrive automatically; bump `CACHE` in `public/sw.js` so the precache refreshes.

If *Dumpboard* does not appear in the share sheet, the PWA is not installed yet (use *Install app*, not just a shortcut) or the manifest changed since installation.

## How it works

```
Android share sheet ──POST /share-target──▶ Service worker ──▶ Server API ──▶ disk
Desktop (paste, drop) ───────────────────────────────────────▶ Server API ──▶ disk
                                                                 │
        every open device  ◀──── Server-Sent Events (/api/events)┘
```

- The service worker intercepts the multipart `POST` to `/share-target`, uploads title, text, URL and files to the server and answers with a `303` redirect to `/?shared=1`. If the upload fails (offline, signed out), the entry is kept in IndexedDB and uploaded later by the page.
- The server stores entries in `items.json` and files under `files/` in `DATA_DIR`. Uploads are streamed to disk, so large files do not use memory. Entries appear in the list only after all their files have arrived.
- Link previews are fetched server-side (browsers cannot, because of CORS), parsed for Open Graph / Twitter / `<title>` metadata and cached for a week. Preview images are proxied through the server.

### Project layout

```
server/server.js        HTTP server, API, uploads, link previews, auth (no dependencies)
public/                 the PWA
  index.html, style.css, app.js
  api.js, db.js         API client and IndexedDB outbox (shared with the service worker)
  sw.js                 share target, precache, offline
  manifest.webmanifest
scripts/make-icons.js   regenerates the PNG icons (no dependencies)
Dockerfile, docker-compose.yml, .env.example
examples/               ready-to-use stacks (basic, Caddy, Traefik) for the prebuilt image
.github/workflows/      Docker build, smoke test and publish to GHCR
```

### API

All endpoints except the static files, `/api/session` and `/api/login` require authentication (cookie, or `Authorization: Bearer <ACCESS_TOKEN>` for scripts), unless the server runs with `DISABLE_AUTH=true`.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/login` | `{ "token": "..." }` sets the session cookie |
| `GET` | `/api/session` | `{ required, auth }` |
| `GET` | `/api/items` | List entries, newest first |
| `POST` | `/api/items` | Create an entry (JSON: `title`, `text`, `url`, `files[]` metadata), returns file IDs |
| `PUT` | `/api/files/:id` | Upload the raw bytes of one file |
| `GET` | `/api/files/:id` | Download or stream a file (supports `Range`); `?download=1` forces download |
| `DELETE` | `/api/items/:id` | Delete one entry |
| `DELETE` | `/api/items` | Delete everything |
| `GET` | `/api/events` | Server-Sent Events stream (`changed`) |
| `GET` | `/api/preview?url=` | Link preview metadata |
| `GET` | `/api/proxy?u=` | Proxied preview image (raster formats only) |

Example, sending a note from a shell:

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
     -d '{"text":"remember https://example.com"}' http://localhost:8080/api/items
```

## Security notes

- **Always set `ACCESS_TOKEN`** before exposing the server to the internet, and serve it over HTTPS. With `DISABLE_AUTH=true` anyone who can reach the server can read, upload and delete everything, and the server can be made to fetch URLs for link previews. The session cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` behind HTTPS. Failed logins are delayed but not locked out, so use a long password.
- It is a single-password, single-user design. There are no accounts.
- Files are stored **unencrypted** on the server's disk.
- Uploaded files are only served inline when they are images, video, audio or PDF; everything else (including HTML) is sent as a download with `nosniff` and a sandboxing CSP, so uploads cannot run code in the app's origin.
- Link previews make the server request third-party URLs. Private and internal addresses (localhost, RFC 1918 ranges, link-local and cloud metadata addresses, IPv6 equivalents) are blocked, including after redirects and DNS resolution. Preview images are only delivered if they really are raster images (no SVG).

## Development

```bash
node server/server.js          # starts on http://localhost:8080
node scripts/make-icons.js     # regenerate public/icons/*
```

There is no build step. Edit files in `public/` and reload; the service worker serves cached files first, so use *Application → Service Workers → Update on reload* in the Chrome dev tools while developing the front end.

## License

[MIT](LICENSE)
