import {assertEntryCliSnapshot} from './entry-cli-snapshot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {finishExitRoute,validateExitRouteBundle,EXIT_ROUTE_METHOD} from '../src/providers/exit-route.js';
import {finishEntryRoute} from '../src/providers/entry-route.js';
import {validateVenueProvenanceBundle,expireVenueProvenanceAssessment} from '../src/providers/venue-provenance.js';
import {Service} from '../src/app/service.js';
import {runCli} from '../src/cli.js';
import type {LiveBundle} from '../src/domain/contracts.js';
const source=JSON.parse(readFileSync(new URL('../../tests/fixtures/entry-route-live.json',import.meta.url),'utf8')).bundle as LiveBundle;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function apply(b:LiveBundle){const r=finishExitRoute(b.token,b.profile,b.cutoff,b.rawArtifacts,b.evidence);b.rawArtifacts[r.record.id]=r.raw;b.evidence=b.evidence.filter(e=>e.id!==r.record.id).concat(r.record);if(r.assessment){b.details!.baseline[b.details!.baseline.findIndex(a=>a.id==='O11')]=r.assessment;b.features=b.features.filter(f=>f.id!=='O11').concat(r.assessment.projection!);}return r;}
function positive(){const b=structuredClone(source);apply(b);return b;}
function bankChange(b:LiveBundle,change:(bank:any)=>void){const bank=JSON.parse(b.rawArtifacts['entry-route-bank']!);change(bank);b.rawArtifacts['entry-route-bank']=JSON.stringify(bank);b.evidence.find(e=>e.id==='entry-route-bank')!.contentHash=hash(b.rawArtifacts['entry-route-bank']!);const records=b.evidence.filter(e=>e.id.startsWith('entry-route-')&&e.id!=='entry-route-derivation'),rawArtifacts=Object.fromEntries(records.map(e=>[e.id,b.rawArtifacts[e.id]!]));const r=finishEntryRoute(b.token,b.profile,b.cutoff,b.rawArtifacts,{records,rawArtifacts});Object.assign(b.rawArtifacts,r.capture.rawArtifacts);b.evidence=b.evidence.filter(e=>!e.id.startsWith('entry-route-')).concat(r.capture.records);if(r.assessment){b.details!.baseline[b.details!.baseline.findIndex(a=>a.id==='O10')]=r.assessment;b.features=b.features.filter(f=>f.id!=='O10').concat(r.assessment.projection!);}return r;}

test('O11 exact acquired-quantity exit matches independent integer oracle against original pre-entry bank, excludes unspent WBTC',()=>{
 const b=positive(),a=validateExitRouteBundle(b)!,entry=b.details!.baseline.find(a=>a.id==='O10')!.data as any,x=a.data as any;
 validateVenueProvenanceBundle(b);assert.equal(x.stateModel,'INDEPENDENT_QUOTES');assert.equal(x.quantityAtomic,entry.acquiredAtomic);
 const v=JSON.parse(b.rawArtifacts['entry-route-bank']!).result.value,base=Buffer.from(v[3].data[0],'base64').readBigUInt64LE(64),physical=Buffer.from(v[4].data[0],'base64').readBigUInt64LE(64),pool=Buffer.from(v[0].data[0],'base64'),virtual=BigInt('0x'+Buffer.from(pool.subarray(245,261)).reverse().toString('hex')),quantity=BigInt(entry.acquiredAtomic),gross=(physical+virtual)*quantity/(base+quantity),ceil=(n:bigint)=>(n+9999n)/10000n,fees=[20n,5n,300n].reduce((s,r)=>s+ceil(gross*r),0n);
 assert.equal(x.grossOutputAtomic,gross.toString());assert.equal(x.outputAtomic,(gross-fees).toString());assert.equal(x.embeddedFeeAtomic,fees.toString());assert.equal(x.unspentEntryAtomic,entry.unspentAtomic);assert.ok(gross-ceil(gross*20n)<=physical);
 for(const id of ['O09','O12','O13','O14','O15','O16'])assert.equal(b.details!.baseline.find(a=>a.id===id)!.quality,'MISSING');
 assert.deepEqual(b.details!.baseline.find(a=>a.id==='O10'),source.details!.baseline.find(a=>a.id==='O10'));
});

test('O11 persists, reopens and CLI replays identically without network',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'exit-route-')),file=join(dir,'live.sqlite');try{let s=new Service(file),saved;try{saved=s.analyzeLive(positive());assert.equal(s.analyzeLive(positive()).id,saved.id);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}s=new Service(file);try{assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}let out='',err='',calls=0;assert.equal(await runCli(['replay',saved.id,'--db',file,'--json'],{env:{},isInteractive:false,fetcher:async()=>{calls++;throw Error('NETWORK_DENIED');},stdout:x=>out+=x,stderr:x=>err+=x}),0,err);assertEntryCliSnapshot(JSON.parse(out),saved);assert.equal(calls,0);}finally{rmSync(dir,{recursive:true,force:true});}
});

test('O11 source ownership, exact amount, dependency binding and all other promotion guards reject rehashed tampering',()=>{
 const mutations:Record<string,(b:LiveBundle)=>void>={
  cache:b=>{(b.details!.baseline.find(a=>a.id==='O11')!.data as any).quantityAtomic='1';},
  derived:b=>{const raw=JSON.parse(b.rawArtifacts['exit-route-derivation']!);raw.outputAtomic='1';b.rawArtifacts['exit-route-derivation']=JSON.stringify(raw);b.evidence.find(e=>e.id==='exit-route-derivation')!.contentHash=hash(b.rawArtifacts['exit-route-derivation']!);},
  scope:b=>{b.evidence.find(e=>e.id==='exit-route-derivation')!.scope={method:EXIT_ROUTE_METHOD,dependencies:[]};},
  adapter:b=>{b.evidence.find(e=>e.id==='exit-route-derivation')!.adapterVersion='live-v1';},
  orphan:b=>{b.rawArtifacts['exit-route-orphan']='{}';},
  stripped:b=>{delete b.rawArtifacts['exit-route-derivation'];b.evidence=b.evidence.filter(e=>e.id!=='exit-route-derivation');},
  entryStripped:b=>{for(const id of Object.keys(b.rawArtifacts))if(id.startsWith('entry-route-'))delete b.rawArtifacts[id];b.evidence=b.evidence.filter(e=>!e.id.startsWith('entry-route-'));},
  foreign:b=>{b.evidence.find(e=>e.id==='exit-route-derivation')!.sourceId='pumpswap-derived';},
  nonLive:b=>{(b as any).analysisKind='FIXTURE';},
  otherFeature:b=>{const a=structuredClone(b.details!.baseline.find(a=>a.id==='O11')!);a.id='O14';a.projection!.id='O14';b.details!.baseline[b.details!.baseline.findIndex(a=>a.id==='O14')]=a;b.features=b.features.filter(f=>f.id!=='O14').concat(a.projection!);},
  state:b=>{const bank=JSON.parse(b.rawArtifacts['entry-route-bank']!);const data=Buffer.from(bank.result.value[4].data[0],'base64');data.writeBigUInt64LE(1n,64);bank.result.value[4].data[0]=data.toString('base64');b.rawArtifacts['entry-route-bank']=JSON.stringify(bank);b.evidence.find(e=>e.id==='entry-route-bank')!.contentHash=hash(b.rawArtifacts['entry-route-bank']!);},
 };
 const dir=mkdtempSync(join(tmpdir(),'exit-route-negative-')),s=new Service(join(dir,'live.sqlite'));try{for(const [name,mutate]of Object.entries(mutations)){const b=positive();mutate(b);assert.throws(()=>s.analyzeLive(b),/EXIT_ROUTE|ENTRY_ROUTE|VENUE_PROVENANCE|UNKNOWN_EVIDENCE_REF|ARTIFACT|Invalid input/,name);}}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('sell disable yields persistable MISSING while entry remains quoted; unsupported reserves never manufacture proceeds',()=>{
 const b=structuredClone(source);bankChange(b,bank=>{const d=Buffer.from(bank.result.value[5].data[0],'base64');d[56]=d[56]!|16;bank.result.value[5].data[0]=d.toString('base64');});const r=apply(b);assert.equal(r.assessment,null);assert.equal(JSON.parse(r.raw).reasonCode,'EXIT_ROUTE_SELL_DISABLED');assert.equal(b.details!.baseline.find(a=>a.id==='O10')!.quality,'KNOWN');validateExitRouteBundle(b);
 const tiny=structuredClone(source);bankChange(tiny,bank=>{const d=Buffer.from(bank.result.value[4].data[0],'base64');d.writeBigUInt64LE(1n,64);bank.result.value[4].data[0]=d.toString('base64');});const low=apply(tiny);assert.equal(low.assessment,null);assert.equal(JSON.parse(low.raw).reasonCode,'EXIT_ROUTE_QUANTITY_UNQUOTABLE');
 const dir=mkdtempSync(join(tmpdir(),'exit-disabled-')),s=new Service(join(dir,'live.sqlite'));try{const saved=s.analyzeLive(b);assert.equal(saved.details!.baseline.find(a=>a.id==='O11')!.quality,'MISSING');assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('stale quote, unavailable entry and expiry crossing preserve unresolved state and reject cached positive exit',()=>{
 const b=positive(),old=b.cutoff;b.cutoff=new Date(Date.parse(old)+31000).toISOString();const c=bankChange(b,()=>{});assert.equal(c.assessment!.quality,'STALE');b.details!.baseline=b.details!.baseline.map(a=>expireVenueProvenanceAssessment(a,b.cutoff));b.features=b.features.filter(f=>!['O08','O10','O11'].includes(f.id)).concat(b.details!.baseline.filter(a=>['O08','O10'].includes(a.id)).flatMap(a=>a.projection?[a.projection]:[]));apply(b);assert.equal(validateExitRouteBundle(b)!.quality,'STALE');validateVenueProvenanceBundle(b);
 const empty=structuredClone(source);for(const id of Object.keys(empty.rawArtifacts))if(id.startsWith('entry-route-'))delete empty.rawArtifacts[id];empty.evidence=empty.evidence.filter(e=>!e.id.startsWith('entry-route-'));empty.details!.baseline=empty.details!.baseline.filter(a=>a.id!=='O10');empty.features=empty.features.filter(f=>f.id!=='O10');assert.equal(apply(empty).assessment,null);validateExitRouteBundle(empty);
 const expired=positive();expired.cutoff=new Date(Date.parse(JSON.parse(expired.rawArtifacts['venue-provenance-record']!).expiresAt)+1).toISOString();assert.equal(finishExitRoute(expired.token,expired.profile,expired.cutoff,expired.rawArtifacts,expired.evidence).assessment,null);assert.throws(()=>validateExitRouteBundle(expired),/ENTRY_ROUTE|EXIT_ROUTE/);
});

test('explicit exit mode rejects EVM and bundle inputs before reads; entry-only historical bundle unchanged',async()=>{
 let calls=0,err='';const rt={env:{},isInteractive:false,fetcher:async()=>{calls++;throw Error('NETWORK_DENIED');},stdout:()=>{},stderr:(x:string)=>err+=x};assert.equal(await runCli(['analyze','0x1111111111111111111111111111111111111111','--chain','bsc','--partial','--wbtc-exit','--json'],rt),2);assert.match(err,/ENTRY_ROUTE_SOLANA_REQUIRED/);err='';assert.equal(await runCli(['analyze','--bundle','absent','--wbtc-exit'],rt),2);assert.match(err,/ENTRY_ROUTE_MODE_REQUIRED/);assert.equal(calls,0);assert.equal(validateExitRouteBundle(source),null);validateVenueProvenanceBundle(source);
});
