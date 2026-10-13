# Mail domain verification

Mail domains are workspace-scoped. Verification is an owner/admin action and is
audited because the `verified` flag changes how the agent send-kit guard classifies
recipients.

## Verify a domain

1. Open **Domains** in Email-Ops and select the workspace domain.
2. Choose **Generate TXT record**. Email-Ops creates a fresh 32-byte challenge.
3. At the domain's DNS provider, add the displayed record:
   - Name: `_emailops-verify.<domain>`
   - Type: `TXT`
   - Value: `emailops-verify=<token>`
4. Wait for DNS propagation, then choose **Check now**.

The API routes are workspace-scoped:

- `GET /workspaces/:workspaceId/mail-domains`
- `POST /workspaces/:workspaceId/mail-domains/:id/verification`
- `POST /workspaces/:workspaceId/mail-domains/:id/verification/check`

The read-only MCP tools `list_mail_domains` and
`get_mail_domain_verification` expose the state and TXT instructions to a member.
There is no MCP write that changes `verified`.

## What verified gates

The existing send-kit guard reads `MailDomain.verified`. Only a domain with
`verified: true` is treated as internal by that guard; an unverified binding does
not grant internal-recipient treatment.

The scheduled daily DNS re-check updates `lastVerificationCheckAt` and records
`lastVerificationError` when the TXT record is missing, mismatched, or DNS fails.
It deliberately does **not** set `verified` back to `false`; a human must decide
whether a previously verified domain should lose that state.
