import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import type {EvidenceRecord} from '../src/domain/contracts.js';
import {loadS14EntryCapture,validateS14EntrySource,S14_SOURCE_ID,S14_ADAPTER,S14_SOURCE_PREFIX,S14_CAPTURE_ID,s14EntryScope,s14EntryHash,deriveS14EntryMetric,verifyS14BirthTrade} from '../src/providers/advisory-actor-entry-source.js';
import {s14EntryDescriptor,validateS14EntryCore} from '../src/app/s14-entry.js';
const portableRaw=gunzipSync(readFileSync('tests/fixtures/s14-creator-birth-entry.json.gz')).toString('utf8');
const token={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'},cutoff='2026-11-03T00:00:00.000Z';
function fixture(){
 const p=JSON.parse(portableRaw),rawArtifacts:Record<string,string>={[S14_CAPTURE_ID]:JSON.stringify(p.manifest)},evidence:EvidenceRecord[]=[];
 for(const r of p.manifest.receipts)rawArtifacts[S14_SOURCE_PREFIX+r.role]=p.rawArtifacts[r.role];
 for(const [id,raw]of Object.entries(rawArtifacts)){const r=p.manifest.receipts.find((r:any)=>S14_SOURCE_PREFIX+r.role===id),at=r?.retrievedAt??p.manifest.captureCreatedAt;evidence.push({id,sourceId:S14_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT',accessMode:'USER_IMPORT',adapterVersion:S14_ADAPTER,scope:r?s14EntryScope(r.role,r.request):s14EntryScope('CAPTURE'),retrievedAt:at,availableAt:at,contentHash:s14EntryHash(raw)});}
 return{token,cutoff,evidence,rawArtifacts};
}
function editManifest(f:ReturnType<typeof fixture>,edit:(m:any)=>void){const m=JSON.parse(f.rawArtifacts[S14_CAPTURE_ID]!);edit(m);f.rawArtifacts[S14_CAPTURE_ID]=JSON.stringify(m);f.evidence.find(e=>e.id===S14_CAPTURE_ID)!.contentHash=s14EntryHash(f.rawArtifacts[S14_CAPTURE_ID]!);}
function replaceBody(f:ReturnType<typeof fixture>,role:string,raw:string){const id=S14_SOURCE_PREFIX+role;f.rawArtifacts[id]=raw;f.evidence.find(e=>e.id===id)!.contentHash=s14EntryHash(raw);editManifest(f,m=>{const r=m.receipts.find((r:any)=>r.role===role);r.sourceBytes=Buffer.byteLength(raw);r.sha256=s14EntryHash(raw);});}
test('genuine compact native birth source reconstructs signed lead and unbounded global-call interval',()=>{
 const f=fixture(),r=validateS14EntrySource(token,cutoff,f.evidence,f.rawArtifacts),d=r.metric.data as any;
 assert.equal(r.ids.length,6);assert.equal(r.metric.quality,'KNOWN');assert.equal(d.signedSeconds,-3600139);assert.equal(d.events.length,3);assert.equal(d.globalFirstCallLead.lowerBoundSeconds,-3600139);assert.equal(d.globalFirstCallLead.upperBoundSeconds,null);assert.equal(d.socialAccountBound,false);assert.equal(d.entry.unitsAtomic,'337603576226656');
 assert.deepEqual(validateS14EntryCore(f,{method:'advisory-provenance-v70',token,cutoff,s14Entry:s14EntryDescriptor()})!.metric,r.metric);
});
test('portable import preserves all original bytes and rejects symlink, foreign members and oversize files',()=>{
 const dir=mkdtempSync(join(tmpdir(),'s14-'));try{const path=join(dir,'capture.json');writeFileSync(path,portableRaw);const r=loadS14EntryCapture(path,token,cutoff);assert.equal(r.records.length,6);assert.equal(r.records.find(r=>r.id===S14_SOURCE_PREFIX+'callers')!.raw,fixture().rawArtifacts[S14_SOURCE_PREFIX+'callers']);symlinkSync(path,join(dir,'link'));assert.throws(()=>loadS14EntryCapture(join(dir,'link'),token,cutoff));const p=JSON.parse(portableRaw);p.unowned=true;writeFileSync(path,JSON.stringify(p));assert.throws(()=>loadS14EntryCapture(path,token,cutoff));writeFileSync(path,' '.repeat(8*1024*1024+1));assert.throws(()=>loadS14EntryCapture(path,token,cutoff),/BOUND/);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('purpose, cross-mint, source clocks, exact membership and hashes are checked',()=>{
 for(const edit of [(m:any)=>{m.purpose='OTHER';},(m:any)=>{m.token.address='3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump';},(m:any)=>{m.captureCreatedAt='2026-11-04T00:00:00.000Z';},(m:any)=>{m.receipts[0].retrievedAt='2026-11-04T00:00:00.000Z';}]){const f=fixture();editManifest(f,edit);assert.throws(()=>validateS14EntrySource(token,cutoff,f.evidence,f.rawArtifacts));}
 for(const change of [(f:ReturnType<typeof fixture>)=>{delete f.rawArtifacts[S14_SOURCE_PREFIX+'genesis'];},(f:ReturnType<typeof fixture>)=>{f.rawArtifacts[S14_SOURCE_PREFIX+'unknown']='x';},(f:ReturnType<typeof fixture>)=>{f.evidence[1]!.contentHash='0'.repeat(64);},(f:ReturnType<typeof fixture>)=>{f.evidence[1]!.sourceId='old';},(f:ReturnType<typeof fixture>)=>{f.evidence[1]!.scope={};},(f:ReturnType<typeof fixture>)=>{f.evidence[1]!.availableAt=cutoff;}]){const f=fixture();change(f);assert.throws(()=>validateS14EntrySource(token,cutoff,f.evidence,f.rawArtifacts));}
});
test('correctly rehashed foreign genesis, changed original role request and unavailable caller classification fail closed',()=>{
 const g=fixture();replaceBody(g,'genesis',JSON.stringify({jsonrpc:'2.0',id:1,result:'wrong'}));assert.throws(()=>validateS14EntrySource(token,cutoff,g.evidence,g.rawArtifacts),/GENESIS/);
 const req=fixture();editManifest(req,m=>{m.receipts.find((r:any)=>r.role==='role-index').request.params[0]=token.address;});req.evidence.find(e=>e.id===S14_SOURCE_PREFIX+'role-index')!.scope=s14EntryScope('role-index',JSON.parse(req.rawArtifacts[S14_CAPTURE_ID]!).receipts.find((r:any)=>r.role==='role-index').request);assert.throws(()=>validateS14EntrySource(token,cutoff,req.evidence,req.rawArtifacts));
 const q=fixture(),body=JSON.parse(q.rawArtifacts[S14_SOURCE_PREFIX+'callers']!);body.qualification=null;replaceBody(q,'callers',JSON.stringify(body));assert.throws(()=>validateS14EntrySource(token,cutoff,q.evidence,q.rawArtifacts),/COMPLETE_CALL_EVENTS_REQUIRED/);
});
test('birth checker rejects SELL, nonbirth clocks/signatures and a pre-existing target balance',()=>{
 const role:any={token,creation:{signature:'birth',slot:1,at:'2026-01-01T00:00:00.000Z',uniqueness:'MINT_ALLOCATED_AND_INITIALIZED_IN_THIS_TRANSACTION',mintCloseAuthority:'NOT_INITIALIZED'}},trade:any={signature:'birth',slot:1,at:role.creation.at,side:'BUY',base:{mint:token.address,preAtomic:'0',unitsAtomic:'2',postAtomic:'2'}};
 for(const mutate of [(t:any)=>{t.side='SELL';},(t:any)=>{t.slot=2;},(t:any)=>{t.signature='later';},(t:any)=>{t.base.preAtomic='1';},(t:any)=>{t.base.unitsAtomic='0';}]){const t=structuredClone(trade);mutate(t);assert.throws(()=>verifyS14BirthTrade(role,t),/BIRTH_PURCHASE_REQUIRED/);}
});
test('all earliest ties retained, sample bound does not silently restrict prebirth calls',()=>{
 const role:any={wallet:'creator',token,creation:{signature:'birth',slot:1,at:'2026-01-01T00:00:00.000Z',uniqueness:'MINT_ALLOCATED_AND_INITIALIZED_IN_THIS_TRANSACTION',mintCloseAuthority:'NOT_INITIALIZED'}},trade:any={signature:'birth',slot:1,at:role.creation.at,side:'BUY',base:{mint:token.address,preAtomic:'0',unitsAtomic:'2',postAtomic:'2'}};
 const events=['b','a','c'].map((sourceId,i)=>({sourceId,contract:token.address,classification:'FORWARD_CALL',publishedAt:i===2?'2026-01-01T00:02:00.000Z':'2025-12-31T23:59:00.000Z',timePrecision:'SECOND'}));
 const d=deriveS14EntryMetric(role,trade,{id:'S07',quality:'KNOWN',data:{events},evidenceIds:[],unit:'scoped-record',reasonCode:'test'},['own'],{}).data as any;assert.equal(d.signedSeconds,60);assert.deepEqual(d.earliestObservedCalls.map((e:any)=>e.sourceId),['a','b']);assert.equal(d.globalFirstCallLead.upperBoundSeconds,null);
});
