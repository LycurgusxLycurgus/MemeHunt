import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import type {TokenRef} from '../domain/contracts.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import {SOLANA_MAINNET_GENESIS,decodeSolanaAddress,LEGACY_TOKEN_PROGRAM,TOKEN_2022_PROGRAM} from './solana.js';
import {decodeO25LifetimePool,O25_QUOTE_MINT} from './advisory-creator-lifetime-import.js';
import {deriveO25BulkLifetime} from './advisory-creator-lifetime-bulk.js';
import {visitO24BulkSources,type O24BulkSourceContext} from './advisory-creator-inventory-bulk.js';
import {recordedWindowInstructions} from './advisory-window-accounts.js';
import {classifyCreatorFailedFees,archiveCreatorFailedFeeReceipt,failedFeeRequest,failedFeeReceiptId,FAILED_FEE_ADAPTER,FAILED_FEE_SOURCE_ID,type FailedFeeReceipt} from './advisory-creator-failed-fees.js';
import {composeS15ReferenceBook,type NativeLeg,type NativeJoin,type ReferencePoint,type TargetBar} from './advisory-creator-reference-book.js';
import {decodeS15ReferenceCapture,projectS15Lifetime,s15ReferenceRecord,type S15DecodedReferenceCapture,type S15ReferenceRecord} from './advisory-creator-reference-import.js';
const METHOD='creator-target-reference-book-v1',SYS='11111111111111111111111111111111',WSOL='So11111111111111111111111111111111111111112';
const TOKENS=new Set([LEGACY_TOKEN_PROGRAM,TOKEN_2022_PROGRAM]),U64=2n**64n-1n;
const fail:(code:string)=>never=code=>{throw Error('S15_REFERENCE_'+code);};
function check(value:unknown,code:string):asserts value{if(!value)fail(code);}
const obj=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const atom=(v:unknown)=>{check(typeof v==='string'&&/^(0|[1-9]\d{0,19})$/.test(v)&&BigInt(v)<=U64,'NATIVE_ATOMIC');return BigInt(v);};
const native=(v:unknown)=>{check(integer(v),'NATIVE_INTEGER');return BigInt(v);};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const recordAt=(r:S15ReferenceRecord)=>{check(r.retrievedAt!==null,'RECORD_CLOCK');return r.retrievedAt;};
function rpc(r:S15ReferenceRecord){const v=JSON.parse(r.raw);check(obj(v)&&v.jsonrpc==='2.0'&&v.id===1&&v.error===undefined&&Object.hasOwn(v,'result'),'RPC_ENVELOPE');return v.result;}
function successfulTransport(r:S15ReferenceRecord){const status=r.receipt?.httpStatus??r.receipt?.status;check(status===undefined||status===200,'TRANSPORT_UNAVAILABLE');}

/** Bind positive own outcomes and every ancestor; successful outer calls never prove unseen inner success. */
export function s15NativeCommitments(tx:any){
 const list=recordedWindowInstructions(tx),parents:number[]=[],steps=list.map((s,order)=>{while(parents.length>=s.depth)parents.pop();check(parents.length+1===s.depth,'NATIVE_DEPTH');const parentOrder=parents.at(-1)??null;parents.push(order);return{...s,order,parentOrder,ownOutcome:null as boolean|null,commitment:'UNKNOWN_INNER_COMMITMENT' as 'COMMITTED'|'ROLLED_BACK'|'UNKNOWN_INNER_COMMITMENT'};});
 check(Array.isArray(tx.meta.logMessages)&&tx.meta.logMessages.every((s:unknown)=>typeof s==='string'),'NATIVE_LOGS');
 let cursor=0,truncated=false;const stack:number[]=[];
 for(const line of tx.meta.logMessages as string[]){
  if(/log truncated/i.test(line)){truncated=true;break;}
  const inv=/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(line);
  if(inv){const s=steps[cursor];check(s&&s.ix.programId===inv[1]&&s.depth===Number(inv[2])&&s.depth===stack.length+1&&s.parentOrder===(stack.at(-1)??null),'NATIVE_LOG_BINDING');stack.push(cursor++);continue;}
  const out=/^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/.exec(line);
  if(out){const at=stack.pop();check(at!==undefined&&steps[at]!.ix.programId===out[1],'NATIVE_LOG_BINDING');steps[at]!.ownOutcome=out[2]==='success';}
 }
 if(!truncated)check(cursor===steps.length&&stack.length===0,'NATIVE_LOG_INCOMPLETE');
 for(const s of steps){const parent=s.parentOrder===null?null:steps[s.parentOrder]!;
  if(s.depth===1){check(s.ownOutcome!==false&&tx.meta.err===null,'NATIVE_TOP_OUTCOME');s.commitment='COMMITTED';}
  else if(s.ownOutcome===false||parent?.commitment==='ROLLED_BACK')s.commitment='ROLLED_BACK';
  else if(s.ownOutcome===true&&parent?.commitment==='COMMITTED')s.commitment='COMMITTED';
 }
 return{steps,truncated};
}
const strings=(v:unknown):string[]=>typeof v==='string'?[v]:Array.isArray(v)?v.flatMap(strings):obj(v)?Object.values(v).flatMap(strings):[];
export type S15NativeCashRow={signature:string;slot:number;transactionIndex:number;canonicalIndexed:boolean;actorSigner:boolean;feePayer:string;actorSystemPreLamports:string;actorSystemPostLamports:string;actorSystemDeltaLamports:string;observedActorPaidNetworkFeeLamports:string;reportedActorOwnedWsolPreAtomic:string;reportedActorOwnedWsolPostAtomic:string;reportedActorOwnedWsolDeltaAtomic:string;sourceRecordId:string;sourceHash:string;sourceAvailableAt:string};
export type S15NativeCost={signature:string;order:number;top:number;depth:number;parentOrder:number|null;kind:'SYSTEM_TRANSFER'|'ACCOUNT_FUNDING'|'TOKEN_CLOSE';commitment:'COMMITTED'|'ROLLED_BACK'|'UNKNOWN_INNER_COMMITMENT';source:string;destination:string;explicitLamports:string|null;provedCanonicalRefundLamports:string|null;expenseAllocation:null;rentPrincipalSplit:null;sourceRecordId:string;sourceHash:string};
export function s15NativeCash(tx:any,context:O24BulkSourceContext,record:S15ReferenceRecord){
 const keys=tx.transaction.message.accountKeys,meta=tx.meta;check(Array.isArray(keys)&&keys.length>0,'NATIVE_KEYS');const addresses=keys.map((k:any)=>{check(obj(k)&&typeof k.pubkey==='string'&&typeof k.signer==='boolean'&&typeof k.writable==='boolean','NATIVE_KEYS');decodeSolanaAddress(k.pubkey);return k.pubkey as string;});check(new Set(addresses).size===keys.length,'NATIVE_KEYS');
 const actor=context.role.wallet,index=addresses.indexOf(actor);check(index>=0&&keys[0].signer&&keys[0].writable,'NATIVE_PAYER');check(Array.isArray(meta.preBalances)&&Array.isArray(meta.postBalances)&&meta.preBalances.length===keys.length&&meta.postBalances.length===keys.length,'NATIVE_BALANCES');
 const pre=meta.preBalances.map(native) as bigint[],post=meta.postBalances.map(native) as bigint[],fee=native(meta.fee);check(post.reduce((n,v)=>n+v,0n)-pre.reduce((n,v)=>n+v,0n)===-fee,'NATIVE_CASH_CONSERVATION');
 const signature=tx.transaction.signatures[0] as string,{steps,truncated}=s15NativeCommitments(tx),costs:S15NativeCost[]=[];
 for(const s of steps){const p=s.ix.parsed,i=p?.info;if(!obj(p)||!obj(i))continue;const system=s.ix.programId===SYS,close=TOKENS.has(s.ix.programId)&&p.type==='closeAccount';if(!(system&&['transfer','createAccount','createAccountWithSeed'].includes(p.type))&&!close)continue;
  const source=close?i.account:i.source,destination=close||p.type==='transfer'?i.destination:i.newAccount;check(typeof source==='string'&&typeof destination==='string'&&addresses.includes(source)&&addresses.includes(destination),'NATIVE_COST_ACCOUNTS');const amount=close?null:native(i.lamports).toString();
  let refund:string|null=null;
  if(close&&source===context.canonicalAccount&&s.depth===1&&s.commitment==='COMMITTED'){
   const touched=tx.transaction.message.instructions.map((ix:any,top:number)=>({top,refs:[...strings(ix.accounts),...strings(ix.parsed)]})).filter((v:any)=>v.refs.includes(source));
   if(touched.length===1&&touched[0].top===s.top&&steps.filter(q=>q.top===s.top).length===1&&post[addresses.indexOf(source)]===0n)refund=pre[addresses.indexOf(source)]!.toString();
  }
  costs.push({signature,order:s.order,top:s.top,depth:s.depth,parentOrder:s.parentOrder,kind:close?'TOKEN_CLOSE':p.type==='transfer'?'SYSTEM_TRANSFER':'ACCOUNT_FUNDING',commitment:s.commitment,source,destination,explicitLamports:amount,provedCanonicalRefundLamports:refund,expenseAllocation:null,rentPrincipalSplit:null,sourceRecordId:record.id,sourceHash:record.sourceHash});
 }
 const wsol=(side:'preTokenBalances'|'postTokenBalances')=>{check(Array.isArray(meta[side]),'WSOL_BALANCES');const seen=new Set<number>();let total=0n;for(const b of meta[side]){if(b.mint!==WSOL)continue;check(integer(b.accountIndex)&&b.accountIndex<keys.length&&!seen.has(b.accountIndex)&&b.programId===LEGACY_TOKEN_PROGRAM&&b.uiTokenAmount?.decimals===9&&typeof b.owner==='string','WSOL_OWNER');seen.add(b.accountIndex);decodeSolanaAddress(b.owner);const value=atom(b.uiTokenAmount.amount);if(b.owner===actor)total+=value;}return total;};
 const w0=wsol('preTokenBalances'),w1=wsol('postTokenBalances'),row:S15NativeCashRow={signature,slot:tx.slot,transactionIndex:tx.transactionIndex,canonicalIndexed:context.canonicalRows.some(r=>r.signature===signature&&r.err===null),actorSigner:keys[index].signer,feePayer:addresses[0]!,actorSystemPreLamports:pre[index]!.toString(),actorSystemPostLamports:post[index]!.toString(),actorSystemDeltaLamports:(post[index]!-pre[index]!).toString(),observedActorPaidNetworkFeeLamports:addresses[0]===actor?fee.toString():'0',reportedActorOwnedWsolPreAtomic:w0.toString(),reportedActorOwnedWsolPostAtomic:w1.toString(),reportedActorOwnedWsolDeltaAtomic:(w1-w0).toString(),sourceRecordId:record.id,sourceHash:record.sourceHash,sourceAvailableAt:recordAt(record)};
 return{row,costs,truncated};
}
function cashSummary(rows:S15NativeCashRow[]){return{transactions:rows.length,actorSystemDeltaLamports:rows.reduce((n,r)=>n+BigInt(r.actorSystemDeltaLamports),0n).toString(),reportedOwnedWsolDeltaAtomic:rows.reduce((n,r)=>n+BigInt(r.reportedActorOwnedWsolDeltaAtomic),0n).toString(),actorNetworkFeeLamports:rows.reduce((n,r)=>n+BigInt(r.observedActorPaidNetworkFeeLamports),0n).toString()};}

function failedSources(c:S15DecodedReferenceCapture,context:O24BulkSourceContext,cutoff:string){
 const get=(id:string)=>s15ReferenceRecord(c,id),genesis=get(c.failed.genesisRecordId);check(genesis.kind==='ARCHIVE_CHAIN_BINDING'&&same(genesis.request,{jsonrpc:'2.0',id:1,method:'getGenesisHash',params:[]})&&rpc(genesis)===SOLANA_MAINNET_GENESIS,'ARCHIVE_GENESIS');successfulTransport(genesis);
 const bySignature=(ids:string[])=>{const map=new Map<string,S15ReferenceRecord>();for(const id of ids){const r=get(id),q=r.request;check(obj(q)&&q.jsonrpc==='2.0'&&q.id===1&&Array.isArray(q.params)&&typeof q.params[0]==='string'&&same(q,{jsonrpc:'2.0',id:1,...failedFeeRequest(q.params[0])})&&!map.has(q.params[0]),'FAILED_REQUEST');map.set(q.params[0],r);}return map;};
 const primary=bySignature(c.failed.primaryRecordIds),archives=bySignature(c.failed.archiveRecordIds),usedArchives=new Set<string>(),rows=context.walletRows.filter(r=>r.err!==null),receipts:FailedFeeReceipt[]=[],provenance=[];
 check(primary.size===rows.length&&[...primary.keys()].every(s=>rows.some(r=>r.signature===s)),'FAILED_INDEX_CLOSURE');
 for(const row of rows){const p=primary.get(row.signature)!;successfulTransport(p);let selected=p;const initial=rpc(p);
  if(initial===null){check(p.kind==='FAILED_ORIGINAL_NULL_ALTERNATE','FAILED_NULL_KIND');selected=archives.get(row.signature)??fail('FAILED_ARCHIVE_MISSING');check(selected.kind==='FAILED_SELECTED_ARCHIVE_BODY'&&Date.parse(recordAt(selected))>=Date.parse(recordAt(p)),'FAILED_ARCHIVE_CLOCK');successfulTransport(selected);check(rpc(selected)!==null,'FAILED_ARCHIVE_NULL');usedArchives.add(selected.id);}
  else check(p.kind==='FAILED_SELECTED_PRIMARY_BODY','FAILED_PRIMARY_KIND');
  const stored=archiveCreatorFailedFeeReceipt(selected.raw);receipts.push({id:failedFeeReceiptId(row.signature),sourceId:FAILED_FEE_SOURCE_ID,adapterVersion:FAILED_FEE_ADAPTER,request:failedFeeRequest(row.signature),retrievedAt:recordAt(selected),contentHash:sha(stored),stored});provenance.push({signature:row.signature,primaryRecordId:p.id,primarySourceHash:p.sourceHash,primaryResultNull:initial===null,selectedRecordId:selected.id,selectedSourceHash:selected.sourceHash,selectedAvailableAt:selected.retrievedAt});
 }
 check(usedArchives.size===archives.size,'FAILED_ARCHIVE_ORPHAN');
 const result=classifyCreatorFailedFees({actor:context.role.wallet,mint:c.token.address,targetAccounts:[context.canonicalAccount],creationSlot:context.role.creation.slot,headSlot:context.stateSlot,cutoff,rows:rows.map(r=>({...r,confirmationStatus:'finalized' as const})),receipts},false,true);
 check(result.status!=='INVALID'&&result.rows.length===rows.length&&result.coverage.missing===0&&result.coverage.unavailable===0&&result.rows.every(r=>r.actorChargedLamports!==null&&r.metaFeeLamports!==null&&(r.classification==='NOT_ACTOR_CHARGED'||r.classification==='TARGET_ASSOCIATED_CHARGED'||r.classification==='UNRESOLVED'&&r.code==='ACTOR_CHARGED_TARGET_UNPROVEN')),'FAILED_REQUIRED_CHARGE_UNAVAILABLE');
 return{observation:result,purposeStatus:result.status,allocation:'UNALLOCATED_WALLET_OVERHEAD',observedActorChargedLamports:result.rows.reduce((n,r)=>n+BigInt(r.actorChargedLamports!),0n).toString(),provenance};
}

// Preserve JSON number source lexemes rather than reserializing Number-rounded prices.
type Numeric={value:number;lexeme:string};
const parseNumbers=(raw:string):any=>(JSON.parse as unknown as (text:string,reviver:(key:string,value:unknown,context?:{source?:string})=>unknown)=>unknown)(raw,(_key,value,context)=>typeof value==='number'?{value,lexeme:context?.source??fail('PRICE_LEXEME_RUNTIME')}:value);
function number(v:unknown){check(obj(v)&&integer(v.value)&&typeof v.lexeme==='string','PRICE_NATIVE_INTEGER');return v.value as number;}
function lexeme(v:unknown){check(obj(v)&&typeof v.lexeme==='string'&&typeof v.value==='number'&&Number.isFinite(v.value),'PRICE_NUMBER');return v.lexeme as string;}
export function s15ReferencePrices(c:S15DecodedReferenceCapture,pool:string,targetDecimals=6){
 const nativePoints:ReferencePoint[]=[],target:TargetBar[]=[];
 for(const id of [...c.prices.requiredRecordIds,...c.prices.optionalHistoryRecordIds]){
  const r=s15ReferenceRecord(c,id),required=c.prices.requiredRecordIds.includes(id);check(r.kind===(required?'PRICE_REQUIRED_BODY':'PRICE_OPTIONAL_EARLIER_EMPTY'),'PRICE_RECORD_KIND');successfulTransport(r);const req=r.request;check(obj(req)&&req.method==='GET'&&typeof req.url==='string','PRICE_REQUEST');const u=new URL(req.url);check(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&!u.port,'PRICE_URL');const body=parseNumbers(r.raw),availableAt=recordAt(r);
  if(u.hostname==='coins.llama.fi'){
   check(/^\/chart\/solana:[1-9A-HJ-NP-Za-km-z]+(?:,solana:[1-9A-HJ-NP-Za-km-z]+)*$/.test(u.pathname)&&obj(body?.coins),'PRICE_CANONICAL_SOURCE');const requested=u.pathname.slice('/chart/'.length).split(','),allowed=new Map([[O25_QUOTE_MINT,8],[WSOL,9],[c.token.address,targetDecimals]]);check(new Set(requested).size===requested.length&&requested.every(k=>allowed.has(k.slice(7))),'PRICE_CANONICAL_IDENTITY');
   check([...u.searchParams.keys()].every(k=>['start','period','span','searchWidth'].includes(k))&&/^\d+$/.test(u.searchParams.get('start')??'')&&['5m','15m'].includes(u.searchParams.get('period')??'')&&/^\d+$/.test(u.searchParams.get('span')??'')&&u.searchParams.get('searchWidth')==='5m','PRICE_REQUEST_WINDOW');
   const from=Number(u.searchParams.get('start')),period=u.searchParams.get('period')==='5m'?300:900,span=Number(u.searchParams.get('span'));check(Number.isSafeInteger(from)&&Number.isSafeInteger(span)&&span>0&&span<=180,'PRICE_REQUEST_WINDOW');
   for(const [key,coin]of Object.entries(body.coins) as [string,any][]){const mint=key.slice(7);check(requested.includes(key)&&obj(coin)&&number(coin.decimals)===allowed.get(mint)&&Array.isArray(coin.prices),'PRICE_RESPONSE_IDENTITY');
    for(const [sourceIndex,p]of coin.prices.entries()){const referenceUnix=number(p.timestamp),priceLexeme=lexeme(p.price);check(referenceUnix>=from-300&&referenceUnix<=from+period*span+300,'PRICE_RESPONSE_WINDOW');if(mint===c.token.address)continue;nativePoints.push({mint,referenceUnix,priceLexeme,recordId:id,sourceHash:r.sourceHash,sourceIndex,availableAt});}
   }
   if(!required)check(Object.keys(body.coins).length===0,'OPTIONAL_EMPTY_HISTORY');
  }else{
   check(required&&u.hostname==='api.geckoterminal.com'&&u.pathname===`/api/v2/networks/solana/pools/${pool}/ohlcv/minute`&&u.searchParams.get('aggregate')==='1'&&u.searchParams.get('currency')==='usd'&&u.searchParams.get('token')===c.token.address&&u.searchParams.get('include_empty_intervals')==='false'&&u.searchParams.get('limit')==='1000'&&/^\d+$/.test(u.searchParams.get('before_timestamp')??'')&&[...u.searchParams.keys()].every(k=>['aggregate','currency','token','include_empty_intervals','limit','before_timestamp'].includes(k)),'TARGET_PRICE_REQUEST');
   check(body.data?.type==='ohlcv_request_response'&&body.meta?.base?.address===c.token.address&&body.meta?.quote?.address===O25_QUOTE_MINT&&Array.isArray(body.data.attributes?.ohlcv_list),'TARGET_PRICE_RESPONSE');
   let previous=Infinity;for(const [sourceIndex,bar]of body.data.attributes.ohlcv_list.entries()){check(Array.isArray(bar)&&bar.length===6,'TARGET_BAR');const startUnix=number(bar[0]);check(startUnix%60===0&&startUnix<previous&&startUnix<=Number(u.searchParams.get('before_timestamp')),'TARGET_BAR_ORDER');previous=startUnix;for(const value of bar)lexeme(value);target.push({mint:c.token.address,pool,startUnix,endUnix:startUnix+60,referenceUnix:startUnix+60,priceLexeme:lexeme(bar[4]),recordId:id,sourceHash:r.sourceHash,sourceIndex,availableAt});}
  }
 }
 return{native:nativePoints,target};
}

const atomicText=z.string().regex(/^(0|[1-9]\d{0,19})$/),index=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),text=z.string().min(1);
const legSchema=z.object({signature:text,slot:index,at:text,programTimestamp:z.string().nullable(),order:index,top:index,rawLegId:text,direction:z.enum(['IN','OUT']),kind:z.enum(['PURCHASE','CROSS_ASSET_EXCHANGE','CREATOR_FEE','HOLDER_DISTRIBUTION','SALE','PLAIN_TRANSFER']),amountAtomic:atomicText,counterasset:z.object({mint:text,program:text,decimals:z.number().int().min(0).max(255),amountAtomic:atomicText}).nullable(),sourceSemantics:text});
const joinSchema=z.object({acquiredRawLegId:text,disposedRawLegId:text,disposition:z.enum(['SALE','PLAIN_TRANSFER']),unitsAtomic:atomicText,holdingSeconds:z.number().int().nonnegative()});

/** Native ownership is established independently of whether the declared reference marks cover every lot. */
export function validateS15ReferenceSource(raw:string,token:TokenRef,cutoff:string,evidenceIds:string[]){
 const capture=decodeS15ReferenceCapture(raw,cutoff);check(same(capture.token,token),'TOKEN');
 const {inventory,bank}=projectS15Lifetime(capture,cutoff),pool=decodeO25LifetimePool(bank,token,inventory.stateSlot,cutoff),lifetime=deriveO25BulkLifetime(inventory,pool,cutoff,[]);
 check(lifetime.quality==='KNOWN'&&obj(lifetime.data)&&lifetime.data.status==='COMPLETE'&&lifetime.data.holdings?.heldAtomic==='0'&&lifetime.data.fifo?.method==='FORWARD_FIFO_TARGET_QUANTITIES','LIFETIME_REQUIRED_NATIVE_PROOF');
 const data=lifetime.data,ledger:NativeLeg[]=z.array(legSchema).min(1).parse(data.ledger),fifo:NativeJoin[]=z.array(joinSchema).parse(data.fifo.consumptions),cashRows:S15NativeCashRow[]=[],costRows:S15NativeCost[]=[];let truncatedTraces=0;
 const decimals=new Set<number>(),sourceRecords=capture.decodedRecords.filter(r=>r.kind==='O25_INVENTORY');
 const context=visitO24BulkSources(inventory,cutoff,(tx,_indexed,at,source)=>{
  const keys=tx.transaction.message.accountKeys as {pubkey:string}[];if(!keys.some(k=>k.pubkey===token.address||k.pubkey===source.canonicalAccount))return;
  const matches=sourceRecords.filter(r=>r.sourceHash===source.sourceHashes.at(-1)&&r.retrievedAt===at);check(matches.length===1,'NATIVE_BODY_SOURCE');const observed=s15NativeCash(tx,source,matches[0]!);cashRows.push(observed.row);costRows.push(...observed.costs);if(observed.truncated)truncatedTraces++;
  if(observed.row.canonicalIndexed)for(const b of [...tx.meta.preTokenBalances,...tx.meta.postTokenBalances])if(b.mint===token.address&&b.owner===source.role.wallet){check(integer(b.uiTokenAmount?.decimals)&&b.uiTokenAmount.decimals<=255,'TARGET_DECIMALS');decimals.add(b.uiTokenAmount.decimals);}
 });
 check(decimals.size===1,'TARGET_DECIMALS');const targetDecimals=[...decimals][0]!;
 cashRows.sort((a,b)=>a.slot-b.slot||a.transactionIndex-b.transactionIndex);costRows.sort((a,b)=>{const x=cashRows.findIndex(r=>r.signature===a.signature),y=cashRows.findIndex(r=>r.signature===b.signature);return x-y||a.order-b.order;});
 const failed=failedSources(capture,context,cutoff),prices=s15ReferencePrices(capture,pool.poolKey,targetDecimals),bookResult=composeS15ReferenceBook({position:{token,actor:context.role.wallet,canonicalAccount:context.canonicalAccount,creationSignature:context.role.creation.signature,creationSlot:context.role.creation.slot,headSlot:context.stateSlot,targetDecimals,heldAtomic:'0',targetPool:pool.poolKey,ledger,fifo},prices,cutoff});
 const canonical=cashRows.filter(r=>r.canonicalIndexed),noncanonical=cashRows.filter(r=>!r.canonicalIndexed),legSignatures=new Set(ledger.map(l=>l.signature)),nativeCash={rows:cashRows,total:cashSummary(cashRows),canonical:cashSummary(canonical),noncanonical:cashSummary(noncanonical),canonicalLifecycleOnlySignatures:canonical.filter(r=>!legSignatures.has(r.signature)).map(r=>r.signature),meaning:'TARGET_KEY_REFERENCE_NATIVE_CASH_ENDPOINTS_NOT_TARGET_PNL',noDoubleCount:'Endpoint deltas already include native funding, consideration, fees and refunds; explanatory movements are never added again.'};
 const nativeCosts={rows:costRows,truncatedTraces,commitmentCounts:Object.fromEntries(['COMMITTED','ROLLED_BACK','UNKNOWN_INNER_COMMITMENT'].map(k=>[k,costRows.filter(r=>r.commitment===k).length])),canonicalRefundTotalLamports:costRows.reduce((n,r)=>n+BigInt(r.provedCanonicalRefundLamports??'0'),0n).toString(),canonicalRefunds:costRows.filter(r=>r.provedCanonicalRefundLamports!==null).map(r=>({signature:r.signature,order:r.order,destination:r.destination,lamports:r.provedCanonicalRefundLamports})),expenseAllocation:null,rentPrincipalSplit:null,meaning:'OBSERVED_NATIVE_MOVEMENTS_WITH_UNRESOLVED_PURPOSE_AND_EXPLICIT_COMMITMENT'};
 const sourceCoverage={historicalHeadSlot:context.stateSlot,nativeCreationSlot:context.role.creation.slot,nativeHeadUnix:context.stateBlockTime,originalInventoryClockRange:{first:[...Object.values(inventory.retrievedAt)].sort()[0],last:[...Object.values(inventory.retrievedAt)].sort().at(-1)},successfulWalletBodies:context.counts.bulkBodies,canonicalSuccessful:context.canonicalRows.filter(r=>r.err===null).length,failedIndexed:context.walletRows.filter(r=>r.err!==null).length,nativeReferencePoints:prices.native.length,targetReferenceBars:prices.target.length,sourceRecords:capture.records.map(r=>({id:r.id,kind:r.kind,sourceHash:r.sourceHash,sourceBytes:r.sourceBytes,archiveHash:r.archiveHash??null,retrievedAt:r.retrievedAt,request:r.request})),captureCreatedAt:capture.captureCreatedAt};
 const metric:AdvisoryMetric=bookResult.status==='COMPLETE'?{id:'S15',quality:'KNOWN',unit:'scoped-record',reasonCode:'CREATOR_TARGET_REFERENCE_BOOK_OBSERVED',evidenceIds,data:{method:METHOD,status:'COMPLETE',completeReferenceBook:true,aggregateNetProfit:null,token,cohort:{kind:'CREATOR_ONLY',wallet:context.role.wallet,canonicalAccount:context.canonicalAccount,identity:null,control:null},censoring:{profile:'EMPTY_HELD_HISTORICAL_HEAD',creationSlot:context.role.creation.slot,creationSignature:context.role.creation.signature,headSlot:context.stateSlot,nativeHeadUnix:context.stateBlockTime,analysisCutoff:cutoff,currentWalletState:false,strategyHorizon:'OBSERVED_TARGET_POSITION_LIFETIME_NOT_FUTURE_STRATEGY'},book:bookResult.book,nativeCash,nativeCosts,failed,sourceCoverage,limitations:['One native signed-creation wallet and target, not a person or all controlled wallets.','Foreign entry basis is received-target reference value, not foreign-asset price, fair exchange proof or actual cash spend.','Protocol-credit zero token purchase consideration does not mean zero income, tax basis or total claim cash cost.','Native endpoint cash and failed overhead remain separate denominations and purpose scopes; aggregate net profit is not measured.','Reference prices were retrieved later; historical reference timestamps do not prove public availability at the native event.','Transferred basis is carried without invented proceeds, recipient-person identity or downstream return.']}}:{id:'S15',quality:'MISSING',unit:'scoped-record',reasonCode:bookResult.reasonCode,evidenceIds,data:{method:METHOD,status:'MISSING',completeReferenceBook:false,aggregateNetProfit:null,book:null,nativeCash,failed,sourceCoverage}};
 return{capture,metric};
}
export function deriveS15ReferenceBook(raw:string,token:TokenRef,cutoff:string,evidenceIds:string[]):AdvisoryMetric{
 try{return validateS15ReferenceSource(raw,token,cutoff,evidenceIds).metric;}catch(error){return{id:'S15',quality:'MISSING',unit:'scoped-record',reasonCode:error instanceof Error?error.message.slice(0,180):'S15_REFERENCE_SOURCE_UNAVAILABLE',evidenceIds,data:{method:METHOD,status:'MISSING',completeReferenceBook:false,aggregateNetProfit:null,book:null}};}
}
