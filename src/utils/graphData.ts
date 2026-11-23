import type { Edge, Node } from '@xyflow/react';
import type {
  GoalGraphNodeData,
  SkillRecord,
  SubstrateSystem,
  SubstrateSystemEdge,
  TaskContextLimit,
  TaskGraphNodeData,
  VisionGoalTaskEdge,
  VisionGraphNodeData,
} from '../types/substrate';

export const SUBSTRATE_SYSTEMS: SubstrateSystem[] = [
  {
    id: 'sys-control-plane',
    systemKey: 'atax-control-plane',
    name: 'ATAX Control Plane',
    systemType: 'repository',
    status: 'active',
    description:
      'Tool source, skill registry, and policy boundary. Never executes target builds inside ATAX Actions.',
    contextVersion: 9,
    parameters: {
      repo: 'dinilmusick/ATAX',
      hostExecution: 'forbidden',
      skillsSynced: 41,
    },
    functions: [
      {
        key: 'resolve_compute_request',
        name: 'Compute Boundary Resolver',
        inputContract: '{ target_repo, visibility }',
        outputContract: '{ execution_mode, fmrl_required }',
      },
    ],
    memoriesCount: 12,
    constraintsCount: 9,
    subsystems: [
      {
        id: 'sub-cp-skills',
        systemId: 'sys-control-plane',
        readableKey: 'SUB-CP-SKILLS',
        name: 'Canonical Skill Registry',
        subsystemType: 'registry',
        status: 'active',
        contract: 'skills/catalog.json -> tool bindings',
        description: 'Versioned skill manifest mapping canonical Supabase skills to agent tools.',
      },
      {
        id: 'sub-cp-boundary',
        systemId: 'sys-control-plane',
        readableKey: 'SUB-CP-POLICY',
        name: 'FMRL Policy Boundary Gate',
        subsystemType: 'policy',
        status: 'active',
        contract: 'target_visibility -> fmrl_route',
        description: 'Blocks private target builds inside ATAX and routes compute requests to FMRL.',
      },
    ],
    position: { x: 20, y: 20 },
  },
  {
    id: 'sys-ledger',
    systemKey: 'supabase-canonical-ledger',
    name: 'Supabase Canonical Ledger',
    systemType: 'database',
    status: 'active',
    description:
      'PostgreSQL source of truth for universes, systems, visions, goals, tasks, claims, fencing tokens, and completion predicates.',
    contextVersion: 14,
    parameters: {
      isolation: 'RLS + SECURITY DEFINER RPC',
      leaseWindowSec: 120,
      notorietyThreshold: 5,
    },
    functions: [
      {
        key: 'task_ledger_claim_next',
        name: 'Atomic Task Claim',
        inputContract: '{ agent_id, goal_key }',
        outputContract: '{ task_id, fencing_token, lease_expires_at }',
      },
      {
        key: 'task_ledger_record_handoff',
        name: 'Fenced Handoff Append',
        inputContract: '{ task_id, stale_token, partial_evidence }',
        outputContract: '{ handoff_event_id }',
      },
    ],
    memoriesCount: 18,
    constraintsCount: 7,
    subsystems: [
      {
        id: 'sub-ledger-sockets',
        systemId: 'sys-ledger',
        readableKey: 'SUB-DB-SOCKETS',
        name: 'Atomic Socket Lease Engine',
        subsystemType: 'rpc',
        status: 'active',
        contract: 'claim_next() -> fencing_token: int8',
        description: 'Enforces single-occupant task leases with monotonic fencing token guards.',
      },
      {
        id: 'sub-ledger-handoff',
        systemId: 'sys-ledger',
        readableKey: 'SUB-DB-HANDOFF',
        name: 'Append-Only Handoff Log',
        subsystemType: 'ledger',
        status: 'active',
        contract: 'stale_token -> immutable handoff row',
        description: 'Records fenced-out agent progress without mutating active task ownership.',
      },
      {
        id: 'sub-ledger-predicates',
        systemId: 'sys-ledger',
        readableKey: 'SUB-DB-GATES',
        name: 'Goal & Vision Gate Evaluator',
        subsystemType: 'sql',
        status: 'active',
        contract: 'goal-dependency-gates.sql',
        description: 'Resolves cross-goal dependencies and blocker notoriety thresholds.',
      },
    ],
    position: { x: 460, y: 20 },
  },
  {
    id: 'sys-mcp',
    systemKey: 'atax-remote-mcp-worker',
    name: 'Remote MCP Worker',
    systemType: 'service',
    status: 'active',
    description:
      'Owner-authenticated Cloudflare Worker at /mcp translating bounded tool invocations into canonical Supabase RPCs.',
    contextVersion: 11,
    parameters: {
      endpoint: '/mcp',
      runtime: 'Cloudflare Workers',
      auth: 'Bearer OAuth / Owner Secret',
    },
    functions: [
      {
        key: 'socket_gateway_dispatch',
        name: 'Socket Gateway Dispatch',
        inputContract: '{ tool_name, args, holder_id }',
        outputContract: '{ rpc_result, token_valid }',
      },
    ],
    memoriesCount: 8,
    constraintsCount: 4,
    subsystems: [
      {
        id: 'sub-mcp-router',
        systemId: 'sys-mcp',
        readableKey: 'SUB-MCP-INGRESS',
        name: 'Cloudflare /mcp Ingress',
        subsystemType: 'edge',
        status: 'active',
        contract: 'Bearer Auth -> JSON-RPC envelope',
        description: 'Validates caller credentials and routes remote MCP requests.',
      },
      {
        id: 'sub-mcp-tools',
        systemId: 'sys-mcp',
        readableKey: 'SUB-MCP-ADAPTER',
        name: 'Bounded Tool Adapter',
        subsystemType: 'adapter',
        status: 'active',
        contract: 'mcp_tool -> supabase_rpc',
        description: 'Translates bounded MCP tool calls into canonical ledger RPCs.',
      },
    ],
    position: { x: 900, y: 20 },
  },
  {
    id: 'sys-fmrl',
    systemKey: 'fmrl-disposable-compute',
    name: 'FMRL Compute Bridge',
    systemType: 'workspace',
    status: 'active',
    description:
      'One-job disposable public bridge repository for private target CI. Provisioned, verified, and deleted (404 confirmed).',
    contextVersion: 6,
    parameters: {
      prefix: 'FMRL-*',
      cleanupPolicy: 'mandatory-404-verify',
      tokenScope: 'clone-step-only',
    },
    functions: [
      {
        key: 'provision_fmrl_workspace',
        name: 'Disposable Workspace Provisioner',
        inputContract: '{ target_ref, workflow_template }',
        outputContract: '{ ephemeral_repo_url, run_id }',
      },
    ],
    memoriesCount: 5,
    constraintsCount: 6,
    subsystems: [
      {
        id: 'sub-fmrl-provisioner',
        systemId: 'sys-fmrl',
        readableKey: 'SUB-FMRL-SPAWN',
        name: 'Disposable Repo Provisioner',
        subsystemType: 'ephemeral',
        status: 'active',
        contract: 'FMRL-* creation -> isolated runner',
        description: 'Creates a single-job public runner repository with clone-only token scope.',
      },
      {
        id: 'sub-fmrl-teardown',
        systemId: 'sys-fmrl',
        readableKey: 'SUB-FMRL-404',
        name: '404 Receipt Verifier',
        subsystemType: 'verifier',
        status: 'active',
        contract: 'delete(FMRL-*) -> HTTP 404 proof',
        description: 'Confirms complete repository destruction on both pass and failure paths.',
      },
    ],
    position: { x: 20, y: 310 },
  },
  {
    id: 'sys-bridge',
    systemKey: 'github-only-ledger-bridge',
    name: 'GitHub-Only Ledger Bridge',
    systemType: 'application',
    status: 'planned',
    description:
      'Credential-bearing controller workflow bridging GitHub-only agent connectors to the Supabase task ledger.',
    contextVersion: 4,
    parameters: {
      parityStatus: 'certification-pending',
      transport: 'workflow_dispatch',
    },
    functions: [
      {
        key: 'controller_bridge_sync',
        name: 'Bridge Ledger Relay',
        inputContract: '{ issue_number, payload }',
        outputContract: '{ ledger_ack }',
      },
    ],
    memoriesCount: 3,
    constraintsCount: 5,
    subsystems: [
      {
        id: 'sub-bridge-dispatch',
        systemId: 'sys-bridge',
        readableKey: 'SUB-GH-DISPATCH',
        name: 'Workflow Dispatch Listener',
        subsystemType: 'controller',
        status: 'planned',
        contract: 'workflow_dispatch -> rpc_payload',
        description: 'Ingests structured ledger mutations from GitHub-only connectors.',
      },
      {
        id: 'sub-bridge-attest',
        systemId: 'sys-bridge',
        readableKey: 'SUB-GH-ATTEST',
        name: 'Credential Relay Signer',
        subsystemType: 'auth',
        status: 'planned',
        contract: 'scoped_secret -> ledger_ack',
        description: 'Applies controller credentials without exposing secrets to target runners.',
      },
    ],
    position: { x: 460, y: 310 },
  },
  {
    id: 'sys-looper',
    systemKey: 'omni-looper-engine',
    name: 'Omni Looper & Predicates',
    systemType: 'service',
    status: 'active',
    description:
      'Bounded loop controller and completion predicate evaluator enforcing independent author vs. verifier separation.',
    contextVersion: 8,
    parameters: {
      maxIterationsDefault: 8,
      selfCertification: false,
    },
    functions: [
      {
        key: 'evaluate_completion_predicates',
        name: 'Predicate Verifier',
        inputContract: '{ task_id, artifact_hash }',
        outputContract: '{ verdict, failed_predicates }',
      },
    ],
    memoriesCount: 9,
    constraintsCount: 4,
    subsystems: [
      {
        id: 'sub-looper-bounds',
        systemId: 'sys-looper',
        readableKey: 'SUB-LOOP-GUARD',
        name: 'Bounded Iteration Guard',
        subsystemType: 'controller',
        status: 'active',
        contract: 'max_iter + notoriety -> halt|continue',
        description: 'Tracks loop budget and escalates blocked goals beyond notoriety threshold.',
      },
      {
        id: 'sub-looper-verifier',
        systemId: 'sys-looper',
        readableKey: 'SUB-LOOP-VERIFY',
        name: 'Independent Verifier Engine',
        subsystemType: 'evaluator',
        status: 'active',
        contract: 'artifact_sha -> pass|fail verdict',
        description: 'Evaluates completion predicates strictly separated from task authors.',
      },
    ],
    position: { x: 900, y: 310 },
  },
];

export const SUBSTRATE_SYSTEM_EDGES: SubstrateSystemEdge[] = [
  {
    id: 'se-1',
    source: 'sys-control-plane',
    target: 'sys-ledger',
    relationType: 'depends_on',
    label: 'depends_on',
  },
  {
    id: 'se-2',
    source: 'sys-control-plane',
    target: 'sys-fmrl',
    relationType: 'dispatches_to',
    label: 'compute_dispatch',
  },
  {
    id: 'se-3',
    source: 'sys-mcp',
    target: 'sys-ledger',
    relationType: 'integrates_with',
    label: '/mcp RPCs',
  },
  {
    id: 'se-4',
    source: 'sys-fmrl',
    target: 'sys-bridge',
    relationType: 'interacts_with',
    label: 'evidence relay',
  },
  {
    id: 'se-5',
    source: 'sys-bridge',
    target: 'sys-ledger',
    relationType: 'wormhole',
    label: 'wormhole · bidirectional',
    isWormhole: true,
    syncMode: 'bidirectional',
  },
  {
    id: 'se-6',
    source: 'sys-looper',
    target: 'sys-mcp',
    relationType: 'interacts_with',
    label: 'loop bounds',
  },
  {
    id: 'se-7',
    source: 'sys-looper',
    target: 'sys-bridge',
    relationType: 'depends_on',
    label: 'predicate gate',
    isWormhole: true,
    syncMode: 'source_to_target',
  },
  // Subsystem data-flow & dependency edges (visible when parent systems are expanded)
  {
    id: 'sube-1',
    source: 'sub-cp-skills',
    target: 'sub-cp-boundary',
    relationType: 'depends_on',
    label: 'skill_constraints',
  },
  {
    id: 'sube-2',
    source: 'sub-ledger-sockets',
    target: 'sub-ledger-handoff',
    relationType: 'interacts_with',
    label: 'stale_token_event',
  },
  {
    id: 'sube-3',
    source: 'sub-ledger-handoff',
    target: 'sub-ledger-predicates',
    relationType: 'interacts_with',
    label: 'evidence_commit',
  },
  {
    id: 'sube-4',
    source: 'sub-mcp-router',
    target: 'sub-mcp-tools',
    relationType: 'dispatches_to',
    label: 'validated_rpc',
  },
  {
    id: 'sube-5',
    source: 'sub-fmrl-provisioner',
    target: 'sub-fmrl-teardown',
    relationType: 'interacts_with',
    label: 'ephemeral_slug',
  },
  {
    id: 'sube-6',
    source: 'sub-bridge-dispatch',
    target: 'sub-bridge-attest',
    relationType: 'dispatches_to',
    label: 'signed_payload',
  },
  {
    id: 'sube-7',
    source: 'sub-looper-bounds',
    target: 'sub-looper-verifier',
    relationType: 'depends_on',
    label: 'iteration_budget',
  },
  {
    id: 'sube-8',
    source: 'sub-mcp-tools',
    target: 'sub-ledger-sockets',
    relationType: 'integrates_with',
    label: 'atomic_claim_rpc',
  },
  {
    id: 'sube-9',
    source: 'sub-looper-verifier',
    target: 'sub-ledger-predicates',
    relationType: 'wormhole',
    label: 'verdict_sync',
    isWormhole: true,
    syncMode: 'source_to_target',
  },
];

export const VISION_NODES: VisionGraphNodeData[] = [
  {
    id: 'vision-1',
    readableKey: 'VIS-FENCING-01',
    title: 'Zero-Leakage Cross-Transport Socket Conformance',
    description:
      'Guarantee single-occupant atomic task leases, fencing token rotation, and independent verifier separation across all 3 connection modes.',
    targetType: 'system',
    targetLabel: 'supabase-canonical-ledger',
    status: 'in_progress',
    goalsCount: 2,
    position: { x: 20, y: 20 },
  },
  {
    id: 'vision-2',
    readableKey: 'VIS-FMRL-02',
    title: 'Ephemeral Private Target Verification Boundary',
    description:
      'Isolate private target testing inside FMRL disposable workspaces with strict token scoping and verified 404 teardown.',
    targetType: 'repository',
    targetLabel: 'FMRL-ephemeral-bridge',
    status: 'verified',
    goalsCount: 1,
    position: { x: 470, y: 20 },
  },
];

export const GOAL_NODES: GoalGraphNodeData[] = [
  {
    id: 'goal-1',
    readableKey: 'GOAL-101',
    visionId: 'vision-1',
    title: 'Cross-Transport Fencing & Lease Recovery',
    goalType: 'system',
    priority: 0.98,
    status: 'active',
    blockerNotoriety: 2,
    progress: 68,
    maxIterations: 6,
    currentIteration: 4,
    tasksCount: 2,
    position: { x: 24, y: 112 },
  },
  {
    id: 'goal-2',
    readableKey: 'GOAL-102',
    visionId: 'vision-1',
    title: 'Independent Loop Predicate Evaluation',
    goalType: 'coding',
    priority: 0.91,
    status: 'active',
    blockerNotoriety: 6,
    progress: 50,
    maxIterations: 8,
    currentIteration: 3,
    tasksCount: 1,
    position: { x: 380, y: 112 },
  },
  {
    id: 'goal-3',
    readableKey: 'GOAL-103',
    visionId: 'vision-2',
    title: 'FMRL Teardown & 404 Receipt Attestation',
    goalType: 'operations',
    priority: 0.87,
    status: 'verified',
    blockerNotoriety: 0,
    progress: 100,
    maxIterations: 4,
    currentIteration: 4,
    tasksCount: 1,
    position: { x: 24, y: 112 },
  },
];

export const TASK_NODES: TaskGraphNodeData[] = [
  {
    id: 'task-1',
    readableKey: 'TSK-101-A',
    goalId: 'goal-1',
    title: 'Verify Atomic Claim & Fencing Token Increment',
    taskType: 'verification',
    status: 'claimed',
    evalScript: 'pg_prove -d $ATAX_DB supabase/tests/task-socket-exclusivity-and-handoff.integration.sql',
    inputs: ['claim_request.json', 'agent_holder_id', 'lease_ttl=120s'],
    outputs: ['fencing_token: int8', 'occupancy_receipt.json'],
    toolsAvailable: ['supabase-rpc', 'pgtap', 'socket-gateway'],
    contextLimit: {
      usedTokens: 42800,
      maxTokens: 128000,
      windowLabel: '128k ctx',
    },
    fencingToken: 142,
    position: { x: 20, y: 98 },
  },
  {
    id: 'task-2',
    readableKey: 'TSK-101-B',
    goalId: 'goal-1',
    title: 'Enforce Append-Only Fenced Handoff Note',
    taskType: 'implementation',
    status: 'unclaimed',
    evalScript: 'node --test tests/task-socket-conformance/conformance.test.mjs',
    inputs: ['stale_fencing_token', 'partial_evidence_ref'],
    outputs: ['handoff_event_id', 'released_socket_state'],
    toolsAvailable: ['supabase-rpc', 'node-test', 'atax-mcp'],
    contextLimit: {
      usedTokens: 19400,
      maxTokens: 64000,
      windowLabel: '64k ctx',
    },
    fencingToken: 0,
    position: { x: 398, y: 98 },
  },
  {
    id: 'task-3',
    readableKey: 'TSK-102-A',
    goalId: 'goal-2',
    title: 'Evaluate Completion Predicates Without Author Bias',
    taskType: 'review',
    status: 'verifying',
    evalScript: 'node --test tools/looper/test/predicate-engine.test.mjs',
    inputs: ['predicate_manifest.json', 'worker_artifact_sha'],
    outputs: ['verdict: pass|fail', 'notoriety_delta'],
    toolsAvailable: ['looper-cli', 'node-test', 'supabase-rpc'],
    contextLimit: {
      usedTokens: 96500,
      maxTokens: 128000,
      windowLabel: '128k ctx',
    },
    fencingToken: 89,
    position: { x: 20, y: 98 },
  },
  {
    id: 'task-4',
    readableKey: 'TSK-103-A',
    goalId: 'goal-3',
    title: 'Confirm Ephemeral Repository 404 Post-Cleanup',
    taskType: 'operations',
    status: 'completed',
    evalScript: 'python3 -m unittest tools/github/test_disposable_workspace.py',
    inputs: ['fmrl_repo_slug', 'gh_cleanup_token'],
    outputs: ['http_404_receipt.json', 'audit_log_entry'],
    toolsAvailable: ['github-api', 'python-unittest', 'fmrl-writer'],
    contextLimit: {
      usedTokens: 14200,
      maxTokens: 32000,
      windowLabel: '32k ctx',
    },
    fencingToken: 57,
    position: { x: 20, y: 98 },
  },
];

/**
 * Pure data-flow and dependency edges (composition is represented exclusively by nesting).
 */
export const VISION_GOAL_TASK_EDGES: VisionGoalTaskEdge[] = [
  {
    id: 'vgt-v1-v2',
    source: 'vision-1',
    target: 'vision-2',
    edgeKind: 'vision_dependency',
    label: 'conformance_gate',
  },
  {
    id: 'vgt-g1-g2',
    source: 'goal-1',
    target: 'goal-2',
    edgeKind: 'goal_dependency',
    label: 'prerequisite_gate',
  },
  {
    id: 'vgt-g2-g3',
    source: 'goal-2',
    target: 'goal-3',
    edgeKind: 'goal_dependency',
    label: 'attestation_input',
  },
  {
    id: 'vgt-t1-t2',
    source: 'task-1',
    target: 'task-2',
    edgeKind: 'task_dependency',
    label: 'token_handoff',
  },
  {
    id: 'vgt-t2-t3',
    source: 'task-2',
    target: 'task-3',
    edgeKind: 'artifact_flow',
    label: 'evidence_artifact',
  },
  {
    id: 'vgt-t3-t4',
    source: 'task-3',
    target: 'task-4',
    edgeKind: 'artifact_flow',
    label: 'verdict_receipt',
  },
];

export const SKILL_CATALOG: SkillRecord[] = [
  {
    id: 7,
    name: 'Task Ledger',
    slug: 'task-ledger',
    path: 'skills/task-ledger/SKILL.md',
    category: 'Coordination',
    version: '2.5.0',
    status: 'active',
    tools: [{ slug: 'supabase', type: 'connector', required: true }],
  },
  {
    id: 4,
    name: 'Loop Generator',
    slug: 'loop-generator',
    path: 'skills/loop-generator/SKILL.md',
    category: 'Planning',
    version: '1.5.0',
    status: 'active',
    tools: [
      { slug: 'looper', type: 'cli', required: true },
      { slug: 'supabase', type: 'connector', required: false },
      { slug: 'playwright', type: 'browser', required: false },
    ],
  },
  {
    id: 10,
    name: 'Browser QA & Runtime Inspection',
    slug: 'browser-qa',
    path: 'skills/browser-qa/SKILL.md',
    category: 'Verification',
    version: '2.1.0',
    status: 'active',
    tools: [
      { slug: 'playwright', type: 'browser', required: true },
      { slug: 'typescript', type: 'cli', required: false },
    ],
  },
  {
    id: 8,
    name: 'Application Security Audit',
    slug: 'security-audit',
    path: 'skills/security-audit/SKILL.md',
    category: 'Security',
    version: '1.2.5',
    status: 'active',
    tools: [{ slug: 'gitleaks', type: 'cli', required: false }],
  },
  {
    id: 9,
    name: 'DevOps, CI/CD & Release Engineering',
    slug: 'devops-ci-release',
    path: 'skills/devops-ci-release/SKILL.md',
    category: 'Infrastructure',
    version: '1.0.9',
    status: 'active',
    tools: [{ slug: 'github', type: 'connector', required: true }],
  },
  {
    id: 3,
    name: 'Prompt Map',
    slug: 'prompt-map',
    path: 'skills/prompt-map/SKILL.md',
    category: 'Planning',
    version: '1.2.5',
    status: 'active',
    tools: [{ slug: 'tldraw-connector', type: 'mcp', required: true }],
  },
  {
    id: 14,
    name: 'Platform Adapters',
    slug: 'platform-adapters',
    path: 'skills/platform-adapters/SKILL.md',
    category: 'Infrastructure',
    version: '1.3.0',
    status: 'active',
    tools: [
      { slug: 'wrangler', type: 'cli', required: false },
      { slug: 'supabase-cli', type: 'cli', required: false },
    ],
  },
  {
    id: 19,
    name: 'Universal Task Router',
    slug: 'universal-task-router',
    path: 'skills/universal-task-router/SKILL.md',
    category: 'Coordination',
    version: '2.0.1',
    status: 'active',
    tools: [{ slug: 'supabase', type: 'connector', required: true }],
  },
];

export function formatContextUsage(limit: TaskContextLimit): {
  percent: number;
  usedLabel: string;
  maxLabel: string;
} {
  const safeMax = Math.max(1, limit.maxTokens);
  const percent = Math.min(100, Math.round((limit.usedTokens / safeMax) * 100));
  const usedLabel = `${Math.round(limit.usedTokens / 1000)}k`;
  const maxLabel = `${Math.round(safeMax / 1000)}k`;
  return { percent, usedLabel, maxLabel };
}

export interface SystemsGraphBuildOptions {
  showWormholes: boolean;
  expandedSystemIds?: string[] | Set<string>;
}

const SYSTEM_COLLAPSED_SIZE = { width: 310, height: 56 };
const SUBSYSTEM_SIZE = { width: 280, height: 50 };

export function buildSystemsGraph(
  options: SystemsGraphBuildOptions | boolean
): {
  nodes: Node[];
  edges: Edge[];
} {
  const showWormholes = typeof options === 'boolean' ? options : options.showWormholes;
  const expandedSet =
    typeof options === 'boolean'
      ? new Set<string>()
      : new Set<string>(options.expandedSystemIds ?? []);

  const gridOrder = [
    ['sys-control-plane', 'sys-ledger', 'sys-mcp'],
    ['sys-fmrl', 'sys-bridge', 'sys-looper'],
  ];

  const sysById = new Map(SUBSTRATE_SYSTEMS.map((s) => [s.id, s]));

  // Compute dynamic size of each system node based on whether its subsystems are expanded
  const sysDims = new Map<string, { width: number; height: number; expanded: boolean }>();
  for (const sys of SUBSTRATE_SYSTEMS) {
    const expanded = expandedSet.has(sys.id) && sys.subsystems.length > 0;
    if (!expanded) {
      sysDims.set(sys.id, { ...SYSTEM_COLLAPSED_SIZE, expanded: false });
    } else {
      const padTop = 72;
      const padBottom = 16;
      const gapY = 12;
      const width = 328;
      const height =
        padTop +
        sys.subsystems.length * SUBSYSTEM_SIZE.height +
        Math.max(0, sys.subsystems.length - 1) * gapY +
        padBottom;
      sysDims.set(sys.id, { width, height, expanded: true });
    }
  }

  // Compute non-overlapping 3x2 grid column X and row Y offsets
  const colWidths = [0, 1, 2].map((col) =>
    Math.max(
      sysDims.get(gridOrder[0][col])?.width ?? SYSTEM_COLLAPSED_SIZE.width,
      sysDims.get(gridOrder[1][col])?.width ?? SYSTEM_COLLAPSED_SIZE.width
    )
  );
  const rowHeights = [0, 1].map((row) =>
    Math.max(
      ...gridOrder[row].map((id) => sysDims.get(id)?.height ?? SYSTEM_COLLAPSED_SIZE.height)
    )
  );

  const colGap = 136;
  const rowGap = 108;
  const colX = [
    20,
    20 + colWidths[0] + colGap,
    20 + colWidths[0] + colGap + colWidths[1] + colGap,
  ];
  const rowY = [20, 20 + rowHeights[0] + rowGap];

  const nodes: Node[] = [];

  gridOrder.forEach((rowIds, r) => {
    rowIds.forEach((sysId, c) => {
      const sys = sysById.get(sysId);
      const dims = sysDims.get(sysId);
      if (!sys || !dims) return;

      // Parent system node MUST precede its child subsystem nodes
      nodes.push({
        id: sys.id,
        type: 'systemNode',
        position: { x: colX[c], y: rowY[r] },
        width: dims.width,
        height: dims.height,
        style: { width: dims.width, height: dims.height },
        data: { ...sys, expanded: dims.expanded },
      });

      if (dims.expanded) {
        sys.subsystems.forEach((sub, idx) => {
          nodes.push({
            id: sub.id,
            type: 'subsystemNode',
            parentId: sys.id,
            extent: 'parent',
            position: {
              x: 24,
              y: 72 + idx * (SUBSYSTEM_SIZE.height + 12),
            },
            width: SUBSYSTEM_SIZE.width,
            height: SUBSYSTEM_SIZE.height,
            style: { width: SUBSYSTEM_SIZE.width, height: SUBSYSTEM_SIZE.height },
            data: { ...sub, systemName: sys.name },
          });
        });
      }
    });
  });

  const visibleIds = new Set(nodes.map((n) => n.id));

  const handleMap: Record<string, { sourceHandle: string; targetHandle: string }> = {
    'se-1': { sourceHandle: 's-right', targetHandle: 't-left' },
    'se-2': { sourceHandle: 's-bottom', targetHandle: 't-top' },
    'se-3': { sourceHandle: 's-top', targetHandle: 't-top' },
    'se-4': { sourceHandle: 's-right', targetHandle: 't-left' },
    'se-5': { sourceHandle: 's-top', targetHandle: 't-bottom' },
    'se-6': { sourceHandle: 's-top', targetHandle: 't-bottom' },
    'se-7': { sourceHandle: 's-left', targetHandle: 't-right' },
    'sube-1': { sourceHandle: 's-bottom', targetHandle: 't-top' },
    'sube-2': { sourceHandle: 's-bottom', targetHandle: 't-top' },
    'sube-3': { sourceHandle: 's-bottom', targetHandle: 't-top' },
    'sube-4': { sourceHandle: 's-bottom', targetHandle: 't-top' },
    'sube-5': { sourceHandle: 's-bottom', targetHandle: 't-top' },
    'sube-6': { sourceHandle: 's-bottom', targetHandle: 't-top' },
    'sube-7': { sourceHandle: 's-bottom', targetHandle: 't-top' },
    'sube-8': { sourceHandle: 's-left', targetHandle: 't-right' },
    'sube-9': { sourceHandle: 's-left', targetHandle: 't-right' },
  };

  const edges: Edge[] = SUBSTRATE_SYSTEM_EDGES.filter(
    (edge) =>
      visibleIds.has(edge.source) &&
      visibleIds.has(edge.target) &&
      (showWormholes || !edge.isWormhole)
  ).map((edge) => {
    const isSubEdge = edge.source.startsWith('sub-') || edge.target.startsWith('sub-');
    const handles = handleMap[edge.id];
    return {
      id: edge.id,
      type: 'smoothstep',
      source: edge.source,
      target: edge.target,
      sourceHandle: handles?.sourceHandle,
      targetHandle: handles?.targetHandle,
      label: edge.label,
      animated: Boolean(edge.isWormhole) || isSubEdge,
      zIndex: isSubEdge ? 20 : 10,
      style: {
        stroke: edge.isWormhole ? '#D9441E' : isSubEdge ? '#DF6B3B' : '#7D6659',
        strokeWidth: edge.isWormhole ? 2 : isSubEdge ? 1.8 : 1.5,
        strokeDasharray: edge.isWormhole ? '6 4' : undefined,
      },
      labelStyle: {
        fill: '#D8CFC2',
        fontSize: 10,
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      },
      labelBgStyle: {
        fill: '#1D1411',
        fillOpacity: 0.94,
      },
      labelBgPadding: [6, 3] as [number, number],
    };
  });

  return { nodes, edges };
}

export interface VisionsGoalsBuildOptions {
  expandedVisionIds?: string[] | Set<string>;
  expandedGoalIds?: string[] | Set<string>;
}

const VISION_COLLAPSED_SIZE = { width: 350, height: 58 };
const GOAL_COLLAPSED_SIZE = { width: 316, height: 54 };
const TASK_CARD_SIZE = { width: 332, height: 54 };

export function buildVisionsGoalsGraph(
  options: VisionsGoalsBuildOptions = {}
): {
  nodes: Node[];
  edges: Edge[];
} {
  const expandedVisions = new Set<string>(options.expandedVisionIds ?? []);
  const expandedGoals = new Set<string>(options.expandedGoalIds ?? []);

  const nodes: Node[] = [];
  let visionCursorX = 20;
  const visionGap = 110;

  for (const vision of VISION_NODES) {
    const isVisionExpanded = expandedVisions.has(vision.id);
    const childGoals = GOAL_NODES.filter((g) => g.visionId === vision.id);

    if (!isVisionExpanded) {
      nodes.push({
        id: vision.id,
        type: 'visionNode',
        position: { x: visionCursorX, y: 20 },
        width: VISION_COLLAPSED_SIZE.width,
        height: VISION_COLLAPSED_SIZE.height,
        style: { width: VISION_COLLAPSED_SIZE.width, height: VISION_COLLAPSED_SIZE.height },
        data: { ...vision, expanded: false },
      });
      visionCursorX += VISION_COLLAPSED_SIZE.width + visionGap;
      continue;
    }

    // Compute nested Goal & Task layout inside this Vision container
    const goalPadSide = 26;
    const goalPadTop = 76;
    const goalPadBottom = 22;
    const goalGapX = 44;

    const goalSpecs = childGoals.map((goal) => {
      const isGoalExpanded = expandedGoals.has(goal.id);
      const childTasks = TASK_NODES.filter((t) => t.goalId === goal.id);

      if (!isGoalExpanded || childTasks.length === 0) {
        return {
          goal,
          expanded: false,
          width: GOAL_COLLAPSED_SIZE.width,
          height: GOAL_COLLAPSED_SIZE.height,
          tasks: [] as Array<{ task: TaskGraphNodeData; x: number; y: number }>,
        };
      }

      const taskPadSide = 20;
      const taskPadTop = 72;
      const taskPadBottom = 18;
      const taskGapX = 40;
      const width = Math.max(
        GOAL_COLLAPSED_SIZE.width,
        taskPadSide * 2 +
          childTasks.length * TASK_CARD_SIZE.width +
          Math.max(0, childTasks.length - 1) * taskGapX
      );
      const height = taskPadTop + TASK_CARD_SIZE.height + taskPadBottom;

      const tasks = childTasks.map((task, ti) => ({
        task,
        x: taskPadSide + ti * (TASK_CARD_SIZE.width + taskGapX),
        y: taskPadTop,
      }));

      return {
        goal,
        expanded: true,
        width,
        height,
        tasks,
      };
    });

    let goalCursorX = goalPadSide;
    const positionedGoals = goalSpecs.map((spec) => {
      const x = goalCursorX;
      goalCursorX += spec.width + goalGapX;
      return { ...spec, x, y: goalPadTop };
    });

    const visionWidth = Math.max(
      VISION_COLLAPSED_SIZE.width,
      positionedGoals.length > 0
        ? goalCursorX - goalGapX + goalPadSide
        : VISION_COLLAPSED_SIZE.width
    );
    const maxGoalHeight =
      positionedGoals.length > 0
        ? Math.max(...positionedGoals.map((g) => g.height))
        : 0;
    const visionHeight =
      positionedGoals.length > 0
        ? goalPadTop + maxGoalHeight + goalPadBottom
        : VISION_COLLAPSED_SIZE.height;

    // 1. Emit Vision container node first
    nodes.push({
      id: vision.id,
      type: 'visionNode',
      position: { x: visionCursorX, y: 20 },
      width: visionWidth,
      height: visionHeight,
      style: { width: visionWidth, height: visionHeight },
      data: { ...vision, expanded: true },
    });

    // 2. Emit nested Goal nodes (and their nested Task nodes right after each Goal)
    for (const gSpec of positionedGoals) {
      nodes.push({
        id: gSpec.goal.id,
        type: 'goalNode',
        parentId: vision.id,
        extent: 'parent',
        position: { x: gSpec.x, y: gSpec.y },
        width: gSpec.width,
        height: gSpec.height,
        style: { width: gSpec.width, height: gSpec.height },
        data: { ...gSpec.goal, expanded: gSpec.expanded },
      });

      if (gSpec.expanded) {
        for (const tSpec of gSpec.tasks) {
          nodes.push({
            id: tSpec.task.id,
            type: 'taskNode',
            parentId: gSpec.goal.id,
            extent: 'parent',
            position: { x: tSpec.x, y: tSpec.y },
            width: TASK_CARD_SIZE.width,
            height: TASK_CARD_SIZE.height,
            style: { width: TASK_CARD_SIZE.width, height: TASK_CARD_SIZE.height },
            data: { ...tSpec.task },
          });
        }
      }
    }

    visionCursorX += visionWidth + visionGap;
  }

  const visibleIds = new Set(nodes.map((n) => n.id));

  const edges: Edge[] = VISION_GOAL_TASK_EDGES.filter(
    (e) => visibleIds.has(e.source) && visibleIds.has(e.target)
  ).map((e) => {
    const isTaskFlow = e.edgeKind === 'task_dependency' || e.edgeKind === 'artifact_flow';
    const isGate = e.edgeKind === 'goal_dependency' || e.edgeKind === 'vision_dependency';
    return {
      id: e.id,
      type: 'smoothstep',
      source: e.source,
      target: e.target,
      label: e.label,
      animated: true,
      zIndex: 25,
      style: {
        stroke: isTaskFlow ? '#DF6B3B' : isGate ? '#C83214' : '#8C7263',
        strokeWidth: isGate ? 2.2 : 1.8,
        strokeDasharray: e.edgeKind === 'goal_dependency' ? '5 4' : undefined,
      },
      labelStyle: {
        fill: '#E2DACD',
        fontSize: 10,
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      },
      labelBgStyle: {
        fill: '#1D1411',
        fillOpacity: 0.94,
      },
      labelBgPadding: [6, 3] as [number, number],
    };
  });

  return { nodes, edges };
}

export function filterSkills(
  skills: SkillRecord[],
  query: string,
  category: string
): SkillRecord[] {
  const normalizedQuery = query.trim().toLowerCase();
  return skills.filter((skill) => {
    const matchesCategory = category === 'All' || skill.category === category;
    const matchesQuery =
      !normalizedQuery ||
      skill.name.toLowerCase().includes(normalizedQuery) ||
      skill.slug.toLowerCase().includes(normalizedQuery) ||
      skill.tools.some((t) => t.slug.toLowerCase().includes(normalizedQuery));
    return matchesCategory && matchesQuery;
  });
}
