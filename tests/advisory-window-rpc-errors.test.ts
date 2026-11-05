// Constructed conformance only. Actual fresh C5 remains coverage/transaction-capped after this codec repair.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {collectAdvisoryWindow,decodeAdvisoryWindow,archiveAdvisoryWindowReceipts,unpackAdvisoryWindowReceipts,WINDOW_BUSY_REQUEST_CAP,WINDOW_BUSY_TRANSACTION_CAP,WINDOW_BUSY_STORED_BYTES,WINDOW_BUSY_SOURCE_BYTES} from '../src/providers/advisory-window.js';
import {encodeSolanaAddress} from '../src/providers/solana.js';
import {busyWindowFixture} from './window-busy-fixtures.js';

const documented=JSON.parse(readFileSync(new URL('../../tests/fixtures/solana-transaction-error-unit-v3.json',import.meta.url),'utf8')) as {unitVariants:string[];excludedPayloadVariants:string[]};
const RPC='https://rpc.invalid';
async function capture(unitErrorVariants=true,errors:unknown[]=['MaxLoadedAccountsDataSizeExceeded','BlockhashNotFound'],mutate?:(f:Awaited<ReturnType<typeof busyWindowFixture>>)=>void){
 const f=await busyWindowFixture(3);for(let i=0;i<errors.length;i++)(f.rows[3+i] as any).err=errors[i];mutate?.(f);
 const set=await collectAdvisoryWindow(f.token,f.pool,RPC,f.fetcher,()=>f.cutoff,f.end,undefined,undefined,true,true,true,true,true,true,true,true,unitErrorVariants);
 return{f,set};
}
function replay(f:Awaited<ReturnType<typeof busyWindowFixture>>,set:{rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;requests:Record<string,{method:string;params:unknown[]}>},unitErrorVariants=true){return decodeAdvisoryWindow(f.token,f.pool,f.end,set.rawArtifacts,set.retrievedAt,set.requests,f.cutoff,true,true,true,true,true,true,true,true,unitErrorVariants);}
function prefix(set:Awaited<ReturnType<typeof capture>>['set']){const keys=['window-genesis','window-anchor-slot','window-anchor-time','window-page-0'];return {rawArtifacts:Object.fromEntries(keys.map(k=>[k,set.rawArtifacts[k]!])),retrievedAt:Object.fromEntries(keys.map(k=>[k,set.retrievedAt[k]!])),requests:Object.fromEntries(keys.map(k=>[k,set.requests[k]!]))};}

test('explicit dense RPC unit codec retains failures without fetching them and preserves selected trade ABI/units/flow',async()=>{
 const old=await capture(false);assert.equal(old.set.data.complete,false);assert.equal(old.set.data.reasonCode,'ADVISORY_WINDOW_PAGE_SHAPE');assert.equal(old.f.calls.filter(c=>c.method==='getTransaction').length,0);
 const {f,set}=await capture();assert.deepEqual([set.data.complete,set.data.successfulSignatures,set.data.failedReferences,set.data.trades.length,set.data.sellQuoteAtomic],[true,3,2,3,'3000']);
 assert.equal(f.calls.filter(c=>c.method==='getTransaction').length,3);for(const failed of f.rows.slice(3,5))assert.ok(!f.calls.some(c=>c.method==='getTransaction'&&c.params[0]===failed.signature));
 const rows=JSON.parse(set.rawArtifacts['window-page-0']!).result;assert.equal(rows[3].err,'MaxLoadedAccountsDataSizeExceeded');assert.equal(rows[4].err,'BlockhashNotFound');assert.deepEqual(replay(f,set),set.data);
 const archived=archiveAdvisoryWindowReceipts(set,true,true);assert.deepEqual(unpackAdvisoryWindowReceipts(archived,true,true).rawArtifacts,set.rawArtifacts);
 const base=await capture(false,[{InstructionError:[0,'Custom']},{InstructionError:[1,'Custom']}]);assert.equal(base.set.data.complete,true);const {limitations:_,...result}=set.data,{limitations:__,...baseline}=base.set.data;assert.deepEqual(result,baseline);
 assert.equal(set.data.limitations.length,base.set.data.limitations.length+1);assert.match(set.data.limitations.find(text=>!base.set.data.limitations.includes(text))!,/unit TransactionError|solana-transaction-error3\.0\.0/);
 assert.deepEqual([WINDOW_BUSY_TRANSACTION_CAP,WINDOW_BUSY_REQUEST_CAP,WINDOW_BUSY_STORED_BYTES,WINDOW_BUSY_SOURCE_BYTES],[2048,2069,16_000_000,128_000_000]);
});

test('all35 documented unit names pass only the opt-in codec; payload names and unknown wire shapes fail closed',async()=>{
 const {f,set}=await capture();assert.equal(documented.unitVariants.length,35);assert.equal(new Set(documented.unitVariants).size,35);
 for(const variant of documented.unitVariants){const copy=structuredClone(set),p=JSON.parse(copy.rawArtifacts['window-page-0']!);p.result[3].err=variant;copy.rawArtifacts['window-page-0']=JSON.stringify(p);assert.equal(replay(f,copy).complete,true,variant);assert.equal(replay(f,copy).failedReferences,2);assert.equal(replay(f,prefix(copy),false).reasonCode,'ADVISORY_WINDOW_PAGE_SHAPE');}
 for(const invalid of ['', ' MaxLoadedAccountsDataSizeExceeded','MaxLoadedAccountsDataSizeExceeded ','maxloadedaccountsdatasizeexceeded','FutureUnknownError',...documented.excludedPayloadVariants,[],true,false,0,1]){const copy=prefix(set),p=JSON.parse(copy.rawArtifacts['window-page-0']!);p.result[3].err=invalid;copy.rawArtifacts['window-page-0']=JSON.stringify(p);const d=replay(f,copy);assert.equal(d.complete,false,JSON.stringify(invalid));assert.equal(d.reasonCode,'ADVISORY_WINDOW_PAGE_SHAPE');}
 const absent=prefix(set),p=JSON.parse(absent.rawArtifacts['window-page-0']!);delete p.result[3].err;absent.rawArtifacts['window-page-0']=JSON.stringify(p);assert.equal(replay(f,absent).reasonCode,'ADVISORY_WINDOW_PAGE_SHAPE');
});

test('unit failure at a full page terminal row keeps the exact next cursor and full failed count',async()=>{
 const f=await busyWindowFixture(3),first:any[]=f.rows.slice(0,3).map(r=>({...r})),slot=f.rows[0]!.slot+1,at=f.rows[0]!.blockTime;
 for(let i=0;i<997;i++){const bytes=Buffer.alloc(64,17);bytes.writeUInt32LE(10000+i);first.push({signature:encodeSolanaAddress(bytes),slot:slot-4-i,blockTime:at,err:i===996?'MaxLoadedAccountsDataSizeExceeded':{InstructionError:[0,'Custom']},confirmationStatus:'finalized'});}
 const witness={...f.rows.at(-1)!,slot:first.at(-1)!.slot-1},cursor=first.at(-1)!.signature;let pages=0;
 const fetcher:typeof fetch=async(input,init)=>{if(init?.method==='POST'){const q=JSON.parse(String(init.body));if(q.method==='getSignaturesForAddress'&&q.params[1].limit===1000){pages++;if(pages===1)assert.equal(q.params[1].before,undefined);else assert.equal(q.params[1].before,cursor);return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:pages===1?first:[witness]}));}}return f.fetcher(input,init);};
 const set=await collectAdvisoryWindow(f.token,f.pool,RPC,fetcher,()=>f.cutoff,f.end,undefined,undefined,true,true,true,true,true,true,true,true,true);assert.equal(pages,2);assert.equal((set.requests['window-page-1']!.params[1] as {before:string}).before,cursor);assert.deepEqual([set.data.complete,set.data.successfulSignatures,set.data.failedReferences,set.data.trades.length],[true,3,997,3]);assert.equal(f.calls.filter(c=>c.method==='getTransaction').length,3);
});

test('named errors do not bypass signature, slot/time order, future/null clocks or finalized status',async()=>{
 const mutations:Array<(f:Awaited<ReturnType<typeof busyWindowFixture>>)=>void>=[f=>{f.rows[3]!.signature=f.rows[0]!.signature;},f=>{f.rows[3]!.signature='garbage';},f=>{f.rows[3]!.slot=f.rows[0]!.slot+1;},f=>{f.rows[3]!.blockTime=Date.parse(f.cutoff)/1000+1;},f=>{(f.rows[3] as any).confirmationStatus='confirmed';},f=>{f.rows[3]!.blockTime=f.rows[2]!.blockTime+1;}];
 for(const mutate of mutations){const {f,set}=await capture(true,undefined,mutate);assert.equal(set.data.complete,false);assert.equal(f.calls.filter(c=>c.method==='getTransaction').length,0);}
 const n=await capture(true,undefined,f=>{(f.rows[3] as any).blockTime=null;});assert.equal(n.set.data.complete,false);assert.equal(n.f.calls.filter(c=>c.method==='getTransaction').length,0);
});

test('unit error opt-in requires the existing complete busy scope before reads; default is unchanged',async()=>{
 const f=await busyWindowFixture(3);assert.throws(()=>decodeAdvisoryWindow(f.token,f.pool,f.end,{},{},{},f.cutoff,true,true,true,true,true,true,true,false,true),/UNIT_ERROR_SCOPE/);
 await assert.rejects(collectAdvisoryWindow(f.token,f.pool,RPC,f.fetcher,()=>f.cutoff,f.end,undefined,undefined,true,true,true,true,true,true,true,false,true),/UNIT_ERROR_SCOPE/);assert.equal(f.calls.length,0);
 assert.throws(()=>decodeAdvisoryWindow(f.token,f.pool,f.end,{},{},{},f.cutoff,true,true,true,true,true,true,false,true,true),/BUSY_SCOPE/);
});
