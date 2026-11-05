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


test('historical read-only RPCs recover bounded HTTP429 gaps before retaining canonical receipts',async()=>{
 const underlying=fetcher(),attempts=new Map<string,number>();
 const intermittent:typeof fetch=async(url,init)=>{const request=JSON.parse(String(init?.body));const method=request.method;attempts.set(method,(attempts.get(method)??0)+1);
  if(['getSignaturesForAddress','getTransaction'].includes(method)&&attempts.get(method)===1)return new Response('rate limited',{status:429,headers:{'retry-after':'0'}});
  return underlying(url,init);
 };
 const collected=await collectAdvisoryChain(token,[token.address],'https://rpc.example',intermittent,()=>at);
 assert.equal(attempts.get('getSignaturesForAddress'),2);assert.equal(attempts.get('getTransaction'),2);
 assert.equal(collected.data.transactions[0]?.status,'OBSERVED');assert.equal(collected.data.movements[0]?.deltaAtomic,'2');
 assert.deepEqual(decodeAdvisoryChain(token,[token.address],collected.rawArtifacts,collected.retrievedAt,collected.requests),collected.data);
});

test('legacy collection keeps its original one-page and version-0 transaction requests',async()=>{
 const requests:Array<{method:string;params:any[]}>=[],underlying=fetcher();
 const recording:typeof fetch=async(url,init)=>{const request=JSON.parse(String(init?.body));requests.push(request);return underlying(url,init);};
 const result=await collectAdvisoryChain(token,[token.address],'https://rpc.example',recording,()=>at);
 assert.deepEqual(requests.map(r=>r.method),['getGenesisHash','getSignaturesForAddress','getTransaction']);
 assert.deepEqual(requests[1]!.params,[token.address,{commitment:'finalized',limit:32}]);
 assert.deepEqual(requests[2]!.params,[sig(),{commitment:'finalized',encoding:'jsonParsed',maxSupportedTransactionVersion:0}]);
 assert.equal(result.data.method,'solana-bounded-movements-v1');
 assert.deepEqual(decodeAdvisoryChain(token,[token.address],result.rawArtifacts,result.retrievedAt,result.requests),result.data);
});

test('expanded collection follows three exact cursors per address and prioritizes successful pool references within 32 v1 reads',async()=>{
 const pool=encodeSolanaAddress(Buffer.alloc(32,33)),addresses=[token.address,pool];
 const rowsByAddress:any[][]=[Array.from({length:96},(_,i)=>({...row(i),slot:1000-i})),Array.from({length:96},(_,i)=>({...row(i+64),slot:936-i}))];
 rowsByAddress[0]![64]!.err={InstructionError:[0,'Custom']};
 rowsByAddress[1]![0]!.err=rowsByAddress[0]![64]!.err;
 const requests:Array<{method:string;params:any[]}>=[],transactions:string[]=[];
 const expandedFetcher:typeof fetch=async(_url,init)=>{
  const req=JSON.parse(String(init?.body));requests.push(req);let result:unknown;
  if(req.method==='getGenesisHash')result=SOLANA_MAINNET_GENESIS;
  else if(req.method==='getSignaturesForAddress'){
   const addressIndex=addresses.indexOf(req.params[0]),before=req.params[1].before;
   const index=before===undefined?0:rowsByAddress[addressIndex]!.findIndex(r=>r.signature===before)+1;
   result=rowsByAddress[addressIndex]!.slice(index,index+32);
  }else{
   const signature=req.params[0] as string;transactions.push(signature);
   const index=Array.from({length:160},(_,i)=>sig(i)).indexOf(signature);
   result={...tx(index),slot:1000-index,version:1,transaction:{signatures:[signature],message:{accountKeys:[{pubkey:addresses[0]},{pubkey:addresses[1]},{pubkey:account}] }},meta:{err:null,preTokenBalances:[],postTokenBalances:[]}};
  }
  return reply(result);
 };
 const result=await collectAdvisoryChain(token,addresses,'https://rpc.example',expandedFetcher,()=>at,undefined,true);
 assert.deepEqual(requests.filter(r=>r.method==='getSignaturesForAddress').map(r=>r.params[1]),[
  {commitment:'finalized',limit:32},{commitment:'finalized',limit:32,before:sig(31)},{commitment:'finalized',limit:32,before:sig(63)},
  {commitment:'finalized',limit:32},{commitment:'finalized',limit:32,before:sig(95)},{commitment:'finalized',limit:32,before:sig(127)},
 ]);
 assert.equal(transactions.length,32);
 assert.ok(transactions.every(s=>rowsByAddress[1]!.some(r=>r.signature===s&&r.err===null)));
 assert.ok(!transactions.includes(sig(64)),'failed pool-referenced row is excluded before prioritization');
 assert.ok(requests.filter(r=>r.method==='getTransaction').every(r=>r.params[1].encoding==='jsonParsed'&&r.params[1].maxSupportedTransactionVersion===1));
 assert.equal(result.data.method,'solana-paginated-movements-v2');assert.equal(result.data.transactions.length,32);
 assert.equal(result.data.pages.length,6);assert.ok(result.data.pages.every(p=>p.returned===32&&p.status==='TRUNCATED'&&!p.exhausted));
 assert.equal(result.data.complete,false);assert.equal(result.data.sourceUniverseComplete,false);
 assert.deepEqual(decodeAdvisoryChain(token,addresses,result.rawArtifacts,result.retrievedAt,result.requests,true),result.data);
});

test('expanded decoder rejects cursor tampering, overlapping pages, backwards page clocks and unknown transaction versions',async()=>{
 const pool=encodeSolanaAddress(Buffer.alloc(32,34)),addresses=[token.address,pool];
 const pages=[Array.from({length:32},(_,i)=>({...row(i),slot:300-i})),Array.from({length:32},(_,i)=>({...row(i+32),slot:268-i}))];
 const expandedFetcher:typeof fetch=async(_url,init)=>{const req=JSON.parse(String(init?.body));let result:unknown;
  if(req.method==='getGenesisHash')result=SOLANA_MAINNET_GENESIS;
  else if(req.method==='getSignaturesForAddress'){
   if(req.params[0]===pool)return reply([]);
   const start=req.params[1].before===undefined?0:32;result=pages[start===0?0:1];
  }else result={...tx(0),version:2,transaction:{...tx(0).transaction,signatures:[req.params[0]],message:{accountKeys:[{pubkey:token.address},{pubkey:pool},{pubkey:account}]}}};
  return reply(result);
 };
 const collected=await collectAdvisoryChain(token,addresses,'https://rpc.example',expandedFetcher,()=>at,undefined,true);
 assert.equal(collected.data.transactions[0]?.status,'INVALID');assert.equal(collected.data.transactions[0]?.code,'ADVISORY_CHAIN_TRANSACTION_INVALID');
 assert.equal(collected.data.movements.length,0);assert.equal(collected.data.complete,false);

 const changedCursor=structuredClone(collected);changedCursor.requests['advisory-chain-page-0-1']!.params[1]={commitment:'finalized',limit:32,before:sig(2)};
 const cursorResult=decodeAdvisoryChain(token,addresses,changedCursor.rawArtifacts,changedCursor.retrievedAt,changedCursor.requests,true);
 assert.equal(cursorResult.pages.find(p=>p.address===token.address&&p.returned===0)?.status,'INVALID');assert.equal(cursorResult.complete,false);

 const overlap=structuredClone(collected),overlapPage=JSON.parse(overlap.rawArtifacts['advisory-chain-page-0-1']!);
 overlapPage.result[0]=pages[0]![0];overlap.rawArtifacts['advisory-chain-page-0-1']=JSON.stringify(overlapPage);
 const overlapResult=decodeAdvisoryChain(token,addresses,overlap.rawArtifacts,overlap.retrievedAt,overlap.requests,true);
 assert.equal(overlapResult.pages.find(p=>p.address===token.address&&p.returned===0)?.status,'INVALID');assert.equal(overlapResult.complete,false);

 const backwards=structuredClone(collected);backwards.retrievedAt['advisory-chain-page-0-1']='2026-10-10T11:59:59.000Z';
 const clockResult=decodeAdvisoryChain(token,addresses,backwards.rawArtifacts,backwards.retrievedAt,backwards.requests,true);
 assert.equal(clockResult.pages.find(p=>p.address===token.address&&p.returned===0)?.status,'INVALID');assert.equal(clockResult.complete,false);
});

test('expanded page RPC errors remain explicit unavailable coverage and never claim complete retention',async()=>{
 const full=Array.from({length:32},(_,i)=>({...row(i),slot:500-i}));let pageCalls=0,transactionCalls=0;
 const failing:typeof fetch=async(_url,init)=>{const req=JSON.parse(String(init?.body));if(req.method==='getGenesisHash')return reply(SOLANA_MAINNET_GENESIS);if(req.method==='getSignaturesForAddress'){pageCalls++;if(pageCalls===1)return reply(full);return new Response(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32005,message:'provider limit'}}));}
  transactionCalls++;const indexed=full.find(r=>r.signature===req.params[0])!;return reply({slot:indexed.slot,blockTime:indexed.blockTime,version:1,transaction:{signatures:[indexed.signature],message:{accountKeys:[{pubkey:token.address}]}},meta:{err:null,preTokenBalances:[],postTokenBalances:[]}});
 };
 const result=await collectAdvisoryChain(token,[token.address],'https://rpc.example',failing,()=>at,undefined,true);
 assert.equal(pageCalls,2);assert.equal(result.data.pages[0]?.status,'TRUNCATED');assert.equal(result.data.pages[1]?.status,'UNAVAILABLE');
 assert.equal(result.data.pages[1]?.code,'RPC_REMOTE_-32005');assert.equal(transactionCalls,32);assert.ok(result.data.transactions.every(t=>t.status==='OBSERVED'));
 assert.equal(result.data.complete,false);assert.ok(!result.data.sourceUniverseComplete);
 assert.ok(result.rawArtifacts['advisory-chain-page-0-1']);
});
