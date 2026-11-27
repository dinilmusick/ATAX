# Repository-Backed Executable Skills

A skill may declare an executable repository reference. The reference is an execution contract, not a checkout instruction for the ATAX control plane.

## Contract

```json
{
  "type": "repository",
  "repository": "owner/name",
  "revision": "<40-character lowercase commit SHA>",
  "command": "npm run check",
  "runtime": "node@24",
  "install": "npm ci",
  "workingDirectory": ".",
  "output": "status"
}
```

## Execution

1. ATAX resolves the repository and authorized GitHub account.
2. FMRL creates a disposable public bridge.
3. The target repository is cloned only inside the ephemeral FMRL runner at the exact SHA.
4. Dependencies are installed inside that runner.
5. The declared command executes inside that checkout.
6. Only bounded, sanitized execution evidence returns through ATAX.
7. The disposable bridge is deleted and independently verified as HTTP 404.

Public and private repositories use the same contract. Private repositories require an ATAX-authorized GitHub account; credentials remain encrypted runtime secrets and never enter the target checkout's Git history, public bridge source, or returned evidence.

ATAX never executes target repository code in the control plane.
