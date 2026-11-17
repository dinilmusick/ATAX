---
name: "DevOps, CI/CD and Release Engineering"
slug: devops-ci-release
version: 1.0.0
source: Supabase Skills Database
sourceId: 9
status: active
---

## Mandatory FMRL execution rule

ATAX is the **tooling and control plane only**, NEVER the repository used to check out, execute, or test a private target. Use the agent's own container first; clone the **target** directly and run all available checks locally. If container access is unavailable/insufficient or remote evidence is required, use ATAX GitHub tools to create one **FMRL-* ephemeral PUBLIC repository**, dispatch CI there, clone the private target only inside the FMRL runner with a clone-only secret, record evidence, independently verify, DELETE FMRL, and independently verify 404. Never commit/cache/upload private source, pass clone credentials to tests, execute private targets in ATAX Actions or private-target Actions, or fall back to Agent-Workspace-1. If provisioning or cleanup fails, persist a blocker; do not silently use a legacy runner.


# DevOps, CI/CD and Release Engineering

Diagnose build pipelines, automate quality gates, manage releases, and verify deployment outcomes.

## Linked tools

- No tool links currently registered.

## Instructions

# DevOps, CI/CD and Release Engineering

1. Identify repository provider, workflow definitions, build system, deployment target, environments, and current release state.
2. Inspect the exact failing or active run, including complete logs, exit status, artifacts, cache behavior, and environment differences.
3. Reproduce locally when practical. Distinguish source errors from dependency, environment, credentials, cache, and infrastructure failures.
4. Keep build and release steps deterministic. Pin dependencies, preserve lockfiles, and avoid hidden environment assumptions.
5. Implement the narrowest pipeline or configuration correction. Keep secrets in the platform's secret store.
6. Run build, tests, and required checks. Confirm artifacts and deployment metadata.
7. Verify the deployed version, health, key routes, runtime logs, and rollback path.
8. Do not claim deployment success based only on a successful CI job; inspect the live deployment.
9. Report commit, workflow/run, checks, deployment URL/version, and remaining risks.

Do not deploy, promote, roll back, or modify production configuration without authorization.

## Metadata

```json
{
  "collection": "coding-skills",
  "synthesized": true,
  "routing_role": "specialist",
  "curation_date": "2026-11-02",
  "source_repository": "vercel-labs/agent-skills"
}
```

## Private repository CI fallback

When a private repository cannot provide usable native CI because runners/credits are unavailable, exhausted, blocked, or unsuitable:

1. Activate private-repo-ci-workspace-runner.
2. Use ATAX's .github/workflows/private-repo-ci.yml strictly as a FMRL provisioning/polling/deletion controller; never as the target runner.
3. Submit .agent/ci-request.json with the repository, ref, event, optional workflow, token mode, and unique request ID.
4. Verify clone → workflow validation → act execution → target tests/typecheck/build → evidence → cleanup.
5. Prefer clone-only unless the trusted target workflow genuinely needs GITHUB_TOKEN.
6. Never pass coding or deployment write tokens into target workflow code.

This fallback is a normal verification path, not an emergency-only path. Use it extensively for private-repository CI.
