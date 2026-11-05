import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeCreatorQuoteAccounting,type CreatorQuoteReceipts} from '../src/providers/advisory-creator-quote.js';
import {creatorRouteRequest,decodeCreatorRoutes,collectCreatorRoutes,type CreatorRouteReceipts,CREATOR_ROUTE_BYTES} from '../src/providers/advisory-creator-routes.js';
import {creatorRoleTransactionRequest} from '../src/providers/advisory-creator-role.js';
import {SOLANA_MAINNET_GENESIS} from '../src/providers/solana.js';
const f=JSON.parse(readFileSync('tests/fixtures/s15-native-quote-history.json','utf8')),h=JSON.parse(readFileSync('tests/fixtures/s15-helius-routes.json','utf8')),role:any={quality:'KNOWN',binding:f.binding,data:{},reasonCode:'RETAINED_PUBLIC_BINDING'},cutoff='2026-10-20T23:00:00.000Z';
function packets(){
 const rows=JSON.parse(f.raw.index).result.filter((x:any)=>x.err===null),canonical:CreatorQuoteReceipts={requests:{genesis:{method:'getGenesisHash',params:[]},head:f.requests.head,index:{method:'getSignaturesForAddress',params:[f.account,{limit:1000,commitment:'finalized',minContextSlot:JSON.parse(f.raw.head).result.context.slot}]}},rawArtifacts:{genesis:JSON.stringify({jsonrpc:'2.0',id:1,result:SOLANA_MAINNET_GENESIS}),head:f.raw.head,index:f.raw.index},retrievedAt:{genesis:cutoff,head:cutoff,index:cutoff}},routes:CreatorRouteReceipts={requests:{},rawArtifacts:{},retrievedAt:{}};
 for(const [i,row]of rows.entries()){const k='transaction-'+i;canonical.requests[k]=creatorRoleTransactionRequest(row.signature);canonical.rawArtifacts[k]=f.raw['tx-'+row.signature];canonical.retrievedAt[k]=cutoff;routes.requests[k]=creatorRouteRequest(row.signature);routes.rawArtifacts[k]=h[row.signature].raw;routes.retrievedAt[k]=h[row.signature].retrievedAt;}
 const accounting=decodeCreatorQuoteAccounting(f.token,role,canonical,cutoff,true);
 return{canonical,routes,accounting,rows};
}
function decode(p=packets()){return decodeCreatorRoutes(role,p.accounting,p.canonical,p.routes,cutoff);}
test('actual seven Helius packets reconcile production native ledger; gross, net, funding/refunds and unallocated payments stay distinct',()=>{
 const d=decode();assert.equal(d.canonicalComplete,true);assert.equal(d.records.length,7);assert.deepEqual(d.unresolved,[]);
 assert.deepEqual(d.ledger,{quoteMint:f.binding.creation.quoteMint,buyQuoteAtomic:'2040452',soldTargetAtomic:'123909950351188',acquiredTargetAtomic:'123909950351188',grossSellSolLamports:'7571226605',sellWalletNetSolLamports:'7467311275',directTradeNetworkFeeLamports:'535000',temporaryRentOutLamports:'7442200',temporaryRentReturnedLamports:'7442200'});
 assert.equal(d.unallocatedCosts.extraBuyQuotePaymentsAtomic,'2890554');assert.equal(d.unallocatedCosts.accountFunding.length,6);assert.equal(d.unallocatedCosts.accountRefunds.length,13);assert.equal(d.unallocatedCosts.accountRefunds.reduce((n,x)=>n+BigInt(x.lamports),0n),19771360n);
 const close=d.records.find(r=>r.side==='CLOSE')!;assert.equal(close.creatorNetworkFeeLamports,'0');assert.equal(close.networkFeeLamports,'51826');assert.equal(close.walletNativeDeltaLamports,'20999701');assert.equal(close.directNativePaymentsLamports,'285499');assert.equal(close.refunds.find(r=>r.account===f.account)!.lamports,'1513840');
 assert.equal(d.records[0]!.executionBasis,'POSITIVE_COMMITTED_TRANSFER_BALANCES_WITH_BOUND_TRUNCATED_TRACE');assert.equal(d.records.reduce((n,x)=>n+x.nativeAccountsReconciled,0),373);assert.equal(d.records.reduce((n,x)=>n+x.tokenAccountsReconciled,0),95);assert.equal(d.realizedProfit,null);assert.equal(d.verifiedHistoricalConversion,null);assert.equal(d.completeCreatorPerformance,false);
});
const mutations:Record<string,(h:any)=>void>={
 'signature':(h:any)=>h.signature=f.account,
 'parser':(h:any)=>h.parserStatus='FAILED',
 'raw fee':(h:any)=>h.rawTransaction.meta.fee++,
 'raw log':(h:any)=>h.rawTransaction.meta.logMessages.pop(),
 'raw account':(h:any)=>h.rawTransaction.transaction.message.accountKeys.reverse(),
 'provider amount':(h:any)=>h.parsed.tokenTransfers[0].rawTokenAmount++,
 'extra transfer':(h:any)=>h.parsed.tokenTransfers.push(h.parsed.tokenTransfers[0]),
 'native amount':(h:any)=>h.parsed.nativeTransfers[0].amount++,
 'frame':(h:any)=>h.parsed.instructions[0].instructionIndex++,
 'raw instruction':(h:any)=>h.rawTransaction.transaction.message.instructions[0].data='1',
 'raydium label':(h:any)=>h.parsed.instructions.find((x:any)=>x.programId.startsWith('CAMMC')).instructionName='unknown',
 'raydium argument':(h:any)=>h.parsed.instructions.find((x:any)=>x.programId.startsWith('CAMMC')).decoded.args.amount='0',
};
for(const [name,mutate]of Object.entries(mutations))test('source mutation cannot certify route: '+name,()=>{
 const p=packets(),id='transaction-1',value=JSON.parse(p.routes.rawArtifacts[id]!);mutate(value[0]);p.routes.rawArtifacts[id]=JSON.stringify(value);const d=decode(p);assert.equal(d.canonicalComplete,false);assert.equal(d.verifiedTransactions,6);assert.equal(d.unresolved.length,1);
});
test('missing/failed source and unsupported raw route preserve partial evidence without known zero',()=>{
 for(const mode of ['missing','remote','unknown']){const p=packets(),id='transaction-1';if(mode==='missing'){delete p.routes.requests[id];delete p.routes.retrievedAt[id];delete p.routes.rawArtifacts[id];}else if(mode==='remote')p.routes.rawArtifacts[id]='{"error":{"code":"HELIUS_ROUTE_SOURCE_UNAVAILABLE"}}';else{const v=JSON.parse(p.routes.rawArtifacts[id]!);v[0].parsed.transactionStatus='FAILED';p.routes.rawArtifacts[id]=JSON.stringify(v);}const d=decode(p);assert.equal(d.canonicalComplete,false);assert.equal(d.unresolved.length,1);assert.equal(d.verifiedTransactions,6);}
 const p=packets();p.accounting.canonicalContinuity!.complete=false;assert.equal(decode(p).canonicalComplete,false);
});
test('exact namespace/request/clock/response and aggregate bounds reject forged provenance',()=>{
 const changes:Array<(p:ReturnType<typeof packets>)=>void>=[
 p=>p.routes.requests['transaction-1']!.body.commitment='confirmed',
 p=>p.routes.retrievedAt['transaction-1']='2026-10-21T00:00:00.000Z',
 p=>p.routes.retrievedAt['transaction-1']='2026-10-10T00:00:00.000Z',
 p=>p.routes.rawArtifacts['transaction-1']=' '.repeat(500001),
 p=>{p.routes.requests.orphan=p.routes.requests['transaction-1']!;p.routes.rawArtifacts.orphan=p.routes.rawArtifacts['transaction-1']!;p.routes.retrievedAt.orphan=cutoff;},
 p=>{delete p.routes.rawArtifacts['transaction-1'];},
 p=>p.routes.rawArtifacts['transaction-1']=' '.repeat(CREATOR_ROUTE_BYTES+1),
 ];for(const change of changes){const p=packets();change(p);assert.throws(()=>decode(p),/ADVISORY_CREATOR_ROUTES_RECEIPT/);}
});
test('free API collector uses finalized exact signatures, bounded reads and sanitized authentication metadata',async()=>{
 const p=packets(),secret='TEST_HELIUS_SECRET',calls:any[]=[];const fetcher:typeof fetch=async(url,init)=>{assert.ok(String(url).endsWith('?api-key='+secret));const body=JSON.parse(String(init?.body));calls.push(body);return new Response(h[body.transactions[0]].raw);};
 const r=await collectCreatorRoutes(p.accounting,p.canonical,secret,fetcher,()=>cutoff);assert.equal(calls.length,7);assert.equal(JSON.stringify(r).includes(secret),false);assert.equal(decodeCreatorRoutes(role,p.accounting,p.canonical,r,cutoff).canonicalComplete,true);
 let count=0;assert.deepEqual(await collectCreatorRoutes(p.accounting,p.canonical,'',async()=>{count++;throw Error();}),{requests:{},rawArtifacts:{},retrievedAt:{}});assert.equal(count,0);
});
test('collector never retains reflected secrets or error URLs; cancellation and partial budgets stay bounded',async()=>{
 const p=packets(),secret='TEST_HELIUS_SECRET';for(const mode of ['reflection','error','large']){const r=await collectCreatorRoutes(p.accounting,p.canonical,secret,async()=>{if(mode==='error')throw Error('https://provider?api-key='+secret);return new Response(mode==='reflection'?secret:'x'.repeat(500001));},()=>cutoff);assert.equal(JSON.stringify(r).includes(secret),false);assert.equal(decodeCreatorRoutes(role,p.accounting,p.canonical,r,cutoff).verifiedTransactions,0);}
 const c=new AbortController();c.abort();await assert.rejects(collectCreatorRoutes(p.accounting,p.canonical,secret,async()=>new Response(),()=>cutoff,c.signal));
});
