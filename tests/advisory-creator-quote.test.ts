import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {join} from 'node:path';
import { createHash } from 'node:crypto';
import { decodeCreatorQuoteTrade,decodeCreatorQuoteAccounting,collectCreatorQuoteAccounting } from '../src/providers/advisory-creator-quote.js';
import { decodeCreatorRole } from '../src/providers/advisory-creator-role-collector.js';
import { creatorRolePageRequest,creatorRoleIndexRequest,creatorRoleTransactionRequest } from '../src/providers/advisory-creator-role.js';
import { SOLANA_MAINNET_GENESIS } from '../src/providers/solana.js';
import { collectLiveToken } from '../src/app/live.js';
import { starterProfile } from '../src/app/config.js';
import { Service } from '../src/app/service.js';
import { reconstructAdvisory } from '../src/app/advisory.js';
const f=JSON.parse(readFileSync('tests/fixtures/s15-native-quote-history.json','utf8')),role:any={quality:'KNOWN',binding:f.binding,reasonCode:'PUBLIC_CREATOR_ROLE_BINDING_VERIFIED',data:{}},token=f.token,cutoff='2026-10-19T17:00:00.000Z';
const rows=JSON.parse(f.raw.index).result as any[],successful=rows.filter(x=>x.err===null),tx=(s:string)=>JSON.parse(f.raw['tx-'+s]).result;
const sell=tx(successful[1].signature);
function roleReceipts(){const mint=token.address,wallet=f.binding.wallet,signature=f.binding.creation.signature,t=tx(signature);return{requests:{page:creatorRolePageRequest(mint),index:creatorRoleIndexRequest(wallet),'transaction-0':creatorRoleTransactionRequest(signature)},retrievedAt:{page:cutoff,index:cutoff,'transaction-0':cutoff},rawArtifacts:{page:JSON.stringify({results:[{url:`https://pump.fun/coin/${mint}`,final_url:`https://pump.fun/coin/${mint}`,text:'Creator\n\nFFdB…hfkF\n',links:[`https://pump.fun/profile/${wallet}`],published_date:'2026-10-11T11:16:33Z'}],errors:[]}),index:JSON.stringify({jsonrpc:'2.0',id:1,result:[{signature,slot:t.slot,blockTime:t.blockTime,err:null,confirmationStatus:'finalized'}]}),'transaction-0':f.raw['tx-'+signature]}};}
function packet(){const r:any={rawArtifacts:{genesis:JSON.stringify({jsonrpc:'2.0',id:1,result:SOLANA_MAINNET_GENESIS}),head:f.raw.head,index:f.raw.index},requests:{genesis:{method:'getGenesisHash',params:[]},head:f.requests.head,index:{method:'getSignaturesForAddress',params:[f.account,{limit:1000,commitment:'finalized',minContextSlot:JSON.parse(f.raw.head).result.context.slot}]}},retrievedAt:{genesis:cutoff,head:cutoff,index:cutoff}};for(const [i,row]of successful.entries()){r.rawArtifacts[`transaction-${i}`]=f.raw['tx-'+row.signature];r.requests[`transaction-${i}`]=creatorRoleTransactionRequest(row.signature);r.retrievedAt[`transaction-${i}`]=cutoff;}return r;}
test('actual routed holder-reward sell has exact native quote, included buyback and no doubled rewards or fabricated SOL',()=>{
 const e=decodeCreatorQuoteTrade(sell,role);assert.equal(e.side,'SELL');assert.equal(e.quote.mint,f.binding.creation.quoteMint);assert.equal(e.quote.decimals,6);assert.equal(e.quote.coreAtomic,'507390');assert.equal(e.quote.userAtomic,'501046');assert.equal(e.quote.transactionNetAtomic,'0');assert.equal(e.quote.routedFlowsOutsideTrade[0]!.amountAtomic,'501046');
 assert.deepEqual([e.fees.protocolAtomic,e.fees.buybackAtomic,e.fees.creatorAtomic,e.fees.holderRewardAtomic,e.fees.creatorFeeAttributedToSignerAtomic,e.fees.receivedHolderDistributionsAtomic],['2411','2410','1523','1523','0',null]);assert.equal(e.quote.solConversion,null);assert.equal(e.networkFee.includedInQuote,false);
});
test('all five actual routed sells decode; truncated initial buy does not acquire execution from balances',()=>{
 const trades=successful.map(r=>tx(r.signature)).filter(t=>!t.meta.logMessages.includes('Log truncated')&&t.transaction.message.instructions.some((x:any)=>!x.parsed&&x.programId.startsWith('J7pour'))).map(t=>decodeCreatorQuoteTrade(t,role));
 assert.equal(trades.length,5);assert.equal(trades.reduce((n,t)=>n+BigInt(t.base.unitsAtomic),0n),123909950351188n);
 assert.equal(trades.reduce((n,t)=>n+BigInt(t.quote.userAtomic),0n),3880224n);
 assert.throws(()=>decodeCreatorQuoteTrade(tx(f.binding.creation.signature),role),/LOG_INCOMPLETE/);
});
test('quote amount/program/owner, extra movement, runtime and holder recipient mutations never verify',()=>{
 const mutations:Array<(x:any)=>void>=[
  x=>x.meta.postTokenBalances.find((v:any)=>v.owner===f.binding.wallet&&v.mint===f.binding.creation.quoteMint).uiTokenAmount.amount='1',
  x=>x.meta.innerInstructions[0].instructions.find((i:any)=>i.parsed?.type==='transferChecked'&&i.parsed.info.mint===token.address).parsed.info.authority=f.account,
  x=>{x.meta.logMessages.splice(-1,1);},
  x=>x.meta.err={InstructionError:[0,'Custom']},
 ];
 for(const change of mutations){const x=structuredClone(sell);change(x);assert.throws(()=>decodeCreatorQuoteTrade(x,role));}
 const wrong=structuredClone(role);wrong.binding.creation.quoteMint=token.address;assert.throws(()=>decodeCreatorQuoteTrade(sell,wrong),/DENOMINATION/);
 const holder=structuredClone(role);holder.binding.creation.holderReward=false;assert.throws(()=>decodeCreatorQuoteTrade(sell,holder),/HOLDER_REWARD/);
});
test('canonical raw replay retains five verified sells, one unresolved buy and zero close without claiming creator-wide performance',()=>{
 const d=decodeCreatorQuoteAccounting(token,role,packet(),cutoff);assert.equal(d.coverage.indexComplete,true);assert.equal(d.coverage.closedZeroAccount,true);assert.equal(d.coverage.canonicalHeadAtomic,'0');assert.equal(d.records.length,5);assert.equal(d.coverage.unresolved.length,1);assert.equal(d.coverage.unresolved[0]!.signature,f.binding.creation.signature);assert.equal(d.completeCreatorPerformance,false);assert.equal(d.assets[0]!.realizedResultAtomic,null);assert.equal(d.assets[0]!.proceedsAtomic,'3880224');
 const bad=packet();bad.requests.index.params[1].minContextSlot++;assert.throws(()=>decodeCreatorQuoteAccounting(token,role,bad,cutoff),/ACCOUNTING_RECEIPT/);
 const missing=packet();missing.rawArtifacts['transaction-1']=JSON.stringify({jsonrpc:'2.0',id:1,result:null});assert.equal(decodeCreatorQuoteAccounting(token,role,missing,cutoff).coverage.unresolved.length,2);
 const extra=packet();extra.requests.orphan=extra.requests.genesis;extra.retrievedAt.orphan=cutoff;extra.rawArtifacts.orphan=extra.rawArtifacts.genesis;assert.throws(()=>decodeCreatorQuoteAccounting(token,role,extra,cutoff),/ACCOUNTING_RECEIPT/);
});
const fetcher=(calls:any[]=[],state={flight:0,max:0}):typeof fetch=>async(_input,init)=>{const request=JSON.parse(String(init?.body));calls.push(request);state.flight++;state.max=Math.max(state.max,state.flight);await new Promise(r=>setTimeout(r,1));try{let raw=request.method==='getGenesisHash'?JSON.stringify({jsonrpc:'2.0',id:1,result:SOLANA_MAINNET_GENESIS}):request.method==='getAccountInfo'?f.raw.head:request.method==='getSignaturesForAddress'?f.raw.index:f.raw['tx-'+request.params[0]];return new Response(raw);}finally{state.flight--;}};
test('bounded collector has two concurrent reads and exact offline replay; failed source prefixes remain unresolved',async()=>{
 const calls:any[]=[],state={flight:0,max:0},r=await collectCreatorQuoteAccounting(token,roleReceipts(),'https://rpc.example',fetcher(calls,state),()=>cutoff);
 assert.ok(r);assert.equal(calls.length,10);assert.equal(state.max,2);assert.equal(decodeCreatorQuoteAccounting(token,decodeCreatorRole(token,roleReceipts(),cutoff,true,true,true),r,cutoff).records.length,5);
 const failed=await collectCreatorQuoteAccounting(token,roleReceipts(),'https://rpc.example',async()=>new Response('{}',{status:429}),()=>cutoff);assert.ok(failed);assert.equal(Object.keys(failed.requests).length,1);assert.equal(decodeCreatorQuoteAccounting(token,role,failed,cutoff).reasonCode,'CREATOR_QUOTE_SOURCE_UNAVAILABLE');
});

function completeConstructedTrace(value:any){
 const x=structuredClone(value),groups=new Map(x.meta.innerInstructions.map((g:any)=>[g.index,g.instructions])),stack:string[]=[],logs:string[]=[];
 const add=(ix:any,depth:number)=>{while(stack.length>=depth)logs.push(`Program ${stack.pop()} success`);logs.push(`Program ${ix.programId} invoke [${depth}]`);stack.push(ix.programId);};
 for(const [i,ix]of x.transaction.message.instructions.entries()){add(ix,1);for(const child of groups.get(i) as any[]??[])add(child,child.stackHeight);}
 while(stack.length)logs.push(`Program ${stack.pop()} success`);x.meta.logMessages=logs;return x;
}
test('constructed complete runtime over actual buy instruction tests exact-quote native accounting, never repairs the actual truncated receipt',()=>{
 const synthetic=completeConstructedTrace(tx(f.binding.creation.signature)),e=decodeCreatorQuoteTrade(synthetic,role);
 assert.equal(e.side,'BUY');assert.equal(e.instruction,'buy_exact_quote_in_v2');assert.equal(e.base.unitsAtomic,'123909950351188');assert.equal(e.quote.mint,f.binding.creation.quoteMint);assert.equal(e.fees.creatorAtomic,e.fees.holderRewardAtomic);assert.equal(e.quote.transactionNetAtomic,'-4931006');assert.ok(e.quote.routedFlowsOutsideTrade.length>0);
 assert.throws(()=>decodeCreatorQuoteTrade(tx(f.binding.creation.signature),role),/LOG_INCOMPLETE/);
});
async function live(priorRole?:ReturnType<typeof roleReceipts>,completeWallet=false,extraRows=0,canonicalIndexUnavailable=false,helius=false,episode=false){
 const acquisition=JSON.parse(readFileSync('tests/fixtures/s15-quote-acquisition.json','utf8')),episodeCutoff=episode?'2026-10-23T23:00:00.000Z':cutoff;
 const original=roleReceipts(),base=fetcher(),extraTransactions=new Map<string,string>(),largePrior:any={requests:{},rawArtifacts:{},retrievedAt:{}},walletRows=JSON.parse(f.raw.index).result;
 for(let i=0;i<extraRows;i++){
  const bytes=createHash('sha512').update('coverage-large-'+i).digest(),alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=BigInt('0x'+bytes.toString('hex')),signature='';while(n){signature=alphabet[Number(n%58n)]+signature;n/=58n;}for(const byte of bytes){if(byte)break;signature='1'+signature;}
  const row={signature,slot:JSON.parse(f.raw.head).result.context.slot-1-i,blockTime:Date.parse(cutoff)/1000-100-i,err:null,confirmationStatus:'finalized'},system='11111111111111111111111111111111',keys=[{pubkey:f.binding.wallet,signer:true,writable:true,source:'transaction'},{pubkey:f.binding.creation.quoteMint,signer:false,writable:true,source:'transaction'},{pubkey:system,signer:false,writable:false,source:'transaction'}];
  const raw=JSON.stringify({jsonrpc:'2.0',id:1,result:{slot:row.slot,blockTime:row.blockTime,version:0,transaction:{signatures:[signature],message:{accountKeys:keys,instructions:[{programId:system,stackHeight:1,parsed:{type:'transfer',info:{source:f.binding.wallet,destination:f.binding.creation.quoteMint,lamports:1}}}]}},meta:{err:null,fee:5000,preBalances:[1000000,0,1],postBalances:[994999,1,1],preTokenBalances:[],postTokenBalances:[],innerInstructions:[],logMessages:[`Program ${system} invoke [1]`,`Program ${system} success`]}}});
  extraTransactions.set(signature,raw);largePrior.requests[signature]=creatorRoleTransactionRequest(signature);largePrior.rawArtifacts[signature]=raw;largePrior.retrievedAt[signature]=cutoff;walletRows.push(row);
 }
 if(episode)walletRows.push(JSON.parse(acquisition.index.raw).result[0]);
 walletRows.sort((a:any,b:any)=>b.slot-a.slot);

 const scripted:typeof fetch=async(input,init)=>{
  if(episode&&init?.method==='POST'){const request=JSON.parse(String(init.body));if(request.transactions?.[0]===acquisition.helius.request.body.transactions[0])return new Response(acquisition.helius.raw);if(request.method==='getBlock')return new Response(acquisition.block.raw);if(request.method==='getTransaction'&&request.params[0]===acquisition.transaction.request.params[0])return new Response(acquisition.transaction.raw);if(request.method==='getSignaturesForAddress'&&request.params[0]===acquisition.index.request.params[0])return new Response(acquisition.index.raw);}

  if(String(input).includes('/v1/parsed-events/transactions')){const sig=JSON.parse(String(init?.body)).transactions[0],h=JSON.parse(readFileSync('tests/fixtures/s15-helius-routes.json','utf8'));return new Response(h[sig].raw);}
  if(String(input)==='https://api.fetch.tinyfish.ai/'){assert.equal(priorRole,undefined,'A recorded birth-role replay must not fetch or retimestamp a page');return new Response(original.rawArtifacts.page);}
  if(init?.method==='POST'){
   const r=JSON.parse(String(init.body)),address=r.params?.[0];
   if(canonicalIndexUnavailable&&address===f.account&&r.method==='getSignaturesForAddress')return new Response(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:'RPC_HTTP_429'}}));
   if(canonicalIndexUnavailable&&address===f.account&&r.method==='getAccountInfo')return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{context:{slot:JSON.parse(f.raw.head).result.context.slot},value:{owner:f.binding.creation.tokenProgram,data:{parsed:{type:'account',info:{mint:token.address,owner:f.binding.wallet,tokenAmount:{amount:'0',decimals:6}}}}}}}));
   if(priorRole&&!canonicalIndexUnavailable&&r.method==='getTransaction'&&address===f.binding.creation.signature)assert.fail('Recorded immutable creation/buy receipt must preserve original bytes/clock without refetch');
   if(r.method==='getTransaction'||r.method==='getAccountInfo'&&address===f.account||r.method==='getSignaturesForAddress'&&address===f.account)return base(input,init);
   if(r.method==='getSignaturesForAddress'&&address===f.binding.wallet){if(!completeWallet||!r.params[1].minContextSlot)return new Response(original.rawArtifacts.index);const start=r.params[1].before?walletRows.findIndex((x:any)=>x.signature===r.params[1].before)+1:0;return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:walletRows.slice(start,start+1000)}));}
   const result=r.method==='getTokenAccountsByOwner'?{context:{slot:JSON.parse(f.raw.head).result.context.slot},value:[]}:r.method==='getGenesisHash'?SOLANA_MAINNET_GENESIS:r.method==='getSignaturesForAddress'?[]:r.method==='getSlot'?JSON.parse(f.raw.head).result.context.slot:r.method==='getBlockTime'?Date.parse(cutoff)/1000:r.method==='getAccountInfo'&&address===token.address?{context:{slot:JSON.parse(f.raw.head).result.context.slot},value:{owner:f.binding.creation.tokenProgram,executable:false,data:{parsed:{type:'mint',info:{mintAuthority:null,freezeAuthority:null,supply:'1000000000000000',decimals:6,isInitialized:true}}}}}:{context:{slot:1},value:null};
   return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result}));
  }
  return new Response(JSON.stringify(String(input).includes('/token-pairs/')?[]:{}));
 };
 return collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,...helius?{heliusKey:'TEST_HELIUS_SECRET'}:{},...priorRole?{creatorRolePrior:priorRole}:{tinyfishKey:'fake-secret'},...extraRows?{creatorCoveragePrior:largePrior}:{},fetcher:scripted,now:()=>episodeCutoff});
}
test('proof30 owns native accounting receipts and Service recomputes S15 evidence without promoting incomplete scope; rejects forgeries/downgrades',async()=>{
 const b=await live(),p=JSON.parse(b.rawArtifacts['advisory-derivation']!),s15=b.details!.advisory!.metrics.find(m=>m.id==='S15')!;
 assert.equal(p.method,'advisory-provenance-v33');assert.equal(Object.keys(p.creatorAccounting.requests).length,10);assert.equal(s15.quality,'MISSING');assert.equal(s15.reasonCode,'S15_COMPLETE_CREATOR_COVERAGE_REQUIRED');assert.equal((s15.data as any).nativeQuoteAccounting.records.length,6);
 const run=(x:typeof b,proof:any)=>reconstructAdvisory(token,cutoff,x.details!.baseline,x.evidence,x.rawArtifacts,proof,x.thesis??null,x.features);
 assert.deepEqual(run(b,p),b.details!.advisory);
 assert.throws(()=>run(b,{...p,method:'advisory-provenance-v28'}),/ADVISORY_PROOF_INVALID/);
 assert.throws(()=>run(b,{...p,creatorAccounting:null}),/ADVISORY_PROOF_INVALID/);
 const x=structuredClone(b),id=p.creatorAccounting.artifactIds.index;x.evidence.find(e=>e.id===id)!.contentHash='0'.repeat(64);assert.throws(()=>run(x,p),/ADVISORY_PROOF_INVALID/);
 const c=structuredClone(b);(c.details!.advisory!.metrics.find(m=>m.id==='S15')!.data as any).nativeQuoteAccounting.assets[0].proceedsAtomic='0';
 const directory=mkdtempSync(join(tmpdir(),'native-quote-live-'));
 try{const service=new Service(join(directory,'live.sqlite'));try{assert.throws(()=>service.analyzeLive(c),/ADVISORY_PROOF_INVALID/);const saved=service.analyzeLive(b);assert.deepEqual(service.replay(saved.id),saved);}finally{service.close();}}finally{rmSync(directory,{recursive:true,force:true});}
});

test('index/receipt/clock bounds fail closed and an unproven close cannot fabricate a zero head',async()=>{
 const bad=packet();bad.retrievedAt.head='2026-10-19T17:00:00.001Z';assert.throws(()=>decodeCreatorQuoteAccounting(token,role,bad,cutoff),/ACCOUNTING_RECEIPT/);
 const duplicate=packet(),index=JSON.parse(duplicate.rawArtifacts.index);index.result.push(index.result[0]);duplicate.rawArtifacts.index=JSON.stringify(index);assert.equal(decodeCreatorQuoteAccounting(token,role,{...duplicate,rawArtifacts:{genesis:duplicate.rawArtifacts.genesis,head:duplicate.rawArtifacts.head,index:duplicate.rawArtifacts.index},requests:{genesis:duplicate.requests.genesis,head:duplicate.requests.head,index:duplicate.requests.index},retrievedAt:{genesis:cutoff,head:cutoff,index:cutoff}},cutoff).coverage.indexComplete,false);
 const close=packet(),body=JSON.parse(close.rawArtifacts['transaction-0']);body.result.transaction.message.instructions.find((x:any)=>x.parsed?.info?.account===f.account).parsed.info.owner=token.address;close.rawArtifacts['transaction-0']=JSON.stringify(body);assert.equal(decodeCreatorQuoteAccounting(token,role,close,cutoff).coverage.canonicalHeadAtomic,null);
 let calls=0;const stop:typeof fetch=async(_input,init)=>{calls++;const r=JSON.parse(String(init?.body));return new Response(r.method==='getGenesisHash'?packet().rawArtifacts.genesis:r.method==='getAccountInfo'?f.raw.head:JSON.stringify({jsonrpc:'2.0',id:1,result:Array.from({length:65},(_,i)=>({...successful[1],signature:successful[i%successful.length].signature,slot:successful[1].slot-i}))}));};
 // A malformed65-row index is refused before transaction acquisition, rather than trusting count alone.
 const r=await collectCreatorQuoteAccounting(token,roleReceipts(),'https://rpc.example',stop,()=>cutoff);assert.ok(r);assert.equal(calls,3);assert.equal(Object.keys(r.requests).length,3);
});


test('explicit recorded birth-role replay revalidates original receipts/clocks and does not fetch a current creator page',async()=>{
 const prior=roleReceipts(),b=await live(prior),p=JSON.parse(b.rawArtifacts['advisory-derivation']!);assert.equal(b.details!.advisory!.metrics.find(m=>m.id==='S13')!.quality,'KNOWN');assert.equal(b.rawArtifacts[p.creatorRole.artifactIds.page],prior.rawArtifacts.page);assert.equal(b.evidence.find(e=>e.id===p.creatorRole.artifactIds.page)!.retrievedAt,prior.retrievedAt.page);
 const invalid=structuredClone(prior);invalid.retrievedAt.page='2026-10-20T19:00:00.000Z';const bad=await live(invalid);assert.equal(bad.details!.advisory!.metrics.find(m=>m.id==='S13')!.quality,'MISSING');assert.equal(JSON.parse(bad.rawArtifacts['advisory-derivation']!).creatorAccounting,null);
});


test('complete native creator source and payer-fee census remain distinct from complete economics; coverage provenance cannot be removed or forged',async()=>{
 const b=await live(roleReceipts(),true),p=JSON.parse(b.rawArtifacts['advisory-derivation']!),m=b.details!.advisory!.metrics.find(m=>m.id==='S15')!,data=m.data as any;
 assert.equal(data.nativeQuoteAccounting.canonicalContinuity.complete,true);assert.equal(data.creatorCoverage.wholeWalletComplete,true);assert.equal(data.creatorCoverage.sourceComplete,true);assert.equal(data.creatorCoverage.failedFees.payerCensusComplete,true);assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,'S15_NATIVE_ECONOMICS_UNRESOLVED');assert.equal(data.completeCreatorPerformance,false);
 const run=(x:typeof b,proof:any)=>reconstructAdvisory(token,cutoff,x.details!.baseline,x.evidence,x.rawArtifacts,proof,x.thesis??null,x.features);
 assert.throws(()=>run(b,{...p,method:'advisory-provenance-v29'}),/ADVISORY_PROOF_INVALID/);assert.throws(()=>run(b,{...p,creatorCoverage:null}),/ADVISORY_PROOF_INVALID/);
 const changed=structuredClone(b),id=p.creatorCoverage.artifactIds.genesis;changed.evidence.find(e=>e.id===id)!.contentHash='0'.repeat(64);assert.throws(()=>run(changed,p),/ADVISORY_PROOF_INVALID/);
});


test('constructed >1000 creator receipts persist and replay while the ordinary bundle count stays bounded',async()=>{
 const b=await live(roleReceipts(),true,1001),p=JSON.parse(b.rawArtifacts['advisory-derivation']!);assert.ok(b.evidence.length>1000);assert.ok(Object.keys(p.creatorCoverage.requests).length>1000);const c=(b.details!.advisory!.metrics.find(m=>m.id==='S15')!.data as any).creatorCoverage;assert.equal(c.sourceComplete,true);assert.equal(c.wholeWalletComplete,true);
 const directory=mkdtempSync(join(tmpdir(),'native-coverage-large-'));try{const service=new Service(join(directory,'live.sqlite'));try{const s=service.analyzeLive(b);assert.deepEqual(service.replay(s.id),s);const over=structuredClone(b),normal=b.evidence.find(e=>!e.id.startsWith('advisory-creatorCoverage-'))!;for(let i=0;i<1001;i++)over.evidence.push({...normal,id:'ordinary-extra-'+i});assert.throws(()=>service.analyzeLive(over),/BUNDLE_LIMIT/);}finally{service.close();}}finally{rmSync(directory,{recursive:true,force:true});}
});


test('proof30 reuses the recorded immutable creation/buy body with its old completion clock after a new canonical index',async()=>{
 const prior=roleReceipts();for(const k of Object.keys(prior.retrievedAt))prior.retrievedAt[k as keyof typeof prior.retrievedAt]='2026-10-19T16:00:00.000Z';const b=await live(prior,true),p=JSON.parse(b.rawArtifacts['advisory-derivation']!),key=Object.keys(p.creatorAccounting.requests).find(k=>p.creatorAccounting.requests[k].params?.[0]===f.binding.creation.signature)!,id=p.creatorAccounting.artifactIds[key];assert.equal(b.rawArtifacts[id],prior.rawArtifacts['transaction-0']);assert.equal(b.evidence.find(e=>e.id===id)!.retrievedAt,'2026-10-19T16:00:00.000Z');assert.equal((b.details!.advisory!.metrics.find(m=>m.id==='S15')!.data as any).nativeQuoteAccounting.coverage.unresolved.length,0);
});


test('borrowed immutable receipts respect the remaining native namespace byte reservation',async()=>{
 const prior=roleReceipts(),pad=(raw:string,size:number)=>{const v=JSON.parse(raw);v.padding='x'.repeat(size-Buffer.byteLength(JSON.stringify(v))-13);return JSON.stringify(v);};prior.rawArtifacts['transaction-0']=pad(prior.rawArtifacts['transaction-0'],480000);
 const index=JSON.parse(f.raw.index).result,extra:any[]=[];for(let i=0;i<7;i++){const bytes=createHash('sha512').update('native-budget-'+i).digest(),alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=BigInt('0x'+bytes.toString('hex')),signature='';while(n){signature=alphabet[Number(n%58n)]+signature;n/=58n;}for(const b of bytes){if(b)break;signature='1'+signature;}extra.push({...index[1],signature,slot:index[0].slot+1+i,blockTime:index[0].blockTime+1+i});}const rows=[...index,...extra].sort((a:any,b:any)=>b.slot-a.slot),bodyBySig=new Map(rows.map((row:any)=>{const t=JSON.parse(f.raw['tx-'+row.signature]??f.raw['tx-'+index[1].signature]);t.result.slot=row.slot;t.result.blockTime=row.blockTime;t.result.transaction.signatures[0]=row.signature;return[row.signature,pad(JSON.stringify(t),430000)];}));
 const scripted:typeof fetch=async(_input,init)=>{const r=JSON.parse(String(init?.body));return new Response(r.method==='getGenesisHash'?JSON.stringify({jsonrpc:'2.0',id:1,result:SOLANA_MAINNET_GENESIS}):r.method==='getAccountInfo'?f.raw.head:r.method==='getSignaturesForAddress'?JSON.stringify({jsonrpc:'2.0',id:1,result:rows}):bodyBySig.get(r.params[0]) as string);};
 const r=await collectCreatorQuoteAccounting(token,prior,'https://rpc.example',scripted,()=>cutoff,undefined,true);assert.ok(r);assert.ok(Object.values(r.rawArtifacts).reduce((n,x)=>n+Buffer.byteLength(x),0)<=6000000);assert.equal(JSON.parse(r.rawArtifacts['transaction-'+(rows.length-1)]!).error.code,'RPC_STORAGE_CAP');
});


test('native coverage admits bounded expanded audit details while ordinary and oversized details retain their limits',async()=>{
 const b=await live(roleReceipts(),true);b.details!.origins.constructedBoundaryPadding='x'.repeat(2_000_000);assert.ok(JSON.stringify(b.details).length>2_000_000);
 const directory=mkdtempSync(join(tmpdir(),'native-coverage-details-'));try{const service=new Service(join(directory,'live.sqlite'));try{const saved=service.analyzeLive(b);assert.deepEqual(service.replay(saved.id),saved);const over=structuredClone(b);over.details!.origins.constructedBoundaryPadding='x'.repeat(8_000_000);assert.throws(()=>service.analyzeLive(over),/INVALID_ASSESSMENT_DETAILS/);const ordinary=structuredClone(b),proof=JSON.parse(ordinary.rawArtifacts['advisory-derivation']!);proof.creatorCoverage=null;ordinary.rawArtifacts['advisory-derivation']=JSON.stringify(proof);ordinary.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=createHash('sha256').update(ordinary.rawArtifacts['advisory-derivation']!).digest('hex');assert.throws(()=>service.analyzeLive(ordinary),/INVALID_ASSESSMENT_DETAILS/);}finally{service.close();}}finally{rmSync(directory,{recursive:true,force:true});}
});


test('missing canonical index cannot report economics-only unresolved despite a complete independent wallet census',async()=>{
 const b=await live(roleReceipts(),true,0,true),p=JSON.parse(b.rawArtifacts['advisory-derivation']!),m=b.details!.advisory!.metrics.find(m=>m.id==='S15')!,data=m.data as any;
 assert.equal(data.nativeQuoteAccounting.coverage.indexComplete,false);assert.equal(data.nativeQuoteAccounting.coverage.unresolved.length,0);assert.equal(data.nativeQuoteAccounting.canonicalContinuity.complete,false);assert.equal(data.creatorCoverage.sourceComplete,true);assert.equal(data.creatorCoverage.wholeWalletComplete,true);assert.equal(data.creatorCoverage.failedFees.payerCensusComplete,true);assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,'S15_NATIVE_ACCOUNTING_EXECUTION_INCOMPLETE');
 assert.deepEqual(reconstructAdvisory(token,cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,p,b.thesis??null,b.features),b.details!.advisory);
 const directory=mkdtempSync(join(tmpdir(),'native-canonical-index-gap-'));try{const service=new Service(join(directory,'live.sqlite'));try{const saved=service.analyzeLive(b);assert.equal(saved.details!.advisory!.metrics.find(m=>m.id==='S15')!.reasonCode,'S15_NATIVE_ACCOUNTING_EXECUTION_INCOMPLETE');assert.deepEqual(service.replay(saved.id),saved);}finally{service.close();}}finally{rmSync(directory,{recursive:true,force:true});}
});


test('proof31 integrates Helius route ledger into S15, keeps unallocated costs separate and persists/replays exact raw-derived facts',async()=>{
 const b=await live(roleReceipts(),true,0,false,true),p=JSON.parse(b.rawArtifacts['advisory-derivation']!),m=b.details!.advisory!.metrics.find(m=>m.id==='S15')!,d=m.data as any;
 assert.equal(p.method,'advisory-provenance-v33');assert.equal(Object.keys(p.creatorRoutes.requests).length,7);assert.equal(d.nativeRouteAccounting.routeCoverageComplete,true);assert.equal(d.nativeRouteAccounting.ledger.grossSellSolLamports,'7571226605');assert.equal(d.nativeRouteAccounting.unallocatedCosts.creatorFailedFees.payerCensusComplete,true);assert.equal(d.completeCreatorPerformance,false);assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,'S15V2_ACQUISITION_INDEX');assert.equal(JSON.stringify(b).includes('TEST_HELIUS_SECRET'),false);
 const run=(x:typeof b,proof:any)=>reconstructAdvisory(token,cutoff,x.details!.baseline,x.evidence,x.rawArtifacts,proof,x.thesis??null,x.features);
 assert.deepEqual(run(b,p),b.details!.advisory);
 for(const mutate of [
  (x:typeof b,q:any)=>{q.creatorRoutes=null;},
  (x:typeof b,q:any)=>{q.method='advisory-provenance-v30';},
  (x:typeof b,q:any)=>{x.evidence.find(e=>e.id===q.creatorRoutes.artifactIds['transaction-1'])!.contentHash='0'.repeat(64);},
  (x:typeof b,q:any)=>{x.evidence.find(e=>e.id===q.creatorRoutes.artifactIds['transaction-1'])!.sourceId='advisory-creatorAccounting';},
  (x:typeof b,q:any)=>{q.creatorRoutes.requests['transaction-1'].query='api-key=forged';},
 ]){const x=structuredClone(b),q=structuredClone(p);mutate(x,q);assert.throws(()=>run(x,q),/ADVISORY_PROOF_INVALID|ADVISORY_CREATOR_ROUTES_RECEIPT/);}
 const directory=mkdtempSync(join(tmpdir(),'helius-routes-live-'));try{const service=new Service(join(directory,'live.sqlite'));try{const saved=service.analyzeLive(b);assert.deepEqual(service.replay(saved.id),saved);const forged=structuredClone(b);(forged.details!.advisory!.metrics.find(m=>m.id==='S15')!.data as any).nativeRouteAccounting.ledger.grossSellSolLamports='0';assert.throws(()=>service.analyzeLive(forged),/ADVISORY_PROOF_INVALID/);}finally{service.close();}}finally{rmSync(directory,{recursive:true,force:true});}
});


test('proof32 fresh S15 v2 production reconstruction persists/reopens exact principal result with separately reported costs; provenance and quality forgeries fail',async()=>{
 const b=await live(roleReceipts(),true,0,false,true,true),p=JSON.parse(b.rawArtifacts['advisory-derivation']!),m=b.details!.advisory!.metrics.find(m=>m.id==='S15')!,data=m.data as any;
 assert.equal(m.quality,'KNOWN',JSON.stringify(m));assert.equal(m.reasonCode,'S15V2_CLOSED_EPISODE_OBSERVED');assert.equal(data.closedTargetEpisode.method,'creator-only-closed-target-episode-v2');assert.equal(data.closedTargetEpisode.realized.resultLamports.numerator,'8801296488307315');assert.equal(data.closedTargetEpisode.aggregateNetProfit,null);assert.equal(Object.keys(p.creatorEpisode.requests).length,4);
 const replay=(x:typeof b,q:any)=>reconstructAdvisory(token,x.cutoff,x.details!.baseline,x.evidence,x.rawArtifacts,q,x.thesis??null,x.features);
 for(const mutate of [
 (x:typeof b,q:any)=>{q.method='advisory-provenance-v31';},
 (x:typeof b,q:any)=>{q.creatorEpisode=null;},
 (x:typeof b,q:any)=>{q.creatorEpisode.requests.block.params[0]++;},
 (x:typeof b,q:any)=>{x.evidence.find(e=>e.id===q.creatorEpisode.artifactIds.block)!.contentHash='0'.repeat(64);},
 (x:typeof b,q:any)=>{x.evidence.find(e=>e.id===q.creatorEpisode.artifactIds.helius)!.accessMode='PUBLIC_API';},
 (x:typeof b,q:any)=>{q.creatorEpisode.artifactIds.extra=q.creatorEpisode.artifactIds.block;},
 ]){const x=structuredClone(b),q=structuredClone(p);mutate(x,q);assert.throws(()=>replay(x,q),/ADVISORY_PROOF_INVALID|ADVISORY_CREATOR_EPISODE_RECEIPT/);}
 const dir=mkdtempSync(join(tmpdir(),'closed-target-episode-'));try{let id:string;let saved:any;const s=new Service(join(dir,'audit.sqlite'));try{saved=s.analyzeLive(b);id=saved.id;assert.deepEqual(s.replay(id),saved);const forged=structuredClone(b);(forged.details!.advisory!.metrics.find(m=>m.id==='S15')!.data as any).closedTargetEpisode.realized.resultLamports.numerator='1';assert.throws(()=>s.analyzeLive(forged),/ADVISORY_PROOF_INVALID/);}finally{s.close();}const reopened=new Service(join(dir,'audit.sqlite'));try{assert.deepEqual(reopened.replay(id!),saved);}finally{reopened.close();}}finally{rmSync(dir,{recursive:true,force:true});}
});
