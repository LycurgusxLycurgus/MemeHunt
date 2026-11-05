import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import type {EvidenceRecord} from '../src/domain/contracts.js';
import type {PublicCreatorRole} from '../src/providers/advisory-creator-role.js';
import {S14_SOURCE_ID,S14_ADAPTER,S14_SOURCE_PREFIX,s14EntryScope,s14EntryHash} from '../src/providers/advisory-actor-entry-source.js';
import {validateS19Source,deriveS19SingletonMetric,loadS19Capture,S19_SOURCE_ID,S19_SOURCE_PREFIX,S19_CAPTURE_ID,S19_ADAPTER,S19_CAPTURE_METHOD,S19_PURPOSE,S19_ROLES,S19_EVIDENCE_IDS,S19_INTERVAL_SECONDS,s19Scope,s19Hash,type S19BirthTrade,type S19Clocks,type S19WireRecord} from '../src/providers/advisory-s19-singleton-source.js';

// Genuine retained C5 source: the original four role/genesis receipts, byte for byte and with original
// requests/retrieval clocks, packaged under the frozen S19 purpose. This is source repackaging, not fresh provider acquisition.
const source=JSON.parse(gunzipSync(readFileSync('tests/fixtures/s19-creator-singleton-birth.json.gz')).toString('utf8'));
const token={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'},cutoff='2026-11-05T00:00:00.000Z';
type Bundle={evidence:EvidenceRecord[];rawArtifacts:Record<string,string>};
function portable(){
 return structuredClone(source);
}
const bundleOf=(records:S19WireRecord[]):Bundle=>({rawArtifacts:Object.fromEntries(records.map(r=>[r.id,r.raw] as [string,string])),evidence:records.map(r=>({id:r.id,sourceId:S19_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT',accessMode:'USER_IMPORT' as const,adapterVersion:S19_ADAPTER,scope:r.scope,retrievedAt:r.retrievedAt,availableAt:r.retrievedAt,contentHash:s19Hash(r.raw)}))});
function fixture():Bundle{const p=portable();return bundleOf([{id:S19_CAPTURE_ID,raw:JSON.stringify(p.manifest),scope:s19Scope('CAPTURE'),retrievedAt:p.manifest.captureCreatedAt},...p.manifest.receipts.map((r:any)=>({id:S19_SOURCE_PREFIX+r.role,raw:p.rawArtifacts[r.role]!,scope:s19Scope(r.role,r.request),retrievedAt:r.retrievedAt}))]);}
const manifestOf=(f:Bundle)=>JSON.parse(f.rawArtifacts[S19_CAPTURE_ID]!);
function editManifest(f:Bundle,edit:(m:any)=>void){const m=manifestOf(f);edit(m);f.rawArtifacts[S19_CAPTURE_ID]=JSON.stringify(m);f.evidence.find(e=>e.id===S19_CAPTURE_ID)!.contentHash=s19Hash(f.rawArtifacts[S19_CAPTURE_ID]!);for(const r of Array.isArray(m.receipts)?m.receipts:[]){const e=f.evidence.find(x=>x.id===S19_SOURCE_PREFIX+r.role);if(e)e.scope=s19Scope(r.role,r.request);}}
function replaceBody(f:Bundle,role:string,raw:string){const id=S19_SOURCE_PREFIX+role;f.rawArtifacts[id]=raw;f.evidence.find(e=>e.id===id)!.contentHash=s19Hash(raw);editManifest(f,m=>{const r=m.receipts.find((x:any)=>x.role===role);r.sourceBytes=Buffer.byteLength(raw);r.sha256=s19Hash(raw);});}
const rpc=(f:Bundle,role:string)=>JSON.parse(f.rawArtifacts[S19_SOURCE_PREFIX+role]!);
const run=(f:Bundle)=>validateS19Source(token,cutoff,f.evidence,f.rawArtifacts);

test('genuine-shape S19 source rederives the signed creation role and positive birth BUY and counts one scoped group',()=>{
 const f=fixture(),r=run(f),d=r.metric.data as any,m=manifestOf(f);
 assert.deepEqual(r.ids,[...S19_EVIDENCE_IDS]);assert.equal(r.metric.id,'S19');assert.equal(r.metric.quality,'KNOWN');assert.deepEqual(r.metric.evidenceIds,r.ids);
 assert.deepEqual(d.observedEntrantGroups,{value:1,unit:'ACTOR_GROUP_WITHIN_COHORT',globalPointValue:null});
 assert.equal(d.cohort.size,1);assert.equal(d.cohort.members.length,1);assert.equal(d.entrants.length,1);assert.equal(d.entrants[0].wallet,d.cohort.members[0].wallet);
 assert.equal(d.entrants[0].unitsAtomic,'337603576226656');assert.equal(d.entrants[0].offsetSeconds,0);assert.equal(d.entrants[0].proof,'UNIQUE_MINT_BIRTH_POSITIVE_PURCHASE');
 assert.equal(d.interval.durationSeconds,21600);assert.equal(Date.parse(d.interval.end)-Date.parse(d.interval.start),21600_000);assert.equal(d.interval.start,d.clocks.creationAt);assert.equal(d.interval.closedAtCutoff,true);
 assert.deepEqual(d.relationships.verifiedRecordsWithinPanel,[]);assert.equal(d.relationships.pairSet,'VACUOUS_PAIRSET');assert.equal(d.relationships.pairsEvaluated,0);
 assert.equal(d.independence.verifiedIndependence,null);assert.equal(d.independence.verifiedIndependenceAsserted,false);
 assert.equal(d.interpretation.convergenceInterpretable,false);assert.equal(d.interpretation.structurallyDetermined,true);assert.equal(d.interpretation.singletonScope,true);
 assert.deepEqual(d.clocks.receipts,S19_ROLES.map(role=>({role,retrievedAt:m.receipts.find((x:any)=>x.role===role).retrievedAt})));
 assert.equal(d.clocks.captureCreatedAt,m.captureCreatedAt);assert.equal(d.clocks.classificationAt,null);assert.equal(d.clocks.pagePublishedDateUsed,false);
 const expected=Math.max(Date.parse(d.interval.end),Date.parse(m.captureCreatedAt),...m.receipts.map((x:any)=>Date.parse(x.retrievedAt)));
 assert.equal(Date.parse(d.clocks.measurementAvailableAt),expected);assert.ok(expected<=Date.parse(cutoff));
 assert.deepEqual(run(fixture()).metric,r.metric);
});

test('portable loader preserves original bytes in canonical order and rejects symlink, nonregular, oversize, invalid UTF-8, grafts and hash drift',()=>{
 const dir=mkdtempSync(join(tmpdir(),'s19-'));
 try{
  const path=join(dir,'capture.json'),p=portable(),write=(x:unknown)=>writeFileSync(path,JSON.stringify(x));
  write(p);const loaded=loadS19Capture(path,token,cutoff);
  assert.deepEqual(loaded.records.map(x=>x.id),[...S19_EVIDENCE_IDS]);
  for(const role of S19_ROLES)assert.equal(loaded.records.find(x=>x.id===S19_SOURCE_PREFIX+role)!.raw,source.rawArtifacts[role]);
  assert.deepEqual(run(bundleOf(loaded.records)).metric,run(fixture()).metric);
  symlinkSync(path,join(dir,'link'));assert.throws(()=>loadS19Capture(join(dir,'link'),token,cutoff));
  assert.throws(()=>loadS19Capture(dir,token,cutoff),/S19_SINGLETON_FILE_BOUND/);
  writeFileSync(path,' '.repeat(8*1024*1024+1));assert.throws(()=>loadS19Capture(path,token,cutoff),/S19_SINGLETON_FILE_BOUND/);
  writeFileSync(path,Buffer.from([0x7b,0xff,0x7d]));assert.throws(()=>loadS19Capture(path,token,cutoff),/S19_SINGLETON_UTF8/);
  write({...p,edges:[]});assert.throws(()=>loadS19Capture(path,token,cutoff));
  write({...p,rawArtifacts:{...p.rawArtifacts,members:'[]'}});assert.throws(()=>loadS19Capture(path,token,cutoff),/S19_SINGLETON_PORTABLE_MEMBERS/);
  write({...p,manifest:{...p.manifest,observedEntrantGroups:2}});assert.throws(()=>loadS19Capture(path,token,cutoff));
  write({...p,rawArtifacts:{...p.rawArtifacts,genesis:p.rawArtifacts.genesis+' '}});assert.throws(()=>loadS19Capture(path,token,cutoff),/S19_SINGLETON_SOURCE_HASH/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('manifest admits only the S19 purpose, four distinct original roles, the fixed 21600 s birth interval and ordered clocks; grafts are rejected',()=>{
 const callers={...structuredClone(source.manifest.receipts[0]),role:'callers'};
 const edits:Array<[string,(m:any)=>void,RegExp?]>=[
  ['S14 purpose',m=>{m.purpose='CREATOR_BIRTH_ENTRY_VS_OBSERVED_INDEPENDENT_CALLS';}],
  ['other method',m=>{m.method='s14-creator-birth-call-capture-v1';}],
  ['3600 s interval',m=>{m.interval.durationSeconds=3600;}],
  ['other anchor',m=>{m.interval.anchor='FIRST_OBSERVED_TRADE';}],
  ['fifth callers receipt',m=>{m.receipts.push(callers);}],
  ['three receipts',m=>{m.receipts.pop();}],
  ['duplicate role',m=>{m.receipts[2]=structuredClone(m.receipts[0]);},/S19_SINGLETON_MANIFEST/],
  ['cross-mint',m=>{m.token.address='3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump';},/S19_SINGLETON_MANIFEST/],
  ['capture after cutoff',m=>{m.captureCreatedAt='2026-11-06T00:00:00.000Z';},/S19_SINGLETON_MANIFEST/],
  ['receipt after capture',m=>{m.receipts[1].retrievedAt='2026-11-05T00:00:00.000Z';},/S19_SINGLETON_CLOCK/],
  ['genesis request dropped',m=>{delete m.receipts[0].request;}],
  ['count graft',m=>{m.observedEntrantGroups=2;}],
  ['member graft',m=>{m.members=[{wallet:'x'}];}],
  ['edge graft',m=>{m.relationships=[{a:'x',b:'y'}];}],
  ['receipt-level graft',m=>{m.receipts[0].verified=true;}],
 ];
 for(const [name,edit,re] of edits){const f=fixture();editManifest(f,edit);assert.throws(()=>run(f),re??Error,name);}
});

test('catalog owns exactly five S19 records; foreign namespace, orphans, restamps and body drift fail closed while unowned S14 records are inert',()=>{
 const base=run(fixture()).metric;
 const changes:Array<[string,(f:Bundle)=>void,RegExp]>=[
  ['no capture',f=>{delete f.rawArtifacts[S19_CAPTURE_ID];},/S19_SINGLETON_CAPTURE_REQUIRED/],
  ['orphan raw',f=>{f.rawArtifacts[S19_SOURCE_PREFIX+'callers']='{}';},/S19_SINGLETON_CATALOG/],
  ['missing evidence',f=>{f.evidence=f.evidence.filter(e=>e.id!==S19_SOURCE_PREFIX+'role-index');},/S19_SINGLETON_CATALOG/],
  ['duplicate evidence',f=>{f.evidence.push(structuredClone(f.evidence[1]!));},/S19_SINGLETON_CATALOG/],
  ['foreign id under S19 source',f=>{f.evidence.push({...structuredClone(f.evidence[1]!),id:S14_SOURCE_PREFIX+'callers'});},/S19_SINGLETON_CATALOG/],
  ['S14 source on S19 id',f=>{f.evidence[1]!.sourceId=S14_SOURCE_ID;},/S19_SINGLETON_EVIDENCE/],
  ['content hash',f=>{f.evidence[1]!.contentHash='0'.repeat(64);},/S19_SINGLETON_EVIDENCE/],
  ['scope without original request',f=>{f.evidence[2]!.scope=s19Scope('role-page');},/S19_SINGLETON_EVIDENCE/],
  ['access mode',f=>{f.evidence[3]!.accessMode='PUBLIC_API';},/S19_SINGLETON_EVIDENCE/],
  ['restamped receipt clock',f=>{const e=f.evidence[4]!;e.availableAt=e.retrievedAt=cutoff;},/S19_SINGLETON_EVIDENCE/],
  ['body drift',f=>{const id=S19_SOURCE_PREFIX+'role-page';f.rawArtifacts[id]+=' ';f.evidence.find(e=>e.id===id)!.contentHash=s19Hash(f.rawArtifacts[id]!);},/S19_SINGLETON_SOURCE_HASH/],
  ['lone surrogate',f=>replaceBody(f,'genesis',f.rawArtifacts[S19_SOURCE_PREFIX+'genesis']+'\ud800'),/S19_SINGLETON_SOURCE_HASH/],
 ];
 for(const [name,change,re] of changes){const f=fixture();change(f);assert.throws(()=>run(f),re,name);}
 const mixed=fixture();mixed.rawArtifacts[S14_SOURCE_PREFIX+'callers']='x';
 mixed.evidence.push({id:S14_SOURCE_PREFIX+'callers',sourceId:S14_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT',accessMode:'USER_IMPORT',adapterVersion:S14_ADAPTER,scope:s14EntryScope('callers'),retrievedAt:cutoff,availableAt:cutoff,contentHash:s14EntryHash('x')});
 assert.deepEqual(run(mixed).metric,base);
});

test('rehashed foreign genesis, changed original requests and tampered role bodies are rederived from raw and rejected',()=>{
 const g=fixture();replaceBody(g,'genesis',JSON.stringify({jsonrpc:'2.0',id:1,result:'wrong'}));assert.throws(()=>run(g),/S19_SINGLETON_GENESIS/);
 const gr=fixture();editManifest(gr,m=>{m.receipts[0].request={method:'getGenesisHash',params:[1]};});assert.throws(()=>run(gr),/S19_SINGLETON_GENESIS/);
 const req=fixture();editManifest(req,m=>{m.receipts.find((r:any)=>r.role==='role-index').request.params[0]=token.address;});assert.throws(()=>run(req),/CREATOR_ROLE_RECEIPT/);
 const idx=fixture(),index=rpc(idx,'role-index');index.result=[];replaceBody(idx,'role-index',JSON.stringify(index));assert.throws(()=>run(idx),/CREATOR_ROLE_INDEX_SIGNATURE/);
 const tx=fixture(),body=rpc(tx,'role-transaction');body.result.blockTime+=1;replaceBody(tx,'role-transaction',JSON.stringify(body));assert.throws(()=>run(tx),/CREATOR_ROLE_TRANSACTION_BINDING/);
});

// SYNTHETIC, labelled: typed stand-ins for an already verified role and decoded birth trade. They test only the pure
// projection; they are not source proof, and no real token, count or outcome is implied.
const M='SyntheticMint',W='SyntheticCreator',Q='SyntheticCustomQuote',SIG='synthetic-birth-signature',T='2026-09-13T19:45:18.000Z',END='2026-09-14T01:45:18.000Z';
function synthRole(at:string,patch:Partial<PublicCreatorRole>={}):PublicCreatorRole{
 return{method:'pump-public-creator-role-v2',abi:{source:'synthetic',sha256:'0'.repeat(64),program:'synthetic',instruction:'create_v2',event:'CreateEvent',argumentTailBytes:0,eventTailBytes:0,appendedFields:'CREATION_FLAGS_AND_QUOTE_DECODED'},token:{chain:'solana',address:M},wallet:W,actor:{kind:'PUBLIC_PUMP_PROFILE',id:'PUBLIC_PUMP_PROFILE:'+W,profileUrl:'https://pump.fun/profile/'+W},relationship:'PUBLIC_PROFILE_CREATOR_CLAIM_CONFIRMED_BY_SIGNED_CREATE_V2',role:'TOKEN_CREATION_SIGNER_AND_DECLARED_CREATOR',validity:{kind:'HISTORICAL_TRANSACTION',validAt:T,validUntil:null,ongoingControlAsserted:false},creation:{holderReward:false,quoteMint:Q,logCoverage:'COMPLETE_TRANSACTION',signature:SIG,slot:7,at:T,instructionIndex:0,feePayer:W,walletIsFeePayer:true,bondingCurve:'SyntheticCurve',mintAuthority:'SyntheticMintAuthority',tokenProgram:'SyntheticTokenProgram',mintFundedBy:W,mintCloseAuthority:'NOT_INITIALIZED',uniqueness:'MINT_ALLOCATED_AND_INITIALIZED_IN_THIS_TRANSACTION'},publicClaim:{pageUrl:'https://pump.fun/coin/'+M,observedAt:'2026-09-13T20:00:00.000Z',profileLinks:1,visibleCreatorLabel:'Synt...ator',pagePublishedDate:null,pagePublishedDateUsedAsBirthProof:false},walletIndex:{retrievedAt:'2026-09-13T20:00:10.000Z',returned:1,limit:1000,providerIndexExhausted:true,oldestRetainedAt:T},cutoff:at,personIdentityAsserted:false,socialAccountBound:false,currentFeeBeneficiaryAsserted:false,limitations:['synthetic'],...patch};
}
function synthTrade(patch:(t:any)=>void=()=>{}):S19BirthTrade{const t:any={signature:SIG,slot:7,at:T,side:'BUY',base:{mint:M,account:'SyntheticCreatorAta',decimals:6,preAtomic:'0',unitsAtomic:'5',postAtomic:'5'},quote:{mint:Q},execution:'COMPLETE_SUCCESSFUL_RUNTIME_TRACE'};patch(t);return t;}
const synthClocks=(at:string,capture='2026-09-13T20:01:00.000Z',receipt='2026-09-13T20:00:30.000Z'):S19Clocks=>({captureCreatedAt:capture,receipts:S19_ROLES.map(role=>({role,retrievedAt:receipt})),cutoff:at});
const derive=(at:string,trade=synthTrade(),clocks=synthClocks(at),role=synthRole(at))=>deriveS19SingletonMetric(role,trade,S19_EVIDENCE_IDS,clocks);

test('SYNTHETIC projection: end==cutoff is closed and counts one scoped group; one millisecond earlier is MISSING with no count',()=>{
 const known=derive(END),d=known.data as any;
 assert.equal(known.quality,'KNOWN');assert.equal(d.interval.end,END);assert.equal(d.interval.closedAtCutoff,true);assert.equal(d.clocks.measurementAvailableAt,END);assert.equal(d.observedEntrantGroups.value,1);
 assert.equal(d.independence.notDisprovenGroups,1);assert.equal(d.independence.verifiedIndependence,null);assert.equal(d.interpretation.degenerate,true);assert.equal(d.interpretation.convergenceInterpretable,false);assert.equal(d.relationships.outsideAssociationsChangeScopedCount,false);
 const open=derive('2026-09-14T01:45:17.999Z'),o=open.data as any;
 assert.equal(open.quality,'MISSING');assert.equal(open.reasonCode,'S19_INTERVAL_OPEN_AT_CUTOFF');assert.equal(o.observedEntrantGroups,null);assert.equal(o.entrants,null);assert.equal(o.cohort,null);assert.equal(o.interval.closedAtCutoff,false);assert.ok(!JSON.stringify(o).includes('ACTOR_GROUP_WITHIN_COHORT'));
 const late=derive('2026-10-01T00:00:00.000Z',synthTrade(),synthClocks('2026-10-01T00:00:00.000Z','2026-09-20T00:00:00.000Z'));
 assert.equal((late.data as any).clocks.measurementAvailableAt,'2026-09-20T00:00:00.000Z');
});

test('SYNTHETIC projection rejects every non-birth-BUY mutation, foreign roles, ids and clocks instead of counting zero',()=>{
 const trades:Array<[string,(t:any)=>void]>=[['signature',t=>{t.signature='later';}],['slot',t=>{t.slot=8;}],['clock',t=>{t.at='2026-09-13T19:45:19.000Z';}],['side',t=>{t.side='SELL';}],['target',t=>{t.base.mint='OtherMint';}],['prior balance',t=>{t.base.preAtomic='1';t.base.postAtomic='6';}],['zero units',t=>{t.base.unitsAtomic='0';t.base.postAtomic='0';}],['post mismatch',t=>{t.base.postAtomic='4';}]];
 for(const [name,mutate] of trades)assert.throws(()=>derive(END,synthTrade(mutate)),/S14_ENTRY_BIRTH_PURCHASE_REQUIRED/,name);
 assert.throws(()=>derive(END,synthTrade(),synthClocks(END),synthRole(END,{method:'pump-public-creator-role-v1'})),/S19_SINGLETON_ROLE/);
 assert.throws(()=>derive(END,synthTrade(),synthClocks(END),synthRole('2026-10-01T00:00:00.000Z')),/S19_SINGLETON_ROLE/);
 assert.throws(()=>derive(END,synthTrade(t=>{t.quote.mint='So11111111111111111111111111111111111111112';})),/S19_SINGLETON_ROLE/);
 const c=synthClocks(END);
 assert.throws(()=>derive(END,synthTrade(),{...c,receipts:c.receipts.slice(1)}),/S19_SINGLETON_CLOCK/);
 assert.throws(()=>derive(END,synthTrade(),synthClocks(END,'2026-09-13T20:01:00.000Z','2026-09-13T20:02:00.000Z')),/S19_SINGLETON_CLOCK/);
 assert.throws(()=>derive(END,synthTrade(),synthClocks(END,'2026-09-15T00:00:00.000Z')),/S19_SINGLETON_CLOCK/);
 assert.throws(()=>deriveS19SingletonMetric(synthRole(END),synthTrade(),[...S19_EVIDENCE_IDS,S14_SOURCE_PREFIX+'callers'],synthClocks(END)),/S19_SINGLETON_EVIDENCE_IDS/);
});

