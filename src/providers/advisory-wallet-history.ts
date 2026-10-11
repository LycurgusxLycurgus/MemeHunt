import type { TokenRef } from '../domain/contracts.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import { decodeSolanaAddress, safeRpcCode, solanaRpc, SOLANA_MAINNET_GENESIS } from './solana.js';
import { pageRows, type SignatureRow, type ChainHistory } from './advisory-chain.js';
import type { TradeHistory } from './advisory-trades.js';

type Request={method:string;params:unknown[]};
type Receipts={rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;requests:Record<string,Request>};
const genesis:Request={method:'getGenesisHash',params:[]},floor:Request={method:'getFirstAvailableBlock',params:[]};
const pageRequest=(wallet:string,before?:string):Request=>({method:'getSignaturesForAddress',params:[wallet,{commitment:'finalized',limit:32,...(before?{before}:{})}]});
const selected=(history:TradeHistory)=>history.poolVerified?[...new Set(history.trades.map(t=>t.user))].sort().slice(0,2):[];
const read=(id:string,expected:Request,r:Receipts)=>{
 if(JSON.stringify(r.requests[id])!==JSON.stringify(expected)||!Number.isFinite(Date.parse(r.retrievedAt[id]??'')))throw new Error('WALLET_HISTORY_RECEIPT');
 const x=JSON.parse(r.rawArtifacts[id]!);if(x?.jsonrpc!=='2.0'||x.id!==1||x.error||!('result'in x))throw new Error('WALLET_HISTORY_UNAVAILABLE');return x.result;
};
/** Bounded wallet-reference index, separate from mint/pool history and from human attribution. */
export async function collectAdvisoryWalletHistory(history:TradeHistory,url:string,fetcher:typeof fetch,now:()=>string,signal?:AbortSignal):Promise<Receipts>{
 const r:Receipts={rawArtifacts:{},retrievedAt:{},requests:{}};
 const run=async(id:string,request:Request)=>{r.requests[id]=request;try{await solanaRpc(url,request.method,request.params,fetcher,500_000,signal,raw=>{r.rawArtifacts[id]=raw;r.retrievedAt[id]=now();});}catch(e){if(!r.rawArtifacts[id]){r.rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:safeRpcCode(e)}});r.retrievedAt[id]=now();}}};
 await run('wallet-genesis',genesis);try{if(read('wallet-genesis',genesis,r)!==SOLANA_MAINNET_GENESIS)return r;}catch{return r;}
 await run('wallet-ledger-floor',floor);
 for(const [i,wallet] of selected(history).entries()){
  let before:string|undefined,previousSlot=Infinity;const seen=new Set<string>();
  for(let j=0;j<2;j++){
   const id=`wallet-page-${i}-${j}`;await run(id,pageRequest(wallet,before));
   try{const rows=pageRows(read(id,pageRequest(wallet,before),r),Date.parse(r.retrievedAt[id]!));if(rows.some(row=>seen.has(row.signature)||row.slot>previousSlot))break;for(const row of rows)seen.add(row.signature);if(rows.length<32)break;before=rows.at(-1)!.signature;previousSlot=rows.at(-1)!.slot;}catch{break;}
  }
 }
 return r;
}
export function decodeAdvisoryWalletHistory(token:TokenRef,history:TradeHistory,r:Receipts,cutoff:string){
 const scope=selected(history);if(token.chain!=='solana'||history.token.chain!==token.chain||history.token.address!==token.address||!Number.isFinite(Date.parse(cutoff)))throw new Error('WALLET_HISTORY_SCOPE');
 scope.forEach(wallet=>decodeSolanaAddress(wallet));
 let verified=false,providerLedgerFloorSlot:number|null=null;try{if(Date.parse(r.retrievedAt['wallet-genesis']??'')>Date.parse(cutoff))throw new Error('WALLET_HISTORY_CLOCK');verified=read('wallet-genesis',genesis,r)===SOLANA_MAINNET_GENESIS;if(verified){if(Date.parse(r.retrievedAt['wallet-ledger-floor']??'')>Date.parse(cutoff))throw new Error('WALLET_HISTORY_CLOCK');const n=read('wallet-ledger-floor',floor,r);if(Number.isSafeInteger(n)&&n>=0)providerLedgerFloorSlot=n;}}catch{/* floor unavailable does not invalidate a witnessed older reference */}
 const wallets=scope.map((wallet,i)=>{
  const rows:SignatureRow[]=[],pages:Array<{returned:number;exhausted:boolean;code:string|null}>=[];let before:string|undefined,previousSlot=Infinity,previousAt=Date.parse(r.retrievedAt['wallet-genesis']??'');const seen=new Set<string>();
  if(verified)for(let j=0;j<2;j++){
   const id=`wallet-page-${i}-${j}`;try{
    const at=Date.parse(r.retrievedAt[id]??'');if(at> Date.parse(cutoff)||at<previousAt)throw new Error('WALLET_HISTORY_CLOCK');
    const found=pageRows(read(id,pageRequest(wallet,before),r),at);
    if(found.some(row=>seen.has(row.signature)||row.slot>previousSlot))throw new Error('WALLET_HISTORY_CURSOR');
    for(const row of found)seen.add(row.signature);rows.push(...found);pages.push({returned:found.length,exhausted:found.length<32,code:null});if(found.length<32)break;before=found.at(-1)!.signature;previousSlot=found.at(-1)!.slot;previousAt=at;
   }catch(e){pages.push({returned:0,exhausted:false,code:e instanceof Error&&/^WALLET_HISTORY_[A-Z_]+$/.test(e.message)?e.message:'WALLET_HISTORY_INVALID'});break;}
  }
  const dated=rows.filter(row=>row.blockTime!==null).sort((a,b)=>a.blockTime!-b.blockTime!||a.slot-b.slot),oldest=dated[0];
  const older=dated.find(row=>row.blockTime!*1000<=Date.parse(cutoff)-24*3_600_000);
  return{wallet,indexedReferences:rows.length,pages,providerIndexExhausted:pages.at(-1)?.exhausted??false,earliestRetainedReference:oldest?{signature:oldest.signature,slot:oldest.slot,at:new Date(oldest.blockTime!*1000).toISOString()}:null,activityClassification:older?'OLDER_THAN_24H_WITNESSED':'UNRESOLVED',olderWitness:older?{signature:older.signature,slot:older.slot,at:new Date(older.blockTime!*1000).toISOString()}:null,firstEverActivityAt:null};
 });
 return{method:'sampled-wallet-reference-history-v1',token,genesisVerified:verified,providerLedgerFloorSlot,ageThresholdHours:24,walletSelection:'lexicographically first two validated decoded trader addresses',wallets,holderExposure:null,holderPopulationCovered:false,limitations:['Account reference is not proof the wallet signed; passive references and failed transactions can be indexed.','Provider ledger floor is not a guarantee of complete account-index or archival retention.','Earliest retained activity is an upper bound on first-ever activity, never wallet creation.','No fresh classification, holder-weighted fraction or whole-wallet incoming-transfer coverage is claimed.']};
}
/** Positive on-chain co-signing is a separate inferred edge, never a social-account identity or ownership claim. */
export function deriveWalletHistoryMetrics(history:ReturnType<typeof decodeAdvisoryWalletHistory>,trades:TradeHistory,chain:ChainHistory,chainRaw:Record<string,string>,ids:string[]):AdvisoryMetric[]{
 const edges:Array<{wallet:string;coSigner:string;signature:string;validAt:string;relationship:string}>=[];
 for(const t of trades.trades){const i=chain.transactions.findIndex(x=>x.signature===t.signature&&x.status==='OBSERVED');if(i<0)continue;
  try{const tx=JSON.parse(chainRaw[`advisory-chain-transaction-${i}`]!).result,keys=tx.transaction.message.accountKeys;if(tx.transaction.signatures[0]!==t.signature||tx.meta.err!==null||!Array.isArray(keys)||keys.filter((k:any)=>k.signer===true).length!==tx.transaction.signatures.length||!keys.some((k:any)=>k.pubkey===t.user&&k.signer===true))continue;
   for(const k of keys){if(k.signer!==true||k.pubkey===t.user)continue;decodeSolanaAddress(k.pubkey);if(!edges.some(e=>e.wallet===t.user&&e.coSigner===k.pubkey&&e.signature===t.signature))edges.push({wallet:t.user,coSigner:k.pubkey,signature:t.signature,validAt:t.at,relationship:'OBSERVED_TRANSACTION_CO_SIGNER'});}
  }catch{/* malformed receipts cannot establish an edge */}
 }
 return[
  {id:'O22',quality:history.genesisVerified&&history.wallets.some(w=>w.indexedReferences>0)?'TRUNCATED':'MISSING',unit:'sampled wallet activity bounds',data:history,evidenceIds:ids,reasonCode:history.wallets.some(w=>w.olderWitness)?'SAMPLED_OLDER_ACTIVITY_WITNESSED_EXPOSURE_UNRESOLVED':'WALLET_ACTIVITY_AND_HOLDER_EXPOSURE_INCOMPLETE'},
  {id:'S13',quality:edges.length?'TRUNCATED':'MISSING',unit:'separate inferred wallet edges',data:{method:'transaction-co-signing-edge-v1',edges,publicActorBindings:[],validity:'Evidence applies only at each transaction clock; no ongoing control or relationship asserted.',limitations:['Co-signing may be sponsorship, routing or one-off collaboration; it does not prove common ownership, funding, friendship or human identity.','No public social-account-to-wallet statement/signature was found in these chain receipts.']},evidenceIds:ids,reasonCode:edges.length?'CO_SIGNING_WITNESSED_PUBLIC_ACTOR_BINDING_UNAVAILABLE':'PUBLIC_ACTOR_WALLET_BINDING_UNAVAILABLE'},
 ];
}
