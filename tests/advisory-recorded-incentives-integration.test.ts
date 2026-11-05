import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {decodeRecordedCallerCapture,deriveRecordedCallerMetrics,recordedCallerProposalPrompt,recordedCallerReviewPrompt,RECORDED_CALLER_METHOD,type RecordedCallerCapture} from '../src/providers/advisory-recorded-callers.js';
import {decodeRecordedIncentiveCapture,deriveRecordedIncentiveMetrics,recordedIncentiveProposalPrompt,recordedIncentiveReviewPrompt,RECORDED_INCENTIVE_METHOD,type RecordedIncentiveCapture} from '../src/providers/advisory-recorded-incentives.js';
import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {Service} from '../src/app/service.js';
import {starterProfile} from '../src/app/config.js';
import {runCli} from '../src/cli.js';
import {a29LiveFetcher} from './a29-fixtures.js';
import {token,at,sha,source,outer,pass,span,classify} from './recorded-incentive-fixtures.js';
const CALL_TEXT = `Early entry Ca: ${token.address}`;
const INC='advisory-recorded-incentives-capture',CAP='advisory-recorded-callers-capture',CUT=at(30),CALLER_IDS=['S07','S09','A21','A23'];
/** Synthetic fixture classification of the frozen four-field caller protocol. */
function qualifyCaller(n: RecordedCallerCapture): string {
  const d = decodeRecordedCallerCapture(JSON.stringify(n), token, CUT), p = recordedCallerProposalPrompt(d), cat = JSON.parse(p).sources;
  const pr = JSON.stringify({ sources: cat.map((s: any) => ({ id: s.id, binding: 'EXACT_CONTRACT', event: 'FORWARD_CALL', category: 'CRYPTO_CALLER', topic: 'PRICE_CHART', citations: [span(s)], rationale: 'Synthetic fixture classification only.' })) });
  const rr = JSON.stringify({ sources: cat.map((s: any) => ({ id: s.id, complete: true, binding: true, event: true, category: true, topic: true })) });
  return JSON.stringify({ ...n, qualification: { proposal: pass('CODEX', p, pr, 6, 10), review: pass('CLAUDE_CODE', recordedCallerReviewPrompt(d, pr), rr, 11, 15) } });
}
const incentiveRaw=async()=>JSON.stringify(classify(JSON.stringify(await source())));
const collect=(o:{inc?:string,call?:string}={},semanticEnabled=false)=>collectLiveToken(token,{profile:starterProfile(),semanticEnabled,advisoryEnabled:true,fetcher:a29LiveFetcher(token.address,CUT),now:()=>CUT,...(o.inc===undefined?{}:{recordedIncentivesCapture:o.inc}),...(o.call===undefined?{}:{recordedCallersCapture:o.call})});
type Run=Awaited<ReturnType<typeof collect>>;
const proof=(b:Run)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const record=(b:Run)=>b.evidence.find(e=>e.id===INC)!;
const reconstruct=(b:Run,p=proof(b))=>reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,p,b.thesis??null,b.features);
const metric=(b:Run,mid:string)=>b.details!.advisory!.metrics.filter(m=>m.id===mid);
const s08=(b:Run)=>{const rows=metric(b,'S08');assert.equal(rows.length,1);return rows[0]!;};
const derived=(raw:string)=>deriveRecordedIncentiveMetrics(raw,token,CUT,[INC])[0]!;
const citing=(b:Run)=>b.details!.advisory!.metrics.filter(m=>JSON.stringify(m).includes(INC)).map(m=>m.id);
const policy=(file:string,sid:string)=>{const db=new DatabaseSync(file);try{return JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(sid)!.semantic as string).policyVersion;}finally{db.close();}};
async function persisted(b:Run,expectedPolicy:string){
 const dir=mkdtempSync(join(tmpdir(),'recorded-incentives-service-')),file=join(dir,'test.sqlite'),service=new Service(file);
 try{const saved=service.analyzeLive(b);assert.deepEqual(service.replay(saved.id),saved);assert.deepEqual(service.analyzeLive(b),saved);assert.equal(policy(file,saved.id),expectedPolicy);const reopened=new Service(file);try{assert.deepEqual(reopened.replay(saved.id),saved);}finally{reopened.close();}}finally{service.close();rmSync(dir,{recursive:true,force:true});}
}

test('explicit incentive-only import keeps exact raw bytes, adds only S08 under proof42/facts41/policy39 and persists/replays',async()=>{
 const base=await collect(),raw=await incentiveRaw(),b=await collect({inc:raw}),p=proof(b),r=record(b);
 assert.equal(p.method,'advisory-provenance-v42');assert.equal(p.recordedCallers,null);assert.deepEqual(p.recordedIncentives,{captureId:INC});assert.equal(b.details!.advisory!.method,'advisory-measurements-v41');
 assert.equal(b.rawArtifacts[INC],raw);assert.deepEqual([r.sourceId,r.accessMode,r.sourceType,r.adapterVersion,r.retrievedAt,r.availableAt,r.contentHash],['advisory-recorded-incentives','USER_IMPORT','HISTORICAL_RECEIPT',RECORDED_INCENTIVE_METHOD,CUT,CUT,sha(raw)]);assert.deepEqual(r.scope,{method:RECORDED_INCENTIVE_METHOD});
 const row=s08(b);assert.equal(row.quality,'KNOWN');assert.equal(row.reasonCode,'HISTORICAL_PUBLIC_INCENTIVES_OBSERVED');assert.deepEqual(row,derived(raw));
 assert.deepEqual(citing(b),['S08']);for(const mid of CALLER_IDS)assert.deepEqual(metric(b,mid),metric(base,mid));
 assert.ok(!b.evidence.some(e=>e.id.startsWith('advisory-recorded-callers-')||e.adapterVersion===RECORDED_CALLER_METHOD));
 assert.deepEqual(reconstruct(b),b.details!.advisory);assert.ok(b.features.every(f=>!f.evidenceIds.includes(INC)));assert.ok(b.details!.baseline.every(a=>!a.evidenceIds.includes(INC)));
 await persisted(b,'research-screen-advisory-v39');
});

test('combined caller and incentive imports retain the four known caller rows and the incentive S08 under proof42',async()=>{
 const call=qualifyCaller(await source(CALL_TEXT)),inc=await incentiveRaw(),b=await collect({inc,call}),p=proof(b);
 assert.equal(p.method,'advisory-provenance-v42');assert.deepEqual(p.recordedCallers,{captureId:CAP});assert.deepEqual(p.recordedIncentives,{captureId:INC});assert.equal(b.details!.advisory!.method,'advisory-measurements-v41');
 assert.equal(b.rawArtifacts[CAP],call);assert.equal(b.rawArtifacts[INC],inc);
 const expected=deriveRecordedCallerMetrics(call,token,CUT,[CAP]);assert.equal(expected.length,4);
 for(const m of expected){assert.equal(m.quality,'KNOWN');assert.deepEqual(metric(b,m.id),[m]);}
 assert.deepEqual(s08(b),derived(inc));assert.deepEqual(citing(b),['S08']);
 assert.deepEqual(reconstruct(b),b.details!.advisory);await persisted(b,'research-screen-advisory-v39');
});

test('ordinary collection keeps proof40/facts39 and refuses incentive descriptors, downgrades and orphan namespace bytes',async()=>{
 const b=await collect(),p=proof(b);assert.equal(p.method,'advisory-provenance-v40');assert.equal(p.recordedIncentives,undefined);assert.equal(b.details!.advisory!.method,'advisory-measurements-v39');assert.deepEqual(reconstruct(b),b.details!.advisory);
 assert.notEqual(s08(b).quality,'KNOWN','portable fixture has no current KNOWN S08; precedence over a current KNOWN row is not exercised here');
 const orphan=structuredClone(b);orphan.rawArtifacts[INC]='{}';assert.throws(()=>reconstruct(orphan),/ADVISORY_PROOF_INVALID/);
 assert.throws(()=>reconstruct(b,{...p,recordedIncentives:null}),/ADVISORY_PROOF_INVALID/);assert.throws(()=>reconstruct(b,{...p,method:'advisory-provenance-v42'}),/ADVISORY_PROOF_INVALID/);
 const imported=await collect({inc:await incentiveRaw()}),q=proof(imported),without=(k:string,x:any={...q})=>{delete x[k];return x;};
 for(const forged of [{...q,recordedIncentives:null},without('recordedIncentives'),without('recordedCallers'),{...q,method:'advisory-provenance-v41'},without('recordedCallers',without('recordedIncentives',{...q,method:'advisory-provenance-v38'}))])
  assert.throws(()=>reconstruct(imported,forged),/ADVISORY_PROOF_INVALID/);
});

test('descriptor membership, source clocks, hashes, nested source and token binding reject forged incentive imports',async()=>{
 const raw=await incentiveRaw(),original=await collect({inc:raw}),qualified=qualifyCaller(await source());
 const rewrite=(b:Run,change:(c:any)=>void)=>{const c=JSON.parse(raw);change(c);b.rawArtifacts[INC]=JSON.stringify(c);record(b).contentHash=sha(b.rawArtifacts[INC]!);};
 const cases:Array<(b:Run)=>void>=[
 b=>{record(b).sourceId='advisory-context';},b=>{record(b).adapterVersion='live-v1';},b=>{record(b).sourceType='REVIEWED_CORPUS';},b=>{record(b).accessMode='PUBLIC_API';},b=>{record(b).scope.extra=true;},
 b=>{record(b).contentHash='0'.repeat(64);},b=>{b.rawArtifacts[INC]=raw+' ';},b=>{record(b).availableAt=at(29);},b=>{record(b).retrievedAt=at(31);},
 b=>{const r=structuredClone(record(b));r.id='advisory-recorded-incentives-shadow';b.evidence.push(r);b.rawArtifacts[r.id]=raw;},
 b=>{const r=structuredClone(record(b));r.id='unrelated-import';b.evidence.push(r);b.rawArtifacts[r.id]=raw;},
 b=>{b.rawArtifacts['advisory-recorded-incentives-extra']=raw;},
 b=>rewrite(b,c=>{c.token={...token,address:'other'};}),
 b=>rewrite(b,c=>{c.qualification.review.execution.finishedAt=at(31);}),
 b=>rewrite(b,c=>{const n=JSON.parse(c.sourceCapture);n.seed.rawArtifacts['attention-page-1']+='x';c.sourceCapture=JSON.stringify(n);}),
 b=>rewrite(b,c=>{c.sourceCapture=qualified;}),
 ];for(const change of cases){const b=structuredClone(original);change(b);assert.throws(()=>reconstruct(b),/ADVISORY_PROOF_INVALID/);}
});

test('incentive capture cannot supply entry features, baseline, observations, semantic, caller or other advisory metrics',async()=>{
 const b=await collect({inc:await incentiveRaw()}),dir=mkdtempSync(join(tmpdir(),'recorded-incentives-exclusivity-')),service=new Service(join(dir,'test.sqlite'));
 try{
 const cases:Array<(x:Run)=>void>=[x=>{x.features[0]!.evidenceIds.push(INC);},x=>{x.details!.baseline[0]!.evidenceIds.push(INC);},x=>{x.semantic.claims.push({claim:'invalid',evidenceId:INC} as any);},
  x=>{metric(x,'O21')[0]!.evidenceIds.push(INC);},x=>{metric(x,'A21')[0]!.evidenceIds.push(INC);}];
 if(b.observations.length)cases.push(x=>{x.observations[0]!.evidenceIds.push(INC);});
 for(const mutate of cases){const x=structuredClone(b);mutate(x);assert.throws(()=>service.analyzeLive(x),/ADVISORY_PROOF_INVALID|invalid|Invalid/);}
 const changed=structuredClone(b);s08(changed).data={forged:true};assert.throws(()=>service.analyzeLive(changed),/ADVISORY_PROOF_INVALID/);
 }finally{service.close();rmSync(dir,{recursive:true,force:true});}
});

test('missing, rejected or invalid incentive classification never replaces S08 and is never a zero observation',async()=>{
 const base=await collect(),raw=JSON.stringify(await source());
 const cases:Array<[RecordedIncentiveCapture,string]>=[[outer(raw),'RECORDED_INCENTIVE_CLASSIFICATION_UNAVAILABLE'],[classify(raw,()=>({}),{incentives:false}),'HISTORICAL_INCENTIVES_REJECTED'],
  [classify(raw,()=>({incentives:[]}),{incentives:false}),'HISTORICAL_INCENTIVES_REJECTED'],[classify(raw,()=>({}),{complete:false}),'HISTORICAL_INSPECTION_INCOMPLETE'],
  [classify(raw,()=>({incentives:[{category:'PUBLIC_HOLDINGS',citations:[{sourceId:'invented',spanId:'invented'}]}]})),'RECORDED_INCENTIVE_CITATION_INVALID']];
 for(const [c,reason] of cases){
  const inc=JSON.stringify(c),b=await collect({inc}),own=derived(inc);assert.equal(own.quality,'MISSING');assert.equal(own.reasonCode,reason);
  assert.equal(proof(b).method,'advisory-provenance-v42');assert.equal(b.rawArtifacts[INC],inc);assert.deepEqual(s08(b),s08(base),reason);
  assert.notEqual(s08(b).quality,'KNOWN');assert.notEqual(s08(b).reasonCode,'HISTORICAL_PUBLIC_INCENTIVES_NONE_IN_INSPECTED_TEXT');assert.deepEqual(citing(b),[]);assert.deepEqual(reconstruct(b),b.details!.advisory);
 }
 await persisted(await collect({inc:JSON.stringify(outer(raw))}),'research-screen-advisory-v39');
});

test('early option and capture gates reject before any read, including cross-protocol and late-clock captures',async()=>{
 let reads=0;const fetcher=(async()=>{reads++;throw Error('Unexpected read');}) as typeof fetch;
 const raw=JSON.stringify(await source()),valid=await incentiveRaw(),opts=(o:Record<string,unknown>,clock=CUT)=>({profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher,now:()=>clock,...o});
 await assert.rejects(collectLiveToken(token,opts({advisoryEnabled:false,recordedIncentivesCapture:valid})),/RECORDED_INCENTIVE_ADVISORY_REQUIRED/);
 for(const bad of ['{}',raw,JSON.stringify(outer(qualifyCaller(await source()))),JSON.stringify({...JSON.parse(valid),token:{...token,address:'other'}})])
  await assert.rejects(collectLiveToken(token,opts({recordedIncentivesCapture:bad})),/RECORDED_INCENTIVE_CAPTURE_INVALID/);
 await assert.rejects(collectLiveToken(token,opts({recordedIncentivesCapture:valid},at(14))),/RECORDED_INCENTIVE_CAPTURE_INVALID/);
 await assert.rejects(collectLiveToken(token,opts({recordedCallersCapture:valid})),/RECORDED_CALLER_CAPTURE_INVALID/);
 assert.equal(reads,0);
});

test('CLI exact strict UTF8 incentive capture saves and replays offline; wrong modes, oversized and malformed inputs reject without reads',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'recorded-incentives-cli-')),file=join(dir,'capture.json'),db=join(dir,'cli.sqlite'),live=a29LiveFetcher(token.address,CUT),flag='--recorded-incentives-capture';
 let out='',err='',reads=0;const fetcher=(async(input:any,init?:any)=>{reads++;return live(input,init);}) as typeof fetch;
 const run=(args:string[])=>{out='';err='';return runCli(args,{env:{},fetcher,now:()=>CUT,isInteractive:false,stdout:s=>{out+=s;},stderr:s=>{err+=s;}});};
 const analyze=['analyze',token.address,'--partial','--advisory',flag,file,'--db',db,'--json'];
 try{writeFileSync(file,await incentiveRaw()+' '.repeat(2_000_001));assert.equal(await run(analyze),0,err);const saved=JSON.parse(out);assert.equal(saved.details.advisory.method,'advisory-measurements-v41');
 reads=0;assert.equal(await run(['replay',saved.id,'--db',db,'--json']),0,err);assert.deepEqual(JSON.parse(out),saved);assert.equal(reads,0);
 for(const args of [['analyze',token.address,'--partial',flag,file],['reassess','id',flag,file],['analyze',token.address,'--bundle',file,flag,file],['analyze',token.address,'--partial','--advisory',flag]]){assert.notEqual(await run([...args,'--db',db,'--json']),0,args.join(' '));}
 writeFileSync(file,Buffer.from([0xc3,0x28]));assert.notEqual(await run(analyze),0);assert.match(err,/RECORDED_INCENTIVE_CAPTURE_INVALID/);
 writeFileSync(file,' '.repeat(8_388_609));assert.notEqual(await run(analyze),0);assert.match(err,/FILE_TOO_LARGE/);
 assert.equal(reads,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('grouped entry preserves sharedv4 policy precedence while proof42/facts41 retain the incentive import outside shared facts',async()=>{
 const raw=await incentiveRaw(),b=await collect({inc:raw},true);
 assert.ok(b.details!.groups);assert.equal(proof(b).method,'advisory-provenance-v42');assert.equal(b.details!.advisory!.method,'advisory-measurements-v41');assert.equal(b.rawArtifacts[INC],raw);
 for(const part of [b.details!.groups,b.details!.shared,b.details!.social,b.semantic])assert.ok(!JSON.stringify(part??null).includes(INC));
 assert.ok(citing(b).every(mid=>mid==='S08'));assert.deepEqual(reconstruct(b),b.details!.advisory);
 await persisted(b,'research-screen-shared-v4');
});
