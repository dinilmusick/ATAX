-- Dedicated OAuth credential envelope registry. Not an ATAX ledger.
-- Credentials are encrypted using keys supplied by the client's ephemeral
-- authorization code or bearer tokens; no operator encryption secret exists.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS byoc_clients (
 client_id TEXT PRIMARY KEY,
 redirects TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS byoc_requests (
 nonce_hash TEXT PRIMARY KEY,
 client_id TEXT NOT NULL REFERENCES byoc_clients(client_id),
 redirect_uri TEXT NOT NULL,
 code_challenge TEXT NOT NULL,
 requested_scopes TEXT NOT NULL,
 state TEXT,
 expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS byoc_codes (
 code_hash TEXT PRIMARY KEY,
 client_id TEXT NOT NULL REFERENCES byoc_clients(client_id),
 redirect_uri TEXT NOT NULL,
 code_challenge TEXT NOT NULL,
 scopes TEXT NOT NULL,
 github_subject TEXT NOT NULL,
 github_owner TEXT NOT NULL,
 iv TEXT NOT NULL,
 encrypted TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS byoc_tokens (
 token_hash TEXT PRIMARY KEY,
 token_type TEXT NOT NULL CHECK(token_type IN ('access','refresh')),
 client_id TEXT NOT NULL REFERENCES byoc_clients(client_id),
 subject TEXT NOT NULL,
 github_owner TEXT NOT NULL,
 scopes TEXT NOT NULL,
 iv TEXT NOT NULL,
 encrypted TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 revoked_at INTEGER,
 family_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS byoc_requests_expiry ON byoc_requests(expires_at);
CREATE INDEX IF NOT EXISTS byoc_codes_expiry ON byoc_codes(expires_at);
CREATE INDEX IF NOT EXISTS byoc_tokens_family ON byoc_tokens(family_id);
CREATE INDEX IF NOT EXISTS byoc_tokens_expiry ON byoc_tokens(expires_at);

-- Request-local, finite anti-abuse counter; stores only a digest of IP + time bucket.
CREATE TABLE IF NOT EXISTS byoc_rate_limits (
 bucket_hash TEXT NOT NULL,
 minute_bucket INTEGER NOT NULL,
 hits INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(bucket_hash,minute_bucket)
);
