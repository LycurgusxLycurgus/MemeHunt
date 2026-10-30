import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {collectLiveToken,type LiveOptions} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {starterProfile} from '../src/app/config.js';
import {Service} from '../src/app/service.js';
import {runCli} from '../src/cli.js';
import {A12_WITNESS_ID,A12_WITNESS_SOURCE,A12_WITNESS_METHOD,A12_WITNESS_PURPOSE,a12WitnessScope,a12WitnessSourcesFromAcquisition} from '../src/providers/advisory-exit-capacity-witness.js';
import {rebindA12WitnessFixture} from './a12-witness-source-fixtures.js';
import {a12WitnessIntegrationFixture} from './a12-witness-integration-fixtures.js';
import {a12ZeroShareHash} from './a12-zero-share-fixtures.js';

type Bundle=Awaited<ReturnType<typeof collectLiveToken>>;
const proof=(b:Bundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const metric=(b:Bundle,id='A12')=>b.details!.advisory!.metrics.find(m=>m.id===id)!;
const other=(b:Bundle)=>b.details!.advisory!.metrics.filter(m=>m.id!=='A12');
const invalid=/ADVISORY_PROOF_INVALID|ADVISORY_EXIT_CAPACITY_|A12_ZERO_WITNESS_|A12_WITNESS_|ARTIFACT_HASH_OR_SIZE|EVIDENCE|INVALID_ASSESSMENT_DETAILS|NATIVE_ATTENTION_/;
function stamp(b:Bundle,id:string,raw:string){b.rawArtifacts[id]=raw;const e=b.evidence.find(e=>e.id===id);if(e)e.contentHash=a12ZeroShareHash(raw);}
function changeProof(b:Bundle,change:(p:any)=>void){const p=proof(b);change(p);stamp(b,'advisory-derivation',JSON.stringify(p));}
function changeSource(b:Bundle,change:(c:ReturnType<typeof a12WitnessIntegrationFixture>['capture'])=>void){const c=JSON.parse(b.rawArtifacts[A12_WITNESS_ID]!);change(c);const raw=JSON.stringify(c);stamp(b,A12_WITNESS_ID,raw);b.evidence.find(e=>e.id===A12_WITNESS_ID)!.scope=a12WitnessScope(raw);}
async function collected(dir:string,f=a12WitnessIntegrationFixture(),name='capture.json'){
 const file=join(dir,name);writeFileSync(file,JSON.stringify(f.capture));
 const b=await collectLiveToken(f.token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,a12ZeroWitnessCapture:file,fetcher:f.fetcher,now:()=>f.cutoff});return {f,file,b};
}

test('constructed pair proof58 identifies target zero from genuine native account objects without completing membership',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a12-witness-pair-'));try{
  const {f,b}=await collected(dir),p=proof(b),d=metric(b).data as any,control=a12WitnessIntegrationFixture();
  const old=await collectLiveToken(control.token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,o28RpcErrors:true,fetcher:control.fetcher,now:()=>control.cutoff});
  assert.equal(p.method,'advisory-provenance-v58');assert.equal(b.details!.advisory!.method,'advisory-measurements-v57');assert.equal(proof(old).method,'advisory-provenance-v51');
  assert.deepEqual(Object.keys(p.exitCapacity).sort(),['artifactIds','comparisonMode','impactBps','requests','witnessCaptureId'].sort());assert.equal(p.exitCapacity.witnessCaptureId,A12_WITNESS_ID);assert.equal(p.exitCapacity.comparisonMode,'zero-target-positive-witness-invariant-v1');assert.equal(p.exitCapacity.impactBps,'300');
  assert.equal(metric(b).quality,'KNOWN');assert.equal(metric(b).reasonCode,'ZERO_TARGET_CAPACITY_SHARE_WITNESS_IDENTIFIED');assert.equal(d.method,'impact-bounded-zero-witness-capacity-share-v1');assert.equal(d.share,'0');assert.equal(d.denominatorAtomic,null);assert.equal(d.quoteMint,null);assert.equal(d.quoteDecimals,null);assert.equal(d.membershipComplete,false);assert.equal(d.comparison.membershipComplete,false);assert.equal(d.comparison.denominatorStatus,'POSITIVE_UNVALUED');assert.equal(d.comparison.normalization,'NOT_PERFORMED');assert.equal(d.candidates.length,2);
  assert.equal(d.candidates[0].token.address,f.token.address);assert.equal(d.candidates[0].capacityAtomic,'0');assert.equal(d.candidates[0].inputAtomic,'0');assert.equal(d.candidates[0].boundary.status,'KNOWN');assert.equal(d.candidates[1].token.address,f.capture.witness.address);assert.equal(d.candidates[1].status,'KNOWN');assert.ok(BigInt(d.candidates[1].capacityAtomic)>0n);assert.equal(d.candidates[1].share,null);assert.equal(d.comparison.positiveCapacityWitnesses.length,1);assert.equal(d.comparison.reference.baseMint,f.token.address);
  assert.equal(d.diagnostics.knownLeads.length,4);assert.equal(d.diagnostics.knownLeads.find((l:any)=>l.token.address==='DwbzUqrJGdQZQNCBfwD1Y3Tmp8wtzhJ19J2yiSsapump').status,'UNRESOLVED_RESEARCH_LEAD');for(const lead of d.diagnostics.knownLeads)assert.ok(!d.candidates.some((c:any)=>c.token.address===lead.token.address));
  assert.deepEqual(b.features,old.features);assert.deepEqual(b.details!.baseline,old.details!.baseline);assert.deepEqual(other(b),other(old));assert.deepEqual(reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,p,b.thesis??null,b.features),b.details!.advisory);
  const source=b.evidence.find(e=>e.id===A12_WITNESS_ID)!;assert.equal(source.sourceId,A12_WITNESS_SOURCE);assert.equal(source.sourceType,'MODEL_EXECUTION');assert.equal(source.accessMode,'USER_IMPORT');assert.equal(source.adapterVersion,A12_WITNESS_METHOD);assert.deepEqual(source.scope,a12WitnessScope(b.rawArtifacts[A12_WITNESS_ID]!));assert.equal(source.availableAt,f.capture.createdAt);assert.equal(b.rawArtifacts[A12_WITNESS_ID],JSON.stringify(f.capture));assert.equal(d.candidateSourceHash,a12ZeroShareHash(b.rawArtifacts[A12_WITNESS_ID]!));
  const stored=JSON.parse(b.rawArtifacts[A12_WITNESS_ID]!);assert.equal(stored.purpose,A12_WITNESS_PURPOSE);assert.equal(stored.diagnostics.membershipComplete,false);assert.equal(JSON.parse(stored.executions[1].response.raw).candidateSet.complete,false);assert.equal(stored.executions[1].response.transportRaw,f.capture.executions[1].response.transportRaw);assert.deepEqual(a12WitnessSourcesFromAcquisition(stored.acquisition).sources,stored.sources);
  assert.equal(f.projections.length,2);assert.deepEqual(f.projections.map(x=>x.kind),['discovery','bank']);assert.equal(f.projections[0]!.request.params[0].length,4);
  for(const projected of f.projections){const original=f.native.records.find((r:any)=>r.id===projected.kind),native=JSON.parse(original.raw).result,constructed=JSON.parse(projected.raw).result;assert.deepEqual(constructed.context,native.context);assert.notEqual(projected.raw,original.raw,'these pair-sized envelopes are constructed, not the historical six-lead RPC bytes');for(const [i,key]of projected.request.params[0].entries())assert.deepEqual(constructed.value[i],native.value[original.request.params[0].indexOf(key)]);assert.equal(a12ZeroShareHash(original.raw),projected.nativeSourceHash);}
  for(const e of b.evidence.filter(e=>e.sourceId==='advisory-exitCapacity')){assert.equal(e.sourceType,'HISTORICAL_RECEIPT');assert.equal(e.accessMode,'PUBLIC_API');assert.deepEqual(Object.keys(e.scope),['request']);}
  for(const k of ['nativeAttention','holderAge','inventoryReturns','creatorInventoryBulk','creatorLifetimeBank','synchronyBulk'])assert.equal(p[k],undefined);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('witness proof saves idempotently, reopens, reconstructs raw bytes and uses no network for CLI replay',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a12-witness-save-'));try{
  const {f,file,b}=await collected(dir),dbfile=join(dir,'live.sqlite');let saved;let service=new Service(dbfile);
  try{saved=service.analyzeLive(b);assert.equal(service.analyzeLive(b).id,saved.id);assert.deepEqual(service.replay(saved.id),saved);}finally{service.close();}
  service=new Service(dbfile);try{assert.deepEqual(service.show(saved.id),saved);assert.deepEqual(service.replay(saved.id),saved);}finally{service.close();}
  const db=new DatabaseSync(dbfile);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string).policyVersion,'research-screen-advisory-v55');}finally{db.close();}
  let out='',err='',reads=0;const denied:typeof fetch=async()=>{reads++;throw Error('NETWORK_DENIED');};
  assert.equal(await runCli(['replay',saved.id,'--db',dbfile,'--json'],{env:{},isInteractive:false,fetcher:denied,stdout:x=>out+=x,stderr:x=>err+=x}),0,err);assert.equal(reads,0);assert.deepEqual(JSON.parse(out),saved);
  out='';err='';assert.equal(await runCli(['analyze',f.token.address,'--chain','solana','--partial','--advisory','--o28-expanded','--a12-zero-witness-capture',file,'--db',join(dir,'cli.sqlite'),'--config',join(dir,'config.json'),'--json'],{env:{},isInteractive:false,fetcher:f.fetcher,now:()=>f.cutoff,stdout:x=>out+=x,stderr:x=>err+=x}),0,err);const cli=JSON.parse(out);assert.equal(cli.details.advisory.metrics.find((m:any)=>m.id==='A12').data.share,'0');assert.deepEqual(cli.features,b.features);assert.deepEqual(cli.details.advisory.metrics.filter((m:any)=>m.id!=='A12'),other(b));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('semantic rejection retains source and model carriers, emits missing and performs no pair-native reads',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a12-witness-reject-'));try{
  const {f,b}=await collected(dir,a12WitnessIntegrationFixture(true)),d=metric(b).data as any;
  assert.equal(metric(b).quality,'MISSING');assert.equal(metric(b).reasonCode,'EXIT_CAPACITY_WITNESS_FACTUAL_QUALIFICATION_FAILED');assert.equal(d.share,null);assert.equal(d.denominatorAtomic,null);assert.equal(f.projections.length,0);assert.equal(b.rawArtifacts[A12_WITNESS_ID],JSON.stringify(f.capture));assert.equal(JSON.parse(b.rawArtifacts[A12_WITNESS_ID]!).executions[1].response.transportRaw,f.capture.executions[1].response.transportRaw);
  const service=new Service(join(dir,'rejected.sqlite'));try{const saved=service.analyzeLive(b);assert.deepEqual(service.replay(saved.id),saved);}finally{service.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

// These mutations rehash where relevant: cached output or self-consistent wrappers do not
// replace the source/native purpose and reconstruction contracts.
test('Service rejects descriptor, source, receipt, cache and authority tampering across witness boundaries',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a12-witness-tamper-'));try{
  const {b}=await collected(dir),service=new Service(join(dir,'tamper.sqlite'));try{
   const changes:Array<[string,(b:Bundle)=>void]>=[
    ['descriptor absent',b=>changeProof(b,p=>delete p.exitCapacity)],
    ['wrong discriminator',b=>changeProof(b,p=>{p.exitCapacity.candidateSetId='a12-reviewed-candidate-set';})],
    ['mode absent',b=>changeProof(b,p=>delete p.exitCapacity.comparisonMode)],
    ['old mode',b=>changeProof(b,p=>p.exitCapacity.comparisonMode='zero-target-positive-reference-invariant-v1')],
    ['descriptor threshold',b=>changeProof(b,p=>p.exitCapacity.impactBps='301')],
    ['profile threshold',b=>{b.profile.risk.maxExitImpactBps='301';}],
    ['v57 downgrade',b=>changeProof(b,p=>p.method='advisory-provenance-v57')],
    ['v51 downgrade stripped',b=>changeProof(b,p=>{p.method='advisory-provenance-v51';delete p.exitCapacity;})],
    ['C10 version',b=>changeProof(b,p=>p.method='advisory-provenance-v59')],
    ['future version61',b=>changeProof(b,p=>p.method='advisory-provenance-v61')],
    ['cached scalar',b=>{(metric(b).data as any).share='1';}],
    ['cached denominator',b=>{(metric(b).data as any).denominatorAtomic='1';}],
    ['cached native',b=>{(metric(b).data as any).candidates[1].capacityAtomic='1';}],
    ['cached source hash',b=>{(metric(b).data as any).candidateSourceHash='0'.repeat(64);}],
    ['foreign metric',b=>{metric(b,'O28').evidenceIds.push(A12_WITNESS_ID);}],
    ['foreign metric cached data',b=>{(metric(b,'O28').data as any).witnessAuthority='promoted';}],
    ['entry feature',b=>{b.features[0]!.evidenceIds.push(A12_WITNESS_ID);}],
    ['baseline',b=>{b.details!.baseline[0]!.evidenceIds.push(A12_WITNESS_ID);}],
    ['source identity',b=>{b.evidence.find(e=>e.id===A12_WITNESS_ID)!.sourceId='native-attention-executor';}],
    ['source type',b=>{b.evidence.find(e=>e.id===A12_WITNESS_ID)!.sourceType='REVIEWED_CORPUS';}],
    ['adapter',b=>{b.evidence.find(e=>e.id===A12_WITNESS_ID)!.adapterVersion='live-v1';}],
    ['scope purpose',b=>{b.evidence.find(e=>e.id===A12_WITNESS_ID)!.scope.purpose='NATIVE_ATTENTION';}],
    ['source clock',b=>{b.evidence.find(e=>e.id===A12_WITNESS_ID)!.availableAt=b.cutoff;}],
    ['source raw hash',b=>{b.rawArtifacts[A12_WITNESS_ID]+=' ';}],
    ['rehashed source purpose',b=>changeSource(b,c=>{(c as any).purpose='NATIVE_ATTENTION';})],
    ['rehashed source body',b=>changeSource(b,c=>{c.sources[0]!.text+=' changed';})],
    ['rehashed source order',b=>changeSource(b,c=>{c.sources.reverse();})],
    ['rehashed raw provider body',b=>changeSource(b,c=>{const batch=c.acquisition.batches[0]!,raw=JSON.parse(batch.raw);raw.results[0].text+=' changed';batch.raw=JSON.stringify(raw);})],
    ['rehashed execution schema',b=>changeSource(b,c=>{c.executions[1].input.schemaJson='{}';c.executions[1].input.schemaSha256=a12ZeroShareHash('{}');})],
    ['rehashed false completeness',b=>changeSource(b,c=>{c.diagnostics.membershipComplete=true as false;})],
    ['rehashed native capacity in source',b=>changeSource(b,c=>{(c as any).capacityAtomic='0';})],
    ['rehashed late source',b=>changeSource(b,c=>{c.createdAt=b.cutoff;rebindA12WitnessFixture(c);})],
    ['native raw hash',b=>{const id=b.evidence.find(e=>e.sourceId==='advisory-exitCapacity')!.id;b.rawArtifacts[id]+=' ';}],
    ['native source purpose',b=>{b.evidence.find(e=>e.sourceId==='advisory-exitCapacity')!.sourceId=A12_WITNESS_SOURCE;}],
    ['rehashed native body',b=>{const id=proof(b).exitCapacity.artifactIds.bank,raw=JSON.parse(b.rawArtifacts[id]!);raw.result.value.pop();stamp(b,id,JSON.stringify(raw));}],
    ['native requested order',b=>changeProof(b,p=>{p.exitCapacity.requests.bank.params[0].reverse();})],
    ['orphan owned raw',b=>{b.rawArtifacts['a12-zero-witness-orphan']='{}';}],
    ['orphan owned evidence',b=>{const e=structuredClone(b.evidence.find(e=>e.id===A12_WITNESS_ID)!);e.id='a12-zero-witness-orphan';b.evidence.push(e);b.rawArtifacts[e.id]=b.rawArtifacts[A12_WITNESS_ID]!;}],
   ];
   for(const [label,mutate]of changes){const changed=structuredClone(b);mutate(changed);assert.throws(()=>service.analyzeLive(changed),invalid,label);}
   const stale=structuredClone(b);stale.cutoff=new Date(Date.parse(b.cutoff)+31000).toISOString();
   // Advance only the two locally derived assessment envelopes. Source/model/native
   // acquisition bytes and availability stay frozen, so replay reaches quote expiry.
   for(const id of ['advisory-derivation','advisory-thesis-context']){const envelope=JSON.parse(stale.rawArtifacts[id]!);envelope.cutoff=stale.cutoff;stamp(stale,id,JSON.stringify(envelope));const e=stale.evidence.find(e=>e.id===id)!;e.availableAt=stale.cutoff;e.retrievedAt=stale.cutoff;}
   for(const e of b.evidence.filter(e=>e.id===A12_WITNESS_ID||e.sourceId==='advisory-exitCapacity')){assert.deepEqual(stale.evidence.find(x=>x.id===e.id),e);assert.equal(stale.rawArtifacts[e.id],b.rawArtifacts[e.id]);}
   const expired=reconstructAdvisory(stale.token,stale.cutoff,stale.details!.baseline,stale.evidence,stale.rawArtifacts,proof(stale),stale.thesis??null,stale.features).metrics.find(m=>m.id==='A12')!;
   assert.equal(expired.quality,'MISSING');assert.equal(expired.reasonCode,'EXIT_CAPACITY_QUOTE_STALE');assert.equal((expired.data as any).share,null);assert.equal(metric(stale).quality,'KNOWN','the stale bundle deliberately retains its old cached scalar');
   assert.throws(()=>service.analyzeLive(stale),/ADVISORY_PROOF_INVALID/,'expired native quote cannot reuse the cached scalar');
  }finally{service.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('witness source scope is still guarded when source is orphaned from the advisory proof or non-live input',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a12-witness-orphan-'));try{const {b}=await collected(dir),service=new Service(join(dir,'orphan.sqlite'));try{
  for(const method of ['advisory-provenance-v51','advisory-provenance-v58']){const orphan=structuredClone(b);changeProof(orphan,p=>{p.method=method;delete p.exitCapacity;});assert.throws(()=>service.analyzeLive(orphan),invalid);}
  const imported={token:b.token,cutoff:b.cutoff,analysisKind:'USER_IMPORT' as const,features:b.features,evidence:b.evidence,rawArtifacts:b.rawArtifacts,profile:b.profile,observations:b.observations};assert.throws(()=>service.analyze(imported),invalid);
 }finally{service.close();}}finally{rmSync(dir,{recursive:true,force:true});}
});

test('new witness option rejects incompatible live/CLI modes and malformed source before any network read',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a12-witness-options-'));try{
  const f=a12WitnessIntegrationFixture(),file=join(dir,'capture.json');writeFileSync(file,JSON.stringify(f.capture));let reads=0;
  const fetcher:typeof fetch=async()=>{reads++;throw Error('NETWORK_DENIED');},base:LiveOptions={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,a12ZeroWitnessCapture:file,fetcher,now:()=>f.cutoff};
  const incompatible:Array<Partial<LiveOptions>>=[{semanticEnabled:true},{advisoryEnabled:false},{o28Expanded:false},{research:{} as any},{semanticExecutor:{} as any},{a12CandidateSet:{} as any},{a12ZeroShare:true},{nativeAttentionCapture:'absent'},{o22HolderAgeCapture:'absent'},{o26AccountCapture:'absent'},{o25LifetimeCapture:'absent'},{o24InventoryCapture:'absent'},{o23BulkCapture:'absent'},{o29ReservePath:true},{o30RegistryAbsence:true},{historicalTopicReuse:true},{a24Capture:'absent'},{a29Capture:'absent'},{recordedCallersCapture:'absent'},{recordedIncentivesCapture:'absent'},{creatorRoleOnly:true}];
  for(const o of incompatible)await assert.rejects(collectLiveToken(f.token,{...base,...o}),/A12_ZERO_WITNESS_REQUIRED|NATIVE_ATTENTION_MODE_REQUIRED|A12_ZERO_SHARE_REQUIRED/);
  await assert.rejects(collectLiveToken({chain:'bsc',address:'0x1111111111111111111111111111111111111111'},base),/A12_ZERO_WITNESS_REQUIRED/);
  const cliBase=['analyze',f.token.address,'--partial','--advisory','--o28-expanded','--a12-zero-witness-capture',file];
  for(const argv of [['analyze','--bundle','absent','--a12-zero-witness-capture',file],cliBase.filter(x=>x!=='--partial'),cliBase.filter(x=>x!=='--advisory'),cliBase.filter(x=>x!=='--o28-expanded'),[...cliBase,'--a12-zero-share'],[...cliBase,'--a12-candidates','absent'],[...cliBase,'--native-attention-capture','absent'],[...cliBase,'--advisory-executor']]){let err='';assert.equal(await runCli(argv,{env:{},isInteractive:false,fetcher,stdout:()=>{},stderr:x=>err+=x}),2);assert.match(err,/A12_ZERO_WITNESS_REQUIRED|NATIVE_ATTENTION_MODE_REQUIRED|A12_ZERO_SHARE_REQUIRED/);}
  for(const raw of ['{','{}',JSON.stringify({...f.capture,purpose:'NATIVE_ATTENTION'})]){writeFileSync(file,raw);await assert.rejects(collectLiveToken(f.token,base),invalid);}
  assert.equal(reads,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
