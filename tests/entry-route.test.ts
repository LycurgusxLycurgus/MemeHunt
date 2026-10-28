import test from 'node:test';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {collectEntryRoute,finishEntryRoute,reconstructEntryRoute,validateEntryRouteBundle,ENTRY_ROUTE_METHOD,type EntryRouteCapture} from '../src/providers/entry-route.js';
import {starterProfile} from '../src/app/config.js';
import {Service} from '../src/app/service.js';
import {runCli} from '../src/cli.js';
import {deriveBaseline} from '../src/domain/baseline.js';
import {venueProvenanceInspection,validateVenueProvenanceBundle,expireVenueProvenanceAssessment} from '../src/providers/venue-provenance.js';
import type {LiveBundle} from '../src/domain/contracts.js';

const f=JSON.parse(readFileSync(new URL('../../tests/fixtures/entry-route-wbtc.json',import.meta.url),'utf8'));
const positive=JSON.parse(readFileSync(new URL('../../tests/fixtures/entry-route-live.json',import.meta.url),'utf8')).bundle as LiveBundle;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const copy=()=>structuredClone(positive);
const rehash=(b:LiveBundle,id:string)=>{b.evidence.find(e=>e.id===id)!.contentHash=sha(b.rawArtifacts[id]!);};
const capture=(b:LiveBundle):EntryRouteCapture=>({records:b.evidence.filter(e=>e.id.startsWith('entry-route-')&&e.id!=='entry-route-derivation'),rawArtifacts:Object.fromEntries(Object.entries(b.rawArtifacts).filter(([id])=>id.startsWith('entry-route-')&&id!=='entry-route-derivation'))});

test('bounded entry collector sends only two RPC requests and one credential-free DEX request; independent integer oracle matches SDK quote',async()=>{
 const calls:any[]=[],fetcher=(async(url:any,init:any)=>{calls.push({url,init});return new Response(calls.length===1?f.genesis:calls.length===2?f.bank:f.usd);}) as typeof fetch;
 const c=await collectEntryRoute(f.token,starterProfile(),f.dependencies,'https://rpc.invalid',fetcher,()=>f.at,AbortSignal.timeout(5000));assert.equal(calls.length,3);assert.equal(calls[2].init.credentials,'omit');assert.equal(calls[2].init.redirect,'error');assert.equal(c.records.length,3);
 const facts=reconstructEntryRoute(f.token,starterProfile(),f.at,f.dependencies,c);assert.equal(facts.quality,'KNOWN');
 const bank=JSON.parse(f.bank).result.value,base=Buffer.from(bank[3].data[0],'base64').readBigUInt64LE(64),physical=Buffer.from(bank[4].data[0],'base64').readBigUInt64LE(64),virtual=BigInt(f.expected.virtualQuote),budget=BigInt(facts.budgetAtomic),rates=[20n,5n,300n],ceil=(x:bigint,y:bigint)=>(x+y-1n)/y,fee=(n:bigint)=>rates.reduce((sum,r)=>sum+ceil(n*r,10000n),0n);
 let effective=budget*10000n/(10000n+rates.reduce((a,b)=>a+b));if(effective+fee(effective)>budget)effective-=effective+fee(effective)-budget;
 const acquired=base*(effective-1n)/(physical+virtual+effective-1n),core=ceil((physical+virtual)*acquired,base-acquired),debit=core+fee(core);
 assert.equal(facts.acquiredAtomic,acquired.toString());assert.equal(facts.actualDebitAtomic,debit.toString());assert.equal(facts.unspentAtomic,(budget-debit).toString());assert.ok(debit<=budget&&acquired>0n);assert.deepEqual(facts.feesBps,{lp:'20',protocol:'5',creator:'300'});assert.ok(!JSON.stringify(JSON.parse(calls[1].init.body).params).includes('SysvarC1ock'));
});

test('independent entry witness is the exact sole O10 override; old binding-only validation remains strict',()=>{
 const b=copy(),a=validateEntryRouteBundle(b);assert.equal(a!.quality,'KNOWN');validateVenueProvenanceBundle(b);const forged=copy();forged.rawArtifacts['entry-route-bank']+=' ';assert.throws(()=>validateVenueProvenanceBundle(forged),/ENTRY_ROUTE_PROOF_INVALID/);
 for(const id of ['O09','O11','O12','O13','O14','O15','O16'])assert.equal(b.details!.baseline.find(a=>a.id===id)!.quality,'MISSING');
 const c=capture(b),later=new Date(Date.parse(b.cutoff)+31000).toISOString(),stale=finishEntryRoute(b.token,b.profile,later,b.rawArtifacts,c);assert.equal(stale.assessment!.quality,'STALE');assert.equal(stale.assessment!.projection!.quality,'STALE');
});

test('real Service save/reopen/idempotence and actual CLI replay are byte-identical with zero network',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'entry-route-')),file=join(dir,'live.sqlite');try{let saved;let s=new Service(file);try{saved=s.analyzeLive(copy());assert.equal(s.analyzeLive(copy()).id,saved.id);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}s=new Service(file);try{assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
 let output='',errors='',network=0;const code=await runCli(['replay',saved.id,'--db',file,'--json'],{env:{},isInteractive:false,fetcher:async()=>{network++;throw Error('NETWORK_DENIED');},stdout:x=>output+=x,stderr:x=>errors+=x});assert.equal(code,0,errors);assert.deepEqual(JSON.parse(output),saved);assert.equal(network,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('entry namespace and cached numerical authority reject source, ownership, scope, cache, profile and cross-feature mutations',()=>{
 const mutations:Record<string,(b:LiveBundle)=>void>={
  omitted:b=>{b.evidence=b.evidence.filter(e=>e.id!=='entry-route-bank');delete b.rawArtifacts['entry-route-bank'];},
  orphan:b=>{b.evidence.push({...b.evidence.find(e=>e.id==='entry-route-bank')!,id:'entry-route-orphan'});b.rawArtifacts['entry-route-orphan']=b.rawArtifacts['entry-route-bank']!;},
  adapter:b=>{b.evidence.find(e=>e.id==='entry-route-bank')!.adapterVersion='live-v1';},
  scope:b=>{b.evidence.find(e=>e.id==='entry-route-usd')!.scope={method:ENTRY_ROUTE_METHOD,request:{url:'https://invalid.example/'}};},
  staleHash:b=>{b.rawArtifacts['entry-route-bank']+=' ';},
  nullAccount:b=>{const r=JSON.parse(b.rawArtifacts['entry-route-bank']!);r.result.value[0]=null;b.rawArtifacts['entry-route-bank']=JSON.stringify(r);rehash(b,'entry-route-bank');},
  wrongOwner:b=>{const r=JSON.parse(b.rawArtifacts['entry-route-bank']!);r.result.value[0].owner='11111111111111111111111111111111';b.rawArtifacts['entry-route-bank']=JSON.stringify(r);rehash(b,'entry-route-bank');},
  price:b=>{const r=JSON.parse(b.rawArtifacts['entry-route-usd']!);for(const p of r)p.priceUsd='1';b.rawArtifacts['entry-route-usd']=JSON.stringify(r);rehash(b,'entry-route-usd');},
  cached:b=>{(b.details!.baseline.find(a=>a.id==='O10')!.data as any).acquiredAtomic='1';},
  profile:b=>{b.profile.sizeUsd='26';b.details!.profile.sizeUsd='26';},
  otherFeature:b=>{const f=structuredClone(b.features.find(f=>f.id==='O10')!);f.id='O11';b.features.push(f);},
  stripped:b=>{b.evidence=b.evidence.filter(e=>!e.id.startsWith('entry-route-'));for(const id of Object.keys(b.rawArtifacts))if(id.startsWith('entry-route-'))delete b.rawArtifacts[id];},
 };
 const dir=mkdtempSync(join(tmpdir(),'entry-route-negative-')),s=new Service(join(dir,'live.sqlite'));try{for(const [name,mutate]of Object.entries(mutations)){const b=copy();mutate(b);assert.throws(()=>s.analyzeLive(b),/ENTRY_ROUTE|ARTIFACT|VENUE_PROVENANCE|UNKNOWN_EVIDENCE_REF/,name);}}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('failed source stays persistable MISSING without a manufactured zero or loss of O08',()=>{
 const b=copy(),c=capture(b),r=c.records.find(e=>e.id==='entry-route-usd')!;c.rawArtifacts[r.id]=JSON.stringify({error:'ENTRY_ROUTE_READ_FAILED'});r.contentHash=sha(c.rawArtifacts[r.id]!);const result=finishEntryRoute(b.token,b.profile,b.cutoff,b.rawArtifacts,c);assert.equal(result.assessment,null);
 b.evidence=b.evidence.filter(e=>!e.id.startsWith('entry-route-')).concat(result.capture.records);for(const id of Object.keys(result.capture.rawArtifacts))b.rawArtifacts[id]=result.capture.rawArtifacts[id]!;
 const old=deriveBaseline({...b,features:b.features.filter(f=>f.id!=='O10'),venueInspection:venueProvenanceInspection(JSON.parse(b.rawArtifacts['venue-provenance-record']!))}).find(a=>a.id==='O10')!;b.details!.baseline[b.details!.baseline.findIndex(a=>a.id==='O10')]=old;b.features=b.features.filter(f=>f.id!=='O10');assert.equal(validateEntryRouteBundle(b),null);assert.equal(b.details!.baseline.find(a=>a.id==='O08')!.quality,'KNOWN');
 const dir=mkdtempSync(join(tmpdir(),'entry-route-missing-')),s=new Service(join(dir,'live.sqlite'));try{const saved=s.analyzeLive(b);assert.equal(saved.details!.baseline.find(a=>a.id==='O10')!.quality,'MISSING');}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('explicit entry mode rejects EVM and bundle requests before reads; unchanged bundles retain no entry namespace',async()=>{
 let reads=0,error='';const runtime={env:{},isInteractive:false,fetcher:async()=>{reads++;throw Error('NETWORK_DENIED');},stdout:()=>{},stderr:(s:string)=>error+=s};
 const code=await runCli(['analyze','0x1111111111111111111111111111111111111111','--chain','bsc','--partial','--wbtc-entry','--json'],runtime);assert.equal(code,2);assert.match(error,/ENTRY_ROUTE_SOLANA_REQUIRED/);assert.equal(reads,0);
 error='';assert.equal(await runCli(['analyze','--bundle','does-not-exist','--wbtc-entry'],runtime),2);assert.match(error,/ENTRY_ROUTE_MODE_REQUIRED/);assert.equal(reads,0);
 const b=copy();b.evidence=b.evidence.filter(e=>!e.id.startsWith('entry-route-'));for(const id of Object.keys(b.rawArtifacts))if(id.startsWith('entry-route-'))delete b.rawArtifacts[id];b.details!.baseline=b.details!.baseline.filter(a=>a.id!=='O10');b.features=b.features.filter(f=>f.id!=='O10');assert.equal(validateEntryRouteBundle(b),null);
});


test('HTTP recovery attempts share the three-request cap and never borrow the ordinary pool',async()=>{
 let actual=0;const fetcher=(async()=>{actual++;return new Response('{}',{status:503});}) as typeof fetch;
 const c=await collectEntryRoute(f.token,starterProfile(),f.dependencies,'https://rpc.invalid',fetcher,()=>f.at,AbortSignal.timeout(10000));assert.equal(actual,3);assert.equal(c.records.length,3);
 assert.equal(reconstructEntryRoute(f.token,starterProfile(),f.at,f.dependencies,c).quality,'MISSING');
});


test('actual HTTP307/308 RPC redirects never follow to another POST and remain persistable MISSING within three attempts',async()=>{
 for(const status of [307,308]){let rpc=0,redirected=0;const server=createServer((req,res)=>{if(req.url==='/target'){redirected++;res.end('{}');}else{rpc++;res.writeHead(status,{location:'/target'});res.end();}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as {port:number};
 try{const b=copy(),deps=b.rawArtifacts;const c=await collectEntryRoute(b.token,b.profile,deps,`http://127.0.0.1:${address.port}/rpc`,fetch,()=>b.cutoff,AbortSignal.timeout(10000));assert.ok(rpc<=3);assert.equal(redirected,0);const finished=finishEntryRoute(b.token,b.profile,b.cutoff,deps,c);assert.equal(finished.assessment,null);
 b.evidence=b.evidence.filter(e=>!e.id.startsWith('entry-route-')).concat(finished.capture.records);Object.assign(b.rawArtifacts,finished.capture.rawArtifacts);b.features=b.features.filter(f=>f.id!=='O10');b.details!.baseline=deriveBaseline({...b,venueInspection:venueProvenanceInspection(JSON.parse(deps['venue-provenance-record']!))});
 const dir=mkdtempSync(join(tmpdir(),'entry-redirect-')),s=new Service(join(dir,'live.sqlite'));try{const saved=s.analyzeLive(b);assert.equal(saved.details!.baseline.find(a=>a.id==='O10')!.quality,'MISSING');assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();rmSync(dir,{recursive:true,force:true});}
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
 }
});

test('provenance current at admission and expired at final cutoff preserves stale O08 and persistable unresolved O10',async()=>{
 const b=copy(),p=JSON.parse(b.rawArtifacts['venue-provenance-record']!),expires=Date.parse(p.expiresAt);let time=expires-1000,reads=0;const old=capture(b),fetcher=(async()=>new Response(old.rawArtifacts[['entry-route-genesis','entry-route-bank','entry-route-usd'][reads++]!])) as typeof fetch;
 const now=()=>{const at=time;time+=1000;return new Date(at).toISOString();};const c=await collectEntryRoute(b.token,b.profile,b.rawArtifacts,'https://rpc.invalid',fetcher,now,AbortSignal.timeout(5000));assert.equal(reads,3);b.cutoff=new Date(expires+4000).toISOString();const finished=finishEntryRoute(b.token,b.profile,b.cutoff,b.rawArtifacts,c);assert.equal(finished.assessment,null);assert.equal(JSON.parse(finished.capture.rawArtifacts['entry-route-derivation']!).reasonCode,'ENTRY_ROUTE_PROVENANCE_EXPIRED');
 b.evidence=b.evidence.filter(e=>!e.id.startsWith('entry-route-')).concat(finished.capture.records);Object.assign(b.rawArtifacts,finished.capture.rawArtifacts);assert.throws(()=>validateEntryRouteBundle(b),/ENTRY_ROUTE_PROOF_INVALID/,'cached positive promotion still rejects after expiry');
 b.features=b.features.filter(f=>!['O08','O10'].includes(f.id));b.details!.baseline=deriveBaseline({...b,venueInspection:venueProvenanceInspection(p)}).map(a=>expireVenueProvenanceAssessment(a,b.cutoff));b.features=b.details!.baseline.flatMap(a=>a.projection?[a.projection]:[]);assert.equal(b.details!.baseline.find(a=>a.id==='O08')!.quality,'STALE');assert.equal(b.features.find(f=>f.id==='O08')!.quality,'STALE');assert.equal(b.details!.baseline.find(a=>a.id==='O10')!.quality,'MISSING');
 const dir=mkdtempSync(join(tmpdir(),'entry-expiry-')),s=new Service(join(dir,'live.sqlite'));try{const saved=s.analyzeLive(b);assert.deepEqual(s.replay(saved.id),saved);assert.equal(saved.details!.baseline.find(a=>a.id==='O08')!.quality,'STALE');assert.ok(!saved.features.some(f=>f.id==='O10'&&f.quality==='KNOWN'));}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
