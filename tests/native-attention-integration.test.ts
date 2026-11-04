import {assertEntryCliSnapshot} from './entry-cli-snapshot.js';
/** CONSTRUCTED model receipts/corpus and mocked live providers. Actual native/CLI acceptance is separate. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {collectLiveToken,type LiveOptions} from '../src/app/live.js';
import {Service} from '../src/app/service.js';
import {starterProfile} from '../src/app/config.js';
import {runCli} from '../src/cli.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {nativeAttentionDescriptor,nativeAttentionSemantic,validateNativeAttentionBundle} from '../src/app/native-attention.js';
import {decodeNativeAttentionCapture,nativeAttentionScope,NATIVE_ATTENTION_ID,NATIVE_ATTENTION_METHOD,NATIVE_ATTENTION_SOURCE} from '../src/providers/native-attention.js';
import {thesisSchema,type LiveBundle,type Thesis} from '../src/domain/contracts.js';
import {nativeAttentionFixture,NATIVE_TEST_TOKEN} from './native-attention-fixtures.js';
import {a29LiveFetcher} from './a29-fixtures.js';

type Loose=Record<string,any>;
const ACQUIRED='2026-10-30T12:00:00.000Z',CUTOFF='2026-10-30T12:05:00.000Z',EXPIRY='2026-10-26T14:26:30.786Z';
const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const proofOf=(b:LiveBundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const metric=(b:LiveBundle,id='C10')=>b.details!.advisory!.metrics.find(m=>m.id===id)!;
const row=(b:LiveBundle,id:string)=>b.details!.baseline.find(a=>a.id===id)!;
const rewrite=(b:LiveBundle,id:string,change:(value:Loose)=>void)=>{const value=JSON.parse(b.rawArtifacts[id]!);change(value);b.rawArtifacts[id]=JSON.stringify(value);const e=b.evidence.find(e=>e.id===id)!;e.contentHash=sha(b.rawArtifacts[id]!);if(id===NATIVE_ATTENTION_ID)e.scope=nativeAttentionScope(b.rawArtifacts[id]!);};
const smallThesis=()=>thesisSchema.parse({support:[{op:'eq',feature:'A01',value:true,unit:'bool'},{op:'eq',feature:'A02',value:true,unit:'bool'}],invalidation:[{op:'eq',feature:'A02',value:false,unit:'bool'}],expiryAt:EXPIRY});
// Exact original six-support/five-invalidation shape. Unavailable mechanical
// inputs must stay UNKNOWN even though this historical thesis is expired.
const originalThesis=()=>thesisSchema.parse({support:['O01','O03','O04','O06','A01','A02'].map(feature=>({op:'eq',feature,value:true,unit:'bool'})),invalidation:[...['O01','O03','O04','O06'].map(feature=>({op:'eq',feature,value:false,unit:'bool'})),{op:'gt',feature:'O15',value:'1000',unit:'bps'}],expiryAt:EXPIRY});
async function withDir<T>(fn:(dir:string,file:string)=>T|Promise<T>){const dir=mkdtempSync(join(tmpdir(),'native-attention-integration-'));try{return await fn(dir,join(dir,'live.sqlite'));}finally{rmSync(dir,{recursive:true,force:true});}}
async function collect(options:{native?:boolean;expanded?:boolean;namedErrors?:boolean;reject?:boolean;cutoff?:string;thesis?:Thesis}={}){
 const cutoff=options.cutoff??CUTOFF,hosts:string[]=[],fetcher=a29LiveFetcher(NATIVE_TEST_TOKEN.address,cutoff);
 const observed:typeof fetch=async(input,init)=>{hosts.push(new URL(String(input)).host);return fetcher(input,init);};
 return withDir(async dir=>{
  const capture=await nativeAttentionFixture({token:NATIVE_TEST_TOKEN,acquiredAt:ACQUIRED,reject:options.reject}),raw=JSON.stringify(capture),file=join(dir,'constructed-capture.json');writeFileSync(file,raw);
  const b=await collectLiveToken(NATIVE_TEST_TOKEN,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:options.expanded??true,...(options.namedErrors?{o28RpcErrors:true}:{}),thesis:options.thesis??smallThesis(),thesisExpiryMode:'FIXED',fetcher:observed,now:()=>cutoff,...(options.native===false?{}:{nativeAttentionCapture:file})});
  return {b,raw,capture,hosts};
 });
}
let positive:Promise<Awaited<ReturnType<typeof collect>>>|undefined;
const live=()=>positive??=collect();
const rebuild=(b:LiveBundle)=>reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,proofOf(b),b.thesis??null,b.features);

test('native partial admission selects proof59/facts58 and independently derives only A01/A02 before C10',async()=>{
 const {b,raw,capture,hosts}=await live(),proof=proofOf(b),record=b.evidence.find(e=>e.id===NATIVE_ATTENTION_ID)!;
 assert.deepEqual([proof.method,b.details!.advisory!.method],['advisory-provenance-v59','advisory-measurements-v58']);
 assert.deepEqual(proof.nativeAttention,nativeAttentionDescriptor());
 assert.deepEqual([proof.executorSemantic,proof.recordedCallers,proof.recordedIncentives],[null,null,null]);
 assert.deepEqual([record.sourceId,record.sourceType,record.accessMode,record.adapterVersion],[NATIVE_ATTENTION_SOURCE,'MODEL_EXECUTION','USER_IMPORT',NATIVE_ATTENTION_METHOD]);
 assert.equal(b.rawArtifacts[NATIVE_ATTENTION_ID],raw);assert.equal(record.contentHash,sha(raw));assert.deepEqual(record.scope,nativeAttentionScope(raw));
 assert.deepEqual([record.availableAt,record.retrievedAt],[capture.createdAt,capture.createdAt]);
 const decoded=decodeNativeAttentionCapture(raw,b.token,b.cutoff);assert.deepEqual(b.semantic,nativeAttentionSemantic(decoded));
 assert.equal(b.semantic.model,undefined);assert.deepEqual(b.semantic.claims,[]);
 for(const a of decoded.assessments){assert.deepEqual(row(b,a.id),a);assert.deepEqual(b.features.find(f=>f.id===a.id),a.projection);assert.equal(a.quality,'KNOWN');}
 assert.deepEqual(decoded.assessments.map(a=>a.id),['A01','A02']);
 assert.deepEqual([b.details!.shared,b.details!.social,b.details!.groups],[undefined,undefined,undefined]);
 assert.ok(!hosts.some(host=>/tinyfish|generativelanguage/.test(host)),'import makes no inference or web-corpus calls');
 assert.deepEqual(rebuild(b),b.details!.advisory);validateNativeAttentionBundle(b,true);
 const c10=metric(b),data=c10.data as Loose;assert.equal(c10.quality,'KNOWN');assert.deepEqual(data.support.map((p:Loose)=>p.truth),['TRUE','TRUE']);assert.deepEqual(data.invalidation.map((p:Loose)=>p.truth),['FALSE']);assert.equal(data.expired,true);assert.equal(data.expiryAt,EXPIRY);assert.deepEqual(data.thesis,smallThesis());assert.ok(c10.evidenceIds.includes(NATIVE_ATTENTION_ID));
});

test('native capture save/idempotence/reopen and offline CLI replay preserve full raw source binding and policy56',async()=>{
 const {b,raw}=await live();await withDir(async(dir,file)=>{
  let service=new Service(file),saved!:ReturnType<Service['analyzeLive']>;
  try{saved=service.analyzeLive(structuredClone(b));assert.equal(service.analyzeLive(structuredClone(b)).id,saved.id);assert.deepEqual(service.replay(saved.id),saved);}finally{service.close();}
  const db=new DatabaseSync(file);try{const semantic=JSON.parse((db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id) as {semantic:string}).semantic);assert.equal(semantic.policyVersion,'research-screen-advisory-v56');}finally{db.close();}
  service=new Service(file);try{assert.deepEqual(service.replay(saved.id),saved);}finally{service.close();}
  let out='',err='',network=0,models=0;const code=await runCli(['replay',saved.id,'--db',file,'--config',join(dir,'config.json'),'--json'],{env:{},isInteractive:false,fetcher:async()=>{network++;throw Error('OFFLINE_NETWORK_DENIED');},semanticExecutor:async()=>{models++;throw Error('OFFLINE_MODEL_DENIED');},stdout:s=>out+=s,stderr:s=>err+=s});
  assert.equal(code,0,err);assertEntryCliSnapshot(JSON.parse(out),saved);assert.deepEqual([network,models],[0,0]);assert.equal(b.rawArtifacts[NATIVE_ATTENTION_ID],raw);
 });
});

test('native qualification leaves ordinary partial versions unchanged and cannot resolve unrelated original thesis inputs',async()=>{
 const ordinary=(await collect({native:false})).b,namedErrors=(await collect({native:false,namedErrors:true})).b,defaultRun=(await collect({native:false,expanded:false})).b,{b}=await live();
 assert.deepEqual([proofOf(ordinary).method,ordinary.details!.advisory!.method],['advisory-provenance-v48','advisory-measurements-v47']);
 assert.deepEqual([proofOf(defaultRun).method,defaultRun.details!.advisory!.method],['advisory-provenance-v40','advisory-measurements-v39']);
 assert.deepEqual([proofOf(namedErrors).method,namedErrors.details!.advisory!.method],['advisory-provenance-v51','advisory-measurements-v50']);
 for(const control of [ordinary,defaultRun]){assert.equal(control.semantic.nativeAttention,undefined);assert.equal(control.semantic.status,'NOT_REQUESTED');assert.ok(!control.evidence.some(e=>e.id.startsWith('native-attention-')));assert.equal(row(control,'A01').quality,'MISSING');assert.equal(row(control,'A02').quality,'MISSING');}
 assert.deepEqual(b.details!.advisory!.metrics.filter(m=>m.id!=='C10'),namedErrors.details!.advisory!.metrics.filter(m=>m.id!=='C10'),'native59 inherits51 named-error scope; two entry features grant no other advisory metric authority');
 const original=(await collect({thesis:originalThesis()})).b,data=metric(original).data as Loose;
 assert.deepEqual(original.thesis,originalThesis());assert.deepEqual(original.details!.thesis,originalThesis());assert.deepEqual(data.thesis,originalThesis());
 assert.equal(data.expiryAt,EXPIRY);assert.equal(data.expired,true);assert.equal(data.support.length,6);assert.equal(data.invalidation.length,5);assert.equal(metric(original).quality,'MISSING','expiry never suppresses unavailable predicate inputs');
 assert.ok(data.support.filter((p:Loose)=>['A01','A02'].includes(p.predicate.feature)).every((p:Loose)=>p.truth==='TRUE'));
 assert.ok([...data.support,...data.invalidation].some((p:Loose)=>p.truth==='UNKNOWN'));
});

test('rejected or stale native qualification retains unavailable A02 and cannot turn C10 into a known favorable result',async()=>{
 const rejected=(await collect({reject:true})).b;assert.equal(row(rejected,'A01').quality,'KNOWN');assert.equal(row(rejected,'A02').quality,'MISSING');assert.equal(metric(rejected).quality,'MISSING');assert.equal(rejected.semantic.status,'CANDIDATE');
 const stale=(await collect({cutoff:'2026-10-30T12:20:00.000Z'})).b;assert.ok(['STALE','MISSING'].includes(row(stale,'A01').quality));assert.equal(metric(stale).quality,'MISSING');
 assert.equal(JSON.parse(stale.rawArtifacts[NATIVE_ATTENTION_ID]!).createdAt,'2026-10-30T12:03:01.000Z','no clock refresh at import');
});

test('native descriptor, ownership, raw replay, projections and C10 caches reject rehashed substitutions',async()=>{
 const {b}=await live(),mutations:Record<string,(x:LiveBundle)=>void>={
  descriptor:x=>rewrite(x,'advisory-derivation',p=>{p.nativeAttention.purpose='ADVISORY_SEMANTICS';}),
  removedDescriptor:x=>rewrite(x,'advisory-derivation',p=>{delete p.nativeAttention;}),
  downversion:x=>rewrite(x,'advisory-derivation',p=>{p.method='advisory-provenance-v51';delete p.nativeAttention;}),
  futureVersion:x=>rewrite(x,'advisory-derivation',p=>{p.method='advisory-provenance-v61';}),
  missingCapture:x=>{delete x.rawArtifacts[NATIVE_ATTENTION_ID];x.evidence=x.evidence.filter(e=>e.id!==NATIVE_ATTENTION_ID);},
  orphanRaw:x=>{x.rawArtifacts['native-attention-orphan']='{}';},
  sourceId:x=>{x.evidence.find(e=>e.id===NATIVE_ATTENTION_ID)!.sourceId='gemini';},
  accessMode:x=>{x.evidence.find(e=>e.id===NATIVE_ATTENTION_ID)!.accessMode='FREE_ACCOUNT';},
  purposeScope:x=>{x.evidence.find(e=>e.id===NATIVE_ATTENTION_ID)!.scope.purpose='ADVISORY_SEMANTICS';},
  capturePurpose:x=>rewrite(x,NATIVE_ATTENTION_ID,p=>{p.purpose='ADVISORY_SEMANTICS';}),
  sourceBody:x=>rewrite(x,NATIVE_ATTENTION_ID,p=>{p.read.sources[0].text+=' fabricated assertion';}),
  prompt:x=>rewrite(x,NATIVE_ATTENTION_ID,p=>{p.executions[0].canonicalPrompt+=' ';}),
  response:x=>rewrite(x,NATIVE_ATTENTION_ID,p=>{p.executions[1].response.raw='{}';}),
  sourceClock:x=>{x.evidence.find(e=>e.id===NATIVE_ATTENTION_ID)!.availableAt=x.cutoff;},
  baseline:x=>{(row(x,'A01').data as Loose).summary='forged cached narrative';},
  projection:x=>{x.features.find(f=>f.id==='A02')!.value=false;},
  projectionEvidence:x=>{x.features.find(f=>f.id==='A01')!.evidenceIds=[];},
  baselineEvidence:x=>{row(x,'A01').evidenceIds=[];},
  semantic:x=>{x.semantic={status:'VALIDATED',claims:[]};},
  fakeModel:x=>{x.semantic.model='gemini-fictional';},
  directOtherFeature:x=>{x.features.find(f=>f.id==='O01')!.evidenceIds=[NATIVE_ATTENTION_ID];},
  directOtherBaseline:x=>{row(x,'A03').evidenceIds=[NATIVE_ATTENTION_ID];},
  otherMetric:x=>{metric(x,'A12').evidenceIds=[NATIVE_ATTENTION_ID];},
  c10:x=>{((metric(x).data as Loose).support[0]).truth='FALSE';},
  c10Closure:x=>{metric(x).evidenceIds=metric(x).evidenceIds.filter(id=>id!==NATIVE_ATTENTION_ID);},
 };
 await withDir((_dir,file)=>{const service=new Service(file);try{for(const [name,change] of Object.entries(mutations)){const x=structuredClone(b);change(x);assert.throws(()=>service.analyzeLive(x),Error,name);}}finally{service.close();}});
 const legacy=structuredClone(b);legacy.analysisKind='LIVE';assert.throws(()=>validateNativeAttentionBundle(legacy,false),/NATIVE_ATTENTION_PROOF_INVALID/,'USER_IMPORT cannot enter through ordinary bundle admission');
});

test('native live option and CLI reject incompatible modes before any provider IO',async()=>{
 let reads=0;const fetcher:typeof fetch=async()=>{reads++;throw Error('NO_PROVIDER_IO');};
 const base:LiveOptions={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,nativeAttentionCapture:'/absent/capture.json',fetcher,now:()=>CUTOFF};
 const choices:Partial<LiveOptions>[]=[{semanticEnabled:true},{advisoryEnabled:false},{o28Expanded:false},{semanticExecutor:async()=>{throw Error('NO_MODEL');}},{o22HolderAgeCapture:'absent'},{o26AccountCapture:'absent'},{o25LifetimeCapture:'absent'},{o24InventoryCapture:'absent'},{o23BulkCapture:'absent'},{o29ReservePath:true},{o30RegistryAbsence:true},{historicalTopicReuse:true},{a29Capture:'{}'},{a24Capture:'{}'},{recordedCallersCapture:'{}'},{recordedIncentivesCapture:'{}'},{creatorRoleOnly:true}];
 for(const choice of choices)await assert.rejects(collectLiveToken(NATIVE_TEST_TOKEN,{...base,...choice}),/NATIVE_ATTENTION_MODE_REQUIRED/);
 await assert.rejects(collectLiveToken({chain:'base',address:'0x1111111111111111111111111111111111111111'},base),/NATIVE_ATTENTION_MODE_REQUIRED/);
 await withDir(async dir=>{
  const runtime={env:{},isInteractive:false,fetcher,stdout:()=>{},stderr:(_s:string)=>{}};
  const standard=['analyze',NATIVE_TEST_TOKEN.address,'--chain','solana','--partial','--advisory','--o28-expanded','--native-attention-capture','/absent/capture.json','--config',join(dir,'config.json'),'--json'];
  const cases=[['analyze','--bundle','/absent','--native-attention-capture','/absent'],standard.filter(s=>s!=='--partial'),standard.filter(s=>s!=='--advisory'),standard.filter(s=>s!=='--o28-expanded'),[...standard,'--advisory-executor'],[...standard,'--o23-bulk-capture','/absent'],[...standard,'--creator-history'],standard.map(s=>s==='solana'?'base':s===NATIVE_TEST_TOKEN.address?'0x1111111111111111111111111111111111111111':s)];
  for(const args of cases){let error='';assert.equal(await runCli(args,{...runtime,stderr:s=>error+=s}),2,args.join(' '));assert.match(error,/NATIVE_ATTENTION_MODE_REQUIRED/,args.join(' '));}
 });
 assert.equal(reads,0);
});

test('strict native file import rejects malformed, oversize, symlink and foreign captures before live IO',async()=>{
 let reads=0;const fetcher:typeof fetch=async()=>{reads++;throw Error('NO_PROVIDER_IO');};
 await withDir(async dir=>{
  const good=JSON.stringify(await nativeAttentionFixture({acquiredAt:ACQUIRED})),bad=join(dir,'bad.json'),large=join(dir,'large.json'),foreign=join(dir,'foreign.json'),link=join(dir,'symlink.json'),source=join(dir,'source.json');
  writeFileSync(bad,'{malformed');writeFileSync(large,' '.repeat(8_000_001));writeFileSync(source,good);symlinkSync(source,link);
  const other=await nativeAttentionFixture({token:{chain:'solana',address:'11111111111111111111111111111111'},acquiredAt:ACQUIRED});writeFileSync(foreign,JSON.stringify(other));
  for(const file of [bad,large,foreign,link])await assert.rejects(collectLiveToken(NATIVE_TEST_TOKEN,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,nativeAttentionCapture:file,fetcher,now:()=>CUTOFF}),/NATIVE_ATTENTION_/);
 });
 assert.equal(reads,0);
});
