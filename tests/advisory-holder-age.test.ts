import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHolderAgeFixture,type HolderAgeFixtureMode} from './holder-age-fixtures.js';
import {deriveO22HolderAge,validateHolderReference,HOLDER_AGE_SPECIAL_ADDRESSES} from '../src/providers/advisory-holder-age.js';
import type {HolderAgeSourceContext} from '../src/providers/advisory-holder-age-source.js';
function fixture(run:(context:HolderAgeSourceContext)=>void,mode:HolderAgeFixtureMode='mixed'){
 const dir=mkdtempSync(join(tmpdir(),'holder-age-core-'));try{run(createHolderAgeFixture(dir,mode).context);}finally{rmSync(dir,{recursive:true,force:true});}
}
const data=(c:HolderAgeSourceContext):any=>deriveO22HolderAge(c,['own-source']).data;

test('mixed constructed holdings use every genuine observed owner reference and exact weighted recent fraction',()=>fixture(c=>{
 const metric=deriveO22HolderAge(c,['own-source','own-source']),d:any=metric.data;assert.equal(metric.quality,'KNOWN');assert.equal(d.method,'holder-weighted-observed-reference-age-v2');assert.deepEqual(d.classificationCounts,{OLD_WITNESSED:2,FRESH_UNDER_DECLARED_INDEX:3,UNKNOWN:0});assert.deepEqual(d.weightsAtomic,{old:'600',fresh:'900',unknown:'0',total:'1500'});assert.equal(d.fraction,'0.6');assert.equal(d.numeratorAtomic,'900');assert.equal(d.denominatorAtomic,'1500');assert.equal(d.ownerProofs.length,5);assert.ok(d.ownerProofs.some((p:any)=>p.classification==='OLD_WITNESSED'&&p.witnessKey.startsWith('OLDER:')));assert.equal(d.firstEverActivityAt,null);assert.equal(d.walletBirth,null);assert.equal(d.queryHistoryStartSlot,0);assert.deepEqual(metric.evidenceIds,['own-source']);
}));

test('full genuine ClaudeCoin115 positive older witnesses prove zero recent weight without treating empty history as zero',()=>fixture(c=>{
 const metric=deriveO22HolderAge(c,[]),d:any=metric.data;assert.equal(metric.quality,'KNOWN');assert.equal(d.ownerProofs.length,115);assert.equal(d.classificationCounts.OLD_WITNESSED,115);assert.equal(d.weightsAtomic.total,'916940499041442');assert.equal(d.weightsAtomic.old,d.weightsAtomic.total);assert.equal(d.weightsAtomic.unknown,'0');assert.equal(d.fraction,'0');assert.ok(d.ownerProofs.every((p:any)=>p.classification==='OLD_WITNESSED'&&p.witnessKey));
},'claudecoin'));

test('empty, missing and null-time histories without a dated fallback retain their complete unknown weight',()=>fixture(c=>{
 const fallbackIndex=[...c.older.keys()][0]!;const noFallback=structuredClone(c);noFallback.older.delete(fallbackIndex);const d=data(noFallback);assert.equal(d.complete,false);assert.equal(d.fraction,null);assert.equal(d.weightsAtomic.unknown,c.owners[fallbackIndex]!.heldAtomic);assert.equal(d.numeratorAtomic,null);
 const empty=structuredClone(c),oldIndex=[...empty.first.keys()].find(i=>!empty.prefixes.has(i)&&!empty.older.has(i))!;empty.first.get(oldIndex)!.value={data:[],paginationToken:null};const e=data(empty);assert.equal(e.fraction,null);assert.equal(e.classificationCounts.UNKNOWN,1);assert.equal(e.weightsAtomic.unknown,c.owners[oldIndex]!.heldAtomic);
 const missing=structuredClone(c);missing.first.delete(oldIndex);assert.equal(data(missing).fraction,null);
}));

test('an earlier prefix or same-slot BEFORE result blocks the shared negative-history premise',()=>fixture(c=>{
 const recent=[...c.prefixes.keys()][0]!;for(const kind of ['prefix','before']){const bad=structuredClone(c);if(kind==='prefix')bad.prefixes.get(recent)!.value={data:[{signature:'retained-index-observation'}],paginationToken:'1:0'};else bad.before.get(recent)!.value=[{signature:'same-slot-earlier-observation'}];const m=deriveO22HolderAge(bad,[]),d:any=m.data;assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,'HOLDER_REFERENCE_INDEX_CONTRADICTION');assert.equal(d.fraction,null);assert.equal(d.classificationCounts.FRESH_UNDER_DECLARED_INDEX,0);assert.equal(d.weightsAtomic.old,'600');assert.equal(d.weightsAtomic.unknown,'900');}
}));

test('all owner weights, roster membership, mint/population reconciliation and source clock remain conjunctive',()=>fixture(c=>{
 const mutations:Array<[string,(v:HolderAgeSourceContext)=>void]>=[['weight',v=>{v.owners[0]!.heldAtomic='1';}],['omit smallest owner',v=>{v.owners.pop();}],['duplicate owner',v=>{v.owners.push({...v.owners[0]!});}],['mint supply',v=>{v.mint.supplyAtomic='1';}],['population slot',v=>{v.holders.slot++;}],['program',v=>{v.mint.program='11111111111111111111111111111111';}],['orphan',v=>{v.first.set(999,v.first.get(0)!);}],['future source',v=>{v.first.get(0)!.record.retrievedAt='2099-01-01T00:00:00Z';}],['premise',v=>{(v.summary.providerIndexPremise as any).requestedSlotFloor=1;}]];
 for(const[label,mutate]of mutations){const bad=structuredClone(c);mutate(bad);assert.throws(()=>deriveO22HolderAge(bad,[]),label);}
 const adjacent=structuredClone(c);adjacent.mint.slot=adjacent.bank.slot-1;assert.equal(data(adjacent).mintPopulationSameSlot,false);assert.equal(data(adjacent).fraction,'0.6');
}));

test('zero holdings remain undefined even if the empty owner roster is complete',()=>fixture(c=>{
 const z=structuredClone(c);z.holders.accounts=[];z.holders.supplyAtomic='0';z.mint.supplyAtomic='0';z.owners=[];z.first.clear();z.prefixes.clear();z.before.clear();z.older.clear();z.summary.exceptionalOwners=[];const m=deriveO22HolderAge(z,[]),d:any=m.data;assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,'HOLDER_REFERENCE_AGE_ZERO_DENOMINATOR');assert.equal(d.fraction,null);assert.equal(d.denominatorAtomic,'0');
}));

test('native reference validates legacy/v0/v1 including ALT, failed/passive references, nullable clocks and exact cursors',()=>fixture(c=>{
 const versions=new Set<unknown>();let alt=false;for(const[i,e]of c.first){const ref=validateHolderReference(e.value,c.owners[i]!.owner,c.bank,e.record.retrievedAt);assert.ok(ref);versions.add(ref.version);alt ||= e.value.data[0].transaction.message.accountKeys.some((k:any)=>k.source==='lookupTable');}
 assert.ok(versions.has('legacy')&&versions.has(0)&&alt);const[i,e]=[...c.first][0]!,owner=c.owners[i]!.owner,v=structuredClone(e.value);v.data[0].meta.err={InstructionError:[0,{Custom:1}]};const ref=validateHolderReference(v,owner,c.bank,e.record.retrievedAt);assert.equal(ref!.failed,true);assert.equal(ref!.signer,e.value.data[0].transaction.message.accountKeys.find((k:any)=>k.pubkey===owner).signer);v.data[0].blockTime=null;assert.equal(validateHolderReference(v,owner,c.bank,e.record.retrievedAt)!.blockTime,null);assert.equal(validateHolderReference({data:[],paginationToken:null},owner,c.bank,e.record.retrievedAt),null);
},'claudecoin'));

test('malformed header, version, owner, timestamp, key, signature and cursor fail native reference validation',()=>fixture(c=>{
 const entry=c.first.get(0)!,owner=c.owners[0]!.owner;const mutations:Array<[string,(v:any)=>void]>=[['version',v=>{v.data[0].version=2;}],['header',v=>{v.data[0].transaction.message.header={numRequiredSignatures:999,numReadonlySignedAccounts:0,numReadonlyUnsignedAccounts:0};}],['bank overflow',v=>{v.data[0].slot=c.bank.slot+1;}],['clock overflow',v=>{v.data[0].blockTime=c.bank.blockTime+1;}],['unknown owner',v=>{v.data[0].transaction.message.accountKeys=v.data[0].transaction.message.accountKeys.filter((k:any)=>k.pubkey!==owner);}],['signature',v=>{v.data[0].transaction.signatures[0]='111';}],['key flags',v=>{v.data[0].transaction.message.accountKeys[0].signer=false;}],['cursor',v=>{v.paginationToken='1:0';}],['empty cursor',v=>{v.data=[];v.paginationToken='1:0';}]];for(const[label,mutate]of mutations){const bad=structuredClone(entry.value);mutate(bad);assert.throws(()=>validateHolderReference(bad,owner,c.bank,entry.record.retrievedAt),label);}assert.throws(()=>validateHolderReference(entry.value,owner,c.bank,'2020-01-01T00:00:00Z'));
 const v1=[...c.first].find(([,e])=>e.value.data[0]?.version===1);assert.ok(v1);const bad=structuredClone(v1[1].value);bad.data[0].transaction.message.transactionConfig.extra=1;assert.throws(()=>validateHolderReference(bad,c.owners[v1[0]]!.owner,c.bank,v1[1].record.retrievedAt));
}));

test('documented special addresses cannot acquire FRESH authority from empty negatives',()=>fixture(c=>{
 assert.equal(HOLDER_AGE_SPECIAL_ADDRESSES.length,29);const special='11111111111111111111111111111111';assert.ok(HOLDER_AGE_SPECIAL_ADDRESSES.includes(special));assert.ok(HOLDER_AGE_SPECIAL_ADDRESSES.includes('BPFLoaderUpgradeab1e11111111111111111111111'));
 // Explicitly CONSTRUCTED one-owner core context, retaining an actual positive recent native reference
 // to System already present in that message. Not a source-valid replacement of original holdings.
 const i=[...c.prefixes.keys()][0]!,e=c.first.get(i)!,v=structuredClone(c);assert.ok(e.value.data[0].transaction.message.accountKeys.some((k:any)=>k.pubkey===special));v.holders.accounts=[{...v.holders.accounts[0]!,owner:special,amount:'100'}];v.holders.supplyAtomic='100';v.mint.supplyAtomic='100';v.owners=[{owner:special,heldAtomic:'100'}];v.first=new Map([[0,e]]);v.prefixes=new Map([[0,c.prefixes.get(i)!]]);v.before=new Map([[0,c.before.get(i)!]]);v.older.clear();v.summary.exceptionalOwners=[special];const d=data(v);assert.equal(d.fraction,null);assert.equal(d.weightsAtomic.unknown,'100');assert.equal(d.ownerProofs[0].reason,'DOCUMENTED_SPECIAL_ADDRESS_INDEX_UNSUPPORTED');
}));

test('genuine parsed readonly program inside the static writable prefix does not reconstruct a false raw header',()=>fixture(c=>{
 const match=[...c.first].find(([,e])=>{const t=e.value.data[0],m=t.transaction.message,keys=m.accountKeys.filter((k:any)=>k.source==='transaction'),signed=t.transaction.signatures.length;return keys.some((k:any,i:number)=>i>=signed&&!k.writable&&keys.slice(i+1).some((next:any)=>next.writable));});assert.ok(match);const[i,e]=match;const ref=validateHolderReference(e.value,c.owners[i]!.owner,c.bank,e.record.retrievedAt);assert.ok(ref);assert.equal(ref.signature,e.value.data[0].transaction.signatures[0]);assert.equal(ref.blockTime,e.value.data[0].blockTime);
 // This is a reference, not permission to use parsed writable flags as serialized or financial authority.
 assert.equal(deriveO22HolderAge(c,[]).quality,'KNOWN');
},'claudecoin'));

test('descriptor-defined ALT segments admit effective demotion but preserve readonly, index, signer and header bounds',()=>fixture(c=>{
 const match=[...c.first].find(([,e])=>{const t=e.value.data[0];return t.version===0&&t.transaction.message.accountKeys.some((k:any)=>k.source==='lookupTable'&&k.pubkey==='11111111111111111111111111111111');});assert.ok(match);const[i,e]=match,v=structuredClone(e.value),t=v.data[0],m=t.transaction.message,lookups=m.addressTableLookups as any[],statics=m.accountKeys.filter((k:any)=>k.source==='transaction'),loaded=m.accountKeys.filter((k:any)=>k.source==='lookupTable'),w=lookups.reduce((n,l)=>n+l.writableIndexes.length,0);const system=loaded.findIndex((k:any)=>k.pubkey==='11111111111111111111111111111111');assert.ok(system>=w);assert.equal(loaded[system].writable,false);
 // CONSTRUCTED metadata case: declare the already-referenced System key writable in its ALT,
 // while preserving the native effective readonly flag, as official runtime demotion permits.
 let wi=0,ri=w;const groups=lookups.map(l=>{const writable=loaded.slice(wi,wi+l.writableIndexes.length),readonly=loaded.slice(ri,ri+l.readonlyIndexes.length);wi+=l.writableIndexes.length;ri+=l.readonlyIndexes.length;return{writable,readonly};});const group=groups.findIndex(g=>g.readonly.some((k:any)=>k.pubkey==='11111111111111111111111111111111'));assert.ok(group>=0);const at=groups[group]!.readonly.findIndex((k:any)=>k.pubkey==='11111111111111111111111111111111'),key=groups[group]!.readonly.splice(at,1)[0],index=lookups[group]!.readonlyIndexes.splice(at,1)[0];groups[group]!.writable.push(key);lookups[group]!.writableIndexes.push(index);m.accountKeys=[...statics,...groups.flatMap(g=>g.writable),...groups.flatMap(g=>g.readonly)];if(t.meta.loadedAddresses)t.meta.loadedAddresses={writable:groups.flatMap(g=>g.writable).map((k:any)=>k.pubkey),readonly:groups.flatMap(g=>g.readonly).map((k:any)=>k.pubkey)};
 assert.ok(validateHolderReference(v,c.owners[i]!.owner,c.bank,e.record.retrievedAt));
 for(const[label,mutate]of [['readonly escalation',(b:any)=>{b.data[0].transaction.message.accountKeys.at(-1).writable=true;}],['loaded signer',(b:any)=>{b.data[0].transaction.message.accountKeys.at(-1).signer=true;}],['lookup length',(b:any)=>{b.data[0].transaction.message.addressTableLookups[0].writableIndexes.push(255);}]] as Array<[string,(b:any)=>void]>){const bad=structuredClone(v);mutate(bad);assert.throws(()=>validateHolderReference(bad,c.owners[i]!.owner,c.bank,e.record.retrievedAt),label);}
 const badHeader=structuredClone(v);badHeader.data[0].transaction.message.header={numRequiredSignatures:t.transaction.signatures.length,numReadonlySignedAccounts:0,numReadonlyUnsignedAccounts:statics.length};assert.throws(()=>validateHolderReference(badHeader,c.owners[i]!.owner,c.bank,e.record.retrievedAt),/HEADER/);
},'claudecoin'));
