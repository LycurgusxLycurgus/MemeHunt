import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk';
import { computeSynchronyStatistics, type SynchronyRole } from '../src/providers/advisory-synchrony.js';
import { decodePumpSwapSynchronyTransaction, decodePumpSwapWindowTransaction } from '../src/providers/advisory-trades.js';
import { projectCompiledTransaction } from '../src/providers/advisory-demand-windows.js';

const roles:SynchronyRole[]=[
 {signature:'a',slot:100,stratum:0,feePayer:'relay',legs:[{user:'alice',side:'BUY',funding:'SPONSORED'},{user:'bob',side:'BUY',funding:'SPONSORED'}]},
 {signature:'b',slot:100,stratum:0,feePayer:'relay',legs:[{user:'alice',side:'BUY',funding:'SPONSORED'}]},
 {signature:'c',slot:100,stratum:0,feePayer:'self',legs:[{user:'self',side:'BUY',funding:'SELF'},{user:'program',side:'BUY',funding:'PROGRAM'}]},
 {signature:'d',slot:100,stratum:0,feePayer:'relay',legs:[{user:'seller',side:'SELL',funding:'SPONSORED'}]},
];
test('shared statistics preserve transaction/user exclusion and include SELF/PROGRAM in denominator',()=>{
 const before=structuredClone(roles),s=computeSynchronyStatistics(roles,'pool','2026-10-26T08:00:00.000Z','sponsored-fee-payer-synchrony-v1');
 assert.deepEqual(roles,before);assert.equal(s.denominator,6);assert.deepEqual(s.fundingClasses,{SELF:1,SPONSORED:4,PROGRAM:1});
 assert.deepEqual(s.transactions,{withTrades:4,sponsored:3,multiLeg:2});
 // a/alice cannot pair with b/alice; a/bob and b/alice can pair. Same-transaction a/alice and a/bob never pair each other.
 for(const b of s.bins){assert.equal(b.synchronizedTrades,2);assert.equal(b.fraction,'0.33333333333333333333');assert.equal(b.null.permutations,999);assert.equal(b.null.minFraction,b.fraction);assert.equal(b.null.maxFraction,b.fraction);assert.equal(b.null.atLeastObserved,999);}
 assert.equal(s.seed,createHash('sha256').update(JSON.stringify(['sponsored-fee-payer-synchrony-v1','pool','2026-10-26T08:00:00.000Z',['a','b','c','d']])).digest('hex'));
 const v2=computeSynchronyStatistics(roles,'pool','2026-10-26T08:00:00.000Z','sponsored-fee-payer-synchrony-v2');
 assert.notEqual(v2.seed,s.seed);assert.deepEqual(v2.bins,s.bins);assert.deepEqual(v2,computeSynchronyStatistics(roles,'pool','2026-10-26T08:00:00.000Z','sponsored-fee-payer-synchrony-v2'));
 assert.throws(()=>computeSynchronyStatistics([],'pool','end','sponsored-fee-payer-synchrony-v2'),/SYNCHRONY_DENOMINATOR_ZERO/);
});

test('null shuffles stay inside relative hour strata',()=>{
 const isolated:SynchronyRole[]=[
  {signature:'one',slot:100,stratum:0,feePayer:'relay',legs:[{user:'a',side:'BUY',funding:'SPONSORED'}]},
  {signature:'two',slot:1000,stratum:11,feePayer:'relay',legs:[{user:'b',side:'BUY',funding:'SPONSORED'}]},
 ];
 for(const b of computeSynchronyStatistics(isolated,'pool','end','sponsored-fee-payer-synchrony-v2').bins){assert.equal(b.synchronizedTrades,0);assert.equal(b.null.maxFraction,'0');assert.equal(b.null.atLeastObserved,999);}
});

const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/a29-c5-wbtc-receipts.json',import.meta.url),'utf8'));
const pool=PUMP_AMM_SDK.decodePool({data:Buffer.from(fixture.pool.dataBase64,'base64')} as any);
const source=fixture.receipts['002'];
const projected=()=>projectCompiledTransaction(JSON.parse(source.response).result);
const count=(value:any,expected=source.expected)=>decodePumpSwapSynchronyTransaction(value,expected,fixture.pool.key,pool,fixture.pool.stateSlot,source.retrieved,fixture.quoteProgram,fixture.quoteDecimals,{logRecovery:true,foreignFlowRecovery:true,compiledRecovery:true});
const financial=(value:any,expected=source.expected)=>decodePumpSwapWindowTransaction(value,expected,fixture.pool.key,pool,fixture.pool.stateSlot,source.retrieved,true,true,true,true,true,true,fixture.quoteProgram,true,fixture.quoteDecimals,true,true);

test('count witness projects canonical event provenance and never exposes money fields',()=>{
 const value=projected(),old=financial(value),proof=count(value);
 assert.ok(proof.trades.length>0);assert.equal(proof.trades.length,old.trades.length);
 for(const[t,i]of proof.trades.map((t,i)=>[t,i] as const)){
  const prior=old.trades[i]!;assert.deepEqual([t.signature,t.slot,t.at,t.user,t.side,t.instructionIndex,t.provenance],[prior.signature,prior.slot,prior.at,prior.user,prior.side,prior.instructionIndex,prior.provenance]);
  assert.match(t.programTimestamp,/^(0|[1-9]\d*)$/);assert.ok(Number(t.programTimestamp)*1000<=Date.parse(source.retrieved));
  for(const key of ['baseAtomic','quoteAtomic','quoteAccounting','poolBaseReservesAtomic','poolQuoteReservesAtomic','virtualQuoteReservesAtomic'])assert.equal(Object.hasOwn(t,key),false,key);
 }
});

test('O23 keeps separate clocks and canonical index time without changing financial profiles',()=>{
 const residuals=JSON.parse(readFileSync(new URL('../../tests/fixtures/advisory-synchrony-bulk-residuals.json',import.meta.url),'utf8'));
 const bank=JSON.parse(residuals.poolSource.raw).result;
 const nativePool=PUMP_AMM_SDK.decodePool({data:Buffer.from(bank.value[0].data[0],'base64')} as any);
 const cases=residuals.cases.filter((c:any)=>['ADVISORY_TRADE_MULTIHOP_EVENT_BINDING','ADVISORY_TRADE_EVENT_BINDING'].includes(c.originalFailure));
 assert.equal(cases.length,5);
 for(const c of cases){
  // Actual retained source bytes and canonical index time remain unchanged, including the20:00 cohort edge.
  const value=c.transaction,expected={signature:c.signature,slot:value.slot,at:c.indexAt},retrieved=c.bulkSource.retrievedAt;
  const invoke=(v:any)=>decodePumpSwapSynchronyTransaction(v,expected,residuals.pool,nativePool,bank.context.slot,retrieved,fixture.quoteProgram,fixture.quoteDecimals);
  assert.throws(()=>decodePumpSwapWindowTransaction(value,expected,residuals.pool,nativePool,bank.context.slot,retrieved,true,true,false,false,false,true,fixture.quoteProgram,true,fixture.quoteDecimals),new RegExp(c.originalFailure));
  const proof=invoke(value);assert.equal(proof.trades.length,1);
  const t=proof.trades[0]!;assert.equal(t.at,c.indexAt);assert.equal(Number(t.programTimestamp),value.blockTime-1);assert.equal(t.provenance.eventPayload.length>0,true);
  const mismatch=structuredClone(value);mismatch.slot++;
  assert.throws(()=>invoke(mismatch),/ADVISORY_TRADE_TRANSACTION_BINDING/);
  const failed=structuredClone(value);failed.meta.err={InstructionError:[0,'Custom']};
  assert.throws(()=>invoke(failed),/ADVISORY_TRADE_TRANSACTION_BINDING/);
  assert.throws(()=>decodePumpSwapSynchronyTransaction(value,expected,residuals.pool,nativePool,bank.context.slot,retrieved,fixture.quoteProgram,fixture.quoteDecimals,{compiledRecovery:true}),/ADVISORY_TRADE_SYNCHRONY_SCOPE/);
 }
});
