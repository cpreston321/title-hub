# Title Hub agent

Customer-side agent for SoftPro Standard *direct* integrations (push-mode).
Posts `FileSnapshot` batches to the Title Hub server's
`/integrations/agent/sync` endpoint and a liveness ping to
`/integrations/agent/heartbeat`. Server-side schema, HMAC verification, and
upsert path live in `convex/integrations.ts` + `convex/http.ts`.

## Status

Three slices ship in order:

1. ✅ HTTP + HMAC + heartbeat (`agent push`, `agent heartbeat`, `agent run`).
2. 🚧 SQL Server poller against ProForm — connection + watermark loop wired
   (`src/proform.rs`); field mapping in `query_changed_orders` is the
   remaining pilot work.
3. 🚧 Windows Service hosting (`windows-service` crate).

## Setup (the easy path)

1. **Install Rust** (one-time):
   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. **Build the binary** (one-time):
   ```sh
   cargo build --release   # produces target/release/agent
   ```

3. **In the admin UI**, create a `softpro_standard` integration → click
   **Generate install command**. The web app produces a one-line command:

   ```sh
   agent install --token <64-hex> --server https://your-deployment.convex.site
   ```

   Copy it. The token is single-use and expires in 15 minutes — if you
   miss the window, click "Generate install command" again.

4. **Paste the command on the agent host.** The agent calls the redeem
   endpoint, fetches the long-lived inbound secret, and writes a complete
   config to the OS-appropriate path:
   - **Windows:** `%ProgramData%\TitleHubAgent\agent.toml`
   - **macOS:** `~/Library/Application Support/title-hub-agent/agent.toml`
   - **Linux:** `~/.config/title-hub-agent/agent.toml`

5. **Verify connectivity:**
   ```sh
   agent doctor
   ```
   Runs the full preflight (config validates, server reachable, HMAC
   round-trips, clock skew checked). If something's wrong, the output tells
   you exactly what — you don't have to guess at error codes.

6. **Run it:**
   ```sh
   agent run
   ```

### Manual / airgapped install

If the agent host can't reach the Convex deployment from the same shell
where you generate the token (rare — the install command and the agent
both talk to the same .convex.site URL), use the legacy two-step path:

1. In the admin UI, click **Show secret** instead of "Generate install
   command". Copy the TOML block.
2. On the agent host:
   ```sh
   pbpaste | agent init                        # macOS
   Get-Clipboard | agent init                  # Windows PowerShell
   xclip -o -selection clipboard | agent init  # Linux X11
   ```

## CLI reference

| Command              | What it does                                                  |
| -------------------- | ------------------------------------------------------------- |
| `agent install`      | Redeems a one-time install token, writes the config (preferred) |
| `agent init`         | Reads install-token TOML from stdin, writes it to disk          |
| `agent doctor`       | Preflight: config valid, server reachable, HMAC + skew          |
| `agent push`         | One-shot push from a JSON fixture (testing the snapshot wire)   |
| `agent push-document`| One-shot upload of a single PDF against an existing file        |
| `agent heartbeat`    | One-shot heartbeat                                              |
| `agent run`          | Long-running loop: heartbeat + (if `[proform]` set) polling     |

`--config <PATH>` overrides the default config location for any command.

## Wire format

`POST $base_url/integrations/agent/sync?id=$integration_id`

Headers:

| Header              | Value                                            |
| ------------------- | ------------------------------------------------ |
| `Content-Type`      | `application/json`                               |
| `X-Title-Timestamp` | Unix ms; server rejects > 5 min skew             |
| `X-Title-Signature` | `sha256=<hex(HMAC-SHA256(secret, ts.body))>`     |

Body:

```json
{
  "snapshots": [{ "externalId": "...", "fileNumber": "...", ... }],
  "watermark": "rowversion:0x000A"
}
```

The `FileSnapshot` Rust types in `src/snapshot.rs` mirror
`convex/integrations/types.ts`. Wire is camelCase via serde rename.

## Document uploads

ProForm stores order documents (PA, counter offer, lender instructions,
ID copies) on a file system share — `\\AGENCY-FS\ProForm\Documents\<OrderNumber>\`
on most installs — with pointers in SQL. The agent ships those bytes
through a separate, signed endpoint:

```
POST /integrations/agent/document
     ?id=<integrationId>
     &fileNumber=<file number>
     &docType=<purchase_agreement|counter_offer|...>
     &title=<filename>
     &sha256=<hex>
Headers:
  X-Title-Timestamp: <unix ms>
  X-Title-Signature: sha256=<hex(HMAC-SHA256(secret, message))>
Body: <raw bytes>
```

The signed message is pipe-delimited and binds every URL field plus the
body checksum:

```
${ts}|${integrationId}|${fileNumber}|${docType}|${title}|${sha256}
```

Server verifies HMAC, recomputes sha256 of the body to confirm it
matches the signed value, stores the blob, inserts a `documents` row
attributed to the integration's owner-or-admin, and schedules the same
Claude extraction the manual upload path uses. **De-dup is automatic**
on `(file, sha256)` — re-uploading an unchanged file returns `deduped:
true` and creates no new rows.

Constraints to know:

- Convex's HTTP body limit is **20 MB**. The agent should skip + log
  files larger than that. Agency closing packages occasionally exceed
  this, but they're output (not extraction input), so it's acceptable.
- The file must already exist on the server (push the snapshot first
  via `agent push` or the SQL poller) — uploading against an unknown
  `fileNumber` returns 404 with `FILE_NOT_FOUND_FOR_DOCUMENT`.
- NPI lives in these PDFs (SSNs on borrower IDs, EINs on entity docs).
  Bytes land in `_storage` server-side; the existing tokenization story
  takes over once extraction runs. Per-tenant storage encryption is on
  the deferred list.

Try the wire end-to-end without writing the SQL mapping:

```sh
agent push-document \
  --file /path/to/PA.pdf \
  --file-number QT-2026-0001 \
  --doc-type purchase_agreement
```

The companion `agent push --snapshots fixtures/sample.json` ensures the
matching file row exists first.

## Wiring up the SQL poller

The poller scaffold is in `src/proform.rs` and runs alongside the heartbeat
when a `[proform]` block is present in `agent.toml` (see the example file).
Connection, the rowversion-based watermark loop, and server-bounded
batching are all live. What's left for the pilot is the **field mapping**
in `query_changed_orders` — a real `SELECT` against ProForm's schema and
the per-row → `FileSnapshot` translation.

The watermark is the SQL Server `rowversion` (8 bytes) for the orders
table, hex-encoded. The server stores the latest acknowledged value as
`integrations.agentWatermark` so a fresh agent can resume without losing
position.

⚠ **Auth note:** ProForm SQL Servers usually want Windows integrated auth.
`tiberius` supports SQL auth cleanly but integrated auth is rougher than
ADO.NET. For pilot 1, prefer provisioning a SQL login with read-only access
to the orders table.

## Next steps

Concrete follow-up work, in roughly the order it should land. Each section
points at the file or system to start in.

### 1. Cut the first signed release

Everything's in place — what's left is the operational push.

1. **Set up signing** per [`SIGNING.md`](./SIGNING.md). Azure Trusted
   Signing is the path of least resistance; budget ~30 min once Microsoft
   finishes the 1–3 day identity validation. Add the six `AZURE_TS_*`
   secrets to the GitHub repo.
2. **Set up the release env-var hand-off.** Confirm that
   `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY` are present
   on the GitHub repo (they already are if `ci.yml` deploys cleanly).
   The `publish-to-convex` job in `agent-release.yml` uses them to set
   `AGENT_RELEASE_BASE_URL` + `AGENT_RELEASE_VERSION` after each release.
3. **Tag and push:**
   ```sh
   cd agent && cargo set-version 0.1.0
   git commit -am "agent v0.1.0"
   git tag agent-v0.1.0
   git push origin main agent-v0.1.0
   ```
4. **Verify on a clean Windows VM.** Generate an install command in the
   admin UI, paste the PowerShell one-liner. SmartScreen should not warn.
   `agent doctor` should print three green ticks.

See [`RELEASE.md`](./RELEASE.md) for the operational checklist.

### 2. Wire the ProForm SQL field mapping

The agent connects, polls, and ships — but there are no fields to ship
yet. `query_changed_orders` in `src/proform.rs` is the explicit TODO,
gated behind a `warn!` so a misconfigured run is loud, not silent.

This is the only piece of the agent that **must** be done against a real
ProForm install. Path forward:

1. Get a test ProForm DB from the pilot agency (or a SoftPro-licensed
   sandbox if they'll provide one).
2. Map columns onto `FileSnapshot`. The starting points commented in
   `proform.rs`:
   - `dbo.OrderHeader` keyed by `OrderID`, with a `Rowversion` column
     for the watermark.
   - `dbo.OrderName` for parties (buyer/seller).
   - `dbo.OrderProperty` for the property address.
   - `dbo.OrderDocument` (or whatever ProForm names it) for document
     pointers — filename + path on the documents share, doc type code,
     last-modified timestamp.
3. The query has to be **bounded by `batch_size`** and **ordered by
   `Rowversion ASC`** — the watermark loop assumes monotonic progress.
4. After upserting the snapshot, walk the document pointers and call
   `client.upload_document(...)` for each new one. The wire format is
   already done (see "Document uploads" above) and the server de-dupes
   on `(file, sha256)`, so resyncing an unchanged file is a no-op.
5. Add a per-mapping integration test against a recorded fixture (anonymized
   real data is fine; checked into `agent/tests/fixtures/`).

⚠ **Schema drift.** SoftPro renames columns between releases. Wrap each
table read in a small mapper and unit-test it; that way a service-pack
upgrade on the agency's machine fails one mapper instead of blowing up
the whole sync.

⚠ **Documents share access.** The agent's service account needs read
access to the UNC path that ProForm stores documents under. SoftPro
service accounts usually have it; verify during pilot setup.

### 3. Run as a Windows Service

Right now `agent run` runs in the foreground. For a real install it has
to start at boot, restart on crash, run as a service account, and be
manageable via standard Windows tools.

The [`windows-service`](https://crates.io/crates/windows-service) crate is
the canonical Rust answer. Add three subcommands:

- `agent service install` — registers the service via `CreateService`
  with auto-start + restart-on-crash configured.
- `agent service uninstall` — `DeleteService`.
- `agent service run` — the entry point Windows calls when starting the
  service. Wraps the existing `cmd_run` body inside a service control
  handler so SCM signals (stop, pause, shutdown) are honored.

The bootstrap script (`renderPowerShellScript` in `convex/agentBootstrap.ts`)
should call `agent service install` after `agent install` and
`Start-Service` afterward, so the IT admin's whole install is a single
paste.

### 4. Self-update

The agent shouldn't require a human to push a new version. Build a
`update` subcommand that:

1. Reads `AGENT_RELEASE_BASE_URL` + `AGENT_RELEASE_VERSION` from the
   server (a new server-side `agentLatestVersion` query can return both).
2. Compares against the running version (`env!("CARGO_PKG_VERSION")`).
3. If newer: download the platform-appropriate archive, verify SHA-256
   (same logic the bootstrap uses), drop the new exe alongside the old
   one, restart the service, swap on success, retain the previous binary
   for one rollback step.

Schedule it from `cmd_run` to check once a day. Keep the existing
heartbeat cadence — auto-update is orthogonal.

### 5. Ship agent-side observability back to the server

The server only knows the agent is alive when a heartbeat lands. When the
SQL poller fails, the agent logs to `tracing` and keeps trying — the
admin has no visibility from the web UI.

Add a small structured-log shipper:

- A `agentLogs` table on the server, indexed by integration + time, with
  `level` (info/warn/error) + `message` + `metadata`.
- A new HTTP endpoint that accepts batched log entries, signed with the
  same HMAC scheme as `/integrations/agent/sync`.
- A `tracing-subscriber` `Layer` on the agent side that buffers and ships.
- Surface the last 50 log lines on the integration card in the admin UI.

This is what turns "the agent is offline, no idea why" into "ProForm DB
unreachable since 14:32 — auth failure on `agent_user`."

### 6. Operational reminders

These don't need code; they need calendar reminders.

- **Cert + secret rotation.** The Azure Trusted Signing App Registration
  client secret expires every ~6 months. Set a reminder a week before
  expiry. When it rotates, update `AZURE_TS_CLIENT_SECRET` on the repo.
- **Watermark backfill on first install.** A fresh agent starts from an
  empty watermark, which means it ships *every* historical order. For
  pilots with thousands of historical files this is fine (one slow
  initial sync); for larger agencies, add a `--from-watermark` flag to
  bypass the initial backfill and only ship new orders.
- **Audit the install-token table** quarterly. Active tokens older than
  a few minutes that haven't been redeemed are usually paste failures —
  a one-off cleanup script + an admin-UI surface for "outstanding
  tokens" is enough.

### Done — for reference

These are checked off so future-you doesn't redo them:

- ✅ HTTP + HMAC + heartbeat (`agent push`/`heartbeat`/`run`)
- ✅ Document upload wire (`agent push-document`, server-side de-dup,
  triggers extraction)
- ✅ SQL poller scaffold (connection, watermark loop, batching)
- ✅ `agent init` (paste TOML)
- ✅ `agent install` (one-line redeem flow)
- ✅ `agent doctor` (preflight with actionable hints)
- ✅ Cross-platform binaries via GitHub Actions
- ✅ SHA-256 integrity check in bootstrap script
- ✅ Convex env-var hand-off in CI
- ✅ Code-signing pipeline (Azure Trusted Signing + legacy .pfx)
- ✅ Bootstrap endpoints (`/agent/install.{ps1,sh}`)
- ✅ Single-use install tokens with 15-min TTL
