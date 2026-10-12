import { deriveAuthorityTopology, type TopologyReceipts } from '../providers/advisory-topology.js';
import { deriveO30Window, type AutomationReceipts } from '../providers/advisory-automation.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { BaselineAssessment } from '../domain/baseline.js';
import { thesisSchema, type Thesis, type FeatureResult } from '../domain/contracts.js';
import type { TokenRef,EvidenceRecord } from '../domain/contracts.js';
import { deriveAdvisory } from '../domain/advisory.js';
import { decodeAdvisoryWalletHistory,deriveWalletHistoryMetrics } from '../providers/advisory-wallet-history.js';
import { decodeAdvisoryWindow,deriveO28Window } from '../providers/advisory-window.js';
import { decodeAdvisoryWindowAccounts,deriveO26Window } from '../providers/advisory-window-accounts.js';
import { decodeAdvisoryDemandWindows,deriveA30DemandWindows,DEMAND_REQUEST_CAP,DEMAND_ARCHIVE_ADAPTER } from '../providers/advisory-demand-windows.js';
import { deriveAdvisoryDemand } from '../domain/advisory-demand.js';
import { decodeAdvisoryChain } from '../providers/advisory-chain.js';
import { decodeAdvisoryMarket } from '../providers/advisory-market.js';
import { decodeAdvisorySocial,deriveSocialAdvisory } from '../providers/advisory-social.js';
import { decodeAdvisoryTrades,deriveAdvisoryTrades } from '../providers/advisory-trades.js';
import { decodeAdvisoryContextHistory } from '../providers/advisory-context-history.js';
import { validateAdvisorySemanticWire,deriveAdvisorySemantic,advisorySemanticRequests,type AdvisorySemanticWire } from '../providers/advisory-semantic.js';
import { socialInputSchema,socialProposalSchema,socialReviewSchema } from '../domain/social.js';
import { replayCallerHistory,supersedingCallerMetrics } from '../providers/advisory-caller-measures.js';
import { CALLER_REQUEST_CAP } from '../providers/advisory-caller-history.js';
import { deriveO23Synchrony } from '../providers/advisory-synchrony.js';
import { deriveO29ReservePath } from '../providers/advisory-reserve-path.js';
import { deriveShortDemandReport,type ShortDemandReport } from '../providers/advisory-short-demand.js';
import { decodeCreatorRole,creatorRoleS13,CREATOR_RECEIPT_CAP } from '../providers/advisory-creator-role-collector.js';

const descriptor=z.object({requests:z.record(z.string(),z.unknown()),artifactIds:z.record(z.string(),z.string())}).strict();
export const advisoryProofSchema=z.object({
  method:z.enum(['advisory-provenance-v2','advisory-provenance-v3','advisory-provenance-v4','advisory-provenance-v5','advisory-provenance-v6','advisory-provenance-v7','advisory-provenance-v8','advisory-provenance-v9','advisory-provenance-v10','advisory-provenance-v11','advisory-provenance-v12','advisory-provenance-v13','advisory-provenance-v14','advisory-provenance-v15','advisory-provenance-v16']),token:z.object({chain:z.literal('solana'),address:z.string()}).strict(),cutoff:z.iso.datetime({offset:true}),
  pool:z.string().nullable(),addresses:z.array(z.string()).min(1).max(3),chain:descriptor,market:descriptor,paid:descriptor,trades:descriptor,context:descriptor,semantic:descriptor.nullable(),wallets:descriptor.optional(),
  socialDerivationId:z.literal('social-derivation').nullable(),thesisContextId:z.literal('advisory-thesis-context'),
  window:descriptor.extend({end:z.iso.datetime({offset:true})}).strict().optional(),
  accounts:descriptor.optional(),automation:descriptor.optional(),topology:descriptor.optional(),demand:descriptor.optional(),
  callers:descriptor.extend({selectionId:z.literal('advisory-callers-selection')}).strict().nullable().optional(),callerSemantic:descriptor.nullable().optional(),
  creatorRole:descriptor.nullable().optional(),
}).strict();
export type AdvisoryProof=z.infer<typeof advisoryProofSchema>;
export const advisoryHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Reconstruct measurements from retained responses, never from a claimed normalized cache. */
export function reconstructAdvisory(token:TokenRef,cutoff:string,baseline:BaselineAssessment[],evidence:EvidenceRecord[],rawArtifacts:Record<string,string>,input:unknown,thesis:Thesis|null=null,features:FeatureResult[]=[]){
  const proof=advisoryProofSchema.parse(input);
  if(token.chain!==proof.token.chain||token.address!==proof.token.address||cutoff!==proof.cutoff||JSON.stringify(proof.addresses)!==JSON.stringify([token.address,...(proof.pool?[proof.pool]:[])]))throw new Error('ADVISORY_PROOF_INVALID');
  // Descriptors and decoders join at their proof version; v13 is v12 plus O23 over the same window and demand receipts; v14 is v13 plus O29 from one demand decode that retains per-event virtual quote reserves; v16 is v15 plus the supplementary one-hour report from that same decode, kept outside metrics and groups.
  const version=Number(proof.method.slice('advisory-provenance-v'.length));
  if((proof.method!=='advisory-provenance-v2')!==!!proof.wallets||!proof.wallets&&evidence.some(e=>e.sourceId==='advisory-wallets')||(version>=4)!==!!proof.window||!proof.window&&evidence.some(e=>e.sourceId==='advisory-window'))throw new Error('ADVISORY_PROOF_INVALID');
  if((version>=7)!==!!proof.accounts||!proof.accounts&&evidence.some(e=>e.sourceId==='advisory-accounts'))throw new Error('ADVISORY_PROOF_INVALID');
  if((version>=8)!==!!proof.automation||!proof.automation&&evidence.some(e=>e.sourceId==='advisory-automation'))throw new Error('ADVISORY_PROOF_INVALID');
  if((version>=9)!==!!proof.topology||!proof.topology&&evidence.some(e=>e.sourceId==='advisory-topology'))throw new Error('ADVISORY_PROOF_INVALID');
  if((version>=10)!==!!proof.demand||!proof.demand&&evidence.some(e=>e.sourceId==='advisory-demand'))throw new Error('ADVISORY_PROOF_INVALID');
  // Both caller keys exist from v11 (null when not collected); caller receipts, selection or classification without their descriptor are rejected.
  const callerVersion=version>=11;
  // Proofs v12 and later accept only the v3 origin rubric; older proofs replay only frozen v2 packets, so categories never cross versions.
  const semanticWire:AdvisorySemanticWire=version>=12?'v3':'v2';
  if(callerVersion!==(proof.callers!==undefined)||callerVersion!==(proof.callerSemantic!==undefined)||!proof.callers&&(!!proof.callerSemantic||evidence.some(e=>e.sourceId==='advisory-callers'||e.id==='advisory-callers-selection'))||!proof.callerSemantic&&evidence.some(e=>e.id.startsWith('advisory-callerSemantic-')))throw new Error('ADVISORY_PROOF_INVALID');
  // Proof v15 carries an explicit creatorRole key (null when not collected); earlier proofs may carry only null and never derive the role, and creator receipts without a descriptor are orphans.
  if((version>=15?proof.creatorRole===undefined:!!proof.creatorRole)||!proof.creatorRole&&evidence.some(e=>e.sourceId==='advisory-creator-role'||e.id.startsWith('advisory-creatorRole-')))throw new Error('ADVISORY_PROOF_INVALID');
  const resolve=(namespace:'chain'|'market'|'paid'|'trades'|'context'|'semantic'|'wallets'|'window'|'accounts'|'automation'|'topology'|'demand'|'callers'|'callerSemantic'|'creatorRole')=>{
    const d=proof[namespace]! ,raw:Record<string,string>={},times:Record<string,string>={};
    const keys=Object.keys(d.requests);
    // Trader-account receipts are absent when the selected window is incomplete.
    if((keys.length===0&&namespace!=='trades'&&namespace!=='accounts'&&namespace!=='automation'&&namespace!=='topology'&&namespace!=='demand')||keys.length>(namespace==='demand'?DEMAND_REQUEST_CAP:namespace==='callers'?CALLER_REQUEST_CAP:namespace==='creatorRole'?CREATOR_RECEIPT_CAP:64)||JSON.stringify(keys.sort())!==JSON.stringify(Object.keys(d.artifactIds).sort()))throw new Error('ADVISORY_PROOF_INVALID');
    for(const [key,id] of Object.entries(d.artifactIds)){
      const record=evidence.find(e=>e.id===id);
      const model=namespace==='semantic'||namespace==='callerSemantic',hosted=model&&(key.includes('prompt')||key.includes('response'));
      const source=model?(hosted?'gemini':'advisory-collector'):namespace==='creatorRole'?'advisory-creator-role':`advisory-${namespace}`;
      const access=model?(hosted?'FREE_ACCOUNT':'LOCAL_DERIVED'):'PUBLIC_API';
      // Current demand receipts bind the known archive adapter, a sole exact request scope, the stored archive hash and a unique id; the archive's own source hash is checked on unpack. Older namespaces keep their recorded checks.
      if(namespace==='demand'&&(!record||evidence.filter(e=>e.id===id).length!==1||record.adapterVersion!==DEMAND_ARCHIVE_ADAPTER||!record.scope||JSON.stringify(Object.keys(record.scope))!=='["request"]'||JSON.stringify(record.scope.request)!==JSON.stringify(d.requests[key])||typeof rawArtifacts[id]!=='string'||record.contentHash!==createHash('sha256').update(rawArtifacts[id]!).digest('hex')))throw new Error('ADVISORY_PROOF_INVALID');
      // Caller receipts and caller classification bind the live adapter, a sole exact request scope, the stored content hash and a unique id.
      if((namespace==='callers'||namespace==='callerSemantic'||namespace==='creatorRole')&&(!record||evidence.filter(e=>e.id===id).length!==1||record.adapterVersion!=='live-v1'||!record.scope||Object.keys(record.scope).join()!=='request'||typeof rawArtifacts[id]!=='string'||record.contentHash!==createHash('sha256').update(rawArtifacts[id]!).digest('hex')))throw new Error('ADVISORY_PROOF_INVALID');
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
  const chainData=decodeAdvisoryChain(token,proof.addresses,chain.raw,chain.times,chain.requests as Record<string,{method:string;params:unknown[]}>,proof.method!=='advisory-provenance-v2');
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
      try{qualified=validateAdvisorySemanticWire(read,semantic.raw,token,semanticWire);}catch{/* Invalid or failed classification cannot supply a measured metric. */}
      additionalMetrics=[...additionalMetrics,...deriveAdvisorySemantic(read,proposal,review,token,cutoff,[...packet.evidenceIds,...semantic.ids,...paid.ids],qualified,paidData)];
    }
  }else{
    if(semantic)throw new Error('ADVISORY_PROOF_INVALID');
    // An absent social corpus cannot certify a complete paid-post inventory.
    socialMetrics=[{id:'A22',quality:paidData.quality==='INVALID'?'INVALID':'MISSING',unit:'scoped-record',data:{dex:paidData,disclosedPosts:null,disclosureCoverage:'NOT_COLLECTED'},evidenceIds:paid.ids,reasonCode:'PAID_POST_DISCLOSURE_REVIEW_MISSING'}];
  }
  // Historical caller measures only fill metrics the current 24h corpus left unmeasured.
  if(proof.callers){const c=resolve('callers'),s=proof.callerSemantic?resolve('callerSemantic'):null;additionalMetrics.push(...supersedingCallerMetrics([...socialMetrics,...additionalMetrics],replayCallerHistory(token,cutoff,evidence,rawArtifacts,c,proof.callers.selectionId,s,semanticWire)));}
  if(proof.wallets){const w=resolve('wallets'),history=decodeAdvisoryWalletHistory(token,tradeData,{rawArtifacts:w.raw,retrievedAt:w.times,requests:w.requests as Record<string,{method:string;params:unknown[]}>},cutoff);additionalMetrics.push(...deriveWalletHistoryMetrics(history,tradeData,chainData,chain.raw,[...chain.ids,...trades.ids,...w.ids]));}
  // Proof v15 appends the exact public creator-role decode to S13 after the co-signing edges; failures keep the prior S13 quality and disclose every candidate.
  if(version>=15&&proof.creatorRole){const c=resolve('creatorRole'),prior=[...additionalMetrics].reverse().find(m=>m.id==='S13');additionalMetrics.push(creatorRoleS13(prior,decodeCreatorRole(token,{rawArtifacts:c.raw,retrievedAt:c.times,requests:c.requests},cutoff),c.ids));}
  additionalMetrics.push(...deriveAdvisoryDemand(tradeData,socialMetrics.find(m=>m.id==='A19'),cutoff,[...chain.ids,...trades.ids]));
  let shortDemand:ShortDemandReport|undefined;
  if(proof.window){
    const w=resolve('window'),windowRequests=w.requests as Record<string,{method:string;params:unknown[]}>;
    const windowData=decodeAdvisoryWindow(token,proof.pool,proof.window.end,w.raw,w.times,windowRequests,cutoff,version>=5,version>=6);
    additionalMetrics.push(deriveO28Window(windowData,w.ids));
    // Appended after the bounded-sample O26 so complete account coverage supersedes it; an incomplete window keeps the older value.
    if(proof.accounts){const a=resolve('accounts'),history=decodeAdvisoryWindowAccounts(token,windowData,{rawArtifacts:w.raw,retrievedAt:w.times,requests:windowRequests},a.raw,a.times,a.requests as Record<string,{method:string;params:unknown[]}>,cutoff),metric=deriveO26Window(history,windowData,[...w.ids,...a.ids]);if(metric)additionalMetrics.push(metric);}
    if(proof.automation){const a=resolve('automation'),receipts:AutomationReceipts={rawArtifacts:a.raw,retrievedAt:a.times,requests:a.requests};additionalMetrics.push(deriveO30Window(token,windowData,{rawArtifacts:w.raw,retrievedAt:w.times,requests:windowRequests},receipts,cutoff,[...w.ids,...a.ids]));}
    // Appended after the sampled A30 so a complete-tape result supersedes it; an ineligible O28 hour keeps the older value.
    if(proof.demand){const d=resolve('demand'),history=decodeAdvisoryDemandWindows(token,windowData,{rawArtifacts:w.raw,retrievedAt:w.times,requests:windowRequests},d.raw,d.times,d.requests as Record<string,{method:string;params:unknown[]}>,cutoff,version>=14),metric=deriveA30DemandWindows(history,[...w.ids,...d.ids]);if(metric)additionalMetrics.push(metric);
      // Proof v13 adds O23 from the same window and demand receipts; earlier proofs never derive it retrospectively.
      if(version>=13){const o23=deriveO23Synchrony(token,windowData,{rawArtifacts:w.raw,retrievedAt:w.times,requests:windowRequests},d.raw,d.times,d.requests as Record<string,{method:string;params:unknown[]}>,cutoff,[...w.ids,...d.ids]);if(o23)additionalMetrics.push(o23);}
      // Proof v14 adds O29 from that same retained-V history; A30 serializes no trades and O23 keeps its own default decode.
      if(version>=14){const o29=deriveO29ReservePath(history,[...w.ids,...d.ids]);if(o29)additionalMetrics.push(o29);}
      // Proof v16 adds the supplementary one-hour report from this same raw-receipt decode; an ineligible hour still yields an explicit NOT_ELIGIBLE report and earlier proofs never derive it.
      if(version>=16)shortDemand=deriveShortDemandReport(history,[...w.ids,...d.ids]);}
  }
  if(proof.topology){const t=resolve('topology'),receipts:TopologyReceipts={rawArtifacts:t.raw,retrievedAt:t.times,requests:t.requests};additionalMetrics.push(deriveAuthorityTopology(token,cutoff,evidence,rawArtifacts,receipts));}
  let supplements:{shortDemand:ShortDemandReport}|undefined;
  if(version>=16){if(!shortDemand)throw new Error('ADVISORY_PROOF_INVALID');supplements={shortDemand};}
  return deriveAdvisory({token,cutoff,baseline,evidence,chain:chainData,market:marketData,socialMetrics,chainIds:chain.ids,marketIds:market.ids,paidIds:paid.ids,additionalMetrics,contextHistory:contextData,contextIds:context.ids,thesis,features,thesisEvidenceId:thesisRecord.id,method:version>=16?'advisory-measurements-v17':version>=15?'advisory-measurements-v16':version>=14?'advisory-measurements-v15':version>=13?'advisory-measurements-v14':'advisory-measurements-v13',supplements});
}
