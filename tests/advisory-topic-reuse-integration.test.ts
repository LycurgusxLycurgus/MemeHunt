import {assertEntryCliSnapshot} from './entry-cli-snapshot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory,EXECUTOR_INPUT_SOURCE,EXECUTOR_BODY_INPUT_SOURCE} from '../src/app/advisory.js';
import {Service} from '../src/app/service.js';
import {starterProfile} from '../src/app/config.js';
import {runCli} from '../src/cli.js';
import {a29LiveFetcher} from './a29-fixtures.js';
const retained=JSON.parse(readFileSync(new URL('../../tests/fixtures/a23-retained-c5.json',import.meta.url),'utf8'));
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const CAP='advisory-recorded-callers-capture',EXEC='advisory-executor-capture',BODY='advisory-executor-bodies',ACQ='advisory-executor-acquisition';
type Bundle=Awaited<ReturnType<typeof collectLiveToken>>;
const proof=(b:Bundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const rebuild=(b:Bundle,p=proof(b))=>reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,p,b.thesis??null,b.features);
function stamp(b:Bundle,p:any){b.rawArtifacts['advisory-derivation']=JSON.stringify(p);b.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=sha(b.rawArtifacts['advisory-derivation']);}
/** Constructed app envelope around unchanged retained public captures; not a fresh source acquisition. */
async function composed(){
 const token=retained.token,cutoff=retained.cutoff;
 const b=await collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher:a29LiveFetcher(token.address,cutoff),now:()=>cutoff});
 const p=proof(b),capture=JSON.parse(retained.rawArtifacts[EXEC]);
 for(const e of retained.records){b.evidence.push(structuredClone(e));b.rawArtifacts[e.id]=retained.rawArtifacts[e.id];}
 const sourceIds:string[]=[];
 for(const s of capture.read.sources){const id=`advisory-executor-source-${s.id}`,expanded=Object.hasOwn(capture.bodyBySourceId,s.id);sourceIds.push(id);b.rawArtifacts[id]=s.text;b.evidence.push({id,sourceId:expanded?EXECUTOR_BODY_INPUT_SOURCE:EXECUTOR_INPUT_SOURCE,sourceType:expanded?'COMPOSITE_SOURCE':'WEB_PAGE',accessMode:expanded?'USER_IMPORT':'FREE_ACCOUNT',adapterVersion:'live-v1',retrievedAt:s.availableAt,availableAt:s.availableAt,contentHash:sha(s.text),scope:{url:s.url,publishedAt:s.publishedAt,authorId:s.authorId,kind:s.kind}});}
 p.method='advisory-provenance-v50';p.executorSemantic={bodyCaptureId:BODY,captureId:EXEC,acquisitionId:ACQ,sourceIds};p.recordedCallers={captureId:CAP};p.recordedIncentives=null;stamp(b,p);b.details!.advisory=rebuild(b);return b;
}

test('proof50 composes historical A23 only, preserves old45 current rejection and persists/reopens/replays',async()=>{
 const b=await composed(),p=proof(b),a=b.details!.advisory!.metrics.find(m=>m.id==='A23')!;assert.equal(b.details!.advisory!.method,'advisory-measurements-v49');assert.equal(a.quality,'KNOWN');assert.deepEqual([(a.data as any).eligible,(a.data as any).classified,(a.data as any).fraction],[8,8,'0']);
 const old=structuredClone(b);stamp(old,{...p,method:'advisory-provenance-v45'});old.details!.advisory=rebuild(old);assert.equal(old.details!.advisory.metrics.find(m=>m.id==='A23')!.quality,'MISSING');assert.deepEqual(old.details!.advisory.metrics.filter(m=>m.id!=='A23'),b.details!.advisory!.metrics.filter(m=>m.id!=='A23'));assert.deepEqual(b.features,old.features);assert.deepEqual(b.details!.baseline,old.details!.baseline);
 const dir=mkdtempSync(join(tmpdir(),'topic-reuse-')),file=join(dir,'live.sqlite');let saved;
 try{let s=new Service(file);try{saved=s.analyzeLive(b);assert.equal(s.analyzeLive(b).id,saved.id);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}s=new Service(file);try{assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string).policyVersion,'research-screen-advisory-v47');}finally{db.close();}let out='',err='',calls=0;assert.equal(await runCli(['replay',saved.id,'--db',file,'--json'],{env:{},isInteractive:false,fetcher:async()=>{calls++;throw Error('NETWORK_DENIED');},stdout:x=>out+=x,stderr:x=>err+=x}),0,err);assert.equal(calls,0);assertEntryCliSnapshot(JSON.parse(out),saved);}finally{rmSync(dir,{recursive:true,force:true});}
});

test('proof50 mandatory sources, cached values, own clocks and entry quarantine remain strict',async()=>{
 const original=await composed();
 for(const mutate of [
  (b:Bundle)=>{const p=proof(b);p.recordedCallers=null;stamp(b,p);},
  (b:Bundle)=>{const p=proof(b);p.executorSemantic=null;stamp(b,p);},
  (b:Bundle)=>{const p=proof(b);delete p.executorSemantic.bodyCaptureId;stamp(b,p);},
  (b:Bundle)=>{b.evidence.find(e=>e.id===EXEC)!.sourceId='advisory-context';},
  (b:Bundle)=>{b.evidence.find(e=>e.id===BODY)!.availableAt=b.cutoff;},
  (b:Bundle)=>{b.evidence.find(e=>e.id===ACQ)!.contentHash='0'.repeat(64);},
  (b:Bundle)=>{b.features[0]!.evidenceIds.push(EXEC);},
 ]){const b=structuredClone(original);mutate(b);assert.throws(()=>rebuild(b),/ADVISORY_PROOF_INVALID/);}
 const dir=mkdtempSync(join(tmpdir(),'topic-forgery-')),s=new Service(join(dir,'live.sqlite'));
 try{const forged=structuredClone(original);(forged.details!.advisory!.metrics.find(m=>m.id==='A23')!.data as any).fraction='1';assert.throws(()=>s.analyzeLive(forged),/ADVISORY_PROOF_INVALID/);}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('explicit topic reuse CLI/live mode rejects missing prerequisites and busy composition before reads',async()=>{
 let reads=0;const fetcher:typeof fetch=async()=>{reads++;throw Error('NETWORK_DENIED');},base={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,historicalTopicReuse:true,fetcher};
 for(const options of [base,{...base,recordedCallersCapture:retained.rawArtifacts[CAP]},{...base,recordedCallersCapture:retained.rawArtifacts[CAP],semanticExecutor:async()=>{throw Error('NOT_CALLED');},o28Expanded:true}])await assert.rejects(collectLiveToken(retained.token,options),/HISTORICAL_TOPIC_REUSE_REQUIRED/);
 for(const args of [['analyze','--bundle','absent','--historical-topic-reuse'],['analyze',retained.token.address,'--partial','--advisory','--historical-topic-reuse'],['analyze',retained.token.address,'--partial','--advisory','--advisory-executor','--recorded-callers-capture','absent','--o28-expanded','--historical-topic-reuse']]){let error='';assert.equal(await runCli(args,{env:{},isInteractive:false,fetcher,stdout:()=>{},stderr:x=>error+=x}),2);assert.match(error,/HISTORICAL_TOPIC_REUSE_REQUIRED/);}assert.equal(reads,0);
});

test('explicit producer selects proof50 and keeps topic missing without a matching current classification',async()=>{
 const base=a29LiveFetcher(retained.token.address,retained.cutoff),fetcher:typeof fetch=async(input,init)=>{const host=new URL(String(input)).hostname;if(host==='api.search.tinyfish.ai')return new Response(JSON.stringify({results:[]}));if(host==='api.fetch.tinyfish.ai')return new Response(JSON.stringify({results:[],errors:[]}));return base(input,init);};
 const b=await collectLiveToken(retained.token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,historicalTopicReuse:true,recordedCallersCapture:retained.rawArtifacts[CAP],tinyfishKey:'constructed-fixture',semanticExecutor:async()=>{throw Error('EMPTY_CORPUS_HAS_NO_CLASSIFICATION');},fetcher,now:()=>retained.cutoff});
 assert.equal(proof(b).method,'advisory-provenance-v50');assert.ok(proof(b).recordedCallers);assert.ok(proof(b).executorSemantic?.bodyCaptureId);assert.equal(b.details!.advisory!.method,'advisory-measurements-v49');assert.equal(b.details!.advisory!.metrics.find(m=>m.id==='A23')!.quality,'MISSING');assert.deepEqual(rebuild(b),b.details!.advisory);
});
