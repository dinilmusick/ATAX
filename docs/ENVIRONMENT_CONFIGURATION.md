# ATAX MCP environment contract — single URL (supersedes legacy inventory)

**Effective 2026-11-23:** This document replaces the previous requirement to configure multiple GitHub, Cloudflare, owner-auth and Supabase Worker environment variables.

For the **remote ATAX MCP runtime only**, configure exactly one secret:

```dotenv
SUPABASE_URL=https://<project>.supabase.co/#key=<privileged-server-key>
```

The full URL is **server-side secret material**. It is accepted only by the server loader; the fragment is stripped before HTTPS requests. A plain public Supabase origin is insufficient. This variable must not be exposed to a browser, static Vercel client bundle or `VITE_*` / `NEXT_PUBLIC_*` setting. On Cloudflare use `wrangler secret put SUPABASE_URL`; do not use `[vars]`.

All other configuration is taken from the **canonical Supabase ledger**, not from deployment environment variables:

| Database configuration | Storage and access |
| --- | --- |
| Multiple GitHub, Cloudflare and Vercel account credentials | Supabase Vault with opaque connection IDs; server-only controlled hydration |
| MCP owner subject, authentication and scopes | `atax_mcp_server_settings`, accessible through privileged backend only |
| Restricted socket auth, approved workflows and model policy | Same canonical server settings with allowlisted keys |
| FMRL allowed targets and owner policy | Same server settings, never client-controlled |
| Provider account IDs, aliases, enabled state | `atax_mcp_provider_credentials`; UI receives masked metadata |

The exact schema/RPCs and UI responsibilities are in [MCP ledger configuration and UI handoff](MCP_LEDGER_CONFIG_UI_HANDOFF.md). The previous `SUPABASE_SECRET_KEY`, `GH_KEY_*`, `CF_KEY_*`, `MCP_*` and `SOCKET_*` *runtime environment* setup instructions are **retired**; do not reintroduce them. Values with these names may appear in internal compatibility objects hydrated from database state, but they are not host bindings.

**Scope boundary:** Direct ChatGPT GitHub + Supabase connectors and their independent, trusted GitHub Actions/CLI operations are unchanged. They may have separate deployment-only secrets and must not be routed through MCP. No Vercel MCP adapter is certified yet. The UI itself will be built by the Google AI Studio/Hydrogen agent; source-only code is not proof of live production readiness.
