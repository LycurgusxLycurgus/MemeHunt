import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {starterProfile} from '../src/app/config.js';
import {Service} from '../src/app/service.js';
import {runCli} from '../src/cli.js';
import {loadO23BulkCapture} from '../src/providers/advisory-synchrony-bulk-import.js';
import {createO29BulkCapture,reserveContiguousFixture} from './reserve-bulk-fixtures.js';
import {bulkSha} from './synchrony-bulk-fixtures.js';

type Bundle=Awaited<ReturnType<typeof collectLiveToken>>;
const proof=(b:Bundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const metric=(b:Bundle,id='O29')=>b.details!.advisory!.metrics.find(m=>m.id===id)!;
const rebuild=(b:Bundle)=>reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,proof(b),b.thesis??null,b.features);
function stamp(b:Bundle,p:any){b.rawArtifacts['advisory-derivation']=JSON.stringify(p);b.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=bulkSha(b.rawArtifacts['advisory-derivation']!);}
const collect=(f:ReturnType<typeof createO29BulkCapture>,reserve=true)=>collectLiveToken(f.token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,o23BulkCapture:f.directory,...(reserve?{o29ReservePath:true}:{}),fetcher:f.fetcher,now:()=>f.cutoff});

test('reserve fixture retains three contiguous genuine page0 objects and explicitly constructs only a subset census',()=>{
 const f=reserveContiguousFixture();assert.match(f.notice,/NOT getTransaction RPC responses/);assert.match(f.notice,/not actual whole history/);assert.equal(f.transactions.length,3);
 assert.equal(f.bulkSource.page,0);assert.match(f.bulkSource.sourceHash,/^[a-f0-9]{64}$/);assert.equal(f.bulkSource.retrievedAt.length>0,true);
 for(const [i,t]of f.transactions.entries()){assert.equal(t.meta.err,null);assert.ok(Number.isSafeInteger(t.transactionIndex));assert.ok(Number.isSafeInteger(t.blockTime));assert.equal(typeof t.transaction.signatures[0],'string');if(i)assert.ok(f.transactions[i-1].slot>=t.slot);}
});

test('proof53 derives quote-reserve path from the same sources while all other52 metrics and features remain identical',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o29-reserve-import-'));try{
  const f=createO29BulkCapture(join(dir,'capture'));assert.deepEqual(loadO23BulkCapture(f.directory,f.token,f.cutoff),f.source);
  const previous=await collect(f,false),current=await collect(f),m=metric(current),data=m.data as any;
  assert.equal(proof(previous).method,'advisory-provenance-v52');assert.equal(previous.details!.advisory!.method,'advisory-measurements-v51');
  assert.equal(proof(current).method,'advisory-provenance-v53');assert.equal(current.details!.advisory!.method,'advisory-measurements-v52');
  assert.equal(m.quality,'KNOWN');assert.equal(m.reasonCode,'EFFECTIVE_RESERVE_PATH_OBSERVED');assert.equal(data.method,'complete-pool-effective-reserve-path-v2');
  assert.equal(data.quoteMint,'3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh');assert.equal(data.quoteDecimals,8);
  assert.ok(data.gates.checkedTrades>=2);assert.equal(data.gates.curveMatches,data.gates.checkedTrades);assert.equal(data.gates.curveMismatches,0);assert.equal(data.gates.continuityPairs,data.gates.checkedTrades-1);assert.equal(data.gates.effectiveDiscontinuities,0);
  for(const key of ['depthAtDefinedImpact','cohortBaseline','anomaly','thinLiquidity','offsetCause'])assert.equal(data[key],null,key);
  assert.equal(data.depthStatus,'FIXED_SIZE_NOT_DECLARED');assert.equal(data.anomalyStatus,'ANOMALY_REQUIRES_COHORT_BASELINE');
  assert.equal(data.whole.modelledPost.basis,'MODELLED_CURVE_ENDPOINT');assert.equal(data.hours.length,12);
  for(const h of data.hours.filter((h:any)=>h.trades===0)){assert.equal(h.buyCoreQuoteAtomic,'0');assert.equal(h.sellCoreQuoteAtomic,'0');assert.equal(h.firstEventPre,null);assert.equal(h.modelledPost,null);}
  assert.deepEqual(current.features,previous.features);assert.deepEqual(current.details!.baseline,previous.details!.baseline);
  assert.deepEqual(current.details!.advisory!.metrics.filter(m=>m.id!=='O29'),previous.details!.advisory!.metrics.filter(m=>m.id!=='O29'));
  assert.deepEqual(metric(current,'O23'),metric(previous,'O23'));assert.deepEqual(Object.fromEntries(Object.entries(current.rawArtifacts).filter(([id])=>id!=='advisory-derivation')),Object.fromEntries(Object.entries(previous.rawArtifacts).filter(([id])=>id!=='advisory-derivation')));
  assert.deepEqual(rebuild(current),current.details!.advisory);
  const p=proof(current);assert.deepEqual(p.synchronyBulk,proof(previous).synchronyBulk);assert.equal(Object.keys(p).filter(k=>/reserve/i.test(k)).length,0,'parent53 is the financial-purpose marker; no duplicate descriptor');
  assert.ok(!f.calls.some(c=>c.method==='getTransactionsForAddress'),'import causes no new bulk source reads');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('proof53 persists and CLI propagates reserve purpose; proof52 never authorizes O29 source citations',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o29-reserve-persist-'));try{
  const f=createO29BulkCapture(join(dir,'capture')),current=await collect(f),previous=await collect(f,false),file=join(dir,'live.sqlite');let id='';
  let service=new Service(file);try{const saved=service.analyzeLive(current);id=saved.id;assert.equal(service.analyzeLive(current).id,id);assert.deepEqual(service.replay(id),saved);
   const old=structuredClone(previous);metric(old).evidenceIds.push(old.evidence.find(e=>e.id.startsWith('advisory-synchrony-bulk-'))!.id);assert.throws(()=>service.analyzeLive(old),/ADVISORY_PROOF_INVALID/);
  }finally{service.close();}
  service=new Service(file);try{assert.equal(service.show(id).details!.advisory!.method,'advisory-measurements-v52');assert.deepEqual(service.replay(id),service.show(id));}finally{service.close();}
  const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(id)!.semantic as string).policyVersion,'research-screen-advisory-v50');}finally{db.close();}
  let out='',error='',reads=0;
  assert.equal(await runCli(['replay',id,'--db',file,'--json'],{env:{},isInteractive:false,fetcher:async()=>{reads++;throw Error('NETWORK_DENIED');},stdout:x=>out+=x,stderr:x=>error+=x}),0,error);assert.equal(reads,0);assert.equal(JSON.parse(out).details.advisory.method,'advisory-measurements-v52');
  out='';error='';assert.equal(await runCli(['analyze',f.token.address,'--chain','solana','--partial','--advisory','--o28-expanded','--o23-bulk-capture',f.directory,'--o29-reserve-path','--db',join(dir,'cli.sqlite'),'--config',join(dir,'config.json'),'--json'],{env:{},isInteractive:false,fetcher:f.fetcher,now:()=>f.cutoff,stdout:x=>out+=x,stderr:x=>error+=x}),0,error);
  const cli=JSON.parse(out);assert.equal(cli.details.advisory.method,'advisory-measurements-v52');assert.equal(cli.details.advisory.metrics.find((m:any)=>m.id==='O29').quality,'KNOWN');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('reserve purpose rejects cache, descriptor/version/ownership and source laundering',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o29-reserve-guards-'));try{const f=createO29BulkCapture(join(dir,'capture')),original=await collect(f),service=new Service(join(dir,'live.sqlite'));
  try{for(const mutate of [
   (b:Bundle)=>{const p=proof(b);p.method='advisory-provenance-v52';stamp(b,p);},
   (b:Bundle)=>{const p=proof(b);delete p.synchronyBulk;stamp(b,p);},
   (b:Bundle)=>{const p=proof(b);p.synchronyBulk.requests['bulk-page-0'].params[1].limit=501;stamp(b,p);},
   (b:Bundle)=>{(metric(b).data as any).whole.netCoreQuoteAtomic='1';},
   (b:Bundle)=>{const e=b.evidence.find(e=>e.id.startsWith('advisory-synchrony-bulk-'))!;e.adapterVersion='forged';},
   (b:Bundle)=>{const e=b.evidence.find(e=>e.id.startsWith('advisory-synchrony-bulk-'))!;e.accessMode='PUBLIC_API';},
   (b:Bundle)=>{const e=b.evidence.find(e=>e.id.startsWith('advisory-synchrony-bulk-'))!;e.availableAt='2026-10-29T16:00:01.000Z';},
   (b:Bundle)=>{const e=b.evidence.find(e=>e.id.startsWith('advisory-synchrony-bulk-'))!;b.rawArtifacts[e.id]+=' ';},
   (b:Bundle)=>{b.features[0]!.evidenceIds.push(metric(b).evidenceIds.find(id=>id.startsWith('advisory-synchrony-bulk-'))!);},
   (b:Bundle)=>{b.details!.baseline[0]!.evidenceIds.push(metric(b).evidenceIds.find(id=>id.startsWith('advisory-synchrony-bulk-'))!);},
   (b:Bundle)=>{metric(b,'A30').evidenceIds.push(metric(b).evidenceIds.find(id=>id.startsWith('advisory-synchrony-bulk-'))!);},
  ]){const b=structuredClone(original);mutate(b);assert.throws(()=>service.analyzeLive(b),/ADVISORY_PROOF_INVALID|ARTIFACT_HASH_OR_SIZE|EVIDENCE|ADVISORY_SYNCHRONY_BULK_STORAGE_(?:RECORD|MEMBERSHIP)/);}}
  finally{service.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('reserve option requires explicit live Solana imported expanded-advisory purpose before network',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o29-reserve-modes-'));try{const f=createO29BulkCapture(join(dir,'capture'));let reads=0;const fetcher:typeof fetch=async()=>{reads++;throw Error('NETWORK_DENIED');};
  const base={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,o29ReservePath:true,fetcher};
  for(const options of [base,{...base,o23BulkCapture:f.directory,advisoryEnabled:false},{...base,o23BulkCapture:f.directory,o28Expanded:false}])await assert.rejects(collectLiveToken(f.token,options),/O29_RESERVE_PATH_REQUIRED/);
  for(const args of [
   ['analyze','--bundle','absent','--o29-reserve-path'],
   ['analyze',f.token.address,'--partial','--advisory','--o28-expanded','--o29-reserve-path'],
   ['analyze',f.token.address,'--partial','--advisory','--o23-bulk-capture',f.directory,'--o29-reserve-path'],
   ['analyze','0x1111111111111111111111111111111111111111','--chain','bsc','--partial','--advisory','--o28-expanded','--o23-bulk-capture',f.directory,'--o29-reserve-path'],
  ]){let error='';assert.equal(await runCli(args,{env:{},isInteractive:false,fetcher,stdout:()=>{},stderr:x=>error+=x}),2);assert.match(error,/O29_RESERVE_PATH_REQUIRED/);}
  for(const extra of [{o30RegistryAbsence:true},{historicalTopicReuse:true}])await assert.rejects(collectLiveToken(f.token,{...base,o23BulkCapture:f.directory,...extra}),/O29_RESERVE_PATH_REQUIRED/);
  assert.equal(reads,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
