import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildA30FxReference,buildA30FxCells,resolveA30FxState,type A30FxWriter,type A30FxReference} from '../src/providers/advisory-demand-fx-state.js';
import {ORCA,stateSource,replaceNative,genuineSelected,genuineEvent,topOnly,ownerForms,formTransaction,base58} from './a30-fx-state-fixtures.js';

test('genuine truncated native event anchors only after full unchanged compiled parity and ancestor proof',()=>stateSource((source,cutoff,tx)=>{
 const ref=buildA30FxReference(source,cutoff);assert.equal(ref.complete,true,ref.reasonCode);assert.equal(ref.writers.length,1);assert.equal(ref.cells.length,2);const writer=ref.writers[0]!;assert.ok(writer.first);assert.equal(writer.first.proofMode,'COMPILED_RUNTIME');assert.equal(writer.first.compiledSource?.id,'advisory-a30-fx-fx-compiled-0');assert.ok(writer.first.ownAndAncestors.length>=2);assert.ok(writer.first.ownAndAncestors.some(a=>a.proof==='COMMITTED'));
 assert.equal(resolveA30FxState(ref,{slot:tx.slot,transactionIndex:tx.transactionIndex,signature:tx.transaction.signatures[0]}).sqrtPriceX64,writer.first.pre);assert.equal(resolveA30FxState(ref,{slot:tx.slot,transactionIndex:tx.transactionIndex+1,signature:'constructed-after'}).sqrtPriceX64,writer.last!.post);
 const nativeOnly=structuredClone(source);for(const key of Object.keys(nativeOnly.requests).filter(k=>k.startsWith('fx-compiled-'))){delete nativeOnly.requests[key];delete nativeOnly.rawArtifacts[key];delete nativeOnly.retrievedAt[key];}const unproved=buildA30FxReference(nativeOnly,cutoff);assert.equal(unproved.complete,true,unproved.reasonCode);assert.equal(unproved.writers[0]!.first,null);assert.equal(unproved.cells[0]!.status,'UNANCHORED');
}));

test('native strict and explicit prefix paths retain original event payloads without requiring global CPI signer',()=>stateSource((source,cutoff,tx)=>{
 const ix=genuineSelected(tx),event=genuineEvent(tx);topOnly(tx,ix,event);replaceNative(source,tx);const strict=buildA30FxReference(source,cutoff);assert.equal(strict.complete,true,strict.reasonCode);assert.equal(strict.writers[0]!.first?.proofMode,'STRICT_NATIVE');
 // Construct a later open branch; the selected native top-level already succeeded.
 tx.transaction.message.instructions.push({...ix});tx.meta.logMessages.push(`Program ${ORCA} invoke [1]`,'Log truncated');replaceNative(source,tx);const prefix=buildA30FxReference(source,cutoff);assert.equal(prefix.complete,true,prefix.reasonCode);assert.equal(prefix.writers[0]!.first?.proofMode,'POSITIVE_NATIVE_PREFIX');assert.equal(prefix.writers[0]!.last,null);assert.equal(prefix.writers[0]!.possibleWriters,2);
 // A CPI Signer is source-validated by its successful invoke_signed context.
 const caller=tx.transaction.message.accountKeys.find((k:any)=>k.pubkey!==(ix.accounts[1])&&k.pubkey!==ORCA)!.pubkey;tx.transaction.message.instructions=[{programId:caller,accounts:[],data:'1'}];tx.meta.innerInstructions=[{index:0,instructions:[{...ix,stackHeight:2}]}];tx.meta.logMessages=[`Program ${caller} invoke [1]`,`Program ${ORCA} invoke [2]`,event,`Program ${ORCA} success`,`Program ${caller} success`];tx.transaction.message.accountKeys.find((k:any)=>k.pubkey===ix.accounts[1]).signer=false;replaceNative(source,tx);const cpi=buildA30FxReference(source,cutoff);assert.equal(cpi.complete,true,cpi.reasonCode);assert.ok(cpi.writers[0]!.first);
}));

test('unknown owner opcodes, typed aliases, writability and initialization fail the whole reference',()=>stateSource((source,cutoff,tx)=>{
 const mutations:Array<(t:any)=>void>=[t=>{genuineSelected(t).data=base58(Buffer.alloc(42));},t=>{genuineSelected(t).accounts[7]=source.fx.pool;},t=>{t.transaction.message.accountKeys.find((k:any)=>k.pubkey===source.fx.pool).writable=false;},t=>{genuineSelected(t).data=base58(createHash('sha256').update('global:initialize_pool').digest().subarray(0,8));}];
 for(const change of mutations){const r=structuredClone(source),t=structuredClone(tx);change(t);replaceNative(r,t);const ref=buildA30FxReference(r,cutoff);assert.equal(ref.complete,false,ref.reasonCode);assert.equal(resolveA30FxState(ref,{slot:t.slot,transactionIndex:t.transactionIndex,signature:t.transaction.signatures[0]}).status,'MISSING');}
}));

test('all actual selected instruction forms close typed roles, while remaining-account and fixed padding mutations reject',()=>stateSource((source,cutoff,tx)=>{
 for(const[label,form]of Object.entries(ownerForms())){const r=structuredClone(source),t=formTransaction(structuredClone(tx),form);replaceNative(r,t);const ref=buildA30FxReference(r,cutoff);assert.equal(ref.complete,true,label+': '+ref.reasonCode);assert.equal(ref.coverage.possibleWriterInvocations,label.startsWith('swap')||label.startsWith('two_hop')?1:0,label);assert.equal(ref.cells.every(c=>c.status==='UNANCHORED'),true,label);}
 for(const label of ['swap_v2|bytes=50|accounts=15','swap_v2|bytes=53|accounts=16']){const r=structuredClone(source),form=structuredClone(ownerForms()[label]!),bytes=Buffer.from(form.dataHex,'hex');bytes[bytes.length-1]=9;form.dataHex=bytes.toString('hex');replaceNative(r,formTransaction(structuredClone(tx),form));assert.equal(buildA30FxReference(r,cutoff).complete,false,label);}
}));

test('event full length, direction and duplicates reject rather than deduplicate or fabricate state',()=>stateSource((source,cutoff,tx)=>{
 const event=genuineEvent(tx);for(const mutate of [(b:Buffer)=>b.subarray(0,120),(b:Buffer)=>{b[40]=b[40]===1?0:1;return b;}]){const r=structuredClone(source),t=topOnly(structuredClone(tx),genuineSelected(tx),'Program data: '+mutate(Buffer.from(event.slice(14),'base64')).toString('base64'));replaceNative(r,t);assert.equal(buildA30FxReference(r,cutoff).complete,false);}
 const t=topOnly(structuredClone(tx),genuineSelected(tx),event);t.meta.logMessages.splice(2,0,event);replaceNative(source,t);assert.equal(buildA30FxReference(source,cutoff).reasonCode,'A30_FX_STATE_DUPLICATE_EVENT');
}));

test('own success below a rolled-back ancestor never supplies a price; absent events remain mutation barriers',()=>stateSource((source,cutoff,tx)=>{
 const ix=genuineSelected(tx),event=genuineEvent(tx),system='11111111111111111111111111111111',caller=tx.transaction.message.instructions[7].programId;
 tx.transaction.message.instructions=[{programId:system,accounts:[],data:'1'}];tx.meta.innerInstructions=[{index:0,instructions:[{programId:caller,accounts:[],data:'1',stackHeight:2},{...ix,stackHeight:3}]}];tx.meta.logMessages=[`Program ${system} invoke [1]`,`Program ${caller} invoke [2]`,`Program ${ORCA} invoke [3]`,event,`Program ${ORCA} success`,`Program ${caller} failed: constructed rollback`,`Program ${system} success`];replaceNative(source,tx);const rollback=buildA30FxReference(source,cutoff);assert.equal(rollback.complete,true,rollback.reasonCode);assert.equal(rollback.writers[0]!.first,null);assert.equal(rollback.writers[0]!.missingEvents,0);
 topOnly(tx,ix);replaceNative(source,tx);const absent=buildA30FxReference(source,cutoff);assert.equal(absent.complete,true,absent.reasonCode);assert.equal(absent.writers[0]!.possibleWriters,1);assert.equal(absent.writers[0]!.missingEvents,1);assert.equal(absent.cells[0]!.status,'UNANCHORED');
}));

test('static bank price cannot change historical cell state; source clocks still fail globally',()=>stateSource((source,cutoff)=>{
 const before=buildA30FxReference(source,cutoff);const r=structuredClone(source),bank=JSON.parse(r.rawArtifacts['fx-identity-bank']!),b=Buffer.from(bank.result.value[8].data[0],'base64');b.writeBigUInt64LE(b.readBigUInt64LE(65)+1n,65);bank.result.value[8].data[0]=b.toString('base64');r.rawArtifacts['fx-identity-bank']=JSON.stringify(bank);assert.deepEqual(buildA30FxReference(r,cutoff).cells,before.cells);r.retrievedAt['fx-compiled-0']='2026-10-30T15:00:00.000Z';assert.equal(buildA30FxReference(r,cutoff).complete,false);
}));

// Explicitly constructed state kernel counterexamples; these endpoints are not RPC observations.
function writer(index:number,pre:string|null,post:string|null):A30FxWriter{const endpoint=(pre:string,post:string)=>({signature:'constructed-'+index,slot:100+index*10,transactionIndex:1,sourceId:'constructed',sourceHash:'0'.repeat(64),sourceAt:'2026-10-26T08:00:00.000Z',eventHash:'1'.repeat(64),logIndex:1,proofMode:'STRICT_NATIVE' as const,frame:{top:0,position:-1,depth:1,order:0},ownAndAncestors:[{programId:ORCA,top:0,position:-1,depth:1,proof:'LOGGED_SUCCESS' as const}],pre,post});return{signature:'constructed-'+index,slot:100+index*10,transactionIndex:1,blockTime:1792960000,possibleWriters:1,first:pre===null?null:endpoint(pre,post??pre),last:post===null?null:endpoint(pre??post,post),missingEvents:pre===null?1:0,unboundEventInvocations:0,unprovedEndpoints:pre===null?1:0};}
function reference(writers:A30FxWriter[]):A30FxReference{return{method:'a30-incoming-fx-state-cells-v1',complete:true,range:{start:'2026-10-25T20:00:00.000Z',end:'2026-10-26T08:00:00.000Z'},anchorSlot:999,writers,cells:buildA30FxCells(writers),coverage:{constructed:true},reasonCode:'CONSTRUCTED',sourceContext:null} as unknown as A30FxReference;}
const query=(r:A30FxReference,slot:number,transactionIndex=0,signature='constructed-query')=>resolveA30FxState(r,{slot,transactionIndex,signature});
test('right first.pre identifies only its own mutation-free cell across an isolated missing writer',()=>{
 const r=reference([writer(0,'10','20'),writer(1,null,null),writer(2,'30','40')]);assert.equal(query(r,105).sqrtPriceX64,'20');assert.equal(query(r,115).sqrtPriceX64,'30');assert.equal(query(r,110,1,'constructed-1').sqrtPriceX64,'20');assert.equal(query(r,110,2).sqrtPriceX64,'30');assert.equal(query(r,120,1,'constructed-2').sqrtPriceX64,'30');assert.equal(query(r,121).sqrtPriceX64,'40');
});
test('consecutive missing writers create an explicit unanchored cell, without poisoning unqueried cells',()=>{
 const r=reference([writer(0,'10','20'),writer(1,null,null),writer(2,null,null),writer(3,'40','50')]);assert.equal(r.complete,true);assert.equal(query(r,115).status,'MISSING');assert.equal(query(r,105).sqrtPriceX64,'20');assert.equal(query(r,125).sqrtPriceX64,'40');assert.equal(query(reference([]),1).status,'MISSING');
});
test('admitted anchor disagreement and duplicate writer positions reject; same-TX queries use first.pre',()=>{
 assert.throws(()=>reference([writer(0,'10','20'),writer(1,'21','30')]),/CELL_CONFLICT/);assert.throws(()=>reference([writer(0,'10','20'),writer(0,'20','30')]),/WRITER_ORDER/);const w=writer(0,'10','90');w.possibleWriters=2;const r=reference([w]);assert.equal(query(r,100,1,w.signature).sqrtPriceX64,'10');assert.equal(query(r,100,2).sqrtPriceX64,'90');assert.equal(query(r,100,1,'wrong-signature').reasonCode,'A30_FX_QUERY_POSITION_CONFLICT');
});

test('two selected writes in one constructed TX require true first and final frame endpoints',()=>stateSource((source,cutoff,tx)=>{
 const ix=genuineSelected(tx),first=genuineEvent(tx),bytes=Buffer.from(first.slice(14),'base64');const firstPost=bytes.readBigUInt64LE(57)|(bytes.readBigUInt64LE(65)<<64n);bytes.writeBigUInt64LE(firstPost&((1n<<64n)-1n),41);bytes.writeBigUInt64LE(firstPost>>64n,49);bytes.writeBigUInt64LE((firstPost+1n)&((1n<<64n)-1n),57);bytes.writeBigUInt64LE((firstPost+1n)>>64n,65);const final='Program data: '+bytes.toString('base64');
 topOnly(tx,ix,first);tx.transaction.message.instructions.push({...ix,stackHeight:1});tx.meta.logMessages.push(`Program ${ORCA} invoke [1]`,final,`Program ${ORCA} success`);replaceNative(source,tx);const ref=buildA30FxReference(source,cutoff);assert.equal(ref.complete,true,ref.reasonCode);assert.equal(ref.writers[0]!.possibleWriters,2);assert.notEqual(ref.writers[0]!.first!.frame.order,ref.writers[0]!.last!.frame.order);assert.equal(ref.cells[0]!.sqrtPriceX64,ref.writers[0]!.first!.pre);assert.equal(ref.cells[1]!.sqrtPriceX64,(firstPost+1n).toString());
}));

test('complete source with no owner writes may retain one unqueried unanchored cell',()=>stateSource((source,cutoff,tx)=>{
 tx.transaction.message.instructions=[];tx.meta.innerInstructions=[];tx.meta.logMessages=[];replaceNative(source,tx);const ref=buildA30FxReference(source,cutoff);assert.equal(ref.complete,true,ref.reasonCode);assert.equal(ref.writers.length,0);assert.equal(ref.cells.length,1);assert.equal(ref.cells[0]!.status,'UNANCHORED');assert.equal(resolveA30FxState(ref,{slot:tx.slot,transactionIndex:tx.transactionIndex,signature:tx.transaction.signatures[0]}).status,'MISSING');
}));

test('unlogged precompile alignment stays unadmitted and supplied companion disagreements fail closed',()=>stateSource((source,cutoff,tx)=>{
 const ix=genuineSelected(tx),event=genuineEvent(tx),ed='Ed25519SigVerify111111111111111111111111111';topOnly(tx,ix,event);tx.transaction.message.instructions.unshift({programId:ed,accounts:[],data:'1'});tx.transaction.message.accountKeys.push({pubkey:ed,signer:false,writable:false,source:'transaction'});const r=structuredClone(source);replaceNative(r,tx);const unadmitted=buildA30FxReference(r,cutoff);assert.equal(unadmitted.complete,true,unadmitted.reasonCode);assert.equal(unadmitted.writers[0]!.first,null);assert.equal(unadmitted.coverage.unboundEventInvocations,1);
 const changed=structuredClone(source);changed.rawArtifacts['fx-head']=changed.rawArtifacts['fx-body-0']!;
 // Alter the supplied companion's fee only; exact whole-transaction parity must fail.
 const companion=JSON.parse(changed.rawArtifacts['fx-compiled-0']!);companion.result.meta.fee++;changed.rawArtifacts['fx-compiled-0']=JSON.stringify(companion);const mismatch=buildA30FxReference(changed,cutoff);assert.equal(mismatch.complete,false);assert.equal(mismatch.reasonCode,'A30_FX_STATE_COMPANION_PARITY');
}));
