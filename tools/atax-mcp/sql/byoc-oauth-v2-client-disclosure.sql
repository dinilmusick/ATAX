-- Add identity labels for explicit, informed client authorization.
-- Display names are self-declared and MUST be labelled unverified.
ALTER TABLE byoc_clients ADD COLUMN client_name TEXT NOT NULL DEFAULT 'Unverified MCP client';
