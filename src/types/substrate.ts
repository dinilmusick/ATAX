export type ActiveTab = 'systems' | 'visions' | 'worksockets' | 'skills' | 'settings';

export type BranchingNodeKind = 'multi_in_single_out' | 'single_in_multi_out' | 'fan_out';

export type NodeTypeKey =
  | 'vision'
  | 'goal'
  | 'task'
  | 'system'
  | 'subsystem'
  | BranchingNodeKind;

export type DeadlineUrgencyLevel = 'green' | 'yellow' | 'orange' | 'red' | 'none';

export interface StickyNoteItem {
  id: string;
  scopeKey: string;
  text: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GroupingBoxItem {
  id: string;
  scopeKey: string;
  title: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BranchingNodeItem {
  id: string;
  scopeKey: string;
  kind: BranchingNodeKind;
  title: string;
  rule: string;
  description: string;
  portCount: number;
  portLabels: string[];
  x: number;
  y: number;
}

export interface CustomDomainNodeItem {
  id: string;
  scopeKey: string;
  domainKind: 'vision' | 'goal' | 'task' | 'system' | 'subsystem';
  parentId?: string | null;
  readableKey: string;
  title: string;
  description: string;
  status: string;
  subtitle: string;
  x: number;
  y: number;
}

export interface CustomEdgeItem {
  id: string;
  scopeKey: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
}

export type SavedNodePositionsMap = Record<string, Record<string, { x: number; y: number }>>;

export interface NodeColorPreferences {
  byType: Record<NodeTypeKey, string>;
  byNodeId: Record<string, string>;
}

export interface NodeDeadlineOverride {
  startAt: string;
  deadlineAt: string;
}

export type ProviderType = string;

export interface ProviderAccountSummary {
  id: string;
  provider: ProviderType;
  alias: string;
  accountId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SettingsStatusResponse {
  backend: {
    configured: boolean;
    reachable: boolean;
  };
  authentication: {
    required: true;
    authenticated: boolean;
  };
  providers: {
    github: boolean;
    cloudflare: boolean;
    neon: boolean;
    vercel: boolean;
  };
}

export interface ProviderTestResult {
  ok: boolean;
  provider: ProviderType;
  alias: string;
  statusCode: number;
  summary: string;
  checkedAt: string;
  apiReachable?: boolean;
  authVerified?: boolean;
  computeSupported?: boolean;
  inferenceSupported?: boolean;
}

export type SystemRelationType =
  | 'depends_on'
  | 'integrates_with'
  | 'interacts_with'
  | 'hosts'
  | 'deployed_on'
  | 'derived_from'
  | 'related_to'
  | 'dispatches_to';

export interface SystemFunctionSummary {
  key: string;
  name: string;
  inputContract: string;
  outputContract: string;
  description?: string;
  status?: string;
}

export interface SubstrateSubsystem {
  id: string;
  systemId: string;
  readableKey: string;
  name: string;
  subsystemType: string;
  status: string;
  contract: string;
  description: string;
}

export interface SubstrateUniverse {
  id: string;
  universeKey: string;
  name: string;
  description: string;
  status: string;
}

export interface SubstrateSystem {
  id: string;
  universeId?: string | null;
  universeName?: string | null;
  systemKey: string;
  name: string;
  systemType: string;
  status: string;
  description: string;
  contextVersion: number;
  parameters: Record<string, string | number | boolean | unknown>;
  functions: SystemFunctionSummary[];
  memoriesCount: number;
  constraintsCount: number;
  subsystems: SubstrateSubsystem[];
  position: { x: number; y: number };
}

export interface SubstrateSystemEdge {
  id: string;
  source: string;
  target: string;
  relationType: SystemRelationType | 'wormhole';
  label: string;
  isWormhole?: boolean;
  syncMode?: 'bidirectional' | 'source_to_target' | 'target_to_source';
}

export interface SystemsSubstrateResponse {
  universes: SubstrateUniverse[];
  systems: SubstrateSystem[];
  edges: SubstrateSystemEdge[];
  fetchedAt: string;
}

export interface VisionGraphNodeData {
  id: string;
  readableKey: string;
  title: string;
  description: string;
  targetType: string;
  targetLabel: string;
  status: string;
  goalsCount: number;
  createdAt?: string | null;
  deadlineAt?: string | null;
  isDerived?: boolean;
  position: { x: number; y: number };
}

export interface GoalGraphNodeData {
  id: string;
  readableKey: string;
  visionId: string | null;
  visionTargetLabel?: string | null;
  systemKey?: string | null;
  title: string;
  description?: string;
  goalType: string;
  priority: number;
  status: string;
  blockerNotoriety: number;
  progress: number;
  maxIterations: number;
  currentIteration: number;
  tasksCount: number;
  createdAt?: string | null;
  deadlineAt?: string | null;
  position: { x: number; y: number };
}

export interface TaskContextLimit {
  usedTokens: number;
  maxTokens: number;
  windowLabel: string;
}

export interface TaskCheckpointSummary {
  parameterId: string;
  objective: string;
  status: string;
  predicateKey?: string | null;
}

export interface TaskOccupancyInfo {
  agentDisplayLabel: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  claimExpiresAt: string | null;
  leaseState: 'lease_valid' | 'lease_expired' | 'no_claim' | 'unknown';
  currentStep: string | null;
  blocker: string | null;
}

export interface TaskGraphNodeData {
  id: string;
  readableKey: string;
  goalId: string | null;
  parentTaskId?: string | null;
  title: string;
  description?: string;
  taskType: string;
  status: string;
  verificationStatus: string;
  evalScript: string;
  inputs: string[];
  outputs: string[];
  toolsAvailable: string[];
  contextLimit: TaskContextLimit | null;
  checkpoints: TaskCheckpointSummary[];
  occupancy: TaskOccupancyInfo;
  blockerNotoriety: number;
  startedAt?: string | null;
  dueAt?: string | null;
  updatedAt?: string | null;
  position: { x: number; y: number };
}

export interface VisionGoalTaskEdge {
  id: string;
  source: string;
  target: string;
  edgeKind: 'vision_dependency' | 'goal_dependency' | 'task_dependency' | 'artifact_flow';
  dependencyType?: 'blocking' | 'advisory';
  label: string;
}

export interface VisionsGoalsSubstrateResponse {
  visions: VisionGraphNodeData[];
  goals: GoalGraphNodeData[];
  tasks: TaskGraphNodeData[];
  edges: VisionGoalTaskEdge[];
  fetchedAt: string;
}


export interface WorkSocketBudgetSummary {
  maxInput: number;
  maxOutput: number;
  maxTotal: number;
  inputUsed: number;
  outputUsed: number;
}

export interface WorkSocketPredicateReceipt {
  checkpointIndex: number;
  predicateKey: string;
  predicateVersion: number;
  passed: boolean;
  evidenceCount: number;
  createdAt: string | null;
}

export interface WorkSocketAuditEvent {
  eventType: string;
  message: string;
  actorLabel: string | null;
  occurredAt: string | null;
}

export interface WorkSocketTaskRecord {
  id: string;
  taskKey: string;
  goalId: string | null;
  goalKey: string | null;
  goalName: string | null;
  systemKey: string | null;
  parentTaskId: string | null;
  name: string;
  description: string;
  status: string;
  executionModel: string;
  taskRole: string;
  loopScriptStatus: string;
  verificationStatus: string;
  requiredCapabilities: string[];
  occupancy: TaskOccupancyInfo;
  budget: WorkSocketBudgetSummary | null;
  nextContextOffset: number;
  childCount: number;
  predicates: WorkSocketPredicateReceipt[];
  events: WorkSocketAuditEvent[];
  updatedAt: string | null;
}

export interface WorkSocketWorkerRecord {
  label: string;
  name: string;
  role: string;
  enabled: boolean;
  capabilities: string[];
  lastSeenAt: string | null;
  expiresAt: string | null;
  source: 'agent_registry' | 'socket_invocation' | 'intelligence_profile';
  domainAffinities?: Record<string, number>;
  toolFamiliarity?: string[];
  resourceCapacity?: Record<string, unknown>;
  modelFamilies?: string[];
}

export interface WorkSocketSubstrateResponse {
  tasks: WorkSocketTaskRecord[];
  workers: WorkSocketWorkerRecord[];
  fetchedAt: string;
}

export interface WorkSocketSuitabilityComponents {
  capability: number;
  reliability: number;
  domain_affinity: number;
  tool_familiarity: number;
  verification: number;
  latency: number;
  context_efficiency: number;
  resource_fit: number;
}

export interface WorkSocketSuitabilityCandidate {
  evaluation_id: string;
  agent_id: string;
  agent_name: string;
  agent_type: string;
  suitability_score: number;
  capability_complete: boolean;
  components: WorkSocketSuitabilityComponents;
  evidence: Record<string, number | null>;
}

export interface WorkSocketSuitabilityResponse {
  task_id: string;
  evaluated_at: string;
  candidate_count: number;
  suitability_only: true;
  authorization_note: string;
  candidates: WorkSocketSuitabilityCandidate[];
}


export interface SkillRecord {
  id: number;
  name: string;
  slug: string;
  path: string;
  description?: string;
  category: string;
  version: string;
  status: string;
  tools: Array<{
    slug: string;
    name?: string;
    type: string;
    required: boolean;
  }>;
}

export interface SkillsSubstrateResponse {
  skills: SkillRecord[];
  categories: string[];
  fetchedAt: string;
}
