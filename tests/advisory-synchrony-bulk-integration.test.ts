import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {starterProfile} from '../src/app/config.js';
import {Service} from '../src/app/service.js';
import {runCli} from '../src/cli.js';
import {loadO23BulkCapture} from '../src/providers/advisory-synchrony-bulk-import.js';
import {createO23BulkCapture,bulkSha,synchronyResidualFixture} from './synchrony-bulk-fixtures.js';
type Bundle=Awaited<ReturnType<typeof collectLiveToken>>;
const proof=(b:Bundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const metric=(b:Bundle)=>b.details!.advisory!.metrics.find(m=>m.id==='O23')!;
const rebuild=(b:Bundle)=>reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,proof(b),b.thesis??null,b.features);
function stamp(b:Bundle,p:any){b.rawArtifacts['advisory-derivation']=JSON.stringify(p);b.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=bulkSha(b.rawArtifacts['advisory-derivation']!);}
async function collect(f:ReturnType<typeof createO23BulkCapture>,extra:Record<string,unknown>={}){
 return collectLiveToken(f.token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,o23BulkCapture:f.directory,fetcher:f.fetcher,now:()=>f.cutoff,...extra});
}

test('portable residual fixture retains 21 projected public rows and 16 exact compiled RPC sources',()=>{
 const f=synchronyResidualFixture();assert.match(f.notice,/NOT getTransaction RPC responses/);assert.match(f.notice,/not a complete twelve-hour tape/);
 assert.equal(f.cases.length,21);assert.equal(f.cases.filter((c:any)=>c.compiled).length,16);assert.equal(new Set(f.cases.map((c:any)=>c.signature)).size,21);
 const counts:Record<string,number>={};for(const c of f.cases){counts[c.originalFailure]=(counts[c.originalFailure]??0)+1;assert.equal(c.transaction.transaction.signatures[0],c.signature);assert.equal(new Date(c.transaction.blockTime*1000).toISOString(),c.indexAt);assert.match(c.bulkSource.sourceHash,/^[a-f0-9]{64}$/);if(c.compiled){assert.equal(bulkSha(c.compiled.raw),c.compiled.receipt.sourceHash);assert.equal(Buffer.byteLength(c.compiled.raw),c.compiled.receipt.sourceBytes);const v=JSON.parse(c.compiled.raw).result;assert.equal(v.transaction.signatures[0],c.signature);assert.equal(v.slot,c.transaction.slot);assert.equal(v.blockTime,c.transaction.blockTime);assert.equal(c.compiled.receipt.request.params[1].encoding,'json');}}
 assert.deepEqual(counts,{ADVISORY_TRADE_MULTIHOP_EVENT_BINDING:4,ADVISORY_TRADE_LOG_TRUNCATED:4,ADVISORY_TRADE_EVENT_MISSING:1,ADVISORY_TRADE_EVENT_BINDING:1,ADVISORY_TRADE_FEE_BINDING:11});
});

test('proof52 imports retained quote-pool sources, reconstructs O23 only, and preserves old48/51 missing',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o23-import-'));try{
  const f=createO23BulkCapture(join(dir,'capture')),loaded=loadO23BulkCapture(f.directory,f.token,f.cutoff);assert.deepEqual(loaded,f.source);
  const b=await collect(f);assert.equal(proof(b).method,'advisory-provenance-v52');assert.equal(b.details!.advisory!.method,'advisory-measurements-v51');assert.equal(metric(b).quality,'KNOWN');assert.deepEqual(rebuild(b),b.details!.advisory);
  const ids=b.evidence.filter(e=>e.id.startsWith('advisory-synchrony-bulk-'));assert.equal(ids.length,Object.keys(f.source.requests).length);for(const e of ids){assert.equal(e.sourceId,'advisory-synchrony-bulk');assert.equal(e.accessMode,'USER_IMPORT');assert.equal(e.sourceType,'HISTORICAL_RECEIPT');assert.equal(e.adapterVersion,'o23-bulk-receipts-v1');assert.equal(e.contentHash,bulkSha(b.rawArtifacts[e.id]!));}
  assert.ok(!f.calls.some(c=>c.method==='getTransactionsForAddress'),'import issues no bulk transport reads');
  for(const codec of [false,true]){const old=await collectLiveToken(f.token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,...(codec?{o28RpcErrors:true}:{}),fetcher:f.fetcher,now:()=>f.cutoff});assert.equal(proof(old).method,codec?'advisory-provenance-v51':'advisory-provenance-v48');assert.equal(metric(old).quality,'MISSING');assert.ok(!old.evidence.some(e=>e.id.startsWith('advisory-synchrony-bulk-')));assert.deepEqual(old.features,b.features);assert.deepEqual(old.details!.baseline,b.details!.baseline);if(codec)assert.deepEqual(old.details!.advisory!.metrics.filter(m=>m.id!=='O23'),b.details!.advisory!.metrics.filter(m=>m.id!=='O23'));}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('proof52 Service rejects cached facts, namespace laundering, downgrade/orphans and baseline citations',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o23-ownership-'));try{const f=createO23BulkCapture(join(dir,'capture')),original=await collect(f),s=new Service(join(dir,'live.sqlite'));
  try{for(const mutate of [
   (b:Bundle)=>{const p=proof(b);delete p.synchronyBulk;stamp(b,p);},
   (b:Bundle)=>{const p=proof(b);p.method='advisory-provenance-v51';stamp(b,p);},
   (b:Bundle)=>{const p=proof(b);p.synchronyBulk.requests['bulk-page-0'].params[1].limit=501;stamp(b,p);},
   (b:Bundle)=>{const e=b.evidence.find(e=>e.id.startsWith('advisory-synchrony-bulk-'))!;e.accessMode='PUBLIC_API';},
   (b:Bundle)=>{const e=b.evidence.find(e=>e.id.startsWith('advisory-synchrony-bulk-'))!;e.sourceId='advisory-context';},
   (b:Bundle)=>{const e=b.evidence.find(e=>e.id.startsWith('advisory-synchrony-bulk-'))!;e.availableAt='2026-10-29T16:00:01.000Z';},
   (b:Bundle)=>{const e=b.evidence.find(e=>e.id.startsWith('advisory-synchrony-bulk-'))!;b.rawArtifacts[e.id]+=' ';},
   (b:Bundle)=>{const e=structuredClone(b.evidence.find(e=>e.id.startsWith('advisory-synchrony-bulk-'))!);e.id='advisory-synchrony-bulk-orphan';b.evidence.push(e);b.rawArtifacts[e.id]='{}';e.contentHash=bulkSha('{}');},
   (b:Bundle)=>{b.features[0]!.evidenceIds.push(b.evidence.find(e=>e.id.startsWith('advisory-synchrony-bulk-'))!.id);},
   (b:Bundle)=>{b.details!.baseline[0]!.evidenceIds.push(b.evidence.find(e=>e.id.startsWith('advisory-synchrony-bulk-'))!.id);},
   (b:Bundle)=>{b.details!.advisory!.metrics.find(m=>m.id==='O28')!.evidenceIds.push(b.evidence.find(e=>e.id.startsWith('advisory-synchrony-bulk-'))!.id);},
   (b:Bundle)=>{(metric(b).data as any).method='forged-cached-result';},
  ]){const b=structuredClone(original);mutate(b);assert.throws(()=>s.analyzeLive(b),/ADVISORY_PROOF_INVALID|ARTIFACT_HASH_OR_SIZE|EVIDENCE|ADVISORY_SYNCHRONY_BULK_STORAGE_(?:RECORD|MEMBERSHIP)/);}}
  finally{s.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('proof52 persists, reopens, replays offline and CLI propagates the import path',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o23-persist-'));try{const f=createO23BulkCapture(join(dir,'capture')),b=await collect(f),file=join(dir,'live.sqlite');let saved;
  let s=new Service(file);try{saved=s.analyzeLive(b);assert.equal(s.analyzeLive(b).id,saved.id);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
  s=new Service(file);try{assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
  const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string).policyVersion,'research-screen-advisory-v49');}finally{db.close();}
  let out='',error='',network=0;assert.equal(await runCli(['replay',saved.id,'--db',file,'--json'],{env:{},isInteractive:false,fetcher:async()=>{network++;throw Error('NETWORK_DENIED');},stdout:x=>out+=x,stderr:x=>error+=x}),0,error);assert.equal(network,0);assert.deepEqual(JSON.parse(out),saved);
  out='';error='';assert.equal(await runCli(['analyze',f.token.address,'--chain','solana','--partial','--advisory','--o28-expanded','--o23-bulk-capture',f.directory,'--db',join(dir,'cli.sqlite'),'--config',join(dir,'config.json'),'--json'],{env:{},isInteractive:false,fetcher:f.fetcher,now:()=>f.cutoff,stdout:x=>out+=x,stderr:x=>error+=x}),0,error);const cli=JSON.parse(out);assert.equal(cli.details.advisory.method,'advisory-measurements-v51');assert.equal(cli.details.advisory.metrics.find((m:any)=>m.id==='O23').quality,'KNOWN');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('bulk import mode rejects missing prerequisites, mixed modes and unsafe files before network',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o23-modes-'));try{const f=createO23BulkCapture(join(dir,'capture'));let reads=0;const fetcher:typeof fetch=async()=>{reads++;throw Error('NETWORK_DENIED');},base={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o23BulkCapture:f.directory,fetcher};
  for(const options of [base,{...base,o28Expanded:true,o30RegistryAbsence:true},{...base,o28Expanded:true,historicalTopicReuse:true}])await assert.rejects(collectLiveToken(f.token,options),/O23_BULK_ADVISORY_REQUIRED/);
  for(const args of [['analyze','--bundle','absent','--o23-bulk-capture',f.directory],['analyze',f.token.address,'--partial','--advisory','--o23-bulk-capture',f.directory],['analyze',f.token.address,'--partial','--advisory','--o28-expanded','--o30-registry-absence','--o23-bulk-capture',f.directory],['analyze','0x1111111111111111111111111111111111111111','--chain','bsc','--partial','--advisory','--o28-expanded','--o23-bulk-capture',f.directory]]){let error='';assert.equal(await runCli(args,{env:{},isInteractive:false,fetcher,stdout:()=>{},stderr:x=>error+=x}),2);assert.match(error,/O23_BULK_ADVISORY_REQUIRED/);}assert.equal(reads,0);
  const capture=join(f.directory,'capture.json'),original=readFileSync(capture,'utf8'),m=JSON.parse(original);m.receipts[0].file='../outside.json';writeFileSync(capture,JSON.stringify(m));assert.throws(()=>loadO23BulkCapture(f.directory,f.token,f.cutoff),/ADVISORY_SYNCHRONY_BULK_/);writeFileSync(capture,original);
  writeFileSync(join(f.directory,'foreign.json'),'{}');assert.throws(()=>loadO23BulkCapture(f.directory,f.token,f.cutoff),/ADVISORY_SYNCHRONY_BULK_/);rmSync(join(f.directory,'foreign.json'));
  const first=join(f.directory,JSON.parse(original).receipts[0].file),raw=readFileSync(first);rmSync(first);const outside=join(dir,'outside.json');writeFileSync(outside,raw);symlinkSync(outside,first);assert.throws(()=>loadO23BulkCapture(f.directory,f.token,f.cutoff),/ADVISORY_SYNCHRONY_BULK_/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
