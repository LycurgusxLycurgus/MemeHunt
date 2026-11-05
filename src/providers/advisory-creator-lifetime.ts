import { PublicKey } from '@solana/web3.js';
import { Decimal } from 'decimal.js';
import type { TokenRef } from '../domain/contracts.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import { PUMP_CREATE_ABI_HASH, PUMP_CREATE_ABI_SOURCE, PUMP_PROGRAM } from './advisory-creator-role.js';
import { CREATOR_PENDING_PREMISES, creatorPageRequest, creatorTransactionRequest, decodeCreatorInventory, type CreatorInventoryReceipts, type CreatorReuse, type CreatorRole, type CreatorTape } from './advisory-creator-inventory.js';
import { executedWindowInstructions } from './advisory-window-accounts.js';
import { LEGACY_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, decodeSolanaAddress } from './solana.js';

/** O25 for the S13 creation signer: lifetime cost, age, realized and current-sell vector of its target-mint holdings, read only from O24's verified inventory receipts and priced only by Pump's own TradeEvent and exact lamport legs. */
export const CREATOR_LIFETIME_METHOD='creator-lifetime-on-inventory-v1' as const;
// Pinned from the same official pump.json (PUMP_CREATE_ABI_HASH): TradeEvent discriminator, the advertised trade instructions that emit it and, per supported instruction, its ordered fixed accounts ('+' = writable; user is the signer) and Borsh arguments (two u64, then one-byte 0/1 OptionBools that may only be omitted from the end).
// buy_exact_quote_in_v2 is advertised but unsupported: its exact-quote input carries no exact token amount, so such a trade leaves O25 unresolved.
export const PUMP_TRADE_ABI={
 eventDiscriminator:[189,219,127,211,78,230,97,238],
 buys:{buy:[102,6,61,18,1,218,235,234],buy_v2:[184,23,238,97,103,197,211,61],buy_exact_quote_in_v2:[194,171,28,70,104,77,91,47]},
 sells:{sell:[51,230,133,164,1,127,131,173],sell_v2:[93,246,130,60,231,233,64,178]},
 layouts:{
  buy:{accounts:'global fee_recipient+ mint bonding_curve+ associated_bonding_curve+ associated_user+ user+ system_program token_program creator_vault+ event_authority program global_volume_accumulator user_volume_accumulator+ fee_config fee_program',optionBools:2},
  buy_v2:{accounts:'global base_mint quote_mint base_token_program quote_token_program associated_token_program fee_recipient+ associated_quote_fee_recipient+ buyback_fee_recipient+ associated_quote_buyback_fee_recipient+ bonding_curve+ associated_base_bonding_curve+ associated_quote_bonding_curve+ user+ associated_base_user+ associated_quote_user+ creator_vault+ associated_creator_vault+ sharing_config global_volume_accumulator user_volume_accumulator+ associated_user_volume_accumulator+ fee_config fee_program system_program event_authority program',optionBools:1},
  sell:{accounts:'global fee_recipient+ mint bonding_curve+ associated_bonding_curve+ associated_user+ user+ system_program creator_vault+ token_program event_authority program fee_config fee_program',optionBools:0},
  sell_v2:{accounts:'global base_mint quote_mint base_token_program quote_token_program associated_token_program fee_recipient+ associated_quote_fee_recipient+ buyback_fee_recipient+ associated_quote_buyback_fee_recipient+ bonding_curve+ associated_base_bonding_curve+ associated_quote_bonding_curve+ user+ associated_base_user+ associated_quote_user+ creator_vault+ associated_creator_vault+ sharing_config user_volume_accumulator+ associated_user_volume_accumulator+ fee_config fee_program system_program event_authority program',optionBools:0},
 },
 unsupported:['buy_exact_quote_in_v2'],
 associatedTokenProgram:'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
 feeProgram:'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
 feeConfigSeed:[1,86,224,246,147,102,90,207,68,219,21,104,191,23,91,170,81,137,203,151,245,210,255,59,101,93,43,182,253,109,24,176],
 sharingConfigProgram:[12,53,255,169,5,90,142,86,141,168,247,188,7,86,21,39,76,241,201,44,164,31,64,0,156,81,106,164,20,194,124,112],
} as const;
// TradeEvent fields appended after creator_fee, in IDL order; an older event may end after any complete field.
const TAIL=[['trackVolume','bool'],['totalUnclaimedTokens','u64'],['totalClaimedTokens','u64'],['currentSolVolume','u64'],['lastUpdateTimestamp','i64'],['ixName','string'],['mayhemMode','bool'],['cashbackFeeBasisPoints','u64'],['cashback','u64'],['buybackFeeBasisPoints','u64'],['buybackFee','u64'],['shareholders','shareholders'],['quoteMint','key'],['quoteAmount','u64'],['virtualQuoteReserves','u64'],['realQuoteReserves','u64'],['holderRewardsBps','u64'],['holderRewards','u64'],['creatorFeeUnclaimed','u64']] as const;
const AGE_BANDS=[['LT_1H',0,3_600],['1H_6H',3_600,21_600],['6H_24H',21_600,86_400],['1D_7D',86_400,604_800],['GE_7D',604_800,null]] as const;
// Entry cost in lamports per whole token (10^decimals atomic units).
const COST_BANDS=[['LT_100',0,100],['100_1K',100,1_000],['1K_10K',1_000,10_000],['10K_100K',10_000,100_000],['GE_100K',100_000,null]] as const;
const BASE58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',SYSTEM='11111111111111111111111111111111',WSOL='So11111111111111111111111111111111111111112',TX='creator-tx-',SIGNATURE=/^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const EVENT_IX_TAG=Buffer.from('e445a52e51cb9a1d','hex'),TRADE_TAG=Buffer.from(PUMP_TRADE_ABI.eventDiscriminator);
const PUMP=new PublicKey(PUMP_PROGRAM),pda=(...seeds:Buffer[])=>PublicKey.findProgramAddressSync(seeds,PUMP)[0].toBase58();
const EVENT_AUTHORITY=pda(Buffer.from('__event_authority'));
const tokenPrograms=new Set([LEGACY_TOKEN_PROGRAM,TOKEN_2022_PROGRAM]);
// Initialization forms move no amount; every other parsed token form naming the canonical account is a leg that must belong to a priced trade.
const INIT_FORMS=new Set(['initializeAccount','initializeAccount2','initializeAccount3','initializeImmutableOwner','getAccountDataSize']);
const LIMITATIONS=[
 'Cohort is the S13 signed creation key (CREATOR_ONLY) as recomputed for O24; it is not a person, team or every wallet the creator may control.',
 'Lifetime coverage is the canonical account index exhausted at the O24 head slot plus the O24 whole-wallet exclusion of every other creator-owned target-mint account from creation through the catalog slot; a canonical receipt O24 did not inspect leaves O25 truncated, and no extra read is made.',
 'Lot cost is the creator-borne quote of each verified Pump bonding-curve trade: core sol_amount plus protocol, buyback and creator fees reconciled exactly against lamport deltas. Network fees and creator-funded account deposits are reported separately and excluded; a creator fee paid into the creator own vault is flagged, not netted.',
 'Deposits are exact for pre-existing accounts; for an account created in the same transaction the deposit is the bounded residual above its Pump leg.',
 'Index completeness is a provider property pinned to finalized context slots, not a cryptographic archive.',
 'Holdings are those at the O24 head slot and ages are measured at the cutoff; with zero held units every band amount is zero and every share of held units is undefined.',
 'The realized fraction is units disposed through verified Pump sells divided by units the creator acquired; it is not a supply share, a probability of selling or profit.',
 'No USD valuation, PnL or tracker-reported value is used.',
];

type Request={method:string;params:unknown[]};
type Row={signature:string;slot:number;blockTime:number;err:unknown;transactionIndex:number|null};
type Steps=ReturnType<typeof executedWindowInstructions>;
type Read=(id:string,expected:Request)=>{value:any;at:number};
type TradeEvent={timestamp:bigint;feeBasisPoints:bigint;creatorFeeBasisPoints:bigint;mint:string;solAmount:bigint;tokenAmount:bigint;isBuy:boolean;user:string;feeRecipient:string;fee:bigint;creator:string;creatorFee:bigint;tail:Record<string,unknown>;tailFields:number};
type Events={list:Steps;found:Array<{event:TradeEvent;top:number}>};
type Balance={pre:bigint;post:bigint;decimals:number;created:boolean};
type Entry={signature:string;slot:number;blockTime:number;side:'BUY'|'SELL';instruction:string;ixName:string|null;units:bigint;decimals:number;coreQuote:bigint;protocolFee:bigint;buybackFee:bigint;creatorFee:bigint;creatorFeeToOwnVault:boolean;feeModel:string;userQuote:bigint;networkFee:bigint;deposits:bigint;canonicalPre:bigint;canonicalPost:bigint;eventTailFields:number};

class Unresolved extends Error {}
function fail(code:string):never{throw new Error(code);}
function unresolved(code:string):never{throw new Unresolved(code);}
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const iso=(seconds:number)=>new Date(seconds*1000).toISOString();
function bytes58(s:unknown):Buffer{
 if(typeof s!=='string'||!s.length||s.length>4000||!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s))unresolved('O25_ENCODING');
 let n=0n;for(const c of s)n=n*58n+BigInt(BASE58.indexOf(c));
 const hex=n.toString(16),body=n===0n?Buffer.alloc(0):Buffer.from(hex.length%2?'0'+hex:hex,'hex');
 return Buffer.concat([Buffer.alloc(s.match(/^1*/)![0].length),body]);
}
function eventReader(b:Buffer){
 let o=0;
 const take=(n:number)=>{if(o+n>b.length)unresolved('O25_EVENT_TRUNCATED');const s=b.subarray(o,o+n);o+=n;return s;};
 return{
  left:()=>b.length-o,key:()=>new PublicKey(take(32)).toBase58(),u64:()=>take(8).readBigUInt64LE(0),i64:()=>take(8).readBigInt64LE(0),u16:()=>take(2).readUInt16LE(0),u32:()=>take(4).readUInt32LE(0),
  bool:()=>{const v=take(1)[0];if(v!==0&&v!==1)unresolved('O25_EVENT_BOOL');return v===1;},
  string:()=>{const n=take(4).readUInt32LE(0);if(n>64)unresolved('O25_EVENT_STRING');try{return new TextDecoder('utf-8',{fatal:true}).decode(take(n));}catch{return unresolved('O25_EVENT_STRING');}},
 };
}
/** Pinned TradeEvent of the target mint: fixed prefix through creator_fee, then appended IDL fields; other mints are skipped before any further decode. */
export function decodePumpTradeEvent(data:Buffer,mint:string):TradeEvent|null{
 if(data.length<16||!data.subarray(0,8).equals(EVENT_IX_TAG)||!data.subarray(8,16).equals(TRADE_TAG))return null;
 const r=eventReader(data.subarray(16));
 if(r.key()!==mint)return null;
 const solAmount=r.u64(),tokenAmount=r.u64(),isBuy=r.bool(),user=r.key(),timestamp=r.i64();
 for(let i=0;i<4;i++)r.u64(); // virtual/real SOL and token reserves are not O25 inputs
 const feeRecipient=r.key(),feeBasisPoints=r.u64(),fee=r.u64(),creator=r.key(),creatorFeeBasisPoints=r.u64(),creatorFee=r.u64();
 const tail:Record<string,unknown>={};let tailFields=0;
 for(const [name,type] of TAIL){
  if(!r.left())break;
  if(type==='shareholders'){const n=r.u32();if(n>16)unresolved('O25_EVENT_SHAREHOLDERS');tail[name]=Array.from({length:n},()=>({address:r.key(),shareBps:r.u16()}));}
  else tail[name]=type==='bool'?r.bool():type==='u64'?r.u64():type==='i64'?r.i64():type==='string'?r.string():r.key();
  tailFields++;
 }
 if(r.left())unresolved('O25_EVENT_UNPINNED_TAIL');
 return{timestamp,feeBasisPoints,creatorFeeBasisPoints,mint,solAmount,tokenAmount,isBuy,user,feeRecipient,fee,creator,creatorFee,tail,tailFields};
}
const instructionName=(tag:Buffer,isBuy:boolean)=>Object.entries(isBuy?PUMP_TRADE_ABI.buys:PUMP_TRADE_ABI.sells).find(([,d])=>tag.equals(Buffer.from(d)))?.[0]??null;
const ATA_PROGRAM=new PublicKey(PUMP_TRADE_ABI.associatedTokenProgram),FEE_PROGRAM=new PublicKey(PUMP_TRADE_ABI.feeProgram),SHARING_PROGRAM=new PublicKey(Uint8Array.from(PUMP_TRADE_ABI.sharingConfigProgram));
const seed=(a:string)=>new PublicKey(a).toBuffer(),derived=(program:PublicKey,...seeds:Buffer[])=>PublicKey.findProgramAddressSync(seeds,program)[0].toBase58();
const ata=(owner:string,program:string,mint:string)=>derived(ATA_PROGRAM,seed(owner),seed(program),seed(mint)),quoteAta=(owner:string)=>ata(owner,LEGACY_TOKEN_PROGRAM,WSOL);
type Bound={instruction:string;amount:bigint;limit:bigint;optionBools:number[];buyback:Set<string>};
/** The executed top-level trade instruction must be one supported pinned-IDL encoding: exact Borsh arguments (only trailing OptionBools may be absent, as the actual launch buy_v2 shows), every fixed account by position with PDAs re-derived, constants equal, IDL writable flags and the creator as signer, remaining accounts only after every fixed role, and exact-token amount semantics. */
export function bindPumpTradeInstruction(ix:any,flags:Map<string,any>,role:CreatorRole,account:string,event:TradeEvent,quote?:{mint:string;program:string}):Bound{
 const data=bytes58(ix.data),instruction=instructionName(data.subarray(0,8),event.isBuy);
 if(!instruction)unresolved('O25_TRADE_INSTRUCTION');
 const layout=quote&&instruction==='buy_exact_quote_in_v2'?PUMP_TRADE_ABI.layouts.buy_v2:(PUMP_TRADE_ABI.layouts as Record<string,{accounts:string;optionBools:number}|undefined>)[instruction];
 if(!layout)unresolved('O25_TRADE_VARIANT_UNSUPPORTED');
 const args=data.subarray(8),optionBools=[...args.subarray(16)];
 if(args.length<16||optionBools.length>layout.optionBools||optionBools.some(b=>b>1))unresolved('O25_TRADE_ARGS');
 const roles=layout.accounts.split(' '),names=roles.map(r=>r.replace('+','')),accounts:unknown[]=ix.accounts,at=(name:string)=>accounts[names.indexOf(name)] as string;
 if(accounts.length<roles.length||!accounts.every(a=>typeof a==='string'&&flags.has(a)))unresolved('O25_TRADE_ROLE');
 const base=at(names.includes('token_program')?'token_program':'base_token_program');
 if(!tokenPrograms.has(base))unresolved('O25_TRADE_ROLE');
 const quoteMint=quote?.mint??WSOL,quoteProgram=quote?.program??LEGACY_TOKEN_PROGRAM;
 const quoteAta=(owner:string)=>ata(owner,quoteProgram,quoteMint);
 if(!tokenPrograms.has(quoteProgram))unresolved('O25_TRADE_ROLE');
 const curve=pda(Buffer.from('bonding-curve'),seed(role.mint)),vault=pda(Buffer.from('creator-vault'),seed(event.creator)),volume=pda(Buffer.from('user_volume_accumulator'),seed(role.wallet));
 // Expected account per IDL role; null marks a role the IDL leaves unconstrained (buyback recipient, the ignored SOL-trade quote user account).
 const want:Record<string,()=>string|null>={
  global:()=>pda(Buffer.from('global')),fee_recipient:()=>event.feeRecipient,mint:()=>role.mint,base_mint:()=>role.mint,quote_mint:()=>quoteMint,
  token_program:()=>base,base_token_program:()=>base,quote_token_program:()=>quoteProgram,associated_token_program:()=>ATA_PROGRAM.toBase58(),system_program:()=>SYSTEM,
  associated_quote_fee_recipient:()=>quoteAta(event.feeRecipient),buyback_fee_recipient:()=>null,associated_quote_buyback_fee_recipient:()=>quoteAta(at('buyback_fee_recipient')),
  bonding_curve:()=>curve,associated_bonding_curve:()=>ata(curve,base,role.mint),associated_base_bonding_curve:()=>ata(curve,base,role.mint),associated_quote_bonding_curve:()=>quoteAta(curve),
  user:()=>role.wallet,associated_user:()=>account,associated_base_user:()=>account,associated_quote_user:()=>quote?quoteAta(role.wallet):null,
  creator_vault:()=>vault,associated_creator_vault:()=>quoteAta(vault),sharing_config:()=>derived(SHARING_PROGRAM,Buffer.from('sharing-config'),seed(role.mint)),
  global_volume_accumulator:()=>pda(Buffer.from('global_volume_accumulator')),user_volume_accumulator:()=>volume,associated_user_volume_accumulator:()=>quoteAta(volume),
  fee_config:()=>derived(FEE_PROGRAM,Buffer.from('fee_config'),Buffer.from(PUMP_TRADE_ABI.feeConfigSeed)),fee_program:()=>FEE_PROGRAM.toBase58(),event_authority:()=>EVENT_AUTHORITY,program:()=>PUMP_PROGRAM,
 };
 roles.forEach((r,i)=>{
  const name=r.replace('+',''),a=accounts[i] as string,f=flags.get(a),expected=want[name]?.();
  if(expected===undefined||(expected!==null&&a!==expected)||(r.endsWith('+')&&f.writable!==true)||(name==='user'&&f.signer!==true))unresolved('O25_TRADE_ROLE');
 });
 if(account!==ata(role.wallet,base,role.mint))unresolved('O25_TRADE_ROLE');
 const ixName=event.tail.ixName;
 if(ixName!==undefined&&ixName!==(instruction==='buy_exact_quote_in_v2'?'buy_exact_quote_in':event.isBuy?'buy':'sell'))unresolved('O25_TRADE_INSTRUCTION');
 // Ordinary exact-token trades: the amount argument is the executed token amount (a partial fill short of it is unsupported). The core-quote bound is only a cheap first gate; trade() checks the limit against the reconciled post-fee user quote.
 const amount=args.readBigUInt64LE(0),limit=args.readBigUInt64LE(8);
 if(amount===0n||(quote&&instruction==='buy_exact_quote_in_v2'?event.tokenAmount<limit:amount!==event.tokenAmount)||(instruction!=='buy_exact_quote_in_v2'&&(event.isBuy?limit<(quote?event.tail.quoteAmount as bigint:event.solAmount):limit>(quote?event.tail.quoteAmount as bigint:event.solAmount))))unresolved('O25_TRADE_AMOUNT');
 return{instruction,amount:instruction==='buy_exact_quote_in_v2'?event.tokenAmount:amount,limit:instruction==='buy_exact_quote_in_v2'?amount:limit,optionBools,buyback:new Set(names.includes('buyback_fee_recipient')?[at('buyback_fee_recipient')]:accounts.slice(roles.length) as string[])};
}

/** Read-only view of O24's own receipts and its exact reuse map: same ids, requests, bodies and clocks; nothing is rewritten. */
function projection(r:CreatorInventoryReceipts,reuse:CreatorReuse,cutoff:number){
 const reused=new Set<string>();
 const read:Read=(id,expected)=>{
  const own=Object.hasOwn(r.requests,id),shared=!own&&id.startsWith(TX)?reuse.get(id.slice(TX.length)):undefined;
  if(!own&&!shared)unresolved('O25_RECEIPT_ABSENT');
  if(shared)reused.add(shared.id);
  const request=shared?shared.request:r.requests[id],text:unknown=shared?shared.raw:r.rawArtifacts[id],time=shared?shared.retrievedAt:r.retrievedAt[id];
  if(JSON.stringify(request)!==JSON.stringify(expected)||typeof text!=='string')fail('O25_RECEIPT_REQUEST');
  const at=Date.parse(time??'');if(!Number.isFinite(at)||at>cutoff)fail('O25_RECEIPT_CLOCK');
  let raw:any;try{raw=JSON.parse(text as string);}catch{fail('O25_RECEIPT_SHAPE');}
  if(!object(raw)||raw.jsonrpc!=='2.0'||raw.id!==1||raw.error!==undefined||!Object.hasOwn(raw,'result'))fail('O25_RECEIPT_SHAPE');
  return{value:raw.result,at};
 };
 return{read,reused};
}
function rowsOf(value:unknown,at:number):Row[]{
 if(!Array.isArray(value))fail('O25_PROJECTION_INCONSISTENT');
 return value.map((v:unknown)=>{
  if(!object(v)||typeof v.signature!=='string'||!SIGNATURE.test(v.signature)||!integer(v.slot)||!integer(v.blockTime)||v.blockTime*1000>at||!('err' in v)||!(v.err===null||object(v.err)))fail('O25_PROJECTION_INCONSISTENT');
  return{signature:v.signature,slot:v.slot,blockTime:v.blockTime,err:v.err,transactionIndex:integer(v.transactionIndex)?v.transactionIndex:null};
 });
}
function transaction(read:Read,row:Row){
 const {value,at}=read(`${TX}${row.signature}`,creatorTransactionRequest(row.signature));
 if(!object(value)||value.slot!==row.slot||value.blockTime!==row.blockTime||value.transaction?.signatures?.[0]!==row.signature||!object(value.meta)||value.meta.err!==null||!['legacy',0,1].includes(value.version)||at<row.blockTime*1000)unresolved('O25_TRANSACTION_BINDING');
 return value;
}
/** Executed target-mint TradeEvent self-CPIs in the receipt's complete runtime trace; rolled-back frames carry no trade. */
function creatorEvents(value:any,role:CreatorRole):Events{
 let list:Steps;
 try{list=executedWindowInstructions(value);}catch{unresolved('O25_RUNTIME_TRACE_UNRESOLVED');}
 const found:Events['found']=[];
 for(const s of list){
  if(s.depth<2||s.ix.programId!==PUMP_PROGRAM||typeof s.ix.data!=='string')continue;
  const event=decodePumpTradeEvent(bytes58(s.ix.data),role.mint);
  if(!event||!s.executed)continue;
  if(s.depth!==2||!Array.isArray(s.ix.accounts)||s.ix.accounts.length!==1||s.ix.accounts[0]!==EVENT_AUTHORITY)unresolved('O25_EVENT_AUTHORITY');
  found.push({event,top:s.top});
 }
 return{list,found};
}
const leg=(s:Steps[number],account:string)=>{
 if(!tokenPrograms.has(s.ix.programId))return false;
 const p=s.ix.parsed;if(!object(p)||typeof p.type!=='string'||!object(p.info))unresolved('O25_TOKEN_FORM_UNRESOLVED');
 return !INIT_FORMS.has(p.type)&&[p.info.source,p.info.destination,p.info.account].includes(account);
};
/** Canonical-account balance of one receipt; an absent pre is allowed only for an account this receipt created, an absent post is an unsupported close. */
function canonicalBalance(value:any,role:CreatorRole,account:string):Balance{
 const keys=value.transaction?.message?.accountKeys,meta=value.meta;
 if(!Array.isArray(keys)||!Array.isArray(meta.preTokenBalances)||!Array.isArray(meta.postTokenBalances)||!Array.isArray(meta.preBalances))unresolved('O25_TRANSACTION_SHAPE');
 const index=keys.findIndex((k:any)=>k?.pubkey===account);
 if(index<0)unresolved('O25_CANONICAL_BALANCE_UNPROVEN');
 const pick=(rows:any[])=>{
  const own=rows.filter((b:any)=>object(b)&&b.accountIndex===index);
  if(own.length>1)unresolved('O25_CANONICAL_BALANCE_UNPROVEN');
  const b=own[0];if(!b)return null;
  const a=b.uiTokenAmount?.amount,d=b.uiTokenAmount?.decimals;
  if(b.mint!==role.mint||b.owner!==role.wallet||typeof a!=='string'||!/^(0|[1-9]\d{0,19})$/.test(a)||!integer(d))unresolved('O25_CANONICAL_BALANCE_UNPROVEN');
  return{amount:BigInt(a),decimals:d as number};
 };
 const before=pick(meta.preTokenBalances),after=pick(meta.postTokenBalances);
 if(!after)unresolved('O25_CANONICAL_LIFECYCLE_UNSUPPORTED');
 if(!before&&meta.preBalances[index]!==0)unresolved('O25_CANONICAL_BALANCE_UNPROVEN');
 return{pre:before?before.amount:0n,post:after.amount,decimals:after.decimals,created:!before};
}

/** One creator Pump trade: event, side-matching instruction, canonical legs inside its frame, token identity and an exact lamport census of every account. */
function trade(value:any,role:CreatorRole,account:string,row:Row,ev:Events,bal:Balance):Entry{
 const message=value.transaction.message,meta=value.meta,list=message.accountKeys;
 if(!Array.isArray(list)||!list.every((k:any)=>object(k)&&typeof k.pubkey==='string')||!Array.isArray(message.instructions)||!Array.isArray(meta.preTokenBalances)||!Array.isArray(meta.postTokenBalances))unresolved('O25_TRANSACTION_SHAPE');
 const keys:string[]=list.map((k:any)=>k.pubkey);
 if(keys[0]!==role.wallet||list[0].signer!==true)unresolved('O25_CREATOR_NOT_FEE_PAYER');
 const lamports=(x:unknown)=>{if(!Array.isArray(x)||x.length!==keys.length||!x.every(integer))unresolved('O25_TRANSACTION_SHAPE');return (x as number[]).map(n=>BigInt(n));};
 const pre=lamports(meta.preBalances),post=lamports(meta.postBalances);
 if(!integer(meta.fee))unresolved('O25_TRANSACTION_SHAPE');
 const networkFee=BigInt(meta.fee);
 if(ev.found.length!==1)unresolved('O25_TRADE_EVENT_COUNT');
 const {event,top}=ev.found[0]!,t=event.tail;
 if(event.user!==role.wallet)unresolved('O25_TRADE_EVENT_USER');
 if((t.cashback??0n)!==0n||(t.holderRewards??0n)!==0n||Array.isArray(t.shareholders)&&t.shareholders.length>0||t.quoteMint!==undefined&&t.quoteMint!==SYSTEM&&t.quoteMint!==WSOL)unresolved('O25_TRADE_SEMANTICS_UNSUPPORTED');
 const ix=message.instructions[top];
 if(!object(ix)||ix.programId!==PUMP_PROGRAM||!Array.isArray(ix.accounts)||typeof ix.data!=='string')unresolved('O25_TRADE_INSTRUCTION');
 const bound=bindPumpTradeInstruction(ix,new Map<string,any>(list.map((k:any)=>[k.pubkey,k])),role,account,event),instruction=bound.instruction;
 if(ev.list.some(s=>s.executed&&s.top!==top&&leg(s,account)))unresolved('O25_CANONICAL_LEG_OUTSIDE_TRADE');
 if([...meta.preTokenBalances,...meta.postTokenBalances].some((b:any)=>b?.mint===role.mint&&b?.owner===role.wallet&&keys[b.accountIndex]!==account))unresolved('O25_NON_CANONICAL_ACCOUNT');
 if(event.tokenAmount===0n||bal.post-bal.pre!==(event.isBuy?event.tokenAmount:-event.tokenAmount))unresolved('O25_TOKEN_IDENTITY');
 // Exact lamport census: each Pump leg lands on its derived or event-named account; nothing else moves except creator-funded new accounts.
 // Curve, creator vault and fee recipient are already bound to their IDL positions; the buyback leg may land only on the bound buyback recipient (v2) or a remaining account after every fixed role (v1).
 const curve=pda(Buffer.from('bonding-curve'),decodeSolanaAddress(role.mint)),vault=pda(Buffer.from('creator-vault'),decodeSolanaAddress(event.creator));
 const buyback=typeof t.buybackFee==='bigint'?t.buybackFee:0n,sol=event.solAmount;
 const settle=(model:'NONE'|'ADDITIVE'|'INCLUDED')=>{
  const protocol=model==='INCLUDED'?event.fee-buyback:event.fee;if(protocol<0n)return null;
  const expected=new Map<string,bigint>(),add=(a:string,v:bigint)=>expected.set(a,(expected.get(a)??0n)+v);
  add(curve,event.isBuy?sol:-sol);add(vault,event.creatorFee);add(event.feeRecipient,protocol);
  let deposits=0n,unnamed=0n;
  for(let i=1;i<keys.length;i++){
   const d=post[i]!-pre[i]!,e=expected.get(keys[i]!);
   if(e!==undefined){if(d===e)continue;if(pre[i]===0n&&d>e){deposits+=d-e;continue;}return null;}
   if(d===0n)continue;
   if(d>0n&&pre[i]===0n){deposits+=d;continue;}
   if(d>0n&&bound.buyback.has(keys[i]!)){unnamed+=d;continue;}
   return null;
  }
  const charged=event.fee+event.creatorFee+(model==='ADDITIVE'?buyback:0n),userQuote=event.isBuy?sol+charged:sol-charged;
  const creator=event.isBuy?-(networkFee+userQuote+deposits):userQuote-networkFee-deposits;
  return unnamed===buyback&&(post[0]!-pre[0]!)===creator?{model,protocol,userQuote,deposits}:null;
 };
 const models:Array<'NONE'|'ADDITIVE'|'INCLUDED'>=buyback===0n?['NONE']:['ADDITIVE','INCLUDED'];
 const fits=models.map(settle).filter((x):x is NonNullable<typeof x>=>x!==null);
 if(fits.length!==1)unresolved('O25_QUOTE_RECONCILIATION');
 const fit=fits[0]!;
 // Official Pump BUY/SELL docs: max_sol_cost is the most the buyer pays including protocol and creator fees, min_sol_output the least the seller receives after them; both are checked against the uniquely reconciled user quote (protocol fee including any buyback carve, never network fee or deposits).
 if(event.isBuy?fit.userQuote>bound.limit:fit.userQuote<bound.limit)unresolved('O25_TRADE_AMOUNT');
 return{signature:row.signature,slot:row.slot,blockTime:row.blockTime,side:event.isBuy?'BUY':'SELL',instruction,ixName:typeof t.ixName==='string'?t.ixName:null,units:event.tokenAmount,decimals:bal.decimals,coreQuote:sol,protocolFee:fit.protocol,buybackFee:buyback,creatorFee:event.creatorFee,creatorFeeToOwnVault:event.creator===role.wallet,feeModel:fit.model,userQuote:fit.userQuote,networkFee,deposits:fit.deposits,canonicalPre:bal.pre,canonicalPost:bal.post,eventTailFields:event.tailFields};
}

/** KNOWN only on top of a KNOWN O24 inventory decode of the same receipts; any gap, foreign leg or unpriced movement leaves the whole vector unreported. */
export function deriveO25CreatorLifetime(token:TokenRef,role:CreatorRole,tape:CreatorTape,receipts:CreatorInventoryReceipts,reuse:CreatorReuse,cutoff:string,evidenceIds:string[]):AdvisoryMetric{
 // O24's pure decode is the sole guard for cohort, membership, clocks, canonical chain, whole-wallet exclusion and creation witness; it throws on forged membership or scope.
 const history=decodeCreatorInventory(token,role,tape,receipts,cutoff,reuse),c=history.canonical,w=history.walletProof,interval=history.interval;
 const base={method:CREATOR_LIFETIME_METHOD,token,
  cohort:{kind:'CREATOR_ONLY',wallet:role.wallet,basis:'S13_SIGNED_CREATION_ROLE_VIA_O24',creationSignature:role.creationSignature,creationSlot:role.creationSlot,canonicalAccount:history.account,identity:null,control:null},
  inventoryBasis:{method:history.method,reasonCode:history.reasonCode,canonical:{status:c.status,code:c.code,headSlot:c.headSlot,headAtomic:c.headAtomic},walletProof:{status:w.status,code:w.code,catalogSlot:w.catalogSlot,rowsSinceCreation:w.rowsSinceCreation,successfulInspected:w.successfulInspected},pendingPremises:CREATOR_PENDING_PREMISES.length,reusedReceipts:history.reusedReceipts},
  abi:{source:PUMP_CREATE_ABI_SOURCE,sha256:PUMP_CREATE_ABI_HASH,program:PUMP_PROGRAM,event:'TradeEvent',eventAuthority:EVENT_AUTHORITY,instructions:[...Object.keys(PUMP_TRADE_ABI.buys),...Object.keys(PUMP_TRADE_ABI.sells)]},
  quote:{asset:'SOL',unit:'lamports',decimals:9,usdBasis:null,trackerValuesUsed:false},interval,limitations:LIMITATIONS};
 const metric=(quality:AdvisoryMetric['quality'],data:Record<string,unknown>,reason:string):AdvisoryMetric=>({id:'O25',quality,unit:'scoped-record',data:{...base,...data},evidenceIds:[...new Set(evidenceIds)],reasonCode:reason});
 const empty={holdings:null,realized:null,currentSells:null};
 if(!history.eligible||c.status!=='OBSERVED'||w.status!=='OBSERVED'||CREATOR_PENDING_PREMISES.length)return metric(!history.eligible?'MISSING':c.status==='OBSERVED'?'TRUNCATED':c.status,{status:'PREREQUISITE_UNRESOLVED',...empty},'O25_INVENTORY_PREREQUISITE_UNRESOLVED');
 const cut=Date.parse(cutoff),start=Date.parse(interval.start),end=Date.parse(interval.end),account=history.account,headSlot=c.headSlot!,catalogSlot=w.catalogSlot!,{read,reused}=projection(receipts,reuse,cut);
 try{
  const pages=(list:typeof c.pages,address:string,pin:number)=>{
   const rows:Row[]=[];let before:string|undefined;
   for(const p of list){const {value,at}=read(p.id,creatorPageRequest(address,pin,before)),found=rowsOf(value,at);if(found.length!==p.returned)fail('O25_PROJECTION_INCONSISTENT');rows.push(...found);before=found.at(-1)?.signature;}
   return{rows,exhausted:list.at(-1)?.exhausted===true};
  };
  // Lifetime of the canonical account: its complete index up to the head; O24 itself may stop at its pre-interval witness.
  const ata=pages(c.pages,account,headSlot);if(!ata.exhausted)unresolved('O25_ATA_LIFETIME_UNEXHAUSTED');
  const wallet=pages(w.pages,role.wallet,catalogSlot),since=wallet.rows.filter(r=>r.slot>=role.creationSlot&&r.slot<=catalogSlot),inspected=since.filter(r=>r.err===null);
  if(since.length!==w.rowsSinceCreation||inspected.length!==w.successfulInspected)fail('O25_PROJECTION_INCONSISTENT');
  const walletSigs=new Set(inspected.map(r=>r.signature)),chainSigs=new Set(c.transactions.map(t=>t.signature));
  const canonicalRows=ata.rows.filter(r=>r.err===null&&r.slot<=headSlot),canonicalSigs=new Set(canonicalRows.map(r=>r.signature));
  for(const r of canonicalRows){if(r.slot<role.creationSlot)unresolved('O25_CANONICAL_BEFORE_CREATION');if(!walletSigs.has(r.signature)&&!chainSigs.has(r.signature))unresolved('O25_CANONICAL_RECEIPT_UNINSPECTED');}
  // A creator-signed Pump trade of the target mint anywhere in the inspected wallet history must settle through the canonical account.
  for(const r of inspected)if(!canonicalSigs.has(r.signature)&&creatorEvents(transaction(read,r),role).found.some(f=>f.event.user===role.wallet))unresolved('O25_CREATOR_TRADE_OUTSIDE_CANONICAL');
  const views=canonicalRows.map(row=>{
   const value=transaction(read,row),bal=canonicalBalance(value,role,account),ev=creatorEvents(value,role),order=row.transactionIndex??(integer(value.transactionIndex)?value.transactionIndex:null);
   if(bal.post===bal.pre&&!ev.found.length){if(ev.list.some(s=>s.executed&&leg(s,account)))unresolved('O25_CANONICAL_UNPRICED_LEG');return{row,order,bal,entry:null};}
   return{row,order,bal,entry:trade(value,role,account,row,ev,bal)};
  }).sort((a,b)=>a.row.slot-b.row.slot||(a.order??-1)-(b.order??-1));
  for(let i=1;i<views.length;i++){const p=views[i-1]!,n=views[i]!;if(p.row.slot===n.row.slot&&(p.order===null||n.order===null||p.order===n.order))unresolved('O25_ORDER_AMBIGUOUS');if(p.bal.post!==n.bal.pre)unresolved('O25_CONTINUITY');}
  if(views.length&&(!views[0]!.bal.created||views[0]!.bal.pre!==0n))unresolved('O25_CANONICAL_START_UNPROVEN');
  const headAtomic=BigInt(c.headAtomic!);if((views.at(-1)?.bal.post??0n)!==headAtomic)unresolved('O25_HEAD_CONTINUITY');
  const entries=views.flatMap(v=>v.entry?[v.entry]:[]);
  // FIFO lots in chain order; each lot costs the creator-borne Pump quote of its buy.
  const lots:Array<{signature:string;at:number;units:bigint;cost:bigint;original:bigint}>=[],disposed:Array<Record<string,unknown>>=[];
  for(const e of entries){
   if(e.side==='BUY'){lots.push({signature:e.signature,at:e.blockTime,units:e.units,cost:e.userQuote,original:e.units});continue;}
   let left=e.units;
   while(left>0n){
    const lot=lots[0];if(!lot)unresolved('O25_DISPOSAL_EXCEEDS_LOTS');
    const take=lot.units<left?lot.units:left;
    disposed.push({acquiredSignature:lot.signature,disposedSignature:e.signature,unitsAtomic:String(take),entryCostLamports:new Decimal(lot.cost.toString()).mul(take.toString()).div(lot.original.toString()).toFixed(),holdingSeconds:e.blockTime-lot.at});
    lot.units-=take;left-=take;if(lot.units===0n)lots.shift();
   }
  }
  const total=(side:'BUY'|'SELL',list=entries)=>list.filter(e=>e.side===side).reduce((n,e)=>n+e.units,0n);
  const acquired=total('BUY'),sold=total('SELL'),held=lots.reduce((n,l)=>n+l.units,0n),decimals=entries[0]?.decimals??views[0]?.bal.decimals??null,now=Math.floor(cut/1000);
  if(held!==headAtomic)unresolved('O25_HEAD_CONTINUITY');
  const share=(x:bigint)=>held>0n?new Decimal(x.toString()).div(held.toString()).toFixed():null;
  const within=(v:Decimal|number,lo:number,hi:number|null)=>new Decimal(v).gte(lo)&&(hi===null||new Decimal(v).lt(hi));
  const perToken=(l:{cost:bigint;original:bigint})=>new Decimal(l.cost.toString()).mul(new Decimal(10).pow(decimals??0)).div(l.original.toString());
  const band=(match:(l:typeof lots[number])=>boolean)=>{const x=lots.filter(match).reduce((n,l)=>n+l.units,0n);return{atomic:String(x),shareOfHeld:share(x)};};
  const sells=entries.filter(e=>e.side==='SELL'&&e.blockTime*1000>=start&&e.blockTime*1000<end);
  const view=(e:Entry)=>({signature:e.signature,slot:e.slot,at:iso(e.blockTime),side:e.side,instruction:e.instruction,ixName:e.ixName,unitsAtomic:String(e.units),coreQuoteLamports:String(e.coreQuote),protocolFeeLamports:String(e.protocolFee),buybackFeeLamports:String(e.buybackFee),creatorFeeLamports:String(e.creatorFee),creatorFeeToOwnVault:e.creatorFeeToOwnVault,feeModel:e.feeModel,userQuoteLamports:String(e.userQuote),networkFeeLamports:String(e.networkFee),accountDepositsLamports:String(e.deposits),canonicalPreAtomic:String(e.canonicalPre),canonicalPostAtomic:String(e.canonicalPost),eventTailFields:e.eventTailFields});
  return metric('KNOWN',{status:'COMPLETE',
   coverage:{headSlot,catalogSlot,ataIndex:{pinnedSlot:headSlot,rows:ata.rows.length,successful:canonicalRows.length,exhausted:true,pages:c.pages.length},walletIndex:{pinnedSlot:catalogSlot,rowsSinceCreation:since.length,successfulInspected:inspected.length,pages:w.pages.length},canonicalReceipts:views.map(v=>v.row.signature),reusedReceipts:[...reused].sort()},
   ledger:entries.map(view),
   flows:{buyAtomic:String(acquired),sellAtomic:String(sold),transferInAtomic:'0',transferOutAtomic:'0',mintAtomic:'0',burnAtomic:'0',basis:'Every canonical-account balance change from creation through the head binds one executed creator TradeEvent with exact token and lamport identities, every other canonical leg fails closed, and O24 proves every other creator-owned target-mint account untouched; any transfer, mint, burn or unpriced incoming leaves O25 unreported.'},
   holdings:{heldAtomic:String(held),openLots:lots.length,unknownCostAtomic:'0',shareDenominator:held>0n?'HELD_ATOMIC':'UNDEFINED_ZERO_HELD',
    ageBands:AGE_BANDS.map(([name,lo,hi])=>({band:name,fromSeconds:lo,toSeconds:hi,...band(l=>within(now-l.at,lo,hi))})),
    costBands:COST_BANDS.map(([name,lo,hi])=>({band:name,lamportsPerWholeTokenFrom:lo,lamportsPerWholeTokenTo:hi,...band(l=>within(perToken(l),lo,hi))}))},
   realized:{definition:'units disposed through verified Pump sells / units acquired by the creator over its lifetime',acquiredAtomic:String(acquired),disposedThroughSalesAtomic:String(sold),fraction:acquired>0n?new Decimal(sold.toString()).div(acquired.toString()).toFixed():null,disposedLots:disposed},
   currentSells:{interval,sells:sells.length,unitsAtomic:String(total('SELL',sells)),coreQuoteLamports:String(sells.reduce((n,e)=>n+e.coreQuote,0n)),userQuoteLamports:String(sells.reduce((n,e)=>n+e.userQuote,0n))}},
   'CREATOR_LIFETIME_VECTOR_OBSERVED');
 }catch(error){
  if(error instanceof Unresolved)return metric(/_(UNINSPECTED|UNEXHAUSTED|ABSENT|UNRESOLVED)$/.test(error.message)?'TRUNCATED':'MISSING',{status:'UNRESOLVED',reason:error.message,...empty},error.message);
  throw error;
 }
}
