# RDPm — RDP Manager

Browser-based RDP access to your AWS EC2 (and custom) machines, streamed to the
browser via [Apache Guacamole](https://guacamole.apache.org/). Manage many
Windows instances from one page: start/stop EC2, connect several at once in a
grid, share the clipboard across sessions, and see your month-to-date AWS spend.

## How it works

```
Browser (React SPA)  ──WebSocket──►  Backend (Express + guacamole-lite)  ──►  guacd (Docker)  ──RDP──►  EC2 / Windows host
        │                                     │
        └── REST /api/* ─────────────────────►┴── AWS SDK (EC2 list/start/stop, password, Cost Explorer), optional SSM tunnel
```

- **frontend/** — React 19 + Vite + Tailwind single-page app. Built to `frontend/dist`.
- **backend/** — Node/TypeScript Express server. Proxies the Guacamole WebSocket
  to `guacd`, exposes the REST API, and serves the built SPA. Stores custom
  (non-EC2) connections in a local SQLite file (`backend/rdpm.sqlite`).
- **guacd** — the Guacamole daemon, run as a Docker container, that actually
  speaks RDP. Listens on `127.0.0.1:4822` (hard-coded in `backend/src/index.ts`).

## Prerequisites

- **Node.js 18+** and npm.
- **Docker** (to run `guacd`).
- **An AWS account** and credentials with the permissions below. Provided via
  `backend/.env`, `~/.aws/credentials`, or an instance role (SDK default chain).
- **AWS CLI + Session Manager plugin** — only if you set `USE_SSM_TUNNEL=true`
  (to reach private instances without opening 3389).

> **macOS host?** Everything below works as-is. Install the prerequisites with
> Homebrew: `brew install node`, `brew install --cask docker` (Docker Desktop),
> and — for the optional SSM tunnel — `brew install awscli session-manager-plugin`.
> Start Docker Desktop before running the `docker run` command.

### Required IAM permissions

| Feature | Actions |
|---|---|
| List / start / stop instances | `ec2:DescribeInstances`, `ec2:StartInstances`, `ec2:StopInstances` |
| Auto-fetch Windows password | `ec2:GetPasswordData` |
| Month-to-date bill (Settings modal) | `ce:GetCostAndUsage` |
| SSM tunnel (optional) | `ssm:StartSession` on `AWS-StartPortForwardingSession`; instances need the SSM agent + a role |

## Setup

1. **Clone and install**
   ```bash
   git clone <this-repo> rdpm && cd rdpm
   npm install
   (cd backend && npm install)
   (cd frontend && npm install)
   ```

2. **Start guacd**
   ```bash
   docker run -d --name guacd --restart unless-stopped -p 4822:4822 guacamole/guacd
   ```
   > Optional — larger clipboard: the stock image caps the clipboard at 256 KiB.
   > See [Bigger clipboard limit](#bigger-clipboard-limit-optional) to build an
   > image with a higher cap.

   The Settings modal shows whether guacd is reachable and can start, stop, or
   restart it — it runs `docker <action> guacd`, so the account running the
   backend needs Docker access (i.e. be in the `docker` group). Running guacd as
   a systemd unit instead? Set `GUACD_SERVICE_CMD="sudo -n systemctl"` in
   `backend/.env` and add a passwordless sudoers rule for those three commands.
   Set `GUACD_SERVICE=` (blank) to remove the buttons. Note that anyone who can
   reach the UI can use them — the app has no authentication of its own.

3. **Configure the backend**
   ```bash
   cp backend/.env.example backend/.env
   # then edit backend/.env — at minimum set GUAC_CRYPT_KEY (exactly 32 chars)
   # and your AWS credentials/region.
   ```
   Optionally drop your EC2 key pair's private key at **`backend/key.pem`**. When
   present, the backend decrypts each Windows instance's password automatically
   (`ec2:GetPasswordData` + RSA). Without it, it falls back to `RDP_PASSWORD`.

4. **Build the frontend**
   ```bash
   (cd frontend && npm run build)   # outputs frontend/dist
   ```

5. **Run the server** (serves the API *and* the built SPA)
   ```bash
   npm run start:backend            # listens on PORT (default 3010)
   ```

## Accessing the app

**No reverse proxy is required.** The SPA is built with a relative base and
derives its API/WebSocket URLs from wherever the page is served, so it works both
standalone and behind a path-stripping proxy — the same build, unchanged.

### Standalone (simplest)

After step 5, just open the backend directly:

```
http://localhost:3010/          # or http://<this-host-ip>:3010/
```

That's the whole deployment. To keep it running, use your process manager of
choice (`systemd`, `pm2`, `docker`, …) to run `npm run start:backend`.

> **HTTPS & the clipboard.** The browser [Clipboard API][clipboard-api] only
> works in a *secure context* — HTTPS, or `http://localhost`. Over a plain-HTTP
> **LAN IP** (`http://192.168.x.x:3010/`) device ↔ session copy/paste silently
> no-ops (session-to-session still works, over the WebSocket). Two options:
>
> - **Built-in TLS** — set `TLS_CERT` and `TLS_KEY` in `backend/.env` to a cert +
>   key and the server speaks HTTPS/WSS directly (no proxy). Generate a
>   self-signed pair (or use [mkcert](https://github.com/FiloSottile/mkcert) for
>   one your machines trust):
>   ```bash
>   openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
>     -keyout backend/tls.key -out backend/tls.crt \
>     -subj "/CN=$(hostname -I | awk '{print $1}')"
>   ```
>   Then open `https://<host>:3010/`. Browsers warn on a self-signed cert but
>   still grant secure-context status once you accept it.
> - Or just use `http://localhost:3010/` on the same machine.

### Behind a reverse proxy (optional)

To host it at a path alongside other apps, point a proxy at the backend and strip
the prefix. Example nginx serving it at `/rdpm/` over HTTPS:

```nginx
server {
    listen 443 ssl;
    server_name your-host;
    ssl_certificate     /etc/ssl/certs/your-host.crt;   # or a Let's Encrypt cert
    ssl_certificate_key /etc/ssl/private/your-host.key;

    location /rdpm/ {
        proxy_pass http://127.0.0.1:3010/;   # trailing slash strips the /rdpm prefix
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # required for the WebSocket
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

The relative asset/API/WS paths resolve correctly through the stripped prefix, so
nothing in the build needs to know it's mounted at `/rdpm/`. Use
[Let's Encrypt](https://certbot.eff.org/) for a trusted cert on a public host.

> Pinning the API/WS to a fixed origin (e.g. a separate API host)? Set
> `VITE_API_URL` / `VITE_WS_URL` at build time to override the derived paths.

## Usage

- **Sidebar** lists EC2 instances (green dot = running) and any custom RDP hosts
  you add with the **+** button. Start/stop EC2 inline; **Connect** opens a session.
- **Layouts** (top-right): single, horizontal scroll, 2×2, 4×4 grid. Sessions
  render at a fixed 1920×1080 and fill each 16:9 pane.
- **Click a pane** to control it — the focused pane gets a **yellow** highlight,
  and keyboard input (including Ctrl/Alt combos) is routed only to that pane.
- **Clipboard** is shared across all open sessions and your device (text only).
  Copy in one session and it's immediately pastable in every other session; text
  copied on your device is picked up while the tab has focus (and the instant it
  regains focus), so it's already in place when you go to paste.
  > **HTTPS is required for *device* clipboard sync.** Reading/writing your local
  > clipboard uses the browser [Clipboard API][clipboard-api], which browsers
  > only expose in a *secure context* (HTTPS, or `http://localhost`). Over plain
  > HTTP on a LAN IP (e.g. `http://192.168.x.x/`) the copy-to-device / paste-from-device
  > direction silently no-ops — session-to-session clipboard still works because
  > that goes over the Guacamole WebSocket. See [Accessing the app](#accessing-the-app)
  > for the built-in TLS option.
  >
  > **Chromium-only for device→session.** Reading your clipboard needs the
  > `clipboard-read` permission, which only Chromium-based browsers expose;
  > Firefox and Safari raise a "Paste" confirmation on every read instead, so
  > that direction stays off there. Session→session and session→device are
  > unaffected.

[clipboard-api]: https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API
- **Settings** (gear) has global display options and your **month-to-date AWS spend**.

## Development

```bash
npm start          # runs backend + `vite dev` together (concurrently)
```
Because Vite's dev server doesn't proxy the API by default, point the frontend at
the backend during dev by setting `VITE_API_URL` / `VITE_WS_URL` (or add a
`server.proxy` entry to `vite.config.ts`). For most changes it's simplest to
`npm run build` and use `npm run start:backend`.

## Bigger clipboard limit (optional)

`guacd`'s clipboard size is a compile-time constant (`GUAC_COMMON_CLIPBOARD_MAX_LENGTH`,
256 KiB). To raise it, build a custom image from the matching guacamole-server
source:

```bash
curl -fsSL -o gs.tar.gz \
  https://github.com/apache/guacamole-server/archive/refs/tags/1.6.0.tar.gz
tar xzf gs.tar.gz && cd guacamole-server-1.6.0
# raise the cap (keep it well under the 8 MiB thread stack — the RDP copy path
# allocates a buffer of this size on the stack). 2 MiB is a safe, generous value.
# (`sed -i.bak` works on both GNU/Linux and macOS/BSD sed; it leaves a .bak file.)
sed -i.bak 's/#define GUAC_COMMON_CLIPBOARD_MAX_LENGTH .*/#define GUAC_COMMON_CLIPBOARD_MAX_LENGTH 2097152/' \
  src/common/common/clipboard.h
docker build -t guacamole/guacd:1.6.0-clip2m \
  --build-arg GUACAMOLE_SERVER_OPTS="--disable-guaclog --enable-allow-freerdp-snapshots CPPFLAGS=-Wno-error=deprecated-declarations" .
```
Then run that tag instead of `guacamole/guacd` in step 2.

## Notes & limitations

- **File copy/paste is not supported** — Guacamole's clipboard is text-only.
  Transferring files would need RDP drive redirection or SFTP plus an upload UI.
- **OS-reserved key combos** (Ctrl+Alt+Del, the Super/Win key, and on Linux hosts
  Ctrl+Alt+arrows / F-keys or DE shortcuts) are grabbed by *your* OS/window
  manager before the browser sees them, so they can't be forwarded from the
  physical keyboard.
- Secrets live in `backend/.env`, `backend/key.pem`, and `backend/rdpm.sqlite`
  (encrypted passwords) — keep them out of version control.
