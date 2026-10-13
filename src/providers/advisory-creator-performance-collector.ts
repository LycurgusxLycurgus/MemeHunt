import { createHash } from 'node:crypto';
import type { TokenRef } from '../domain/contracts.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import type { AdvisoryWindowHistory, AdvisoryWindowReuse } from './advisory-window.js';
import { decodeAdvisoryDemandWindows } from './advisory-demand-windows.js';
import { decodeCreatorRole, type CreatorRoleDecode } from './advisory-creator-role-collector.js';
import type { CreatorRoleReceipts } from './advisory-creator-role.js';
import type { CreatorInventoryReceipts, CreatorReuse, CreatorRole, CreatorTape } from './advisory-creator-inventory.js';
import { creatorInventoryReuse, creatorInventoryRole, creatorInventoryTape } from './advisory-creator-inventory-collector.js';
import { FAILED_FEE_ADAPTER, FAILED_FEE_RECEIPT_CAP, FAILED_FEE_RESPONSE_BYTES, FAILED_FEE_SOURCE_ID, archiveCreatorFailedFeeReceipt, failedFeeReceiptId, failedFeeRequest, type FailedFeeReceipt, type FailedIndexRow } from './advisory-creator-failed-fees.js';
import { creatorPerformanceGate, deriveS15CreatorPerformance } from './advisory-creator-performance.js';
import { safeRpcCode, solanaRpc } from './solana.js';

/** Dedicated allowance: one getTransaction per failed row of the accepted complete index (130); admitted retries count against it. */
export const CREATOR_FAILED_FEE_REQUEST_CAP=FAILED_FEE_RECEIPT_CAP;
/** Stage ceiling on stored archive containers: 2.27x the 439,802 B measured for all 130 actual receipts. It fits the 1,213,295 B root measured under the unchanged 24 MB cap (stored 22,786,705 B), but that is no guarantee for other bundles; the app aggregate and metadata guard remains mandatory. */
export const CREATOR_FAILED_FEE_STORED_BYTES=1_000_000;
const CONCURRENCY=2,ENVELOPE_RESERVE=1_024;
type Request={method:string;params:unknown[]};
export type CreatorFailedFeeReceipts={rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;requests:Record<string,Request>};
/** Bodies already retained elsewhere, keyed by signature, each with its original request, bytes and clock. */
export type FailedFeePrior=ReadonlyMap<string,{request:unknown;raw:string;retrievedAt:string}>;
const envelope=(code:string)=>JSON.stringify({jsonrpc:'2.0',id:1,error:{code}});

/** Bounded acquisition of receipts for the indexed failed transactions referencing the creator key once every S13/O24/O25/tape and position prerequisite holds; null when the stage is not admitted. Every retained body, error envelopes included, is an exact archive with its request and clock; nothing throws. */
export async function collectCreatorFailedFees(token:TokenRef,role:CreatorRole,tape:CreatorTape,inventory:CreatorInventoryReceipts,reuse:CreatorReuse,prior:FailedFeePrior,rpcUrl:string,fetcher:typeof fetch,now:()=>string,signal?:AbortSignal):Promise<CreatorFailedFeeReceipts|null>{
 let rows:FailedIndexRow[];
 try{const gate=creatorPerformanceGate(token,role,tape,inventory,reuse,now(),[]);if(!gate.ready)return null;rows=gate.scope.failedRows;}catch{return null;}
 const r:CreatorFailedFeeReceipts={rawArtifacts:{},retrievedAt:{},requests:{}};
 let stored=0,reserved=0,fresh=0,halted=false;
 const keep=(id:string,request:Request,container:string,at:string)=>{r.requests[id]=request;r.rawArtifacts[id]=container;r.retrievedAt[id]=at;stored+=Buffer.byteLength(container);};
 const pending:FailedIndexRow[]=[];
 for(const row of rows){
  const id=failedFeeReceiptId(row.signature),request=failedFeeRequest(row.signature),p=prior.get(row.signature);
  // A prior body is reused only under the byte-identical immutable request, keeping its bytes and clock; anything else is read fresh.
  if(p&&JSON.stringify(p.request)===JSON.stringify(request)&&typeof p.raw==='string'&&typeof p.retrievedAt==='string'&&Number.isFinite(Date.parse(p.retrievedAt))){
   let container:string|null=null;try{container=archiveCreatorFailedFeeReceipt(p.raw);}catch{container=null;}
   if(container&&stored+Buffer.byteLength(container)<=CREATOR_FAILED_FEE_STORED_BYTES){keep(id,request,container,p.retrievedAt);continue;}
  }
  pending.push(row);
 }
 const read=async(row:FailedIndexRow)=>{
  if(halted||signal?.aborted||fresh>=CREATOR_FAILED_FEE_REQUEST_CAP||stored+reserved+ENVELOPE_RESERVE>CREATOR_FAILED_FEE_STORED_BYTES){halted=true;return;}
  const id=failedFeeReceiptId(row.signature),request=failedFeeRequest(row.signature),got:{raw?:string;at?:string}={};
  fresh++;reserved+=ENVELOPE_RESERVE;
  try{await solanaRpc(rpcUrl,request.method,request.params,fetcher,FAILED_FEE_RESPONSE_BYTES,signal,body=>{got.raw=body;got.at=now();});}
  catch(error){if(got.raw===undefined){got.raw=envelope(safeRpcCode(error));got.at=now();}}
  reserved-=ENVELOPE_RESERVE;
  let container:string;
  try{container=archiveCreatorFailedFeeReceipt(got.raw!);}catch{container=archiveCreatorFailedFeeReceipt(envelope('RPC_ARCHIVE_SOURCE_LIMIT'));}
  // An archive that would pass the stage ceiling is replaced by a sanitized envelope and admission stops: the stage stays incomplete instead of exceeding storage.
  if(stored+reserved+Buffer.byteLength(container)>CREATOR_FAILED_FEE_STORED_BYTES){container=archiveCreatorFailedFeeReceipt(envelope('RPC_STORAGE_CAP'));halted=true;}
  keep(id,request,container,got.at??now());
 };
 for(let i=0;i<pending.length&&!halted&&!signal?.aborted;i+=CONCURRENCY)await Promise.all(pending.slice(i,i+CONCURRENCY).map(read));
 return r;
}

/** Live entry after the inventory task: recomputes cohort, tape and reuse exactly as replay will, then collects. Never throws. */
export async function collectCreatorFailedFeesRun(token:TokenRef,role:CreatorRoleReceipts,window:AdvisoryWindowReuse&{data:AdvisoryWindowHistory},demand:AdvisoryWindowReuse,inventory:CreatorInventoryReceipts,rpcUrl:string,fetcher:typeof fetch,now:()=>string,signal?:AbortSignal,foreignFlowRecovery=false):Promise<CreatorFailedFeeReceipts|null>{
 try{
  const cutoff=now(),cohort=creatorInventoryRole(token,decodeCreatorRole(token,role,cutoff));
  if(!cohort)return null;
  const tape=creatorInventoryTape(window.data,window,decodeAdvisoryDemandWindows(token,window.data,window,demand.rawArtifacts,demand.retrievedAt,demand.requests,cutoff,true,foreignFlowRecovery));
  if(!tape)return null;
  return await collectCreatorFailedFees(token,cohort,tape,inventory,creatorInventoryReuse([['advisory-creatorRole-',role],['advisory-window-',window]]),new Map(),rpcUrl,fetcher,now,signal);
 }catch{return null;}
}

/** Collected receipts in the provider interface, unfiltered: every key becomes one owned receipt and a missing body fails its hash. */
export function failedFeeReceiptsOf(r:CreatorFailedFeeReceipts):FailedFeeReceipt[]{
 return [...new Set([...Object.keys(r.requests),...Object.keys(r.rawArtifacts)])].sort().map(id=>{
  const stored=r.rawArtifacts[id]??'';
  return{id,sourceId:FAILED_FEE_SOURCE_ID,adapterVersion:FAILED_FEE_ADAPTER,request:r.requests[id],retrievedAt:r.retrievedAt[id]??'',contentHash:createHash('sha256').update(stored,'utf8').digest('hex'),stored};
 });
}

/** Replay: the cohort is the S13 role recomputed from its own receipts; failed receipts without a KNOWN role and a complete tape are orphans. */
export function replayCreatorPerformance(token:TokenRef,role:CreatorRoleDecode|null,tape:CreatorTape|null,inventory:CreatorInventoryReceipts,reuse:CreatorReuse,failed:FailedFeeReceipt[]|null,cutoff:string,evidenceIds:string[]):AdvisoryMetric{
 const cohort=role?creatorInventoryRole(token,role):null;
 if(!cohort||!tape)throw new Error('ADVISORY_PROOF_INVALID');
 return deriveS15CreatorPerformance(token,cohort,tape,inventory,reuse,failed,cutoff,evidenceIds);
}
