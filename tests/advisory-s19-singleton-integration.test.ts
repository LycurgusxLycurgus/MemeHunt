import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {collectLiveToken} from '../src/app/live.js';
import {starterProfile,starterConfig} from '../src/app/config.js';
import {runCli} from '../src/cli.js';
import {validateS19SingletonBundle,validateS19SingletonCore,s19SingletonDescriptor,s19SingletonDescriptorSchema} from '../src/app/s19-singleton.js';
import {S19_SOURCE_ID,S19_SOURCE_PREFIX,S19_CAPTURE_ID,S19_ADAPTER,S19_PURPOSE,S19_EVIDENCE_IDS,loadS19Capture,validateS19Source,s19Scope,s19Hash,type S19WireRecord} from '../src/providers/advisory-s19-singleton-source.js';
import {Service} from '../src/app/service.js';
import {advisoryProofSchema} from '../src/app/advisory.js';
import {advisoryFactsSchema,advisoryGroups} from '../src/domain/advisory-contracts.js';
import type {EvidenceRecord,LiveBundle} from '../src/domain/contracts.js';
import {a29LiveFetcher} from './a29-fixtures.js';

const token={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'};
const cutoff='2026-11-05T00:00:00.000Z';
// The genuine retained C5 portable S19 capture of advisory-s19-singleton-source.test.ts, byte for byte. The surrounding
// ordinary bundle comes from the labelled offline a29 fixture reads and is never presented as genuine provider data.
const portable=gunzipSync(readFileSync('tests/fixtures/s19-creator-singleton-birth.json.gz')).toString('utf8');
const ordinaryRun=()=>collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,now:()=>cutoff,fetcher:a29LiveFetcher(token.address,cutoff)});
const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const proofOf=(b:LiveBundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!) as Record<string,unknown>;
function setProof(b:LiveBundle,edit:(proof:Record<string,unknown>)=>void){const proof=proofOf(b);edit(proof);const raw=JSON.stringify(proof);b.rawArtifacts['advisory-derivation']=raw;b.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=sha(raw);}
function withCapture<T>(run:(file:string,dir:string)=>T):T{const dir=mkdtempSync(join(tmpdir(),'s19-integration-'));try{const file=join(dir,'capture.json');writeFileSync(file,portable);return run(file,dir);}finally{rmSync(dir,{recursive:true,force:true});}}
/** Appends the five owned records as the live collector stores them: original receipt clocks, USER_IMPORT, ordinary storage. */
function withRecords(ordinary:LiveBundle,records:S19WireRecord[]):LiveBundle{
 const b=structuredClone(ordinary);
 for(const r of records){b.rawArtifacts[r.id]=r.raw;b.evidence.push({id:r.id,sourceId:S19_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT',accessMode:'USER_IMPORT',adapterVersion:S19_ADAPTER,scope:r.scope,retrievedAt:r.retrievedAt,availableAt:r.retrievedAt,contentHash:s19Hash(r.raw)});}
 return b;
}
/** Constructed proof73/facts72 envelope over the ordinary bundle; its S19 row is the provider recomputation from the owned raw records, never a cached value. */
function genuine(ordinary:LiveBundle,records:S19WireRecord[]):LiveBundle{
 const b=withRecords(ordinary,records);
 setProof(b,p=>{p.method='advisory-provenance-v73';p.s19Singleton=s19SingletonDescriptor();});
 const metric=validateS19Source(token,cutoff,b.evidence,b.rawArtifacts).metric,facts=b.details!.advisory!,index=facts.metrics.findIndex(m=>m.id==='S19');
 assert.ok(index>=0,'S19 is a registered advisory metric row');
 facts.metrics[index]=metric;facts.method='advisory-measurements-v72';
 facts.groups=advisoryGroups.map(group=>{const unresolved=group.featureIds.filter(id=>facts.metrics.find(m=>m.id===id)!.quality!=='KNOWN');return{checkId:group.checkId,total:group.featureIds.length,known:group.featureIds.length-unresolved.length,unresolved};});
 return b;
}

// These checks exercise public mode, storage, CLI and schema boundaries.
test('S19 mode rejects incompatible source/semantic/execution boundaries before any file/API read',async()=>{
 let reads=0;const options={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,s19GroupsCapture:'/nonexistent-s19-capture.json',fetcher:async()=>{reads++;throw Error('UNEXPECTED_API');}};
 for(const other of [{s16CopyCapture:'/other'},{s17InventoryCapture:'/other'},{s14EntryCapture:'/other'},{a27MarginalCapture:'/other'},{advisoryEnabled:false},{semanticEnabled:true},{a26BuyerPostCapture:'/other'},{a25LeadLagCapture:'/other'},{s15ReferenceCapture:'/other'},{a13ParticipationCapture:'/other'},{c12BridgeCapture:'/other'},{a30FxCapture:'/other'},{nativeAttentionCapture:'/other'},{o25LifetimeCapture:'/other'},{a29Capture:'/other'},{creatorRoleOnly:true},{wbtcEntry:true},{executableLiquidity:true},{o28Expanded:true}])await assert.rejects(()=>collectLiveToken(token,{...options,...other}),/S19_SINGLETON_MODE_REQUIRED|C12_BRIDGE_MODE_REQUIRED/);
 await assert.rejects(()=>collectLiveToken({chain:'base',address:'0x0000000000000000000000000000000000000001'},options),/S19_SINGLETON_MODE_REQUIRED/);
 // A compatible mode opens its named file before any provider read.
 await assert.rejects(()=>collectLiveToken(token,options),/ENOENT/);assert.equal(reads,0);
});

test('CLI requires S19 file value before API or database creation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'s19-cli-boundary-'));try{
  const config=join(dir,'config.json'),raw=JSON.stringify(starterConfig());writeFileSync(config,raw);
  for(const [name,tail]of [['missing',[]],['following',['--json']]]as const){let reads=0;const out:string[]=[],err:string[]=[],db=join(dir,name+'.sqlite');const code=await runCli(['analyze',token.address,'--partial','--advisory','--config',config,'--db',db,'--s19-groups-capture',...tail],{env:{},isInteractive:false,stdout:s=>out.push(s),stderr:s=>err.push(s),fetcher:async()=>{reads++;throw Error('UNEXPECTED_API');}});assert.equal(code,2);assert.match(err.join(''),/^FLAG_VALUE_REQUIRED:/);assert.equal(reads,0);assert.equal(existsSync(db),false);assert.equal(out.join(''),'');assert.equal(readFileSync(config,'utf8'),raw);}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('ordinary advisory stays outside S19 while forged, orphan, foreign-owned and descriptor-only grafts are refused before storage',async()=>{
 const ordinary=await ordinaryRun(),proof=proofOf(ordinary);
 assert.equal(proof.method,'advisory-provenance-v40');assert.equal('s19Singleton' in proof,false);
 assert.ok(!ordinary.evidence.some(e=>e.id.startsWith(S19_SOURCE_PREFIX)||e.sourceId===S19_SOURCE_ID||e.adapterVersion===S19_ADAPTER));
 assert.equal(validateS19SingletonCore({token,cutoff,evidence:ordinary.evidence,rawArtifacts:ordinary.rawArtifacts,baseline:ordinary.details!.baseline,features:ordinary.features},proof),undefined);
 assert.doesNotThrow(()=>validateS19SingletonBundle(ordinary,true));assert.doesNotThrow(()=>validateS19SingletonBundle(ordinary,false));
 const fabricated=JSON.stringify({fabricated:true});
 const forged=(id:string,patch:Partial<EvidenceRecord>={}):EvidenceRecord=>({id,sourceId:S19_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT',accessMode:'USER_IMPORT',adapterVersion:S19_ADAPTER,availableAt:cutoff,retrievedAt:cutoff,contentHash:s19Hash(fabricated),scope:s19Scope('CAPTURE'),...patch});
 const variants:Array<[string,(b:LiveBundle)=>void]>=[
  ['forged capture',b=>{b.rawArtifacts[S19_CAPTURE_ID]=fabricated;b.evidence.push(forged(S19_CAPTURE_ID));}],
  ['forged role receipt',b=>{const id=S19_SOURCE_PREFIX+'role-page';b.rawArtifacts[id]=fabricated;b.evidence.push(forged(id,{scope:s19Scope('role-page')}));}],
  ['orphan capture raw',b=>{b.rawArtifacts[S19_CAPTURE_ID]=fabricated;}],
  ['orphan reserved role raw',b=>{b.rawArtifacts[S19_SOURCE_PREFIX+'role-transaction']=fabricated;}],
  ['S19 source on foreign id',b=>{b.rawArtifacts['advisory-s19-foreign']=fabricated;b.evidence.push(forged('advisory-s19-foreign'));}],
  ['S19 adapter on foreign source',b=>{b.rawArtifacts['advisory-foreign-record']=fabricated;b.evidence.push(forged('advisory-foreign-record',{sourceId:'advisory-foreign'}));}],
  ['reserved id under ordinary source',b=>{const id=S19_SOURCE_PREFIX+'callers';b.rawArtifacts[id]=fabricated;b.evidence.push(forged(id,{sourceId:'advisory-chain',adapterVersion:'live-v1',accessMode:'PUBLIC_API'}));}],
  ['descriptor without source on proof73',b=>setProof(b,p=>{p.method='advisory-provenance-v73';p.s19Singleton=s19SingletonDescriptor();})],
  ['proof73 without descriptor or source',b=>setProof(b,p=>{p.method='advisory-provenance-v73';})],
  ['descriptor on ordinary40',b=>setProof(b,p=>{p.s19Singleton=s19SingletonDescriptor();})],
  ['descriptor on proof72',b=>setProof(b,p=>{p.method='advisory-provenance-v72';p.s19Singleton=s19SingletonDescriptor();})],
 ];
 const dir=mkdtempSync(join(tmpdir(),'s19-storage-boundary-'));try{
  const service=new Service(join(dir,'test.sqlite'));try{
   for(const [name,edit] of variants){const b=structuredClone(ordinary);edit(b);assert.throws(()=>validateS19SingletonBundle(b,true),/S19_SINGLETON_/,name);assert.throws(()=>validateS19SingletonBundle(b,false),/S19_SINGLETON_/,name);assert.throws(()=>service.analyzeLive(b),Error,name);}
  }finally{service.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('genuine C5 S19 source atop the ordinary bundle grants only its recomputed S19 metric and quarantines every other citation or authority',async()=>{
 const ordinary=await ordinaryRun();
 withCapture((file,dir)=>{
  const records=loadS19Capture(file,token,cutoff).records;assert.deepEqual(records.map(r=>r.id),[...S19_EVIDENCE_IDS]);
  const positive=genuine(ordinary,records);
  const resolved=validateS19SingletonCore({token,cutoff,evidence:positive.evidence,rawArtifacts:positive.rawArtifacts,baseline:positive.details!.baseline,features:positive.features},proofOf(positive));
  assert.ok(resolved);assert.deepEqual(resolved.ids,[...S19_EVIDENCE_IDS]);assert.equal(resolved.metric.quality,'KNOWN');
  assert.deepEqual((resolved.metric.data as {observedEntrantGroups:unknown}).observedEntrantGroups,{value:1,unit:'ACTOR_GROUP_WITHIN_COHORT',globalPointValue:null});
  assert.equal(advisoryFactsSchema.safeParse(positive.details!.advisory).success,true);
  assert.doesNotThrow(()=>validateS19SingletonBundle(positive,true));
  assert.throws(()=>validateS19SingletonBundle(positive,false),/S19_SINGLETON_PROOF_INVALID/);
  const id=S19_SOURCE_PREFIX+'role-transaction',s19=(b:LiveBundle)=>b.details!.advisory!.metrics.find(m=>m.id==='S19')!,other=(b:LiveBundle)=>b.details!.advisory!.metrics.find(m=>m.id!=='S19')!;
  const grafts:Array<[string,(b:LiveBundle)=>void]>=[
   ['feature',b=>{b.features.push({id:'S19-GRAFT',value:true,unit:'bool',quality:'KNOWN',availableAt:cutoff,evidenceIds:[id],applicability:'APPLICABLE'});}],
   ['baseline',b=>{b.details!.baseline[0]!.evidenceIds.push(id);}],
   ['nested baseline data',b=>{(b.details!.baseline[0] as {data:unknown}).data={graft:[id]};}],
   ['other metric',b=>{other(b).evidenceIds.push(id);}],
   ['nested other metric data',b=>{other(b).data={graft:{ids:[id]}};}],
   ['short-demand supplement',b=>{b.details!.advisory!.supplements!.shortDemand.evidenceIds.push(id);}],
   ['observation',b=>{b.observations.push({id:'obs-s19-graft',subject:token,field:'s19Graft',value:null,unit:'enum',evidenceIds:[id],observedAt:cutoff,availableAt:cutoff,quality:'KNOWN'});}],
   ['semantic claim',b=>{b.semantic.claims.push({kind:'NARRATIVE',value:'graft',evidenceId:id,quote:'grafted S19 quote',assertion:'SOURCE_STATES'});}],
   ['exit proof context',b=>{(b as {exitProofs?:unknown}).exitProofs=[{evidenceIds:[id]}];}],
   ['shared authority',b=>{Object.assign(b.details!,{shared:{}});}],
   ['groups authority',b=>{Object.assign(b.details!,{groups:{}});}],
   ['social authority',b=>{Object.assign(b.details!,{social:{}});}],
   ['executable-liquidity authority',b=>{Object.assign(b.details!,{executableLiquidity:{}});}],
   ['facts71 downgrade',b=>{b.details!.advisory!.method='advisory-measurements-v71';}],
   ['proof72 downgrade',b=>setProof(b,p=>{p.method='advisory-provenance-v72';})],
   ['proof70 downgrade',b=>setProof(b,p=>{p.method='advisory-provenance-v70';})],
   ['descriptor dropped',b=>setProof(b,p=>{delete p.s19Singleton;})],
   ['descriptor sourcePath',b=>setProof(b,p=>{p.s19Singleton={...s19SingletonDescriptor(),sourcePath:join(dir,'capture.json')};})],
   ['descriptor foreign purpose',b=>setProof(b,p=>{p.s19Singleton={...s19SingletonDescriptor(),purpose:'CREATOR_BIRTH_ENTRY_VS_OBSERVED_INDEPENDENT_CALLS'};})],
   ['proof cutoff',b=>setProof(b,p=>{p.cutoff='2026-11-04T23:00:00.000Z';})],
   ['duplicate S19 metric',b=>{b.details!.advisory!.metrics.push(structuredClone(s19(b)));}],
   ['missing S19 metric',b=>{b.details!.advisory!.metrics=b.details!.advisory!.metrics.filter(m=>m.id!=='S19');}],
   ['tampered S19 metric',b=>{(s19(b).data as {observedEntrantGroups:{value:number}}).observedEntrantGroups.value=2;}],
   ['missing owned record',b=>{b.evidence=b.evidence.filter(e=>e.id!==S19_SOURCE_PREFIX+'role-index');}],
   ['extra reserved raw',b=>{b.rawArtifacts[S19_SOURCE_PREFIX+'callers']=JSON.stringify([]);}],
  ];
  const service=new Service(join(dir,'test.sqlite'));try{
   for(const [name,graft] of grafts){const b=structuredClone(positive);graft(b);assert.throws(()=>validateS19SingletonBundle(b,true),/S19_SINGLETON_/,name);assert.throws(()=>service.analyzeLive(b),Error,name);}
  }finally{service.close();}
 });
});

test('public S19 collection stores the genuine source in ordinary storage, recomputes only S19 and leaves every ordinary output unchanged',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'s19-public-'));try{
  const file=join(dir,'capture.json');writeFileSync(file,portable);
  const records=loadS19Capture(file,token,cutoff).records,ordinary=await ordinaryRun();
  const live=await collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,s19GroupsCapture:file,now:()=>cutoff,fetcher:a29LiveFetcher(token.address,cutoff)});
  const proof=proofOf(live);assert.equal(proof.method,'advisory-provenance-v73');assert.deepEqual(proof.s19Singleton,s19SingletonDescriptor());assert.equal(advisoryProofSchema.safeParse(proof).success,true);
  assert.ok(!JSON.stringify(live).includes(dir),'no capture path is stored');
  const owned=live.evidence.filter(e=>e.id.startsWith(S19_SOURCE_PREFIX));assert.deepEqual(owned.map(e=>e.id),[...S19_EVIDENCE_IDS]);
  for(const r of records){const e=owned.find(e=>e.id===r.id)!;assert.equal(e.sourceId,S19_SOURCE_ID);assert.equal(e.accessMode,'USER_IMPORT');assert.equal(e.adapterVersion,S19_ADAPTER);assert.equal(e.retrievedAt,r.retrievedAt);assert.equal(e.availableAt,r.retrievedAt);assert.equal(live.rawArtifacts[r.id],r.raw);}
  const facts=live.details!.advisory!,metric=validateS19Source(token,cutoff,live.evidence,live.rawArtifacts).metric;
  assert.equal(facts.method,'advisory-measurements-v72');assert.deepEqual(facts.metrics.filter(m=>m.id==='S19'),[metric]);
  assert.deepEqual(facts.metrics.filter(m=>m.id!=='S19'),ordinary.details!.advisory!.metrics.filter(m=>m.id!=='S19'));
  assert.deepEqual(live.features,ordinary.features);assert.deepEqual(live.details!.baseline,ordinary.details!.baseline);assert.deepEqual(live.observations,ordinary.observations);
  assert.doesNotThrow(()=>validateS19SingletonBundle(live,true));
  let id='';
  const service=new Service(join(dir,'s19.sqlite'));try{
   const first=service.analyzeLive(live),again=service.analyzeLive(structuredClone(live));assert.equal(again.id,first.id);id=first.id;
   const control=new Service(join(dir,'ordinary.sqlite'));try{const base=control.analyzeLive(ordinary);assert.equal(first.result.binary,base.result.binary);assert.equal(first.result.classification,base.result.classification);}finally{control.close();}
  }finally{service.close();}
  const reopened=new Service(join(dir,'s19.sqlite'));try{assert.equal(reopened.show(id).id,id);assert.equal(reopened.replay(id).id,id);}finally{reopened.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('facts72 keeps the mandatory ordinary short-demand supplement and proof73 admits only the strict S19 descriptor without a source path',async()=>{
 const ordinary=await ordinaryRun();
 const facts=ordinary.details!.advisory!;assert.ok(facts.supplements?.shortDemand);
 // Schema-only version admission: these constructed facts and proofs carry no source authority.
 for(const method of ['advisory-measurements-v71','advisory-measurements-v72'] as const){
  const current={...facts,method};assert.equal(advisoryFactsSchema.safeParse(current).success,true,method);
  const {supplements,...missing}=current;assert.equal(advisoryFactsSchema.safeParse(missing).success,false,method);
 }
 const proof=proofOf(ordinary);
 assert.equal(advisoryProofSchema.safeParse(proof).success,true);
 assert.equal(advisoryProofSchema.safeParse({...proof,method:'advisory-provenance-v73',s19Singleton:s19SingletonDescriptor()}).success,true);
 for(const descriptor of [{...s19SingletonDescriptor(),sourcePath:'/tmp/s19-capture.json'},{method:S19_ADAPTER,purpose:S19_PURPOSE},{...s19SingletonDescriptor(),captureId:S19_SOURCE_PREFIX+'genesis'},{...s19SingletonDescriptor(),method:'s19-creator-singleton-birth-capture-v1'}]){
  assert.equal(s19SingletonDescriptorSchema.safeParse(descriptor).success,false);
  assert.equal(advisoryProofSchema.safeParse({...proof,method:'advisory-provenance-v73',s19Singleton:descriptor}).success,false);
 }
});
