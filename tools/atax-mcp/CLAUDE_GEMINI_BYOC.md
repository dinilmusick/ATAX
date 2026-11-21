# ATAX BYOC MCP — portable Claude/Gemini onboarding

ATAX is hosted at one Cloudflare Worker, but **every client supplies its own GitHub and Supabase credentials and uses its own durable ledger**. No Luth, ULTRST login, operator GitHub/Supabase fallback or Worker-owned credential encryption key is required.

## MCP configuration

- URL: `https://atax-mcp.dextro1n1laevo.workers.dev/mcp`
- Transport: Streamable HTTP (JSON-RPC).
- Client authorization: ATAX-owned OAuth with public-client Dynamic Client Registration and Authorization Code + PKCE S256. No client secret is required.
- Separate user-held Github token and Supabase URL/key are entered only on the first-party HTTPS consent screen. Optional Cloudflare and Vercel API tokens can be provided separately, with account/team bindings.

**Note:** The BYOC OAuth source is presently in ATAX PR #1606, not the production Worker. Do not claim the public URL supports this new flow until deployed and independently tested.

## First connection

1. In a supported MCP connector (Claude/Gemini), enter the HTTPS `/mcp` URL and use dynamic OAuth client registration.
2. On the ATAX-hosted consent page, review the unverified client name, exact redirect URI, and requested permissions. Never paste provider credentials into a chat or MCP tool call.
3. Supply a fine-grained GitHub token with permissions appropriate to the exact repositories and actions, and your own Supabase project HTTPS URL and server-side secret API key.
4. **Optional:** Add your Cloudflare API token and a 32-hex-digit Cloudflare account ID, and/or a Vercel token and team ID. ATAX checks the provider token identity before encrypting these connections. Missing optional tokens do not trigger operator-account fallback.
5. Access tokens expire after 15 minutes. Refresh tokens rotate. Revocation invalidates the token family.

## Empty Supabase project: supported bootstrap-only mode

The gateway does **not** share the operator's canonical ATAX ledger. If `agent_context_overview` is unavailable in your selected Supabase project, the new OAuth session is restricted to GitHub bootstrap workflow installation and Actions run discovery. No task claiming, goal writes, independent verification, or unrestricted GitHub mutations are available.

1. Call `atax_supabase_bootstrap_workflow_create` with an authorized GitHub repository and its exact default branch. It creates a fixed, no-overwrite Actions workflow using reviewed ATAX schema commit `d182e89a590a088bebd3aa18add8891ad3001fb2` and Supabase CLI 3.2.0.
2. **In your own GitHub repository**, add `ATAX_BOOTSTRAP_DATABASE_URL` under Settings → Secrets and variables → Actions. Use the PostgreSQL connection string of **your dedicated Supabase project**. Never supply it through an MCP argument or chat.
3. Trigger `ATAX tenant database bootstrap` in that repository using GitHub Actions, or use the authorized `atax_github_actions_dispatch` tool. The workflow applies the pinned ATAX migrations to the *specified* database, then checks canonical tables and migration history. It does not reset the database.
4. Inspect the exact GitHub Actions run and its terminal success, then **reconnect / reauthorize OAuth** to activate normal ATAX ledger tools. A bootstrap-only token never automatically escalates to normal privileges.
5. The bootstrap workflow can be independently reviewed in your own repository before execution. Existing populated projects should be migrated only after their owner has assessed schema compatibility and backups.

## Tenant-owned FMRL and CI

- **Public targets:** `atax_fmrl_public_start` creates a disposable public CI repository under the authenticated GitHub user. It checks out only an exact verified public target SHA, runs a bounded test suite, and returns a dispatch acknowledgement. External agents must poll `atax_fmrl_public_status` until terminal status; this attempts deletion and verifies independent anonymous 404. Failed tests or missing cleanup are **not** success.
- **Private targets:** `atax_fmrl_private_workflow_create` installs a reviewed owner-specific GitHub Actions controller in *your private target repository*. In its own GitHub Actions secrets, configure `ATAX_FMRL_REPO_WRITE_TOKEN`, `ATAX_FMRL_SOURCE_READ_TOKEN`, `ATAX_FMRL_ACTIONS_SECRET_TOKEN`, and `ATAX_FMRL_ACTIONS_DISPATCH_TOKEN`. Dispatch with exact target `target_sha` and mode `direct` or `act` using `atax_github_actions_dispatch`; verify the terminal run using `atax_github_actions_run_status`. The existing pinned ATAX FMRL scripts create and run a disposable public bridge while keeping private source and private ref in encrypted GitHub Actions secrets, then delete the bridge even when tests fail. The user must grant the scoped tokens access to newly created disposable repositories.
- **Never use** legacy `atax_fmrl_create_run_dispose` or the hard-coded `dinilmusick/ATAX` controller as another user's FMRL workspace.
- Workflow dispatch is not evidence of execution; task completion requires exact-run results, cleanup proof and independent review.

## Provider diagnostics

`atax_github_actions_run_status` and `atax_github_actions_check_annotations` return exact job states and bounded error annotations. Optional provider tokens activate `atax_cloudflare_accounts_list`, `atax_cloudflare_workers_list`, `atax_cloudflare_builds_list`, `atax_cloudflare_build_logs`, `atax_vercel_projects_list`, `atax_vercel_deployments_list`, and `atax_vercel_build_events`. Build logs are bounded and redact known credentials; they never authorize deployments on their own.

## Run a real two-user OAuth certification (after Worker deployment)

The repository includes `node tools/atax-mcp/live-e2e.mjs`, a real HTTP test of independent registration, consent, PKCE, scoped `initialize`, `tools/list`, canonical read and token-family revocation. Run it only with **two different GitHub users and two independent migrated Supabase test projects**, using process environment variables injected from a local secret manager or private ephemeral runner.

Required environment names: `ATAX_LIVE_WORKER_URL` (exact HTTPS origin, not the `/mcp` path), `ATAX_LIVE_GITHUB_TOKEN_A`, `ATAX_LIVE_SUPABASE_URL_A`, `ATAX_LIVE_SUPABASE_KEY_A`, and the corresponding three `_B` variables. Do not send their values in chat, create GitHub issues from them, commit them to source code, or run this test in an untrusted fork's pull-request workflow. The script prints only an outcome summary, never credentials or raw ledger data, and revokes the test OAuth token families. Run separate native Claude and Gemini connector login tests, since a scripted OAuth test does not prove either client's UI or compatibility.

## Release and certification gate

As of 2026-11-21 these source paths require final exact-head CI, independent security review, real tenant GitHub/Supabase/Cloudflare/Vercel checks and live Claude/Gemini OAuth tests. **A green mock test suite is not production certification.** Before main merge or Cloudflare deployment, independently verify ATAX’s per-IST-day quotas, release lease, source history and branch protection, as well as disposable FMRL terminal cleanup. External agents—not ATAX—must drive and verify finite work.
