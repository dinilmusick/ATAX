export type ActiveTab = 'systems' | 'visions-goals' | 'skills' | 'settings';

export type ProviderType = 'github' | 'cloudflare' | 'vercel';

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
  supabaseConfigured: boolean;
  supabaseHost: string | null;
  supabaseError: string | null;
  operatorClaimed: boolean;
  authenticated: boolean;
  operatorSubject: string | null;
  requiredEnvVars: string[];
}

export interface ProviderTestResult {
  ok: boolean;
  provider: ProviderType;
  alias: string;
  statusCode: number;
  summary: string;
  checkedAt: string;
}

export type SystemRelationType =
  | 'depends_on'
  | 'integrates_with'
  | 'interacts_with'
  | 'dispatches_to'
  | 'deployed_on';

export interface SystemFunctionSummary {
  key: string;
  name: string;
  inputContract: string;
  outputContract: string;
}

export interface SubstrateSubsystem {
  id: string;
  systemId: string;
  readableKey: string;
  name: string;
  subsystemType: string;
  status: 'active' | 'planned' | 'paused';
  contract: string;
  description: string;
}

export interface SubstrateSystem {
  id: string;
  systemKey: string;
  name: string;
  systemType: string;
  status: 'active' | 'planned' | 'paused';
  description: string;
  contextVersion: number;
  parameters: Record<string, string | number | boolean>;
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
  syncMode?: 'bidirectional' | 'source_to_target';
}

export interface VisionGraphNodeData {
  id: string;
  readableKey: string;
  title: string;
  description: string;
  targetType: string;
  targetLabel: string;
  status: 'in_progress' | 'verified' | 'planned';
  goalsCount: number;
  position: { x: number; y: number };
}

export interface GoalGraphNodeData {
  id: string;
  readableKey: string;
  visionId: string;
  title: string;
  goalType: string;
  priority: number;
  status: 'active' | 'verified' | 'queued' | 'blocked';
  blockerNotoriety: number;
  progress: number;
  maxIterations: number;
  currentIteration: number;
  tasksCount: number;
  position: { x: number; y: number };
}

export interface TaskContextLimit {
  usedTokens: number;
  maxTokens: number;
  windowLabel: string;
}

export interface TaskGraphNodeData {
  id: string;
  readableKey: string;
  goalId: string;
  title: string;
  taskType: string;
  status: 'claimed' | 'unclaimed' | 'verifying' | 'completed';
  evalScript: string;
  inputs: string[];
  outputs: string[];
  toolsAvailable: string[];
  contextLimit: TaskContextLimit;
  fencingToken: number;
  position: { x: number; y: number };
}

export interface VisionGoalTaskEdge {
  id: string;
  source: string;
  target: string;
  edgeKind: 'vision_dependency' | 'goal_dependency' | 'task_dependency' | 'artifact_flow';
  label: string;
}

export interface SkillRecord {
  id: number;
  name: string;
  slug: string;
  path: string;
  category: string;
  version: string;
  status: 'active' | 'deprecated';
  tools: Array<{
    slug: string;
    type: string;
    required: boolean;
  }>;
}
