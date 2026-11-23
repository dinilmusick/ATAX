export type BudgetDirection = 'input'|'output';
export type BudgetStatus = 'allowed'|'approaching_limit'|'input_exceeded'|'output_exceeded';
export type OverflowReason = 'input_quota'|'output_quota'|'combined_capacity';
export type ToolEnvelope = {tool: string; payload: unknown};
export type Snapshot = {
  socketId:string; modelId:string; tokenizerId:string; profileSetVersion:string;
  maxUsableTokens:number; inputLimit:number; outputLimit:number;
  /** Pinned transfer framing charge and approaching-limit policy; immutable across restores. */
  overhead:number; threshold:number; revision:number;
  attempts:number; rejectedAttempts:number; inputTokens:number; outputTokens:number;
  attemptedInputTokens:number; attemptedOutputTokens:number;
  rejectedInputTokens:number; rejectedOutputTokens:number;
  consumedTokens?:number; remainingInputTokens?:number; remainingOutputTokens?:number;
  remainingCombinedTokens?:number;
};
export type Profile = {provider?:string; contextWindowTokens:number; evidence:string};
export type BudgetOptions = {
  profile?:Profile; reliabilityCeilingTokens?:number; maxUsableTokens?:number;
  inputLimitTokens?:number; outputLimitTokens?:number;
  approachFraction?:number; messageOverheadTokens?:number;
};
export type BudgetConfig = {
  modelId:string;provider:string;verified:boolean;evidence:string;contextWindowTokens:number;
  verifiedMaxUsableTokens:number;maxUsableTokens:number;inputLimit:number;outputLimit:number;
  threshold:number;overhead:number;tokenizerId:string;profileSetVersion:string;
};
export type Decision = {
  status:BudgetStatus; accepted:boolean;direction:BudgetDirection;chargedTokens:number;
  reasons:OverflowReason[];projectedInputTokens:number;projectedOutputTokens:number;
  projectedCombinedTokens:number;accounting:Snapshot;
};
export declare const TOKENIZER_ID:string;
export declare const PROFILE_SET_VERSION:string;
export declare const UNKNOWN_CONTEXT_TOKENS:number;
export declare const VERIFIED_MODELS:Readonly<Record<string,Profile>>;
export declare function canonicalPayload(payload:unknown):string;
export declare function estimateTextTokens(text:string):number;
export declare function resolveBudget(modelId:string,options?:BudgetOptions):BudgetConfig;
export declare function createSocketBudgetMeter(socketId:string,modelId:string,
  options?:BudgetOptions,restored?:Snapshot):Readonly<{
    budget:BudgetConfig;snapshot():Snapshot;
    preview(direction:BudgetDirection,value:string|ToolEnvelope,kind?:'text'|'tool'):Decision;
    charge(direction:BudgetDirection,value:string|ToolEnvelope,kind?:'text'|'tool',expectedRevision?:number):Decision;
    chargeInput(value:string|ToolEnvelope,kind?:'text'|'tool',expectedRevision?:number):Decision;
    chargeOutput(value:string|ToolEnvelope,kind?:'text'|'tool',expectedRevision?:number):Decision;
  }>;
