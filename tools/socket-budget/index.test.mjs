import test from 'node:test';
import assert from 'node:assert/strict';
import {createSocketBudgetMeter, resolveBudget, estimateTextTokens,
  canonicalPayload, TOKENIZER_ID, VERIFIED_MODELS} from './index.mjs';

const small = () => createSocketBudgetMeter('socket-1','unlisted-small',{
  maxUsableTokens:100,inputLimitTokens:40,outputLimitTokens:60,messageOverheadTokens:0
});
test('40 percent upper bound and lower reliability ceiling always win',()=>{
  const known=resolveBudget('gpt-4o-mini');
  assert.equal(known.maxUsableTokens,51200);
  assert.equal(resolveBudget('gpt-4o-mini',{reliabilityCeilingTokens:200}).maxUsableTokens,200);
  assert.equal(resolveBudget('gpt-4o-mini',{maxUsableTokens:999999}).maxUsableTokens,51200);
  assert.equal(resolveBudget('unlisted').maxUsableTokens,3276);
  assert.equal(resolveBudget('Unlisted').verified,false);
  assert.equal(Object.keys(VERIFIED_MODELS).length,5);
  assert.equal(known.tokenizerId,TOKENIZER_ID);
});
test('all accepted repeated chunks and retries are cumulative',()=>{
  const m=small();
  assert.equal(m.chargeInput('x'.repeat(20)).status,'allowed');
  assert.equal(m.chargeInput('x'.repeat(12)).status,'approaching_limit');
  assert.equal(m.chargeInput('x'.repeat(8)).accepted,true);
  const rejected=m.chargeInput('x');
  assert.equal(rejected.status,'input_exceeded');
  assert.deepEqual(rejected.reasons,['input_quota']);
  assert.equal(m.snapshot().inputTokens,40);
  assert.equal(m.snapshot().attemptedInputTokens,41);
  assert.equal(m.snapshot().rejectedInputTokens,1);
  assert.equal(m.snapshot().attempts,4);
  assert.equal(m.snapshot().revision,4);
  assert.equal(m.chargeInput('x').status,'input_exceeded');
  assert.equal(m.snapshot().rejectedInputTokens,2);
  assert.equal(m.snapshot().attempts,5);
});
test('output quota separately enforced including attempted replays',()=>{
  const m=small();
  assert.equal(m.chargeOutput('y'.repeat(48)).status,'approaching_limit');
  assert.equal(m.chargeOutput('y'.repeat(12)).accepted,true);
  const denied=m.chargeOutput('y');
  assert.equal(denied.status,'output_exceeded');
  assert.deepEqual(denied.reasons,['output_quota']);
  assert.equal(m.snapshot().outputTokens,60);
  assert.equal(m.snapshot().attemptedOutputTokens,61);
});
test('combined quota cannot be bypassed by configuring generous directions',()=>{
  const m=createSocketBudgetMeter('combined','other',{
    maxUsableTokens:100,inputLimitTokens:100,outputLimitTokens:100,messageOverheadTokens:0
  });
  assert.equal(m.chargeInput('x'.repeat(70)).accepted,true);
  const denied=m.chargeOutput('y'.repeat(40));
  assert.equal(denied.status,'output_exceeded');
  assert.deepEqual(denied.reasons,['combined_capacity']);
  assert.equal(m.snapshot().remainingCombinedTokens,30);
  assert.equal(m.snapshot().outputTokens,0);
  assert.equal(m.chargeOutput('y'.repeat(30)).accepted,true);
});
test('Unicode and JSON canonicalisation are deterministic',()=>{
  assert.equal(estimateTextTokens('💡'),4);
  assert.equal(estimateTextTokens('é'),2);
  assert.equal(estimateTextTokens('a'),1);
  assert.equal(canonicalPayload({z:1,a:{b:'💡',a:2}}),
    canonicalPayload({a:{a:2,b:'💡'},z:1}));
  const m=small();
  const e={tool:'search',payload:{b:['💡'],a:3}};
  assert.equal(m.chargeInput(e,'tool').chargedTokens,
    estimateTextTokens(canonicalPayload(e)));
  assert.throws(()=>m.chargeInput({tool:'search',payload:new Uint8Array([1])},'tool'),/plain JSON/);
  assert.throws(()=>m.chargeInput({tool:'search',payload:undefined},'tool'),/finite JSON/);
});
test('preflight is read only; admission is the charge operation',()=>{
  const m=small();
  assert.equal(m.preview('input','x'.repeat(20)).accepted,true);
  assert.equal(m.preview('input','x'.repeat(20)).accepted,true);
  assert.equal(m.snapshot().revision,0);
  m.chargeInput('x'.repeat(20));
  assert.equal(m.snapshot().revision,1);
});
test('old revision cannot replace an admitted transfer',()=>{
  const m=small();
  m.chargeInput('one', 'text',0);
  assert.throws(()=>m.chargeInput('replay','text',0),/STALE_BUDGET_REVISION/);
  assert.equal(m.snapshot().attempts,1);
});
test('restoration retains counters and rejects negative or tampered snapshots',()=>{
  const m=small();m.chargeInput('abc');
  const snap=m.snapshot();
  const restored=createSocketBudgetMeter('socket-1','unlisted-small',{
    maxUsableTokens:100,inputLimitTokens:40,outputLimitTokens:60,messageOverheadTokens:0
  },snap);
  assert.equal(restored.snapshot().inputTokens,3);
  restored.chargeInput('abc');
  assert.equal(restored.snapshot().inputTokens,6);
  assert.throws(()=>createSocketBudgetMeter('socket-1','unlisted-small',{
    maxUsableTokens:100,inputLimitTokens:40,outputLimitTokens:60,messageOverheadTokens:0
  },{...snap,inputTokens:-1}),/safe integer/);
  assert.throws(()=>createSocketBudgetMeter('wrong-socket','unlisted-small',{
    maxUsableTokens:100,inputLimitTokens:40,outputLimitTokens:60,messageOverheadTokens:0
  },snap),/mismatch/);
});
test('fail closed on unsupported formats or unverified capacity evidence',()=>{
  assert.throws(()=>resolveBudget('model',{profile:{contextWindowTokens:999999}}),/HTTPS/);
  assert.throws(()=>resolveBudget('x',{maxUsableTokens:-1}),/safe integer/);
  assert.throws(()=>resolveBudget('x',{inputLimitTokens:99999999}),/directional quota/);
  const m=small();
  assert.throws(()=>m.chargeInput({}),/expected string/);
  assert.throws(()=>m.chargeInput(null,'tool'),/tool envelope/);
  assert.equal(m.snapshot().attempts,0);
});
test('message framing overhead is charged on every request including empty strings',()=>{
  const m=createSocketBudgetMeter('overhead','unknown',{
    maxUsableTokens:100,inputLimitTokens:50,outputLimitTokens:50,messageOverheadTokens:8
  });
  m.chargeInput('');m.chargeInput('');
  assert.equal(m.snapshot().inputTokens,16);
});

test('model metadata is immutable and an arbitrary HTTPS URL cannot increase context',()=>{
  const original=VERIFIED_MODELS['gpt-4o-mini'].contextWindowTokens;
  assert.throws(()=>{VERIFIED_MODELS['gpt-4o-mini'].contextWindowTokens=999999999;},TypeError);
  assert.equal(VERIFIED_MODELS['gpt-4o-mini'].contextWindowTokens,original);
  assert.throws(()=>resolveBudget('unknown',{profile:{provider:'fake',contextWindowTokens:999999999,evidence:'https://example.com/untrusted'}}),/cannot increase pinned/);
  assert.throws(()=>resolveBudget('gpt-4o-mini',{profile:{provider:'fake',contextWindowTokens:999999999,evidence:'https://example.com/untrusted'}}),/cannot increase pinned/);
  assert.equal(resolveBudget('unknown',{profile:{contextWindowTokens:4000,evidence:'https://example.com/only-reduction'}}).verified,false);
  assert.equal(resolveBudget('unknown',{profile:{contextWindowTokens:4000,evidence:'https://example.com/only-reduction'}}).maxUsableTokens,1600);
});
test('sparse arrays fail closed before an optimistic JSON undercount',()=>{
  const sparse=Array(5);
  assert.ok(JSON.stringify(sparse).length>('[,,,,]').length);
  assert.throws(()=>canonicalPayload(sparse),/sparse JSON/);
  const m=small();
  assert.throws(()=>m.chargeInput({tool:'x',payload:sparse},'tool'),/sparse JSON/);
  assert.equal(m.snapshot().attempts,0);
});
test('restore must preserve pinned metering policy and deny drift',()=>{
  const opts={maxUsableTokens:100,inputLimitTokens:75,outputLimitTokens:25,messageOverheadTokens:8};
  const m=createSocketBudgetMeter('policy','other',opts);
  const snap=m.snapshot();
  assert.throws(()=>createSocketBudgetMeter('policy','other',{...opts,messageOverheadTokens:0},snap),/mismatch/);
  assert.throws(()=>createSocketBudgetMeter('policy','other',{...opts,approachFraction:.9},snap),/mismatch/);
  assert.equal(createSocketBudgetMeter('policy','other',opts,snap).snapshot().overhead,8);
});
test('conservative free-tier Cerebras context profile is source-backed',()=>{
  const p=resolveBudget('cerebras/gpt-oss-120b:free');
  assert.equal(p.provider,'cerebras');
  assert.equal(p.contextWindowTokens,64000);
  assert.equal(p.maxUsableTokens,25600);
  assert.equal(p.verified,true);
});
