import assert from 'node:assert/strict';
import test from 'node:test';
import { collectAdvisoryChain, type ChainHistory } from '../src/providers/advisory-chain.js';
import { collectAdvisoryWalletHistory, decodeAdvisoryWalletHistory, deriveWalletHistoryMetrics } from '../src/providers/advisory-wallet-history.js';
import type { TradeHistory } from '../src/providers/advisory-trades.js';
import { encodeSolanaAddress, SOLANA_MAINNET_GENESIS } from '../src/providers/solana.js';

const token={chain:'solana' as const,address:'3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'};
const cutoff='2026-10-11T12:00:00.000Z',cutoffSeconds=Date.parse(cutoff)/1000;
const sig=(i=0)=>encodeSolanaAddress(Buffer.alloc(64,i+2));
const wallet=(i:number)=>encodeSolanaAddress(Buffer.alloc(32,i));
const wallets=[wallet(8),wallet(9),wallet(10)],pool=wallet(20),coSigner=wallet(21);
const row=(signature:string,slot:number,blockTime:number)=>({signature,slot,blockTime,err:null,confirmationStatus:'finalized'});

function tradeHistory(users:string[],poolVerified=true):TradeHistory{
 const trades=users.map((user,i)=>({signature:sig(500+i),slot:500-i,at:new Date((cutoffSeconds-(i+1)*60)*1000).toISOString(),user,side:'BUY' as const,baseAtomic:'10',quoteAtomic:'100',poolBaseReservesAtomic:'1000',poolQuoteReservesAtomic:'10000',instructionIndex:0}));
 return{method:'pumpswap-decoded-sample-v1',token,pool,quoteMint:wallet(30),quoteDecimals:9,poolVerified,stateSlot:1000,trades,buyQuoteAtomic:'100',sellQuoteAtomic:'0',netQuoteAtomic:'100',coveredInterval:null,sourceUniverseComplete:false,complete:false,transactionsInspected:trades.length,transactionsExcluded:0,excluded:[],limitations:[]};
}

function walletRows(start:number,count:number,slotStart:number,hoursAgo:(index:number)=>number){
 return Array.from({length:count},(_,i)=>row(sig(1000+start+i),slotStart-i,cutoffSeconds-hoursAgo(i)*3600));
}
function rpcHarness(pageMap:Record<string,unknown[][]>,genesis:string=SOLANA_MAINNET_GENESIS,floor:number=123){
 const calls:Array<{method:string;params:unknown[]}>=[],pageIndex=new Map<string,number>();let nowValue=Date.parse('2026-10-11T11:59:00.000Z');
 const now=()=>new Date(nowValue+=1000).toISOString();
 const fetcher:typeof fetch=async(_url,init)=>{
  const request=JSON.parse(String(init?.body)) as {method:string;params:unknown[]};calls.push(request);let result:unknown;
  if(request.method==='getGenesisHash')result=genesis;
  else if(request.method==='getFirstAvailableBlock')result=floor;
  else if(request.method==='getSignaturesForAddress'){
   const address=String(request.params[0]),index=pageIndex.get(address)??0;pageIndex.set(address,index+1);result=pageMap[address]?.[index]??[];
  }else throw new Error(`unexpected wallet-history RPC ${request.method}`);
  return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result}));
 };
 return{fetcher,now,calls};
}

test('wallet-reference sampling selects two sorted trader wallets, caps retention, and leaves age/exposure unresolved',async()=>{
 const ordered=[...wallets].sort(),history=tradeHistory([wallets[2]!,wallets[1]!,wallets[0]!,wallets[0]!]);
 const pages:Record<string,unknown[][]>={
  [ordered[0]!]:[walletRows(0,32,500,i=>i+1),walletRows(32,32,468,i=>i+33)],
  [ordered[1]!]:[walletRows(200,3,300,i=>i+1)],
 };
 const harness=rpcHarness(pages),receipts=await collectAdvisoryWalletHistory(history,'https://rpc.example',harness.fetcher,harness.now);
 const lookups=harness.calls.filter(call=>call.method==='getSignaturesForAddress');
 assert.deepEqual(lookups.map(call=>call.params[0]),[ordered[0],ordered[0],ordered[1]]);
 assert.deepEqual(receipts.requests['wallet-page-0-1']!.params,[ordered[0],{commitment:'finalized',limit:32,before:sig(1031)}]);
 assert.equal(receipts.requests['wallet-page-1-1'],undefined);
 assert.equal(receipts.requests['wallet-page-2-0'],undefined);
 assert.equal(receipts.requests['wallet-genesis']!.method,'getGenesisHash');
 assert.equal(receipts.requests['wallet-ledger-floor']!.method,'getFirstAvailableBlock');

 const decoded=decodeAdvisoryWalletHistory(token,history,receipts,cutoff),first=decoded.wallets[0]!,second=decoded.wallets[1]!;
 assert.equal(decoded.genesisVerified,true);assert.equal(decoded.providerLedgerFloorSlot,123);
 assert.deepEqual(decoded.wallets.map(item=>item.wallet),ordered.slice(0,2));
 assert.equal(first.indexedReferences,64);assert.equal(first.pages.length,2);assert.equal(first.providerIndexExhausted,false);
 assert.equal(first.earliestRetainedReference?.at,new Date((cutoffSeconds-64*3600)*1000).toISOString());
 assert.equal(first.activityClassification,'OLDER_THAN_24H_WITNESSED');assert.equal(first.olderWitness?.at,first.earliestRetainedReference?.at);
 assert.equal(second.indexedReferences,3);assert.equal(second.providerIndexExhausted,true);assert.equal(second.activityClassification,'UNRESOLVED');
 assert.ok(decoded.wallets.every(item=>item.firstEverActivityAt===null));
 assert.equal(decoded.holderExposure,null);assert.equal(decoded.holderPopulationCovered,false);
 assert.equal(decoded.ageThresholdHours,24);assert.match(decoded.limitations.join(' '),/never wallet creation/);assert.match(decoded.limitations.join(' '),/No fresh classification/);
 const chain={transactions:[]} as unknown as ChainHistory;
 const metrics=deriveWalletHistoryMetrics(decoded,history,chain,{},['wallet-history-evidence']);
 assert.equal(metrics.find(metric=>metric.id==='O22')?.quality,'TRUNCATED');
 assert.equal(metrics.find(metric=>metric.id==='O22')?.reasonCode,'SAMPLED_OLDER_ACTIVITY_WITNESSED_EXPOSURE_UNRESOLVED');
 assert.equal(metrics.find(metric=>metric.id==='S13')?.quality,'MISSING');
 assert.deepEqual((metrics.find(metric=>metric.id==='S13')!.data as any).publicActorBindings,[]);
 assert.ok(!JSON.stringify(decoded).includes('"fresh":'));
});

test('wallet page receipts reject cursor changes, overlap, and clocks outside genesis/cutoff',async()=>{
 const trader=wallets[0]!,history=tradeHistory([trader]),pages:Record<string,unknown[][]>={[trader]:[walletRows(300,32,800,i=>i+1),walletRows(332,32,768,i=>i+33)]};
 const harness=rpcHarness(pages),valid=await collectAdvisoryWalletHistory(history,'https://rpc.example',harness.fetcher,harness.now);

 const changedCursor=structuredClone(valid);changedCursor.requests['wallet-page-0-1']!.params[1]={commitment:'finalized',limit:32,before:sig(1)};
 const cursorDecoded=decodeAdvisoryWalletHistory(token,history,changedCursor,cutoff);
 assert.equal(cursorDecoded.wallets[0]?.indexedReferences,32);assert.equal(cursorDecoded.wallets[0]?.pages[1]?.code,'WALLET_HISTORY_RECEIPT');

 const overlap=structuredClone(valid),overlapReceipt=JSON.parse(overlap.rawArtifacts['wallet-page-0-1']!);
 overlapReceipt.result[0]=pages[trader]![0]![0];overlap.rawArtifacts['wallet-page-0-1']=JSON.stringify(overlapReceipt);
 const overlapDecoded=decodeAdvisoryWalletHistory(token,history,overlap,cutoff);
 assert.equal(overlapDecoded.wallets[0]?.indexedReferences,32);assert.equal(overlapDecoded.wallets[0]?.pages[1]?.code,'WALLET_HISTORY_CURSOR');

 const beforeGenesis=structuredClone(valid);beforeGenesis.retrievedAt['wallet-page-0-0']='2026-10-11T11:58:59.000Z';
 assert.equal(decodeAdvisoryWalletHistory(token,history,beforeGenesis,cutoff).wallets[0]?.pages[0]?.code,'WALLET_HISTORY_CLOCK');
 const afterCutoff=structuredClone(valid);afterCutoff.retrievedAt['wallet-page-0-0']='2026-10-11T12:01:00.000Z';
 assert.equal(decodeAdvisoryWalletHistory(token,history,afterCutoff,cutoff).wallets[0]?.pages[0]?.code,'WALLET_HISTORY_CLOCK');
});

test('mainnet genesis guard prevents every wallet-index request on a different cluster',async()=>{
 const trader=wallets[0]!,harness=rpcHarness({[trader]:[[walletRows(400,1,900,()=>1)]]},'wrong-genesis');
 const history=tradeHistory([trader]),receipts=await collectAdvisoryWalletHistory(history,'https://rpc.example?api-key=SECRET',harness.fetcher,harness.now);
 assert.deepEqual(harness.calls.map(call=>call.method),['getGenesisHash']);
 assert.deepEqual(Object.keys(receipts.requests),['wallet-genesis']);assert.equal(JSON.stringify(receipts).includes('SECRET'),false);
 const decoded=decodeAdvisoryWalletHistory(token,history,receipts,cutoff);
 assert.equal(decoded.genesisVerified,false);assert.equal(decoded.wallets[0]?.indexedReferences,0);
 assert.equal(decoded.wallets[0]?.activityClassification,'UNRESOLVED');assert.equal(decoded.wallets[0]?.firstEverActivityAt,null);
 assert.equal(decoded.holderExposure,null);
});

test('co-signer edges require an observed decoded trade and signer/signature cardinality, without actor identity',async()=>{
 const trader=wallets[0]!,signature=sig(700),tradeAt=new Date((cutoffSeconds-10)*1000).toISOString(),history=tradeHistory([trader]);
 history.trades[0]!.signature=signature;history.trades[0]!.slot=700;history.trades[0]!.at=tradeAt;
 const fixture={slot:700,blockTime:cutoffSeconds-10,version:1,transaction:{signatures:[signature,sig(701)],message:{accountKeys:[
  {pubkey:trader,signer:true},{pubkey:coSigner,signer:true},{pubkey:token.address,signer:false},{pubkey:pool,signer:false},
 ]}},meta:{err:null,preTokenBalances:[],postTokenBalances:[]}};
 const chainFetcher:typeof fetch=async(_url,init)=>{
  const request=JSON.parse(String(init?.body));let result:unknown;
  if(request.method==='getGenesisHash')result=SOLANA_MAINNET_GENESIS;
  else if(request.method==='getSignaturesForAddress')result=[row(signature,700,cutoffSeconds-10)];
  else result=fixture;
  return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result}));
 };
 const chain=await collectAdvisoryChain(token,[token.address,pool],'https://rpc.example',chainFetcher,()=>cutoff,undefined,true);
 assert.equal(chain.data.transactions[0]?.status,'OBSERVED');
 const walletHarness=rpcHarness({[trader]:[[]]}),walletReceipts=await collectAdvisoryWalletHistory(history,'https://rpc.example',walletHarness.fetcher,walletHarness.now);
 const walletFacts=decodeAdvisoryWalletHistory(token,history,walletReceipts,cutoff);
 const metrics=deriveWalletHistoryMetrics(walletFacts,history,chain.data,chain.rawArtifacts,['chain-evidence']);
 const s13=metrics.find(metric=>metric.id==='S13')!,data=s13.data as any;
 assert.equal(s13.quality,'TRUNCATED');
 assert.deepEqual(data.edges,[{wallet:trader,coSigner,signature,validAt:tradeAt,relationship:'OBSERVED_TRANSACTION_CO_SIGNER'}]);
 assert.deepEqual(data.publicActorBindings,[]);assert.match(data.validity,/no ongoing control/);
 assert.ok(!JSON.stringify(data.edges).match(/identity|ownership|control/i));

 const malformed=structuredClone(chain.rawArtifacts),transaction=JSON.parse(malformed['advisory-chain-transaction-0']!);
 transaction.result.transaction.signatures.pop();malformed['advisory-chain-transaction-0']=JSON.stringify(transaction);
 const rejected=deriveWalletHistoryMetrics(walletFacts,history,chain.data,malformed,['chain-evidence']).find(metric=>metric.id==='S13')!;
 assert.equal(rejected.quality,'MISSING');assert.deepEqual((rejected.data as any).edges,[]);
});
