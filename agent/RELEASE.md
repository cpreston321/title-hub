# Title Hub agent — release process

## What gets shipped

For each release tag `agent-v<X.Y.Z>`, the GitHub Actions workflow at
`.github/workflows/agent-release.yml` builds the agent for:

- `x86_64-pc-windows-msvc` (the primary target — agency Windows servers)
- `aarch64-apple-darwin` (M-series Macs, dev parity)
- `x86_64-apple-darwin` (Intel Macs, dev parity)
- `x86_64-unknown-linux-gnu` (CI testing, future Linux pilots)

Each archive is named `title-hub-agent-agent-v<X.Y.Z>-<target>.<ext>` and
ships with a sibling `.sha256` file containing the lowercase hex digest.
The bootstrap script downloads both and rejects the install if they don't
match — this is the integrity backstop even when the binary isn't signed.

## Cutting a release

```sh
# Bump the version
cd agent && cargo set-version 0.1.0   # or edit Cargo.toml

# Tag and push
git commit -am "agent v0.1.0"
git tag agent-v0.1.0
git push origin main agent-v0.1.0
```

The workflow fans out across the build matrix, runs unit tests on every
platform, and on success publishes a GitHub Release with all four archives
plus checksums. Total wall time is ~10 minutes.

## Pointing the bootstrap endpoint at a release

The Convex deployment serves install scripts at
`/agent/install.ps1?t=<token>` and `/agent/install.sh?t=<token>`. Two
environment variables tell it where to download from:

- `AGENT_RELEASE_BASE_URL` — e.g. `https://github.com/<owner>/<repo>/releases/download/agent-v0.1.0`
- `AGENT_RELEASE_VERSION` — the tag, e.g. `agent-v0.1.0`

> The version string here matches the tag exactly (it includes the
> `agent-v` prefix). The bootstrap script's archive name uses the same
> token in `title-hub-agent-${version}-${target}.zip`.

### Automatic (recommended)

The release workflow's final job (`publish-to-convex`) sets these env
vars automatically using the same `CONVEX_SELF_HOSTED_URL` +
`CONVEX_SELF_HOSTED_ADMIN_KEY` secrets that `ci.yml` already uses for
`convex deploy`. Push a tag, the new agent build appears on GitHub
Releases, and the Convex deployment is repointed at it within ~30
seconds of the workflow finishing. No manual `convex env set` step.

If you re-run the workflow manually via `workflow_dispatch` and want to
keep the previous deployment pointer (e.g. you're republishing a build
with a hot fix in CI but don't want to surface it to customers yet),
set the **Update Convex env vars** input to `false`.

### Manual fallback

If the secrets aren't set on the repo (the `publish-to-convex` job logs
a warning and skips silently), or you want to roll back to a previous
release without recutting a tag:

```sh
npx convex env set AGENT_RELEASE_BASE_URL \
  "https://github.com/<owner>/<repo>/releases/download/agent-v0.1.0"
npx convex env set AGENT_RELEASE_VERSION agent-v0.1.0
```

After updating the env vars, the next install command generated in the
admin UI will pull from the new release. Existing already-pasted install
URLs continue to point at whatever version they were generated against —
the token TTL of 15 minutes bounds how stale they can be.

## Code signing

See [`agent/SIGNING.md`](./SIGNING.md) for procurement options and
step-by-step setup. The TL;DR: the modern path is **Azure Trusted
Signing** (~$10/mo, no hardware token, first-party GitHub Action),
which the release workflow uses automatically when six `AZURE_TS_*`
secrets are configured on the repo.

Until signing is enabled, the workflow logs a warning and ships an
unsigned `agent.exe`. The bootstrap script's SHA-256 integrity check
still proves the archive wasn't tampered with, but Windows SmartScreen
will flash a warning until reputation accrues — fine for the pilot,
not fine at scale.

## Verifying a release end-to-end

Once `AGENT_RELEASE_BASE_URL` + `AGENT_RELEASE_VERSION` are set:

1. In the admin UI, click "Generate install command" on a softpro_standard integration.
2. Copy the PowerShell one-liner.
3. Open a PowerShell window on a clean Windows VM.
4. Paste. The install runs end-to-end: download, checksum, extract, redeem the install token, write `agent.toml`.
5. The integration card in the admin UI flips from "offline" to "online" within ~60 seconds.

For Unix dev parity, the same flow with `bash` instead of `iwr`.

## Operational notes

- **Don't reuse a tag.** Once `agent-v0.1.0` is released and any agent
  has installed from it, recutting that tag with different content
  invalidates the SHA-256 the bootstrap script downloaded. Cut a new
  patch instead.
- **Keep `AGENT_RELEASE_VERSION` pinned to a real release.** A bare
  `latest` doesn't have a stable URL on GitHub and the bootstrap relies
  on a deterministic archive name.
- **Rotate signing certs annually.** OV certs expire; sign + republish
  before the cert goes stale, otherwise existing customers will see
  signature warnings on next start.
