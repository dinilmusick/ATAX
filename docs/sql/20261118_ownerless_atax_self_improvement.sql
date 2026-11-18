-- ATAX canonical ownerless System support.
-- The only current access to improvement RPCs is service_role; existing
-- authenticated RLS policies require owner_user_id = auth.uid(), so NULL
-- owner rows remain inaccessible to ordinary authenticated clients.
-- This migration does not relax RLS or grant RPC EXECUTE.
alter table public.system_improvement_cycles
  alter column owner_user_id drop not null;
alter table public.system_improvement_candidates
  alter column owner_user_id drop not null;
alter table public.system_constraints
  alter column owner_user_id drop not null;
alter table public.constraint_observations
  alter column owner_user_id drop not null;
comment on column public.system_improvement_cycles.owner_user_id is
  'NULL for canonical ownerless Systems managed by service-role ATAX; authenticated RLS still requires matching owned user.';
comment on column public.system_improvement_candidates.owner_user_id is
  'NULL for service-role-only canonical ownerless System improvements.';
comment on column public.system_constraints.owner_user_id is
  'NULL for service-role-only canonical ownerless System constraints.';
comment on column public.constraint_observations.owner_user_id is
  'NULL for service-role-only ownerless System constraint observations.';
