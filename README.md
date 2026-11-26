# ssPortal

A Dockerized, single-host application workspace for Grocy, webtrees, ssAcademy, and future HTTP applications. The portal includes passkey sign-in, user approval and administration, live availability, search, categories, per-user favorites, grid/list layouts, and seven themes with light, dark, and system modes.

## Architecture

**Use one container per application behind one reverse proxy.** A hostname is a routing concern, not a container boundary. Caddy forwards requests by path, preserving the original hostname and path prefix.

```text
Browser: https://localhost:4125
             |
  Caddy gateway              Only service with published ports
             |
             +-- /                 Preact frontend + Fastify API
             +-- /api/portal/       Portal API
             +-- /grocy/            Grocy: PHP 8.5 + Apache + SQLite
             |     +-- api/         Grocy's own authenticated API
             +-- /webtrees/         webtrees: PHP 8.5 + Apache
             +-- /ssacademy/        Collection data viewer + JSON API + SQLite
```

| Component | Choice | Reason |
| --- | --- | --- |
| Frontend | Preact, TypeScript, Vite | Small static bundle; no SSR server or frontend framework runtime needed |
| Portal backend | Fastify on Node.js 24 LTS | Passkey/session APIs, bounded health checks, static-file serving |
| Gateway | Caddy | HTTPS for every app, HTTP redirects, persistent local certificates or supplied certificates |
| Applications | Separate source-built images | Independent upgrades, restarts, dependencies, and persistent storage |
| Portal state | SQLite accounts/sessions; JSON app registry; browser preferences | Durable authentication without a separate database service |

Containers share the host kernel, so separating apps does not incur VM-sized overhead. The PHP apps reuse a common cached runtime layer. A single combined container would save a little process overhead but couple dependency versions, upgrades, failures, permissions, and scaling. It is not the recommended structure here. Actual resource use depends on the hosted apps and workload.

The portal does not iframe, rewrite, or fork Grocy or webtrees. Their own authentication and APIs remain intact. webtrees does not advertise a general REST API here; its native routes stay under `/webtrees/`. The included ssAcademy data server shares portal identities and provides its own scoped upload API and data viewer.

## Start

Requires Docker Desktop with Linux containers (or Docker Engine) and Docker Compose v2.24.4+. PHP, Composer, and Node do not need to be installed on the host for Docker operation.

The existing source checkouts must be present at `portal_apps/grocy/` and `portal_apps/webtrees/`. They are intentionally excluded from this repository's Git tracking. A fresh clone of the portal alone is not sufficient to build the app images. Keep the upstream applications' licenses with their source. This host-side directory layout does not change the public `/grocy/` and `/webtrees/` routes or the containers' data paths.

From this directory:

```powershell
docker compose up -d --build --wait --wait-timeout 180
```

For subsequent updates, run `.\update_docker.ps1` without arguments. It pulls Git changes with `--ff-only`, validates the Compose configuration, builds the application images, and starts the full stack with a 180-second readiness timeout without removing volumes. Use `.\update_docker.ps1 -NoPull` to rebuild local changes without pulling. The script works in Windows PowerShell 5.1 and PowerShell 7 and does not create or modify `.env`.

Trust the generated local CA as described under **HTTPS and Security**, then open the configured `PASSKEY_ORIGIN`. The defaults, with `PASSKEY_RP_ID` blank or set to `localhost`, are:

| Application | URL |
| --- | --- |
| Portal | https://localhost:4125/ |
| Grocy | https://localhost:4125/grocy/ |
| webtrees | https://localhost:4125/webtrees/ |
| ssAcademy | https://localhost:4125/ssacademy/ |

All applications use the **same HTTPS hostname and port**. HTTP on `WEB_API_PORT` redirects to that origin, preserving the path and query. Use one canonical hostname consistently, especially when completing webtrees setup. If an app was already installed under HTTP, update its configured public URL to HTTPS.

- Grocy creates its initial SQLite database automatically. Its upstream default login is `admin` / `admin`; change the password immediately.
- webtrees opens its setup wizard. SQLite is the lowest-overhead choice for a small personal installation; the image also includes PDO MySQL for a separately managed MySQL/MariaDB server. Set its base URL to the exact public URL ending in `/webtrees`, without a trailing slash.
- Availability means the application's HTTP endpoint responds, including a login redirect or setup wizard. It does not imply that installation is complete or that a user is logged in.
- New named volumes are used; existing data in the app checkouts is neither copied nor modified. Import existing data deliberately after backing it up.

The gateway binds to `127.0.0.1` by default. To choose ports or explicitly allow LAN access, copy `.envexample` to `.env` and set `WEB_API_PORT` (HTTP redirect), `HTTPS_WEB_PORT` (HTTPS), `PASSKEY_RP_ID` (hostname), and `DOCKER_BIND_ADDRESS`. Blank ports use 8080 and 4125; a blank hostname uses `localhost`. The two ports must differ. A bind address of `0.0.0.0` exposes the gateway to other machines; apply firewall rules and trust the certificate on those devices first. No app or Docker socket is exposed directly. Keep the hostname resolving to this server's reachable address using local DNS, a hosts entry, or correctly configured router forwarding; a public DNS name alone does not make a loopback listener reachable from another device.

These names replace `PORTAL_BIND`, `PORTAL_PORT`, and `PORTAL_HOST`, respectively with `DOCKER_BIND_ADDRESS`, `WEB_API_PORT`, and `PASSKEY_RP_ID`. `POSTGRES_PASSWORD` is reserved for integrations and is unused by this SQLite-based stack.

## Passkeys and Users

The account lifecycle follows ssMusic_Server: passkey registration, pending approval for new members, administrator/member roles, account renaming, multiple passkeys, revocation, and deletion. It intentionally does not import music-specific sharing roles, native-app OAuth flows, or ssMusic private access tokens.

### First Administrator

Choose the permanent public hostname **before enrolling passkeys**. The default is `https://localhost:4125`; use `localhost`, not `127.0.0.1`. Trust the local CA or supply a browser-trusted certificate. Passkeys are bound to their relying-party hostname and do not migrate to a new hostname automatically. A port change alone does not change the relying party, but the configured origin must match the browser's exact URL.

Generate a one-time setup code in your own terminal:

```powershell
docker compose exec portal node server/accounts.mjs setup
```

Open the configured portal address, enter a username and the server setup code, then create a passkey using your device or security key. The first successfully verified enrollment becomes the approved administrator. The setup code expires after 15 minutes; generating another replaces the previous code. The setup command refuses to run after an account exists. Codes are secrets: enter them directly into the portal, not chat, tickets, or shared logs.

This console-authorized step prevents a first visitor from claiming administrator access on an exposed installation. No default portal administrator or password is shipped.

### Account Lifecycle

- Later registrations are members with `pending` status. Their passkeys are saved, but no session or application access is granted until an administrator approves them in **Users**.
- **Account settings** supports renaming your account and adding/removing named passkeys. Register a backup passkey on another device. Removing the last passkey is blocked; removing another key signs out other sessions.
- **Users** supports search, access-state filtering, approval/revocation, role/name changes, session revocation, and account deletion. Users cannot revoke/delete themselves, and the last approved administrator cannot be demoted or revoked.
- Role/status changes invalidate existing sessions. Re-approving an account does not revive revoked sessions; the user must sign in again.
- Sessions use random, server-side-hashed tokens in HttpOnly, SameSite=Strict cookies. HTTPS enables the Secure flag. They expire after `SESSION_DAYS` (30 by default).
- Registration/login challenges are browser-bound, single-use, expire after five minutes, and require authenticator user verification. Mutation requests must match the configured origin; passkey endpoints are rate-limited.
- The dashboard/API and every request under `/grocy/` and `/webtrees/` require an approved portal session. All approved portal users have access to those launch paths, but the apps' native accounts and permissions still apply. This is a shared access gate, **not application-account SSO**.
- Grocy/webtrees native API keys alone do not bypass the gateway; their APIs also require a portal session cookie. ssAcademy separately supports approved device tokens for JSON uploads and downloading owned imports by ID, without granting access to the other apps or portal administration.
- Revocation blocks subsequent requests; it does not erase previously rendered browser content or terminate requests/streams already in flight.

### Recovery

An operator with Docker access can issue an account recovery code:

```powershell
docker compose exec portal node server/accounts.mjs recover "Your username"
```

Use **Recover account** on the sign-in screen and create a replacement passkey. Recovery codes expire after 15 minutes and are single-use. Successful recovery replaces all old passkeys and invalidates existing sessions. Recovery does not bypass a pending or revoked status; the account must be approved first. Operator/Docker access is therefore an administrative trust boundary. No recovery secret is stored in browser preferences.

### Authentication Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PASSKEY_ORIGIN` | `https://<PASSKEY_RP_ID or localhost>:<HTTPS_WEB_PORT or 4125>` | Exact public origin, including scheme and port; no path; leave blank to use the Compose default |
| `PASSKEY_RP_ID` | `localhost` for Docker's default origin | Certificate hostname; must equal the origin hostname; no scheme, port, path, or IP address |
| `ALLOW_REGISTRATION` | `true` | Set `false` to disable new-member registration; initial operator setup still works |
| `SESSION_DAYS` | `30` | Session lifetime, 1-90 days |
| `AUTH_DB_PATH` | `/app/data/auth.sqlite` in Docker | Internal database location in the portal data volume |

The HTTPS Compose override sets `PASSKEY_ORIGIN` to `https://<PASSKEY_RP_ID>`. When changing a local port, update an explicitly set `PASSKEY_ORIGIN` too. Set `PASSKEY_RP_ID` to the hostname when using a custom origin. A sign-in page opened at a different origin links to the configured address. A hostname change requires enrolling new passkeys at the new hostname, using operator recovery when necessary. Do not copy ssMusic's credentials into this database; they are bound to that application's relying party and user handles.

## ssAcademy Collections

Open ssAcademy from Applications to import and view collection data exported by the Android app. Parsed balances and animation identifiers are stored as database rows, not export files. Members see their own imports; administrators can choose **All users** and **Edit values** to adjust reward balances and animation IDs with revision checks.

For mobile syncs, the app identifies its registration using `student` and its private per-installation `fingerprintToken` at `POST /ssacademy/api/devices/register`. The student does not need a portal account. An administrator approves the request in **ssAcademy > Sync Tokens > App approvals**; the device receives a separate bearer secret once in its next status response, without administrator display or manual transfer. That secret authorizes uploads and `GET /ssacademy/api/imports/:id` downloads of owned imports for 90 days. The private identifier pair authorizes one-time credential delivery, not sync requests. Bearer authentication uses stored hashes; pending delivery uses a nonce and a private key stored beside the auth database, which must be included in backups. **Generate bearer token** replaces a lost or expired credential without changing ownership. Previously approved registrations need a new bearer secret; their registrations and imports are preserved. Accountless registrations have isolated import ownership; administrators can view their imports with **All users**.

The `ssAcademy-collections` version 1 sync payload contains rewards, collected animations, and an optional snapshot of game, reward, and appearance settings. It excludes practice history, reading progress, PINs, credentials, and device identity. Settings sync with the owned collection snapshot; legacy collection-only snapshots preserve local settings, and collection merges do not replace local settings. Import details show synced settings; administrator reward/animation edits preserve them. See [portal_apps/ssAcademy/README.md](portal_apps/ssAcademy/README.md) for the API request format, permissions, validation limits, and backup instructions.

## Themes

The portal follows the theme names and palettes from ssMusic_Server:

Midnight blue, Maize and blue, Royal purple, Gold, Green, Pink, and Black.

Appearance settings include Light, Dark, and System modes, app launch behavior, and automatic status refresh. Appearance is browser-local; favorites are scoped to each portal account in browser storage and synchronize between portal tabs. App launches are not recorded. Fonts and app icons are served locally. The **portal and ssAcademy viewer** share color themes and modes; either app's Appearance settings updates both. The independent Grocy/webtrees interfaces retain their native appearance settings.

## Development

### Docker Hot Reload

```powershell
docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait --wait-timeout 180
```

Continue using the same configured HTTPS URL (default https://localhost:4125). The gateway routes the portal through Vite, including its secure HMR WebSocket, and leaves app routes unchanged. Vite permits the explicitly configured public hostname; it does not allow arbitrary Host headers. Portal source is bind-mounted; Linux dependencies live in a separate named volume rather than using Windows `node_modules`. Polling is enabled for frontend file changes on Docker Desktop. The API uses Node's file watcher. Restart the portal after changing the app registry.

After changing portal dependencies:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml run --rm --no-deps portal npm ci
docker compose -f compose.yaml -f compose.dev.yaml restart portal
```

If the development dependency volume was created by an older root-running image, repair its ownership once before `npm ci`:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml run --rm --no-deps --user root --cap-add CHOWN portal chown -R node:node /app/node_modules
```

Development and production share the same authentication data volume and hostname, so existing passkeys continue to work. Use the same Compose override for console account commands when in development mode.

PHP source checkouts are built into their images, not bind-mounted in production or development. Rebuild only the app being edited. Return to the production build with:

```powershell
docker compose up -d --build --wait
```

### Host Node Development

Node.js 22.13+ is needed for this workflow and local tests; Node.js 24 LTS is recommended. For isolated portal UI development:

```powershell
npm --prefix portal ci
$env:PASSKEY_ORIGIN = 'http://localhost:5173'
npm --prefix portal run dev
```

Use http://localhost:5173, and generate the development setup code in a second terminal with `node portal/server/accounts.mjs setup`. The host server has its own ignored database in `portal/data/`, not the Docker database. `PORT` overrides the API port if 3000 is occupied; change `PASSKEY_ORIGIN` if Vite selects a different port. Set an app's `<ID>_HEALTH_URL` to an explicitly reachable private endpoint when testing outside Docker. Probing the protected public gateway without a session only confirms that its authentication gate responds, not that the app is ready.

For end-to-end app access, use the Docker hot-reload workflow. The isolated host database's sessions are intentionally not trusted by the Docker gateway. `APP_GATEWAY_URL` can change Vite's app proxy destination, but does not share account/session databases.

## Add an Application

Adding a catalog entry does **not** deploy an application. Complete these three steps:

1. Add an independent service to `compose.yaml`, attached to the `applications` network, with its own image/build, data volume, and health check. Do not publish a new port or add a fixed `container_name`.
2. Configure the app's public/base URL, API URLs, redirects, asset paths, WebSocket paths, and cookies for its prefix, then add a route to `deploy/Caddyfile` before the portal catch-all:

   ```caddyfile
   @notes_root path /notes
   redir @notes_root /notes/?{query} 308

   handle /notes/* {
     import portal_session
     reverse_proxy notes:3000
   }
   ```

3. Add an object to `portal/config/apps.json`:

   ```json
   {
     "id": "notes",
     "name": "Notes",
     "description": "Personal notes and shared documents.",
     "category": "Productivity",
     "path": "/notes/",
     "apiPath": "/notes/api/",
     "healthUrl": "http://notes:3000/notes/health",
     "icon": "folder",
     "color": "amber",
     "runtime": "Node.js",
     "source": "notes/"
   }
   ```

Use `null` for `apiPath` when the app has no separate API, and `null` for `healthUrl` to disable probes. Icons: `shopping-basket`, `network`, `app-window`, `music`, `folder`. Colors: `green`, `blue`, `pink`, `amber`. The registry allows up to 50 unique top-level app prefixes; `/api/` and `/assets/` are reserved. Internal health URLs never appear in the public API.

Then build/start the new service and restart the gateway and portal. Caddy's admin API is disabled, so gateway route changes require a restart. Registry changes require a portal restart but no frontend rebuild.

**The app must support deployment under a subpath.** Removing the prefix with `handle_path` alone cannot fix hardcoded root-relative assets, redirects, cookies, or API calls. Such apps need their supported base-path setting or a dedicated adapter. Do not make application-agnostic HTML rewriting the integration strategy.

## Updates and Data

Each app can be updated without rebuilding or restarting the others:

```powershell
docker compose build --pull grocy
docker compose up -d --no-deps --wait grocy
```

Replace `grocy` with `webtrees`, `ssacademy`, or `portal` as needed. Update the corresponding source checkout before rebuilding; the Dockerfiles build the local source, not a separate upstream release image. Back up data before upgrades because upstream schema migrations may prevent rolling back just the image. For reproducible releases, preserve each upstream dependency lockfile and pin image digests/source revisions in your release process. The portal's npm lockfile is included.

Persistent volumes:

| Volume | Contents |
| --- | --- |
| `ssportal_grocy_data` | Grocy database, settings, uploads, backups |
| `ssportal_webtrees_data` | webtrees configuration, SQLite database if selected, media, cache |
| `ssportal_gateway_data` | Caddy certificates and other state |
| `ssportal_gateway_config` | Caddy runtime state |
| `ssportal_portal_data` | Portal users, passkey public keys, sessions, challenges, setup/recovery token hashes |
| `ssportal_ssacademy_data` | Parsed ssAcademy imports, normalized values, revisions, and edit metadata |

Ordinary `docker compose down` preserves data. **Do not run `docker compose down -v` unless you intend to erase the volumes.**

For a consistent SQLite backup, stop writes first and copy the app data to a new backup folder. Example in PowerShell:

```powershell
$backup = Join-Path ./backups (Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Force $backup
docker compose stop portal ssacademy grocy webtrees
docker compose cp portal:/app/data "$backup/portal"
docker compose cp ssacademy:/app/data "$backup/ssacademy"
docker compose cp grocy:/var/www/grocy/data "$backup/grocy"
docker compose cp webtrees:/var/www/webtrees/data "$backup/webtrees"
docker compose start portal ssacademy grocy webtrees
```

Check command results and archive the backup off-host. Back up external MySQL/MariaDB databases separately. Restore only with the app stopped, copy files into the matching volume, and restore ownership to `node` (UID 1000) for portal data or `www-data` for PHP app data. Copy the whole SQLite data directory, including any WAL/SHM files. Treat portal backups as sensitive identity data. Do not overwrite populated volumes without a backup. Custom webtrees modules belong in a deliberate derived image or separately managed mount; the image is read-only and in-app code upgrades are intentionally disabled.

## HTTPS and Security

The HTTPS workflow follows ssMusic_Server: a separate HTTPS port, automatic persistent local certificates, an HTTP-to-HTTPS redirect, and optional `HTTPS_KEY_PATH`/`HTTPS_CERT_PATH` files. TLS terminates at Caddy so the portal, Grocy, webtrees, APIs, and WebSockets all use the same secure origin. No native app source is modified.

### Local Certificates

With `HTTPS_MODE=local` (the default), Caddy generates a local CA and a certificate for `PASSKEY_RP_ID` (or `localhost` when blank), stores their keys in the `gateway_data` volume, and renews managed certificates automatically. This is a proper local CA plus leaf certificate rather than a self-signed leaf; clients trust the CA once and continue trusting renewed certificates. The HTTP redirect is the only public HTTP application route. Internal container-to-container traffic and health checks can remain HTTP. `HTTPS_MODE`, certificate paths, and `ALLOW_REGISTRATION` remain optional advanced settings; they are not required in the seven-variable environment template.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOCKER_BIND_ADDRESS` | `127.0.0.1` | Host interface for published ports |
| `WEB_API_PORT` | `8080` | Host HTTP redirect port |
| `HTTPS_WEB_PORT` | `4125` | Host HTTPS port (TCP and UDP/HTTP3) |
| `PASSKEY_RP_ID` | `localhost` | Certificate and public hostname; no scheme, path, or port |
| `HTTPS_MODE` | `local` | Local CA by default; `public` enables public ACME issuance |
| `HTTPS_CERT_PATH` | Empty | Optional PEM certificate/full-chain path inside the gateway |
| `HTTPS_KEY_PATH` | Empty | Optional matching PEM private-key path inside the gateway |

### Trust the Local CA

After starting the stack, export **only the public CA certificate**:

```powershell
docker compose cp gateway:/data/caddy/pki/authorities/local/root.crt ./certificates/ssportal-local-ca.crt
```

The generated certificate directory is gitignored and excluded from Docker build contexts. Inspect the certificate before trusting it. To trust this portal CA for the current Windows user, run this yourself:

```powershell
Import-Certificate -FilePath .\certificates\ssportal-local-ca.crt -CertStoreLocation Cert:\CurrentUser\Root
```

This changes your user's trusted root store. Trust it only on devices where you trust this server and its operators. Restart the browser afterward. Other operating systems, Firefox configurations, and mobile devices may require their own certificate installation steps. Do not share the CA private key or copy it out of Docker. An HTTPS certificate-warning bypass is not the supported passkey setup. The application does not automatically modify host trust stores or disable certificate verification.

Keep `gateway_data` across updates and restarts. Deleting it creates a new CA, which clients would need to trust again. Local DNS/hosts configuration must route `PASSKEY_RP_ID` (or `localhost`) to the machine running the gateway; TLS does not configure DNS, Windows firewall rules, or router port forwarding.

### Supplied Certificates

Put your PEM key and certificate chain in the ignored `certificates` directory, mounted read-only into the gateway at `/certificates`, then set both values:

```dotenv
HTTPS_CERT_PATH=/certificates/server-cert.pem
HTTPS_KEY_PATH=/certificates/server-key.pem
```

Paths must be readable absolute container paths containing only letters, digits, underscores, dots, slashes, and hyphens. Both settings are required together. The supplied certificate must cover `PASSKEY_RP_ID` (or `localhost`); it takes precedence over automatic local/public issuance. Supply the intermediate chain where required. Your certificate provider remains responsible for renewal; replace the files and restart the gateway after renewal. A partial pair, missing file, or invalid mode fails startup rather than silently falling back.

```powershell
docker compose up -d --no-deps --wait gateway
docker compose exec -T gateway /bin/sh /etc/caddy/gateway-entrypoint.sh validate
```

### Existing Reverse Proxy

When another proxy provides public HTTPS, configure its upstream to the portal's **HTTPS** listener. The old HTTP port now redirects and must not be used as the app upstream. Keep `PASSKEY_ORIGIN` set to the exact browser-facing address, for example:

```dotenv
PASSKEY_ORIGIN=https://portal.example.com
PASSKEY_RP_ID=portal.example.com
```

Then apply the environment change without rebuilding or deleting data:

```powershell
docker compose up -d --no-deps --wait portal gateway
```

For a proxy on this machine with `HTTPS_WEB_PORT=4125`, the upstream address is `https://127.0.0.1:4125`, with upstream TLS SNI/hostname verification set to `PASSKEY_RP_ID` (or `localhost`). Trust the exported portal CA in the proxy (or supply a certificate it already trusts). Do not disable upstream certificate verification. Preserve the public `Host` and browser `Origin` headers, cookies, full request paths, and WebSocket upgrades. A proxy on another machine cannot reach a loopback binding; use an explicitly firewalled private binding for that topology.

The browser must open the configured public HTTPS origin, not an internal upstream URL or an iframe inside an HTTP page. If an explicit `PASSKEY_ORIGIN` is set, update it when changing the hostname or public port. Direct access on a different origin intentionally links back to the configured sign-in address. Passkeys enrolled under another hostname need re-enrollment or account recovery.

### Public Certificates

For a real domain, point its DNS to this server, allow inbound ports 80/443, set `PASSKEY_RP_ID` to the hostname (no scheme/path/port) and explicitly set `DOCKER_BIND_ADDRESS=0.0.0.0` in `.env`, then:

```powershell
docker compose -f compose.yaml -f compose.https.yaml up -d --build --wait
```

Caddy obtains and renews publicly trusted certificates using ACME instead of the local CA. All apps remain on one hostname: `https://your-host/grocy/`, `https://your-host/webtrees/`, and `/`. This override replaces the custom port mappings with 80/443 and sets the public origin without a port; UDP 443 enables HTTP/3. Leave supplied certificate paths empty to use ACME. Update webtrees' configured base URL if it was previously installed under HTTP or a different hostname. Real-domain certificate issuance requires valid DNS and network access and cannot be verified by local tests.

The portal registry/status and administration APIs require approved sessions. Caddy validates the session before forwarding app pages, static assets, APIs, and WebSocket handshakes; it fails closed if the authentication service is unavailable. Only the sign-in assets, minimal authentication metadata, enrollment/login endpoints, and liveness endpoints are public. Keep internal app/API ports unpublished. Rate-limit client identification trusts one proxy hop; deploy only behind the controlled gateway and do not expose the portal backend directly.

**Same hostname also means the same browser origin.** Cookie paths help avoid accidental collisions, but they are not an XSS or trust boundary. Only put mutually trusted apps here. An app with a compromised script can affect other apps on that origin. Separate containers isolate processes and dependencies, not browser origins.

## Scaling

- The portal now stores identities, sessions, and challenges in SQLite. Keep one authentication/backend instance for this deployment. Before horizontal scaling, migrate that store to a shared transactional database and use a shared rate-limit backend; do not copy SQLite databases between replicas or place a WAL database on network storage.
- Each app has an independent service boundary and can move to another server or runtime without changing public paths.
- Do not blindly scale the current SQLite-backed apps. Horizontal scaling requires a supported shared database, session storage, shared media, and coordinated migrations. Grocy's SQLite storage is naturally suited to a single instance.
- Start with this Compose deployment. Add a database, cache, job workers, or orchestration when an actual application requires them, not just for the portal.

## Validation

```powershell
npm --prefix portal ci
npm --prefix portal_apps/ssAcademy ci
npm --prefix portal test
npm --prefix portal_apps/ssAcademy test
npm --prefix portal run build
$env:STACK_CA_CERT = (Resolve-Path ./certificates/ssportal-local-ca.crt).Path
$env:STACK_URL = 'https://localhost:4125'
$env:STACK_HTTP_URL = 'http://localhost:8080'
npm --prefix portal run test:stack
npm --prefix portal exec -- playwright install chromium
npm --prefix portal run test:e2e
```

Set the stack URLs to your configured hostname and ports. `STACK_CA_CERT` trusts the specified CA for these tests only; omit it for a certificate trusted by Node's normal roots. Optional `STACK_CONNECT_ADDRESS=127.0.0.1` routes requests locally while retaining the URL hostname for SNI and certificate verification, useful when public DNS does not loop back to this machine. The six stack tests verify real TLS, matching passkey origins, Secure cookies, HTTP redirects, and the deployed authentication boundary without creating accounts or printing secrets. They do not disable certificate verification. Docker health checks still probe app containers directly.

Browser tests start isolated servers on random localhost ports with fresh in-memory databases and Chromium virtual authenticators. They perform real WebAuthn registration and signature verification, including approval/revocation, roles, passkey management, recovery, tampered attestations, and safe return URLs. They do not use or alter live Docker accounts; `TEST_BASE_URL` is no longer used. Existing search, favorites, themes, error recovery, and desktop/mobile screenshot checks run after verified test-admin enrollment. Tests contain no production authentication bypass.

```powershell
docker compose ps
docker compose logs --tail 100 portal grocy webtrees gateway
```

Health probes are coalesced and cached for 15 seconds, with a 2.5-second per-app timeout. The browser refreshes every 30 seconds when visible. An unavailable app does not prevent the portal or other apps from running.