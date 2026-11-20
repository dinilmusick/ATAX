---
name: FMRL Private Repository CI Runner
slug: private-repo-ci-workspace-runner
version: 2.0.1
source: ATAX repository
status: active
---

## Mandatory FMRL execution boundary

ATAX is **only the control plane and tool source**, never a checkout workspace or GitHub Actions runner for target code. No target/private checkout, installation, build, test, `act` invocation, or coding commands may run in `dinilmusick/ATAX` Actions. The historical ATAX-as-workspace and Agent-Workspace-1 patterns are forbidden.

Execution priority:
1. Use the agent's own container/runtime; clone the **target repository** directly there (if authorized), edit and test locally. ATAX tools may be downloaded as tooling, but the ATAX repository must not become the target checkout or runner.
2. If local execution is unavailable, inaccessible, insufficient, or remote public Actions evidence is required, provision an **FMRL-prefixed, one-job disposable public repository** through `tools/github/disposable_workspace.py` or ATAX's control-plane workflow. This is the **only** remote GitHub compute location for private targets.
3. The FMRL public repository contains only bridge workflow code. Authorized private source is checked out **only inside its transient runner** and never pushed, artifacted, cached, or committed to the public repository. The checkout token is used only by the clone step; target commands receive no repository token.
4. Run and inspect checks, record evidence, obtain independent verification, **delete FMRL**, and independently confirm the repository returns 404. Deletion is mandatory on failure as well as success; failed cleanup is a blocker, not completion.
5. If FMRL cannot be provisioned, report the blocker and preserve work in the ledger. **Never fall back to ATAX or private-repository Actions execution.**

A new permanent repository (plain or Skipo) is a different lifecycle from disposable FMRL compute. Keep the two workflows separate.

## Tooling

Use `tools/github/disposable_workspace.py`, the ATAX FMRL control-plane workflow, and `tools/github/repository_lifecycle.py` for verified cleanup. Do not use the legacy direct ATAX `private-repo-ci` job. Any retired script is archival reference, not an execution entry point.

## Owner-authorized private lockfile regeneration (FMRL)

**Discovery/entry point.** For a private `dinilmusick/Luth`, `dinilmusick/Srkl-Engine`, `dinilmusick/Aiko`, or `dinilmusick/Frnes` pull request with an invalid/stale lockfile, use ATAX's existing FMRL control plane. Its owner-only request is an issue in `dinilmusick/ATAX` titled exactly `[atax-fmrl] repair-lockfile`; the **entire body is the opaque GitHub pull-request `node_id`** (format `PR_...`, available from the authenticated GitHub pull-request metadata). The issue author must pass the controller's verified owner-ID gate. Do not put private repository names, source code, tokens or private commit SHAs in public issue bodies. See `.github/workflows/owner-authorized-private-ci.yml` and `.github/workflows/private-repo-ci.yml`.

**Exact operation.** The resolver uses `CODING_REPO_TOKEN` only for owner-scoped private PR metadata, obtains the exact head SHA and non-fork branch, and provisions an `FMRL-*` disposable **public repository containing static bridge code only**. Only that repository's transient runner clones private source, at the exact SHA, using the separately scoped clone-only token. In `--mode repair`: for Luth/Frnes regenerate `pnpm-lock.yaml` (Frnes may start without a lockfile; the generated file must be recognized as an untracked lockfile-only change) using `pnpm install --lockfile-only --ignore-scripts --fix-lockfile --no-frozen-lockfile`, then prove `pnpm install --frozen-lockfile --ignore-scripts`; for SRKL/Aiko regenerate `package-lock.json` using `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`, then prove `npm ci --ignore-scripts --no-audit --no-fund`. No arbitrary package lifecycle scripts run in this repair phase.

**Commit and verification.** `tools/github/fmrl_lock_writer.py` is a reviewed static helper in the public bridge, invoked only **after** dependency operations finish. It accepts a write credential in that one step, validates the private PR head is still the requested commit, refuses non-lockfile changes, creates a lockfile-only commit, and uses non-forced GitHub REST `PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}` (plural `refs`, unlike read endpoint `GET /git/ref/heads/...`). Independently re-read the branch and committed blob digest. If the PR head changed, write authority is absent, or any readback fails, report a blocker, never force-push or mark repaired. Never expose write credentials to install/test commands.

**Required acceptance:** confirm changed paths contain only the expected lockfile; independently verify exact PR head, frozen install, and that each disposable FMRL repository is DELETED even after failure and returns unauthenticated HTTP 404. Record the ATAX issue/run, original/new SHA, change scope and deletion evidence in the canonical ledger. Then request a fresh `[atax-fmrl] verify` issue with the same PR node ID to run the portable **direct** install/test/build/typecheck checks against the new head. Direct FMRL success is **not** original GitHub Actions parity or deployed OAuth evidence. Full target workflow checks, protected preview deployment, real login/logout/refresh/revocation, negative authorization and workspace-isolation tests remain separate release gates.

**Failures:** `ERR_PNPM_BROKEN_LOCKFILE` or an npm frozen-lock mismatch calls for repair, not hand-editing lockfile snapshots. An API 404 at `atomic-branch-update` must be investigated as route/permission failure; check plural `git/refs` for PATCH, no fallback to force-update or credential disclosure. Consult `tools/github/README.md`, `skills/private-repo-ci-workspace-runner/SKILL.md`, `tools/github/disposable_workspace.py`, `tools/github/fmrl_lock_writer.py`, and their `test_fmrl_lock_repair.py` contract tests. Until an actual PR writeback and subsequent CI are green, describe the operation as implemented but **not yet end-to-end certified**.
