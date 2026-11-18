# ATAX GitHub tools

## Mandatory FMRL execution boundary

ATAX is **only the control plane and tool source**, never a checkout workspace or GitHub Actions runner for target code. No target/private checkout, installation, build, test, `act` invocation, or coding commands may run in `dinilmusick/ATAX` Actions. The historical ATAX-as-workspace and Agent-Workspace-1 patterns are forbidden.

Execution priority:
1. Use the agent's own container/runtime; clone the **target repository** directly there (if authorized), edit and test locally. ATAX tools may be downloaded as tooling, but the ATAX repository must not become the target checkout or runner.
2. If local execution is unavailable, inaccessible, insufficient, or remote public Actions evidence is required, provision an **FMRL-prefixed, one-job disposable public repository** through `tools/github/disposable_workspace.py` or ATAX's control-plane workflow. This is the **only** remote GitHub compute location for private targets.
3. The FMRL public repository contains only bridge workflow code. Authorized private source is checked out **only inside its transient runner** and never pushed, artifacted, cached, or committed to the public repository. The checkout token is used only by the clone step; target commands receive no repository token.
4. Run and inspect checks, record evidence, obtain independent verification, **delete FMRL**, and independently confirm the repository returns 404. Deletion is mandatory on failure as well as success; failed cleanup is a blocker, not completion.
5. If FMRL cannot be provisioned, report the blocker and preserve work in the ledger. **Never fall back to ATAX or private-repository Actions execution.**

A new permanent repository (plain or Skipo) is a different lifecycle from disposable FMRL compute. Keep the two workflows separate.

Repository creation: `create_repository.py` or `create-repository.sh`. Skipo scaffolding: `scaffold-skipo-app.sh`. Disposable private CI: `disposable_workspace.py` (FMRL only). ATAX Actions control-plane entry: `.github/workflows/private-repo-ci.yml`. Cleanup: `repository_lifecycle.py delete --repository <owner/FMRL-...>` followed by independent absence verification.

New application repositories are permanent and **must not** be confused with FMRL compute. Credentials must never be printed, committed, injected into untrusted target code, or included in artifacts.

## FMRL dispatch credential contract

The control-plane runner uses three separate authorities. `CODING_REPO_TOKEN` provisions and deletes disposable public FMRL repositories. `FMRL_SECRETS_TOKEN` installs the clone-only `PRIVATE_REPO_TOKEN` as an Actions secret (never exposed as a workflow input). `FMRL_DISPATCH_TOKEN` is the preferred token for invoking the disposable repository's workflow: grant it **Actions: write** on newly created FMRL repositories. The controller falls back to `FMRL_SECRETS_TOKEN` only if no dispatch token is configured; in that case this token also requires Actions: write, not merely Secrets: write. Do not substitute the private clone token or execute target builds inside ATAX. On an authorization-related HTTP 403 the controller fails immediately and still deletes the disposable repository and verifies HTTP 404.
