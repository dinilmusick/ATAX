export interface LedgerDb {
  rpc(name: string, params?: Record<string, unknown>): Promise<unknown>;
  query(sql: string, values?: unknown[]): Promise<Array<Record<string, unknown>>>;
  ping(): Promise<boolean>;
  skills(term: string): Promise<unknown>;
  skill(slug: string): Promise<unknown>;
  skillsCatalog(): Promise<unknown>;
}

export interface LedgerConfig {
  connectionString: string;
  hostLabel: string;
}

export declare const CANONICAL_RPC_ALLOWLIST: ReadonlySet<string>;
export declare const ALLOWED_RPCS: ReadonlySet<string>;
export declare class LedgerError extends Error {
  code: string;
  status: number;
  rpcName: string | null;
  constructor(message: string, code?: string, status?: number, rpcName?: string | null);
}
export declare function sanitizeErrorMessage(raw: string): string;
export declare function assertAllowedRpc(name: string): void;
export declare function validateRpcParams(params: Record<string, unknown>): string;
export declare function parseDataApiConfig(env: Record<string, string | undefined>): LedgerConfig;
export declare const parseSupabaseConfig: typeof parseDataApiConfig;
export declare function createLedgerDb(config: LedgerConfig): LedgerDb;
export declare function openLedger(env?: Record<string, string | undefined>): Promise<LedgerDb>;
