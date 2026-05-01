// Generates the platform-specific install scripts served at
// /agent/install.ps1 (Windows) and /agent/install.sh (macOS/Linux). The
// scripts download the pre-built agent binary from a release URL configured
// via Convex env vars, verify SHA-256 checksums, then call
// `agent install --token --server` to redeem the install token and write
// the config.
//
// The token itself is the credential — anyone with the bootstrap URL can
// install an agent into the integration the token belongs to. Mitigations:
//   • 15-min TTL (set in `agentInstallTokens.expiresAt`)
//   • single-use redemption
//   • the bootstrap endpoint pre-validates the token, so a stale URL
//     fails fast with a clear hint instead of downloading a 30 MB binary.

const RELEASE_BASE_URL_ENV = 'AGENT_RELEASE_BASE_URL'
const RELEASE_VERSION_ENV = 'AGENT_RELEASE_VERSION'

export type BootstrapConfig = {
  serverUrl: string
  releaseBaseUrl: string
  releaseVersion: string
}

export function loadBootstrapConfig(siteUrl: string): BootstrapConfig {
  const releaseBaseUrl = process.env[RELEASE_BASE_URL_ENV]
  const releaseVersion = process.env[RELEASE_VERSION_ENV]
  if (!releaseBaseUrl) {
    throw new Error(
      `${RELEASE_BASE_URL_ENV} is not set. Configure it on the Convex deployment so the bootstrap endpoint knows where to download agent binaries from (e.g. https://github.com/<owner>/<repo>/releases/download/agent-v0.1.0).`
    )
  }
  if (!releaseVersion) {
    throw new Error(
      `${RELEASE_VERSION_ENV} is not set. Pin a specific agent version (e.g. v0.1.0) so the bootstrap script downloads a predictable artifact.`
    )
  }
  return {
    serverUrl: siteUrl,
    releaseBaseUrl: releaseBaseUrl.replace(/\/+$/, ''),
    releaseVersion,
  }
}

// File-name conventions match the GitHub Actions workflow at
// .github/workflows/agent-release.yml — change one, change both.
function archiveName(version: string, target: string, archive: 'zip' | 'tar.gz'): string {
  return `title-hub-agent-${version}-${target}.${archive}`
}

// ─── PowerShell (Windows) ────────────────────────────────────────────

export function renderPowerShellScript(cfg: BootstrapConfig, token: string): string {
  const v = cfg.releaseVersion
  const target = 'x86_64-pc-windows-msvc'
  const archive = archiveName(v, target, 'zip')
  const archiveUrl = `${cfg.releaseBaseUrl}/${archive}`
  const checksumUrl = `${archiveUrl}.sha256`
  const installRoot = '$env:ProgramData\\TitleHubAgent'

  return `# title-hub-agent bootstrap (Windows)
# Generated ${new Date().toISOString()} by ${cfg.serverUrl}
# Token expires soon — rerun if this script fails with an expired-token error.
$ErrorActionPreference = 'Stop'

$archiveUrl = '${archiveUrl}'
$checksumUrl = '${checksumUrl}'
$installRoot = "${installRoot}"
$token = '${token}'
$server = '${cfg.serverUrl}'

Write-Host "Title Hub agent installer" -ForegroundColor Cyan
Write-Host "  release : ${v}"
Write-Host "  target  : ${target}"
Write-Host "  install : $installRoot"
Write-Host ""

if (-not (Test-Path $installRoot)) {
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
}

$tmp = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP "title-hub-agent-$([guid]::NewGuid().ToString('N'))")
try {
  $archivePath = Join-Path $tmp 'agent.zip'
  $checksumPath = Join-Path $tmp 'agent.zip.sha256'

  Write-Host "Downloading $archiveUrl ..."
  Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath -UseBasicParsing
  Invoke-WebRequest -Uri $checksumUrl -OutFile $checksumPath -UseBasicParsing

  # Verify SHA-256 — proves the archive wasn't tampered with even if the
  # download URL or its CDN hop is compromised. The signing certificate
  # (when configured) is a stronger guarantee, but the checksum is the
  # backstop that always works.
  $expected = (Get-Content $checksumPath -Raw).Trim().ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLower()
  if ($expected -ne $actual) {
    throw "checksum mismatch: expected $expected, got $actual"
  }
  Write-Host "Checksum verified ($actual)"

  Expand-Archive -Path $archivePath -DestinationPath $installRoot -Force
  $exe = Join-Path $installRoot 'agent.exe'
  if (-not (Test-Path $exe)) { throw "agent.exe not found in archive" }
  Write-Host "Extracted to $installRoot"

  & $exe install --token $token --server $server --overwrite
  Write-Host ""
  Write-Host "Next: run \`& '$exe' doctor\` to verify connectivity, then \`& '$exe' run\` to start." -ForegroundColor Green
}
finally {
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
}
`
}

// ─── Bash (macOS / Linux) ────────────────────────────────────────────

export function renderShellScript(cfg: BootstrapConfig, token: string): string {
  const v = cfg.releaseVersion
  // Picked at runtime from `uname` output. The script knows about the three
  // targets the release workflow builds.
  return `#!/usr/bin/env bash
# title-hub-agent bootstrap (macOS / Linux)
# Generated ${new Date().toISOString()} by ${cfg.serverUrl}
# Token expires soon — rerun if this script fails with an expired-token error.
set -euo pipefail

RELEASE_BASE='${cfg.releaseBaseUrl}'
VERSION='${v}'
TOKEN='${token}'
SERVER='${cfg.serverUrl}'

case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in
      arm64|aarch64) TARGET=aarch64-apple-darwin ;;
      x86_64) TARGET=x86_64-apple-darwin ;;
      *) echo "unsupported macOS arch: $(uname -m)" >&2; exit 2 ;;
    esac ;;
  Linux)
    case "$(uname -m)" in
      x86_64|amd64) TARGET=x86_64-unknown-linux-gnu ;;
      *) echo "unsupported Linux arch: $(uname -m)" >&2; exit 2 ;;
    esac ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 2 ;;
esac

ARCHIVE="title-hub-agent-$VERSION-$TARGET.tar.gz"
ARCHIVE_URL="$RELEASE_BASE/$ARCHIVE"
CHECKSUM_URL="$ARCHIVE_URL.sha256"

INSTALL_ROOT="\${TITLEHUB_AGENT_HOME:-$HOME/.local/share/title-hub-agent}"
mkdir -p "$INSTALL_ROOT"

echo "Title Hub agent installer"
echo "  release : $VERSION"
echo "  target  : $TARGET"
echo "  install : $INSTALL_ROOT"
echo

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $ARCHIVE_URL ..."
curl -fsSL "$ARCHIVE_URL" -o "$TMP/agent.tar.gz"
curl -fsSL "$CHECKSUM_URL" -o "$TMP/agent.tar.gz.sha256"

EXPECTED=$(tr -d '\\n\\r ' < "$TMP/agent.tar.gz.sha256")
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$TMP/agent.tar.gz" | awk '{print $1}')
else
  ACTUAL=$(shasum -a 256 "$TMP/agent.tar.gz" | awk '{print $1}')
fi
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "checksum mismatch: expected $EXPECTED, got $ACTUAL" >&2
  exit 3
fi
echo "Checksum verified ($ACTUAL)"

tar -C "$INSTALL_ROOT" -xzf "$TMP/agent.tar.gz"
EXE="$INSTALL_ROOT/agent"
if [ ! -x "$EXE" ]; then
  echo "agent binary not found in archive" >&2
  exit 4
fi
echo "Extracted to $INSTALL_ROOT"

"$EXE" install --token "$TOKEN" --server "$SERVER" --overwrite
echo
echo "Next: run '$EXE doctor' to verify connectivity, then '$EXE run' to start."
`
}
