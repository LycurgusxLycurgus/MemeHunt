import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {deriveA30FxDemandFromHistory,deriveA30FxDemandWindows,A30_FX_DEMAND_METHOD} from '../src/providers/advisory-demand-fx.js';
import {decodeBulkQuoteFinancialTape,deriveO29BulkReservePath} from '../src/providers/advisory-reserve-bulk.js';
import {deriveO29QuoteReservePath} from '../src/providers/advisory-reserve-path.js';
import {createO29BulkCapture} from './reserve-bulk-fixtures.js';
import {createA30SourceCapture} from './a30-fx-source-fixtures.js';
import {a30DemandHistory,a30DemandTrade,a30DemandReference,a30DemandVariableReference,A30_TEST_Q64} from './a30-fx-demand-fixtures.js';
const derive=(trades:ReturnType<typeof a30DemandTrade>[],program:string[]=[],ref=a30DemandReference())=>deriveA30FxDemandFromHistory(a30DemandHistory(trades),program,ref,['constructed']);
const data=(metric:ReturnType<typeof derive>)=>metric.data as any;
function temporary(run:(directory:string)=>void){const dir=mkdtempSync(join(tmpdir(),'a30-demand-'));try{run(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
function allNull(metric:ReturnType<typeof derive>){const d=data(metric);assert.equal(metric.quality,'MISSING');assert.equal(d.satisfiedWindows,null);assert.equal(d.share,null);assert.equal(d.baseline.meaningfulBuyers,null);for(const w of d.windows){assert.equal(w.condition,null);assert.equal(w.newMeaningfulBuyerCount,null);assert.equal(w.newMeaningfulBuyers,null);assert.equal(w.netQuoteAtomic,null);}}

test('meaningful threshold includes exact equality and rejects one atomic unit below it',()=>{
 for(const [q,expected] of [['9999999',0],['10000000',1],['10000001',1]] as const){const m=derive([a30DemandTrade('buyer',6,'BUY',q)]);assert.equal(m.quality,'KNOWN');assert.equal(data(m).windows[0].newMeaningfulBuyerCount,expected);assert.equal(data(m).windows[0].condition,expected===1);}
 const m=derive([a30DemandTrade('buyer',6,'BUY','40000000')],[],a30DemandReference(2n*A30_TEST_Q64));assert.equal(data(m).windows[0].condition,true);
});
test('baseline and first meaningful rules retain prior sell and subthreshold flags and count once',()=>{
 const m=derive([a30DemandTrade('old',1,'BUY','10000000'),a30DemandTrade('old',6,'BUY','10000000'),a30DemandTrade('new',2,'SELL','2'),a30DemandTrade('new',3,'BUY','9999999'),a30DemandTrade('new',6,'BUY','10000000'),a30DemandTrade('new',7,'BUY','10000000')]),d=data(m);
 assert.equal(d.baseline.meaningfulBuyers,1);assert.equal(d.windows[0].newMeaningfulBuyerCount,1);assert.equal(d.windows[0].newMeaningfulBuyers[0].user,'new');assert.equal(d.windows[0].newMeaningfulBuyers[0].baselineSell,true);assert.equal(d.windows[0].newMeaningfulBuyers[0].baselineSubThresholdBuy,true);assert.equal(d.windows[1].newMeaningfulBuyerCount,0);assert.equal(d.denominator,6);assert.equal(d.share,'0.16666666666666666667');
});
test('program accounts never become buyers but their complete buy and sell flow stays native',()=>{
 const m=derive([a30DemandTrade('buyer',6,'BUY','10000000'),a30DemandTrade('program',6,'SELL','10000001',161),a30DemandTrade('program',7,'BUY','50000000')],['program']),d=data(m);
 assert.equal(d.windows[0].newMeaningfulBuyerCount,1);assert.equal(d.windows[0].netQuoteAtomic,'-1');assert.equal(d.windows[0].condition,false);assert.equal(d.windows[1].buyQuoteAtomic,'50000000');assert.equal(d.windows[1].newMeaningfulBuyerCount,0);assert.equal(d.windows[1].condition,false);
});
test('variable FX cannot reverse the native WBTC net condition',()=>{
 // Reference-weighted flow would be 20m - 30m/4 > 0; native core WBTC is -10m.
 const m=derive([a30DemandTrade('buyer',6,'BUY','20000000',140),a30DemandTrade('seller',6,'SELL','30000000',160)],[],a30DemandVariableReference()),d=data(m);
 assert.equal(m.quality,'KNOWN');assert.equal(d.windows[0].newMeaningfulBuyerCount,1);assert.equal(d.windows[0].netQuoteAtomic,'-10000000');assert.equal(d.windows[0].condition,false);assert.equal(d.fx.referenceNetComputed,false);assert.equal(d.quoteDecimals,8);assert.equal(d.meaningfulThreshold.referenceDecimals,9);
});
test('all legs use the same incoming transaction state and native provenance ordering',()=>{
 const a=a30DemandTrade('buyer',6,'BUY','6000000'),b={...a,quoteAtomic:'10000000',provenance:{...a.provenance,pumpOrdinal:1}};const m=derive([b,a]),d=data(m);assert.equal(m.quality,'KNOWN');assert.equal(d.fx.requiredQueryTransactions,1);assert.equal(d.fx.identifiedQueryTransactions,1);assert.equal(d.windows[0].newMeaningfulBuyerCount,1);assert.equal(d.windows[0].buyQuoteAtomic,'16000000');
});
test('a required unanchored cell, structural failure, or missing native index nulls every result',()=>{
 const ref=a30DemandReference();ref.cells[0]!.status='UNANCHORED';ref.cells[0]!.sqrtPriceX64=null;allNull(derive([a30DemandTrade('buyer',6,'BUY','10000000')],[],ref));
 allNull(derive([a30DemandTrade('buyer',6,'BUY','10000000')],[],{...a30DemandReference(),complete:false,sourceContext:null,reasonCode:'A30_FX_STATE_OWNER_OPCODE'}));
 allNull(derive([{...a30DemandTrade('buyer',6,'BUY','10000000'),transactionIndex:null}]));
});
test('complete empty tape has zero share and no invented price even with an unanchored cell',()=>{
 const ref=a30DemandReference();ref.cells[0]!.status='UNANCHORED';ref.cells[0]!.sqrtPriceX64=null;const m=derive([],[],ref),d=data(m);assert.equal(m.quality,'KNOWN');assert.equal(d.method,A30_FX_DEMAND_METHOD);assert.equal(d.share,'0');assert.equal(d.satisfiedWindows,0);assert.equal(d.fx.requiredQueryTransactions,0);assert.ok(d.windows.every((w:any)=>w.condition===false));allNull(derive([],[],{...ref,complete:false,reasonCode:'A30_FX_STATE_OWNER_OPCODE'}));
});
test('identity bank extra mutable prices cannot affect incoming-state arithmetic',()=>{
 const ref=a30DemandReference(),before=derive([a30DemandTrade('buyer',6,'BUY','10000000')],[],ref);Object.assign(ref.sourceContext!.identity,{sqrtPriceX64:'1',price:'999999999999'});assert.deepEqual(derive([a30DemandTrade('buyer',6,'BUY','10000000')],[],ref),before);
});
test('neutral source-bound extraction preserves the exact O29 envelope and observes only bulk pages',()=>temporary(dir=>{
 const f=createO29BulkCapture(dir),calls:Array<[string,string]>=[],tape=decodeBulkQuoteFinancialTape(f.source,f.cutoff,(id,raw)=>calls.push([id,raw])),core=deriveO29QuoteReservePath(tape.history,tape.quote,['retained-source'])!;
 assert.equal(calls.length,1);assert.equal(calls[0]![0],'bulk-page-0');assert.equal(JSON.parse(calls[0]![1]).result.data.length,3);assert.deepEqual(deriveO29BulkReservePath(f.source,f.cutoff,['retained-source']),{...core,data:{...(core.data as object),sourceTrust:'RETAINED_PROVIDER_RPC_IMPORT',sourceAuthentication:'Hashes bind retained bytes, not provider authentication or independent onchain attestation.',financialPurpose:'O29_RESERVE_PATH_ONLY',sourceCoverage:tape.sourceCoverage,pairedClocks:tape.pairedClocks}});assert.ok(!Object.hasOwn(deriveO29BulkReservePath(f.source,f.cutoff,[]).data as object,'programAccounts'));
}));
test('receipt wrapper reconstructs genuine native financial and incoming FX inputs on constructed small census',()=>temporary(dir=>{
 const f=createA30SourceCapture(dir),before=JSON.stringify(f.source),m=deriveA30FxDemandWindows(f.source,f.cutoff,['constructed-native-subset']),d=data(m);assert.equal(m.quality,'KNOWN');assert.equal(d.sourceCoverage.financialTrades,3);assert.equal(d.fx.requiredQueryTransactions,3);assert.equal(d.crossSourceCoherence.complete,true);assert.equal(d.financialPurpose,'A30_DEMAND_WINDOWS_ONLY');assert.equal(JSON.stringify(f.source),before);
}));
