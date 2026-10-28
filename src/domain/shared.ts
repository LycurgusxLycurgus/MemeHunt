import {resolveEmptyVenueEntries} from './venue-entry.js';
import { acquisitionEvidenceMethod, type AcquisitionEvidence } from '../providers/acquisition-evidence.js';
import {attentionEntryBoundsSchema,attentionExplanationSchema,binaryPublicEntryDecisionV5Schema,criterionProofSchema,factualCriterionProofSchema,resolveAttentionEntryCriterion,resolveOriginEntryCriterion,qualifiedAttentionEntryBound,qualifiedAttentionEntrySupport} from './attention.js';
import {sharedClaimProjectionMethod} from '../providers/attention.js';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { evaluateEntry, type EntryEvidenceGates } from './policy.js';
import { sharedPolicyFactsSchema, type SharedPolicyFacts, type EntryGroupFacts, type FeatureResult, type EvidenceRecord, type Observation, type Profile, type SocialPolicyFacts, type TokenRef } from './contracts.js';
import type { BaselineAssessment } from './baseline.js';
import type { AttentionSource } from '../providers/attention.js';

export const sharedClaimSchema=z.object({id:z.string(),statement:z.string().min(1).max(4000),supportBasis:z.enum(['BODY_FACT','BOUNDED_SUPPORT_DECISION']).optional(),featureIds:z.array(z.string()).optional(),entryScope:attentionEntryBoundsSchema.optional(),criterionContext:z.object({method:z.literal('criterion-premises-v1'),criterion:z.enum(['NAR-01','NAR-02','NAR-03']),value:z.boolean().optional(),verdict:z.enum(['PASS','FAIL']).optional(),negativeBasis:z.enum(['FACTUAL_COUNTEREVIDENCE','PUBLIC_SUPPORT_INADEQUATE']).optional(),proof:z.union([criterionProofSchema,factualCriterionProofSchema]).optional(),publicDecision:binaryPublicEntryDecisionV5Schema.optional()}).strict().optional(),citations:z.array(z.object({sourceId:z.string(),quote:z.string().min(8).max(1000)}).strict()).min(1).max(10)}).strict();
export type SharedClaim=z.infer<typeof sharedClaimSchema>;
export type SharedDecisionMethod='independent-final-dispositions-v1'|'source-support-and-conflict-v2';
export const sharedAuditSchema=z.object({
  decisionMethod:z.enum(['independent-final-dispositions-v1','source-support-and-conflict-v2']).optional(),
  claims:z.array(z.object({id:z.string(),support:z.enum(['SUPPORTED','INSUFFICIENT','UNRESOLVED']).optional(),disposition:z.enum(['CLEAR','CONFLICT','UNCLEAR']),rationale:z.string().min(8).max(1000),citations:z.array(z.object({sourceId:z.string(),quote:z.string().min(8).max(1000)}).strict()).max(5)}).strict()).max(40),
  review:z.array(z.object({id:z.string(),accepted:z.boolean()}).strict()).max(40),
  sources:z.array(z.object({id:z.string(),complete:z.boolean()}).strict()).max(64),
}).strict();
export type SharedAudit=z.infer<typeof sharedAuditSchema>;
export function hasTwoConflictSides(claim:SharedAudit['claims'][number]){return claim.disposition!=='CONFLICT'||new Set(claim.citations.map(ref=>JSON.stringify([ref.sourceId,ref.quote]))).size>=2;}
export type SharedSource=(Omit<AttentionSource,'kind'>&{kind:'PAGE'|'POST'|'INDEXED_METADATA'})|AcquisitionEvidence;
export type SharedInputs={acquisitionEvidenceMethod?:typeof acquisitionEvidenceMethod;decisionMethod?:SharedDecisionMethod;sourceInspectionMethod?:'acquired-text-inspection-v1';completionMethod?:'reviewed-audit-completion-v1';qualityMode?:'ENTRY_GATES_V1'|'ENTRY_GROUPS_V1';groups?:EntryGroupFacts;token:TokenRef;cutoff:string;profile:Profile;baseline:BaselineAssessment[];features:FeatureResult[];evidence:EvidenceRecord[];observations:Observation[];social?:SocialPolicyFacts;claims:SharedClaim[];sources:SharedSource[];audit:SharedAudit|null;semanticReceiptIds:string[]};

/** A reviewed entry-support decision does not resolve factual candidate binding. */
export function comparisonEntryGrade(baseline:BaselineAssessment[]):boolean|undefined{
 const a=baseline.find(a=>a.id==='A09'&&a.quality==='KNOWN'),d=a?.data as {entryDecisionMethod?:string;decision?:{verdict?:string}}|null|undefined;
 return !!d&&['binary-public-support-v1','binary-public-support-v2','binary-public-support-v3','binary-public-support-v4','binary-public-support-v5'].includes(d.entryDecisionMethod??'')&&['PASS','FAIL'].includes(d.decision?.verdict??'')&&a?.projection?.value===(d.decision?.verdict==='PASS')?d.decision?.verdict==='PASS':undefined;
}
/** Negative entry evidence grades retain unknown factual counts and growth. */
export function attentionEntryGates(baseline:BaselineAssessment[],entryGroups=false):EntryEvidenceGates|undefined{
 const gates:EntryEvidenceGates={};
 if(qualifiedAttentionEntrySupport(baseline,'qualifiedSample'))gates.sample=false;
 if(qualifiedAttentionEntrySupport(baseline,'growth'))gates.growth=false;
 for(const [id,criterion,key]of [['A15','ATT-01','sample'],['A18','ATT-02','growth']] as const){const a=baseline.find(a=>a.id===id&&a.quality!=='STALE'),d=a?.data as {method?:string;entryCriterion?:string;verdict?:string;postSampleScope?:{complete:boolean}}|null|undefined;if(d?.method==='entry-evidence-gate-v1'&&d.entryCriterion===criterion&&d.verdict==='FAIL'&&d.postSampleScope?.complete===true)gates[key]=false;}
 if(entryGroups){const origin=resolveOriginEntryCriterion(baseline);if(origin)gates.originResolution=origin;else {const a=baseline.find(a=>a.id==='A03'&&a.quality==='KNOWN'&&a.projection?.quality==='KNOWN'),d=a?.data as {method?:string;entryCriterion?:string;entryDecisionMethod?:string;decision?:{verdict?:string;citations?:unknown[]}}|null|undefined;if(d&&['binary-public-support-v4','binary-public-support-v5'].includes(d.method??'')&&d.entryDecisionMethod===d.method&&d.entryCriterion==='NAR-02'&&['PASS','FAIL'].includes(d.decision?.verdict??'')&&d.decision?.citations?.length&&a?.projection?.value===(d.decision.verdict==='PASS'))gates.originTraceability=d.decision.verdict==='PASS';}}
 for(const [criterion,key]of [['qualifiedSample','sample'],['growth','growth']] as const){const resolution=resolveAttentionEntryCriterion(baseline,criterion);if(resolution){(gates.resolutions??={})[key]=resolution;if(resolution.status!=='UNKNOWN')gates[key]=resolution.status==='PASS';else delete gates[key];}else{const bound=qualifiedAttentionEntryBound(baseline,criterion);if(bound)gates[key]=bound.status==='PASS';}}
 return Object.keys(gates).length?gates:undefined;
}
export function entryEvidenceGates(baseline:BaselineAssessment[],entryGroups=false,profile?:Profile,cutoff?:string):EntryEvidenceGates|undefined{const attention=attentionEntryGates(baseline,entryGroups),venue=profile&&cutoff?resolveEmptyVenueEntries(baseline,profile,cutoff):undefined;return venue?{...attention,venueResolutions:venue}:attention;}
/** Reuse the actual entry evaluator. Remove inputs only when the same decision survives. */
export function sharedWitnesses(features:FeatureResult[],profile:Profile,cutoff:string,social?:SocialPolicyFacts,entryComparison?:boolean,entryGates?:EntryEvidenceGates,groups?:EntryGroupFacts,baseline?:BaselineAssessment[]){
  const mode=social?.identityReview||social?.integrityReview?'QUALIFIED_V4':social?'QUALIFIED_V3':'QUALIFIED_V2';
  const rows=evaluateEntry(features,profile,cutoff,mode,social,false,entryComparison,entryGates,groups).checks.filter(c=>c.required&&!c.checkId.startsWith('DAT-'));
  return rows.map(row=>{
    const venue=entryGates?.venueResolutions?.[row.checkId as keyof NonNullable<EntryEvidenceGates['venueResolutions']>];
    if(venue)return {checkId:row.checkId,status:row.status as 'PASS'|'FAIL'|'UNKNOWN',featureIds:venue.featureIds,evidenceIds:venue.evidenceIds,route:'qualified-venue'};
    const origin=row.checkId==='NAR-02'?entryGates?.originResolution:undefined;
    if(origin)return {checkId:row.checkId,status:row.status as 'PASS'|'FAIL'|'UNKNOWN',featureIds:origin.featureIds,evidenceIds:origin.evidenceIds,route:'qualified-attention'};
    const group=groups?.groups.find(g=>g.checkId===row.checkId);
    if(group)return {checkId:row.checkId,status:row.status as 'PASS'|'FAIL'|'UNKNOWN',featureIds:group.featureIds,evidenceIds:group.evidenceIds,route:'qualified-context'};
    const criterion=row.checkId==='ATT-01'?'qualifiedSample':row.checkId==='ATT-02'?'growth':null;
    const resolution=criterion&&baseline?resolveAttentionEntryCriterion(baseline,criterion):null;
    const communityPositive=features.some(f=>f.id==='S10'&&f.quality==='KNOWN'&&f.value===true)||social?.communityBreadthReview?.verdict==='SUPPORTED';
    if(resolution&&row.checkId==='ATT-02'&&communityPositive){const scalar=features.find(f=>f.id==='S10'&&f.quality==='KNOWN'&&f.value===true);return {checkId:row.checkId,status:row.status as 'PASS'|'FAIL'|'UNKNOWN',featureIds:scalar?['S10']:[],evidenceIds:scalar?scalar.evidenceIds:social?.evidenceIds??[],route:scalar?'entry-policy':'qualified-social'};}
    if(resolution&&resolution.status!=='UNKNOWN'&&(row.checkId==='ATT-01'||!communityPositive)){const communityIds=row.checkId==='ATT-02'&&resolution.status!=='PASS'?['S10']:[];return {checkId:row.checkId,status:row.status as 'PASS'|'FAIL'|'UNKNOWN',featureIds:[...resolution.featureIds,...communityIds],evidenceIds:[...new Set([...resolution.evidenceIds,...(communityIds.length?social?.evidenceIds??[]:[])])],route:'qualified-attention'};}
    let selected=[...features];
    if(row.status!=='UNKNOWN')for(const feature of features){const trial=selected.filter(f=>f.id!==feature.id),result=evaluateEntry(trial,profile,cutoff,mode,social,false,entryComparison,entryGates,groups).checks.find(c=>c.checkId===row.checkId)!;if(result.status===row.status)selected=trial;}
    const featureIds=row.status==='UNKNOWN'?row.featureRefs:selected.map(f=>f.id);
    const socialIds=row.checkId.startsWith('SOC-')?social?.evidenceIds??[]:[];
    return {checkId:row.checkId,status:row.status as 'PASS'|'FAIL'|'UNKNOWN',featureIds,evidenceIds:[...new Set([...selected.filter(f=>featureIds.includes(f.id)).flatMap(f=>f.evidenceIds),...socialIds])],route:row.checkId.startsWith('SOC-')&&social?'qualified-social':row.checkId==='CAN-02'?'qualified-representation':'entry-policy'};
  });
}

export function sharedClaims(baseline:BaselineAssessment[],social?:SocialPolicyFacts,decisionMethod?:SharedDecisionMethod):SharedClaim[]{
  const claims:SharedClaim[]=[];
  const origin=resolveOriginEntryCriterion(baseline);
  if(origin&&origin.status!=='UNKNOWN'){
    const data=baseline.find(a=>a.id==='A03')?.data as {semanticPremiseMethod?:string;entryCriterionDecision?:{decision?:{verdict:'PASS'|'FAIL';negativeBasis?:string;criterionProof?:unknown}}}|undefined,decision=data?.entryCriterionDecision?.decision;
    claims.push(sharedClaimSchema.parse({id:'A03:entry',statement:origin.outcome+': '+origin.rationale,citations:origin.citations,...(data?.semanticPremiseMethod==='criterion-premises-v1'&&decision?{criterionContext:{method:data.semanticPremiseMethod,criterion:'NAR-02',verdict:decision.verdict,...(decision.negativeBasis?{negativeBasis:decision.negativeBasis}:{}),proof:decision.criterionProof}}:{})}));
  }
  for(const a of baseline.filter(a=>['A01','A02','A03','A04','A05'].includes(a.id)&&a.quality==='KNOWN')){
    const data=a.data as {originBasis?:string;summary?:string;citations?:SharedClaim['citations'];sharedClaimProjectionMethod?:string;semanticPremiseMethod?:string;criterionProof?:unknown;entryCriterionDecision?:{decision:unknown};entryDecisionMethod?:string;decision?:{verdict:'PASS'|'FAIL';negativeBasis?:string;criterionProof?:unknown};explanation?:unknown};
    if(data.summary&&data.citations){
      let statement=data.originBasis==='PUBLIC_EVIDENCE_INADEQUATE'?`Reviewed public origin evidence is inadequate within the declared discovery sample: ${data.summary}. This is a traceability screening grade, not fraud or absence of origin everywhere.`:data.summary;
      if(a.id==='A05'&&data.sharedClaimProjectionMethod===sharedClaimProjectionMethod&&data.explanation!==undefined){
        const explanation=attentionExplanationSchema.parse(data.explanation),value=z.boolean().parse(a.projection?.value);
        statement=`${data.summary}\nValue: ${value}\nReferent: ${explanation.referent}\nInterest: ${explanation.interest}\nToken relation: ${explanation.tokenRelation}\nPrerequisites: ${explanation.prerequisites.length?explanation.prerequisites.map((item,index)=>`${index+1}. ${item}`).join('\n'):'none'}`;
      }
      const context=data.semanticPremiseMethod==='criterion-premises-v1'&&['A01','A02','A05'].includes(a.id)?{method:data.semanticPremiseMethod,criterion:a.id==='A05'?'NAR-03':'NAR-01',value:a.projection?.value,...(data.entryCriterionDecision?{publicDecision:data.entryCriterionDecision.decision}:{}),...(data.entryDecisionMethod&&data.decision?{verdict:data.decision.verdict,...(data.decision.negativeBasis?{negativeBasis:data.decision.negativeBasis}:{}),proof:data.decision.criterionProof}:{...(data.criterionProof?{proof:data.criterionProof}:{})})}:undefined;
      claims.push(sharedClaimSchema.parse({id:a.id,statement,citations:data.citations,...(context?{criterionContext:context}:{})}));
    }
  }
  for(const a of baseline.filter(a=>['A09','A14'].includes(a.id)&&a.quality==='KNOWN')){const d=a.data as {entryDecisionMethod?:string;entryCriterion?:string;decision?:{verdict:string;rationale:string;citations:SharedClaim['citations']}};if(['binary-public-support-v1','binary-public-support-v2','binary-public-support-v3','binary-public-support-v4','binary-public-support-v5'].includes(d.entryDecisionMethod??'')&&d.decision)claims.push(sharedClaimSchema.parse({id:a.id+':entry',statement:'Entry '+d.entryCriterion+' evidence standard '+d.decision.verdict+': '+d.decision.rationale+'. This is a bounded public-support judgment, not verified factual identity, origin, popularity or fraud.',citations:d.decision.citations}));}
  const representation=baseline.find(a=>a.id==='A09'&&a.quality==='KNOWN');
  for(const a of baseline.filter(a=>['A01','A05'].includes(a.id)&&a.quality==='KNOWN')){
    const data=a.data as {method?:string;publicSupport?:{rationale:string;citations:SharedClaim['citations']}};
    if(data.method==='narrative-public-support-v1'&&data.publicSupport)claims.push(sharedClaimSchema.parse({id:a.id+':adequacy',statement:`Reviewed public ${a.id==='A01'?'narrative':'explainable-thesis'} support is inadequate: ${data.publicSupport.rationale}. The factual narrative remains unresolved; this is an entry support grade, not fraud or a false-story finding.`,citations:data.publicSupport.citations}));
  }
  const representations=(representation?.projection?.value===true?representation.data:null) as {candidates?:Array<{token:TokenRef;sourceId:string;quote:string}>}|undefined;
  const screening=representation?.data as {evidenceAdequacy?:{rationale:string;citations:SharedClaim['citations']}}|undefined;
  if(representation?.projection?.value===false&&screening?.evidenceAdequacy)claims.push(sharedClaimSchema.parse({id:'A09:adequacy',statement:`Public representation evidence is inadequate: ${screening.evidenceAdequacy.rationale}. This is a bounded evidence screening judgment, not a proven competing token or fraud.`,citations:screening.evidenceAdequacy.citations}));
  for(const [index,candidate] of (representations?.candidates??[]).entries())claims.push(sharedClaimSchema.parse({id:`A09:${index}`,statement:`This acquired source represents ${candidate.token.chain}:${candidate.token.address} as the same project or narrative as the target, within the reviewed comparison scope.`,citations:[{sourceId:candidate.sourceId,quote:candidate.quote}]}));
  const routes=baseline.find(a=>a.id==='A14'&&a.quality==='KNOWN')?.data as {leadershipScreening?:{rationale:string;citations:SharedClaim['citations']};originRelationship?:{status:string;rationale:string;citations:SharedClaim['citations']}}|undefined;
  if(routes?.originRelationship&&routes.originRelationship.status!=='UNKNOWN')claims.push(sharedClaimSchema.parse({id:'A14:origin',statement:`${routes.originRelationship.status}: ${routes.originRelationship.rationale}`,citations:routes.originRelationship.citations}));
  if(routes?.leadershipScreening)claims.push(sharedClaimSchema.parse({id:'A14:adequacy',statement:`Reviewed public origin/leadership support is inadequate within the declared sample: ${routes.leadershipScreening.rationale}. This entry grade does not establish factual non-origin or lack of real-world popularity.`,citations:routes.leadershipScreening.citations}));
  for(const [id,judgment] of [['SOC-01',social?.identityReview],['SOC-02',social?.integrityReview],['SOC-03',social?.participationReview],['ATT-02',social?.communityBreadthReview]] as const)if(judgment&&judgment.verdict!=='UNRESOLVED')claims.push(sharedClaimSchema.parse({id,statement:`${social?.outcomeBasisMethod&&judgment.verdict==='CONTRADICTED'?(judgment.negativeBasis==='PUBLIC_SUPPORT_INADEQUATE'?'INSUFFICIENT':'CONTRADICTED'):judgment.verdict}: ${judgment.rationale}. Social sample publication window: ${social!.start} inclusive to ${social!.end} exclusive; retrieval time does not make an older post current.`,citations:judgment.citations}));
  const fresh=resolveAttentionEntryCriterion(baseline,'qualifiedSample');
  if(fresh){
    const context=resolveAttentionEntryCriterion(baseline,'attentionContext'),growth=resolveAttentionEntryCriterion(baseline,'growth');
    const selected=[fresh,...(context?.components??[]),...(social?.communityBreadthReview?.verdict==='SUPPORTED'||baseline.some(a=>a.id==='S10'&&a.quality==='KNOWN'&&a.projection?.value===true)?[]:growth?[growth]:[])];
    const used=new Set<string>();for(const resolution of selected)if(resolution.route==='bounded'&&resolution.status!=='UNKNOWN'&&!used.has(resolution.criterion)){used.add(resolution.criterion);claims.push(sharedClaimSchema.parse({id:'attention-bounds:'+resolution.criterion,statement:resolution.outcome+' for the bounded '+resolution.criterion+' entry support criterion. '+resolution.rationale+' Window '+resolution.start+' inclusive to '+resolution.end+' exclusive. Conservative intervals: '+(resolution.bounds?JSON.stringify(resolution.bounds):'not established')+'. Exact factual totals remain unqualified.',citations:resolution.citations,...(used.size===1&&resolution.bounds?{entryScope:attentionEntryBoundsSchema.parse(Object.fromEntries(Object.entries((baseline.find(a=>a.id===(resolution.criterion==='growth'?'A18':'A15'))?.data as {entryBounds:Record<string,unknown>}).entryBounds).filter(([key])=>key!=='inspectionComplete')))}:{})}));}
  }else{
  for(const criterion of ['attentionContext','qualifiedSample','growth'] as const){const support=qualifiedAttentionEntrySupport(baseline,criterion);if(support)claims.push(sharedClaimSchema.parse({id:'attention-support:'+criterion,statement:'Reviewed '+criterion+' entry public support is inadequate: '+support.rationale+'. Actual original post counts, dates and growth remain separately unqualified.',citations:support.citations}));}
  for(const criterion of ['attentionContext','qualifiedSample','growth'] as const){const id=criterion==='growth'?'A18':'A15',fact=baseline.find(a=>a.id===id),bound=qualifiedAttentionEntryBound(baseline,criterion);if(bound&&fact?.quality!=='KNOWN'&&(criterion!=='attentionContext'||bound.status==='FAIL'||['A01','A02','A05'].every(id=>baseline.find(a=>a.id===id)?.projection?.value===true))&&(criterion!=='growth'||social?.communityBreadthReview?.verdict!=='SUPPORTED'&&baseline.find(a=>a.id==='S10')?.projection?.value!==true))claims.push(sharedClaimSchema.parse({id:'attention-bounds:'+criterion,statement:bound.status+' for the '+(criterion==='attentionContext'?'3-post / 3-account component of attention context':criterion)+' bounded entry predicate. '+bound.rationale+' Exact total measurements remain unqualified; this is not all-platform activity.',citations:bound.citations}));}
  }
  if(decisionMethod==='source-support-and-conflict-v2')for(const claim of claims){
    const id=claim.id,criterion=id.split(':')[1];
    if(baseline.some(a=>(a.data as {acquisitionEvidenceMethod?:string})?.acquisitionEvidenceMethod===acquisitionEvidenceMethod)||social?.acquisitionEvidenceMethod===acquisitionEvidenceMethod){
      const data=baseline.find(a=>a.id===id.split(':')[0])?.data as {entryDecisionMethod?:string;decision?:{negativeBasis?:string};method?:string;originBasis?:string}|undefined;
      const judgment=id==='SOC-01'?social?.identityReview:id==='SOC-02'?social?.integrityReview:id==='SOC-03'?social?.participationReview:id==='ATT-02'?social?.communityBreadthReview:undefined;
      const bounded=id==='A03:entry'&&origin?.basis==='PUBLIC_SUPPORT_INADEQUATE'||claim.citations.some(ref=>/^acquisition-(?:attention|social)-scope$/.test(ref.sourceId))||data?.decision?.negativeBasis==='PUBLIC_SUPPORT_INADEQUATE'||data?.originBasis==='PUBLIC_EVIDENCE_INADEQUATE'||data?.method==='narrative-public-support-v1'||judgment?.negativeBasis==='PUBLIC_SUPPORT_INADEQUATE'||id.startsWith('attention-support:');
      claim.supportBasis=bounded?'BOUNDED_SUPPORT_DECISION':'BODY_FACT';
    }
    claim.featureIds=origin&&id==='A03'?[]:id.startsWith('SOC-')||id==='ATT-02'?[id]:id.startsWith('attention-')?(criterion==='growth'?['A18']:criterion==='attentionContext'?['A01','A02','A05','A15']:['A15']):[id.split(':')[0]];
    const route=baseline.find(a=>a.id==='A14')?.data as {basis?:string;entryDecisionMethod?:string;decision?:{basis?:string}}|undefined;
    if(id==='A14:origin'&&(route?.entryDecisionMethod||route?.basis!=='ORIGIN'))claim.featureIds=[];
    if(id==='A14:adequacy'&&(route?.entryDecisionMethod||route?.basis!=='EVIDENCE_INADEQUACY'))claim.featureIds=[];
  }
  return claims;
}

/** Source support affects only the recorded sufficient witnesses, never an unused OR alternative. */
export function sharedClaimSupportOutcomes(facts:SharedPolicyFacts|undefined){
  const result=new Map<string,Array<{outcome:'INSUFFICIENT'|'UNKNOWN';rationale:string;evidenceIds:string[]}>>();
  if(facts?.decisionMethod!=='source-support-and-conflict-v2')return result;
  for(const claim of facts.claimSupport??[]){
    const support=facts.auditCompleted?claim.support:'UNRESOLVED';
    if(support==='SUPPORTED')continue;
    for(const witness of facts.witnesses){
      const directly=claim.id===witness.checkId&&(claim.id!=='ATT-02'||witness.route==='qualified-social');
      const featureMatch=claim.featureIds.some(id=>witness.featureIds.includes(id));
      if(!directly&&!featureMatch)continue;
      const decisions=result.get(witness.checkId)??[];
      decisions.push({outcome:support==='UNRESOLVED'?'UNKNOWN':'INSUFFICIENT',rationale:claim.rationale,evidenceIds:claim.evidenceIds});
      result.set(witness.checkId,decisions);
    }
  }
  return result;
}

export function deriveShared(input:SharedInputs){
  const decisionMethod=input.decisionMethod;
  if(decisionMethod!==undefined&&(!['independent-final-dispositions-v1','source-support-and-conflict-v2'].includes(decisionMethod)||input.completionMethod!=='reviewed-audit-completion-v1'||input.sourceInspectionMethod!=='acquired-text-inspection-v1')||input.audit&&input.audit.decisionMethod!==decisionMethod)throw Error('SHARED_DECISION_METHOD_INVALID');
  const supportMethod=decisionMethod==='source-support-and-conflict-v2';
  const audit=input.audit&&sharedAuditSchema.safeParse(input.audit);
  if(audit?.success&&audit.data.claims.some(c=>supportMethod?c.support===undefined:c.support!==undefined))throw Error('SHARED_SUPPORT_METHOD_INVALID');
  if(input.qualityMode==='ENTRY_GROUPS_V1'&&!input.groups)throw Error('SHARED_GROUPS_REQUIRED');
  const gates=input.qualityMode==='ENTRY_GATES_V1'||input.qualityMode==='ENTRY_GROUPS_V1';
  const witnesses=sharedWitnesses(input.features,input.profile,input.cutoff,input.social,gates?comparisonEntryGrade(input.baseline):undefined,gates?entryEvidenceGates(input.baseline,!!input.groups,input.profile,input.cutoff):undefined,input.groups,input.baseline),unresolved=witnesses.filter(w=>w.status==='UNKNOWN').map(w=>w.checkId);
  const selected=new Set(witnesses.filter(w=>w.status!=='UNKNOWN'&&w.route!=='qualified-context').flatMap(w=>w.featureIds));
  const freshness=[...selected].map(id=>{
    const f=input.features.find(f=>f.id===id)!,a=input.baseline.find(a=>a.id===id),data=a?.data as {window?:{end?:string};end?:string;screening?:{availableAt?:string}}|undefined;
    const ttlSeconds=['O10','O11','O13','O14','O15','O16',...(input.groups?['O12']:[]),...(witnesses.some(w=>w.route==='qualified-venue')?['O08']:[])].includes(id)?30:/^[AS]/.test(id)?900:300;
    const freshnessIds=id==='O08'&&data?.screening?f.evidenceIds.filter(id=>['damm-state','damm-program','damm-program-data'].includes(id)):f.evidenceIds;
    const refs=freshnessIds.map(id=>input.evidence.find(e=>e.id===id));
    const eventAt=data?.screening?.availableAt??data?.window?.end??data?.end??f.availableAt;
    const times=[eventAt,...refs.flatMap(e=>e?[e.retrievedAt,e.availableAt]:[])];
    const fresh=refs.length>0&&refs.every(e=>!!e)&&times.every(time=>{const age=Date.parse(input.cutoff)-Date.parse(time);return Number.isFinite(age)&&age>=0&&age<=ttlSeconds*1000;});
    return {featureId:id,ttlSeconds,eventAt,fresh,evidenceIds:freshnessIds};
  });
  // Social witnesses may be decided from qualified judgments rather than legacy scalar projections.
  for(const w of witnesses.filter(w=>w.route==='qualified-social'&&w.status!=='UNKNOWN')){
    const social=input.social!,refs=w.evidenceIds.map(id=>input.evidence.find(e=>e.id===id));
    const fresh=refs.length>0&&refs.every(e=>!!e&&[e.retrievedAt,e.availableAt].every(t=>Date.parse(t)<=Date.parse(input.cutoff)&&Date.parse(input.cutoff)-Date.parse(t)<=900000))&&Date.parse(input.cutoff)-Date.parse(social.end)>=0&&Date.parse(input.cutoff)-Date.parse(social.end)<=900000;
    freshness.push({featureId:w.checkId,ttlSeconds:900,eventAt:social.end,fresh,evidenceIds:w.evidenceIds});
  }
  for(const group of input.groups?.groups.filter(g=>g.status!=='UNKNOWN')??[]){
    const empty=group.checkId==='ADV-05'&&group.code==='DAMM_NO_ACTIVE_LIQUIDITY'&&resolveEmptyVenueEntries(input.baseline,input.profile,input.cutoff)?.['ADV-05']?.code===group.code;
    const ttlSeconds=empty?30:['ADV-03','ADV-04'].includes(group.checkId)?900:300,ids=empty?group.evidenceIds.filter(id=>['damm-state','damm-program','damm-program-data'].includes(id)):group.evidenceIds,refs=ids.map(id=>input.evidence.find(e=>e.id===id));
    const fresh=refs.length>0&&(!empty||['damm-state','damm-program'].every(id=>ids.includes(id)))&&group.evidenceIds.every(id=>input.evidence.some(e=>e.id===id))&&[group.availableAt,...refs.flatMap(e=>e?[e.availableAt,e.retrievedAt]:[''])].every(t=>Number.isFinite(Date.parse(t))&&Date.parse(t)<=Date.parse(input.cutoff)&&Date.parse(input.cutoff)-Date.parse(t)<=ttlSeconds*1000);
    freshness.push({featureId:group.checkId,ttlSeconds,eventAt:group.availableAt,fresh,evidenceIds:group.evidenceIds});
  }
  const sourceMap=new Map(input.sources.map(s=>[s.id,s]));
  const literal=(c:{sourceId:string;quote:string})=>sourceMap.get(c.sourceId)?.text.includes(c.quote)===true;
  if(input.sources.some(source=>source.kind==='ACQUISITION_RECEIPT')&&input.acquisitionEvidenceMethod!==acquisitionEvidenceMethod)throw Error('SHARED_ACQUISITION_METHOD_INVALID');
  if(input.claims.some(claim=>claim.citations.some(ref=>sourceMap.get(ref.sourceId)?.kind==='ACQUISITION_RECEIPT')&&claim.supportBasis!=='BOUNDED_SUPPORT_DECISION')||audit?.success&&audit.data.claims.some(final=>final.citations.some(ref=>sourceMap.get(ref.sourceId)?.kind==='ACQUISITION_RECEIPT')&&(final.disposition==='CONFLICT'||input.claims.find(claim=>claim.id===final.id)?.supportBasis!=='BOUNDED_SUPPORT_DECISION')))throw Error('SHARED_ACQUISITION_CITATION_INVALID');
  const semanticFeatures=witnesses.filter(w=>w.status!=='UNKNOWN').flatMap(w=>w.featureIds).filter(id=>/^A/.test(id));
  const semanticQualified=unresolved.filter(id=>/^(NAR|CAN|ATT|SOC)-/.test(id)).length===0&&input.claims.length>0&&input.claims.every(c=>c.citations.every(literal))&&JSON.stringify(input.claims)===JSON.stringify(sharedClaims(input.baseline,input.social,decisionMethod))&&JSON.stringify(input.semanticReceiptIds)===JSON.stringify(['attention-qualified-receipt','social-qualified-receipt'])&&input.semanticReceiptIds.every(id=>input.evidence.some(e=>e.id===id&&e.accessMode==='LOCAL_DERIVED'))&&semanticFeatures.every(id=>input.baseline.find(a=>a.id===id)?.quality==='KNOWN'||(id==='A15'||id==='A18'||id==='A03'&&!!resolveOriginEntryCriterion(input.baseline))&&witnesses.some(w=>w.route==='qualified-attention'&&w.status!=='UNKNOWN'&&w.featureIds.includes(id))||id==='A15'&&!resolveAttentionEntryCriterion(input.baseline,'qualifiedSample')&&!!(qualifiedAttentionEntryBound(input.baseline,'qualifiedSample')||qualifiedAttentionEntryBound(input.baseline,'attentionContext')||qualifiedAttentionEntrySupport(input.baseline,'qualifiedSample')||qualifiedAttentionEntrySupport(input.baseline,'attentionContext'))||id==='A18'&&!resolveAttentionEntryCriterion(input.baseline,'growth')&&!!(qualifiedAttentionEntryBound(input.baseline,'growth')||qualifiedAttentionEntrySupport(input.baseline,'growth')));
  const ids=input.claims.map(c=>c.id),unique=(xs:string[])=>new Set(xs).size===xs.length;
  const auditCompleted=semanticQualified&&!!audit?.success&&unique(ids)&&unique(audit.data.claims.map(c=>c.id))&&audit.data.claims.length===ids.length&&audit.data.claims.every(c=>ids.includes(c.id)&&(!decisionMethod||c.citations.length>0)&&(c.disposition!=='UNCLEAR'||c.citations.length>0)&&c.citations.every(literal)&&hasTwoConflictSides(c))&&unique(audit.data.review.map(c=>c.id))&&audit.data.review.length===ids.length&&audit.data.review.every(c=>ids.includes(c.id)&&(!!decisionMethod||c.accepted))&&unique(audit.data.sources.map(s=>s.id))&&audit.data.sources.length===input.sources.length&&audit.data.sources.every(s=>sourceMap.has(s.id)&&s.complete);
  const auditQualified=auditCompleted&&!!audit?.success&&audit.data.claims.every(c=>c.disposition!=='UNCLEAR');
  const supportCompleted=auditCompleted&&!!audit?.success&&audit.data.claims.every(c=>c.support!==undefined&&c.support!=='UNRESOLVED');
  const supportQualified=supportCompleted&&!!audit?.success&&audit.data.claims.every(c=>c.support==='SUPPORTED');
  const claimSupport=supportMethod&&audit?.success?audit.data.claims.map(c=>({id:c.id,featureIds:input.claims.find(p=>p.id===c.id)?.featureIds??[],support:c.support!,rationale:c.rationale,evidenceIds:[...new Set(c.citations.map(r=>r.sourceId))]})):[];
  const conflicts:Array<{field:string;evidenceIds:string[];rationale:string}>=[];
  const groups=new Map<string,Observation[]>();
  for(const o of input.observations.filter(o=>o.quality==='KNOWN')){const key=`${o.subject.chain}:${o.subject.address}:${o.field}:${o.unit}:${o.observedAt}`;groups.set(key,[...(groups.get(key)??[]),o]);}
  const normalized=(v:Observation['value'])=>typeof v==='string'&&/^-?\d+(\.\d+)?$/.test(v)?new Decimal(v).toFixed():JSON.stringify(v);
  for(const [field,values] of groups)if(new Set(values.map(v=>normalized(v.value))).size>1)conflicts.push({field,evidenceIds:[...new Set(values.flatMap(v=>v.evidenceIds))],rationale:'Different values for the same subject, field, unit and observation instant.'});
  if((auditQualified||input.completionMethod&&auditCompleted)&&audit?.success)for(const c of audit.data.claims.filter(c=>c.disposition==='CONFLICT'))conflicts.push({field:c.id,evidenceIds:[...new Set(c.citations.map(c=>c.sourceId))],rationale:c.rationale});
  const complete=unresolved.length===0,fresh=freshness.length>0&&freshness.every(f=>f.fresh);
  const semanticSupport=semanticQualified&&(!supportMethod||supportQualified);
  const values=gates?{C03:complete&&fresh,C04:complete,C05:semanticSupport,C06:complete&&auditQualified&&conflicts.length===0}:{C03:complete&&fresh?true:null,C04:complete?true:null,C05:semanticSupport?true:null,C06:complete&&auditQualified?conflicts.length===0:null};
  const facts=sharedPolicyFactsSchema.parse({method:'shared-evidence-v1',...(decisionMethod?{decisionMethod}:{}),...(supportMethod?{supportCompleted,supportQualified,claimSupport}:{}),...(input.completionMethod?{completionMethod:input.completionMethod,auditCompleted}:{}),...(gates?{qualityMode:input.qualityMode}:{}),token:input.token,cutoff:input.cutoff,witnesses,freshness,unresolved,semanticQualified,auditQualified,conflicts,values});
  const evidenceIds=[...new Set([...witnesses.flatMap(w=>w.evidenceIds),...input.semanticReceiptIds,...input.evidence.filter(e=>e.id==='shared-qualified-receipt'||/^shared-(proposal|review)-response$/.test(e.id)).map(e=>e.id)])];
  const auditCode=input.evidence.find(e=>e.id==='shared-audit-status')?.scope.code;
  const assessments:BaselineAssessment[]=Object.entries(values).map(([id,value])=>({id,version:'baseline-v1',evaluator:'IMPLEMENTED',collector:'IMPLEMENTED',quality:value===null?'MISSING':'KNOWN',unit:'bool',data:{method:'shared-evidence-v1',...(decisionMethod?{decisionMethod}:{}),...(input.completionMethod?{completionMethod:input.completionMethod,auditCompleted}:{}),...(gates?{qualityMode:input.qualityMode,meaning:'Entry data-quality standard; a failed or incomplete review is not a false token fact or detected conflict.',...(id==='C06'?{conflictAssessment:auditQualified?'COMPLETED':input.completionMethod&&auditCompleted?'COMPLETED_INSUFFICIENT':'INCOMPLETE_REVIEW'}:{})}:{}),unresolved,...(id==='C03'?{freshness}:{}),...(id==='C06'?{conflicts}:{})},observationIds:[],evidenceIds,limitations:['Required decision scope; no guarantee of real-world token truth or exhaustive coverage'],causes:value===null||gates&&value===false?[{category:'EVIDENCE_UNAVAILABLE',code:gates&&id==='C06'&&conflicts.length?'SHARED_CONFLICT_DETECTED':unresolved.length?'SHARED_REQUIRED_SCOPE_INCOMPLETE':id==='C03'?'SHARED_EVIDENCE_STALE':id==='C05'?'SHARED_SEMANTIC_UNQUALIFIED':(typeof auditCode==='string'&&auditCode!=='SHARED_AUDIT_RECEIVED'?auditCode:'SHARED_CONFLICT_AUDIT_INCOMPLETE'),featureId:id,evidenceIds,action:'Refresh the named required decision scope and its source qualification.'}]:[],projection:{id,value,unit:'bool',quality:value===null?'MISSING':'KNOWN',availableAt:input.cutoff,evidenceIds,applicability:'APPLICABLE'}}));
  return {facts,assessments};
}

/** Only the sufficient policy witnesses expire; unused alternatives keep their original state. */
export function expireSharedWitnesses(input:SharedInputs):SharedInputs{
  const expired=new Set(deriveShared(input).facts.freshness.filter(f=>!f.fresh).map(f=>f.featureId));
  return {...input,features:input.features.map(f=>expired.has(f.id)?{...f,quality:'STALE' as const}:f),baseline:input.baseline.map(a=>expired.has(a.id)&&a.projection?{...a,quality:'STALE' as const,projection:{...a.projection,quality:'STALE' as const},causes:[...a.causes,{category:'EVIDENCE_UNAVAILABLE' as const,code:'FEATURE_TTL_EXCEEDED',featureId:a.id,evidenceIds:a.evidenceIds,action:'Refresh the required witness; review time does not refresh its source or event window.'}]}:a)};
}
