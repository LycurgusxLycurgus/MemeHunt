import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { collectLiveToken } from '../src/app/live.js';
import { Service } from '../src/app/service.js';
import { starterProfile } from '../src/app/config.js';
import { runCli } from '../src/cli.js';
import { reconstructAdvisory,archiveA29Capture,unpackA29Capture,a29CaptureRequest,A29_CAPTURE_ADAPTER,A29_CAPTURE_ID,A29_SOURCE_ID } from '../src/app/advisory.js';
import { decodeA29Capture,deriveA29Absorption } from '../src/providers/advisory-absorption.js';
import type { EvidenceRecord } from '../src/domain/contracts.js';
import { a29DataSchema } from '../src/domain/advisory-contracts.js';
import { Decimal } from 'decimal.js';
import { a29LiveFetcher,buildA29Capture,loadA29Capture } from './a29-fixtures.js';

const token={chain:'solana' as const,address:'3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'},at='2026-10-10T12:30:00.000Z';
const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const collect=(options:{a29Capture?:string;address?:string;now?:string;advisory?:boolean}={})=>{
  const address=options.address??token.address,clock=options.now??at;
  return collectLiveToken({chain:'solana',address},{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:options.advisory??true,fetcher:a29LiveFetcher(address,clock),now:()=>clock,...(options.a29Capture!==undefined?{a29Capture:options.a29Capture}:{})});
};
type LiveRun=Awaited<ReturnType<typeof collect>>;
type Capture={raw:string;token:{chain:'solana';address:string};latestClock:string;after:string};
const rebuild=(b:LiveRun,proof:unknown)=>()=>reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);
const captureRecord=(b:LiveRun)=>b.evidence.find(e=>e.id===A29_CAPTURE_ID)!;
/** Appends one A29 record in the exact import shape; each case changes only the field it forges. */
function attach(b:LiveRun,raw:string,label:string,change:(record:EvidenceRecord)=>void=()=>{}){
  const stored=archiveA29Capture(raw),request=a29CaptureRequest(raw,label);
  const record:EvidenceRecord={id:A29_CAPTURE_ID,sourceId:A29_SOURCE_ID,sourceType:'RECONSTRUCTED_HISTORY',retrievedAt:b.cutoff,availableAt:b.cutoff,contentHash:sha(stored),adapterVersion:A29_CAPTURE_ADAPTER,accessMode:'USER_IMPORT',scope:{request}};
  change(record);b.evidence.push(record);b.rawArtifacts[record.id]=stored;
  return {requests:{capture:request},artifactIds:{capture:A29_CAPTURE_ID},label};
}
async function withService(name:string,run:(service:Service,file:string)=>void|Promise<void>){
  const directory=mkdtempSync(join(tmpdir(),name)),file=join(directory,'live.sqlite'),service=new Service(file);
  try{await run(service,file);}finally{service.close();rmSync(directory,{recursive:true,force:true});}
}
const garbage=JSON.stringify({method:'a29-retained-sources-v1'});
/** Appends a second complete raw-deflate stream after the archived one; canonical base64, source bytes and source hash all stay valid. */
const appendCompressed=(stored:string)=>{const a=JSON.parse(stored);a.data=Buffer.concat([Buffer.from(a.data,'base64'),deflateRawSync(Buffer.from(' '))]).toString('base64');return JSON.stringify(a);};

/** One imported capture end to end: exact USER_IMPORT record, provider-derived A29 only, proof forgeries, Service persistence and the CLI analyze/show/replay path. */
async function exerciseImportedCapture(c:Capture){
  const decoded=decodeA29Capture(c.raw),bundle=await collect({a29Capture:c.raw,address:c.token.address,now:c.after});
  const proof=JSON.parse(bundle.rawArtifacts['advisory-derivation']!),record=captureRecord(bundle),stored=bundle.rawArtifacts[A29_CAPTURE_ID]!;
  assert.equal(proof.method,'advisory-provenance-v40');
  assert.deepEqual(proof.a29,{requests:{capture:a29CaptureRequest(c.raw,decoded.label)},artifactIds:{capture:A29_CAPTURE_ID},label:decoded.label});
  assert.deepEqual([record.sourceId,record.sourceType,record.accessMode,record.adapterVersion,record.retrievedAt,record.availableAt,record.contentHash,record.scope],[A29_SOURCE_ID,'RECONSTRUCTED_HISTORY','USER_IMPORT',A29_CAPTURE_ADAPTER,c.latestClock,c.after,sha(stored),{request:proof.a29.requests.capture}]);
  assert.deepEqual([unpackA29Capture(stored),decoded.maxClock],[c.raw,c.latestClock]);
  const facts=bundle.details!.advisory!,metric=facts.metrics.find(m=>m.id==='A29')!;
  assert.deepEqual(metric,deriveA29Absorption(decoded.freeze,decoded.label,decoded.receipts,bundle.cutoff,[A29_CAPTURE_ID]));
  assert.ok(facts.metrics.every(m=>m.id==='A29'||!m.evidenceIds.includes(A29_CAPTURE_ID)));
  assert.ok(bundle.features.every(f=>!f.evidenceIds.includes(A29_CAPTURE_ID))&&bundle.observations.every(o=>!o.evidenceIds.includes(A29_CAPTURE_ID)));
  const forgeries:Array<[string,(b:LiveRun)=>void]>=[
    ['changed-capture-bytes',b=>{const changed=archiveA29Capture(c.raw+' ');b.rawArtifacts[A29_CAPTURE_ID]=changed;captureRecord(b).contentHash=sha(changed);}],
    ['appended-compressed-bytes',b=>{const changed=appendCompressed(b.rawArtifacts[A29_CAPTURE_ID]!);b.rawArtifacts[A29_CAPTURE_ID]=changed;captureRecord(b).contentHash=sha(changed);}],
    ['restamped-clock',b=>{captureRecord(b).retrievedAt=captureRecord(b).availableAt;}],
    ['live-adapter',b=>{captureRecord(b).adapterVersion='live-v1';}],
    ['historical-receipt',b=>{captureRecord(b).sourceType='HISTORICAL_RECEIPT';}],
    ['extra-scope-key',b=>{captureRecord(b).scope.fresh=true;}],
    ['orphan-second-record',b=>{const r=structuredClone(captureRecord(b));r.id='advisory-a29-shadow';b.evidence.push(r);b.rawArtifacts[r.id]=b.rawArtifacts[A29_CAPTURE_ID]!;}],
  ];
  for(const [name,change] of forgeries){const b=structuredClone(bundle);change(b);assert.throws(rebuild(b,proof),/ADVISORY_PROOF_INVALID/,name);}
  assert.throws(rebuild(bundle,{...proof,a29:{...proof.a29,label:decoded.label+'-other'}}),/ADVISORY_PROOF_INVALID/);
  await assert.rejects(collect({a29Capture:c.raw,now:c.after}),/A29_CAPTURE_INVALID/);
  await withService('a29-capture-',(service,file)=>{
    const saved=service.analyzeLive(bundle);assert.deepEqual(service.replay(saved.id),saved);assert.deepEqual(service.show(saved.id),saved);
    const reader=new Service(file);try{assert.deepEqual(reader.replay(saved.id),saved);}finally{reader.close();}
    const cited=structuredClone(bundle);cited.details!.baseline.find(a=>a.id!=='O28')!.evidenceIds.push(A29_CAPTURE_ID);assert.throws(()=>service.analyzeLive(cited),/ADVISORY_PROOF_INVALID/);
    const forged=structuredClone(bundle),m=forged.details!.advisory!.metrics.find(x=>x.id==='A29')!;m.data={claim:'absorbed'};if(m.quality!=='KNOWN'){m.quality='KNOWN';for(const g of forged.details!.advisory!.groups)if(g.unresolved.includes('A29')){g.known++;g.unresolved=g.unresolved.filter(id=>id!=='A29');}}
    assert.throws(()=>service.analyzeLive(forged),/ADVISORY_A29_DATA|ADVISORY_PROOF_INVALID/);
    const access=structuredClone(bundle);captureRecord(access).accessMode='PUBLIC_API';assert.throws(()=>service.analyzeLive(access),/LIVE_PROVENANCE_INVALID/);
    const future=structuredClone(bundle);captureRecord(future).availableAt=new Date(Date.parse(future.cutoff)+1000).toISOString();assert.throws(()=>service.analyzeLive(future),/FUTURE_EVIDENCE/);
  });
  const directory=mkdtempSync(join(tmpdir(),'a29-cli-capture-'));
  try{
    const file=join(directory,'capture.json'),db=join(directory,'cli.sqlite');writeFileSync(file,c.raw);let out='';
    const run=(args:string[])=>runCli(args,{env:{},fetcher:a29LiveFetcher(c.token.address,c.after),now:()=>c.after,isInteractive:false,stdout:text=>{out+=text;},stderr:()=>{}});
    assert.equal(await run(['analyze',c.token.address,'--partial','--advisory','--a29-capture',file,'--db',db,'--json']),0);
    const saved=JSON.parse(out);out='';
    assert.deepEqual(saved.details.advisory.metrics.find((x:{id:string})=>x.id==='A29'),metric);
    assert.equal(await run(['show',saved.id,'--db',db,'--json']),0);assert.deepEqual(JSON.parse(out),saved);out='';
    assert.equal(await run(['replay',saved.id,'--db',db,'--json']),0);assert.deepEqual(JSON.parse(out),saved);
  }finally{rmSync(directory,{recursive:true,force:true});}
  return metric;
}

test('fresh advisory proof v38 carries an explicit null a29 key, facts v37 and policy v35, and replays without any A29 import',async()=>{
  const bundle=await collect(),proof=JSON.parse(bundle.rawArtifacts['advisory-derivation']!),facts=bundle.details!.advisory!,a29=facts.metrics.find(m=>m.id==='A29')!;
  assert.deepEqual([proof.method,proof.saturation,proof.a29,facts.method],['advisory-provenance-v40',null,null,'advisory-measurements-v39']);
  assert.notEqual(a29.quality,'KNOWN');assert.notEqual((a29.data as {method?:string}|null)?.method,'prospective-same-slot-absorption-v1');
  assert.ok(!bundle.evidence.some(e=>e.sourceId===A29_SOURCE_ID||e.adapterVersion===A29_CAPTURE_ADAPTER||e.id.startsWith('advisory-a29-')));
  await withService('a29-fresh-',(service,file)=>{
    const saved=service.analyzeLive(bundle);assert.deepEqual(service.replay(saved.id),saved);
    const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string).policyVersion,'research-screen-advisory-v37');}finally{db.close();}
  });
});

test('an A29 record, descriptor or archive that is not one bound imported capture cannot enter a proof',async()=>{
  const bundle=await collect(),proof=JSON.parse(bundle.rawArtifacts['advisory-derivation']!);
  const cases:Array<[string,(b:LiveRun)=>unknown]>=[
    ['orphan-under-null-descriptor',b=>{attach(b,garbage,'ClaudeAI');return proof;}],
    ['orphan-by-prefix',b=>{attach(b,garbage,'ClaudeAI',r=>{r.id='advisory-a29-extra';r.sourceId='advisory-context';r.adapterVersion='live-v1';});return proof;}],
    ['orphan-by-adapter',b=>{attach(b,garbage,'ClaudeAI',r=>{r.id='loose-a29';r.sourceId='advisory-context';});return proof;}],
    ['v36-proof-with-descriptor',b=>({...proof,method:'advisory-provenance-v36',a29:attach(b,garbage,'ClaudeAI')})],
    ['v38-proof-without-key',()=>{const p={...proof};delete p.a29;return p;}],
    ['undecodable-capture',b=>({...proof,a29:attach(b,garbage,'ClaudeAI')})],
    ['live-adapter-spoof',b=>({...proof,a29:attach(b,garbage,'ClaudeAI',r=>{r.adapterVersion='live-v1';})})],
    ['historical-receipt-spoof',b=>({...proof,a29:attach(b,garbage,'ClaudeAI',r=>{r.sourceType='HISTORICAL_RECEIPT';})})],
    ['public-api-spoof',b=>({...proof,a29:attach(b,garbage,'ClaudeAI',r=>{r.accessMode='PUBLIC_API';})})],
    ['stale-content-hash',b=>({...proof,a29:attach(b,garbage,'ClaudeAI',r=>{r.contentHash='0'.repeat(64);})})],
    ['forged-file-hash',b=>{const d=attach(b,garbage,'ClaudeAI');d.requests.capture.fileSha256='0'.repeat(64);return {...proof,a29:d};}],
    ['plain-body-under-archive',b=>{const d=attach(b,garbage,'ClaudeAI');b.rawArtifacts[A29_CAPTURE_ID]=garbage;captureRecord(b).contentHash=sha(garbage);return {...proof,a29:d};}],
    ['duplicate-record',b=>{const d=attach(b,garbage,'ClaudeAI');b.evidence.push(structuredClone(captureRecord(b)));return {...proof,a29:d};}],
  ];
  for(const [name,make] of cases){const b=structuredClone(bundle),p=make(b);assert.throws(rebuild(b,p),/ADVISORY_PROOF_INVALID/,name);}
  await withService('a29-forged-',service=>{
    const orphan=structuredClone(bundle);attach(orphan,garbage,'ClaudeAI');assert.throws(()=>service.analyzeLive(orphan),/ADVISORY_PROOF_INVALID/);
    const access=structuredClone(bundle);attach(access,garbage,'ClaudeAI',r=>{r.accessMode='PUBLIC_API';});assert.throws(()=>service.analyzeLive(access),/LIVE_PROVENANCE_INVALID/);
    const declared=structuredClone(bundle),p=JSON.parse(declared.rawArtifacts['advisory-derivation']!);p.a29=attach(declared,garbage,'ClaudeAI');
    declared.rawArtifacts['advisory-derivation']=JSON.stringify(p);declared.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=sha(declared.rawArtifacts['advisory-derivation']!);
    assert.throws(()=>service.analyzeLive(declared),/ADVISORY_PROOF_INVALID/);
  });
  await assert.rejects(collect({a29Capture:garbage}),/A29_CAPTURE_INVALID/);
  await assert.rejects(collect({a29Capture:garbage,advisory:false}),/A29_ADVISORY_REQUIRED/);
});

test('the CLI imports --a29-capture only into a live --advisory analysis and fails closed before any read',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'a29-cli-'));let reads=0;
  try{
    const file=join(directory,'capture.json'),db=join(directory,'cli.sqlite');writeFileSync(file,garbage);
    const run=async(args:string[])=>{let err='';const code=await runCli(args,{env:{},fetcher:async()=>{reads++;throw new Error('UNEXPECTED_READ');},now:()=>at,isInteractive:false,stdout:()=>{},stderr:text=>{err+=text;}});return {code,err};};
    let r=await run(['analyze',token.address,'--partial','--a29-capture',file,'--db',db,'--json']);assert.equal(r.code,2);assert.match(r.err,/A29_ADVISORY_REQUIRED/);
    r=await run(['analyze',token.address,'--partial','--advisory','--a29-capture','--db',db]);assert.equal(r.code,2);assert.match(r.err,/FLAG_VALUE_REQUIRED/);
    r=await run(['analyze',token.address,'--bundle',file,'--a29-capture',file,'--db',db]);assert.equal(r.code,2);assert.match(r.err,/A29_ADVISORY_REQUIRED/);
    r=await run(['analyze',token.address,'--partial','--advisory','--a29-capture',file,'--db',db,'--json']);assert.equal(r.code,2);assert.match(r.err,/A29_CAPTURE_INVALID/);
    assert.equal(reads,0);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('a portable constructed capture yields a KNOWN zero-activity A29 and survives proof forgeries, Service and CLI show/replay',async()=>{
  const c=await buildA29Capture(),metric=await exerciseImportedCapture(c);
  assert.equal(metric.quality,'KNOWN');
  const d=metric.data as any,v=d.vector;
  assert.deepEqual([d.method,d.label,d.status,d.provenance.accessMode,d.provenance.freshLive,d.interval.seconds],['prospective-same-slot-absorption-v1',c.label,'KNOWN','USER_IMPORT',false,700]);
  assert.deepEqual(v.cohort.map((o:{owner:string})=>o.owner),c.cohort);
  assert.deepEqual([v.selling.trades,v.selling.netSellBaseAtomic,v.inventory.deltaAtomic,v.inventory.residualAtomic,v.newBuyerGrowth.warmup.meaningfulBuyers,v.newBuyerGrowth.baseline.meaningfulBuyers,v.newBuyerGrowth.measured.meaningfulBuyers,v.newBuyerGrowth.difference,v.newBuyerGrowth.ratio,v.depthChange.quoteDeltaAtomic,v.priceChange.fraction],[0,'0','0','0',0,0,0,0,null,'0','0']);
  assert.deepEqual(v.endpoints.e0.concentration,v.endpoints.e1.concentration);
  assert.deepEqual(v.concentrationChange,{supply:{top1:'0',top5:'0',top10:'0'},vaultAdjusted:{top1:'0',top5:'0',top10:'0'}});
  assert.ok(a29DataSchema.safeParse(d).success);
  const forge=(change:(f:any)=>void)=>{const f=structuredClone(d);change(f);return a29DataSchema.safeParse(f);};
  const concentrationRejected=(r:ReturnType<typeof forge>)=>!r.success&&r.error.issues.some(i=>i.message==='ADVISORY_A29_CONCENTRATION');
  // A real e1 shift with its exact signed difference is accepted.
  assert.ok(forge(f=>{f.vector.endpoints.e1.concentration.supply.top1='0';f.vector.concentrationChange.supply.top1=new Decimal(0).minus(v.endpoints.e0.concentration.supply.top1).toFixed();}).success);
  assert.ok(concentrationRejected(forge(f=>{f.vector.concentrationChange.supply.top1='0.01';})),'invented difference');
  assert.ok(concentrationRejected(forge(f=>{f.vector.concentrationChange.vaultAdjusted.top5='1';})),'ratio e1/e0 posing as difference');
  assert.ok(concentrationRejected(forge(f=>{f.vector.concentrationChange.vaultAdjusted.top10='-0';f.vector.endpoints.e1.concentration.vaultAdjusted.top10='1';})),'endpoint share moved without its difference');
  assert.ok(!forge(f=>{delete f.vector.concentrationChange;}).success,'missing fifth component');
});

test('constructed source, mint, slot and cache tampering never certify A29',async()=>{
  const c=await buildA29Capture(),wrapper=JSON.parse(c.raw);
  assert.equal(unpackA29Capture(archiveA29Capture(c.raw)),c.raw);
  assert.throws(()=>unpackA29Capture(appendCompressed(archiveA29Capture(c.raw))),/A29_CAPTURE_ARCHIVE_INVALID/);
  const variant=(change:(w:any)=>void)=>{const w=structuredClone(wrapper);change(w);return JSON.stringify(w);};
  const notKnown=(raw:string)=>{try{const x=decodeA29Capture(raw);return deriveA29Absorption(x.freeze,x.label,x.receipts,c.after,[A29_CAPTURE_ID]).quality!=='KNOWN';}catch{return true;}};
  const rejected:Array<[string,string]>=[
    ['source-bytes-without-hash',variant(w=>{w.rawArtifacts['a29-e1-bank']=w.rawArtifacts['a29-e1-bank'].replace('400001750','400001751');})],
    ['wrapper-mint',variant(w=>{w.token.address=c.controlMint;})],
    ['frozen-mint',variant(w=>{w.freeze.tokens[1].mint=c.controlMint;})],
    ['metric-cache',variant(w=>{w.metric={id:'A29',quality:'KNOWN',data:{absorbed:true}};})],
    ['private-genesis',variant(w=>{w.rawArtifacts['a29-e1-genesis']=JSON.stringify({jsonrpc:'2.0',result:'1'.repeat(44),id:1});})],
  ];
  for(const [name,raw] of rejected){assert.throws(()=>decodeA29Capture(raw),Error,name);await assert.rejects(collect({a29Capture:raw,address:c.token.address,now:c.after}),/A29_CAPTURE_INVALID/,name);}
  // Honestly hashed but semantically wrong captures may decode; they never yield a KNOWN vector.
  assert.ok(notKnown((await buildA29Capture({e1PopulationSlotDelta:1})).raw),'mismatched endpoint1 slot');
  assert.ok(notKnown(variant(w=>{w.freeze.tokens[1].cohort[0].balanceAtomic='1';})),'freeform cohort count');
  assert.ok(notKnown(variant(w=>{w.freeze.tokens[1].cohort.reverse();})),'reordered cohort');
});

const genuine=loadA29Capture();
test('the retained genuine capture replays through the same path (supplementary)',{skip:genuine?false:'A29_CAPTURE_FILE does not name the retained genuine a29-retained-sources-v1 capture'},async()=>{
  await exerciseImportedCapture(genuine!);
});
