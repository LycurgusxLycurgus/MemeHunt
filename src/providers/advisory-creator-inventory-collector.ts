import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID } from '@pump-fun/pump-swap-sdk';
import type { TokenRef } from '../domain/contracts.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import type { AdvisoryWindowHistory, AdvisoryWindowReuse } from './advisory-window.js';
import { decodeAdvisoryDemandWindows, type DemandHistory } from './advisory-demand-windows.js';
import { decodeCreatorRole, type CreatorRoleDecode } from './advisory-creator-role-collector.js';
import type { CreatorRoleReceipts } from './advisory-creator-role.js';
import { CREATOR_MAX_PAGES, CREATOR_PAGE_LIMIT, CREATOR_TRANSACTION_CAP, creatorHeadRequest, creatorOwnerRequest, creatorPageRequest, creatorTransactionRequest, decodeCreatorInventory, deriveO24CreatorInventory, type CreatorInventoryReceipts, type CreatorReuse, type CreatorRole, type CreatorTape } from './advisory-creator-inventory.js';
import { safeRpcCode, solanaRpc } from './solana.js';

/** Dedicated allowance from the decoder bounds: ATA head, ATA index pages, owner catalog, wallet index pages and fresh transactions (1+2+1+2+96=102). Admitted retries count against it. */
export const CREATOR_INVENTORY_REQUEST_CAP=1+CREATOR_MAX_PAGES+1+CREATOR_MAX_PAGES+CREATOR_TRANSACTION_CAP;
/** Hard ceiling on retained plain bodies: each in-flight read reserves its response cap, and a read that could pass the ceiling is never issued. */
export const CREATOR_INVENTORY_STORED_BYTES=6_000_000;
const ACCOUNT_BYTES=500_000,PAGE_BYTES=2_000_000,TRANSACTION_BYTES=500_000,CONCURRENCY=2,TX='creator-tx-',SIGNATURE=/^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
type Request={method:string;params:unknown[]};
type Row={signature:string;slot:number;blockTime:number;err:unknown};
type ReceiptSource={rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;requests:Record<string,unknown>};
const empty=():CreatorInventoryReceipts=>({rawArtifacts:{},retrievedAt:{},requests:{}});
const usable=(raw:string)=>{try{const v=JSON.parse(raw);return v!==null&&typeof v==='object'&&v.jsonrpc==='2.0'&&v.id===1&&v.error===undefined&&v.result!==null&&typeof v.result==='object'&&!Array.isArray(v.result);}catch{return false;}};

/** Successful receipts another namespace already retained under the byte-identical inventory getTransaction request; source order, then sorted keys, fix precedence. */
export function creatorInventoryReuse(sources:Array<[prefix:string,receipts:ReceiptSource]>):CreatorReuse{
 const out=new Map<string,{id:string;request:Request;raw:string;retrievedAt:string}>();
 for(const [prefix,s] of sources)for(const key of Object.keys(s.requests).sort()){
  const request:any=s.requests[key],signature=Array.isArray(request?.params)?request.params[0]:undefined,raw=s.rawArtifacts[key],at=s.retrievedAt[key];
  if(typeof signature!=='string'||out.has(signature)||JSON.stringify(request)!==JSON.stringify(creatorTransactionRequest(signature))||typeof raw!=='string'||typeof at!=='string'||!usable(raw))continue;
  out.set(signature,{id:`${prefix}${key}`,request:creatorTransactionRequest(signature),raw,retrievedAt:at});
 }
 return out;
}

/** The S13 cohort: only a KNOWN signed-creation binding for this mint, never a claimed or client-passed wallet. */
export function creatorInventoryRole(token:TokenRef,decode:CreatorRoleDecode):CreatorRole|null{
 const b=decode.binding;
 if(decode.quality!=='KNOWN'||!b||token.chain!=='solana'||b.token.address!==token.address)return null;
 return{wallet:b.wallet,mint:token.address,creationSignature:b.creation.signature,creationSlot:b.creation.slot};
}

/** The complete A30 tape with the base vault of the O28-verified pool state; null unless both are complete for the same pool and anchor. */
export function creatorInventoryTape(window:AdvisoryWindowHistory,windowReceipts:AdvisoryWindowReuse,demand:DemandHistory):CreatorTape|null{
 if(!window.complete||!window.poolVerified||window.pool===null||!demand.eligible||!demand.complete||demand.pool!==window.pool||demand.anchorSlot!==window.anchorSlot)return null;
 // decodeAdvisoryWindow already bound this exact pool state to the pool PDA; its base vault is the a[7] every tape trade was decoded against.
 try{
  const value=JSON.parse(windowReceipts.rawArtifacts['window-pool']!).result.value,data=Buffer.from(value.data[0],'base64');
  return{history:demand,vault:PUMP_AMM_SDK.decodePool({data,owner:PUMP_AMM_PROGRAM_ID,lamports:0,executable:false,rentEpoch:0}).poolBaseTokenAccount.toBase58()};
 }catch{return null;}
}

/** Bounded sequential acquisition in the decoder's pin order (head, ATA index, ATA chain, owner catalog, wallet index, wallet references), at most two transactions in flight.
 * The pure decoder gates every stage, so no read follows a failed, capped or unproven step; failures are retained as sanitized receipts and nothing throws. */
export async function collectCreatorInventory(token:TokenRef,role:CreatorRole,tape:CreatorTape,reuse:CreatorReuse,rpcUrl:string,fetcher:typeof fetch,now:()=>string,signal?:AbortSignal):Promise<CreatorInventoryReceipts>{
 const r=empty(),h=tape.history,start=Date.parse(h.range.baselineEnd);
 let stored=0,reserved=0,fresh=0;
 const rpc=async(id:string,request:Request,maxBytes:number)=>{
  if(signal?.aborted||stored+reserved+maxBytes>CREATOR_INVENTORY_STORED_BYTES)return false;
  reserved+=maxBytes;r.requests[id]=request;
  try{await solanaRpc(rpcUrl,request.method,request.params,fetcher,maxBytes,signal,raw=>{r.rawArtifacts[id]=raw;r.retrievedAt[id]=now();});}
  catch(error){if(r.rawArtifacts[id]===undefined){r.rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:safeRpcCode(error)}});r.retrievedAt[id]=now();}}
  reserved-=maxBytes;stored+=Buffer.byteLength(r.rawArtifacts[id]!);
  return true;
 };
 const result=(id:string):any=>{try{const v=JSON.parse(r.rawArtifacts[id]??'');return v?.jsonrpc==='2.0'&&v.id===1&&v.error===undefined?v.result:undefined;}catch{return undefined;}};
 const slotOf=(id:string):number|null=>{const s=result(id)?.context?.slot;return Number.isSafeInteger(s)?s:null;};
 const index=async(prefix:'ata'|'wallet',address:string,contextSlot:number,reached:(rows:Row[])=>boolean):Promise<Row[]|null>=>{
  const rows:Row[]=[];let before:string|undefined;
  for(let p=0;p<CREATOR_MAX_PAGES;p++){
   const id=`creator-${prefix}-page-${p}`;
   if(!await rpc(id,creatorPageRequest(address,contextSlot,before),PAGE_BYTES))return null;
   const page=result(id);
   if(!Array.isArray(page)||!page.every((x:any)=>x!==null&&typeof x==='object'&&typeof x.signature==='string'&&SIGNATURE.test(x.signature)&&Number.isSafeInteger(x.slot)&&Number.isSafeInteger(x.blockTime)&&'err' in x))return null;
   rows.push(...page);
   if(page.length<CREATOR_PAGE_LIMIT||reached(rows))return rows;
   before=page.at(-1).signature;
  }
  return null;
 };
 const transactions=async(signatures:string[])=>{
  const pending=[...new Set(signatures)].filter(s=>!reuse.has(s)&&!Object.hasOwn(r.requests,TX+s));
  for(let i=0;i<pending.length;){
   const batch=pending.slice(i,i+Math.min(CONCURRENCY,CREATOR_TRANSACTION_CAP-fresh));
   if(!batch.length||signal?.aborted)return false;
   fresh+=batch.length;i+=batch.length;
   if((await Promise.all(batch.map(s=>rpc(TX+s,creatorTransactionRequest(s),TRANSACTION_BYTES)))).includes(false))return false;
  }
  return true;
 };
 const decoded=()=>decodeCreatorInventory(token,role,tape,r,now(),reuse);
 try{
  if(decoded().canonical.code!=='CREATOR_RECEIPT_ABSENT')return r;
  const account=getAssociatedTokenAddressSync(new PublicKey(role.mint),new PublicKey(role.wallet),true,TOKEN_2022_PROGRAM_ID).toBase58();
  if(!await rpc('creator-ata-head',creatorHeadRequest(account,h.anchorSlot!),ACCOUNT_BYTES))return r;
  const headSlot=slotOf('creator-ata-head');if(headSlot===null)return r;
  const ata=await index('ata',account,headSlot,rows=>rows.some(x=>x.err===null&&x.blockTime*1000<start));if(!ata)return r;
  const success=ata.filter(x=>x.err===null&&x.slot<=headSlot),pin=success.find(x=>x.blockTime*1000<start);
  const chain=[...(pin?[pin]:[]),...success.filter(x=>x.blockTime*1000>=start)].map(x=>x.signature);
  if(chain.length>CREATOR_TRANSACTION_CAP||!await transactions(chain)||decoded().canonical.status!=='OBSERVED')return r;
  if(!await rpc('creator-owner-accounts',creatorOwnerRequest(role.wallet,role.mint,headSlot),ACCOUNT_BYTES))return r;
  const catalogSlot=slotOf('creator-owner-accounts');
  if(catalogSlot===null||decoded().walletProof.code!=='CREATOR_RECEIPT_ABSENT')return r;
  const wallet=await index('wallet',role.wallet,catalogSlot,rows=>rows.some(x=>x.slot<role.creationSlot));if(!wallet)return r;
  const since=wallet.filter(x=>x.err===null&&x.slot>=role.creationSlot&&x.slot<=catalogSlot).map(x=>x.signature);
  if(since.length<=CREATOR_TRANSACTION_CAP&&since.includes(role.creationSignature))await transactions(since);
 }catch{/* Receipts gathered so far stay retained; replay reports the unfinished step. */}
 return r;
}

/** Live entry once S13 and A30 finished: recomputes the role and tape exactly as replay will, then collects. Never throws. */
export async function collectCreatorInventoryRun(token:TokenRef,role:CreatorRoleReceipts,window:AdvisoryWindowReuse&{data:AdvisoryWindowHistory},demand:AdvisoryWindowReuse,rpcUrl:string,fetcher:typeof fetch,now:()=>string,signal?:AbortSignal,foreignFlowRecovery=false,recoverCreation=false):Promise<CreatorInventoryReceipts>{
 try{
  const cutoff=now(),cohort=creatorInventoryRole(token,decodeCreatorRole(token,role,cutoff,true,true,recoverCreation));
  if(!cohort)return empty();
  const tape=creatorInventoryTape(window.data,window,decodeAdvisoryDemandWindows(token,window.data,window,demand.rawArtifacts,demand.retrievedAt,demand.requests,cutoff,true,foreignFlowRecovery));
  if(!tape)return empty();
  return await collectCreatorInventory(token,cohort,tape,creatorInventoryReuse([['advisory-creatorRole-',role],['advisory-window-',window]]),rpcUrl,fetcher,now,signal);
 }catch{return empty();}
}

/** Proof v16 replay: the cohort is the S13 role recomputed from its own receipts; a descriptor without a KNOWN role and a complete tape is an orphan. */
export function replayCreatorInventory(token:TokenRef,role:CreatorRoleDecode|null,tape:CreatorTape|null,receipts:CreatorInventoryReceipts,reuse:CreatorReuse,cutoff:string,evidenceIds:string[]):AdvisoryMetric{
 const cohort=role?creatorInventoryRole(token,role):null;
 if(!cohort||!tape)throw new Error('ADVISORY_PROOF_INVALID');
 return deriveO24CreatorInventory(decodeCreatorInventory(token,cohort,tape,receipts,cutoff,reuse),tape,evidenceIds);
}
