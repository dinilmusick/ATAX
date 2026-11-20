-- Restore the canonical helper used by goal-scoped and global blocker-first claims.
-- Live Supabase already defines this helper; the resettable migration chain must do so too.
-- Do not weaken claims or silently bypass blocker ordering.
create or replace function public.goal_ledger_blocker_attention(goal_key_in text)
returns jsonb
language sql
set search_path to public
as $function$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.notoriety desc),'[]'::jsonb)
  from public.goal_ledger_blocker_overview(goal_key_in) x
  where x.notoriety > 5;
$function$;
