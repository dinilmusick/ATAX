import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Cpu,
  Database,
  GitBranch,
  Loader2,
  RefreshCw,
  Search,
  Shield,
  TimerReset,
  Workflow,
} from 'lucide-react';
import type {
  WorkSocketSubstrateResponse,
  WorkSocketSuitabilityResponse,
  WorkSocketTaskRecord,
} from '../types/substrate';

interface WorkSocketsViewProps {
  refreshTick?: number;
  onLoadingChange?: (loading: boolean) => void;
}

function formatWhen(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function statusTone(status: string): string {
  switch (status) {
    case 'running': return 'border-[#6CC48E]/40 bg-[#163022] text-[#9BE2B2]';
    case 'waiting': return 'border-[#E09F3E]/40 bg-[#302313] text-[#F5C979]';
    case 'completed': return 'border-[#7AA6D9]/40 bg-[#182638] text-[#B6D2F2]';
    case 'failed':
    case 'blocked':
    case 'abandoned': return 'border-[#C83214]/50 bg-[#301611] text-[#F2A28F]';
    default: return 'border-[#5A4439] bg-[#201613] text-[#CBBFB2]';
  }
}

function leaseLabel(task: WorkSocketTaskRecord): string {
  const state = task.occupancy.leaseState;
  if (state === 'lease_valid') return 'Lease active';
  if (state === 'lease_expired') return 'Lease expired';
  if (state === 'no_claim') return 'Unclaimed';
  return 'Lease unknown';
}

function BudgetMeter({ task }: { task: WorkSocketTaskRecord }) {
  if (!task.budget) {
    return <span className="text-[11px] text-[#806E62] font-mono">No socket budget</span>;
  }
  const used = task.budget.inputUsed + task.budget.outputUsed;
  const ratio = task.budget.maxTotal > 0
    ? Math.min(100, Math.round((used / task.budget.maxTotal) * 100))
    : 0;
  return (
    <div className="min-w-[155px] space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-[10px] font-mono text-[#CBBFB2]">
        <span>{formatTokens(used)} / {formatTokens(task.budget.maxTotal)} tokens</span>
        <span>{ratio}%</span>
      </div>
      <div className="h-1.5 bg-[#120C0A] border border-[#4A362D] overflow-hidden">
        <div
          className={`h-full ${ratio >= 90 ? 'bg-[#C83214]' : ratio >= 75 ? 'bg-[#E09F3E]' : 'bg-[#6CC48E]'}`}
          style={{ width: `${ratio}%` }}
        />
      </div>
      <div className="flex justify-between text-[9px] text-[#89776B] font-mono">
        <span>in {formatTokens(task.budget.inputUsed)} / {formatTokens(task.budget.maxInput)}</span>
        <span>out {formatTokens(task.budget.outputUsed)} / {formatTokens(task.budget.maxOutput)}</span>
      </div>
    </div>
  );
}

function TaskDetails({ task }: { task: WorkSocketTaskRecord }) {
  const passed = task.predicates.filter((p) => p.passed).length;
  const failed = task.predicates.length - passed;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 border-t border-[#382821] bg-[#170F0D] p-4">
      <section className="space-y-2">
        <h4 className="text-[10px] font-mono uppercase tracking-wider text-[#DF6B3B]">Task authority & hierarchy</h4>
        <div className="text-[11px] text-[#CBBFB2] space-y-1.5">
          <div>Task: <span className="font-mono text-[#F7F3EC]">{task.id}</span></div>
          <div>Parent: <span className="font-mono text-[#F7F3EC]">{task.parentTaskId || 'Root task'}</span></div>
          <div>Goal: <span className="font-mono text-[#F7F3EC]">{task.goalKey || task.goalName || task.goalId || '—'}</span></div>
          <div>System: <span className="font-mono text-[#F7F3EC]">{task.systemKey || '—'}</span></div>
          <div>Required capabilities: {task.requiredCapabilities.length
            ? task.requiredCapabilities.map((cap) => (
                <span key={cap} className="inline-block mr-1 mb-1 rounded-sm border border-[#4A362D] px-1.5 py-0.5 font-mono text-[10px]">{cap}</span>
              ))
            : <span className="font-mono">none declared</span>}
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <h4 className="text-[10px] font-mono uppercase tracking-wider text-[#DF6B3B]">Predicate evidence</h4>
        <div className="flex items-center gap-2 text-[11px] font-mono">
          <span className="text-[#9BE2B2]">{passed} passed</span>
          <span className="text-[#89776B]">·</span>
          <span className={failed > 0 ? 'text-[#F2A28F]' : 'text-[#B9AA9D]'}>{failed} failed/pending</span>
          <span className="text-[#89776B]">·</span>
          <span className="text-[#CBBFB2]">{task.predicates.length} receipts</span>
        </div>
        {task.predicates.length === 0 ? (
          <p className="text-[11px] text-[#806E62]">No predicate receipts recorded.</p>
        ) : (
          <div className="space-y-1.5 max-h-28 overflow-y-auto pr-1">
            {task.predicates.map((predicate, index) => (
              <div key={`${predicate.checkpointIndex}-${predicate.predicateKey}-${index}`} className="flex items-center justify-between gap-2 text-[10px] font-mono">
                <span className="text-[#CBBFB2] truncate">
                  #{predicate.checkpointIndex} {predicate.predicateKey}@{predicate.predicateVersion}
                </span>
                <span className={predicate.passed ? 'text-[#9BE2B2]' : 'text-[#F2A28F]'}>
                  {predicate.passed ? 'PASS' : 'NOT PASS'}
                </span>
                <span className="text-[#89776B]">{predicate.evidenceCount} evidence</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="text-[10px] font-mono uppercase tracking-wider text-[#DF6B3B]">Recent audit events</h4>
        {task.events.length === 0 ? (
          <p className="text-[11px] text-[#806E62]">No task events available.</p>
        ) : (
          <div className="space-y-1.5 max-h-28 overflow-y-auto pr-1">
            {task.events.map((event, index) => (
              <div key={`${event.eventType}-${event.occurredAt}-${index}`} className="border-l border-[#684331] pl-2">
                <div className="flex items-center justify-between gap-2 text-[10px] font-mono">
                  <span className="text-[#DFE4D8]">{event.eventType}</span>
                  <span className="text-[#89776B]">{formatWhen(event.occurredAt)}</span>
                </div>
                <p className="text-[10px] text-[#A99688] break-words">{event.message}</p>
                {event.actorLabel && <p className="text-[9px] text-[#806E62] font-mono">actor {event.actorLabel}</p>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function WorkSocketsView({ refreshTick = 0, onLoadingChange }: WorkSocketsViewProps) {
  const [snapshot, setSnapshot] = useState<WorkSocketSubstrateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [suitabilityTaskId, setSuitabilityTaskId] = useState<string | null>(null);
  const [suitability, setSuitability] = useState<WorkSocketSuitabilityResponse | null>(null);
  const [suitabilityLoading, setSuitabilityLoading] = useState(false);
  const [suitabilityError, setSuitabilityError] = useState<string | null>(null);

  const fetchWorkSockets = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    onLoadingChange?.(true);
    setError(null);
    try {
      const response = await fetch('/api/substrate/worksockets', { signal });
      const payload = await response.json() as WorkSocketSubstrateResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || `WorkSocket query failed (HTTP ${response.status})`);
      setSnapshot({
        tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
        workers: Array.isArray(payload.workers) ? payload.workers : [],
        fetchedAt: payload.fetchedAt || new Date().toISOString(),
      });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Unable to load canonical WorkSocket state.');
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        onLoadingChange?.(false);
      }
    }
  }, [onLoadingChange]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchWorkSockets(controller.signal);
    return () => controller.abort();
  }, [fetchWorkSockets, refreshTick]);

  const fetchSuitability = useCallback(async (taskId: string) => {
    setSuitabilityTaskId(taskId);
    setSuitability(null);
    setSuitabilityError(null);
    setSuitabilityLoading(true);
    try {
      const response = await fetch(`/api/substrate/worksockets/${encodeURIComponent(taskId)}/suitability`);
      const payload = await response.json() as WorkSocketSuitabilityResponse & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || `Suitability evaluation failed (HTTP ${response.status})`);
      }
      setSuitability(payload);
    } catch (err) {
      setSuitabilityError(err instanceof Error ? err.message : 'Unable to evaluate worker suitability.');
    } finally {
      setSuitabilityLoading(false);
    }
  }, []);

  const tasks = snapshot?.tasks || [];
  const workers = snapshot?.workers || [];
  const activeCount = tasks.filter((task) => task.status === 'running').length;
  const waitingCount = tasks.filter((task) => task.status === 'waiting').length;
  const pendingVerification = tasks.filter((task) => task.status === 'completed' && task.verificationStatus === 'pending').length;
  const activeLeases = tasks.filter((task) => task.occupancy.leaseState === 'lease_valid').length;

  const filteredTasks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tasks.filter((task) => {
      const statusMatch = statusFilter === 'all' || task.status === statusFilter;
      const searchMatch = !needle || [
        task.name, task.taskKey, task.goalKey, task.goalName, task.systemKey,
        task.id, task.parentTaskId, task.occupancy.agentDisplayLabel,
      ].filter(Boolean).join(' ').toLowerCase().includes(needle);
      return statusMatch && searchMatch;
    });
  }, [tasks, statusFilter, query]);

  const totalBudgetUsed = tasks.reduce((sum, task) => task.budget
    ? sum + task.budget.inputUsed + task.budget.outputUsed
    : sum, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4 border-b border-[#382821] pb-5">
        <div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] font-mono text-[#DF6B3B]">
            <Activity className="w-3.5 h-3.5" /> Runtime & ledger
          </div>
          <h2 className="font-display text-2xl font-bold tracking-tight text-[#F7F3EC] mt-1">WorkSocket Operations</h2>
          <p className="text-sm text-[#B9AA9D] mt-1">
            Canonical task sockets, leases, decomposition, budget usage, predicate receipts and audit history.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-4 h-4 text-[#8C7263] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              aria-label="Search WorkSockets"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search task, goal, actor..."
              className="w-64 bg-[#1D1411] border border-[#4A362D] text-sm text-[#F2EBE1] placeholder-[#7C695D] pl-9 pr-3 py-2 rounded-sm focus:outline-none focus:border-[#C83214]"
            />
          </div>
          <select
            aria-label="Filter WorkSockets by status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="bg-[#1D1411] border border-[#4A362D] text-sm text-[#F2EBE1] px-3 py-2 rounded-sm focus:outline-none focus:border-[#C83214]"
          >
            <option value="all">All states</option>
            <option value="running">Running</option>
            <option value="waiting">Waiting / atomized</option>
            <option value="queued">Queued</option>
            <option value="completed">Completed</option>
            <option value="blocked">Blocked</option>
            <option value="failed">Failed</option>
          </select>
          <button
            type="button"
            onClick={() => void fetchWorkSockets()}
            className="inline-flex items-center gap-2 border border-[#684331] bg-[#241814] hover:bg-[#332019] text-[#F7F3EC] px-3 py-2 text-xs font-mono rounded-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="border border-[#C83214] bg-[#241310] px-4 py-3 flex items-start gap-2 text-xs text-[#F7F3EC]">
          <AlertTriangle className="w-4 h-4 text-[#E04819] shrink-0" />
          <span className="font-mono break-words">{error}</span>
        </div>
      )}

      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
        {[
          { label: 'Sockets tracked', value: tasks.length, icon: Workflow },
          { label: 'Running', value: activeCount, icon: Activity },
          { label: 'Valid leases', value: activeLeases, icon: Clock3 },
          { label: 'Awaiting atomization', value: waitingCount, icon: GitBranch },
          { label: 'Evidence verification', value: pendingVerification, icon: Shield },
        ].map((metric) => (
          <div key={metric.label} className="border border-[#3B2A23] bg-[#1B120F] px-4 py-3 rounded-sm">
            <div className="flex items-center justify-between gap-2 text-[10px] font-mono uppercase tracking-wider text-[#A89688]">
              <span>{metric.label}</span>
              <metric.icon className="w-3.5 h-3.5 text-[#DF6B3B]" />
            </div>
            <div className="font-display text-2xl font-bold text-[#F7F3EC] mt-1 tabular-nums">{metric.value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4">
        <section className="border border-[#3B2A23] bg-[#1B120F] rounded-sm overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[#382821]">
            <div>
              <h3 className="font-display font-semibold text-[#F7F3EC]">Task sockets</h3>
              <p className="text-[10px] text-[#89776B] font-mono mt-0.5">
                {filteredTasks.length} displayed · {formatTokens(totalBudgetUsed)} tokens used across tracked tasks
              </p>
            </div>
            {loading && <Loader2 className="w-4 h-4 text-[#DF6B3B] animate-spin" />}
          </div>

          {loading && tasks.length === 0 ? (
            <div className="p-10 flex justify-center items-center gap-3 text-xs font-mono text-[#B9AA9D]">
              <Loader2 className="w-4 h-4 animate-spin" /> Reading canonical Supabase socket state…
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="p-10 text-center text-xs text-[#89776B]">
              No WorkSocket tasks match this view. Empty registry/queue states are shown as such; no worker data is synthesized.
            </div>
          ) : (
            <div className="divide-y divide-[#30211B]">
              {filteredTasks.map((task) => {
                const isExpanded = expanded === task.id;
                const predicatesPassed = task.predicates.filter((p) => p.passed).length;
                const leaseTone = task.occupancy.leaseState === 'lease_valid'
                  ? 'text-[#9BE2B2]'
                  : task.occupancy.leaseState === 'lease_expired'
                    ? 'text-[#F2A28F]'
                    : 'text-[#89776B]';
                return (
                  <article key={task.id} className="min-w-0">
                    <button
                      type="button"
                      onClick={() => setExpanded(isExpanded ? null : task.id)}
                      aria-expanded={isExpanded}
                      className="w-full text-left px-4 py-3 hover:bg-[#211613] transition-colors"
                    >
                      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_125px_165px] gap-3 items-center">
                        <div className="min-w-0">
                          <div className="flex items-center flex-wrap gap-2">
                            <span className="font-mono text-[10px] text-[#DF6B3B]">{task.taskKey}</span>
                            <span className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 border rounded-sm ${statusTone(task.status)}`}>{task.status}</span>
                            {task.executionModel === 'bounded-v2' && (
                              <span className="text-[9px] font-mono text-[#B6D2F2] border border-[#486587] px-1.5 py-0.5 rounded-sm">bounded-v2</span>
                            )}
                          </div>
                          <h4 className="font-display text-sm text-[#F7F3EC] truncate mt-1">{task.name}</h4>
                          <p className="text-[10px] font-mono text-[#89776B] truncate mt-0.5">
                            {task.goalKey || task.goalName || 'Unlinked goal'} · {task.systemKey || 'System unassigned'} · {task.id.slice(0, 8)}
                          </p>
                        </div>

                        <div className="space-y-1">
                          <div className="text-[10px] font-mono uppercase text-[#89776B]">Claim / lease</div>
                          <div className={`text-[11px] font-mono ${leaseTone}`}>{leaseLabel(task)}</div>
                          <div className="text-[10px] text-[#A99688] truncate">{task.occupancy.agentDisplayLabel || 'No active claimant'}</div>
                          <div className="text-[9px] font-mono text-[#806E62]">expires {formatWhen(task.occupancy.claimExpiresAt)}</div>
                        </div>

                        <div className="space-y-1.5">
                          <div className="flex justify-between gap-2 text-[10px] font-mono text-[#A99688]">
                            <span>Budget / context</span>
                            <span>cursor {task.nextContextOffset}</span>
                          </div>
                          <BudgetMeter task={task} />
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[10px] font-mono text-[#A99688]">
                        <span className="inline-flex items-center gap-1"><Cpu className="w-3 h-3" /> {task.taskRole} · loop {task.loopScriptStatus}</span>
                        <span className="inline-flex items-center gap-1"><GitBranch className="w-3 h-3" /> {task.childCount} children</span>
                        <span className="inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> {predicatesPassed}/{task.predicates.length} predicate passes</span>
                        <span className="inline-flex items-center gap-1"><TimerReset className="w-3 h-3" /> heartbeat {formatWhen(task.occupancy.heartbeatAt)}</span>
                        <span className="ml-auto inline-flex items-center gap-1 text-[#DF6B3B]">
                          {isExpanded ? 'Hide details' : 'Details'} <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                        </span>
                      </div>
                    </button>
                    <div className="flex justify-end border-t border-[#30211B] bg-[#170F0D] px-4 py-2">
                      <button
                        type="button"
                        onClick={() => void fetchSuitability(task.id)}
                        disabled={suitabilityLoading && suitabilityTaskId === task.id}
                        className="inline-flex items-center gap-2 border border-[#684331] bg-[#241814] hover:bg-[#332019] disabled:opacity-50 text-[#E8CDB7] px-2.5 py-1.5 text-[10px] font-mono rounded-sm"
                      >
                        {suitabilityLoading && suitabilityTaskId === task.id
                          ? <Loader2 className="w-3 h-3 animate-spin" />
                          : <Cpu className="w-3 h-3" />}
                        Assess suitability
                      </button>
                    </div>
                    {isExpanded && <TaskDetails task={task} />}
                    {suitabilityTaskId === task.id && (
                      <div className="border-t border-[#382821] bg-[#170F0D] p-4 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <h4 className="text-[10px] font-mono uppercase tracking-wider text-[#DF6B3B]">
                              Explainable suitability · {suitability?.candidate_count ?? 0} candidates
                            </h4>
                            <p className="text-[10px] text-[#89776B] mt-1">
                              Suitability ranks possible fits; it never grants authorization or claims this task.
                            </p>
                          </div>
                          {suitability && (
                            <span className="text-[9px] font-mono text-[#806E62]">
                              {formatWhen(suitability.evaluated_at)}
                            </span>
                          )}
                        </div>
                        {suitabilityLoading && (
                          <div className="flex items-center gap-2 text-[11px] font-mono text-[#B9AA9D]">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Evaluating registered capability and evidence signals…
                          </div>
                        )}
                        {suitabilityError && (
                          <p role="alert" className="text-[11px] text-[#F2A28F] font-mono">{suitabilityError}</p>
                        )}
                        {!suitabilityLoading && suitability && suitability.candidates.length === 0 && (
                          <p className="text-[11px] text-[#A99688]">
                            No registered, enabled worker candidates. No synthetic candidate or fallback score was generated.
                          </p>
                        )}
                        {suitability?.candidates.map((candidate, index) => (
                          <div key={candidate.evaluation_id} className="border border-[#382821] bg-[#1B120F] p-3 rounded-sm">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="min-w-0">
                                <div className="text-[11px] font-semibold text-[#F7F3EC] truncate">
                                  {index + 1}. {candidate.agent_name}
                                </div>
                                <div className="text-[9px] font-mono text-[#89776B] mt-0.5">
                                  {candidate.agent_type} · {candidate.agent_id}
                                </div>
                              </div>
                              <div className="text-right">
                                <div className="text-sm font-mono font-bold text-[#F5C979]">
                                  {(candidate.suitability_score * 100).toFixed(1)}%
                                </div>
                                <div className={`text-[9px] font-mono ${candidate.capability_complete ? 'text-[#9BE2B2]' : 'text-[#F2A28F]'}`}>
                                  {candidate.capability_complete ? 'capability-complete' : 'missing required capabilities'}
                                </div>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2 mt-3">
                              {Object.entries(candidate.components).map(([key, value]) => (
                                <div key={key} className="min-w-0">
                                  <div className="flex items-center justify-between gap-1 text-[8px] font-mono text-[#A99688]">
                                    <span className="truncate">{key.replaceAll('_', ' ')}</span>
                                    <span>{(value * 100).toFixed(0)}</span>
                                  </div>
                                  <div className="h-1 bg-[#120C0A] mt-1 overflow-hidden">
                                    <div className="h-full bg-[#B66C42]" style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
                                  </div>
                                </div>
                              ))}
                            </div>
                            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3 text-[9px] font-mono text-[#806E62]">
                              <span>claims {candidate.evidence.claim_count ?? 0}</span>
                              <span>verified {candidate.evidence.verified_count ?? 0}</span>
                              <span>predicate pass {candidate.evidence.predicate_passed_count ?? 0}/{candidate.evidence.predicate_count ?? 0}</span>
                              <span>context samples {candidate.evidence.context_samples ?? 0}</span>
                              <span>latency {candidate.evidence.average_latency_ms ? `${Math.round(candidate.evidence.average_latency_ms)}ms` : 'n/a'}</span>
                              <span>tools {candidate.evidence.matched_tools ?? 0}/{candidate.evidence.required_tools ?? 0}</span>
                            </div>
                          </div>
                        ))}
                        <p className="text-[9px] font-mono text-[#806E62]">
                          {suitability?.authorization_note || 'A canonical claim RPC is still required. Ranking never authorizes execution.'}
                        </p>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="border border-[#3B2A23] bg-[#1B120F] rounded-sm p-4 space-y-4">
          <div>
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-[#DF6B3B]" />
              <h3 className="font-display font-semibold text-[#F7F3EC]">Worker / caller profiles</h3>
            </div>
            <p className="text-[10px] font-mono text-[#89776B] mt-1">
              Registry capability metadata and authenticated socket invocation roles.
            </p>
          </div>
          {workers.length === 0 ? (
            <div className="border border-dashed border-[#594337] px-3 py-5 text-center">
              <p className="text-xs text-[#CBBFB2]">No registered worker profiles or socket invocations.</p>
              <p className="text-[10px] text-[#806E62] mt-1">No suitability score is inferred without registered capability/history data.</p>
            </div>
          ) : (
            <div className="space-y-3 max-h-[520px] overflow-y-auto pr-1">
              {workers.map((worker, index) => (
                <div key={`${worker.source}-${worker.label}-${index}`} className="border border-[#382821] bg-[#170F0D] p-3 rounded-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-[#F2EBE1] font-semibold truncate">{worker.name}</span>
                    <span className={`text-[9px] font-mono uppercase ${worker.enabled ? 'text-[#9BE2B2]' : 'text-[#F2A28F]'}`}>
                      {worker.enabled ? 'enabled' : 'expired / disabled'}
                    </span>
                  </div>
                  <div className="text-[10px] font-mono text-[#DF6B3B] mt-1">{worker.role}</div>
                  <div className="text-[9px] font-mono text-[#806E62] mt-1">{worker.label}</div>
                  {worker.capabilities.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {worker.capabilities.map((capability) => (
                        <span key={capability} className="text-[9px] font-mono border border-[#4A362D] px-1 py-0.5 text-[#CBBFB2]">{capability}</span>
                      ))}
                    </div>
                  )}
                  <div className="text-[9px] font-mono text-[#806E62] mt-2">
                    {worker.source === 'socket_invocation' ? 'expires ' + formatWhen(worker.expiresAt) : 'seen ' + formatWhen(worker.lastSeenAt)}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="border-t border-[#382821] pt-3 space-y-2">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider font-mono text-[#DF6B3B]">
              <Database className="w-3.5 h-3.5" /> Authority model
            </div>
            <p className="text-[10px] leading-relaxed text-[#A99688]">
              This view is a read-only projection. Claims and lifecycle mutations must use the authenticated ATAX MCP operations, which enforce goal scope, current fencing tokens, leases, tool grants and context budgets.
            </p>
            <p className="text-[10px] leading-relaxed text-[#A99688]">
              Actor labels are audit attribution only; orchestrator, author, executor and verifier roles do not require separate identities.
            </p>
          </div>
        </aside>
      </div>

      <div className="flex items-center justify-between text-[9px] font-mono text-[#715F54]">
        <span>Canonical snapshot · {formatWhen(snapshot?.fetchedAt || null)}</span>
        <span>{formatTokens(totalBudgetUsed)} aggregate budget tokens consumed</span>
      </div>
    </div>
  );
}
