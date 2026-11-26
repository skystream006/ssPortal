# ssAcademy Data Server

An independent app at `/ssacademy/` for importing, viewing, and administering collection exports from [skystream006/ssAcademy](https://github.com/skystream006/ssAcademy). It shares the portal's HTTPS hostname and accounts.

The database stores parsed values in SQLite tables, **not uploaded files or raw export JSON blobs**. The viewer can read a local JSON file, but only the parsed data is sent to the server. No Android source or device data is modified automatically.

The app icon is a 256 x 256 PNG resized without cropping from the [upstream Android launcher artwork](https://github.com/skystream006/ssAcademy/blob/0f603630936f58d2546448cbb5968a6bd989a997/app/src/main/res/drawable-nodpi/ic_launcher_artwork.png). The portal bundles it at `/icons/ssacademy.png`; the catalog, ssAcademy header/footer, and favicon share that local asset, without runtime requests to GitHub.

## Supported Data

The contract was verified against upstream revision `0f603630936f58d2546448cbb5968a6bd989a997`, specifically `CollectionBackup` and `RewardBalance`.

- Format `ssAcademy-collections`, version `1`.
- Exports contain reward balances and animation identifiers in `pokemons`. They do **not** contain practice history, reading progress, device settings, the local user's name, or the Admin PIN.
- Whole rewards must be integers from 0 to 715827881; fragments must be integers from 0 to 2. Missing balance fields default to zero.
- Supported rewards: `LOLLIPOP`, `ICE_CREAM`, `GUMMI_BEAR`, `RAMEN`, `BED_TIME`, `VIDEO_GAME`, `RESTAURANT`, `TOYS_1`, `TOYS_2`, `TOYS_3`, `GOOD_BEHAVIOR_POINT`.
- Animation identifiers are uppercase enum-name strings, up to 100 characters, containing letters, digits, and underscores. They are syntax-checked rather than tied to a copied artwork catalog, allowing future animation IDs within version 1. Duplicate identifiers are deduplicated.
- Export data is limited to 256 KiB and 2048 animation entries. Unsupported versions, unknown fields/reward types, and invalid balances are rejected before writes.

## View and Edit

Open **ssAcademy** from the portal. **Collections** provides search, source filters, pagination, reward details, and animation IDs. **Import data** accepts pasted JSON or a locally selected JSON file, plus a source label such as `Learning tablet`.

**Appearance settings** in the header offers the portal's seven color themes and Light, Dark, and System modes. Both apps use the same palettes and browser-local preference, with changes synchronized across open tabs. **Reset appearance** restores Green and System without changing other portal preferences.

Members can view and delete their own imports. Administrators can select **All users**, open any collection, and choose **Edit values** to change whole/fragment balances and animation IDs. Source labels, owners, schema versions, and original import metadata are not editable. Deletion remains owner-scoped, including for administrators.

Edits are transactional and revision-checked. Stale forms receive HTTP 409 instead of overwriting newer changes. The current and original checksums, revision, editor ID, edit time, and checksum audit metadata are retained. Audit metadata does not include copies of the original file or previous values, so automatic undo is not provided.

Re-uploading the same original data with the same source label and owner returns the existing record and preserves administrative corrections. A different source export creates another snapshot. Edits affect this server only; there is no automatic sync back to Android.

## App Approval and Fingerprint Tokens

The mobile app supplies a `student` and a persistent `fingerprintToken`. The server does not generate upload credentials. An administrator opens **ssAcademy > Sync Tokens** to view the **App approvals** queue, filter registrations, and approve, revoke, or delete an app. Members cannot open or administer this page.

The student is a display name; a portal account is **not required** to register or approve an app token. Registration does not create a portal account. Only a signed-in portal administrator can approve tokens. Compare the requesting app's fingerprint ID with the queue before granting access. The public fingerprint ID is the first 16 lowercase hexadecimal characters of SHA-256 over the exact UTF-8 token string; it is not the credential.

`fingerprintToken` must be a **private, randomly generated per-installation secret**, persisted securely on the device and reused for retries, uploads, and downloads. Generate at least 32 random bytes and encode them as hexadecimal or unpadded base64url. The API accepts 32-256 characters from `A-Z`, `a-z`, `0-9`, `_`, and `-`. Do not use a hardware ID, a publicly readable device fingerprint, a password, or biometric data. Approval is not hardware attestation: anyone possessing the secret can use its upload and owned-import download permissions.

Only SHA-256 token hashes are stored. Tokens are never returned by the API or displayed in the admin page. Approval lasts 90 days; an administrator can explicitly approve an expired or revoked registration again. There are at most 20 registrations per normalized student and 2000 total, including pending, expired, and revoked entries. Administrators can delete obsolete entries to free capacity.

Approved tokens can upload ssAcademy data and download an owned import by ID. They cannot list collections, browse the viewer, edit, delete, manage tokens/users, or access other portal apps. Downloads remain owner-scoped even for tokens linked to administrators.

Without a linked portal account, imports belong to a stable app-registration owner ID and display the student name. Separate registrations remain isolated even if they use the same student name; creating a matching portal account later does not transfer their imports. Administrators can view and edit these imports through **Collections > All users**. Deleting a registration invalidates its token; re-registering creates a new owner and does not regain access to the old imports.

Registrations that match an existing portal account retain that optional account link and its import ownership, including after an account rename. Existing registrations and imports are preserved. Account revocation, role changes, deletion, or recovery still invalidate linked devices; approving an account again does not revive its devices. Token approval itself does not require that linked account to be approved.

Protected API requests validate their session or token against the portal account service and fail closed if it is unavailable. Browser mutations require the exact configured portal origin. Mobile enrollment and status endpoints do not require a browser session or authorization header.

### Mobile Registration

`POST /ssacademy/api/devices/register` with `Content-Type: application/json`:

```json
{
  "student": "Learning student",
  "fingerprintToken": "<private per-installation secret>"
}
```

Replace the placeholder with the actual secret in the request body, never a URL/query parameter. Student names use portal normalization (case-insensitive matching, NFKC, trimmed and collapsed whitespace; 2-64 characters). The mobile app should retain the original student/token pair for registration retries and status checks.

The `student` field replaces `username` in registration/status requests and device responses, including the app approval listing and updates. Clients must send `student`; legacy `username` fields are rejected with HTTP 400. Existing registrations, approvals, and tokens are preserved.

New registrations return **202** with `pending` status. Repeating the same pair returns **200** with its existing status and does not extend approval or revive revoked/expired access. A token already registered under a different student returns **409**.

```json
{
  "device": {
    "id": "server-generated-uuid",
    "student": "Learning student",
    "fingerprint": "0123456789abcdef",
    "status": "pending",
    "expiresAt": null
  }
}
```

`POST /ssacademy/api/devices/status` accepts the same JSON pair and returns **200** with the same response shape. Status is `pending`, `approved`, `revoked`, or `expired`; `expiresAt` is null before approval and otherwise Unix milliseconds. An absent pair returns **404**, including after an administrator deletes the registration. Registering after deletion creates a new pending request, not approved access.

Each public endpoint is limited to 10 requests per minute per client and a 1 KiB JSON body. Poll status with backoff, respect HTTP 429, and stop uploading when access is rejected. Native requests normally omit `Origin`; any supplied `Origin` must match the portal exactly. Registration and status do not accept cookies as substitutes for the student/token pair, and never reveal another user's account details.

### Existing Generated Tokens

Previously generated upload tokens no longer authenticate, and the token-creation endpoint is removed. Existing accounts, passkeys, imports, and edits are preserved. Legacy token rows may remain in the identity database but are not consulted. Existing upload clients must switch to mobile-provided fingerprint tokens, register, and receive administrator approval; no legacy token is automatically approved or migrated.

## Upload API

`POST /ssacademy/api/imports`

```http
Content-Type: application/json
Authorization: Bearer <same approved fingerprintToken>
```

```json
{
  "source": "Learning tablet",
  "data": {
    "format": "ssAcademy-collections",
    "version": 1,
    "rewards": {
      "LOLLIPOP": { "whole": 3, "fragments": 2 },
      "TOYS_1": { "whole": 1, "fragments": 0 }
    },
    "pokemons": ["PIKACHU", "BULBASAUR"]
  }
}
```

`source` is a required 1-80 character label. `data` is the parsed export object. Do not send multipart/form-data, a file name, or base64 file contents.

New uploads return **201**; identical owner/source/data retries return **200** with `duplicate: true`. Token responses contain a receipt only, without collection values:

```json
{
  "duplicate": false,
  "import": {
    "id": "server-generated-uuid",
    "source": "Learning tablet",
    "format": "ssAcademy-collections",
    "version": 1,
    "importedAt": 1790000000000
  }
}
```

Example JavaScript upload using a parsed `exportedCollections` object:

```js
const response = await fetch(`${process.env.PORTAL_ORIGIN}/ssacademy/api/imports`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.SSACADEMY_FINGERPRINT_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ source: 'Learning tablet', data: exportedCollections }),
});
if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
const receipt = await response.json();
```

Use your actual HTTPS portal origin and trust its certificate. Do not disable TLS verification, publish tokens, or put them in public client code. The example environment variable contains the same device secret used for registration, not the public fingerprint ID. The Android app has not been changed to call this API automatically.

## Download API

`GET /ssacademy/api/imports/:id` accepts `Authorization: Bearer <same approved fingerprintToken>` without a browser-session cookie or `Origin` header. Use the import ID returned by an upload receipt. The response is `{ "import": ... }`, with the same current values and edit metadata returned to the browser; the response shape has not changed. Responses use `Cache-Control: no-store`.

Tokens can download only imports owned by their approved portal account. Missing or other-owner imports return **404**, including for administrator-owned tokens. Missing, unapproved, revoked, or expired credentials return **401**; an unavailable portal account service returns **503**. The endpoint is not anonymous. Browser sessions continue to work with their existing owner/administrator access.

## Read and Admin API

These endpoints require an approved portal browser-session cookie, except the import detail/download route described above. Device tokens are rejected on the other routes.

| Method and path | Purpose |
| --- | --- |
| `GET /ssacademy/api/me` | Current user |
| `GET /ssacademy/api/schema` | Format, version, reward catalog, and limits |
| `GET /ssacademy/api/imports` | Own snapshots |
| `GET /ssacademy/api/imports?scope=all` | Administrator-only all-owner list |
| `GET /ssacademy/api/imports/:id` | Values and edit metadata; browser owner/admin or approved owner device token |
| `PATCH /ssacademy/api/imports/:id` | Administrator-only value editing |
| `DELETE /ssacademy/api/imports/:id` | Delete an owned snapshot and its child records |
| `GET /ssacademy/api/tokens` | Administrator-only app registration metadata, without secrets |
| `PATCH /ssacademy/api/tokens/:id` | Administrator-only approval or revocation using `{ "status": "approved" }` or `{ "status": "revoked" }` |
| `DELETE /ssacademy/api/tokens/:id` | Administrator-only registration deletion; immediately removes upload access |

Import listing supports `search`, `source`, `page` (default 1), and `pageSize` (default 25, maximum 100). Default scope is `mine`. Timestamps are Unix milliseconds.

App registration listing returns `{ devices, total, page, pageSize }` and accepts `search` (literal student substring), `status` (empty for all, or `pending`, `approved`, `revoked`, `expired`), `page` (default 1), and `pageSize` (default 50, maximum 100). Approval requires a signed-in portal administrator, not a portal account for the student.

An edit sends the complete replacement data and the revision from the detail endpoint:

```json
{
  "revision": 1,
  "data": {
    "format": "ssAcademy-collections",
    "version": 1,
    "rewards": { "LOLLIPOP": { "whole": 4, "fragments": 0 } },
    "pokemons": ["PIKACHU"]
  }
}
```

Omitted rewards/animations are removed from the current values. The response contains the saved `import` and its revision. No-op edits keep the current revision. `sha256` describes current normalized data; `importedSha256` preserves the original ingest fingerprint used for deduplication.

Errors use `{ "error": "..." }`: 400 invalid data, 401 unauthenticated/unapproved token, 403 permission/origin failure, 404 absent/not-owned data, 409 stale edit or registration conflict, 413 oversized data, 415 wrong media type, 429 request/registration limit, and 503 authentication service unavailable. Imports are limited to 30 per minute per client; other app requests share a 180-per-minute limit, with the tighter registration/status limits described above.

## Storage and Operations

The `ssacademy` Compose service uses Node.js 24, Fastify, SQLite, and a small browser-native UI. Icons/fonts are local, and theme colors are copied from the portal when building the image.

The `ssportal_ssacademy_data` volume contains `/app/data/academy.sqlite` and WAL/SHM files. Tables are `imports`, `reward_balances`, `collected_animations`, and `import_edits`. Device hashes and approval metadata live separately in `academy_devices` in the portal identity database. Deleting a portal account removes its linked registrations and prevents access, but does not automatically erase its imported records.

```powershell
docker compose up -d --build --wait portal ssacademy gateway
docker compose logs --tail 100 ssacademy
```

Stop ssAcademy before copying its entire data directory for a consistent backup. Back up portal account data too, since imports reference portal user IDs. Preserve both data volumes during updates; restore ssAcademy files with UID 1000 ownership. Do not run `docker compose down -v` unless intentionally deleting data. Horizontal scaling requires replacing local SQLite with a shared transactional database.

The gateway intentionally does not use the cookie-only `portal_session` snippet for ssAcademy: this service handles public mobile enrollment and enforces portal-session or scoped-token authorization for protected endpoints itself. Keep `PORTAL_INTERNAL_URL` private and controlled. Only the gateway has published ports. Liveness at `/ssacademy/health` exposes no records.

For isolated local development, use `npm --prefix portal_apps/ssAcademy ci` and `npm --prefix portal_apps/ssAcademy run dev` with a reachable `PORTAL_INTERNAL_URL`. The complete browser workflow must use the same public origin as the portal; Docker is recommended. `HOST`, `PORT`, `ACADEMY_DB_PATH`, and `PORTAL_THEME_PATH` are configurable. Cross-origin access is not enabled.

## Tests

```powershell
npm --prefix portal_apps/ssAcademy ci
npm --prefix portal_apps/ssAcademy test
npm --prefix portal test
npm --prefix portal run test:e2e -- academy.spec.ts
```

Live `npm --prefix portal run test:stack` checks use `STACK_URL` for the canonical HTTPS origin and `STACK_CA_CERT` for the trusted CA. When connecting directly to a gateway behind a public proxy, `STACK_CONNECT_ADDRESS` and `STACK_CONNECT_PORT` can select its IP and HTTPS port without changing the hostname, Host header, or TLS verification. Set `STACK_HTTP_URL` to the actual HTTP listener. These checks do not register live devices or upload collection data.

Tests use isolated databases and real portal test sessions. Coverage includes JSON-only ingestion, normalized storage, duplicate uploads, rollback, ownership, fingerprint enrollment/approval/revocation, expiry, account binding, hashed storage, legacy-token retirement, filtering, administrator editing, revision conflicts, dark mode, and mobile layout. No live devices or production records are created by browser tests.