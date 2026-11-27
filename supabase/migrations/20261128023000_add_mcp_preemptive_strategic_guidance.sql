-- ATAX MCP preemptive strategic guidance.
-- Guidance is durable state: actions refresh it; ordinary MCP responses only advertise retrieval.

create table if not exists atax_private.mcp_preemptive_guidance (
  owner_subject text primary key,
  guidance jsonb not null default '{}'::jsonb,
  version bigint not null default 0,
  last_tool_name text,
  last_action_summary text,
  updated_at timestamptz not null default now(),
  constraint mcp_preemptive_guidance_owner_subject_chk check (length(trim(owner_subject)) between 3 and 200)
);

create index if not exists mcp_preemptive_guidance_updated_idx
  on atax_private.mcp_preemptive_guidance (updated_at desc);

-- See the deployed SQL in this commit for the complete function bodies.
