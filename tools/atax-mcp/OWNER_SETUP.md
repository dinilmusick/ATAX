# ATAX remote MCP — one Supabase URL, ledger-managed accounts

The **remote MCP** is an alternative interface to the canonical ATAX ledger for external transient agents. It is independent of the direct GitHub + Supabase connector workflow and GitHub-only ledger bridge. Those modes stay unchanged.

## Only runtime environment binding

```dotenv
SUPABASE_URL=https://<project>.supabase.co/#key=<privileged-server-key>
```

Set the **entire URL as a Cloudflare Worker secret** with `wrangler secret put SUPABASE_URL`. Its fragment contains the backend bootstrap key and must never be exposed to a browser or log. Do not configure extra Worker environment variables for Supabase, owner login, GitHub accounts, Cloudflare accounts, Vercel accounts, FMRL allowlists or Socket auth. Those are stored in the canonical database.

The backend hydrates current allowlisted policy from `atax_mcp_server_settings` and active Vault-backed credentials from `atax_mcp_provider_credentials` via service-role-only `atax_mcp_runtime_config_v1()`. Credential values are never returned to MCP clients or browser UI. A new Google AI Studio/Hydrogen-designed **authenticated settings UI** will create/rotate/disable connections through a trusted server adapter; for now absent configuration fails closed.

The provider account selection contract remains the same: when multiple accounts exist, clients select a named alias. Github creates permanent repositories separately from disposable FMRL CI. FMRL requires exact revision, approved target, external execution, cleanup and independently observed 404. No private target work in ATAX Actions. The restricted Socket Worker remains separately host-isolated and subject to release certification.

**Vercel:** account credentials may now be stored in Supabase Vault for the planned UI; MCP Vercel tools are not yet operational. Do not display them as connected until an adapter and live check exist.

Follow [MCP ledger configuration and UI handoff](../../docs/MCP_LEDGER_CONFIG_UI_HANDOFF.md) and [connection modes](../../docs/connection-modes.md). The original multi-secret Worker setup, root `.env.example` inventory, and read-only-only UI assumptions are superseded. The existing direct connector path is **not** migrated.
