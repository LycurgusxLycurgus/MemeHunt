import { Decimal } from 'decimal.js';
import type { TokenRef } from '../domain/contracts.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import { pageRows, type SignatureRow } from './advisory-chain.js';
import type { AdvisoryWindowHistory, AdvisoryWindowReuse } from './advisory-window.js';
import { LEGACY_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, decodeSolanaAddress, safeRpcCode, solanaRpc } from './solana.js';

type Request={method:string;params:unknown[]};
type ReceiptSet=AdvisoryWindowReuse;
type Status='OBSERVED'|'UNAVAILABLE'|'INVALID'|'TRUNCATED';
export type AccountLeg={signature:string;slot:number;at:string;order:number;kind:'POOL_BUY'|'POOL_SELL'|'TRANSFER_IN'|'TRANSFER_OUT'|'MINT'|'BURN';amountAtomic:string;counterparty:string|null;trade:number|null};
export type TraderAccountHistory={
 account:string;users:string[];trades:number[];status:Status;code?:string;
 pages:Array<{id:string;returned:number;oldestAt:string|null;newestAt:string|null;exhausted:boolean;status:Status;code?:string}>;
 transactions:Array<{signature:string;slot:number;at:string;receipt:'WINDOW'|'ACCOUNTS';preAtomic:string|null;postAtomic:string|null;lifecycle:Array<'INITIALIZED'|'CLOSED'>;legs:number}>;
 legs:AccountLeg[];startAtomic:string|null;endAtomic:string|null;
};
export type WindowAccountHistory={
 method:'selected-window-trader-account-legs-v1';token:TokenRef;pool:string|null;window:{start:string;end:string};anchorSlot:number|null;
 windowComplete:boolean;population:number;accounts:TraderAccountHistory[];receipts:number;receiptCap:64;complete:boolean;reasonCode:string;limitations:string[];
};
export const ACCOUNT_RECEIPT_CAP=64;
// The selected window already verified pool, program and vault identities; these constants only locate its retained receipts.
const PAGE_LIMIT=32,PAGES_PER_ACCOUNT=4,program='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',wsol='So11111111111111111111111111111111111111112',tokenPrograms=new Set([LEGACY_TOKEN_PROGRAM,TOKEN_2022_PROGRAM]);
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const atomic=(v:unknown):string=>{if(typeof v!=='string'||!/^(0|[1-9]\d{0,19})$/.test(v)||BigInt(v)>18446744073709551615n)fail('ADVISORY_ACCOUNTS_ATOMIC');return v as string;};
const fail=(code:string):never=>{throw new Error(code);};
const page=(account:string,anchorSlot:number,before?:string):Request=>({method:'getSignaturesForAddress',params:[account,{commitment:'finalized',limit:PAGE_LIMIT,minContextSlot:anchorSlot,...(before?{before}:{})}]});
const transaction=(signature:string):Request=>({method:'getTransaction',params:[signature,{commitment:'finalized',encoding:'jsonParsed',maxSupportedTransactionVersion:1}]});
const errorCode=(error:unknown)=>error instanceof Error&&/^(ADVISORY_ACCOUNTS_[A-Z_]+|RPC_[A-Z0-9_-]{1,50})$/.test(error.message)?error.message:'ADVISORY_ACCOUNTS_RECEIPT_INVALID';
const bad=(error:unknown)=>{const code=errorCode(error);return{status:code.startsWith('RPC_')?'UNAVAILABLE' as const:'INVALID' as const,code};};
function read(id:string,expected:Request,receipts:ReceiptSet,cutoff:string){
 if(JSON.stringify(receipts.requests[id])!==JSON.stringify(expected)||typeof receipts.rawArtifacts[id]!=='string')fail('ADVISORY_ACCOUNTS_REQUEST');
 const at=Date.parse(receipts.retrievedAt[id]??'');if(!Number.isFinite(at)||at>Date.parse(cutoff))fail('ADVISORY_ACCOUNTS_RECEIPT_TIME');
 const raw=JSON.parse(receipts.rawArtifacts[id]!);
 if(!object(raw)||raw.jsonrpc!=='2.0'||raw.id!==1)fail('ADVISORY_ACCOUNTS_RECEIPT_SHAPE');
 if(raw.error){const c=raw.error.code;fail(typeof c==='string'&&/^RPC_[A-Z0-9_-]{1,50}$/.test(c)?c:Number.isSafeInteger(c)&&Math.abs(c)<=999999?`RPC_REMOTE_${c}`:'ADVISORY_ACCOUNTS_REMOTE');}
 if(!Object.hasOwn(raw,'result'))fail('ADVISORY_ACCOUNTS_RECEIPT_SHAPE');return{value:raw.result,at};
}

/** Executed instructions in runtime order: each top-level instruction, then its CPIs. */
type Step={ix:any;depth:number;top:number;executed:boolean};
function steps(value:any):Step[]{
 const instructions=value?.transaction?.message?.instructions,inner=value?.meta?.innerInstructions;
 if(!Array.isArray(instructions)||!Array.isArray(inner))fail('ADVISORY_ACCOUNTS_TRANSACTION_SHAPE');
 const groups=new Map<number,any[]>();for(const g of inner){if(!object(g)||!integer(g.index)||g.index>=instructions.length||groups.has(g.index)||!Array.isArray(g.instructions))fail('ADVISORY_ACCOUNTS_INNER_SHAPE');groups.set(g.index,g.instructions);}
 const list:Step[]=[];
 instructions.forEach((ix:any,top:number)=>{if(!object(ix)||typeof ix.programId!=='string')fail('ADVISORY_ACCOUNTS_TRANSACTION_SHAPE');list.push({ix,depth:1,top,executed:false});let previous=1;
  for(const x of groups.get(top)??[]){if(!object(x)||typeof x.programId!=='string'||!integer(x.stackHeight)||x.stackHeight<2||x.stackHeight>previous+1)fail('ADVISORY_ACCOUNTS_INNER_DEPTH');list.push({ix:x,depth:x.stackHeight,top,executed:false});previous=x.stackHeight;}});
 // RPC innerInstructions includes attempted CPIs, including effects rolled back by
 // a caught failure. Bind every position to its runtime frame before using legs.
 const logs=value?.meta?.logMessages;
 if(!Array.isArray(logs)||logs.some((line:unknown)=>typeof line!=='string'))fail('ADVISORY_ACCOUNTS_LOG_SHAPE');
 type Invocation={position:number;parent:number|null;success:boolean|null};
 const invocations:Invocation[]=[],stack:Invocation[]=[];let cursor=0;
 for(const line of logs as string[]){
  const invoke=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/);
  if(invoke){
   const depth=Number(invoke[2]),step=list[cursor];
   if(!step||depth!==stack.length+1||step.depth!==depth||step.ix.programId!==invoke[1]||stack.length&&list[stack[0]!.position]!.top!==step.top)fail('ADVISORY_ACCOUNTS_LOG_BINDING');
   const entry:Invocation={position:cursor++,parent:stack.at(-1)?.position??null,success:null};invocations.push(entry);stack.push(entry);continue;
  }
  const outcome=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/);
  if(outcome){
   const entry=stack.pop()??fail('ADVISORY_ACCOUNTS_LOG_BINDING');if(list[entry.position]!.ix.programId!==outcome[1])fail('ADVISORY_ACCOUNTS_LOG_BINDING');
   entry.success=outcome[2]==='success';if(entry.parent===null&&!entry.success)fail('ADVISORY_ACCOUNTS_LOG_BINDING');continue;
  }
  if(/^Program \S+ (invoke|success|failed)(?:\b|:)/.test(line)||/log truncated/i.test(line))fail('ADVISORY_ACCOUNTS_LOG_INCOMPLETE');
 }
 if(stack.length||cursor!==list.length||invocations.some(f=>f.success===null))fail('ADVISORY_ACCOUNTS_LOG_INCOMPLETE');
 // Positions stay unchanged for Pump instructionIndex and pool-leg bindings.
 // Ancestors precede descendants, so their final success is already available.
 for(const entry of invocations)list[entry.position]!.executed=entry.success===true&&(entry.parent===null||list[entry.parent]!.executed);
 return list;
}
const frame=(list:Step[],position:number)=>{const result:number[]=[];for(let q=position+1;q<list.length&&list[q]!.top===list[position]!.top&&list[q]!.depth>list[position]!.depth;q++)result.push(q);return result;};
const parsedToken=(step:Step)=>tokenPrograms.has(step.ix.programId)&&object(step.ix.parsed)&&typeof step.ix.parsed.type==='string'&&object(step.ix.parsed.info)?step.ix.parsed as {type:string;info:Record<string,any>}:null;
const amountOf=(info:Record<string,any>)=>atomic(object(info.tokenAmount)?info.tokenAmount.amount:info.amount);
function transfer(step:Step,mint:string){const p=parsedToken(step);if(!p||!['transfer','transferChecked'].includes(p.type))return null;if(p.type==='transferChecked'&&p.info.mint!==mint)return null;if(typeof p.info.source!=='string'||typeof p.info.destination!=='string')fail('ADVISORY_ACCOUNTS_TRANSFER_SHAPE');return{source:p.info.source as string,destination:p.info.destination as string,amount:amountOf(p.info)};}

function windowTransactions(window:AdvisoryWindowHistory,receipts:ReceiptSet){
 const bySignature=new Map<string,any>();
 for(const t of window.transactions){
  const entry=Object.entries(receipts.requests).find(([,r])=>r?.method==='getTransaction'&&r.params?.[0]===t.signature);
  if(!entry||JSON.stringify(entry[1])!==JSON.stringify(transaction(t.signature)))return fail('ADVISORY_ACCOUNTS_WINDOW_RECEIPT');
  bySignature.set(t.signature,JSON.parse(receipts.rawArtifacts[entry[0]]!).result);
 }
 return bySignature;
}
type Binding={trade:number;account:string;user:string;signature:string;position:number;side:'BUY'|'SELL';baseAtomic:string};
/** Binds every decoded window trade to its one executed pool-vault leg; the event never adds a second movement. */
function bindTrades(token:TokenRef,window:AdvisoryWindowHistory,receipts:ReceiptSet){
 if(!window.complete||!window.pool||window.method!=='pumpswap-selected-pool-window-v3')fail('ADVISORY_ACCOUNTS_WINDOW_INCOMPLETE');
 // decodeAdvisoryWindow bound a[7] to the verified pool state's base vault for every selected-pool trade.
 const values=windowTransactions(window,receipts),bindings:Binding[]=[],used=new Set<string>();let vault:string|null=null;
 window.trades.forEach((trade,index)=>{
  const value=values.get(trade.signature);if(!value)fail('ADVISORY_ACCOUNTS_TRADE_BINDING');
  const list=steps(value),pumps=list.map((s,position)=>({...s,position})).filter(s=>s.ix.programId===program),ix=pumps[trade.instructionIndex],a=ix?.ix.accounts;
  if(!ix||!Array.isArray(a)||a[0]!==window.pool||a[3]!==token.address||a[4]!==wsol||typeof a[7]!=='string'||vault!==null&&a[7]!==vault||typeof a[5]!=='string'||a[5]===a[7]||a[1]!==trade.user)fail('ADVISORY_ACCOUNTS_TRADE_BINDING');
  vault=a[7] as string;
  if(!ix.executed)fail('ADVISORY_ACCOUNTS_TRADE_BINDING');
  const legs=frame(list,ix.position).filter(q=>{if(!list[q]!.executed)return false;const t=transfer(list[q]!,token.address);return !!t&&t.amount===trade.baseAtomic&&(trade.side==='BUY'?t.source===vault&&t.destination===a[5]:t.source===a[5]&&t.destination===vault);});
  if(legs.length!==1||used.has(`${trade.signature}:${legs[0]}`))fail('ADVISORY_ACCOUNTS_TRADE_BINDING');used.add(`${trade.signature}:${legs[0]}`);
  bindings.push({trade:index,account:a[5],user:trade.user,signature:trade.signature,position:legs[0]!,side:trade.side,baseAtomic:trade.baseAtomic});
 });
 return{vault:vault??'',values,bindings,accounts:[...new Set(bindings.map(b=>b.account))].sort()};
}

type Index={pages:TraderAccountHistory['pages'];rows:SignatureRow[];indexes:Map<string,number|null>;reached:boolean;status:Status;code?:string;used:string[]};
function index(k:number,account:string,anchorSlot:number,anchorRetrieved:number,window:{start:string;end:string},receipts:ReceiptSet,cutoff:string):Index{
 const result:Index={pages:[],rows:[],indexes:new Map(),reached:false,status:'TRUNCATED',code:'ADVISORY_ACCOUNTS_PAGE_CAP',used:[]},seen=new Set<string>();let before:string|undefined,lastSlot=Infinity,lastAt=Infinity,lastRetrieved=0,unknown=false;
 for(let p=0;p<PAGES_PER_ACCOUNT;p++){
  const id=`account-${k}-page-${p}`;if(!(id in receipts.requests)){result.code='ADVISORY_ACCOUNTS_PAGE_MISSING';break;}result.used.push(id);
  try{
   const response=read(id,page(account,anchorSlot,before),receipts,cutoff),rows=pageRows(response.value,response.at);
   if(response.at<Date.parse(window.end)||response.at<anchorRetrieved||response.at<lastRetrieved)fail('ADVISORY_ACCOUNTS_PAGE_TIME');
   for(const [i,row] of rows.entries()){if(seen.has(row.signature)||row.slot>lastSlot||row.blockTime!==null&&row.blockTime>lastAt)fail('ADVISORY_ACCOUNTS_PAGE_ORDER');seen.add(row.signature);lastSlot=row.slot;if(row.blockTime===null)unknown=true;else lastAt=row.blockTime;const t=(response.value as any[])[i]?.transactionIndex;result.indexes.set(row.signature,integer(t)?t:null);}
   result.rows.push(...rows);lastRetrieved=response.at;
   const dates=rows.flatMap(r=>r.blockTime===null?[]:[new Date(r.blockTime*1000).toISOString()]),exhausted=rows.length<PAGE_LIMIT,older=rows.some(r=>r.blockTime!==null&&r.blockTime*1000<Date.parse(window.start));
   result.pages.push({id,returned:rows.length,oldestAt:dates.at(-1)??null,newestAt:dates[0]??null,exhausted,status:unknown?'TRUNCATED':'OBSERVED'});
   if(older||exhausted){result.reached=true;result.status=unknown?'TRUNCATED':'OBSERVED';result.code=unknown?'ADVISORY_ACCOUNTS_NULL_CLOCK':undefined;break;}
   before=rows.at(-1)!.signature;
  }catch(error){const b=bad(error);result.pages.push({id,returned:0,oldestAt:null,newestAt:null,exhausted:false,...b});result.status=b.status;result.code=b.code;break;}
 }
 if(!result.code)delete result.code;return result;
}
const inWindow=(rows:SignatureRow[],window:{start:string;end:string})=>rows.filter(r=>r.err===null&&r.blockTime!==null&&r.blockTime*1000>=Date.parse(window.start)&&r.blockTime*1000<Date.parse(window.end));
/** Deterministic receipt keys for successful in-window transactions absent from the window namespace. */
function extraSignatures(indexes:Index[],windowValues:Map<string,unknown>,window:{start:string;end:string}){const extras:string[]=[];for(const x of indexes)if(x.status==='OBSERVED')for(const row of inWindow(x.rows,window))if(!windowValues.has(row.signature)&&!extras.includes(row.signature))extras.push(row.signature);return extras;}
const anchorClock=(receipts:ReceiptSet)=>Date.parse(receipts.retrievedAt['window-anchor-time']??'');

type TxView={pre:bigint|null;post:bigint|null;legs:Array<Omit<AccountLeg,'signature'|'slot'|'at'>>;lifecycle:Array<'INITIALIZED'|'CLOSED'>};
const inert=new Set(['approve','approveChecked','revoke','getAccountDataSize','initializeImmutableOwner']);
/** Executed target-mint legs for one token account, reconciled against raw pre/post balances. */
function accountView(value:any,account:string,mint:string,vault:string,bindings:Binding[]):TxView{
 const keys=value.transaction?.message?.accountKeys;if(!Array.isArray(keys)||keys.some((k:any)=>!object(k)||typeof k.pubkey!=='string'))fail('ADVISORY_ACCOUNTS_TRANSACTION_SHAPE');
 const position=keys.findIndex((k:any)=>k.pubkey===account);if(position<0)fail('ADVISORY_ACCOUNTS_ACCOUNT_ABSENT');
 const balance=(list:unknown)=>{if(!Array.isArray(list))fail('ADVISORY_ACCOUNTS_BALANCE_SHAPE');const entries=(list as any[]).filter(b=>object(b)&&b.accountIndex===position);if(entries.length>1)fail('ADVISORY_ACCOUNTS_BALANCE_SHAPE');const b=entries[0];if(!b)return null;if(b.mint!==mint||!object(b.uiTokenAmount))fail('ADVISORY_ACCOUNTS_BALANCE_MINT');return BigInt(atomic(b.uiTokenAmount.amount));};
 const view:TxView={pre:balance(value.meta.preTokenBalances),post:balance(value.meta.postTokenBalances),legs:[],lifecycle:[]};let initializedAt=-1,closedAt=-1,firstLeg=-1,lastLeg=-1;
 for(const [order,step] of steps(value).entries()){
  if(!step.executed||!tokenPrograms.has(step.ix.programId))continue;
  const p=parsedToken(step);
  if(!p){if(Array.isArray(step.ix.accounts)&&step.ix.accounts.includes(account))fail('ADVISORY_ACCOUNTS_UNPARSED_TOKEN_INSTRUCTION');continue;}
  const {type,info}=p,refers=JSON.stringify(info).includes(`"${account}"`);
  if(type==='transfer'||type==='transferChecked'){
   const t=transfer(step,mint);if(!t){if(refers)fail('ADVISORY_ACCOUNTS_TRANSFER_MINT');continue;}
   if(t.source!==account&&t.destination!==account)continue;
   const binding=bindings.find(b=>b.position===order&&b.account===account&&b.signature===value.transaction.signatures[0]);
   for(const incoming of [true,false]){
    if((incoming?t.destination:t.source)!==account)continue;const counterparty=incoming?t.source:t.destination;
    if(counterparty===vault&&!binding)fail('ADVISORY_ACCOUNTS_UNBOUND_POOL_LEG');
    view.legs.push({order,kind:binding?(binding.side==='BUY'?'POOL_BUY':'POOL_SELL'):incoming?'TRANSFER_IN':'TRANSFER_OUT',amountAtomic:t.amount,counterparty,trade:binding?.trade??null});
   }
  }else if(type==='mintTo'||type==='mintToChecked'||type==='burn'||type==='burnChecked'){
   if(info.account!==account){if(refers)fail('ADVISORY_ACCOUNTS_UNSUPPORTED_INSTRUCTION');continue;}
   if(info.mint!==mint)fail('ADVISORY_ACCOUNTS_TRANSFER_MINT');view.legs.push({order,kind:type.startsWith('mint')?'MINT':'BURN',amountAtomic:amountOf(info),counterparty:null,trade:null});
  }else if(['initializeAccount','initializeAccount2','initializeAccount3'].includes(type)){
   if(info.account!==account){if(refers)fail('ADVISORY_ACCOUNTS_UNSUPPORTED_INSTRUCTION');continue;}
   if(info.mint!==mint||initializedAt>=0)fail('ADVISORY_ACCOUNTS_LIFECYCLE');initializedAt=order;view.lifecycle.push('INITIALIZED');
  }else if(type==='closeAccount'){
   if(info.account!==account){if(refers)fail('ADVISORY_ACCOUNTS_UNSUPPORTED_INSTRUCTION');continue;}
   if(closedAt>=0)fail('ADVISORY_ACCOUNTS_LIFECYCLE');closedAt=order;view.lifecycle.push('CLOSED');
  }else if(!inert.has(type)&&refers)fail('ADVISORY_ACCOUNTS_UNSUPPORTED_INSTRUCTION');
  if(view.legs.length&&view.legs.at(-1)!.order===order){if(firstLeg<0)firstLeg=order;lastLeg=order;}
 }
 const net=view.legs.reduce((n,l)=>n+(['POOL_BUY','TRANSFER_IN','MINT'].includes(l.kind)?BigInt(l.amountAtomic):-BigInt(l.amountAtomic)),0n);
 // Absent raw balances stay unknown unless the same transaction proves the account was created or closed around its legs.
 const pre=view.pre??(initializedAt>=0&&(firstLeg<0||initializedAt<firstLeg)?0n:null),post=view.post??(closedAt>=0&&closedAt>lastLeg?0n:null);
 if(view.pre!==null&&initializedAt>=0||view.post!==null&&closedAt>=0)fail('ADVISORY_ACCOUNTS_LIFECYCLE');
 if(pre===null||post===null){if(view.legs.length||view.pre!==null||view.post!==null)fail('ADVISORY_ACCOUNTS_BALANCE_UNRECONCILED');}
 else if(post-pre!==net)fail('ADVISORY_ACCOUNTS_BALANCE_UNRECONCILED');
 return{...view,pre,post};
}

function emptyHistory(token:TokenRef,window:AdvisoryWindowHistory,reasonCode:string):WindowAccountHistory{
 return{method:'selected-window-trader-account-legs-v1',token,pool:window.pool,window:window.window,anchorSlot:window.anchorSlot,windowComplete:window.complete,population:0,accounts:[],receipts:0,receiptCap:ACCOUNT_RECEIPT_CAP,complete:false,reasonCode,limitations:[
  'Population is the user base-token accounts of decoded trades in one complete selected-pool hour; token accounts are not people and owners are not aggregated.',
  'Each account history covers only successful finalized transactions inside the declared half-open hour; counterparties are not covered or attributed.',
  'Failed transactions have no token effects; unsupported token instructions or unreconciled raw balances leave the account incomplete.']};
}
/** Reconstructs complete per-account token legs for every trader account of a complete selected-pool hour. */
export function decodeAdvisoryWindowAccounts(token:TokenRef,window:AdvisoryWindowHistory,windowReceipts:ReceiptSet,rawArtifacts:Record<string,string>,retrievedAt:Record<string,string>,requests:Record<string,Request>,cutoff:string):WindowAccountHistory{
 if(token.chain!=='solana'||window.token.address!==token.address||!Number.isFinite(Date.parse(cutoff))||Date.parse(window.window.end)>Date.parse(cutoff))fail('ADVISORY_ACCOUNTS_SCOPE');
 const rawKeys=Object.keys(rawArtifacts).sort();
 if(rawKeys.length>ACCOUNT_RECEIPT_CAP||JSON.stringify(rawKeys)!==JSON.stringify(Object.keys(requests).sort())||JSON.stringify(rawKeys)!==JSON.stringify(Object.keys(retrievedAt).sort()))fail('ADVISORY_ACCOUNTS_RECEIPT_MEMBERSHIP');
 const result=emptyHistory(token,window,'SELECTED_POOL_WINDOW_INCOMPLETE'),receipts={rawArtifacts,retrievedAt,requests},used=new Set<string>();result.receipts=rawKeys.length;
 const finish=()=>{if(rawKeys.some(k=>!used.has(k)))fail('ADVISORY_ACCOUNTS_RECEIPT_MEMBERSHIP');return result;};
 if(!window.complete||!window.pool||window.anchorSlot===null)return finish();
 let bound:ReturnType<typeof bindTrades>;
 try{bound=bindTrades(token,window,windowReceipts);}catch(error){result.reasonCode=errorCode(error);return finish();}
 const anchorRetrieved=anchorClock(windowReceipts);if(!Number.isFinite(anchorRetrieved))fail('ADVISORY_ACCOUNTS_ANCHOR');
 result.population=bound.accounts.length;
 const indexes=bound.accounts.map((account,k)=>index(k,account,window.anchorSlot!,anchorRetrieved,window.window,receipts,cutoff));
 for(const x of indexes)for(const id of x.used)used.add(id);
 const extras=extraSignatures(indexes,bound.values,window.window),extraValues=new Map<string,{value:any;at:number}|{error:unknown}>();
 extras.forEach((signature,j)=>{const id=`account-transaction-${j}`;if(!(id in requests))return;used.add(id);try{extraValues.set(signature,read(id,transaction(signature),receipts,cutoff));}catch(error){extraValues.set(signature,{error});}});
 for(const [k,account] of bound.accounts.entries()){
  const x=indexes[k]!,own=bound.bindings.filter(b=>b.account===account);
  const history:TraderAccountHistory={account,users:[...new Set(own.map(b=>b.user))].sort(),trades:own.map(b=>b.trade),status:x.status,...(x.code?{code:x.code}:{}),pages:x.pages,transactions:[],legs:[],startAtomic:null,endAtomic:null};
  result.accounts.push(history);if(x.status!=='OBSERVED')continue;
  try{
   const rows=inWindow(x.rows,window.window);if(own.some(b=>!rows.some(r=>r.signature===b.signature)))fail('ADVISORY_ACCOUNTS_INDEX_INCONSISTENT');
   const views:Array<{row:SignatureRow;order:number|null;view:TxView;receipt:'WINDOW'|'ACCOUNTS'}>=[];
   for(const row of rows){
    let value:any,receipt:'WINDOW'|'ACCOUNTS'='WINDOW';
    if(bound.values.has(row.signature))value=bound.values.get(row.signature);
    else{receipt='ACCOUNTS';const extra=extraValues.get(row.signature);if(!extra){history.status='TRUNCATED';history.code='ADVISORY_ACCOUNTS_RECEIPT_CAP';break;}if('error' in extra)throw extra.error;if(extra.at<row.blockTime!*1000)fail('ADVISORY_ACCOUNTS_TRANSACTION_TIME');value=extra.value;}
    if(!object(value)||value.slot!==row.slot||value.blockTime!==row.blockTime||value.transaction?.signatures?.[0]!==row.signature||!object(value.meta)||value.meta.err!==null||!['legacy',0,1].includes(value.version))fail('ADVISORY_ACCOUNTS_TRANSACTION_BINDING');
    const t=integer(value.transactionIndex)?value.transactionIndex:x.indexes.get(row.signature)??null;
    views.push({row,order:t,view:accountView(value,account,token.address,bound.vault,bound.bindings),receipt});
   }
   if(history.status!=='OBSERVED')continue;
   views.sort((a,b)=>a.row.slot-b.row.slot||(a.order??-1)-(b.order??-1));
   for(let i=1;i<views.length;i++){const p=views[i-1]!,n=views[i]!;if(p.row.slot===n.row.slot&&(p.order===null||n.order===null||p.order===n.order))fail('ADVISORY_ACCOUNTS_ORDER_AMBIGUOUS');}
   // Rows without raw balances or legs cannot interrupt the reconciled balance chain.
   const chain=views.filter(v=>v.view.pre!==null);
   for(let i=1;i<chain.length;i++)if(chain[i-1]!.view.post!==chain[i]!.view.pre)fail('ADVISORY_ACCOUNTS_CONTINUITY');
   if(own.some(b=>!views.some(v=>v.row.signature===b.signature&&v.view.legs.some(l=>l.trade===b.trade))))fail('ADVISORY_ACCOUNTS_TRADE_BINDING');
   for(const v of views){const at=new Date(v.row.blockTime!*1000).toISOString();history.transactions.push({signature:v.row.signature,slot:v.row.slot,at,receipt:v.receipt,preAtomic:v.view.pre===null?null:String(v.view.pre),postAtomic:v.view.post===null?null:String(v.view.post),lifecycle:v.view.lifecycle,legs:v.view.legs.length});history.legs.push(...v.view.legs.map(l=>({signature:v.row.signature,slot:v.row.slot,at,...l})));}
   history.startAtomic=chain[0]?String(chain[0].view.pre):null;history.endAtomic=chain.at(-1)?String(chain.at(-1)!.view.post):null;
  }catch(error){const b=bad(error);history.status=b.status;history.code=b.code;history.transactions=[];history.legs=[];}
 }
 result.complete=result.accounts.every(a=>a.status==='OBSERVED');
 result.reasonCode=result.complete?'TRADER_ACCOUNT_LEGS_OBSERVED':result.accounts.find(a=>a.status!=='OBSERVED')?.code??'TRADER_ACCOUNT_HISTORY_INCOMPLETE';
 return finish();
}

/** Bounded acquisition after a complete window: account indexes, then only receipts the window did not already retain. */
export async function collectAdvisoryWindowAccounts(token:TokenRef,window:ReceiptSet&{data:AdvisoryWindowHistory},rpcUrl:string,fetcher:typeof fetch,now:()=>string,signal?:AbortSignal):Promise<ReceiptSet&{data:WindowAccountHistory}>{
 if(token.chain!=='solana')fail('ADVISORY_ACCOUNTS_SCOPE');decodeSolanaAddress(token.address);
 const receipts:ReceiptSet={rawArtifacts:{},retrievedAt:{},requests:{}},data=window.data,decode=()=>decodeAdvisoryWindowAccounts(token,data,window,receipts.rawArtifacts,receipts.retrievedAt,receipts.requests,now());
 const run=async(id:string,request:Request)=>{
  if(Object.keys(receipts.requests).length>=ACCOUNT_RECEIPT_CAP)return false;receipts.requests[id]=request;
  try{await solanaRpc(rpcUrl,request.method,request.params,fetcher,500_000,signal,raw=>{receipts.rawArtifacts[id]=raw;receipts.retrievedAt[id]=now();});}
  catch(error){if(!receipts.rawArtifacts[id]){receipts.rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:safeRpcCode(error)}});receipts.retrievedAt[id]=now();}}
  return true;
 };
 let bound:ReturnType<typeof bindTrades>;try{bound=bindTrades(token,data,window);}catch{return{...receipts,data:decode()};}
 const anchorRetrieved=anchorClock(window);if(!Number.isFinite(anchorRetrieved)||data.anchorSlot===null)return{...receipts,data:decode()};
 const indexes:Index[]=[];
 for(const [k,account] of bound.accounts.entries()){
  let before:string|undefined;
  for(let p=0;p<PAGES_PER_ACCOUNT;p++){
   if(!await run(`account-${k}-page-${p}`,page(account,data.anchorSlot,before)))break;
   const current=index(k,account,data.anchorSlot,anchorRetrieved,data.window,receipts,now()),last=current.pages.at(-1);
   if(current.reached||!last||last.status==='INVALID'||last.status==='UNAVAILABLE')break;
   before=current.rows.at(-1)?.signature;if(!before)break;
  }
  indexes.push(index(k,account,data.anchorSlot,anchorRetrieved,data.window,receipts,now()));
 }
 const extras=extraSignatures(indexes,bound.values,data.window);
 for(let offset=0;offset<extras.length;offset+=2)await Promise.all(extras.slice(offset,offset+2).map((signature,j)=>run(`account-transaction-${offset+j}`,transaction(signature))));
 return{...receipts,data:decode()};
}

type Segment={legs:AccountLeg[]};
/** O26 over the complete trader-account population; null leaves the older bounded-sample derivation in place. */
export function deriveO26Window(history:WindowAccountHistory,window:AdvisoryWindowHistory,evidenceIds:string[]):AdvisoryMetric|null{
 if(!history.windowComplete||!window.complete)return null;
 const covered=history.accounts.filter(a=>a.status==='OBSERVED'),motifs:Array<{account:string;start:string;end:string;signatures:string[];legs:number;transferLegs:number;poolBuyBaseAtomic:string;poolSellBaseAtomic:string;transferInBaseAtomic:string;transferOutBaseAtomic:string;grossQuoteAtomic:string;netQuoteAtomic:string;proof:Array<{signature:string;slot:number;kind:AccountLeg['kind'];amountAtomic:string}>}>=[];
 let passThroughReturns=0,singleSidePoolReturns=0,transferOnlyReturns=0,openAccounts=0;
 const sum=(legs:AccountLeg[],kind:AccountLeg['kind'])=>String(legs.filter(l=>l.kind===kind).reduce((n,l)=>n+BigInt(l.amountAtomic),0n));
 for(const account of covered){
  let level=0n,segment:Segment={legs:[]};
  for(const leg of account.legs){
   const amount=BigInt(leg.amountAtomic);if(amount===0n)continue;
   level+=['POOL_BUY','TRANSFER_IN','MINT'].includes(leg.kind)?amount:-amount;segment.legs.push(leg);
   if(level!==0n)continue;
   const legs=segment.legs,buys=legs.filter(l=>l.kind==='POOL_BUY'),sells=legs.filter(l=>l.kind==='POOL_SELL');segment={legs:[]};
   if(!buys.length||!sells.length){passThroughReturns++;if(buys.length||sells.length)singleSidePoolReturns++;else transferOnlyReturns++;continue;}
   const quote=(l:AccountLeg)=>BigInt(window.trades[l.trade!]!.quoteAtomic);
   motifs.push({account:account.account,start:legs[0]!.at,end:legs.at(-1)!.at,signatures:[...new Set(legs.map(l=>l.signature))],legs:legs.length,transferLegs:legs.filter(l=>l.trade===null).length,
    poolBuyBaseAtomic:sum(legs,'POOL_BUY'),poolSellBaseAtomic:sum(legs,'POOL_SELL'),transferInBaseAtomic:sum(legs,'TRANSFER_IN'),transferOutBaseAtomic:sum(legs,'TRANSFER_OUT'),
    grossQuoteAtomic:String([...buys,...sells].reduce((n,l)=>n+quote(l),0n)),netQuoteAtomic:String(sells.reduce((n,l)=>n+quote(l),0n)-buys.reduce((n,l)=>n+quote(l),0n)),
    proof:legs.map(l=>({signature:l.signature,slot:l.slot,kind:l.kind,amountAtomic:l.amountAtomic}))});
  }
  if(segment.legs.length)openAccounts++;
 }
 const repeatedAccounts=[...new Set(motifs.map(m=>m.account))].filter(a=>motifs.filter(m=>m.account===a).length>=2).sort(),repeated=motifs.filter(m=>repeatedAccounts.includes(m.account));
 const gross=(list:typeof motifs)=>list.reduce((n,m)=>n+BigInt(m.grossQuoteAtomic),0n),coveredQuote=window.trades.reduce((n,t)=>n+BigInt(t.quoteAtomic),0n),motifQuote=gross(motifs);
 const quality=history.complete?'KNOWN':covered.length?'TRUNCATED':'MISSING';
 return{id:'O26',quality,unit:'inventory-return motifs in a complete selected-pool hour',evidenceIds:[...new Set(evidenceIds)],reasonCode:history.complete?'SELECTED_WINDOW_INVENTORY_RETURNS_OBSERVED':history.reasonCode,data:{
  method:'selected-window-inventory-return-v2',scope:'VERIFIED_PUMPSWAP_WSOL_POOL_HOUR_TRADER_TOKEN_ACCOUNTS',pool:window.pool,window:window.window,anchorSlot:window.anchorSlot,
  segmentRule:'Per token account, a segment closes at every exact return to its starting balance; a motif is a closed segment containing at least one selected-pool buy leg and one selected-pool sell leg.',
  population:history.population,coveredAccounts:covered.length,receipts:history.receipts,receiptCap:history.receiptCap,complete:history.complete,
  motifCount:motifs.length,repeatedAccounts,repeatedMotifCount:repeated.length,passThroughReturns,singleSidePoolReturns,transferOnlyReturns,openAccounts,motifs,
  quoteMint:wsol,quoteDecimals:9,quoteBasis:'fee-exclusive core quote of decoded window trades',
  motifGrossQuoteAtomic:String(motifQuote),repeatedMotifGrossQuoteAtomic:String(gross(repeated)),coveredTradeGrossQuoteAtomic:String(coveredQuote),motifQuoteShare:coveredQuote>0n&&history.complete?new Decimal(String(motifQuote)).div(String(coveredQuote)).toFixed():null,
  accounts:history.accounts,
  alternatives:['Arbitrage routing, market making or legitimate inventory rebalancing can produce the same motif.','Routers and shared pools do not establish common ownership.'],
  limitations:[...history.limitations,'Motifs crossing the window boundaries or linking several accounts are not detected; this is not a whole-token or whole-wallet wash-trading estimate.','A count of zero describes this declared population only.'],
 }};
}
