import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { evaluateEntry, type EntryEvidenceGates } from './policy.js';
import { sharedPolicyFactsSchema, type EntryGroupFacts, type FeatureResult, type EvidenceRecord, type Observation, type Profile, type SocialPolicyFacts, type TokenRef } from './contracts.js';
import type { BaselineAssessment } from './baseline.js';
import type { AttentionSource } from '../providers/attention.js';

export const sharedClaimSchema=z.object({id:z.string(),statement:z.string().min(1).max(4000),citations:z.array(z.object({sourceId:z.string(),quote:z.string().min(8).max(1000)}).strict()).min(1).max(10)}).strict();
export type SharedClaim=z.infer<typeof sharedClaimSchema>;
export const sharedAuditSchema=z.object({
  claims:z.array(z.object({id:z.string(),disposition:z.enum(['CLEAR','CONFLICT','UNCLEAR']),rationale:z.string().min(8).max(1000),citations:z.array(z.object({sourceId:z.string(),quote:z.string().min(8).max(1000)}).strict()).max(5)}).strict()).max(40),
  review:z.array(z.object({id:z.string(),accepted:z.boolean()}).strict()).max(40),
  sources:z.array(z.object({id:z.string(),complete:z.boolean()}).strict()).max(64),
}).strict();
export type SharedAudit=z.infer<typeof sharedAuditSchema>;
export function hasTwoConflictSides(claim:SharedAudit['claims'][number]){return claim.disposition!=='CONFLICT'||new Set(claim.citations.map(ref=>JSON.stringify([ref.sourceId,ref.quote]))).size>=2;}
export type SharedSource=Omit<AttentionSource,'kind'>&{kind:'PAGE'|'POST'|'INDEXED_METADATA'};
export type SharedInputs={qualityMode?:'ENTRY_GATES_V1'|'ENTRY_GROUPS_V1';groups?:EntryGroupFacts;token:TokenRef;cutoff:string;profile:Profile;baseline:BaselineAssessment[];features:FeatureResult[];evidence:EvidenceRecord[];observations:Observation[];social?:SocialPolicyFacts;claims:SharedClaim[];sources:SharedSource[];audit:SharedAudit|null;semanticReceiptIds:string[]};

/** A reviewed entry-support decision does not resolve factual candidate binding. */
export function comparisonEntryGrade(baseline:BaselineAssessment[]):boolean|undefined{
 const a=baseline.find(a=>a.id==='A09'&&a.quality==='KNOWN'),d=a?.data as {entryDecisionMethod?:string;decision?:{verdict?:string}}|null|undefined;
 return !!d&&['binary-public-support-v1','binary-public-support-v2','binary-public-support-v3','binary-public-support-v4'].includes(d.entryDecisionMethod??'')&&['PASS','FAIL'].includes(d.decision?.verdict??'')&&a?.projection?.value===(d.decision?.verdict==='PASS')?d.decision?.verdict==='PASS':undefined;
}
/** Negative entry evidence grades retain unknown factual counts and growth. */
export function attentionEntryGates(baseline:BaselineAssessment[],entryGroups=false):EntryEvidenceGates|undefined{
 const gates:EntryEvidenceGates={};
 for(const [id,criterion,key]of [['A15','ATT-01','sample'],['A18','ATT-02','growth']] as const){const a=baseline.find(a=>a.id===id&&a.quality!=='STALE'),d=a?.data as {method?:string;entryCriterion?:string;verdict?:string;postSampleScope?:{complete:boolean}}|null|undefined;if(d?.method==='entry-evidence-gate-v1'&&d.entryCriterion===criterion&&d.verdict==='FAIL'&&d.postSampleScope?.complete===true)gates[key]=false;}
 if(entryGroups){const a=baseline.find(a=>a.id==='A03'&&a.quality==='KNOWN'&&a.projection?.quality==='KNOWN'),d=a?.data as {method?:string;entryCriterion?:string;entryDecisionMethod?:string;decision?:{verdict?:string;citations?:unknown[]}}|null|undefined;if(d?.method==='binary-public-support-v4'&&d.entryDecisionMethod===d.method&&d.entryCriterion==='NAR-02'&&['PASS','FAIL'].includes(d.decision?.verdict??'')&&d.decision?.citations?.length&&a?.projection?.value===(d.decision.verdict==='PASS'))gates.originTraceability=d.decision.verdict==='PASS';}
 return Object.keys(gates).length?gates:undefined;
}
/** Reuse the actual entry evaluator. Remove inputs only when the same decision survives. */
export function sharedWitnesses(features:FeatureResult[],profile:Profile,cutoff:string,social?:SocialPolicyFacts,entryComparison?:boolean,entryGates?:EntryEvidenceGates,groups?:EntryGroupFacts){
  const mode=social?.identityReview||social?.integrityReview?'QUALIFIED_V4':social?'QUALIFIED_V3':'QUALIFIED_V2';
  const rows=evaluateEntry(features,profile,cutoff,mode,social,false,entryComparison,entryGates,groups).checks.filter(c=>c.required&&!c.checkId.startsWith('DAT-'));
  return rows.map(row=>{
    const group=groups?.groups.find(g=>g.checkId===row.checkId);
    if(group)return {checkId:row.checkId,status:row.status as 'PASS'|'FAIL'|'UNKNOWN',featureIds:group.featureIds,evidenceIds:group.evidenceIds,route:'qualified-context'};
    let selected=[...features];
    if(row.status!=='UNKNOWN')for(const feature of features){const trial=selected.filter(f=>f.id!==feature.id),result=evaluateEntry(trial,profile,cutoff,mode,social,false,entryComparison,entryGates,groups).checks.find(c=>c.checkId===row.checkId)!;if(result.status===row.status)selected=trial;}
    const featureIds=row.status==='UNKNOWN'?row.featureRefs:selected.map(f=>f.id);
    const socialIds=row.checkId.startsWith('SOC-')?social?.evidenceIds??[]:[];
    return {checkId:row.checkId,status:row.status as 'PASS'|'FAIL'|'UNKNOWN',featureIds,evidenceIds:[...new Set([...selected.filter(f=>featureIds.includes(f.id)).flatMap(f=>f.evidenceIds),...socialIds])],route:row.checkId.startsWith('SOC-')&&social?'qualified-social':row.checkId==='CAN-02'?'qualified-representation':'entry-policy'};
  });
}

export function sharedClaims(baseline:BaselineAssessment[],social?:SocialPolicyFacts):SharedClaim[]{
  const claims:SharedClaim[]=[];
  for(const a of baseline.filter(a=>['A01','A02','A03','A04','A05'].includes(a.id)&&a.quality==='KNOWN')){
    const data=a.data as {originBasis?:string;summary?:string;citations?:SharedClaim['citations']};
    if(data.summary&&data.citations)claims.push(sharedClaimSchema.parse({id:a.id,statement:data.originBasis==='PUBLIC_EVIDENCE_INADEQUATE'?`Reviewed public origin evidence is inadequate within the declared discovery sample: ${data.summary}. This is a traceability screening grade, not fraud or absence of origin everywhere.`:data.summary,citations:data.citations}));
  }
  for(const a of baseline.filter(a=>['A09','A14'].includes(a.id)&&a.quality==='KNOWN')){const d=a.data as {entryDecisionMethod?:string;entryCriterion?:string;decision?:{verdict:string;rationale:string;citations:SharedClaim['citations']}};if(['binary-public-support-v1','binary-public-support-v2','binary-public-support-v3','binary-public-support-v4'].includes(d.entryDecisionMethod??'')&&d.decision)claims.push(sharedClaimSchema.parse({id:a.id+':entry',statement:'Entry '+d.entryCriterion+' evidence standard '+d.decision.verdict+': '+d.decision.rationale+'. This is a bounded public-support judgment, not verified factual identity, origin, popularity or fraud.',citations:d.decision.citations}));}
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
  for(const [id,judgment] of [['SOC-01',social?.identityReview],['SOC-02',social?.integrityReview],['SOC-03',social?.participationReview],['ATT-02',social?.communityBreadthReview]] as const)if(judgment&&judgment.verdict!=='UNRESOLVED')claims.push(sharedClaimSchema.parse({id,statement:`${judgment.verdict}: ${judgment.rationale}. Social sample publication window: ${social!.start} inclusive to ${social!.end} exclusive; retrieval time does not make an older post current.`,citations:judgment.citations}));
  return claims;
}

export function deriveShared(input:SharedInputs){
  if(input.qualityMode==='ENTRY_GROUPS_V1'&&!input.groups)throw Error('SHARED_GROUPS_REQUIRED');
  const gates=input.qualityMode==='ENTRY_GATES_V1'||input.qualityMode==='ENTRY_GROUPS_V1';
  const witnesses=sharedWitnesses(input.features,input.profile,input.cutoff,input.social,gates?comparisonEntryGrade(input.baseline):undefined,gates?attentionEntryGates(input.baseline,!!input.groups):undefined,input.groups),unresolved=witnesses.filter(w=>w.status==='UNKNOWN').map(w=>w.checkId);
  const selected=new Set(witnesses.filter(w=>w.status!=='UNKNOWN'&&w.route!=='qualified-context').flatMap(w=>w.featureIds));
  const freshness=[...selected].map(id=>{
    const f=input.features.find(f=>f.id===id)!,a=input.baseline.find(a=>a.id===id),data=a?.data as {window?:{end?:string};end?:string}|undefined;
    const ttlSeconds=['O10','O11','O13','O14','O15','O16',...(input.groups?['O12']:[])].includes(id)?30:/^[AS]/.test(id)?900:300;
    const refs=f.evidenceIds.map(id=>input.evidence.find(e=>e.id===id));
    const eventAt=data?.window?.end??data?.end??f.availableAt;
    const times=[eventAt,...refs.flatMap(e=>e?[e.retrievedAt,e.availableAt]:[])];
    const fresh=refs.length>0&&refs.every(e=>!!e)&&times.every(time=>{const age=Date.parse(input.cutoff)-Date.parse(time);return Number.isFinite(age)&&age>=0&&age<=ttlSeconds*1000;});
    return {featureId:id,ttlSeconds,eventAt,fresh,evidenceIds:f.evidenceIds};
  });
  // Social witnesses may be decided from qualified judgments rather than legacy scalar projections.
  for(const w of witnesses.filter(w=>w.route==='qualified-social'&&w.status!=='UNKNOWN')){
    const social=input.social!,refs=w.evidenceIds.map(id=>input.evidence.find(e=>e.id===id));
    const fresh=refs.length>0&&refs.every(e=>!!e&&[e.retrievedAt,e.availableAt].every(t=>Date.parse(t)<=Date.parse(input.cutoff)&&Date.parse(input.cutoff)-Date.parse(t)<=900000))&&Date.parse(input.cutoff)-Date.parse(social.end)>=0&&Date.parse(input.cutoff)-Date.parse(social.end)<=900000;
    freshness.push({featureId:w.checkId,ttlSeconds:900,eventAt:social.end,fresh,evidenceIds:w.evidenceIds});
  }
  for(const group of input.groups?.groups.filter(g=>g.status!=='UNKNOWN')??[]){
    const ttlSeconds=['ADV-03','ADV-04'].includes(group.checkId)?900:300,refs=group.evidenceIds.map(id=>input.evidence.find(e=>e.id===id));
    const fresh=refs.length>0&&[group.availableAt,...refs.flatMap(e=>e?[e.availableAt,e.retrievedAt]:[''])].every(t=>Number.isFinite(Date.parse(t))&&Date.parse(t)<=Date.parse(input.cutoff)&&Date.parse(input.cutoff)-Date.parse(t)<=ttlSeconds*1000);
    freshness.push({featureId:group.checkId,ttlSeconds,eventAt:group.availableAt,fresh,evidenceIds:group.evidenceIds});
  }
  const sourceMap=new Map(input.sources.map(s=>[s.id,s]));
  const literal=(c:{sourceId:string;quote:string})=>sourceMap.get(c.sourceId)?.text.includes(c.quote)===true;
  const semanticFeatures=witnesses.filter(w=>w.status!=='UNKNOWN').flatMap(w=>w.featureIds).filter(id=>/^A/.test(id));
  const semanticQualified=unresolved.filter(id=>/^(NAR|CAN|ATT|SOC)-/.test(id)).length===0&&input.claims.length>0&&input.claims.every(c=>c.citations.every(literal))&&JSON.stringify(input.claims)===JSON.stringify(sharedClaims(input.baseline,input.social))&&JSON.stringify(input.semanticReceiptIds)===JSON.stringify(['attention-qualified-receipt','social-qualified-receipt'])&&input.semanticReceiptIds.every(id=>input.evidence.some(e=>e.id===id&&e.accessMode==='LOCAL_DERIVED'))&&semanticFeatures.every(id=>input.baseline.find(a=>a.id===id)?.quality==='KNOWN');
  const audit=input.audit&&sharedAuditSchema.safeParse(input.audit);
  const ids=input.claims.map(c=>c.id),unique=(xs:string[])=>new Set(xs).size===xs.length;
  const auditQualified=semanticQualified&&!!audit?.success&&unique(ids)&&unique(audit.data.claims.map(c=>c.id))&&audit.data.claims.length===ids.length&&audit.data.claims.every(c=>ids.includes(c.id)&&c.disposition!=='UNCLEAR'&&c.citations.every(literal)&&hasTwoConflictSides(c))&&unique(audit.data.review.map(c=>c.id))&&audit.data.review.length===ids.length&&audit.data.review.every(c=>ids.includes(c.id)&&c.accepted)&&unique(audit.data.sources.map(s=>s.id))&&audit.data.sources.length===input.sources.length&&audit.data.sources.every(s=>sourceMap.has(s.id)&&s.complete);
  const conflicts:Array<{field:string;evidenceIds:string[];rationale:string}>=[];
  const groups=new Map<string,Observation[]>();
  for(const o of input.observations.filter(o=>o.quality==='KNOWN')){const key=`${o.subject.chain}:${o.subject.address}:${o.field}:${o.unit}:${o.observedAt}`;groups.set(key,[...(groups.get(key)??[]),o]);}
  const normalized=(v:Observation['value'])=>typeof v==='string'&&/^-?\d+(\.\d+)?$/.test(v)?new Decimal(v).toFixed():JSON.stringify(v);
  for(const [field,values] of groups)if(new Set(values.map(v=>normalized(v.value))).size>1)conflicts.push({field,evidenceIds:[...new Set(values.flatMap(v=>v.evidenceIds))],rationale:'Different values for the same subject, field, unit and observation instant.'});
  if(auditQualified&&audit?.success)for(const c of audit.data.claims.filter(c=>c.disposition==='CONFLICT'))conflicts.push({field:c.id,evidenceIds:[...new Set(c.citations.map(c=>c.sourceId))],rationale:c.rationale});
  const complete=unresolved.length===0,fresh=freshness.length>0&&freshness.every(f=>f.fresh);
  const values=gates?{C03:complete&&fresh,C04:complete,C05:semanticQualified,C06:complete&&auditQualified&&conflicts.length===0}:{C03:complete&&fresh?true:null,C04:complete?true:null,C05:semanticQualified?true:null,C06:complete&&auditQualified?conflicts.length===0:null};
  const facts=sharedPolicyFactsSchema.parse({method:'shared-evidence-v1',...(gates?{qualityMode:input.qualityMode}:{}),token:input.token,cutoff:input.cutoff,witnesses,freshness,unresolved,semanticQualified,auditQualified,conflicts,values});
  const evidenceIds=[...new Set([...witnesses.flatMap(w=>w.evidenceIds),...input.semanticReceiptIds,...input.evidence.filter(e=>e.id==='shared-qualified-receipt'||/^shared-(proposal|review)-response$/.test(e.id)).map(e=>e.id)])];
  const auditCode=input.evidence.find(e=>e.id==='shared-audit-status')?.scope.code;
  const assessments:BaselineAssessment[]=Object.entries(values).map(([id,value])=>({id,version:'baseline-v1',evaluator:'IMPLEMENTED',collector:'IMPLEMENTED',quality:value===null?'MISSING':'KNOWN',unit:'bool',data:{method:'shared-evidence-v1',...(gates?{qualityMode:input.qualityMode,meaning:'Entry data-quality standard; a failed or incomplete review is not a false token fact or detected conflict.',...(id==='C06'?{conflictAssessment:auditQualified?'COMPLETED':'INCOMPLETE_REVIEW'}:{})}:{}),unresolved,...(id==='C03'?{freshness}:{}),...(id==='C06'?{conflicts}:{})},observationIds:[],evidenceIds,limitations:['Required decision scope; no guarantee of real-world token truth or exhaustive coverage'],causes:value===null||gates&&value===false?[{category:'EVIDENCE_UNAVAILABLE',code:gates&&id==='C06'&&conflicts.length?'SHARED_CONFLICT_DETECTED':unresolved.length?'SHARED_REQUIRED_SCOPE_INCOMPLETE':id==='C03'?'SHARED_EVIDENCE_STALE':id==='C05'?'SHARED_SEMANTIC_UNQUALIFIED':(typeof auditCode==='string'&&auditCode!=='SHARED_AUDIT_RECEIVED'?auditCode:'SHARED_CONFLICT_AUDIT_INCOMPLETE'),featureId:id,evidenceIds,action:'Refresh the named required decision scope and its source qualification.'}]:[],projection:{id,value,unit:'bool',quality:value===null?'MISSING':'KNOWN',availableAt:input.cutoff,evidenceIds,applicability:'APPLICABLE'}}));
  return {facts,assessments};
}

/** Only the sufficient policy witnesses expire; unused alternatives keep their original state. */
export function expireSharedWitnesses(input:SharedInputs):SharedInputs{
  const expired=new Set(deriveShared(input).facts.freshness.filter(f=>!f.fresh).map(f=>f.featureId));
  return {...input,features:input.features.map(f=>expired.has(f.id)?{...f,quality:'STALE' as const}:f),baseline:input.baseline.map(a=>expired.has(a.id)&&a.projection?{...a,quality:'STALE' as const,projection:{...a.projection,quality:'STALE' as const},causes:[...a.causes,{category:'EVIDENCE_UNAVAILABLE' as const,code:'FEATURE_TTL_EXCEEDED',featureId:a.id,evidenceIds:a.evidenceIds,action:'Refresh the required witness; review time does not refresh its source or event window.'}]}:a)};
}
