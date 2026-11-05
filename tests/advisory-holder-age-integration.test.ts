import {assertEntryCliSnapshot} from './entry-cli-snapshot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {starterProfile} from '../src/app/config.js';
import {Service} from '../src/app/service.js';
import {runCli} from '../src/cli.js';
import {createHolderAgeFixture} from './holder-age-fixtures.js';
import {inventoryReturnsFixture} from './inventory-returns-fixtures.js';
import {bulkSha} from './synchrony-bulk-fixtures.js';
type Bundle=Awaited<ReturnType<typeof collectLiveToken>>;
const PREFIX='advisory-holder-age-';
const proof=(b:Bundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const metric=(b:Bundle,id='O22')=>b.details!.advisory!.metrics.find(m=>m.id===id)!;
const other=(b:Bundle)=>b.details!.advisory!.metrics.filter(m=>m.id!=='O22');
const collect=(f:ReturnType<typeof createHolderAgeFixture>,enabled=true)=>collectLiveToken(f.token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,...(enabled?{o22HolderAgeCapture:f.directory}:{o28RpcErrors:true}),fetcher:f.fetcher,now:()=>f.cutoff});
function stamp(b:Bundle,p:any){b.rawArtifacts['advisory-derivation']=JSON.stringify(p);b.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=bulkSha(b.rawArtifacts['advisory-derivation']!);}

test('proof57 reconstructs complete weighted historical O22 and preserves all49 other metrics on identical51 ordinary sources',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'holder-age-source-integration-'));try{
  for(const mode of ['mixed','claudecoin']as const){const f=createHolderAgeFixture(join(dir,mode),mode),old=await collect(f,false),b=await collect(f),p=proof(b),m=metric(b),d=m.data as any,expected=f.fixture.expected;
   assert.equal(p.method,'advisory-provenance-v57');assert.equal(b.details!.advisory!.method,'advisory-measurements-v56');assert.ok(p.holderAge);for(const absent of ['inventoryReturns','creatorInventoryBulk','creatorLifetimeBank','synchronyBulk'])assert.equal(p[absent],undefined);
   assert.equal(m.quality,'KNOWN');assert.equal(d.method,'holder-weighted-observed-reference-age-v2');assert.equal(d.complete,true);assert.equal(d.fraction,expected.fraction);assert.deepEqual(d.classificationCounts,{OLD_WITNESSED:expected.old,FRESH_UNDER_DECLARED_INDEX:expected.fresh,UNKNOWN:expected.unknown});assert.deepEqual(d.weightsAtomic,{old:expected.oldAtomic,fresh:expected.freshAtomic,unknown:expected.unknownAtomic,total:expected.totalAtomic});assert.equal(d.ownerProofs.length,expected.owners);
   if(mode==='mixed'){assert.match(f.fixture.originPopulationKind,/CONSTRUCTED/);assert.equal(f.context.mint.slot+1,f.context.bank.slot);const fallback=d.ownerProofs.find((p:any)=>p.heldAtomic==='500');assert.equal(fallback.classification,'OLD_WITNESSED');assert.equal(fallback.witnessKey,'OLDER:owner-4');assert.equal(f.context.first.get(4)!.value.data[0].blockTime,null,'a dated older witness resolves the inequality without imputing earliest time');}
   else{assert.match(f.fixture.originPopulationKind,/GENUINE_FULL115/);assert.equal(f.fixture.records.filter((r:any)=>r.kind==='FIRST').length,115);assert.equal(d.fraction,'0','all genuine owner weights have positive older witnesses');}
   assert.deepEqual(b.features,old.features);assert.deepEqual(b.details!.baseline,old.details!.baseline);assert.deepEqual(other(b),other(old));assert.deepEqual(reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,p,b.thesis??null,b.features),b.details!.advisory);
   const owned=b.evidence.filter(e=>e.id.startsWith(PREFIX));assert.equal(owned.length,2);for(const e of owned){assert.equal(e.sourceId,'advisory-holder-age');assert.equal(e.adapterVersion,'o22-holder-age-receipts-v1');assert.equal(e.accessMode,'USER_IMPORT');assert.equal(e.sourceType,'HISTORICAL_RECEIPT');assert.equal(e.retrievedAt,f.receipts.createdAt);assert.equal(e.availableAt,e.retrievedAt);assert.ok(e.scope.container);assert.equal(e.scope.request,undefined);}
   assert.ok(!f.calls.some(c=>c.method==='getTransactionsForAddress'),'retained holder history makes no new oldest-reference transport requests');
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('proof57 persists exact sources, idempotently reopens, and replays without a network through the CLI',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'holder-age-persist-'));try{const f=createHolderAgeFixture(join(dir,'capture')),b=await collect(f),file=join(dir,'live.sqlite');let saved;
  let s=new Service(file);try{saved=s.analyzeLive(b);assert.equal(s.analyzeLive(b).id,saved.id);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
  s=new Service(file);try{assert.deepEqual(s.show(saved.id),saved);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
  const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string).policyVersion,'research-screen-advisory-v54');}finally{db.close();}
  let out='',err='',reads=0;assert.equal(await runCli(['replay',saved.id,'--db',file,'--json'],{env:{},isInteractive:false,fetcher:async()=>{reads++;throw Error('NETWORK_DENIED');},stdout:x=>out+=x,stderr:x=>err+=x}),0,err);assert.equal(reads,0);assertEntryCliSnapshot(JSON.parse(out),saved);
  out='';err='';assert.equal(await runCli(['analyze',f.token.address,'--chain','solana','--partial','--advisory','--o28-expanded','--o22-holder-age-capture',f.directory,'--db',join(dir,'cli.sqlite'),'--config',join(dir,'config.json'),'--json'],{env:{},isInteractive:false,fetcher:f.fetcher,now:()=>f.cutoff,stdout:x=>out+=x,stderr:x=>err+=x}),0,err);assert.equal(JSON.parse(out).details.advisory.metrics.find((m:any)=>m.id==='O22').data.fraction,'0.6');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('O22 source authority and cached classifications cannot leak through versions, othermetrics or entry evidence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'holder-age-quarantine-'));try{const f=createHolderAgeFixture(join(dir,'capture')),original=await collect(f),s=new Service(join(dir,'live.sqlite'));
  try{const changes:Array<[string,(b:Bundle)=>void]>=[
   ['downgrade',b=>{const p=proof(b);p.method='advisory-provenance-v56';stamp(b,p);}],
   ['missing descriptor',b=>{const p=proof(b);delete p.holderAge;stamp(b,p);}],
   ['changed age threshold',b=>{const p=proof(b);p.holderAge.ageThresholdHours=48;stamp(b,p);}],
   ['cached fraction',b=>{(metric(b).data as any).fraction='1';}],
   ['cached roster',b=>{(metric(b).data as any).ownerProofs.pop();}],
   ['wrong adapter',b=>{b.evidence.find(e=>e.id.startsWith(PREFIX))!.adapterVersion='forged';}],
   ['wrong source',b=>{b.evidence.find(e=>e.id.startsWith(PREFIX))!.sourceId='advisory-inventory-returns';}],
   ['fake RPC container scope',b=>{b.evidence.find(e=>e.id.startsWith(PREFIX))!.scope={request:{method:'getTransactionsForAddress',params:[]}};}],
   ['grafted outer clock',b=>{b.evidence.find(e=>e.id.startsWith(PREFIX))!.retrievedAt=f.fixture.header.origin.cutoff;}],
   ['changed source bytes',b=>{const id=b.evidence.find(e=>e.id.startsWith(PREFIX))!.id;b.rawArtifacts[id]+=' ';}],
   ['orphan source',b=>{const e=structuredClone(b.evidence.find(e=>e.id.startsWith(PREFIX))!);e.id=PREFIX+'orphan';b.evidence.push(e);b.rawArtifacts[e.id]=b.rawArtifacts[PREFIX+'manifest']!;}],
   ['entry feature',b=>{b.features[0]!.evidenceIds.push(PREFIX+'manifest');}],
   ['baseline',b=>{b.details!.baseline[0]!.evidenceIds.push(PREFIX+'manifest');}],
   ...other(original).map(m=>[m.id,(b:Bundle)=>{metric(b,m.id).evidenceIds.push(PREFIX+'manifest');}]as [string,(b:Bundle)=>void]),
  ];for(const[label,change]of changes){const b=structuredClone(original);change(b);assert.throws(()=>s.analyzeLive(b),/ADVISORY_PROOF_INVALID|ADVISORY_HOLDER_AGE_|O22_HOLDER_|HOLDER_AGE_|ARTIFACT_HASH_OR_SIZE|EVIDENCE|INVALID_ASSESSMENT_DETAILS/,label);}}
  finally{s.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('O22 historical mode refuses incompatible flags before any network or import file read',async()=>{
 let reads=0;const fetcher:typeof fetch=async()=>{reads++;throw Error('NETWORK_DENIED');},token={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'},base={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,o22HolderAgeCapture:'/absent-holder-age-capture',fetcher};
 for(const o of [{...base,advisoryEnabled:false},{...base,o28Expanded:false},{...base,semanticEnabled:true},{...base,o26AccountCapture:'absent'},{...base,o25LifetimeCapture:'absent'},{...base,o24InventoryCapture:'absent'},{...base,o23BulkCapture:'absent'},{...base,o29ReservePath:true},{...base,o30RegistryAbsence:true},{...base,historicalTopicReuse:true}])await assert.rejects(collectLiveToken(token,o),/O22_HOLDER_AGE_REQUIRED/);
 for(const args of [['analyze','--bundle','absent','--o22-holder-age-capture','absent'],['analyze',token.address,'--partial','--advisory','--o22-holder-age-capture','absent'],['analyze',token.address,'--advisory','--o28-expanded','--o22-holder-age-capture','absent'],['analyze','0x1111111111111111111111111111111111111111','--chain','bsc','--partial','--advisory','--o28-expanded','--o22-holder-age-capture','absent']]){let err='';assert.equal(await runCli(args,{env:{},isInteractive:false,fetcher,stdout:()=>{},stderr:x=>err+=x}),2);assert.match(err,/O22_HOLDER_AGE_REQUIRED/);}assert.equal(reads,0);
});

test('documented57 CLI flags enable inherited named-error collection and preserve other49 metrics without an extra flag',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'holder-age-named-errors-'));try{const f=createHolderAgeFixture(join(dir,'capture')),w=inventoryReturnsFixture(),pool=w.header.pool,bank=JSON.parse(w.records.find((r:any)=>r.kind==='WINDOW'&&r.id==='window-pool').raw).result,anchor=JSON.parse(w.records.find((r:any)=>r.kind==='WINDOW'&&r.id==='window-anchor-slot').raw).result,end=Math.floor(Date.parse(f.cutoff)/3_600_000)*3600;
  // Only this ordinary all-failed-hour transport is constructed; the retained holder-age sources stay exact.
  const signatures=w.records.filter((r:any)=>r.kind==='WINDOW'&&r.request.method==='getTransaction').map((r:any)=>r.request.params[0]),rows=signatures.map((signature:string,i:number)=>({signature,slot:anchor-i-1,blockTime:end-(i===2?5400:1800),err:i===0?'MaxLoadedAccountsDataSizeExceeded':i===1?'BlockhashNotFound':null,confirmationStatus:'finalized'})),calls:Array<{method:string;params:any[]}>=[];
  const fetcher:typeof fetch=async(input,init)=>{if(init?.method!=='POST'){const raw=await(await f.fetcher(input,init)).text();return new Response(raw.replaceAll('4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E',pool));}const q=JSON.parse(String(init.body));calls.push(q);let result:any;
   if(q.method==='getSlot')result=anchor;else if(q.method==='getBlockTime')result=end;else if(q.method==='getSignaturesForAddress'&&q.params[1]?.limit===1000)result=rows;else if(q.method==='getAccountInfo'&&q.params[0]===pool)result={context:bank.context,value:bank.value[0]};else if(q.method==='getMultipleAccounts'&&q.params[0][0]===pool&&q.params[0].length===2)result=bank;else return f.fetcher(input,init);return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result}));};
  const options={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,fetcher,now:()=>f.cutoff},old=await collectLiveToken(f.token,{...options,o28RpcErrors:true}),b=await collectLiveToken(f.token,{...options,o22HolderAgeCapture:f.directory});assert.equal(metric(b).quality,'KNOWN');assert.equal(metric(b,'O28').quality,'KNOWN');assert.equal((metric(b,'O28').data as any).failedReferences,2);assert.deepEqual(other(b),other(old));assert.ok(calls.some(q=>q.method==='getMultipleAccounts'&&q.params[0][0]===pool));assert.ok(!calls.some(q=>q.method==='getTransaction'&&signatures.slice(0,2).includes(q.params[0])));
  let out='',err='';assert.equal(await runCli(['analyze',f.token.address,'--chain','solana','--partial','--advisory','--o28-expanded','--o22-holder-age-capture',f.directory,'--db',join(dir,'cli.sqlite'),'--config',join(dir,'config.json'),'--json'],{env:{},isInteractive:false,fetcher,now:()=>f.cutoff,stdout:x=>out+=x,stderr:x=>err+=x}),0,err);assert.equal(JSON.parse(out).details.advisory.metrics.find((m:any)=>m.id==='O28').quality,'KNOWN');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
