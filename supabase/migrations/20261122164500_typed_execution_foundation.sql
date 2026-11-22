-- Typed execution state is orthogonal to canonical task occupancy.
-- No grants to anon/authenticated. Only trusted server-side service role may access.
create table if not exists public.typed_task_executions (
 id uuid primary key default gen_random_uuid(),
 task_id uuid not null references public.tasks(id) on delete restrict,
 revision integer not null default 1 check (revision > 0),
 stage text not null default 'initiated' check (stage in
 ('initiated','input_ready','dispatch_pending','dispatched','executing',
 'executed','failed','outcome_unknown','verification_pending','verified','rejected')),
 operation_key text not null,
 contract jsonb not null check (jsonb_typeof(contract) = 'object'),
 input_payload jsonb,
 input_sha256 text check (input_sha256 is null or input_sha256 ~ '^[0-9a-f]{64}$'),
 initiator_id text not null,
 preparer_id text,
 verifier_id text,
 dispatch_correlation uuid,
 execution_receipt jsonb,
 verification_receipt jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(task_id,revision),
 check (preparer_id is null or preparer_id <> initiator_id),
 check (verifier_id is null or (verifier_id <> initiator_id and verifier_id is distinct from preparer_id))
);
create table if not exists public.typed_execution_outbox (
 id uuid primary key default gen_random_uuid(),
 execution_id uuid not null references public.typed_task_executions(id) on delete restrict,
 revision integer not null check (revision > 0),
 status text not null default 'pending' check (status in ('pending','leased','dispatched','failed','reconcile')),
 attempts integer not null default 0 check (attempts >= 0),
 correlation_id uuid not null default gen_random_uuid(),
 run_id text,
 last_error_class text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(execution_id,revision),
 unique(correlation_id)
);
create index if not exists typed_execution_outbox_pending_idx on public.typed_execution_outbox(status,created_at);
alter table public.typed_task_executions enable row level security;
alter table public.typed_execution_outbox enable row level security;
revoke all on public.typed_task_executions,public.typed_execution_outbox from public,anon,authenticated;
comment on table public.typed_execution_outbox is 'Durable dispatch intent only. No database trigger starts agents or external compute.';
