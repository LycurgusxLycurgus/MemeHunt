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
import {createO26InventoryCapture} from './inventory-returns-fixtures.js';
import {bulkSha} from './synchrony-bulk-fixtures.js';
type Bundle=Awaited<ReturnType<typeof collectLiveToken>>;
const PREFIX='advisory-inventory-returns-';
const proof=(b:Bundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const metric=(b:Bundle,id='O26')=>b.details!.advisory!.metrics.find(m=>m.id===id)!;
const collect=(f:ReturnType<typeof createO26InventoryCapture>,enabled=true)=>collectLiveToken(f.token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,...(enabled?{o26AccountCapture:f.directory}:{o28RpcErrors:true}),fetcher:f.fetcher,now:()=>f.cutoff});
function stamp(b:Bundle,p:any){b.rawArtifacts['advisory-derivation']=JSON.stringify(p);b.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=bulkSha(b.rawArtifacts['advisory-derivation']!);}

test('proof56 binds complete historical motifs to native quote units and changes only O26 versus identical51 sources',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o26-source-integration-'));try{const f=createO26InventoryCapture(join(dir,'capture')),old=await collect(f,false),b=await collect(f),p=proof(b),m=metric(b),d=m.data as any;
  assert.equal(p.method,'advisory-provenance-v56');assert.equal(b.details!.advisory!.method,'advisory-measurements-v55');assert.ok(p.inventoryReturns);assert.equal(p.creatorInventoryBulk,undefined);assert.equal(p.creatorLifetimeBank,undefined);assert.equal(p.synchronyBulk,undefined);
  assert.equal(m.quality,'KNOWN');assert.equal(d.motifCount,1);assert.equal(d.repeatedMotifCount,0);assert.equal(d.population,2);assert.equal(d.motifGrossQuoteAtomic,'2416');assert.equal(d.coveredTradeGrossQuoteAtomic,'3477');assert.equal(d.quoteMint,'3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh');assert.equal(d.quoteDecimals,8);
  assert.deepEqual(b.features,old.features);assert.deepEqual(b.details!.baseline,old.details!.baseline);assert.deepEqual(b.details!.advisory!.metrics.filter(m=>m.id!=='O26'),old.details!.advisory!.metrics.filter(m=>m.id!=='O26'));
  assert.deepEqual(reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,p,b.thesis??null,b.features),b.details!.advisory);
  const owned=b.evidence.filter(e=>e.id.startsWith(PREFIX));assert.equal(owned.length,2);for(const e of owned){assert.equal(e.sourceId,'advisory-inventory-returns');assert.equal(e.adapterVersion,'o26-account-receipts-v1');assert.equal(e.accessMode,'USER_IMPORT');assert.equal(e.retrievedAt,f.receipts.createdAt);assert.equal(e.availableAt,e.retrievedAt);assert.equal(e.sourceType,'HISTORICAL_RECEIPT');assert.ok(e.scope.container);assert.equal(e.scope.request,undefined);}
  assert.ok(!f.calls.some(c=>c.method==='getTransactionsForAddress'),'retained local container makes no new address-census network reads');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('proof56 persists source bytes idempotently and reopens/replays through a network-denied CLI',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o26-source-persist-'));try{const f=createO26InventoryCapture(join(dir,'capture')),b=await collect(f),file=join(dir,'live.sqlite');let saved;
  let s=new Service(file);try{saved=s.analyzeLive(b);assert.equal(s.analyzeLive(b).id,saved.id);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
  s=new Service(file);try{assert.deepEqual(s.show(saved.id),saved);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
  const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string).policyVersion,'research-screen-advisory-v53');}finally{db.close();}
  let out='',err='',calls=0;assert.equal(await runCli(['replay',saved.id,'--db',file,'--json'],{env:{},isInteractive:false,fetcher:async()=>{calls++;throw Error('NETWORK_DENIED');},stdout:x=>out+=x,stderr:x=>err+=x}),0,err);assert.equal(calls,0);assert.deepEqual(JSON.parse(out),saved);
  out='';err='';assert.equal(await runCli(['analyze',f.token.address,'--chain','solana','--partial','--advisory','--o28-expanded','--o26-account-capture',f.directory,'--db',join(dir,'cli.sqlite'),'--config',join(dir,'config.json'),'--json'],{env:{},isInteractive:false,fetcher:f.fetcher,now:()=>f.cutoff,stdout:x=>out+=x,stderr:x=>err+=x}),0,err);assert.equal(JSON.parse(out).details.advisory.metrics.find((m:any)=>m.id==='O26').quality,'KNOWN');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('O26 source authority, caches and parent versions cannot be laundered into other measurements',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o26-source-quarantine-'));try{const f=createO26InventoryCapture(join(dir,'capture')),original=await collect(f),s=new Service(join(dir,'live.sqlite'));
  try{const changes:Array<[string,(b:Bundle)=>void]>=[
   ['downgrade',b=>{const p=proof(b);p.method='advisory-provenance-v55';stamp(b,p);}],
   ['missing descriptor',b=>{const p=proof(b);delete p.inventoryReturns;stamp(b,p);}],
   ['fake cache',b=>{(metric(b).data as any).motifCount=999;}],
   ['wrong adapter',b=>{b.evidence.find(e=>e.id.startsWith(PREFIX))!.adapterVersion='forged';}],
   ['wrong source',b=>{b.evidence.find(e=>e.id.startsWith(PREFIX))!.sourceId='advisory-creator-inventory-bulk';}],
   ['changed raw',b=>{const id=b.evidence.find(e=>e.id.startsWith(PREFIX))!.id;b.rawArtifacts[id]+=' ';}],
   ['entry feature',b=>{b.features[0]!.evidenceIds.push(PREFIX+'manifest');}],
   ['baseline',b=>{b.details!.baseline[0]!.evidenceIds.push(PREFIX+'manifest');}],
   ...['O23','O24','O25','O29','S13','S15'].map(id=>[id,(b:Bundle)=>{metric(b,id).evidenceIds.push(PREFIX+'manifest');}]as [string,(b:Bundle)=>void]),
  ];for(const[label,change]of changes){const b=structuredClone(original);change(b);assert.throws(()=>s.analyzeLive(b),/ADVISORY_PROOF_INVALID|ADVISORY_INVENTORY_RETURNS_|ARTIFACT_HASH_OR_SIZE|EVIDENCE/,label);}}
  finally{s.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('O26 historical mode rejects incompatible paths before any network or file collection',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o26-source-modes-'));try{const f=createO26InventoryCapture(join(dir,'capture'));let reads=0;const fetcher:typeof fetch=async()=>{reads++;throw Error('NETWORK_DENIED');},base={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,o26AccountCapture:f.directory,fetcher};
  for(const o of [{...base,advisoryEnabled:false},{...base,o28Expanded:false},{...base,o25LifetimeCapture:f.directory},{...base,o24InventoryCapture:f.directory},{...base,o23BulkCapture:f.directory},{...base,o29ReservePath:true},{...base,o30RegistryAbsence:true},{...base,historicalTopicReuse:true}])await assert.rejects(collectLiveToken(f.token,o),/O26_ACCOUNT_REQUIRED/);
  for(const args of [['analyze','--bundle','absent','--o26-account-capture',f.directory],['analyze',f.token.address,'--partial','--advisory','--o26-account-capture',f.directory],['analyze','0x1111111111111111111111111111111111111111','--chain','bsc','--partial','--advisory','--o28-expanded','--o26-account-capture',f.directory]]){let err='';assert.equal(await runCli(args,{env:{},isInteractive:false,fetcher,stdout:()=>{},stderr:x=>err+=x}),2);assert.match(err,/O26_ACCOUNT_REQUIRED/);}assert.equal(reads,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});


test('documented O26 flags inherit named failed-reference collection without an extra RPC-error flag',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'o26-named-error-'));try{
  const f=createO26InventoryCapture(join(dir,'capture')),anchor=f.context.window.anchorSlot!,pool=f.context.window.pool!,end=Math.floor(Date.parse(f.cutoff)/3_600_000)*3600;
  // Constructed ordinary all-failed hour; the retained historical O26 capture stays byte-exact.
  const signatures=f.fixture.records.filter((r:any)=>r.kind==='WINDOW'&&r.request.method==='getTransaction').map((r:any)=>r.request.params[0]);
  const rows=signatures.map((signature:string,i:number)=>({signature,slot:anchor-i-1,blockTime:end-(i===2?5400:1800),err:i===0?'MaxLoadedAccountsDataSizeExceeded':i===1?'BlockhashNotFound':null,confirmationStatus:'finalized'}));
  const bank=JSON.parse(f.fixture.records.find((r:any)=>r.kind==='WINDOW'&&r.id==='window-pool').raw).result,calls:Array<{method:string;params:any[]}>=[];
  const fetcher:typeof fetch=async(input,init)=>{
   if(init?.method!=='POST'){const raw=await(await f.fetcher(input,init)).text();return new Response(raw.replaceAll('4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E',pool));}
   const q=JSON.parse(String(init.body));calls.push(q);let result:any;
   if(q.method==='getSlot')result=anchor;
   else if(q.method==='getBlockTime')result=end;
   else if(q.method==='getSignaturesForAddress'&&q.params[1]?.limit===1000)result=rows;
   else if(q.method==='getAccountInfo'&&q.params[0]===pool)result={context:bank.context,value:bank.value[0]};
   else if(q.method==='getMultipleAccounts'&&q.params[0][0]===pool&&q.params[0].length===2)result=bank;
   else return f.fetcher(input,init);
   return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result}));
  };
  const options={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,fetcher,now:()=>f.cutoff};
  const old=await collectLiveToken(f.token,{...options,o28RpcErrors:true}),b=await collectLiveToken(f.token,{...options,o26AccountCapture:f.directory});
  assert.equal(proof(b).method,'advisory-provenance-v56');assert.equal(metric(b).quality,'KNOWN');assert.equal(metric(b,'O28').quality,'KNOWN');assert.equal((metric(b,'O28').data as any).failedReferences,2);
  assert.ok(calls.some(q=>q.method==='getMultipleAccounts'&&q.params[0][0]===pool),'named failed references must not stop ordinary pool-bank collection');
  assert.ok(!calls.some(q=>q.method==='getTransaction'&&signatures.slice(0,2).includes(q.params[0])),'failed references are never successful transaction bodies');
  assert.deepEqual(b.details!.advisory!.metrics.filter(m=>m.id!=='O26'),old.details!.advisory!.metrics.filter(m=>m.id!=='O26'));
  let out='',err='';assert.equal(await runCli(['analyze',f.token.address,'--chain','solana','--partial','--advisory','--o28-expanded','--o26-account-capture',f.directory,'--db',join(dir,'cli.sqlite'),'--config',join(dir,'config.json'),'--json'],{env:{},isInteractive:false,fetcher,now:()=>f.cutoff,stdout:x=>out+=x,stderr:x=>err+=x}),0,err);
  assert.equal(JSON.parse(out).details.advisory.metrics.find((m:any)=>m.id==='O28').quality,'KNOWN');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
