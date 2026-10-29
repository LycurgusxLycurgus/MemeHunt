/** Constructed conformance over retained public source bytes; actual three-token acceptance is separate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {finishRouteImpacts,validateRouteImpactBundle,ROUTE_IMPACT_METHOD} from '../src/providers/route-impact.js';
import {finishExitRoute} from '../src/providers/exit-route.js';
import {finishEntryRoute} from '../src/providers/entry-route.js';
import {validateVenueProvenanceBundle,expireVenueProvenanceAssessment} from '../src/providers/venue-provenance.js';
import {Service} from '../src/app/service.js';
import {deriveExecution,type VenueFacts} from '../src/domain/baseline.js';
import {runCli} from '../src/cli.js';
import type {LiveBundle} from '../src/domain/contracts.js';
const source=JSON.parse(readFileSync(new URL('../../tests/fixtures/entry-route-live.json',import.meta.url),'utf8')).bundle as LiveBundle;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const copy=()=>structuredClone(source);
function applyExit(b:LiveBundle){const r=finishExitRoute(b.token,b.profile,b.cutoff,b.rawArtifacts,b.evidence);b.rawArtifacts[r.record.id]=r.raw;b.evidence=b.evidence.filter(e=>e.id!==r.record.id).concat(r.record);if(r.assessment){b.details!.baseline[b.details!.baseline.findIndex(a=>a.id==='O11')]=r.assessment;b.features=b.features.filter(f=>f.id!=='O11').concat(r.assessment.projection!);}return r;}
function apply(b:LiveBundle){const r=finishRouteImpacts(b.token,b.profile,b.cutoff,b.rawArtifacts,b.evidence);b.rawArtifacts[r.record.id]=r.raw;b.evidence=b.evidence.filter(e=>e.id!==r.record.id).concat(r.record);for(const a of r.assessments){b.details!.baseline[b.details!.baseline.findIndex(x=>x.id===a.id)]=a;b.features=b.features.filter(f=>f.id!==a.id).concat(a.projection!);}return r;}
function positive(){const b=copy();applyExit(b);apply(b);return b;}
function rebuildEntry(b:LiveBundle){const records=b.evidence.filter(e=>e.id.startsWith('entry-route-')&&e.id!=='entry-route-derivation');const r=finishEntryRoute(b.token,b.profile,b.cutoff,b.rawArtifacts,{records,rawArtifacts:Object.fromEntries(records.map(e=>[e.id,b.rawArtifacts[e.id]!]))});Object.assign(b.rawArtifacts,r.capture.rawArtifacts);b.evidence=b.evidence.filter(e=>!e.id.startsWith('entry-route-')).concat(r.capture.records);if(r.assessment){b.details!.baseline[b.details!.baseline.findIndex(a=>a.id==='O10')]=r.assessment;b.features=b.features.filter(f=>f.id!=='O10').concat(r.assessment.projection!);}return r;}

// Independent exact finite-decimal parsing and rational quantization: no Decimal or SDK math.
const fraction=(s:string)=>{const [a,b='']=s.split('.');return [BigInt(a!+b),10n**BigInt(b.length)] as const;};
const oracleBps=(num:bigint,den:bigint)=>[den>num?(den-num)*10000n:0n,den] as const;
const quantized=(num:bigint,den:bigint)=>{const scale=10n**10n;return (num*scale*2n+den)/(2n*den);};
function exactOracle(b:LiveBundle){
 const bank=JSON.parse(b.rawArtifacts['entry-route-bank']!).result.value,base=Buffer.from(bank[3].data[0],'base64').readBigUInt64LE(64),physical=Buffer.from(bank[4].data[0],'base64').readBigUInt64LE(64),pool=Buffer.from(bank[0].data[0],'base64'),virtual=BigInt('0x'+Buffer.from(pool.subarray(245,261)).reverse().toString('hex'));
 const entry=b.details!.baseline.find(a=>a.id==='O10')!.data as any,exit=b.details!.baseline.find(a=>a.id==='O11')!.data as any,a=BigInt(entry.acquiredAtomic),s=BigInt(exit.outputAtomic),u=BigInt(entry.unspentAtomic),[pn,pd]=fraction(entry.quoteUsdReference),[in_,id]=fraction(b.profile.sizeUsd!);
 const e=oracleBps(a*(physical+virtual)*pn*id,base*10n**BigInt(entry.quoteDecimals)*pd*in_),x=oracleBps((s+u)*base,a*(physical+virtual));
 return {entry:e,exit:x,actualDebitEntry:oracleBps(a*(physical+virtual),base*BigInt(entry.actualDebitAtomic)),exitWithoutUnspent:oracleBps(s*base,a*(physical+virtual)),entryFacts:entry,exitFacts:exit};
}

test('O13/O14 independent rational oracle preserves requested-USD and unspent-budget definitions at declared10decimalbps precision',()=>{
 const b=positive(),a=validateRouteImpactBundle(b);assert.equal(a.length,2);validateVenueProvenanceBundle(b);
 const oracle=exactOracle(b);for(const [id,expected]of [['O13',oracle.entry],['O14',oracle.exit]] as const){const text=String(a.find(a=>a.id===id)!.projection!.value),actual=fraction(text);assert.equal(quantized(...actual),quantized(...expected),id);assert.equal(a.find(a=>a.id===id)!.projection!.unit,'bps');}
 const facts=JSON.parse(b.rawArtifacts['impact-route-derivation']!);assert.equal(facts.stateModel,'INDEPENDENT_QUOTES');assert.equal(facts.reference.quantityAtomic,oracle.entryFacts.acquiredAtomic);assert.equal(facts.reference.unspentEntryAtomic,oracle.entryFacts.unspentAtomic);
 assert.ok(BigInt(oracle.entryFacts.unspentAtomic)>0n,'fixture must exercise unspent rounding');assert.notEqual(quantized(...oracle.exit),quantized(...oracle.exitWithoutUnspent),'discarding unspent silently changes O14');assert.notEqual(quantized(...oracle.entry),quantized(...oracle.actualDebitEntry),'actualDebit denominator silently changes O13');
 for(const id of ['O09','O12','O15','O16'])assert.equal(b.details!.baseline.find(a=>a.id===id)!.quality,'MISSING');
 assert.deepEqual(b.details!.baseline.find(a=>a.id==='O10'),source.details!.baseline.find(a=>a.id==='O10'));
});

test('entry-only or sell-disabled cases keep O13 measured while O14 stays unresolved',()=>{
 const entryOnly=copy();assert.deepEqual(apply(entryOnly).assessments.map(a=>a.id),['O13']);assert.deepEqual(validateRouteImpactBundle(entryOnly).map(a=>a.id),['O13']);validateVenueProvenanceBundle(entryOnly);
 const b=copy(),bank=JSON.parse(b.rawArtifacts['entry-route-bank']!),d=Buffer.from(bank.result.value[5].data[0],'base64');d[56]=d[56]!|16;bank.result.value[5].data[0]=d.toString('base64');b.rawArtifacts['entry-route-bank']=JSON.stringify(bank);b.evidence.find(e=>e.id==='entry-route-bank')!.contentHash=hash(b.rawArtifacts['entry-route-bank']!);rebuildEntry(b);assert.equal(applyExit(b).assessment,null);assert.deepEqual(apply(b).assessments.map(a=>a.id),['O13']);validateRouteImpactBundle(b);validateVenueProvenanceBundle(b);
});

test('impact source/record/cache and profile substitutions reject; no O15/O16 promotion from own namespace',()=>{
 const mutations:Record<string,(b:LiveBundle)=>void>={
  cache:b=>{(b.details!.baseline.find(a=>a.id==='O13')!.data as any).bps='0';},
  derived:b=>{const f=JSON.parse(b.rawArtifacts['impact-route-derivation']!);f.exit.bps='0';b.rawArtifacts['impact-route-derivation']=JSON.stringify(f);b.evidence.find(e=>e.id==='impact-route-derivation')!.contentHash=hash(b.rawArtifacts['impact-route-derivation']!);},
  raw:b=>{b.rawArtifacts['entry-route-bank']+=' ';b.evidence.find(e=>e.id==='entry-route-bank')!.contentHash=hash(b.rawArtifacts['entry-route-bank']!);},
  scope:b=>{b.evidence.find(e=>e.id==='impact-route-derivation')!.scope={method:ROUTE_IMPACT_METHOD,dependencies:[]};},
  foreign:b=>{b.evidence.find(e=>e.id==='impact-route-derivation')!.sourceId='pumpswap-derived';},
  adapter:b=>{b.evidence.find(e=>e.id==='impact-route-derivation')!.adapterVersion='live-v1';},
  stripped:b=>{delete b.rawArtifacts['impact-route-derivation'];b.evidence=b.evidence.filter(e=>e.id!=='impact-route-derivation');},
  orphan:b=>{b.rawArtifacts['impact-route-orphan']='{}';},
  price:b=>{(b.details!.baseline.find(a=>a.id==='O14')!.data as any).reference.quoteUsdReference='1';},
  size:b=>{b.profile.sizeUsd='26';b.details!.profile.sizeUsd='26';},
  nonLive:b=>{(b as any).analysisKind='FIXTURE';},
  otherFeature:b=>{const a=structuredClone(b.details!.baseline.find(a=>a.id==='O14')!);a.id='O15';a.projection!.id='O15';b.details!.baseline[b.details!.baseline.findIndex(a=>a.id==='O15')]=a;b.features=b.features.filter(f=>f.id!=='O15').concat(a.projection!);},
 };
 const dir=mkdtempSync(join(tmpdir(),'impact-negative-')),s=new Service(join(dir,'live.sqlite'));try{for(const [name,mutate]of Object.entries(mutations)){const b=positive();mutate(b);assert.throws(()=>s.analyzeLive(b),/ROUTE_IMPACT|ENTRY_ROUTE|EXIT_ROUTE|VENUE_PROVENANCE|UNKNOWN_EVIDENCE_REF|ARTIFACT|Invalid input/,name);}}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('original quote expiry produces stale impacts without restamping; expired provenance cannot preserve cached known impacts',()=>{
 const b=copy();b.cutoff=new Date(Date.parse(b.cutoff)+31000).toISOString();rebuildEntry(b);applyExit(b);for(let i=0;i<b.details!.baseline.length;i++)b.details!.baseline[i]=expireVenueProvenanceAssessment(b.details!.baseline[i]!,b.cutoff);b.features=b.features.filter(f=>f.id!=='O08').concat(b.details!.baseline.find(a=>a.id==='O08')!.projection!);apply(b);
 const a=validateRouteImpactBundle(b);assert.deepEqual(a.map(x=>x.quality),['STALE','STALE']);assert.ok(a.every(x=>Date.parse(x.projection!.availableAt)<Date.parse(b.cutoff)));validateVenueProvenanceBundle(b);
 const expired=positive();expired.cutoff=new Date(Date.parse(JSON.parse(expired.rawArtifacts['venue-provenance-record']!).expiresAt)+1).toISOString();assert.equal(finishRouteImpacts(expired.token,expired.profile,expired.cutoff,expired.rawArtifacts,expired.evidence).assessments.length,0);assert.throws(()=>validateRouteImpactBundle(expired),/ENTRY_ROUTE|EXIT_ROUTE|ROUTE_IMPACT/);
});

test('actual Service persistence/reopen/idempotence and CLI replay preserve derived impact facts with zero reads',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'impact-persist-')),file=join(dir,'live.sqlite');try{let s=new Service(file),saved;try{saved=s.analyzeLive(positive());assert.equal(s.analyzeLive(positive()).id,saved.id);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}s=new Service(file);try{assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}let out='',err='',calls=0;assert.equal(await runCli(['replay',saved.id,'--db',file,'--json'],{env:{},isInteractive:false,fetcher:async()=>{calls++;throw Error('NETWORK_DENIED');},stdout:x=>out+=x,stderr:x=>err+=x}),0,err);assert.deepEqual(JSON.parse(out),saved);assert.equal(calls,0);}finally{rmSync(dir,{recursive:true,force:true});}
});


test('O13/O14 retain exact baseline Decimal operation order and CLI guards before any reads',async()=>{
 const b=positive(),f=JSON.parse(b.rawArtifacts['impact-route-derivation']!),e=b.details!.baseline.find(a=>a.id==='O10')!.data as any;
 const venue:VenueFacts={certificateId:'constructed-contract-parity',bindingVerified:true,version:'constructed-only',token:b.token,availableAt:f.reference.availableAt,expiresAt:f.reference.expiresAt,removableLiquidityFraction:'0',lockExpiresAt:null,entryQuoteUsd:b.profile.sizeUsd!,acquiredAtomic:e.acquiredAtomic,decimals:e.baseDecimals,exitQuantityAtomic:e.acquiredAtomic,exitQuoteUsd:f.exit.exitValueWithUnspentUsd,referencePriceUsd:f.reference.referencePriceUsd,entryExternalCostUsd:'0',exitExternalCostUsd:'0',embeddedFeesUsd:'0',costsReconciled:false,method:'INDEPENDENT_QUOTES',evidenceIds:[]};
 const expected=deriveExecution(venue,b.token,b.profile,b.cutoff);assert.equal(f.entry.bps,expected.entryImpactBps);assert.equal(f.exit.bps,expected.exitImpactBps);
 let reads=0,error='';const runtime={env:{},isInteractive:false,fetcher:async()=>{reads++;throw Error('NETWORK_DENIED');},stdout:()=>{},stderr:(x:string)=>error+=x};assert.equal(await runCli(['analyze','0x1111111111111111111111111111111111111111','--chain','bsc','--partial','--wbtc-impacts','--json'],runtime),2);assert.match(error,/ENTRY_ROUTE_SOLANA_REQUIRED/);error='';assert.equal(await runCli(['analyze','--bundle','absent','--wbtc-impacts'],runtime),2);assert.match(error,/ENTRY_ROUTE_MODE_REQUIRED/);assert.equal(reads,0);
});


test('baseline decimal-range guard remains unresolved beyond36 without cached impact promotion',()=>{
 const b=copy(),bank=JSON.parse(b.rawArtifacts['entry-route-bank']!),mint=Buffer.from(bank.result.value[1].data[0],'base64');mint[44]=37;bank.result.value[1].data[0]=mint.toString('base64');b.rawArtifacts['entry-route-bank']=JSON.stringify(bank);b.evidence.find(e=>e.id==='entry-route-bank')!.contentHash=hash(b.rawArtifacts['entry-route-bank']!);rebuildEntry(b);applyExit(b);const result=apply(b);assert.equal(result.assessments.length,0);assert.equal(JSON.parse(result.raw).entry.reasonCode,'IMPACT_ROUTE_DECIMALS_UNSUPPORTED');validateRouteImpactBundle(b);validateVenueProvenanceBundle(b);assert.equal(b.details!.baseline.find(a=>a.id==='O13')!.quality,'MISSING');
});
