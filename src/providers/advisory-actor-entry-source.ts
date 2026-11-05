import {isDeepStrictEqual as same} from 'node:util';
import type {TokenRef,EvidenceRecord} from '../domain/contracts.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import {verifyPublicCreatorRole,CREATOR_ROLE_RECEIPTS,creatorRoleRpcResult,type PublicCreatorRole} from './advisory-creator-role.js';
import {decodeCreatorQuoteTrade} from './advisory-creator-quote.js';
import {decodeRecordedCallerCapture,deriveRecordedCallerMetrics,RECORDED_CALLER_METHOD} from './advisory-recorded-callers.js';
import {SOLANA_MAINNET_GENESIS} from './solana.js';
import {S14_SOURCE_ID,S14_SOURCE_PREFIX,S14_CAPTURE_ID,S14_ADAPTER,S14_ROLES,S14_CAPTURE_BYTES,decodeS14EntryManifest,s14EntryHash,s14EntryScope} from './advisory-actor-entry-import.js';
export * from './advisory-actor-entry-import.js';
const check=(v:unknown,code:string):void=>{if(!v)throw Error('S14_ENTRY_'+code);};
export const s14EntryOwns=(e:EvidenceRecord)=>e.sourceId===S14_SOURCE_ID||e.id.startsWith(S14_SOURCE_PREFIX)||e.adapterVersion===S14_ADAPTER;
/** The only supported entry is a positively proven purchase in this unique mint's birth transaction. */
export function verifyS14BirthTrade(role:PublicCreatorRole,trade:ReturnType<typeof decodeCreatorQuoteTrade>){
 check(role.creation.uniqueness==='MINT_ALLOCATED_AND_INITIALIZED_IN_THIS_TRANSACTION'&&role.creation.mintCloseAuthority==='NOT_INITIALIZED'&&trade.side==='BUY'&&trade.signature===role.creation.signature&&trade.slot===role.creation.slot&&trade.at===role.creation.at&&trade.base.mint===role.token.address&&trade.base.preAtomic==='0'&&BigInt(trade.base.unitsAtomic)>0n&&trade.base.postAtomic===trade.base.unitsAtomic,'BIRTH_PURCHASE_REQUIRED');
}
export function deriveS14EntryMetric(role:PublicCreatorRole,trade:ReturnType<typeof decodeCreatorQuoteTrade>,caller:AdvisoryMetric,ids:string[],clocks:unknown):AdvisoryMetric{
 verifyS14BirthTrade(role,trade);const data=caller.data as any;
 check(caller.id==='S07'&&caller.quality==='KNOWN'&&Array.isArray(data?.events)&&data.events.length>0,'COMPLETE_CALL_EVENTS_REQUIRED');
 const events=[...data.events].sort((a,b)=>Date.parse(a.publishedAt)-Date.parse(b.publishedAt)||String(a.sourceId).localeCompare(String(b.sourceId)));
 const seen=new Set<string>();for(const e of events){check(e.contract===role.token.address&&e.classification==='FORWARD_CALL'&&typeof e.sourceId==='string'&&!seen.has(e.sourceId)&&Number.isFinite(Date.parse(e.publishedAt)),'CALL_EVENT');seen.add(e.sourceId);}
 const signedSeconds=(Date.parse(trade.at)-Date.parse(events[0]!.publishedAt))/1000;
 return{id:'S14',quality:'KNOWN',unit:'scoped-record',reasonCode:'CREATOR_BIRTH_ENTRY_OBSERVED_CALL_LEAD_MEASURED',evidenceIds:ids,data:{method:'creator-birth-observed-call-lead-v1',scope:'CREATOR_ONLY_VS_INDEPENDENT_PUBLIC_CALLS',wallet:role.wallet,token:role.token,socialAccountBound:false,personIdentityAsserted:false,ongoingControlAsserted:false,entry:{at:trade.at,signature:trade.signature,slot:trade.slot,timePrecision:'SECOND',proof:'UNIQUE_MINT_BIRTH_POSITIVE_PURCHASE',unitsAtomic:trade.base.unitsAtomic,execution:trade.execution},earliestObservedCalls:events.filter(e=>Date.parse(e.publishedAt)===Date.parse(events[0]!.publishedAt)),events:events.map(e=>({...e,signedSeconds:(Date.parse(trade.at)-Date.parse(e.publishedAt))/1000})),signedSeconds,signConvention:'ENTRY_MINUS_CALL_NEGATIVE_MEANS_ENTRY_PRECEDED_CALL',globalFirstCallLead:{lowerBoundSeconds:signedSeconds,upperBoundSeconds:null,upperBound:'UNBOUNDED',earlierCallsRuledOut:false},pairedClocks:clocks,callEditCoverage:data.editCoverage,limitations:['Eligible calls are the independently qualified retained sample, not a platform-wide first-call census. Earlier or deleted calls and predecessor revision bodies are not excluded.','The creator wallet is bound to the token creation only; call authors, controllers, people, campaign wallets and causation are not linked.','The signed observed-sample difference is exact at reported event precision; global first-call lead has only the stated lower bound. No postcreation-only call universe is assumed.','Retained source bytes and operator-recorded model outputs are user imports; hashes do not authenticate providers, deployed programs or model/session identity. No price, proceeds, profit or follower outcome is inferred.']}};
}
export function validateS14EntrySource(token:TokenRef,cutoff:string,evidence:EvidenceRecord[],rawArtifacts:Record<string,string>){
 const metadata=rawArtifacts[S14_CAPTURE_ID];check(typeof metadata==='string','CAPTURE_REQUIRED');const manifest=decodeS14EntryManifest(metadata!,token,cutoff),owned=evidence.filter(s14EntryOwns),ids=[S14_CAPTURE_ID,...manifest.receipts.map(r=>S14_SOURCE_PREFIX+r.role)],rawIds=Object.keys(rawArtifacts).filter(id=>id.startsWith(S14_SOURCE_PREFIX));
 check(owned.length===6&&new Set(owned.map(e=>e.id)).size===6&&rawIds.length===6&&rawIds.every(id=>ids.includes(id)),'CATALOG');
 let total=Buffer.byteLength(metadata!);for(const e of owned){const r=manifest.receipts.find(r=>S14_SOURCE_PREFIX+r.role===e.id),raw=rawArtifacts[e.id],at=e.id===S14_CAPTURE_ID?manifest.captureCreatedAt:r?.retrievedAt;
 check(ids.includes(e.id)&&e.sourceId===S14_SOURCE_ID&&e.adapterVersion===S14_ADAPTER&&e.sourceType==='HISTORICAL_RECEIPT'&&e.accessMode==='USER_IMPORT'&&typeof raw==='string'&&e.contentHash===s14EntryHash(raw)&&e.availableAt===at&&e.retrievedAt===at&&same(e.scope,e.id===S14_CAPTURE_ID?s14EntryScope('CAPTURE'):s14EntryScope(r!.role,r!.request)),'EVIDENCE');
 if(r){total+=Buffer.byteLength(raw!);check(Buffer.byteLength(raw!)===r.sourceBytes&&s14EntryHash(raw!)===r.sha256&&Buffer.from(raw!).toString('utf8')===raw,'SOURCE_HASH');}}
 check(total<=S14_CAPTURE_BYTES,'SOURCE_BOUND');
 const byRole=(role:typeof S14_ROLES[number])=>manifest.receipts.find(r=>r.role===role)!;
 check(same(byRole('genesis').request,{method:'getGenesisHash',params:[]})&&creatorRoleRpcResult(rawArtifacts[S14_SOURCE_PREFIX+'genesis']!)===SOLANA_MAINNET_GENESIS,'GENESIS');
 const receipts={rawArtifacts:{} as Record<string,string>,requests:{} as Record<string,any>,retrievedAt:{} as Record<string,string>};
 for(const [role,id] of [['role-page',CREATOR_ROLE_RECEIPTS.page],['role-index',CREATOR_ROLE_RECEIPTS.walletIndex],['role-transaction',CREATOR_ROLE_RECEIPTS.transaction]] as const){receipts.rawArtifacts[id]=rawArtifacts[S14_SOURCE_PREFIX+role]!;receipts.requests[id]=byRole(role).request;receipts.retrievedAt[id]=byRole(role).retrievedAt;}
 const role=verifyPublicCreatorRole(token,receipts,cutoff,manifest.roleIndexBefore,true),trade=decodeCreatorQuoteTrade(creatorRoleRpcResult(receipts.rawArtifacts[CREATOR_ROLE_RECEIPTS.transaction]!),{quality:'KNOWN',binding:role} as any,true);
 check(same(byRole('callers').request,{method:RECORDED_CALLER_METHOD}),'CALLER_REQUEST');
 const callerRaw=rawArtifacts[S14_SOURCE_PREFIX+'callers']!,decoded=decodeRecordedCallerCapture(callerRaw,token,cutoff);check(Date.parse(decoded.availableAt)<=Date.parse(byRole('callers').retrievedAt),'CALLER_IMPORT_CLOCK');
 const caller=deriveRecordedCallerMetrics(callerRaw,token,cutoff,ids).find(m=>m.id==='S07')!;
 const metric=deriveS14EntryMetric(role,trade,caller,ids,{captureCreatedAt:manifest.captureCreatedAt,sourceReceipts:manifest.receipts.map(({role,retrievedAt})=>({role,retrievedAt})),callerQualificationAvailableAt:decoded.availableAt,callerQualificationExecutions:decoded.capture.qualification?{proposal:decoded.capture.qualification.proposal.execution,review:decoded.capture.qualification.review.execution}:null,callerSeedReceipts:decoded.capture.seed.evidence.map(e=>({id:e.id,retrievedAt:e.retrievedAt,availableAt:e.availableAt})),callerBodyReceipts:decoded.capture.callers.times,callerBodyCutoff:decoded.history.analysisCutoff,cutoff});return{ids,metric,manifest};
}
