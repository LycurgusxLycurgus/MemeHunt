import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { PublicKey } from '@solana/web3.js';
import { unpackMint, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, poolPda, pumpPoolAuthorityPda } from '@pump-fun/pump-swap-sdk';
import { a30NativeBodyDigests } from './advisory-demand-fx-source.js';
import { decodeWindowQuote } from './advisory-window.js';
import { decodePumpSwapReservePathTransaction } from './advisory-trades.js';
import { decodePinnedWindowEvent } from './pumpswap-window-abi.js';
import { runtimeWindowSteps } from './advisory-runtime-proof.js';
import { C07_COHORT, C07_PROFILE_SHA256, type C07StudyNative } from './advisory-c07-study.js';
import type { TokenRef } from '../domain/contracts.js';

/** In-memory original-native source rederivation. The caller separately authenticates the exact
 * portable archive bytes, original receipt catalogue and whole-capture pins. No filesystem,
 * environment, network, claimed result, source completeness flag or external path is consumed here.
 * Current bank accounts bind immutable pool/mint topology only, never historical mutable reserves.
 */
export type C07NativeAsset = {
 token: TokenRef; pool: string|null; quote: {mint:string;decimals:number;program:string}|null;
 range: {start:string;end:string;startSecond:number;endSecondExclusive:number;baselineEnd:string};
 complete:boolean;reasonCode:string|null;sourceCoverage:any;transactions:any[];trades:any[];
 programAccounts:string[];native:C07StudyNative;
};
const CONTRACT_HASH=C07_PROFILE_SHA256;
const sha=(b:string|Buffer):string=>createHash('sha256').update(b).digest('hex');
function must(v:unknown,code:string):asserts v{if(!v)throw new Error('C07_NATIVE_'+code);}
const contract = {
  "frozenAt": "2026-11-05T08:32:30.468742+00:00",
  "range": {
    "start": "2026-11-04T20:00:00Z",
    "end": "2026-11-05T08:00:00Z",
    "startSecond": 1793822400,
    "endSecondExclusive": 1793865600
  },
  "acquisitionBounds": {
    "perAssetIndexPages": 100,
    "perAssetBulkPages": 200,
    "bulkPageLimit": 100,
    "perAssetCompanionReads": 64,
    "perAssetAnchorBankReads": 10,
    "globalRequests": 2618,
    "globalWallSeconds": 3600,
    "concurrency": 2,
    "perHTTPBodyBytes": 32000000,
    "storedBytesTotal": 3221225472,
    "decodedBytesTotal": 12884901888,
    "automaticOutcomeRetries": 0,
    "onCap": "MISSING asset, no fallback/extension/reroll. Bounded transport recovery only onexactsamequery withfailedattempts retained, no outcomesampling."
  }
};
const selections=C07_COHORT.map(([mint,pool])=>({token:{chain:"solana" as const,address:mint},selected:pool===null?null:{pool,baseMint:mint,quoteMint:"So11111111111111111111111111111111111111112"}}));
const bounds=contract.acquisitionBounds,start=contract.range.startSecond,end=contract.range.endSecondExclusive;
// Global anchor IDs also begin with a; only the closed asset prefix owns a cohort index.
const receiptAssetIndex=(id:string):number|null=>{const m=/^a([0-6])-/.exec(id);return m===null?null:Number(m[1]);};
const rpcRequest=(method:string,params:any[])=>({jsonrpc:'2.0',id:1,method,params});
export function bulkParams(pool:string,anchor:number,cursor:string|null){return [pool,{transactionDetails:'full',encoding:'jsonParsed',maxSupportedTransactionVersion:1,commitment:'finalized',minContextSlot:anchor,sortOrder:'desc',limit:100,...(cursor===null?{}:{paginationToken:cursor}),filters:{slot:{gte:0,lte:anchor},blockTime:{gte:start,lt:end},status:'succeeded',tokenAccounts:'none'}}];}
export function indexParams(pool:string,anchor:number,before:string|null){return [pool,{commitment:'finalized',limit:1000,minContextSlot:anchor,...(before===null?{}:{before})}];}
function openCapture(rawMap:Map<string,string>,cap:any,rows:any[]){
 must(cap.method==='c07-native-wsol-fixed-census-v1'&&cap.contractHash===CONTRACT_HASH&&same(cap.range,contract.range)&&same(cap.limits,bounds)&&Array.isArray(cap.assets)&&cap.assets.length===7&&Array.isArray(rows)&&rows.length<=bounds.globalRequests,'CAPTURE_HEADER');
 for(const [i,a] of (cap.assets as any[]).entries())must(a.index===i&&same(a.token,selections[i].token)&&a.pool===(selections[i].selected?.pool??null),'CAPTURE_COHORT');
 must(rawMap.size===rows.length&&rows.every(r=>rawMap.has(r.id)),'RAW_CATALOG');
 const map=new Map<string,any>();let decoded=0,stored=0,previousClock=Date.parse(cap.startedAt);
 for(const r of rows){
  must(typeof r.id==='string'&&/^(genesis|anchor-slot|anchor-time|a[0-6]-(bank|index-\d{1,3}|bulk-\d{1,3}))$/.test(r.id)&&!map.has(r.id),'RECEIPT_ID');
  const assetIndex=receiptAssetIndex(r.id);if(assetIndex!==null)must(selections[assetIndex].selected,'UNSUPPORTED_ASSET_RECEIPT');
  const text=rawMap.get(r.id);must(typeof text==='string','MISSING_ORIGINAL_BODY');
  const raw=Buffer.from(text!, 'utf8');decoded+=raw.length;stored+=r.archiveBytes;
  must(raw.length<=bounds.perHTTPBodyBytes&&Number.isSafeInteger(r.archiveBytes)&&r.archiveBytes>=0&&decoded<=bounds.decodedBytesTotal&&stored<=bounds.storedBytesTotal&&raw.length===r.sourceBytes&&sha(raw)===r.sourceHash,'SOURCE_INTEGRITY');
  must(r.requestBytes===Buffer.byteLength(JSON.stringify(r.request))&&r.requestHash===sha(JSON.stringify(r.request)),'REQUEST_INTEGRITY');
  const a=Date.parse(r.startedAt),z=Date.parse(r.receivedAt);must(Number.isFinite(a)&&Number.isFinite(z)&&a<=z&&a>=previousClock&&z<=Date.parse(cap.updatedAt)&&a-Date.parse(cap.startedAt)<bounds.globalWallSeconds*1000,'RECEIPT_CLOCKS');previousClock=z;
  map.set(r.id,r);
 }
 must(rows.length===cap.requestsIssued&&decoded===cap.decodedBytes&&stored===cap.storedBytes,'CAPTURE_TOTALS');
 function rawText(id:string):string{const value=rawMap.get(id);must(typeof value==='string','MISSING_ORIGINAL_BODY');return value!;}
 const texts={get:rawText};
 function get(id:string,method:string,params:any[]){const r=map.get(id);must(r&&same(r.request,rpcRequest(method,params))&&r.completeHTTPBody&&r.httpStatus===200&&r.outcome==='RECEIVED','REQUEST_OR_BODY_'+id.replaceAll('-','_').toUpperCase());const v=JSON.parse(rawText(id));must(v.jsonrpc==='2.0'&&v.id===1&&!Object.hasOwn(v,'error')&&Object.hasOwn(v,'result'),'RPC_ENVELOPE');return v.result;}

 const genesis=get('genesis','getGenesisHash',[]);must(genesis==='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d','GENESIS');
 const anchor=get('anchor-slot','getSlot',[{commitment:'finalized'}]),anchorTime=get('anchor-time','getBlockTime',[anchor]);
 must(Number.isSafeInteger(anchor)&&Number.isSafeInteger(anchorTime)&&anchorTime>=end&&anchorTime*1000<=Date.parse(map.get('anchor-time').receivedAt),'FINALIZED_ANCHOR');
 return{cap,rows,map,texts,get,anchor,anchorTime};
}
function validateAssetSources(source:any,i:number){
 const {get,map,texts,anchor}=source,selection=selections[i],s=selection.selected,prefix='a'+i;
 must(s,'NO_ELIGIBLE_POOL_MISSING_NO_FALLBACK');if(!s)throw new Error('C07_NATIVE_NO_POOL');
 const bank=get(prefix+'-bank','getMultipleAccounts',[[s.pool,s.baseMint,s.quoteMint],{encoding:'base64',commitment:'finalized',minContextSlot:anchor}]);
 must(Number.isSafeInteger(bank?.context?.slot)&&bank.context.slot>=anchor&&Array.isArray(bank.value)&&bank.value.length===3,'BANK_CONTEXT');
 const seen=new Set<string>(),expected=new Map<string,any>(),failed:any[]=[],aboveAnchor:any[]=[],outOfRange:any[]=[];let before:string|null=null,lastSlot=Infinity,lastTime=Infinity,indexTerminal=false,indexPages=0;
 for(let p=0;p<bounds.perAssetIndexPages&&!indexTerminal;p++){
  const id=prefix+'-index-'+p,rows:any[]=get(id,'getSignaturesForAddress',indexParams(s.pool,anchor,before));indexPages++;
  must(Array.isArray(rows)&&rows.length<=1000,'INDEX_SHAPE');
  for(const r of rows){
   must(typeof r.signature==='string'&&r.signature.length>=64&&!seen.has(r.signature)&&Number.isSafeInteger(r.slot)&&r.slot>=0&&r.slot<=lastSlot&&Number.isSafeInteger(r.blockTime)&&r.blockTime<=lastTime&&r.confirmationStatus==='finalized'&&Object.hasOwn(r,'err'),'INDEX_IDENTITY_CLOCK_ORDER');
   seen.add(r.signature);lastSlot=r.slot;lastTime=r.blockTime;
   if(r.slot>anchor){aboveAnchor.push(r);continue;}must(r.blockTime<=source.anchorTime,'INDEX_ANCHOR_CLOCK');
   if(r.blockTime<start||r.blockTime>=end){outOfRange.push(r);continue;}
   if(r.err!==null)failed.push(r);else expected.set(r.signature,{...r,nativeIndexOrder:expected.size});
  }
  indexTerminal=rows.some((r:any)=>r.blockTime<start)||rows.length<1000;
  before=rows.at(-1)?.signature;must(indexTerminal||typeof before==='string','INDEX_CURSOR');
 }
 must(indexTerminal,'INDEX_PAGE_CAP_INCOMPLETE');
 let cursor:string|null=null,bulkTerminal=false,bulkPages=0,lastPosition=[Infinity,Infinity];const transactions:any[]=[],bodyDigests:any[]=[],positions=new Set(),seenBulk=new Set();
 for(let p=0;p<bounds.perAssetBulkPages&&!bulkTerminal;p++){
  const id=prefix+'-bulk-'+p,v:any=get(id,'getTransactionsForAddress',bulkParams(s.pool,anchor,cursor)),r=map.get(id);bulkPages++;
  must(v&&Object.keys(v).sort().join()==='data,paginationToken'&&Array.isArray(v.data)&&v.data.length<=100,'BULK_SHAPE');
  const digests=a30NativeBodyDigests(texts.get(id));
  for(const tx of v.data){
   const signature=tx.transaction?.signatures?.[0],idx=expected.get(signature),pos=[tx.slot,tx.transactionIndex];
   must(idx&&idx.nativeIndexOrder===transactions.length&&!seenBulk.has(signature)&&tx.slot===idx.slot&&tx.blockTime===idx.blockTime&&tx.slot<=anchor&&Number.isSafeInteger(tx.transactionIndex)&&tx.transactionIndex>=0&&tx.meta?.err===null&&['legacy',0,1].includes(tx.version)&&Array.isArray(tx.transaction?.message?.accountKeys)&&tx.transaction.message.accountKeys.some((k:any)=>k.pubkey===s.pool)&&Array.isArray(tx.meta.logMessages)&&Array.isArray(tx.meta.innerInstructions),'BULK_INDEX_NATIVE_BIJECTION');
   must(pos[0]<lastPosition[0]||pos[0]===lastPosition[0]&&pos[1]<lastPosition[1],'BULK_ORDER');lastPosition=pos;
   must(!positions.has(pos.join(':')),'POSITION_DUPLICATE');positions.add(pos.join(':'));seenBulk.add(signature);
   const digest=digests.get(signature);must(digest&&digest.slot===tx.slot&&digest.blockTime===tx.blockTime&&digest.transactionIndex===tx.transactionIndex,'LOSSLESS_BODY_DIGEST');
   transactions.push({tx,sourceId:id,sourceAt:r.receivedAt,sourceHash:r.sourceHash,canonicalBodyHash:digest.hash});bodyDigests.push({...digest});
  }
  const next:any=v.paginationToken;must(next===null||typeof next==='string'&&v.data.length>0&&next===v.data.at(-1).slot+':'+v.data.at(-1).transactionIndex&&next!==cursor,'BULK_CURSOR');
  bulkTerminal=next===null;cursor=next;
 }
 must(bulkTerminal&&transactions.length===expected.size&&[...expected.keys()].every((s:any)=>seenBulk.has(s)),'COMPLETE_BULK_BIJECTION');
 const actual=source.rows.filter((r:any)=>r.id.startsWith(prefix+'-')).map((r:any)=>r.id).sort(),wanted=[prefix+'-bank',...Array.from({length:indexPages},(_,p)=>prefix+'-index-'+p),...Array.from({length:bulkPages},(_,p)=>prefix+'-bulk-'+p)].sort();
 must(same(actual,wanted),'UNEXPECTED_ASSET_RECEIPTS');
 return{bank,transactions,sourceCoverage:{complete:true,indexTerminal,bulkTerminal,indexPages,bulkPages,successfulReferences:expected.size,failedReferences:failed,aboveAnchorExcluded:aboveAnchor,outOfRangeReferences:outOfRange,bodyDigests,anchorSlot:anchor,anchorBlockTime:source.anchorTime}};
}

const u=(x:any):bigint=>{must(typeof x==='string'&&/^(0|[1-9]\d{0,19})$/.test(x)&&BigInt(x)<=18446744073709551615n,'NATIVE_ATOMIC');return BigInt(x);};
const clean=(x:any):any=>typeof x==='bigint'?String(x):x?.toBase58?x.toBase58():x?.constructor?.name==='BN'?x.toString():Array.isArray(x)?x.map(clean):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v]:[string,any])=>[k,clean(v)])):x;
function account(raw:any){
 must(raw&&raw.executable===false&&typeof raw.owner==='string'&&Array.isArray(raw.data)&&raw.data[1]==='base64','ACCOUNT_SHAPE');
 const data=Buffer.from(raw.data[0],'base64');must(data.toString('base64')===raw.data[0]&&data.length<=20000,'ACCOUNT_DATA');
 return{data,owner:new PublicKey(raw.owner),lamports:raw.lamports,executable:false,rentEpoch:0};
}
function verifySelectedIdentity(bank:any,s:any){
 const a=bank.value.map(account);must(a[0].owner.equals(PUMP_AMM_PROGRAM_ID),'POOL_OWNER');
 must([TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(a[1].owner.toBase58()),'BASE_MINT_OWNER');
 const pool=PUMP_AMM_SDK.decodePool(a[0]),baseProgram=a[1].owner,mint=unpackMint(new PublicKey(s.baseMint),a[1],baseProgram),quote=decodeWindowQuote(bank.value[2],s.quoteMint);
 must(mint.isInitialized&&quote.decimals===9&&quote.mint==='So11111111111111111111111111111111111111112'&&quote.program===TOKEN_PROGRAM_ID.toBase58(),'NATIVE_QUOTE_IDENTITY');
 must(pool.baseMint.toBase58()===s.baseMint&&pool.quoteMint.toBase58()===s.quoteMint&&pool.index===0&&pool.creator.equals(pumpPoolAuthorityPda(new PublicKey(s.baseMint)))&&poolPda(pool.index,pool.creator,pool.baseMint,pool.quoteMint).toBase58()===s.pool,'POOL_PDA_TOPOLOGY');
 must(getAssociatedTokenAddressSync(pool.baseMint,new PublicKey(s.pool),true,baseProgram).equals(pool.poolBaseTokenAccount)&&getAssociatedTokenAddressSync(pool.quoteMint,new PublicKey(s.pool),true,TOKEN_PROGRAM_ID).equals(pool.poolQuoteTokenAccount),'POOL_VAULT_ATA_TOPOLOGY');
 return{pool,quote,baseProgram:baseProgram.toBase58(),baseDecimals:mint.decimals};
}

/** Adapted only S18's independent child-transfer + event prestate + whole token-balance closure.
 * No S18 selection, source purpose, pin or historical source authority is imported.
 * Routes are deliberately unsupported and invalidate the whole asset rather than disappear.
 */
function verifyNativeTransfersAndBalances(tx:any,proof:any,s:any,pool:any,quote:any){
 const runtime=runtimeWindowSteps(tx,false),local:any[]=[],rows:any[]=[];
 must(!runtime.truncated,'RUNTIME_TRUNCATED');
 const poolSummary={baseVault:pool.poolBaseTokenAccount.toBase58(),quoteVault:pool.poolQuoteTokenAccount.toBase58()};
        for (const trade of proof.trades) {
            const p = trade.provenance, frame = runtime.list.findIndex((z:any) => z.top === p.top && z.position === p.position);
            must(frame >= 0 && runtime.list[frame].proof === 'LOGGED_SUCCESS', 'NATIVE_EVENT_FRAME');
            let parent = runtime.list[frame].parent;
            while (parent >= 0) {
                must(runtime.list[parent].proof === 'LOGGED_SUCCESS', 'NATIVE_ANCESTRY');
                parent = runtime.list[parent].parent;
            }
            must(p.hop === null && p.routeEvent === null, 'PRIVATE_TRANSFER_ROUTE_UNSUPPORTED');
            const ev = decodePinnedWindowEvent(p.eventPayload, true, true, true);
            must(ev, 'EVENT_REDECODE');const d = ev.data;
            must(ev && d.pool.toBase58() === s.pool && d.user.toBase58() === trade.user, 'EVENT_REDECODE');
            const children = runtime.list.filter((z:any) => z.parent === frame && [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(z.ix.programId));
            const transfers = children.map((z:any) => { must(z.proof === 'LOGGED_SUCCESS', 'CHILD_TRANSFER_COMMITMENT'); const i = z.ix.parsed?.info, t = z.ix.parsed?.type; must(['transfer', 'transferChecked', 'transferCheckedWithFee'].includes(t) && i && typeof i.source === 'string' && typeof i.destination === 'string' && typeof i.authority === 'string' && !i.multisigAuthority, 'PRIVATE_TRANSFER_KIND_UNSUPPORTED'); return { source: i.source, destination: i.destination, authority: i.authority, mint: i.mint ?? null, amount: u(i.tokenAmount?.amount ?? i.amount), fee: i.feeAmount ? u(i.feeAmount.amount) : null, program: z.ix.programId }; });
            const buy = trade.side === 'BUY', baseSource = buy ? poolSummary.baseVault : d.userBaseTokenAccount.toBase58(), baseDest = buy ? d.userBaseTokenAccount.toBase58() : poolSummary.baseVault, b = transfers.filter((t:any) => t.source === baseSource && t.destination === baseDest);
            must(b.length === 1 && b[0].amount === u(trade.baseAtomic) && b[0].mint === s.baseMint && b[0].authority === (buy ? s.pool : trade.user), 'ACTUAL_BASE_TRANSFER');
            const qt = transfers.filter((t:any) => buy ? t.source === d.userQuoteTokenAccount.toBase58() : t.source === poolSummary.quoteVault);
            must(qt.length > 0 && qt.length + 1 === transfers.length && qt.every((t:any) => t.program === quote.program && (t.mint === null || t.mint === s.quoteMint) && t.authority === (buy ? trade.user : s.pool)), 'ACTUAL_QUOTE_TRANSFERS');
            const q = trade.quoteAccounting, total = qt.reduce((n:bigint,t:any) => n + t.amount, 0n);
            must(q && u(trade.quoteAtomic) === u(q.coreQuoteAtomic), 'CORE_QUOTE');
            if (buy)
                must(total === u(q.walletQuoteAtomic ?? q.grossQuoteAtomic), 'BUY_GROSS_TRANSFER_TOTAL');
            else {
                if(trade.instructionName==='sell_v2'){
                    // The public financial decoder binds this version to the original raw discriminator.
                    // V2 retains accrued protocol/creator fees; only user proceeds and buyback physically leave.
                    const accounts=runtime.list[frame].ix.accounts,buyback=u(q.buybackFeeAtomic);
                    must(Array.isArray(accounts)&&accounts.length===17&&accounts[14]!==d.userQuoteTokenAccount.toBase58(),'SELL_V2_BUYBACK_ROLE');
                    must(buyback===u(q.protocolFeeAtomic)*u(String(d.buybackFeeBasisPoints))/10000n,'SELL_V2_BUYBACK_SUBDIVISION');
                    const buybackLeg=qt.filter((t:any)=>t.destination===accounts[14]);
                    must(buyback===0n?buybackLeg.length===0||buybackLeg.length===1&&buybackLeg[0].amount===0n:buybackLeg.length===1&&buybackLeg[0].amount===buyback,'SELL_V2_BUYBACK_TRANSFER');
                    must(qt.every((t:any)=>t.destination===d.userQuoteTokenAccount.toBase58()||t.destination===accounts[14]),'SELL_V2_QUOTE_RECIPIENT');
                    must(total===u(q.userQuoteAtomic)+buyback,'SELL_V2_POOL_DEBIT_TOTAL');
                }else must(total === u(q.coreQuoteAtomic) - u(q.lpFeeAtomic), 'SELL_POOL_DEBIT_TOTAL');
                const userLeg = qt.filter((t:any) => t.destination === d.userQuoteTokenAccount.toBase58());
                must(userLeg.length === 1 && userLeg[0].amount === u(q.walletQuoteAtomic ?? q.userQuoteAtomic), 'SELL_USER_TRANSFER');
            }
            rows.push({provenance:trade.provenance,payloadHash:sha(Buffer.from(p.eventPayload,'base64')),frame,ancestorsCommitted:true,transfers:clean(transfers)});
            local.push({ trade, d, frame });
        }
        // Whole-transaction token metadata conservation for selected pool vaults and actual user base accounts.
        const ks = tx.transaction.message.accountKeys, presentKeys = new Set(ks.map((k:any) => k.pubkey));
        if (local.length)
            must(presentKeys.has(poolSummary.baseVault) && presentKeys.has(poolSummary.quoteVault), 'TRADE_VAULT_KEYS');
        const watches = new Map<string,string>([[poolSummary.baseVault, s.baseMint], [poolSummary.quoteVault, s.quoteMint], ...local.map((e:any) => [e.d.userBaseTokenAccount.toBase58(), s.baseMint])].filter(([account]) => presentKeys.has(account)) as [string,string][]), pre = new Map<string,any>(tx.meta.preTokenBalances.map((t:any) => [ks[t.accountIndex].pubkey, t])), post = new Map<string,any>(tx.meta.postTokenBalances.map((t:any) => [ks[t.accountIndex].pubkey, t])), balances = new Map<string,bigint>();
        for (const [a, m] of watches) {
            const z = pre.get(a);
            if (z) {
                must(z.mint === m, 'PRE_TOKEN_MINT');
                balances.set(a, u(z.uiTokenAmount.amount));
            }
            else {
                must(runtime.list.some((z:any) => z.proof === 'LOGGED_SUCCESS' && /^initializeAccount/.test(z.ix.parsed?.type ?? '') && z.ix.parsed.info.account === a && z.ix.parsed.info.mint === m), 'PRE_TOKEN_ZERO_CREATION_WITNESS');
                balances.set(a, 0n);
            }
        }
        for (const [j, z] of runtime.list.entries()) {
            for (const l of local.filter((l:any) => l.frame === j)) {
                must(balances.get(poolSummary.baseVault) === u(String(l.d.poolBaseTokenReserves)) && balances.get(poolSummary.quoteVault) === u(String(l.d.poolQuoteTokenReserves)), 'EVENT_PRESTATE_NATIVE_BALANCES');
            }
            if (![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(z.ix.programId))
                continue;
            const i = z.ix.parsed?.info, t = z.ix.parsed?.type;
            if (!i) {
                must(!z.ix.accounts?.some((a:any)=>watches.has(typeof a==='string'?a:a?.pubkey)), 'WATCHED_UNPARSED_TOKEN_OPERATION');
                continue;
            }
            if (watches.has(i.account))
                must(/^initializeAccount/.test(t??'') || t==='closeAccount', 'WATCHED_ACCOUNT_OPERATION_UNSUPPORTED');
            const from = watches.has(i.source), to = watches.has(i.destination);
            if (!from && !to)
                continue;
            must(z.proof === 'LOGGED_SUCCESS' && ['transfer', 'transferChecked', 'transferCheckedWithFee'].includes(t), 'WATCHED_TOKEN_OPERATION_UNSUPPORTED');
            const amount = u(i.tokenAmount?.amount ?? i.amount), fee = i.feeAmount ? u(i.feeAmount.amount) : 0n;
            if (from)
                {balances.set(i.source, balances.get(i.source)! - amount);must(balances.get(i.source)!>=0n,'NEGATIVE_WATCHED_BALANCE');}
            if (to)
                balances.set(i.destination, balances.get(i.destination)! + amount - fee);
        }
        for (const [a, m] of watches) {
            const z = post.get(a);
            if (z) {
                must(z.mint === m && balances.get(a) === u(z.uiTokenAmount.amount), 'POST_NATIVE_TOKEN_CONSERVATION');
            }
            else
                must(balances.get(a) === 0n && runtime.list.some((z:any) => z.proof === 'LOGGED_SUCCESS' && z.ix.parsed?.type === 'closeAccount' && z.ix.parsed.info.account === a), 'POST_ZERO_CLOSE_WITNESS');
        }

 return rows.map((r:any)=>({...r,transactionBalanceClosure:true,independentConfirmation:"TRANSFER_AND_NATIVE_BALANCE_RECONCILED"}));
}


function healthWindows(status:'MISSING'|'COMPLETE',reason:string|null):C07StudyNative['windows']{return [{status,reason},{status,reason},{status,reason}];}

/** Returns exact seven-asset source/financial tape; never labels C07 or computes windows. */
export function reconstructC07Native(rawMap:Map<string,string>,capture:any,receipts:any[]):C07NativeAsset[]{
 let source:ReturnType<typeof openCapture>|undefined,globalGap:string|null=null;try{source=openCapture(rawMap,capture,receipts);}catch(e){globalGap=e instanceof Error?e.message:"C07_NATIVE_SOURCE_INVALID";}
 const assets=selections.map((selection,i)=>{
  const base:C07NativeAsset={token:selection.token,pool:selection.selected?.pool??null,quote:null,range:{...contract.range,baselineEnd:'2026-11-05T02:00:00Z'},complete:false,reasonCode:null,sourceCoverage:null,transactions:[],trades:[],programAccounts:[],native:{status:'MISSING',reason:null,sourceIds:[],availableAt:contract.frozenAt,windows:healthWindows('MISSING','NATIVE_TAPE_NOT_COMPLETE'),events:[]}};
  try{
   must(selection.selected,'NO_ELIGIBLE_POOL_MISSING_NO_FALLBACK');must(source,globalGap??'CAPTURE_UNAVAILABLE');if(!source||!selection.selected)throw new Error(globalGap??"C07_NATIVE_SOURCE_UNAVAILABLE");
   const s=selection.selected,admitted=validateAssetSources(source,i),identity=verifySelectedIdentity(admitted.bank,s);base.quote=identity.quote;base.sourceCoverage=admitted.sourceCoverage;
   const programs=new Set<string>(),physical=new Set<string>();
   for(const row of admitted.transactions){
    const {tx}=row,signature=tx.transaction.signatures[0],at=new Date(tx.blockTime*1000).toISOString();
    const proof=decodePumpSwapReservePathTransaction(tx,{signature,slot:tx.slot,at},s.pool,identity.pool,admitted.bank.context.slot,row.sourceAt,identity.quote.program,9,{});
    must(!proof.logRecovery?.truncated&&(proof.logRecovery?.unresolvedInvocations??0)===0,'UNRESOLVED_FINANCIAL_LOGS');
    const closures=verifyNativeTransfersAndBalances(tx,proof,s,identity.pool,identity.quote);
    const trades=proof.trades.map((t,j)=>{
     must(t.quoteAccounting&&t.quoteAccounting.coreQuoteAtomic===t.quoteAtomic,'CORE_QUOTE');u(t.quoteAtomic);
     const p=t.provenance,id=[signature,p.top,p.position,p.pumpOrdinal,p.hop,p.routeEvent].join(':');must(!physical.has(id),'DUPLICATE_PHYSICAL_EVENT');physical.add(id);
     return{...t,transactionIndex:tx.transactionIndex,blockTime:tx.blockTime,sourceId:row.sourceId,sourceAt:row.sourceAt,sourceHash:row.sourceHash,canonicalBodyHash:row.canonicalBodyHash,closure:closures[j]};
    });
    // Publish atomically after the entire transaction's financial and independent closure guards pass.
    base.transactions.push({signature,slot:tx.slot,at,transactionIndex:tx.transactionIndex,status:'OBSERVED',tradeCount:trades.length,foreignSwapLegs:proof.foreignSwapLegs,nonSwapInvocations:proof.nonSwapInvocations,cpiAuthorizedAccounts:proof.cpiAuthorizedAccounts});
    base.trades.push(...trades);for(const a of proof.cpiAuthorizedAccounts)programs.add(a);
   }
   base.trades.sort((a,b)=>a.slot-b.slot||a.transactionIndex-b.transactionIndex||a.provenance.pumpOrdinal-b.provenance.pumpOrdinal||(a.provenance.routeEvent??-1)-(b.provenance.routeEvent??-1));
   base.programAccounts=[...programs].sort();base.complete=true;
   const ids=['genesis','anchor-slot','anchor-time',...source.rows.filter((r:any)=>r.id.startsWith('a'+i+'-')).map((r:any)=>r.id)];
   const availableAt=ids.map(id=>source!.map.get(id).receivedAt).sort().at(-1)!;
   base.native={status:'COMPLETE',reason:null,sourceIds:ids,availableAt,windows:healthWindows('COMPLETE',null),events:base.trades.map(t=>({signature:t.signature,instructionOrdinal:t.provenance.pumpOrdinal,eventOrdinal:t.provenance.routeEvent??0,blockTime:t.blockTime,programTimestamp:t.programTimestamp,slot:t.slot,transactionIndex:t.transactionIndex,user:t.user,side:t.side,coreQuoteAtomic:t.quoteAtomic,cpiAuthorizedAccounts:base.programAccounts}))};
  }catch(e){base.reasonCode=e instanceof Error?e.message:"C07_NATIVE_TAPE_UNAVAILABLE";base.native.reason=base.reasonCode;base.native.windows=healthWindows('MISSING',base.reasonCode);if(source){base.native.sourceIds=source.rows.filter((r:any)=>receiptAssetIndex(r.id)===i||receiptAssetIndex(r.id)===null).map((r:any)=>r.id);base.native.availableAt=base.native.sourceIds.map(id=>source!.map.get(id).receivedAt).sort().at(-1)??contract.frozenAt;}}
  return base;
 });
 return clean(assets);
}
