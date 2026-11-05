import {isDeepStrictEqual as same} from 'node:util';
import type {TokenRef,EvidenceRecord} from '../domain/contracts.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import {verifyPublicCreatorRole,CREATOR_ROLE_RECEIPTS,creatorRoleRpcResult,type PublicCreatorRole,type CreatorRoleReceipts} from './advisory-creator-role.js';
import {decodeCreatorQuoteTrade} from './advisory-creator-quote.js';
import type {CreatorRoleDecode} from './advisory-creator-role-collector.js';
import {verifyS14BirthTrade} from './advisory-actor-entry-source.js';
import {SOLANA_MAINNET_GENESIS} from './solana.js';
import {S19_SOURCE_ID,S19_SOURCE_PREFIX,S19_CAPTURE_ID,S19_ADAPTER,S19_ROLES,S19_CAPTURE_BYTES,S19_INTERVAL_SECONDS,S19_INTERVAL_ANCHOR,S19_EVIDENCE_IDS,S19_METRIC_METHOD,S19_SCOPE,decodeS19Manifest,s19Hash,s19Scope,type S19Role,type S19Manifest} from './advisory-s19-singleton-import.js';
export * from './advisory-s19-singleton-import.js';
const check=(v:unknown,code:string):void=>{if(!v)throw Error('S19_SINGLETON_'+code);};
const iso=(ms:number)=>new Date(ms).toISOString();
export type S19BirthTrade=ReturnType<typeof decodeCreatorQuoteTrade>;
export type S19Clocks={captureCreatedAt:string;receipts:ReadonlyArray<{role:S19Role;retrievedAt:string}>;cutoff:string};
export const s19Owns=(e:EvidenceRecord)=>e.sourceId===S19_SOURCE_ID||e.id.startsWith(S19_SOURCE_PREFIX)||e.adapterVersion===S19_ADAPTER;
/** The KNOWN wrapper S14 also hands the unchanged decoder; only a role just returned by verifyPublicCreatorRole reaches it. */
const knownRole=(binding:PublicCreatorRole)=>({quality:'KNOWN',binding}) as CreatorRoleDecode;
/**
 * Pure projection from a verified v2 creation role and its decoded birth trade. No member, edge or count is an input.
 * Every proof failure throws; the only non-KNOWN result is an interval still open at the cutoff, which carries no count.
 */
export function deriveS19SingletonMetric(role:PublicCreatorRole,trade:S19BirthTrade,ids:readonly string[],clocks:S19Clocks):AdvisoryMetric{
 verifyS14BirthTrade(role,trade);
 const start=Date.parse(role.creation.at),end=start+S19_INTERVAL_SECONDS*1000,entry=Date.parse(trade.at),cut=Date.parse(clocks.cutoff),capture=Date.parse(clocks.captureCreatedAt),seen=clocks.receipts.map(r=>Date.parse(r.retrievedAt));
 check(role.method==='pump-public-creator-role-v2'&&role.token.chain==='solana'&&typeof role.creation.quoteMint==='string'&&trade.quote.mint===role.creation.quoteMint&&role.validity.validAt===role.creation.at&&Date.parse(role.cutoff)===cut,'ROLE');
 check(same(ids,S19_EVIDENCE_IDS),'EVIDENCE_IDS');
 check(Number.isFinite(cut)&&Number.isFinite(capture)&&capture<=cut&&same(clocks.receipts.map(r=>r.role),[...S19_ROLES])&&seen.every(t=>Number.isFinite(t)&&t<=capture),'CLOCK');
 check(Number.isSafeInteger(start)&&start%1000===0&&entry>=start&&entry<end,'ENTRY_INTERVAL');
 const interval={anchor:S19_INTERVAL_ANCHOR,rule:'HALF_OPEN_[BIRTH,BIRTH+21600S)',start:role.creation.at,end:iso(end),durationSeconds:S19_INTERVAL_SECONDS,timePrecision:'SECOND',eventClock:'CHAIN_BLOCK_TIME',closedAtCutoff:end<=cut,ruleFixedBeforeDerivation:true,prospectivelyPreregistered:false};
 const head={method:S19_METRIC_METHOD,scope:S19_SCOPE,token:role.token,interval},receiptClocks=clocks.receipts.map(r=>({role:r.role,retrievedAt:r.retrievedAt}));
 if(end>cut)return{id:'S19',quality:'MISSING',unit:'scoped-record',reasonCode:'S19_INTERVAL_OPEN_AT_CUTOFF',evidenceIds:[...ids],data:{...head,cohort:null,entrants:null,observedEntrantGroups:null,clocks:{creationAt:role.creation.at,captureCreatedAt:clocks.captureCreatedAt,receipts:receiptClocks,intervalEnd:iso(end),measurementAvailableAt:null,cutoff:clocks.cutoff},limitations:['The fixed first-6h birth interval is still open at the analysis cutoff, so no count is reported; this is neither zero nor a non-entry claim.']}};
 const member={actorId:role.actor.id,wallet:role.wallet,roleMethod:role.method,roleValidAt:role.validity.validAt,ongoingControlAsserted:false};
 return{id:'S19',quality:'KNOWN',unit:'scoped-record',reasonCode:'CREATOR_SINGLETON_BIRTH_ENTRY_GROUP_COUNTED',evidenceIds:[...ids],data:{...head,
  cohort:{definition:'PUBLIC_SIGNED_TOKEN_CREATION_ROLE_FOR_THIS_MINT_INCARNATION',incarnation:{creationSignature:role.creation.signature,creationSlot:role.creation.slot,uniqueness:role.creation.uniqueness,mintCloseAuthority:role.creation.mintCloseAuthority,archivalEarlierIncarnationClaim:null},members:[member],size:1,population:'FINITE_BY_DEFINITION',excluded:['OTHER_WALLETS','CALL_AUTHORS','MARKET_PARTICIPANTS','FEE_PAYER_AND_COSIGNERS']},
  entrants:[{...member,at:trade.at,signature:trade.signature,slot:trade.slot,offsetSeconds:(entry-start)/1000,proof:'UNIQUE_MINT_BIRTH_POSITIVE_PURCHASE',baseAccount:trade.base.account,unitsAtomic:trade.base.unitsAtomic,quoteMint:trade.quote.mint,execution:trade.execution}],
  observedEntrantGroups:{value:1,unit:'ACTOR_GROUP_WITHIN_COHORT',globalPointValue:null},
  relationships:{verifiedRecordsWithinPanel:[],pairSet:'VACUOUS_PAIRSET',pairsEvaluated:0,globalAbsenceAsserted:false,outsideAssociations:'UNKNOWN',outsideAssociationsChangeScopedCount:false},
  independence:{notDisprovenGroups:1,notDisprovenPairs:{evaluated:0,status:'VACUOUS'},verifiedIndependence:null,verifiedIndependenceAsserted:false},
  interpretation:{degenerate:true,singletonScope:true,structurallyDetermined:true,valueKnownBeforeDerivation:true,convergenceInterpretable:false,globalConvergenceAsserted:false,campaignOrControllerAsserted:false,personIdentityAsserted:false,callAuthorBound:false,currentOwnershipAsserted:false},
  clocks:{eventClock:'CHAIN_BLOCK_TIME',creationAt:role.creation.at,entryAt:trade.at,pageObservedAt:role.publicClaim.observedAt,pagePublishedDateUsed:false,walletIndexRetrievedAt:role.walletIndex.retrievedAt,receipts:receiptClocks,captureCreatedAt:clocks.captureCreatedAt,captureRestampsReceipts:false,classificationAt:null,intervalEnd:iso(end),measurementAvailableAt:iso(Math.max(end,capture,...seen)),cutoff:clocks.cutoff},
  limitations:[...role.limitations,
   'The value 1 counts the one-member public signed creation-role cohort of this mint incarnation by definition. It was determined before derivation and is not a count of independent actors, controllers, campaigns or market participants.',
   'With no in-panel pair, collapsing and relationship evaluation are vacuous. Outside associations, fee payer, co-signers and hidden controllers stay unknown; the empty within-panel relationship list is not a global absence claim.',
   'Entry is the positively decoded custom native-quote BUY in the verified creation transaction. An absent, unsupported or legacy SOL-quote birth purchase is rejected, never counted as zero or as non-entry.',
   'The anchor carries the existing creation proof (mint allocated and initialized in this transaction, no mint close authority initialized). No archival claim about an earlier closed account at this address is made.',
   'The 21600 s interval is a code constant fixed before this derivation but after the historical birth and exposure; it is not a prospective preregistration.',
   'Retained bytes are user imports; hashes bind them but do not authenticate providers, deployed programs or the mutable IDL. The capture clock packages original receipts and never restamps page or RPC retrieval times.']}};
}
/** Full S19 source: exactly five owned records, original hashes/bytes/requests/clocks, mainnet genesis, then role and birth trade re-derived from raw. */
export function validateS19Source(token:TokenRef,cutoff:string,evidence:EvidenceRecord[],rawArtifacts:Record<string,string>):{ids:string[];manifest:S19Manifest;metric:AdvisoryMetric}{
 const metadata=rawArtifacts[S19_CAPTURE_ID];check(typeof metadata==='string','CAPTURE_REQUIRED');
 const manifest=decodeS19Manifest(metadata!,token,cutoff),ids=[...S19_EVIDENCE_IDS],owned=evidence.filter(s19Owns),rawIds=Object.keys(rawArtifacts).filter(id=>id.startsWith(S19_SOURCE_PREFIX));
 check(owned.length===ids.length&&new Set(owned.map(e=>e.id)).size===ids.length&&owned.every(e=>ids.includes(e.id))&&rawIds.length===ids.length&&rawIds.every(id=>ids.includes(id)),'CATALOG');
 const by=(role:S19Role)=>manifest.receipts.find(r=>r.role===role)!;let total=0;
 for(const e of owned){
  const r=manifest.receipts.find(x=>S19_SOURCE_PREFIX+x.role===e.id),raw=rawArtifacts[e.id],at=e.id===S19_CAPTURE_ID?manifest.captureCreatedAt:r?.retrievedAt;
  check(e.sourceId===S19_SOURCE_ID&&e.adapterVersion===S19_ADAPTER&&e.sourceType==='HISTORICAL_RECEIPT'&&e.accessMode==='USER_IMPORT'&&typeof raw==='string'&&e.contentHash===s19Hash(raw)&&at!==undefined&&e.availableAt===at&&e.retrievedAt===at&&same(e.scope,r?s19Scope(r.role,r.request):s19Scope('CAPTURE')),'EVIDENCE');
  total+=Buffer.byteLength(raw!);
  if(r)check(Buffer.byteLength(raw!)===r.sourceBytes&&s19Hash(raw!)===r.sha256&&Buffer.from(raw!).toString('utf8')===raw,'SOURCE_HASH');
 }
 check(total<=S19_CAPTURE_BYTES,'SOURCE_BOUND');
 check(same(by('genesis').request,{method:'getGenesisHash',params:[]})&&creatorRoleRpcResult(rawArtifacts[S19_SOURCE_PREFIX+'genesis']!)===SOLANA_MAINNET_GENESIS,'GENESIS');
 const receipts:CreatorRoleReceipts={rawArtifacts:{},requests:{},retrievedAt:{}};
 for(const [local,id] of [['role-page',CREATOR_ROLE_RECEIPTS.page],['role-index',CREATOR_ROLE_RECEIPTS.walletIndex],['role-transaction',CREATOR_ROLE_RECEIPTS.transaction]] as const){const r=by(local);receipts.rawArtifacts[id]=rawArtifacts[S19_SOURCE_PREFIX+local]!;receipts.requests[id]=r.request;receipts.retrievedAt[id]=r.retrievedAt;}
 const role=verifyPublicCreatorRole(token,receipts,cutoff,manifest.roleIndexBefore,true);
 const trade=decodeCreatorQuoteTrade(creatorRoleRpcResult(receipts.rawArtifacts[CREATOR_ROLE_RECEIPTS.transaction]!),knownRole(role),true);
 const metric=deriveS19SingletonMetric(role,trade,ids,{captureCreatedAt:manifest.captureCreatedAt,receipts:S19_ROLES.map(x=>({role:x,retrievedAt:by(x).retrievedAt})),cutoff});
 return{ids,manifest,metric};
}

