export interface LedgerDb {
  rpc(name: string, params?: Record<string, unknown>): Promise<unknown>;
  skills(term: string): Promise<unknown>;
  skill(slug: string): Promise<unknown>;
  request(path: string, options?: RequestInit): Promise<unknown>;
  ping(): Promise<boolean>;
}

export interface LedgerConfig {
  url: string;
  baseUrl: string;
  key: string;
  apiKey: string;
}

export declare const PARAM_KEY_REGEX: RegExp;
export declare const CANONICAL_RPC_ALLOWLIST: ReadonlySet<string>;
export declare const ALLOWED_RPCS: ReadonlySet<string>;
export declare const INSTANCE_CONTROL_PLANE_RPCS: ReadonlySet<string>;
export declare const CONTROL_PLANE_RPC_ALLOWLIST: ReadonlySet<string>;

export declare class LedgerError extends Error {
  code: string;
  status: number;
  rpcName: string | null;
  constructor(message: string, code?: string, status?: number, rpcName?: string | null);
}

export declare function assertAllowedRpc(name: string, allowlist?: ReadonlySet<string>): void;
export declare function parseDataApiConfig(env: Record<string, string | undefined>): LedgerConfig;
export declare const parseSupabaseConfig: typeof parseDataApiConfig;
export declare function validateRpcParams(params: Record<string, unknown>): string;
export declare function sanitizeErrorMessage(raw: string): string;
export declare function createLedgerDb(
  config: LedgerConfig,
  fetcher?: typeof fetch,
  allowlist?: ReadonlySet<string>
): LedgerDb;
export declare function openLedger(
  bootstrapEnv?: Record<string, string | undefined>,
  fetcher?: typeof fetch
): Promise<LedgerDb>;
export declare function openControlPlaneLedger(
  bootstrapEnv?: Record<string, string | undefined>,
  fetcher?: typeof fetch
): Promise<LedgerDb>;
