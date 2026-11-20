# Safe FMRL diagnostic extraction

The ATAX controller must not print, upload or retain private-target logs. Its
disposable FMRL runner runs the target with stdout/stderr redirected to an
ephemeral file and prints **only** fixed-prefix categories, gate names and
safe error identifiers. After the run, the controller reads the public bridge
job logs with the existing scoped repository token and extracts only those
trusted line prefixes. If logs are not accessible it reports the failed job
step and an explicit diagnostics-unavailable receipt; it does not guess.

Controller credentials are never passed to private target code and the FMRL
repository is deleted with independent 404 verification even when tests fail.
This applies to the Frnes frozen-install/build check as well as all other
approved private verification runs.
