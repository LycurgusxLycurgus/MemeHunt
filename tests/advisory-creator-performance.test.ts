import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { advisoryMetricSchema } from '../src/domain/advisory-contracts.js';
import type { CreatorInventoryReceipts, CreatorRole, CreatorTape } from '../src/providers/advisory-creator-inventory.js';
import { deriveO25CreatorLifetime } from '../src/providers/advisory-creator-lifetime.js';
import { archiveCreatorFailedFeeReceipt, unpackCreatorFailedFeeReceipt, failedFeeRequest, failedFeeReceiptId, FAILED_FEE_ADAPTER, FAILED_FEE_RECEIPT_CAP, FAILED_FEE_SOURCE_ID, type FailedFeeReceipt, type FailedIndexRow } from '../src/providers/advisory-creator-failed-fees.js';
import { creatorPerformanceGate, creatorPositionPerformance, deriveS15CreatorPerformance } from '../src/providers/advisory-creator-performance.js';
import { collectCreatorFailedFees, failedFeeReceiptsOf, CREATOR_FAILED_FEE_STORED_BYTES, CREATOR_FAILED_FEE_REQUEST_CAP, type CreatorFailedFeeReceipts, type FailedFeePrior } from '../src/providers/advisory-creator-performance-collector.js';

const DIR='tests/fixtures/o25-creator',MINT='3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump',WALLET='8RXNzg9QEheV1SZyTLisckJRwziVoZFzGWA3tajj1yJg',OTHER='DCKEuw8Da2B4ugX9i2aiKoku1eMPMjMk99CR1tyJfddM';
const CREATION='3Hiax4YZEW8FjgRL86RTJJt5xL5aBCFH1BTw8zfjjiWd5jc8bhWkj3gDS1VALXZKKBqaAHEdjat6VQZXLQSVc1uc',SELL='2Mej3XgaGARrsAtGjzqm9FxH2mAWQSH5QL9CzpKbcTaYiymCAdydGFSkeagwscsxU1vxz8Zm81oAGiLcRqdQXeH';
const COMPUTE_BUDGET='ComputeBudget111111111111111111111111111111';
const token={chain:'solana' as const,address:MINT},role:CreatorRole={wallet:WALLET,mint:MINT,creationSignature:CREATION,creationSlot:451_486_744};
// Same accepted A30 tape projection the O25 tests use.
const tape:CreatorTape={history:{complete:true,pool:'4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E',anchorSlot:455_909_330,range:{start:'2026-10-11T16:00:00.000Z',baselineEnd:'2026-10-11T22:00:00.000Z',end:'2026-10-12T04:00:00.000Z'},trades:[]},vault:'ALnzFihp12pxn12qZDgwRqEnTF8RGzpXyWWTP6yDQHEy'};
// Root's prospective cutoff for the actual 130-receipt run; every inventory and failed-fee clock precedes it.
const CUTOFF='2026-10-12T09:34:07.755Z',CLOCK='2026-10-12T09:30:00.000Z';
const REAL_SIG='gZrtdAehgqYzcPDkPfrzAuLti9Eiu9koxpoU3o6wRVsU8nJh82BpV5AaADKo5MQqnecCCrqX1Dpi8WRcgAN3Noo',REAL_CLOCK='2026-10-12T09:20:13.817230+00:00';
const REAL_RAW=readFileSync('tests/fixtures/creator-failed-fees-gZrtdAeh.json','utf8').replace(/\n$/,'');
const named:Record<string,string>={'creator-ata-head':'creator-ata-head','creator-ata-index':'creator-ata-page-0','creator-owner-accounts':'creator-owner-accounts','creator-wallet-page-0':'creator-wallet-page-0'};
/** The existing public O25 receipts under O24's namespace ids, exactly as the O25 tests load them. */
function actual():CreatorInventoryReceipts{
 const r:CreatorInventoryReceipts={rawArtifacts:{},retrievedAt:{},requests:{}};
 for(const file of readdirSync(DIR).filter(f=>f.endsWith('-request.json'))){
  const name=file.slice(0,-'-request.json'.length),id=named[name]??(name.startsWith('wallet-tx-')?`creator-tx-${name.slice('wallet-tx-'.length)}`:null);
  if(!id)continue;
  const meta=JSON.parse(readFileSync(`${DIR}/${file}`,'utf8'));
  r.requests[id]=meta.request;r.retrievedAt[id]=meta.retrievedAt;r.rawArtifacts[id]=readFileSync(`${DIR}/${name}.json`,'utf8');
 }
 return r;
}
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encode58(bytes:Buffer):string{let n=BigInt(`0x${bytes.toString('hex')}`),s='';while(n>0n){s=B58[Number(n%58n)]+s;n/=58n;}for(const b of bytes){if(b!==0)break;s=`1${s}`;}return s;}
const EXTRA=encode58(createHash('sha512').update('s15-extra-failed-row').digest());
const data=(m:{data:unknown})=>m.data as any;
function failedRows(r=actual()):FailedIndexRow[]{const g=creatorPerformanceGate(token,role,tape,r,new Map(),CUTOFF,['ev']);if(!g.ready)throw new Error(g.code);return g.scope.failedRows;}
/** Synthetic fee-only failure bound to a real indexed row (signature, slot, blockTime, err, index); the payer signs and pays, nothing else moves. */
function failedBody(row:FailedIndexRow,o:{payer?:string;keys?:string[];fee?:number;pad?:string;mutate?:(v:any)=>void}={}):string{
 const payer=o.payer??OTHER,fee=o.fee??5000,statics=[payer,...(o.keys??[MINT]),COMPUTE_BUDGET];
 const accountKeys=statics.map((pubkey,i)=>({pubkey,signer:i===0,source:'transaction',writable:i===0}));
 const pre=accountKeys.map((_,i)=>i===0?10_000_000:2_039_280),post=pre.map((x,i)=>i===0?x-fee:x);
 const v:any={blockTime:row.blockTime,meta:{err:row.err,fee,innerInstructions:[],logMessages:o.pad?[o.pad]:[],postBalances:post,postTokenBalances:[],preBalances:pre,preTokenBalances:[],rewards:[],status:{Err:row.err}},slot:row.slot,
  transaction:{message:{accountKeys,addressTableLookups:[],instructions:[{accounts:[],data:'1',programId:COMPUTE_BUDGET,stackHeight:1}],recentBlockhash:OTHER},signatures:[row.signature]},...(row.transactionIndex===null?{}:{transactionIndex:row.transactionIndex}),version:0};
 o.mutate?.(v);
 return JSON.stringify({jsonrpc:'2.0',result:v,id:1});
}
const actualBody=(row:FailedIndexRow)=>row.signature===REAL_SIG?REAL_RAW:failedBody(row);
/** Stored S15 receipts for the given rows; the real public receipt keeps its original clock. */
function stored(rows:FailedIndexRow[],body:(row:FailedIndexRow)=>string|null):FailedFeeReceipt[]{
 const r:CreatorFailedFeeReceipts={rawArtifacts:{},retrievedAt:{},requests:{}};
 for(const row of rows){const raw=body(row);if(raw===null)continue;const id=failedFeeReceiptId(row.signature);r.requests[id]=failedFeeRequest(row.signature);r.rawArtifacts[id]=archiveCreatorFailedFeeReceipt(raw);r.retrievedAt[id]=row.signature===REAL_SIG?REAL_CLOCK:CLOCK;}
 return failedFeeReceiptsOf(r);
}
const s15=(failed:FailedFeeReceipt[]|null,r=actual(),who=role)=>deriveS15CreatorPerformance(token,who,tape,r,new Map(),failed,CUTOFF,['ev']);
const assertNoPerformance=(d:any)=>assert.deepEqual([d.position,d.unrealized,d.tradeFees,d.networkFees,d.accountFunding],[null,null,null,null,null]);
type Probe={calls:string[];inFlight:number;max:number};
const probe=():Probe=>({calls:[],inFlight:0,max:0});
function rpcFetcher(respond:(signature:string)=>Response|string,p:Probe,onCall?:(n:number)=>void):typeof fetch{
 return (async(_url:unknown,init?:RequestInit)=>{
  const request=JSON.parse(String(init?.body));p.calls.push(JSON.stringify({method:request.method,params:request.params}));onCall?.(p.calls.length);
  p.inFlight++;p.max=Math.max(p.max,p.inFlight);await new Promise(resolve=>setImmediate(resolve));p.inFlight--;
  const out=respond(request.params[0]);return typeof out==='string'?new Response(out,{status:200}):out;
 }) as typeof fetch;
}
function withoutWalletReceipt(r:CreatorInventoryReceipts){const id=Object.keys(r.requests).find(k=>k.startsWith('creator-tx-')&&!k.endsWith(CREATION)&&!k.endsWith(SELL))!;delete r.requests[id];delete r.rawArtifacts[id];delete r.retrievedAt[id];return r;}
function withExtraFailedRow(r:CreatorInventoryReceipts){const v=JSON.parse(r.rawArtifacts['creator-wallet-page-0']!),i=v.result.findIndex((x:any)=>x.err!==null&&x.slot>=role.creationSlot);v.result.splice(i+1,0,{...v.result[i],signature:EXTRA});r.rawArtifacts['creator-wallet-page-0']=JSON.stringify(v);return r;}

test('the complete failed set over the actual O25 lifetime gives the exact CREATOR_ONLY position with separate fee components', ()=>{
 const rows=failedRows();
 assert.equal(rows.length,130);assert.ok(rows.some(r=>r.signature===REAL_SIG));
 const m=s15(stored(rows,actualBody)),d=data(m);
 assert.deepEqual([m.id,m.quality,m.reasonCode],['S15','KNOWN','S15_CREATOR_POSITION_PERFORMANCE_OBSERVED']);advisoryMetricSchema.parse(m);
 assert.deepEqual([d.cohort.kind,d.cohort.wallet,d.quote.usdBasis,d.quote.trackerValuesUsed],['CREATOR_ONLY',WALLET,null,false]);
 assert.deepEqual([d.position.buys,d.position.sells,d.position.grossEntryCostLamports,d.position.allocatedGrossEntryCostLamports,d.position.realizedProceedsLamports,d.position.realizedQuoteResultLamports],[1,1,'1700000000','1700000000','3049721804','1349721804']);
 assert.deepEqual([d.tradeFees.protocolFeeLamports.total,d.tradeFees.buybackFeeLamports.total,d.tradeFees.creatorFee.ownVaultLamports,d.tradeFees.creatorFee.otherVaultLamports,d.tradeFees.includedInQuotes],['22644857','22644857','14302016','0',true]);
 assert.deepEqual([d.networkFees.successfulTradeLamports,d.networkFees.successfulTargetTransactions,d.networkFees.failedTargetAssociatedChargedTransactionOverheadLamports,d.networkFees.directTotalLamports,d.networkFees.subtractedFromPosition],['837757',2,'0','837757',false]);
 assert.deepEqual([d.accountFunding.depositsLamports,d.thirdPartyCreatorFeeIncome.status],['9062720','OUTSIDE_POSITION_SCOPE']);
 assert.deepEqual(d.unrealized,{heldAtomic:'0',unrealizedLamports:'0',mark:null,basis:'ZERO_HELD_NO_MARK_REQUIRED'});
 assert.deepEqual(d.sample.disposedLots.map((l:any)=>[l.acquiredSignature,l.disposedSignature,l.holdingSeconds]),[[CREATION,SELL,10]]);
 assert.deepEqual([d.indexCompleteness.walletIndex.rowsSinceCreation,d.indexCompleteness.walletIndex.successful,d.indexCompleteness.walletIndex.failed,d.censoring.rightCensored],[197,67,130,false]);
 const failed=d.failedTransactionsReferencingCreator;
 assert.deepEqual([failed.status,failed.counts.NOT_ACTOR_CHARGED,failed.rows.length,failed.countBasis,failed.foreignAssetCoverage,failed.overheadAllocation],['COMPLETE',130,130,'TRANSACTIONS_NOT_PARTICIPANTS','PARTIAL_OR_NOT_EVALUATED','NOT_ATTEMPTED']);
 // The actual public receipt references the creator key and the target, but another account signed and paid.
 const real=failed.rows.find((r:any)=>r.signature===REAL_SIG);
 assert.deepEqual([real.classification,real.feePayer,real.actorSigner,real.targetReference,real.metaFeeLamports,real.actorChargedLamports],['NOT_ACTOR_CHARGED',OTHER,false,true,'6000','0']);
 assert.ok(failed.rows.every((r:any)=>r.actorSigner===false&&r.actorChargedLamports==='0'));
 assert.equal(d.currentSixHourProfile.partOfPerformance,false);
 assert.ok(!Object.keys(d).some(k=>/pnl/i.test(k)));
});

test('an actor-paid target failure adds overhead beside the position without a second fee subtraction', ()=>{
 const rows=failedRows(),charged=rows.find(r=>r.signature!==REAL_SIG)!;
 const m=s15(stored(rows,row=>row===charged?failedBody(row,{payer:WALLET,keys:[MINT],fee:5000}):actualBody(row))),d=data(m);
 assert.equal(m.quality,'KNOWN');
 assert.deepEqual([d.failedTransactionsReferencingCreator.counts.TARGET_ASSOCIATED_CHARGED,d.networkFees.failedTargetAssociatedChargedTransactionOverheadLamports,d.networkFees.directTotalLamports],[1,'5000','842757']);
 const row=d.failedTransactionsReferencingCreator.rows.find((r:any)=>r.signature===charged.signature);
 assert.deepEqual([row.feePayer,row.actorSigner,row.targetReference,row.actorChargedLamports],[WALLET,true,true,'5000']);
 assert.equal(d.position.realizedQuoteResultLamports,'1349721804');
});

test('unresolved, missing or uncollected failed receipts never yield a performance or a zero', ()=>{
 const rows=failedRows(),opaque=rows.find(r=>r.signature!==REAL_SIG)!;
 const unresolved=s15(stored(rows,row=>row===opaque?failedBody(row,{payer:WALLET,keys:[]}):actualBody(row)));
 assert.deepEqual([unresolved.quality,unresolved.reasonCode,data(unresolved).failedTransactionsReferencingCreator.counts.UNRESOLVED],['TRUNCATED','S15_FAILED_FEES_INCOMPLETE',1]);assertNoPerformance(data(unresolved));
 const partial=s15(stored(rows,row=>row.signature===REAL_SIG?REAL_RAW:null));
 assert.deepEqual([partial.quality,data(partial).failedTransactionsReferencingCreator.coverage.missing,data(partial).failedTransactionsReferencingCreator.coverage.complete],['TRUNCATED',129,false]);assertNoPerformance(data(partial));
 const none=s15(null);
 assert.deepEqual([none.quality,none.reasonCode,data(none).failedIndexedRows],['MISSING','S15_FAILED_FEES_NOT_COLLECTED',130]);assertNoPerformance(data(none));
});

test('orphan, rebound, re-clocked or misfiled failed receipts invalidate the proof', ()=>{
 const rows=failedRows(),good=stored(rows,actualBody),one=rows.find(r=>r.signature!==REAL_SIG)!,oneId=failedFeeReceiptId(one.signature);
 const orphan=stored([{...one,signature:CREATION}],row=>failedBody({...one,signature:row.signature}));
 assert.throws(()=>s15([...good,...orphan]),/^Error: S15_FAILED_RECEIPT_ORPHAN$/);
 const rebound=stored(rows,row=>row===one?failedBody(row,{mutate:v=>{v.slot+=1;}}):actualBody(row));
 assert.throws(()=>s15(rebound),/^Error: S15_FAILED_RECEIPT_BINDING$/);
 assert.throws(()=>s15(good.map(r=>r.id===oneId?{...r,retrievedAt:'2026-10-12T09:34:07.756Z'}:r)),/^Error: S15_FAILED_RECEIPT_CLOCK$/);
 assert.throws(()=>s15(good.map(r=>r.id===oneId?{...r,sourceId:'advisory-creator-inventory'}:r)),/^Error: S15_FAILED_RECEIPT_SOURCE$/);
});

test('held units, transfers, missing fees and broken quote identities never produce a profit', ()=>{
 const base=data(deriveO25CreatorLifetime(token,role,tape,actual(),new Map(),CUTOFF,['ev']));
 assert.equal(creatorPositionPerformance(base).ok,true);
 const cases:Array<[string,(d:any)=>void]>=[
  ['S15_HELD_VALUATION_UNSUPPORTED',d=>{d.holdings.heldAtomic='1';}],
  ['S15_TARGET_TRANSFER_UNSUPPORTED',d=>{d.flows.transferInAtomic='5';}],
  ['S15_LEDGER_ARITHMETIC',d=>{delete d.ledger[0].networkFeeLamports;}],
  ['S15_LEDGER_ARITHMETIC',d=>{d.ledger[1].userQuoteLamports=String(BigInt(d.ledger[1].userQuoteLamports)+1n);}],
  ['S15_LEDGER_ARITHMETIC',d=>{d.realized.disposedLots=[];}],
  ['S15_NO_TARGET_POSITION',d=>{d.ledger=[];d.realized.disposedLots=[];}],
 ];
 for(const [code,mutate] of cases){const d=structuredClone(base);mutate(d);const out=creatorPositionPerformance(d);assert.deepEqual(out,{ok:false,quality:'MISSING',code},code);}
});

test('an unresolved O25 or mismatched cohort stops S15 before the failed set and the collector before any read', async ()=>{
 const failed=stored(failedRows(),actualBody);
 const truncated=s15(failed,withoutWalletReceipt(actual()));
 assert.deepEqual([truncated.quality,truncated.reasonCode,data(truncated).status],['TRUNCATED','S15_O25_PREREQUISITE_UNRESOLVED','PREREQUISITE_UNRESOLVED']);assertNoPerformance(data(truncated));
 const other=s15(failed,actual(),{...role,creationSlot:role.creationSlot+1});
 assert.notEqual(other.quality,'KNOWN');assert.equal(other.reasonCode,'S15_O25_PREREQUISITE_UNRESOLVED');
 const p=probe();
 assert.equal(await collectCreatorFailedFees(token,role,tape,withoutWalletReceipt(actual()),new Map(),new Map(),'http://rpc.test',rpcFetcher(()=>'{}',p),()=>CLOCK),null);
 assert.equal(p.calls.length,0);
});

test('a failed index above the dedicated cap fails closed without reads', async ()=>{
 const r=withExtraFailedRow(actual()),gate=creatorPerformanceGate(token,role,tape,r,new Map(),CUTOFF,['ev']);
 assert.deepEqual(gate.ready?null:[gate.quality,gate.code],['TRUNCATED','S15_FAILED_INDEX_CAP']);
 assert.equal(FAILED_FEE_RECEIPT_CAP,130);assert.equal(CREATOR_FAILED_FEE_REQUEST_CAP,130);
 const p=probe();
 assert.equal(await collectCreatorFailedFees(token,role,tape,withExtraFailedRow(actual()),new Map(),new Map(),'http://rpc.test',rpcFetcher(()=>'{}',p),()=>CLOCK),null);
 assert.equal(p.calls.length,0);
 const m=s15([],withExtraFailedRow(actual()));
 assert.deepEqual([m.quality,m.reasonCode],['TRUNCATED','S15_FAILED_INDEX_CAP']);
});

test('the collector reads only missing failed receipts at most two at a time, reuses the exact prior body and clock, and replays to the same KNOWN S15', async ()=>{
 const rows=failedRows(),byRow=new Map(rows.map(r=>[r.signature,r])),p=probe();
 const prior:FailedFeePrior=new Map([[REAL_SIG,{request:failedFeeRequest(REAL_SIG),raw:REAL_RAW,retrievedAt:REAL_CLOCK}],[EXTRA,{request:failedFeeRequest(EXTRA),raw:'{}',retrievedAt:CLOCK}]]);
 const got=await collectCreatorFailedFees(token,role,tape,actual(),new Map(),prior,'http://rpc.test',rpcFetcher(sig=>failedBody(byRow.get(sig)!),p),()=>CLOCK);
 assert.ok(got);
 assert.equal(p.calls.length,129);assert.ok(p.max<=2);
 assert.ok(p.calls.every(c=>{const q=JSON.parse(c);return c===JSON.stringify(failedFeeRequest(q.params[0]))&&byRow.has(q.params[0])&&q.params[0]!==REAL_SIG;}));
 assert.deepEqual(Object.keys(got.rawArtifacts).sort(),rows.map(r=>failedFeeReceiptId(r.signature)).sort());
 assert.equal(got.retrievedAt[failedFeeReceiptId(REAL_SIG)],REAL_CLOCK);
 assert.equal(unpackCreatorFailedFeeReceipt(got.rawArtifacts[failedFeeReceiptId(REAL_SIG)]!),REAL_RAW);
 assert.ok(Object.values(got.rawArtifacts).reduce((n,s)=>n+Buffer.byteLength(s),0)<=CREATOR_FAILED_FEE_STORED_BYTES);
 const m=s15(failedFeeReceiptsOf(got));
 assert.deepEqual([m.quality,data(m).position.realizedQuoteResultLamports,data(m).failedTransactionsReferencingCreator.storage.receipts],['KNOWN','1349721804',130]);
 const mismatched=probe();
 await collectCreatorFailedFees(token,role,tape,actual(),new Map(),new Map([[REAL_SIG,{request:{...failedFeeRequest(REAL_SIG),method:'getParsedTransaction'},raw:REAL_RAW,retrievedAt:REAL_CLOCK}]]),'http://rpc.test',rpcFetcher(sig=>failedBody(byRow.get(sig)!),mismatched),()=>CLOCK);
 assert.equal(mismatched.calls.length,130);
});

test('collector errors, deadline and the storage ceiling stay sanitized and leave S15 incomplete', async ()=>{
 const rows=failedRows(),byRow=new Map(rows.map(r=>[r.signature,r])),broken=rows[0]!.signature;
 const errored=await collectCreatorFailedFees(token,role,tape,actual(),new Map(),new Map(),'http://rpc.test',rpcFetcher(sig=>sig===broken?new Response('upstream detail',{status:500}):failedBody(byRow.get(sig)!),probe()),()=>CLOCK);
 assert.equal(unpackCreatorFailedFeeReceipt(errored!.rawArtifacts[failedFeeReceiptId(broken)]!),'{"jsonrpc":"2.0","id":1,"error":{"code":"RPC_HTTP_500"}}');
 const e=data(s15(failedFeeReceiptsOf(errored!)));
 assert.deepEqual([e.status,e.failedTransactionsReferencingCreator.rows.find((r:any)=>r.signature===broken).code],['FAILED_FEES_INCOMPLETE','RPC_HTTP_500']);assertNoPerformance(e);
 const control=new AbortController(),aborted=probe();
 const stopped=await collectCreatorFailedFees(token,role,tape,actual(),new Map(),new Map(),'http://rpc.test',rpcFetcher(sig=>failedBody(byRow.get(sig)!),aborted,n=>{if(n===3)control.abort();}),()=>CLOCK,control.signal);
 assert.equal(aborted.calls.length,3);assert.equal(Object.keys(stopped!.rawArtifacts).length,3);
 assert.equal(s15(failedFeeReceiptsOf(stopped!)).quality,'TRUNCATED');
 const pad=randomBytes(337_500).toString('base64'),large=probe();
 const capped=await collectCreatorFailedFees(token,role,tape,actual(),new Map(),new Map(),'http://rpc.test',rpcFetcher(sig=>failedBody(byRow.get(sig)!,{pad}),large),()=>CLOCK);
 const bodies=Object.values(capped!.rawArtifacts);
 assert.ok(bodies.reduce((n,s)=>n+Buffer.byteLength(s),0)<=CREATOR_FAILED_FEE_STORED_BYTES);
 assert.ok(large.calls.length<CREATOR_FAILED_FEE_REQUEST_CAP);
 assert.ok(bodies.some(s=>unpackCreatorFailedFeeReceipt(s).includes('RPC_STORAGE_CAP')));
 assert.equal(s15(failedFeeReceiptsOf(capped!)).quality,'TRUNCATED');
});

// The portable corpus of the actual 130 public failed receipts: original requests, clocks, hashes and strict archive containers.
const CORPUS_PREFIX='s15-failed-tx-',EVIDENCE_PREFIX='advisory-creatorFailedFees-';
type CorpusRecord={id:string;request:unknown;retrievedAt:string;contentHash:string;stored:string};
const CORPUS=JSON.parse(readFileSync('tests/fixtures/s15-failed-fees-corpus.json','utf8')) as {sourceSnapshot:string;indexBodySha256:string;classification:string;recordCount:number;records:CorpusRecord[]};
type CorpusEvidence={id:string;sourceId:string;adapterVersion:string;scope:{request:unknown};retrievedAt:string;contentHash:string};
type CorpusBundle={evidence:CorpusEvidence[];raw:Record<string,string>};
const sha=(s:string)=>createHash('sha256').update(s,'utf8').digest('hex');
const signatureOf=(id:string)=>id.slice(CORPUS_PREFIX.length);
/** Each corpus record in the live ingest shape: one S15 evidence entry and its stored archive. */
function corpusBundle():CorpusBundle{
 const evidence:CorpusEvidence[]=[],raw:Record<string,string>={};
 for(const r of CORPUS.records){const id=`${EVIDENCE_PREFIX}${r.id}`;evidence.push({id,sourceId:FAILED_FEE_SOURCE_ID,adapterVersion:FAILED_FEE_ADAPTER,scope:{request:structuredClone(r.request)},retrievedAt:r.retrievedAt,contentHash:r.contentHash});raw[id]=r.stored;}
 return {evidence,raw};
}
/** The unfiltered translation of src/app/advisory.ts: every source-, prefix- or adapter-owned entry with the evidence prefix stripped. */
const translate=(b:CorpusBundle):FailedFeeReceipt[]=>b.evidence.filter(e=>e.sourceId===FAILED_FEE_SOURCE_ID||e.id.startsWith(EVIDENCE_PREFIX)||e.adapterVersion===FAILED_FEE_ADAPTER)
 .map(e=>({id:e.id.startsWith(EVIDENCE_PREFIX)?e.id.slice(EVIDENCE_PREFIX.length):e.id,sourceId:e.sourceId,adapterVersion:e.adapterVersion,request:e.scope.request,retrievedAt:e.retrievedAt,contentHash:e.contentHash,stored:b.raw[e.id]??''}));
const corpusS15=(change:(b:CorpusBundle)=>void=()=>{})=>{const b=corpusBundle();change(b);return s15(translate(b));};

test('the portable corpus is exactly the 130 recomputed failed rows with original requests, clocks, hashes and strict archives', ()=>{
 assert.deepEqual([CORPUS.recordCount,CORPUS.records.length,CORPUS.classification],[130,130,'PUBLIC_FINALIZED_RPC']);
 assert.match(CORPUS.indexBodySha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(CORPUS.records.map(r=>r.id).sort(),failedRows().map(r=>failedFeeReceiptId(r.signature)).sort());
 for(const r of CORPUS.records){
  const signature=signatureOf(r.id),body=JSON.parse(unpackCreatorFailedFeeReceipt(r.stored));
  assert.equal(r.id,failedFeeReceiptId(signature));
  assert.equal(JSON.stringify(r.request),JSON.stringify(failedFeeRequest(signature)),r.id);
  assert.equal(sha(r.stored),r.contentHash,r.id);
  assert.match(r.retrievedAt,/^2026-10-12T\d{2}:\d{2}:\d{2}\.\d{3,9}(?:Z|\+00:00)$/);
  assert.ok(r.retrievedAt.slice(0,23)<=CUTOFF.slice(0,23),r.id);
  assert.equal(body.result.transaction.signatures[0],signature);
 }
 assert.equal(CORPUS.records.find(r=>r.id===failedFeeReceiptId(REAL_SIG))!.retrievedAt,REAL_CLOCK);
});

test('the real 130-receipt corpus through the live evidence translation gives the exact KNOWN S15 with every row derived from its own receipt', ()=>{
 const m=corpusS15(),d=data(m);
 assert.deepEqual([m.id,m.quality,m.reasonCode],['S15','KNOWN','S15_CREATOR_POSITION_PERFORMANCE_OBSERVED']);advisoryMetricSchema.parse(m);
 assert.deepEqual([d.position.buys,d.position.sells,d.position.grossEntryCostLamports,d.position.realizedProceedsLamports,d.position.realizedQuoteResultLamports],[1,1,'1700000000','3049721804','1349721804']);
 assert.deepEqual([d.tradeFees.protocolFeeLamports.total,d.tradeFees.buybackFeeLamports.total,d.tradeFees.creatorFee.ownVaultLamports],['22644857','22644857','14302016']);
 assert.deepEqual([d.networkFees.successfulTradeLamports,d.networkFees.failedTargetAssociatedChargedTransactionOverheadLamports,d.networkFees.directTotalLamports,d.accountFunding.depositsLamports],['837757','0','837757','9062720']);
 assert.deepEqual(d.sample.disposedLots.map((l:any)=>l.holdingSeconds),[10]);
 assert.deepEqual([d.indexCompleteness.walletIndex.rowsSinceCreation,d.indexCompleteness.walletIndex.successful,d.indexCompleteness.walletIndex.failed],[197,67,130]);
 // External target deposits and withdrawals are zero only under O25's complete transfer, mint and burn proof; whole-wallet flows stay out of scope.
 assert.deepEqual(d.targetTransfers,{transferInAtomic:'0',transferOutAtomic:'0',mintAtomic:'0',burnAtomic:'0',basis:'O25_COMPLETE_TRANSFER_MINT_BURN_PROOF',wholeWalletSolFlows:'OUTSIDE_POSITION_SCOPE',accountRentRefunds:'OUTSIDE_POSITION_SCOPE'});
 const failed=d.failedTransactionsReferencingCreator;
 assert.deepEqual([failed.status,failed.counts.NOT_ACTOR_CHARGED,failed.counts.TARGET_ASSOCIATED_CHARGED,failed.rows.length,failed.storage.receipts,failed.coverage.complete],['COMPLETE',130,0,130,130,true]);
 const storedBytes=CORPUS.records.reduce((n,r)=>n+Buffer.byteLength(r.stored),0),sourceBytes=CORPUS.records.reduce((n,r)=>n+Buffer.byteLength(unpackCreatorFailedFeeReceipt(r.stored)),0);
 assert.deepEqual([failed.storage.storedBytes,failed.storage.sourceBytes],[storedBytes,sourceBytes]);
 const g=creatorPerformanceGate(token,role,tape,actual(),new Map(),CUTOFF,['ev']);if(!g.ready)throw new Error(g.code);
 const targets=new Set([MINT,...g.scope.targets]);
 for(const r of CORPUS.records){
  const v=JSON.parse(unpackCreatorFailedFeeReceipt(r.stored)).result,keys=v.transaction.message.accountKeys as Array<{pubkey:string;signer:boolean}>,row=failed.rows.find((x:any)=>x.signature===signatureOf(r.id));
  assert.deepEqual([row.classification,row.feePayer,row.actorSigner,row.targetReference,row.metaFeeLamports,row.actorChargedLamports],['NOT_ACTOR_CHARGED',keys[0]!.pubkey,keys.some(k=>k.pubkey===WALLET&&k.signer),keys.some(k=>targets.has(k.pubkey)),String(v.meta.fee),'0'],r.id);
  assert.notEqual(row.feePayer,WALLET,r.id);
 }
 // The real failed set leaves the position exactly as the synthetic fee-only set does.
 const synthetic=data(s15(stored(failedRows(),actualBody)));
 assert.deepEqual([d.position,d.tradeFees,d.networkFees,d.accountFunding],[synthetic.position,synthetic.tradeFees,synthetic.networkFees,synthetic.accountFunding]);
});

test('forged corpus entries fail at their exact S15 boundary; a dropped receipt is incomplete and an uncollected set is never zero', ()=>{
 const index=CORPUS.records.findIndex(r=>r.id!==failedFeeReceiptId(REAL_SIG)),record=CORPUS.records[index]!,target=`${EVIDENCE_PREFIX}${record.id}`;
 const blockTime=JSON.parse(unpackCreatorFailedFeeReceipt(record.stored)).result.blockTime as number;
 const at=(b:CorpusBundle)=>b.evidence.find(e=>e.id===target)!;
 const extra=(b:CorpusBundle,id:string,patch:Partial<CorpusEvidence>={})=>{b.evidence.push({...structuredClone(at(b)),id,...patch});b.raw[id]=b.raw[target]!;};
 const rearchive=(b:CorpusBundle,mutate:(v:any)=>void)=>{const v=JSON.parse(unpackCreatorFailedFeeReceipt(b.raw[target]!));mutate(v);b.raw[target]=archiveCreatorFailedFeeReceipt(JSON.stringify(v));at(b).contentHash=sha(b.raw[target]!);};
 assert.equal(corpusS15().quality,'KNOWN','the unmodified corpus is the positive control');
 const cases:Array<[string,string,(b:CorpusBundle)=>void]>=[
  ['orphan-by-prefix','S15_FAILED_RECEIPT_ORPHAN',b=>extra(b,`${EVIDENCE_PREFIX}${failedFeeReceiptId(CREATION)}`)],
  ['orphan-by-source','S15_FAILED_RECEIPT_ORPHAN',b=>extra(b,'advisory-window-misfiled-failed-fee')],
  ['orphan-by-adapter','S15_FAILED_RECEIPT_ORPHAN',b=>extra(b,'loose-failed-fee',{sourceId:'advisory-window'})],
  ['duplicate','S15_FAILED_RECEIPT_DUPLICATE',b=>{b.evidence.push(structuredClone(at(b)));}],
  ['foreign-source','S15_FAILED_RECEIPT_SOURCE',b=>{at(b).sourceId='advisory-creator-inventory';}],
  ['plain-adapter','S15_FAILED_RECEIPT_ADAPTER',b=>{at(b).adapterVersion='live-v1';}],
  ['changed-commitment','S15_FAILED_RECEIPT_REQUEST',b=>{const q=structuredClone(at(b).scope.request) as any;q.params[1].commitment='confirmed';at(b).scope.request=q;}],
  ['edited-without-rehash','S15_FAILED_RECEIPT_HASH',b=>{b.raw[target]=`${b.raw[target]} `;}],
  ['clock-after-cutoff','S15_FAILED_RECEIPT_CLOCK',b=>{at(b).retrievedAt='2026-10-12T09:34:07.755001+00:00';}],
  ['clock-before-block','S15_FAILED_RECEIPT_CLOCK',b=>{at(b).retrievedAt=new Date(blockTime*1000-1000).toISOString();}],
  ['plain-body-rehashed','S15_FAILED_ARCHIVE_INVALID',b=>{b.raw[target]=unpackCreatorFailedFeeReceipt(b.raw[target]!);at(b).contentHash=sha(b.raw[target]!);}],
  ['rebound-slot','S15_FAILED_RECEIPT_BINDING',b=>rearchive(b,v=>{v.result.slot+=1;})],
 ];
 for(const [name,code,change] of cases)assert.throws(()=>corpusS15(change),new RegExp(`^Error: ${code}$`),name);
 const dropped=corpusS15(b=>{b.evidence=b.evidence.filter(e=>e.id!==target);delete b.raw[target];}),dd=data(dropped);
 assert.deepEqual([dropped.quality,dropped.reasonCode,dd.status,dd.failedTransactionsReferencingCreator.coverage.missing,dd.failedTransactionsReferencingCreator.counts.MISSING],['TRUNCATED','S15_FAILED_FEES_INCOMPLETE','FAILED_FEES_INCOMPLETE',1,1]);assertNoPerformance(dd);
 const none=s15(null);
 assert.deepEqual([none.quality,none.reasonCode,data(none).status,data(none).failedIndexedRows],['MISSING','S15_FAILED_FEES_NOT_COLLECTED','FAILED_FEES_NOT_COLLECTED',130]);assertNoPerformance(data(none));
});

test('the collector rebuilds all 130 corpus receipts from prior bodies with zero reads, keeping each request, body and clock', async ()=>{
 const prior:FailedFeePrior=new Map(CORPUS.records.map(r=>[signatureOf(r.id),{request:r.request,raw:unpackCreatorFailedFeeReceipt(r.stored),retrievedAt:r.retrievedAt}]));
 const p=probe(),got=await collectCreatorFailedFees(token,role,tape,actual(),new Map(),prior,'http://rpc.test',rpcFetcher(()=>'{}',p),()=>CUTOFF);
 assert.ok(got);assert.equal(p.calls.length,0);
 assert.deepEqual(Object.keys(got.rawArtifacts).sort(),CORPUS.records.map(r=>r.id).sort());
 // Bodies, requests and clocks are compared exactly; re-deflated container bytes may differ across zlib builds and are not asserted.
 for(const r of CORPUS.records){
  assert.equal(unpackCreatorFailedFeeReceipt(got.rawArtifacts[r.id]!),unpackCreatorFailedFeeReceipt(r.stored),r.id);
  assert.equal(got.retrievedAt[r.id],r.retrievedAt,r.id);
  assert.equal(JSON.stringify(got.requests[r.id]),JSON.stringify(r.request),r.id);
 }
 assert.ok(Object.values(got.rawArtifacts).reduce((n,s)=>n+Buffer.byteLength(s),0)<=CREATOR_FAILED_FEE_STORED_BYTES);
 const m=s15(failedFeeReceiptsOf(got));
 assert.equal(m.quality,'KNOWN');
 assert.deepEqual(data(m).failedTransactionsReferencingCreator.rows,data(corpusS15()).failedTransactionsReferencingCreator.rows);
});
