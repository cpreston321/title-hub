/**
 * Pluggable crypto helpers for NPI tokenization (TECHINAL-SPEC §4).
 *
 * - "mock" provider: Web Crypto AES-GCM with a 256-bit key stored in the
 *   tenantCryptoKeys table. Suitable for local dev and CI; NOT for production.
 * - "aws-kms" provider: stub for now. When enabled, replace the encrypt /
 *   decrypt / generateRawKey calls with AWS KMS Encrypt/Decrypt/GenerateDataKey
 *   action calls. The schema is provider-agnostic (keyRef holds either
 *   "mock:<id>" or the real KMS ARN).
 */

export type CryptoProvider = "mock" | "aws-kms"

export function activeProvider(): CryptoProvider {
  const v = process.env.NPI_CRYPTO_PROVIDER
  return v === "aws-kms" ? "aws-kms" : "mock"
}

const TOKEN_BYTES = 16

export function newToken(): string {
  const buf = new Uint8Array(TOKEN_BYTES)
  crypto.getRandomValues(buf)
  return "npi_tok_" + Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function generateRawKey(): ArrayBuffer {
  const buf = new Uint8Array(32) // 256-bit
  crypto.getRandomValues(buf)
  // Detach into a fresh ArrayBuffer to satisfy v.bytes()
  const out = new ArrayBuffer(32)
  new Uint8Array(out).set(buf)
  return out
}

function newIv(): ArrayBuffer {
  const buf = new Uint8Array(12) // 96-bit IV for AES-GCM
  crypto.getRandomValues(buf)
  const out = new ArrayBuffer(12)
  new Uint8Array(out).set(buf)
  return out
}

async function importAesKey(rawKey: ArrayBuffer): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

export async function encryptWithRawKey(
  rawKey: ArrayBuffer,
  plaintext: string,
): Promise<{ ciphertext: ArrayBuffer; iv: ArrayBuffer }> {
  const key = await importAesKey(rawKey)
  const iv = newIv()
  const data = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data)
  return { ciphertext, iv }
}

export async function decryptWithRawKey(
  rawKey: ArrayBuffer,
  ciphertext: ArrayBuffer,
  iv: ArrayBuffer,
): Promise<string> {
  const key = await importAesKey(rawKey)
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext)
  return new TextDecoder().decode(data)
}
