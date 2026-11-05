import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {collectLiveToken} from '../src/app/live.js';
import {starterProfile,starterConfig} from '../src/app/config.js';
import {runCli} from '../src/cli.js';
import {validateA28DecayBundle,validateA28DecayCore,a28DecayDescriptor,a28DecayDescriptorSchema} from '../src/app/a28-decay.js';
import {A28_SOURCE_ID,A28_SOURCE_PREFIX,A28_CAPTURE_ID,A28_ADAPTER,A28_PURPOSE,loadA28DecayCapture,validateA28DecaySource,a28Owns} from '../src/providers/advisory-a28-decay-source.js';
import {A28_SUBJECT} from '../src/providers/advisory-a28-decay-study.js';
import {S20_ADAPTER,S20_PURPOSE} from '../src/providers/advisory-s20-structural.js';
import {s20StructuralDescriptor} from '../src/app/s20-structural.js';
import {Service} from '../src/app/service.js';
import {advisoryProofSchema} from '../src/app/advisory.js';
import {advisoryFactsSchema,advisoryGroups} from '../src/domain/advisory-contracts.js';
import type {EvidenceRecord,LiveBundle,EntrySnapshot,TokenRef} from '../src/domain/contracts.js';
import {a29LiveFetcher} from './a29-fixtures.js';

const token:TokenRef={chain:'solana',address:A28_SUBJECT.address};
// Genuine Parasite is outside the fixed C5 source study: full source validation must precede MISSING.
const control:TokenRef={chain:'solana',address:'3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'};
const cutoff='2026-11-10T00:00:00.000Z';
// Root's frozen source-sufficiency expectation for the genuine selected study; no component value of the genuine source is asserted here.
const GENUINE_EXPECTED_QUALITY='KNOWN';
// The genuine portable A28 file is created from retained native source and read byte for byte; this suite never constructs or rewrites it. The surrounding
// ordinary bundle comes from the labelled offline a29 fixture reads and is never presented as genuine provider data.
const FIXTURE='tests/fixtures/a28-native-decay.json.gz';
let fixture:Buffer|undefined;
const portable=()=>fixture??=gunzipSync(readFileSync(FIXTURE));
const sha=(raw:string)=>createHash('sha256').update(raw,'utf8').digest('hex');
type Wire={id:string;raw:string;scope:Record<string,unknown>;retrievedAt:string};
const recordsOf=(file:string,t:TokenRef=token):Wire[]=>loadA28DecayCapture(file,t,cutoff).records.map(r=>({id:r.id,raw:r.raw,scope:r.scope,retrievedAt:r.retrievedAt}));
let sharedDir:string|undefined;
/** One shared on-disk copy of the genuine portable bytes for synchronous loader calls; removed at exit. */
function captureFile(){if(!sharedDir){const dir=mkdtempSync(join(tmpdir(),'a28-integration-shared-'));sharedDir=dir;writeFileSync(join(dir,'capture.json'),portable());process.on('exit',()=>rmSync(dir,{recursive:true,force:true}));}return join(sharedDir,'capture.json');}
function withCapture<T>(run:(file:string,dir:string)=>Promise<T>):Promise<T>{const dir=mkdtempSync(join(tmpdir(),'a28-integration-'));const done=()=>rmSync(dir,{recursive:true,force:true});try{const file=join(dir,'capture.json');writeFileSync(file,portable());return run(file,dir).finally(done);}catch(error){done();throw error;}}
const ordinaryRun=(t:TokenRef=token,extra:Record<string,unknown>={})=>collectLiveToken(t,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,now:()=>cutoff,fetcher:a29LiveFetcher(t.address,cutoff),...extra});
async function cliRun(args:string[]){const out:string[]=[],err:string[]=[];let reads=0;const fixtureFetch=a29LiveFetcher(token.address,cutoff);const code=await runCli(args,{env:{},isInteractive:false,fetcher:((...a:Parameters<typeof fetch>)=>{reads++;return fixtureFetch(...a);}) as typeof fetch,now:()=>cutoff,stdout:t=>out.push(t),stderr:t=>err.push(t)});return{code,stdout:out.join(''),stderr:err.join(''),reads};}
const proofOf=(b:LiveBundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!) as Record<string,unknown>;
function setProof(b:LiveBundle,edit:(proof:Record<string,unknown>)=>void){const proof=proofOf(b);edit(proof);const raw=JSON.stringify(proof);b.rawArtifacts['advisory-derivation']=raw;b.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=sha(raw);}
/** Appends every loader-returned record as the live collector stores it: original record clocks, USER_IMPORT, ordinary storage. */
function withRecords(b:LiveBundle,records:Wire[]):LiveBundle{
 for(const r of records){b.rawArtifacts[r.id]=r.raw;b.evidence.push({id:r.id,sourceId:A28_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT',accessMode:'USER_IMPORT',adapterVersion:A28_ADAPTER,scope:r.scope,retrievedAt:r.retrievedAt,availableAt:r.retrievedAt,contentHash:sha(r.raw)} as EvidenceRecord);}
 return b;
}
const factsOf=(b:LiveBundle)=>b.details!.advisory!;
/** Constructed proof77/facts76 envelope over the ordinary bundle; its A28 row is the source recomputation from the owned raw records, never a cached value. */
function genuine(ordinary:LiveBundle,t:TokenRef=token):LiveBundle{
 const b=withRecords(structuredClone(ordinary),recordsOf(captureFile(),t));
 setProof(b,p=>{p.method='advisory-provenance-v77';p.a28Decay=a28DecayDescriptor();});
 const facts=factsOf(b),index=facts.metrics.findIndex(m=>m.id==='A28');assert.ok(index>=0);
 facts.metrics[index]=validateA28DecaySource(t,cutoff,b.evidence,b.rawArtifacts).metric;
 facts.method='advisory-measurements-v76';facts.groups=advisoryGroups.map(g=>{const unresolved=g.featureIds.filter(id=>facts.metrics.find(m=>m.id===id)!.quality!=='KNOWN');return{checkId:g.checkId,total:g.featureIds.length,known:g.featureIds.length-unresolved.length,unresolved};});return b;
}
async function rejectsEverywhere(b:LiveBundle,dir:string,label:string){
 assert.throws(()=>validateA28DecayBundle(b,true),/A28_/,label+' trusted');
 assert.throws(()=>validateA28DecayBundle(b,false),/A28_/,label+' untrusted');
 const service=new Service(join(dir,'graft.db'));
 try{await assert.rejects(async()=>service.analyzeLive(b),Error,label+' service');}finally{service.close();}
}
const MODE=/A28_DECAY_MODE_REQUIRED|S20_STRUCTURAL_MODE_REQUIRED|S19_SINGLETON_MODE_REQUIRED|C09_MARKET_CONTEXT_MODE_REQUIRED|C12_BRIDGE_MODE_REQUIRED|S18_OBSERVABILITY_MODE_REQUIRED/;

test('A28 public mode rejects incompatible options before any capture read or API',async()=>{
 let reads=0;const base={a28DecayCapture:'/nonexistent-a28-capture.json',fetcher:async()=>{reads++;throw Error('UNEXPECTED_API');}};
 const incompatible:Record<string,unknown>[]=[{c07LifecycleCapture:'/nonexistent-c07.json'},{advisoryEnabled:false},{semanticEnabled:true},{executableLiquidity:true},{o28Expanded:true},{creatorRoleOnly:true},{s20RecurrenceCapture:'/nonexistent-s20.json'},{s19GroupsCapture:'/nonexistent-s19.json'},{c12BridgeCapture:'/nonexistent-c12.json'},{s18ObservabilityCapture:'/nonexistent-s18.json'}];
 for(const extra of incompatible)await assert.rejects(ordinaryRun(token,{...base,...extra}),MODE,JSON.stringify(extra));
 await assert.rejects(collectLiveToken({chain:'base',address:'0x0000000000000000000000000000000000000001'},{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,...base}),/A28_DECAY_MODE_REQUIRED/);
 await assert.rejects(ordinaryRun(token,base),/ENOENT|A28_DECAY_/);assert.equal(reads,0);
});
test('A28 source file over the hard 4 MiB bound fails before any API read',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a28-bound-'));try{
  // Constructed oversize placeholder, not a source: it must be refused on size alone.
  const file=join(dir,'oversize.json');writeFileSync(file,Buffer.alloc(4*1024*1024+1,0x20));
  let reads=0;await assert.rejects(ordinaryRun(token,{a28DecayCapture:file,fetcher:async()=>{reads++;throw Error('UNEXPECTED_API');}}),/A28_/);assert.equal(reads,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('A28 CLI flag requires a value and the dedicated public mode without writes or reads',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a28-cli-boundary-'));try{
  // Constructed placeholder path: every case must fail before the file is opened, so its content is irrelevant and never a source.
  const file=join(dir,'placeholder.json'),config=join(dir,'config.json'),db=join(dir,'a28.db'),configText=JSON.stringify(starterConfig());writeFileSync(file,'{}');writeFileSync(config,configText);
  const run=['analyze',token.address,'--partial','--advisory'];
  const cases:[string,string[],RegExp][]=[
   ['missing',[...run,'--a28-decay-capture'],/^FLAG_VALUE_REQUIRED:/],
   ['following flag',[...run,'--a28-decay-capture','--json'],/^FLAG_VALUE_REQUIRED:/],
   ['no partial',['analyze',token.address,'--advisory','--a28-decay-capture',file],/^A28_DECAY_MODE_REQUIRED:/],
   ['full',['analyze',token.address,'--full','--advisory','--a28-decay-capture',file],/^A28_DECAY_MODE_REQUIRED:/],
   ['no advisory',['analyze',token.address,'--partial','--a28-decay-capture',file],/^A28_DECAY_MODE_REQUIRED:/],
   ['other import',[...run,'--a28-decay-capture',file,'--s20-recurrence-capture',file],/^(A28_DECAY|S20_STRUCTURAL)_MODE_REQUIRED:/],
   ['expanded',[...run,'--a28-decay-capture',file,'--o28-expanded'],/^A28_DECAY_MODE_REQUIRED:/],
   ['evm',['analyze','0x0000000000000000000000000000000000000001','--partial','--advisory','--chain','base','--a28-decay-capture',file],/^A28_DECAY_MODE_REQUIRED:/],
   ['reassess',['reassess','1','--a28-decay-capture',file],/^A28_DECAY_MODE_REQUIRED:/]];
  for(const [label,args,expected] of cases){
   const r=await cliRun([...args,'--config',config,'--db',db]);
   assert.equal(r.code,2,label);assert.match(r.stderr,expected,label);assert.equal(r.stdout,'',label);assert.equal(r.reads,0,label+' network');assert.equal(existsSync(db),false,label);assert.equal(readFileSync(config,'utf8'),configText,label);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('A28 CLI public run stores every source record and reports one recomputed source-only metric',async()=>{await withCapture(async(file,dir)=>{
 const config=join(dir,'config.json'),db=join(dir,'a28.db'),records=recordsOf(file);writeFileSync(config,JSON.stringify(starterConfig()));
 const r=await cliRun(['analyze',token.address,'--partial','--advisory','--a28-decay-capture',file,'--json','--config',config,'--db',db]);
 assert.equal(r.code,0,r.stderr);assert.equal(r.stdout.includes(dir),false);
 const out=JSON.parse(r.stdout) as EntrySnapshot;
 assert.equal(out.details!.advisory!.method,'advisory-measurements-v76');
 const a28=out.details!.advisory!.metrics.filter(m=>m.id==='A28');assert.equal(a28.length,1);
 assert.deepEqual(a28[0],validateA28DecaySource(token,cutoff,out.evidence,Object.fromEntries(records.map(x=>[x.id,x.raw]))).metric);
 assert.equal(a28[0]!.quality,GENUINE_EXPECTED_QUALITY);
 assert.deepEqual(out.evidence.filter(a28Owns).map(e=>e.id).sort(),records.map(x=>x.id).sort());
 for(const x of records)assert.equal(readFileSync(join(dirname(db),'artifacts',sha(x.raw)),'utf8'),x.raw,x.id);
});});
test('ordinary bundles carry no A28 authority and reserved grafts fail closed',async()=>{await withCapture(async(_file,dir)=>{
 const ordinary=await ordinaryRun(),proof=proofOf(ordinary),records=recordsOf(captureFile());
 assert.equal(proof.method,'advisory-provenance-v40');assert.equal('a28Decay' in proof,false);assert.equal(ordinary.evidence.some(a28Owns),false);
 assert.equal(factsOf(ordinary).metrics.find(m=>m.id==='A28')!.quality,'MISSING');
 assert.equal(validateA28DecayCore(ordinary as never,proof),undefined);validateA28DecayBundle(ordinary,true);validateA28DecayBundle(ordinary,false);
 const variants:[string,(b:LiveBundle)=>void][]=[
  ['forged records',b=>{withRecords(b,records);}],
  ['orphan bare source raw',b=>{b.rawArtifacts[A28_SOURCE_ID]='{}';}],
  ['orphan capture raw',b=>{b.rawArtifacts[A28_CAPTURE_ID]=records[0]!.raw;}],
  ['orphan reserved raw',b=>{b.rawArtifacts[A28_SOURCE_PREFIX+'extra']=records[0]!.raw;}],
  ['A28 source on foreign id',b=>{b.evidence.at(-1)!.sourceId=A28_SOURCE_ID;}],
  ['A28 adapter on foreign source',b=>{b.evidence.at(-1)!.adapterVersion=A28_ADAPTER;}],
  ['reserved id under ordinary source',b=>{const e=b.evidence.at(-1)!;b.rawArtifacts[A28_SOURCE_PREFIX+'x']=b.rawArtifacts[e.id]??'';e.id=A28_SOURCE_PREFIX+'x';}],
  ['descriptor on ordinary40',b=>setProof(b,p=>{p.a28Decay=a28DecayDescriptor();})],
  ['proof77 without descriptor',b=>setProof(b,p=>{p.method='advisory-provenance-v77';})],
  ['descriptor without source on proof77',b=>setProof(b,p=>{p.method='advisory-provenance-v77';p.a28Decay=a28DecayDescriptor();})],
  ['descriptor on proof76',b=>setProof(b,p=>{p.method='advisory-provenance-v76';p.a28Decay=a28DecayDescriptor();})]];
 for(const [label,edit] of variants){const b=structuredClone(ordinary);edit(b);await rejectsEverywhere(b,dir,label);}
});});
test('genuine A28 bundle is trusted-only and every authority graft fails closed',async()=>{await withCapture(async(_file,dir)=>{
 const ordinary=await ordinaryRun(),good=genuine(ordinary),facts=factsOf(good),records=recordsOf(captureFile());
 const metric=facts.metrics.find(m=>m.id==='A28')!;assert.equal(metric.quality,GENUINE_EXPECTED_QUALITY);
 assert.ok(advisoryFactsSchema.safeParse(facts).success);validateA28DecayBundle(good,true);
 assert.throws(()=>validateA28DecayBundle(good,false),/A28_DECAY_PROOF_INVALID/);
 const other=(b:LiveBundle)=>factsOf(b).metrics.find(m=>m.id!=='A28')!;
 const a28=(b:LiveBundle)=>factsOf(b).metrics.find(m=>m.id==='A28')!;
 const owned=(b:LiveBundle)=>b.evidence.find(e=>e.id===A28_CAPTURE_ID)!;
 const variants:[string,(b:LiveBundle)=>void][]=[
  ['feature cites capture',b=>{b.features.push({id:'A28-GRAFT',value:true,unit:'bool',quality:'KNOWN',availableAt:cutoff,evidenceIds:[A28_CAPTURE_ID],applicability:'APPLICABLE'});}],
  ['baseline cites capture',b=>{b.details!.baseline[0]!.evidenceIds.push(A28_CAPTURE_ID);}],
  ['nested baseline cites capture',b=>{(b.details!.baseline[0] as {data:unknown}).data={graft:{ids:[A28_CAPTURE_ID]}};}],
  ['observation cites capture',b=>{b.observations.push({id:'a28-graft',subject:token,field:'graft',value:null,unit:'enum',evidenceIds:[A28_CAPTURE_ID],observedAt:cutoff,availableAt:cutoff,quality:'KNOWN'});}],
  ['semantic cites capture',b=>{b.semantic.claims.push({kind:'NARRATIVE',value:'graft',evidenceId:A28_CAPTURE_ID,quote:'grafted A28 evidence',assertion:'SOURCE_STATES'});}],
  ['exit cites capture',b=>{(b as {exitProofs?:unknown}).exitProofs=[{evidenceIds:[A28_CAPTURE_ID]}];}],
  ['other metric cites capture',b=>{other(b).evidenceIds=[...other(b).evidenceIds,A28_CAPTURE_ID];}],
  ['nested other metric data cites capture',b=>{other(b).data={previous:other(b).data,graft:A28_CAPTURE_ID};}],
  ['short-demand supplement cites capture',b=>{factsOf(b).supplements!.shortDemand.evidenceIds.push(A28_CAPTURE_ID);}],
  ['details groups',b=>{Object.assign(b.details!,{groups:{}});}],['details shared',b=>{Object.assign(b.details!,{shared:{}});}],
  ['details social',b=>{Object.assign(b.details!,{social:{}});}],['details executable liquidity',b=>{Object.assign(b.details!,{executableLiquidity:{}});}],
  ['facts75 downgrade',b=>{factsOf(b).method='advisory-measurements-v75';}],
  ['proof76 downgrade',b=>setProof(b,p=>{p.method='advisory-provenance-v76';})],['proof40 downgrade',b=>setProof(b,p=>{p.method='advisory-provenance-v40';})],
  ['proof cutoff',b=>setProof(b,p=>{p.cutoff='2026-11-09T00:00:00.000Z';})],
  ['descriptor dropped',b=>setProof(b,p=>{delete p.a28Decay;})],
  ['descriptor sourcePath',b=>setProof(b,p=>{p.a28Decay={...a28DecayDescriptor(),sourcePath:'/tmp/capture.json'};})],
  ['descriptor S20 purpose',b=>setProof(b,p=>{p.a28Decay={...a28DecayDescriptor(),purpose:S20_PURPOSE};})],
  ['descriptor S20 method',b=>setProof(b,p=>{p.a28Decay={...a28DecayDescriptor(),method:S20_ADAPTER};})],
  ['duplicate A28 metric',b=>{factsOf(b).metrics.push(structuredClone(a28(b)));}],
  ['missing A28 metric',b=>{const f=factsOf(b);f.metrics=f.metrics.filter(m=>m.id!=='A28');}],
  ['tampered A28 data',b=>{a28(b).data={...(a28(b).data as Record<string,unknown>),tampered:true};}],
  ['tampered quality',b=>{a28(b).quality=a28(b).quality==='KNOWN'?'MISSING':'KNOWN';}],
  ['extra evidence id',b=>{a28(b).evidenceIds=[...a28(b).evidenceIds,A28_SOURCE_PREFIX+'extra'];}],
  ['missing capture record',b=>{b.evidence=b.evidence.filter(e=>e.id!==A28_CAPTURE_ID);delete b.rawArtifacts[A28_CAPTURE_ID];}],
  ['extra reserved raw',b=>{b.rawArtifacts[A28_SOURCE_PREFIX+'extra']=records[0]!.raw;}],
  ['capture restamped',b=>{owned(b).retrievedAt=cutoff;owned(b).availableAt=cutoff;}],
  ['capture scope sourcePath',b=>{owned(b).scope={...owned(b).scope,sourcePath:'/tmp/capture.json'};}],
  ...records.map((x):[string,(b:LiveBundle)=>void]=>['record bytes edited '+x.id,b=>{const raw=b.rawArtifacts[x.id]+' ';b.rawArtifacts[x.id]=raw;b.evidence.find(e=>e.id===x.id)!.contentHash=sha(raw);}])];
 for(const [label,edit] of variants){const b=structuredClone(good);edit(b);await rejectsEverywhere(b,dir,label);}
 // A second special descriptor on the A28 proof is refused by the central proof and S20 cores even though A28 itself is intact.
 const both=structuredClone(good);setProof(both,p=>{p.s20Structural=s20StructuralDescriptor();});
 const service=new Service(join(dir,'both.db'));try{await assert.rejects(async()=>service.analyzeLive(both),Error);}finally{service.close();}
});});
test('public collection stores every exact record, preserves ordinary authority and persists idempotently',async()=>{await withCapture(async(file,dir)=>{
 const records=recordsOf(file),packagedAt=records[0]!.retrievedAt;
 assert.ok(Date.parse(packagedAt)<=Date.parse(cutoff),'the run cutoff follows the packaged source');
 const ordinary=await ordinaryRun(),b=await ordinaryRun(token,{a28DecayCapture:file});
 assert.equal(JSON.stringify(b).includes(dir),false);
 const proof=proofOf(b);assert.equal(proof.method,'advisory-provenance-v77');assert.deepEqual(proof.a28Decay,a28DecayDescriptor());assert.ok(advisoryProofSchema.safeParse(proof).success);
 const owned=b.evidence.filter(a28Owns);assert.deepEqual(owned.map(e=>e.id).sort(),records.map(x=>x.id).sort());
 for(const x of records){
  const e=owned.find(o=>o.id===x.id)!;
  assert.equal(e.sourceId,A28_SOURCE_ID);assert.equal(e.adapterVersion,A28_ADAPTER);assert.equal(e.sourceType,'HISTORICAL_RECEIPT');assert.equal(e.accessMode,'USER_IMPORT');
  assert.equal(e.retrievedAt,x.retrievedAt);assert.equal(e.availableAt,x.retrievedAt);assert.equal(e.contentHash,sha(x.raw));assert.deepEqual(e.scope,x.scope);
  assert.equal(b.rawArtifacts[x.id],x.raw);
 }
 assert.equal(owned.find(e=>e.id===A28_CAPTURE_ID)!.retrievedAt,packagedAt);
 const facts=factsOf(b),plainFacts=factsOf(ordinary);assert.equal(facts.method,'advisory-measurements-v76');assert.ok(facts.supplements?.shortDemand);
 const a28=facts.metrics.find(m=>m.id==='A28')!;assert.deepEqual(a28,validateA28DecaySource(token,cutoff,b.evidence,b.rawArtifacts).metric);assert.equal(a28.quality,GENUINE_EXPECTED_QUALITY);
 // Every other advisory metric, feature, baseline row and observation is identical to the ordinary run.
 const others=facts.metrics.filter(m=>m.id!=='A28');assert.equal(others.length,facts.metrics.length-1);assert.deepEqual(others,plainFacts.metrics.filter(m=>m.id!=='A28'));
 assert.deepEqual(b.features,ordinary.features);assert.deepEqual(b.details!.baseline,ordinary.details!.baseline);assert.deepEqual(b.observations,ordinary.observations);
 validateA28DecayBundle(b,true);
 const db=join(dir,'a28.db');let id='';
 {const service=new Service(db);try{const first=await service.analyzeLive(b),second=await service.analyzeLive(structuredClone(b));assert.equal(second.id,first.id);id=first.id;
  const plain=await service.analyzeLive(ordinary);assert.deepEqual(plain.result.binary,first.result.binary);assert.deepEqual(plain.result.classification,first.result.classification);}finally{service.close();}}
 for(const x of records)assert.equal(readFileSync(join(dirname(db),'artifacts',sha(x.raw)),'utf8'),x.raw,x.id);
 {const service=new Service(db);try{const shown=await service.show(id);assert.equal(shown.id,id);const replay=await service.replay(id);assert.equal(replay.id,id);assert.equal(service.frozenDetails(replay.id).advisory!.method,'advisory-measurements-v76');}finally{service.close();}}
});});
test('a genuine outside-study control gets honest A28 MISSING after full source validation and keeps every ordinary output',async()=>{await withCapture(async(file,dir)=>{
 const ordinary=await ordinaryRun(control),b=await ordinaryRun(control,{a28DecayCapture:file});
 const metric=factsOf(b).metrics.find(m=>m.id==='A28')!;
 assert.deepEqual(metric,validateA28DecaySource(control,cutoff,b.evidence,b.rawArtifacts).metric);
 assert.equal(metric.quality,'MISSING');assert.ok(metric.reasonCode.length>0);
 assert.deepEqual(factsOf(b).metrics.filter(m=>m.id!=='A28'),factsOf(ordinary).metrics.filter(m=>m.id!=='A28'));
 assert.deepEqual(b.features,ordinary.features);assert.deepEqual(b.details!.baseline,ordinary.details!.baseline);
 validateA28DecayBundle(b,true);
 // A missing member run still revalidates every raw record: an edited record fails exactly as for the subject token.
 const edited=structuredClone(b),id=recordsOf(file,control).at(-1)!.id,raw=edited.rawArtifacts[id]+' ';
 edited.rawArtifacts[id]=raw;edited.evidence.find(e=>e.id===id)!.contentHash=sha(raw);
 await rejectsEverywhere(edited,dir,'control record edited');
});});
test('A28 facts and proof schemas require supplements and the strict descriptor',async()=>{
 const good=genuine(await ordinaryRun()),facts=factsOf(good),proof=proofOf(good);
 for(const method of ['advisory-measurements-v75','advisory-measurements-v76']){
  assert.ok(advisoryFactsSchema.safeParse({...facts,method}).success,method);
  const {supplements:_drop,...bare}=facts;assert.equal(advisoryFactsSchema.safeParse({...bare,method}).success,false,method+' without supplements');
 }
 assert.ok(advisoryProofSchema.safeParse(proof).success);assert.deepEqual(proof.a28Decay,{method:A28_ADAPTER,purpose:A28_PURPOSE,captureId:A28_CAPTURE_ID});
 const {captureId:_id,...noCapture}=a28DecayDescriptor();
 const bad:unknown[]=[{...a28DecayDescriptor(),sourcePath:'/tmp/capture.json'},noCapture,{...a28DecayDescriptor(),captureId:A28_SOURCE_PREFIX+'manifest'},{...a28DecayDescriptor(),method:S20_ADAPTER},{...a28DecayDescriptor(),purpose:S20_PURPOSE}];
 for(const d of bad){assert.equal(a28DecayDescriptorSchema.safeParse(d).success,false);assert.equal(advisoryProofSchema.safeParse({...proof,a28Decay:d}).success,false);}
});
