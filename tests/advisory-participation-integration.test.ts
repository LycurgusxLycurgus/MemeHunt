import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {validateA13ParticipationBundle} from '../src/app/a13-participation.js';
import {A13_CAPTURE_ID} from '../src/providers/advisory-participation-import.js';
import {Service} from '../src/app/service.js';
import {starterProfile} from '../src/app/config.js';
import {a29LiveFetcher} from './a29-fixtures.js';

const token={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'};
// The imported pair/qualification bytes are actual historical observations. Only
// this test's live transport and final clock are constructed, as in the C12 test.
const cutoff='2026-11-03T00:00:00.000Z';
const capture=()=>gunzipSync(readFileSync('tests/fixtures/a13-observed-peer-participation.json.gz')).toString('utf8');

test('A13 isolated mode rejects incompatible collection boundaries before any file or API read',async()=>{
 let reads=0;
 const base={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,a13ParticipationCapture:'/nonexistent-a13-test-file',fetcher:async()=>{reads++;throw Error('UNEXPECTED_READ');}};
 for(const change of [{advisoryEnabled:false},{semanticEnabled:true},{o28Expanded:true},{c12BridgeCapture:'/another-file'},{a12ZeroWitnessCapture:'/another-file'},{executableLiquidity:true},{nativeAttentionCapture:'/another-file'},{o25LifetimeCapture:'/another-file'}]){
  await assert.rejects(()=>collectLiveToken(token,{...base,...change}),/A13_PARTICIPATION_MODE_REQUIRED|C12_BRIDGE_MODE_REQUIRED/);
 }
 await assert.rejects(()=>collectLiveToken({chain:'base',address:'0x0000000000000000000000000000000000000001'},base),/A13_PARTICIPATION_MODE_REQUIRED/);
 assert.equal(reads,0);
});

test('proof65 reports measured undefined A13 while preserving ordinary40 facts and required entry evidence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a13-composition-'));
 try{
  const file=join(dir,'capture.json');writeFileSync(file,capture());
  const options={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher:a29LiveFetcher(token.address,cutoff),now:()=>cutoff};
  const ordinary=await collectLiveToken(token,options);
  const next=await collectLiveToken(token,{...options,a13ParticipationCapture:file});
  const facts=next.details!.advisory!,proof=JSON.parse(next.rawArtifacts['advisory-derivation']!);
  assert.equal(proof.method,'advisory-provenance-v65');
  assert.equal(facts.method,'advisory-measurements-v64');
  assert.deepEqual(facts.metrics.filter(m=>m.id!=='A13'),ordinary.details!.advisory!.metrics.filter(m=>m.id!=='A13'));
  assert.deepEqual(next.features,ordinary.features);
  assert.deepEqual(next.details!.baseline,ordinary.details!.baseline);
  const metric=facts.metrics.find(m=>m.id==='A13')!,d=metric.data as any;
  assert.equal(metric.quality,'KNOWN');
  assert.equal(d.share,null);
  assert.equal(d.shareStatus,'UNDEFINED_ZERO_POSITIVE_GROWTH');
  assert.equal(d.numeratorPositiveGrowth,'0');assert.equal(d.denominatorPositiveGrowth,'0');
  assert.equal(d.denominatorIdentified,true);assert.equal(d.qualificationComplete,false);
  assert.equal(d.identification,'FINITE_FRAME_ZERO_POSITIVE_GROWTH_INVARIANT');
  assert.equal(d.acquisition.complete,false);assert.equal(d.acquisition.requiredCandidateSourcesComplete,true);
  assert.equal(d.acquisition.failedControlReads,4);
  assert.deepEqual(d.qualification.unresolvedTokenKeys,[
   'solana:HKh5uh37FyRhRbDPcmPCoTcfByRLdY65RFZj9AvZpump',
   'solana:HfSspmBgvTb5m4uMqcftkxwhXqzLGZYEaQ21HwYgpump',
  ]);
  assert.equal(d.candidates.length,10);
  assert.deepEqual(reconstructAdvisory(next.token,next.cutoff,next.details!.baseline,next.evidence,next.rawArtifacts,proof,next.thesis??null,next.features),facts);
  validateA13ParticipationBundle(next,true);
  assert.throws(()=>validateA13ParticipationBundle(next,false));

  const dbFile=join(dir,'a13.sqlite'),service=new Service(dbFile);
  try{
   const saved=service.analyzeLive(next);
   assert.deepEqual(service.show(saved.id),saved);assert.deepEqual(service.replay(saved.id),saved);
   assert.deepEqual(service.analyzeLive(next),saved);
   const db=new DatabaseSync(dbFile);
   try{const row=db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!;assert.equal(JSON.parse(row.semantic as string).policyVersion,'research-screen-advisory-v62');}finally{db.close();}
   const reopened=new Service(dbFile);try{assert.deepEqual(reopened.show(saved.id),saved);assert.deepEqual(reopened.replay(saved.id),saved);}finally{reopened.close();}
   const changed=structuredClone(next);(changed.details!.advisory!.metrics.find(m=>m.id==='A13')!.data as any).share='0';
   assert.throws(()=>service.analyzeLive(changed));
  }finally{service.close();}

  assert.ok(next.features.length>0,'The entry-citation corruption must exercise a real feature.');
  for(const edit of [
   (b:typeof next)=>{b.features[0]!.evidenceIds.push(A13_CAPTURE_ID);},
   (b:typeof next)=>{b.details!.advisory!.metrics.find(m=>m.id==='C09')!.evidenceIds.push(A13_CAPTURE_ID);},
   (b:typeof next)=>{b.evidence.find(e=>e.id===A13_CAPTURE_ID)!.accessMode='PUBLIC_API';},
   (b:typeof next)=>{const p=JSON.parse(b.rawArtifacts['advisory-derivation']!);p.method='advisory-provenance-v64';b.rawArtifacts['advisory-derivation']=JSON.stringify(p);},
  ]){const changed=structuredClone(next);edit(changed);assert.throws(()=>validateA13ParticipationBundle(changed,true));}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
