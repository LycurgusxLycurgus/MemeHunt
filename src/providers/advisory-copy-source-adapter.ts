import {isDeepStrictEqual as same} from 'node:util';
import type {TokenRef,EvidenceRecord} from '../domain/contracts.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import {decodeA30CoherentFinancialContext} from './advisory-demand-fx.js';
import {deriveO29QuoteReservePath,type ReservePathTrade} from './advisory-reserve-path.js';
import {decodeRecordedCallerCapture,deriveRecordedCallerMetrics,RECORDED_CALLER_METHOD} from './advisory-recorded-callers.js';
import {verifyPublicCreatorRole,CREATOR_ROLE_RECEIPTS,creatorRoleRpcResult} from './advisory-creator-role.js';
import {recordedWindowInstructions} from './advisory-window-accounts.js';
import {TOKEN_2022_PROGRAM} from './solana.js';
import {decodePinnedWindowEvent} from './pumpswap-window-abi.js';
import type {DirectPrestate} from './advisory-copy-quote.js';
import {evaluateS16Study,serializeS16,type S16StudyInput,type S16StudyTrade} from './advisory-copy-study.js';
import {projectS16CopyCapture,S16_SOURCE_PREFIX,S16_PRIMARY_SOURCES,s16CopyHash} from './advisory-copy-source-import.js';
export * from './advisory-copy-source-import.js';
const check=(v:unknown,code:string):void=>{if(!v)throw Error('S16_COPY_SOURCE_'+code);};
const DEFAULT='11111111111111111111111111111111';
/** Recheck source-specific mint facts; published processor/parser semantics remain an explicit model premise. */
export function verifyS16BirthPremises(token:TokenRef,tx:any,creation:{instructionIndex:number;mintCloseAuthority:string;uniqueness:string}){
 check(creation.uniqueness==='MINT_ALLOCATED_AND_INITIALIZED_IN_THIS_TRANSACTION'&&creation.mintCloseAuthority==='NOT_INITIALIZED','UNIQUE_BIRTH');
 const steps=recordedWindowInstructions(tx),mint=token.address,init=steps.filter(s=>s.top===creation.instructionIndex&&s.ix.programId===TOKEN_2022_PROGRAM&&s.ix.parsed?.type==='initializeMint2'&&s.ix.parsed.info?.mint===mint);
 check(init.length===1,'MINT_INITIALIZATION');const first=steps.indexOf(init[0]!),info=init[0]!.ix.parsed.info;
 check(info.decimals===6&&(info.freezeAuthority===undefined||info.freezeAuthority===null),'BIRTH_FREEZE_AUTHORITY');
 const before=steps.slice(0,first).filter(s=>s.ix.programId===TOKEN_2022_PROGRAM&&s.ix.parsed?.info?.mint===mint);check(before.length===1&&before[0]!.ix.parsed?.type==='initializeMetadataPointer','BIRTH_EXTENSION_SURFACE');
 const top=steps.filter(s=>s.top===creation.instructionIndex&&s.ix.programId===TOKEN_2022_PROGRAM),nullMint=top.filter(s=>s.ix.parsed?.type==='setAuthority'&&s.ix.parsed.info?.mint===mint&&s.ix.parsed.info?.authorityType==='mintTokens'&&s.ix.parsed.info?.newAuthority===null);
 check(nullMint.length===1,'BIRTH_MINT_AUTHORITY');
 return{basis:'UNIQUE_NATIVE_MINT_BIRTH_AND_PINNED_PUBLISHED_PROCESSOR_PARSER_SEMANTICS',mint,decimals:6,preInitializeMintExtensions:['METADATA_POINTER_ONLY'],mintCloseAuthority:'NOT_INITIALIZED',freezeAuthority:'NONE_UNDER_PUBLISHED_RPC_PARSER',mintTokensAuthority:'NONE_IN_COMPLETED_CREATION_FRAME',currentBankBackdated:false,transferFeeModel:'ORDINARY_UNTAXED_TARGET_UNDER_PUBLISHED_INIT_AND_NO_REINITIALIZATION_PREMISES',historicalDeployedBinaryAttested:false};
}
/** All rows are retained; unsupported direct rows keep their native position and cannot be skipped for a later favorable quote. */
export function s16StudyTradeFromBoundFinancial(row:ReservePathTrade,ordinal:number):S16StudyTrade{
 const p=row.provenance,direct=p.hop===null&&p.routeEvent===null,nativeFamily=direct?(p.position===-1?'DIRECT' as const:'CPI_DIRECT' as const):'ROUTE' as const;
 const proof:Record<string,unknown>={nativeOrder:{slot:row.slot,transactionIndex:row.transactionIndex,pumpOrdinal:p.pumpOrdinal,routeEvent:p.routeEvent},top:p.top,position:p.position,hop:p.hop,instructionName:row.instructionName??null,instructionFamily:direct?(row.side==='SELL'?'DIRECT_SELL_FAMILY_NATIVE_BINDER_VERIFIED':'DIRECT_BUY_FAMILY_NATIVE_BINDER_VERIFIED'):'MULTI_HOP_ROUTE',programTimestamp:row.programTimestamp,eventPayloadSha256:s16CopyHash(Buffer.from(p.eventPayload,'base64')),eventPayload:p.eventPayload,quoteAccounting:row.quoteAccounting};
 const output=(state:DirectPrestate|null,unsupportedReason:string|null):S16StudyTrade=>({ordinal,signature:row.signature,slot:row.slot,transactionIndex:row.transactionIndex,at:row.at,side:row.side,nativeFamily,state,unsupportedReason,proof});
 if(!direct)return output(null,'ROUTE_MASKED_FEES_NOT_A_DIRECT_RATE_WITNESS');
 // A direct event nested inside an external program is retained but is outside the fixed top-level instrument.
 if(p.position!==-1)return output(null,'DIRECT_INVOCATION_NOT_TOP_LEVEL');
 let decoded:ReturnType<typeof decodePinnedWindowEvent>;try{decoded=decodePinnedWindowEvent(p.eventPayload,true,true,true);}catch{return output(null,'DIRECT_BOUND_EVENT_UNSUPPORTED');}
 if(!decoded||decoded.name!==(row.side==='BUY'?'buyEvent':'sellEvent'))return output(null,'DIRECT_EVENT_SIDE');const d=decoded.data;
 const required=['poolBaseTokenReserves','poolQuoteTokenReserves','virtualQuoteReserves','lpFeeBasisPoints','protocolFeeBasisPoints','coinCreatorFeeBasisPoints','buybackFeeBasisPoints','cashbackFeeBasisPoints','cashback','coinCreatorFee','holderRewards','holderRewardsBps','quoteTransferFee','baseSupply'];
 if(required.some(k=>d[k]===undefined||d[k]===null))return output(null,'DIRECT_EVENT_FIELD_UNAVAILABLE');
 const n=(k:string)=>BigInt(String(d[k]));let state:DirectPrestate;
 try{
  if(String(d.poolBaseTokenReserves)!==row.poolBaseReservesAtomic||String(d.poolQuoteTokenReserves)!==row.poolQuoteReservesAtomic||String(d.virtualQuoteReserves)!==row.virtualQuoteReservesAtomic||d.user?.toBase58()!==row.user)return output(null,'DIRECT_SAME_PRESTATE_BINDING');
  if(n('cashback')!==0n||n('cashbackFeeBasisPoints')!==0n)return output(null,'DIRECT_CASHBACK_UNSUPPORTED');
  if(n('quoteTransferFee')!==0n||row.quoteAccounting?.quoteTransferFeeAtomic!=='0')return output(null,'DIRECT_QUOTE_TRANSFER_FEE_UNSUPPORTED');
  if(n('virtualQuoteReserves')<=0n)return output(null,'DIRECT_VIRTUAL_DOMAIN_UNCALIBRATED');
  const holder=n('holderRewards'),holderBps=n('holderRewardsBps'),creator=n('coinCreatorFee'),creatorBps=n('coinCreatorFeeBasisPoints'),mode=holder===0n&&holderBps===0n?'NONE' as const:holder===creator&&holderBps===creatorBps?'DUPLICATES_CREATOR_FEE' as const:'UNKNOWN' as const;
  if(mode==='UNKNOWN')return output(null,'DIRECT_HOLDER_REWARD_SEMANTICS');
  const creatorActive=d.coinCreator?.toBase58()!==DEFAULT;if(typeof d.coinCreator?.toBase58!=='function')return output(null,'DIRECT_CREATOR_IDENTITY');
  if(!creatorActive&&(creator!==0n||creatorBps!==0n))return output(null,'DIRECT_INACTIVE_CREATOR_FEE');
  state={baseReserve:n('poolBaseTokenReserves'),quoteReserve:n('poolQuoteTokenReserves'),virtualQuoteReserve:n('virtualQuoteReserves'),rates:{lpBps:n('lpFeeBasisPoints'),protocolBps:n('protocolFeeBasisPoints'),creatorBps,buybackBps:n('buybackFeeBasisPoints')},rateWitnessSide:row.side,creatorActive,holderRewardMode:mode,cashbackBps:0n,quoteTransferFee:'ZERO_WITNESSED',baseTransferFee:'ZERO_DECLARED_PREMISE'};
  Object.assign(proof,{eventName:decoded.name,eventLayout:d.eventLayout,baseSupply:String(d.baseSupply),rateWitnessSide:row.side,holderRewardMode:mode,baseTransferPremise:'UNIQUE_MINT_BIRTH_PINNED_PUBLISHED_TOKEN_SEMANTICS_AND_ORDINARY_FOLLOWER_ACCOUNT',cashbackAmount:'0',cashbackBps:'0',quoteTransferFee:'0'});
 }catch{return output(null,'DIRECT_EVENT_INTEGER_DOMAIN');}return output(state,null);
}
export function validateS16CopySource(token:TokenRef,cutoff:string,evidence:EvidenceRecord[],rawArtifacts:Record<string,string>){
 check(!evidence.some(e=>['advisory-a30-fx','advisory-a26-buyer-post','advisory-a27-marginal'].includes(e.sourceId))&&!Object.keys(rawArtifacts).some(id=>['advisory-a30-fx-','advisory-a26-buyer-post-','advisory-a27-marginal-'].some(prefix=>id.startsWith(prefix))),'COMPETING_SOURCE');
 const projected=projectS16CopyCapture(token,cutoff,evidence,rawArtifacts),{manifest:m,native,supplements,ids,nativeIds}=projected,context=decodeA30CoherentFinancialContext(native,cutoff);
 check(context.financial.history.complete&&context.history.complete&&context.reference.complete&&context.coherenceReason===null,'COMPLETE_COHERENT_FINANCIAL_CONTEXT');
 const curve=deriveO29QuoteReservePath(context.history,context.financial.quote,[]);check(curve?.quality==='KNOWN','COMPLETE_EFFECTIVE_RESERVE_PATH');
 const roleReceipts={requests:{} as Record<string,any>,rawArtifacts:{} as Record<string,string>,retrievedAt:{} as Record<string,string>};
 for(const[local,key]of [['role-page',CREATOR_ROLE_RECEIPTS.page],['role-index',CREATOR_ROLE_RECEIPTS.walletIndex],['role-transaction',CREATOR_ROLE_RECEIPTS.transaction]] as const){const r=m.supplements.find(r=>r.role===local)!;roleReceipts.requests[key]=r.request;roleReceipts.rawArtifacts[key]=supplements[local]!;roleReceipts.retrievedAt[key]=r.retrievedAt;}
 const role=verifyPublicCreatorRole(token,roleReceipts,cutoff,m.roleIndexBefore,true),birth=verifyS16BirthPremises(token,creatorRoleRpcResult(supplements['role-transaction']!),role.creation);
 const callerSpec=m.supplements.find(r=>r.role==='callers')!;check(same(callerSpec.request,{method:RECORDED_CALLER_METHOD}),'CALLER_REQUEST');const decoded=decodeRecordedCallerCapture(supplements.callers!,token,cutoff);check(Date.parse(decoded.availableAt)<=Date.parse(callerSpec.retrievedAt),'CALLER_IMPORT_CLOCK');
 const s07=deriveRecordedCallerMetrics(supplements.callers!,token,cutoff,ids).find(metric=>metric.id==='S07')!,s07data=s07.data as any;check(s07.quality==='KNOWN'&&Array.isArray(s07data?.events)&&s07data.events.length>0&&decoded.capture.qualification!==null,'COMPLETE_QUALIFIED_BATCH');
 const callRefs=s07data.events.map((event:any)=>{check(event.contract===token.address&&event.classification==='FORWARD_CALL','CALL_BINDING');return{...event,classificationAvailableAt:decoded.availableAt};});
 const sourceSummary={financialCoverage:context.financial.sourceCoverage,pairedNativeClocks:context.financial.pairedClocks,crossSourceCoherence:{...context.coherence,complete:true},fxSourceCoverage:context.reference.sourceContext?.coverage,sourceBytes:context.reference.sourceContext?.sourceBytes,storedBytes:context.reference.sourceContext?.storedBytes,mintBirthPremises:birth,primarySemantics:S16_PRIMARY_SOURCES,callSelection:s07data.scope,callEditCoverage:s07data.editCoverage,pairedClocks:{captureCreatedAt:m.captureCreatedAt,detectedAt:decoded.availableAt,originalCallerImportAt:callerSpec.retrievedAt,sourceReceipts:m.supplements.map(r=>({role:r.role,retrievedAt:r.retrievedAt,sha256:r.sha256})),qualification:{proposal:decoded.capture.qualification!.proposal.execution,review:decoded.capture.qualification!.review.execution},callerBodyReceipts:decoded.capture.callers.times,callerBodyCutoff:decoded.history.analysisCutoff,cutoff}};
 const input:S16StudyInput={token,pool:context.history.pool!,range:context.history.range,complete:true,detectedAt:decoded.availableAt,callRefs,trades:context.history.trades.map(s16StudyTradeFromBoundFinancial),availableAt:[m.captureCreatedAt,...Object.values(native.retrievedAt),...m.supplements.map(r=>r.retrievedAt)].sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1)!,sourceSummary};
 const evaluated=evaluateS16Study(input),metric:AdvisoryMetric={id:'S16',quality:evaluated.quality,reasonCode:evaluated.reasonCode,unit:'scoped-record',evidenceIds:ids,data:serializeS16(evaluated.data) as Record<string,unknown>};return{ids,nativeIds,metric};
}
