import { validatePumpRecoveryBundle } from '../providers/pumpswap.js';
import { verifyOriginAlias, verifiedOriginExclusion } from '../providers/origin-recovery.js';
import { createHash, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { entryGroupsForBundle } from '../providers/entry-groups.js';
import { VersionedMessage } from '@solana/web3.js';
import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { bundleSchema, liveBundleSchema, positionEventSchema, positionRecordSchema, profileSchema, thesisSchema, type FeatureResult, type AssessmentDetails, type Bundle, type LiveBundle, type EntrySnapshot, type ManagementSnapshot, type PositionEvent, type PositionRecord, type Thesis, type ThesisEpisode, type TokenRef } from '../domain/contracts.js';
import { baselineIds, deriveBaseline, deriveHolderBounds, validateResearch } from '../domain/baseline.js';
import { evaluateEntry, evaluateManagement, evaluatePredicate, type StageInputs } from '../domain/policy.js';
import { reduceLedger } from '../domain/ledger.js';
import { deriveSocial, socialInputSchema, socialProposalSchema, socialReviewSchema, canonicalSocialUrl, type SocialInput } from '../domain/social.js';
import { deriveAttention,attentionProposalSchema,originSourceScope,normalizeComparisonRefs,comparisonScopeV2Schema } from '../domain/attention.js';
import { emptyAttentionQualification, comparisonRequiredRecoveryPlan, decodeComparisonLeadTasks, comparisonReferenceRepairDetails, decodeNarrativePublicSupport, decodeSubmittedAttention, comparisonTargetContext, comparisonInstruction, decodeComparisonLeadArray, decodeComparisonLeadAccounting, comparisonScopeV3Schema, comparisonLeadIsAccounted, comparisonAccountingComplete, comparisonAccountingContext, comparisonAccountingInstruction, comparisonAccountingReviewInstruction, comparisonAccountingReferenceRepairInstruction, comparisonAccountingArraySchema, comparisonLeadSupportInstruction, comparisonLeadSupportRepairEligible, comparisonLeadSupportRepairValid, leadershipEntryCriterion, decodeBinaryEntryDecisions, resolvePublicEntryDecision, binaryLeadershipReviewSchema, scopedLeadershipReviewSchema, decodeLeadershipSupport, leadershipSupportProposalSchema, leadershipSupportReviewSchema, decodeComparisonCoverage, comparisonSourceLineage, comparisonLeadIsQualified } from '../providers/attention-model.js';
import { attentionSourceText, normalizeAttentionSearchUrl, normalizeAttentionFetchUrl, terminalPostScope, type AttentionRead } from '../providers/attention.js';
import { geckoPoolBinding } from '../providers/origin-recovery.js';
import { validateSocialRepair,validateSocialWire } from '../providers/social-model.js';
import { parseSourceResponse,sourceSpans } from '../providers/source-model.js';
import { validateDammBundle } from '../providers/meteora-damm-v2.js';
import { validateCurveBundle } from '../providers/pumpcurve.js';
import { decodeHolderPopulation } from '../providers/solana.js';
import { decodeTokenMetadataUri } from '../providers/token-discovery.js';
import { decodeSharedAuditProof } from '../providers/shared-model.js';
import { deriveShared,expireSharedWitnesses,sharedClaims,comparisonEntryGrade,attentionEntryGates,type SharedInputs } from '../domain/shared.js';
import { dexArtifacts, dexFetchBody, dexPairsUrl, parseDexFetch, parseDexPairs, type DexRecoveryReceipt } from '../providers/dexscreener.js';

/** Fresh execution receipts separate discovery, semantic work and final state acquisition. */
function validateLiveExecution(b:LiveBundle){
 const attentionReceipt=b.rawArtifacts['attention-qualified-receipt']?JSON.parse(b.rawArtifacts['attention-qualified-receipt']):null;
 const gapMethod=attentionReceipt?.read?.comparisonRecovery?.accessGapMethod;
 const optionalPacket=(id:string)=>b.rawArtifacts[id]?JSON.parse(b.rawArtifacts[id]):undefined;
 const firstRecovery=optionalPacket('attention-entry-first-acquisition'),fallback=optionalPacket('attention-recovery-fallback-scope');
 const selectionMethods=[attentionReceipt?.read?.comparisonRecovery?.fallbackSelectionMethod,firstRecovery?.fallbackSelectionMethod,optionalPacket('attention-leadership-proposal-prompt')?.scope?.fallbackSelectionMethod,optionalPacket('attention-leadership-review-prompt')?.scope?.fallbackSelectionMethod];
 if(selectionMethods.some(method=>method!==undefined)||fallback?.method==='same-parent-alternates-v2'){
  if(selectionMethods.some(method=>method!==undefined&&method!=='observed-hosts-v1')||selectionMethods[0]!=='observed-hosts-v1'||selectionMethods[1]!=='observed-hosts-v1'||fallback?.method!=='same-parent-alternates-v2'||['attention-leadership-proposal-prompt','attention-leadership-review-prompt'].some(id=>b.rawArtifacts[id]&&optionalPacket(id)?.scope?.fallbackSelectionMethod!=='observed-hosts-v1'))throw Error('ATTENTION_HTTP_PROOF_INVALID');
 }
 const metadataPackets=[attentionReceipt?.read,optionalPacket('attention-acquisition-scope'),optionalPacket('attention-scope'),optionalPacket('social-attention-seed')?.read,optionalPacket('attention-proposal-prompt')?.scope,optionalPacket('attention-review-prompt')?.scope];
 if(metadataPackets.some(p=>p?.metadataLinkMethod!==undefined)){
  if(metadataPackets.some(p=>p&&p.metadataLinkMethod!=='onchain-metadata-v1')||!attentionReceipt?.read?.metadataLinks||!attentionReceipt.read.metadataUri||!metadataPackets[1]||!metadataPackets[2]||!metadataPackets[3])throw Error('ATTENTION_METADATA_METHOD_INVALID');
 }
 const positivePackets=[attentionReceipt?.read,optionalPacket('attention-acquisition-scope'),optionalPacket('attention-scope'),optionalPacket('attention-proposal-prompt')?.scope,optionalPacket('attention-review-prompt')?.scope,optionalPacket('social-attention-seed')?.read,optionalPacket('attention-leadership-proposal-prompt'),optionalPacket('attention-leadership-review-prompt')];
 if(positivePackets.some(p=>p?.leadershipPositiveMethod!==undefined)||attentionReceipt?.review?.entryDecisions?.method==='binary-public-support-v4'){
  if(positivePackets.some(p=>p&&p.leadershipPositiveMethod!=='source-bound-positive-v1')||positivePackets[0]?.leadershipPositiveMethod!=='source-bound-positive-v1'||positivePackets[1]?.leadershipPositiveMethod!=='source-bound-positive-v1'||positivePackets[5]?.leadershipPositiveMethod!=='source-bound-positive-v1'||attentionReceipt?.review?.entryDecisions&&attentionReceipt.review.entryDecisions.method!=='binary-public-support-v4')throw Error('ATTENTION_LEADERSHIP_METHOD_INVALID');
 }
 const collectionMethods=[attentionReceipt?.read?.collectionMethod,JSON.parse(b.rawArtifacts['attention-acquisition-scope']??'{}').collectionMethod,JSON.parse(b.rawArtifacts['attention-proposal-prompt']??'{}').scope?.collectionMethod,JSON.parse(b.rawArtifacts['attention-review-prompt']??'{}').scope?.collectionMethod,JSON.parse(b.rawArtifacts['social-attention-seed']??'{}').read?.collectionMethod];
 if(collectionMethods.some(method=>method!==undefined)){
  if(collectionMethods.some(method=>method!==undefined&&method!=='project-context-v2')||collectionMethods[0]!=='project-context-v2'||collectionMethods[1]!=='project-context-v2'||collectionMethods[4]!=='project-context-v2'||b.rawArtifacts['attention-proposal-prompt']&&collectionMethods[2]!=='project-context-v2'||b.rawArtifacts['attention-review-prompt']&&collectionMethods[3]!=='project-context-v2')throw Error('ATTENTION_COLLECTION_METHOD_INVALID');
 }
 if(gapMethod!==undefined){
  if(gapMethod!=='own-acquired-alternates-v1'||!Array.isArray(attentionReceipt.read.comparisonRecovery.recoveryQueries))throw Error('ATTENTION_HTTP_PROOF_INVALID');
  for(const id of ['attention-http-outcomes',...(attentionReceipt.read.comparisonRecovery.recoveryQueries.length?['attention-recovery-http-outcomes']:[]),...(b.rawArtifacts['attention-origin-http-outcomes']?['attention-origin-http-outcomes']:[])]){
   const e=b.evidence.find(e=>e.id===id&&e.sourceId==='attention-collector'&&e.sourceType==='SAMPLE_SCOPE'&&e.accessMode==='LOCAL_DERIVED'),packet=b.rawArtifacts[id]?JSON.parse(b.rawArtifacts[id]):null;
   if(!e||!packet||packet.method!=='fetch-http-outcomes-v1'||!Array.isArray(packet.outcomes)||new Set(packet.outcomes.map((r:any)=>r.artifactId)).size!==packet.outcomes.length||packet.outcomes.some((r:any)=>!r||typeof r.artifactId!=='string'||!(id==='attention-origin-http-outcomes'?/^attention-origin-role-\d+-(?:search|fetch)$/:/^attention-(?:search|fetch)-\d+(?:-retry-1)?$/).test(r.artifactId)||!Number.isInteger(r.status)||r.status<100||r.status>599))throw Error('ATTENTION_HTTP_PROOF_INVALID');
  }
 }
 const raw=b.rawArtifacts['live-run-scope'];
 const fresh=!!raw||b.evidence.some(e=>e.sourceId==='solana-rpc-preflight'||e.id==='social-attention-seed'||e.id==='attention-entry-first-acquisition');
 if(!fresh)return;
 const record=b.evidence.find(e=>e.id==='live-run-scope'&&e.sourceId==='shared-collector'&&e.accessMode==='LOCAL_DERIVED');
 if(!raw||!record)throw Error('LIVE_EXECUTION_PROOF_REQUIRED');
 const scope=JSON.parse(raw),names=['PREFLIGHT','ATTENTION','SOCIAL','SHARED','FINALIZE'],allocations={PREFLIGHT:12,ATTENTION:60,SOCIAL:18,SHARED:12,FINALIZE:48};
 if(scope.method!=='phase-isolated-live-v1'||tokenKey(scope.token)!==tokenKey(b.token)||scope.hardLimitMs!==840000||scope.semanticLimitMs!==600000||scope.operationLimit!==150||decisionHash(scope.allocations)!==decisionHash(allocations)||!Number.isFinite(scope.elapsedMs)||scope.elapsedMs<0||scope.elapsedMs>900000||!Number.isSafeInteger(scope.admittedRequests)||scope.admittedRequests<0||scope.admittedRequests>150||!Array.isArray(scope.stages)||scope.stages.length!==5||decisionHash(scope.stages.map((r:{phase:string})=>r.phase))!==decisionHash(names))throw Error('LIVE_EXECUTION_PROOF_INVALID');
 let ops=0;
 for(const row of scope.stages){
  if(!['COMPLETED','FAILED','CANCELLED','NOT_STARTED'].includes(row.status)||!Number.isSafeInteger(row.ops)||row.ops<0||!Array.isArray(row.evidenceIds)||row.evidenceIds.some((id:string)=>!b.evidence.some(e=>e.id===id)))throw Error('LIVE_EXECUTION_PROOF_INVALID');
  ops+=row.ops;
  if(row.startedAt===null){if(row.startMs!==null||row.ops||row.status!=='NOT_STARTED')throw Error('LIVE_EXECUTION_PROOF_INVALID');}
  else if(!Number.isFinite(Date.parse(row.startedAt))||!Number.isFinite(row.startMs)||row.startMs<0||row.startMs>scope.elapsedMs)throw Error('LIVE_EXECUTION_PROOF_INVALID');
  if(row.endedAt!==null&&(!Number.isFinite(Date.parse(row.endedAt))||!Number.isFinite(row.endMs)||row.endMs<(row.startMs??0)||row.endMs>scope.elapsedMs||row.startedAt!==null&&Date.parse(row.endedAt)<Date.parse(row.startedAt)))throw Error('LIVE_EXECUTION_PROOF_INVALID');
  if(row.status!=='NOT_STARTED'&&row.endedAt===null)throw Error('LIVE_EXECUTION_PROOF_INVALID');
  if(row.code!==undefined&&(typeof row.code!=='string'||!/^[-A-Z0-9_:]{1,180}$/.test(row.code)))throw Error('LIVE_EXECUTION_PROOF_INVALID');
  if(row.origin!==undefined&&!['PROVIDER','PHASE_DEADLINE','HARD_DEADLINE','OPERATION_LIMIT','CALLER','DEPENDENCY','UNSUPPORTED'].includes(row.origin))throw Error('LIVE_EXECUTION_PROOF_INVALID');
  const localCodes:Record<string,string>={PHASE_DEADLINE:'LIVE_PHASE_DEADLINE',HARD_DEADLINE:'LIVE_HARD_DEADLINE',OPERATION_LIMIT:'LIVE_OPERATION_LIMIT',CALLER:'LIVE_CALLER_CANCELLED',DEPENDENCY:'LIVE_DEPENDENCY_SKIPPED'};
  if(localCodes[row.origin]&&row.code!==localCodes[row.origin]||Object.entries(localCodes).some(([origin,code])=>row.code===code&&row.origin!==origin)||row.blockedBy!==undefined&&!names.includes(row.blockedBy))throw Error('LIVE_EXECUTION_PROOF_INVALID');
 }
 if(ops!==scope.admittedRequests)throw Error('LIVE_EXECUTION_PROOF_INVALID');
 const [preStage,attentionStage,socialStage,sharedStage,finalStage]=scope.stages;
 if(finalStage.startedAt===null||finalStage.endedAt===null||preStage.endedAt===null||finalStage.startMs<preStage.endMs||[attentionStage,socialStage,sharedStage].some(row=>row.startedAt!==null&&(row.startMs<preStage.endMs||row.endedAt===null||row.endMs>finalStage.startMs))||socialStage.startedAt!==null&&(attentionStage.startedAt===null||socialStage.startMs<attentionStage.startMs)||sharedStage.startedAt!==null&&[attentionStage,socialStage].some(row=>row.startedAt===null||row.endMs>sharedStage.startMs))throw Error('LIVE_EXECUTION_PROOF_INVALID');
 const pre=scope.stages[0],final=scope.stages[4],capture=JSON.parse(b.rawArtifacts['live-state-capture']??'null');
 const canonical=b.evidence.filter(e=>e.sourceId==='solana-rpc'||e.id==='dex-pairs').map(e=>({id:e.id,retrievedAt:e.retrievedAt}));
 if(!capture||capture.method!=='late-state-capture-v1'||tokenKey(capture.token)!==tokenKey(b.token)||decisionHash(capture.canonical)!==decisionHash(canonical)||capture.rpcState!==b.collection.rpc.state||capture.dexState!==b.collection.dex.state||capture.discoveryId!==(b.evidence.some(e=>e.id==='dex-discovery')?'dex-discovery':null)||!Number.isFinite(Date.parse(capture.startedAt))||!Number.isFinite(Date.parse(capture.endedAt))||Date.parse(capture.startedAt)>Date.parse(capture.endedAt)||Date.parse(capture.startedAt)<Date.parse(final.startedAt)||Date.parse(capture.endedAt)>Date.parse(final.endedAt)||Date.parse(final.endedAt)>Date.parse(b.cutoff)||canonical.some(e=>Date.parse(e.retrievedAt)<Date.parse(capture.startedAt)||Date.parse(e.retrievedAt)>Date.parse(capture.endedAt))||b.evidence.some(e=>e.sourceId==='gemini'&&e.sourceType==='MODEL_RESPONSE'&&Date.parse(e.availableAt)>Date.parse(capture.startedAt)))throw Error('LIVE_EXECUTION_PROOF_INVALID');
 for(const e of b.evidence.filter(e=>e.sourceId==='solana-rpc-preflight'))if(!['preflight-rpc-genesis','preflight-rpc-account'].includes(e.id)||Date.parse(e.availableAt)<Date.parse(pre.startedAt)||Date.parse(e.availableAt)>Date.parse(pre.endedAt))throw Error('LIVE_EXECUTION_PROOF_INVALID');
 const early=b.rawArtifacts['preflight-rpc-account']?JSON.parse(b.rawArtifacts['preflight-rpc-account']):null,late=b.rawArtifacts['rpc-account']?JSON.parse(b.rawArtifacts['rpc-account']):null;
 if(early&&late&&Number.isSafeInteger(early.result?.context?.slot)&&(!Number.isSafeInteger(late.result?.context?.slot)||late.result.context.slot<early.result.context.slot))throw Error('LIVE_EXECUTION_PROOF_INVALID');
 if(b.details?.social&&!b.rawArtifacts['social-attention-seed'])throw Error('SOCIAL_SEED_PROOF_REQUIRED');
 if(b.rawArtifacts['social-attention-seed']){
  const seedRecord=b.evidence.find(e=>e.id==='social-attention-seed'&&e.sourceId==='social-collector'),seed=JSON.parse(b.rawArtifacts['social-attention-seed']),attention=JSON.parse(b.rawArtifacts['attention-qualified-receipt']??'null');
  const original=JSON.parse(b.rawArtifacts['attention-acquisition-scope']??'null');
  if(!seedRecord||seed.method!=='attention-social-seed-v1'||!attention||!original||decisionHash(seed.read.comparisonAcquisition??null)!==decisionHash(original.comparisonAcquisition??null)||seed.read.start!==attention.read.start||seed.read.end!==attention.read.end||decisionHash(seed.read.queries)!==decisionHash(attention.read.queries)||decisionHash(seed.read.discoveryUrls??[])!==decisionHash(attention.read.discoveryUrls??[])||!Array.isArray(seed.read.sources)||seed.read.sources.some((source:{id:string;text:string;availableAt:string})=>!attention.read.sources.some((s:{id:string})=>s.id===source.id)||typeof b.rawArtifacts[source.id]!=='string'||Date.parse(source.availableAt)>Date.parse(seedRecord.availableAt))||Date.parse(seedRecord.availableAt)>Date.parse(scope.stages[2].startedAt))throw Error('SOCIAL_SEED_PROOF_INVALID');
  if(decisionHash(seed.read.sources.map((source:{id:string})=>source.id))!==decisionHash(attention.read.sources.filter((source:{id:string})=>!source.id.startsWith('attention-recovery-')).map((source:{id:string})=>source.id)))throw Error('SOCIAL_SEED_PROOF_INVALID');
  const postScope=terminalPostScope({...seed.read,sources:seed.read.sources.map((source:{id:string})=>({...source,text:b.rawArtifacts[source.id]})),rawArtifacts:b.rawArtifacts});
  if(!seed.read.postSampleScope||decisionHash(seed.read.postSampleScope)!==decisionHash(postScope)||decisionHash(attention.read.postSampleScope)!==decisionHash(postScope))throw Error('SOCIAL_SEED_PROOF_INVALID');
  if(b.details?.social){const social=JSON.parse(b.rawArtifacts['social-derivation']),acquisition=JSON.parse(b.rawArtifacts['social-acquisition-scope']??'null');
    if((seed.read.leadershipPositiveMethod==='source-bound-positive-v1')!==(social.read.inspectionRecoveryMethod==='historical-post-inspection-v1'))throw Error('SOCIAL_SEED_PROOF_INVALID');
    const target=(seed.read.postSampleSourceIds??seed.read.sources.filter((source:{id:string;kind:string})=>source.kind==='POST'&&!seed.read.comparisonSourceIds?.includes(source.id)).map((source:{id:string})=>source.id)).filter((id:string)=>seed.read.sources.some((source:{id:string})=>source.id===id));
    if(!['verdict-aware-v1','verdict-aware-v2','verdict-aware-v3','verdict-aware-v4'].includes(social.read.reviewCriterionMethod)||decisionHash(social.read.postSampleScope)!==decisionHash(postScope)||decisionHash(social.read.targetPostIds)!==decisionHash(target)||!acquisition||acquisition.retainedAttentionSourceCount!==seed.read.sources.length)throw Error('SOCIAL_SEED_PROOF_INVALID');
  }
 }
}
function validateSocialUnavailableSources(b:LiveBundle,read:SocialInput,evidenceIds:string[]){
 const scope=JSON.parse(b.rawArtifacts['social-acquisition-scope']??'null');
 const gaps=scope?.selection?.filter((lead:any)=>/^TERMINAL_HTTP_(404|410)$/.test(lead.status))??[];
 if(!read.identityUnavailableSources&&!gaps.length)return;
 try{
  if(read.screeningConstraintMethod!=='frozen-positive-guards-v1'||!read.identityUnavailableSources?.length||!b.evidence.some(e=>e.id==='social-acquisition-scope'&&e.sourceId==='social-collector'&&e.accessMode==='LOCAL_DERIVED')||!Array.isArray(scope.requestedUrlsByBatch))throw Error();
  if(read.identityComplete&&(scope.selection.some((lead:any)=>lead.required&&!['REUSED','RETAINED','TERMINAL_HTTP_404','TERMINAL_HTTP_410'].includes(lead.status))||read.sources.length===0||read.identitySourceIds.some(id=>scope.remainingClippedSourceIds?.includes(id))))throw Error();
  const expected=gaps.map((lead:any)=>{
   if(!lead.required||!lead.selected||typeof lead.url!=='string')throw Error();
   const code=lead.status.slice(9),url=canonicalSocialUrl(lead.url),status=code==='HTTP_404'?404:410;
   const proof=scope.requestedUrlsByBatch.some((urls:string[],index:number)=>{
    if(!Array.isArray(urls)||!urls.includes(url))return false;
    const id='social-fetch-'+(index+1),outcomeId='social-http-outcome-'+(index+1),errorId='social-collection-fetch-'+(index+1)+'-error';
    if(b.rawArtifacts[errorId]!==undefined||b.evidence.some(e=>e.id===errorId))return false;
    if(!evidenceIds.includes(id)||!evidenceIds.includes(outcomeId)||!b.evidence.some(e=>e.id===id&&e.sourceId==='tinyfish-fetch'&&e.accessMode==='FREE_ACCOUNT')||!b.evidence.some(e=>e.id===outcomeId&&e.sourceId==='social-collector'&&e.sourceType==='SAMPLE_SCOPE'&&e.accessMode==='LOCAL_DERIVED'))return false;
    const outcome=JSON.parse(b.rawArtifacts[outcomeId]);
    if(outcome.method!=='social-fetch-http-v1'||outcome.ok!==true||!Number.isInteger(outcome.status)||outcome.status<200||outcome.status>299)return false;
    const packet=JSON.parse(b.rawArtifacts[id]);
    if(!Array.isArray(packet.results)||!Array.isArray(packet.errors)||packet.results.some((r:any)=>typeof r.url==='string'&&canonicalSocialUrl(r.url)===url))return false;
    const errors=packet.errors.filter((e:any)=>typeof e.url==='string'&&canonicalSocialUrl(e.url)===url);
    return errors.length>0&&errors.every((e:any)=>e.status===404||e.status===410)&&errors.some((e:any)=>e.status===status);
   });
   if(!proof)throw Error();return {url,code};
  });
  if(new Set(expected.map((g:{url:string})=>g.url)).size!==expected.length||decisionHash(expected)!==decisionHash(read.identityUnavailableSources))throw Error();
 }catch{throw Error('SOCIAL_UNAVAILABLE_SOURCE_PROOF_INVALID');}
}
function validateHolderReconciliation(b:LiveBundle){
 const ids=['rpc-mint-raw-reconciliation-attempt-1','rpc-holder-population-reconciliation-attempt-1'];
 if(!ids.some(id=>b.rawArtifacts[id]))return;
 try{
  for(const id of [...ids,'rpc-mint-raw','rpc-holder-population'])if(!b.evidence.some(e=>e.id===id&&e.sourceId==='solana-rpc'&&e.sourceType==='JSON_RPC'&&e.accessMode==='PUBLIC_API'))throw Error('proof');
  const initialMint=JSON.parse(b.rawArtifacts[ids[0]]).result,initialPopulation=JSON.parse(b.rawArtifacts[ids[1]]).result,currentMint=JSON.parse(b.rawArtifacts['rpc-mint-raw']).result,currentPopulation=JSON.parse(b.rawArtifacts['rpc-holder-population']).result;
  const supply=(mint:any)=>{if(mint.value.data[1]!=='base64')throw Error('shape');const bytes=Buffer.from(mint.value.data[0],'base64');if(bytes.length<82)throw Error('shape');return bytes.readBigUInt64LE(36).toString();};
  let mismatch=false;try{decodeHolderPopulation(initialPopulation,b.token.address,initialMint.value.owner,supply(initialMint),initialMint.context.slot);}catch(error){mismatch=error instanceof Error&&error.message==='HOLDER_SUPPLY_UNRECONCILED';}if(!mismatch)throw Error('trigger');
  const mintChanged=b.rawArtifacts['rpc-mint-raw']!==b.rawArtifacts[ids[0]],populationChanged=b.rawArtifacts['rpc-holder-population']!==b.rawArtifacts[ids[1]];
  if(mintChanged&&(currentMint.context.slot<initialPopulation.context.slot||currentMint.value.owner!==initialMint.value.owner)||populationChanged&&Number.isSafeInteger(currentPopulation?.context?.slot)&&(!mintChanged||currentPopulation.context.slot<currentMint.context.slot))throw Error('floor');
  if(b.details?.baseline.some(a=>['O17','O18'].includes(a.id)&&a.quality==='KNOWN')){
   if(!mintChanged||!populationChanged)throw Error('capture');
   const holders=decodeHolderPopulation(currentPopulation,b.token.address,currentMint.value.owner,supply(currentMint),currentMint.context.slot),bounds=deriveHolderBounds(holders);
   if(['O17','O18','O19','O20'].some(id=>decisionHash(b.details!.baseline.find(a=>a.id===id)?.data??null)!==decisionHash(bounds)))throw Error('bounds');
  }
 }catch{throw Error('HOLDER_RECONCILIATION_PROOF_INVALID');}
}
function validateFeeRecovery(b:LiveBundle){
  for(const e of b.evidence.filter(e=>e.id.endsWith('-min-context-recovery'))){
    const id=e.id.replace(/-min-context-recovery$/,''),receipt=JSON.parse(b.rawArtifacts[e.id]);
    if(!/^pump-(?:entry|exit)-network-fee(?:-retry)?$/.test(id)||e.sourceId!=='pumpswap-derived'||e.accessMode!=='LOCAL_DERIVED'||receipt.method!=='fee-min-context-retry-v1'||receipt.operation!=='getFeeForMessage'||receipt.code!=='RPC_REMOTE_-32016'||receipt.delayMs!==1000||receipt.firstResponseId!==`${id}-min-context-attempt-1`||receipt.secondResponseId!==`${id}-min-context-attempt-2`||!Array.isArray(receipt.params)||receipt.params.length!==2||typeof receipt.params[0]!=='string'||!receipt.params[1]||typeof receipt.params[1]!=='object'||Array.isArray(receipt.params[1])||Object.keys(receipt.params[1]).sort().join(',')!=='commitment,minContextSlot'||receipt.params[1].commitment!=='finalized')throw new Error('PUMP_RECOVERY_PROOF_INVALID');
    const first=b.evidence.find(e=>e.id===receipt.firstResponseId),second=b.evidence.find(e=>e.id===receipt.secondResponseId),normal=b.evidence.find(e=>e.id===id);
    if(!first||first.sourceId!=='pumpswap-direct'||first.accessMode!=='PUBLIC_API'||JSON.parse(b.rawArtifacts[first.id]).error?.code!==-32016||Date.parse(first.retrievedAt)>Date.parse(e.retrievedAt))throw new Error('PUMP_RECOVERY_PROOF_INVALID');
    const state=JSON.parse(b.rawArtifacts['pump-mints-vaults']),block=JSON.parse(b.rawArtifacts[id.endsWith('-retry')?'pump-blockhash-retry':'pump-blockhash']);
    if(receipt.params[1].minContextSlot!==Math.max(state.result.context.slot,Number.isSafeInteger(block.result.context?.slot)?block.result.context.slot:state.result.context.slot))throw new Error('PUMP_RECOVERY_PROOF_INVALID');
    const bytes=Buffer.from(receipt.params[0],'base64');
    if(bytes.toString('base64')!==receipt.params[0]||VersionedMessage.deserialize(bytes).recentBlockhash!==block.result.value.blockhash)throw new Error('PUMP_RECOVERY_PROOF_INVALID');
    if(second&&(second.sourceId!=='pumpswap-direct'||second.accessMode!=='PUBLIC_API'||Date.parse(second.retrievedAt)<Date.parse(e.retrievedAt)))throw new Error('PUMP_RECOVERY_PROOF_INVALID');
    if(normal&&(!second||b.rawArtifacts[normal.id]!==b.rawArtifacts[second.id]||normal.retrievedAt!==second.retrievedAt))throw new Error('PUMP_RECOVERY_PROOF_INVALID');
  }
}
function stable(v: unknown): string {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('NONFINITE_NUMBER'); return JSON.stringify(v); }
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v === 'object' && v) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  throw new Error('UNSERIALIZABLE_VALUE');
}
export const decisionHash = (v: unknown) => createHash('sha256').update(stable(v)).digest('hex');
const tokenKey = (t: TokenRef) => `${t.chain}:${t.address}`;
/** Optional fresh fallback receipts are verified without changing legacy snapshot dispatch. */
function validateDexRecovery(b:LiveBundle) {
  for(const e of b.evidence.filter(e=>e.sourceType==='FETCH_SELECTION')){
    const namespace=e.id.replace(/-fetch-selection$/,''),chain=namespace==='pump-sol-usd'?'solana':b.token.chain;
    const address=namespace==='pump-sol-usd'?'So11111111111111111111111111111111111111112':b.token.address;
    if(!['dex-discovery','dex-pairs','pump-sol-usd'].includes(namespace)||e.sourceId!=='shared-collector'||e.accessMode!=='LOCAL_DERIVED')throw new Error('DEX_RECOVERY_PROOF_INVALID');
    const d=JSON.parse(b.rawArtifacts[e.id]) as DexRecoveryReceipt & {parents:string[]};
    const get=(suffix:string)=>b.rawArtifacts[`${namespace}-${suffix}`];
    const requestRaw=get('fetch-request'),responseRaw=get('fetch-response'),primaryRaw=get('primary');
    if(d.method!=='tinyfish-live-dex-json-v1'||d.requestedUrl!==dexPairsUrl(chain,address)||requestRaw!==JSON.stringify(dexFetchBody(d.requestedUrl))||typeof d.selected!=='boolean'||!['OBSERVED','TRUNCATED','NO_RESULTS','UNAVAILABLE','INVALID'].includes(d.primaryState)||d.primaryState==='OBSERVED'||d.primaryState==='TRUNCATED'||d.retrievedAt&&(!Number.isFinite(Date.parse(d.retrievedAt))||Date.parse(d.retrievedAt)>Date.parse(b.cutoff))||d.primaryRetrievedAt&&(!Number.isFinite(Date.parse(d.primaryRetrievedAt))||Date.parse(d.primaryRetrievedAt)>Date.parse(d.retrievedAt??e.retrievedAt)))throw new Error('DEX_RECOVERY_PROOF_INVALID');
    if(primaryRaw!==undefined&&d.primaryState==='NO_RESULTS'&&parseDexPairs(JSON.parse(primaryRaw),chain,address).retainedPairCount)throw new Error('DEX_RECOVERY_PROOF_INVALID');
    const parsed=d.selected?parseDexFetch(responseRaw,d.requestedUrl,chain,address):undefined;
    if(d.selected&&(!d.retrievedAt||d.code)||!d.selected&&!d.code)throw new Error('DEX_RECOVERY_PROOF_INVALID');
    const recovery:DexRecoveryReceipt={...d,requestRaw,...(responseRaw!==undefined?{responseRaw}:{}),...(primaryRaw!==undefined?{primaryRaw}:{})};
    const expected=dexArtifacts({status:parsed?parsed.market.retainedPairCount?parsed.market.truncated?'TRUNCATED':'OBSERVED':'NO_RESULTS':d.primaryState,recovery,...(parsed?{raw:parsed.text,market:parsed.market,retrievedAt:d.retrievedAt}:{})},namespace,chain,address,e.retrievedAt);
    for(const [id,a] of Object.entries(expected)){
      const actual=b.evidence.find(row=>row.id===id);
      if(!actual||actual.sourceId!==a.sourceId||actual.sourceType!==a.sourceType||actual.accessMode!==a.accessMode||actual.retrievedAt!==a.retrievedAt||actual.availableAt!==a.retrievedAt||decisionHash(actual.scope)!==decisionHash(a.scope)||b.rawArtifacts[id]!==a.raw)throw new Error('DEX_RECOVERY_PROOF_INVALID');
    }
    if(!parsed&&b.evidence.some(row=>row.id===namespace))throw new Error('DEX_RECOVERY_PROOF_INVALID');
    if(parsed&&namespace==='dex-pairs'){
      if(decisionHash(b.market)!==decisionHash(parsed.market)||b.collection.dex.count!==parsed.market.retainedPairCount||b.collection.dex.state!==(parsed.market.retainedPairCount?parsed.market.truncated?'TRUNCATED':'OBSERVED':'NO_RESULTS'))throw new Error('DEX_RECOVERY_MARKET_INVALID');
      const fields:Record<string,string>={reportedPairCount:String(parsed.market.reportedPairCount),retainedPairCount:String(parsed.market.retainedPairCount)};
      for(const [i,p] of parsed.market.pairs.entries()){
        const stem=`pair.${i+1}`;fields[`${stem}.address`]=p.pairAddress;fields[`${stem}.mintSide`]=p.mintSide;
        for(const key of ['priceUsd','liquidityUsd','volume24hUsd','buys24h','sells24h'] as const)if(p[key]!==null)fields[`${stem}.${key}`]=String(p[key]);
        if(p.pairCreatedAt)fields[`${stem}.poolCreatedAt`]=p.pairCreatedAt;
      }
      for(const [field,value] of Object.entries(fields)){const o=b.observations.find(o=>o.field===field);if(!o||o.value!==value||decisionHash(o.evidenceIds)!==decisionHash([namespace])||o.availableAt!==d.retrievedAt||o.observedAt!==d.retrievedAt)throw new Error('DEX_RECOVERY_MARKET_INVALID');}
      if(b.observations.some(o=>(o.field.startsWith('pair.')||['reportedPairCount','retainedPairCount'].includes(o.field))&&!(o.field in fields)))throw new Error('DEX_RECOVERY_MARKET_INVALID');
      const pair=parsed.market.pairs.find(p=>p.mintSide==='base'&&p.priceUsd!==null&&p.buys24h!==null&&p.sells24h!==null&&p.volume24hUsd!==null);
      const flow=b.details?.baseline.find(a=>a.id==='O28');
      if(pair&&flow&&(decisionHash(flow.data)!==decisionHash({pair:pair.pairAddress,buys:pair.buys24h,sells:pair.sells24h,volumeUsd:pair.volume24hUsd,window:'rolling 24h',meaning:'trade counts; no buyer identity or organic-flow claim'})||decisionHash(flow.evidenceIds)!==decisionHash([namespace])))throw new Error('DEX_RECOVERY_MARKET_INVALID');
      const fdv=b.observations.find(o=>o.field==='derivedFdvUsd');
      if(fdv){const supply=b.observations.find(o=>o.field==='supplyAtomic')?.value,decimals=b.observations.find(o=>o.field==='decimals')?.value,price=parsed.market.pairs.find(p=>p.mintSide==='base'&&p.priceUsd!==null)?.priceUsd;if(typeof supply!=='string'||typeof decimals!=='string'||!price||fdv.value!==new Decimal(supply).div(new Decimal(10).pow(decimals)).mul(price).toFixed()||!fdv.evidenceIds.includes(namespace))throw new Error('DEX_RECOVERY_MARKET_INVALID');}
    }
    if(parsed&&namespace==='pump-sol-usd'&&b.rawArtifacts['pump-quote-calculation']){
      const calc=JSON.parse(b.rawArtifacts['pump-quote-calculation']);
      const price=parsed.market.pairs.find(p=>p.baseAddress===address&&p.quoteAddress==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'&&p.priceUsd!==null)?.priceUsd;
      if(!price||calc.nativeUsd!==price||calc.nativePriceEvidenceId!==namespace||calc.requestedUsd!==b.profile.sizeUsd||calc.quoteAtomic!==new Decimal(calc.requestedUsd).div(price).mul(1e9).floor().toFixed(0))throw new Error('DEX_RECOVERY_MARKET_INVALID');
      const exit=b.details?.baseline.find(a=>a.id==='O11');
      if(exit?.quality==='KNOWN'){
        const data=exit.data as {quantityAtomic:string;outputUsd:string};
        const output=new Decimal(calc.exitAtomic).add(new Decimal(calc.quoteAtomic).sub(calc.actualEntryAtomic)).div(1e9).mul(price).toFixed();
        if(data.quantityAtomic!==calc.acquiredAtomic||data.outputUsd!==output||!exit.evidenceIds.includes(namespace))throw new Error('DEX_RECOVERY_MARKET_INVALID');
      }
    }
  }
  if(b.evidence.some(e=>e.sourceType==='MARKET_API_WITH_FETCH'&&e.scope.method!=='tinyfish-live-dex-json-v1'||e.scope.method==='tinyfish-live-dex-json-v1'&&!b.evidence.some(s=>s.id===`${e.id}-fetch-selection`&&s.sourceType==='FETCH_SELECTION')))throw new Error('DEX_RECOVERY_PROOF_INVALID');
}
const normalizeToken = (t: TokenRef, fixture: boolean): TokenRef => {
  if (fixture) return t;
  if (t.chain === 'solana') { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.address)) throw new Error('INVALID_SOLANA_ADDRESS'); return t; }
  if (!/^0x[a-fA-F0-9]{40}$/.test(t.address)) throw new Error('INVALID_EVM_ADDRESS');
  return { ...t, address: t.address.toLowerCase() };
};
const readJson = <T>(v: unknown): T => JSON.parse(String(v)) as T;
const directOnly = new Set(['O01','O03','O04','O05','O06','O07','O08','O09','O10','O11','O12','O13','O14','O15','O16','O17','O18','O19','O20','C02']);
const legacyPolicyFeatures=(b:Bundle|LiveBundle)=>b.analysisKind==='FIXTURE'||b.analysisKind==='LIVE'?b.features:b.features.map(f=>directOnly.has(f.id)&&f.quality==='KNOWN'?{...f,quality:'MISSING' as const}:f);
const importedResearch=(b:Bundle|LiveBundle)=>{
  const record=b.evidence.find(e=>e.sourceId==='curated-research'&&e.accessMode==='USER_IMPORT');
  return record&&b.rawArtifacts?.[record.id]!==undefined?validateResearch(JSON.parse(b.rawArtifacts[record.id]),b.token,b.cutoff):undefined;
};
const policyFeatures = (b: Bundle | LiveBundle) => {
  if(b.analysisKind==='FIXTURE')return b.features;
  const features=b.features.map(f=>f.quality==='KNOWN'&&(b.analysisKind!=='LIVE'||directOnly.has(f.id)&&f.evidenceIds.some(id=>b.evidence.find(e=>e.id===id)?.accessMode==='USER_IMPORT'))?{...f,quality:'MISSING' as const}:f);
  if(b.analysisKind==='USER_IMPORT'){
    const research=importedResearch(b);
    if(research)for(const a of deriveBaseline({token:b.token,cutoff:b.cutoff,profile:b.profile,features:[],evidence:b.evidence,observations:b.observations,research})){if(!a.projection||directOnly.has(a.id))continue;const index=features.findIndex(f=>f.id===a.id);if(index>=0)features[index]=a.projection;else features.push(a.projection);}
  }
  return features;
};
const stageInputs = (b: Bundle | LiveBundle): StageInputs => {
  if (b.analysisKind === 'LIVE') return b.details?.stageInputs??{circulatingMarketCapUsd:null,tokenCreatedAt:null};
  if (b.analysisKind !== 'FIXTURE') return { circulatingMarketCapUsd: null, tokenCreatedAt: null };
  const value = (field: string) => b.observations.find(o => o.field === field && o.quality === 'KNOWN' && Date.parse(o.availableAt) <= Date.parse(b.cutoff))?.value;
  const cap = value('circulatingMarketCapUsd'), created = value('tokenCreatedAt');
  return { circulatingMarketCapUsd: typeof cap === 'string' ? cap : null, tokenCreatedAt: typeof created === 'string' ? created : null };
};

export class Service {
  private db: DatabaseSync;
  private artifactDir: string;
  constructor(file = '.data/dd.sqlite') {
    mkdirSync(dirname(file), { recursive: true });
    this.artifactDir = join(dirname(file), 'artifacts');
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, hash TEXT NOT NULL, semantic TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, token_key TEXT NOT NULL UNIQUE, token_json TEXT NOT NULL, status TEXT NOT NULL, episode_id TEXT);
      CREATE TABLE IF NOT EXISTS episodes(id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS positions(id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS position_events(id TEXT PRIMARY KEY, position_id TEXT NOT NULL REFERENCES positions(id), idempotency_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal(id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), at TEXT NOT NULL, text TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS snapshots_no_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SNAPSHOT'); END;
      CREATE TRIGGER IF NOT EXISTS snapshots_no_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SNAPSHOT'); END;
      CREATE TRIGGER IF NOT EXISTS episodes_no_update BEFORE UPDATE ON episodes BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EPISODE'); END;
      CREATE TRIGGER IF NOT EXISTS episodes_no_delete BEFORE DELETE ON episodes BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EPISODE'); END;`);
  }
  close() { this.db.close(); }
  private validateBundle(input: Bundle | LiveBundle, trustedLive = false): Bundle | LiveBundle {
    const parsed = trustedLive ? liveBundleSchema.parse(input) : bundleSchema.parse(input);
    const b = { ...parsed, token: normalizeToken(parsed.token, parsed.analysisKind === 'FIXTURE') };
    if (b.analysisKind === 'MANUAL_EMPTY' && (b.evidence.length || b.features.length || b.observations.length)) throw new Error('MANUAL_EMPTY_MUST_BE_EMPTY');
    if (b.evidence.length > 1000 || b.features.length > 1000 || b.observations.length > 1000) throw new Error('BUNDLE_LIMIT');
    const ids = new Set(b.evidence.map(e => e.id));
    if (ids.size !== b.evidence.length || new Set(b.features.map(f => f.id)).size !== b.features.length) throw new Error('DUPLICATE_BUNDLE_ID');
    for (const e of b.evidence) if (Date.parse(e.availableAt) > Date.parse(b.cutoff) || Date.parse(e.retrievedAt) > Date.parse(b.cutoff)) throw new Error('FUTURE_EVIDENCE');
    if (b.rawArtifacts && Object.keys(b.rawArtifacts).some(id => !ids.has(id))) throw new Error('UNREFERENCED_ARTIFACT');
    if ((b.analysisKind === 'USER_IMPORT' || b.analysisKind === 'LIVE') && b.evidence.some(e => b.rawArtifacts?.[e.id] === undefined)) throw new Error('RAW_ARTIFACT_REQUIRED');
    let artifactBytes = 0,populationBytes=0;
    for (const e of b.evidence) if (b.rawArtifacts?.[e.id] !== undefined) {
      const raw = b.rawArtifacts[e.id],bytes=Buffer.byteLength(raw); artifactBytes += bytes;
      if(b.analysisKind==='LIVE'&&['rpc-holder-population','rpc-holder-population-reconciliation-attempt-1'].includes(e.id)&&e.sourceId==='solana-rpc'&&e.sourceType==='JSON_RPC'&&e.accessMode==='PUBLIC_API'){if(bytes>64_000_000)throw Error('ARTIFACT_HASH_OR_SIZE');populationBytes+=bytes;}
      if (artifactBytes-populationBytes > (b.analysisKind === 'LIVE' ? 24_000_000 : 2_000_000) || createHash('sha256').update(raw).digest('hex') !== e.contentHash) throw new Error('ARTIFACT_HASH_OR_SIZE');
    }
    for (const e of b.evidence) {
      if (b.analysisKind === 'LIVE') {
        const sources: Record<string,string> = { 'solana-rpc': 'PUBLIC_API', 'solana-rpc-preflight':'PUBLIC_API', 'venue-discovery-rpc':'PUBLIC_API', 'solana-rpc-diagnostics':'LOCAL_DERIVED', 'meteora-damm-direct':'PUBLIC_API','meteora-damm-derived':'LOCAL_DERIVED','pumpswap-direct':'PUBLIC_API','pumpswap-derived':'LOCAL_DERIVED','pump-curve-direct':'PUBLIC_API','pump-curve-derived':'LOCAL_DERIVED','token-metadata-discovery':'PUBLIC_API', dexscreener: 'PUBLIC_API', 'tinyfish-search': 'FREE_ACCOUNT', 'tinyfish-fetch': 'FREE_ACCOUNT', gemini: 'FREE_ACCOUNT','local-config':'LOCAL_DERIVED','attention-collector':'LOCAL_DERIVED','social-collector':'LOCAL_DERIVED','shared-collector':'LOCAL_DERIVED','curated-research':'USER_IMPORT' };
        if (sources[e.sourceId] !== e.accessMode) throw new Error('LIVE_PROVENANCE_INVALID');
      } else if (e.accessMode !== 'USER_IMPORT' && b.analysisKind !== 'FIXTURE') throw new Error('IMPORT_PROVENANCE_FORGED');
    }
    for (const f of b.features) {
      if (f.evidenceIds.some(id => !ids.has(id))) throw new Error('UNKNOWN_EVIDENCE_REF');
      if (Date.parse(f.availableAt) > Date.parse(b.cutoff)) throw new Error('FUTURE_FEATURE');
    }
    for (const o of b.observations) {
      if (tokenKey(o.subject) !== tokenKey(b.token) || o.evidenceIds.some(id => !ids.has(id))) throw new Error('INVALID_OBSERVATION_REF');
      if (Date.parse(o.availableAt) > Date.parse(b.cutoff)) throw new Error('FUTURE_OBSERVATION');
    }
    if (b.analysisKind === 'LIVE') {
      validateLiveExecution(b);
      validatePumpRecoveryBundle(b);
      validateCurveBundle(b);
      validateDammBundle(b);
      validateDexRecovery(b);
      validateFeeRecovery(b);
      validateHolderReconciliation(b);
      let captureGroupMethod:unknown;
      if(b.rawArtifacts['live-state-capture'])try{captureGroupMethod=JSON.parse(b.rawArtifacts['live-state-capture']).entryGroupMethod;}catch{throw Error('ENTRY_GROUP_PROOF_INVALID');}
      const groupMarked=!!b.details?.groups||b.details?.shared?.qualityMode==='ENTRY_GROUPS_V1'||b.rawArtifacts['entry-groups-derivation']!==undefined||captureGroupMethod!==undefined;
      if(groupMarked){
        const proof=b.evidence.find(e=>e.id==='entry-groups-derivation'&&e.sourceId==='shared-collector'&&e.sourceType==='CALCULATION'&&e.accessMode==='LOCAL_DERIVED');
        if(!b.details?.groups||b.details.shared?.qualityMode!=='ENTRY_GROUPS_V1'||captureGroupMethod!=='mandatory-entry-groups-v1'||!proof||proof.scope.method!=='mandatory-entry-groups-v1'||proof.availableAt!==b.cutoff||proof.retrievedAt!==b.cutoff||decisionHash(JSON.parse(b.rawArtifacts[proof.id]))!==decisionHash(b.details.groups))throw Error('ENTRY_GROUP_PROOF_INVALID');
      }
      for (const claim of b.semantic.claims) if (!ids.has(claim.evidenceId)) throw new Error('UNKNOWN_SEMANTIC_REF');
      if(b.details){
        const details=b.details;
        if(details.version!==1||decisionHash(profileSchema.parse(details.profile))!==decisionHash(b.profile)||decisionHash(details.thesis)!==decisionHash(b.thesis??null)||!Array.isArray(details.baseline)||details.baseline.length!==baselineIds.length||new Set(details.baseline.map(a=>a.id)).size!==baselineIds.length||details.baseline.some(a=>!baselineIds.some(id=>id===a.id)||a.evaluator!=='IMPLEMENTED'||a.evidenceIds.some(id=>!ids.has(id)))||JSON.stringify(details).length>2_000_000)throw new Error('INVALID_ASSESSMENT_DETAILS');
        if(details.social){
          const record=b.evidence.find(e=>e.id==='social-derivation'&&e.sourceId==='social-collector'&&e.accessMode==='LOCAL_DERIVED');
          if(!record)throw new Error('SOCIAL_PROOF_REQUIRED');
          const packet=JSON.parse(b.rawArtifacts[record.id]) as {read:unknown;proposal:unknown;review:unknown;token:TokenRef;cutoff:string;evidenceIds:string[]};
          const read=socialInputSchema.parse(packet.read),proposal=packet.proposal===null?null:socialProposalSchema.parse(packet.proposal),review=packet.review===null?null:socialReviewSchema.parse(packet.review);
          validateSocialUnavailableSources(b,read,Array.isArray(packet.evidenceIds)?packet.evidenceIds:[]);
          if(tokenKey(packet.token)!==tokenKey(b.token)||packet.cutoff!==b.cutoff||!Array.isArray(packet.evidenceIds)||packet.evidenceIds.some(id=>!ids.has(id)||b.evidence.find(e=>e.id===id)?.accessMode==='USER_IMPORT'))throw new Error('SOCIAL_PROOF_INVALID');
          if(read.sources.some(source=>!packet.evidenceIds.includes(source.id))||packet.evidenceIds.some(id=>Date.parse(b.evidence.find(e=>e.id===id)!.availableAt)>Date.parse(read.qualifiedAt??read.end)))throw new Error('SOCIAL_PROOF_INVALID');
          if(proposal&&review){
            const receipt=b.evidence.find(e=>e.id==='social-qualified-receipt'&&e.sourceId==='social-collector');
            if(!receipt||!packet.evidenceIds.includes(receipt.id)||!['social-proposal-response','social-review-response'].every(id=>packet.evidenceIds.includes(id)&&b.evidence.some(e=>e.id===id&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT')))throw new Error('SOCIAL_PROOF_REQUIRED');
            const normalized=JSON.parse(b.rawArtifacts[receipt.id]);
            const {qualifiedAt:receiptTime,...receiptScope}=socialInputSchema.parse(normalized.read);
            const {qualifiedAt:derivationTime,...derivationScope}=read;
            if(decisionHash(normalized.proposal)!==decisionHash(proposal)||decisionHash(normalized.review)!==decisionHash(review)||decisionHash(receiptScope)!==decisionHash(derivationScope))throw new Error('SOCIAL_PROOF_INVALID');
            const acquisition=b.rawArtifacts['social-acquisition-scope']?JSON.parse(b.rawArtifacts['social-acquisition-scope']):null;
            const submitted=b.rawArtifacts['social-proposal-prompt']?JSON.parse(b.rawArtifacts['social-proposal-prompt']):null;
            if(read.entryDecisionMethod||acquisition?.read?.entryDecisionMethod||submitted?.scope?.entryDecisionMethod||proposal.participationAssessment||proposal.communityBreadthAssessment){
              if(!['public-support-v2','public-support-v3'].includes(read.entryDecisionMethod??'')||(read.entryDecisionMethod==='public-support-v3'?!proposal.communityBreadthAssessment:!!proposal.communityBreadthAssessment)||normalized.wireMethod!=='social-line-span-v2'||!proposal.participationAssessment||decisionHash(acquisition?.read)!==decisionHash(receiptScope))throw Error('SOCIAL_PROOF_INVALID');
            }
            if(normalized.wireMethod!==undefined&&normalized.wireMethod!=='social-line-span-v2')throw new Error('SOCIAL_PROOF_INVALID');
            if(normalized.identityCitationMethod!==undefined&&(!['assessment-citation-closure-v1','identity-citation-closure-v2','identity-citation-closure-v3'].includes(normalized.identityCitationMethod)||normalized.wireMethod!=='social-line-span-v2'))throw new Error('SOCIAL_PROOF_INVALID');
            const hasRepair=Object.keys(b.rawArtifacts).some(id=>id.startsWith('social-repair-'));
            if((normalized.repairSelectionId!==undefined&&normalized.repairSelectionId!==(hasRepair?'social-repair-selection':null))||hasRepair&&!b.rawArtifacts['social-repair-selection'])throw new Error('SOCIAL_PROOF_INVALID');
            const selectorRepairIds=Object.keys(b.rawArtifacts).filter(id=>/^social-selector-repair-(?:prompt|response)$/.test(id));
            if(selectorRepairIds.length){
              if(normalized.wireMethod!=='social-line-span-v2'||selectorRepairIds.length!==2)throw new Error('SOCIAL_PROOF_INVALID');
              for(const id of selectorRepairIds)if(!packet.evidenceIds.includes(id)||!b.evidence.some(e=>e.id===id&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT'))throw new Error('SOCIAL_PROOF_REQUIRED');
            }
            if(normalized.wireMethod==='social-line-span-v2')validateSocialWire(b.rawArtifacts,read,b.token,proposal,review);
            if(hasRepair){
              const repair=b.evidence.find(e=>e.id==='social-repair-selection'&&e.sourceId==='social-collector'&&e.accessMode==='LOCAL_DERIVED');
              if(!repair||!packet.evidenceIds.includes(repair.id))throw new Error('SOCIAL_PROOF_REQUIRED');
              for(const id of Object.keys(b.rawArtifacts).filter(id=>/^social-repair-(?:proposal|review)-(?:prompt|response)$/.test(id)))if(!packet.evidenceIds.includes(id)||!b.evidence.some(e=>e.id===id&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT'))throw new Error('SOCIAL_PROOF_REQUIRED');
              validateSocialRepair(b.rawArtifacts,read,b.token,proposal,review);
            }
          }
          for(const source of read.sources){const e=b.evidence.find(e=>e.id===source.id);if(!e||e.sourceId!=='tinyfish-fetch'||e.accessMode!=='FREE_ACCOUNT'||b.rawArtifacts[e.id]!==source.text||e.availableAt!==source.availableAt||e.scope.url!==source.url||e.scope.authorId!==source.authorId||e.scope.publishedAt!==source.publishedAt||e.scope.kind!==source.kind)throw new Error('SOCIAL_SOURCE_INVALID');}
          const derived=deriveSocial(read,proposal,review,b.token,b.cutoff,packet.evidenceIds);
          if(decisionHash(derived.facts)!==decisionHash(details.social)||derived.assessments.some(a=>decisionHash(a)!==decisionHash(details.baseline.find(x=>x.id===a.id))||decisionHash(a.projection)!==decisionHash(b.features.find(x=>x.id===a.id))))throw new Error('SOCIAL_FACTS_INVALID');
        }
        if(details.shared){
          const proof=b.evidence.find(e=>e.id==='shared-derivation'&&e.sourceId==='shared-collector'&&e.accessMode==='LOCAL_DERIVED');
          if(!proof)throw new Error('SHARED_PROOF_REQUIRED');
          const packet=JSON.parse(b.rawArtifacts[proof.id]) as SharedInputs;
          if(packet.qualityMode!==undefined&&!['ENTRY_GATES_V1','ENTRY_GROUPS_V1'].includes(packet.qualityMode)||packet.qualityMode!==proof.scope.qualityMode||decisionHash(packet.groups??null)!==decisionHash(details.groups??null))throw Error('SHARED_PROOF_INVALID');
          const effective=expireSharedWitnesses(packet);
          const withoutShared=(fs:FeatureResult[])=>fs.filter(f=>!['C03','C04','C05','C06'].includes(f.id));
          if(tokenKey(packet.token)!==tokenKey(b.token)||packet.cutoff!==b.cutoff||decisionHash(packet.profile)!==decisionHash(b.profile)||decisionHash(withoutShared(effective.features))!==decisionHash(withoutShared(b.features))||decisionHash(packet.observations)!==decisionHash(b.observations)||decisionHash(packet.social??null)!==decisionHash(details.social??null)||decisionHash(packet.claims)!==decisionHash(sharedClaims(packet.baseline,details.social))||decisionHash(packet.evidence)!==decisionHash(b.evidence.filter(e=>e.id!==proof.id)))throw new Error('SHARED_PROOF_INVALID');
          const nonShared=(as:typeof details.baseline)=>as.filter(a=>!['C03','C04','C05','C06'].includes(a.id));
          if(decisionHash(nonShared(effective.baseline))!==decisionHash(nonShared(details.baseline)))throw new Error('SHARED_PROOF_INVALID');
          for(const source of packet.sources){
            const e=b.evidence.find(e=>e.id===source.id);
            if(source.kind==='INDEXED_METADATA'){
              if(!e||e.sourceId!=='attention-collector'||e.sourceType!=='INDEXED_LEAD'||e.accessMode!=='LOCAL_DERIVED')throw new Error('SHARED_SOURCE_INVALID');
              const descriptor=JSON.parse(b.rawArtifacts[e.id]);
              if(typeof descriptor.title!=='string'||typeof descriptor.snippet!=='string'||source.text!==descriptor.title+'\n'+descriptor.snippet||source.url!==(descriptor.normalizedUrl??descriptor.url)||source.availableAt!==e.availableAt||source.authorId!==null||source.publishedAt!==null)throw new Error('SHARED_SOURCE_INVALID');
              if(descriptor.urlMethod!==undefined){
                const search=b.evidence.find(e=>e.id===descriptor.searchArtifactId&&e.sourceId==='tinyfish-search'&&e.accessMode==='FREE_ACCOUNT'),row=search?JSON.parse(b.rawArtifacts[search.id]).results?.[descriptor.resultIndex]:null;
                if(descriptor.urlMethod!=='tinyfish-search-redirect-v1'||!row||typeof row.url!=='string'||!row.url.startsWith('/url?')||descriptor.url!==row.url||descriptor.normalizedUrl!==normalizeAttentionSearchUrl(row.url)||descriptor.title!==(row.title??'')||descriptor.snippet!==(row.snippet??''))throw new Error('SHARED_SOURCE_INVALID');
              }
            }else if(!e||e.sourceId!=='tinyfish-fetch'||e.accessMode!=='FREE_ACCOUNT'||b.rawArtifacts[e.id]!==source.text||e.availableAt!==source.availableAt||e.scope.url!==source.url||e.scope.authorId!==source.authorId||e.scope.publishedAt!==source.publishedAt||e.scope.kind!==source.kind)throw new Error('SHARED_SOURCE_INVALID');
          }
          const attentionRecord=b.evidence.find(e=>e.id==='attention-qualified-receipt'&&e.sourceId==='attention-collector'&&e.accessMode==='LOCAL_DERIVED');
          const receiptIds=['attention-qualified-receipt','social-qualified-receipt'].filter(id=>b.evidence.some(e=>e.id===id&&e.accessMode==='LOCAL_DERIVED'));
          if(decisionHash(packet.semanticReceiptIds)!==decisionHash(receiptIds))throw new Error('SHARED_PROOF_INVALID');
          if(attentionRecord){
            const receipt=JSON.parse(b.rawArtifacts[attentionRecord.id]);
            const binaryMode=receipt.read.entryEvidenceMethod==='public-support-v2'||receipt.read.comparisonQualification?.entryDecisionMethod==='binary-public-support-v1';
            const acquisitionMode=JSON.parse(b.rawArtifacts['attention-acquisition-scope']??'{}').entryEvidenceMethod,submittedMode=JSON.parse(b.rawArtifacts['attention-proposal-prompt']??'{}').scope?.entryEvidenceMethod;
            if(receipt.read.entryEvidenceMethod||acquisitionMode||submittedMode||['binary-public-support-v2','binary-public-support-v3','binary-public-support-v4'].includes(receipt.review?.entryDecisions?.method)){const empty=emptyAttentionQualification(receipt.read),localEmpty=!receipt.read.sources.length&&decisionHash({proposal:receipt.proposal,review:receipt.review})===decisionHash({proposal:empty.proposal,review:empty.review});const submitted=!!b.rawArtifacts['attention-proposal-prompt']||!!b.rawArtifacts['attention-proposal-response']||!localEmpty&&(!!receipt.proposal||!!receipt.review);if(receipt.read.entryEvidenceMethod!=='public-support-v2'||acquisitionMode!=='public-support-v2'||(submitted&&submittedMode!=='public-support-v2'))throw Error('SHARED_PROOF_INVALID');}
            const freshAcquisition=b.rawArtifacts['attention-entry-first-acquisition'];
            const entryPrompt=JSON.parse(b.rawArtifacts['attention-leadership-proposal-prompt']??'{}');
            if(receipt.read.entryExecutionMethod||receipt.read.comparisonRecovery||freshAcquisition||entryPrompt.entryExecutionMethod){
              if(!['entry-first-v1','entry-first-v2'].includes(receipt.read.entryExecutionMethod)||receipt.read.comparisonQualification||receipt.read.comparisonComplete!==false||!freshAcquisition||decisionHash(JSON.parse(freshAcquisition))!==decisionHash(receipt.read.comparisonRecovery)||entryPrompt.entryExecutionMethod&&entryPrompt.entryExecutionMethod!==receipt.read.entryExecutionMethod)throw Error('SHARED_PROOF_INVALID');
              const full:AttentionRead={...receipt.read,rawArtifacts:b.rawArtifacts};
              const q=full.comparisonRecovery!;
              if(q.method!=='comparison-acquisition-v1'||!Array.isArray(q.recoveryQueries)||!Array.isArray(q.sourceLineage)||!Array.isArray(q.selectedLeadIds)||typeof q.recoveryCapped!=='boolean'||q.accessGapMethod!==undefined&&q.accessGapMethod!=='own-acquired-alternates-v1'||entryPrompt.accessGapMethod!==undefined&&entryPrompt.accessGapMethod!==q.accessGapMethod)throw Error('SHARED_PROOF_INVALID');
              const base=decodeSubmittedAttention(full,b.rawArtifacts),target=comparisonTargetContext(full,base.proposal,base.review,b.token,receipt.cutoff),plan=comparisonRequiredRecoveryPlan(full,b.token,target.narrativeClaims);
              if(full.leadershipPositiveMethod){const {entryDecisions,leadershipScreening,...factualReview}=receipt.review??{};if(decisionHash(base.proposal)!==decisionHash(receipt.proposal)||decisionHash(base.review)!==decisionHash(factualReview))throw Error('SHARED_PROOF_INVALID');}
              if(decisionHash(q.selectedLeadIds)!==decisionHash(plan.selectedLeadIds))throw Error('SHARED_PROOF_INVALID');
              let expected:Array<{query:string;parentLeadId:string}>=[];
              if(plan.selectedLeadIds.length){
                if(b.rawArtifacts['attention-comparison-recovery-plan-prompt']!==JSON.stringify(plan.packet))throw Error('SHARED_PROOF_INVALID');
                const decoded=plan.decode(parseSourceResponse(b.rawArtifacts['attention-comparison-recovery-plan-response']));
                expected=decoded.queries.map((query,i)=>({query,parentLeadId:decoded.queryParents[i]}));
              }
              if(expected.length!==q.recoveryQueries.length)throw Error('SHARED_PROOF_INVALID');
              for(const [i,query]of q.recoveryQueries.entries()){
                const e=b.evidence.find(e=>e.id===query.queryId&&e.sourceId==='tinyfish-search'&&e.accessMode==='FREE_ACCOUNT'),raw=e?JSON.parse(b.rawArtifacts[e.id]):null;
                if(query.queryId!=='attention-recovery-search-'+(i+1)||query.parentLeadId!==expected[i].parentLeadId||query.query!==expected[i].query||!Number.isFinite(Date.parse(query.availableAt))||Date.parse(query.availableAt)>Date.parse(receipt.cutoff)||e&&(!receipt.evidenceIds.includes(e.id)||e.availableAt!==query.availableAt)||!['OBSERVED','NO_RESULTS','INVALID','UNAVAILABLE'].includes(query.state)||query.state==='UNAVAILABLE'&&(e||raw)||query.state==='INVALID'&&!e)throw Error('SHARED_PROOF_INVALID');
                if(['OBSERVED','NO_RESULTS'].includes(query.state)&&(!e||!Array.isArray(raw?.results)||raw.error||raw.errors&&(!Array.isArray(raw.errors)||raw.errors.length)||raw.results.length!==query.resultCount||query.state!==(raw.results.length?'OBSERVED':'NO_RESULTS')||!query.descriptorComplete||raw.results.some((r:{url?:unknown})=>typeof r?.url!=='string')))throw Error('SHARED_PROOF_INVALID');
              }
              const leads=full.comparisonAcquisition!.leads;
              if(decisionHash(q.sourceLineage)!==decisionHash(leads.map(l=>({leadId:l.id,queryIds:l.recoveryQueryIds,sourceIds:l.recoverySourceIds}))))throw Error('SHARED_PROOF_INVALID');
              for(const lead of leads){
                const descriptor=JSON.parse(b.rawArtifacts[lead.metadataEvidenceId]??'null'),row=JSON.parse(b.rawArtifacts[lead.searchArtifactId]??'null')?.results?.[lead.resultIndex];
                if(!descriptor||!row||descriptor.searchArtifactId!==lead.searchArtifactId||descriptor.resultIndex!==lead.resultIndex||descriptor.url!==row.url||descriptor.title!==(row.title??'')||descriptor.snippet!==(row.snippet??'')||lead.title!==descriptor.title||lead.snippet!==descriptor.snippet||lead.url!==descriptor.normalizedUrl||lead.recoveryQueryIds.some(id=>!q.recoveryQueries.some(query=>query.queryId===id&&query.parentLeadId===lead.id))||lead.recoverySourceIds.some(id=>!full.sources.some(source=>source.id===id)))throw Error('SHARED_SOURCE_INVALID');
              }
            }
            if(receipt.review?.entryDecisions){
              if(!binaryMode)throw Error('SHARED_PROOF_INVALID');
              for(const id of ['attention-leadership-proposal-response','attention-leadership-review-response'])if(!receipt.evidenceIds.includes(id)||!b.evidence.some(e=>e.id===id&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT'))throw Error('SHARED_PROOF_REQUIRED');
              const fullRead={...receipt.read,rawArtifacts:b.rawArtifacts,sources:receipt.read.sources.map((s:{id:string;text:string})=>({...s,text:b.rawArtifacts[s.id]??s.text}))};
              if(decisionHash(decodeBinaryEntryDecisions(fullRead,receipt.proposal,receipt.review,b.token,receipt.cutoff,b.rawArtifacts))!==decisionHash(receipt.review.entryDecisions))throw Error('SHARED_PROOF_INVALID');
            }
            if(binaryMode&&b.rawArtifacts['attention-leadership-review-response']){let completed=false;try{const response=parseSourceResponse(b.rawArtifacts['attention-leadership-review-response']);if(receipt.read.entryEvidenceMethod){resolvePublicEntryDecision(response,{...receipt.read,rawArtifacts:b.rawArtifacts,sources:receipt.read.sources.map((s:{id:string;text:string})=>({...s,text:b.rawArtifacts[s.id]??s.text}))},b.token,receipt.cutoff,receipt.proposal,receipt.review);completed=true;}else completed=(receipt.read.comparisonQualification?.entryCitationMethod==='single-required-citation-v1'?scopedLeadershipReviewSchema:receipt.read.comparisonQualification?.entryScopeMethod==='code-owned-origin-scope-v1'?binaryLeadershipReviewSchema.omit({sourceIds:true}):binaryLeadershipReviewSchema).safeParse(response).success;}catch{}if(completed&&!receipt.review?.entryDecisions)throw Error('SHARED_PROOF_REQUIRED');}
            if(receipt.read.comparisonQualification?.wireMethod==='comparison-lead-tasks-v5'&&b.rawArtifacts['attention-leadership-proposal-response']&&b.rawArtifacts['attention-leadership-review-response']){
              let completed=false;try{completed=leadershipSupportProposalSchema.safeParse(parseSourceResponse(b.rawArtifacts['attention-leadership-proposal-response'])).success&&leadershipSupportReviewSchema.safeParse(parseSourceResponse(b.rawArtifacts['attention-leadership-review-response'])).success;}catch{/* An honest malformed/interrupted review is not a completed proof. */}
              if(completed&&receipt.review?.leadershipScreening?.method!=='reviewed-public-support-v2')throw Error('SHARED_PROOF_REQUIRED');
            }
            if(receipt.review?.leadershipScreening){
              const screening=receipt.review.leadershipScreening;
              for(const id of ['attention-leadership-proposal-response','attention-leadership-review-response'])if(!receipt.evidenceIds.includes(id)||!b.evidence.some(e=>e.id===id&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT'))throw new Error('SHARED_PROOF_REQUIRED');
              if(screening.method==='reviewed-public-support-v2'){
                const fullRead={...receipt.read,rawArtifacts:b.rawArtifacts,sources:receipt.read.sources.map((s:{id:string;text:string})=>({...s,text:b.rawArtifacts[s.id]??s.text}))};
                if(decisionHash(decodeLeadershipSupport(fullRead,receipt.proposal,receipt.review,b.token,receipt.cutoff,b.rawArtifacts))!==decisionHash(screening))throw Error('SHARED_PROOF_INVALID');
              }else{
              const selected=parseSourceResponse(b.rawArtifacts['attention-leadership-proposal-response']),independent=parseSourceResponse(b.rawArtifacts['attention-leadership-review-response']);
              const normalized=normalizeComparisonRefs(selected,receipt.read.sources);
              if(decisionHash(screening)!==decisionHash({method:'reviewed-public-support-v1',...normalized as object,review:independent}))throw new Error('SHARED_PROOF_INVALID');
              const prompt=JSON.parse(b.rawArtifacts['attention-leadership-proposal-prompt']),reviewPrompt=JSON.parse(b.rawArtifacts['attention-leadership-review-prompt']);
              if(decisionHash(prompt.entryCriterion)!==decisionHash(leadershipEntryCriterion({...receipt.read,sources:receipt.read.sources.map((s:{id:string;text:string})=>({...s,text:b.rawArtifacts[s.id]??s.text}))},receipt.proposal,receipt.review,b.token,receipt.cutoff))||decisionHash(reviewPrompt.entryCriterion)!==decisionHash(prompt.entryCriterion))throw new Error('SHARED_PROOF_INVALID');
              const fullSources=receipt.read.sources.filter((s:{id:string})=>receipt.read.originScope?.sourceIds.includes(s.id)).map((s:{id:string;text:string})=>{const {text,...info}=s;return {...info,spans:sourceSpans(s.id,b.rawArtifacts[s.id]??text)};});
              if(tokenKey(prompt.token)!==tokenKey(b.token)||tokenKey(reviewPrompt.token)!==tokenKey(b.token)||decisionHash(prompt.comparisonQualification)!==decisionHash(receipt.read.comparisonQualification)||decisionHash(reviewPrompt.comparisonQualification)!==decisionHash(receipt.read.comparisonQualification)||decisionHash(prompt.originEvidenceScope)!==decisionHash(receipt.read.originScope)||decisionHash(prompt.sources)!==decisionHash(fullSources)||decisionHash(reviewPrompt.sources)!==decisionHash(fullSources)||decisionHash(reviewPrompt.screening)!==decisionHash(selected)||decisionHash(reviewPrompt.originEvidenceScope)!==decisionHash(receipt.read.originScope))throw new Error('SHARED_PROOF_INVALID');
              }
            }
            if(receipt.read.originRecovery){
              const marker=b.evidence.find(e=>e.id==='attention-origin-recovery-scope'&&e.sourceId==='attention-collector'&&e.accessMode==='LOCAL_DERIVED');
              if(!marker||decisionHash(JSON.parse(b.rawArtifacts[marker.id]))!==decisionHash(receipt.read.originRecovery))throw new Error('SHARED_PROOF_INVALID');
              const recovery=receipt.read.originRecovery;
              if(!Array.isArray(recovery.aliases)||recovery.aliases.length>1||!Array.isArray(recovery.comparisonSupplementIds)||recovery.comparisonSupplementIds.length>2)throw new Error('SHARED_PROOF_INVALID');
              const sources=receipt.read.sources.map((s:{id:string;text:string})=>({...s,text:b.rawArtifacts[s.id]??s.text}));
              if(recovery.aliases.some((a:Parameters<typeof verifyOriginAlias>[0])=>!verifyOriginAlias(a,sources,b.rawArtifacts)))throw new Error('SHARED_PROOF_INVALID');
              for(const id of recovery.comparisonSupplementIds){const source=sources.find((s:{id:string})=>s.id===id),response=JSON.parse(b.rawArtifacts['attention-origin-fetch-1']),url=`https://api.dexscreener.com/token-pairs/v1/${b.token.chain}/${b.token.address}`;
                const result=response.results?.find((r:{url:string;final_url?:string;text?:string})=>r.url===source?.url&&(r.final_url??r.url)===r.url&&typeof r.text==='string');
                if(!source||source.kind!=='PAGE'||source.authorId!==null||source.publishedAt!==null||!result||source.text!==result.text.replace(/\\_/g,'_'))throw new Error('SHARED_PROOF_INVALID');
                if(source.url===url){const pairs=JSON.parse(source.text);if(!Array.isArray(pairs)||!pairs.some(p=>p.chainId===b.token.chain&&(p.baseToken?.address===b.token.address||p.quoteToken?.address===b.token.address)))throw new Error('SHARED_PROOF_INVALID');}
                else if(b.token.chain!=='solana'||!receipt.read.comparisonAcquisition?.leads.some((lead:{url:string|null;acquisitionStatus:string})=>lead.acquisitionStatus!=='ACQUIRED'&&geckoPoolBinding(source,lead.url)))throw new Error('SHARED_PROOF_INVALID');
              }
            }
            if(receipt.read.originExclusions){
              const marker=b.evidence.find(e=>e.id==='attention-origin-exclusion-scope'&&e.sourceId==='attention-collector'&&e.accessMode==='LOCAL_DERIVED');
              for(const item of receipt.read.originExclusions){const prefix=`attention-origin-role-${item.index}`;for(const suffix of ['proposal-response','review-response','search','fetch']){const id=prefix+'-'+suffix;if(!receipt.evidenceIds.includes(id)||!b.evidence.some(e=>e.id===id&&e.accessMode==='FREE_ACCOUNT'&&e.sourceId===(suffix==='search'?'tinyfish-search':suffix==='fetch'?'tinyfish-fetch':'gemini')))throw new Error('SHARED_PROOF_REQUIRED');}}
              const full={...receipt.read,rawArtifacts:b.rawArtifacts,sources:receipt.read.sources.map((s:{id:string;text:string})=>({...s,text:b.rawArtifacts[s.id]??s.text}))};
              if(!marker||decisionHash(JSON.parse(b.rawArtifacts[marker.id]))!==decisionHash(receipt.read.originExclusions)||!Array.isArray(receipt.read.originExclusions)||receipt.read.originExclusions.length>2||receipt.read.originExclusions.some((item:Parameters<typeof verifiedOriginExclusion>[1])=>!verifiedOriginExclusion(full,item,b.token)))throw new Error('SHARED_PROOF_INVALID');
            }
            if(receipt.read.metadataLinks){
              const metadata=b.evidence.find(e=>e.id==='discovery-token-metadata'&&e.sourceId==='token-metadata-discovery'&&e.accessMode==='PUBLIC_API'&&e.scope.mint===b.token.address);
              if(!metadata||decodeTokenMetadataUri(b.rawArtifacts[metadata.id],b.token.address).uri!==receipt.read.metadataUri||!receipt.read.discoveryUrls.includes(receipt.read.metadataUri))throw new Error('SHARED_SOURCE_INVALID');
              for(const source of receipt.read.sources.filter((s:{discoveredFrom?:string})=>s.discoveredFrom))if(b.evidence.find(e=>e.id===source.id)?.scope.discoveredFrom!==source.discoveredFrom)throw new Error('SHARED_SOURCE_INVALID');
            }
            if(tokenKey(receipt.token)!==tokenKey(b.token)||Date.parse(receipt.cutoff)>Date.parse(b.cutoff)||!Array.isArray(receipt.evidenceIds)||receipt.evidenceIds.some((id:string)=>!ids.has(id)))throw new Error('SHARED_PROOF_INVALID');
            if(receipt.read.originScope){
              for(const id of ['attention-search-1','attention-search-2']){const search=b.evidence.find(e=>e.id===id&&e.sourceId==='tinyfish-search'&&e.accessMode==='FREE_ACCOUNT');if(search&&(decisionHash(search.scope.discoveryUrls??[])!==decisionHash(receipt.read.discoveryUrls??[])||decisionHash(search.scope.queries??[])!==decisionHash(receipt.read.queries??[])))throw new Error('SHARED_PROOF_INVALID');}
              if(decisionHash(receipt.read.originScope)!==decisionHash(originSourceScope({...receipt.read,rawArtifacts:b.rawArtifacts,sources:receipt.read.sources.map((s:{id:string;text:string})=>({...s,text:b.rawArtifacts[s.id]??s.text}))},b.token)))throw new Error('SHARED_PROOF_INVALID');
            }
            {
              const full:AttentionRead={...receipt.read,rawArtifacts:b.rawArtifacts,sources:receipt.read.sources.map((source:{id:string;text:string})=>({...source,text:b.rawArtifacts[source.id]??source.text}))};
              let decoded:ReturnType<typeof decodeNarrativePublicSupport>|undefined;
              const marked=receipt.read.narrativePublicSupport!==undefined||b.rawArtifacts['attention-narrative-public-support']!==undefined;
              try{if(b.rawArtifacts['attention-narrative-support-proposal-response']&&b.rawArtifacts['attention-narrative-support-review-response']){const base=decodeSubmittedAttention(full,b.rawArtifacts);decoded=decodeNarrativePublicSupport(full,b.token,base.proposal,base.review,b.rawArtifacts);}}catch{if(marked)throw Error('SHARED_PROOF_INVALID');}
              if(marked||decoded){
                if(!decoded||!receipt.read.narrativePublicSupport||!b.rawArtifacts['attention-narrative-public-support'])throw Error('SHARED_PROOF_REQUIRED');
                for(const id of decoded.responseIds)if(!receipt.evidenceIds.includes(id)||!b.evidence.some(e=>e.id===id&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT'))throw Error('SHARED_PROOF_REQUIRED');
                if(!b.evidence.some(e=>e.id==='attention-narrative-public-support'&&e.sourceId==='attention-collector'&&e.accessMode==='LOCAL_DERIVED')||decisionHash(decoded.receipt)!==decisionHash(receipt.read.narrativePublicSupport)||decisionHash(decoded.receipt)!==decisionHash(JSON.parse(b.rawArtifacts['attention-narrative-public-support'])))throw Error('SHARED_PROOF_INVALID');
              }
            }
            for(const claim of receipt.proposal?.claims?.filter((c:{originBasis?:string})=>c.originBasis==='PUBLIC_EVIDENCE_INADEQUATE')??[]){
              const wire=parseSourceResponse(b.rawArtifacts['attention-proposal-response']) as {claims:Array<Record<string,unknown>>};
              const reviewer=parseSourceResponse(b.rawArtifacts['attention-review-response']) as {decisions:Record<string,unknown>;originScopeReview?:unknown};
              const candidate=wire.claims.find(c=>c.id===claim.id),stored=receipt.review?.decisions.find((d:{id:string})=>d.id===claim.id);
              if(!candidate||!stored||decisionHash(reviewer.originScopeReview??null)!==decisionHash(receipt.review.originScopeReview??null)||decisionHash(reviewer.decisions[claim.id])!==decisionHash({accepted:stored.accepted,rationale:stored.rationale}))throw new Error('SHARED_PROOF_INVALID');
              const citations=(candidate.citations as Array<{sourceId:string;spanId:string}>).map(ref=>{const source=receipt.read.sources.find((s:{id:string})=>s.id===ref.sourceId),span=source&&sourceSpans(source.id,attentionSourceText(receipt.read,source.text)).find(s=>s.id===ref.spanId);if(!span)throw new Error('SHARED_PROOF_INVALID');return {sourceId:ref.sourceId,quote:span.text};});
              if(decisionHash({...candidate,citations})!==decisionHash(claim))throw new Error('SHARED_PROOF_INVALID');
            }
            const localEmptyAttention=receipt.read.sources.length===0&&['claims','posts','competitors'].every(key=>Array.isArray(receipt.proposal?.[key])&&receipt.proposal[key].length===0)&&Array.isArray(receipt.review?.decisions)&&receipt.review.decisions.length===0&&receipt.review.candidateSet?.complete!==true&&(!receipt.review.originRelationship||receipt.review.originRelationship.status==='UNKNOWN');
            if(receipt.proposal&&receipt.review&&!localEmptyAttention&&!['attention-proposal-response','attention-review-response'].every(id=>receipt.evidenceIds.includes(id)&&b.evidence.some(e=>e.id===id&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT')))throw new Error('SHARED_PROOF_REQUIRED');
            if(receipt.read.comparisonComplete&&receipt.proposal&&receipt.review&&!b.evidence.some(e=>e.id==='attention-comparison-final-review-response'&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT'))throw new Error('SHARED_PROOF_REQUIRED');
            if(receipt.read.comparisonQualification?.evidenceAdequacy){
              if(!['attention-comparison-lead-proposal-response','attention-comparison-lead-review-response'].every(id=>receipt.evidenceIds.includes(id)&&b.evidence.some(e=>e.id===id&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT')))throw new Error('SHARED_PROOF_REQUIRED');
              const lead=receipt.read.comparisonAcquisition?.leads.find((l:{id:string})=>l.id===receipt.read.comparisonQualification.evidenceAdequacy.leadId);
              if(!lead||lead.recoveryQueryIds.some((id:string)=>!receipt.evidenceIds.includes(id)||!b.evidence.some(e=>e.id===id&&e.sourceId==='tinyfish-search'&&e.accessMode==='FREE_ACCOUNT')))throw new Error('SHARED_PROOF_REQUIRED');
            }
            if(['qualified-identified-leads-v2','qualified-identified-leads-v3'].includes(receipt.read.comparisonQualification?.mode)){
              const fresh=receipt.read.comparisonQualification.mode==='qualified-identified-leads-v3';
              const parsedScope=(fresh?comparisonScopeV3Schema:comparisonScopeV2Schema).safeParse(receipt.read.comparisonQualification);
              if(!parsedScope.success)throw new Error('SHARED_PROOF_INVALID');
              const q=parsedScope.data;
              if(fresh){const marker=b.evidence.find(e=>e.id==='comparison-lead-qualification'&&e.sourceId==='attention-collector'&&e.accessMode==='LOCAL_DERIVED');if(!marker||!receipt.evidenceIds.includes(marker.id))throw new Error('SHARED_PROOF_REQUIRED');if(decisionHash(JSON.parse(b.rawArtifacts[marker.id]))!==decisionHash(receipt.read.comparisonQualification))throw new Error('SHARED_PROOF_INVALID');}
              for(const lead of receipt.read.comparisonAcquisition.leads){
                const e=b.evidence.find(e=>e.id===lead.metadataEvidenceId&&e.sourceId==='attention-collector'&&e.sourceType==='INDEXED_LEAD'&&e.accessMode==='LOCAL_DERIVED'),d=e?JSON.parse(b.rawArtifacts[e.id]):null;
                const search=b.evidence.find(e=>e.id===lead.searchArtifactId&&e.sourceId==='tinyfish-search'&&e.accessMode==='FREE_ACCOUNT'),row=search?JSON.parse(b.rawArtifacts[search.id]).results?.[lead.resultIndex]:null;
                if(!d||!row||d.searchArtifactId!==lead.searchArtifactId||d.resultIndex!==lead.resultIndex||d.url!==row.url||d.title!==(row.title??'')||d.snippet!==(row.snippet??'')||lead.title!==d.title||lead.snippet!==d.snippet||lead.url!==d.normalizedUrl)throw new Error('SHARED_SOURCE_INVALID');
                if(d.urlMethod!==undefined&&(d.urlMethod!=='tinyfish-search-redirect-v1'||typeof row.url!=='string'||!row.url.startsWith('/url?')||d.normalizedUrl!==normalizeAttentionSearchUrl(row.url)))throw new Error('SHARED_SOURCE_INVALID');
              }
              const response=(id:string)=>{if(!receipt.evidenceIds.includes(id)||!b.evidence.some(e=>e.id===id&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT'))throw new Error('SHARED_PROOF_REQUIRED');return parseSourceResponse(b.rawArtifacts[id]) as {decisions:Record<string,Record<string,unknown>>;leads:Record<string,{queries:string[];metadataRefs:Array<{sourceId:string;spanId:string}>}>};};
              const metadata=b.evidence.filter(e=>receipt.evidenceIds.includes(e.id)&&e.sourceId==='attention-collector'&&e.sourceType==='INDEXED_LEAD').map(e=>{const d=JSON.parse(b.rawArtifacts[e.id]);return {id:e.id,text:d.title+'\n'+d.snippet,url:d.normalizedUrl??d.url,leadId:d.originalLeadId};});
              const catalog=[...receipt.read.sources.map((s:{id:string;text:string})=>({id:s.id,text:s.text.slice(0,6000)})),...metadata];
              const originalWire=response('attention-comparison-lead-proposal-response'),reviewWire=response('attention-comparison-lead-review-response');
              let original:any,review:any;
              const taskRoute=q.wireMethod==='comparison-lead-tasks-v2'||q.wireMethod==='comparison-lead-tasks-v3'||q.wireMethod==='comparison-lead-tasks-v4'||q.wireMethod==='comparison-lead-tasks-v5';
              if(taskRoute){
                if(!['comparison-lead-support-scope-v3','comparison-lead-support-scope-v4'].includes(String(q.supportScopeMethod))||q.supportScopeMethod==='comparison-lead-support-scope-v4'&&q.wireMethod!=='comparison-lead-tasks-v3'&&q.wireMethod!=='comparison-lead-tasks-v4'&&q.wireMethod!=='comparison-lead-tasks-v5'||(q.wireMethod==='comparison-lead-tasks-v4'||q.wireMethod==='comparison-lead-tasks-v5')&&q.supportScopeMethod!=='comparison-lead-support-scope-v4'||q.targetContextMethod!=='comparison-target-context-v1'||q.supportSelection)throw Error('SHARED_PROOF_INVALID');
                const full={...receipt.read,rawArtifacts:b.rawArtifacts,sources:receipt.read.sources.map((s:{id:string;text:string})=>({...s,text:b.rawArtifacts[s.id]??s.text}))};
                const base=decodeSubmittedAttention(full,b.rawArtifacts),target=comparisonTargetContext(full,base.proposal,base.review,b.token,receipt.cutoff);
                if(decisionHash(q.targetContext??null)!==decisionHash(target))throw Error('SHARED_PROOF_INVALID');
                const selected=decodeComparisonLeadTasks(full,b.token,target,b.rawArtifacts,q.wireMethod==='comparison-lead-tasks-v5'?'comparison-lead-tasks-v5':q.wireMethod==='comparison-lead-tasks-v4'?'comparison-lead-tasks-v4':q.wireMethod==='comparison-lead-tasks-v3'?'comparison-lead-tasks-v3':'comparison-lead-tasks-v2');
                for(const id of selected.responseIds)response(id);
                if(q.proposalResponseId!==selected.proposalResponseId)throw Error('SHARED_PROOF_INVALID');
                original=selected.proposal;review=selected.review;
              }else{
                if(q.supportScopeMethod==='comparison-lead-support-scope-v3'||q.supportScopeMethod==='comparison-lead-support-scope-v4')throw Error('SHARED_PROOF_INVALID');
              const compact=q.wireMethod==='comparison-lead-array-v1'||fresh;
              const scopeV2=q.supportScopeMethod==='comparison-lead-support-scope-v2';
              const newScope=scopeV2||q.supportScopeMethod==='comparison-lead-support-scope-v1';
              const decode=fresh?((value:unknown,leads:Parameters<typeof decodeComparisonLeadAccounting>[1],sources:Parameters<typeof decodeComparisonLeadAccounting>[2],metadata:Parameters<typeof decodeComparisonLeadAccounting>[3],review=false)=>decodeComparisonLeadAccounting(value,leads,sources,metadata,review,newScope,scopeV2)):decodeComparisonLeadArray;
              let selectedWire=originalWire;
              if(q.proposalResponseId){
                const marker=b.evidence.find(e=>e.id==='comparison-lead-wire-repair'&&e.sourceId==='attention-collector'&&e.accessMode==='LOCAL_DERIVED');
                if(!compact||!marker||!receipt.evidenceIds.includes(marker.id))throw new Error('SHARED_PROOF_REQUIRED');
                const selection=JSON.parse(b.rawArtifacts[marker.id]);
                if(selection.method!=='comparison-lead-reference-repair-v1'||selection.code!=='ATT_MODEL_COMPARISON_LEAD_REF_INVALID'||selection.originalResponseId!=='attention-comparison-lead-proposal-response'||selection.selectedResponseId!==q.proposalResponseId)throw new Error('SHARED_PROOF_INVALID');
                let invalid=false;try{decode(originalWire,receipt.read.comparisonAcquisition.leads,receipt.read.sources,metadata);}catch(error){invalid=error instanceof Error&&error.message==='ATT_MODEL_COMPARISON_LEAD_REF_INVALID';}
                if(!invalid)throw new Error('SHARED_PROOF_INVALID');
                if(typeof q.proposalResponseId!=='string')throw new Error('SHARED_PROOF_INVALID');selectedWire=response(q.proposalResponseId);
              }
              original=compact?decode(selectedWire,receipt.read.comparisonAcquisition.leads,receipt.read.sources,metadata):selectedWire;
              review=compact?decode(reviewWire,receipt.read.comparisonAcquisition.leads,receipt.read.sources,metadata,true):reviewWire;
              if(fresh){
                const full={...receipt.read,rawArtifacts:b.rawArtifacts,sources:receipt.read.sources.map((s:{id:string;text:string})=>({...s,text:b.rawArtifacts[s.id]??s.text}))};
                const initial=parseSourceResponse(b.rawArtifacts['attention-proposal-response']) as {claims:Array<{id:string;feature:string;value:boolean}>};
                const initialReview=parseSourceResponse(b.rawArtifacts['attention-review-response']) as {decisions:Record<string,{accepted:boolean}>};
                const narrative=initial.claims.filter(c=>c.feature==='A01'&&c.value&&initialReview.decisions[c.id]?.accepted).map(c=>attentionProposalSchema.shape.claims.element.parse(normalizeComparisonRefs(c,full.sources.map((s:{id:string;text:string})=>({...s,text:s.text.slice(0,6000)})))));
                const base=newScope?decodeSubmittedAttention(full,b.rawArtifacts):undefined;
                const target=newScope?comparisonTargetContext(full,base!.proposal,base!.review,b.token,receipt.cutoff):undefined;
                if(newScope&&(q.targetContextMethod!=='comparison-target-context-v1'||decisionHash(q.targetContext??null)!==decisionHash(target)))throw Error('SHARED_PROOF_INVALID');
                const context=comparisonAccountingContext(full,b.token,newScope?target!.narrativeClaims:narrative,target,scopeV2?'comparison-lead-support-scope-v2':'comparison-lead-support-scope-v1');
                if(q.proposalResponseId&&b.rawArtifacts['attention-comparison-lead-repair-proposal-prompt']!==JSON.stringify({instruction:comparisonInstruction(comparisonAccountingReferenceRepairInstruction,newScope,scopeV2),...context,initialInvalidProposal:comparisonAccountingArraySchema.parse(originalWire),localError:'ATT_MODEL_COMPARISON_LEAD_REF_INVALID',...(newScope?{referenceObligations:comparisonReferenceRepairDetails(originalWire,full.comparisonAcquisition.leads,q.literalSelectorRepairMethod==='bound-literal-options-v1'?context.eligibleCorroboration:undefined)}:{})}))throw new Error('SHARED_PROOF_INVALID');
                let selected=false;
                const repairIds=['attention-comparison-lead-support-proposal-response','attention-comparison-lead-support-review-response'];
                if(repairIds.every(id=>b.rawArtifacts[id])&&comparisonLeadSupportRepairEligible(original,review)&&receipt.read.comparisonAcquisition.searchSucceeded&&receipt.read.comparisonAcquisition.descriptorComplete&&!q.recoveryCapped&&q.recoveryQueries.every(r=>['OBSERVED','NO_RESULTS'].includes(r.state)&&r.descriptorComplete)){
                  try{
                    const repaired=decodeComparisonLeadAccounting(response(repairIds[0]),full.comparisonAcquisition.leads,full.sources,metadata,false,newScope,scopeV2),checked=decodeComparisonLeadAccounting(response(repairIds[1]),full.comparisonAcquisition.leads,full.sources,metadata,true,newScope);
                    if(b.rawArtifacts['attention-comparison-lead-support-proposal-prompt']!==JSON.stringify({instruction:comparisonInstruction(comparisonLeadSupportInstruction,newScope,scopeV2),...context,initialProposal:original,initialReview:review})||b.rawArtifacts['attention-comparison-lead-support-review-prompt']!==JSON.stringify({instruction:comparisonInstruction(comparisonAccountingReviewInstruction,newScope,scopeV2),...context,proposal:repaired}))throw new Error('SHARED_PROOF_INVALID');
                    if(comparisonLeadSupportRepairValid(original,review,repaired,checked)){selected=true;}
                    if(selected!== (q.supportSelection===true))throw new Error('SHARED_PROOF_INVALID');
                    // Check the original prompts before selecting the replacement below.
                  }catch(error){if(q.supportSelection===true||error instanceof Error&&/^SHARED_/.test(error.message))throw error;}
                }
                if(q.supportSelection===true&&!selected)throw new Error('SHARED_PROOF_REQUIRED');
                if(b.rawArtifacts['attention-comparison-lead-proposal-prompt']!==JSON.stringify({instruction:comparisonInstruction(comparisonAccountingInstruction,newScope,scopeV2),...context})||b.rawArtifacts['attention-comparison-lead-review-prompt']!==JSON.stringify({instruction:comparisonInstruction(comparisonAccountingReviewInstruction,newScope,scopeV2),...context,proposal:original}))throw new Error('SHARED_PROOF_INVALID');
                if(selected){original=decodeComparisonLeadAccounting(response(repairIds[0]),full.comparisonAcquisition.leads,full.sources,metadata,false,newScope,scopeV2);review=decodeComparisonLeadAccounting(response(repairIds[1]),full.comparisonAcquisition.leads,full.sources,metadata,true,newScope);}
              }
              }
              const normalized=normalizeComparisonRefs(original,catalog) as {decisions:Record<string,Record<string,unknown>>};
              const stored=receipt.read.comparisonQualification;
              if(decisionHash(normalized)!==decisionHash(stored.proposal)||decisionHash(review)!==decisionHash(stored.review)||decisionHash(Object.keys(normalized.decisions).sort())!==decisionHash(q.decisions.map(d=>d.leadId).sort())||decisionHash(Object.keys(review.decisions).sort())!==decisionHash(q.decisions.map(d=>d.leadId).sort()))throw new Error('SHARED_PROOF_INVALID');
              for(const d of q.decisions){const p=normalized.decisions[d.leadId],actual=Object.fromEntries(Object.keys(p).map(k=>[k,d[k]]));if(decisionHash(actual)!==decisionHash(p)||decisionHash(d.review)!==decisionHash(review.decisions[d.leadId]))throw new Error('SHARED_PROOF_INVALID');}
              let expectedQueries:Array<{parentLeadId:string;query:string}>;
              if(q.supportScopeMethod==='comparison-lead-support-scope-v4'){
                const full={...receipt.read,rawArtifacts:b.rawArtifacts,sources:receipt.read.sources.map((s:{id:string;text:string})=>({...s,text:b.rawArtifacts[s.id]??s.text}))};
                const base=decodeSubmittedAttention(full,b.rawArtifacts),target=comparisonTargetContext(full,base.proposal,base.review,b.token,receipt.cutoff),plan=comparisonRequiredRecoveryPlan(full,b.token,target.narrativeClaims);
                if(decisionHash(q.selectedLeadIds)!==decisionHash(plan.selectedLeadIds)||q.deferredLeadIds.length)throw Error('SHARED_PROOF_INVALID');
                if(plan.selectedLeadIds.length){
                  if(b.rawArtifacts['attention-comparison-recovery-plan-prompt']!==JSON.stringify(plan.packet))throw Error('SHARED_PROOF_INVALID');
                  const decoded=plan.decode(response('attention-comparison-recovery-plan-response'));
                  expectedQueries=decoded.queries.map((query,i)=>({query,parentLeadId:decoded.queryParents[i]}));
                }else expectedQueries=[];
              }else{
              const planned=q.selectedLeadIds.length?response('attention-comparison-recovery-plan-response').leads:{};
              if(decisionHash(Object.keys(planned).sort())!==decisionHash([...q.selectedLeadIds].sort()))throw new Error('SHARED_PROOF_INVALID');
                expectedQueries=q.selectedLeadIds.flatMap(parentLeadId=>{const item=planned[parentLeadId],lead=receipt.read.comparisonAcquisition.leads.find((l:{id:string})=>l.id===parentLeadId);if(!item||!lead||!Array.isArray(item.queries)||item.queries.length<1||item.queries.length>2||!item.metadataRefs.length||item.metadataRefs.some(ref=>ref.sourceId!==lead.metadataEvidenceId))throw new Error('SHARED_PROOF_INVALID');normalizeComparisonRefs(item.metadataRefs,metadata);return item.queries.map(query=>({parentLeadId,query}));});

              }
              if(expectedQueries.length!==q.recoveryQueries.length||new Set(expectedQueries.map(q=>q.query)).size!==expectedQueries.length)throw new Error('SHARED_PROOF_INVALID');
              for(const [i,query] of q.recoveryQueries.entries()){
                if(query.queryId!==`attention-recovery-search-${i+1}`||query.parentLeadId!==expectedQueries[i].parentLeadId||query.query!==expectedQueries[i].query)throw new Error('SHARED_PROOF_INVALID');
                if(['OBSERVED','NO_RESULTS'].includes(query.state)){
                  const e=b.evidence.find(e=>e.id===query.queryId&&e.sourceId==='tinyfish-search'&&e.accessMode==='FREE_ACCOUNT'),raw=e?JSON.parse(b.rawArtifacts[e.id]):null;
                  if(!e||!receipt.evidenceIds.includes(e.id)||e.availableAt!==query.availableAt||!Array.isArray(raw?.results)||raw.error||raw.errors&&(!Array.isArray(raw.errors)||raw.errors.length)||raw.results.length!==query.resultCount||query.state!==(raw.results.length?'OBSERVED':'NO_RESULTS')||!query.descriptorComplete||raw.results.some((r:{url?:unknown})=>!r||typeof r.url!=='string'))throw new Error('SHARED_PROOF_INVALID');
                }
              }
              const capture=b.evidence.find(e=>e.id==='live-state-capture'&&e.sourceId==='shared-collector'&&e.accessMode==='LOCAL_DERIVED');
              if(!capture)throw new Error('SHARED_PROOF_REQUIRED');
              const c=JSON.parse(b.rawArtifacts[capture.id]),canonical=b.evidence.filter(e=>e.sourceId==='solana-rpc'||e.id==='dex-pairs').map(e=>({id:e.id,retrievedAt:e.retrievedAt}));
              if(c.method!=='late-state-capture-v1'||tokenKey(c.token)!==tokenKey(b.token)||decisionHash(c.canonical)!==decisionHash(canonical)||c.discoveryId!==(b.evidence.some(e=>e.id==='dex-discovery')?'dex-discovery':null)||c.rpcState!==b.collection.rpc.state||c.dexState!==b.collection.dex.state||!Number.isFinite(Date.parse(c.startedAt))||!Number.isFinite(Date.parse(c.endedAt))||Date.parse(c.startedAt)>Date.parse(c.endedAt)||Date.parse(c.endedAt)>Date.parse(b.cutoff)||canonical.some(e=>Date.parse(e.retrievedAt)<Date.parse(c.startedAt)||Date.parse(e.retrievedAt)>Date.parse(c.endedAt))||b.evidence.some(e=>e.sourceId==='gemini'&&e.sourceType==='MODEL_RESPONSE'&&Date.parse(e.availableAt)>Date.parse(c.startedAt)))throw new Error('SHARED_PROOF_INVALID');
            }
            for(const source of receipt.read.sources){const e=b.evidence.find(e=>e.id===source.id);if(!e||e.sourceId!=='tinyfish-fetch'||e.accessMode!=='FREE_ACCOUNT'||!b.rawArtifacts[e.id].startsWith(source.text)||e.scope.url!==source.url||e.availableAt!==source.availableAt||e.scope.kind!==source.kind||e.scope.authorId!==source.authorId||e.scope.publishedAt!==source.publishedAt)throw new Error('SHARED_SOURCE_INVALID');}
            let completedAccounting=false;try{const p=parseSourceResponse(b.rawArtifacts['attention-comparison-lead-proposal-response']),r=parseSourceResponse(b.rawArtifacts['attention-comparison-lead-review-response']);completedAccounting=!!comparisonScopeV3Schema.safeParse(JSON.parse(b.rawArtifacts['comparison-lead-qualification']??'null')).success||!!(Array.isArray((p as {decisions?:unknown}).decisions)&&Array.isArray((r as {decisions?:unknown}).decisions)&&(r as {decisions:Array<{accounting?:unknown}>}).decisions.length&&(r as {decisions:Array<{accounting?:unknown}>}).decisions.every(d=>d.accounting));}catch{/* Failed/invalid requests may save honest UNKNOWN; a completed marked path cannot downgrade. */}
            const v3Artifacts=completedAccounting||!!b.rawArtifacts['attention-comparison-public-support']||Object.entries(b.rawArtifacts).some(([id,raw])=>/^(?:attention-comparison-\d+-proposal-|attention-comparison-manifest$)/.test(id)&&/comparison-lead-accounting-v1|comparison-lead-tasks-v2|comparison-lead-tasks-v3|comparison-lead-tasks-v4|comparison-lead-tasks-v5|sourceSupport|bodyObservations/.test(raw));
            if(v3Artifacts&&receipt.read.comparisonQualification?.mode!=='qualified-identified-leads-v3')throw new Error('SHARED_PROOF_REQUIRED');
            const markedComparison=receipt.read.comparisonCoverage!==undefined||b.rawArtifacts['attention-comparison-coverage']!==undefined||receipt.read.comparisonComplete===true&&Object.entries(b.rawArtifacts).some(([id,raw])=>/^attention-comparison-\d+-(?:repair-)?review-response$/.test(id)&&raw.includes('insufficiencyKind'));
            if(markedComparison){
              const fullRead:AttentionRead={...receipt.read,rawArtifacts:b.rawArtifacts,sources:receipt.read.sources.map((s:{id:string;text:string})=>({...s,text:b.rawArtifacts[s.id]??s.text}))};
              const marker=b.evidence.find(e=>e.id==='attention-comparison-coverage'&&e.sourceId==='attention-collector'&&e.accessMode==='LOCAL_DERIVED');
              if(!marker||!receipt.read.comparisonCoverage)throw new Error('SHARED_PROOF_REQUIRED');
              if(decisionHash(JSON.parse(b.rawArtifacts[marker.id]))!==decisionHash(receipt.read.comparisonCoverage))throw new Error('SHARED_PROOF_INVALID');
              const acquisition=fullRead.comparisonAcquisition,qualification=fullRead.comparisonQualification as {mode?:string;complete?:boolean;decisions?:Array<Parameters<typeof comparisonLeadIsQualified>[1]>;recoveryCapped?:boolean;accountingComplete?:boolean}|undefined;
              if(acquisition){
                const original=JSON.parse(b.rawArtifacts['attention-search-3']);
                if(!Array.isArray(original.results)||original.results.length!==acquisition.leads.length||acquisition.leadCount!==acquisition.leads.length)throw new Error('SHARED_SOURCE_INVALID');
                const metadata=b.evidence.filter(e=>receipt.evidenceIds.includes(e.id)&&e.sourceId==='attention-collector'&&e.sourceType==='INDEXED_LEAD').map(e=>{const d=JSON.parse(b.rawArtifacts[e.id]);return {id:e.id,text:d.title+'\n'+d.snippet,url:d.normalizedUrl??d.url,leadId:d.originalLeadId};});
                const lineage=comparisonSourceLineage(fullRead);
                for(const lead of acquisition.leads){
                  const actual=lineage.find(l=>l.leadId===lead.id)!;
                  if(decisionHash([...lead.sourceIds].sort())!==decisionHash([...actual.sourceIds].sort())||decisionHash([...lead.recoverySourceIds].sort())!==decisionHash([...actual.recoverySourceIds].sort()))throw new Error('SHARED_SOURCE_INVALID');
                  const d=qualification?.decisions?.find(d=>d.leadId===lead.id);
                  if(!d||('accounting'in d&&d.accounted!==comparisonLeadIsAccounted(lead,d,fullRead,metadata))||d.qualified!==comparisonLeadIsQualified(lead,d,fullRead.sources,metadata,b.token,qualification?.mode==='qualified-identified-leads-v2'||qualification?.mode==='qualified-identified-leads-v3',fullRead))throw new Error('SHARED_PROOF_INVALID');
                  // Successful original fetches remain part of the corpus even if a local receipt deletes their source.
                  for(const [id,raw] of Object.entries(b.rawArtifacts))if(/^attention-fetch-\d+(?:-retry-\d+)?$/.test(id))try{
                    for(const r of JSON.parse(raw).results??[])if(normalizeAttentionSearchUrl(r.url)===lead.url&&typeof r.text==='string'&&r.text.trim()&&r.text.trim().toLowerCase()!=='safety check'){
                      const record=b.evidence.find(e=>e.sourceId==='tinyfish-fetch'&&e.scope.url===normalizeAttentionFetchUrl(r.final_url??r.url)&&r.text.startsWith(b.rawArtifacts[e.id]??'')&&!!b.rawArtifacts[e.id]);
                      if(!record||!actual.sourceIds.includes(record.id)||!fullRead.comparisonSourceIds?.includes(record.id))throw new Error('SHARED_SOURCE_INVALID');
                    }
                  }catch(error){if(error instanceof Error&&error.message==='SHARED_SOURCE_INVALID')throw error;}
                }
                const expectedComplete=acquisition.searchSucceeded&&acquisition.descriptorComplete&&acquisition.leadCount===acquisition.leads.length&&acquisition.leads.length>0&&!qualification?.recoveryCapped&&!fullRead.codes.some(c=>/ATT_(?:PAGE|DESCRIPTOR)_CAP/.test(c))&&qualification?.decisions?.every(d=>d.qualified)===true;
                if(qualification?.mode==='qualified-identified-leads-v3'){const decisions=qualification.decisions as Parameters<typeof comparisonAccountingComplete>[1];if(qualification.accountingComplete!==comparisonAccountingComplete(fullRead,decisions)||qualification.decisions?.some(d=>!('accounting'in d)))throw new Error('SHARED_PROOF_INVALID');}else if(qualification?.complete!==expectedComplete)throw new Error('SHARED_PROOF_INVALID');
              }
              let reconstructed:ReturnType<typeof decodeComparisonCoverage>;
              try{reconstructed=decodeComparisonCoverage(fullRead,b.token,b.rawArtifacts);}catch(error){if(error instanceof Error&&/^SHARED_/.test(error.message))throw error;throw new Error('SHARED_PROOF_INVALID');}
              for(const id of reconstructed.responseIds)if(!receipt.evidenceIds.includes(id)||!b.evidence.some(e=>e.id===id&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT'))throw new Error('SHARED_PROOF_REQUIRED');
              const {leadershipScreening,entryDecisions,...comparisonReview}=receipt.review;
              if(decisionHash(reconstructed.publicSupport??null)!==decisionHash(receipt.read.comparisonPublicSupport??null)||decisionHash(reconstructed.coverage)!==decisionHash(receipt.read.comparisonCoverage)||decisionHash(reconstructed.proposal)!==decisionHash(receipt.proposal)||decisionHash(reconstructed.review)!==decisionHash(comparisonReview)||receipt.read.comparisonComplete!==reconstructed.coverage.complete)throw new Error('SHARED_PROOF_INVALID');
            }
            for(const length of receipt.read.comparisonQualification?.adequacySourceLengths??[]){const source=receipt.read.sources.find((s:{id:string})=>s.id===length.id);if(!source||!Number.isSafeInteger(length.retainedLength)||b.rawArtifacts[length.id]?.length!==length.retainedLength)throw new Error('SHARED_SOURCE_INVALID');}
            const fixedPosts=receipt.read.sources.filter((s:{id:string;kind:string})=>s.kind==='POST'&&(!receipt.read.postSampleSourceIds||receipt.read.postSampleSourceIds.includes(s.id)));
            const expectedSample={method:'fixed-query-sample-v1',sourceIds:fixedPosts.map((s:{id:string})=>s.id),queries:receipt.read.queries,complete:!!(receipt.read.postSampleComplete??receipt.read.complete)&&fixedPosts.every((s:{id:string;text:string;publishedAt:string|null})=>!!s.publishedAt&&Date.parse(s.publishedAt)<Date.parse(receipt.read.start)||b.rawArtifacts[s.id]===s.text)};
            if(decisionHash(receipt.read.growthSample)!==decisionHash(expectedSample))throw new Error('SHARED_PROOF_INVALID');
            const derived=deriveAttention({...receipt.read,rawArtifacts:b.rawArtifacts},receipt.proposal,receipt.review,b.token,receipt.cutoff,receipt.evidenceIds,true,!!details.groups);
            if(derived.some(a=>decisionHash(a)!==decisionHash(packet.baseline.find(x=>x.id===a.id))))throw new Error('SHARED_ATTENTION_INVALID');
            const originGrade=derived.find(a=>a.id==='A03'&&a.quality==='KNOWN'&&['origin-traceability-screen-v2','binary-public-support-v1','binary-public-support-v2','binary-public-support-v3','binary-public-support-v4'].includes((a.data as {method?:string}).method??''));
            if(originGrade){const d=originGrade.data as {summary:string;citations:Array<{sourceId:string;quote:string}>};const expected={kind:'ORIGIN',value:d.summary,evidenceId:d.citations[0].sourceId,quote:d.citations[0].quote,assertion:'MODEL_INFERENCE'};if(decisionHash(b.semantic.claims.filter(c=>c.kind==='ORIGIN'))!==decisionHash([expected]))throw Error('SHARED_ATTENTION_INVALID');}
            const socialRecord=b.evidence.find(e=>e.id==='social-derivation');
            const socialSources=socialRecord?JSON.parse(b.rawArtifacts[socialRecord.id]).read.sources:[];
            const metadataIds=packet.claims.flatMap(c=>c.citations.map(ref=>ref.sourceId)).filter(id=>b.evidence.some(e=>e.id===id&&e.sourceId==='attention-collector'&&e.sourceType==='INDEXED_LEAD'));
            const expectedIds=[...new Set([...receipt.read.sources,...socialSources].map((s:{id:string})=>s.id).concat(metadataIds))].sort();
            if(decisionHash(packet.sources.map(s=>s.id).sort())!==decisionHash(expectedIds))throw new Error('SHARED_SOURCE_INVALID');
          }
          if(packet.audit){
            const e=b.evidence.find(e=>e.id==='shared-qualified-receipt'&&e.sourceId==='shared-collector'&&e.accessMode==='LOCAL_DERIVED');if(!e)throw new Error('SHARED_PROOF_REQUIRED');
            const receipt=JSON.parse(b.rawArtifacts[e.id]);
            if(tokenKey(receipt.token)!==tokenKey(b.token)||decisionHash(receipt.claims)!==decisionHash(packet.claims)||decisionHash(receipt.sources)!==decisionHash(packet.sources)||decisionHash(receipt.audit)!==decisionHash(packet.audit)||!['shared-proposal-response','shared-review-response'].every(id=>b.evidence.some(e=>e.id===id&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT')))throw new Error('SHARED_PROOF_INVALID');
            if(receipt.wireMethod===undefined&&b.evidence.some(e=>e.id.startsWith('shared-repair-')))throw new Error('SHARED_PROOF_INVALID');
            const repair=receipt.wireMethod!==undefined&&receipt.proposalResponseId==='shared-repair-proposal-response';
            if(receipt.wireMethod!==undefined){
              if(receipt.wireMethod!=='shared-audit-wire-v2'||receipt.proposalResponseId!==(repair?'shared-repair-proposal-response':'shared-proposal-response')||receipt.reviewResponseId!==(repair?'shared-repair-review-response':'shared-review-response'))throw new Error('SHARED_PROOF_INVALID');
            }
            const stages=['proposal','review',...(repair?['repair-proposal','repair-review']:[])];
            if(stages.some(stage=>['prompt','response'].some(suffix=>!b.evidence.some(e=>e.id==='shared-'+stage+'-'+suffix&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT'))))throw new Error('SHARED_PROOF_REQUIRED');
            try{if(decisionHash(decodeSharedAuditProof(packet.claims,packet.sources,b.token,b.rawArtifacts,repair))!==decisionHash(receipt.audit))throw Error('SHARED_PROOF_INVALID');}catch{throw new Error('SHARED_PROOF_INVALID');}
          }
          const derived=deriveShared(effective);
          if(decisionHash(derived.facts)!==decisionHash(details.shared)||derived.assessments.some(a=>decisionHash(a)!==decisionHash(details.baseline.find(x=>x.id===a.id))||decisionHash(a.projection)!==decisionHash(b.features.find(f=>f.id===a.id))))throw new Error('SHARED_FACTS_INVALID');
        }
        for(const field of ['circulatingMarketCapUsd','tokenCreatedAt'] as const){const value=details.stageInputs[field];if(value!==null&&!b.observations.some(o=>o.field===field&&o.value===value&&o.quality==='KNOWN'&&o.evidenceIds.every(id=>b.evidence.find(e=>e.id===id)?.accessMode==='PUBLIC_API')))throw new Error('UNQUALIFIED_STAGE_INPUT');}
        if(details.groups&&decisionHash(entryGroupsForBundle({...b,details}))!==decisionHash(details.groups))throw Error('ENTRY_GROUP_FACTS_INVALID');
      }
    }
    if (b.thesis) {
      for (const p of [...b.thesis.support,...b.thesis.invalidation,...[b.thesis.catalyst,b.thesis.onchainTraction,b.thesis.externalTraction,b.thesis.warning].filter(x => x !== null),...b.thesis.legs.map(l => l.trigger)]) evaluatePredicate(p,[],b.cutoff);
    }
    return b;
  }
  private persistArtifacts(b: Bundle | LiveBundle) {
    if (!b.rawArtifacts) return;
    mkdirSync(this.artifactDir,{ recursive: true });
    for (const e of b.evidence) {
      const raw = b.rawArtifacts[e.id]; if (raw === undefined) continue;
      const final = join(this.artifactDir,e.contentHash);
      if (existsSync(final)) continue;
      const temp = join(this.artifactDir,`${e.contentHash}.${randomUUID()}.tmp`);
      writeFileSync(temp,raw,{ flag:'wx' }); renameSync(temp,final);
    }
  }
  private transact<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const v = fn(); this.db.exec('COMMIT'); return v; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  caseFor(token: TokenRef): { id: string; status: string; episodeId: string | null } | null {
    const row = this.db.prepare('SELECT id,status,episode_id FROM cases WHERE token_key=?').get(tokenKey(token));
    return row ? { id: String(row.id), status: String(row.status), episodeId: row.episode_id ? String(row.episode_id) : null } : null;
  }
  analyze(input: Bundle): EntrySnapshot { return this.analyzeCore(this.validateBundle(input)); }
  analyzeLive(input: LiveBundle): EntrySnapshot { return this.analyzeCore(this.validateBundle(input, true)); }
  private assessmentDetails(b:Bundle|LiveBundle,thesis=b.thesis??null):AssessmentDetails {
    if(b.analysisKind==='LIVE'&&b.details)return {...b.details,thesis,baseline:b.details.baseline.map(a=>a.id==='C10'?deriveBaseline({token:b.token,cutoff:b.cutoff,profile:b.profile,features:policyFeatures(b),evidence:b.evidence,observations:b.observations,thesis:thesis??undefined}).find(f=>f.id==='C10')!:a)};
    return {version:1,profile:b.profile,thesis,origins:{profile:'FROZEN_INPUT'},stageInputs:stageInputs(b),baseline:deriveBaseline({token:b.token,cutoff:b.cutoff,profile:b.profile,features:policyFeatures(b),evidence:b.evidence,observations:b.observations,thesis:thesis??undefined,research:b.analysisKind==='USER_IMPORT'?importedResearch(b):undefined})};
  }
  private analyzeCore(b: Bundle | LiveBundle): EntrySnapshot {
    this.persistArtifacts(b); const liveDetails=b.analysisKind==='LIVE'?b.details:undefined,social=liveDetails?.social,groups=liveDetails?.groups;
    const entryMode=['ENTRY_GATES_V1','ENTRY_GROUPS_V1'].includes(liveDetails?.shared?.qualityMode??'');
    const entryComparison=entryMode?comparisonEntryGrade(liveDetails!.baseline):undefined,entryGates=entryMode?attentionEntryGates(liveDetails!.baseline,!!liveDetails!.groups):undefined;
    const result = evaluateEntry(policyFeatures(b), b.profile, b.cutoff,social?.identityReview||social?.integrityReview?'QUALIFIED_V4':social?'QUALIFIED_V3':'QUALIFIED_V2',social,b.analysisKind==='LIVE'&&!!b.details?.shared,entryComparison,entryGates,groups);
    if (result.binary === 'PASS' && !b.thesis) throw new Error('PASS_REQUIRES_FROZEN_THESIS');
    const details=this.assessmentDetails(b);
    const semantic = { schemaVersion: 2, policyVersion: groups?'research-screen-shared-v4':b.analysisKind==='LIVE'&&b.details?.shared?(entryGates?'research-screen-shared-v3':entryComparison!==undefined?'research-screen-shared-v2':'research-screen-shared-v1'):social?.identityReview||social?.integrityReview?'research-screen-v4':social?'research-screen-v3':'research-screen-v2', ...(entryComparison!==undefined?{entryComparison}:{}),...(entryGates?{entryGates}:{}), featureVersion: social?2:1, token: b.token, cutoff: b.cutoff, analysisKind: b.analysisKind, features: b.features, policyFeatures:policyFeatures(b), evidence: b.evidence, profile: b.profile, thesis: b.thesis ?? null, result,details,
      ...(b.analysisKind === 'LIVE' ? { observations: b.observations, collection: b.collection, semantic: b.semantic, market: b.market } : {}) };
    const hash = decisionHash(semantic);
    const existing = this.db.prepare('SELECT payload FROM snapshots WHERE hash=? AND kind=?').get(hash, 'ENTRY');
    if (existing) return readJson<EntrySnapshot>(existing.payload);
    return this.transact(() => {
      const id = randomUUID();
      let c = this.caseFor(b.token);
      if (!c) { const caseId = randomUUID(); this.db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run(caseId, tokenKey(b.token), JSON.stringify(b.token), 'INITIAL_RESEARCH', null); c = { id: caseId, status: 'INITIAL_RESEARCH', episodeId: null }; }
      const snapshot: EntrySnapshot = { id, caseId: c.id, checklistKind: 'ENTRY', token: b.token, cutoff: b.cutoff, analysisKind: b.analysisKind, features: policyFeatures(b), evidence: b.evidence, result, hash,details,
        ...(b.analysisKind === 'LIVE' ? { observations: b.observations, collection: b.collection, semantic: b.semantic, market: b.market } : {}) };
      this.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?)').run(id, 'ENTRY', JSON.stringify(snapshot), hash, JSON.stringify(semantic));
      if (result.binary === 'PASS' && c.status === 'INITIAL_RESEARCH') {
        const episode: ThesisEpisode = { id: randomUUID(), caseId: c.id, baselineSnapshotId: id, thesis: b.thesis!, createdAt: b.cutoff };
        this.db.prepare('INSERT INTO episodes VALUES(?,?,?)').run(episode.id, c.id, JSON.stringify(episode));
        this.db.prepare('UPDATE cases SET status=?,episode_id=? WHERE id=?').run('THESIS_TRACKED', episode.id, c.id);
      }
      return snapshot;
    });
  }
  reassess(caseId: string, input: Bundle): ManagementSnapshot { return this.reassessCore(caseId, this.validateBundle(input)); }
  reassessLive(caseId: string, input: LiveBundle): ManagementSnapshot { return this.reassessCore(caseId, this.validateBundle(input, true)); }
  private reassessCore(caseId: string, b: Bundle | LiveBundle): ManagementSnapshot {
    this.persistArtifacts(b);
    const row = this.db.prepare('SELECT token_key,status,episode_id FROM cases WHERE id=?').get(caseId);
    if (!row) throw new Error('CASE_NOT_FOUND');
    if (String(row.token_key) !== tokenKey(b.token)) throw new Error('TOKEN_CASE_MISMATCH');
    if (!row.episode_id || row.status !== 'THESIS_TRACKED') throw new Error('NO_ACTIVE_THESIS');
    const episode = this.episodeAt(caseId, String(row.episode_id), b.cutoff);
    const pRow = this.db.prepare('SELECT payload,id FROM positions WHERE case_id=?').get(caseId);
    const savedPosition = pRow ? readJson<PositionRecord>(pRow.payload) : null;
    const position = savedPosition && Date.parse(savedPosition.entryAt) <= Date.parse(b.cutoff) && Date.parse(savedPosition.recordedAt) <= Date.parse(b.cutoff) ? savedPosition : null;
    const events = position && pRow ? this.db.prepare('SELECT payload FROM position_events WHERE position_id=?').all(String(pRow.id)).map(x => readJson<PositionEvent>(x.payload)).filter(e => Date.parse(e.recordedAt) <= Date.parse(b.cutoff)) : [];
    const social=b.analysisKind==='LIVE'?b.details?.social:undefined;
    const result = evaluateManagement(episode, policyFeatures(b), position, events, b.profile, b.cutoff,stageInputs(b),social?.identityReview||social?.integrityReview?'QUALIFIED_V4':social?'QUALIFIED_V3':'QUALIFIED_V2',social);
    const details=this.assessmentDetails(b,episode.thesis);
    const semantic = { schemaVersion: 2, policyVersion: social?.identityReview||social?.integrityReview?'thesis-management-v4':social?'thesis-management-v3':'thesis-management-v2', ...(social?{featureVersion:2}:{}), episode, cutoff: b.cutoff, analysisKind: b.analysisKind, features: b.features, policyFeatures:policyFeatures(b), evidence: b.evidence, profile: b.profile, position, events, stageInputs: stageInputs(b), result,details,
      ...(b.analysisKind === 'LIVE' ? { observations: b.observations, collection: b.collection, semantic: b.semantic, market: b.market } : {}) };
    const hash = decisionHash(semantic);
    const existing = this.db.prepare('SELECT payload FROM snapshots WHERE hash=? AND kind=?').get(hash, 'MANAGEMENT');
    if (existing) return readJson<ManagementSnapshot>(existing.payload);
    return this.transact(() => { const id = randomUUID(); const snapshot: ManagementSnapshot = { id, checklistKind: 'MANAGEMENT', token:b.token,analysisKind:b.analysisKind,caseId, episodeId: episode.id, baselineSnapshotId: episode.baselineSnapshotId, cutoff: b.cutoff, features: policyFeatures(b), evidence: b.evidence, result, hash,details,
      ...(b.analysisKind === 'LIVE' ? { observations: b.observations, collection: b.collection, semantic: b.semantic, market: b.market } : {}) };
      this.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?)').run(id, 'MANAGEMENT', JSON.stringify(snapshot), hash, JSON.stringify(semantic)); return snapshot; });
  }
  episode(id: string): ThesisEpisode { const row = this.db.prepare('SELECT payload FROM episodes WHERE id=?').get(id); if (!row) throw new Error('EPISODE_NOT_FOUND'); return readJson<ThesisEpisode>(row.payload); }
  private episodeAt(caseId: string, headId: string, cutoff: string): ThesisEpisode {
    const cutoffMs = Date.parse(cutoff);
    const seen = new Set<string>();
    let id: string | undefined = headId;
    let childAt = Number.POSITIVE_INFINITY;
    let selected: ThesisEpisode | undefined;
    while (id !== undefined) {
      if (seen.has(id)) throw new Error('INVALID_EPISODE_TIMELINE');
      seen.add(id);
      const row: Record<string, unknown> | undefined = this.db.prepare('SELECT payload FROM episodes WHERE id=? AND case_id=?').get(id, caseId);
      if (!row) throw new Error('INVALID_EPISODE_TIMELINE');
      const episode: ThesisEpisode = readJson<ThesisEpisode>(row.payload);
      const at = Date.parse(episode.createdAt);
      if (episode.id !== id || episode.caseId !== caseId || !Number.isFinite(at) || at >= childAt) {
        throw new Error('INVALID_EPISODE_TIMELINE');
      }
      if (!selected && at <= cutoffMs) selected = episode;
      childAt = at;
      id = episode.supersedesEpisodeId;
    }
    if (!selected) throw new Error('NO_THESIS_AT_CUTOFF');
    return selected;
  }
  successor(caseId: string, thesisInput: Thesis, at: string): ThesisEpisode {
    const thesis = thesisSchema.parse(thesisInput);
    if (!Number.isFinite(Date.parse(at))) throw new Error('INVALID_SUCCESSOR_TIME');
    for (const p of [...thesis.support,...thesis.invalidation,...[thesis.catalyst,thesis.onchainTraction,thesis.externalTraction,thesis.warning].filter(x => x !== null),...thesis.legs.map(l => l.trigger)]) evaluatePredicate(p,[],at);
    return this.transact(() => {
      const row = this.db.prepare('SELECT episode_id,status FROM cases WHERE id=?').get(caseId);
      if (!row) throw new Error('CASE_NOT_FOUND');
      if (row.status !== 'THESIS_TRACKED' || !row.episode_id) throw new Error('NO_ACTIVE_THESIS');
      const headId = String(row.episode_id);
      const head = this.db.prepare('SELECT payload FROM episodes WHERE id=? AND case_id=?').get(headId, caseId);
      if (!head) throw new Error('INVALID_EPISODE_TIMELINE');
      const old = readJson<ThesisEpisode>(head.payload);
      this.episodeAt(caseId, headId, old.createdAt);
      if (Date.parse(at) <= Date.parse(old.createdAt)) throw new Error('SUCCESSOR_TIME_NOT_AFTER_PREDECESSOR');
      const episode: ThesisEpisode = { id: randomUUID(), caseId, baselineSnapshotId: old.baselineSnapshotId, thesis, createdAt: at, supersedesEpisodeId: old.id };
      this.db.prepare('INSERT INTO episodes VALUES(?,?,?)').run(episode.id,caseId,JSON.stringify(episode));
      this.db.prepare('UPDATE cases SET episode_id=? WHERE id=?').run(episode.id,caseId);
      return episode;
    });
  }
  show(id: string): EntrySnapshot | ManagementSnapshot { const row = this.db.prepare('SELECT payload FROM snapshots WHERE id=?').get(id); if (!row) throw new Error('SNAPSHOT_NOT_FOUND'); return readJson<EntrySnapshot | ManagementSnapshot>(row.payload); }
  frozenDetails(id:string):AssessmentDetails {
    const row=this.db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(id);if(!row)throw new Error('SNAPSHOT_NOT_FOUND');const s=readJson<Record<string,any>>(row.semantic);
    return s.details??{version:1,profile:s.profile,thesis:s.thesis??s.episode?.thesis??null,origins:{profile:'LEGACY_FROZEN_INPUT'},baseline:[],stageInputs:s.stageInputs??{circulatingMarketCapUsd:null,tokenCreatedAt:null}};
  }
  replay(id: string): EntrySnapshot | ManagementSnapshot {
    const row = this.db.prepare('SELECT payload,hash,semantic,kind FROM snapshots WHERE id=?').get(id); if (!row) throw new Error('SNAPSHOT_NOT_FOUND');
    const semantic = readJson<Record<string, any>>(row.semantic);
    if(semantic.schemaVersion!==1&&semantic.schemaVersion!==2)throw new Error('UNSUPPORTED_SNAPSHOT_VERSION');
    if (decisionHash(semantic) !== row.hash) throw new Error('SNAPSHOT_HASH_MISMATCH');
    const replayBundle = { analysisKind: semantic.analysisKind, features: semantic.features, evidence:semantic.evidence??[] } as Bundle | LiveBundle;
    const effective=semantic.schemaVersion===1?legacyPolicyFeatures(replayBundle):semantic.policyFeatures;
    if(!Array.isArray(effective))throw new Error('UNSUPPORTED_SNAPSHOT_VERSION');
    const recomputed = row.kind === 'ENTRY' ? evaluateEntry(effective,semantic.profile,semantic.cutoff,['research-screen-shared-v1','research-screen-shared-v2','research-screen-shared-v3','research-screen-shared-v4'].includes(semantic.policyVersion)?(semantic.details?.social?.identityReview||semantic.details?.social?.integrityReview?'QUALIFIED_V4':semantic.details?.social?'QUALIFIED_V3':'QUALIFIED_V2'):semantic.policyVersion==='research-screen-v4'?'QUALIFIED_V4':semantic.policyVersion==='research-screen-v3'?'QUALIFIED_V3':semantic.policyVersion==='research-screen-v2'?'QUALIFIED_V2':semantic.policyVersion==='research-screen-v1'?'QUALIFIED':'LEGACY',semantic.details?.social,['research-screen-shared-v1','research-screen-shared-v2','research-screen-shared-v3','research-screen-shared-v4'].includes(semantic.policyVersion),['research-screen-shared-v2','research-screen-shared-v3','research-screen-shared-v4'].includes(semantic.policyVersion)?semantic.entryComparison:undefined,['research-screen-shared-v3','research-screen-shared-v4'].includes(semantic.policyVersion)?semantic.entryGates:undefined,semantic.policyVersion==='research-screen-shared-v4'?semantic.details?.groups:undefined) : evaluateManagement(semantic.episode,effective,semantic.position,semantic.events,semantic.profile,semantic.cutoff,semantic.stageInputs,semantic.policyVersion==='thesis-management-v4'?'QUALIFIED_V4':semantic.policyVersion==='thesis-management-v3'?'QUALIFIED_V3':semantic.policyVersion==='thesis-management-v2'?'QUALIFIED_V2':semantic.policyVersion==='thesis-management-v1'?'QUALIFIED':'LEGACY',semantic.details?.social);
    if (decisionHash(recomputed) !== decisionHash(semantic.result)) throw new Error('REPLAY_RESULT_MISMATCH');
    return readJson<EntrySnapshot | ManagementSnapshot>(row.payload);
  }
  recordPosition(position: PositionRecord): PositionRecord {
    position = positionRecordSchema.parse(position);
    const row = this.db.prepare('SELECT id,status FROM cases WHERE id=?').get(position.caseId); if (!row) throw new Error('CASE_NOT_FOUND');
    if (row.status !== 'THESIS_TRACKED') throw new Error('NO_ACTIVE_THESIS');
    if (this.db.prepare('SELECT id FROM positions WHERE case_id=?').get(position.caseId)) throw new Error('POSITION_ALREADY_EXISTS');
    reduceLedger(position, []);
    this.db.prepare('INSERT INTO positions VALUES(?,?,?)').run(position.id, position.caseId, JSON.stringify(position)); return position;
  }
  appendPositionEvent(positionId: string, event: PositionEvent) {
    event = positionEventSchema.parse(event);
    const p = this.db.prepare('SELECT payload FROM positions WHERE id=?').get(positionId); if (!p) throw new Error('POSITION_NOT_FOUND');
    const prior = this.db.prepare('SELECT payload FROM position_events WHERE idempotency_key=?').get(event.idempotencyKey);
    if (prior) { if (String(prior.payload) !== JSON.stringify(event)) throw new Error('IDEMPOTENCY_CONFLICT'); return this.positionState(positionId); }
    const current = this.db.prepare('SELECT payload FROM position_events WHERE position_id=?').all(positionId).map(x => readJson<PositionEvent>(x.payload));
    const next = [...current, event]; const state = reduceLedger(readJson<PositionRecord>(p.payload), next);
    this.db.prepare('INSERT INTO position_events VALUES(?,?,?,?)').run(event.id, positionId, event.idempotencyKey, JSON.stringify(event));
    return state;
  }
  positionState(positionId: string) { const p = this.db.prepare('SELECT payload FROM positions WHERE id=?').get(positionId); if (!p) throw new Error('POSITION_NOT_FOUND'); const events = this.db.prepare('SELECT payload FROM position_events WHERE position_id=?').all(positionId).map(x => readJson<PositionEvent>(x.payload)); return reduceLedger(readJson<PositionRecord>(p.payload),events); }
  showCase(id: string) { const row = this.db.prepare('SELECT id,token_json,status,episode_id FROM cases WHERE id=?').get(id); if (!row) throw new Error('CASE_NOT_FOUND'); return { id: String(row.id), token: readJson<TokenRef>(row.token_json), status: String(row.status), episodeId: row.episode_id ? String(row.episode_id) : null }; }
  diff(a: string,b: string) {
    const x = this.show(a), y = this.show(b);
    const sx = readJson<Record<string, unknown>>(this.db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(a)!.semantic);
    const sy = readJson<Record<string, unknown>>(this.db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(b)!.semantic);
    const changed = (k: string) => decisionHash(sx[k] ?? null) !== decisionHash(sy[k] ?? null);
    return { from: a, to: b, checklistChanged: x.checklistKind !== y.checklistKind, policyChanged: changed('policyVersion') || changed('profile'), evidenceChanged: changed('evidence'), featuresChanged: changed('features'), thesisChanged: changed('episode') || changed('thesis'), stageChanged: changed('stageInputs'), positionChanged: changed('position') || changed('events'), resultChanged: changed('result'), semanticChanged: changed('semantic') };
  }
  closeCase(id: string) { const row = this.db.prepare('UPDATE cases SET status=? WHERE id=?').run('CLOSED',id); if (!row.changes) throw new Error('CASE_NOT_FOUND'); }
  journal(caseId: string, text: string) { if (text.length > 4000) throw new Error('JOURNAL_LIMIT'); this.db.prepare('INSERT INTO journal VALUES(?,?,?,?)').run(randomUUID(),caseId,new Date().toISOString(),text); }
  async backup(directory: string) {
    if (existsSync(directory)) throw new Error('BACKUP_TARGET_EXISTS');
    mkdirSync(directory,{ recursive: true });
    await backup(this.db,join(directory,'dd.sqlite'));
    if (existsSync(this.artifactDir)) cpSync(this.artifactDir,join(directory,'artifacts'),{ recursive: true });
    return { directory, database: join(directory,'dd.sqlite'), artifacts: existsSync(this.artifactDir) };
  }
}
