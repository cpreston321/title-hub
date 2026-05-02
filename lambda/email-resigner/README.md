# Email re-signer Lambda

Reference code for forwarding inbound mail from a non-Postmark provider
(SES, Mailgun, SendGrid, custom SMTP server) into Title Hub.

## TL;DR — most teams don't need this

If you can use Postmark Inbound, the re-signer is unnecessary. Configure
Postmark to POST directly to:

```
POST https://<your-deployment>.convex.site/integrations/email/postmark
Authorization: Basic <base64("user:pass")>
```

Set `POSTMARK_INBOUND_AUTH=user:pass` in the Convex environment so the
route can verify the credential.

Routing happens server-side via Postmark's `MailboxHash` field, mapped
onto each tenant's `email_inbound` integration via
`config.forwardAddressLocalPart` (defaults to the integration id).

## When you need this Lambda

- **AWS SES** — SES doesn't speak Postmark JSON. Land mail in S3, parse
  it via `mailparser` or AWS SES inbound rule, then call this Lambda.
- **Mailgun / SendGrid Inbound Parse** — different field names, but
  every field has a Postmark counterpart.
- **Self-hosted SMTP** — your relay forwards each message to this Lambda
  in any JSON shape you define; add an adapter alongside `sesToEnvelope`.
- **Pre-filtering** — strip auto-replies, drop calendar invites, redact
  attachments before they hit Title Hub.

## Configuration (env)

| Variable                     | Purpose                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| `TITLE_HUB_SITE_URL`         | The deployment's `.convex.site` base URL                             |
| `TITLE_HUB_POSTMARK_AUTH`    | `user:pass` matching Convex's `POSTMARK_INBOUND_AUTH` env            |

## Per-tenant routing

Each tenant's `email_inbound` integration has a unique
`forwardAddressLocalPart` (defaults to the integration id). Configure the
agency to forward mail to:

```
mail-<localPart>@<your-inbound-domain>
```

Title Hub extracts the local-part suffix from the `MailboxHash` field
(or `OriginalRecipient` if `MailboxHash` is empty), and routes accordingly.

## Deployment notes

- **AWS Lambda (Node 20)**: drop `index.ts` into a Lambda, attach an SNS
  trigger that fires on SES inbound, and the `handler` export is the
  entrypoint. Compile to JS first (`bun build` or `tsc`).
- **Cloudflare Workers**: replace the SNS handler with a fetch handler
  that pulls the provider payload off `request.json()`.
- **Bun standalone**: `bun run index.ts` — useful for self-hosted SMTP
  forwarders running on a small VM next to the mail server.

## Testing

You don't need to deploy this Lambda to test the inbound pipeline. The
`bun run admin simulate-email` CLI signs and posts directly to the
per-integration HMAC route — no provider involved.
