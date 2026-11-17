# ATAX container-first target bootstrap

ATAX is a control plane and source of reusable tools. It must never be cloned or used as the **target workspace**.

1. Run `python3 tools/agent-bootstrap/bootstrap.py plan --repository owner/name` to inspect the agent's container.
2. Run `prepare --repository owner/name` to clone the TARGET directly into the container. Run build/lint/typecheck/tests there.
3. If unavailable, insufficient, or public CI evidence is needed, use ATAX's FMRL provisioning tool or control-plane workflow. The runner executes only inside the newly provisioned disposable **FMRL-*** public repo.
4. Independently verify the result and delete FMRL; confirm deletion (404). A failed cleanup is a blocker.

Never substitute historical ATAX-native runner workflows or private target Actions. Private checkout tokens belong only to the FMRL clone step.
