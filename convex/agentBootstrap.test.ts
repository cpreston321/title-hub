/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  loadBootstrapConfig,
  renderPowerShellScript,
  renderShellScript,
} from './agentBootstrap'

describe('agent bootstrap script generation', () => {
  const ORIGINAL_ENV = { ...process.env }
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })
  afterEach(() => {
    process.env = ORIGINAL_ENV
  })

  test('loadBootstrapConfig requires AGENT_RELEASE_BASE_URL', () => {
    delete process.env.AGENT_RELEASE_BASE_URL
    process.env.AGENT_RELEASE_VERSION = 'v0.1.0'
    expect(() => loadBootstrapConfig('https://x.convex.site')).toThrow(
      /AGENT_RELEASE_BASE_URL/
    )
  })

  test('loadBootstrapConfig requires AGENT_RELEASE_VERSION', () => {
    process.env.AGENT_RELEASE_BASE_URL = 'https://github.com/x/y/releases/download/agent-v0.1.0'
    delete process.env.AGENT_RELEASE_VERSION
    expect(() => loadBootstrapConfig('https://x.convex.site')).toThrow(
      /AGENT_RELEASE_VERSION/
    )
  })

  test('loadBootstrapConfig strips trailing slashes from the release URL', () => {
    process.env.AGENT_RELEASE_BASE_URL = 'https://example.com/releases//'
    process.env.AGENT_RELEASE_VERSION = 'v0.1.0'
    const cfg = loadBootstrapConfig('https://x.convex.site')
    expect(cfg.releaseBaseUrl).toBe('https://example.com/releases')
    expect(cfg.releaseVersion).toBe('v0.1.0')
    expect(cfg.serverUrl).toBe('https://x.convex.site')
  })

  function cfg() {
    return {
      serverUrl: 'https://example.convex.site',
      releaseBaseUrl: 'https://github.com/owner/repo/releases/download/agent-v0.1.0',
      releaseVersion: 'v0.1.0',
    }
  }

  test('powershell script downloads the windows-msvc archive', () => {
    const ps = renderPowerShellScript(cfg(), 'a'.repeat(64))
    expect(ps).toContain('title-hub-agent-v0.1.0-x86_64-pc-windows-msvc.zip')
    expect(ps).toContain('agent-v0.1.0/title-hub-agent-v0.1.0-x86_64-pc-windows-msvc.zip')
    expect(ps).toContain('agent-v0.1.0/title-hub-agent-v0.1.0-x86_64-pc-windows-msvc.zip.sha256')
    expect(ps).toContain('Get-FileHash -Algorithm SHA256')
  })

  test('powershell script embeds the token + server', () => {
    const token = 'b'.repeat(64)
    const ps = renderPowerShellScript(cfg(), token)
    expect(ps).toContain(`$token = '${token}'`)
    expect(ps).toContain(`$server = 'https://example.convex.site'`)
    // And the actual install command uses both.
    expect(ps).toContain('install --token $token --server $server')
  })

  test('powershell script installs into ProgramData by default', () => {
    const ps = renderPowerShellScript(cfg(), 'a'.repeat(64))
    expect(ps).toContain('$env:ProgramData\\TitleHubAgent')
  })

  test('shell script picks the right target via uname', () => {
    const sh = renderShellScript(cfg(), 'c'.repeat(64))
    expect(sh).toContain('aarch64-apple-darwin')
    expect(sh).toContain('x86_64-apple-darwin')
    expect(sh).toContain('x86_64-unknown-linux-gnu')
    // Each line we test is a unique bash construct, not a substring of
    // the URL — protects against accidental double-quoting.
    expect(sh).toMatch(/case "\$\(uname -s\)"/)
    expect(sh).toMatch(/case "\$\(uname -m\)"/)
  })

  test('shell script verifies the checksum before extracting', () => {
    const sh = renderShellScript(cfg(), 'c'.repeat(64))
    expect(sh).toContain('checksum mismatch')
    // Checksum comparison happens before the tar extract.
    const checksumIdx = sh.indexOf('checksum mismatch')
    const extractIdx = sh.indexOf('tar -C')
    expect(checksumIdx).toBeLessThan(extractIdx)
  })

  test('shell script embeds the token + server', () => {
    const token = 'd'.repeat(64)
    const sh = renderShellScript(cfg(), token)
    expect(sh).toContain(`TOKEN='${token}'`)
    expect(sh).toContain(`SERVER='https://example.convex.site'`)
    expect(sh).toContain('install --token "$TOKEN" --server "$SERVER"')
  })
})
