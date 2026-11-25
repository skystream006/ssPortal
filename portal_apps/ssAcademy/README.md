# ssAcademy Data Server

An independent app at `/ssacademy/` for importing, viewing, and administering collection exports from [skystream006/ssAcademy](https://github.com/skystream006/ssAcademy). It shares the portal's HTTPS hostname and accounts.

The database stores parsed values in SQLite tables, **not uploaded files or raw export JSON blobs**. The viewer can read a local JSON file, but only the parsed data is sent to the server. The device decides when to upload or apply a downloaded collection; the server does not push to devices.

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

Members can view and delete their own imports. Administrators can select **All users**, open any collection, and choose **Edit values** to change whole/fragment balances and animation IDs. Source labels, owners, schema versions, and original import metadata are not editable. Deletion remains owner-scoped, including for administrators.

Edits are transactional and revision-checked. Stale forms receive HTTP 409 instead of overwriting newer changes. The current and original checksums, revision, editor ID, edit time, and checksum audit metadata are retained. Audit metadata does not include copies of the original file or previous values, so automatic undo is not provided.

Re-uploading the same original data with the same source label and owner returns the existing record and preserves administrative corrections. A different source label or original export creates another browsable snapshot. An edit to the owner's current sync collection is visible on the next authorized sync.

## App Approval and Fingerprint Tokens

The mobile app supplies a `username` and a persistent `fingerprintToken`. The server does not generate upload credentials. An administrator opens **ssAcademy > Upload tokens** to view the **App approvals** queue, filter registrations, and approve, revoke, or delete an app. Members cannot open or administer this page.

The username identifies a portal account; registration does not create or approve an account. The account must exist and be approved before the app can be approved. Compare the requesting app's fingerprint ID with the queue before granting access. The public fingerprint ID is the first 16 lowercase hexadecimal characters of SHA-256 over the exact UTF-8 token string; it is not the credential.

`fingerprintToken` must be a **private, randomly generated per-installation secret**, persisted securely on the device and reused for retries and authorized requests. Generate at least 32 random bytes and encode them as hexadecimal or unpadded base64url. The API accepts 32-256 characters from `A-Z`, `a-z`, `0-9`, `_`, and `-`. Do not use a hardware ID, a publicly readable device fingerprint, a password, or biometric data. Approval is not hardware attestation: anyone possessing the secret can use its granted permissions.

Only SHA-256 token hashes are stored. Tokens are never returned by the API or displayed in the admin page. Approval lasts 90 days; an administrator can explicitly approve an expired or revoked registration again. There are at most 20 registrations per normalized username and 2000 total, including pending, expired, and revoked entries. Administrators can delete obsolete entries to free capacity.

Approved tokens are **upload-only by default**, including all previously approved devices. For registrations marked **Owner sync requested**, the approval dialog offers a separate, initially unchecked download/sync permission. An administrator can change access on an already approved device to grant or remove sync without extending its expiry. Expired or revoked devices require fresh approval, with sync off by default.

Even with sync, a token cannot browse other snapshots, patch or delete imports, manage tokens/users, obtain a browser session, or access other portal apps. Imports and sync belong to the approved portal account ID (even for an administrator), including after an account rename. Account revocation, role changes, deletion, or recovery invalidate linked devices; approving an account again does not revive its devices.

Protected API requests validate their session or token against the portal account service and fail closed if it is unavailable. Browser mutations require the exact configured portal origin. Mobile enrollment and status endpoints do not require a browser session or authorization header.

### Mobile Registration

`POST /ssacademy/api/devices/register` with `Content-Type: application/json`:

```json
{
  "username": "Existing portal username",
  "fingerprintToken": "<private per-installation secret>"
}
```

Replace the placeholder with the actual secret in the request body, never a URL/query parameter. Add `"requestSync": true` to **registration only** to request owner sync. Omitting it preserves ordinary upload-only enrollment. An existing device may repeat registration with that flag; the request never grants sync or changes an approval's status or expiry. Usernames use portal normalization (case-insensitive matching, NFKC, trimmed and collapsed whitespace; 2-64 characters). The mobile app should retain the original username/token pair for registration retries and status checks.

New registrations return **202** with `pending` status. Repeating the same pair returns **200** with its existing status and does not extend approval or revive revoked/expired access. A token already registered under a different username returns **409**.

```json
{
  "device": {
    "id": "server-generated-uuid",
    "username": "Existing portal username",
    "fingerprint": "0123456789abcdef",
    "status": "pending",
    "expiresAt": null,
    "syncApproved": false
  }
}
```

`POST /ssacademy/api/devices/status` accepts **only** the original username/token pair and returns **200** with the same response shape. Status is `pending`, `approved`, `revoked`, or `expired`; `expiresAt` is null before approval and otherwise Unix milliseconds. `syncApproved` is true only for a currently valid, explicitly sync-approved device. An absent pair returns **404**, including after an administrator deletes the registration. Registering after deletion creates a new pending request, not approved access.

Each public endpoint is limited to 10 requests per minute per client and a 1 KiB JSON body. Poll status with backoff, respect HTTP 429, and stop uploading when access is rejected. Native requests normally omit `Origin`; any supplied `Origin` must match the portal exactly. Registration and status do not accept cookies as substitutes for the username/token pair, and never reveal another user's account details.

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

New uploads return **201**; identical owner/source/data retries return **200** with `duplicate: true`. Ordinary token uploads (no `baseVersion`) return a receipt only, without collection values:

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

Use your actual HTTPS portal origin and trust its certificate. Do not disable TLS verification, publish tokens, or put them in public client code. The example environment variable contains the same device secret used for registration, not the public fingerprint ID.

## Owner Sync API

Both operations require `Authorization: Bearer <fingerprintToken>` with the separate owner-sync grant. A portal session or upload-only token cannot use them.

1. **Read:** `GET /ssacademy/api/sync` takes no query parameters. It returns `{ "version": "<opaque string>", "data": <version-1 export> }`. When there are no imports for this account, `data` is `null`; an empty but stored export is still an object. `version` is always a nonempty string of at most 160 characters. Do not parse it.
2. **Write:** `POST /ssacademy/api/imports` accepts `{ "source": "Learning tablet", "data": <version-1 export>, "baseVersion": "<version from read>" }`. The server compares the base and applies the upload in one transaction. A stale base returns **409** without changing any collection, even for a duplicate. Read again and reconcile before retrying; do not blindly submit old data with the new version.
3. **Use the returned head:** On **201** (new import) or **200** (duplicate), the receipt additionally contains `sync: { version, data }` in the same shape as the read. These are the canonical stored values, including normalization and any preserved administrator corrections. The same protocol applies to manual or reward-triggered device sync.

There is one sync collection per **account**, not per source or device. Before the first version-checked write, reads return the newest owned snapshot (creation time, then ID). A new ordinary upload changes the version only if it becomes that newest snapshot. An ordinary duplicate never changes the selection or version, even if it matches an older snapshot.

The first version-checked write pins its snapshot, even when it matches the initial fallback. Once pinned, **uploads without `baseVersion` remain browsable but cannot replace the current collection or invalidate its version**. A version-checked write can select an older duplicate: syncing A, B, then A returns A with a new version without storing another copy. Repeating an already version-selected current snapshot is a no-op.

Explicitly editing or deleting the current collection invalidates the version. Deleting a pinned head selects the most recently version-selected surviving snapshot, or the newest remaining import if none was selected by sync. That replacement stays pinned. If a previously synced account is emptied, reads return `null` until a version-checked write selects a collection again. Returning to an earlier snapshot or to empty data does not revive old versions.

## Read and Admin API

These endpoints require an approved portal browser-session cookie; all app tokens are rejected.

| Method and path | Purpose |
| --- | --- |
| `GET /ssacademy/api/me` | Current user |
| `GET /ssacademy/api/schema` | Format, version, reward catalog, and limits |
| `GET /ssacademy/api/imports` | Own snapshots |
| `GET /ssacademy/api/imports?scope=all` | Administrator-only all-owner list |
| `GET /ssacademy/api/imports/:id` | Values and edit metadata; owner or admin |
| `PATCH /ssacademy/api/imports/:id` | Administrator-only value editing |
| `DELETE /ssacademy/api/imports/:id` | Delete an owned snapshot and its child records |
| `GET /ssacademy/api/tokens` | Administrator-only app registration metadata, without secrets |
| `PATCH /ssacademy/api/tokens/:id` | Administrator-only: `{ "status": "approved" }` grants uploads only. Add `"syncApproved": true` to explicitly grant requested owner sync. `{ "status": "revoked" }` removes all access. |
| `DELETE /ssacademy/api/tokens/:id` | Administrator-only registration deletion; immediately removes app access |

Import listing supports `search`, `source`, `page` (default 1), and `pageSize` (default 25, maximum 100). Default scope is `mine`. Timestamps are Unix milliseconds.

App registration listing returns `{ devices, total, page, pageSize }`, with separate `syncRequested` and `syncApproved` flags. It accepts `search` (literal username substring), `status` (empty for all, or `pending`, `approved`, `revoked`, `expired`), `page` (default 1), and `pageSize` (default 50, maximum 100). Approval requires an approved account and returns **409** if the named account does not exist, or **403** if it is not approved.

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

Errors use `{ "error": "..." }`: 400 invalid data, 401 unauthenticated/unapproved token, 403 permission/origin failure, 404 absent/not-owned data, 409 stale sync base, stale edit or registration conflict, 413 oversized data, 415 wrong media type, 429 request/registration limit, and 503 authentication service unavailable. Imports are limited to 30 per minute per client; other app requests share a 180-per-minute limit, with the tighter registration/status limits described above.

## Storage and Operations

The `ssacademy` Compose service uses Node.js 24, Fastify, SQLite, and a small browser-native UI. Icons/fonts are local, and theme colors are copied from the portal when building the image.

The `ssportal_ssacademy_data` volume contains `/app/data/academy.sqlite` and WAL/SHM files. Tables are `imports`, `reward_balances`, `collected_animations`, `import_edits`, `collection_versions` (one sequence per changed owner), and `collection_pins` (which snapshot a synced owner currently uses). Neither sync table copies collection data. Device hashes and approval metadata live separately in `academy_devices` in the portal identity database. Deleting a portal account removes its linked registrations and prevents access, but does not automatically erase its imported records.

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