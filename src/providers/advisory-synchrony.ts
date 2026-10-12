import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { TokenRef } from '../domain/contracts.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import type { AdvisoryWindowHistory, AdvisoryWindowReuse } from './advisory-window.js';
import { decodeAdvisoryDemandWindows, demandArchiveSourceLimit, demandTransactionRequest, projectCompiledTransaction, unpackDemandReceipt, type DemandHistory, type DemandTrade } from './advisory-demand-windows.js';

/**
 * O23 over the complete A30 selected-pool tape and its retained receipts; it issues no reads of its own.
 * - Funding: the verified fee payer of each trade transaction (account 0, writable signer, positive meta.fee), classified against the decoded trade user.
 * - Behavior: trade side. A trade is synchronized when another trade in the same declared slot bin, from a different transaction and user, shares its sponsor and side.
 * - Null: transaction slots permuted within each UTC hour; every transaction keeps its fee payer, users, legs and sides.
 */
type Request={method:string;params:unknown[]};
type Receipts={rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;requests:Record<string,unknown>};
type Funding='SELF'|'SPONSORED'|'PROGRAM';
type Leg={user:string;side:'BUY'|'SELL';funding:Funding};
type Role={signature:string;slot:number;stratum:number;feePayer:string;legs:Leg[]};
type Bin={widthSlots:number;offsetSlots:number};
export const SYNCHRONY_METHOD='sponsored-fee-payer-synchrony-v1' as const;
// Declared before observation: one, ten and 150 slots; each wider bin is repeated with a half-width origin shift.
export const SYNCHRONY_BINS:readonly Bin[]=[{widthSlots:1,offsetSlots:0},{widthSlots:10,offsetSlots:0},{widthSlots:10,offsetSlots:5},{widthSlots:150,offsetSlots:0},{widthSlots:150,offsetSlots:75}];
export const SYNCHRONY_PERMUTATIONS=999;
const HOUR=3_600_000,HOURS=12,TOP_SPONSORS=10,UNIT='fraction-vector';
const RULES={
 funding:'Fee payer is account 0 of the trade transaction, a writable signer charged a positive meta.fee. SELF when it is the trade user; SPONSORED when the user is another transaction signer; PROGRAM when the user is CPI-authorized and signs nothing.',
 behavior:'Decoded trade side (BUY or SELL). Size is not used.',
 synchrony:'A SPONSORED trade with at least one other SPONSORED trade in the same slot bin, with the same fee payer and side, from a different transaction and a different user. Legs of one transaction never synchronize each other.',
 denominator:'Every decoded selected-pool trade in the complete twelve-hour tape, including SELF and PROGRAM trades.',
 bins:'Bin index floor((slot + offsetSlots) / widthSlots) for each declared width and offset.',
 nullModel:'Transaction slot labels permuted uniformly within each of the twelve UTC hours of the tape; fee payer, users, legs, sides and funding classes stay with their transaction and each hour keeps its slot multiset.',
 quantiles:'Order statistic k = ceil(q * permutations) of the sorted null counts.',
};
const LIMITATIONS=[
 'One verified PumpSwap WSOL pool and the twelve declared UTC hours of the A30 tape only; other pools, venues and wallets outside this pool tape are unobserved.',
 'A fee payer funds only the transaction fee. It is not incoming wallet funding, a common owner, a person or a control relationship; shared sponsors include relays and apps serving unrelated users.',
 'Co-signers that do not pay the fee carry no funding role.',
 'PROGRAM trades stay in the denominator and can never be synchronized because no sponsor relationship to their user is observed.',
 'Funding and behavior are independently specified facets of the same trades. Their co-occurrence is descriptive and is not proof of coordination.',
 'atLeastObserved counts null permutations with at least the observed synchronized trades; it is a descriptive rank under the declared null, not a probability of coordination, and it conditions on the per-hour slot multiset.',
 'Any incomplete tape, unreadable receipt or unverifiable fee role leaves every fraction null; the corpus is never shrunk to its verifiable part.',
];
function fail(code:string):never{throw new Error(code);}
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const errorCode=(error:unknown)=>error instanceof Error&&/^(ADVISORY_[A-Z0-9_]+|RPC_[A-Z0-9_-]{1,50})$/.test(error.message)?error.message:'ADVISORY_SYNCHRONY_RECEIPT_SHAPE';
// The exact O28 jsonParsed request that A30 reuses.
const windowTransactionRequest=(signature:string):Request=>({method:'getTransaction',params:[signature,{commitment:'finalized',encoding:'jsonParsed',maxSupportedTransactionVersion:1}]});

function read(id:string,expected:Request,set:Receipts,cutoff:number,archived:boolean):unknown{
 if(JSON.stringify(set.requests[id])!==JSON.stringify(expected)||typeof set.rawArtifacts[id]!=='string')fail('ADVISORY_SYNCHRONY_REQUEST');
 const at=Date.parse(set.retrievedAt[id]??'');if(!Number.isFinite(at)||at>cutoff)fail('ADVISORY_SYNCHRONY_RECEIPT_TIME');
 let raw:any=null;try{raw=JSON.parse(archived?unpackDemandReceipt(set.rawArtifacts[id]!,demandArchiveSourceLimit(id)):set.rawArtifacts[id]!);}catch{raw=null;}
 if(!object(raw)||raw.jsonrpc!=='2.0'||raw.id!==1||raw.error!==undefined||!Object.hasOwn(raw,'result'))fail('ADVISORY_SYNCHRONY_RECEIPT_SHAPE');
 return raw.result;
}
/** Re-reads every trade-bearing receipt under the A30 key plan; one unverifiable fee role fails the whole tape. */
function feeRoles(history:DemandHistory,windowReceipts:Receipts,demand:Receipts,cutoff:number):Role[]{
 const reusable=new Map<string,string>();for(const [key,request] of Object.entries(windowReceipts.requests))reusable.set(JSON.stringify(request),key);
 const bySignature=new Map<string,DemandTrade[]>();for(const t of history.trades){const list=bySignature.get(t.signature);if(list)list.push(t);else bySignature.set(t.signature,[t]);}
 const start=Date.parse(history.range.start),roles:Role[]=[];let fresh=0;
 for(const t of history.transactions){
  // Fresh keys follow index order exactly as A30 assigned them.
  const id=t.receipt==='DEMAND'?`demand-transaction-${fresh++}`:reusable.get(JSON.stringify(windowTransactionRequest(t.signature))),trades=bySignature.get(t.signature);
  if(!trades)continue;
  if(t.status!=='OBSERVED'||id===undefined)fail('ADVISORY_SYNCHRONY_REQUEST');
  const value:any=t.receipt==='DEMAND'?projectCompiledTransaction(read(id,demandTransactionRequest(t.signature),demand,cutoff,true)):read(id,windowTransactionRequest(t.signature),windowReceipts,cutoff,false);
  if(!object(value)||!object(value.meta)||!object(value.transaction)||!Array.isArray(value.transaction.signatures)||value.transaction.signatures[0]!==t.signature||value.slot!==t.slot||!Number.isSafeInteger(value.blockTime)||new Date(value.blockTime*1000).toISOString()!==t.at||value.meta.err!==null)fail('ADVISORY_SYNCHRONY_BINDING');
  const keys:unknown=value.transaction.message?.accountKeys,payer=Array.isArray(keys)?keys[0]:null,fee=value.meta.fee;
  if(!Array.isArray(keys)||!object(payer)||typeof payer.pubkey!=='string'||payer.signer!==true||payer.writable!==true||!Number.isSafeInteger(fee)||fee<=0)fail('ADVISORY_SYNCHRONY_FEE_ROLE');
  const stratum=Math.floor((Date.parse(t.at)-start)/HOUR);if(!(stratum>=0&&stratum<HOURS))fail('ADVISORY_SYNCHRONY_BINDING');
  roles.push({signature:t.signature,slot:t.slot,stratum,feePayer:payer.pubkey,legs:trades.map((trade):Leg=>{
   const key=keys.find(k=>object(k)&&k.pubkey===trade.user);
   if(!object(key)||typeof key.signer!=='boolean')fail('ADVISORY_SYNCHRONY_FEE_ROLE');
   return{user:trade.user,side:trade.side,funding:!key.signer?'PROGRAM':trade.user===payer.pubkey?'SELF':'SPONSORED'};
  })});
 }
 if(roles.reduce((n,r)=>n+r.legs.length,0)!==history.trades.length)fail('ADVISORY_SYNCHRONY_BINDING');
 return roles;
}
/** Trades with a same-bin, same-sponsor, same-side partner outside both their own transaction and their own user. */
function synchronized(roles:Role[],slots:number[],bin:Bin):number{
 const groups=new Map<string,Array<[string,string]>>();
 roles.forEach((role,i)=>{
  const b=Math.floor((slots[i]!+bin.offsetSlots)/bin.widthSlots);
  for(const leg of role.legs)if(leg.funding==='SPONSORED'){const key=`${b}|${role.feePayer}|${leg.side}`,group=groups.get(key);if(group)group.push([role.signature,leg.user]);else groups.set(key,[[role.signature,leg.user]]);}
 });
 let n=0;
 for(const group of groups.values()){
  if(group.length<2)continue;
  const tally=new Map<string,number>(),add=(k:string)=>tally.set(k,(tally.get(k)??0)+1);
  for(const [signature,user] of group){add(`s|${signature}`);add(`u|${user}`);add(`b|${signature}|${user}`);}
  // Inclusion-exclusion: members outside this trade transaction and this user.
  for(const [signature,user] of group)if(group.length-tally.get(`s|${signature}`)!-tally.get(`u|${user}`)!+tally.get(`b|${signature}|${user}`)!>0)n++;
 }
 return n;
}
/** Counter-mode SHA-256 words with rejection sampling: unbiased, seeded and platform independent. */
function draws(seed:string):(n:number)=>number{
 let counter=0,offset=32,block=Buffer.alloc(32);
 const word=()=>{if(offset===32){block=createHash('sha256').update(`${seed}:${counter++}`).digest();offset=0;}const v=block.readUInt32BE(offset);offset+=4;return v;};
 return n=>{const limit=Math.floor(0x1_0000_0000/n)*n;for(;;){const v=word();if(v<limit)return v%n;}};
}

/** O23 from the same receipts A30 decodes; null keeps the existing missing row when the tape is not eligible. */
export function deriveO23Synchrony(token:TokenRef,window:AdvisoryWindowHistory,windowReceipts:AdvisoryWindowReuse,rawArtifacts:Record<string,string>,retrievedAt:Record<string,string>,requests:Record<string,Request>,cutoff:string,evidenceIds:string[]):AdvisoryMetric|null{
 const history=decodeAdvisoryDemandWindows(token,window,windowReceipts,rawArtifacts,retrievedAt,requests,cutoff);
 if(!history.eligible)return null;
 const ids=[...new Set(evidenceIds)];
 const scope={method:SYNCHRONY_METHOD,tapeMethod:history.method,scope:'VERIFIED_PUMPSWAP_WSOL_POOL',pool:history.pool,range:history.range,anchorSlot:history.anchorSlot,stateSlot:history.stateSlot,tapeComplete:history.complete,
  identityUnit:'decoded PumpSwap trade user account and transaction fee payer; never merged and not a person',rules:RULES,permutations:SYNCHRONY_PERMUTATIONS,commonControl:null,coordination:null,limitations:LIMITATIONS};
 const missing=(reasonCode:string,denominator:number|null):AdvisoryMetric=>({id:'O23',quality:'MISSING',unit:UNIT,evidenceIds:ids,reasonCode,data:{...scope,denominator,fundingClasses:null,transactions:null,sponsors:null,seed:null,
  bins:SYNCHRONY_BINS.map(bin=>({...bin,synchronizedTrades:null,fraction:null,null:null}))}});
 if(!history.complete)return missing(history.reasonCode,null);
 let roles:Role[];
 try{roles=feeRoles(history,windowReceipts,{rawArtifacts,retrievedAt,requests},Date.parse(cutoff));}catch(error){return missing(errorCode(error),null);}
 const denominator=history.trades.length;
 if(!denominator)return missing('SYNCHRONY_DENOMINATOR_ZERO',0);
 const observed=roles.map(r=>r.slot),strata=Array.from({length:HOURS},(_,h)=>roles.flatMap((r,i)=>r.stratum===h?[i]:[]));
 const seed=createHash('sha256').update(JSON.stringify([SYNCHRONY_METHOD,history.pool,history.range.end,roles.map(r=>r.signature)])).digest('hex');
 const random=draws(seed),nulls=SYNCHRONY_BINS.map(()=>[] as number[]);
 for(let p=0;p<SYNCHRONY_PERMUTATIONS;p++){
  const slots=[...observed];
  for(const members of strata){
   const labels=members.map(i=>observed[i]!);
   for(let i=labels.length-1;i>0;i--){const j=random(i+1);[labels[i],labels[j]]=[labels[j]!,labels[i]!];}
   members.forEach((m,k)=>{slots[m]=labels[k]!;});
  }
  SYNCHRONY_BINS.forEach((bin,b)=>nulls[b]!.push(synchronized(roles,slots,bin)));
 }
 const fraction=(n:number)=>new Decimal(n).div(denominator).toFixed(),order=(sorted:number[],q:number)=>fraction(sorted[Math.ceil(q*sorted.length)-1]!);
 const bins=SYNCHRONY_BINS.map((bin,b)=>{
  const count=synchronized(roles,observed,bin),sorted=[...nulls[b]!].sort((x,y)=>x-y);
  return{...bin,synchronizedTrades:count,fraction:fraction(count),null:{permutations:sorted.length,meanFraction:new Decimal(sorted.reduce((s,x)=>s+x,0)).div(sorted.length*denominator).toFixed(),
   minFraction:fraction(sorted[0]!),q05Fraction:order(sorted,0.05),medianFraction:order(sorted,0.5),q95Fraction:order(sorted,0.95),maxFraction:fraction(sorted.at(-1)!),atLeastObserved:sorted.filter(x=>x>=count).length}};
 });
 const classes={SELF:0,SPONSORED:0,PROGRAM:0},sponsors=new Map<string,{trades:number;transactions:number;users:Set<string>}>();
 for(const role of roles){
  for(const l of role.legs)classes[l.funding]++;
  const legs=role.legs.filter(l=>l.funding==='SPONSORED');if(!legs.length)continue;
  const s=sponsors.get(role.feePayer)??{trades:0,transactions:0,users:new Set<string>()};s.trades+=legs.length;s.transactions++;for(const l of legs)s.users.add(l.user);sponsors.set(role.feePayer,s);
 }
 const top=[...sponsors].map(([feePayer,s])=>({feePayer,sponsoredTrades:s.trades,transactions:s.transactions,distinctUsers:s.users.size})).sort((a,b)=>b.sponsoredTrades-a.sponsoredTrades||a.feePayer.localeCompare(b.feePayer)).slice(0,TOP_SPONSORS);
 return{id:'O23',quality:'KNOWN',unit:UNIT,evidenceIds:ids,reasonCode:'SPONSORED_SYNCHRONY_OBSERVED',data:{...scope,denominator,fundingClasses:classes,
  transactions:{withTrades:roles.length,sponsored:roles.filter(r=>r.legs.some(l=>l.funding==='SPONSORED')).length,multiLeg:roles.filter(r=>r.legs.length>1).length},
  sponsors:{accounts:sponsors.size,top},seed,bins}};
}
