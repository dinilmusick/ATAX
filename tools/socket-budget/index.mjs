/** ATAX Socket V1. Dependency-free, pinned conservative text metering. */
export const TOKENIZER_ID = 'utf8-byte-upper-bound-v1';
export const PROFILE_SET_VERSION = '2026-11-22.2';
export const UNKNOWN_CONTEXT_TOKENS = 8192;
export const VERIFIED_MODELS = Object.freeze(Object.fromEntries(Object.entries({
  'gpt-4o-mini': {provider:'openai',contextWindowTokens:128000,evidence:'https://platform.openai.com/docs/models/gpt-4o-mini'},
  'claude-haiku-4-5-20251001': {provider:'anthropic',contextWindowTokens:200000,evidence:'https://docs.anthropic.com/en/docs/about-claude/models/overview'},
  'gemini-3.1-flash-lite': {provider:'google',contextWindowTokens:1048576,evidence:'https://ai.google.dev/gemini-api/docs/models'},
  'grok-4.7': {provider:'xai',contextWindowTokens:500000,evidence:'https://docs.x.ai/developers/grok-4-7'},
  // Documented '65k' Cerebras FREE tier; 64,000 is intentionally below the rounded claim.
  'cerebras/gpt-oss-120b:free': {provider:'cerebras',contextWindowTokens:64000,evidence:'https://inference-docs.cerebras.ai/models/overview'}
}).map(([id, profile]) => [id, Object.freeze(profile)])));
const encode = new TextEncoder();
const integer = (v,n,min=0) => {
  if (!Number.isSafeInteger(v) || v < min) throw new RangeError(n+' must be a safe integer >= '+min);
  return v;
};
const safeAdd = (a,b,n) => {
  if (b > Number.MAX_SAFE_INTEGER-a) throw new RangeError(n+' overflow');
  return a+b;
};
const name = (v,n) => {
  if(typeof v!=='string'||!v.trim()) throw new TypeError(n+' must be nonempty');
  return v.trim();
};
const json = value => {
  const seen = new Set();
  function walk(v) {
    if(v===null||typeof v==='string'||typeof v==='boolean') return JSON.stringify(v);
    if(typeof v==='number'&&Number.isFinite(v)) return JSON.stringify(v);
    if(!v||typeof v!=='object') throw new TypeError('finite JSON values only');
    if(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)
      throw new TypeError('plain JSON values only');
    if(seen.has(v)) throw new TypeError('cyclic JSON not supported');
    if(Array.isArray(v)) {
      // JSON.stringify turns holes into null; map() silently skips them.
      // Refuse sparse inputs rather than measure fewer bytes than the wire body.
      for(let i=0;i<v.length;i++)
        if(!Object.prototype.hasOwnProperty.call(v,i)) throw new TypeError('sparse JSON arrays unsupported');
    }
    seen.add(v);
    const result=Array.isArray(v)?'['+v.map(walk).join(',')+']'
      :'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+walk(v[k])).join(',')+'}';
    seen.delete(v);
    return result;
  }
  return walk(value);
};
export function canonicalPayload(value) { return json(value); }
export function estimateTextTokens(text) {
  if(typeof text!=='string') throw new TypeError('expected string');
  return encode.encode(text).byteLength;
}
export function resolveBudget(modelId, options={}) {
  const id=name(modelId,'modelId').toLowerCase();
  if(!options||typeof options!=='object'||Array.isArray(options)) throw new TypeError('options must be object');
  const known=VERIFIED_MODELS[id];
  const override=options.profile;
  // An untrusted HTTPS URL is not a verification of arbitrary model capacity.
  // Overrides only LOWER the pinned capacity (or the unknown-model fallback).
  const pinnedWindow=known?.contextWindowTokens??UNKNOWN_CONTEXT_TOKENS;
  if(override!==undefined) {
    if(!override || typeof override!=='object' ||
      typeof override.evidence!=='string' || !/^https:\/\//.test(override.evidence))
      throw new TypeError('capacity override requires HTTPS source');
    integer(override.contextWindowTokens,'contextWindowTokens',1);
    if(override.contextWindowTokens>pinnedWindow)
      throw new RangeError('untrusted profile cannot increase pinned capacity');
  }
  const verified=known!==undefined;
  const contextWindowTokens=override?.contextWindowTokens??pinnedWindow;
  const ceiling=Math.floor(contextWindowTokens*0.4);
  const maxUsableTokens=Math.min(ceiling,
    integer(options.reliabilityCeilingTokens??ceiling,'reliabilityCeilingTokens',1),
    integer(options.maxUsableTokens??ceiling,'maxUsableTokens',1));
  if(maxUsableTokens<2) throw new RangeError('usable capacity too small');
  const inputLimit=integer(options.inputLimitTokens??Math.floor(maxUsableTokens*.75),'inputLimitTokens',1);
  const outputLimit=integer(options.outputLimitTokens??(maxUsableTokens-Math.floor(maxUsableTokens*.75)),'outputLimitTokens',1);
  if(inputLimit>maxUsableTokens||outputLimit>maxUsableTokens)
    throw new RangeError('directional quota exceeds combined limit');
  const threshold=options.approachFraction??.8;
  if(typeof threshold!=='number'||!Number.isFinite(threshold)||threshold<=0||threshold>1)
    throw new RangeError('approachFraction must be (0,1]');
  const overhead=integer(options.messageOverheadTokens??8,'messageOverheadTokens');
  return Object.freeze({modelId:id,provider:known?.provider??'unknown',verified,
    evidence:override?.evidence??known?.evidence??'conservative-unverified-fallback',contextWindowTokens,
    verifiedMaxUsableTokens:ceiling,maxUsableTokens,inputLimit,outputLimit,
    threshold,overhead,tokenizerId:TOKENIZER_ID,profileSetVersion:PROFILE_SET_VERSION});
}
function check(s,b,socketId) {
  if(!s||typeof s!=='object'||Array.isArray(s)||
    s.socketId!==socketId||s.modelId!==b.modelId||
    s.tokenizerId!==TOKENIZER_ID||s.profileSetVersion!==PROFILE_SET_VERSION||
    s.maxUsableTokens!==b.maxUsableTokens||s.inputLimit!==b.inputLimit||s.outputLimit!==b.outputLimit||
    s.overhead!==b.overhead||s.threshold!==b.threshold)
      throw new Error('snapshot identity/profile mismatch');
  for(const key of ['revision','attempts','rejectedAttempts','inputTokens','outputTokens',
    'attemptedInputTokens','attemptedOutputTokens','rejectedInputTokens','rejectedOutputTokens'])
    integer(s[key],key);
  if(s.inputTokens>b.inputLimit||s.outputTokens>b.outputLimit||
    s.inputTokens+s.outputTokens>b.maxUsableTokens||
    s.attemptedInputTokens-s.inputTokens!==s.rejectedInputTokens||
    s.attemptedOutputTokens-s.outputTokens!==s.rejectedOutputTokens||
    s.rejectedAttempts>s.attempts)
      throw new Error('invalid/negative/inconsistent snapshot counters');
  return Object.freeze({...s});
}
/** Synchronous reference. Production must CAS-persist revised snapshots under an unexpired socket fence before egress. */
export function createSocketBudgetMeter(socketId,modelId,options={},restored) {
  name(socketId,'socketId');
  const budget=resolveBudget(modelId,options);
  let state=check(restored??{socketId,modelId:budget.modelId,
    tokenizerId:TOKENIZER_ID,profileSetVersion:PROFILE_SET_VERSION,
    maxUsableTokens:budget.maxUsableTokens,inputLimit:budget.inputLimit,outputLimit:budget.outputLimit,
    overhead:budget.overhead,threshold:budget.threshold,
    revision:0,attempts:0,rejectedAttempts:0,inputTokens:0,outputTokens:0,
    attemptedInputTokens:0,attemptedOutputTokens:0,rejectedInputTokens:0,rejectedOutputTokens:0},budget,socketId);
  const snapshot=()=>Object.freeze({...state,consumedTokens:state.inputTokens+state.outputTokens,
    remainingInputTokens:budget.inputLimit-state.inputTokens,
    remainingOutputTokens:budget.outputLimit-state.outputTokens,
    remainingCombinedTokens:budget.maxUsableTokens-state.inputTokens-state.outputTokens});
  const count=(value,kind)=>{
    if(kind==='text') return estimateTextTokens(value);
    if(kind==='tool') {
      if(!value||typeof value!=='object'||Array.isArray(value)||
        typeof value.tool!=='string'||!value.tool.trim()||
        !Object.prototype.hasOwnProperty.call(value,'payload'))
        throw new TypeError('tool envelope must contain tool and payload');
      return estimateTextTokens(canonicalPayload(value));
    }
    throw new TypeError('unknown payload kind');
  };
  const decision=(direction,value,kind='text')=>{
    if(direction!=='input'&&direction!=='output') throw new TypeError('invalid direction');
    const charge=safeAdd(count(value,kind),budget.overhead,'per-transfer tokens');
    const i=safeAdd(state.inputTokens,direction==='input'?charge:0,'projected input');
    const o=safeAdd(state.outputTokens,direction==='output'?charge:0,'projected output');
    const reasons=[];
    if(i>budget.inputLimit) reasons.push('input_quota');
    if(o>budget.outputLimit) reasons.push('output_quota');
    if(i+o>budget.maxUsableTokens) reasons.push('combined_capacity');
    const accepted=reasons.length===0;
    const approaching=accepted&&(i>=Math.ceil(budget.inputLimit*budget.threshold)||
      o>=Math.ceil(budget.outputLimit*budget.threshold)||
      i+o>=Math.ceil(budget.maxUsableTokens*budget.threshold));
    return Object.freeze({status:!accepted?(direction==='input'?'input_exceeded':'output_exceeded')
      :approaching?'approaching_limit':'allowed',accepted,direction,chargedTokens:charge,
      reasons,projectedInputTokens:i,projectedOutputTokens:o,projectedCombinedTokens:i+o,
      accounting:snapshot()});
  };
  const charge=(direction,value,kind='text',expectedRevision=state.revision)=>{
    integer(expectedRevision,'expectedRevision');
    if(expectedRevision!==state.revision) throw new Error('STALE_BUDGET_REVISION');
    const d=decision(direction,value,kind),n=d.chargedTokens,ok=d.accepted,inp=direction==='input';
    state=check({...state,revision:safeAdd(state.revision,1,'revision'),
      attempts:safeAdd(state.attempts,1,'attempts'),
      rejectedAttempts:safeAdd(state.rejectedAttempts,ok?0:1,'rejectedAttempts'),
      inputTokens:safeAdd(state.inputTokens,ok&&inp?n:0,'inputTokens'),
      outputTokens:safeAdd(state.outputTokens,ok&&!inp?n:0,'outputTokens'),
      attemptedInputTokens:safeAdd(state.attemptedInputTokens,inp?n:0,'attemptedInputTokens'),
      attemptedOutputTokens:safeAdd(state.attemptedOutputTokens,!inp?n:0,'attemptedOutputTokens'),
      rejectedInputTokens:safeAdd(state.rejectedInputTokens,!ok&&inp?n:0,'rejectedInputTokens'),
      rejectedOutputTokens:safeAdd(state.rejectedOutputTokens,!ok&&!inp?n:0,'rejectedOutputTokens')
    },budget,socketId);
    return Object.freeze({...d,accounting:snapshot()});
  };
  return Object.freeze({budget,snapshot,preview:decision,charge,
    chargeInput:(v,k='text',r=state.revision)=>charge('input',v,k,r),
    chargeOutput:(v,k='text',r=state.revision)=>charge('output',v,k,r)});
}
