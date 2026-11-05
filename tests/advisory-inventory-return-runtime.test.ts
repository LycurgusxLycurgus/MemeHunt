import test from 'node:test';
import assert from 'node:assert/strict';
import {inventoryReturnsFixture} from './inventory-returns-fixtures.js';
import {recordedWindowInstructions} from '../src/providers/advisory-window-accounts.js';
import {assertInventoryReturnCompanionParity,getInventoryReturnExecution,requireInventoryReturnCriticalExecution,type InventoryReturnExecution} from '../src/providers/advisory-inventory-return-runtime.js';
const SYSTEM='11111111111111111111111111111111';
function fixture(){
 const f=inventoryReturnsFixture(),rows=f.records.filter((r:any)=>r.kind==='WINDOW'&&r.request.method==='getTransaction').map((r:any)=>({record:r,value:JSON.parse(r.raw).result})),companion=f.records.find((r:any)=>r.kind==='COMPILED_POOL'),compiled=JSON.parse(companion.raw).result;
 const context=(row:any)=>({expected:{signature:row.value.transaction.signatures[0],slot:row.value.slot,blockTime:row.value.blockTime,transactionIndex:row.value.transactionIndex},nativeSourceAt:row.record.retrievedAt,compiledSourceAt:companion.retrievedAt,cutoff:f.cutoff,endpoints:new Set<string>(f.accounts)});
 return{f,rows,companion,compiled,context};
}
test('genuine strict and compiled receipts preserve global order, native parsed steps and positive endpoint ancestry',()=>{
 const{rows,compiled,context}=fixture();for(const row of rows){const truncated=row.value.meta.logMessages.includes('Log truncated'),got=getInventoryReturnExecution(row.value,truncated?compiled:undefined,context(row));assert.equal(got.mode,truncated?'COMPILED_RECOVERY':'STRICT_NATIVE');assert.equal(got.list.length,recordedWindowInstructions(row.value).length);assert.ok(got.list.every((s,i)=>s.order===i));for(const s of got.list.filter(s=>s.criticalAccounts.length||s.lifecycleAccounts.length)){if(s.proof==='ROLLED_BACK')continue;let i=s.order;while(i>=0){assert.ok(['LOGGED_SUCCESS','COMMITTED'].includes(got.list[i]!.proof));i=got.list[i]!.parent;}}}
 const ephemeral=getInventoryReturnExecution(rows[2]!.value,compiled,context(rows[2]));assert.ok(ephemeral.list.some(s=>s.ix.parsed?.type==='create'&&s.compiledIx));assert.ok(ephemeral.list.some(s=>s.ix.parsed?.type==='transferChecked'&&s.ix.parsed.info.source===s.ix.parsed.info.destination));assert.ok(ephemeral.list.some(s=>s.ix.parsed?.type==='closeAccount'&&s.criticalAccounts.length));assert.throws(()=>getInventoryReturnExecution(rows[2]!.value,undefined,context(rows[2])),/O26_RUNTIME_(CRITICAL_EXECUTION|UNRELATED_UNKNOWN)/);
});
test('full companion parity rejects metadata, header, resolved flags, config, instruction and tree mutations',()=>{
 const{rows,compiled}=fixture(),native=rows[2]!.value;assert.doesNotThrow(()=>assertInventoryReturnCompanionParity(native,compiled));
 const mutations:Array<[string,(c:any)=>void]>=[['fee',(c:any)=>{c.meta.fee++;}],['header',(c:any)=>{c.transaction.message.header.numRequiredSignatures++;}],['config',(c:any)=>{c.transaction.message.transactionConfig={unsupported:true};}],['inner opcode',(c:any)=>{c.meta.innerInstructions[0].instructions[0].data='2';}],['invalid account index',(c:any)=>{c.transaction.message.instructions[0].accounts.push(999999);}]];
 for(const[label,mutate]of mutations){const c=structuredClone(compiled);mutate(c);assert.notDeepEqual(c,compiled,label+' must change source');assert.throws(()=>assertInventoryReturnCompanionParity(native,c),label);}
 const n=structuredClone(native);n.transaction.message.accountKeys[0].signer=false;assert.throws(()=>assertInventoryReturnCompanionParity(n,compiled));
 const c=structuredClone(compiled),nsteps=recordedWindowInstructions(native),rsteps=c.transaction.message.instructions.flatMap((ix:any,top:number)=>[{ix},...(c.meta.innerInstructions.find((g:any)=>g.index===top)?.instructions??[]).map((ix:any)=>({ix}))]),at=nsteps.findIndex(s=>s.ix.parsed?.type==='create');assert.ok(at>=0);rsteps[at]!.ix.data='2';assert.throws(()=>assertInventoryReturnCompanionParity(native,c),/COMPANION_INSTRUCTION/);
});
test('source identity, native clock and independent companion clock are mandatory',()=>{
 const{rows,compiled,context}=fixture(),row=rows[2]!,c=context(row);for(const bad of [{...c,nativeSourceAt:'2020-01-01T00:00:00Z'},{...c,compiledSourceAt:c.nativeSourceAt.replace('2026','2025')},{...c,compiledSourceAt:'2030-01-01T00:00:00Z'},{...c,expected:{...c.expected,transactionIndex:c.expected.transactionIndex+1}}])assert.throws(()=>getInventoryReturnExecution(row.value,compiled,bad));
});
test('critical own and caught ancestor UNKNOWN cannot become execution; rolled-back amounts remain zero',()=>{
 const{rows,compiled,context}=fixture(),row=rows[2]!,original=getInventoryReturnExecution(row.value,compiled,context(row)),critical=original.list.find(s=>s.criticalAccounts.length&&s.parent>=0)!;assert.ok(critical);
 for(const at of [critical.order,critical.parent]){const got=structuredClone(original);got.list[at]!.proof='UNKNOWN';got.list[at]!.executed=false;assert.throws(()=>requireInventoryReturnCriticalExecution(got,context(row).endpoints),/(CRITICAL_EXECUTION|UNRELATED_UNKNOWN)/);}
 const rollback=structuredClone(original);for(const s of rollback.list)if(s.criticalAccounts.length||s.lifecycleAccounts.length){s.proof='ROLLED_BACK';s.executed=false;}assert.doesNotThrow(()=>requireInventoryReturnCriticalExecution(rollback,context(row).endpoints));
});
test('UNKNOWN exclusion is exact scalar System transfer and disjoint from the entire endpoint roster',()=>{
 const a='2RukXtMqv6EAFFQppeaS1TfRmiXBEDgBeFBAnMPYkRsC',b='EDS3q3c6SUeN6ajXULWo5ZChzLenbC2A1NMT7K1xYHWX',ix={programId:SYSTEM,parsed:{type:'transfer',info:{source:a,destination:b,lamports:1}}};
 const e:InventoryReturnExecution={mode:'NATIVE_PREFIX',logged:0,truncated:true,list:[{ix,order:0,top:0,depth:1,parent:-1,position:-1,proof:'UNKNOWN',executed:false,references:[a,b],criticalAccounts:[],lifecycleAccounts:[]}]};assert.doesNotThrow(()=>requireInventoryReturnCriticalExecution(e,new Set()));assert.throws(()=>requireInventoryReturnCriticalExecution(e,new Set([b])),/CRITICAL_EXECUTION/);
 for(const change of [(s:any)=>{s.ix.programId='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';},(s:any)=>{s.ix.parsed.info.hiddenAccount=a;},(s:any)=>{s.ix.parsed.info.lamports=-1;}]){const bad=structuredClone(e);change(bad.list[0]);assert.throws(()=>requireInventoryReturnCriticalExecution(bad,new Set()),/UNRELATED_UNKNOWN/);}
});
test('constructed marker after a genuine fully closed trace preserves native-prefix proof without inferred execution',()=>{
 const{rows,context}=fixture(),row=rows[0]!,tx=structuredClone(row.value);tx.meta.logMessages.push('Log truncated');const got=getInventoryReturnExecution(tx,undefined,context(row));assert.equal(got.mode,'NATIVE_PREFIX');assert.ok(got.list.every(s=>s.proof==='LOGGED_SUCCESS'||s.proof==='ROLLED_BACK'));assert.equal(got.list.filter(s=>s.proof==='COMMITTED').length,0);
 const bad=structuredClone(tx);bad.meta.logMessages=['Log truncated'];assert.throws(()=>getInventoryReturnExecution(bad,undefined,context(row)));
});
