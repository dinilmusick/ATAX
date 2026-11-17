# Container-first development and FMRL remote execution

## Mandatory FMRL execution boundary

ATAX is **only the control plane and tool source**, never a checkout workspace or GitHub Actions runner for target code. No target/private checkout, installation, build, test, `act` invocation, or coding commands may run in `dinilmusick/ATAX` Actions. The historical ATAX-as-workspace and Agent-Workspace-1 patterns are forbidden.

Execution priority:
1. Use the agent's own container/runtime; clone the **target repository** directly there (if authorized), edit and test locally. ATAX tools may be downloaded as tooling, but the ATAX repository must not become the target checkout or runner.
2. If local execution is unavailable, inaccessible, insufficient, or remote public Actions evidence is required, provision an **FMRL-prefixed, one-job disposable public repository** through `tools/github/disposable_workspace.py` or ATAX's control-plane workflow. This is the **only** remote GitHub compute location for private targets.
3. The FMRL public repository contains only bridge workflow code. Authorized private source is checked out **only inside its transient runner** and never pushed, artifacted, cached, or committed to the public repository. The checkout token is used only by the clone step; target commands receive no repository token.
4. Run and inspect checks, record evidence, obtain independent verification, **delete FMRL**, and independently confirm the repository returns 404. Deletion is mandatory on failure as well as success; failed cleanup is a blocker, not completion.
5. If FMRL cannot be provisioned, report the blocker and preserve work in the ledger. **Never fall back to ATAX or private-repository Actions execution.**

A new permanent repository (plain or Skipo) is a different lifecycle from disposable FMRL compute. Keep the two workflows separate.

Local preflight: `python3 tools/agent-bootstrap/bootstrap.py plan --repository owner/name`. Local preparation should check out the **target**, not ATAX. The remote ATAX fallback is a **control-plane** workflow only: `.github/workflows/private-repo-ci.yml`, which provisions and monitors `FMRL-*` and deletes it in an unconditional cleanup step. The prior `[github-dev]` and `[private-ci]` issue-based code execution workflows are retired. Do not create issues with those prefixes.

## ATAX FMRL credential boundaries

Store all three values as **GitHub Actions repository secrets on dinilmusick/ATAX** (Settings → Secrets and variables → Actions):

- `CODING_REPO_TOKEN`: existing lifecycle credential; creates the disposable public `FMRL-*` repository, writes the bridge workflow, dispatches and monitors CI, and deletes the repository.
- `FMRL_SECRETS_TOKEN`: **new, separate** credential used only to set the encrypted `PRIVATE_REPO_TOKEN` Actions secret on the disposable repository. For a fine-grained personal access token, select the `dinilmusick` owner, **All repositories** (including newly created FMRL repositories), and repository **Secrets: Read and write**. GitHub adds Metadata: Read automatically. Do not reuse the lifecycle or private-read credentials.
- `PRIVATE_REPO_TOKEN`: existing read-only credential to clone the authorized private target; never pass it as a workflow input or commit it to FMRL.

`FMRL_SECRETS_TOKEN` is required; provisioning fails **before creating** a disposable repository if it is missing. The tool does not fall back to `CODING_REPO_TOKEN` on a missing secret or HTTP 403. A permission failure after repository creation triggers the existing cleanup and independent deletion check.

After adding `FMRL_SECRETS_TOKEN` to ATAX, run the `FMRL CI controller (no target code in ATAX)` workflow with an authorized private repository, inspect its result, and verify that its temporary repository was deleted. Do not put token values in issues, workflow inputs, logs, or chat messages.
