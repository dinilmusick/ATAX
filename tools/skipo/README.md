# Skipo CLI inside ATAX-managed GitHub CI

ATAX is the control plane, not an execution workspace. The reusable composite action at `tools/skipo/action.yml` installs a **SHA-pinned Skipo CLI**, Node.js 22, pnpm 10.33.0, and Python 3 on an **ephemeral GitHub-hosted runner**. It executes against the already-checked-out application worktree. It does not spawn or schedule agents, create a resident workspace, or receive a Cloudflare deployment token.

## Target-app workflow example

Add this to the **target application's** workflow. For private repositories whose own Actions cannot run, dispatch that target workflow using the existing ATAX FMRL controller and disposable public bridge; source remains confined to the FMRL runner. Do **not** execute the target workflow inside ATAX Actions.

```yaml
name: Skipo contract
on: [push, pull_request, workflow_dispatch]
permissions:
  contents: read
jobs:
  skipo:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - name: Skipo architectural diagnosis
        uses: dinilmusick/ATAX/tools/skipo@<reviewed-ATAX-commit-SHA>
        with:
          skipo-ref: 25a9921b051e7c6b2601fe33f0f163e432a56d2a
          operation: diagnose
          project-path: .
      - name: Skipo certification
        uses: dinilmusick/ATAX/tools/skipo@<reviewed-ATAX-commit-SHA>
        with:
          skipo-ref: 25a9921b051e7c6b2601fe33f0f163e432a56d2a
          operation: certify
          project-path: .
```

Replace the ATAX placeholder with the reviewed full commit SHA after merging the action. The listed Skipo SHA was observed on 2026-11-18; refresh it deliberately as Skipo advances. Do not use a mutable branch when reproducibility matters.

## Supported operations

Read-only operations: `inspect`, `check`, `diagnose`, `plan`, `verify`, `certify`, `policy`, `semantic`, `test`. Full native Skipo subcommands, including nested `add` and page/repair commands, can be sent with `cli-args-json`, which overrides the convenience `operation` and `project-path` inputs without shell interpolation.

Mutating operations: `create`, `adopt`, `sync`, `update`, `repair`, `fix`, `add`, `remove`, `auth`, `login`, `workspace`, `workspaceMenu`, and `mainPage` require `allow-write: 'true'` and should run only on an **isolated working branch** created for the task; never on production main. `project-path` cannot escape `GITHUB_WORKSPACE`. The `create` operation treats it as a new one-component application name; other operations treat it as a project-relative directory.

The action emits a `skipo-commit` and `status` output and exposes CLI stdout/stderr in the workflow step. A failed command fails CI; the agent should preserve a *redacted* structured diagnostic and commit/SHA fingerprint in Supabase, then correct the code in a PR. Never record tokens, environment values, complete private source, or raw private build artifacts in a public FMRL repository.

## Native argument-vector mode

For the complete supported Skipo CLI grammar, pass an argv array rather than a shell command string. Examples:

```yaml
with:
  skipo-ref: 25a9921b051e7c6b2601fe33f0f163e432a56d2a
  cli-args-json: '["add","main","tab","Mixer","."]'
  allow-write: 'true'
```

```yaml
with:
  skipo-ref: 25a9921b051e7c6b2601fe33f0f163e432a56d2a
  cli-args-json: '["repair","shell",".","--plan"]'
  allow-write: 'true'
```

The native vector is passed directly to the installed Skipo executable with no shell evaluation; unknown verbs and control characters are rejected. The mutation gate applies to the requested *command*, but passing a destructive command on a real repo is still dangerous. Treat raw arguments as trusted task-contract data, use an isolated checkout/branch, and never let arbitrary issue comments or PR text supply them. Native Skipo's own repair and conformance checks are authoritative; ATAX does not reimplement Skipo's architecture.

## Boundaries and remaining integration

- FMRL's existing control-plane workflow accepts a **target workflow filename** and executes it via `act`. To use this action, add the target-side workflow to the app branch, then run it through the FMRL controller; never invoke the action in ATAX Actions to build the target.
- Full app editing is supported by the Skipo CLI operations, but editing source still requires an authorized transient agent to push a branch and open a PR. The action alone **does not edit GitHub repositories remotely**, open PRs, or create agents.
- Create/edit operations are opt-in; production deployment and account switching are not performed by this action.
- The action is a new integration surface. Actual end-to-end FMRL execution and readback must be independently verified before the task is marked complete.
- Faster diagnostic delivery and Cloudflare quota-aware routing require a separate GitHub Actions ingest workflow plus canonical Supabase event ingestion. Reconcile source SHA, project identity, build status, normalized error fingerprint, and receipt; retry transient API failures without duplicating tasks.

## Acceptance tests for follow-up implementation

1. Run `diagnose` and `certify` for a known Skipo app through a real FMRL runner; capture job name, Skipo SHA, target commit SHA, exit code and safe diagnostic codes.
2. Run `update` with `allow-write: false`; it must fail before installing the CLI or writing source.
3. Run `create` or `repair` on an isolated target branch with `allow-write: true`; verify resulting diff and rerun no-op/transactional safeguards.
4. Verify that the FMRL disposable repository is deleted and independently returns HTTP 404 on success *and* failure.
5. On one failed CI run, deduplicate and persist the failure in Supabase and link it to the correct goal and task without marking completion before independent verification.

The work above is GitHub-hosted compute with Supabase as canonical state, not an ATAX-local workspace.
