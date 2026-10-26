import {deriveExitCapacity as deriveCustomExitCapacity} from '../providers/advisory-exit-capacity-custom.js';
import { decodeA29Capture,deriveA29Absorption } from '../providers/advisory-absorption.js';
import { decodeA29CaptureV2,deriveA29AbsorptionV2 } from '../providers/advisory-absorption-v2.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import { deflateRawSync,inflateRawSync } from 'node:zlib';
import {deriveExitCapacity,type ExitCapacityReceipts,EXIT_CAPACITY_REQUEST_CAP} from '../providers/advisory-exit-capacity.js';
import {decodeCreatorEpisode,CREATOR_EPISODE_REQUEST_CAP,type CreatorEpisodeReceipts} from '../providers/advisory-creator-episode.js';
import {decodeCreatorRoutes,CREATOR_ROUTE_REQUEST_CAP,type CreatorRouteReceipts} from '../providers/advisory-creator-routes.js';
import {decodeCreatorCoverage,CREATOR_COVERAGE_REQUEST_CAP,EPISODE_COVERAGE_REQUEST_CAP} from '../providers/advisory-creator-coverage.js';
import { decodeCreatorQuoteAccounting,CREATOR_QUOTE_REQUEST_CAP } from '../providers/advisory-creator-quote.js';
import { deriveAuthorityTopology, HOLDER_ARCHIVE_ADAPTER, type TopologyReceipts } from '../providers/advisory-topology.js';
import { deriveO30Window, type AutomationReceipts } from '../providers/advisory-automation.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { BaselineAssessment } from '../domain/baseline.js';
import { thesisSchema, type Thesis, type FeatureResult } from '../domain/contracts.js';
import type { TokenRef,EvidenceRecord } from '../domain/contracts.js';
import { deriveAdvisory } from '../domain/advisory.js';
import { decodeAdvisoryWalletHistory,deriveWalletHistoryMetrics } from '../providers/advisory-wallet-history.js';
import { decodeAdvisoryWindow,deriveO28Window,unpackAdvisoryWindowReceipts,WINDOW_ARCHIVE_ADAPTER,WINDOW_DENSE_REQUEST_CAP,WINDOW_EXPANDED_REQUEST_CAP } from '../providers/advisory-window.js';
import { decodeAdvisoryWindowAccounts,deriveO26Window } from '../providers/advisory-window-accounts.js';
import { decodeAdvisoryDemandWindows,deriveA30DemandWindows,DEMAND_REQUEST_CAP,DEMAND_ARCHIVE_ADAPTER } from '../providers/advisory-demand-windows.js';
import { deriveAdvisoryDemand } from '../domain/advisory-demand.js';
import { decodeAdvisoryChain } from '../providers/advisory-chain.js';
import { decodeAdvisoryMarket } from '../providers/advisory-market.js';
import { decodeAdvisorySocial,deriveSocialAdvisory } from '../providers/advisory-social.js';
import { decodeAdvisoryTrades,deriveAdvisoryTrades } from '../providers/advisory-trades.js';
import { decodeAdvisoryContextHistory } from '../providers/advisory-context-history.js';
import { validateAdvisorySemanticWire,deriveAdvisorySemantic,advisorySemanticRequests,advisorySemanticRulesV3,type AdvisorySemanticWire } from '../providers/advisory-semantic.js';
import { A24_CAPTURE_METHODS,A24_LIMITS,decodeA24Capture,deriveA24FromDecoded } from '../providers/advisory-saturation.js';
import { socialInputSchema,socialProposalSchema,socialReviewSchema } from '../domain/social.js';
import { replayCallerHistory,supersedingCallerMetrics } from '../providers/advisory-caller-measures.js';
import { CALLER_REQUEST_CAP } from '../providers/advisory-caller-history.js';
import { deriveO23Synchrony } from '../providers/advisory-synchrony.js';
import { deriveO29ReservePath } from '../providers/advisory-reserve-path.js';
import { deriveShortDemandReport,type ShortDemandReport } from '../providers/advisory-short-demand.js';
import { decodeCreatorRole,creatorRoleS13,CREATOR_RECEIPT_CAP,CREATOR_LEGACY_RECEIPT_CAP,EXPANDED_CREATOR_RECEIPT_CAP } from '../providers/advisory-creator-role-collector.js';
import { decodeLaunchpadContext,deriveC16Launchpad,uncollectedC16,type LaunchpadRequest } from '../providers/advisory-launchpad.js';
import { creatorInventoryReuse,creatorInventoryRole,creatorInventoryTape,replayCreatorInventory,CREATOR_INVENTORY_REQUEST_CAP } from '../providers/advisory-creator-inventory-collector.js';
import { deriveO25CreatorLifetime } from '../providers/advisory-creator-lifetime.js';
import { replayCreatorPerformance,CREATOR_FAILED_FEE_REQUEST_CAP,EXPANDED_CREATOR_FAILED_FEE_REQUEST_CAP } from '../providers/advisory-creator-performance-collector.js';
import { FAILED_FEE_ADAPTER,FAILED_FEE_SOURCE_ID,type FailedFeeReceipt } from '../providers/advisory-creator-failed-fees.js';

const descriptor=z.object({requests:z.record(z.string(),z.unknown()),artifactIds:z.record(z.string(),z.string())}).strict();
export const advisoryProofSchema=z.object({
  method:z.enum(['advisory-provenance-v2','advisory-provenance-v3','advisory-provenance-v4','advisory-provenance-v5','advisory-provenance-v6','advisory-provenance-v7','advisory-provenance-v8','advisory-provenance-v9','advisory-provenance-v10','advisory-provenance-v11','advisory-provenance-v12','advisory-provenance-v13','advisory-provenance-v14','advisory-provenance-v15','advisory-provenance-v16','advisory-provenance-v17','advisory-provenance-v18','advisory-provenance-v19','advisory-provenance-v20','advisory-provenance-v21','advisory-provenance-v22','advisory-provenance-v23','advisory-provenance-v24','advisory-provenance-v25','advisory-provenance-v26','advisory-provenance-v27','advisory-provenance-v28','advisory-provenance-v29','advisory-provenance-v30','advisory-provenance-v31','advisory-provenance-v32','advisory-provenance-v33','advisory-provenance-v34','advisory-provenance-v35','advisory-provenance-v36','advisory-provenance-v37','advisory-provenance-v38','advisory-provenance-v39','advisory-provenance-v40']),token:z.object({chain:z.literal('solana'),address:z.string()}).strict(),cutoff:z.iso.datetime({offset:true}),
  pool:z.string().nullable(),addresses:z.array(z.string()).min(1).max(3),chain:descriptor,market:descriptor,paid:descriptor,trades:descriptor,context:descriptor,semantic:descriptor.nullable(),wallets:descriptor.optional(),
  socialDerivationId:z.literal('social-derivation').nullable(),thesisContextId:z.literal('advisory-thesis-context'),
  window:descriptor.extend({end:z.iso.datetime({offset:true})}).strict().optional(),
  accounts:descriptor.optional(),automation:descriptor.optional(),topology:descriptor.optional(),demand:descriptor.optional(),
  callers:descriptor.extend({selectionId:z.literal('advisory-callers-selection')}).strict().nullable().optional(),callerSemantic:descriptor.nullable().optional(),
  creatorRole:descriptor.nullable().optional(),
  launchpad:descriptor.nullable().optional(),
  creatorInventory:descriptor.nullable().optional(),
  creatorFailedFees:descriptor.nullable().optional(),
  creatorAccounting:descriptor.nullable().optional(),
  creatorCoverage:descriptor.nullable().optional(),
  creatorRoutes:descriptor.nullable().optional(),
  creatorEpisode:descriptor.nullable().optional(),
  exitCapacity:descriptor.extend({candidateSetId:z.literal('a12-reviewed-candidate-set'),impactBps:z.string().nullable()}).strict().nullable().optional(),
  saturation:z.object({captureId:z.literal('advisory-saturation-capture')}).strict().nullable().optional(),
  a29:descriptor.extend({label:z.string().min(1)}).strict().nullable().optional(),
}).strict();
export type AdvisoryProof=z.infer<typeof advisoryProofSchema>;
export const advisoryHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Evidence-id prefix of the S15 failed-fee namespace; with the provider sourceId and adapter it defines catalog ownership. */
const FAILED_FEE_EVIDENCE_PREFIX='advisory-creatorFailedFees-';
/** Evidence-id prefix of the window namespace; with its sourceId and the proof-v21 archive adapter it defines window catalog ownership. */
const WINDOW_EVIDENCE_PREFIX='advisory-window-';
/** Source id and evidence-id prefix of the A24 raw-capture namespace; with either capture transport adapter (v1 or v2) they define its catalog ownership. */
const A24_SOURCE_ID='advisory-saturation',A24_EVIDENCE_PREFIX='advisory-saturation-';
/** The A29 import adapter: one exact prior capture file is USER_IMPORT reconstructed history under its own source, record id and raw-deflate archive, never a live-v1 or fresh-collection receipt. */
export const A29_SOURCE_ID='advisory-a29',A29_CAPTURE_ID='advisory-a29-capture',A29_CAPTURE_ADAPTER='a29-capture-archive-v1',A29_CAPTURE_SOURCE_BYTES=24_000_000;
const sha256=(raw:string|Buffer)=>createHash('sha256').update(raw).digest('hex');
/** The descriptor request names the provider-chosen label and the exact UTF-8 bytes of the imported file. */
export const a29CaptureRequest=(raw:string,label:string)=>({method:'a29-capture-import-v1',label,fileSha256:sha256(raw),fileBytes:Buffer.byteLength(raw)});
export function archiveA29Capture(raw:string){
  const bytes=Buffer.from(raw,'utf8');if(bytes.length>A29_CAPTURE_SOURCE_BYTES)throw new Error('A29_CAPTURE_TOO_LARGE');
  return JSON.stringify({method:A29_CAPTURE_ADAPTER,encoding:'DEFLATE_RAW_BASE64',sourceBytes:bytes.length,sourceHash:sha256(bytes),data:deflateRawSync(bytes).toString('base64')});
}
/** Restores the exact file under the fixed stored and inflate ceilings; any shape, length, hash or encoding mismatch fails closed. */
export function unpackA29Capture(stored:string){
  const fail=():never=>{throw new Error('A29_CAPTURE_ARCHIVE_INVALID');};
  if(Buffer.byteLength(stored)>A29_CAPTURE_SOURCE_BYTES)fail();
  const c=JSON.parse(stored);
  if(!c||typeof c!=='object'||Object.keys(c).join()!=='method,encoding,sourceBytes,sourceHash,data'||c.method!==A29_CAPTURE_ADAPTER||c.encoding!=='DEFLATE_RAW_BASE64'||!Number.isSafeInteger(c.sourceBytes)||c.sourceBytes<1||c.sourceBytes>A29_CAPTURE_SOURCE_BYTES||typeof c.sourceHash!=='string'||typeof c.data!=='string')fail();
  const packed=Buffer.from(c.data,'base64');if(packed.toString('base64')!==c.data)fail();
  const inflated=inflateRawSync(packed,{maxOutputLength:c.sourceBytes,info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
  if(inflated.engine.bytesWritten!==packed.length)fail();
  const bytes=inflated.buffer,raw=bytes.toString('utf8');
  if(bytes.length!==c.sourceBytes||sha256(bytes)!==c.sourceHash||!Buffer.from(raw,'utf8').equals(bytes))fail();
  return raw;
}
/** Decodes one imported capture through the provider and binds its chosen label to the analyzed mint as USER_IMPORT provenance. */
export function a29BoundCapture(raw:string,token:TokenRef){return a29BindToken(decodeA29Capture(raw),token);}
/** v1 freezes list tokens and v2 freezes key them by label; either way the chosen label binds the analyzed mint under USER_IMPORT provenance. */
function a29BindToken<C extends {freeze:unknown;label:string;provenance:unknown}>(capture:C,token:TokenRef):C{
  const tokens:unknown=(capture.freeze as {tokens?:unknown}|null)?.tokens,entry=(Array.isArray(tokens)?tokens.find((t:{label?:unknown}|null|undefined)=>t?.label===capture.label):tokens&&typeof tokens==='object'&&Object.hasOwn(tokens,capture.label)?(tokens as Record<string,unknown>)[capture.label]:undefined) as {mint?:unknown}|null|undefined;
  if(entry?.mint!==token.address||(capture.provenance as {accessMode?:unknown}|null|undefined)?.accessMode!=='USER_IMPORT')throw new Error('A29_CAPTURE_TOKEN_MISMATCH');
  return capture;
}

/** The A29 v2 adapter stores the exact a29-retained-sources-v2 packet as UTF-8 with no outer archive; its receipts are already strict per-receipt archives. */
export const A29_V2_CAPTURE_ADAPTER='a29-capture-v2',A29_V2_SOURCE_BYTES=128_000_000;
export const a29CaptureRequestV2=(raw:string,label:string)=>({method:'a29-capture-import-v2',label,fileSha256:sha256(raw),fileBytes:Buffer.byteLength(raw)});
const a29Owns=(e:EvidenceRecord)=>e.sourceId===A29_SOURCE_ID||e.id.startsWith('advisory-a29-')||e.adapterVersion===A29_CAPTURE_ADAPTER||e.adapterVersion===A29_V2_CAPTURE_ADAPTER;
/** Chooses the exact decoder by the packet's own method; only v2 may exceed the v1 cap, and any other method fails closed. */
export function a29ImportCapture(raw:string,token:TokenRef){
  const bytes=Buffer.byteLength(raw);if(bytes>A29_V2_SOURCE_BYTES)throw new Error('A29_CAPTURE_TOO_LARGE');
  const v2=bytes>A29_CAPTURE_SOURCE_BYTES||(()=>{const m=(JSON.parse(raw) as {method?:unknown}|null)?.method;if(m==='a29-retained-sources-v2')return true;if(m==='a29-retained-sources-v1')return false;throw new Error('A29_CAPTURE_METHOD_UNSUPPORTED');})();
  if(!v2){const capture=a29BoundCapture(raw,token);return {adapter:A29_CAPTURE_ADAPTER,stored:archiveA29Capture(raw),request:a29CaptureRequest(raw,capture.label),label:capture.label,maxClock:capture.maxClock};}
  const capture=a29BindToken(decodeA29CaptureV2(raw),token);
  return {adapter:A29_V2_CAPTURE_ADAPTER,stored:raw,request:a29CaptureRequestV2(raw,capture.label),label:capture.label,maxClock:capture.maxClock};
}
function a29DeriveV2(d:NonNullable<AdvisoryProof['a29']>,record:EvidenceRecord,stored:string,token:TokenRef,cutoff:string,a29Recovery=false):AdvisoryMetric{
  if(Buffer.byteLength(stored)>A29_V2_SOURCE_BYTES)throw new Error('ADVISORY_PROOF_INVALID');
  const capture=a29BindToken(decodeA29CaptureV2(stored),token);
  if(advisoryHash(a29CaptureRequestV2(stored,capture.label))!==advisoryHash(d.requests.capture)||capture.label!==d.label||capture.maxClock!==record.retrievedAt)throw new Error('ADVISORY_PROOF_INVALID');
  return deriveA29AbsorptionV2(capture.freeze,capture.label,capture.receipts,cutoff,[A29_CAPTURE_ID],a29Recovery);
}
/** Separate-bound eligibility: only a proof-v39/v40 descriptor over exactly one owned, hash- and request-bound, provider-admitted and derivable v2 record qualifies; anything else stays under the default artifact budget. */
export function a29VerifiedV2Id(token:TokenRef,cutoff:string,evidence:EvidenceRecord[],rawArtifacts:Record<string,string>):string|null{
  try{
    const proof=advisoryProofSchema.parse(JSON.parse(rawArtifacts['advisory-derivation']??'null')),d=proof.a29,owned=evidence.filter(a29Owns),record=owned[0],stored=record?rawArtifacts[record.id]:undefined;
    if(!['advisory-provenance-v39','advisory-provenance-v40'].includes(proof.method)||proof.cutoff!==cutoff||proof.token.address!==token.address||!d||owned.length!==1||!record||record.id!==A29_CAPTURE_ID||Object.keys(d.requests).join()!=='capture'||Object.keys(d.artifactIds).join()!=='capture'||d.artifactIds.capture!==A29_CAPTURE_ID||record.sourceId!==A29_SOURCE_ID||record.sourceType!=='RECONSTRUCTED_HISTORY'||record.accessMode!=='USER_IMPORT'||record.adapterVersion!==A29_V2_CAPTURE_ADAPTER||Object.keys(record.scope).join()!=='request'||advisoryHash(record.scope.request)!==advisoryHash(d.requests.capture)||typeof stored!=='string'||record.contentHash!==sha256(stored)||Date.parse(record.retrievedAt)>Date.parse(record.availableAt)||Date.parse(record.availableAt)>Date.parse(cutoff))return null;
    return a29DeriveV2(d,record,stored,token,cutoff,proof.method==='advisory-provenance-v40').id==='A29'?record.id:null;
  }catch{return null;}
}

/** Reconstruct measurements from retained responses, never from a claimed normalized cache. */
export function reconstructAdvisory(token:TokenRef,cutoff:string,baseline:BaselineAssessment[],evidence:EvidenceRecord[],rawArtifacts:Record<string,string>,input:unknown,thesis:Thesis|null=null,features:FeatureResult[]=[]){
  const proof=advisoryProofSchema.parse(input);
  if(token.chain!==proof.token.chain||token.address!==proof.token.address||cutoff!==proof.cutoff||JSON.stringify(proof.addresses)!==JSON.stringify([token.address,...(proof.pool?[proof.pool]:[])]))throw new Error('ADVISORY_PROOF_INVALID');
  // Descriptors and decoders join at their proof version; v13 is v12 plus O23 over the same window and demand receipts; v14 is v13 plus O29 from one demand decode that retains per-event virtual quote reserves; v16 is v15 plus the supplementary one-hour report from that same decode, kept outside metrics and groups; v18 is v17 plus the creator-inventory O24 over the recomputed S13 role and the complete A30 tape; v19 is v18 plus O25 from that same role, tape, inventory receipts and reuse; v20 is v19 plus S15 from that same role, tape, inventory and reuse with every owned failed-fee receipt.
  const version=Number(proof.method.slice('advisory-provenance-v'.length));
  if((proof.method!=='advisory-provenance-v2')!==!!proof.wallets||!proof.wallets&&evidence.some(e=>e.sourceId==='advisory-wallets')||(version>=4)!==!!proof.window||!proof.window&&evidence.some(e=>e.sourceId==='advisory-window'))throw new Error('ADVISORY_PROOF_INVALID');
  if((version>=7)!==!!proof.accounts||!proof.accounts&&evidence.some(e=>e.sourceId==='advisory-accounts'))throw new Error('ADVISORY_PROOF_INVALID');
  if((version>=8)!==!!proof.automation||!proof.automation&&evidence.some(e=>e.sourceId==='advisory-automation'))throw new Error('ADVISORY_PROOF_INVALID');
  if((version>=9)!==!!proof.topology||!proof.topology&&evidence.some(e=>e.sourceId==='advisory-topology'))throw new Error('ADVISORY_PROOF_INVALID');
  if((version>=10)!==!!proof.demand||!proof.demand&&evidence.some(e=>e.sourceId==='advisory-demand'))throw new Error('ADVISORY_PROOF_INVALID');
  // Both caller keys exist from v11 (null when not collected); caller receipts, selection or classification without their descriptor are rejected.
  const callerVersion=version>=11;
  // Caller origin remains pinned to v3 from proof v12. Proof v24 and later isolate optional persistence in the main v4 source review.
  const callerSemanticWire:AdvisorySemanticWire=version>=12?'v3':'v2';
  const semanticWire:AdvisorySemanticWire=version>=24?'v4':callerSemanticWire;
  if(callerVersion!==(proof.callers!==undefined)||callerVersion!==(proof.callerSemantic!==undefined)||!proof.callers&&(!!proof.callerSemantic||evidence.some(e=>e.sourceId==='advisory-callers'||e.id==='advisory-callers-selection'))||!proof.callerSemantic&&evidence.some(e=>e.id.startsWith('advisory-callerSemantic-')))throw new Error('ADVISORY_PROOF_INVALID');
  // Proof v15 carries an explicit creatorRole key (null when not collected); earlier proofs may carry only null and never derive the role, and creator receipts without a descriptor are orphans.
  if((version>=15?proof.creatorRole===undefined:!!proof.creatorRole)||!proof.creatorRole&&evidence.some(e=>e.sourceId==='advisory-creator-role'||e.id.startsWith('advisory-creatorRole-')))throw new Error('ADVISORY_PROOF_INVALID');
  if(proof.creatorRole){const owned=evidence.filter(e=>e.sourceId==='advisory-creator-role'||e.id.startsWith('advisory-creatorRole-')).map(e=>e.id).sort(),declared=Object.values(proof.creatorRole.artifactIds).sort();if(new Set(declared).size!==declared.length||JSON.stringify(owned)!==JSON.stringify(declared))throw new Error('ADVISORY_PROOF_INVALID');}
  const episodeOwned=evidence.filter(e=>e.sourceId==='advisory-creatorEpisode'||e.id.startsWith('advisory-creatorEpisode-'));
  if((version>=32?proof.creatorEpisode===undefined:!!proof.creatorEpisode)||proof.creatorEpisode&&(!proof.creatorAccounting||!proof.creatorRoutes||!proof.creatorCoverage)||!proof.creatorEpisode&&episodeOwned.length)throw new Error('ADVISORY_PROOF_INVALID');
  if(proof.creatorEpisode){const ids=Object.values(proof.creatorEpisode.artifactIds).sort();if(new Set(ids).size!==ids.length||JSON.stringify(episodeOwned.map(e=>e.id).sort())!==JSON.stringify(ids))throw new Error('ADVISORY_PROOF_INVALID');}
  const capacityOwned=evidence.filter(e=>e.sourceId==='advisory-exitCapacity'||e.id.startsWith('advisory-exitCapacity-'));
  const candidateOwned=evidence.filter(e=>e.id==='a12-reviewed-candidate-set'||e.sourceId==='a12-reviewed-candidate-set');
  if((version>=33?proof.exitCapacity===undefined:!!proof.exitCapacity)||!proof.exitCapacity&&(capacityOwned.length||candidateOwned.length))throw Error('ADVISORY_PROOF_INVALID');
  if(proof.exitCapacity){const ids=Object.values(proof.exitCapacity.artifactIds).sort();if(new Set(ids).size!==ids.length||JSON.stringify(capacityOwned.map(e=>e.id).sort())!==JSON.stringify(ids)||candidateOwned.length!==1)throw Error('ADVISORY_PROOF_INVALID');}
  // Proof v37 carries an explicit saturation key (null without an import); earlier proofs never carry it, and a populated descriptor owns exactly one source-, prefix- or adapter-identified capture.
  const saturationOwned=evidence.filter(e=>e.sourceId===A24_SOURCE_ID||e.id.startsWith(A24_EVIDENCE_PREFIX)||(A24_CAPTURE_METHODS as readonly string[]).includes(e.adapterVersion));
  if((version>=37?proof.saturation===undefined:proof.saturation!==undefined)||!proof.saturation&&saturationOwned.length||proof.saturation&&(saturationOwned.length!==1||saturationOwned[0]!.id!==proof.saturation.captureId))throw new Error('ADVISORY_PROOF_INVALID');
  // Proof v38 also carries an explicit a29 key (null without an imported capture); proof v37 and earlier never carry the key, and a source-, prefix- or adapter-identified A29 record without its descriptor is an orphan.
  const a29Owned=evidence.filter(a29Owns);
  if((version>=38?proof.a29===undefined:proof.a29!==undefined)||!proof.a29&&a29Owned.length)throw new Error('ADVISORY_PROOF_INVALID');
  const routeOwned=evidence.filter(e=>e.sourceId==='advisory-creatorRoutes'||e.id.startsWith('advisory-creatorRoutes-'));
  if((version>=31?proof.creatorRoutes===undefined:!!proof.creatorRoutes)||proof.creatorRoutes&&!proof.creatorAccounting||!proof.creatorRoutes&&routeOwned.length)throw new Error('ADVISORY_PROOF_INVALID');
  if(proof.creatorRoutes){const ids=Object.values(proof.creatorRoutes.artifactIds).sort();if(new Set(ids).size!==ids.length||JSON.stringify(routeOwned.map(e=>e.id).sort())!==JSON.stringify(ids))throw new Error('ADVISORY_PROOF_INVALID');}
  const coverageOwned=evidence.filter(e=>e.sourceId==='advisory-creatorCoverage'||e.id.startsWith('advisory-creatorCoverage-'));
  if((version>=30?proof.creatorCoverage===undefined:!!proof.creatorCoverage)||proof.creatorCoverage&&!proof.creatorAccounting||!proof.creatorCoverage&&coverageOwned.length)throw new Error('ADVISORY_PROOF_INVALID');
  if(proof.creatorCoverage){const ids=Object.values(proof.creatorCoverage.artifactIds).sort();if(new Set(ids).size!==ids.length||JSON.stringify(coverageOwned.map(e=>e.id).sort())!==JSON.stringify(ids))throw new Error('ADVISORY_PROOF_INVALID');}
  const accountingOwned=evidence.filter(e=>e.sourceId==='advisory-creatorAccounting'||e.id.startsWith('advisory-creatorAccounting-'));
  if((version>=29?proof.creatorAccounting===undefined:!!proof.creatorAccounting)||proof.creatorAccounting&&!proof.creatorRole||!proof.creatorAccounting&&accountingOwned.length)throw new Error('ADVISORY_PROOF_INVALID');
  if(proof.creatorAccounting){const declared=Object.values(proof.creatorAccounting.artifactIds).sort();if(new Set(declared).size!==declared.length||JSON.stringify(accountingOwned.map(e=>e.id).sort())!==JSON.stringify(declared))throw new Error('ADVISORY_PROOF_INVALID');}
  // Proof v17 carries an explicit launchpad key (null without a key or after a failed collector); earlier proofs may carry only null and never derive C16 from receipts, and launchpad receipts without a descriptor are orphans.
  if((version>=17?proof.launchpad===undefined:!!proof.launchpad)||!proof.launchpad&&evidence.some(e=>e.sourceId==='advisory-launchpad'||e.id.startsWith('advisory-launchpad-')))throw new Error('ADVISORY_PROOF_INVALID');
  // A populated descriptor owns the complete launchpad catalog: every source- or prefix-identified record is exactly one declared artifact, so no extra, missing or duplicate receipt can persist unvalidated.
  if(proof.launchpad){const owned=evidence.filter(e=>e.sourceId==='advisory-launchpad'||e.id.startsWith('advisory-launchpad-')).map(e=>e.id).sort(),declared=Object.values(proof.launchpad.artifactIds).sort();if(new Set(declared).size!==declared.length||JSON.stringify(owned)!==JSON.stringify(declared))throw new Error('ADVISORY_PROOF_INVALID');}
  // Proof v18 carries an explicit creatorInventory key (null when not collected); earlier proofs may carry only null, a populated descriptor needs the role descriptor that recomputes its cohort, and inventory receipts without a descriptor are orphans.
  if((version>=18?proof.creatorInventory===undefined:!!proof.creatorInventory)||proof.creatorInventory&&!proof.creatorRole||!proof.creatorInventory&&evidence.some(e=>e.sourceId==='advisory-creator-inventory'||e.id.startsWith('advisory-creatorInventory-')))throw new Error('ADVISORY_PROOF_INVALID');
  // A populated descriptor owns the complete inventory catalog exactly as launchpad does: every source- or prefix-identified record is exactly one declared artifact, so no extra, missing, duplicate or cross-id receipt can persist unvalidated.
  if(proof.creatorInventory){const owned=evidence.filter(e=>e.sourceId==='advisory-creator-inventory'||e.id.startsWith('advisory-creatorInventory-')).map(e=>e.id).sort(),declared=Object.values(proof.creatorInventory.artifactIds).sort();if(new Set(declared).size!==declared.length||JSON.stringify(owned)!==JSON.stringify(declared))throw new Error('ADVISORY_PROOF_INVALID');}
  // Proof v20 carries an explicit creatorFailedFees key (null when the stage was not admitted or was dropped under the artifact cap, never a known zero); earlier proofs may carry only null, a populated descriptor needs the inventory descriptor whose gate admitted it, and failed-fee receipts without a descriptor are orphans.
  const failedOwned=evidence.filter(e=>e.sourceId===FAILED_FEE_SOURCE_ID||e.id.startsWith(FAILED_FEE_EVIDENCE_PREFIX)||e.adapterVersion===FAILED_FEE_ADAPTER);
  if((version>=20?proof.creatorFailedFees===undefined:!!proof.creatorFailedFees)||proof.creatorFailedFees&&!proof.creatorInventory||!proof.creatorFailedFees&&failedOwned.length)throw new Error('ADVISORY_PROOF_INVALID');
  // A populated descriptor owns the complete failed-fee catalog exactly as inventory does: every source-, prefix- or adapter-identified record is exactly one declared artifact.
  if(proof.creatorFailedFees){const owned=failedOwned.map(e=>e.id).sort(),declared=Object.values(proof.creatorFailedFees.artifactIds).sort();if(new Set(declared).size!==declared.length||JSON.stringify(owned)!==JSON.stringify(declared))throw new Error('ADVISORY_PROOF_INVALID');}
  // Proof v21 is v20 with the dense window acquisition stored as window-archive-v1 archives. Earlier proofs never carry that adapter; a v21 descriptor owns every source-, prefix- or adapter-identified window record exactly, so no orphan, extra, missing or duplicate window receipt persists unvalidated.
  const windowOwned=evidence.filter(e=>e.sourceId==='advisory-window'||e.id.startsWith(WINDOW_EVIDENCE_PREFIX)||e.adapterVersion===WINDOW_ARCHIVE_ADAPTER);
  if(version<21&&windowOwned.some(e=>e.adapterVersion===WINDOW_ARCHIVE_ADAPTER))throw new Error('ADVISORY_PROOF_INVALID');
  if(version>=21){const owned=windowOwned.map(e=>e.id).sort(),declared=Object.values(proof.window!.artifactIds).sort();if(new Set(declared).size!==declared.length||JSON.stringify(owned)!==JSON.stringify(declared))throw new Error('ADVISORY_PROOF_INVALID');}
  // Proof v22 is v21 with the canonical rpc-holder-population body stored as one holder-population-archive-v1 archive; facts are unchanged. Earlier proofs never carry that adapter. From v22 the adapter and that receipt id bind one-to-one with a stored body, so a plain, foreign-adapter, renamed, duplicated, rawless or recordless holder receipt is invalid; the topology replay then checks source, scope, clock, stored hash and the exact original body.
  const holderOwned=evidence.filter(e=>e.id==='rpc-holder-population'||e.adapterVersion===HOLDER_ARCHIVE_ADAPTER);
  if(version<22&&holderOwned.some(e=>e.adapterVersion===HOLDER_ARCHIVE_ADAPTER))throw new Error('ADVISORY_PROOF_INVALID');
  if(version>=22&&(holderOwned.length>1||holderOwned.some(e=>e.id!=='rpc-holder-population'||e.adapterVersion!==HOLDER_ARCHIVE_ADAPTER||typeof rawArtifacts[e.id]!=='string')||!holderOwned.length&&Object.hasOwn(rawArtifacts,'rpc-holder-population')))throw new Error('ADVISORY_PROOF_INVALID');
  const resolve=(namespace:'chain'|'market'|'paid'|'trades'|'context'|'semantic'|'wallets'|'window'|'accounts'|'automation'|'topology'|'demand'|'callers'|'callerSemantic'|'creatorRole'|'launchpad'|'creatorInventory'|'creatorFailedFees'|'creatorAccounting'|'creatorCoverage'|'creatorRoutes'|'creatorEpisode'|'exitCapacity')=>{
    const d=proof[namespace]! ,raw:Record<string,string>={},times:Record<string,string>={};
    const keys=Object.keys(d.requests);
    // Trader-account receipts are absent when the selected window is incomplete; a collected failed-fee stage over a creator with no failed rows is empty.
    if((keys.length===0&&namespace!=='trades'&&namespace!=='accounts'&&namespace!=='automation'&&namespace!=='topology'&&namespace!=='demand'&&namespace!=='creatorFailedFees'&&namespace!=='exitCapacity')||keys.length>(namespace==='exitCapacity'?EXIT_CAPACITY_REQUEST_CAP:namespace==='creatorEpisode'?CREATOR_EPISODE_REQUEST_CAP:namespace==='creatorRoutes'?CREATOR_ROUTE_REQUEST_CAP:namespace==='creatorCoverage'?(version>=32?EPISODE_COVERAGE_REQUEST_CAP:CREATOR_COVERAGE_REQUEST_CAP):namespace==='creatorAccounting'?CREATOR_QUOTE_REQUEST_CAP:namespace==='demand'?DEMAND_REQUEST_CAP:namespace==='callers'?CALLER_REQUEST_CAP:namespace==='creatorRole'?(version>=27?EXPANDED_CREATOR_RECEIPT_CAP:version>=26?CREATOR_RECEIPT_CAP:CREATOR_LEGACY_RECEIPT_CAP):namespace==='creatorInventory'?CREATOR_INVENTORY_REQUEST_CAP:namespace==='creatorFailedFees'?(version>=25?EXPANDED_CREATOR_FAILED_FEE_REQUEST_CAP:CREATOR_FAILED_FEE_REQUEST_CAP):namespace==='window'&&version>=21?(version>=28?WINDOW_EXPANDED_REQUEST_CAP:WINDOW_DENSE_REQUEST_CAP):64)||JSON.stringify(keys.sort())!==JSON.stringify(Object.keys(d.artifactIds).sort()))throw new Error('ADVISORY_PROOF_INVALID');
    for(const [key,id] of Object.entries(d.artifactIds)){
      const record=evidence.find(e=>e.id===id);
      const model=namespace==='semantic'||namespace==='callerSemantic',hosted=model&&(key.includes('prompt')||key.includes('response'));
      const source=model?(hosted?'gemini':'advisory-collector'):namespace==='creatorRole'?'advisory-creator-role':namespace==='creatorInventory'?'advisory-creator-inventory':namespace==='creatorFailedFees'?FAILED_FEE_SOURCE_ID:`advisory-${namespace}`;
      const access=model?(hosted?'FREE_ACCOUNT':'LOCAL_DERIVED'):namespace==='creatorRoutes'||namespace==='creatorEpisode'&&key==='helius'||namespace==='launchpad'&&key==='lighthouse'?'FREE_ACCOUNT':'PUBLIC_API';
      // Current demand receipts bind the known archive adapter, a sole exact request scope, the stored archive hash and a unique id; the archive's own source hash is checked on unpack. Older namespaces keep their recorded checks.
      if(namespace==='demand'&&(!record||evidence.filter(e=>e.id===id).length!==1||record.adapterVersion!==DEMAND_ARCHIVE_ADAPTER||!record.scope||JSON.stringify(Object.keys(record.scope))!=='["request"]'||JSON.stringify(record.scope.request)!==JSON.stringify(d.requests[key])||typeof rawArtifacts[id]!=='string'||record.contentHash!==createHash('sha256').update(rawArtifacts[id]!).digest('hex')))throw new Error('ADVISORY_PROOF_INVALID');
      // Failed-fee receipts bind the S15 archive adapter, a sole exact request scope, the stored archive hash and a unique id; the classifier re-checks request, hash and clock against the recomputed failed index.
      if(namespace==='creatorFailedFees'&&(!record||evidence.filter(e=>e.id===id).length!==1||record.adapterVersion!==FAILED_FEE_ADAPTER||!record.scope||JSON.stringify(Object.keys(record.scope))!=='["request"]'||JSON.stringify(record.scope.request)!==JSON.stringify(d.requests[key])||typeof rawArtifacts[id]!=='string'||record.contentHash!==createHash('sha256').update(rawArtifacts[id]!).digest('hex')))throw new Error('ADVISORY_PROOF_INVALID');
      // Proof v21 window receipts bind the window archive adapter, a sole exact request scope, the stored archive hash and a unique id; the archive's own source length/hash and the namespace ceiling are checked on unpack.
      if(namespace==='window'&&version>=21&&(!record||evidence.filter(e=>e.id===id).length!==1||record.adapterVersion!==WINDOW_ARCHIVE_ADAPTER||!record.scope||JSON.stringify(Object.keys(record.scope))!=='["request"]'||JSON.stringify(record.scope.request)!==JSON.stringify(d.requests[key])||typeof rawArtifacts[id]!=='string'||record.contentHash!==createHash('sha256').update(rawArtifacts[id]!).digest('hex')))throw new Error('ADVISORY_PROOF_INVALID');
      // Caller receipts and caller classification bind the live adapter, a sole exact request scope, the stored content hash and a unique id.
      if((namespace==='callers'||namespace==='callerSemantic'||namespace==='creatorRole'||namespace==='launchpad'||namespace==='creatorInventory'||namespace==='creatorAccounting'||namespace==='creatorCoverage'||namespace==='creatorRoutes'||namespace==='creatorEpisode'||namespace==='exitCapacity')&&(!record||evidence.filter(e=>e.id===id).length!==1||record.adapterVersion!=='live-v1'||!record.scope||Object.keys(record.scope).join()!=='request'||typeof rawArtifacts[id]!=='string'||record.contentHash!==createHash('sha256').update(rawArtifacts[id]!).digest('hex')))throw new Error('ADVISORY_PROOF_INVALID');
      if(id!==`advisory-${namespace}-${key}`||!record||record.sourceId!==source||record.accessMode!==access||record.sourceType!=='HISTORICAL_RECEIPT'||record.availableAt!==record.retrievedAt||Date.parse(record.availableAt)>Date.parse(cutoff)||advisoryHash(record.scope.request)!==advisoryHash(d.requests[key])||typeof rawArtifacts[id]!=='string')throw new Error('ADVISORY_PROOF_INVALID');
      if(model&&advisoryHash(d.requests[key])!==advisoryHash({operation:key,modelRequests:advisorySemanticRequests()}))throw new Error('ADVISORY_PROOF_INVALID');
      raw[key]=rawArtifacts[id]!;times[key]=record.retrievedAt;
    }
    // Proof v21 window archives are unpacked here, before any consumer reads them, so every decoder and reuse path sees the exact original bodies.
    const plain=namespace==='window'&&version>=21?(()=>{try{return unpackAdvisoryWindowReceipts({rawArtifacts:raw,retrievedAt:times,requests:d.requests as Record<string,{method:string;params:unknown[]}>},version>=28).rawArtifacts;}catch{throw new Error('ADVISORY_PROOF_INVALID');}})():raw;
    return {raw:plain,times,requests:d.requests,ids:Object.values(d.artifactIds)};
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
  if(proof.callers){const c=resolve('callers'),s=proof.callerSemantic?resolve('callerSemantic'):null;additionalMetrics.push(...supersedingCallerMetrics([...socialMetrics,...additionalMetrics],replayCallerHistory(token,cutoff,evidence,rawArtifacts,c,proof.callers.selectionId,s,callerSemanticWire)));}
  if(proof.wallets){const w=resolve('wallets'),history=decodeAdvisoryWalletHistory(token,tradeData,{rawArtifacts:w.raw,retrievedAt:w.times,requests:w.requests as Record<string,{method:string;params:unknown[]}>},cutoff);additionalMetrics.push(...deriveWalletHistoryMetrics(history,tradeData,chainData,chain.raw,[...chain.ids,...trades.ids,...w.ids]));}
  // Proof v15 appends the exact public creator-role decode to S13 after the co-signing edges; failures keep the prior S13 quality and disclose every candidate.
  // Proof v18 keeps this decode and its receipts so the inventory cohort is recomputed from S13 itself, never read from a claim.
  let roleDecode:ReturnType<typeof decodeCreatorRole>|null=null,roleReceipts:{rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;requests:Record<string,unknown>;ids:string[]}|null=null,inventoryReplayed=false,failedReplayed=false;
  if(version>=15&&proof.creatorRole){const c=resolve('creatorRole'),prior=[...additionalMetrics].reverse().find(m=>m.id==='S13');roleReceipts={rawArtifacts:c.raw,retrievedAt:c.times,requests:c.requests,ids:c.ids};roleDecode=decodeCreatorRole(token,roleReceipts,cutoff,version>=26,version>=27,version>=28);additionalMetrics.push(creatorRoleS13(prior,roleDecode,c.ids));}
  additionalMetrics.push(...deriveAdvisoryDemand(tradeData,socialMetrics.find(m=>m.id==='A19'),cutoff,[...chain.ids,...trades.ids]));
  let shortDemand:ShortDemandReport|undefined;
  if(proof.window){
    const w=resolve('window'),windowRequests=w.requests as Record<string,{method:string;params:unknown[]}>;
    const windowData=decodeAdvisoryWindow(token,proof.pool,proof.window.end,w.raw,w.times,windowRequests,cutoff,version>=5,version>=6,version>=21,version>=23,version>=28,version>=35,version>=36);
    additionalMetrics.push(deriveO28Window(windowData,w.ids));
    // Appended after the bounded-sample O26 so complete account coverage supersedes it; an incomplete window keeps the older value.
    if(proof.accounts){const a=resolve('accounts'),history=decodeAdvisoryWindowAccounts(token,windowData,{rawArtifacts:w.raw,retrievedAt:w.times,requests:windowRequests},a.raw,a.times,a.requests as Record<string,{method:string;params:unknown[]}>,cutoff),metric=deriveO26Window(history,windowData,[...w.ids,...a.ids]);if(metric)additionalMetrics.push(metric);}
    if(proof.automation){const a=resolve('automation'),receipts:AutomationReceipts={rawArtifacts:a.raw,retrievedAt:a.times,requests:a.requests};additionalMetrics.push(deriveO30Window(token,windowData,{rawArtifacts:w.raw,retrievedAt:w.times,requests:windowRequests},receipts,cutoff,[...w.ids,...a.ids]));}
    // Appended after the sampled A30 so a complete-tape result supersedes it; an ineligible O28 hour keeps the older value.
    if(proof.demand){const d=resolve('demand'),history=decodeAdvisoryDemandWindows(token,windowData,{rawArtifacts:w.raw,retrievedAt:w.times,requests:windowRequests},d.raw,d.times,d.requests as Record<string,{method:string;params:unknown[]}>,cutoff,version>=14,version>=24),metric=deriveA30DemandWindows(history,[...w.ids,...d.ids]);if(metric)additionalMetrics.push(metric);
      // Proof v13 adds O23 from the same window and demand receipts; earlier proofs never derive it retrospectively.
      if(version>=13){const o23=deriveO23Synchrony(token,windowData,{rawArtifacts:w.raw,retrievedAt:w.times,requests:windowRequests},d.raw,d.times,d.requests as Record<string,{method:string;params:unknown[]}>,cutoff,[...w.ids,...d.ids],version>=24);if(o23)additionalMetrics.push(o23);}
      // Proof v14 adds O29 from that same retained-V history; A30 serializes no trades and O23 keeps its own default decode.
      if(version>=14){const o29=deriveO29ReservePath(history,[...w.ids,...d.ids]);if(o29)additionalMetrics.push(o29);}
      // Proof v16 adds the supplementary one-hour report from this same raw-receipt decode; an ineligible hour still yields an explicit NOT_ELIGIBLE report and earlier proofs never derive it.
      if(version>=16)shortDemand=deriveShortDemandReport(history,[...w.ids,...d.ids]);
      // Proof v18 adds O24 for the recomputed S13 creation signer over A30's measured hours from this complete tape and the inventory namespace; only a KNOWN result supersedes the sampled O24, and earlier proofs never derive it.
      if(version>=18&&proof.creatorInventory){const i=resolve('creatorInventory'),windowSet={rawArtifacts:w.raw,retrievedAt:w.times,requests:windowRequests};inventoryReplayed=true;
        const tape=creatorInventoryTape(windowData,windowSet,history),inventory={rawArtifacts:i.raw,retrievedAt:i.times,requests:i.requests as Record<string,{method:string;params:unknown[]}>},reuse=creatorInventoryReuse([['advisory-creatorRole-',roleReceipts!],['advisory-window-',windowSet]]),inventoryIds=[...w.ids,...d.ids,...roleReceipts!.ids,...i.ids];
        const o24=replayCreatorInventory(token,roleDecode,tape,inventory,reuse,cutoff,inventoryIds);
        if(o24.quality==='KNOWN'&&!additionalMetrics.some(m=>m.id==='O24'&&m.quality==='KNOWN'))additionalMetrics.push(o24);
        // Proof v19 adds O25 from these same typed role, tape, inventory receipts and reuse with no further read; its quality follows O24's verified gates, and earlier proofs never derive it.
        const cohort=roleDecode?creatorInventoryRole(token,roleDecode):null;
        if(version>=19&&cohort&&tape)additionalMetrics.push(deriveO25CreatorLifetime(token,cohort,tape,inventory,reuse,cutoff,inventoryIds));
        // Proof v20 adds S15 from these same role, tape, inventory receipts and reuse plus every owned failed-fee record translated unfiltered; a null descriptor stays not collected, never a known zero, and earlier proofs never derive it.
        if(version>=20&&cohort&&tape){
          const f=proof.creatorFailedFees?resolve('creatorFailedFees'):null;
          const failed:FailedFeeReceipt[]|null=f?failedOwned.map(e=>({id:e.id.startsWith(FAILED_FEE_EVIDENCE_PREFIX)?e.id.slice(FAILED_FEE_EVIDENCE_PREFIX.length):e.id,sourceId:e.sourceId,adapterVersion:e.adapterVersion,request:e.scope.request,retrievedAt:e.retrievedAt,contentHash:e.contentHash,stored:rawArtifacts[e.id]??''})):null;
          const s15=replayCreatorPerformance(token,roleDecode,tape,inventory,reuse,failed,cutoff,[...inventoryIds,...(f?.ids??[])],version>=25);
          // Receipts are admitted only after the S15 gate holds, so a populated descriptor over an unready gate is an orphan catalog.
          if(f&&(s15.data as {status?:unknown}).status==='PREREQUISITE_UNRESOLVED')throw new Error('ADVISORY_PROOF_INVALID');
          failedReplayed=!!f;additionalMetrics.push(s15);}}}
  }
  // Proof v22 replays the canonical holder population only through its holder archive; earlier proofs only through the plain live-v1 body.
  if(proof.topology){const t=resolve('topology'),receipts:TopologyReceipts={rawArtifacts:t.raw,retrievedAt:t.times,requests:t.requests};additionalMetrics.push(deriveAuthorityTopology(token,cutoff,evidence,rawArtifacts,receipts,version>=22));}
  // Proof v17 is v16 plus C16 decoded only from the four retained launchpad receipts; an uncollected run discloses that state instead of the registry default. The v16 supplement is unchanged.
  if(version>=17){if(proof.launchpad){const l=resolve('launchpad');additionalMetrics.push(deriveC16Launchpad(decodeLaunchpadContext({rawArtifacts:l.raw,retrievedAt:l.times,requests:l.requests as Record<string,LaunchpadRequest>},cutoff),l.ids));}else additionalMetrics.push(uncollectedC16());}
  // A populated inventory descriptor is valid only when its O24 replay ran over this proof's window and demand tape.
  if(proof.creatorInventory&&!inventoryReplayed)throw new Error('ADVISORY_PROOF_INVALID');
  // A populated failed-fee descriptor is valid only when its S15 replay consumed it over a ready gate.
  if(proof.creatorFailedFees&&!failedReplayed)throw new Error('ADVISORY_PROOF_INVALID');
  if(proof.creatorAccounting){
    if(!roleDecode||roleDecode.quality!=='KNOWN')throw new Error('ADVISORY_PROOF_INVALID');
    const a=resolve('creatorAccounting'),accounting=decodeCreatorQuoteAccounting(token,roleDecode,{rawArtifacts:a.raw,retrievedAt:a.times,requests:a.requests as Record<string,{method:string;params:unknown[]}>},cutoff,version>=30);
    const coverage=proof.creatorCoverage?(()=>{const c=resolve('creatorCoverage');return decodeCreatorCoverage(token,roleDecode,accounting.account,{rawArtifacts:c.raw,retrievedAt:c.times,requests:c.requests as Record<string,{method:string;params:unknown[]}>},cutoff,JSON.parse(a.raw.index??'{"result":[]}').result?.filter((x:any)=>x.err===null).map((x:any)=>x.signature)??[],{slot:accounting.coverage.headSlot,amountAtomic:accounting.coverage.canonicalHeadAtomic},version>=32);})():null;
    const routes=proof.creatorRoutes?(()=>{const r=resolve('creatorRoutes');return decodeCreatorRoutes(roleDecode,accounting,{rawArtifacts:a.raw,retrievedAt:a.times,requests:a.requests as Record<string,{method:string;params:unknown[]}>},{rawArtifacts:r.raw,retrievedAt:r.times,requests:r.requests as CreatorRouteReceipts['requests']},cutoff);})():null;
    const routeCoverageComplete=!!routes?.canonicalComplete&&coverage?.wholeWalletComplete===true&&coverage.failedFees.payerCensusComplete;
    const nativeRouteAccounting=routes?{...routes,routeCoverageComplete,unallocatedCosts:{...routes.unallocatedCosts,creatorFailedFees:coverage?.failedFees??null}}:null;
    const episode=version>=32&&proof.creatorEpisode?decodeCreatorEpisode(roleDecode,accounting,{rawArtifacts:a.raw,retrievedAt:a.times,requests:a.requests as Record<string,{method:string;params:unknown[]}>},routes,coverage,proof.creatorEpisode?(()=>{const e=resolve('creatorEpisode');return{rawArtifacts:e.raw,retrievedAt:e.times,requests:e.requests as CreatorEpisodeReceipts['requests']};})():null,cutoff):null;
    const prior=[...additionalMetrics].reverse().find(m=>m.id==='S15');
    additionalMetrics.push({id:'S15',quality:episode?.status==='KNOWN'||prior?.quality==='KNOWN'?'KNOWN':'MISSING',unit:'scoped-record',reasonCode:episode?.status==='KNOWN'?episode.reasonCode:prior?.quality==='KNOWN'?prior.reasonCode:episode?episode.reasonCode:routeCoverageComplete?'S15_NATIVE_LEDGER_COMPLETE_UNALLOCATED_COSTS':routes?'S15_NATIVE_ROUTE_COVERAGE_INCOMPLETE':(accounting.coverage.unresolved.length||version>=30&&(!accounting.coverage.indexComplete||!accounting.canonicalContinuity?.complete))?'S15_NATIVE_ACCOUNTING_EXECUTION_INCOMPLETE':coverage?.wholeWalletComplete&&coverage.failedFees.payerCensusComplete?'S15_NATIVE_ECONOMICS_UNRESOLVED':'S15_COMPLETE_CREATOR_COVERAGE_REQUIRED',
      data:{...(episode?{closedTargetEpisode:episode}:{}),...(prior?.data&&typeof prior.data==='object'?prior.data:{}),nativeQuoteAccounting:accounting,...(version>=31?{nativeRouteAccounting}:{}),...(version>=30?{creatorCoverage:coverage}:{}),completeCreatorPerformance:episode?.status==='KNOWN'||prior?.quality==='KNOWN'},evidenceIds:[...new Set([...(prior?.evidenceIds??[]),...roleReceipts!.ids,...a.ids,...(proof.creatorRoutes?Object.values(proof.creatorRoutes.artifactIds):[]),...(proof.creatorCoverage?Object.values(proof.creatorCoverage.artifactIds):[]),...(proof.creatorEpisode?Object.values(proof.creatorEpisode.artifactIds):[])])]});
  }
  let supplements:{shortDemand:ShortDemandReport}|undefined;
  if(version>=16){if(!shortDemand)throw new Error('ADVISORY_PROOF_INVALID');supplements={shortDemand};}
  if(version>=33){
    if(proof.exitCapacity){
      const record=candidateOwned[0]!,raw=rawArtifacts[record.id];
      if(record.id!==proof.exitCapacity.candidateSetId||record.sourceId!=='a12-reviewed-candidate-set'||record.accessMode!=='USER_IMPORT'||record.sourceType!=='REVIEWED_CORPUS'||record.adapterVersion!=='live-v1'||record.availableAt!==record.retrievedAt||Date.parse(record.availableAt)>Date.parse(cutoff)||typeof raw!=='string'||record.contentHash!==createHash('sha256').update(raw).digest('hex')||JSON.stringify(record.scope)!==JSON.stringify({method:version>=34?JSON.parse(raw).method:'a12-reviewed-candidate-set-v1'}))throw Error('ADVISORY_PROOF_INVALID');
      const capacity=resolve('exitCapacity');
      additionalMetrics.push((version>=34?deriveCustomExitCapacity:deriveExitCapacity)(JSON.parse(raw),token,cutoff,proof.exitCapacity.impactBps??undefined,chainData.genesisVerified?{requests:capacity.requests,rawArtifacts:capacity.raw,retrievedAt:capacity.times} as ExitCapacityReceipts:null,[record.id,...chain.ids,...capacity.ids]));
    }
  }
  // Proof v37 re-derives A24 only from the exact retained capture bytes after its provenance holds; INVALID provenance rejects, and the result is appended last so it supersedes every earlier A24.
  if(version>=37&&proof.saturation){
    const record=saturationOwned[0]!,raw=rawArtifacts[record.id];
    if(record.sourceId!==A24_SOURCE_ID||record.accessMode!=='USER_IMPORT'||record.sourceType!=='HISTORICAL_RECEIPT'||!(A24_CAPTURE_METHODS as readonly string[]).includes(record.adapterVersion)||evidence.filter(e=>e.id===record.id).length!==1||record.availableAt!==record.retrievedAt||Date.parse(record.availableAt)>Date.parse(cutoff)||typeof raw!=='string'||Buffer.byteLength(raw)>A24_LIMITS.retainedBytes||record.contentHash!==createHash('sha256').update(raw).digest('hex')||JSON.stringify(record.scope)!==JSON.stringify({method:record.adapterVersion}))throw new Error('ADVISORY_PROOF_INVALID');
    // The evidence adapter, its scope and the decoded transport method agree exactly; the capture is decoded and materialized once.
    let vector:ReturnType<typeof deriveA24FromDecoded>;
    try{const capture=decodeA24Capture(raw);if(capture.method!==record.adapterVersion)throw new Error('ADVISORY_PROOF_INVALID');vector=deriveA24FromDecoded(capture,token,cutoff,advisorySemanticRulesV3,[record.id]);}catch{throw new Error('ADVISORY_PROOF_INVALID');}
    if(vector.quality!=='KNOWN'&&vector.quality!=='MISSING')throw new Error('ADVISORY_PROOF_INVALID');
    additionalMetrics.push({id:'A24',quality:vector.quality,unit:'scoped-vector',data:vector,evidenceIds:[record.id],reasonCode:vector.reasonCode||(vector.quality==='KNOWN'?'A24_SATURATION_VECTOR_OBSERVED':'A24_SATURATION_VECTOR_MISSING')});
  }
  // Proof v38 adds A29 only from its one imported capture: the dedicated USER_IMPORT record keeps its copied latest source clock, its archive restores the exact file the descriptor hashes, and the provider re-derives the whole vector. Nothing else may cite it.
  if(version>=38&&proof.a29){
    const d=proof.a29,record=a29Owned[0],stored=record?rawArtifacts[record.id]:undefined;
    if(Object.keys(d.requests).join()!=='capture'||Object.keys(d.artifactIds).join()!=='capture'||d.artifactIds.capture!==A29_CAPTURE_ID||a29Owned.length!==1||!record||record.id!==A29_CAPTURE_ID||record.sourceId!==A29_SOURCE_ID||record.sourceType!=='RECONSTRUCTED_HISTORY'||record.accessMode!=='USER_IMPORT'||!(version>=39?[A29_CAPTURE_ADAPTER,A29_V2_CAPTURE_ADAPTER]:[A29_CAPTURE_ADAPTER]).includes(record.adapterVersion)||Object.keys(record.scope).join()!=='request'||advisoryHash(record.scope.request)!==advisoryHash(d.requests.capture)||typeof stored!=='string'||record.contentHash!==sha256(stored)||Date.parse(record.retrievedAt)>Date.parse(record.availableAt)||Date.parse(record.availableAt)>Date.parse(cutoff))throw new Error('ADVISORY_PROOF_INVALID');
    const metric=(():AdvisoryMetric=>{try{
      // Proof v39 dispatches by the record's exact adapter; the v1 archive path below is unchanged.
      if(record.adapterVersion===A29_V2_CAPTURE_ADAPTER)return a29DeriveV2(d,record,stored,token,cutoff,version>=40);
      const raw=unpackA29Capture(stored),capture=a29BoundCapture(raw,token);
      if(advisoryHash(a29CaptureRequest(raw,capture.label))!==advisoryHash(d.requests.capture)||capture.label!==d.label||capture.maxClock!==record.retrievedAt)throw new Error('ADVISORY_PROOF_INVALID');
      return deriveA29Absorption(capture.freeze,capture.label,capture.receipts,cutoff,[A29_CAPTURE_ID]);
    }catch{throw new Error('ADVISORY_PROOF_INVALID');}})();
    if(metric.id!=='A29'||metric.evidenceIds.some(id=>id!==A29_CAPTURE_ID)||[...socialMetrics,...additionalMetrics].some(m=>m.evidenceIds.includes(A29_CAPTURE_ID)))throw new Error('ADVISORY_PROOF_INVALID');
    additionalMetrics.push(metric);
  }
  return deriveAdvisory({token,cutoff,baseline,evidence,chain:chainData,market:marketData,socialMetrics,chainIds:chain.ids,marketIds:market.ids,paidIds:paid.ids,additionalMetrics,contextHistory:contextData,contextIds:context.ids,thesis,features,thesisEvidenceId:thesisRecord.id,method:version>=40?'advisory-measurements-v39':version>=39?'advisory-measurements-v38':version>=38?'advisory-measurements-v37':version>=37?'advisory-measurements-v36':version>=36?'advisory-measurements-v35':version>=35?'advisory-measurements-v34':version>=34?'advisory-measurements-v33':version>=33?'advisory-measurements-v32':version>=32?'advisory-measurements-v31':version>=31?'advisory-measurements-v30':version>=30?'advisory-measurements-v29':version>=29?'advisory-measurements-v28':version>=28?'advisory-measurements-v27':version>=27?'advisory-measurements-v26':version>=26?'advisory-measurements-v25':version>=25?'advisory-measurements-v24':version>=24?'advisory-measurements-v23':version>=21?'advisory-measurements-v22':version>=20?'advisory-measurements-v21':version>=19?'advisory-measurements-v20':version>=18?'advisory-measurements-v19':version>=17?'advisory-measurements-v18':version>=16?'advisory-measurements-v17':version>=15?'advisory-measurements-v16':version>=14?'advisory-measurements-v15':version>=13?'advisory-measurements-v14':'advisory-measurements-v13',supplements});
}
