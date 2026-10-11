import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { BaselineAssessment } from '../domain/baseline.js';
import { thesisSchema, type Thesis, type FeatureResult } from '../domain/contracts.js';
import type { TokenRef,EvidenceRecord } from '../domain/contracts.js';
import { deriveAdvisory } from '../domain/advisory.js';
import { deriveAdvisoryDemand } from '../domain/advisory-demand.js';
import { decodeAdvisoryChain } from '../providers/advisory-chain.js';
import { decodeAdvisoryMarket } from '../providers/advisory-market.js';
import { decodeAdvisorySocial,deriveSocialAdvisory } from '../providers/advisory-social.js';
import { decodeAdvisoryTrades,deriveAdvisoryTrades } from '../providers/advisory-trades.js';
import { decodeAdvisoryContextHistory } from '../providers/advisory-context-history.js';
import { validateAdvisorySemanticWire,deriveAdvisorySemantic,advisorySemanticRequests } from '../providers/advisory-semantic.js';
import { socialInputSchema,socialProposalSchema,socialReviewSchema } from '../domain/social.js';

const descriptor=z.object({requests:z.record(z.string(),z.unknown()),artifactIds:z.record(z.string(),z.string())}).strict();
export const advisoryProofSchema=z.object({
  method:z.literal('advisory-provenance-v2'),token:z.object({chain:z.literal('solana'),address:z.string()}).strict(),cutoff:z.iso.datetime({offset:true}),
  pool:z.string().nullable(),addresses:z.array(z.string()).min(1).max(3),chain:descriptor,market:descriptor,paid:descriptor,trades:descriptor,context:descriptor,semantic:descriptor.nullable(),
  socialDerivationId:z.literal('social-derivation').nullable(),thesisContextId:z.literal('advisory-thesis-context'),
}).strict();
export type AdvisoryProof=z.infer<typeof advisoryProofSchema>;
export const advisoryHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Reconstruct measurements from retained responses, never from a claimed normalized cache. */
export function reconstructAdvisory(token:TokenRef,cutoff:string,baseline:BaselineAssessment[],evidence:EvidenceRecord[],rawArtifacts:Record<string,string>,input:unknown,thesis:Thesis|null=null,features:FeatureResult[]=[]){
  const proof=advisoryProofSchema.parse(input);
  if(token.chain!==proof.token.chain||token.address!==proof.token.address||cutoff!==proof.cutoff||JSON.stringify(proof.addresses)!==JSON.stringify([token.address,...(proof.pool?[proof.pool]:[])]))throw new Error('ADVISORY_PROOF_INVALID');
  const resolve=(namespace:'chain'|'market'|'paid'|'trades'|'context'|'semantic')=>{
    const d=proof[namespace]! ,raw:Record<string,string>={},times:Record<string,string>={};
    const keys=Object.keys(d.requests);
    if((keys.length===0&&namespace!=='trades')||keys.length>64||JSON.stringify(keys.sort())!==JSON.stringify(Object.keys(d.artifactIds).sort()))throw new Error('ADVISORY_PROOF_INVALID');
    for(const [key,id] of Object.entries(d.artifactIds)){
      const record=evidence.find(e=>e.id===id);
      const model=namespace==='semantic',hosted=model&&(key.includes('prompt')||key.includes('response'));
      const source=model?(hosted?'gemini':'advisory-collector'):`advisory-${namespace}`;
      const access=model?(hosted?'FREE_ACCOUNT':'LOCAL_DERIVED'):'PUBLIC_API';
      if(id!==`advisory-${namespace}-${key}`||!record||record.sourceId!==source||record.accessMode!==access||record.sourceType!=='HISTORICAL_RECEIPT'||record.availableAt!==record.retrievedAt||Date.parse(record.availableAt)>Date.parse(cutoff)||advisoryHash(record.scope.request)!==advisoryHash(d.requests[key])||typeof rawArtifacts[id]!=='string')throw new Error('ADVISORY_PROOF_INVALID');
      if(model&&advisoryHash(d.requests[key])!==advisoryHash({operation:key,modelRequests:advisorySemanticRequests()}))throw new Error('ADVISORY_PROOF_INVALID');
      raw[key]=rawArtifacts[id]!;times[key]=record.retrievedAt;
    }
    return {raw,times,requests:d.requests,ids:Object.values(d.artifactIds)};
  };
  const thesisRecord=evidence.find(e=>e.id===proof.thesisContextId&&e.sourceId==='local-config'&&e.accessMode==='LOCAL_DERIVED'&&e.sourceType==='CONFIG'&&e.availableAt===cutoff);
  if(!thesisRecord)throw new Error('ADVISORY_PROOF_INVALID');
  const thesisContext=z.object({method:z.literal('frozen-advisory-thesis-v1'),token:z.object({chain:z.literal('solana'),address:z.string()}).strict(),cutoff:z.string(),thesis:thesisSchema.nullable()}).strict().parse(JSON.parse(rawArtifacts[thesisRecord.id]!));
  if(advisoryHash(thesisContext.token)!==advisoryHash(token)||thesisContext.cutoff!==cutoff||advisoryHash(thesisContext.thesis)!==advisoryHash(thesis))throw new Error('ADVISORY_PROOF_INVALID');
  const chain=resolve('chain'),market=resolve('market'),paid=resolve('paid'),trades=resolve('trades'),context=resolve('context'),semantic=proof.semantic?resolve('semantic'):null;
  // The market adapter gives its whole batch one availability boundary after all reads complete.
  const marketTimes=[...new Set(Object.values(market.times))];
  if(marketTimes.length!==1)throw new Error('ADVISORY_PROOF_INVALID');
  const chainData=decodeAdvisoryChain(token,proof.addresses,chain.raw,chain.times,chain.requests as Record<string,{method:string;params:unknown[]}>);
  const marketData=decodeAdvisoryMarket(token,proof.pool,market.raw,marketTimes[0]!,market.requests as Record<string,{url:string}>);
  const paidData=decodeAdvisorySocial(token,paid.raw,paid.times,paid.requests as Record<string,{url:string}>);
  const contextTimes=[...new Set(Object.values(context.times))];if(contextTimes.length!==1)throw new Error('ADVISORY_PROOF_INVALID');
  const contextData=decodeAdvisoryContextHistory(token,context.raw,contextTimes[0]!,context.requests as Record<string,{url:string}>);
  const tradeData=decodeAdvisoryTrades(token,proof.pool,chainData,chain.raw,chain.times,chain.requests as Record<string,{method:string;params:unknown[]}>,trades.raw,trades.times,trades.requests as Record<string,{method:string;params:unknown[]}>);
  let additionalMetrics=deriveAdvisoryTrades(tradeData,cutoff,[...chain.ids,...trades.ids]);
  let socialMetrics:ReturnType<typeof deriveSocialAdvisory>=[];
  if(proof.socialDerivationId){
    const record=evidence.find(e=>e.id===proof.socialDerivationId&&e.sourceId==='social-collector'&&e.accessMode==='LOCAL_DERIVED');
    if(!record||record.availableAt!==cutoff)throw new Error('ADVISORY_PROOF_INVALID');
    const packet=JSON.parse(rawArtifacts[record.id]!);
    if(packet.token.chain!==token.chain||packet.token.address!==token.address||packet.cutoff!==cutoff)throw new Error('ADVISORY_PROOF_INVALID');
    const read=socialInputSchema.parse(packet.read),proposal=packet.proposal===null?null:socialProposalSchema.parse(packet.proposal),review=packet.review===null?null:socialReviewSchema.parse(packet.review);
    socialMetrics=deriveSocialAdvisory(read,proposal,review,token,cutoff,packet.evidenceIds,paidData);
    if(semantic){
      let qualified:ReturnType<typeof validateAdvisorySemanticWire>|null=null;
      try{qualified=validateAdvisorySemanticWire(read,semantic.raw,token);}catch{/* Invalid or failed classification cannot supply a measured metric. */}
      additionalMetrics=[...additionalMetrics,...deriveAdvisorySemantic(read,proposal,review,token,cutoff,[...packet.evidenceIds,...semantic.ids,...paid.ids],qualified,paidData)];
    }
  }else{
    if(semantic)throw new Error('ADVISORY_PROOF_INVALID');
    // An absent social corpus cannot certify a complete paid-post inventory.
    socialMetrics=[{id:'A22',quality:paidData.quality==='INVALID'?'INVALID':'MISSING',unit:'scoped-record',data:{dex:paidData,disclosedPosts:null,disclosureCoverage:'NOT_COLLECTED'},evidenceIds:paid.ids,reasonCode:'PAID_POST_DISCLOSURE_REVIEW_MISSING'}];
  }
  additionalMetrics.push(...deriveAdvisoryDemand(tradeData,socialMetrics.find(m=>m.id==='A19'),cutoff,[...chain.ids,...trades.ids]));
  return deriveAdvisory({token,cutoff,baseline,evidence,chain:chainData,market:marketData,socialMetrics,chainIds:chain.ids,marketIds:market.ids,paidIds:paid.ids,additionalMetrics,contextHistory:contextData,contextIds:context.ids,thesis,features,thesisEvidenceId:thesisRecord.id});
}
