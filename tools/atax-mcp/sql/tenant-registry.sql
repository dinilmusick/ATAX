-- Shared Worker tenant registry, not the canonical ATAX Supabase substrate.
-- Only JWT identities invited by the configured administrator may use this database.
-- Secret values are AES-256-GCM encrypted in ciphertext, with an external Worker-only key.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS atax_principals (
  subject TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS atax_connections (
  subject TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('supabase','github','cloudflare','vercel')),
  alias TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(subject,provider,alias),
  FOREIGN KEY(subject) REFERENCES atax_principals(subject) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS atax_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  action TEXT NOT NULL,
  provider TEXT,
  alias TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_atax_connections_owner ON atax_connections(subject);

-- Never write plaintext invitation keys to the tenant registry; only SHA-256 hashes.
CREATE TABLE IF NOT EXISTS atax_access_keys (
  key_hash TEXT PRIMARY KEY CHECK(length(key_hash)=64),
  subject TEXT NOT NULL REFERENCES atax_principals(subject) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  label TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_atax_access_keys_subject ON atax_access_keys(subject);
