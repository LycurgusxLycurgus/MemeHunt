import {assertEntryCliSnapshot} from './entry-cli-snapshot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {collectLiveToken,type LiveOptions} from '../src/app/live.js';
import {starterProfile} from '../src/app/config.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {Service} from '../src/app/service.js';
import {runCli} from '../src/cli.js';
import {createA30SourceCapture,a30Sha} from './a30-fx-source-fixtures.js';
import {A30_SOURCE_PREFIX,A30_SOURCE_ID} from '../src/providers/advisory-demand-fx-source.js';

type Bundle=Awaited<ReturnType<typeof collectLiveToken>>;
const proof=(b:Bundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const metric=(b:Bundle,id='A30')=>b.details!.advisory!.metrics.find(m=>m.id===id)!;
const other=(b:Bundle)=>b.details!.advisory!.metrics.filter(m=>m.id!=='A30');
const invalid=/NATIVE_ATTENTION_|A12_ZERO_WITNESS_|A30_FX_|ADVISORY_A30_|ADVISORY_PROOF_INVALID|ARTIFACT_HASH_OR_SIZE|INVALID_ASSESSMENT_DETAILS|EVIDENCE/;
function changeProof(b:Bundle,mutate:(p:any)=>void){const p=proof(b);mutate(p);b.rawArtifacts['advisory-derivation']=JSON.stringify(p);b.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=a30Sha(b.rawArtifacts['advisory-derivation']!);}
const options=(f:ReturnType<typeof createA30SourceCapture>):LiveOptions=>({profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,fetcher:f.c5.fetcher,now:()=>f.cutoff});

test('constructed small native census selects proof60 and changes only A30 against identical proof51 sources',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a30-integration-'));try{
  const f=createA30SourceCapture(dir),base=options(f),old=await collectLiveToken(f.source.token,{...base,o28RpcErrors:true}),b=await collectLiveToken(f.source.token,{...base,a30FxCapture:dir}),p=proof(b),d=metric(b).data as any;
  assert.equal(p.method,'advisory-provenance-v60');assert.equal(b.details!.advisory!.method,'advisory-measurements-v59');assert.equal(metric(b).quality,'KNOWN');assert.equal(d.method,'complete-pool-baseline-demand-fx-cells-v1');assert.equal(d.financialPurpose,'A30_DEMAND_WINDOWS_ONLY');assert.equal(d.quoteDecimals,8);assert.equal(d.denominator,6);assert.equal(d.fx.identityBankPriceUsed,false);
  for(const k of ['synchronyBulk','inventoryReturns','holderAge','creatorInventoryBulk','creatorLifetimeBank','nativeAttention','exitCapacity'])assert.ok(!p[k]);
  assert.deepEqual(b.features,old.features);assert.deepEqual(b.details!.baseline,old.details!.baseline);assert.deepEqual(other(b),other(old));assert.deepEqual(reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,p,b.thesis??null,b.features),b.details!.advisory);
  const owned=b.evidence.filter(e=>e.sourceId===A30_SOURCE_ID);assert.equal(owned.length,Object.keys(f.source.rawArtifacts).length);for(const e of owned){const key=e.id.slice(A30_SOURCE_PREFIX.length);assert.equal(b.rawArtifacts[e.id],f.source.rawArtifacts[key]);assert.equal(e.availableAt,f.source.retrievedAt[key]);assert.equal(e.retrievedAt,e.availableAt);assert.deepEqual(e.scope,{request:f.source.requests[key]});assert.equal(e.sourceType,'HISTORICAL_RECEIPT');assert.equal(e.accessMode,'USER_IMPORT');}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('proof60 saves, reconstructs and reopens idempotently; CLI replay needs no network',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a30-save-'));try{
  const f=createA30SourceCapture(dir),b=await collectLiveToken(f.source.token,{...options(f),a30FxCapture:dir}),dbfile=join(dir,'saved.sqlite');let saved;let s=new Service(dbfile);
  try{saved=s.analyzeLive(b);assert.equal(s.analyzeLive(b).id,saved.id);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
  s=new Service(dbfile);try{assert.deepEqual(s.show(saved.id),saved);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
  const db=new DatabaseSync(dbfile);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string).policyVersion,'research-screen-advisory-v57');}finally{db.close();}
  let out='',err='',reads=0;assert.equal(await runCli(['replay',saved.id,'--db',dbfile,'--json'],{env:{},isInteractive:false,fetcher:async()=>{reads++;throw Error('NETWORK_DENIED');},stdout:x=>out+=x,stderr:x=>err+=x}),0,err);assert.equal(reads,0);assertEntryCliSnapshot(JSON.parse(out),saved);
  // The import directory is exact: remove databases before using it as a CLI input.
  rmSync(dbfile);rmSync(dbfile+'-wal',{force:true});rmSync(dbfile+'-shm',{force:true});rmSync(join(dir,'artifacts'),{recursive:true,force:true});out='';err='';
  const outputDir=mkdtempSync(join(tmpdir(),'a30-cli-output-'));try{assert.equal(await runCli(['analyze',f.source.token.address,'--chain','solana','--partial','--advisory','--o28-expanded','--a30-fx-capture',dir,'--db',join(outputDir,'cli.sqlite'),'--config',join(outputDir,'config.json'),'--json'],{env:{},isInteractive:false,fetcher:f.c5.fetcher,now:()=>f.cutoff,stdout:x=>out+=x,stderr:x=>err+=x}),0,err);assert.equal(JSON.parse(out).details.advisory.metrics.find((m:any)=>m.id==='A30').quality,'KNOWN');}finally{rmSync(outputDir,{recursive:true,force:true});}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('A30 source authority cannot cross versions, source bindings, other metrics or entry boundaries',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a30-authority-'));try{const f=createA30SourceCapture(dir),b=await collectLiveToken(f.source.token,{...options(f),a30FxCapture:dir}),s=new Service(':memory:');try{
  const own=b.evidence.find(e=>e.sourceId===A30_SOURCE_ID)!.id;
  const changes:Array<[string,(b:Bundle)=>void]>=[
   ['descriptor absent',b=>changeProof(b,p=>delete p.a30Fx)],['downgrade59',b=>changeProof(b,p=>p.method='advisory-provenance-v59')],['downgrade51 stripped',b=>changeProof(b,p=>{p.method='advisory-provenance-v51';delete p.a30Fx;})],['future61',b=>changeProof(b,p=>p.method='advisory-provenance-v61')],
   ['purpose',b=>changeProof(b,p=>p.a30Fx.purpose='O29_RESERVE_PATH_ONLY')],['pool',b=>changeProof(b,p=>p.a30Fx.pool='11111111111111111111111111111111')],['request',b=>changeProof(b,p=>p.a30Fx.requests['fx-index-0'].params[1].limit=999)],
   ['cache',b=>(metric(b).data as any).share='1'],['raw',b=>b.rawArtifacts[own]+=' '],['source',b=>b.evidence.find(e=>e.id===own)!.sourceId='advisory-synchrony-bulk'],['adapter',b=>b.evidence.find(e=>e.id===own)!.adapterVersion='live-v1'],['clock',b=>b.evidence.find(e=>e.id===own)!.availableAt=b.cutoff],['scope',b=>b.evidence.find(e=>e.id===own)!.scope={purpose:'A30'}],
   ['orphan raw',b=>b.rawArtifacts[A30_SOURCE_PREFIX+'orphan']='{}'],['entry',b=>b.features[0]!.evidenceIds.push(own)],['baseline',b=>b.details!.baseline[0]!.evidenceIds.push(own)],
   ...other(b).map(m=>[m.id,(b:Bundle)=>metric(b,m.id).evidenceIds.push(own)] as [string,(b:Bundle)=>void]),
  ];for(const [label,mutate]of changes){const copy=structuredClone(b);mutate(copy);assert.throws(()=>s.analyzeLive(copy),invalid,label);}
  assert.throws(()=>s.analyze({token:b.token,cutoff:b.cutoff,analysisKind:'USER_IMPORT',features:b.features,evidence:b.evidence,rawArtifacts:b.rawArtifacts,profile:b.profile,observations:b.observations}),invalid);
 }finally{s.close();}}finally{rmSync(dir,{recursive:true,force:true});}
});

test('A30 CLI/live incompatible modes and malformed import fail before source or network collection',async()=>{
 let reads=0;const fetcher:typeof fetch=async()=>{reads++;throw Error('NETWORK_DENIED');},token={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'},base:LiveOptions={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,a30FxCapture:'/absent-a30',fetcher};
 const bad:Array<Partial<LiveOptions>>=[{semanticEnabled:true},{advisoryEnabled:false},{o28Expanded:false},{research:{} as any},{semanticExecutor:{} as any},{a12ZeroWitnessCapture:'absent'},{nativeAttentionCapture:'absent'},{a12CandidateSet:{} as any},{a12ZeroShare:true},{o22HolderAgeCapture:'absent'},{o26AccountCapture:'absent'},{o25LifetimeCapture:'absent'},{o24InventoryCapture:'absent'},{o23BulkCapture:'absent'},{o29ReservePath:true},{o30RegistryAbsence:true},{historicalTopicReuse:true},{a24Capture:'absent'},{a29Capture:'absent'},{recordedCallersCapture:'absent'},{recordedIncentivesCapture:'absent'},{creatorRoleOnly:true}];
 for(const v of bad)await assert.rejects(collectLiveToken(token,{...base,...v}),/A30_FX_MODE_REQUIRED/);await assert.rejects(collectLiveToken({chain:'bsc',address:'0x1111111111111111111111111111111111111111'},base),/A30_FX_MODE_REQUIRED/);
 const cli=['analyze',token.address,'--partial','--advisory','--o28-expanded','--a30-fx-capture','absent'];for(const argv of [['analyze','--bundle','absent','--a30-fx-capture','absent'],cli.filter(v=>v!=='--partial'),cli.filter(v=>v!=='--advisory'),cli.filter(v=>v!=='--o28-expanded'),[...cli,'--full'],[...cli,'--native-attention-capture','absent'],[...cli,'--a12-zero-witness-capture','absent'],[...cli,'--advisory-executor']]){let err='';assert.equal(await runCli(argv,{env:{},isInteractive:false,fetcher,stdout:()=>{},stderr:x=>err+=x}),2);assert.match(err,/A30_FX_MODE_REQUIRED|A12_ZERO_WITNESS_REQUIRED|NATIVE_ATTENTION_MODE_REQUIRED|ANALYSIS_MODES_CONFLICT/);}
 const dir=mkdtempSync(join(tmpdir(),'a30-bad-'));try{writeFileSync(join(dir,'capture.json'),'{}');await assert.rejects(collectLiveToken(token,{...base,a30FxCapture:dir}),/ADVISORY_A30_IMPORT_MANIFEST/);}finally{rmSync(dir,{recursive:true,force:true});}assert.equal(reads,0);
});
