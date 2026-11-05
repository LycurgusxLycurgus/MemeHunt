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
import {validateS20StructuralBundle,validateS20StructuralCore,s20StructuralDescriptor,s20StructuralDescriptorSchema} from '../src/app/s20-structural.js';
import {S20_SOURCE_ID,S20_SOURCE_PREFIX,S20_CAPTURE_ID,S20_ADAPTER,S20_PURPOSE,S20_EVIDENCE_IDS,loadS20StructuralCapture,validateS20StructuralSource,s20Scope,s20Hash,s20Owns,type S20WireRecord} from '../src/providers/advisory-s20-structural.js';
import {S20_IMPORT_METHOD,S20_PURPOSE as S20_FRAME_PURPOSE} from '../src/providers/advisory-s20-source-frames.js';
import {S19_PURPOSE} from '../src/providers/advisory-s19-singleton-source.js';
import {Service} from '../src/app/service.js';
import {advisoryProofSchema} from '../src/app/advisory.js';
import {advisoryFactsSchema,advisoryGroups} from '../src/domain/advisory-contracts.js';
import type {EvidenceRecord,LiveBundle} from '../src/domain/contracts.js';
import {a29LiveFetcher} from './a29-fixtures.js';

const token={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'};
const cutoff='2026-11-05T00:00:00.000Z',packagedAt='2026-11-04T13:53:52.566Z';
// The genuine retained portable S20 source-frame file of advisory-s20-structural.test.ts, byte for byte. The surrounding
// ordinary bundle comes from the labelled offline a29 fixture reads and is never presented as genuine provider data.
const portable=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(gunzipSync(readFileSync('tests/fixtures/s20-provided-call-samples.json.gz')));
const ordinaryRun=(extra:Record<string,unknown>={})=>collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,now:()=>cutoff,fetcher:a29LiveFetcher(token.address,cutoff),...extra});
async function cliRun(args:string[]){const out:string[]=[],err:string[]=[];let reads=0;const fixture=a29LiveFetcher(token.address,cutoff);const code=await runCli(args,{env:{},isInteractive:false,fetcher:((...a:Parameters<typeof fetch>)=>{reads++;return fixture(...a);}) as typeof fetch,now:()=>cutoff,stdout:t=>out.push(t),stderr:t=>err.push(t)});return{code,stdout:out.join(''),stderr:err.join(''),reads};}
const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const proofOf=(b:LiveBundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!) as Record<string,unknown>;
function setProof(b:LiveBundle,edit:(proof:Record<string,unknown>)=>void){const proof=proofOf(b);edit(proof);const raw=JSON.stringify(proof);b.rawArtifacts['advisory-derivation']=raw;b.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=sha(raw);}
function withCapture<T>(run:(file:string,dir:string)=>Promise<T>):Promise<T>{const dir=mkdtempSync(join(tmpdir(),'s20-integration-'));const done=()=>rmSync(dir,{recursive:true,force:true});try{const file=join(dir,'capture.json');writeFileSync(file,portable);return run(file,dir).finally(done);}catch(error){done();throw error;}}
// One shared on-disk copy of the genuine portable bytes for synchronous loader calls; removed at exit.
const shared=mkdtempSync(join(tmpdir(),'s20-integration-shared-')),captureFile=join(shared,'capture.json');
writeFileSync(captureFile,portable);process.on('exit',()=>rmSync(shared,{recursive:true,force:true}));
function withRecords(b:LiveBundle,records:S20WireRecord[]):LiveBundle{
 for(const r of records){b.rawArtifacts[r.id]=r.raw;b.evidence.push({id:r.id,sourceId:S20_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT',accessMode:'USER_IMPORT',adapterVersion:S20_ADAPTER,scope:r.scope,retrievedAt:r.retrievedAt,availableAt:r.retrievedAt,contentHash:s20Hash(r.raw)} as EvidenceRecord);}
 return b;
}
const factsOf=(b:LiveBundle)=>b.details!.advisory!;
function genuine(ordinary:LiveBundle):LiveBundle{
 const b=withRecords(structuredClone(ordinary),loadS20StructuralCapture(captureFile,token,cutoff).records);
 setProof(b,p=>{p.method='advisory-provenance-v74';p.s20Structural=s20StructuralDescriptor();});
 const facts=factsOf(b),index=facts.metrics.findIndex(m=>m.id==='S20');assert.ok(index>=0);
 facts.metrics[index]=validateS20StructuralSource(token,cutoff,b.evidence,b.rawArtifacts).metric;
 facts.method='advisory-measurements-v73';facts.groups=advisoryGroups.map(g=>{const unresolved=g.featureIds.filter(id=>facts.metrics.find(m=>m.id===id)!.quality!=='KNOWN');return{checkId:g.checkId,total:g.featureIds.length,known:g.featureIds.length-unresolved.length,unresolved};});return b;
}
async function rejectsEverywhere(b:LiveBundle,dir:string,label:string){
 assert.throws(()=>validateS20StructuralBundle(b,true),/S20_STRUCTURAL_/,label+' trusted');
 assert.throws(()=>validateS20StructuralBundle(b,false),/S20_STRUCTURAL_/,label+' untrusted');
 const service=new Service(join(dir,'graft.db'));
 try{await assert.rejects(async()=>service.analyzeLive(b),Error,label+' service');}finally{service.close();}
}
test('S20 public mode rejects incompatible options before any capture read',async()=>{
 let reads=0;const base={s20RecurrenceCapture:'/nonexistent-s20-capture.json',fetcher:async()=>{reads++;throw Error('UNEXPECTED_API');}};
 const incompatible:Record<string,unknown>[]=[{advisoryEnabled:false},{semanticEnabled:true},{executableLiquidity:true},{o28Expanded:true},{creatorRoleOnly:true},{s19GroupsCapture:'/nonexistent-s19.json'}];
 for(const extra of incompatible)await assert.rejects(ordinaryRun({...base,...extra}),/S20_STRUCTURAL_MODE_REQUIRED|C09_MARKET_CONTEXT_MODE_REQUIRED|C12_BRIDGE_MODE_REQUIRED/,JSON.stringify(extra));
 await assert.rejects(ordinaryRun(base),/ENOENT/);assert.equal(reads,0);
});
test('S20 CLI flag requires a value and the dedicated public mode without writes',async()=>{await withCapture(async(file,dir)=>{
 const config=join(dir,'config.json'),db=join(dir,'s20.db'),configText=JSON.stringify(starterConfig());writeFileSync(config,configText);
 const run=['analyze',token.address,'--partial','--advisory'];
 const cases:[string,string[],RegExp][]=[
  ['missing',[...run,'--s20-recurrence-capture'],/^FLAG_VALUE_REQUIRED:/],
  ['following flag',[...run,'--s20-recurrence-capture','--json'],/^FLAG_VALUE_REQUIRED:/],
  ['no partial',['analyze',token.address,'--advisory','--s20-recurrence-capture',file],/^S20_STRUCTURAL_MODE_REQUIRED:/],
  ['full',['analyze',token.address,'--full','--advisory','--s20-recurrence-capture',file],/^S20_STRUCTURAL_MODE_REQUIRED:/],
  ['no advisory',['analyze',token.address,'--partial','--s20-recurrence-capture',file],/^S20_STRUCTURAL_MODE_REQUIRED:/],
  ['other import',[...run,'--s20-recurrence-capture',file,'--s19-groups-capture',file],/^S20_STRUCTURAL_MODE_REQUIRED:/],
  ['expanded',[...run,'--s20-recurrence-capture',file,'--o28-expanded'],/^S20_STRUCTURAL_MODE_REQUIRED:/],
  ['evm',['analyze','0x0000000000000000000000000000000000000001','--partial','--advisory','--chain','base','--s20-recurrence-capture',file],/^S20_STRUCTURAL_MODE_REQUIRED:/],
  ['reassess',['reassess','1','--s20-recurrence-capture',file],/^S20_STRUCTURAL_MODE_REQUIRED:/]];
 for(const [label,args,code] of cases){
  const r=await cliRun([...args,'--config',config,'--db',db]);
  assert.equal(r.code,2,label);assert.match(r.stderr,code,label);assert.equal(r.stdout,'',label);assert.equal(r.reads,0,label+' network');assert.equal(existsSync(db),false,label);assert.equal(readFileSync(config,'utf8'),configText,label);
 }
});});
test('S20 CLI public run stores the exact capture and reports one source-only metric',async()=>{await withCapture(async(file,dir)=>{
 const config=join(dir,'config.json'),db=join(dir,'s20.db');writeFileSync(config,JSON.stringify(starterConfig()));
 const r=await cliRun(['analyze',token.address,'--partial','--advisory','--s20-recurrence-capture',file,'--json','--config',config,'--db',db]);
 assert.equal(r.code,0,r.stderr);assert.equal(r.stdout.includes(dir),false);
 const out=JSON.parse(r.stdout) as import('../src/domain/contracts.js').EntrySnapshot;
 assert.equal(out.details!.advisory!.method,'advisory-measurements-v73');
 const s20=out.details!.advisory!.metrics.filter(m=>m.id==='S20');assert.equal(s20.length,1);assert.equal(s20[0]!.quality,'KNOWN');assert.deepEqual(s20[0]!.evidenceIds,[S20_CAPTURE_ID]);
 assert.deepEqual(out.evidence.filter(s20Owns).map(e=>e.id),[S20_CAPTURE_ID]);
 assert.equal(readFileSync(join(dirname(db),'artifacts',s20Hash(portable)),'utf8'),portable);
});});
test('ordinary bundles carry no S20 authority and reserved grafts fail closed',async()=>{await withCapture(async(_file,dir)=>{
 const ordinary=await ordinaryRun(),proof=proofOf(ordinary);
 assert.equal(proof.method,'advisory-provenance-v40');assert.equal('s20Structural' in proof,false);assert.equal(ordinary.evidence.some(s20Owns),false);
 assert.equal(validateS20StructuralCore(ordinary as never,proof),undefined);validateS20StructuralBundle(ordinary,true);validateS20StructuralBundle(ordinary,false);
 const capture=loadS20StructuralCapture(captureFile,token,cutoff).records;
 const variants:[string,(b:LiveBundle)=>void][]=[
  ['forged capture',b=>{withRecords(b,capture);}],
  ['orphan capture raw',b=>{b.rawArtifacts[S20_CAPTURE_ID]=portable;}],
  ['orphan reserved raw',b=>{b.rawArtifacts[S20_SOURCE_PREFIX+'extra']=portable;}],
  ['S20 source on foreign id',b=>{b.evidence.at(-1)!.sourceId=S20_SOURCE_ID;}],
  ['S20 adapter on foreign source',b=>{b.evidence.at(-1)!.adapterVersion=S20_ADAPTER;}],
  ['reserved id under ordinary source',b=>{const e=b.evidence.at(-1)!;b.rawArtifacts[S20_SOURCE_PREFIX+'x']=b.rawArtifacts[e.id]??'';e.id=S20_SOURCE_PREFIX+'x';}],
  ['descriptor on ordinary40',b=>setProof(b,p=>{p.s20Structural=s20StructuralDescriptor();})],
  ['proof74 without descriptor',b=>setProof(b,p=>{p.method='advisory-provenance-v74';})],
  ['descriptor without source on proof74',b=>setProof(b,p=>{p.method='advisory-provenance-v74';p.s20Structural=s20StructuralDescriptor();})],
  ['descriptor on proof73',b=>setProof(b,p=>{p.method='advisory-provenance-v73';p.s20Structural=s20StructuralDescriptor();})]];
 for(const [label,edit] of variants){const b=structuredClone(ordinary);edit(b);await rejectsEverywhere(b,dir,label);}
});});
test('genuine S20 bundle is trusted-only and every authority graft fails closed',async()=>{await withCapture(async(_file,dir)=>{
 const ordinary=await ordinaryRun(),good=genuine(ordinary),facts=factsOf(good);
 const metric=facts.metrics.find(m=>m.id==='S20')!;assert.equal(metric.quality,'KNOWN');assert.deepEqual((metric.data as {recurrence:{value:number}}).recurrence.value,0);
 assert.ok(advisoryFactsSchema.safeParse(facts).success);validateS20StructuralBundle(good,true);
 assert.throws(()=>validateS20StructuralBundle(good,false),/S20_STRUCTURAL_PROOF_INVALID/);
 const other=(b:LiveBundle)=>factsOf(b).metrics.find(m=>m.id!=='S20')!;
 const s20=(b:LiveBundle)=>factsOf(b).metrics.find(m=>m.id==='S20')!;
 const owned=(b:LiveBundle)=>b.evidence.find(e=>e.id===S20_CAPTURE_ID)!;
 const variants:[string,(b:LiveBundle)=>void][]=[
  ['feature cites capture',b=>{b.features.push({id:'S20-GRAFT',value:true,unit:'bool',quality:'KNOWN',availableAt:cutoff,evidenceIds:[S20_CAPTURE_ID],applicability:'APPLICABLE'});}],
  ['baseline cites capture',b=>{b.details!.baseline[0]!.evidenceIds.push(S20_CAPTURE_ID);}],
  ['nested baseline cites capture',b=>{(b.details!.baseline[0] as {data:unknown}).data={graft:S20_CAPTURE_ID};}],
  ['observation cites capture',b=>{b.observations.push({id:'s20-graft',subject:token,field:'graft',value:null,unit:'enum',evidenceIds:[S20_CAPTURE_ID],observedAt:cutoff,availableAt:cutoff,quality:'KNOWN'});}],
  ['semantic cites capture',b=>{b.semantic.claims.push({kind:'NARRATIVE',value:'graft',evidenceId:S20_CAPTURE_ID,quote:'grafted S20 evidence',assertion:'SOURCE_STATES'});}],
  ['exit cites capture',b=>{(b as {exitProofs?:unknown}).exitProofs=[{evidenceIds:[S20_CAPTURE_ID]}];}],
  ['details groups',b=>{Object.assign(b.details!,{groups:{}});}],
  ['other metric cites capture',b=>{other(b).evidenceIds=[...(other(b).evidenceIds??[]),S20_CAPTURE_ID];}],
  ['nested other metric data cites capture',b=>{other(b).data={previous:other(b).data,graft:S20_CAPTURE_ID};}],
  ['short-demand supplement cites capture',b=>{factsOf(b).supplements!.shortDemand.evidenceIds.push(S20_CAPTURE_ID);}],
  ['details shared',b=>{Object.assign(b.details!,{shared:{}});}],
  ['details social',b=>{Object.assign(b.details!,{social:{}});}],
  ['details executable liquidity',b=>{Object.assign(b.details!,{executableLiquidity:{}});}],
  ['facts72 downgrade',b=>{factsOf(b).method='advisory-measurements-v72';}],
  ['proof73 downgrade',b=>setProof(b,p=>{p.method='advisory-provenance-v73';})],
  ['proof40 downgrade',b=>setProof(b,p=>{p.method='advisory-provenance-v40';})],
  ['descriptor dropped',b=>setProof(b,p=>{delete p.s20Structural;})],
  ['descriptor sourcePath',b=>setProof(b,p=>{p.s20Structural={...s20StructuralDescriptor(),sourcePath:'/tmp/capture.json'};})],
  ['descriptor frame purpose',b=>setProof(b,p=>{p.s20Structural={...s20StructuralDescriptor(),purpose:S20_FRAME_PURPOSE};})],
  ['descriptor S19 purpose',b=>setProof(b,p=>{p.s20Structural={...s20StructuralDescriptor(),purpose:S19_PURPOSE};})],
  ['descriptor import method',b=>setProof(b,p=>{p.s20Structural={...s20StructuralDescriptor(),method:S20_IMPORT_METHOD};})],
  ['duplicate S20 metric',b=>{factsOf(b).metrics.push(structuredClone(s20(b)));}],
  ['missing S20 metric',b=>{const f=factsOf(b);f.metrics=f.metrics.filter(m=>m.id!=='S20');}],
  ['tampered recurrence',b=>{(s20(b).data as {recurrence:{value:number}}).recurrence.value=1;}],
  ['tampered quality',b=>{s20(b).quality='MISSING';}],
  ['extra evidence id',b=>{s20(b).evidenceIds=[S20_CAPTURE_ID,S20_SOURCE_PREFIX+'extra'];}],
  ['missing owned record',b=>{b.evidence=b.evidence.filter(e=>e.id!==S20_CAPTURE_ID);delete b.rawArtifacts[S20_CAPTURE_ID];}],
  ['extra reserved raw',b=>{b.rawArtifacts[S20_SOURCE_PREFIX+'extra']=portable;}],
  ['capture bytes edited',b=>{const raw=b.rawArtifacts[S20_CAPTURE_ID]+' ';b.rawArtifacts[S20_CAPTURE_ID]=raw;owned(b).contentHash=s20Hash(raw);}],
  ['capture restamped',b=>{owned(b).retrievedAt=cutoff;owned(b).availableAt=cutoff;}],
  ['capture scope sourcePath',b=>{owned(b).scope={...s20Scope(),sourcePath:'/tmp/capture.json'};}]];
 for(const [label,edit] of variants){const b=structuredClone(good);edit(b);await rejectsEverywhere(b,dir,label);}
});});
test('public collection stores one exact capture, preserves ordinary authority and persists idempotently',async()=>{await withCapture(async(file,dir)=>{
 const ordinary=await ordinaryRun(),b=await ordinaryRun({s20RecurrenceCapture:file});
 assert.equal(JSON.stringify(b).includes(dir),false);
 const proof=proofOf(b);assert.equal(proof.method,'advisory-provenance-v74');assert.deepEqual(proof.s20Structural,s20StructuralDescriptor());assert.ok(advisoryProofSchema.safeParse(proof).success);
 const owned=b.evidence.filter(s20Owns);assert.equal(owned.length,1);const e=owned[0]!;
 assert.equal(e.id,S20_CAPTURE_ID);assert.equal(e.sourceId,S20_SOURCE_ID);assert.equal(e.adapterVersion,S20_ADAPTER);assert.equal(e.sourceType,'HISTORICAL_RECEIPT');assert.equal(e.accessMode,'USER_IMPORT');
 assert.equal(e.retrievedAt,packagedAt);assert.equal(e.availableAt,packagedAt);assert.equal(e.contentHash,s20Hash(portable));assert.deepEqual(e.scope,s20Scope());
 assert.equal(b.rawArtifacts[S20_CAPTURE_ID],portable);
 const facts=factsOf(b),plainFacts=factsOf(ordinary);assert.equal(facts.method,'advisory-measurements-v73');assert.ok(facts.supplements?.shortDemand);
 const s20=facts.metrics.find(m=>m.id==='S20')!;assert.deepEqual(s20,validateS20StructuralSource(token,cutoff,b.evidence,b.rawArtifacts).metric);assert.equal(s20.quality,'KNOWN');
 assert.deepEqual(facts.metrics.filter(m=>m.id!=='S20'),plainFacts.metrics.filter(m=>m.id!=='S20'));
 assert.deepEqual(b.features,ordinary.features);assert.deepEqual(b.details!.baseline,ordinary.details!.baseline);assert.deepEqual(b.observations,ordinary.observations);
 validateS20StructuralBundle(b,true);
 const db=join(dir,'s20.db');let id='';
 {const service=new Service(db);try{const first=await service.analyzeLive(b),second=await service.analyzeLive(b);assert.equal(second.id,first.id);id=first.id;
  const control=await service.analyzeLive(ordinary);assert.deepEqual(control.result.binary,first.result.binary);assert.deepEqual(control.result.classification,first.result.classification);}finally{service.close();}}
 assert.equal(readFileSync(join(dirname(db),'artifacts',s20Hash(portable)),'utf8'),portable);
 {const service=new Service(db);try{const shown=await service.show(id);assert.ok(shown);const replay=await service.replay(id);assert.equal(service.frozenDetails(replay.id).advisory!.method,'advisory-measurements-v73');}finally{service.close();}}
});});
test('S20 facts and proof schemas require supplements and the strict descriptor',async()=>{
 const good=genuine(await ordinaryRun()),facts=factsOf(good),proof=proofOf(good);
 for(const method of ['advisory-measurements-v72','advisory-measurements-v73']){
  assert.ok(advisoryFactsSchema.safeParse({...facts,method}).success,method);
  const {supplements:_drop,...bare}=facts;assert.equal(advisoryFactsSchema.safeParse({...bare,method}).success,false,method+' without supplements');
 }
 assert.ok(advisoryProofSchema.safeParse(proof).success);assert.deepEqual(proof.s20Structural,{method:S20_ADAPTER,purpose:S20_PURPOSE,captureId:S20_CAPTURE_ID});
 const {captureId:_id,...noCapture}=s20StructuralDescriptor();
 const bad:unknown[]=[{...s20StructuralDescriptor(),sourcePath:'/tmp/capture.json'},noCapture,{...s20StructuralDescriptor(),captureId:S20_SOURCE_PREFIX+'frames'},{...s20StructuralDescriptor(),method:S20_IMPORT_METHOD},{...s20StructuralDescriptor(),purpose:S20_FRAME_PURPOSE}];
 for(const d of bad){assert.equal(s20StructuralDescriptorSchema.safeParse(d).success,false);assert.equal(advisoryProofSchema.safeParse({...proof,s20Structural:d}).success,false);}
});
