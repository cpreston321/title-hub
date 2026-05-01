# Code signing — Windows

Without a code signature, Windows SmartScreen flashes "Windows protected
your PC — Microsoft Defender SmartScreen prevented an unrecognized app
from starting" the first time an IT admin runs the bootstrap script. The
bootstrap script verifies SHA-256 integrity, but that warning erodes
trust the moment a customer sees it.

This doc covers what to buy and how to wire it up. The release workflow
already supports two signing paths — pick one, populate the secrets,
re-tag.

## Background — why "just put a .pfx in CI" doesn't work anymore

Before 2023-06-01, you could buy an OV cert as a PKCS#12 file, store it
as a base64 secret, and have `signtool` use it from any CI runner. As
of the [CA/Browser Forum baseline requirements](https://cabforum.org/baseline-requirements-code-signing/)
that took effect on that date, **all newly issued code-signing private
keys must live on a FIPS 140-2 Level 2 hardware security module (HSM)**.
That includes both OV and EV — the distinction is now mostly about
SmartScreen behavior, not key storage.

Practical implication: you can no longer just download a .pfx and use
it in GitHub Actions. You either need (a) a self-hosted runner with a
hardware token plugged in, or (b) a cloud signing service that uses a
remote HSM you authenticate to. (b) is dramatically less painful.

## Choosing a path

### Recommended: Azure Trusted Signing

Microsoft's first-party answer to the HSM mandate. You authenticate to
Azure with an App Registration; the workflow signs over the wire
without ever touching a key.

- **Cost**: ~$10/mo Basic SKU + per-signature fees in the cents range.
- **Trust**: Microsoft-issued certificate, Microsoft-operated HSM,
  rapid SmartScreen reputation.
- **CI**: First-party GitHub Action (`azure/trusted-signing-action`).
- **Setup time**: ~30 minutes once your tenant is verified (verification
  itself takes 1–3 business days the first time).
- **Best for**: Most teams, including this one.

### Alternative: SignPath.io

Independent signing service that takes your existing cert (or sells you
one) and operates the HSM for you. Free tier for OSS, paid tiers for
commercial use.

- **Cost**: Free for OSS; commercial starts ~$30/mo per project.
- **CI**: Official GitHub Action (`signpath/github-action-submit-signing-request`).
- **Best for**: Teams that already have an EV cert from another CA and
  want to keep using it.

### Alternative: SSL.com eSigner

Cloud signing tied to an OV cert from SSL.com. Cheaper than EV but
SmartScreen warns until reputation accrues.

- **Cost**: ~$300/yr.
- **CI**: REST API or their `CodeSignTool` jar.
- **Best for**: Teams wanting a non-Microsoft trust path on a budget.

### Hardware-token EV cert

The non-cloud option: buy an EV cert from DigiCert/Sectigo/etc, plug
the YubiKey into a self-hosted GitHub Actions runner.

- **Cost**: $300–700/yr.
- **CI**: Requires self-hosted runner, can't use ubuntu/macos GitHub-hosted runners.
- **Best for**: Compliance regimes that mandate physical key custody.

---

## Setup — Azure Trusted Signing

### One-time procurement

1. **Verify your business with Microsoft Entra**. Either onboard a new
   Entra tenant or use an existing one. The signing certificate is
   issued to the legal entity that owns the tenant — make sure that
   matches the publisher name you want customers to see.

2. **Create a Trusted Signing account** in the Azure portal:
   - Search for "Trusted Signing", click *Create*.
   - Pick a region close to your CI runners (e.g. `eastus2`, `westus2`,
     or `westeurope`). The endpoint URL is region-specific.
   - Pick the **Basic** SKU for pilot scale.

3. **Identity validation.** Microsoft requires either:
   - **Public organization** validation (free) — they look you up via
     public business records (Dun & Bradstreet, secretary of state).
     1–3 business days.
   - **Private organization** validation ($) — for newer entities not in
     public registries.

4. **Create a certificate profile**. After validation completes:
   - In the Trusted Signing account, *Identity validation* → *Add new*.
   - Once approved, *Certificate profiles* → *Create*.
   - The "subject name" field is what shows up in the certificate's
     *Subject* attribute. Customers can look it up to confirm authenticity.

### App Registration for CI

1. **Microsoft Entra ID** → *App registrations* → *New registration*.
   Name it `title-hub-agent-signing` or similar. Single-tenant.
2. After creation, copy the **Application (client) ID** and the
   **Directory (tenant) ID**.
3. *Certificates & secrets* → *New client secret*. Copy the *Value*
   (it's only shown once). Set the expiry to ~6 months and put a
   reminder on your calendar — when it rotates, redeploy the GitHub
   secret.
4. **Grant the role** to the App Registration:
   - In the Trusted Signing account → *Access control (IAM)* → *Add
     role assignment*.
   - Role: **Trusted Signing Certificate Profile Signer**.
   - Assign access to: *User, group, or service principal* → pick the
     App Registration you just created.

### GitHub repo secrets

Add these to *Settings → Secrets and variables → Actions*:

| Secret                       | Value                                                                |
| ---------------------------- | -------------------------------------------------------------------- |
| `AZURE_TS_TENANT_ID`         | Directory (tenant) ID from above                                     |
| `AZURE_TS_CLIENT_ID`         | Application (client) ID                                              |
| `AZURE_TS_CLIENT_SECRET`     | Client secret value                                                  |
| `AZURE_TS_ENDPOINT`          | Region-scoped, e.g. `https://eus.codesigning.azure.net/`             |
| `AZURE_TS_ACCOUNT_NAME`      | The Trusted Signing account name                                     |
| `AZURE_TS_PROFILE_NAME`      | The certificate profile name                                         |

That's it. The next `agent-v*` tag you push will produce a signed
binary; the workflow's "Verify Windows signature" step prints
`signtool verify /pa /v` output so you can confirm in the run log.

## Setup — Legacy `.pfx` (grandfathered certs only)

The workflow's second signing path activates when `WINDOWS_CERT_BASE64`
and `WINDOWS_CERT_PASSWORD` are set and the Azure secrets are *not*. If
you have a pre-2023 cert that wasn't migrated to an HSM:

```sh
# Encode the .pfx for the secret value
base64 -i title-hub-agent.pfx | pbcopy   # macOS
base64 -w0 title-hub-agent.pfx | xclip   # Linux
```

Add the two secrets, push a tag. **Don't use this path for new certs**
— modern issuance won't give you a downloadable .pfx.

## Verifying a signed release

1. Push the tag, watch the workflow run. The "Verify Windows signature"
   step should print `Successfully verified` for `agent.exe`.
2. Download the .zip from the GitHub Release on a Windows VM.
3. Extract, right-click `agent.exe` → *Properties* → *Digital Signatures*.
   You should see your publisher name + a green "This digital signature
   is OK" status.
4. Run `agent.exe --version` from PowerShell. SmartScreen should not
   warn (with EV / Azure Trusted Signing) or warn-then-pass after
   reputation accrues (with OV).

## Operational notes

- **The signature changes the SHA-256.** The release workflow computes
  the checksum *after* signing, so the bootstrap script's integrity
  check still works.
- **Keep the App Registration secret rotated.** When it expires, the
  release workflow's signing step fails, but only on the next tag —
  set a calendar reminder a week ahead of expiry.
- **One App Registration per repo.** Don't reuse the same client secret
  across multiple unrelated projects; if it leaks, rotation is
  per-project.
- **Counter-signing.** Both signing paths in the workflow request a
  trusted timestamp from a third-party TSA (Microsoft for Azure,
  DigiCert for the legacy path). This means the signature stays valid
  even after the certificate expires — without it, customers running
  an old agent build see a signature warning the day after the cert
  rotates.
