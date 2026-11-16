# Private Repository CI Workspace Runner

Purpose:
- native private-repository GitHub Actions unavailable/exhausted
- clone target into ATAX's dedicated `clones/` directory
- execute the target repository's own `.github/workflows/*` definitions with `act`
- collect logs/artifacts in the public ATAX Actions run
- delete the clone unconditionally

Flow:

```text
private repo
  -> clone-private-repo.sh
  -> clones/<owner>__<repo>
  -> run-workflows.sh
  -> public ATAX GitHub Actions runner
  -> evidence
  -> cleanup-clone.sh
  -> clones/*
```

## Secret bootstrap

`configure-private-repo-secret.sh` configures the read-capable GitHub Actions secret required by the fallback CI workflow.

Local agents should run:

```bash
bash tools/private-repo-ci/configure-private-repo-secret.sh
```

By default it uses the token from the authenticated `gh` CLI session:

```bash
gh auth token
  -> PRIVATE_REPO_TOKEN
  -> gh secret set PRIVATE_REPO_TOKEN --repo dinilmusick/ATAX
```

The script never prints the token and never accepts it as a command-line argument. For non-interactive execution, provide `PRIVATE_REPO_TOKEN` through the process environment.

Security rule: the script deliberately refuses to substitute GitHub Actions' built-in `GITHUB_TOKEN`. That token is scoped to ATAX and cannot be assumed to read the separate private repositories.

The configured secret should have only the minimum read access needed by the target private repositories.

## Runtime security invariants

- Clone authentication is removed from the target repository's Git configuration immediately after cloning.
- The default workflow runner can execute trusted target workflows with their normal checkout authentication.
- Use `token_mode=clone-only` when target workflow code must not receive repository authentication.
- Run target code only from repositories and refs you trust.
- Cleanup is mandatory and runs through the workflow's exit trap.
- Private source is never committed to ATAX.

## Requirements

- Git
- Docker
- `act`
- GitHub CLI (`gh`) for secret bootstrap
- `PRIVATE_REPO_TOKEN` repository secret on ATAX for GitHub Actions execution

Local agents may invoke the scripts directly. Public ATAX CI uses the same scripts.

The runner intentionally executes the cloned workflow definitions rather than copying them into the workspace repository's workflow directory. This preserves the target workflow logic while using the public repository's runner for compute.


## Generic workflow runner

The reusable workflow `.github/workflows/private-repo-ci.yml` is manually dispatchable for any private repository the configured token can read.

Inputs:

- `repository`: `owner/name`
- `ref`: branch, tag, or commit; empty uses the default branch
- `event`: GitHub Actions event to emulate with `act`
- `workflow`: optional workflow filename; empty runs every target workflow
- `token_mode`: `workflow` passes the read-only repository token to `act` as `GITHUB_TOKEN` so normal `actions/checkout` steps can authenticate; `clone-only` keeps the token out of target workflows

Use `workflow` mode only for repositories and workflow definitions that are trusted. Executing untrusted checked-out code with a credential can expose that credential. The configured token should therefore be fine-grained, read-only, and limited to the private repositories this runner is intended to verify.

The runner validates the target workflow definitions, clones the requested ref, runs the target workflow definitions with pinned `act`, records an Actions summary/artifacts, and unconditionally removes the private clone.

The compatibility issue route is restricted to owner/member/collaborator-authored issues titled `[private-ci] <short task>` with a JSON body containing `repository`, `ref`, and either `workflow` or `command`. Other issue types (including `[github-dev]` and `[acquire-repo]`) are ignored.

The target workflow files are never copied into ATAX's workflow directory.

## Current execution authority

ATAX is the current public execution repository. The former Agent-Workspace-1 name is historical only and must not be used as a repository, secret target, or workflow authority.

Private targets are cloned only beneath the ATAX runner's ephemeral `clones/` directory. The target source is never copied into ATAX commits or artifacts. The cleanup step removes each clone and checks that the clone root is empty.

## act runner image

The runner builds `tools/private-repo-ci/act-runner/Dockerfile` on demand. It invokes `act --pull=false` after building the image so act uses the runner-local tag instead of attempting to pull it from Docker Hub. It derives from the pinned `act-24.04` image and adds Git, which target workflows need for checks such as `git diff --check`. The same image is mapped to both `ubuntu-latest` and `ubuntu-24.04`; this avoids act's lightweight default mapping for `ubuntu-latest`, which lacks Git. Set `ACT_PLATFORM` as a comma-separated list of explicit mappings only when a target requires a different runner image.
