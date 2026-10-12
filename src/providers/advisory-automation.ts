import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { PublicKey } from '@solana/web3.js';
import type { TokenRef } from '../domain/contracts.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import type { DecodedTrade } from './advisory-trades.js';
import type { AdvisoryWindowHistory, AdvisoryWindowReuse } from './advisory-window.js';
import { executedWindowInstructions } from './advisory-window-accounts.js';
import { fetchReadResponse, readLimitedText } from './http.js';
import { LEGACY_TOKEN_PROGRAM, safeRpcCode, solanaRpc } from './solana.js';

export type AutomationReceipts={rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;requests:Record<string,unknown>};
export const DCA_PROGRAM='DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M';
export const AUTOMATION_REGISTRY_VERSION='jupiter-legacy-dca-flash-fill-v1';
const PUMP_PROGRAM='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',WSOL='So11111111111111111111111111111111111111112',UPGRADEABLE_LOADER='BPFLoaderUpgradeab1e11111111111111111111111';
const COMMIT='https://raw.githubusercontent.com/jup-ag/dca-cpi/545c5ee7ac1324054157a04e028d6d5e512cc756',SOURCE_LIMIT=100_000,EVENT_TAG='e445a52e51cb9a1d',UNIT='WSOL fee-exclusive quote fraction';
const EVENT_AUTHORITY=PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],new PublicKey(DCA_PROGRAM))[0].toBase58();
// Roles with one fixed identity. The observed fill uses the legacy token program; another token program stays unsupported rather than guessed.
const FIXED_ROLES:Record<string,string>={instructionsSysvar:'Sysvar1nstructions1111111111111111111111111',systemProgram:'11111111111111111111111111111111',tokenProgram:LEGACY_TOKEN_PROGRAM,associatedTokenProgram:'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',eventAuthority:EVENT_AUTHORITY,program:DCA_PROGRAM};
const BOUND_ROLES=['keeper','dca','inputMint','keeperInAta','inAta','outAta'],PROGRAM_ROLES=['instructionsSysvar','systemProgram','tokenProgram','associatedTokenProgram'];
function fail(code:string):never{throw new Error(code);}
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const sha256=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
const errorCode=(error:unknown)=>error instanceof Error&&/^ADVISORY_(AUTOMATION|ACCOUNTS)_[A-Z_]+$/.test(error.message)?error.message:'ADVISORY_AUTOMATION_TRANSACTION_INVALID';

/** Versioned registry evidence. The commit-pinned dca-cpi declaration, IDL and README bind the program ID and keeper flash-fill roles; the legacy Recurring (DCA) document supplies automatic-execution language but names no program ID. */
export const OFFICIAL_AUTOMATION_SOURCES=[
 {id:'dca-lib',url:`${COMMIT}/src/lib.rs`,sha256:'f006ddde1f396213aab53b8c30a101041a7066473e15554eade99f8b055acb45',bytes:122,pinnedRetrievedAt:'2026-10-11T21:40:45.457005+00:00',programId:DCA_PROGRAM,role:'PROGRAM_ID_DECLARATION',literal:`declare_id!("${DCA_PROGRAM}");`},
 {id:'dca-idl',url:`${COMMIT}/idl.json`,sha256:'0d2eddb60adb830cacfe278109552c7b7afaa0f450efd655a06b3a836dab4c61',bytes:27920,pinnedRetrievedAt:'2026-10-11T21:40:45.184897+00:00',programId:DCA_PROGRAM,role:'KEEPER_FLASH_FILL_IDL',literal:'"name": "fulfillFlashFill"'},
 {id:'dca-readme',url:`${COMMIT}/README.md`,sha256:'2c3f1f396d4fd3201bf081f7a22d6572cb603b9ae02cb7fa0df6f61793ef9fa2',bytes:246,pinnedRetrievedAt:'2026-10-11T21:40:45.716274+00:00',programId:DCA_PROGRAM,role:'JUPITER_DCA_PRODUCT_BINDING',literal:'CPI helpers for the [Jupiter DCA](https://jup.ag/dca/USDC-SOL) program.'},
 {id:'recurring-doc',url:'https://developers.jup.ag/docs/recurring.md',sha256:'735e27be4fc85ab44049646f4f9fb6c92ee68b52e6479a09b14b5c973539224b',bytes:2685,pinnedRetrievedAt:'2026-10-11T21:44:37.784392+00:00',programId:DCA_PROGRAM,role:'LEGACY_AUTOMATIC_EXECUTION_STATEMENT',literal:'regular token swaps that execute automatically'},
] as const;
const MEANING='Selected-pool WSOL flow certified as Jupiter legacy DCA keeper flash fills under one fixed registry, divided by all decoded selected-pool trade flow in the same complete hour. Zero means only that no flow matched this registry in this pool-hour; it is never total automation, bot-free, organic or manual activity.';
const LIMITATIONS=[
 'Registry covers only the Jupiter legacy DCA program; routers, trading terminals, wallet labels and unregistered automation remain unattributed, not zero.',
 `The legacy Recurring (DCA) document states automatic execution but names no program ID; the commit-pinned dca-cpi declaration, IDL and README bind ${DCA_PROGRAM} and its keeper flash-fill roles. The successor DCA product is not covered.`,
 'Attribution requires one successful top-level initiateFlashFill/fulfillFlashFill pair with identical keeper, DCA, input mint and token accounts, exact token/WSOL orientation, the keeper as Pump user and the keeper-side base account. Shared-account or multi-hop routes without these bindings stay unattributed.',
 'Executable program state is read at a finalized slot no earlier than the window anchor; upgradeable bytecode deployed during the window is not attested.',
 'One selected pool and declared hour only; other pools, venues and whole-token flow are excluded.',
];

const sourceRequest=(url:string)=>({method:'GET',url});
const programRequest=(anchorSlot:number)=>({method:'getAccountInfo',params:[DCA_PROGRAM,{encoding:'base64',commitment:'finalized',minContextSlot:anchorSlot,dataSlice:{offset:0,length:0}}]});
const transactionRequest=(signature:string)=>({method:'getTransaction',params:[signature,{commitment:'finalized',encoding:'jsonParsed',maxSupportedTransactionVersion:1}]});
const eligible=(w:AdvisoryWindowHistory)=>w.complete&&['pumpswap-selected-pool-window-v3','pumpswap-selected-pool-window-v4'].includes(w.method)&&w.pool!==null&&w.anchorSlot!==null&&w.trades.length>0;
function plan(window:AdvisoryWindowHistory):Record<string,unknown>{
 if(!eligible(window))return {};
 return Object.fromEntries([...OFFICIAL_AUTOMATION_SOURCES.map(s=>[`source-${s.id}`,sourceRequest(s.url)]),['program-account',programRequest(window.anchorSlot!)]]);
}
const sourceCode=(error:unknown)=>error instanceof Error&&error.message==='PROVIDER_RESPONSE_LIMIT'?'AUTOMATION_SOURCE_LIMIT':error instanceof Error&&error.message==='PROVIDER_EMPTY_RESPONSE'?'AUTOMATION_SOURCE_EMPTY':error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)?'AUTOMATION_SOURCE_TIMEOUT':'AUTOMATION_SOURCE_TRANSPORT';

/** Fixed reads only after a complete selected-pool hour with trades: four pinned official sources and one finalized program-account state. Failures are retained, never thrown. */
export async function collectAdvisoryAutomation(token:TokenRef,window:AdvisoryWindowHistory,rpcUrl:string,fetcher:typeof fetch,now:()=>string,signal?:AbortSignal):Promise<AutomationReceipts>{
 if(token.chain!=='solana'||window.token.chain!==token.chain||window.token.address!==token.address)fail('ADVISORY_AUTOMATION_SCOPE');
 const receipts:AutomationReceipts={rawArtifacts:{},retrievedAt:{},requests:{}},requests=plan(window);
 if(!Object.keys(requests).length)return receipts;
 await Promise.all(OFFICIAL_AUTOMATION_SOURCES.map(async source=>{
  const id=`source-${source.id}`;receipts.requests[id]=requests[id];
  try{
   const response=await fetchReadResponse(source.url,{headers:{accept:'text/plain'},redirect:'error',signal},fetcher,10_000);
   receipts.rawArtifacts[id]=JSON.stringify({httpStatus:response.status,url:response.url,body:await readLimitedText(response,SOURCE_LIMIT)});
  }catch(error){receipts.rawArtifacts[id]=JSON.stringify({code:sourceCode(error)});}
  receipts.retrievedAt[id]=now();
 }));
 const id='program-account',request=requests[id] as {params:unknown[]};receipts.requests[id]=request;
 try{await solanaRpc(rpcUrl,'getAccountInfo',request.params,fetcher,10_000,signal,raw=>{receipts.rawArtifacts[id]=raw;receipts.retrievedAt[id]=now();});}
 catch(error){if(!receipts.rawArtifacts[id]){receipts.rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:safeRpcCode(error)}});receipts.retrievedAt[id]=now();}}
 return receipts;
}

type Instruction={name:string;accounts:string[];signers:string[];dataLength:number|null;discriminator:string};
export type FlashFillAbi={initiate:Instruction;fulfill:Instruction;known:Map<string,string>};
export type FlashFill={initiateTop:number;fulfillTop:number;keeper:string;dca:string;inputMint:string;outputMint:string;keeperInAta:string;inAta:string;outAta:string;side:'BUY'|'SELL'|null};
const snake=(name:string)=>name.replace(/[A-Z]/g,c=>`_${c.toLowerCase()}`);
/** Role names, signer and argument widths come from the hash-verified official IDL; Anchor discriminators are sha256("global:<snake_name>")[0..8]. */
export function flashFillAbi(idlText:string):FlashFillAbi{
 let idl:unknown=null;try{idl=JSON.parse(idlText);}catch{fail('ADVISORY_AUTOMATION_IDL');}
 if(!object(idl)||idl.name!=='dca'||!Array.isArray(idl.instructions))fail('ADVISORY_AUTOMATION_IDL');
 const all:Instruction[]=idl.instructions.map((ix:unknown)=>{
  if(!object(ix)||typeof ix.name!=='string'||!Array.isArray(ix.accounts)||!Array.isArray(ix.args)||ix.accounts.some((a:unknown)=>!object(a)||typeof a.name!=='string'))fail('ADVISORY_AUTOMATION_IDL');
  const fixed=ix.args.every((a:unknown)=>object(a)&&['u64','i64'].includes(a.type));
  return {name:ix.name,accounts:ix.accounts.map((a:any)=>a.name),signers:ix.accounts.filter((a:any)=>a.isSigner===true).map((a:any)=>a.name),dataLength:fixed?8+8*ix.args.length:null,discriminator:createHash('sha256').update(`global:${snake(ix.name)}`).digest().subarray(0,8).toString('hex')};
 });
 const known=new Map(all.map(ix=>[ix.discriminator,ix.name]));if(known.size!==all.length||known.has(EVENT_TAG))fail('ADVISORY_AUTOMATION_IDL');
 const pick=(name:string,roles:string[])=>{const ix=all.find(x=>x.name===name);if(!ix||ix.dataLength===null||JSON.stringify(ix.signers)!=='["keeper"]'||new Set(ix.accounts).size!==ix.accounts.length||roles.some(role=>!ix.accounts.includes(role)))fail('ADVISORY_AUTOMATION_IDL');return ix;};
 return {initiate:pick('initiateFlashFill',[...BOUND_ROLES,...PROGRAM_ROLES]),fulfill:pick('fulfillFlashFill',[...BOUND_ROLES,...PROGRAM_ROLES,'outputMint','eventAuthority','program']),known};
}
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bytes58(text:unknown):Buffer{
 if(typeof text!=='string'||text.length>2000||!/^[1-9A-HJ-NP-Za-km-z]*$/.test(text))fail('ADVISORY_AUTOMATION_INSTRUCTION');
 let n=0n;for(const c of text)n=n*58n+BigInt(ALPHABET.indexOf(c));let hex=n.toString(16);if(hex.length%2)hex=`0${hex}`;
 return Buffer.concat([Buffer.alloc(text.match(/^1*/)![0].length),n===0n?Buffer.alloc(0):Buffer.from(hex,'hex')]);
}
function fillRoles(ix:any,abi:Instruction,keys:unknown[]):Record<string,string>{
 const a=ix.accounts;
 if(!Array.isArray(a)||a.length!==abi.accounts.length||a.some((x:unknown)=>typeof x!=='string')||bytes58(ix.data).length!==abi.dataLength)fail('ADVISORY_AUTOMATION_FILL_ROLES');
 const roles:Record<string,string>=Object.fromEntries(abi.accounts.map((name,i)=>[name,a[i] as string]));
 for(const [name,id] of Object.entries(FIXED_ROLES))if(name in roles&&roles[name]!==id)fail('ADVISORY_AUTOMATION_FILL_ROLES');
 if(!keys.some(k=>object(k)&&k.pubkey===roles.keeper&&k.signer===true))fail('ADVISORY_AUTOMATION_FILL_SIGNER');
 return roles;
}

/** Certifies a selected-pool trade only between one successful top-level initiate/fulfill pair with identical bound roles, exact token/WSOL orientation, the keeper as Pump user and the expected keeper-side base account. Unknown registered calls fail closed. */
export function bindFlashFills(value:unknown,tokenMint:string,pool:string,trades:DecodedTrade[],abi:FlashFillAbi):{fills:FlashFill[];attributions:Array<FlashFill|null>}{
 const list=executedWindowInstructions(value),keys=(value as any)?.transaction?.message?.accountKeys;
 if(!Array.isArray(keys))fail('ADVISORY_AUTOMATION_TRANSACTION_SHAPE');
 const topProgram=(top:number)=>list.find(s=>s.top===top&&s.depth===1)?.ix.programId;
 const fills:FlashFill[]=[];let open:{top:number;roles:Record<string,string>}|null=null;
 for(const step of list){
  // A failed CPI branch has no runtime effect and certifies nothing.
  if(step.ix.programId!==DCA_PROGRAM||!step.executed)continue;
  const tag=bytes58(step.ix.data).subarray(0,8).toString('hex');
  if(step.depth>1){if(tag!==EVENT_TAG||topProgram(step.top)!==DCA_PROGRAM||JSON.stringify(step.ix.accounts)!==JSON.stringify([EVENT_AUTHORITY]))fail('ADVISORY_AUTOMATION_UNSUPPORTED_CALL');continue;}
  const name=abi.known.get(tag);if(!name)fail('ADVISORY_AUTOMATION_UNSUPPORTED_CALL');
  if(name===abi.initiate.name){if(open)fail('ADVISORY_AUTOMATION_FILL_SEQUENCE');open={top:step.top,roles:fillRoles(step.ix,abi.initiate,keys)};continue;}
  // Manual open/close/deposit/withdraw and keeper transfers are never fills and may not interrupt one.
  if(name!==abi.fulfill.name){if(open)fail('ADVISORY_AUTOMATION_FILL_SEQUENCE');continue;}
  if(!open)fail('ADVISORY_AUTOMATION_FILL_SEQUENCE');
  const r=fillRoles(step.ix,abi.fulfill,keys),o=open.roles;
  if(BOUND_ROLES.some(role=>r[role]!==o[role]))fail('ADVISORY_AUTOMATION_FILL_ROLES');
  const side=r.inputMint===WSOL&&r.outputMint===tokenMint?'BUY':r.inputMint===tokenMint&&r.outputMint===WSOL?'SELL':null;
  fills.push({initiateTop:open.top,fulfillTop:step.top,keeper:r.keeper!,dca:r.dca!,inputMint:r.inputMint!,outputMint:r.outputMint!,keeperInAta:r.keeperInAta!,inAta:r.inAta!,outAta:r.outAta!,side});open=null;
 }
 if(open)fail('ADVISORY_AUTOMATION_FILL_SEQUENCE');
 // trade.instructionIndex indexes Pump program steps in runtime order, as in the window decoder.
 const pumps=list.filter(s=>s.ix.programId===PUMP_PROGRAM);
 const attributions=trades.map(trade=>{
  const step=pumps[trade.instructionIndex],a=step?.ix.accounts;
  if(!step||!step.executed||!Array.isArray(a)||a[0]!==pool||a[1]!==trade.user||a[3]!==tokenMint||a[4]!==WSOL||typeof a[5]!=='string')fail('ADVISORY_AUTOMATION_TRADE_BINDING');
  if(topProgram(step.top)===DCA_PROGRAM)fail('ADVISORY_AUTOMATION_UNSUPPORTED_CALL');
  const fill=fills.find(f=>f.initiateTop<step.top&&step.top<f.fulfillTop)??null;
  return fill&&fill.side===trade.side&&fill.keeper===trade.user&&a[5]===(trade.side==='BUY'?fill.outAta:fill.keeperInAta)?fill:null;
 });
 return {fills,attributions};
}
function windowValue(signature:string,receipts:AdvisoryWindowReuse){
 const expected=JSON.stringify(transactionRequest(signature)),entry=Object.entries(receipts.requests).find(([,request])=>JSON.stringify(request)===expected);
 let value:any=null;try{value=entry?JSON.parse(receipts.rawArtifacts[entry[0]]??'').result:null;}catch{value=null;}
 if(!object(value)||value.transaction?.signatures?.[0]!==signature||!object(value.meta)||value.meta.err!==null)fail('ADVISORY_AUTOMATION_WINDOW_RECEIPT');
 return value;
}

type SourceProof={id:string;url:string;sha256:string;bytes:number;role:string;pinnedRetrievedAt:string;retrievedAt:string;status:'VERIFIED'|'UNVERIFIED';code:string|null};
function verifySources(receipts:AutomationReceipts){
 const bodies:Record<string,string>={};
 const sources=OFFICIAL_AUTOMATION_SOURCES.map((s):SourceProof=>{
  const id=`source-${s.id}`;let w:unknown=null;try{w=JSON.parse(receipts.rawArtifacts[id]!);}catch{w=null;}
  // Exact URL, status, bytes, hash and literal; a legitimate upstream change fails closed against the pin.
  const code:string|null=!object(w)?'AUTOMATION_SOURCE_INVALID':typeof w.code==='string'?(/^AUTOMATION_SOURCE_[A-Z_]{1,40}$/.test(w.code)?w.code:'AUTOMATION_SOURCE_INVALID')
   :w.httpStatus!==200?'AUTOMATION_SOURCE_HTTP':w.url!==s.url?'AUTOMATION_SOURCE_URL':typeof w.body!=='string'?'AUTOMATION_SOURCE_INVALID'
   :Buffer.byteLength(w.body,'utf8')!==s.bytes||sha256(w.body)!==s.sha256?'AUTOMATION_SOURCE_CHANGED':!w.body.includes(s.literal)?'AUTOMATION_SOURCE_LITERAL':null;
  if(code===null&&object(w))bodies[s.id]=w.body;
  return {id:s.id,url:s.url,sha256:s.sha256,bytes:s.bytes,role:s.role,pinnedRetrievedAt:s.pinnedRetrievedAt,retrievedAt:receipts.retrievedAt[id]!,status:code===null?'VERIFIED':'UNVERIFIED',code};
 });
 return {sources,bodies};
}
function verifyProgram(receipts:AutomationReceipts,window:AdvisoryWindowHistory){
 const id='program-account',retrievedAt=receipts.retrievedAt[id]!;let raw:unknown=null;try{raw=JSON.parse(receipts.rawArtifacts[id]!);}catch{raw=null;}
 const r=object(raw)?raw.result:null,v=object(r)?r.value:null,c=object(raw)&&object(raw.error)?raw.error.code:null;
 const code:string|null=!object(raw)||raw.jsonrpc!=='2.0'||raw.id!==1?'AUTOMATION_PROGRAM_SHAPE'
  :raw.error!==undefined?(typeof c==='string'&&/^RPC_[A-Z0-9_-]{1,50}$/.test(c)?c:Number.isSafeInteger(c)&&Math.abs(c)<=999999?`RPC_REMOTE_${c}`:'AUTOMATION_PROGRAM_REMOTE')
  :!object(r)||!object(r.context)||!integer(r.context.slot)||!object(v)?'AUTOMATION_PROGRAM_SHAPE'
  :r.context.slot<window.anchorSlot!?'AUTOMATION_PROGRAM_SLOT':Date.parse(retrievedAt)<Date.parse(window.window.end)?'AUTOMATION_PROGRAM_TIME'
  :v.executable!==true||v.owner!==UPGRADEABLE_LOADER?'AUTOMATION_PROGRAM_NOT_EXECUTABLE':null;
 return {programId:DCA_PROGRAM,owner:UPGRADEABLE_LOADER,executable:code===null,contextSlot:code===null?(r as any).context.slot as number:null,retrievedAt,status:code===null?'VERIFIED':'UNVERIFIED',code};
}

type TradeProof={signature:string;slot:number;at:string;instructionIndex:number;side:'BUY'|'SELL';user:string;quoteAtomic:string;attribution:'JUPITER_LEGACY_DCA_FLASH_FILL'|'UNATTRIBUTED';fill:FlashFill|null};
/** O30 over one complete selected-pool hour; incomplete sources, programs, windows or fill evidence leave it unresolved. */
export function deriveO30Window(token:TokenRef,window:AdvisoryWindowHistory,windowReceipts:AdvisoryWindowReuse,receipts:AutomationReceipts,cutoff:string,evidenceIds:string[]):AdvisoryMetric{
 if(token.chain!=='solana'||window.token.chain!==token.chain||window.token.address!==token.address)fail('ADVISORY_AUTOMATION_SCOPE');
 const cut=Date.parse(cutoff);if(!Number.isFinite(cut)||Date.parse(window.window.end)>cut)fail('ADVISORY_AUTOMATION_TIME');
 const requests=plan(window),keys=Object.keys(requests).sort(),same=(m:unknown)=>object(m)&&JSON.stringify(Object.keys(m).sort())===JSON.stringify(keys);
 if(!same(receipts.rawArtifacts)||!same(receipts.retrievedAt)||!same(receipts.requests))fail('ADVISORY_AUTOMATION_RECEIPT_MEMBERSHIP');
 for(const key of keys){
  if(JSON.stringify(receipts.requests[key])!==JSON.stringify(requests[key])||typeof receipts.rawArtifacts[key]!=='string')fail('ADVISORY_AUTOMATION_REQUEST');
  const at=Date.parse(receipts.retrievedAt[key]??'');if(!Number.isFinite(at)||at>cut)fail('ADVISORY_AUTOMATION_RECEIPT_TIME');
 }
 const ids=[...new Set(evidenceIds)];
 const base={method:'official-automation-flash-fill-window-v1',registryVersion:AUTOMATION_REGISTRY_VERSION,scope:'VERIFIED_PUMPSWAP_WSOL_POOL_HOUR',window:{pool:window.pool,start:window.window.start,end:window.window.end,anchorSlot:window.anchorSlot,method:window.method,complete:window.complete},quoteMint:WSOL,quoteDecimals:9,quoteBasis:'fee-exclusive core quote atomic units',unknownAutomation:'NOT_MEASURED',meaning:MEANING,limitations:LIMITATIONS};
 const unresolved=(reasonCode:string,extra:Record<string,unknown>={}):AdvisoryMetric=>({id:'O30',quality:'MISSING',unit:UNIT,data:{...base,coveredQuoteAtomic:null,knownAutomatedQuoteAtomic:null,knownAutomatedTrades:null,knownAutomatedTransactions:null,knownAutomatedFraction:null,unattributedQuoteAtomic:null,...extra},evidenceIds:ids,reasonCode});
 if(!keys.length)return unresolved(!window.complete||!['pumpswap-selected-pool-window-v3','pumpswap-selected-pool-window-v4'].includes(window.method)||!window.pool?'AUTOMATION_WINDOW_INCOMPLETE':'AUTOMATION_WINDOW_WITHOUT_TRADES');
 const {sources,bodies}=verifySources(receipts),program=verifyProgram(receipts,window);
 let abi:FlashFillAbi|null=null;try{if(bodies['dca-idl'])abi=flashFillAbi(bodies['dca-idl']);}catch{abi=null;}
 const registry={version:AUTOMATION_REGISTRY_VERSION,programs:[{programId:DCA_PROGRAM,role:'KEEPER_EXECUTED_FLASH_FILL',sources,account:program}]};
 const unverified=sources.find(s=>s.status!=='VERIFIED')?.code??program.code??(abi?null:'AUTOMATION_SOURCE_IDL');
 if(unverified||!abi)return unresolved(unverified??'AUTOMATION_SOURCE_IDL',{registry});
 const covered=window.trades.reduce((n,t)=>n+BigInt(t.quoteAtomic),0n);
 if(covered<=0n)return unresolved('AUTOMATION_DENOMINATOR_ZERO',{registry,coveredQuoteAtomic:String(covered)});
 const proofs:TradeProof[]=[],fills:FlashFill[]=[];
 try{
  for(const signature of [...new Set(window.trades.map(t=>t.signature))]){
   const own=window.trades.filter(t=>t.signature===signature),bound=bindFlashFills(windowValue(signature,windowReceipts),token.address,window.pool!,own,abi);
   fills.push(...bound.fills);
   own.forEach((t,i)=>{const fill=bound.attributions[i]??null;proofs.push({signature:t.signature,slot:t.slot,at:t.at,instructionIndex:t.instructionIndex,side:t.side,user:t.user,quoteAtomic:t.quoteAtomic,attribution:fill?'JUPITER_LEGACY_DCA_FLASH_FILL':'UNATTRIBUTED',fill});});
  }
 }catch(error){return unresolved(errorCode(error),{registry,coveredQuoteAtomic:String(covered)});}
 const attributed=proofs.filter(p=>p.fill!==null),known=attributed.reduce((n,p)=>n+BigInt(p.quoteAtomic),0n);
 return {id:'O30',quality:'KNOWN',unit:UNIT,data:{...base,registry,coveredTrades:proofs.length,coveredQuoteAtomic:String(covered),fillsObserved:fills.length,poolOrientedFills:fills.filter(f=>f.side!==null).length,
  knownAutomatedQuoteAtomic:String(known),knownAutomatedTrades:attributed.length,knownAutomatedTransactions:new Set(attributed.map(p=>p.signature)).size,knownAutomatedFraction:new Decimal(known.toString()).div(covered.toString()).toFixed(),unattributedQuoteAtomic:String(covered-known),trades:proofs},
  evidenceIds:ids,reasonCode:'OFFICIAL_AUTOMATION_FLOW_OBSERVED'};
}
