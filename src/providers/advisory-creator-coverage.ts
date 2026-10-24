import {setTimeout as waitForContext} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import type {TokenRef} from '../domain/contracts.js';
import type {CreatorRoleDecode} from './advisory-creator-role-collector.js';
import type {CreatorQuoteReceipts} from './advisory-creator-quote.js';
import {walletTouch} from './advisory-creator-inventory.js';
import {creatorRoleTransactionRequest} from './advisory-creator-role.js';
import {classifyCreatorFailedFees,archiveCreatorFailedFeeReceipt,failedFeeRequest,failedFeeReceiptId,FAILED_FEE_SOURCE_ID,FAILED_FEE_ADAPTER,NATIVE_FAILED_FEE_RECEIPT_CAP,EPISODE_FAILED_FEE_RECEIPT_CAP} from './advisory-creator-failed-fees.js';
import {archiveDemandReceipt,unpackDemandReceipt} from './advisory-demand-windows.js';
import {SOLANA_MAINNET_GENESIS,solanaRpc,safeRpcCode,decodeSolanaAddress} from './solana.js';
export const CREATOR_COVERAGE_REQUEST_CAP=8724,CREATOR_COVERAGE_BYTES=32_000_000;
export const EPISODE_COVERAGE_REQUEST_CAP=9236,EPISODE_COVERAGE_BYTES=48_000_000;
const SUCCESS_CAP=8192,FAILED_CAP=NATIVE_FAILED_FEE_RECEIPT_CAP,PAGES=16,RESPONSE_BYTES=500_000;
type Request={method:string;params:unknown[]};
export type CreatorCoverageReceipts=CreatorQuoteReceipts;
const genesis:Request={method:'getGenesisHash',params:[]},head:Request={method:'getSlot',params:[{commitment:'finalized'}]};
const catalog=(wallet:string,mint:string,slot:number):Request=>({method:'getTokenAccountsByOwner',params:[wallet,{mint},{encoding:'jsonParsed',commitment:'finalized',minContextSlot:slot}]});
const page=(wallet:string,slot:number,before?:string):Request=>({method:'getSignaturesForAddress',params:[wallet,{limit:1000,commitment:'finalized',minContextSlot:slot,...before?{before}:{}}]});
const obj=(x:any)=>x!==null&&typeof x==='object'&&!Array.isArray(x),int=(x:any)=>Number.isSafeInteger(x)&&x>=0;
function bound(role:CreatorRoleDecode){if(role.quality!=='KNOWN'||!role.binding)throw new Error('CREATOR_COVERAGE_ROLE');return role.binding;}
const invalid=():never=>{throw new Error('ADVISORY_CREATOR_COVERAGE_RECEIPT');};
const code=(e:unknown)=>e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'CREATOR_COVERAGE_UNRESOLVED';
/** Complete wallet-reference source census, separate from execution of individual target trades. */
export function decodeCreatorCoverage(token:TokenRef,role:CreatorRoleDecode,canonicalAccount:string,r:CreatorCoverageReceipts,cutoff:string,canonicalSignatures:string[]=[],canonicalHead?:{slot:number|null;amountAtomic:string|null},episode=false){
 const b=bound(role),cut=Date.parse(cutoff),keys=Object.keys(r.requests),used=new Set<string>();
 if(token.chain!=='solana'||token.address!==b.token.address||!Number.isFinite(cut)||keys.length>(episode?EPISODE_COVERAGE_REQUEST_CAP:CREATOR_COVERAGE_REQUEST_CAP)||JSON.stringify([...keys].sort())!==JSON.stringify(Object.keys(r.rawArtifacts).sort())||JSON.stringify([...keys].sort())!==JSON.stringify(Object.keys(r.retrievedAt).sort())||Object.values(r.rawArtifacts).reduce((n,x)=>n+Buffer.byteLength(x),0)>(episode?EPISODE_COVERAGE_BYTES:CREATOR_COVERAGE_BYTES))invalid();
 const read=(id:string,request:Request)=>{
  used.add(id);if(!Object.hasOwn(r.requests,id))throw new Error('CREATOR_COVERAGE_NOT_COLLECTED');
  const at=Date.parse(r.retrievedAt[id]??'');if(JSON.stringify(r.requests[id])!==JSON.stringify(request)||!Number.isFinite(at)||at>cut)invalid();
  let raw=r.rawArtifacts[id]!,v:any;try{if(id.startsWith('transaction-'))raw=unpackDemandReceipt(raw,RESPONSE_BYTES);if(Buffer.byteLength(raw)>RESPONSE_BYTES)invalid();v=JSON.parse(raw);}catch{invalid();}
  if(!obj(v)||v.jsonrpc!=='2.0'||v.id!==1)invalid();if(v.error)throw new Error('CREATOR_COVERAGE_SOURCE_UNAVAILABLE');if(!Object.hasOwn(v,'result'))invalid();return{value:v.result,at,raw};
 };
 let canonicalCatalogAtomic:string|null=null,headSlot:number|null=null,indexComplete=false,catalogComplete=false,otherAccounts:string[]=[],indexedRows=0,successCount=0,failedCount=0,inspected=0,sourceReceipts=0;
 let reasonCode='CREATOR_COVERAGE_NOT_COLLECTED';const unresolved:Array<{signature:string;code:string}>=[],targetSignatures:string[]=[],canonicalReferences:string[]=[],failedRows:any[]=[],failedReceipts:any[]=[];
 try{
  const g=read('genesis',genesis);if(g.value!==SOLANA_MAINNET_GENESIS)throw new Error('CREATOR_COVERAGE_CLUSTER');
  const h=read('head',head);if(!int(h.value)||h.value<b.creation.slot||h.at<g.at)invalid();headSlot=h.value;
  const c=read('catalog',catalog(b.wallet,token.address,headSlot!));if(c.at<h.at||!int(c.value?.context?.slot)||c.value.context.slot<headSlot!||!Array.isArray(c.value?.value))invalid();headSlot=c.value.context.slot;
  canonicalCatalogAtomic='0';const seenAccounts=new Set<string>();for(const entry of c.value.value){const i=entry?.account?.data?.parsed?.info;if(typeof entry?.pubkey!=='string'||seenAccounts.has(entry.pubkey)||entry.account.owner!==b.creation.tokenProgram||i?.mint!==token.address||i.owner!==b.wallet||!/^\d{1,20}$/.test(i.tokenAmount?.amount))invalid();decodeSolanaAddress(entry.pubkey);seenAccounts.add(entry.pubkey);if(entry.pubkey===canonicalAccount)canonicalCatalogAtomic=String(BigInt(i.tokenAmount.amount));if(entry.pubkey!==canonicalAccount&&BigInt(i.tokenAmount.amount)!==0n)otherAccounts.push(entry.pubkey);}
  catalogComplete=true;
  const rows:any[]=[],seen=new Set<string>();let before:string|undefined,priorSlot=Infinity,priorTime=Infinity,priorAt=c.at;
  for(let p=0;p<PAGES;p++){
   const response=read(`page-${p}`,page(b.wallet,headSlot!,before)),found=response.value;if(response.at<priorAt||!Array.isArray(found)||found.length>1000)invalid();priorAt=response.at;
   for(const row of found){if(!obj(row)||typeof row.signature!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(row.signature)||seen.has(row.signature)||!int(row.slot)||row.slot>priorSlot||!int(row.blockTime)||row.blockTime>priorTime||row.blockTime*1000>response.at||row.confirmationStatus!=='finalized'||!(row.err===null||obj(row.err)))invalid();seen.add(row.signature);priorSlot=row.slot;priorTime=row.blockTime;}
   rows.push(...found);if(found.length<1000||found.some((x:any)=>x.slot<b.creation.slot)){indexComplete=true;break;}before=found.at(-1)?.signature;
  }
  if(!indexComplete)throw new Error('CREATOR_COVERAGE_INDEX_CAP');
  const since=rows.filter(x=>x.slot>=b.creation.slot&&x.slot<=headSlot!);indexedRows=since.length;successCount=since.filter(x=>x.err===null).length;failedCount=since.length-successCount;
  if(!since.some(x=>x.signature===b.creation.signature&&x.slot===b.creation.slot&&x.err===null))invalid();
  if(successCount>SUCCESS_CAP||failedCount>(episode?EPISODE_FAILED_FEE_RECEIPT_CAP:FAILED_CAP))throw new Error('CREATOR_COVERAGE_TRANSACTION_CAP');
  for(const row of since){
   const id=`transaction-${row.signature}`,request=row.err===null?creatorRoleTransactionRequest(row.signature):failedFeeRequest(row.signature);
   if(row.err!==null)failedRows.push({...row,transactionIndex:row.transactionIndex??null});
   try{
    const receipt=read(id,request),tx=receipt.value;if(tx?.slot!==row.slot||tx.blockTime!==row.blockTime||tx.transaction?.signatures?.[0]!==row.signature||!obj(tx.meta)||JSON.stringify(tx.meta.err)!==JSON.stringify(row.err)||receipt.at<row.blockTime*1000)throw new Error('CREATOR_COVERAGE_TRANSACTION_BINDING');sourceReceipts++;
    if(row.err!==null){const stored=archiveCreatorFailedFeeReceipt(receipt.raw);failedReceipts.push({id:failedFeeReceiptId(row.signature),sourceId:FAILED_FEE_SOURCE_ID,adapterVersion:FAILED_FEE_ADAPTER,request,retrievedAt:r.retrievedAt[id],contentHash:createHash('sha256').update(stored).digest('hex'),stored});continue;}
    if(!['legacy',0,1].includes(tx.version))throw new Error('CREATOR_COVERAGE_VERSION_UNSUPPORTED');
    const list=tx.transaction.message.accountKeys;if(!Array.isArray(list)||!list.length||new Set(list.map((x:any)=>x.pubkey)).size!==list.length||list.some((x:any)=>typeof x.signer!=='boolean'||typeof x.writable!=='boolean'))throw new Error('CREATOR_COVERAGE_KEYS_UNRESOLVED');
    const result=walletTouch(tx,{wallet:b.wallet,mint:token.address,creationSlot:b.creation.slot,creationSignature:b.creation.signature},canonicalAccount,true);if(result)unresolved.push({signature:row.signature,code:result});
    if([...tx.meta.preTokenBalances,...tx.meta.postTokenBalances].some(x=>x.mint===token.address)||tx.transaction.message.accountKeys.some((x:any)=>x.pubkey===token.address||x.pubkey===canonicalAccount))targetSignatures.push(row.signature);
    if(tx.transaction.message.accountKeys.some((x:any)=>x.pubkey===canonicalAccount))canonicalReferences.push(row.signature);
    inspected++;
   }catch(e){if(code(e)==='ADVISORY_CREATOR_COVERAGE_RECEIPT')throw e;unresolved.push({signature:row.signature,code:code(e)});}
  }
  for(const signature of canonicalSignatures)if(!since.some(x=>x.signature===signature&&x.err===null))unresolved.push({signature,code:'CREATOR_COVERAGE_CANONICAL_INDEX_GAP'});
  if(canonicalSignatures.length)for(const signature of canonicalReferences)if(!canonicalSignatures.includes(signature))unresolved.push({signature,code:'CREATOR_COVERAGE_CANONICAL_HISTORY_GAP'});
  if(canonicalHead&&(canonicalHead.slot===null||canonicalHead.amountAtomic===null||headSlot!<canonicalHead.slot||canonicalCatalogAtomic!==canonicalHead.amountAtomic))unresolved.push({signature:b.creation.signature,code:'CREATOR_COVERAGE_CANONICAL_HEAD_MISMATCH'});
  reasonCode=unresolved.length||otherAccounts.length?'CREATOR_COVERAGE_EXCLUSION_UNRESOLVED':'CREATOR_COVERAGE_OBSERVED';
 }catch(e){if(code(e)==='ADVISORY_CREATOR_COVERAGE_RECEIPT')throw e;reasonCode=code(e);}
 if(keys.some(k=>!used.has(k)))invalid();
 const failed=!indexComplete||headSlot===null?null:classifyCreatorFailedFees({actor:b.wallet,mint:token.address,targetAccounts:[canonicalAccount],creationSlot:b.creation.slot,headSlot,cutoff,rows:failedRows,receipts:failedReceipts},true,true,episode);
 // An actor-paid failure lacking target keys has a proved fee payer/debit but no safe target allocation.
 const feeCensusComplete=indexComplete&&failedRows.length===failedCount&&failed!==null&&failed.status!=='INVALID'&&failed.rows.length===failedCount&&failed.rows.every(x=>x.classification==='NOT_ACTOR_CHARGED'||x.classification==='TARGET_ASSOCIATED_CHARGED'||x.classification==='UNRESOLVED'&&x.code==='ACTOR_CHARGED_TARGET_UNPROVEN');
 const wholeWalletComplete=feeCensusComplete&&indexComplete&&catalogComplete&&otherAccounts.length===0&&successCount===inspected&&unresolved.length===0;
 return{method:'creator-wallet-coverage-v1',scope:'SIGNED_CREATOR_WALLET_REFERENCE_INDEX_SINCE_CREATION',wallet:b.wallet,cutoff,headSlot,canonicalCatalogAtomic,indexComplete,catalogComplete,indexedRows,successfulReferences:successCount,failedReferences:failedCount,successfulInspected:inspected,sourceReceipts,sourceComplete:indexComplete&&sourceReceipts===indexedRows,wholeWalletComplete,otherNonzeroCurrentAccounts:otherAccounts,unresolved,targetSignatures,reasonCode,
 failedFees:{payerCensusComplete:feeCensusComplete,targetAssociatedCoverageComplete:feeCensusComplete&&failed?.status==='COMPLETE',creatorChargedLamports:feeCensusComplete?String(failed!.rows.reduce((sum,x)=>sum+BigInt(x.actorChargedLamports!),0n)):null,targetAssociatedChargedLamports:feeCensusComplete?failed?.failedTargetAssociatedChargedTransactionOverheadLamports??null:null,allocation:'NONE_WHOLE_TRANSACTION_FEES_NOT_TARGET_PROFIT',classification:failed},
 premises:['A finalized RPC address index and recorded attempted instruction trace are complete provider evidence, not a cryptographic archive attestation.','No other account can hide a target debit authorized by this creator when every attempted critical token form resolves and current target balances are zero; the verified fresh mint has no permanent delegate.','Exclusion uses the entire attempted-instruction superset; it never declares an unlogged CPI executed.','Creator-paid failures without target reference are counted only in the unallocated payer fee census, never target performance.']};
}

/** Whole source census is acquired even if an individual receipt has unsupported target semantics. */
export async function collectCreatorCoverage(token:TokenRef,role:CreatorRoleDecode,canonicalAccount:string,prior:CreatorQuoteReceipts,rpcUrl:string,fetcher:typeof fetch,now:()=>string,signal?:AbortSignal,episode=false):Promise<CreatorCoverageReceipts>{
 const b=bound(role),r:CreatorCoverageReceipts={rawArtifacts:{},retrievedAt:{},requests:{}};let stored=0,reserved=0,nextReadAt=0;
 const run=async(id:string,request:Request)=>{
  if(signal?.aborted||Object.keys(r.requests).length>=(episode?EPISODE_COVERAGE_REQUEST_CAP:CREATOR_COVERAGE_REQUEST_CAP)||stored+reserved+RESPONSE_BYTES>(episode?EPISODE_COVERAGE_BYTES:CREATOR_COVERAGE_BYTES))return false;
  reserved+=RESPONSE_BYTES;r.requests[id]=request;let body:string|undefined,at:string|undefined;
  const shared=request.method==='getTransaction'?Object.keys(prior.requests).find(k=>JSON.stringify(prior.requests[k])===JSON.stringify(request)&&(()=>{try{return JSON.parse(prior.rawArtifacts[k]!.startsWith('{"method":"advisory-demand-rpc-archive-v1"')?unpackDemandReceipt(prior.rawArtifacts[k]!,RESPONSE_BYTES):prior.rawArtifacts[k]!).result!=null;}catch{return false;}})()):undefined;
  if(shared){body=prior.rawArtifacts[shared]!.startsWith('{"method":"advisory-demand-rpc-archive-v1"')?unpackDemandReceipt(prior.rawArtifacts[shared]!,RESPONSE_BYTES):prior.rawArtifacts[shared];at=prior.retrievedAt[shared];}
  else try{const delay=Math.max(0,nextReadAt-Date.now());nextReadAt=Math.max(nextReadAt,Date.now())+300;if(delay)await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal?.reason);},timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},delay);signal?.addEventListener('abort',abort,{once:true});});signal?.throwIfAborted();for(let attempt=0;;attempt++){try{await solanaRpc(rpcUrl,request.method,request.params,fetcher,RESPONSE_BYTES,signal,raw=>{body=raw;at=now();});break;}catch(e){if(!episode||id!=='catalog'||attempt>=2||safeRpcCode(e)!=='RPC_REMOTE_-32016')throw e;await waitForContext(2000,undefined,{signal});}}}catch(e){if(body===undefined){body=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:safeRpcCode(e)}});at=now();}}
  let value=id.startsWith('transaction-')?archiveDemandReceipt(body!):body!;reserved-=RESPONSE_BYTES;if(stored+reserved+Buffer.byteLength(value)>(episode?EPISODE_COVERAGE_BYTES:CREATOR_COVERAGE_BYTES)){const error=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:'RPC_STORAGE_CAP'}});value=id.startsWith('transaction-')?archiveDemandReceipt(error):error;}stored+=Buffer.byteLength(value);r.rawArtifacts[id]=value;r.retrievedAt[id]=at!;return true;
 };
 const value=(id:string)=>{try{return JSON.parse(r.rawArtifacts[id]!).result;}catch{return undefined;}};
 try{
  if(!await run('genesis',genesis)||value('genesis')!==SOLANA_MAINNET_GENESIS||!await run('head',head)||!int(value('head')))return r;
  if(!await run('catalog',catalog(b.wallet,token.address,value('head'))))return r;const slot=value('catalog')?.context?.slot;if(!int(slot))return r;
  const rows:any[]=[];let before:string|undefined,complete=false;
  for(let p=0;p<PAGES;p++){if(!await run(`page-${p}`,page(b.wallet,slot,before)))return r;const found=value(`page-${p}`);if(!Array.isArray(found)||found.length>1000)return r;rows.push(...found);if(found.length<1000||found.some((x:any)=>x.slot<b.creation.slot)){complete=true;break;}before=found.at(-1)?.signature;}
  if(!complete)return r;const since=rows.filter(x=>x.slot>=b.creation.slot&&x.slot<=slot);if(since.filter(x=>x.err===null).length>SUCCESS_CAP||since.filter(x=>x.err!==null).length>(episode?EPISODE_FAILED_FEE_RECEIPT_CAP:FAILED_CAP))return r;
  // Pure preflight validates the full cursor/index/catalog before transaction reads.
  const preflight=decodeCreatorCoverage(token,role,canonicalAccount,r,now(),[],undefined,episode);if(!preflight.indexComplete||!preflight.catalogComplete)return r;
  for(let i=0;i<since.length&&!signal?.aborted;i+=2){const ok=await Promise.all(since.slice(i,i+2).map(row=>run(`transaction-${row.signature}`,row.err===null?creatorRoleTransactionRequest(row.signature):failedFeeRequest(row.signature))));if(ok.some(x=>!x))break;}
 }catch{/* retained prefix is an explicitly incomplete source */}
 return r;
}
