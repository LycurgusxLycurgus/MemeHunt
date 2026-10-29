import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {starterProfile} from '../src/app/config.js';
import {Service} from '../src/app/service.js';
import {runCli} from '../src/cli.js';
import {loadO24BulkCapture} from '../src/providers/advisory-creator-inventory-bulk-import.js';
import {deriveO24BulkInventory} from '../src/providers/advisory-creator-inventory-absence.js';
import {createO24InventoryCapture,creatorAbsenceFixture} from './creator-inventory-bulk-fixtures.js';
import {bulkSha} from './synchrony-bulk-fixtures.js';

type Bundle=Awaited<ReturnType<typeof collectLiveToken>>;
const PREFIX='advisory-creator-inventory-bulk-';
const proof=(b:Bundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const metric=(b:Bundle,id='O24')=>b.details!.advisory!.metrics.find(m=>m.id===id)!;
const rebuild=(b:Bundle)=>reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,proof(b),b.thesis??null,b.features);
function stamp(b:Bundle,p:any){b.rawArtifacts['advisory-derivation']=JSON.stringify(p);b.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=bulkSha(b.rawArtifacts['advisory-derivation']!);}
const collect=(f:ReturnType<typeof createO24InventoryCapture>,inventory=true)=>collectLiveToken(f.token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,o28RpcErrors:true,...(inventory?{o24InventoryCapture:f.directory}:{}),fetcher:f.fetcher,now:()=>f.cutoff});

test('portable absence fixture keeps actual critical gaps, creation, twelve canonical bodies and original role index separate',()=>{
 const f=creatorAbsenceFixture();assert.match(f.notice,/NOT synthesized getTransaction RPC responses/);assert.match(f.notice,/NOT the actual 8577-body history/);assert.equal(f.gaps.length,4);assert.equal(f.canonicalBodies.length,12);
 assert.equal(JSON.parse(f.role.rawArtifacts['creator-role-wallet-index']).result.length,1000);
 for(const[k,raw]of Object.entries(f.role.rawArtifacts)){assert.equal(typeof raw,'string');assert.ok(f.role.retrievedAt[k].startsWith('2026-10-26'));}
 assert.equal(f.creation.transaction.transaction.signatures[0],JSON.parse(f.role.rawArtifacts['creator-role-transaction']).result.transaction.signatures[0]);
 const all=[...f.gaps,...f.canonicalBodies,f.creation];assert.equal(new Set(all.map(c=>c.transaction.transaction.signatures[0])).size,17);
 for(const c of all){assert.equal(c.transaction.meta.err,null);assert.match(c.source.sourceHash,/^[a-f0-9]{64}$/);assert.ok(c.source.retrievedAt.startsWith('2026-10-29'));}
 assert.equal(JSON.parse(f.state['ata-head'].raw).result.value,null);assert.equal(JSON.parse(f.state['owner-catalog'].raw).result.value.length,0);
});

test('proof54 derives base-only absence with no pool tape and preserves all other51 metrics/features',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o24-absence-import-'));try{
  const f=createO24InventoryCapture(join(dir,'capture'));assert.deepEqual(loadO24BulkCapture(f.directory,f.token,f.cutoff),f.source);
  const previous=await collect(f,false),current=await collect(f),p=proof(current),m=metric(current),data=m.data as any;
  assert.equal(proof(previous).method,'advisory-provenance-v51');assert.equal(previous.details!.advisory!.method,'advisory-measurements-v50');
  assert.equal(p.method,'advisory-provenance-v54');assert.equal(current.details!.advisory!.method,'advisory-measurements-v53');
  assert.ok(p.creatorInventoryBulk);assert.equal(p.synchronyBulk,undefined);assert.equal(Object.hasOwn(p.creatorInventoryBulk,'pool'),false);assert.equal(Object.hasOwn(p.creatorInventoryBulk,'tape'),false);
  assert.equal(m.quality,'KNOWN');assert.equal(m.reasonCode,'CREATOR_SIGNER_BASE_INVENTORY_ABSENCE_OBSERVED');assert.equal(data.method,'creator-signer-wallet-base-inventory-absence-v2');assert.equal(data.mode,'ABSENCE_ONLY');assert.equal(data.purpose,'O24_BASE_INVENTORY_ABSENCE_ONLY');
  assert.deepEqual(data.interval,f.fixture.interval);assert.equal(data.nonCanonicalAccountsZeroThroughout,true);assert.equal(data.canonical.intervalReferences,0);assert.equal(data.canonical.transactions.length,12);assert.equal(data.canonical.continuityPairs,11);assert.equal(data.canonical.continuityBreaks,0);assert.equal(data.canonical.headAtomic,'0');
  assert.equal(data.walletProof.successfulInspected,17);assert.equal(data.walletProof.unresolvedTransactions,0);
  for(const k of ['startAtomic','endAtomic','netChangeAtomic','poolBuyBaseAtomic','poolSellBaseAtomic','transferInBaseAtomic','transferOutBaseAtomic','mintAtomic','burnAtomic'])assert.equal(data.inventory[k],'0',k);
  assert.equal(data.inventory.legs,0);assert.equal(data.inventory.poolBuyCoreQuoteAtomic,null);assert.equal(data.inventory.poolSellCoreQuoteAtomic,null);assert.equal(data.quoteMint,null);assert.equal(data.quoteDecimals,null);assert.equal(data.quoteBasis,'NOT_MEASURED_BASE_ONLY');
  assert.deepEqual(current.features,previous.features);assert.deepEqual(current.details!.baseline,previous.details!.baseline);assert.deepEqual(current.details!.advisory!.metrics.filter(m=>m.id!=='O24'),previous.details!.advisory!.metrics.filter(m=>m.id!=='O24'));
  for(const id of ['O25','S15','S13','O23','O29'])assert.deepEqual(metric(current,id),metric(previous,id),id);
  const ordinary=(b:Bundle)=>Object.fromEntries(Object.entries(b.rawArtifacts).filter(([id])=>id!=='advisory-derivation'&&!id.startsWith(PREFIX)));assert.deepEqual(ordinary(current),ordinary(previous));
  assert.deepEqual(rebuild(current),current.details!.advisory);
  const ids=current.evidence.filter(e=>e.id.startsWith(PREFIX));assert.equal(ids.length,Object.keys(f.source.requests).length);for(const e of ids){assert.equal(e.sourceId,'advisory-creator-inventory-bulk');assert.equal(e.adapterVersion,'o24-wallet-absence-receipts-v1');assert.equal(e.accessMode,'USER_IMPORT');assert.equal(e.sourceType,'HISTORICAL_RECEIPT');assert.equal(e.contentHash,bulkSha(current.rawArtifacts[e.id]!));}
  assert.ok(!f.calls.some(c=>c.method==='getTransactionsForAddress'),'import does not acquire wallet bulk over live transport');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a failed canonical interval reference blocks absence rather than disappearing from the cohort',()=>{
 const dir=mkdtempSync(join(tmpdir(),'o24-absence-reference-'));try{
  const f=createO24InventoryCapture(join(dir,'capture')),s=structuredClone(f.source),body=JSON.parse(s.rawArtifacts['ata-page-0']!),row=structuredClone(f.fixture.preCreationTail);
  row.blockTime=Date.parse(f.fixture.interval.start)/1000;row.slot=461500000;row.err={InstructionError:[0,'Custom']};row.transactionIndex=0;
  body.result.push(row);body.result.sort((a:any,b:any)=>b.slot-a.slot||(b.transactionIndex??0)-(a.transactionIndex??0));s.rawArtifacts['ata-page-0']=JSON.stringify(body);
  const result=deriveO24BulkInventory(s,f.cutoff,[]);assert.equal(result.quality,'MISSING');assert.equal(result.reasonCode,'CREATOR_ABSENCE_INTERVAL_REFERENCE');assert.equal((result.data as any).inventory,null);assert.equal((result.data as any).canonical.intervalReferences,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('proof54 Service rejects cached zero, namespace laundering, downgrade, source/clock and other-metric citations',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o24-absence-ownership-'));try{const f=createO24InventoryCapture(join(dir,'capture')),original=await collect(f),s=new Service(join(dir,'live.sqlite'));
  try{for(const mutate of [
   (b:Bundle)=>{const p=proof(b);delete p.creatorInventoryBulk;stamp(b,p);},
   (b:Bundle)=>{const p=proof(b);p.method='advisory-provenance-v51';stamp(b,p);},
   (b:Bundle)=>{const p=proof(b);p.creatorInventoryBulk.requests['bulk-page-0'].params[1].filters.tokenAccounts='all';stamp(b,p);},
   (b:Bundle)=>{(metric(b).data as any).inventory.startAtomic='1';},
   (b:Bundle)=>{const e=b.evidence.find(e=>e.id.startsWith(PREFIX))!;e.adapterVersion='forged';},
   (b:Bundle)=>{const e=b.evidence.find(e=>e.id.startsWith(PREFIX))!;e.sourceId='advisory-synchrony-bulk';},
   (b:Bundle)=>{const e=b.evidence.find(e=>e.id.startsWith(PREFIX))!;e.accessMode='PUBLIC_API';},
   (b:Bundle)=>{const e=b.evidence.find(e=>e.id.startsWith(PREFIX))!;e.availableAt='2026-10-29T18:00:01.000Z';},
   (b:Bundle)=>{const e=b.evidence.find(e=>e.id.startsWith(PREFIX))!;b.rawArtifacts[e.id]+=' ';},
   (b:Bundle)=>{const e=structuredClone(b.evidence.find(e=>e.id.startsWith(PREFIX))!);e.id=PREFIX+'orphan';e.contentHash=bulkSha('{}');b.evidence.push(e);b.rawArtifacts[e.id]='{}';},
   (b:Bundle)=>{b.features[0]!.evidenceIds.push(b.evidence.find(e=>e.id.startsWith(PREFIX))!.id);},
   (b:Bundle)=>{b.details!.baseline[0]!.evidenceIds.push(b.evidence.find(e=>e.id.startsWith(PREFIX))!.id);},
   ...['O25','S15','S13','O23','O29'].map(id=>(b:Bundle)=>{metric(b,id).evidenceIds.push(b.evidence.find(e=>e.id.startsWith(PREFIX))!.id);}),
  ]){const b=structuredClone(original);mutate(b);assert.throws(()=>s.analyzeLive(b),/ADVISORY_PROOF_INVALID|ARTIFACT_HASH_OR_SIZE|EVIDENCE|ADVISORY_CREATOR_INVENTORY_BULK_STORAGE_(?:RECORD|MEMBERSHIP)/);}}
  finally{s.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('proof54 persistence/idempotence/reopen and offline CLI retain base-only source proof',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o24-absence-persist-'));try{const f=createO24InventoryCapture(join(dir,'capture')),b=await collect(f),file=join(dir,'live.sqlite');let saved;
  let s=new Service(file);try{saved=s.analyzeLive(b);assert.equal(s.analyzeLive(b).id,saved.id);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
  s=new Service(file);try{assert.deepEqual(s.show(saved.id),saved);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
  const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string).policyVersion,'research-screen-advisory-v51');}finally{db.close();}
  let out='',error='',reads=0;assert.equal(await runCli(['replay',saved.id,'--db',file,'--json'],{env:{},isInteractive:false,fetcher:async()=>{reads++;throw Error('NETWORK_DENIED');},stdout:x=>out+=x,stderr:x=>error+=x}),0,error);assert.equal(reads,0);assert.deepEqual(JSON.parse(out),saved);
  out='';error='';assert.equal(await runCli(['analyze',f.token.address,'--chain','solana','--partial','--advisory','--o28-expanded','--o24-inventory-capture',f.directory,'--db',join(dir,'cli.sqlite'),'--config',join(dir,'config.json'),'--json'],{env:{},isInteractive:false,fetcher:f.fetcher,now:()=>f.cutoff,stdout:x=>out+=x,stderr:x=>error+=x}),0,error);const cli=JSON.parse(out);assert.equal(cli.details.advisory.method,'advisory-measurements-v53');assert.equal(cli.details.advisory.metrics.find((m:any)=>m.id==='O24').quality,'KNOWN');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('absence import requires explicit live Solana expanded advisory purpose and excludes other import modes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o24-absence-modes-'));try{const f=createO24InventoryCapture(join(dir,'capture'));let reads=0;const fetcher:typeof fetch=async()=>{reads++;throw Error('NETWORK_DENIED');};
  const base={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,o24InventoryCapture:f.directory,fetcher};
  for(const options of [{...base,advisoryEnabled:false},{...base,o28Expanded:false},{...base,o23BulkCapture:f.directory},{...base,o29ReservePath:true},{...base,o30RegistryAbsence:true},{...base,historicalTopicReuse:true}])await assert.rejects(collectLiveToken(f.token,options),/O24_INVENTORY_REQUIRED/);
  for(const args of [['analyze','--bundle','absent','--o24-inventory-capture',f.directory],['analyze',f.token.address,'--partial','--advisory','--o24-inventory-capture',f.directory],['analyze','0x1111111111111111111111111111111111111111','--chain','bsc','--partial','--advisory','--o28-expanded','--o24-inventory-capture',f.directory]]){let error='';assert.equal(await runCli(args,{env:{},isInteractive:false,fetcher,stdout:()=>{},stderr:x=>error+=x}),2);assert.match(error,/O24_INVENTORY_REQUIRED/);}
  assert.equal(reads,0);
  // A changed raw index without manifest hash repair is rejected at the import boundary before it can claim absence.
  const index=join(f.directory,'ata-page-0.json');writeFileSync(index,readFileSync(index,'utf8')+' ');assert.throws(()=>loadO24BulkCapture(f.directory,f.token,f.cutoff),/ADVISORY_CREATOR_INVENTORY_BULK_/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
