import assert from 'node:assert/strict';
import test from 'node:test';
import { closeSync,ftruncateSync,mkdtempSync,openSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { collectLiveToken } from '../src/app/live.js';
import { Service } from '../src/app/service.js';
import { starterProfile } from '../src/app/config.js';
import { runCli } from '../src/cli.js';
import { reconstructAdvisory,a29CaptureRequest,a29CaptureRequestV2,A29_CAPTURE_ADAPTER,A29_V2_CAPTURE_ADAPTER,A29_CAPTURE_ID } from '../src/app/advisory.js';
import { decodeA29CaptureV2,deriveA29AbsorptionV2 } from '../src/providers/advisory-absorption-v2.js';
import { a29DataSchema,a29DataSchemaV2,advisoryFactsSchema } from '../src/domain/advisory-contracts.js';
import { a29LiveFetcher,buildA29Capture } from './a29-fixtures.js';
import { buildA29CaptureV2 } from './a29-v2-integration-fixtures.js';

const WSOL='So11111111111111111111111111111111111111112',other='3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump';
const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
type C={raw:string;token:{address:string};after:string};
const collect=(raw:string,c:{token:{address:string};after:string})=>collectLiveToken({chain:'solana',address:c.token.address},{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher:a29LiveFetcher(c.token.address,c.after),now:()=>c.after,a29Capture:raw});
type LiveRun=Awaited<ReturnType<typeof collect>>;
const rebuild=(b:LiveRun,proof:unknown)=>()=>reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);
const rec=(b:LiveRun)=>b.evidence.find(e=>e.id===A29_CAPTURE_ID)!;
const metric=(b:LiveRun)=>b.details!.advisory!.metrics.find(m=>m.id==='A29')!;
async function withService(name:string,run:(service:Service,file:string)=>void|Promise<void>){
  const directory=mkdtempSync(join(tmpdir(),name)),file=join(directory,'live.sqlite'),service=new Service(file);
  try{await run(service,file);}finally{service.close();rmSync(directory,{recursive:true,force:true});}
}

test('fresh proof v40 keeps the exact v1 dispatch, archive and native units',async()=>{
  const c=await buildA29Capture(),b=await collect(c.raw,c),proof=JSON.parse(b.rawArtifacts['advisory-derivation']!),m=metric(b);
  assert.deepEqual([proof.method,b.details!.advisory!.method,rec(b).adapterVersion,proof.a29.requests.capture.method],['advisory-provenance-v40','advisory-measurements-v39',A29_CAPTURE_ADAPTER,'a29-capture-import-v1']);
  assert.equal(m.quality,'KNOWN');assert.ok(a29DataSchema.safeParse(m.data).success);assert.equal((m.data as any).vector.units.quoteMint,WSOL);
  await withService('a29-v1-fresh-',service=>{const saved=service.analyzeLive(b);assert.deepEqual(service.replay(saved.id),saved);});
});

test('a SYNTHETIC v2 WSOL packet derives KNOWN zero activity via exact v2 dispatch and survives forgeries, Service and reopen',async()=>{
  const c=await buildA29CaptureV2(),b=await collect(c.raw,c),proof=JSON.parse(b.rawArtifacts['advisory-derivation']!),r=rec(b);
  assert.deepEqual([proof.method,r.adapterVersion,r.sourceType,r.accessMode,r.retrievedAt,r.availableAt,b.rawArtifacts[A29_CAPTURE_ID],r.contentHash],['advisory-provenance-v40',A29_V2_CAPTURE_ADAPTER,'RECONSTRUCTED_HISTORY','USER_IMPORT',c.latestClock,c.after,c.raw,sha(c.raw)]);
  assert.deepEqual(proof.a29.requests.capture,a29CaptureRequestV2(c.raw,c.label));
  const x=decodeA29CaptureV2(c.raw),m=metric(b),d=m.data as any;
  assert.deepEqual(m,deriveA29AbsorptionV2(x.freeze,x.label,x.receipts,b.cutoff,[A29_CAPTURE_ID]));
  assert.equal(m.quality,'KNOWN');
  assert.deepEqual([d.method,d.instrument.thresholdSource,d.instrument.meaningfulBuyerQuoteAtomic,d.vector.units.quoteMint,d.vector.units.fx,d.vector.selling.trades,d.vector.inventory.residualAtomic],['prospective-same-slot-absorption-v2','NATIVE','10000000',WSOL,null,0,'0']);
  assert.ok(a29DataSchemaV2.safeParse(d).success&&!a29DataSchema.safeParse(d).success);
  const forge=(f:(v:any)=>void)=>{const v=structuredClone(d);f(v);return a29DataSchemaV2.safeParse(v).success;};
  assert.ok(!forge(v=>{v.vector.units.fx={pool:'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',sqrtPriceX64:'1',bankSlot:v.interval.slot0};}),'wsol fx');
  assert.ok(!forge(v=>{v.instrument.meaningfulBuyerQuoteAtomic='10000001';}),'threshold');
  assert.ok(!forge(v=>{v.instrument.thresholdSource='E0_ORCA_WHIRLPOOL_MARGINAL';}),'threshold source');
  assert.ok(!forge(v=>{v.vector.units.quoteDecimals=6;}),'decimals');
  assert.ok(!forge(v=>{v.vector.selling.netSellBaseAtomic='1';}),'v1 arithmetic kept');
  assert.ok(!forge(v=>{v.vector=null;}),'status/vector');
  const facts=b.details!.advisory!;assert.ok(advisoryFactsSchema.safeParse(facts).success);
  assert.ok(!advisoryFactsSchema.safeParse({...facts,method:'advisory-measurements-v37'}).success,'facts37 v1 only');
  const loose=structuredClone(facts);loose.metrics.find(z=>z.id==='A29')!.data={...d,vector:{...d.vector,depthChange:{quoteDeltaAtomic:'5',ratio:null}}};assert.ok(!advisoryFactsSchema.safeParse(loose).success);
  const forgeries:Array<[string,(x:LiveRun,p:any)=>void]>=[
    ['proof-v38',(_,p)=>{p.method='advisory-provenance-v38';}],
    ['v1-adapter-label',x=>{rec(x).adapterVersion=A29_CAPTURE_ADAPTER;}],
    ['changed-bytes',x=>{const s=c.raw+' ';x.rawArtifacts[A29_CAPTURE_ID]=s;rec(x).contentHash=sha(s);}],
    ['v1-request',(x,p)=>{const q=a29CaptureRequest(c.raw,c.label);p.a29.requests.capture=q;rec(x).scope={request:q};}],
    ['restamped-clock',x=>{rec(x).retrievedAt=rec(x).availableAt;}],
    ['stale-hash',x=>{rec(x).contentHash='0'.repeat(64);}],
    ['orphan',x=>{const o={...rec(x),id:'advisory-a29-shadow'};x.evidence.push(o);x.rawArtifacts[o.id]=c.raw;}],
    ['descriptor-absent',(_,p)=>{p.a29=null;}],
  ];
  for(const [n,f] of forgeries){const x=structuredClone(b),p=structuredClone(proof);f(x,p);assert.throws(rebuild(x,p),/ADVISORY_PROOF_INVALID/,n);}
  await assert.rejects(collect(c.raw,{token:{address:other},after:c.after}),/A29_CAPTURE_INVALID/);
  await withService('a29-v2-',(service,file)=>{
    const saved=service.analyzeLive(b);assert.deepEqual(service.analyzeLive(b),saved);assert.deepEqual(service.replay(saved.id),saved);
    const reader=new Service(file);try{assert.deepEqual(reader.replay(saved.id),saved);}finally{reader.close();}
  });
});

test('only the fully validated owned v2 record leaves the default artifact budget',async()=>{
  const c=await buildA29CaptureV2({pad:25_000_000}),b=await collect(c.raw,c);
  assert.ok(Buffer.byteLength(b.rawArtifacts[A29_CAPTURE_ID]!)>24_000_000);
  await withService('a29-v2-big-',service=>{
    const saved=service.analyzeLive(b);assert.deepEqual(service.replay(saved.id),saved);
    const foreign=structuredClone(b),pad=' '.repeat(24_000_000);
    foreign.evidence.push({id:'a29-v2-foreign-pad',sourceId:'local-config',sourceType:'CONFIG',retrievedAt:b.cutoff,availableAt:b.cutoff,contentHash:sha(pad),adapterVersion:'live-v1',accessMode:'LOCAL_DERIVED',scope:{}});foreign.rawArtifacts['a29-v2-foreign-pad']=pad;
    assert.throws(()=>service.analyzeLive(foreign),/ARTIFACT_HASH_OR_SIZE/);
    const relabeled=structuredClone(b);rec(relabeled).adapterVersion=A29_CAPTURE_ADAPTER;assert.throws(()=>service.analyzeLive(relabeled),/ARTIFACT_HASH_OR_SIZE/);
    const unbound=structuredClone(b);rec(unbound).scope={request:{...rec(unbound).scope.request as object,label:'other'}};assert.throws(()=>service.analyzeLive(unbound),/ARTIFACT_HASH_OR_SIZE/);
  });
});

test('the CLI applies the 128 MB stat cap, strict UTF-8 and method dispatch before any read, and replays a v2 import',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'a29-v2-cli-'));let reads=0;
  try{
    const db=join(directory,'cli.sqlite'),big=join(directory,'big.json'),v1big=join(directory,'v1big.json'),bad=join(directory,'bad.json');
    const fd=openSync(big,'w');ftruncateSync(fd,128_000_001);closeSync(fd);
    writeFileSync(v1big,JSON.stringify({method:'a29-retained-sources-v1'})+' '.repeat(24_000_001));writeFileSync(bad,Buffer.from([0x7b,0xff,0x7d]));
    const fail=async(file:string)=>{let err='';const code=await runCli(['analyze',other,'--partial','--advisory','--a29-capture',file,'--db',db,'--json'],{env:{},fetcher:async()=>{reads++;throw new Error('UNEXPECTED_READ');},now:()=>'2026-10-10T12:30:00.000Z',isInteractive:false,stdout:()=>{},stderr:t=>{err+=t;}});return {code,err};};
    let r=await fail(big);assert.equal(r.code,2);assert.match(r.err,/A29_CAPTURE_TOO_LARGE/);
    r=await fail(v1big);assert.equal(r.code,2);assert.match(r.err,/A29_CAPTURE_INVALID/);
    r=await fail(bad);assert.equal(r.code,2);assert.match(r.err,/A29_CAPTURE_INVALID/);
    assert.equal(reads,0);
    const c:C=await buildA29CaptureV2(),file=join(directory,'v2.json');writeFileSync(file,c.raw);let out='';
    const run=(args:string[])=>runCli(args,{env:{},fetcher:a29LiveFetcher(c.token.address,c.after),now:()=>c.after,isInteractive:false,stdout:t=>{out+=t;},stderr:()=>{}});
    assert.equal(await run(['analyze',c.token.address,'--partial','--advisory','--a29-capture',file,'--db',db,'--json']),0);
    const saved=JSON.parse(out);out='';assert.equal(saved.details.advisory.metrics.find((m:{id:string})=>m.id==='A29').quality,'KNOWN');
    assert.equal(await run(['replay',saved.id,'--db',db,'--json']),0);assert.deepEqual(JSON.parse(out),saved);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

// Codex ingress regression requested by root: archive integrity cannot be deferred past
// an earlier genuine acquisition gap when a packet earns the dedicated v2 budget.
test('v2 validates every retained archive before returning an earlier MISSING acquisition gap',async()=>{
  const c=await buildA29CaptureV2(),packet=JSON.parse(c.raw);
  const remove=(p:any,id:string)=>{delete p.requests[id];delete p.rawArtifacts[id];delete p.retrievedAt[id];p.provenance.records=p.provenance.records.filter((r:any)=>r.key!==id);};
  remove(packet,'a29-e0-bank');
  const valid=JSON.stringify(packet)+' '.repeat(25_000_000),b=await collect(valid,c);
  assert.equal(metric(b).quality,'MISSING','valid incomplete capture remains honest and eligible for its own budget');
  await withService('a29-v2-incomplete-',service=>{const saved=service.analyzeLive(b);assert.deepEqual(service.replay(saved.id),saved);});
  const forgeries:Array<[string,(p:any)=>void]>=[
    ['malformed unused archive',p=>{p.rawArtifacts['a29-e1-bank']='not-an-archive';}],
    ['unused source hash mismatch',p=>{p.provenance.records.find((r:any)=>r.key==='a29-e1-bank').sourceSha256='0'.repeat(64);}],
    ['unused source role bound',p=>{p.provenance.records.find((r:any)=>r.key==='a29-e1-bank').sourceBytes=20_000_001;}],
  ];
  for(const [name,mutate] of forgeries){const forged=structuredClone(packet);mutate(forged);assert.throws(()=>decodeA29CaptureV2(JSON.stringify(forged)),name);}
});
