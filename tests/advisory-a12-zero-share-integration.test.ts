import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {starterProfile} from '../src/app/config.js';
import {Service} from '../src/app/service.js';
import {runCli} from '../src/cli.js';
import {a12ZeroShareFixture,a12ZeroShareHash} from './a12-zero-share-fixtures.js';
import {inventoryReturnsFixture} from './inventory-returns-fixtures.js';
type Bundle=Awaited<ReturnType<typeof collectLiveToken>>;
const proof=(b:Bundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const metric=(b:Bundle,id='A12')=>b.details!.advisory!.metrics.find(m=>m.id===id)!;
const other=(b:Bundle)=>b.details!.advisory!.metrics.filter(m=>m.id!=='A12');
const collect=(f:ReturnType<typeof a12ZeroShareFixture>,enabled=true)=>collectLiveToken(f.token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,a12CandidateSet:f.packet,...(enabled?{a12ZeroShare:true}:{a12ZeroShare:false,o28RpcErrors:true}),fetcher:f.fetcher,now:()=>f.cutoff});
function stamp(b:Bundle,p:any){b.rawArtifacts['advisory-derivation']=JSON.stringify(p);b.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=a12ZeroShareHash(b.rawArtifacts['advisory-derivation']!);}

test('constructed five-member proof58 derives exact zero from genuine account preimages and preserves51 other49/default facts',async()=>{
 const f=a12ZeroShareFixture(),old=await collect(a12ZeroShareFixture(),false),b=await collect(f),p=proof(b),d=metric(b).data as any;
 assert.equal(p.method,'advisory-provenance-v58');assert.equal(b.details!.advisory!.method,'advisory-measurements-v57');assert.equal(proof(old).method,'advisory-provenance-v51');assert.equal(metric(old).reasonCode,'EXIT_CAPACITY_MIXED_QUOTE_UNRESOLVED');
 assert.equal(p.exitCapacity.comparisonMode,'zero-target-positive-reference-invariant-v1');assert.equal(metric(b).quality,'KNOWN');assert.equal(d.method,'impact-bounded-zero-target-capacity-share-v3');assert.equal(d.share,'0');assert.equal(d.denominatorAtomic,null);assert.equal(d.quoteMint,null);assert.equal(d.quoteDecimals,null);assert.equal(d.comparison.denominatorStatus,'POSITIVE_UNVALUED');assert.equal(d.comparison.normalization,'NOT_PERFORMED');assert.equal(d.candidates.length,5);assert.ok(d.candidates.every((c:any)=>c.status==='KNOWN'));assert.ok(d.candidates.filter((c:any)=>BigInt(c.capacityAtomic)>0n).every((c:any)=>c.share===null));assert.equal(d.comparison.positiveCapacityWitnesses.length,2);
 assert.deepEqual(b.features,old.features);assert.deepEqual(b.details!.baseline,old.details!.baseline);assert.deepEqual(other(b),other(old));assert.deepEqual(reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,p,b.thesis??null,b.features),b.details!.advisory);
 assert.equal(f.projections.length,2);for(const projected of f.projections){const original=f.capture.records.find((r:any)=>r.id===projected.kind),native=JSON.parse(original.raw).result,constructed=JSON.parse(projected.raw).result;assert.deepEqual(constructed.context,native.context);assert.notEqual(projected.raw,original.raw,'request-sized test envelopes are explicitly constructed, not original RPC bytes');for(const[key,i]of (projected.request as any).params[0].map((key:string,i:number)=>[key,i]))assert.deepEqual(constructed.value[i],native.value[original.request.params[0].indexOf(key)]);assert.equal(a12ZeroShareHash(original.raw),original.sourceHash);}
 const set=b.evidence.find(e=>e.id==='a12-reviewed-candidate-set')!;assert.equal(set.accessMode,'USER_IMPORT');assert.equal(set.sourceType,'REVIEWED_CORPUS');for(const e of b.evidence.filter(e=>e.sourceId==='advisory-exitCapacity')){assert.equal(e.accessMode,'PUBLIC_API');assert.equal(e.adapterVersion,'live-v1');assert.equal(Object.keys(e.scope).join(),'request');}
 for(const key of ['holderAge','inventoryReturns','creatorInventoryBulk','creatorLifetimeBank','synchronyBulk'])assert.equal(p[key],undefined);
});

test('constructed all-six catalog retains the actual NULL Dwbz route as whole MISSING rather than zero capacity',async()=>{
 const b=await collect(a12ZeroShareFixture(true)),m=metric(b),d=m.data as any;assert.notEqual(m.quality,'KNOWN');assert.equal(d.share,null);assert.equal(d.denominatorAtomic,null);assert.equal(d.candidates.length,6);const absent=d.candidates.find((c:any)=>c.token.address==='DwbzUqrJGdQZQNCBfwD1Y3Tmp8wtzhJ19J2yiSsapump');assert.notEqual(absent.status,'KNOWN');assert.equal(absent.capacityAtomic,null);
});

test('proof58 source reconstruction persists, is idempotent, reopens and replays through network-denied CLI',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a12-zero-share-'));try{const f=a12ZeroShareFixture(),b=await collect(f),file=join(dir,'live.sqlite');let saved;let s=new Service(file);
  try{saved=s.analyzeLive(b);assert.equal(s.analyzeLive(b).id,saved.id);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
  s=new Service(file);try{assert.deepEqual(s.show(saved.id),saved);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
  const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string).policyVersion,'research-screen-advisory-v55');}finally{db.close();}
  let out='',err='',reads=0;assert.equal(await runCli(['replay',saved.id,'--db',file,'--json'],{env:{},isInteractive:false,fetcher:async()=>{reads++;throw Error('NETWORK_DENIED');},stdout:x=>out+=x,stderr:x=>err+=x}),0,err);assert.equal(reads,0);assert.deepEqual(JSON.parse(out),saved);
  const packet=join(dir,'constructed-packet.json');writeFileSync(packet,JSON.stringify(f.packet));out='';err='';assert.equal(await runCli(['analyze',f.token.address,'--chain','solana','--partial','--advisory','--o28-expanded','--a12-candidates',packet,'--a12-zero-share','--db',join(dir,'cli.sqlite'),'--config',join(dir,'config.json'),'--json'],{env:{},isInteractive:false,fetcher:f.fetcher,now:()=>f.cutoff,stdout:x=>out+=x,stderr:x=>err+=x}),0,err);assert.equal(JSON.parse(out).details.advisory.metrics.find((m:any)=>m.id==='A12').data.share,'0');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('proof58 rejects cached scalar, descriptor downgrade, source purpose, impact and entry-feature tampering',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a12-zero-tamper-'));try{const b=await collect(a12ZeroShareFixture()),s=new Service(join(dir,'live.sqlite'));try{
  const changes:Array<[string,(b:Bundle)=>void]>=[
   ['missing descriptor',b=>{const p=proof(b);delete p.exitCapacity;stamp(b,p);}],
   ['missing comparison mode',b=>{const p=proof(b);delete p.exitCapacity.comparisonMode;stamp(b,p);}],
   ['old version retains mode',b=>{const p=proof(b);p.method='advisory-provenance-v51';stamp(b,p);}],
   ['downgrade and strip mode',b=>{const p=proof(b);p.method='advisory-provenance-v51';delete p.exitCapacity.comparisonMode;stamp(b,p);}],
   ['cached share',b=>{(metric(b).data as any).share='1';}],
   ['cached denominator',b=>{(metric(b).data as any).denominatorAtomic='1';}],
   ['impact',b=>{const p=proof(b);p.exitCapacity.impactBps='301';stamp(b,p);}],
   ['candidate purpose',b=>{b.evidence.find(e=>e.id==='a12-reviewed-candidate-set')!.sourceType='HISTORICAL_RECEIPT';}],
   ['native source purpose',b=>{b.evidence.find(e=>e.sourceId==='advisory-exitCapacity')!.sourceId='advisory-chain';}],
   ['raw native bytes',b=>{const id=b.evidence.find(e=>e.sourceId==='advisory-exitCapacity')!.id;b.rawArtifacts[id]+=' ';}],
   ['entry feature',b=>{b.features[0]!.evidenceIds.push('a12-reviewed-candidate-set');}],
   ['baseline',b=>{b.details!.baseline[0]!.evidenceIds.push('a12-reviewed-candidate-set');}],
   ['foreign metric purpose',b=>{metric(b,'O28').evidenceIds.push('a12-reviewed-candidate-set');}],
  ];for(const[label,change]of changes){const tampered=structuredClone(b);change(tampered);assert.throws(()=>s.analyzeLive(tampered),/ADVISORY_PROOF_INVALID|ADVISORY_EXIT_CAPACITY_|ARTIFACT_HASH_OR_SIZE|EVIDENCE|INVALID_ASSESSMENT_DETAILS/,label);}
 }finally{s.close();}}finally{rmSync(dir,{recursive:true,force:true});}
});

test('documented A12 mode rejects incompatible options and malformed CLI combinations before I/O',async()=>{
 const f=a12ZeroShareFixture();let reads=0;const fetcher:typeof fetch=async()=>{reads++;throw Error('NETWORK_DENIED');},base={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,a12CandidateSet:f.packet,a12ZeroShare:true,fetcher};
 for(const o of [{...base,semanticEnabled:true},{...base,advisoryEnabled:false},{...base,o28Expanded:false},{...base,a12CandidateSet:undefined},{...base,o22HolderAgeCapture:'absent'},{...base,o26AccountCapture:'absent'},{...base,o25LifetimeCapture:'absent'},{...base,o24InventoryCapture:'absent'},{...base,o23BulkCapture:'absent'},{...base,o29ReservePath:true},{...base,o30RegistryAbsence:true},{...base,historicalTopicReuse:true}])await assert.rejects(collectLiveToken(f.token,o),/A12_ZERO_SHARE_REQUIRED/);
 await assert.rejects(collectLiveToken({chain:'bsc',address:'0x1111111111111111111111111111111111111111'},base),/A12_ZERO_SHARE_REQUIRED/);
 for(const args of [['analyze','--bundle','absent','--a12-zero-share'],['analyze',f.token.address,'--partial','--advisory','--a12-zero-share'],['analyze',f.token.address,'--advisory','--o28-expanded','--a12-candidates','absent','--a12-zero-share'],['analyze',f.token.address,'--partial','--advisory','--o28-expanded','--a12-zero-share']]){let err='';assert.equal(await runCli(args,{env:{},isInteractive:false,fetcher,stdout:()=>{},stderr:x=>err+=x}),2);assert.match(err,/A12_ZERO_SHARE_REQUIRED/);}assert.equal(reads,0);
});

test('documented58 mode enables inherited named-error collection without an extra flag',async()=>{
 const f=a12ZeroShareFixture(),w=inventoryReturnsFixture(),pool=w.header.pool,bank=JSON.parse(w.records.find((r:any)=>r.kind==='WINDOW'&&r.id==='window-pool').raw).result,anchor=JSON.parse(w.records.find((r:any)=>r.kind==='WINDOW'&&r.id==='window-anchor-slot').raw).result,end=Math.floor(Date.parse(f.cutoff)/3_600_000)*3600;
 const signatures=w.records.filter((r:any)=>r.kind==='WINDOW'&&r.request.method==='getTransaction').map((r:any)=>r.request.params[0]),rows=signatures.map((signature:string,i:number)=>({signature,slot:anchor-i-1,blockTime:end-(i===2?5400:1800),err:i===0?'MaxLoadedAccountsDataSizeExceeded':i===1?'BlockhashNotFound':null,confirmationStatus:'finalized'}));
 // Explicitly constructed all-failed current-hour index; native capacity preimages remain exact.
 const fetcher:typeof fetch=async(input,init)=>{if(init?.method!=='POST'){const raw=await(await f.fetcher(input,init)).text();return new Response(raw.replaceAll('4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E',pool));}const q=JSON.parse(String(init.body));let result:any;if(q.method==='getSlot')result=anchor;else if(q.method==='getBlockTime')result=end;else if(q.method==='getSignaturesForAddress'&&q.params[1]?.limit===1000)result=rows;else if(q.method==='getAccountInfo'&&q.params[0]===pool)result={context:bank.context,value:bank.value[0]};else if(q.method==='getMultipleAccounts'&&q.params[0][0]===pool&&q.params[0].length===2)result=bank;else return f.fetcher(input,init);return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result}));};
 const options={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,a12CandidateSet:f.packet,fetcher,now:()=>f.cutoff},old=await collectLiveToken(f.token,{...options,o28RpcErrors:true}),b=await collectLiveToken(f.token,{...options,a12ZeroShare:true});assert.equal(metric(b).quality,'KNOWN');assert.equal(metric(b,'O28').quality,'KNOWN');assert.equal((metric(b,'O28').data as any).failedReferences,2);assert.deepEqual(other(b),other(old));
});
