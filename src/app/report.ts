import {resolveEmptyVenueEntries} from '../domain/venue-entry.js';
import {resolveNecessaryAttentionContext} from '../domain/entry-groups.js';
import {entryContextDecisionMethod} from '../domain/contracts.js';
import {combineAttentionOutcomes,resolveOriginEntryCriterion,resolveAttentionEntryCriterion,qualifiedAttentionEntryBound,qualifiedAttentionEntrySupport} from '../domain/attention.js';
import { entryDefinitions, featureMetadata } from '../domain/catalog.js';
import { evaluatePredicate } from '../domain/policy.js';
import { sharedClaimSupportOutcomes } from '../domain/shared.js';
import { Decimal } from 'decimal.js';
import type { BaselineAssessment, MissingCause } from '../domain/baseline.js';
import type { AssessmentDetails, EntrySnapshot, ManagementSnapshot, Predicate } from '../domain/contracts.js';

type Snapshot=EntrySnapshot|ManagementSnapshot;
export const cleanText=(value:unknown,max=400)=>String(value??'').replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const metricValueText=(value:unknown)=>{try{return cleanText(JSON.stringify(value)??String(value),220);}catch{return '[unavailable]';}};
const names:Record<string,string>={'ID-01':'Token identity','CTX-01':'Your trade settings','CAP-01':'Chain and venue coverage','SEC-01':'Supply authority','SEC-02':'Transfer restrictions','SEC-03':'Program controls','SEC-04':'Transfer fees','SEC-05':'Venue provenance','LIQ-01':'Liquidity withdrawal exposure','EXE-01':'Entry and acquired-size exit','EXE-02':'Trade friction and costs','EXE-03':'Read-only simulation','OWN-01':'Holder coverage','OWN-02':'Owner/control concentration','MKT-01':'Valuation and scoped activity','NAR-01':'Narrative and game','NAR-02':'Origin and catalyst','NAR-03':'Explainable thesis','CAN-01':'Competing representations','CAN-02':'Observed leadership','ATT-01':'Qualified attention sample','ATT-02':'Attention or community growth','SOC-01':'Social identity binding','SOC-02':'Source integrity','SOC-03':'Independent participation','DAT-01':'Freshness and completeness','DAT-02':'Semantic qualification','DAT-03':'Conflicts','ADV-01':'Ownership patterns','ADV-02':'Flow patterns','ADV-03':'Attention context','ADV-04':'Actor context','ADV-05':'Market and lifecycle context','MG-01':'Frozen baseline','MG-02':'Current integrity','MG-03':'Exit feasibility','MG-04':'Thesis evidence','MG-05':'Age and cap context','MG-06':'Thesis support','MG-07':'Invalidation clear','MG-08':'Catalyst','MG-09':'On-chain traction','MG-10':'External traction','MG-11':'Warnings','MG-12':'Realization trigger','MG-13':'Position and exit plan','MG-14':'Holding horizon','MG-15':'Proposal feasibility'};
export function predicateRefs(p:Predicate):string[]{return 'feature' in p?[p.feature]:p.children.flatMap(predicateRefs);}
function describePredicate(p:Predicate):string {
  if('children' in p)return '('+p.children.map(describePredicate).join(p.op==='all'?' AND ':' OR ')+')';
  const name=featureMetadata.find(f=>f.id===p.feature)?.name??p.feature;
  const operator={eq:'=',lt:'<',lte:'≤',gt:'>',gte:'≥'}[p.op];
  return `${p.feature} ${cleanText(name,70)} ${operator} ${cleanText(p.value)} ${cleanText(p.unit)}`;
}
const managementRefs=(id:string,details?:AssessmentDetails):string[]=>{
  const t=details?.thesis;
  if(id==='MG-02')return entryDefinitions.filter(d=>['SEC-01','SEC-02','SEC-03','SEC-04','SEC-05','LIQ-01'].includes(d.checkId)).flatMap(d=>d.featureIds);
  if(id==='MG-03'||id==='MG-15')return ['O10','O11','O13','O14','O15','O16'];
  if(id==='MG-05')return [];
  if(!t)return [];
  const ps=id==='MG-04'?[...t.support,...t.invalidation,...(t.catalyst?[t.catalyst]:[])]:id==='MG-06'?t.support:id==='MG-07'?t.invalidation:id==='MG-08'?t.catalyst?[t.catalyst]:[]:id==='MG-09'?t.onchainTraction?[t.onchainTraction]:[]:id==='MG-10'?t.externalTraction?[t.externalTraction]:[]:id==='MG-11'?t.warning?[t.warning]:[]:id==='MG-12'?t.legs.map(l=>l.trigger):[];
  return [...new Set(ps.flatMap(predicateRefs))];
};
const riskKeys:Record<string,string[]>={'CTX-01':['sizeUsd','horizonSeconds','maxTransferFeeBps','maxEntryImpactBps','maxExitImpactBps','maxRoundTripLossBps','maxDirectControlShare','maxRemovableLiquidityShare'],'SEC-04':['maxTransferFeeBps'],'LIQ-01':['maxRemovableLiquidityShare'],'OWN-02':['maxDirectControlShare'],'EXE-02':['sizeUsd','maxEntryImpactBps','maxExitImpactBps','maxRoundTripLossBps']};
export function unknownCauseKind(causes:MissingCause[]):'INFRA'|'COLLECTION'|'MODEL'|'IMPLEMENTATION'|'INPUT'|'EXECUTION'|'DATA'{
  const codes=causes.map(c=>c.code);
  if(causes.some(c=>c.category==='USER_INPUT_MISSING'))return 'INPUT';
  if(causes.some(c=>c.category==='COLLECTION_UNIMPLEMENTED'))return 'IMPLEMENTATION';
  if(codes.some(c=>c==='RPC_REMOTE_-32016'||/(?:HTTP_(?:408|429|5\d\d)|TOKEN_COUNT_UNAVAILABLE|TIMEOUT|TRANSPORT|DNS_ERROR|NETWORK_ACCESS_DENIED|RUN_ABORTED|COLLECTION_BUDGET|RUN_LIMIT|RUN_TIMEOUT|LIVE_(?:PHASE_DEADLINE|HARD_DEADLINE|OPERATION_LIMIT|CALLER_CANCELLED|DEPENDENCY_SKIPPED))/.test(c)))return 'INFRA';
  if(codes.some(c=>/^(?:PUMP|CURVE|DAMM)_(?:SIMULATION|TRANSACTION|QUOTE|FEE|PAYER|ACCOUNT)/.test(c)))return 'EXECUTION';
  if(codes.some(c=>/TARGET_(?:EMPTY|BLOCKED)|TEXT_CAP|PAGE_CAP|SOURCE_CAP|PACKET_LIMIT|INPUT_TOKEN_LIMIT|RESPONSE_LIMIT|FETCH_|DISCOVERY_INCOMPLETE|COLLECTION_INCOMPLETE|SCOPE_INCOMPLETE|CORPUS_REQUIRED|HOLDER_TAIL_UNKNOWN|ATT_ENTRY_(?:FETCH|ORIGIN|SOURCE_TEXT|SOURCE_CAP|TEXT_CAP|RECOVERY|COMPARISON|REQUIRED_SEARCH)/.test(c)))return 'COLLECTION';
  if(causes.some(c=>c.category==='CLAIM_UNVALIDATED')||codes.some(c=>/MODEL_|REVIEW_|UNRESOLVED|CITATION/.test(c)))return 'MODEL';
  return 'DATA';
}
export type ReportOutcome='SUPPORTED'|'CONTRADICTED'|'INSUFFICIENT'|'UNKNOWN';
type OutcomeBasis='RULE_SATISFIED'|'FACTUAL_COUNTEREVIDENCE'|'PUBLIC_SUPPORT_INADEQUATE'|'EVALUATION_INCOMPLETE'|'LEGACY_NEGATIVE_BASIS_UNSPECIFIED';
const combineOutcomes=combineAttentionOutcomes;

/** A current interpretation of retained evidence, separate from immutable policy status. */
export function buildEntryReport(snapshot:EntrySnapshot,details=snapshot.details){
  const policyRows=explainPolicyChecks(snapshot,details);
  const assessment=(id:string)=>details?.baseline.find(a=>a.id===id);
  const feature=(id:string)=>snapshot.features.find(f=>f.id===id&&f.quality==='KNOWN'&&f.value!==null);
  const negative=(basis:unknown):ReportOutcome=>basis==='FACTUAL_COUNTEREVIDENCE'?'CONTRADICTED':basis==='PUBLIC_SUPPORT_INADEQUATE'?'INSUFFICIENT':'UNKNOWN';
  const featureOutcome=(id:string):ReportOutcome=>{
    const resolved=id==='A18'?resolveAttentionEntryCriterion(details?.baseline??[],'growth'):null;if(resolved)return resolved.outcome;
    const f=feature(id);const bound=id==='A15'?qualifiedAttentionEntryBound(details?.baseline??[],'qualifiedSample'):id==='A18'?qualifiedAttentionEntryBound(details?.baseline??[],'growth'):null;if(!f&&bound)return bound.status==='PASS'?'SUPPORTED':'CONTRADICTED';if(!f)return id==='A15'&&qualifiedAttentionEntrySupport(details?.baseline??[],'qualifiedSample')||id==='A18'&&qualifiedAttentionEntrySupport(details?.baseline??[],'growth')?'INSUFFICIENT':'UNKNOWN';if(f.value===true)return 'SUPPORTED';
    const d=assessment(id)?.data as Record<string,any>|undefined;
    if(d?.entryDecisionMethod&&d.decision?.verdict==='FAIL'){
      if(d.outcomeBasisMethod==='entry-outcome-basis-v1')return negative(d.decision.negativeBasis);
      return d.decision.basis==='EVIDENCE_INADEQUACY'||d.originBasis==='PUBLIC_EVIDENCE_INADEQUATE'?'INSUFFICIENT':'UNKNOWN';
    }
    if(d?.originBasis==='PUBLIC_EVIDENCE_INADEQUATE'||d?.method==='narrative-public-support-v1'||d?.evidenceAdequacy?.verdict==='INADEQUATE'||d?.method==='entry-evidence-gate-v1'||d?.leadershipScreening||d?.basis==='EVIDENCE_INADEQUACY')return 'INSUFFICIENT';
    if(f.value===false)return 'CONTRADICTED';
    return 'SUPPORTED';
  };
  const social=(name:'identity'|'integrity'|'participation'|'communityBreadth'):ReportOutcome=>{
    const j=details?.social?.[(name+'Review') as 'identityReview'];
    if(!j||j.verdict==='UNRESOLVED')return 'UNKNOWN';if(j.verdict==='SUPPORTED')return 'SUPPORTED';
    return details?.social?.outcomeBasisMethod==='entry-outcome-basis-v1'?negative(j.negativeBasis):'UNKNOWN';
  };
  const rowOutcome=(row:typeof policyRows[number]):ReportOutcome=>{
    const venue=details?resolveEmptyVenueEntries(details.baseline,details.profile,snapshot.cutoff)?.[row.checkId as 'CAP-01']:undefined;if(venue)return row.status===venue.status?venue.outcome:'UNKNOWN';
    if(row.checkId==='NAR-02'){const resolution=resolveOriginEntryCriterion(details?.baseline??[]);if(resolution)return row.status==='UNKNOWN'?'UNKNOWN':resolution.status===row.status?resolution.outcome:'UNKNOWN';}
    if(row.group?.code==='NECESSARY_ATTENTION_CONTEXT'){const g=row.group,selected=details?.groups?.contextDecisionMethod===entryContextDecisionMethod?resolveNecessaryAttentionContext(details.baseline,snapshot.cutoff):null;return selected&&row.status===selected.status&&g.status===selected.status&&g.metrics.outcome===selected.outcome&&g.metrics.basis===selected.basis&&g.metrics.criterion===selected.criterion&&JSON.stringify(g.featureIds)===JSON.stringify(selected.featureIds)&&JSON.stringify(g.evidenceIds)===JSON.stringify(selected.evidenceIds)?selected.outcome:'UNKNOWN';}
    if(row.status==='PASS')return 'SUPPORTED';if(row.status!=='FAIL')return 'UNKNOWN';
    const id=row.checkId,g=row.group;
    if(id==='ATT-01'){const resolution=resolveAttentionEntryCriterion(details?.baseline??[],'qualifiedSample');if(resolution)return resolution.outcome;}
    if(g){
      if(g.code==='RESOLVED_ATTENTION_CONTEXT')return resolveAttentionEntryCriterion(details?.baseline??[],'attentionContext')?.outcome??'UNKNOWN';
      if(g.code==='BOUNDED_ATTENTION_CONTEXT'){const bound=qualifiedAttentionEntryBound(details?.baseline??[],'attentionContext');return combineOutcomes([...['A01','A02','A05'].map(featureOutcome),bound?(bound.status==='PASS'?'SUPPORTED':'CONTRADICTED'):'UNKNOWN']);}
      if(g.code==='REVIEWED_ATTENTION_CONTEXT_INADEQUATE')return qualifiedAttentionEntrySupport(details?.baseline??[],'attentionContext')?'INSUFFICIENT':'UNKNOWN';
      if(g.code==='REVIEWED_ACTOR_SUPPORT_INADEQUATE')return g.metrics.outcomeBasisMethod==='entry-outcome-basis-v1'?negative(g.metrics.negativeBasis):'INSUFFICIENT';
      if(g.code==='CURRENT_MARKET_SUPPORT_INADEQUATE')return 'INSUFFICIENT';
      if(id==='ADV-02')return g.code==='REPORTED_ACTIVITY_CONTEXT'?'CONTRADICTED':'INSUFFICIENT';
      if(id==='ADV-03'){
        const narrative=combineOutcomes(['A01','A02','A05'].map(featureOutcome));
        const posts=feature('A16')?.value,accounts=feature('A17')?.value;
        const measured=feature('A15')?.value===true&&typeof posts==='string'&&typeof accounts==='string';
        const gate=assessment('A15'),data=gate?.data as {method?:string;verdict?:string;postSampleScope?:{complete?:boolean}}|undefined;
        const closedGap=gate?.quality!=='STALE'&&data?.method==='entry-evidence-gate-v1'&&data.verdict==='FAIL'&&data.postSampleScope?.complete===true;
        const contextBound=qualifiedAttentionEntryBound(details?.baseline??[],'attentionContext');
        const sample:ReportOutcome=measured?(new Decimal(posts).gte(3)&&new Decimal(accounts).gte(3)?'SUPPORTED':'CONTRADICTED'):contextBound?(contextBound.status==='PASS'?'SUPPORTED':'CONTRADICTED'):closedGap||qualifiedAttentionEntrySupport(details?.baseline??[],'attentionContext')?'INSUFFICIENT':'UNKNOWN';
        return combineOutcomes([narrative,sample]);
      }
      return ['CURRENT_OWNER_CLUSTER_SCREEN','CURRENT_ACTOR_CONTEXT','CURRENT_LIFECYCLE_CONTEXT'].includes(g.code)?'CONTRADICTED':'UNKNOWN';
    }
    if(id.startsWith('DAT-')){
      const shared=details?.shared;if(!shared)return 'UNKNOWN';
      if(id==='DAT-02'&&shared.decisionMethod==='source-support-and-conflict-v2')return shared.supportCompleted?(shared.supportQualified?'SUPPORTED':'INSUFFICIENT'):'UNKNOWN';
      // deriveShared admits deterministic same-subject/time conflicts independently of its semantic audit.
      if(id==='DAT-03'&&shared.conflicts.length)return 'CONTRADICTED';
      if(id==='DAT-03'&&shared.completionMethod==='reviewed-audit-completion-v1'&&shared.auditCompleted&&shared.unresolved.length===0&&shared.semanticQualified&&shared.freshness.every(f=>f.fresh))return 'INSUFFICIENT';
      // An interrupted audit or absent fresh witness is not a detected conflict.
      return 'UNKNOWN';
    }
    if(id==='SOC-01'||id==='SOC-02')return social(id==='SOC-01'?'identity':'integrity');
    if(id==='SOC-03'){
      const s=details?.social;
      if(s?.sampleComplete&&s.accountUpperBound!==null&&s.accountUpperBound<3)return 'CONTRADICTED';
      if(s?.sampleComplete&&s.lineageComplete&&s.independentGroupCount!==null&&s.independentCommunityCount!==null&&s.accountUpperBound!==null)return 'CONTRADICTED';
      return social('participation');
    }
    if(id==='ATT-01'&&qualifiedAttentionEntryBound(details?.baseline??[],'qualifiedSample'))return qualifiedAttentionEntryBound(details?.baseline??[],'qualifiedSample')!.status==='PASS'?'SUPPORTED':'CONTRADICTED';
    if(id==='ATT-01')return feature('A16')&&feature('A17')?'CONTRADICTED':featureOutcome('A15')==='INSUFFICIENT'?'INSUFFICIENT':'UNKNOWN';
    if(id==='ATT-02')return combineOutcomes([featureOutcome('A18'),feature('S10')?featureOutcome('S10'):social('communityBreadth')],true);
    // Qualified representation policy decides CAN-02 from A14 alone; A11 is a legacy catalog ref.
    if(id==='CAN-02'&&assessment('A14')?.data&&(assessment('A14')!.data as {method?:string}).method==='representation-routes-v2')return featureOutcome('A14');
    const limits:Record<string,[string,string|undefined][]>= {
      'SEC-04':[['O07',details?.profile.risk.maxTransferFeeBps]],
      'OWN-02':[['O19',details?.profile.risk.maxDirectControlShare],['O20',details?.profile.risk.maxDirectControlShare]],
      'LIQ-01':[['O09',details?.profile.risk.maxRemovableLiquidityShare]],
      'EXE-02':[['O13',details?.profile.risk.maxEntryImpactBps],['O14',details?.profile.risk.maxExitImpactBps],['O15',details?.profile.risk.maxRoundTripLossBps]],
    };
    if(limits[id])return combineOutcomes([...limits[id].map(([featureId,limit])=>{const f=feature(featureId);if(!f||typeof f.value!=='string'||limit===undefined)return 'UNKNOWN' as const;return new Decimal(f.value).gt(limit)?'CONTRADICTED' as const:'SUPPORTED' as const;}),...(id==='EXE-02'?[featureOutcome('O16')]:[])]);
    return row.featureRefs.length?combineOutcomes(row.featureRefs.map(featureOutcome)):'UNKNOWN';
  };
  const stageProjection=snapshot.evidence.find(e=>e.id==='live-run-scope')?.scope;
  const phases=stageProjection?.completionMethod==='entry-completion-v1'&&Array.isArray(stageProjection.stages)?stageProjection.stages as Array<{phase:string;status:string;code?:string}>:null;
  const operationalCauses=(row:typeof policyRows[number]):MissingCause[]=>{
    // Follow only unresolved witnesses consumed by this row, never unrelated stage failures.
    const dependencies=row.checkId.startsWith('DAT-')?policyRows.filter(r=>details?.shared?.unresolved.includes(r.checkId)&&rowOutcome(r)==='UNKNOWN'):[row];
    const refs=[...new Set(dependencies.flatMap(r=>r.featureRefs))].filter(id=>!feature(id));
    const causes:MissingCause[]=[];
    const add=(code:unknown,id:string,evidenceIds:string[])=>{
      if(typeof code!=='string'||!/^[A-Z][A-Z0-9_-]{0,100}$/.test(code))return;
      const cause:MissingCause={category:'EVIDENCE_UNAVAILABLE',code,featureId:id,evidenceIds,action:'Retry the unfinished provider operation; an outage is not negative token evidence.'};
      if(unknownCauseKind([cause])==='INFRA')causes.push(cause);
    };
    for(const id of refs){
      const a=assessment(id),data=a?.data as {codes?:unknown[]}|undefined;
      if(Array.isArray(data?.codes))for(const code of data.codes)add(code,id,a?.evidenceIds??[]);
      const owner=id.startsWith('A')?'ATTENTION':id.startsWith('S')?'SOCIAL':null;
      const phase=phases?.find(p=>p.phase===owner&&p.status!=='COMPLETED');
      if(phase)add(phase.code,id,['live-run-scope']);
    }
    if(row.checkId.startsWith('DAT-')){
      const audit=phases?.find(p=>p.phase==='SHARED'&&p.status==='FAILED');
      if(audit)add(audit.code,row.featureRefs[0]??row.checkId,['live-run-scope']);
    }
    return causes;
  };
  const supportOutcomes=sharedClaimSupportOutcomes(details?.shared);
  const checks=policyRows.map(row=>{
    const original=rowOutcome(row),support=supportOutcomes.get(row.checkId)??[];
    const outcome:ReportOutcome=original==='SUPPORTED'?(support.some(s=>s.outcome==='UNKNOWN')?'UNKNOWN':support.length?'INSUFFICIENT':original):original;
    const legacy=outcome==='UNKNOWN'&&row.status==='FAIL'&&(['SOC-01','SOC-02','SOC-03'].includes(row.checkId)&&details?.social?.outcomeBasisMethod===undefined||row.featureRefs.some(id=>{const d=assessment(id)?.data as {entryDecisionMethod?:string;outcomeBasisMethod?:string}|undefined;return d?.entryDecisionMethod&&!d.outcomeBasisMethod;}));
    const basis:OutcomeBasis=outcome==='SUPPORTED'?'RULE_SATISFIED':outcome==='CONTRADICTED'?'FACTUAL_COUNTEREVIDENCE':outcome==='INSUFFICIENT'?'PUBLIC_SUPPORT_INADEQUATE':legacy?'LEGACY_NEGATIVE_BASIS_UNSPECIFIED':'EVALUATION_INCOMPLETE';
    const supportCauses=original==='SUPPORTED'?support.map(s=>({category:'EVIDENCE_UNAVAILABLE' as const,code:s.outcome==='UNKNOWN'?'SHARED_SUPPORT_UNRESOLVED':'SHARED_SUPPORT_INADEQUATE',featureId:row.featureRefs[0]??row.checkId,evidenceIds:s.evidenceIds,action:s.rationale})):[];
    const retained=[...(outcome==='UNKNOWN'?[...operationalCauses(row),...row.causes]:row.causes),...supportCauses];
    const cause=outcome==='UNKNOWN'&&!retained.length?[{category:'EVIDENCE_UNAVAILABLE' as const,code:basis,featureId:row.featureRefs[0]??row.checkId,evidenceIds:row.evidenceRefs,action:legacy?'Run a fresh reviewed analysis that records the negative decision basis. Historical policy status is preserved.':'Complete the named evidence evaluation; an unresolved result is not a token contradiction.'}]:[...new Map(retained.map(c=>[`${c.code}:${c.featureId}`,c])).values()];
    return {checkId:row.checkId,policyStatus:row.status,required:row.required,pillar:snapshot.result.checks.find(c=>c.checkId===row.checkId)!.pillar,outcome,basis,featureRefs:row.featureRefs,evidenceRefs:row.evidenceRefs,unknownKind:outcome==='UNKNOWN'?legacy?'MODEL' as const:unknownCauseKind(cause):null,causes:cause};
  });
  const pillars=Object.fromEntries((['ONCHAIN','ATTENTION','SOCIAL','SHARED'] as const).map(pillar=>{const rs=checks.filter(r=>r.required&&r.pillar===pillar);return [pillar,{supported:rs.filter(r=>r.outcome==='SUPPORTED').length,contradicted:rs.filter(r=>r.outcome==='CONTRADICTED').length,insufficient:rs.filter(r=>r.outcome==='INSUFFICIENT').length,unknown:rs.filter(r=>r.outcome==='UNKNOWN').length,total:rs.length}];})) as Record<'ONCHAIN'|'ATTENTION'|'SOCIAL'|'SHARED',{supported:number;contradicted:number;insufficient:number;unknown:number;total:number}>;
  const required=checks.filter(r=>r.required&&r.policyStatus!=='NOT_APPLICABLE');
  const auxiliaryFacts:Array<{id:string;outcome:ReportOutcome;quality:string;value:unknown;featureRefs:string[];evidenceRefs:string[];reason:string}>=[];
  const addFact=(id:string,value:unknown,quality:string,featureRefs:string[],evidenceRefs:string[],reason:string)=>{if(value===null||value===undefined||quality!=='KNOWN')auxiliaryFacts.push({id,outcome:'UNKNOWN',quality,value:value??null,featureRefs,evidenceRefs,reason});};
  const emptyScreening=details&&resolveEmptyVenueEntries(details.baseline,details.profile,snapshot.cutoff)?.['CAP-01']?.outcome==='SUPPORTED';
  for(const a of details?.baseline??[]){if(a.projection){const codes=a.causes.map(c=>c.code).join('; ');const reason=a.id==='C02'&&codes==='VENUE_INSPECTED'?(emptyScreening?'The empty-pool screening is verified; an executable quote and round-trip simulation are unavailable.':'Venue inspection completed, but an executable route certificate is unavailable.'):codes||'Factual value not established.';addFact(a.id,a.projection.value,a.projection.quality,[a.id],a.evidenceIds,reason);}const d=a.data as {factualAssessment?:{quality:string;value:unknown}}|undefined;if(d?.factualAssessment)addFact(a.id+':factual',d.factualAssessment.value,d.factualAssessment.quality,[a.id],a.evidenceIds,'Entry evidence sufficiency is separate from this factual assessment.');}
  const routes=assessment('A14')?.data as {originRelationship?:{status:string};measuredAttention?:{status:string}}|undefined;
  for(const name of ['originRelationship','measuredAttention'] as const)if(routes?.[name]?.status==='UNKNOWN')addFact('A14:'+name,null,'MISSING',['A14'],assessment('A14')?.evidenceIds??[],'No qualified factual '+name+' value; the entry support judgment is separate.');
  for(const name of ['qualifiedOriginalCount','accountUpperBound','independentGroupCount','independentCommunityCount'] as const)if(details?.social)addFact('social:'+name,details.social[name],details.social[name]===null?'MISSING':'KNOWN',[],details.social.evidenceIds,'Exact sampled social measurement is not qualified; missing is not zero.');
  const engagement=assessment('S06')?.data as {required?:number;coverage?:Record<string,number>}|undefined;
  for(const [metric,count]of Object.entries(engagement?.coverage??{}))if(engagement?.required!==undefined&&count<engagement.required)addFact('social:engagement:'+metric,null,'MISSING',['S06'],assessment('S06')?.evidenceIds??[],`${count}/${engagement.required} sampled posts have this exact field; the remaining values are not established.`);
  const accountHistory=assessment('S05')?.data as {indicators?:Array<{accountId?:string;createdAt:string|null;historyPosts:number}>}|undefined;
  for(const [index,account]of (accountHistory?.indicators??[]).entries())if(account.createdAt===null)addFact('social:accountCreatedAt:'+(account.accountId??index),null,'MISSING',['S05'],assessment('S05')?.evidenceIds??[],'Exact public account creation date not established.');
  const synchrony=assessment('S04')?.data as {currentPeakFraction?:string|null;previousPeakFraction?:string|null}|undefined;
  for(const field of ['currentPeakFraction','previousPeakFraction'] as const)if(synchrony&&field in synchrony)addFact('social:'+field,synchrony[field],synchrony[field]===null?'MISSING':'KNOWN',['S04'],assessment('S04')?.evidenceIds??[],'Sample synchrony measurement is not established.');
  for(const name of ['circulatingMarketCapUsd','tokenCreatedAt'] as const)if(details)addFact('stage:'+name,details.stageInputs[name],details.stageInputs[name]===null?'MISSING':'KNOWN',['C01'],[],snapshot.analysisKind==='LIVE'&&details.stageInputs[name]===null?(name==='circulatingMarketCapUsd'?'Live collection of qualified circulating market cap is not implemented; FDV is not circulating cap.':'Live collection of qualified token creation time is not implemented; pool age is not token age.'):'Stage fact not established; pool age is not token age.');
  const record=snapshot.evidence.find(e=>e.id==='dex-pairs'),sameMint=(value:string)=>snapshot.token.chain==='solana'?value===snapshot.token.address:value.toLowerCase()===snapshot.token.address.toLowerCase();
  const pairs=snapshot.market?.pairs.filter(p=>p.mintSide==='base'&&sameMint(p.baseAddress))??[];
  const observation=(p:typeof pairs[number]|undefined)=>p?{provider:'dexscreener' as const,evidenceId:record?.id??null,retrievedAt:record?.retrievedAt??null,contentHash:record?.contentHash??null,pairAddress:p.pairAddress,dexId:p.dexId,mintSide:p.mintSide,baseAddress:p.baseAddress,quoteAddress:p.quoteAddress,selection:'HIGHEST_RETAINED_LIQUIDITY' as const,scope:'PAIR' as const,aggregation:'NONE' as const,window:'PROVIDER_REPORTED_ROLLING_24H' as const,priceUsd:p.priceUsd,liquidityUsd:p.liquidityUsd,volume24hUsd:p.volume24hUsd,reportedPairCount:snapshot.market?.reportedPairCount??0,retainedPairCount:snapshot.market?.retainedPairCount??0,truncated:snapshot.market?.truncated??false}:null;
  const selected=observation(pairs.find(p=>p.priceUsd!==null));
  const routePool=details?.groups?.groups.find(g=>g.checkId==='ADV-05')?.metrics.pool;
  const route=typeof routePool==='string'&&routePool!==selected?.pairAddress?observation(pairs.find(p=>p.pairAddress===routePool)):null;
  const blockers=[...required.filter(r=>r.outcome==='UNKNOWN').map(r=>({checkId:r.checkId,code:r.causes[0]?.code??'EVALUATION_INCOMPLETE',evidenceIds:r.evidenceRefs})),...(phases??[]).filter(p=>p.status!=='COMPLETED').map(p=>({checkId:p.phase,code:p.code??'PHASE_INCOMPLETE',evidenceIds:['live-run-scope']}))];
  const completion={method:'entry-completion-v1' as const,state:blockers.length?'INCOMPLETE' as const:phases?.length===5&&required.length===33?'COMPLETE' as const:'UNVERIFIED' as const,blockers,phases};
  return {method:'entry-outcomes-v1' as const,completion,checks,pillars,coverage:{known:required.filter(r=>r.outcome!=='UNKNOWN').length,total:required.length},policyCoverage:snapshot.result.coverage,auxiliaryFacts,market:{selected,...(route?{executionRoutePair:{...route,selection:'VERIFIED_EXECUTION_POOL' as const}}:{})}};
}

export function explainChecks(snapshot:Snapshot,details=snapshot.details){
  const rows=explainPolicyChecks(snapshot,details),report=snapshot.checklistKind==='ENTRY'?buildEntryReport(snapshot,details):null;
  return rows.map(row=>{const current=report?.checks.find(c=>c.checkId===row.checkId);return {...row,...(current?{analysisCompletion:report?.completion.state,outcome:current.outcome,outcomeBasis:current.basis,policyStatus:current.policyStatus,unknownKind:current.unknownKind,causes:current.causes}:{outcome:undefined,outcomeBasis:undefined,policyStatus:row.status})};});
}

function explainPolicyChecks(snapshot:Snapshot,details=snapshot.details) {
  return snapshot.result.checks.map(check=>{
    const refs=check.featureRefs.length?check.featureRefs:managementRefs(check.checkId,details);
    const assessments=refs.flatMap(id=>details?.baseline.find(a=>a.id===id)?[details.baseline.find(a=>a.id===id)!]:[]);
    const causes:MissingCause[]=[];
    const group=details?.groups?.groups.find(item=>item.checkId===check.checkId);
    if(group&&check.status==='UNKNOWN')causes.push({category:'EVIDENCE_UNAVAILABLE',code:group.code,featureId:group.featureIds[0]??group.checkId,evidenceIds:group.evidenceIds,action:group.rationale});
    if(check.checkId==='MG-05'&&check.status==='UNKNOWN'){
      for(const field of ['circulatingMarketCapUsd','tokenCreatedAt'] as const)if(details?.stageInputs[field]===null||!details)causes.push({category:snapshot.analysisKind==='LIVE'?'COLLECTION_UNIMPLEMENTED':'EVIDENCE_UNAVAILABLE',code:field==='tokenCreatedAt'?'TOKEN_CREATION_EVIDENCE_MISSING':'CIRCULATING_CAP_EVIDENCE_MISSING',featureId:'C01',field,evidenceIds:[],action:field==='tokenCreatedAt'?'Supply independently qualified token creation evidence; pool age is not mint age.':'Supply independently qualified circulating supply and valuation; FDV is not circulating cap.'});
      if(!details?.profile.stage.ageBands.length)causes.push({category:'USER_INPUT_MISSING',code:'AGE_BANDS_MISSING',featureId:'C01',field:'stage.ageBands',evidenceIds:[],action:'Choose explicit age bands in the saved profile; no course-specific age threshold is invented.'});
    }
    if(check.status==='UNKNOWN'&&check.checkId==='MG-15'&&snapshot.result.checks.some(c=>c.checkId==='MG-13'&&c.status==='UNKNOWN'))causes.push({category:'USER_INPUT_MISSING',code:'PLAN_OR_POSITION_INCOMPLETE',featureId:'C10',evidenceIds:[],action:'Specify ordered realization legs and record a position with known cost before requesting a quantified proposal.'});
    for(const field of riskKeys[check.checkId]??[])if(!details?.profile||((field==='sizeUsd'||field==='horizonSeconds')?details.profile[field]===undefined:details.profile.risk[field]===undefined))causes.push({category:'USER_INPUT_MISSING',code:'PROFILE_FIELD_MISSING',featureId:refs[0]??'C01',field,evidenceIds:[],action:'Run config init to choose and save this setting; historical snapshots stay unchanged.'});
    if(!group&&(check.status==='UNKNOWN'||check.status==='FAIL'&&(check.checkId==='SOC-02'||check.checkId.startsWith('DAT-'))))for(const id of refs){const a=assessments.find(a=>a.id===id),f=snapshot.features.find(f=>f.id===id);if(a?.causes.length)causes.push(...a.causes);else if(!f||f.quality!=='KNOWN'||f.value===null)causes.push({category:a?.collector==='UNIMPLEMENTED'?'COLLECTION_UNIMPLEMENTED':'EVIDENCE_UNAVAILABLE',code:f?.quality??'FEATURE_ABSENT',featureId:id,evidenceIds:f?.evidenceIds??[],action:a?.collector==='UNIMPLEMENTED'?'Complete the named evidence collector.':'Supply qualified, fresh evidence for this feature in a new analysis.'});}
    if(check.status==='UNKNOWN'&&!causes.length){const missingPlan=['MG-09','MG-10','MG-12','MG-13','MG-15'].includes(check.checkId);causes.push({category:missingPlan?'USER_INPUT_MISSING':'EVIDENCE_UNAVAILABLE',code:missingPlan?'PLAN_OR_POSITION_INCOMPLETE':'DEPENDENCY_NOT_VERIFIED',featureId:refs[0]??'C10',evidenceIds:[],action:missingPlan?'Specify traction/exit predicates and record a hypothetical or reported position; no quantity is invented.':'Inspect the row evidence and frozen predicate; absence does not imply safety.'});}
    const unique=[...new Map(causes.map(c=>[`${c.category}:${c.code}:${c.featureId}:${c.field??''}`,c])).values()];
    const socialJudgment=check.checkId==='SOC-01'?details?.social?.identityReview:check.checkId==='SOC-02'?details?.social?.integrityReview:check.checkId==='SOC-03'?details?.social?.participationReview:check.checkId==='ATT-02'?details?.social?.communityBreadthReview:undefined;
    return {unknownKind:check.status==='UNKNOWN'?unknownCauseKind(unique):null,socialJudgment,group,required:'required' in check?check.required:false,checkId:check.checkId,name:names[check.checkId]??check.checkId,status:check.status,featureRefs:refs,evidenceRefs:group?group.evidenceIds:[...new Set([...check.evidenceRefs,...assessments.flatMap(a=>a.evidenceIds)])],values:refs.map(id=>{const f=snapshot.features.find(f=>f.id===id);return {id,name:details?.social&&id==='S05'?'Public account age and activity':details?.social&&id==='S04'?'Sampled synchrony contrast':featureMetadata.find(m=>m.id===id)?.name??id,value:f?.value??null,unit:f?.unit??null,quality:f?.quality??'MISSING'};}),thresholds:(riskKeys[check.checkId]??[]).map(field=>({field,value:field==='sizeUsd'?details?.profile.sizeUsd:field==='horizonSeconds'?details?.profile.horizonSeconds:details?.profile.risk[field]})),causes:unique};
  });
}
const categoryText:Record<MissingCause['category'],string>={USER_INPUT_MISSING:'missing setting',EVIDENCE_UNAVAILABLE:'evidence unavailable',COLLECTION_UNIMPLEMENTED:'collection not implemented',CLAIM_UNVALIDATED:'claim not validated'};
export function renderSnapshot(snapshot:Snapshot,options:{details?:AssessmentDetails;checklist?:boolean;check?:string;evidence?:boolean}={}):string {
  const details=options.details??snapshot.details,rows=explainChecks(snapshot,details),lines:string[]=[],report=snapshot.checklistKind==='ENTRY'?buildEntryReport(snapshot,details):null;
  const label=(row:typeof rows[number])=>row.outcome??row.status;
  const venueResolutions=report&&details?resolveEmptyVenueEntries(details.baseline,details.profile,snapshot.cutoff):undefined;
  if(options.check){const row=rows.find(r=>r.checkId===options.check);if(!row)throw new Error('CHECK_NOT_FOUND');lines.push(`${row.checkId} ${row.name}: ${label(row)}${row.unknownKind?` (${row.unknownKind})`:``}`,...(report?['Analysis completion: '+report.completion.state+'.','Outcome basis: '+row.outcomeBasis+'; frozen policy status: '+row.policyStatus+'. Feature values below are policy inputs; insufficient support does not establish factual falsehood.']:[]),...row.values.map(v=>`  ${v.id} ${cleanText(v.name)}: ${cleanText(v.value??'unknown')} ${cleanText(v.unit)} (${v.quality})`),...row.thresholds.map(t=>`  Your ${t.field}: ${cleanText(t.value??'unset')}`),...row.causes.map(c=>`  ${categoryText[c.category]} / ${c.code}: ${cleanText(c.action)}`));const venue=venueResolutions?.[row.checkId as keyof typeof venueResolutions];if(venue&&venue.status!=='UNKNOWN'&&row.status===venue.status&&label(row)===venue.outcome)lines.push(`  Evidence assessment: ${cleanText(venue.rationale)}`);if(row.group){lines.push(`  Current group decision code: ${cleanText(row.group.code)}`,`  Current group criterion: ${cleanText(row.group.rationale,1200)}`,`  Evidence window available at: ${row.group.availableAt}`);const metrics=Object.entries(row.group.metrics).sort(([a],[b])=>a.localeCompare(b));if(metrics.length)lines.push(`  Current metrics: ${metrics.slice(0,12).map(([key,value])=>`${cleanText(key,80)}=${metricValueText(value)}`).join('; ')}${metrics.length>12?`; ${metrics.length-12} additional metrics`:''}`);for(const limitation of row.group.limitations.slice(0,8))lines.push(`  Limitation: ${cleanText(limitation,300)}`);if(row.group.limitations.length>8)lines.push(`  ${row.group.limitations.length-8} additional limitations.`);}if(row.socialJudgment){lines.push(`  Public-evidence review: ${label(row)} — ${cleanText(row.socialJudgment.rationale)}`);if(row.socialJudgment.missingIndicators.length)lines.push(`  Desired indicators unavailable: ${row.socialJudgment.missingIndicators.join(', ')}. Missing statistics are visibility risks, not proof of fraud, bots or manipulation.`);if(row.checkId==='SOC-01'&&row.status==='FAIL')lines.push('  An insufficient identity-support grade is distinct from affirmative counterevidence; neither label alone proves impersonation.');}if(options.evidence)lines.push(...snapshot.evidence.filter(e=>row.evidenceRefs.includes(e.id)).map(e=>`  Evidence ${cleanText(e.id)}: ${cleanText(e.sourceId)} / ${e.accessMode}, retrieved ${e.retrievedAt}, SHA256 ${e.contentHash}`));return lines.join('\n')+'\n';}
  const title=snapshot.checklistKind==='ENTRY'?`ENTRY — ${snapshot.result.classification==='INSUFFICIENT_DATA'?'UNRESOLVED ANALYSIS':snapshot.result.classification.replaceAll('_',' ')}`:`MANAGEMENT — ${snapshot.result.thesisState}`;
  const mode='analysisKind' in snapshot?snapshot.analysisKind:undefined;
  lines.push(title,`Evidence mode: ${mode??'saved management inputs'}${mode==='FIXTURE'?' — SYNTHETIC TEST SCENARIO; not a live token assessment':''}`,`Token: ${cleanText(snapshot.token?`${snapshot.token.chain} ${snapshot.token.address}`:'saved case '+snapshot.caseId)}`,`As of: ${snapshot.cutoff}`);
  if(details)lines.push(`Scenario: $${details.profile.sizeUsd??'unset'} / ${details.profile.horizonSeconds===undefined?'unset horizon':`${details.profile.horizonSeconds/3600} hours`} / ${cleanText(details.profile.id)}`,`Risk limits: transfer ${details.profile.risk.maxTransferFeeBps??'unset'} bps; entry ${details.profile.risk.maxEntryImpactBps??'unset'} bps; exit ${details.profile.risk.maxExitImpactBps??'unset'} bps; round trip ${details.profile.risk.maxRoundTripLossBps??'unset'} bps; control ${details.profile.risk.maxDirectControlShare??'unset'}; removable liquidity ${details.profile.risk.maxRemovableLiquidityShare??'unset'}.`,`Settings origin: ${cleanText(Object.entries(details.origins).map(([k,v])=>`${k}=${v}`).join(', '))||'frozen snapshot'}. Preset thresholds are uncalibrated; friction is not a price stop.`);
  else lines.push('Legacy snapshot: detailed settings/diagnostics were not stored in this envelope. Use explain to inspect its frozen checks.');
  if(report){
    lines.push('Status meanings: SUPPORTED=qualified criterion met; CONTRADICTED=affirmative counterevidence; INSUFFICIENT=completed review lacks required support; UNKNOWN=unresolved evaluation or fact. Scope is stated beside each result.',
      'Analysis completion: '+report.completion.state+(report.completion.blockers.length?' — '+report.completion.blockers.map(b=>b.checkId+': '+b.code).join('; '):report.completion.state==='UNVERIFIED'?' — no current phase-completion projection retained.':''),
      'Required decisions resolved: '+report.coverage.known+'/'+report.coverage.total+'. INSUFFICIENT is a completed negative entry decision, not proof of a false token fact.',
      'All checklist UNKNOWN rows: '+report.checks.filter(c=>c.outcome==='UNKNOWN').length+' ('+report.checks.filter(c=>c.required&&c.outcome==='UNKNOWN').length+' required; '+report.checks.filter(c=>!c.required&&c.outcome==='UNKNOWN').length+' outside required coverage).');
    if(report.coverage.known!==report.policyCoverage.known)lines.push('Frozen policy coverage: '+report.policyCoverage.known+'/'+report.policyCoverage.total+'. Current report coverage requires an explicit judgment basis; historical policy decisions and hashes are unchanged.');
    for(const pillar of ['ONCHAIN','ATTENTION','SOCIAL','SHARED'] as const){const p=report.pillars[pillar];lines.push(pillar.toLowerCase()+' pillar: '+p.supported+' supported, '+p.contradicted+' contradicted, '+p.insufficient+' insufficient, '+p.unknown+' unknown.');}
    const empty=venueResolutions?.['EXE-01'];if(empty?.status==='FAIL'&&report.checks.find(c=>c.checkId==='EXE-01')?.outcome===empty.outcome)lines.push('The selected pool has no active liquidity. No quote, fee estimate, removable-liquidity fraction or round-trip simulation was produced. The criterion decisions are separate from these unmeasured facts.');
    const m=report.market.selected;
    if(m){lines.push('Market observation: $'+m.priceUsd+'/token; displayed liquidity $'+(m.liquidityUsd??'UNKNOWN')+'; pair-only rolling 24h volume $'+(m.volume24hUsd??'UNKNOWN')+'. This is not executable depth.',
      'Market scope: '+m.provider+' / '+m.dexId+' / pool '+m.pairAddress+'; observed '+m.retrievedAt+'; provider-reported rolling 24h; no cross-pool aggregation; retained '+m.retainedPairCount+'/'+m.reportedPairCount+' pairs'+(m.truncated?' (TRUNCATED)':'')+'.');}
    const route=report.market.executionRoutePair;if(route)lines.push('Execution-pool market observation: '+route.dexId+' / '+route.pairAddress+'; same-capture pair-only rolling 24h volume $'+(route.volume24hUsd??'UNKNOWN')+'; liquidity $'+(route.liquidityUsd??'UNKNOWN')+'. Different pools and capture times must not be compared as token-wide totals.');
    lines.push('Separate auxiliary facts: '+report.auxiliaryFacts.length+' UNKNOWN (unqualified measurements, not additional entry decisions or default release blockers; missing values are not invented zeros).'+(report.auxiliaryFacts.length?' '+report.auxiliaryFacts.map(f=>f.id).join(', ')+'.':''));
  }else if(snapshot.checklistKind==='MANAGEMENT'){
    lines.push('Baseline: '+snapshot.baselineSnapshotId+' / episode '+snapshot.episodeId,'Proposal: '+snapshot.result.proposal+(snapshot.result.proposedQuantityAtomic?' ('+snapshot.result.proposedQuantityAtomic+' token atoms)':'; no execution'));
    const market=snapshot.market?.pairs.find(p=>p.mintSide==='base'&&p.priceUsd!==null);if(market)lines.push('Market observation: $'+market.priceUsd+'/token; displayed liquidity $'+(market.liquidityUsd??'unknown')+'; rolling 24h volume $'+(market.volume24hUsd??'unknown')+'. This is not executable depth.');
  }
  if(snapshot.collection)lines.push(`Sources: RPC ${snapshot.collection.rpc.state}${snapshot.collection.rpc.code?`/${snapshot.collection.rpc.code}`:''}; DEX ${snapshot.collection.dex.state}; web ${snapshot.collection.web.state}${snapshot.collection.web.code?`/${snapshot.collection.web.code}`:''}.`);
  const recovered=snapshot.evidence.filter(e=>e.scope.method==='tinyfish-live-dex-json-v1').map(e=>e.id);
  if(recovered.length)lines.push(`Market recovery: free TinyFish live Fetch (${recovered.join(', ')}); original direct responses retained. Recovery does not certify market accuracy.`);
  const feeRetries=snapshot.evidence.filter(e=>e.id.endsWith('-min-context-recovery')||/^curve-(?:entry|exit)-fee-recovery$/.test(e.id));
  if(feeRetries.length)lines.push(`Fee recovery: ${feeRetries.length} bounded retries while the RPC caught up to the required finalized slot; the slot requirement and quote expiry were preserved.`);
  if(snapshot.evidence.some(e=>e.id==='pump-slippage-refresh'))lines.push('Execution recovery: one complete fresh-state quote and unsigned simulation retry; the spending limit was not widened.');
  if((details?.baseline.find(a=>a.id==='O16')?.data as {method?:string}|undefined)?.method==='pump-budget-rejection-v1')lines.push('Execution finding: both unsigned buys exceeded their exact quoted spending limit. '+(report?'CONTRADICTED':'FAIL')+' means the entry execution-cost standard was not met; fees, sellability and fraud are not established.');
  if(snapshot.evidence.some(e=>e.id==='social-repair-selection'))lines.push('Social review recovery: one reassessment and fresh independent review were attempted; the original rejection is retained. Only an accepted review can change the result.');
  if(snapshot.semantic)lines.push(`Semantic extraction: ${snapshot.semantic.status}, ${snapshot.semantic.claims.length} claims. ${snapshot.semantic.status==='VALIDATED'?'Validated means source-qualified by automated review, not verified real-world truth.':'Candidates are source claims, not verified checklist evidence.'}`);
  const models=[...new Set(snapshot.evidence.filter(e=>e.id.includes('-transport-attempt-')).map(e=>e.scope.model).filter((m):m is string=>typeof m==='string'))];
  if(models.length)lines.push(`Hosted models attempted: ${models.map(m=>cleanText(m,100)).join(', ')}. Each accepted claim still requires independent source review.`);
  if((details?.baseline.find(a=>a.id==='A03')?.data as {originBasis?:string}|undefined)?.originBasis==='PUBLIC_EVIDENCE_INADEQUATE')lines.push('Origin support INSUFFICIENT: reviewed public origin/catalyst evidence is inadequate within the declared discovery sample. This is poor traceability, not a finding of fraud.');
  if(details?.shared){const s=details.shared;lines.push(`Shared evidence: ${s.witnesses.filter(w=>w.status!=='UNKNOWN').length}/${s.witnesses.length} required decisions resolved; semantic receipts ${s.semanticQualified?'qualified':'incomplete'}; conflict audit ${s.auditQualified?'qualified':s.auditCompleted?'completed, insufficient evidence':'incomplete'} (${s.conflicts.length} scoped conflicts).`);if(s.unresolved.length)lines.push(`Shared coverage waits for: ${s.unresolved.join(', ')}.`);lines.push('Growth compares two equal time bins in the reviewed fixed sample. Data-quality checks assess this decision scope; they do not certify token truth or platform-wide coverage.');}
  if(details?.shared?.qualityMode==='ENTRY_GATES_V1')lines.push('Data-quality FAIL means the analysis evidence standard is unmet. An incomplete conflict audit is not a detected conflict.');
  if(details?.groups||details?.shared?.qualityMode==='ENTRY_GROUPS_V1')lines.push('All five entry groups are required in this policy. Each group uses current criterion-level evidence; unlisted history and metrics were not measured and are not treated as zero.');
  const originResolution=resolveOriginEntryCriterion(details?.baseline??[]);if(originResolution&&report){const outcome=report.checks.find(c=>c.checkId==='NAR-02')?.outcome??'UNKNOWN';lines.push('Entry evidence NAR-02: '+outcome+' — '+(outcome==='UNKNOWN'&&originResolution.status!=='UNKNOWN'?'The recorded decision is not usable at this cutoff.':cleanText(originResolution.rationale)));}
  for(const a of details?.baseline??[]){const d=a.data as {entryDecisionMethod?:string;entryCriterion?:string;decision?:{verdict:string;rationale:string}};if(['binary-public-support-v1','binary-public-support-v2','binary-public-support-v3','binary-public-support-v4'].includes(d?.entryDecisionMethod??'')&&d.decision)lines.push(`Entry evidence ${d.entryCriterion}: ${report?.checks.find(c=>c.checkId===d.entryCriterion)?.outcome??d.decision.verdict} — ${cleanText(d.decision.rationale)}`);}
  if(details?.social){
    const s=details.social;
    for(const [label,judgment,checkId] of [['Identity verifiability',s.identityReview,'SOC-01'],['Source integrity',s.integrityReview,'SOC-02'],['Participation evidence',s.participationReview,'SOC-03']] as const)if(judgment){
      lines.push(`  ${label}: ${report?.checks.find(c=>c.checkId===checkId)?.outcome??judgment.verdict} — ${cleanText(judgment.rationale)}`);
      if(judgment.missingIndicators.length)lines.push(`    Desired indicators unavailable: ${judgment.missingIndicators.map(indicator=>cleanText(indicator)).join(', ')}. Missing statistics are visibility risks, not proof of fraud, bots or manipulation.`);
    }
    if(s.identityReview?.verdict==='CONTRADICTED')lines.push('  SOC-01 is a public identity-evidence criterion; its explicit outcome basis does not itself prove impersonation.');
    lines.push(`Social assessment: automated extraction and independent source review when available, ${s.start} to ${s.end}. Accounts are not people; public binding is not an authenticity guarantee.`,
      `  Sample: ${s.qualifiedOriginalCount??'unknown'} qualified original posts; ${s.accountUpperBound??'unknown'} source accounts; ${s.sampleComplete?'complete within the declared query sample':s.participationReview&&s.participationReview.verdict!=='UNRESOLVED'?'entry evidence reviewed; exact participation counts remain unqualified':'incomplete query/review scope'}.`,
      `  Independent origins: ${s.independentGroupCount??'unknown'}; communities: ${s.independentCommunityCount??'unknown'}; ${s.lineageComplete?'source lineage qualified':'source lineage unresolved'}. Participation threshold: 3 accounts / 2 origins / 2 communities.`);
    const identity=details.baseline.find(a=>a.id==='S01')?.data as {claims?:Array<{accountId:string;status:string}>}|undefined;
    for(const claim of identity?.claims??[])lines.push(`  Account ${cleanText(claim.accountId)}: ${cleanText(claim.status)}.`);
    const metrics=details.baseline.find(a=>a.id==='S06')?.data as {required?:number;coverage?:Record<string,number>}|undefined;
    if(metrics?.coverage)lines.push(`  Exact engagement fields: likes ${metrics.coverage.likes}/${metrics.required}; replies ${metrics.coverage.replies}/${metrics.required}; reposts ${metrics.coverage.reposts}/${metrics.required}. Missing fields are not zero.`);
    const history=details.baseline.find(a=>a.id==='S05')?.data as {indicators?:Array<{createdAt:string|null;historyPosts:number}>}|undefined;
    if(history?.indicators)lines.push(`  Account evidence: ${history.indicators.filter(a=>a.createdAt!==null).length}/${history.indicators.length} exact creation dates; ${history.indicators.filter(a=>a.historyPosts>=3).length}/${history.indicators.length} accounts with at least 3 dated original history posts.`);
    const synchrony=details.baseline.find(a=>a.id==='S04')?.data as {currentPeakFraction?:string|null;previousPeakFraction?:string|null;previousOriginals?:number}|undefined;
    if(synchrony?.currentPeakFraction!==undefined)lines.push(`  Minute synchrony: current peak fraction ${synchrony.currentPeakFraction??'unknown'}; prior equal-window peak ${synchrony.previousPeakFraction??'unknown'} (${synchrony.previousOriginals??0} prior originals). This is an uncalibrated sample contrast, not manipulation proof.`);
    for(const id of ['S04','S05']){const a=details.baseline.find(a=>a.id===id);if(a?.causes.length)lines.push(`  ${id}: ${a.causes.map(c=>cleanText(c.code)).join('; ')}.`);}
    const participation=rows.find(r=>r.checkId==='SOC-03');if(participation?.status==='FAIL'&&s.sampleComplete&&s.accountUpperBound!==null&&s.accountUpperBound<3)lines.push(`  SOC-03: the complete reviewed sample contains at most ${s.accountUpperBound} qualifying accounts, below 3. This bounded shortfall does not establish platform-wide inactivity.`);
  }
  const attention=details?.baseline.filter(a=>a.limitations.some(l=>l.startsWith('automated-source-review-v1')))??[];
  if(attention.length){
    lines.push('Attention qualification: two-pass automated source review. Describes cited source claims and a bounded search sample; it does not verify real-world claims or measure all social traffic.');
    for(const a of attention.filter(a=>['A01','A05'].includes(a.id)&&a.quality==='KNOWN')){const data=a.data as {method?:string;publicSupport?:{rationale:string}};if(data.method==='narrative-public-support-v1'&&data.publicSupport)lines.push(`  ${a.id==='A01'?'Narrative':'Explainable thesis'} support: ${report?'INSUFFICIENT':'FAIL'} — ${cleanText(data.publicSupport.rationale)} Factual narrative remains unresolved; this is poor public support, not a proven false story or fraud.`);}
    for(const id of ['A01','A02','A03','A04','A05']){const a=attention.find(a=>a.id===id);const data=a?.data as {summary?:string}|undefined;if(data?.summary)lines.push(`  ${featureMetadata.find(f=>f.id===id)?.name}: ${cleanText(data.summary)}`);}
    const sample=attention.find(a=>a.id==='A16'),authors=attention.find(a=>a.id==='A17');
    if(sample?.quality==='KNOWN')lines.push(`  Observed qualified posts: ${sample.projection?.value}; source accounts: ${authors?.projection?.value??'unknown'} (sample threshold: 10 posts / 3 accounts).`);
    const representation=attention.find(a=>a.id==='A14')?.data as {method?:string;originRelationship?:{status:string;rationale:string};measuredAttention?:{status:string;shares:Array<{token:{chain:string;address:string};count:string;share:string|null}>};leadershipScreening?:{rationale:string};basis?:string}|undefined;
    if(representation?.method==='representation-routes-v2'){
      if(representation.leadershipScreening)lines.push(`  Entry public-support grade: INSUFFICIENT — ${cleanText(representation.leadershipScreening.rationale)} (not proof of non-origin or non-leadership).`);
      lines.push(`  Factual origin relationship: ${representation.originRelationship?.status??'UNKNOWN'} — ${cleanText(representation.originRelationship?.rationale)}`);
      lines.push(`  Factual measured attention leadership: ${representation.measuredAttention?.status??'UNKNOWN'} (common-query sample; minimum 10 qualifying posts / 3 accounts / 2 representations).`);
      if(representation.basis==='ORIGIN')lines.push('  CAN-02 basis: origin-supported representation. Attention popularity is evaluated separately; origin support does not establish safety or authenticity.');
      else if(representation.basis==='MEASURED_ATTENTION')lines.push('  CAN-02 basis: unique measured attention leadership within the discovered sample.');
      const shares=representation.measuredAttention?.shares??[];
      for(const share of shares.slice(0,10))lines.push(`    ${cleanText(share.token.chain)}:${cleanText(share.token.address)} — ${cleanText(share.count)} weighted mentions${representation.measuredAttention?.status!=='UNKNOWN'?`; share ${cleanText(share.share)}`:'; insufficient comparative sample'}.`);
    }
  }
  if(report)for(const outcome of ['CONTRADICTED','INSUFFICIENT','UNKNOWN'] as const){const selected=report.checks.filter(c=>c.required&&c.outcome===outcome);if(selected.length)lines.push(outcome+' entry decisions: '+selected.map(c=>c.checkId).join(', ')+'.');}
  const modelFailures=[...new Set(details?.baseline.flatMap(a=>a.causes.map(c=>c.code)).filter(code=>/^(?:ATT|SOC|SHARED)_MODEL_(?:HTTP_\d+|TIMEOUT|RUN_TIMEOUT|RUN_ABORTED)$/.test(code))??[])];
  if(modelFailures.length)lines.push(`Unavailable model stages: ${modelFailures.map(code=>cleanText(code)).join(', ')}. Required checks blocked by these stages have no qualified result; this is not negative token evidence.`);
  const missingTopic=details?.baseline.some(a=>a.causes.some(c=>c.code==='ATT_NARRATIVE_TOKEN_BOUND_SOURCE_MISSING'));
  if(missingTopic)lines.push('Narrative evidence is missing: comparison waits for an independently qualified token-bound topic. A reference post or ticker alone is insufficient.');
  const program=details?.baseline.find(a=>a.id==='O05');if(program?.projection?.quality==='KNOWN'&&program.projection.value===false)lines.push('Program-control finding: an upgrade authority was observed on the shared token program. This fails the current immutable-program rule; it does not identify a token-specific rug.');
  const comparison=details?.baseline.find(a=>a.id==='A09');
  const adequacy=(comparison?.data as {evidenceAdequacy?:{rationale:string}}|undefined)?.evidenceAdequacy;
  if(comparison?.projection?.quality==='KNOWN'&&comparison.projection.value===false&&adequacy)lines.push(`Public representation evidence: inadequate after independent source review — ${cleanText(adequacy.rationale)}. This screening failure does not prove another competing token or fraud.`);
  if(details?.thesis){const t=details.thesis;const support=t.support.map(p=>({p,truth:evaluatePredicate(p,snapshot.features,snapshot.cutoff)})),invalid=t.invalidation.map(p=>({p,truth:evaluatePredicate(p,snapshot.features,snapshot.cutoff)}));lines.push(`Thesis: ${snapshot.checklistKind==='ENTRY'?(snapshot.result.binary==='PASS'?'eligible entry thesis':'proposed; management not started'):'frozen baseline comparison'}.`);for(const [label,xs] of [[report?'Frozen thesis predicates met':'Supports',support.filter(p=>p.truth==='TRUE')],[report?'Frozen thesis predicates unmet or triggered':'Contradicts',[...support.filter(p=>p.truth==='FALSE'),...invalid.filter(p=>p.truth==='TRUE')]],[report?'Unresolved thesis predicates':'Thesis unknown',[...support,...invalid].filter(p=>p.truth==='UNKNOWN')]] as const)lines.push(`${label}: ${xs.length?xs.map(x=>describePredicate(x.p)).join('; '):'none established'}.`);lines.push(`Plan readiness: ${t.legs.length&&t.onchainTraction&&t.externalTraction?'SPECIFIED':'INCOMPLETE (traction/realization not fully specified)'}. Expiry: ${t.expiryAt??'none selected'}.`);}
  lines.push('',`${snapshot.checklistKind==='ENTRY'?'Entry':'Management'} checklist:`);
  const selected=options.checklist?rows:rows.filter(r=>r.required||!r.checkId.startsWith('ADV-'));
  if(options.checklist&&rows.some(r=>r.checkId.startsWith('ADV-'))&&!details?.groups&&details?.shared?.qualityMode!=='ENTRY_GROUPS_V1')lines.push('ADV-* groups are outside the current required manifest and pillar totals. Missing collectors in these groups remain unfinished capabilities.');
  for(const id of ['A15','A18']){const a=details?.baseline.find(a=>a.id===id),d=a?.data as {method?:string;entryCriterion?:string;reason?:string}|undefined;if(d?.method==='entry-evidence-gate-v1')lines.push((id==='A18'?'Growth evidence branch':'Qualified sample evidence')+': INSUFFICIENT — '+cleanText(d.reason)+ ' This does not establish zero posts or declining attention.'+(id==='A18'?' ATT-02 also evaluates community breadth independently.':''));}
  for(const criterion of ['attentionContext','qualifiedSample','growth'] as const){const bound=qualifiedAttentionEntryBound(details?.baseline??[],criterion),fact=details?.baseline.find(a=>a.id===(criterion==='growth'?'A18':'A15'));if(bound&&fact?.quality!=='KNOWN')lines.push('Bounded '+criterion+': '+(bound.status==='PASS'?'SUPPORTED':'CONTRADICTED')+' — '+cleanText(bound.rationale)+' Exact measurements remain unknown.');}
  for(const [criterion,name]of [['attentionContext','Attention-context evidence'],['qualifiedSample','Qualified-sample evidence'],['growth','Growth evidence branch']] as const){const support=resolveAttentionEntryCriterion(details?.baseline??[],criterion)?null:qualifiedAttentionEntrySupport(details?.baseline??[],criterion);if(support)lines.push(name+': INSUFFICIENT — '+cleanText(support.rationale)+' Original post measurements remain separately qualified; unavailable content is not zero activity.');}
  if(rows.some(r=>label(r)==='UNKNOWN'))lines.push('Unknown causes: INFRA=request/quota/deadline; COLLECTION=blocked or incomplete sources; MODEL=unfinished or unqualified review; EXECUTION=quote/setup/simulation; INPUT=settings; IMPLEMENTATION=unsupported collector; DATA=missing evidence. Higher rate limits address only some INFRA failures.');
  for(const row of selected){const tags=[...new Set(row.causes.map(c=>categoryText[c.category]))];if(label(row)==='UNKNOWN'&&row.featureRefs.some(id=>/^[OAS]/.test(id)))tags.push(...[...new Set(row.causes.map(c=>c.code))].slice(0,2));lines.push(`  ${(label(row)+(row.unknownKind?` (${row.unknownKind})`:``)).padEnd(25)} ${row.checkId} ${row.name}${label(row)==='UNKNOWN'?` — ${tags.join('; ')}`:''}${row.group?` — ${cleanText(row.group.rationale,220)} [${cleanText(row.group.code,80)}]`:''}`);}
  const actions=[...new Set(rows.flatMap(r=>label(r)==='UNKNOWN'?r.causes.map(c=>c.action):[]))];
  lines.push('','Next actions:',...actions.slice(0,6).map(a=>`  - ${cleanText(a)}`),`  - Inspect a row offline: explain ${snapshot.id} --check <ID> --evidence`,`Snapshot: ${snapshot.id}`);
  return lines.join('\n')+'\n';
}
