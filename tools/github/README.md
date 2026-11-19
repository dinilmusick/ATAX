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

## Public repository network-enabled CI (2026-11-19)

For PUBLIC targets, when the agent's local runtime cannot resolve npm or other package registries, distinguish local DNS failures (for example EAI_AGAIN) from package compatibility errors. Do not claim that a dependency is broken without a network-enabled install result.

Use the target repository's GitHub-hosted CI for public source; this is distinct from PRIVATE targets, which MUST use the disposable FMRL boundary above. The ATAX control plane may dispatch public target workflows but MUST NOT checkout/build the target itself.

For Skiplet: ensure `dinilmusick/Skiplet/.github/workflows/ci.yml` supports `workflow_dispatch`. Create an owner-authorized issue titled exactly `[public-ci] Skiplet` in `dinilmusick/ATAX`; `.github/workflows/public-target-ci-dispatch.yml` uses `CODING_REPO_TOKEN` to dispatch Skiplet CI on main. The controller only dispatches; do not interpret a successful dispatch as a passing build. Inspect the target run jobs/logs and compare its head SHA with the expected commit, then persist the result and fix errors.

For reproducible npm installs, generate and commit `package-lock.json` using a network-enabled runner and use `npm ci` once the lockfile is present. Never generate a fabricated lockfile or silently substitute `npm install` as final reproducibility evidence. Do not expose registry credentials.

## Create a Meditation — uses the Skiplet scaffold to create a Meditation repository

**Description:** Uses the Skiplet scaffold to create a new Meditation (`MDT-*`) GitHub repository, including the React/TypeScript starter, artistic configuration, and project instructions. Select a repository name and visibility; ATAX generates the repository from `dinilmusick/Skiplet` and verifies its default branch.

## Permanent repository creation from an existing GitHub template

Use `tools/github/create_from_template.py` (or `.github/workflows/create-from-template.yml`) when a new permanent project must inherit a template. This is different from `create_repository.py`, which creates a normal empty/initialized repository, and different from disposable FMRL compute.

CLI: `CODING_REPO_TOKEN=... python3 tools/github/create_from_template.py --template dinilmusick/Skiplet --owner dinilmusick --name MDT-Example --visibility public`. For a safe preview omit the token and add `--dry-run`. The source must have `is_template=true`; the destination must not exist. The tool invokes GitHub's template generation API, waits for the generated default branch and prints its exact commit SHA. A generated permanent repository is never automatically deleted.

From GitHub Actions, dispatch `create-from-template.yml` with template, owner, name and visibility, or create an owner-authorized ATAX issue titled `[template-repo] create` whose body is JSON, e.g. `{"template":"dinilmusick/Skiplet","owner":"dinilmusick","name":"MDT-MyProject","visibility":"public"}`. The workflow uses `CODING_REPO_TOKEN` and reports outcome to the issue. Check the resulting repository and generated files independently before marking completion. Do not confuse creating a project FROM Skiplet with provisioning Skiplet itself.
