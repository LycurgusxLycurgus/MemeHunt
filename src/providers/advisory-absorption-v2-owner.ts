import { PublicKey } from '@solana/web3.js';
import type { PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk';
import { decodePumpSwapWindowTransaction, type DecodedTrade } from './advisory-trades.js';
import { executedWindowInstructions, recordedWindowInstructions } from './advisory-window-accounts.js';
import { projectCompiledTransaction } from './advisory-demand-windows.js';

type Pool=ReturnType<typeof PUMP_AMM_SDK.decodePool>;
type Step={ix:any;depth:number;top:number;executed:boolean};
const PUMP='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',TOKEN=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']),EVENT_TAG='e445a52e51cb9a1d';
// Native host programs are not bound by SBF CPI ?-propagation; an open native frame never proves its children.
const NATIVE=new Set(['11111111111111111111111111111111','ComputeBudget111111111111111111111111111111','Vote111111111111111111111111111111111111111','Stake11111111111111111111111111111111111111','Config1111111111111111111111111111111111111','BPFLoaderUpgradeab1e11111111111111111111111','BPFLoader2111111111111111111111111111111111','BPFLoader1111111111111111111111111111111111','LoaderV411111111111111111111111111111111111','NativeLoader1111111111111111111111111111111','AddressLookupTab1e1111111111111111111111111','Ed25519SigVerify111111111111111111111111111','KeccakSecp256k11111111111111111111111111111','Secp256r1SigVerify1111111111111111111111111']);
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fail=(code:string):never=>{throw new Error(code);};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function decode58(text:unknown):Buffer{
 if(typeof text!=='string'||text.length>2048)fail('A29V2_INSTRUCTION');
 let n=0n;for(const c of text as string){const v=ALPHABET.indexOf(c);if(v<0)fail('A29V2_INSTRUCTION');n=n*58n+BigInt(v);}
 let hex=n?n.toString(16):'';if(hex.length%2)hex='0'+hex;
 return Buffer.concat([Buffer.alloc((text as string).match(/^1*/)![0].length),Buffer.from(hex,'hex')]);
}
const pubkeyAt=(d:Buffer,o:number)=>d.length>=o+32?new PublicKey(d.subarray(o,o+32)).toBase58():fail('A29V2_INSTRUCTION');
const address=(s:string)=>{try{return new PublicKey(s).toBase58()===s?s:fail('A29V2_OWNER');}catch{return fail('A29V2_OWNER');}};
// Raw Transfer and TransferChecked only; any other instruction touching the vault fails closed.
function legOf(ix:any){
 const a=ix.accounts,d=decode58(ix.data);
 if(!Array.isArray(a)||a.some((k:unknown)=>typeof k!=='string'))fail('A29V2_INSTRUCTION');
 if(d[0]===3&&d.length===9&&a.length>=3)return{source:a[0] as string,destination:a[1] as string,amount:d.readBigUInt64LE(1),mint:null as string|null};
 if(d[0]===12&&d.length===10&&a.length>=4)return{source:a[0] as string,destination:a[2] as string,amount:d.readBigUInt64LE(1),mint:a[1] as string};
 return null;
}
// A PumpSwap emit_cpi node: its payload equals the decoder's eventCpiPayload identity.
function eventPayload(ix:any):string|null{
 if(ix.programId!==PUMP||!Array.isArray(ix.accounts)||ix.accounts.length!==1)return null;
 const d=decode58(ix.data);return d.subarray(0,8).toString('hex')===EVENT_TAG?d.subarray(8).toString('base64'):null;
}
/** Executed steps. A complete log reuses executedWindowInstructions. A truncated log marks steps in the strict log prefix executed when their frame closed in success or is still open under non-native ancestry; unlogged steps stay unexecuted and are reported through `logged`. */
function stepsV2(projected:any):{list:Step[];logged:number}{
 const logs=projected?.meta?.logMessages;if(!Array.isArray(logs))fail('A29V2_LOG');
 const cut=logs.indexOf('Log truncated');
 if(cut<0){const list=executedWindowInstructions(projected) as Step[];return{list,logged:list.length};}
 if(logs.indexOf('Log truncated',cut+1)>=0||projected.meta.err!==null)fail('A29V2_LOG');
 const list=recordedWindowInstructions(projected) as Step[],closed:boolean[]=[],parent:number[]=[],stack:number[]=[];let cursor=0;
 for(const line of logs.slice(0,cut)){
  if(typeof line!=='string')fail('A29V2_LOG');
  const inv=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/);
  if(inv){const s=list[cursor];if(!s||s.depth!==Number(inv[2])||s.depth!==stack.length+1||s.ix.programId!==inv[1])fail('A29V2_LOG_BINDING');parent[cursor]=stack.at(-1)??-1;stack.push(cursor++);continue;}
  const out=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/);
  if(out){const p=stack.pop();if(p===undefined||list[p]!.ix.programId!==out[1]||out[2]!=='success')fail('A29V2_LOG_FAILURE');closed[p!]=true;}
 }
 const openNative=new Set(stack.filter(p=>NATIVE.has(list[p]!.ix.programId)));
 for(let i=0;i<cursor;i++)list[i]!.executed=!openNative.has(i)&&(closed[i]===true||stack.includes(i))&&(parent[i]!<0||list[parent[i]!]!.executed);
 return{list,logged:cursor};
}

/** A29 v2 decode: the strict modern O28 decoder with truncation recovery and per-trade provenance. */
export function decodeA29TradesV2(value:unknown,expected:{signature:string;slot:number;at:string},poolKey:string,pool:Pool,stateSlot:number,retrieved:string,quoteProgram:string,quoteDecimals:number):{projected:any;trades:DecodedTrade[];cpiAuthorizedAccounts:string[];coverage?:Record<string,number>}{
 const projected=projectCompiledTransaction(value);
 if(projected.transaction.signatures[0]!==expected.signature)fail('A29_TRANSACTION_SIGNATURE');
 const proof=decodePumpSwapWindowTransaction(projected,expected,poolKey,pool,stateSlot,retrieved,true,true,true,true,true,true,quoteProgram,true,quoteDecimals,true);
 for(const t of proof.trades)if(t.signature!==expected.signature||t.slot!==expected.slot||!t.quoteAccounting||t.quoteAccounting.coreQuoteAtomic!==t.quoteAtomic||!t.provenance)fail('A29_TRADE_CORE_QUOTE');
 const r=proof.logRecovery;
 return{projected,trades:proof.trades,cpiAuthorizedAccounts:proof.cpiAuthorizedAccounts,...(r?.truncated?{coverage:{truncated:1,unresolvedInvocations:r.unresolvedInvocations,executionProvenInvocations:r.executionProvenInvocations??0}}:{})};
}

/** Binds a provenance-carrying trade to the single base-vault leg in its own executed event segment, then resolves the leg account owner. The trade user is never the owner; any lifecycle doubt is ambiguous. */
export function bindA29TradeAccountV2(projected:any,trade:DecodedTrade,baseMint:string,baseVault:string):{account:string;owners:string[];ambiguous:boolean;legPosition:number}{
 const p=trade.provenance??fail('A29V2_PROVENANCE');
 const {list,logged}=stepsV2(projected),root=list.findIndex(s=>s.top===p.top&&s.depth===1),at=root<0?-1:p.position<0?root:root+1+p.position,step=list[at];
 if(!step||step.top!==p.top||step.ix.programId!==PUMP||!step.executed)fail('A29_TRADE_STEP');
 let end=at+1;while(end<list.length&&list[end]!.top===step!.top&&list[end]!.depth>step!.depth)end++;
 if(end>logged)fail('A29V2_FRAME_UNLOGGED');
 const events:number[]=[];for(let q=at+1;q<end;q++)if(list[q]!.depth===step!.depth+1&&eventPayload(list[q]!.ix)!==null)events.push(q);
 const k=p.routeEvent,ev=k===null?(events.length===1?events[0]:undefined):events[k];
 if(ev===undefined||eventPayload(list[ev]!.ix)!==p.eventPayload||!list[ev]!.executed)fail('A29V2_EVENT_IDENTITY');
 const from=k===null?at+1:trade.side==='BUY'?ev!+1:k>0?events[k-1]!+1:at+1;
 const to=k===null?end:trade.side==='BUY'?(events[k+1]??end):ev!;
 const legs:Array<{q:number;leg:NonNullable<ReturnType<typeof legOf>>}>=[];
 for(let q=from;q<to;q++){
  const s=list[q]!;if(!s.executed||!TOKEN.has(s.ix.programId)||!Array.isArray(s.ix.accounts)||!s.ix.accounts.includes(baseVault))continue;
  const leg=legOf(s.ix);
  if(!leg||leg.source!==baseVault&&leg.destination!==baseVault)fail('A29_TRADE_VAULT_UNRECOGNIZED');
  if(leg!.mint!==null&&leg!.mint!==baseMint)fail('A29_TRADE_LEG_MINT');
  legs.push({q,leg:leg!});
 }
 if(legs.length!==1)fail('A29_TRADE_LEG');
 const {q:legPosition,leg}=legs[0]!;
 if(leg.amount!==BigInt(trade.baseAtomic))fail('A29_TRADE_LEG_AMOUNT');
 const account=trade.side==='SELL'&&leg.destination===baseVault&&leg.source!==baseVault?leg.source:trade.side==='BUY'&&leg.source===baseVault&&leg.destination!==baseVault?leg.destination:fail('A29_TRADE_LEG_DIRECTION');
 const index=projected.transaction.message.accountKeys.map((x:any)=>x.pubkey).indexOf(account);if(index<0)fail('A29_TRADE_ACCOUNT');
 const balance=(rows:unknown):string|null|undefined=>{
  if(!Array.isArray(rows))fail('A29_TOKEN_BALANCES');
  const hits=(rows as unknown[]).filter(r=>object(r)&&r.accountIndex===index);if(hits.length>1)fail('A29_TOKEN_BALANCES');
  const r=hits[0] as any;if(!r)return undefined;if(r.mint!==baseMint)fail('A29_TOKEN_BALANCE_MINT');
  return typeof r.owner==='string'?address(r.owner):null;
 };
 const pre=balance(projected.meta.preTokenBalances),post=balance(projected.meta.postTokenBalances),owners=new Set<string>(),inits:Array<{q:number;owner:string}>=[];
 let ambiguous=false,closed=false;
 for(const [q,s] of list.entries()){
  if(!TOKEN.has(s.ix.programId)||!Array.isArray(s.ix.accounts)||s.ix.accounts[0]!==account)continue;
  const d=decode58(s.ix.data),lifecycle=d[0]===1||d[0]===6||d[0]===9||d[0]===16||d[0]===18;
  // Unlogged lifecycle instructions on the leg account have unknown execution.
  if(q>=logged){if(lifecycle)ambiguous=true;continue;}
  if(!s.executed)continue;
  if(d[0]===6){if(d.length<3)fail('A29V2_INSTRUCTION');if(d[1]===2){ambiguous=true;if(d[2]===1)owners.add(pubkeyAt(d,3));}}
  else if(d[0]===9)closed=true;
  else if(d[0]===1){if(typeof s.ix.accounts[2]!=='string')fail('A29V2_INSTRUCTION');inits.push({q,owner:s.ix.accounts[2]});}
  else if(d[0]===16||d[0]===18)inits.push({q,owner:pubkeyAt(d,1)});
 }
 if(pre)owners.add(pre);if(post)owners.add(post);for(const i of inits)owners.add(i.owner);
 if(closed||post===undefined||post===null)ambiguous=true;
 // No pre-owner resolves only through one executed initialization before the leg that matches the post-owner.
 else if(pre===undefined){if(inits.length!==1||inits[0]!.q>=legPosition||inits[0]!.owner!==post)ambiguous=true;}
 else if(pre===null||pre!==post||inits.length)ambiguous=true;
 if(owners.size!==1)ambiguous=true;
 return{account,owners:[...owners].sort(),ambiguous,legPosition};
}
