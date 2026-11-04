import {assertEntryCliSnapshot} from './entry-cli-snapshot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {starterProfile} from '../src/app/config.js';
import {Service} from '../src/app/service.js';
import {runCli} from '../src/cli.js';
import {loadO25LifetimeCapture,decodeO25LifetimePool} from '../src/providers/advisory-creator-lifetime-import.js';
import {createO25LifetimeCapture} from './creator-lifetime-bulk-fixtures.js';
import {bulkSha} from './synchrony-bulk-fixtures.js';
type Bundle=Awaited<ReturnType<typeof collectLiveToken>>;
const BANK='advisory-creator-lifetime-',INV='advisory-creator-inventory-bulk-';
const proof=(b:Bundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const metric=(b:Bundle,id='O25')=>b.details!.advisory!.metrics.find(m=>m.id===id)!;
function stamp(b:Bundle,p:any){b.rawArtifacts['advisory-derivation']=JSON.stringify(p);b.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=bulkSha(b.rawArtifacts['advisory-derivation']!);}
const collect=(f:ReturnType<typeof createO25LifetimeCapture>,lifetime=true)=>collectLiveToken(f.token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,o28RpcErrors:true,...(lifetime?{o25LifetimeCapture:f.directory}:{o24InventoryCapture:join(f.directory,'inventory')}),fetcher:f.fetcher,now:()=>f.cutoff});

test('proof55 derives the complete empty-held lifetime vector and changes only O25 versus identical54 sources',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o25-lifetime-integration-'));try{
  const f=createO25LifetimeCapture(join(dir,'capture')),loaded=loadO25LifetimeCapture(f.directory,f.token,f.cutoff);assert.deepEqual(loaded.inventory,f.source);assert.deepEqual(loaded.bank,f.bank);
  const bank=decodeO25LifetimePool(loaded.bank,f.token,f.source.stateSlot,f.cutoff);assert.equal(bank.poolKey,f.poolContext.poolKey);assert.equal(bank.quote.mint,'3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh');assert.equal(bank.quote.decimals,8);
  const previous=await collect(f,false),current=await collect(f),p=proof(current),m=metric(current),d=m.data as any;
  assert.equal(proof(previous).method,'advisory-provenance-v54');assert.equal(p.method,'advisory-provenance-v55');assert.equal(current.details!.advisory!.method,'advisory-measurements-v54');assert.ok(p.creatorInventoryBulk);assert.ok(p.creatorLifetimeBank);assert.equal(p.synchronyBulk,undefined);
  assert.equal(m.quality,'KNOWN');assert.equal(m.reasonCode,'CREATOR_LIFETIME_FULL_VECTOR_OBSERVED');assert.equal(d.method,'creator-lifetime-full-vector-empty-held-v2');assert.equal(d.status,'COMPLETE');assert.equal(d.profile,'EMPTY_HELD');
  assert.equal(d.holdings.heldAtomic,'0');assert.equal(d.holdings.openLots,0);assert.equal(d.holdings.unknownCostAtomic,'0');assert.equal(d.holdings.shareDenominator,'UNDEFINED_ZERO_HELD');
  for(const b of [...d.holdings.ageBands,...d.holdings.costBands]){assert.equal(b.atomic,'0');assert.equal(b.shareOfHeld,null);}
  assert.equal(d.realized.acquiredAtomic,'339149663879364');assert.equal(d.realized.disposedThroughSalesAtomic,'109149663879364');assert.equal(d.realized.transferredOutAtomic,'230000000000000');assert.notEqual(d.realized.fraction,'1');assert.equal(d.realized.denominatorStatus,'ALL_ACQUIRED_TARGET_ATOMIC');
  assert.equal(d.ledger.length,222);assert.equal(d.currentSells.sells,0);assert.equal(d.currentSells.unitsAtomic,'0');assert.equal(d.currentSells.coreQuoteAtomic,null);assert.equal(d.currentSells.userQuoteAtomic,null);
  assert.deepEqual(current.features,previous.features);assert.deepEqual(current.details!.baseline,previous.details!.baseline);assert.deepEqual(current.details!.advisory!.metrics.filter(m=>m.id!=='O25'),previous.details!.advisory!.metrics.filter(m=>m.id!=='O25'));
  const ordinary=(b:Bundle)=>Object.fromEntries(Object.entries(b.rawArtifacts).filter(([id])=>id!=='advisory-derivation'&&!id.startsWith(BANK)));assert.deepEqual(ordinary(current),ordinary(previous));
  assert.deepEqual(reconstructAdvisory(current.token,current.cutoff,current.details!.baseline,current.evidence,current.rawArtifacts,p,current.thesis??null,current.features),current.details!.advisory);
  const e=current.evidence.find(e=>e.id===BANK+'pool')!;assert.equal(e.sourceId,'advisory-creator-lifetime');assert.equal(e.adapterVersion,'o25-lifetime-bank-v1');assert.equal(e.accessMode,'USER_IMPORT');assert.equal(e.contentHash,bulkSha(f.bank.rawArtifacts.pool!));
  assert.ok(!f.calls.some(c=>c.method==='getTransactionsForAddress'),'retained import does not issue new wallet transport calls');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('proof55 persists idempotently and reopens/replays through network-denied CLI',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o25-lifetime-persist-'));try{const f=createO25LifetimeCapture(join(dir,'capture')),b=await collect(f),file=join(dir,'live.sqlite');let saved;
  let service=new Service(file);try{saved=service.analyzeLive(b);assert.equal(service.analyzeLive(b).id,saved.id);assert.deepEqual(service.replay(saved.id),saved);}finally{service.close();}
  service=new Service(file);try{assert.deepEqual(service.show(saved.id),saved);assert.deepEqual(service.replay(saved.id),saved);}finally{service.close();}
  const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string).policyVersion,'research-screen-advisory-v52');}finally{db.close();}
  let out='',error='',reads=0;assert.equal(await runCli(['replay',saved.id,'--db',file,'--json'],{env:{},isInteractive:false,fetcher:async()=>{reads++;throw Error('NETWORK_DENIED');},stdout:s=>out+=s,stderr:s=>error+=s}),0,error);assert.equal(reads,0);assertEntryCliSnapshot(JSON.parse(out),saved);
  out='';error='';assert.equal(await runCli(['analyze',f.token.address,'--chain','solana','--partial','--advisory','--o28-expanded','--o25-lifetime-capture',f.directory,'--db',join(dir,'cli.sqlite'),'--config',join(dir,'config.json'),'--json'],{env:{},isInteractive:false,fetcher:f.fetcher,now:()=>f.cutoff,stdout:s=>out+=s,stderr:s=>error+=s}),0,error);const cli=JSON.parse(out);assert.equal(cli.details.advisory.method,'advisory-measurements-v54');assert.equal(cli.details.advisory.metrics.find((m:any)=>m.id==='O25').quality,'KNOWN');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('lifetime bank and inventory authority cannot escape their explicit55 purposes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o25-lifetime-ownership-'));try{const f=createO25LifetimeCapture(join(dir,'capture')),original=await collect(f),s=new Service(join(dir,'live.sqlite'));
  const mutations:Array<[string,(b:Bundle)=>void]>=[
   ['proof downgrade',(b)=>{const p=proof(b);p.method='advisory-provenance-v54';stamp(b,p);}],
   ['missing bank descriptor',(b)=>{const p=proof(b);delete p.creatorLifetimeBank;stamp(b,p);}],
   ['missing inventory descriptor',(b)=>{const p=proof(b);delete p.creatorInventoryBulk;stamp(b,p);}],
   ['bank context request',(b)=>{const p=proof(b);p.creatorLifetimeBank.requests.pool.params[1].minContextSlot--;stamp(b,p);}],
   ['cached realized fraction',(b)=>{(metric(b).data as any).realized.fraction='1';}],
   ['bank adapter',(b)=>{const e=b.evidence.find(e=>e.id===BANK+'pool')!;e.adapterVersion='forged';}],
   ['bank source laundering',(b)=>{const e=b.evidence.find(e=>e.id===BANK+'pool')!;e.sourceId='advisory-creator-inventory-bulk';}],
   ['bank access mode',(b)=>{const e=b.evidence.find(e=>e.id===BANK+'pool')!;e.accessMode='PUBLIC_API';}],
   ['future bank availability',(b)=>{const e=b.evidence.find(e=>e.id===BANK+'pool')!;e.availableAt='2026-10-29T18:00:01.000Z';}],
   ['bank raw hash',(b)=>{b.rawArtifacts[BANK+'pool']+=' ';}],
   ['orphan bank source',(b)=>{const e=structuredClone(b.evidence.find(e=>e.id===BANK+'pool')!);e.id=BANK+'orphan';e.contentHash=bulkSha('{}');b.evidence.push(e);b.rawArtifacts[e.id]='{}';}],
   ['feature bank citation',(b)=>{b.features[0]!.evidenceIds.push(BANK+'pool');}],
   ['baseline bank citation',(b)=>{b.details!.baseline[0]!.evidenceIds.push(BANK+'pool');}],
   ...['O24','S13','S15','O23','O29'].map(id=>[`bank citation in ${id}`,(b:Bundle)=>{metric(b,id).evidenceIds.push(BANK+'pool');}] as [string,(b:Bundle)=>void]),
   ...['S13','S15','O23','O29'].map(id=>[`inventory citation in ${id}`,(b:Bundle)=>{metric(b,id).evidenceIds.push(b.evidence.find(e=>e.id.startsWith(INV))!.id);}] as [string,(b:Bundle)=>void]),
  ];
  try{for(const [label,mutate]of mutations){const b=structuredClone(original);mutate(b);const expected=label==='bank access mode'?/LIVE_PROVENANCE_INVALID/:/ADVISORY_PROOF_INVALID|ARTIFACT_HASH_OR_SIZE|EVIDENCE|ADVISORY_CREATOR_INVENTORY_BULK_STORAGE_(?:RECORD|MEMBERSHIP)/;assert.throws(()=>s.analyzeLive(b),expected,label);}}
  finally{s.close();}
  const old=await collect(f,false);metric(old).evidenceIds.push(old.evidence.find(e=>e.id.startsWith(INV))!.id);const legacy=new Service(join(dir,'legacy.sqlite'));try{assert.throws(()=>legacy.analyzeLive(old),/ADVISORY_PROOF_INVALID/,'54 retains O24-only inventory authority');}finally{legacy.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('strict lifetime package rejects file/hash/request/state/quote forgery before financial derivation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'o25-lifetime-import-'));try{const f=createO25LifetimeCapture(join(dir,'capture')),mfile=join(f.directory,'capture.json'),original=readFileSync(mfile,'utf8');
  for(const mutate of [(m:any)=>{m.file='../pool.json';},(m:any)=>{m.quoteMint=f.token.address;},(m:any)=>{m.request.params[1].minContextSlot--;},(m:any)=>{m.retrievedAt='2026-10-29T18:00:01.000Z';},(m:any)=>{m.sourceHash='0'.repeat(64);}]){const m=JSON.parse(original);mutate(m);writeFileSync(mfile,JSON.stringify(m));assert.throws(()=>loadO25LifetimeCapture(f.directory,f.token,f.cutoff),/ADVISORY_CREATOR_LIFETIME_/);}writeFileSync(mfile,original);
  const bank=structuredClone(f.bank),raw=JSON.parse(bank.rawArtifacts.pool!);raw.result.context.slot=f.source.stateSlot-1;bank.rawArtifacts.pool=JSON.stringify(raw);assert.throws(()=>decodeO25LifetimePool(bank,f.token,f.source.stateSlot,f.cutoff),/ADVISORY_CREATOR_LIFETIME_BANK_SHAPE/);
  writeFileSync(join(f.directory,'foreign.json'),'{}');assert.throws(()=>loadO25LifetimeCapture(f.directory,f.token,f.cutoff),/ADVISORY_CREATOR_LIFETIME_/);rmSync(join(f.directory,'foreign.json'));
  const path=join(f.directory,'pool.json'),bytes=readFileSync(path),outside=join(dir,'outside.json');writeFileSync(outside,bytes);rmSync(path);symlinkSync(outside,path);assert.throws(()=>loadO25LifetimeCapture(f.directory,f.token,f.cutoff),/ADVISORY_CREATOR_LIFETIME_/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('lifetime mode requires live Solana expanded advisory and excludes other explicit imports',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o25-lifetime-modes-'));try{const f=createO25LifetimeCapture(join(dir,'capture'));let reads=0;const fetcher:typeof fetch=async()=>{reads++;throw Error('NETWORK_DENIED');},base={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,o25LifetimeCapture:f.directory,fetcher};
  for(const options of [{...base,advisoryEnabled:false},{...base,o28Expanded:false},{...base,o24InventoryCapture:join(f.directory,'inventory')},{...base,o23BulkCapture:f.directory},{...base,o29ReservePath:true},{...base,o30RegistryAbsence:true},{...base,historicalTopicReuse:true}])await assert.rejects(collectLiveToken(f.token,options),/O25_LIFETIME_REQUIRED/);
  for(const args of [['analyze','--bundle','absent','--o25-lifetime-capture',f.directory],['analyze',f.token.address,'--partial','--advisory','--o25-lifetime-capture',f.directory],['analyze','0x1111111111111111111111111111111111111111','--chain','bsc','--partial','--advisory','--o28-expanded','--o25-lifetime-capture',f.directory]]){let error='';assert.equal(await runCli(args,{env:{},isInteractive:false,fetcher,stdout:()=>{},stderr:s=>error+=s}),2);assert.match(error,/O25_LIFETIME_REQUIRED/);}assert.equal(reads,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
