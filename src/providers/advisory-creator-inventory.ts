import {truncatedQuoteCandidates} from './advisory-creator-quote-execution.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT_2022, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { TokenRef } from '../domain/contracts.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import type { DemandHistory } from './advisory-demand-windows.js';
import { accountTokenView, executedWindowInstructions, recordedWindowInstructions, type AccountLeg } from './advisory-window-accounts.js';
import { LEGACY_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, decodeSolanaAddress } from './solana.js';

export const CREATOR_INVENTORY_METHOD='creator-signer-wallet-inventory-v1' as const;
export const CREATOR_PAGE_LIMIT=1000,CREATOR_MAX_PAGES=2,CREATOR_TRANSACTION_CAP=96;
type Request={method:string;params:unknown[]};
export type CreatorInventoryReceipts={rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;requests:Record<string,Request>};
/** Identical immutable getTransaction receipts another namespace (S13 role, O28 window) already retained, keyed by signature with their evidence id, request, original body and clock. */
export type CreatorReuse=ReadonlyMap<string,{id:string;request:Request;raw:string;retrievedAt:string}>;
/** Verified signed-creation role from advisory-creator-role.ts: a role-holding key, never a person, controller or fee recipient. */
export type CreatorRole={wallet:string;mint:string;creationSignature:string;creationSlot:number};
/** Complete A30 tape and the base vault bound by its verified O28 pool state. */
export type CreatorTape={history:Pick<DemandHistory,'complete'|'pool'|'anchorSlot'|'range'|'trades'>;vault:string};
type Status='OBSERVED'|'TRUNCATED'|'MISSING';
type Page={id:string;returned:number;exhausted:boolean};
type Row={signature:string;slot:number;blockTime:number;err:unknown;transactionIndex:number|null};
type Binding=Parameters<typeof accountTokenView>[4][number];
type Steps=ReturnType<typeof executedWindowInstructions>;
type Read=(id:string,expected:Request)=>{value:any;at:number};
export type CanonicalHistory={status:Status;code:string|null;headSlot:number|null;headAtomic:string|null;pages:Page[];indexedRows:number;failedRows:number;
 startWitness:{signature:string;slot:number;postAtomic:string}|null;startAtomic:string|null;endAtomic:string|null;
 transactions:Array<{signature:string;slot:number;at:string;inInterval:boolean;preAtomic:string|null;postAtomic:string|null;lifecycle:string[]}>;legs:AccountLeg[]};
export type WalletProof={status:Status;code:string|null;catalogSlot:number|null;otherCurrentAccounts:Array<{account:string;amountAtomic:string}>;pages:Page[];rowsSinceCreation:number;successfulInspected:number};
export type CreatorInventoryHistory={method:typeof CREATOR_INVENTORY_METHOD;token:TokenRef;wallet:string;account:string;creationSignature:string;interval:{start:string;end:string};anchorSlot:number|null;
 eligible:boolean;reasonCode:string;canonical:CanonicalHistory;walletProof:WalletProof;receipts:number;reusedReceipts:string[];transactionCap:number};

const PUMP_AMM='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',WSOL='So11111111111111111111111111111111111111112',HOUR=3_600_000,TX='creator-tx-';
const tokenPrograms=new Set([LEGACY_TOKEN_PROGRAM,TOKEN_2022_PROGRAM]);
// A non-pool leg is a transfer only when its whole top-level frame runs these programs; any venue or router leaves it unattributed.
const INERT=new Set([...tokenPrograms,'11111111111111111111111111111111','ComputeBudget111111111111111111111111111111','ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL','MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr','Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo']);
// Token-2022 semantics the non-canonical exclusion relies on, verified by root against the official program/src tree pinned below (canonical source, not an attestation of deployed program bytes).
export const TOKEN_2022_SOURCE_COMMIT='b4724e6e7fecc8fc36295f861a769401bf92b270';
const PREMISES=['Transfer/TransferChecked and Burn/BurnChecked lower an account amount only after validate_owner of its owner account (single signer or multisig), an approved delegate, or the mint permanent delegate (processor.rs 475-540, 1258-1335).','Approve validates the source owner account (655-695); SetAuthority(AccountOwner) validates the current owner and clears any delegate (760-807); CloseAccount of a non-native account requires a zero amount (1339-1368).','PermanentDelegate initializes only on an uninitialized mint (1707-1726) and the signed creation initialized none before InitializeMint2; no broader claim about other mint extensions.','Each owner-validated instruction lists the owner account among its accounts, so it is an address reference in the provider signature index; that index is a provider property, not a cryptographic archive.'];
const SOURCE_PREMISES=['Every non-native base.amount debit first validates the owner account, an approved delegate or the mint permanent delegate: processor.rs Transfer 486-539 before 570, Burn 1277-1323 before 1326 (owner check skipped only for System-program and incinerator owners, excluded by scope); SyncNative 1532 and UnwrapLamports 1858-1908 apply only to native accounts; confidential_transfer/processor.rs Deposit validates the owner 444-451 before debiting 465-468; every other writer adds or resets.','PermanentDelegate, ConfidentialTransferMint (confidential_transfer/processor.rs 61-80) and ConfidentialMintBurn initialize only on an uninitialized mint; the retained creation receipt must show this transaction creating the mint and running only InitializeMetadataPointer before InitializeMint2.'];
// Extension instructions allowed before InitializeMint2; anything else on the mint, parsed or not, fails the creation witness.
const PRE_MINT_ALLOWED=new Set(['initializeMetadataPointer']);
const SYSTEM_PROGRAM='11111111111111111111111111111111',INCINERATOR='1nc1nerator11111111111111111111111111111111',NATIVE_MINTS=new Set([WSOL,NATIVE_MINT_2022.toBase58()]);
// System-program freshness the creation witness relies on, verified by root against pinned Agave source (canonical source, not an attestation of the deployed runtime).
export const SYSTEM_SOURCE_COMMIT='f14a033e30eb7f34649e9d64cd3d5e7f13b28cf1';
const SYSTEM_PREMISES=['System CreateAccount (programs/system/src/system_processor.rs create_account 150-183) rejects a destination holding lamports; its allocate step (75-109) requires the new address to sign, empty data and the System owner before assign sets the requested owner, so the mint carried no extension state from an earlier transaction. CreateAccountAllowPrefund (188) is a separate path the witness does not accept.'];
// KNOWN stays blocked until each entry is checked against primary source and removed.
export const CREATOR_PENDING_PREMISES:readonly string[]=[];

export const creatorHeadRequest=(account:string,anchorSlot:number):Request=>({method:'getAccountInfo',params:[account,{encoding:'jsonParsed',commitment:'finalized',minContextSlot:anchorSlot}]});
export const creatorPageRequest=(address:string,contextSlot:number,before?:string):Request=>({method:'getSignaturesForAddress',params:[address,{limit:CREATOR_PAGE_LIMIT,commitment:'finalized',minContextSlot:contextSlot,...(before?{before}:{})}]});
export const creatorOwnerRequest=(wallet:string,mint:string,headSlot:number):Request=>({method:'getTokenAccountsByOwner',params:[wallet,{mint},{encoding:'jsonParsed',commitment:'finalized',minContextSlot:headSlot}]});
export const creatorTransactionRequest=(signature:string):Request=>({method:'getTransaction',params:[signature,{commitment:'finalized',encoding:'jsonParsed',maxSupportedTransactionVersion:1}]});

const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
function fail(code:string):never{throw new Error(code);}
const atomic=(v:unknown):bigint=>{if(typeof v!=='string'||!/^(0|[1-9]\d{0,19})$/.test(v)||BigInt(v)>18446744073709551615n)fail('CREATOR_INVENTORY_ATOMIC');return BigInt(v);};
const iso=(seconds:number)=>new Date(seconds*1000).toISOString();
const codeOf=(e:unknown)=>e instanceof Error&&/^(CREATOR_[A-Z_]+|ADVISORY_ACCOUNTS_[A-Z_]+|RPC_[A-Z0-9_-]{1,50})$/.test(e.message)?e.message:'CREATOR_INVENTORY_INVALID';
const statusOf=(code:string):'TRUNCATED'|'MISSING'=>/_(CAP|ABSENT|UNRESOLVED)$/.test(code)?'TRUNCATED':'MISSING';
const signed=(l:{kind:AccountLeg['kind'];amountAtomic:string})=>(['POOL_BUY','TRANSFER_IN','MINT'].includes(l.kind)?1n:-1n)*BigInt(l.amountAtomic);
const inertFrame=(list:Steps,order:number)=>{const top=list[order]!.top;return list.every(s=>s.top!==top||!s.executed||INERT.has(s.ix.programId));};

function reader(r:CreatorInventoryReceipts,cutoff:number,reuse:CreatorReuse){
 const used=new Set<string>(),reused=new Set<string>();
 const read:Read=(id,expected)=>{
  // A transaction this namespace does not hold may only be another namespace's identical retained receipt, with its original body and clock.
  const own=Object.hasOwn(r.requests,id),shared=!own&&id.startsWith(TX)?reuse.get(id.slice(TX.length)):undefined;
  if(!own&&!shared)fail('CREATOR_RECEIPT_ABSENT');
  if(shared)reused.add(shared.id);else used.add(id);
  const request=shared?shared.request:r.requests[id],text:unknown=shared?shared.raw:r.rawArtifacts[id],time=shared?shared.retrievedAt:r.retrievedAt[id];
  if(JSON.stringify(request)!==JSON.stringify(expected)||typeof text!=='string')fail('CREATOR_INVENTORY_REQUEST');
  const at=Date.parse(time??'');if(!Number.isFinite(at)||at>cutoff)fail('CREATOR_INVENTORY_RECEIPT_TIME');
  let raw:any;try{raw=JSON.parse(text as string);}catch{fail('CREATOR_INVENTORY_RECEIPT_SHAPE');}
  if(!object(raw)||raw.jsonrpc!=='2.0'||raw.id!==1)fail('CREATOR_INVENTORY_RECEIPT_SHAPE');
  if(raw.error){const c=raw.error?.code;fail(typeof c==='string'&&/^RPC_[A-Z0-9_-]{1,50}$/.test(c)?c:Number.isSafeInteger(c)&&Math.abs(c)<=999999?`RPC_REMOTE_${c}`:'CREATOR_INVENTORY_REMOTE');}
  if(!Object.hasOwn(raw,'result'))fail('CREATOR_INVENTORY_RECEIPT_SHAPE');
  return{value:raw.result,at};
 };
 return{read,used,reused};
}
function pageRows(value:unknown,retrieved:number):Row[]{
 if(!Array.isArray(value)||value.length>CREATOR_PAGE_LIMIT)fail('CREATOR_INVENTORY_PAGE_SHAPE');
 return value.map((v:unknown)=>{
  if(!object(v)||typeof v.signature!=='string'||!integer(v.slot)||!('err' in v)||!(v.err===null||object(v.err))||v.confirmationStatus!=='finalized'||!(v.transactionIndex===undefined||v.transactionIndex===null||integer(v.transactionIndex)))fail('CREATOR_INVENTORY_PAGE_SHAPE');
  if(!integer(v.blockTime)||v.blockTime*1000>retrieved)fail('CREATOR_INVENTORY_PAGE_CLOCK');
  return{signature:v.signature,slot:v.slot,blockTime:v.blockTime,err:v.err,transactionIndex:integer(v.transactionIndex)?v.transactionIndex:null};
 });
}
/** Finalized index pages pinned to a context slot; stops once the caller's witness is reached or the index is exhausted. */
function walk(read:Read,prefix:'ata'|'wallet',address:string,contextSlot:number,after:number,reached:(rows:Row[])=>boolean){
 const rows:Row[]=[],pages:Page[]=[],seen=new Set<string>();let before:string|undefined,last=after,lastSlot=Infinity,lastTime=Infinity,exhausted=false;
 for(let p=0;p<CREATOR_MAX_PAGES&&!exhausted&&!reached(rows);p++){
  const id=`creator-${prefix}-page-${p}`,{value,at}=read(id,creatorPageRequest(address,contextSlot,before));
  if(at<last)fail('CREATOR_INVENTORY_PAGE_TIME');last=at;
  const found=pageRows(value,at);
  for(const row of found){if(seen.has(row.signature)||row.slot>lastSlot||row.blockTime>lastTime)fail('CREATOR_INVENTORY_PAGE_ORDER');seen.add(row.signature);lastSlot=row.slot;lastTime=row.blockTime;}
  rows.push(...found);exhausted=found.length<CREATOR_PAGE_LIMIT;pages.push({id,returned:found.length,exhausted});before=found.at(-1)?.signature;
 }
 if(!exhausted&&!reached(rows))fail(prefix==='ata'?'CREATOR_ATA_INDEX_CAP':'CREATOR_WALLET_INDEX_CAP');
 return{rows,pages,last,exhausted};
}
function transaction(read:Read,row:Row){
 const {value,at}=read(`creator-tx-${row.signature}`,creatorTransactionRequest(row.signature));
 if(!object(value)||value.slot!==row.slot||value.blockTime!==row.blockTime||value.transaction?.signatures?.[0]!==row.signature||!object(value.meta)||value.meta.err!==null||!['legacy',0,1].includes(value.version)||at<row.blockTime*1000)fail('CREATOR_INVENTORY_TRANSACTION_BINDING');
 return value;
}
function tokenAccount(v:any,role:CreatorRole,code:string){
 const info=v?.data?.parsed?.info;
 if(!object(v)||v.owner!==TOKEN_2022_PROGRAM||v.data?.program!=='spl-token-2022'||v.data?.parsed?.type!=='account'||!object(info)||info.mint!==role.mint||info.owner!==role.wallet||info.state!=='initialized')fail(code);
 return{amount:atomic(info.tokenAmount?.amount),immutable:Array.isArray(info.extensions)&&info.extensions.some((e:any)=>e?.extension==='immutableOwner')};
}
/** Binds each tape trade of this transaction to its one executed vault leg on the tracked account. */
function bindings(value:any,signature:string,role:CreatorRole,account:string,tape:CreatorTape):Binding[]{
 const list=executedWindowInstructions(value),pumps=list.map((s,position)=>({s,position})).filter(x=>x.s.ix.programId===PUMP_AMM),out:Binding[]=[];
 tape.history.trades.forEach((t,trade)=>{
  if(t.signature!==signature)return;
  const x=pumps[t.instructionIndex],a=x?.s.ix.accounts;
  if(!x||!x.s.executed||!Array.isArray(a)||a[0]!==tape.history.pool||a[1]!==t.user||a[3]!==role.mint||a[4]!==WSOL||a[7]!==tape.vault)fail('CREATOR_INVENTORY_TRADE_BINDING');
  if(a[5]!==account){if(t.user===role.wallet)fail('CREATOR_TRADE_OUTSIDE_CANONICAL_ACCOUNT');return;}
  const legs:number[]=[];
  for(let q=x.position+1;q<list.length&&list[q]!.top===x.s.top&&list[q]!.depth>x.s.depth;q++){
   const s=list[q]!,p=s.ix.parsed;
   if(!s.executed||!tokenPrograms.has(s.ix.programId)||!object(p)||!['transfer','transferChecked'].includes(p.type)||!object(p.info))continue;
   const i=p.info,amount=object(i.tokenAmount)?i.tokenAmount.amount:i.amount;
   if(p.type==='transferChecked'&&i.mint!==role.mint)continue;
   if(amount===t.baseAtomic&&(t.side==='BUY'?i.source===tape.vault&&i.destination===account:i.source===account&&i.destination===tape.vault))legs.push(q);
  }
  if(legs.length!==1)fail('CREATOR_INVENTORY_TRADE_BINDING');
  out.push({trade,account,user:t.user,signature,position:legs[0]!,side:t.side,baseAtomic:t.baseAtomic});
 });
 return out;
}
const emptyCanonical=():CanonicalHistory=>({status:'MISSING',code:null,headSlot:null,headAtomic:null,pages:[],indexedRows:0,failedRows:0,startWitness:null,startAtomic:null,endAtomic:null,transactions:[],legs:[]});
const emptyWallet=():WalletProof=>({status:'MISSING',code:null,catalogSlot:null,otherCurrentAccounts:[],pages:[],rowsSinceCreation:0,successfulInspected:0});

/** Complete balance chain of the canonical account from a pinned pre-interval receipt through the finalized head. */
function canonical(read:Read,role:CreatorRole,account:string,tape:CreatorTape,start:number,end:number){
 const out=emptyCanonical();let after=0;
 try{
  const anchorSlot=tape.history.anchorSlot!,head=read('creator-ata-head',creatorHeadRequest(account,anchorSlot)),h=head.value;
  if(head.at<end)fail('CREATOR_ATA_HEAD_TIME');
  if(!object(h)||!object(h.context)||!integer(h.context.slot)||h.context.slot<anchorSlot||!Object.hasOwn(h,'value'))fail('CREATOR_ATA_HEAD_SHAPE');
  let headAtomic=0n;
  if(h.value!==null){const v=tokenAccount(h.value,role,'CREATOR_ATA_HEAD_OWNER');if(!v.immutable)fail('CREATOR_ATA_HEAD_OWNER');headAtomic=v.amount;}
  const headSlot:number=h.context.slot;out.headSlot=headSlot;out.headAtomic=String(headAtomic);
  const index=walk(read,'ata',account,headSlot,head.at,rows=>rows.some(r=>r.err===null&&r.blockTime*1000<start));after=index.last;
  out.pages=index.pages;out.indexedRows=index.rows.length;out.failedRows=index.rows.filter(r=>r.err!==null).length;
  const success=index.rows.filter(r=>r.err===null&&r.slot<=headSlot),pin=success.find(r=>r.blockTime*1000<start)??null;
  const later=success.filter(r=>r.blockTime*1000>=start).reverse(),chain=pin?[pin,...later]:later;
  if(chain.length>CREATOR_TRANSACTION_CAP)fail('CREATOR_ATA_RECEIPT_CAP');
  const inside=(row:Row)=>row!==pin&&row.blockTime*1000<end,windowSignatures=new Set(chain.filter(inside).map(r=>r.signature));
  // A creator-signed tape trade must settle through the tracked account; another base account is outside this proof.
  if(tape.history.trades.some(t=>t.user===role.wallet&&Date.parse(t.at)>=start&&Date.parse(t.at)<end&&!windowSignatures.has(t.signature)))fail('CREATOR_TRADE_OUTSIDE_CANONICAL_ACCOUNT');
  const views=chain.map(row=>{
   const value=transaction(read,row);
   // Balances alone never certify that a critical token form was unrelated; unsupported or unresolved forms leave the chain unresolved.
   tokenForms(value,receiptKeys(value),'ATA');
   const order=row.transactionIndex??(integer(value.transactionIndex)?value.transactionIndex:null),within=inside(row);
   const bound=within?bindings(value,row.signature,role,account,tape):[];
   // Rows outside the interval only carry balances; an empty vault leaves their legs unclassified and unreported.
   const view=accountTokenView(value,account,role.mint,within?tape.vault:'',bound);
   if(within){
    const list=executedWindowInstructions(value);
    if(view.legs.some(l=>(l.kind==='TRANSFER_IN'||l.kind==='TRANSFER_OUT')&&!inertFrame(list,l.order)))fail('CREATOR_ATA_UNATTRIBUTED_LEG');
    if(bound.some(b=>!view.legs.some(l=>l.trade===b.trade)))fail('CREATOR_INVENTORY_TRADE_BINDING');
   }
   return{row,order,view,within};
  }).sort((a,b)=>a.row.slot-b.row.slot||(a.order??-1)-(b.order??-1));
  for(let i=1;i<views.length;i++){const p=views[i-1]!,n=views[i]!;if(p.row.slot===n.row.slot&&(p.order===null||n.order===null||p.order===n.order))fail('CREATOR_ATA_ORDER_AMBIGUOUS');}
  const balanced=views.filter(v=>v.view.pre!==null&&v.view.post!==null);
  for(let i=1;i<balanced.length;i++)if(balanced[i-1]!.view.post!==balanced[i]!.view.pre)fail('CREATOR_ATA_CONTINUITY');
  const first=balanced[0];if(!first)fail('CREATOR_ATA_START_UNPINNED');
  let startAtomic:bigint;
  if(pin){if(first.row!==pin)fail('CREATOR_ATA_START_UNPINNED');startAtomic=first.view.post!;out.startWitness={signature:pin.signature,slot:pin.slot,postAtomic:String(startAtomic)};}
  else if(index.exhausted&&first.view.lifecycle.includes('INITIALIZED')&&first.view.pre===0n)startAtomic=0n;
  else fail('CREATOR_ATA_START_UNPINNED');
  if(balanced.at(-1)!.view.post!==headAtomic)fail('CREATOR_ATA_HEAD_CONTINUITY');
  const ended=[...balanced].reverse().find(v=>v.row.blockTime*1000<end),endAtomic=ended?ended.view.post!:startAtomic;
  const legs:AccountLeg[]=views.filter(v=>v.within).flatMap(v=>v.view.legs.map(l=>({signature:v.row.signature,slot:v.row.slot,at:iso(v.row.blockTime),...l})));
  if(startAtomic+legs.reduce((n,l)=>n+signed(l),0n)!==endAtomic)fail('CREATOR_ATA_IDENTITY');
  out.transactions=views.map(v=>({signature:v.row.signature,slot:v.row.slot,at:iso(v.row.blockTime),inInterval:v.within,preAtomic:v.view.pre===null?null:String(v.view.pre),postAtomic:v.view.post===null?null:String(v.view.post),lifecycle:[...v.view.lifecycle]}));
  Object.assign(out,{legs,startAtomic:String(startAtomic),endAtomic:String(endAtomic),status:'OBSERVED',code:null});
 }catch(error){const code=codeOf(error);Object.assign(out,{status:statusOf(code),code,startWitness:null,startAtomic:null,endAtomic:null,transactions:[],legs:[]});}
 return{out,after};
}
const ATA_PROGRAM='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const address=(v:unknown)=>{if(typeof v!=='string')return false;try{decodeSolanaAddress(v);return true;}catch{return false;}};
const digits=(v:unknown)=>typeof v==='string'&&/^\d{1,20}$/.test(v),text=(v:unknown)=>typeof v==='string',decimals=(v:unknown)=>integer(v)&&Number(v)<=255;
const uiAmount=(v:unknown)=>object(v)&&Object.keys(v).every(k=>['amount','decimals','uiAmount','uiAmountString'].includes(k))&&digits(v.amount)&&decimals(v.decimals);
/** A supported jsonParsed form under S13's exact-field contract: keys name receipt account keys, data are valid public keys, nullable addresses may be absent or null,
 * values must hold, exactly one oneOf field names a key, the signer (or its multisig form with signers) names keys, and no other field appears. */
type Form={keys:string[];data?:string[];nullable?:string[];values?:Record<string,(v:unknown)=>boolean>;optional?:Record<string,(v:unknown)=>boolean>;oneOf?:string[];signer?:string;subjects:string[]};
// Forms observed in the retained creator receipts and the signed creation, plus those the shared O26 account parser reads; every other Token or associated-account form leaves the receipt unresolved.
const TOKEN_FORMS:Record<string,Form>={
 transfer:{keys:['source','destination'],values:{amount:digits},signer:'authority',subjects:['source','destination']},
 transferChecked:{keys:['source','mint','destination'],values:{tokenAmount:uiAmount},signer:'authority',subjects:['source','destination']},
 approve:{keys:['source','delegate'],values:{amount:digits},signer:'owner',subjects:['source']},
 approveChecked:{keys:['source','mint','delegate'],values:{tokenAmount:uiAmount},signer:'owner',subjects:['source']},
 revoke:{keys:['source'],signer:'owner',subjects:['source']},
 closeAccount:{keys:['account','destination'],signer:'owner',subjects:['account']},
 syncNative:{keys:['account'],subjects:['account']},
 initializeAccount:{keys:['account','mint','owner','rentSysvar'],subjects:['account']},
 initializeAccount2:{keys:['account','mint','rentSysvar'],data:['owner'],subjects:['account']},
 initializeAccount3:{keys:['account','mint'],data:['owner'],subjects:['account']},
 initializeImmutableOwner:{keys:['account'],subjects:['account']},
 mintTo:{keys:['mint','account'],values:{amount:digits},signer:'mintAuthority',subjects:['account']},
 mintToChecked:{keys:['mint','account'],values:{tokenAmount:uiAmount},signer:'mintAuthority',subjects:['account']},
 burn:{keys:['account','mint'],values:{amount:digits},signer:'authority',subjects:['account']},
 burnChecked:{keys:['account','mint'],values:{tokenAmount:uiAmount},signer:'authority',subjects:['account']},
 setAuthority:{keys:[],oneOf:['mint','account'],nullable:['newAuthority'],values:{authorityType:text},signer:'authority',subjects:['account']},
 getAccountDataSize:{keys:['mint'],optional:{extensionTypes:v=>Array.isArray(v)&&v.every(text)},subjects:[]},
 initializeMint:{keys:['mint','rentSysvar'],data:['mintAuthority'],nullable:['freezeAuthority'],values:{decimals},subjects:[]},
 initializeMint2:{keys:['mint'],data:['mintAuthority'],nullable:['freezeAuthority'],values:{decimals},subjects:[]},
 initializeMetadataPointer:{keys:['mint'],nullable:['authority','metadataAddress'],subjects:[]},
 initializeTokenMetadata:{keys:['metadata','updateAuthority','mint','mintAuthority'],values:{name:text,symbol:text,uri:text},subjects:[]},
 updateTokenMetadataAuthority:{keys:['metadata','updateAuthority'],nullable:['newAuthority'],subjects:[]},
};
// Native proof30 only: this mint-level initialization cannot alter a foreign account amount. The tracked mint is explicitly rejected below.
const NATIVE_WALLET_TOKEN_FORMS:Record<string,Form>={...TOKEN_FORMS,initializeTransferFeeConfig:{keys:['mint'],nullable:['transferFeeConfigAuthority','withdrawWithheldAuthority'],values:{maximumFee:integer,transferFeeBasisPoints:v=>integer(v)&&Number(v)<=10000},subjects:[]}};
// The associated account must be the derivation of its wallet, mint and token program; the System and token program fields must be their immutable canonical ids.
const ATA_FORM:Form={keys:['source','account','wallet','mint'],values:{systemProgram:v=>v===SYSTEM_PROGRAM,tokenProgram:v=>typeof v==='string'&&tokenPrograms.has(v)},subjects:['account']};
const ATA_FORMS:Record<string,Form>={create:ATA_FORM,createIdempotent:ATA_FORM};
// Parsed fields by which the creator would hold authority over the target mint.
const MINT_AUTHORITY_FIELDS=['authority','multisigAuthority','mintAuthority','multisigMintAuthority','freezeAuthority','updateAuthority','newAuthority'];
type Facts=Map<string,{mints:Set<string>;owners:Set<string>}>;
const note=(facts:Facts,account:unknown,mint?:unknown,owner?:unknown)=>{if(typeof account!=='string')return;const f=facts.get(account)??{mints:new Set<string>(),owners:new Set<string>()};if(typeof mint==='string')f.mints.add(mint);if(typeof owner==='string')f.owners.add(owner);facts.set(account,f);};
/** Receipt account keys, static and loaded, each a valid public key. */
function receiptKeys(value:any):Set<string>{
 const list=value.transaction?.message?.accountKeys;
 if(!Array.isArray(list)||list.some((k:any)=>!object(k)||!address(k.pubkey)))fail('CREATOR_INVENTORY_TRANSACTION_SHAPE');
 return new Set(list.map((k:any)=>k.pubkey as string));
}
/** Every attempted Token, Token-2022 and associated-account instruction of a receipt's complete runtime trace as a supported form, with the token accounts it acts on and the mint and owner facts its fields establish. */
function tokenForms(value:any,keys:Set<string>,scope:'ATA'|'WALLET',attemptedSuperset=false){
 // Absence is certified only over the complete runtime trace: every top-level and inner instruction bound in order to its logged invoke frame and outcome.
 // A dropped, added or reordered instruction, or an incomplete or truncated log, is never read as unrelated activity; parsed forms alone never stand in for the trace.
 let trace:Steps;
 try{try{trace=executedWindowInstructions(value);}catch(error){if(!attemptedSuperset)throw error;trace=truncatedQuoteCandidates(value,true).map(s=>({...s,executed:false}));}if(attemptedSuperset&&trace.some(s=>!keys.has(s.ix.programId)))fail(`CREATOR_${scope}_RUNTIME_TRACE_UNRESOLVED`);}catch{fail(`CREATOR_${scope}_RUNTIME_TRACE_UNRESOLVED`);}
 const facts:Facts=new Map(),ixs:Array<{type:string;info:Record<string,any>;subjects:string[]}>=[];
 for(const {ix} of trace){
  const ata=ix.programId===ATA_PROGRAM,table=ata?ATA_FORMS:attemptedSuperset?NATIVE_WALLET_TOKEN_FORMS:TOKEN_FORMS,p=ix.parsed;
  if(!ata&&!tokenPrograms.has(ix.programId))continue;
  if(!object(p)||typeof p.type!=='string'||!object(p.info)||!Object.hasOwn(table,p.type))fail(`CREATOR_${scope}_TOKEN_FORM_UNRESOLVED`);
  const type:string=p.type,info:Record<string,any>=p.info,form=table[type]!,key=(f:string)=>typeof info[f]==='string'&&keys.has(info[f]);
  const multi=form.signer?`multisig${form.signer[0]!.toUpperCase()}${form.signer.slice(1)}`:null,signer=multi&&Object.hasOwn(info,multi)?multi:form.signer;
  const chosen=(form.oneOf??[]).filter(f=>Object.hasOwn(info,f)),checks=Object.entries(form.values??{}),optional=Object.entries(form.optional??{});
  const allowed=new Set([...form.keys,...form.data??[],...form.nullable??[],...checks.map(([f])=>f),...optional.map(([f])=>f),...chosen,...signer?[signer]:[],...signer===multi?['signers']:[]]);
  const valid=Object.keys(info).every(f=>allowed.has(f))&&form.keys.every(key)&&(form.data??[]).every(f=>address(info[f]))
   &&(form.nullable??[]).every(f=>info[f]===undefined||info[f]===null||address(info[f]))&&checks.every(([f,check])=>check(info[f]))&&optional.every(([f,check])=>info[f]===undefined||check(info[f]))
   &&(!form.oneOf||chosen.length===1&&key(chosen[0]!))&&(!signer||key(signer)&&(signer!==multi||Array.isArray(info.signers)&&info.signers.length>0&&info.signers.every((s:unknown)=>typeof s==='string'&&keys.has(s))));
  if(!valid||ata&&getAssociatedTokenAddressSync(new PublicKey(info.mint),new PublicKey(info.wallet),true,new PublicKey(info.tokenProgram)).toBase58()!==info.account)fail(`CREATOR_${scope}_TOKEN_FIELD_UNRESOLVED`);
  // Mint and owner facts the program enforces for each form; delegate and close authorities are never owners.
  if(ata||/^initializeAccount[23]?$/.test(type))note(facts,info.account,info.mint,ata?info.wallet:info.owner);
  else if(type==='approve'||type==='approveChecked'||type==='revoke')note(facts,info.source,info.mint,info.owner??info.multisigOwner);
  else if(type==='transferChecked'){note(facts,info.source,info.mint);note(facts,info.destination,info.mint);}
  else if(/^(mintTo|burn)(Checked)?$/.test(type))note(facts,info.account,info.mint);
  ixs.push({type,info,subjects:form.subjects.filter(f=>typeof info[f]==='string').map(f=>info[f] as string)});
 }
 return{ixs,facts};
}
/** Shared native boundary: every critical parsed form and referenced key must be complete before any committed-amount witness is accepted. */
export function validateNativeCreatorTokenForms(value:any):void{tokenForms(value,receiptKeys(value),'WALLET',true);}
/** Returns a code when a creator-referencing receipt touches, or cannot exclude touching, another creator-owned target-mint account, including one opened and closed inside it.
 * System instructions are not inspected: only the token program owning a token account can change its amount, owner or lifecycle. */
export function walletTouch(value:any,role:CreatorRole,account:string,attemptedSuperset=false):string|null{
 const keys=receiptKeys(value),list=value.transaction.message.accountKeys;
 if(!keys.has(role.wallet))fail('CREATOR_WALLET_INDEX_INCONSISTENT');
 const {ixs,facts}=tokenForms(value,keys,'WALLET',attemptedSuperset);
 // Raw balances add each listed account's mint and owner; accounts opened and closed inside the receipt resolve only from their parsed initialization.
 for(const rows of [value.meta?.preTokenBalances,value.meta?.postTokenBalances]){
  if(!Array.isArray(rows))fail('CREATOR_INVENTORY_BALANCE_SHAPE');
  for(const b of rows){
   if(!object(b)||!integer(b.accountIndex)||b.accountIndex>=list.length||!address(b.mint)||!(b.owner===undefined||address(b.owner))||b.mint===role.mint&&b.owner===undefined)fail('CREATOR_INVENTORY_BALANCE_SHAPE');
   const target:string=list[b.accountIndex].pubkey;note(facts,target,b.mint,b.owner);
   if(b.mint===role.mint&&b.owner===role.wallet&&target!==account)return 'CREATOR_NON_CANONICAL_ACCOUNT_TOUCHED';
  }
 }
 for(const {type,info,subjects} of ixs){
  if(attemptedSuperset&&type==='initializeTransferFeeConfig'&&info.mint===role.mint)return 'CREATOR_WALLET_TARGET_EXTENSION_UNRESOLVED';
  // Creator authority over the target mint is outside this proof; other mint-level forms hold no inventory.
  if((info.mint??info.metadata)===role.mint&&(!subjects.length||type.startsWith('mintTo'))&&MINT_AUTHORITY_FIELDS.some(f=>info[f]===role.wallet))return 'CREATOR_WALLET_TARGET_MINT_AUTHORITY';
  // Every token account acted on must resolve from this receipt alone: its mint, and for the target mint its single owner.
  for(const subject of subjects){
   if(subject===account)continue;
   const f=facts.get(subject);
   if(!f||f.mints.size!==1)return 'CREATOR_WALLET_ACCOUNT_UNRESOLVED';
   if(!f.mints.has(role.mint))continue;
   if(f.owners.size!==1)return 'CREATOR_WALLET_ACCOUNT_UNRESOLVED';
   if(f.owners.has(role.wallet)||type==='setAuthority'&&info.newAuthority===role.wallet)return 'CREATOR_NON_CANONICAL_ACCOUNT_TOUCHED';
  }
 }
 return null;
}
/** Retained creation receipt: the role signers, a mint this transaction created, and only allowed extensions before its InitializeMint2.
 * Only the System and token programs can write the mint before initialization, so each of their instructions up to InitializeMint2 must be a supported parsed form
 * naming resolved keys; a body that omits or spoofs the mint, a prefund or assign, or an unresolved creator key never certifies a fresh mint. */
function creationWitness(value:any,role:CreatorRole){
 const keys=value.transaction?.message?.accountKeys;
 if(!Array.isArray(keys)||keys[0]?.pubkey!==role.wallet||keys[0]?.signer!==true||keys.filter((k:any)=>k?.signer===true).length!==2||!keys.some((k:any)=>k?.pubkey===role.mint&&k.signer===true))fail('CREATOR_CREATION_WITNESS_ROLE');
 const known=receiptKeys(value),exact=(info:Record<string,unknown>,names:string[])=>JSON.stringify(Object.keys(info).sort())===JSON.stringify([...names].sort());
 let created=false;
 for(const s of executedWindowInstructions(value)){
  const system=s.ix.programId===SYSTEM_PROGRAM;if(!system&&!tokenPrograms.has(s.ix.programId))continue;
  const p=object(s.ix.parsed)&&typeof s.ix.parsed.type==='string'&&object(s.ix.parsed.info)?s.ix.parsed as {type:string;info:Record<string,any>}:null;
  if(!p)fail('CREATOR_CREATION_WITNESS_MINT');
  const {type,info}=p;
  if(system){
   // Only CreateAccount of resolved keys may precede InitializeMint2; another System form could prefund, allocate or assign the mint.
   if(type!=='createAccount'||!exact(info,['source','newAccount','lamports','space','owner'])||!known.has(info.source)||!known.has(info.newAccount)||!integer(info.lamports)||!integer(info.space)||!address(info.owner))fail('CREATOR_CREATION_WITNESS_MINT');
   if(info.newAccount===role.mint){if(created||!s.executed||info.owner!==TOKEN_2022_PROGRAM)fail('CREATOR_CREATION_WITNESS_MINT');created=true;}
   continue;
  }
  if(type==='initializeMint2'||type==='initializeMint'){if(!created||!s.executed||s.ix.programId!==TOKEN_2022_PROGRAM||info.mint!==role.mint)fail('CREATOR_CREATION_WITNESS_MINT');return;}
  if(!PRE_MINT_ALLOWED.has(type))fail(created?'CREATOR_CREATION_WITNESS_EXTENSION':'CREATOR_CREATION_WITNESS_MINT');
  if(!created||!s.executed||s.ix.programId!==TOKEN_2022_PROGRAM||info.mint!==role.mint||!known.has(info.mint)||!Object.keys(info).every(f=>['mint','authority','metadataAddress'].includes(f))||!['authority','metadataAddress'].every(f=>info[f]===undefined||info[f]===null||address(info[f])))fail('CREATOR_CREATION_WITNESS_MINT');
 }
 fail('CREATOR_CREATION_WITNESS_MINT');
}
/** Every other creator-owned target-mint account stayed at zero: the current catalog ends the chain and every amount-lowering exit lists the creator as owner. */
function walletProof(read:Read,role:CreatorRole,account:string,headSlot:number,headAtomic:bigint,after:number):WalletProof{
 const out=emptyWallet();
 try{
  const catalog=read('creator-owner-accounts',creatorOwnerRequest(role.wallet,role.mint,headSlot)),c=catalog.value;
  if(catalog.at<after)fail('CREATOR_CATALOG_TIME');
  if(!object(c)||!object(c.context)||!integer(c.context.slot)||c.context.slot<headSlot||!Array.isArray(c.value))fail('CREATOR_CATALOG_SHAPE');
  let canonicalSeen=false;
  for(const entry of c.value){
   if(!object(entry)||!address(entry.pubkey))fail('CREATOR_CATALOG_SHAPE');
   const amount=tokenAccount(entry.account,role,'CREATOR_CATALOG_SHAPE').amount;
   if(entry.pubkey===account){if(canonicalSeen||amount!==headAtomic)fail('CREATOR_CATALOG_HEAD_MISMATCH');canonicalSeen=true;continue;}
   out.otherCurrentAccounts.push({account:entry.pubkey,amountAtomic:String(amount)});if(amount!==0n)fail('CREATOR_NON_CANONICAL_BALANCE');
  }
  if(!canonicalSeen&&headAtomic!==0n)fail('CREATOR_CATALOG_HEAD_MISMATCH');
  const catalogSlot:number=c.context.slot;out.catalogSlot=catalogSlot;
  const index=walk(read,'wallet',role.wallet,catalogSlot,catalog.at,rows=>rows.some(r=>r.slot<role.creationSlot));out.pages=index.pages;
  const creationRow=index.rows.find(r=>r.signature===role.creationSignature&&r.err===null);
  if(!creationRow)fail('CREATOR_WALLET_INDEX_INCONSISTENT');
  if(creationRow.slot!==role.creationSlot)fail('CREATOR_CREATION_WITNESS_ROLE');
  creationWitness(transaction(read,creationRow),role);
  const since=index.rows.filter(r=>r.slot>=role.creationSlot&&r.slot<=catalogSlot),success=since.filter(r=>r.err===null);out.rowsSinceCreation=since.length;
  if(success.length>CREATOR_TRANSACTION_CAP)fail('CREATOR_WALLET_RECEIPT_CAP');
  for(const row of success){const code=walletTouch(transaction(read,row),role,account);if(code)fail(code);}
  out.successfulInspected=success.length;out.status='OBSERVED';
 }catch(error){out.code=codeOf(error);out.status=statusOf(out.code);}
 return out;
}

/** Inventory of the creation-signer wallet over A30's measured hours; KNOWN only with both the canonical chain and the non-canonical exclusion. */
export function decodeCreatorInventory(token:TokenRef,role:CreatorRole,tape:CreatorTape,receipts:CreatorInventoryReceipts,cutoff:string,reuse:CreatorReuse=new Map()):CreatorInventoryHistory{
 if(token.chain!=='solana'||role.mint!==token.address||!integer(role.creationSlot)||!Number.isFinite(Date.parse(cutoff))||role.wallet===SYSTEM_PROGRAM||role.wallet===INCINERATOR||NATIVE_MINTS.has(role.mint))fail('CREATOR_INVENTORY_SCOPE');
 decodeSolanaAddress(role.wallet);decodeSolanaAddress(role.mint);decodeSolanaAddress(tape.vault);
 const account=getAssociatedTokenAddressSync(new PublicKey(role.mint),new PublicKey(role.wallet),true,TOKEN_2022_PROGRAM_ID).toBase58();
 const keys=Object.keys(receipts.requests).sort();
 if(JSON.stringify(keys)!==JSON.stringify(Object.keys(receipts.rawArtifacts).sort())||JSON.stringify(keys)!==JSON.stringify(Object.keys(receipts.retrievedAt).sort())
  ||keys.some(k=>!/^creator-(ata-head|owner-accounts|(ata|wallet)-page-[01]|tx-[1-9A-HJ-NP-Za-km-z]{64,88})$/.test(k))||keys.filter(k=>k.startsWith('creator-tx-')).length>CREATOR_TRANSACTION_CAP)fail('CREATOR_INVENTORY_RECEIPT_MEMBERSHIP');
 // An identical transaction receipt already retained by another namespace is reused, never stored twice.
 if(keys.some(k=>k.startsWith(TX)&&reuse.has(k.slice(TX.length))))fail('CREATOR_INVENTORY_RECEIPT_MEMBERSHIP');
 const h=tape.history,start=Date.parse(h.range.baselineEnd),end=Date.parse(h.range.end);
 const result:CreatorInventoryHistory={method:CREATOR_INVENTORY_METHOD,token,wallet:role.wallet,account,creationSignature:role.creationSignature,interval:{start:h.range.baselineEnd,end:h.range.end},anchorSlot:h.anchorSlot,
  eligible:false,reasonCode:'CREATOR_TAPE_INCOMPLETE',canonical:emptyCanonical(),walletProof:emptyWallet(),receipts:keys.length,reusedReceipts:[],transactionCap:CREATOR_TRANSACTION_CAP};
 if(!h.complete||!h.pool||h.anchorSlot===null||!Number.isFinite(start)||end-start!==6*HOUR||end>Date.parse(cutoff))return result;
 result.eligible=true;
 const {read,used,reused}=reader(receipts,Date.parse(cutoff),reuse),c=canonical(read,role,account,tape,start,end);result.canonical=c.out;
 if(c.out.status==='OBSERVED')result.walletProof=walletProof(read,role,account,c.out.headSlot!,BigInt(c.out.headAtomic!),c.after);
 else result.walletProof.code='CREATOR_CANONICAL_INCOMPLETE';
 const complete=result.canonical.status==='OBSERVED'&&result.walletProof.status==='OBSERVED';
 if(complete&&keys.some(k=>!used.has(k)))fail('CREATOR_INVENTORY_RECEIPT_MEMBERSHIP');
 result.reusedReceipts=[...reused].sort();
 result.reasonCode=result.canonical.status!=='OBSERVED'?result.canonical.code!:!complete?'CREATOR_NON_CANONICAL_ACCOUNTS_UNPROVEN':CREATOR_PENDING_PREMISES.length?'CREATOR_SOURCE_PREMISE_PENDING':'CREATOR_SIGNER_INVENTORY_OBSERVED';
 return result;
}

export function deriveO24CreatorInventory(history:CreatorInventoryHistory,tape:CreatorTape,evidenceIds:string[]):AdvisoryMetric{
 const c=history.canonical,w=history.walletProof,known=history.eligible&&c.status==='OBSERVED'&&w.status==='OBSERVED'&&CREATOR_PENDING_PREMISES.length===0;
 const quality:AdvisoryMetric['quality']=!history.eligible?'MISSING':c.status==='OBSERVED'?(known?'KNOWN':'TRUNCATED'):c.status;
 const total=(kind:AccountLeg['kind'],quote=false)=>String(c.legs.filter(l=>l.kind===kind).reduce((n,l)=>n+BigInt(quote?tape.history.trades[l.trade!]!.quoteAtomic:l.amountAtomic),0n));
 const inventory=c.status==='OBSERVED'?{startAtomic:c.startAtomic,endAtomic:c.endAtomic,netChangeAtomic:String(BigInt(c.endAtomic!)-BigInt(c.startAtomic!)),
  poolBuyBaseAtomic:total('POOL_BUY'),poolSellBaseAtomic:total('POOL_SELL'),poolBuyCoreQuoteAtomic:total('POOL_BUY',true),poolSellCoreQuoteAtomic:total('POOL_SELL',true),
  transferInBaseAtomic:total('TRANSFER_IN'),transferOutBaseAtomic:total('TRANSFER_OUT'),mintAtomic:total('MINT'),burnAtomic:total('BURN'),legs:c.legs.length}:null;
 return{id:'O24',quality,unit:'target-mint base-atomic inventory change of the creation-signer wallet over the A30 measured hours',evidenceIds:[...new Set(evidenceIds)],reasonCode:history.reasonCode,data:{
  method:CREATOR_INVENTORY_METHOD,scope:known?'CREATION_SIGNER_WALLET_ALL_TARGET_MINT_ACCOUNTS':'CREATION_SIGNER_CANONICAL_ACCOUNT_COMPONENT',
  cohort:{wallet:history.wallet,basis:'CREATION_TX_FEE_PAYER_SOLE_NON_MINT_SIGNER',creationSignature:history.creationSignature,canonicalAccount:history.account,identity:null,control:null},
  interval:history.interval,anchorSlot:history.anchorSlot,inventory,nonCanonicalAccountsZeroThroughout:known?true:null,canonical:c,walletProof:w,receipts:history.receipts,reusedReceipts:history.reusedReceipts,transactionCap:history.transactionCap,
  quoteMint:WSOL,quoteDecimals:9,quoteBasis:'fee-exclusive core quote of bound A30 tape trades',premises:[...PREMISES,...SOURCE_PREMISES,...SYSTEM_PREMISES],sourceCommit:TOKEN_2022_SOURCE_COMMIT,systemSourceCommit:SYSTEM_SOURCE_COMMIT,pendingPremises:CREATOR_PENDING_PREMISES,
  alternatives:['The signer may control other wallets; this cohort is one role-holding key, not a person or group.','Transfers out may be custody moves rather than disposals.'],
  limitations:['The current owner catalog only ends the proof chain; it is not a historical account list.','Pre-interval receipts serve only as reconciled balance witnesses; their legs are not labelled.','Index completeness for creator-referencing transactions is a provider property, cross-checked but not proven.','Exclusion trusts only supported jsonParsed Token, Token-2022 and associated-account forms whose account fields resolve to receipt keys; parsed bodies are the provider decoding of retained instructions, not re-decoded from instruction bytes.','No early-owner cohort, identity, control or fee-recipient claim.','Token-2022 and System-program semantics come from pinned canonical source, not an attestation of the deployed program bytes or runtime.']}};
}
