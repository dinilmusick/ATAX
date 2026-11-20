# Invite-only ATAX hosted MCP: operator and developer setup

**Mode:** One Cloudflare Worker, isolated Supabase substrates owned by individual invited developers. ATAX stores persistent state; it never spawns, schedules or hosts resident agents.

## Public URLs

- MCP: `https://atax-mcp.dextro1n1laevo.workers.dev/mcp`
- Developer credential setup: `https://atax-mcp.dextro1n1laevo.workers.dev/setup`
- Health: `https://atax-mcp.dextro1n1laevo.workers.dev/health`
- OAuth protected-resource metadata: `/.well-known/oauth-protected-resource`

**Sharing a URL is not authorization.** The owner issues a separate high-entropy, expiring invitation access key for each developer (or invites a verified JWT subject if an OAuth identity provider is configured). The key is stored **only as a SHA-256 digest** in Cloudflare D1 and can be revoked immediately. All requests are checked against the current invite registry; revocation is immediate at the Worker boundary. In hosted mode, legacy shared bearer tokens are refused.

## Provisioning: Cloudflare account dextro1n1laevo

Account: `38bdf043bc4cb132cfc22b13d597ca2e`.

1. D1 `atax-mcp-tenants`, ID `4035dd75-8fed-4c08-ac6a-a8b10c09417b`, APAC, with `tools/atax-mcp/sql/tenant-registry.sql` applied. The Worker binding name is `ATAX_TENANTS`.
2. The secret `MCP_VAULT_KEY_B64` must be a **random base64-encoded 32-byte key**. It is generated/stored directly in Cloudflare, not committed or printed. **Back up this encryption key in a secure owner-controlled vault. Replacing it without a migration makes existing connections undecryptable.**
3. **Optional OAuth mode:** Configure OIDC issuer credentials through Cloudflare secret bindings (do not put them in `wrangler.toml`):
   - `MCP_AUTH_JWKS_URL` — the provider's **HTTPS JWKS URL**, signing RS256 tokens.
   - `MCP_AUTH_ISSUER` — exact `iss` value.
   - `MCP_AUTH_AUDIENCE` — exact `aud` value for ATAX MCP.
   - `MCP_ADMIN_SUBJECT` — exact stable `sub` of the administrator's OIDC access token.
   - `MCP_AUTH_AUTHORIZATION_SERVER` — recommended: issuer's OAuth 2.1 authorization server URL for MCP client discovery.
4. `MCP_MULTI_TENANT_ENABLED = "true"` and `MCP_INVITATIONS_ENABLED = "true"` are set in `wrangler.toml`. Hosted mode requires D1, the encryption key, and **either** revocable invitation keys **or** complete signed JWT configuration. Unknown/uninvited callers fail closed. For native OAuth clients, configure the optional OIDC provider.
5. Deploy the exact reviewed `main` commit using `.github/workflows/atax-mcp-deploy.yml` or `wrangler deploy --config tools/atax-mcp/wrangler.toml`. Verify Cloudflare deployment version + actual authenticated and denied calls. The CI test suite cannot substitute for live proof.

If using **OAuth mode**, an external OAuth identity provider must issue distinct signed access tokens with `sub`, `scope`, `iss`, `aud` and `exp` claims. An email address supplied by a user in a request is **not** identity proof. For ChatGPT/other MCP clients, that provider must also support OAuth authorization-code + PKCE consent and client registration/metadata compatible with the MCP specification. **The Worker is an OAuth resource server, not an authorization server.** For **invite-key mode**, a compatible MCP client must allow a manually configured `Authorization: Bearer <invitation-key>` header; clients that require automatic OAuth consent need the optional identity-provider setup. The URL alone never grants access.

## Preferred invitation flow: operator-managed access keys (no external OAuth required)

On a **trusted owner-controlled machine** with Cloudflare Wrangler authenticated to the correct account, run from the ATAX repository root:

```bash
# Create an access key for one developer; default validity 30 days, max 365 days.
node tools/atax-mcp/invite-cli.mjs issue guest-01 atax:read,atax:write,atax:github:read,atax:github:create,atax:github:ci,atax:cloudflare:read,atax:vercel:read 30

# Revoke immediately, remove all keys and encrypted provider connections.
node tools/atax-mcp/invite-cli.mjs revoke guest-01
```

The CLI inserts or updates the allowlisted subject, stores **only the key hash** in D1 and prints the random invitation key **once after the remote write succeeds**. Send that key privately to the intended developer. Do not run this CLI in CI or a shared terminal, and never paste keys into repositories or chat. The same subject can have multiple expiring keys; use revocation for full subject access cancellation. A user with a revoked or expired key cannot authenticate.

To use ATAX, the developer opens the **setup page** on the same Worker host, enters their key and stores their own credentials. They then connect an MCP client with `/mcp` and a bearer authorization header containing the invitation key. Cloudflare D1 remains your invitation and encrypted-connection registry; each developer's actual ATAX system state is in **their own Supabase**.

### Optional owner JWT administration

## Invite and revoke OAuth JWT subjects

The administrator receives their own signed JWT with `atax:admin` and a `sub` exactly matching `MCP_ADMIN_SUBJECT`. From a trusted environment (not a chat), call:

```bash
MCP_BASE='https://atax-mcp.dextro1n1laevo.workers.dev'
# JWT is available securely as an environment variable; never paste it into source.
curl --fail-with-body -X POST "$MCP_BASE/api/admin/invites" \
  -H "Authorization: Bearer $MCP_ADMIN_JWT" \
  -H 'Content-Type: application/json' \
  --data '{"subject":"verified-oidc-subject","scopes":["atax:read","atax:write","atax:github:read","atax:github:create","atax:cloudflare:read","atax:vercel:read"]}'
```

The invite registry supports `GET /api/admin/invites` and `DELETE /api/admin/invites/<subject>`. Revoking a subject denies its JWT and deletes all encrypted provider connections and invitation keys. Independent verifiers require **distinct principals** and `atax:verify` consent. Never give `atax:admin` to ordinary invitees.

## Developer setup: bring your own connections

The invited developer obtains their **personal invitation key** from the operator (or their own short-lived JWT from an approved OAuth provider), opens `/setup` on the Worker hostname, and uses the same-origin form. Credentials are sent directly over HTTPS to the Worker (not via ChatGPT tool arguments, chat, query strings, public repository history or logs). The browser form holds the bearer key/token in memory only and never caches credentials.

Provider connection names use uppercase aliases, e.g. `PERSONAL` or `WORK`. One developer may connect multiple GitHub, Cloudflare and Vercel accounts. `GET /api/connections` returns metadata **only**; `POST /api/connections` securely adds or rotates a credential; `DELETE /api/connections/<provider>/<alias>` deletes it.

| Provider | Developer-supplied configuration | Access isolation |
| --- | --- | --- |
| Supabase | `url` exactly `https://<project>.supabase.co`, `token` as a server-side `sb_secret_...` key (or legacy service role), alias `DEFAULT` | Calls go only to this developer's project; missing entry **never** falls back to the owner's canonical DB |
| GitHub | `token` (scoped OAuth/PAT), aliases `PERSONAL`, `WORK`, etc. | The Worker verifies token's `/user` account on registration and the GitHub API enforces its permissions |
| Cloudflare | `token`, optional `account_id` and alias | Script/observability reads use only that token and its optional account pin |
| Vercel | `token`, optional `team_id` and alias | Project/deployment reads use only that token and its optional team pin |

**Security warning:** A Supabase secret/service-role key is highly privileged within the developer's own project. Use a dedicated ATAX project, never provide the owner's canonical project key, and review access revocation and project scope. Every developer must independently install the ATAX Supabase schema/migrations in their own project; providing a Data API key does **not** create database tables or functions.

Tenant provider operations include governed GitHub repository actions, **GitHub Actions workflow discovery plus public/private-repository CI dispatch and exact run checks (execution inside each developer's own GitHub repository)**, **Cloudflare Worker deployment and observability summaries**, and **Vercel deployment build-event diagnostics**; separate provider-native OAuth connections are needed for more advanced deployment-management operations. Private-target FMRL CI on the owner's controller is deliberately **disabled** for hosted tenants until their own disposable-controller lifecycle is independently certified. The platform must never run unknown users' private code inside ATAX Actions.

## Operator verification gate

Require all of the following *before* issuing invitations: invitation-key hash matching/expiry/revocation (and JWT/OAuth discovery if enabled), two users with separate Supabase project credentials, separate Cloudflare/Vercel/GitHub accounts, scope denial, malformed input, provider token rotation, wrong-user deny, exact deployed Worker revision, verified no credential leakage, and independently reviewed evidence. A green mock CI alone does not certify this environment.

Failure treatment:
- 503: missing Worker authentication/vault bindings or provider outage; fail closed.
- 401: no valid signed JWT or unexpired/revoked invitation key.
- 403: valid identity but not invited, revoked, or insufficient scope.
- MCP tool error: provider credentials missing, invalid, revoked, or wrong account, or the developer's ATAX Supabase schema is not installed.

No ATAX access token, provider token, JWT signing key, or Supabase service-role key belongs in GitHub, chat, build logs, or public artifacts.
