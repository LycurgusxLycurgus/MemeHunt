import assert from 'node:assert/strict';
import test from 'node:test';
import { collectAdvisoryChain, decodeAdvisoryChain } from '../src/providers/advisory-chain.js';
import { encodeSolanaAddress, SOLANA_MAINNET_GENESIS } from '../src/providers/solana.js';
const token={chain:'solana' as const,address:'3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'};
const owner='11111111111111111111111111111111', account='So11111111111111111111111111111111111111112';
const at='2026-10-10T12:00:00.000Z', epoch=Date.parse(at)/1000;
const sig=(i=0)=>encodeSolanaAddress(Buffer.alloc(64,i+2));
const row=(i=0)=>({signature:sig(i),slot:100-i,blockTime:epoch-10-i,err:null,confirmationStatus:'finalized'});
const balance=(amount:string)=>({accountIndex:0,mint:token.address,owner,uiTokenAmount:{amount,decimals:6,uiAmount:0.000001,uiAmountString:'0.000001'}});
const tx=(i=0)=>({slot:100-i,blockTime:epoch-10-i,transaction:{signatures:[sig(i)],message:{accountKeys:[{pubkey:account},{pubkey:token.address}]}},meta:{err:null,preTokenBalances:[balance('10')],postTokenBalances:[balance('12')]}});
const reply=(result:unknown)=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,result}),{status:200});
function fetcher(pages:unknown[]= [row()], alter?:(v:any)=>unknown):typeof fetch {
 return async(_url,init)=>{const r=JSON.parse(String(init?.body));if(r.method==='getGenesisHash')return reply(SOLANA_MAINNET_GENESIS);if(r.method==='getSignaturesForAddress')return reply(pages);const i=Array.from({length:32},(_,i)=>sig(i)).indexOf(r.params[0]);const v=tx(i);return reply(alter?alter(v):v);};
}
test('bounded chain collector reconstructs exact atomic movements without trade or attribution claims',async()=>{
 const result=await collectAdvisoryChain(token,[token.address],'https://private.example?key=secret',fetcher(),()=>at);
 assert.equal(result.data.complete,true);assert.equal(result.data.sourceUniverseComplete,false);assert.equal(result.data.tradeCoverageComplete,false);
 assert.equal(result.data.movements[0]?.deltaAtomic,'2');assert.equal(result.data.movements[0]?.owner,owner);
 assert.deepEqual(decodeAdvisoryChain(token,[token.address],result.rawArtifacts,result.retrievedAt,result.requests),result.data);
 assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify(result).includes('private.example'));
});
test('chain history caps indexed signatures at32 and retained transactions at16 with batches of4',async()=>{
 let active=0,max=0,transactions=0;
 const underlying=fetcher(Array.from({length:32},(_,i)=>row(i)));
 const bounded:typeof fetch=async(url,init)=>{const req=JSON.parse(String(init?.body));if(req.method!=='getTransaction')return underlying(url,init);transactions++;active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,2));const response=await underlying(url,init);active--;return response;};
 const result=await collectAdvisoryChain(token,[token.address], 'https://rpc.example',bounded,()=>at);
 assert.equal(transactions,16);assert.ok(max<=4);assert.equal(result.data.transactions.length,16);assert.equal(result.data.complete,false);assert.equal(result.data.pages[0]?.status,'TRUNCATED');assert.equal(result.data.pages[0]?.exhausted,false);
});
test('invalid mainnet proof stops all address and transaction queries',async()=>{
 let calls=0;const result=await collectAdvisoryChain(token,[token.address],'https://rpc.example',async()=>{calls++;return reply('wronggenesis');},()=>at);
 assert.equal(calls,1);assert.equal(result.data.genesisVerified,false);assert.deepEqual(result.data.movements,[]);
});
test('future, malformed or duplicate signature listings retain receipts and fail closed',async()=>{
 for(const pages of [[{...row(),blockTime:epoch+1}],[{...row(),confirmationStatus:'confirmed'}],[row(),row()],[{...row(),signature:'invalid'}],[{...row(),slot:-1}]]){
 const result=await collectAdvisoryChain(token,[token.address],'https://rpc.example',fetcher(pages),()=>at);assert.equal(result.data.complete,false);assert.equal(result.data.pages[0]?.status,'INVALID');assert.ok(result.rawArtifacts['advisory-chain-page-0']);assert.equal(result.data.movements.length,0);
 }
});
test('transaction mismatches and conflicting or noninteger balances cannot become movements',async()=>{
 const mutations=[(v:any)=>({...v,slot:101}),(v:any)=>({...v,blockTime:epoch+1}),(v:any)=>({...v,transaction:{...v.transaction,signatures:[sig(1)]}}),(v:any)=>({...v,meta:{...v.meta,postTokenBalances:[balance('1.2')]}}),(v:any)=>({...v,meta:{...v.meta,postTokenBalances:[{...balance('12'),owner:account}]}}),(v:any)=>({...v,meta:{...v.meta,postTokenBalances:[balance('12'),balance('12')]}}),(v:any)=>({...v,meta:{...v.meta,postTokenBalances:[{...balance('12'),accountIndex:2}]}}),(v:any)=>({...v,meta:{...v.meta,postTokenBalances:[{...balance('12'),uiTokenAmount:{amount:'12',decimals:5}}]}})];
 for(const change of mutations){const result=await collectAdvisoryChain(token,[token.address],'https://rpc.example',fetcher([row()],change),()=>at);assert.equal(result.data.transactions[0]?.status,'INVALID');assert.equal(result.data.movements.length,0);assert.equal(result.data.complete,false);}
});
test('missing and failed transactions are explicit unavailable coverage',async()=>{
 const missing=await collectAdvisoryChain(token,[token.address],'https://rpc.example',fetcher([row()],()=>null),()=>at);assert.equal(missing.data.transactions[0]?.code,'TRANSACTION_NOT_AVAILABLE');assert.equal(missing.data.complete,false);
 const failed=await collectAdvisoryChain(token,[token.address],'https://rpc.example',fetcher([{...row(),err:{InstructionError:[0,'Custom']}}]),()=>at);assert.equal(failed.data.transactions[0]?.code,'TRANSACTION_FAILED');assert.equal(failed.data.complete,false);assert.ok(!Object.keys(failed.requests).some(x=>x.includes('transaction')));
});
test('transport failure remains bounded safe evidence without endpoint or error details',async()=>{
 const result=await collectAdvisoryChain(token,[token.address],'https://rpc.example?api-key=SECRET',async()=>{throw new Error('SECRET endpoint');},()=>at);
 assert.equal(result.data.complete,false);assert.equal(result.data.genesisVerified,false);assert.ok(!JSON.stringify(result).includes('SECRET'));assert.match(result.rawArtifacts['advisory-chain-genesis']!,/RPC_TRANSPORT/);
});
test('receipt request tampering and unsupported scope fail closed',async()=>{
 const result=await collectAdvisoryChain(token,[token.address],'https://rpc.example',fetcher(),()=>at);result.requests['advisory-chain-transaction-0']!.params[1]={commitment:'confirmed',encoding:'jsonParsed',maxSupportedTransactionVersion:0};
 const changed=decodeAdvisoryChain(token,[token.address],result.rawArtifacts,result.retrievedAt,result.requests);assert.equal(changed.transactions[0]?.status,'INVALID');assert.equal(changed.movements.length,0);
 await assert.rejects(()=>collectAdvisoryChain(token,[token.address,token.address],'https://rpc.example',fetcher(),()=>at),/ADVISORY_CHAIN_SCOPE/);
});

test('indexed addresses and retrieval chronology must match the returned transaction',async()=>{
 const outside=await collectAdvisoryChain(token,[token.address],'https://rpc.example',fetcher([row()],v=>({...v,transaction:{...v.transaction,message:{accountKeys:[{pubkey:account}]}}})),()=>at);
 assert.equal(outside.data.transactions[0]?.status,'INVALID');assert.equal(outside.data.movements.length,0);
 const result=await collectAdvisoryChain(token,[token.address],'https://rpc.example',fetcher(),()=>at);result.retrievedAt['advisory-chain-transaction-0']='2026-10-10T11:59:59.000Z';
 const changed=decodeAdvisoryChain(token,[token.address],result.rawArtifacts,result.retrievedAt,result.requests);assert.equal(changed.transactions[0]?.status,'INVALID');
});
