import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { admittedFetchers,collectLiveToken } from '../src/app/live.js';
import { Service,decisionHash } from '../src/app/service.js';
import { starterProfile } from '../src/app/config.js';
import { SOLANA_MAINNET_GENESIS,TOKEN_2022_PROGRAM,decodeSolanaAddress,encodeSolanaAddress } from '../src/providers/solana.js';
import { advisoryFactsSchema } from '../src/domain/advisory-contracts.js';
import { reconstructAdvisory } from '../src/app/advisory.js';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { OFFLINE_PUMP_AMM_PROGRAM as sdk,PUMP_AMM_PROGRAM_ID,poolPda } from '@pump-fun/pump-swap-sdk';
import { DEMAND_REQUEST_CAP,DEMAND_ARCHIVE_ADAPTER,archiveDemandReceipt,unpackDemandReceipt,demandArchiveSourceLimit } from '../src/providers/advisory-demand-windows.js';
import { CALLER_REQUEST_CAP } from '../src/providers/advisory-caller-history.js';
import { CREATOR_INVENTORY_REQUEST_CAP } from '../src/providers/advisory-creator-inventory-collector.js';
import { CREATOR_FAILED_FEE_REQUEST_CAP } from '../src/providers/advisory-creator-performance-collector.js';
import { archiveCreatorFailedFeeReceipt,failedFeeReceiptId,failedFeeRequest,FAILED_FEE_ADAPTER,FAILED_FEE_SOURCE_ID } from '../src/providers/advisory-creator-failed-fees.js';
import { WINDOW_ARCHIVE_ADAPTER,WINDOW_ARCHIVE_SOURCE_BYTES,WINDOW_DENSE_PAGE_LIMIT,WINDOW_EXPANDED_PAGE_LIMIT,WINDOW_DENSE_REQUEST_CAP } from '../src/providers/advisory-window.js';
import { legacyWindowBundle,legacyDenseWindowBundle } from './window-legacy-fixtures.js';
import { HOLDER_ARCHIVE_ADAPTER,unpackHolderPopulation } from '../src/providers/advisory-topology.js';
import { deriveSocial } from '../src/domain/social.js';
import { makeSocialFixture,SOCIAL_TOKEN,SOCIAL_CUTOFF } from './social-fixtures.js';
import { evaluateEntry } from '../src/domain/policy.js';
import { renderSnapshot } from '../src/app/report.js';

const token={chain:'solana' as const,address:'3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'};
const pool='4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E',quote='So11111111111111111111111111111111111111112';
const at='2026-10-10T12:30:00.000Z',hour=Date.parse('2026-10-10T12:00:00.000Z')/1000,day=Date.parse('2026-10-10T00:00:00.000Z')/1000;
const fetcher:typeof fetch=async(input,init)=>{
  const url=String(input);let value:unknown;
  if(init?.method==='POST'){
    const request=JSON.parse(String(init.body));
    value={jsonrpc:'2.0',id:1,result:request.method==='getGenesisHash'?SOLANA_MAINNET_GENESIS:request.method==='getSignaturesForAddress'?[]:{context:{slot:1},value:null}};
  }else if(url.includes('/token-pairs/'))value=[{chainId:'solana',dexId:'pumpswap',pairAddress:pool,baseToken:{address:token.address},quoteToken:{address:quote},priceUsd:'1',liquidity:{usd:10000},volume:{h24:100},txns:{h24:{buys:4,sells:3}}}];
  else if(url.includes('include=base_token'))value={data:{id:`solana_${pool}`,type:'pool',attributes:{address:pool},relationships:{base_token:{data:{id:`solana_${token.address}`,type:'token'}},quote_token:{data:{id:`solana_${quote}`,type:'token'}}}},included:[token.address,quote].map(address=>({id:`solana_${address}`,type:'token',attributes:{address}}))};
  else if(url.includes('ohlcv'))value={data:{attributes:{ohlcv_list:Array.from({length:75},(_,i)=>[hour-i*3600,10+i%6,11+i%6,9+i%6,10+i%6,20])}}};
  else if(url.includes('coinbase'))value=Array.from({length:75},(_,i)=>[hour-i*3600,9+i%6,11+i%6,10+i%6,10+i%6,2]);
  else if(url.includes('llama'))value={chain:new URL(url).pathname.split('/').at(-1),totalDataChart:[[day-172800,10],[day-86400,20],[day,999]]};
  else if(url.includes('/orders/'))value={orders:[{chainId:'solana',tokenAddress:token.address,type:'tokenProfile',status:'approved',paymentTimestamp:Date.parse(at)-1000}],boosts:[]};
  else throw new Error('Unexpected fixture request');
  return new Response(JSON.stringify(value));
};
const collect=(semanticEnabled=false)=>collectLiveToken(token,{profile:starterProfile(),semanticEnabled,advisoryEnabled:true,fetcher,now:()=>at});
const rehash=(bundle:Awaited<ReturnType<typeof collect>>,id:string)=>{bundle.evidence.find(e=>e.id===id)!.contentHash=createHash('sha256').update(bundle.rawArtifacts[id]!).digest('hex');};

test('opt-in advisory history persists 50 truthful metric states and freezes distinct policy/reopen replay',async()=>{
  const bundle=await collect();assert.ok(bundle.details?.advisory);
  const proof=JSON.parse(bundle.rawArtifacts['advisory-derivation']!);
  assert.equal(proof.method,'advisory-provenance-v33');assert.equal(proof.creatorFailedFees,null);assert.equal(proof.creatorInventory,null);assert.equal(proof.launchpad,null);assert.equal(proof.creatorRole,null);assert.deepEqual(proof.demand,{requests:{},artifactIds:{}});assert.equal(proof.callers,null);assert.equal(proof.callerSemantic,null);assert.ok(proof.wallets);assert.ok(proof.window);assert.deepEqual(proof.accounts,{requests:{},artifactIds:{}});assert.deepEqual(proof.automation,{requests:{},artifactIds:{}});assert.deepEqual(proof.topology,{requests:{},artifactIds:{}});assert.equal(proof.window.end,'2026-10-10T12:00:00.000Z');
  assert.ok(bundle.evidence.some(e=>e.sourceId==='advisory-wallets'&&e.id==='advisory-wallets-wallet-genesis'));
  const facts=bundle.details.advisory;
  assert.equal(facts.method,'advisory-measurements-v32');
  // An ineligible selected hour still yields an explicit supplementary report; it never enters the 50 metrics or the group counts.
  const short=facts.supplements!.shortDemand;
  assert.deepEqual([short.status,short.reasonCode,short.complete,short.satisfiedWindows,short.share,short.denominator,short.windows.length,short.coverage.transactionsCollected],['NOT_ELIGIBLE','SELECTED_POOL_WINDOW_INCOMPLETE',false,null,null,6,6,false]);
  assert.ok(short.windows.every(w=>w.condition===null&&w.flow===null&&w.firstObservedBuyers===null));
  // Older proofs replay only plain legacy windows: the same fixture's exact proof-v20 form rebuilds facts v21, and every older relabel is compared with that frozen result.
  const {bundle:v20Bundle,proof:v20}=legacyWindowBundle(bundle),rebuild=(p:unknown)=>reconstructAdvisory(token,at,v20Bundle.details!.baseline,v20Bundle.evidence,v20Bundle.rawArtifacts,p,v20Bundle.thesis??null,v20Bundle.features),facts20=rebuild(v20);
  assert.equal(facts20.method,'advisory-measurements-v21');
  assert.equal((facts.metrics.find(m=>m.id==='O28')!.data as {acquisition?:{version:string}}).acquisition?.version,'window-dense-v2');assert.equal(Object.hasOwn(facts20.metrics.find(m=>m.id==='O28')!.data as object,'acquisition'),false);
  // Archived window receipts never replay under an older proof, and plain legacy receipts never satisfy proof v21.
  assert.throws(()=>reconstructAdvisory(token,at,bundle.details!.baseline,bundle.evidence,bundle.rawArtifacts,{...proof,method:'advisory-provenance-v20'},bundle.thesis??null,bundle.features),/ADVISORY_PROOF_INVALID/);
  assert.throws(()=>rebuild({...v20,method:'advisory-provenance-v21'}),/ADVISORY_PROOF_INVALID/);
  const prior=rebuild({...v20,method:'advisory-provenance-v15'});
  // C16 is the only metric proof v17 adds; proof v15 and the short-only proof v16 keep the registry C16 default and every other metric and group count.
  const withoutC16=(metrics:typeof facts.metrics)=>metrics.filter(m=>m.id!=='C16');
  assert.deepEqual([prior.method,prior.supplements,withoutC16(prior.metrics),prior.groups],['advisory-measurements-v16',undefined,withoutC16(facts20.metrics),facts20.groups]);
  const shortOnly=rebuild({...v20,method:'advisory-provenance-v16',launchpad:undefined});
  assert.deepEqual([shortOnly.method,shortOnly.supplements,withoutC16(shortOnly.metrics),shortOnly.groups,shortOnly.metrics.find(m=>m.id==='C16')?.reasonCode],['advisory-measurements-v17',facts20.supplements,withoutC16(facts20.metrics),facts20.groups,'LAUNCH_MIGRATION_AND_COHORT_HISTORY_REQUIRED']);
  // Proof v17 (C16 and the supplement, no inventory key) still rebuilds facts v18 identically; a fresh v18 proof must carry the key, null here without a creator role.
  const c16Only=rebuild({...v20,method:'advisory-provenance-v17',creatorInventory:undefined});
  assert.deepEqual([c16Only.method,c16Only.supplements,c16Only.metrics,c16Only.groups],['advisory-measurements-v18',facts20.supplements,facts20.metrics,facts20.groups]);
  assert.throws(()=>reconstructAdvisory(token,at,bundle.details!.baseline,bundle.evidence,bundle.rawArtifacts,{...proof,creatorInventory:undefined},bundle.thesis??null,bundle.features),/ADVISORY_PROOF_INVALID/);
  // Proof v18 (inventory key, no O25) rebuilds facts v19 identically here: without a creator role there is no inventory, so O25 keeps its registry default in both.
  const inventoryOnly=rebuild({...v20,method:'advisory-provenance-v18'});
  assert.deepEqual([inventoryOnly.method,inventoryOnly.supplements,inventoryOnly.metrics,inventoryOnly.groups],['advisory-measurements-v19',facts20.supplements,facts20.metrics,facts20.groups]);
  // Proof v19 (no failed-fee key) rebuilds facts v20 identically here: without inventory S15 keeps its registry default in both; a fresh v20 proof must carry the key.
  const lifetimeOnly=rebuild({...v20,method:'advisory-provenance-v19',creatorFailedFees:undefined});
  assert.deepEqual([lifetimeOnly.method,lifetimeOnly.supplements,lifetimeOnly.metrics,lifetimeOnly.groups],['advisory-measurements-v20',facts20.supplements,facts20.metrics,facts20.groups]);
  assert.throws(()=>reconstructAdvisory(token,at,bundle.details!.baseline,bundle.evidence,bundle.rawArtifacts,{...proof,creatorFailedFees:undefined},bundle.thesis??null,bundle.features),/ADVISORY_PROOF_INVALID/);
  // Without a complete selected hour O23 keeps its registry row; nothing is inferred from absent receipts.
  assert.deepEqual([facts.metrics.find(m=>m.id==='O23')?.quality,facts.metrics.find(m=>m.id==='O23')?.reasonCode],['MISSING','INDEPENDENT_INDICATORS_AND_NULL_BASELINE_REQUIRED']);
  // An incomplete selected hour collects no demand receipts and keeps the sampled A30 unresolved.
  assert.equal((facts.metrics.find(m=>m.id==='A30')?.data as {method?:string}|null)?.method,'sample-demand-windows-v1');assert.equal(facts.metrics.find(m=>m.id==='A30')?.quality,'MISSING');
  assert.equal(facts.metrics.length,50);assert.equal(facts.metrics.find(m=>m.id==='C08')?.quality,'KNOWN');
  assert.equal(facts.metrics.find(m=>m.id==='C11')?.quality,'KNOWN');assert.equal(facts.metrics.find(m=>m.id==='C15')?.quality,'KNOWN');
  assert.equal(facts.metrics.find(m=>m.id==='A22')?.quality,'MISSING');assert.equal(facts.metrics.find(m=>m.id==='O26')?.quality,'MISSING');
  const directory=mkdtempSync(join(tmpdir(),'advisory-integration-')),file=join(directory,'live.sqlite');
  try{
    const writer=new Service(file);let id='';
    try{const saved=writer.analyzeLive(bundle);id=saved.id;assert.ok(saved.result.checks.filter(c=>c.checkId.startsWith('ADV-')).every(c=>c.status==='UNKNOWN'&&c.reasonCode==='ADVISORY_METRICS_INCOMPLETE'));
      const text=renderSnapshot(saved);
      for(const expected of ['Supplementary one-hour demand (not A30; not counted): NOT_ELIGIBLE / SELECTED_POOL_WINDOW_INCOMPLETE.','baseline 2026-10-10T10:00:00.000Z to 2026-10-10T11:00:00.000Z; measured 2026-10-10T11:00:00.000Z to 2026-10-10T12:00:00.000Z','no zero is inferred'])assert.ok(text.includes(expected),expected);
    }finally{writer.close();}
    const reader=new Service(file);try{assert.deepEqual(reader.replay(id),reader.show(id));assert.equal(reader.analyzeLive(bundle).id,id);}finally{reader.close();}
    const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(id)!.semantic as string).policyVersion,'research-screen-advisory-v30');}finally{db.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

const completeCreator=new PublicKey(Buffer.alloc(32,7)),completePool=poolPda(0,completeCreator,new PublicKey(token.address),NATIVE_MINT).toBase58(),completeAnchorSlot=10_001;
/** Same public fixture with a verifiable PumpSwap pool and finalized anchor, so the selected hour and the 12-hour demand tape complete. */
async function completeHourFetcher(){
  const type=sdk.idl.types!.find(t=>t.name==='pool')!,state:Record<string,unknown>={};
  for(const f of (type.type as any).fields)state[f.name]=f.type==='pubkey'?completeCreator:f.type==='bool'?false:f.type==='string'?'':f.type==='u8'||f.type==='u16'?0:new BN(0);
  Object.assign(state,{baseMint:new PublicKey(token.address),quoteMint:NATIVE_MINT});
  const poolData=(await sdk.coder.accounts.encode('pool',state)).toString('base64'),bodies=new Map<string,string>();
  const complete:typeof fetch=async(input,init)=>{
    const request=init?.method==='POST'?JSON.parse(String(init.body)):null;
    const result=request?.method==='getSlot'?completeAnchorSlot:request?.method==='getBlockTime'?hour+60:request?.method==='getAccountInfo'&&request.params[0]===completePool?{context:{slot:completeAnchorSlot+1},value:{owner:PUMP_AMM_PROGRAM_ID.toBase58(),executable:false,lamports:1,data:[poolData,'base64']}}:undefined;
    let text:string;
    if(result!==undefined)text=JSON.stringify({jsonrpc:'2.0',id:1,result});
    else{text=await (await fetcher(input,init)).text();if(!request)text=text.replaceAll(pool,completePool);}
    if(request)bodies.set(JSON.stringify({method:request.method,params:request.params}),text);
    return new Response(text);
  };
  return {complete,bodies};
}

test('complete selected hour stores exact demand archives through live collection, Service validation and replay',async()=>{
  const {complete,bodies}=await completeHourFetcher();
  const bundle=await collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher:complete,now:()=>at});
  const proof=JSON.parse(bundle.rawArtifacts['advisory-derivation']!);
  assert.equal(proof.pool,completePool);assert.deepEqual(Object.keys(proof.demand.requests).sort(),['demand-page-0','demand-pool']);
  for(const [key,id] of Object.entries(proof.demand.artifactIds as Record<string,string>)){
    const record=bundle.evidence.find(e=>e.id===id)!,stored=bundle.rawArtifacts[id]!,container=JSON.parse(stored),original=unpackDemandReceipt(stored,demandArchiveSourceLimit(key));
    assert.deepEqual([record.sourceId,record.sourceType,record.accessMode,record.adapterVersion,Object.keys(record.scope)],['advisory-demand','HISTORICAL_RECEIPT','PUBLIC_API',DEMAND_ARCHIVE_ADAPTER,['request']]);
    assert.equal(record.contentHash,createHash('sha256').update(stored).digest('hex'));assert.equal(container.method,'advisory-demand-rpc-archive-v1');
    assert.equal(original,bodies.get(JSON.stringify(proof.demand.requests[key])));assert.equal(container.sourceHash,createHash('sha256').update(original).digest('hex'));
  }
  // Proof v21 stores every selected-window receipt as an exact window-archive-v1 archive with a sole request scope and the stored archive hash; the original body and its source hash are recoverable byte for byte.
  assert.equal(proof.method,'advisory-provenance-v33');assert.equal(proof.window.requests['window-page-0'].params[1].limit,WINDOW_EXPANDED_PAGE_LIMIT);
  const windowIds=proof.window.artifactIds as Record<string,string>;
  assert.deepEqual(bundle.evidence.filter(e=>e.sourceId==='advisory-window').map(e=>e.id).sort(),Object.values(windowIds).sort());
  for(const [key,id] of Object.entries(windowIds)){
    const record=bundle.evidence.find(e=>e.id===id)!,stored=bundle.rawArtifacts[id]!,container=JSON.parse(stored),original=unpackDemandReceipt(stored,WINDOW_ARCHIVE_SOURCE_BYTES);
    assert.deepEqual([record.sourceId,record.sourceType,record.accessMode,record.adapterVersion,Object.keys(record.scope),record.scope.request,record.contentHash,container.method],['advisory-window','HISTORICAL_RECEIPT','PUBLIC_API',WINDOW_ARCHIVE_ADAPTER,['request'],proof.window.requests[key],createHash('sha256').update(stored).digest('hex'),'advisory-demand-rpc-archive-v1']);
    assert.equal(original,bodies.get(JSON.stringify(proof.window.requests[key])));assert.equal(container.sourceHash,createHash('sha256').update(original).digest('hex'));
  }
  const facts=bundle.details!.advisory!,a30=facts.metrics.find(m=>m.id==='A30')!,data=a30.data as any;
  assert.equal(facts.metrics.length,50);assert.equal(a30.quality,'KNOWN');assert.equal(data.method,'complete-pool-baseline-demand-windows-v1');
  assert.deepEqual([data.complete,data.satisfiedWindows,data.share,data.denominator,data.windows.length],[true,0,'0',6,6]);
  // A complete tradeless tape gives O23 no denominator: missing, never a measured zero.
  const o23=facts.metrics.find(m=>m.id==='O23')!;assert.deepEqual([o23.quality,o23.reasonCode,(o23.data as any).denominator,(o23.data as any).bins.every((b:any)=>b.fraction===null)],['MISSING','SYNCHRONY_DENOMINATOR_ZERO',0,true]);
  // The same tradeless tape leaves O29 explicitly unmeasured with every value null.
  const o29=facts.metrics.find(m=>m.id==='O29')!,reserve=o29.data as any;assert.deepEqual([o29.quality,o29.reasonCode,reserve.method,reserve.whole,reserve.hours,reserve.anomaly,reserve.depthAtDefinedImpact],['MISSING','RESERVE_PATH_NO_TRADES','complete-pool-effective-reserve-path-v1',null,null,null,null]);
  assert.deepEqual([data.storage.receipts,data.storage.storedAggregateCapBytes],[2,24_000_000]);assert.ok(data.storage.storedBytes>0&&data.storage.sourceBytes>0);
  const poolId=proof.demand.artifactIds['demand-pool'] as string,original=unpackDemandReceipt(bundle.rawArtifacts[poolId]!,demandArchiveSourceLimit('demand-pool'));
  const tamper=(change:(b:typeof bundle)=>void)=>{const b=structuredClone(bundle);change(b);rehash(b,poolId);return b;};
  const direct=(b:typeof bundle)=>()=>reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);
  const plainUnderArchive=tamper(b=>{b.rawArtifacts[poolId]=original;});
  assert.throws(direct(plainUnderArchive),/ADVISORY_DEMAND_ARCHIVE_INVALID/);
  assert.throws(direct(tamper(b=>{const c=JSON.parse(b.rawArtifacts[poolId]!);c.sourceHash=createHash('sha256').update('forged').digest('hex');b.rawArtifacts[poolId]=JSON.stringify(c);})),/ADVISORY_DEMAND_ARCHIVE_INVALID/);
  assert.throws(direct(tamper(b=>{b.evidence.find(e=>e.id===poolId)!.adapterVersion='live-v1';})),/ADVISORY_PROOF_INVALID/);
  // Window archives fail closed at resolve: plain or forged bodies, a downgraded adapter, extra scope, a stale hash, a duplicate and orphan source-, prefix- or adapter-identified receipts are all rejected.
  const pageId=windowIds['window-page-0']!,pageRecord=(b:typeof bundle)=>b.evidence.find(e=>e.id===pageId)!;
  const copy=(b:typeof bundle,id:string,change:(r:any)=>void)=>{b.rawArtifacts[id]=b.rawArtifacts[pageId]!;const r:any=structuredClone(pageRecord(b));r.id=id;change(r);b.evidence.push(r);rehash(b,id);};
  const windowForgeries:Array<[string,(b:typeof bundle)=>void]>=[
    ['plain-under-archive',b=>{b.rawArtifacts[pageId]=unpackDemandReceipt(b.rawArtifacts[pageId]!,WINDOW_ARCHIVE_SOURCE_BYTES);rehash(b,pageId);}],
    ['forged-source-hash',b=>{const c=JSON.parse(b.rawArtifacts[pageId]!);c.sourceHash=createHash('sha256').update('forged').digest('hex');b.rawArtifacts[pageId]=JSON.stringify(c);rehash(b,pageId);}],
    ['adapter-downgrade',b=>{pageRecord(b).adapterVersion='live-v1';}],
    ['extra-scope-key',b=>{(pageRecord(b).scope as Record<string,unknown>).extra=1;}],
    ['stale-hash',b=>{pageRecord(b).contentHash='0'.repeat(64);}],
    ['duplicate-id',b=>{b.evidence.push(structuredClone(pageRecord(b)));}],
    ['orphan-by-prefix',b=>copy(b,'advisory-window-shadow',r=>{r.sourceId='advisory-context';r.adapterVersion='live-v1';})],
    ['orphan-by-source',b=>copy(b,'loose-window-source',r=>{r.adapterVersion='live-v1';})],
    ['orphan-by-adapter',b=>copy(b,'loose-window-adapter',r=>{r.sourceId='advisory-context';})],
  ];
  for(const [name,change] of windowForgeries){const b=structuredClone(bundle);change(b);assert.throws(direct(b),/ADVISORY_PROOF_INVALID/,name);}
  const directory=mkdtempSync(join(tmpdir(),'advisory-demand-archive-')),file=join(directory,'live.sqlite');
  try{
    const writer=new Service(file);let id='';
    try{id=writer.analyzeLive(bundle).id;assert.throws(()=>writer.analyzeLive(plainUnderArchive),/ADVISORY_PROOF_INVALID/);}finally{writer.close();}
    const reader=new Service(file);try{assert.deepEqual(reader.replay(id),reader.show(id));assert.equal(reader.analyzeLive(bundle).id,id);}finally{reader.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('fresh proof v29 dispatch is required while legacy v25, v24 and v23 reconstruction stay frozen',async()=>{
  const {complete}=await completeHourFetcher();
  const bundle=await collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher:complete,now:()=>at});
  const proof=JSON.parse(bundle.rawArtifacts['advisory-derivation']!),facts=bundle.details!.advisory!;
  assert.deepEqual([proof.method,facts.method],['advisory-provenance-v33','advisory-measurements-v32']);
  const legacy=legacyDenseWindowBundle(bundle),rebuild=(method:string)=>reconstructAdvisory(token,at,legacy.bundle.details!.baseline,legacy.bundle.evidence,legacy.bundle.rawArtifacts,{...legacy.proof,method},legacy.bundle.thesis??null,legacy.bundle.features),oldFacts=rebuild('advisory-provenance-v27');
  const prior25=rebuild('advisory-provenance-v25');
  assert.deepEqual(prior25,{...oldFacts,method:'advisory-measurements-v24'});
  const previous=rebuild('advisory-provenance-v24');
  assert.deepEqual(previous,{...oldFacts,method:'advisory-measurements-v23'});
  const oldProof={...legacy.proof,method:'advisory-provenance-v23'};
  const old=rebuild('advisory-provenance-v23');
  assert.equal(old.method,'advisory-measurements-v22');
  assert.equal(old.supplements!.shortDemand.coverage.logRecovery?.unresolvedForeignSwaps,undefined);
  const oldShort=structuredClone(old.supplements!.shortDemand) as any;
  if(oldShort.coverage.logRecovery)oldShort.coverage.logRecovery.unresolvedForeignSwaps=0;
  assert.equal(advisoryFactsSchema.safeParse({...old,supplements:{shortDemand:oldShort}}).success,oldShort.coverage.logRecovery===null);
  const downgraded=structuredClone(bundle);
  downgraded.rawArtifacts['advisory-derivation']=JSON.stringify(oldProof);rehash(downgraded,'advisory-derivation');
  downgraded.details!.advisory=old;
  const directory=mkdtempSync(join(tmpdir(),'advisory-v24-dispatch-'));
  try{const service=new Service(join(directory,'live.sqlite'));try{
    assert.throws(()=>service.analyzeLive(downgraded),/ADVISORY_PROOF_INVALID/);
    const saved=service.analyzeLive(bundle);assert.deepEqual(service.replay(saved.id),saved);
  }finally{service.close();}}finally{rmSync(directory,{recursive:true,force:true});}
});

for(const [version,measured] of [[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[16,17],[17,18],[18,19],[19,20],[20,21]] as const)test(`a saved research-screen-advisory-v${version} snapshot with facts v${measured} still replays from its stored facts`,async()=>{
  const bundle=await collect(),directory=mkdtempSync(join(tmpdir(),'advisory-v7-replay-')),file=join(directory,'live.sqlite');
  try{
    const writer=new Service(file);let id='',relabeled='';try{id=writer.analyzeLive(bundle).id;}finally{writer.close();}
    const db=new DatabaseSync(file);
    try{
      db.exec('DROP TRIGGER snapshots_no_update');
      const stored=db.prepare('SELECT payload,semantic FROM snapshots WHERE id=?').get(id) as {payload:string;semantic:string};
      const payload=JSON.parse(stored.payload),semantic=JSON.parse(stored.semantic);
      // Saved facts before v17 never carried the supplementary report; saved short (v17), C16 (v18), creator-inventory (v19) and O25 (v20) facts keep it under their recorded policy (v16, v17, v18, v19).
      semantic.policyVersion=`research-screen-advisory-v${version}`;semantic.details.advisory.method=`advisory-measurements-v${measured}`;if(measured<17)delete semantic.details.advisory.supplements;
      if(payload.details?.advisory){payload.details.advisory.method=`advisory-measurements-v${measured}`;if(measured<17)delete payload.details.advisory.supplements;}
      payload.hash=relabeled=decisionHash(semantic);
      db.prepare('UPDATE snapshots SET payload=?,hash=?,semantic=? WHERE id=?').run(JSON.stringify(payload),payload.hash,JSON.stringify(semantic),id);
    }finally{db.close();}
    const reader=new Service(file);try{const replayed=reader.replay(id);assert.deepEqual(replayed,reader.show(id));assert.equal(replayed.hash,relabeled);}finally{reader.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('trader-account history has its own bounded allowance and never consumes the shared 150-request budget',()=>{
  let calls=0;const base:typeof fetch=async()=>{calls++;return new Response('{}');};
  const controller=new AbortController(),admission=admittedFetchers(base,controller.signal,64,DEMAND_REQUEST_CAP,CALLER_REQUEST_CAP);
  for(let i=0;i<64;i++)void admission.accountFetcher('https://rpc.example');
  assert.throws(()=>admission.accountFetcher('https://rpc.example'),/COLLECTION_BUDGET/);
  for(let i=0;i<DEMAND_REQUEST_CAP;i++)void admission.demandFetcher('https://rpc.example');
  assert.throws(()=>admission.demandFetcher('https://rpc.example'),/COLLECTION_BUDGET/);
  for(let i=0;i<CALLER_REQUEST_CAP;i++)void admission.callerFetcher('https://cdn.syndication.twimg.com/tweet-result');
  assert.throws(()=>admission.callerFetcher('https://cdn.syndication.twimg.com/tweet-result'),/COLLECTION_BUDGET/);
  assert.deepEqual(admission.counts,{shared:0,accounts:64,demand:DEMAND_REQUEST_CAP,callers:CALLER_REQUEST_CAP,inventory:0,failedFees:0,window:0});
  for(let i=0;i<150;i++)void admission.fetcher('https://rpc.example');
  assert.throws(()=>admission.fetcher('https://rpc.example'),/COLLECTION_BUDGET/);
  assert.deepEqual({counts:admission.counts,limit:admission.limit,calls},{counts:{shared:150,accounts:64,demand:DEMAND_REQUEST_CAP,callers:CALLER_REQUEST_CAP,inventory:0,failedFees:0,window:0},limit:{shared:150,accounts:64,demand:DEMAND_REQUEST_CAP,callers:CALLER_REQUEST_CAP,inventory:0,failedFees:0,window:0},calls:214+DEMAND_REQUEST_CAP+CALLER_REQUEST_CAP});
  const disabled=admittedFetchers(base,controller.signal,0);
  assert.throws(()=>disabled.accountFetcher('https://rpc.example'),/COLLECTION_BUDGET/);assert.throws(()=>disabled.demandFetcher('https://rpc.example'),/COLLECTION_BUDGET/);assert.throws(()=>disabled.callerFetcher('https://rpc.example'),/COLLECTION_BUDGET/);assert.throws(()=>disabled.inventoryFetcher('https://rpc.example'),/COLLECTION_BUDGET/);assert.throws(()=>disabled.failedFeeFetcher('https://rpc.example'),/COLLECTION_BUDGET/);assert.throws(()=>disabled.windowFetcher('https://rpc.example'),/COLLECTION_BUDGET/);assert.deepEqual(disabled.counts,{shared:0,accounts:0,demand:0,callers:0,inventory:0,failedFees:0,window:0});
  // Creator inventory has its own derived 102-request pool and never touches the shared 150.
  const inventory=admittedFetchers(base,controller.signal,0,0,0,CREATOR_INVENTORY_REQUEST_CAP);
  for(let i=0;i<CREATOR_INVENTORY_REQUEST_CAP;i++)void inventory.inventoryFetcher('https://rpc.example');
  assert.throws(()=>inventory.inventoryFetcher('https://rpc.example'),/COLLECTION_BUDGET/);
  assert.deepEqual([inventory.counts,inventory.limit,CREATOR_INVENTORY_REQUEST_CAP],[{shared:0,accounts:0,demand:0,callers:0,inventory:102,failedFees:0,window:0},{shared:150,accounts:0,demand:0,callers:0,inventory:102,failedFees:0,window:0},102]);
  // Failed-fee receipts have their own 130-request pool; it never touches the shared 150, inventory or any other allowance.
  const failed=admittedFetchers(base,controller.signal,0,0,0,0,CREATOR_FAILED_FEE_REQUEST_CAP);
  for(let i=0;i<CREATOR_FAILED_FEE_REQUEST_CAP;i++)void failed.failedFeeFetcher('https://rpc.example');
  assert.throws(()=>failed.failedFeeFetcher('https://rpc.example'),/COLLECTION_BUDGET/);assert.throws(()=>failed.inventoryFetcher('https://rpc.example'),/COLLECTION_BUDGET/);
  assert.deepEqual([failed.counts,failed.limit,CREATOR_FAILED_FEE_REQUEST_CAP],[{shared:0,accounts:0,demand:0,callers:0,inventory:0,failedFees:130,window:0},{shared:150,accounts:0,demand:0,callers:0,inventory:0,failedFees:130,window:0},130]);
  // Dense selected-window reads have their own 72-request pool; they never touch the shared 150 or any other allowance.
  const dense=admittedFetchers(base,controller.signal,0,0,0,0,0,WINDOW_DENSE_REQUEST_CAP);
  for(let i=0;i<WINDOW_DENSE_REQUEST_CAP;i++)void dense.windowFetcher('https://rpc.example');
  assert.throws(()=>dense.windowFetcher('https://rpc.example'),/COLLECTION_BUDGET/);
  assert.deepEqual([dense.counts,dense.limit,WINDOW_DENSE_REQUEST_CAP],[{shared:0,accounts:0,demand:0,callers:0,inventory:0,failedFees:0,window:72},{shared:150,accounts:0,demand:0,callers:0,inventory:0,failedFees:0,window:72},72]);
  controller.abort(new Error('COLLECTION_DEADLINE'));
  const late=admittedFetchers(base,controller.signal,64,DEMAND_REQUEST_CAP);assert.throws(()=>late.accountFetcher('https://rpc.example'),/COLLECTION_DEADLINE/);assert.equal(late.counts.accounts,0);assert.throws(()=>late.demandFetcher('https://rpc.example'),/COLLECTION_DEADLINE/);assert.equal(late.counts.demand,0);
  const lateFailed=admittedFetchers(base,controller.signal,0,0,0,0,CREATOR_FAILED_FEE_REQUEST_CAP);assert.throws(()=>lateFailed.failedFeeFetcher('https://rpc.example'),/COLLECTION_DEADLINE/);assert.equal(lateFailed.counts.failedFees,0);
});

test('failed-fee receipts are owned only by a v20 descriptor over an ingested inventory; orphans, downgrades and misfiles are rejected and null is never a zero',async()=>{
  const bundle=await collect(),proof=JSON.parse(bundle.rawArtifacts['advisory-derivation']!),s15=bundle.details!.advisory!.metrics.find(m=>m.id==='S15')!;
  assert.deepEqual([proof.creatorFailedFees,s15.quality,s15.reasonCode,s15.data],[null,'MISSING','TRANSFER_AWARE_ACTOR_COST_BASIS_REQUIRED',null]);
  assert.ok(!bundle.evidence.some(e=>e.sourceId===FAILED_FEE_SOURCE_ID||e.adapterVersion===FAILED_FEE_ADAPTER||e.id.startsWith('advisory-creatorFailedFees-')));
  const signature=encodeSolanaAddress(Buffer.alloc(64,9)),key=failedFeeReceiptId(signature),id=`advisory-creatorFailedFees-${key}`,request=failedFeeRequest(signature);
  const declared={requests:{[key]:request},artifactIds:{[key]:id}};
  // A well-formed archived receipt in the live ingest shape; each case changes only ownership or proof version.
  const add=(b:typeof bundle,recordId:string,change:(r:any)=>void=()=>{})=>{
    const template=b.evidence.find(e=>e.sourceId==='advisory-window')!,r:any={...structuredClone(template),id:recordId,sourceId:FAILED_FEE_SOURCE_ID,adapterVersion:FAILED_FEE_ADAPTER,scope:{request}};change(r);
    b.evidence.push(r);b.rawArtifacts[recordId]=archiveCreatorFailedFeeReceipt(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:'RPC_TRANSPORT'}}));rehash(b,recordId);
  };
  const run=(b:typeof bundle,p:unknown)=>()=>reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,p,b.thesis??null,b.features);
  const cases:Array<[string,(b:typeof bundle)=>unknown]>=[
    ['orphan-by-source',b=>{add(b,'advisory-window-misfiled-failed-fee');return proof;}],
    ['orphan-by-prefix',b=>{add(b,id,r=>{r.sourceId='advisory-window';r.adapterVersion='live-v1';});return proof;}],
    ['orphan-by-adapter',b=>{add(b,'loose-failed-fee',r=>{r.sourceId='advisory-window';});return proof;}],
    ['orphan-under-null-descriptor',b=>{add(b,id);return proof;}],
    ['descriptor-without-inventory',b=>{add(b,id);return {...proof,creatorFailedFees:declared};}],
    ['empty-descriptor-without-inventory',()=>({...proof,creatorFailedFees:{requests:{},artifactIds:{}}})],
    ['v19-proof-with-descriptor',b=>{add(b,id);return {...proof,method:'advisory-provenance-v19',creatorFailedFees:declared};}],
    ['v20-proof-without-key',()=>{const p={...proof};delete p.creatorFailedFees;return p;}],
  ];
  for(const [name,make] of cases){const b=structuredClone(bundle),p=make(b);assert.throws(run(b,p),/ADVISORY_PROOF_INVALID/,name);}
  const directory=mkdtempSync(join(tmpdir(),'advisory-failed-fees-'));
  try{
    const service=new Service(join(directory,'live.sqlite'));
    try{
      // The failed-fee source is a known public API, so a public orphan reaches the advisory proof and fails there; a wrong access mode fails provenance first.
      const orphan=structuredClone(bundle);add(orphan,id);assert.throws(()=>service.analyzeLive(orphan),/ADVISORY_PROOF_INVALID/);
      const access=structuredClone(bundle);add(access,id,r=>{r.accessMode='FREE_ACCOUNT';});assert.throws(()=>service.analyzeLive(access),/LIVE_PROVENANCE_INVALID/);
      const saved=service.analyzeLive(bundle);assert.deepEqual(service.replay(saved.id),saved);
    }finally{service.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('the unchanged 24 MB live artifact cap admits a bundle at the cap and rejects one byte over',async()=>{
  const bundle=await collect(),size=(b:typeof bundle)=>b.evidence.reduce((n,e)=>n+(b.rawArtifacts[e.id]===undefined?0:Buffer.byteLength(b.rawArtifacts[e.id]!)),0);
  const pad=(n:number)=>{const b=structuredClone(bundle);b.rawArtifacts['analysis-context']+=' '.repeat(n);rehash(b,'analysis-context');return b;};
  const room=24_000_000-size(bundle);assert.ok(room>0);
  const directory=mkdtempSync(join(tmpdir(),'advisory-artifact-cap-'));
  try{
    const service=new Service(join(directory,'live.sqlite'));
    try{const full=pad(room);assert.equal(size(full),24_000_000);assert.ok(service.analyzeLive(full).id);assert.throws(()=>service.analyzeLive(pad(room+1)),/ARTIFACT_HASH_OR_SIZE/);}finally{service.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('advisory rehashed metric, raw request, clock and marker tampering cannot certify a live result',async()=>{
  const original=await collect(),directory=mkdtempSync(join(tmpdir(),'advisory-tamper-'));
  const reject=(name:string,mutate:(bundle:typeof original)=>void)=>{
    const candidate=structuredClone(original),service=new Service(join(directory,`${name}.sqlite`));
    try{assert.throws(()=>{mutate(candidate);service.analyzeLive(candidate);},/ADVISORY_PROOF|FUTURE_EVIDENCE|FUTURE_|RAW_ARTIFACT_REQUIRED|LIVE_PROVENANCE_INVALID/,name);}finally{service.close();}
  };
  try{
    reject('normalized-o28-forgery',b=>{b.details!.baseline.find(a=>a.id==='O28')!.data={netQuoteFlowUsd:'999999999999',meaning:'fabricated organic buys'};b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,JSON.parse(b.rawArtifacts['advisory-derivation']!),b.thesis??null,b.features);});
    reject('normalized-market-forgery',b=>{b.market!.pairs[0]!.buys24h=999999;b.details!.baseline.find(a=>a.id==='O28')!.data={fabricated:true};b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,JSON.parse(b.rawArtifacts['advisory-derivation']!),b.thesis??null,b.features);});
    reject('legacy-proof-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v1';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('wallet-proof-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v2';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('wallet-proof-descriptor-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.wallets;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('window-proof-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v3';delete proof.window;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('window-abi-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v4';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('window-fee-basis-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v5';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('self-consistent-unsafe-window-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v5';delete proof.accounts;delete proof.automation;delete proof.topology;delete proof.demand;delete proof.callers;delete proof.callerSemantic;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);});
    reject('accounts-proof-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v6';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('accounts-proof-descriptor-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.accounts;delete proof.automation;delete proof.topology;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('self-consistent-accounts-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v6';delete proof.accounts;delete proof.automation;delete proof.topology;delete proof.demand;delete proof.callers;delete proof.callerSemantic;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);});
    reject('automation-proof-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v7';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('automation-proof-descriptor-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.automation;delete proof.topology;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('self-consistent-automation-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v7';delete proof.automation;delete proof.topology;delete proof.demand;delete proof.callers;delete proof.callerSemantic;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);});
    reject('topology-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v8';delete proof.topology;delete proof.demand;delete proof.callers;delete proof.callerSemantic;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);});
    reject('demand-proof-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v9';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('demand-descriptor-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.demand;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('self-consistent-demand-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v9';delete proof.demand;delete proof.callers;delete proof.callerSemantic;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);});
    reject('claimed-demand-measurement',b=>{const metric=b.details!.advisory!.metrics.find(m=>m.id==='A30')!;metric.quality='KNOWN';metric.data={satisfiedWindows:6,share:'1',claim:'persistent organic demand'};for(const group of b.details!.advisory!.groups)if(group.unresolved.includes('A30')){group.known++;group.unresolved=group.unresolved.filter(id=>id!=='A30');}});
    reject('forged-demand-receipt',b=>{
      // An ineligible selected hour admits no demand receipt, even one with valid hash, source and scope.
      const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!),key='demand-page-0',id=`advisory-demand-${key}`;
      const request={method:'getSignaturesForAddress',params:[pool,{commitment:'finalized',limit:1000,minContextSlot:1}]};
      proof.demand={requests:{[key]:request},artifactIds:{[key]:id}};b.rawArtifacts[id]=archiveDemandReceipt(JSON.stringify({jsonrpc:'2.0',id:1,result:[]}));
      const template=b.evidence.find(e=>e.sourceId==='advisory-window')!;b.evidence.push({...structuredClone(template),id,sourceId:'advisory-demand',adapterVersion:DEMAND_ARCHIVE_ADAPTER,scope:{request}});rehash(b,id);
      b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');
      assert.throws(()=>reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features),/ADVISORY_DEMAND_RECEIPT_MEMBERSHIP/);
    });
    reject('forged-demand-receipt-metadata',b=>{
      // Valid metadata reaches membership; each forged adapter, scope, hash or duplicate id fails at the demand boundary first.
      const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!),key='demand-page-0',id=`advisory-demand-${key}`;
      const request={method:'getSignaturesForAddress',params:[pool,{commitment:'finalized',limit:1000,minContextSlot:1}]};
      proof.demand={requests:{[key]:request},artifactIds:{[key]:id}};b.rawArtifacts[id]=archiveDemandReceipt(JSON.stringify({jsonrpc:'2.0',id:1,result:[]}));
      const template=b.evidence.find(e=>e.sourceId==='advisory-window')!;b.evidence.push({...structuredClone(template),id,sourceId:'advisory-demand',adapterVersion:DEMAND_ARCHIVE_ADAPTER,scope:{request}});rehash(b,id);
      b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');
      const run=(evidence:typeof b.evidence)=>reconstructAdvisory(token,at,b.details!.baseline,evidence,b.rawArtifacts,proof,b.thesis??null,b.features);
      assert.throws(()=>run(b.evidence),/ADVISORY_DEMAND_RECEIPT_MEMBERSHIP/);
      const forge=(change:(record:any)=>void)=>{const evidence=structuredClone(b.evidence);change(evidence.find(e=>e.id===id)!);return evidence;};
      const forgeries:Array<[string,typeof b.evidence]>=[
        ['plain-live-adapter',forge(r=>{r.adapterVersion='live-v1';})],['unknown-archive-adapter',forge(r=>{r.adapterVersion='demand-archive-v2';})],['missing-adapter',forge(r=>{delete r.adapterVersion;})],
        ['extra-scope-key',forge(r=>{r.scope.extra=1;})],['missing-scope-request',forge(r=>{delete r.scope.request;})],
        ['mutated-scope-request',forge(r=>{r.scope.request={method:'getSignaturesForAddress',params:[pool,{commitment:'finalized',limit:1000,minContextSlot:2}]};})],
        ['stale-content-hash',forge(r=>{r.contentHash='0'.repeat(64);})],
        ['duplicate-id',[...structuredClone(b.evidence),structuredClone(b.evidence.find(e=>e.id===id)!)]],
      ];
      for(const [name,evidence] of forgeries)assert.throws(()=>run(evidence),/ADVISORY_PROOF_INVALID/,name);
      b.evidence.find(e=>e.id===id)!.adapterVersion='live-v0';
    });
    reject('topology-descriptor-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.topology;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('callers-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v10';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('self-consistent-callers-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v10';delete proof.callers;delete proof.callerSemantic;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);});
    reject('callers-descriptor-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.callers;delete proof.callerSemantic;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('origin-wire-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v11';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('self-consistent-origin-wire-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v11';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);});
    reject('synchrony-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v12';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('reserve-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v13';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('self-consistent-reserve-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v13';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);});
    reject('self-consistent-synchrony-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v12';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);});
    reject('failed-fees-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v19';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('failed-fees-descriptor-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.creatorFailedFees;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('self-consistent-failed-fees-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v19';delete proof.creatorFailedFees;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);});
    for(const [name,id,sourceId] of [['orphan-caller-receipt','advisory-callers-caller-history:1:oembed','advisory-callers'],['orphan-caller-selection','advisory-callers-selection','advisory-collector'],['orphan-caller-semantic','advisory-callerSemantic-advisory-semantic-proposal-response','gemini']] as const)reject(name,b=>{
      const template=b.evidence.find(e=>e.sourceId==='advisory-window')!;b.evidence.push({...structuredClone(template),id,sourceId});b.rawArtifacts[id]='{}';rehash(b,id);
      assert.throws(()=>reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,JSON.parse(b.rawArtifacts['advisory-derivation']!),b.thesis??null,b.features),/ADVISORY_PROOF_INVALID/);
    });
    reject('claimed-topology-measurement',b=>{b.details!.advisory!.metrics.find(m=>m.id==='O21')!.data={largestProvenControlFraction:'1',inventedOwners:true};});
    reject('claimed-automation-measurement',b=>{b.details!.advisory!.metrics.find(m=>m.id==='O30')!.quality='KNOWN';b.details!.advisory!.metrics.find(m=>m.id==='O30')!.data={knownAutomatedFraction:'0',claim:'bot-free'};for(const group of b.details!.advisory!.groups)if(group.unresolved.includes('O30')){group.known++;group.unresolved=group.unresolved.filter(id=>id!=='O30');}});
    reject('forged-automation-receipt',b=>{
      const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!),key='automation-program',id=`advisory-automation-${key}`;
      const request={method:'getAccountInfo',params:[pool,{commitment:'finalized',encoding:'base64',minContextSlot:1,dataSlice:{offset:0,length:0}}]};
      proof.automation={requests:{[key]:request},artifactIds:{[key]:id}};b.rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,result:{context:{slot:1},value:{executable:true}}});
      const template=b.evidence.find(e=>e.sourceId==='advisory-window')!;b.evidence.push({...structuredClone(template),id,sourceId:'advisory-automation',adapterVersion:'live-v1',scope:{...template.scope,request}});rehash(b,id);
      b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');
    });
    reject('forged-accounts-receipt',b=>{
      // A receipt for a window that never bound any trader account must not enter the proof.
      const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!),key='account-0-page-0',id=`advisory-accounts-${key}`;
      const request={method:'getSignaturesForAddress',params:[pool,{commitment:'finalized',limit:32,minContextSlot:1}]};
      proof.accounts={requests:{[key]:request},artifactIds:{[key]:id}};b.rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,result:[]});
      const template=b.evidence.find(e=>e.sourceId==='advisory-window')!;b.evidence.push({...structuredClone(template),id,sourceId:'advisory-accounts',adapterVersion:'live-v1',scope:{...template.scope,request}});rehash(b,id);
      b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');
      assert.throws(()=>reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features),/ADVISORY_ACCOUNTS_RECEIPT_MEMBERSHIP/);
    });
    reject('window-proof-descriptor-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.window;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('window-future-end',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.window.end='2026-10-10T12:31:00.000Z';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('window-request-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.window.requests['window-genesis'];b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('window-raw-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete b.rawArtifacts[proof.window.artifactIds['window-genesis']];});
    reject('context-request-forgery',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.context.requests['bridge-page-0'].url='https://unrelated.example';b.evidence.find(e=>e.id===proof.context.artifactIds['bridge-page-0'])!.scope.request=proof.context.requests['bridge-page-0'];b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('entire-details-removal',b=>{delete b.details;});
    reject('claimed-measurement',b=>{b.details!.advisory!.metrics.find(m=>m.id==='C08')!.data={returnFraction:'999'};});
    reject('wrong-request-token',b=>{
      const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);const key=Object.keys(proof.market.requests).find(k=>k==='market-candles')!;
      proof.market.requests[key].url=proof.market.requests[key].url.replace(token.address,quote);
      const record=b.evidence.find(e=>e.id===proof.market.artifactIds[key])!;record.scope.request=proof.market.requests[key];
      b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');
    });
    reject('future-availability',b=>{const record=b.evidence.find(e=>e.sourceId==='advisory-market')!;record.availableAt='2026-10-11T00:00:00.000Z';record.retrievedAt=record.availableAt;});
    reject('receipt-token',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.token.address=quote;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('details-marker-removal',b=>{delete b.details!.advisory;});
    reject('both-marker-removal',b=>{delete b.details!.advisory;delete b.rawArtifacts['advisory-derivation'];b.evidence=b.evidence.filter(e=>e.id!=='advisory-derivation');});
    reject('request-catalog-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.market.requests['market-candles'];b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('measurement coverage cannot override required failures and old boolean policy is unchanged',async()=>{
  const bundle=await collect(),facts=structuredClone(bundle.details!.advisory!);
  for(const metric of facts.metrics){metric.quality='KNOWN';metric.data={observed:'0'};}
  for(const group of facts.groups){group.known=group.total;group.unresolved=[];}
  const measured=evaluateEntry(bundle.features,bundle.profile,at,'QUALIFIED_V2',undefined,false,advisoryFactsSchema.parse(facts));
  assert.ok(measured.checks.filter(c=>c.checkId.startsWith('ADV-')).every(c=>c.status==='PASS'&&c.reasonCode==='ADVISORY_CONTEXT_MEASURED'));
  assert.equal(measured.classification,'REJECTED');
  const historical=evaluateEntry(bundle.features,bundle.profile,at,'QUALIFIED_V2');
  assert.deepEqual(measured.checks.filter(c=>c.required),historical.checks.filter(c=>c.required));
  assert.ok(historical.checks.filter(c=>c.checkId.startsWith('ADV-')).every(c=>c.reasonCode!=='ADVISORY_CONTEXT_MEASURED'));
});

test('facts schema binds the supplementary report to fresh facts v17 with its fixed shape and null semantics',async()=>{
  const bundle=await collect(),facts=structuredClone(bundle.details!.advisory!);
  const valid=(value:unknown)=>advisoryFactsSchema.safeParse(value).success;
  assert.equal(valid(facts),true);
  const {supplements,...plain}=facts;assert.ok(supplements);
  assert.equal(valid({...plain,method:'advisory-measurements-v16'}),true,'saved facts without a supplement');
  assert.equal(valid({...facts,method:'advisory-measurements-v16'}),false,'old facts carrying a supplement');
  assert.equal(valid(plain),false,'fresh facts missing the supplement');
  assert.equal(valid({...facts,method:'advisory-measurements-v17'}),true,'saved short facts keep their supplement');
  assert.equal(valid({...plain,method:'advisory-measurements-v17'}),false,'saved short facts missing the supplement');
  assert.equal(valid({...facts,method:'advisory-measurements-v18'}),true,'saved C16 facts keep their supplement');
  assert.equal(valid({...plain,method:'advisory-measurements-v18'}),false,'saved C16 facts missing the supplement');
  assert.equal(valid({...facts,method:'advisory-measurements-v19'}),true,'saved creator-inventory facts keep their supplement');
  assert.equal(valid({...plain,method:'advisory-measurements-v19'}),false,'saved creator-inventory facts missing the supplement');
  assert.equal(valid({...facts,method:'advisory-measurements-v20'}),true,'saved O25 facts keep their supplement');
  assert.equal(valid({...plain,method:'advisory-measurements-v20'}),false,'saved O25 facts missing the supplement');
  const report=(change:(r:any)=>void)=>{const f=structuredClone(facts) as any;change(f.supplements.shortDemand);return valid(f);};
  const cases:Array<[string,(r:any)=>void]>=[
    ['method',r=>{r.method='supplementary-short-demand-windows-v2';}],['role',r=>{r.role='CANONICAL';}],['canonical substitution',r=>{r.substitutesCanonical=true;}],['counted',r=>{r.countsTowardKnownMetrics=true;}],
    ['metric id',r=>{r.canonicalMetricId='A31';}],['denominator',r=>{r.denominator=5;}],['window count',r=>{r.windows.pop();}],['window minutes',r=>{r.windowMinutes=60;}],['extra key',r=>{r.extra=1;}],
    ['status flag',r=>{r.status='COMPLETE';}],['complete flag',r=>{r.complete=true;}],['incomplete condition',r=>{r.windows[0].condition=false;}],['incomplete count',r=>{r.satisfiedWindows=0;r.share='0';}],
    ['incomplete flow',r=>{r.baseline.flow={decodedTrades:0,buyQuoteAtomic:'0',sellQuoteAtomic:'0',netQuoteAtomic:'0',programAccountTrades:0,programAccountQuoteAtomic:'0'};}],
    ['string count',r=>{r.coverage.outsideScopeUnresolvedTransactions='0';}],['shifted hour',r=>{r.reportEnd='2026-10-10T11:30:00.000Z';}],['wall-clock window',r=>{r.windows[2].start='2026-10-10T11:21:00.000Z';}],
    ['threshold',r=>{r.meaningfulThreshold.coreQuoteAtomic='1';}],['token',r=>{r.token.address=quote;}],
  ];
  for(const [name,change] of cases)assert.equal(report(change),false,name);
  assert.equal(report(()=>{}),true);
});

test('advisory inventory refuses duplicate metrics and forged coverage counts',async()=>{
  const bundle=await collect(),facts=structuredClone(bundle.details!.advisory!);
  facts.metrics[1]=facts.metrics[0]!;assert.equal(advisoryFactsSchema.safeParse(facts).success,false);
  const forged=structuredClone(bundle.details!.advisory!);forged.groups[0]!.known=forged.groups[0]!.total;forged.groups[0]!.unresolved=[];
  assert.equal(advisoryFactsSchema.safeParse(forged).success,false);
});


test('shared live provenance includes advisory parents before its frozen derivation and replays',async()=>{
  const bundle=await collect(true),directory=mkdtempSync(join(tmpdir(),'advisory-shared-'));
  try{
    assert.ok(bundle.details?.shared);assert.ok(bundle.details?.advisory);
    const packet=JSON.parse(bundle.rawArtifacts['shared-derivation']!);
    assert.ok(packet.evidence.some((e:{id:string})=>e.id==='advisory-derivation'));
    const service=new Service(join(directory,'live.sqlite'));
    try{const saved=service.analyzeLive(bundle);assert.deepEqual(service.replay(saved.id),saved);}finally{service.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});


test('a local-only reviewed social packet cannot certify advisory metrics without validated source/model provenance',async()=>{
  const bundle=await collect(),directory=mkdtempSync(join(tmpdir(),'advisory-social-proof-'));
  const shifted=JSON.stringify(makeSocialFixture()).replaceAll(SOCIAL_TOKEN.address,token.address).replace(/2026-10-0[234]T[^"]+/g,value=>new Date(Date.parse(value)+Date.parse(at)-Date.parse(SOCIAL_CUTOFF)).toISOString());
  const fixture=JSON.parse(shifted),packet={...fixture,token,cutoff:at,evidenceIds:[]};
  bundle.rawArtifacts['social-derivation']=JSON.stringify(packet);
  bundle.evidence.push({id:'social-derivation',sourceId:'social-collector',sourceType:'CALCULATION',accessMode:'LOCAL_DERIVED',retrievedAt:at,availableAt:at,contentHash:'pending',adapterVersion:'live-v1',scope:{method:'social-source-review-v1'}});
  rehash(bundle,'social-derivation');
  const proof=JSON.parse(bundle.rawArtifacts['advisory-derivation']!);proof.socialDerivationId='social-derivation';
  bundle.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(bundle,'advisory-derivation');
  bundle.details!.advisory=reconstructAdvisory(token,at,bundle.details!.baseline,bundle.evidence,bundle.rawArtifacts,proof,bundle.thesis??null,bundle.features);
  assert.equal(bundle.details!.advisory.metrics.find(m=>m.id==='A19')?.quality,'KNOWN');
  try{
    const service=new Service(join(directory,'missing-social.sqlite'));
    try{assert.throws(()=>service.analyzeLive(bundle),/ADVISORY_PROOF_INVALID/);}finally{service.close();}
    // Adding normalized social facts still cannot replace the existing source/model validation.
    bundle.details!.social=deriveSocial(fixture.read,fixture.proposal,fixture.review,token,at,[]).facts;
    const candidate=new Service(join(directory,'unverified-social.sqlite'));
    try{assert.throws(()=>candidate.analyzeLive(bundle),/SOCIAL_PROOF_INVALID|SOCIAL_PROOF_REQUIRED|SOCIAL_SOURCE_INVALID/);}finally{candidate.close();}
    delete bundle.details!.social;
    const removed=new Service(join(directory,'removed-social.sqlite'));
    try{assert.throws(()=>removed.analyzeLive(bundle),/ADVISORY_PROOF_INVALID/);}finally{removed.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});


test('C10 evaluates frozen typed entry conditions and binds their retained configuration',async()=>{
 const thesis={support:[{op:'eq' as const,feature:'O28',value:true,unit:'bool'}],invalidation:[{op:'eq' as const,feature:'O28',value:false,unit:'bool'}],catalyst:null,expiryAt:null,onchainTraction:null,externalTraction:null,warning:null,legs:[]};
 const bundle=await collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher,now:()=>at,thesis});
 const metric=bundle.details!.advisory!.metrics.find(m=>m.id==='C10')!;assert.equal(metric.quality,'KNOWN');
 const data=metric.data as {support:{truth:string}[];invalidation:{truth:string}[]};assert.equal(data.support[0]!.truth,'TRUE');assert.equal(data.invalidation[0]!.truth,'FALSE');
 const directory=mkdtempSync(join(tmpdir(),'advisory-thesis-'));const service=new Service(join(directory,'live.sqlite'));
 try{const saved=service.analyzeLive(bundle);assert.deepEqual(service.replay(saved.id),saved);
 const mutated=structuredClone(bundle),raw=JSON.parse(mutated.rawArtifacts['advisory-thesis-context']!);raw.thesis.support[0].value=false;mutated.rawArtifacts['advisory-thesis-context']=JSON.stringify(raw);rehash(mutated,'advisory-thesis-context');assert.throws(()=>service.analyzeLive(mutated),/ADVISORY_PROOF/);
 }finally{service.close();rmSync(directory,{recursive:true,force:true});}
 const unavailable=await collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher,now:()=>at,thesis:{...thesis,support:[{op:'eq',feature:'S01',value:true,unit:'bool'}]}});
 assert.equal(unavailable.details!.advisory!.metrics.find(m=>m.id==='C10')!.quality,'MISSING');
});

test('full Token-2022 topology waits for late canonical mint capture and persists reconstructed grants',async()=>{
  const owner=encodeSolanaAddress(Buffer.alloc(32,31)),delegate=encodeSolanaAddress(Buffer.alloc(32,32)),account=encodeSolanaAddress(Buffer.alloc(32,33));
  const mint=Buffer.alloc(82);mint.writeBigUInt64LE(100n,36);mint[44]=6;mint[45]=1;
  const full=Buffer.alloc(170);decodeSolanaAddress(token.address).copy(full);decodeSolanaAddress(owner).copy(full,32);full.writeBigUInt64LE(100n,64);full.writeUInt32LE(1,72);decodeSolanaAddress(delegate).copy(full,76);full[108]=1;full.writeBigUInt64LE(30n,121);full[165]=2;full.writeUInt16LE(7,166);
  const calls:string[]=[];let populationBody='';
  const liveFetcher:typeof fetch=async(input,init)=>{
    if(init?.method==='POST'){
      const req=JSON.parse(String(init.body));
      if(req.method==='getAccountInfo'&&req.params[0]===token.address){
        calls.push(req.params[1].encoding==='jsonParsed'?'mint-parsed':'mint-raw');
        const value=req.params[1].encoding==='jsonParsed'?{owner:TOKEN_2022_PROGRAM,executable:false,data:{program:'spl-token-2022',parsed:{type:'mint',info:{decimals:6,supply:'100',isInitialized:true,mintAuthority:null,freezeAuthority:null}}}}:{owner:TOKEN_2022_PROGRAM,executable:false,space:82,data:[mint.toString('base64'),'base64']};
        return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{context:{slot:1},value}}));
      }
      if(req.method==='getProgramAccounts'&&req.params[0]===TOKEN_2022_PROGRAM){
        const sliced=!!req.params[1].dataSlice;calls.push(sliced?'population-sliced':'population-full');
        const text=JSON.stringify({jsonrpc:'2.0',id:1,result:{context:{slot:2},value:[{pubkey:account,account:{owner:TOKEN_2022_PROGRAM,executable:false,space:170,data:[(sliced?full.subarray(0,165):full).toString('base64'),'base64']}}]}});
        if(!sliced)populationBody=text;return new Response(text);
      }
    }
    return fetcher(input,init);
  };
  const bundle=await collectLiveToken(token,{profile:starterProfile(),semanticEnabled:true,advisoryEnabled:true,fetcher:liveFetcher,now:()=>at});
  assert.ok(calls.indexOf('population-full')>calls.indexOf('mint-raw'));assert.equal(calls.filter(x=>x==='population-full').length,1);
  const m=bundle.details!.advisory!.metrics.find(m=>m.id==='O21')!;assert.equal(m.quality,'KNOWN');assert.equal((m.data as any).approvedExposure.effectiveAtomic,'30');
  const proof=JSON.parse(bundle.rawArtifacts['advisory-derivation']!);assert.equal(Object.keys(proof.topology.artifactIds).length,0);assert.ok(m.evidenceIds.includes('rpc-holder-population'));
  // Proof v22 stores the canonical holder body as one exact holder-population-archive-v1 archive: same id, source, scope and clock; the stored hash is the container's and the original body is recoverable byte for byte.
  const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex'),holder=bundle.evidence.find(e=>e.id==='rpc-holder-population')!,stored=bundle.rawArtifacts['rpc-holder-population']!,container=JSON.parse(stored);
  assert.equal(proof.method,'advisory-provenance-v33');assert.equal(unpackHolderPopulation(stored),populationBody);
  assert.deepEqual([holder.sourceId,holder.sourceType,holder.accessMode,holder.adapterVersion,holder.scope,holder.retrievedAt,holder.availableAt,holder.contentHash],['solana-rpc','JSON_RPC','PUBLIC_API',HOLDER_ARCHIVE_ADAPTER,{operation:'rpc-holder-population',commitment:'finalized',mint:token.address,fullAccountData:true},at,at,sha(stored)]);
  assert.deepEqual([container.method,container.encoding,container.sourceBytes,container.sourceHash],['advisory-demand-rpc-archive-v1','DEFLATE_RAW_BASE64',Buffer.byteLength(populationBody),sha(populationBody)]);
  assert.deepEqual(bundle.evidence.filter(e=>e.adapterVersion===HOLDER_ARCHIVE_ADAPTER).map(e=>e.id),['rpc-holder-population']);
  const rebuild=(b:typeof bundle,p:unknown)=>reconstructAdvisory(token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,p,b.thesis??null,b.features);
  assert.equal(decisionHash(rebuild(bundle,proof)),decisionHash(bundle.details!.advisory));
  // Older proofs replay only the plain live-v1 holder receipt: the exact proof-v20 form rebuilds the identical O21, and the archive never satisfies an older proof.
  const {bundle:v20Bundle,proof:v20}=legacyWindowBundle(bundle);
  assert.equal(v20Bundle.rawArtifacts['rpc-holder-population'],populationBody);assert.equal(v20Bundle.evidence.find(e=>e.id==='rpc-holder-population')!.adapterVersion,'live-v1');
  assert.deepEqual(rebuild(v20Bundle,v20).metrics.find(x=>x.id==='O21'),m);
  for(const method of ['advisory-provenance-v20','advisory-provenance-v21'])assert.throws(()=>rebuild(bundle,{...proof,method}),{message:'ADVISORY_PROOF_INVALID'},method);
  // Proof v22 binds exactly one archived holder receipt: plain bodies, forged containers, foreign adapters, masquerading, duplicate, rawless or recordless receipts are rejected.
  const holderOf=(b:typeof bundle)=>b.evidence.find(e=>e.id==='rpc-holder-population')!;
  const variant=(change:(b:typeof bundle)=>void)=>{const b=structuredClone(bundle);change(b);return b;};
  const store=(b:typeof bundle,raw:string,adapterVersion:string=HOLDER_ARCHIVE_ADAPTER)=>{b.rawArtifacts['rpc-holder-population']=raw;Object.assign(holderOf(b),{contentHash:sha(raw),adapterVersion});};
  const tampered:Array<[string,typeof bundle,string]>=[
    ['plain-live-v1-body',variant(b=>store(b,populationBody,'live-v1')),'ADVISORY_PROOF_INVALID'],
    ['plain-body-under-archive-adapter',variant(b=>store(b,populationBody)),'ADVISORY_TOPOLOGY_HOLDER_ARCHIVE_INVALID'],
    ['forged-source-hash',variant(b=>store(b,JSON.stringify({...container,sourceHash:sha('forged')}))),'ADVISORY_TOPOLOGY_HOLDER_ARCHIVE_INVALID'],
    ['stored-hash-mismatch',variant(b=>{holderOf(b).contentHash=sha(populationBody);}),'ADVISORY_TOPOLOGY_RECEIPT_HASH'],
    ['foreign-archive-adapter',variant(b=>{holderOf(b).adapterVersion=DEMAND_ARCHIVE_ADAPTER;}),'ADVISORY_PROOF_INVALID'],
    ['masquerading-receipt',variant(b=>{b.evidence.find(e=>e.id==='rpc-mint-raw')!.adapterVersion=HOLDER_ARCHIVE_ADAPTER;}),'ADVISORY_PROOF_INVALID'],
    ['duplicate-receipt',variant(b=>{b.evidence.push(structuredClone(holderOf(b)));}),'ADVISORY_PROOF_INVALID'],
    ['missing-body',variant(b=>{delete b.rawArtifacts['rpc-holder-population'];}),'ADVISORY_PROOF_INVALID'],
    ['missing-record',variant(b=>{b.evidence=b.evidence.filter(e=>e.id!=='rpc-holder-population');}),'ADVISORY_PROOF_INVALID'],
  ];
  for(const [name,b,code] of tampered)assert.throws(()=>rebuild(b,proof),{message:code},name);
  const directory=mkdtempSync(join(tmpdir(),'advisory-topology-live-')),service=new Service(join(directory,'live.sqlite'));
  try{const saved=service.analyzeLive(bundle);assert.deepEqual(service.replay(saved.id),saved);const forged=structuredClone(bundle);(forged.details!.advisory!.metrics.find(m=>m.id==='O21')!.data as any).approvedExposure.effectiveAtomic='100';assert.throws(()=>service.analyzeLive(forged),/ADVISORY_PROOF/);assert.throws(()=>service.analyzeLive(tampered[0]![1]),/ADVISORY_PROOF_INVALID/);}finally{service.close();rmSync(directory,{recursive:true,force:true});}
});

test('creator-mode advisory recovers DEX discovery through the existing exact JSON fallback and produces the complete demand tape without Gemini',async()=>{
 const {complete}=await completeHourFetcher();let recoveryCalls=0,creatorCalls=0;
 const fixture:typeof fetch=async(input,init)=>{
  const url=String(input);
  if(url.includes('/token-pairs/'))return new Response('',{status:502});
  if(url==='https://api.fetch.tinyfish.ai/'){
   const q=JSON.parse(String(init?.body));
   assert.equal((init?.headers as Record<string,string>)['X-API-Key'],'recovery-key');
   if(q.format==='html'){
    recoveryCalls++;const target=q.urls[0],reply=await complete(target,{headers:{accept:'application/json'}}),raw=await reply.text();
    return new Response(JSON.stringify({results:[{url:target,final_url:target,format:'html',text:raw}],errors:[]}));
   }
   creatorCalls++;return new Response('',{status:404});
  }
  assert.ok(!url.includes('generativelanguage'),'Gemini must stay disabled');
  return complete(input,init);
 };
 const b=await collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,tinyfishKey:'recovery-key',fetcher:fixture,now:()=>at});
 assert.ok(recoveryCalls>=1&&creatorCalls===1);assert.ok(b.evidence.some(e=>e.id==='dex-pairs-fetch-selection'));
 assert.equal(b.details!.advisory!.metrics.find(m=>m.id==='A30')!.quality,'KNOWN');
 assert.ok(!JSON.stringify(b).includes('recovery-key'));
 const directory=mkdtempSync(join(tmpdir(),'creator-dex-recovery-'));
 try{const service=new Service(join(directory,'isolated.sqlite'));try{
  const saved=service.analyzeLive(b);assert.deepEqual(service.replay(saved.id),saved);
  const changed=structuredClone(b);changed.rawArtifacts['dex-pairs-fetch-response']=JSON.stringify({results:[],errors:[]});rehash(changed,'dex-pairs-fetch-response');
  assert.throws(()=>service.analyzeLive(changed),/DEX_RECOVERY_PROOF_INVALID|DEX_FETCH_SHAPE/);
 }finally{service.close();}}finally{rmSync(directory,{recursive:true,force:true});}
});
