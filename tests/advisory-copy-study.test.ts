import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateS16Study,serializeS16,s16CompleteModeledCosts,S16_REQUIRED_COST_KINDS,type S16StudyInput,type S16StudyTrade} from '../src/providers/advisory-copy-study.js';
import type {DirectPrestate} from '../src/providers/advisory-copy-quote.js';
// Every prestate and native order in this file is constructed; no historical fill or source authority is claimed.
const state=(side:'BUY'|'SELL'):DirectPrestate=>({baseReserve:1_000_000_000n,quoteReserve:1_000_000_000n,virtualQuoteReserve:1_000_000n,rates:{lpBps:20n,protocolBps:5n,creatorBps:300n,buybackBps:5000n},rateWitnessSide:side,creatorActive:true,holderRewardMode:'NONE',cashbackBps:0n,quoteTransferFee:'ZERO_WITNESSED',baseTransferFee:'ZERO_DECLARED_PREMISE'});
function fixture():S16StudyInput{
 const spec:Array<[string,'BUY'|'SELL','DIRECT'|'ROUTE']>=[['00:01:00','BUY','DIRECT'],['00:01:01','BUY','ROUTE'],['00:01:02','BUY','DIRECT'],['01:01:01','SELL','DIRECT'],['01:01:02','SELL','ROUTE'],['01:01:03','SELL','DIRECT']];
 const trades:S16StudyTrade[]=spec.map(([time,side,nativeFamily],ordinal)=>({ordinal,signature:'synthetic-'+ordinal,slot:100+ordinal,transactionIndex:0,at:'2026-10-25T'+time+'.000Z',side,nativeFamily,state:nativeFamily==='DIRECT'?state(side):null,unsupportedReason:null,proof:{kind:'CONSTRUCTED_SYNTHETIC'}}));
 return{token:{chain:'solana',address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'},pool:'synthetic-pool',range:{start:'2026-10-25T00:00:00.000Z',end:'2026-10-25T06:00:00.000Z'},complete:true,detectedAt:'2026-10-25T00:00:00.276Z',callRefs:[{sourceId:'a'},{sourceId:'b'},{sourceId:'c'}],trades,availableAt:'2026-10-26T00:00:00.000Z',sourceSummary:{kind:'CONSTRUCTED_SYNTHETIC'}};
}
const run=(v:S16StudyInput)=>serializeS16(evaluateS16Study(v)) as any;
test('fractional detection latency and one-hour rule select first direct native anchors without rounding backward',()=>{
 const f=fixture(),r=run(f);assert.equal(r.quality,'KNOWN');assert.equal(r.data.status,'EXECUTED_CONDITIONALLY');assert.equal(r.data.entryAnchor.ordinal,2);assert.equal(r.data.exitAnchor.ordinal,5);assert.equal(r.data.entryTriggerAt,'2026-10-25T00:01:00.276Z');assert.equal(r.data.exitTriggerAt,'2026-10-25T01:01:02.000Z');assert.equal(r.data.holdingDurationMs,3601000);assert.equal(r.data.simulationOpportunities,1);assert.equal(r.data.callReferences.length,3);
});
test('complete modeled cost ledger and asset vector do not subtract embedded pool fees twice',()=>{
 const r=run(fixture()),d=r.data;assert.deepEqual(d.costModel.components.map((c:any)=>c.kind),[...S16_REQUIRED_COST_KINDS]);assert.equal(d.costModel.totalLamports,'10000');assert.equal(d.costModel.historicalActualNetworkFeeMeasured,false);assert.equal(d.assetCashflowVector.sol.atomic,'-10000');assert.equal(d.assetCashflowVector.target.atomic,'0');assert.equal(d.assetCashflowVector.quote.decimals,8);assert.equal(d.assetCashflowVector.quote.atomic,String(BigInt(d.exitQuote.userNetQuote)-BigInt(d.entryQuote.bookedQuote)));assert.equal(d.endQuoteFromBudgetAtomic,String(BigInt(d.unusedQuoteBudgetAtomic)+BigInt(d.exitQuote.userNetQuote)));assert.equal(d.allInValuedProfit,null);assert.equal(d.allInValuedProfitStatus,'NOT_AGGREGATED_ACROSS_ASSETS');
});
test('first unsupported direct entry is not replaced by a later favorable candidate',()=>{
 const f=fixture();f.trades[2]!.unsupportedReason='NATIVE_CASHBACK_UNSUPPORTED';f.trades.splice(3,0,{...f.trades[2]!,signature:'later-good',at:'2026-10-25T00:01:03.000Z',unsupportedReason:null});f.trades.forEach((t,i)=>{t.ordinal=i;t.slot=100+i;});const r=run(f);assert.equal(r.quality,'MISSING');assert.equal(r.reasonCode,'S16_ENTRY_ANCHOR_UNSUPPORTED');assert.equal(r.data.entryAnchor.signature,'synthetic-2');
});
test('first unsupported direct exit is retained instead of skipping to a later price',()=>{
 const f=fixture();f.trades[5]!.unsupportedReason='TRANSFER_FEE_UNRESOLVED';f.trades.push({...f.trades[5]!,ordinal:6,slot:106,signature:'later-good',at:'2026-10-25T01:01:04.000Z',unsupportedReason:null});const r=run(f);assert.equal(r.quality,'MISSING');assert.equal(r.reasonCode,'S16_EXIT_ANCHOR_UNSUPPORTED');assert.equal(r.data.exitAnchor.signature,'synthetic-5');
});
test('entry impact rejection does not submit either leg or charge network fees',()=>{
 const f=fixture();Object.assign(f.trades[2]!.state!,{quoteReserve:10000n,virtualQuoteReserve:10000n});const r=run(f);assert.equal(r.quality,'KNOWN');assert.equal(r.data.status,'ENTRY_CONSTRAINT_BLOCKED');assert.equal(r.data.entrySubmitted,false);assert.equal(r.data.exitSubmitted,false);assert.equal(r.data.costModel.totalLamports,'0');assert.equal(r.data.assetCashflowVector.quote.atomic,'0');assert.equal(r.data.assetCashflowVector.target.atomic,'0');
});
test('physical exit backing failure retains entered cashflow and unvalued target holdings',()=>{
 const f=fixture();Object.assign(f.trades[5]!.state!,{quoteReserve:100n,virtualQuoteReserve:1_000_000_000n});const r=run(f);assert.equal(r.quality,'KNOWN');assert.equal(r.data.status,'EXIT_CONSTRAINT_BLOCKED');assert.equal(r.data.kernelCode,'SELL_PHYSICAL_BACKING_INSUFFICIENT');assert.equal(r.data.costModel.totalLamports,'5000');assert.equal(r.data.assetCashflowVector.target.atomic,r.data.entryQuote.baseOut);assert.equal(r.data.assetCashflowVector.quote.atomic,String(-BigInt(r.data.entryQuote.bookedQuote)));assert.equal(r.data.quotePnlAtomic,null);
});
test('exit impact failure retains its first anchor and held position',()=>{
 const f=fixture();Object.assign(f.trades[5]!.state!,{baseReserve:1000n});const r=run(f);assert.equal(r.quality,'KNOWN');assert.equal(r.reasonCode,'S16_EXIT_IMPACT_LIMIT_PREVENTS_SUBMISSION');assert.equal(r.data.exitImpact.passes,false);assert.equal(r.data.assetCashflowVector.target.atomic,r.data.entryQuote.baseOut);
});
test('missing native horizon or anchor stays missing, never known zero',()=>{
 const f=fixture();f.range.end='2026-10-25T01:00:00.000Z';f.trades=f.trades.slice(0,3);const r=run(f);assert.equal(r.quality,'MISSING');assert.equal(r.reasonCode,'S16_EXIT_HORIZON_NOT_FULLY_COVERED');const noEntry=fixture();noEntry.trades=noEntry.trades.filter(t=>t.side==='SELL');noEntry.trades.forEach((t,i)=>{t.ordinal=i;});assert.equal(run(noEntry).reasonCode,'S16_ENTRY_ANCHOR_NOT_COVERED');const noExit=fixture();noExit.trades=noExit.trades.slice(0,3);assert.equal(run(noExit).reasonCode,'S16_EXIT_ANCHOR_NOT_COVERED');
});
test('missing batch, unavailable chronology and invalid native order fail closed',()=>{
 for(const mutate of [(f:S16StudyInput)=>{f.callRefs=[];},(f:S16StudyInput)=>{f.availableAt='2026-10-25T01:00:00.000Z';},(f:S16StudyInput)=>{f.trades[2]!.ordinal=99;},(f:S16StudyInput)=>{f.trades[2]!.at='not-a-date';},(f:S16StudyInput)=>{f.trades[2]!.slot=1;},(f:S16StudyInput)=>{f.detectedAt='2026-10-26T00:00:00.000Z';}]){const f=fixture();mutate(f);assert.equal(run(f).quality,'MISSING');}
});
test('uncalibrated virtual reserve does not receive an optimistic substitution',()=>{
 const f=fixture();Object.assign(f.trades[2]!.state!,{virtualQuoteReserve:0n});assert.equal(run(f).reasonCode,'S16_ENTRY_VIRTUAL_DOMAIN_UNCALIBRATED');
});
test('cost model never omits required kinds or allows exit submission before entry',()=>{
 for(const [entry,exit,total]of[[false,false,'0'],[true,false,'5000'],[true,true,'10000']] as const){const c=serializeS16(s16CompleteModeledCosts(entry,exit)) as any;assert.equal(c.components.length,5);assert.deepEqual(c.requiredKinds,[...S16_REQUIRED_COST_KINDS]);assert.equal(c.totalLamports,total);assert(c.components.every((x:any)=>x.lamports!==null));}assert.throws(()=>s16CompleteModeledCosts(false,true),/SUBMISSION_ORDER/);
});
test('minout parameters are integer limits, not worst-case PnL or actual fills',()=>{
 const r=run(fixture()),d=r.data;assert.equal(d.entryMinimumBaseOut,String(BigInt(d.entryQuote.baseOut)*9700n/10000n));assert.equal(d.exitMinimumQuoteOut,String(BigInt(d.exitQuote.userNetQuote)*9700n/10000n));assert(d.limitations.some((s:string)=>s.includes('no actual fill')));
});

test('native CPI-direct instructions are excluded by the fixed top-level instrument, without pretending they are multi-hop',()=>{
 const f=fixture();f.trades[1]!.nativeFamily='CPI_DIRECT';f.trades[1]!.unsupportedReason='DIRECT_INVOCATION_NOT_TOP_LEVEL';const r=run(f);assert.equal(r.quality,'KNOWN');assert.equal(r.data.entryAnchor.ordinal,2);assert.equal(r.data.entryWaitingAfterTriggerMs,1724);assert.equal(r.data.actualEntryDelayMs,61724);assert.equal(r.data.exitWaitingAfterTriggerMs,1000);
});
