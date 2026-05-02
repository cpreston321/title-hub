/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { parseAuthResults, scoreEmail } from './spamScore'

describe('spamScore — deterministic scorer', () => {
  test('clean tier when DMARC + SPF pass and nothing fires', () => {
    const r = scoreEmail({
      fromAddress: 'agent@example.com',
      fromName: 'Jane Agent',
      subject: 'Re: file 25-001234',
      bodyText: 'Attached.',
      auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    })
    expect(r.tier).toBe('clean')
    expect(r.score).toBe(0)
    expect(r.signals.find((s) => s.id === 'dmarc_pass')).toBeDefined()
    expect(r.signals.find((s) => s.id === 'spf_pass')).toBeDefined()
  })

  test('high_risk tier when DMARC fails AND display name spoofs', () => {
    const r = scoreEmail({
      fromAddress: 'lookatme@evil.example',
      fromName: 'support@chase.com',
      subject: 'Updated wire instructions',
      auth: { spf: 'fail', dkim: 'fail', dmarc: 'fail' },
    })
    expect(r.tier).toBe('high_risk')
    expect(r.score).toBeGreaterThanOrEqual(61)
    const ids = r.signals.map((s) => s.id)
    expect(ids).toContain('dmarc_fail')
    expect(ids).toContain('display_name_spoof')
    expect(ids).toContain('spf_fail')
    expect(ids).toContain('dkim_fail')
  })

  test('reply_to_divergence flags BEC-style redirects', () => {
    const r = scoreEmail({
      fromAddress: 'broker@realestate.example',
      replyToAddress: 'attacker@scam.example',
      subject: 'Wire instructions',
      auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    })
    expect(r.signals.find((s) => s.id === 'reply_to_divergence')).toBeDefined()
    // pass -15 (dmarc) -5 (spf) + 25 (reply_to) = 5 → still clean
    expect(r.tier).toBe('clean')
  })

  test('punycode lookalike adds weight', () => {
    const r = scoreEmail({
      fromAddress: 'admin@xn--paypa1-i7a.com',
      auth: { spf: 'pass', dmarc: 'pass' },
    })
    const ids = r.signals.map((s) => s.id)
    expect(ids).toContain('lookalike_punycode')
  })

  test('auth_missing fires when no verdicts arrive', () => {
    const r = scoreEmail({
      fromAddress: 'someone@example.com',
      subject: 'hello',
    })
    expect(r.signals.find((s) => s.id === 'auth_missing')).toBeDefined()
    // 10 → still clean
    expect(r.tier).toBe('clean')
  })

  test('parseAuthResults extracts spf/dkim/dmarc verdicts', () => {
    const v = parseAuthResults(
      'postmark.smtpapi.postmarkapp.com; spf=pass smtp.mailfrom=foo@example.com; dkim=pass header.d=example.com; dmarc=pass action=none header.from=example.com'
    )
    expect(v).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' })
  })

  test('parseAuthResults handles fail/none/etc.', () => {
    const v = parseAuthResults('mx.example; spf=softfail; dkim=none; dmarc=fail')
    expect(v).toEqual({ spf: 'softfail', dkim: 'none', dmarc: 'fail' })
  })

  test('parseAuthResults returns empty for missing input', () => {
    expect(parseAuthResults(undefined)).toEqual({})
    expect(parseAuthResults(null)).toEqual({})
    expect(parseAuthResults('')).toEqual({})
  })

  test('score is clamped to [0, 100] under heavy stacking', () => {
    const r = scoreEmail({
      fromAddress: 'attacker@xn--evil-vfa.example',
      fromName: 'support@chase.com',
      replyToAddress: 'phisher@drop.example',
      subject: 'updated wire — urgent ASAP',
      bodyText: '> on tuesday i wrote\n> please send the wire',
      auth: { spf: 'fail', dkim: 'fail', dmarc: 'fail' },
    })
    expect(r.score).toBeLessThanOrEqual(100)
    expect(r.score).toBeGreaterThanOrEqual(61)
    expect(r.tier).toBe('high_risk')
  })
})
