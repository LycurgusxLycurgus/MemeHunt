import { createHash, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { VersionedMessage } from '@solana/web3.js';
import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { bundleSchema, liveBundleSchema, positionEventSchema, positionRecordSchema, profileSchema, thesisSchema, type FeatureResult, type AssessmentDetails, type Bundle, type LiveBundle, type EntrySnapshot, type ManagementSnapshot, type PlanBasisDeclaration, type PositionEvent, type PositionRecord, type Thesis, type ThesisEpisode, type TokenRef } from '../domain/contracts.js';
import { baselineIds, deriveBaseline, validateResearch } from '../domain/baseline.js';
import { evaluateEntry, evaluateManagement, evaluatePredicate, type ExecutionInputs, type StageInputs } from '../domain/policy.js';
import { reduceLedger } from '../domain/ledger.js';
import { deriveSocial, socialInputSchema, socialProposalSchema, socialReviewSchema } from '../domain/social.js';
import { deriveAttention,normalizeComparisonRefs,comparisonScopeV2Schema } from '../domain/attention.js';
import { decodeComparisonLeadArray } from '../providers/attention-model.js';
import { normalizeAttentionSearchUrl } from '../providers/attention.js';
import { validateSocialRepair,validateSocialWire } from '../providers/social-model.js';
import { parseSourceResponse } from '../providers/source-model.js';
import { decodeSharedAudit,validSharedReassessment } from '../providers/shared-model.js';
import { deriveShared,expireSharedWitnesses,sharedClaims,type SharedInputs } from '../domain/shared.js';
import { dexArtifacts, dexFetchBody, dexPairsUrl, parseDexFetch, parseDexPairs, type DexRecoveryReceipt } from '../providers/dexscreener.js';
import { evaluateManagementAs, MANAGEMENT_POLICY_VERSION } from '../domain/management-trace.js';
import { evaluateManagement as evaluateLegacyManagement } from '../domain/legacy-policy.js';

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
    const b = { ...parsed, token: normalizeToken(parsed.token, parsed.analysisKind === 'FIXTURE'), ...(parsed.exitProofs ? { exitProofs: parsed.exitProofs.map(p => ({...p,token:normalizeToken(p.token,parsed.analysisKind==='FIXTURE')})) } : {}) };
    if (b.analysisKind === 'MANUAL_EMPTY' && (b.evidence.length || b.features.length || b.observations.length || b.exitProofs?.length)) throw new Error('MANUAL_EMPTY_MUST_BE_EMPTY');
    if (b.evidence.length > 1000 || b.features.length > 1000 || b.observations.length > 1000) throw new Error('BUNDLE_LIMIT');
    const ids = new Set(b.evidence.map(e => e.id));
    if (ids.size !== b.evidence.length || new Set(b.features.map(f => f.id)).size !== b.features.length) throw new Error('DUPLICATE_BUNDLE_ID');
    for (const e of b.evidence) if (Date.parse(e.availableAt) > Date.parse(b.cutoff) || Date.parse(e.retrievedAt) > Date.parse(b.cutoff)) throw new Error('FUTURE_EVIDENCE');
    if (b.rawArtifacts && Object.keys(b.rawArtifacts).some(id => !ids.has(id))) throw new Error('UNREFERENCED_ARTIFACT');
    if ((b.analysisKind === 'USER_IMPORT' || b.analysisKind === 'LIVE') && b.evidence.some(e => b.rawArtifacts?.[e.id] === undefined)) throw new Error('RAW_ARTIFACT_REQUIRED');
    let artifactBytes = 0;
    for (const e of b.evidence) if (b.rawArtifacts?.[e.id] !== undefined) {
      const raw = b.rawArtifacts[e.id]; artifactBytes += Buffer.byteLength(raw);
      if (artifactBytes > (b.analysisKind === 'LIVE' ? 24_000_000 : 2_000_000) || createHash('sha256').update(raw).digest('hex') !== e.contentHash) throw new Error('ARTIFACT_HASH_OR_SIZE');
    }
    for (const e of b.evidence) {
      if (b.analysisKind === 'LIVE') {
        const sources: Record<string,string> = { 'solana-rpc': 'PUBLIC_API', 'pumpswap-direct':'PUBLIC_API','pumpswap-derived':'LOCAL_DERIVED', dexscreener: 'PUBLIC_API', 'tinyfish-search': 'FREE_ACCOUNT', 'tinyfish-fetch': 'FREE_ACCOUNT', gemini: 'FREE_ACCOUNT','local-config':'LOCAL_DERIVED','attention-collector':'LOCAL_DERIVED','social-collector':'LOCAL_DERIVED','shared-collector':'LOCAL_DERIVED','curated-research':'USER_IMPORT' };
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
    const proofs = b.exitProofs ?? [];
    if (new Set(proofs.map(p => p.id)).size !== proofs.length) throw new Error('DUPLICATE_BUNDLE_ID');
    for (const p of proofs) {
      if ([...p.evidenceIds, ...(p.outcome === 'FILLABLE' ? p.fees.flatMap(f => f.conversionEvidenceIds) : [])].some(id => !ids.has(id))) throw new Error('UNKNOWN_EVIDENCE_REF');
      if (Date.parse(p.asOf) > Date.parse(b.cutoff) || Date.parse(p.availableAt) > Date.parse(b.cutoff)) throw new Error('FUTURE_EXIT_PROOF');
    }
    if (b.analysisKind === 'LIVE') {
      validateDexRecovery(b);
      validateFeeRecovery(b);
      for (const claim of b.semantic.claims) if (!ids.has(claim.evidenceId)) throw new Error('UNKNOWN_SEMANTIC_REF');
      if(b.details){
        const details=b.details;
        if(details.version!==1||decisionHash(profileSchema.parse(details.profile))!==decisionHash(b.profile)||decisionHash(details.thesis)!==decisionHash(b.thesis??null)||!Array.isArray(details.baseline)||details.baseline.length!==baselineIds.length||new Set(details.baseline.map(a=>a.id)).size!==baselineIds.length||details.baseline.some(a=>!baselineIds.some(id=>id===a.id)||a.evaluator!=='IMPLEMENTED'||a.evidenceIds.some(id=>!ids.has(id)))||JSON.stringify(details).length>2_000_000)throw new Error('INVALID_ASSESSMENT_DETAILS');
        if(details.social){
          const record=b.evidence.find(e=>e.id==='social-derivation'&&e.sourceId==='social-collector'&&e.accessMode==='LOCAL_DERIVED');
          if(!record)throw new Error('SOCIAL_PROOF_REQUIRED');
          const packet=JSON.parse(b.rawArtifacts[record.id]) as {read:unknown;proposal:unknown;review:unknown;token:TokenRef;cutoff:string;evidenceIds:string[]};
          const read=socialInputSchema.parse(packet.read),proposal=packet.proposal===null?null:socialProposalSchema.parse(packet.proposal),review=packet.review===null?null:socialReviewSchema.parse(packet.review);
          if(tokenKey(packet.token)!==tokenKey(b.token)||packet.cutoff!==b.cutoff||!Array.isArray(packet.evidenceIds)||packet.evidenceIds.some(id=>!ids.has(id)||b.evidence.find(e=>e.id===id)?.accessMode==='USER_IMPORT'))throw new Error('SOCIAL_PROOF_INVALID');
          if(read.sources.some(source=>!packet.evidenceIds.includes(source.id))||packet.evidenceIds.some(id=>Date.parse(b.evidence.find(e=>e.id===id)!.availableAt)>Date.parse(read.qualifiedAt??read.end)))throw new Error('SOCIAL_PROOF_INVALID');
          if(proposal&&review){
            const receipt=b.evidence.find(e=>e.id==='social-qualified-receipt'&&e.sourceId==='social-collector');
            if(!receipt||!packet.evidenceIds.includes(receipt.id)||!['social-proposal-response','social-review-response'].every(id=>packet.evidenceIds.includes(id)&&b.evidence.some(e=>e.id===id&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT')))throw new Error('SOCIAL_PROOF_REQUIRED');
            const normalized=JSON.parse(b.rawArtifacts[receipt.id]);
            const {qualifiedAt:receiptTime,...receiptScope}=socialInputSchema.parse(normalized.read);
            const {qualifiedAt:derivationTime,...derivationScope}=read;
            if(decisionHash(normalized.proposal)!==decisionHash(proposal)||decisionHash(normalized.review)!==decisionHash(review)||decisionHash(receiptScope)!==decisionHash(derivationScope))throw new Error('SOCIAL_PROOF_INVALID');
            if(normalized.wireMethod!==undefined&&normalized.wireMethod!=='social-line-span-v2')throw new Error('SOCIAL_PROOF_INVALID');
            const hasRepair=Object.keys(b.rawArtifacts).some(id=>id.startsWith('social-repair-'));
            if((normalized.repairSelectionId!==undefined&&normalized.repairSelectionId!==(hasRepair?'social-repair-selection':null))||hasRepair&&!b.rawArtifacts['social-repair-selection'])throw new Error('SOCIAL_PROOF_INVALID');
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
            if(tokenKey(receipt.token)!==tokenKey(b.token)||Date.parse(receipt.cutoff)>Date.parse(b.cutoff)||!Array.isArray(receipt.evidenceIds)||receipt.evidenceIds.some((id:string)=>!ids.has(id)))throw new Error('SHARED_PROOF_INVALID');
            const localEmptyAttention=receipt.read.sources.length===0&&['claims','posts','competitors'].every(key=>Array.isArray(receipt.proposal?.[key])&&receipt.proposal[key].length===0)&&Array.isArray(receipt.review?.decisions)&&receipt.review.decisions.length===0&&receipt.review.candidateSet?.complete!==true&&(!receipt.review.originRelationship||receipt.review.originRelationship.status==='UNKNOWN');
            if(receipt.proposal&&receipt.review&&!localEmptyAttention&&!['attention-proposal-response','attention-review-response'].every(id=>receipt.evidenceIds.includes(id)&&b.evidence.some(e=>e.id===id&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT')))throw new Error('SHARED_PROOF_REQUIRED');
            if(receipt.read.comparisonComplete&&receipt.proposal&&receipt.review&&!b.evidence.some(e=>e.id==='attention-comparison-final-review-response'&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT'))throw new Error('SHARED_PROOF_REQUIRED');
            if(receipt.read.comparisonQualification?.evidenceAdequacy){
              if(!['attention-comparison-lead-proposal-response','attention-comparison-lead-review-response'].every(id=>receipt.evidenceIds.includes(id)&&b.evidence.some(e=>e.id===id&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT')))throw new Error('SHARED_PROOF_REQUIRED');
              const lead=receipt.read.comparisonAcquisition?.leads.find((l:{id:string})=>l.id===receipt.read.comparisonQualification.evidenceAdequacy.leadId);
              if(!lead||lead.recoveryQueryIds.some((id:string)=>!receipt.evidenceIds.includes(id)||!b.evidence.some(e=>e.id===id&&e.sourceId==='tinyfish-search'&&e.accessMode==='FREE_ACCOUNT')))throw new Error('SHARED_PROOF_REQUIRED');
            }
            if(receipt.read.comparisonQualification?.mode==='qualified-identified-leads-v2'){
              const parsedScope=comparisonScopeV2Schema.safeParse(receipt.read.comparisonQualification);
              if(!parsedScope.success)throw new Error('SHARED_PROOF_INVALID');
              const q=parsedScope.data;
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
              const compact=q.wireMethod==='comparison-lead-array-v1';
              let selectedWire=originalWire;
              if(q.proposalResponseId){
                const marker=b.evidence.find(e=>e.id==='comparison-lead-wire-repair'&&e.sourceId==='attention-collector'&&e.accessMode==='LOCAL_DERIVED');
                if(!compact||!marker||!receipt.evidenceIds.includes(marker.id))throw new Error('SHARED_PROOF_REQUIRED');
                const selection=JSON.parse(b.rawArtifacts[marker.id]);
                if(selection.method!=='comparison-lead-reference-repair-v1'||selection.code!=='ATT_MODEL_COMPARISON_LEAD_REF_INVALID'||selection.originalResponseId!=='attention-comparison-lead-proposal-response'||selection.selectedResponseId!==q.proposalResponseId)throw new Error('SHARED_PROOF_INVALID');
                let invalid=false;try{decodeComparisonLeadArray(originalWire,receipt.read.comparisonAcquisition.leads,receipt.read.sources,metadata);}catch(error){invalid=error instanceof Error&&error.message==='ATT_MODEL_COMPARISON_LEAD_REF_INVALID';}
                if(!invalid)throw new Error('SHARED_PROOF_INVALID');
                selectedWire=response(q.proposalResponseId);
              }
              const original=compact?decodeComparisonLeadArray(selectedWire,receipt.read.comparisonAcquisition.leads,receipt.read.sources,metadata):selectedWire;
              const review=compact?decodeComparisonLeadArray(reviewWire,receipt.read.comparisonAcquisition.leads,receipt.read.sources,metadata,true):reviewWire;
              const normalized=normalizeComparisonRefs(original,catalog) as {decisions:Record<string,Record<string,unknown>>};
              const stored=receipt.read.comparisonQualification;
              if(decisionHash(normalized)!==decisionHash(stored.proposal)||decisionHash(review)!==decisionHash(stored.review)||decisionHash(Object.keys(normalized.decisions).sort())!==decisionHash(q.decisions.map(d=>d.leadId).sort())||decisionHash(Object.keys(review.decisions).sort())!==decisionHash(q.decisions.map(d=>d.leadId).sort()))throw new Error('SHARED_PROOF_INVALID');
              for(const d of q.decisions){const p=normalized.decisions[d.leadId],actual=Object.fromEntries(Object.keys(p).map(k=>[k,d[k]]));if(decisionHash(actual)!==decisionHash(p)||decisionHash(d.review)!==decisionHash(review.decisions[d.leadId]))throw new Error('SHARED_PROOF_INVALID');}
              const planned=q.selectedLeadIds.length?response('attention-comparison-recovery-plan-response').leads:{};
              if(decisionHash(Object.keys(planned).sort())!==decisionHash([...q.selectedLeadIds].sort()))throw new Error('SHARED_PROOF_INVALID');
              const expectedQueries=q.selectedLeadIds.flatMap(parentLeadId=>{const item=planned[parentLeadId],lead=receipt.read.comparisonAcquisition.leads.find((l:{id:string})=>l.id===parentLeadId);if(!item||!lead||!Array.isArray(item.queries)||item.queries.length<1||item.queries.length>2||!item.metadataRefs.length||item.metadataRefs.some(ref=>ref.sourceId!==lead.metadataEvidenceId))throw new Error('SHARED_PROOF_INVALID');normalizeComparisonRefs(item.metadataRefs,metadata);return item.queries.map(query=>({parentLeadId,query}));});
              if(expectedQueries.length!==q.recoveryQueries.length||new Set(expectedQueries.map(q=>q.query)).size!==expectedQueries.length)throw new Error('SHARED_PROOF_INVALID');
              for(const [i,query] of q.recoveryQueries.entries()){
                if(query.queryId!==`attention-recovery-search-${i+1}`||query.parentLeadId!==expectedQueries[i].parentLeadId||query.query!==expectedQueries[i].query)throw new Error('SHARED_PROOF_INVALID');
                if(['OBSERVED','NO_RESULTS'].includes(query.state)){
                  const e=b.evidence.find(e=>e.id===query.queryId&&e.sourceId==='tinyfish-search'&&e.accessMode==='FREE_ACCOUNT'),raw=e?JSON.parse(b.rawArtifacts[e.id]):null;
                  if(!e||!receipt.evidenceIds.includes(e.id)||e.availableAt!==query.availableAt||!Array.isArray(raw?.results)||raw.results.length!==query.resultCount||query.state!==(raw.results.length?'OBSERVED':'NO_RESULTS')||!query.descriptorComplete||raw.results.some((r:{url?:unknown})=>!r||typeof r.url!=='string'))throw new Error('SHARED_PROOF_INVALID');
                }
              }
              const capture=b.evidence.find(e=>e.id==='live-state-capture'&&e.sourceId==='shared-collector'&&e.accessMode==='LOCAL_DERIVED');
              if(!capture)throw new Error('SHARED_PROOF_REQUIRED');
              const c=JSON.parse(b.rawArtifacts[capture.id]),canonical=b.evidence.filter(e=>e.sourceId==='solana-rpc'||e.id==='dex-pairs').map(e=>({id:e.id,retrievedAt:e.retrievedAt}));
              if(c.method!=='late-state-capture-v1'||tokenKey(c.token)!==tokenKey(b.token)||decisionHash(c.canonical)!==decisionHash(canonical)||c.discoveryId!==(b.evidence.some(e=>e.id==='dex-discovery')?'dex-discovery':null)||c.rpcState!==b.collection.rpc.state||c.dexState!==b.collection.dex.state||!Number.isFinite(Date.parse(c.startedAt))||!Number.isFinite(Date.parse(c.endedAt))||Date.parse(c.startedAt)>Date.parse(c.endedAt)||Date.parse(c.endedAt)>Date.parse(b.cutoff)||canonical.some(e=>Date.parse(e.retrievedAt)<Date.parse(c.startedAt)||Date.parse(e.retrievedAt)>Date.parse(c.endedAt))||b.evidence.some(e=>e.sourceId==='gemini'&&e.sourceType==='MODEL_RESPONSE'&&Date.parse(e.availableAt)>Date.parse(c.startedAt)))throw new Error('SHARED_PROOF_INVALID');
            }
            for(const source of receipt.read.sources){const e=b.evidence.find(e=>e.id===source.id);if(!e||e.sourceId!=='tinyfish-fetch'||e.accessMode!=='FREE_ACCOUNT'||!b.rawArtifacts[e.id].startsWith(source.text)||e.scope.url!==source.url||e.availableAt!==source.availableAt||e.scope.kind!==source.kind||e.scope.authorId!==source.authorId||e.scope.publishedAt!==source.publishedAt)throw new Error('SHARED_SOURCE_INVALID');}
            for(const length of receipt.read.comparisonQualification?.adequacySourceLengths??[]){const source=receipt.read.sources.find((s:{id:string})=>s.id===length.id);if(!source||!Number.isSafeInteger(length.retainedLength)||b.rawArtifacts[length.id]?.length!==length.retainedLength)throw new Error('SHARED_SOURCE_INVALID');}
            const fixedPosts=receipt.read.sources.filter((s:{id:string;kind:string})=>s.kind==='POST'&&(!receipt.read.postSampleSourceIds||receipt.read.postSampleSourceIds.includes(s.id)));
            const expectedSample={method:'fixed-query-sample-v1',sourceIds:fixedPosts.map((s:{id:string})=>s.id),queries:receipt.read.queries,complete:!!(receipt.read.postSampleComplete??receipt.read.complete)&&fixedPosts.every((s:{id:string;text:string;publishedAt:string|null})=>!!s.publishedAt&&Date.parse(s.publishedAt)<Date.parse(receipt.read.start)||b.rawArtifacts[s.id]===s.text)};
            if(decisionHash(receipt.read.growthSample)!==decisionHash(expectedSample))throw new Error('SHARED_PROOF_INVALID');
            const derived=deriveAttention(receipt.read,receipt.proposal,receipt.review,b.token,receipt.cutoff,receipt.evidenceIds,true);
            if(derived.some(a=>decisionHash(a)!==decisionHash(packet.baseline.find(x=>x.id===a.id))))throw new Error('SHARED_ATTENTION_INVALID');
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
            if(receipt.wireMethod!==undefined){
              if(receipt.wireMethod!=='shared-audit-wire-v2')throw new Error('SHARED_PROOF_INVALID');
              const repair=receipt.proposalResponseId==='shared-repair-proposal-response';
              if(receipt.proposalResponseId!==(repair?'shared-repair-proposal-response':'shared-proposal-response')||receipt.reviewResponseId!==(repair?'shared-repair-review-response':'shared-review-response')||![receipt.proposalResponseId,receipt.reviewResponseId].every(id=>b.evidence.some(e=>e.id===id&&e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT')))throw new Error('SHARED_PROOF_INVALID');
              try{
                const initial=decodeSharedAudit(packet.claims,packet.sources,b.rawArtifacts['shared-proposal-response'],b.rawArtifacts['shared-review-response']);
                const selected=repair?decodeSharedAudit(packet.claims,packet.sources,b.rawArtifacts[receipt.proposalResponseId],b.rawArtifacts[receipt.reviewResponseId]):initial;
                if(decisionHash(selected)!==decisionHash(receipt.audit)||repair&&!validSharedReassessment(initial,selected))throw new Error('SHARED_PROOF_INVALID');
              }catch{throw new Error('SHARED_PROOF_INVALID');}
            }
          }
          const derived=deriveShared(effective);
          if(decisionHash(derived.facts)!==decisionHash(details.shared)||derived.assessments.some(a=>decisionHash(a)!==decisionHash(details.baseline.find(x=>x.id===a.id))||decisionHash(a.projection)!==decisionHash(b.features.find(f=>f.id===a.id))))throw new Error('SHARED_FACTS_INVALID');
        }
        for(const field of ['circulatingMarketCapUsd','tokenCreatedAt'] as const){const value=details.stageInputs[field];if(value!==null&&!b.observations.some(o=>o.field===field&&o.value===value&&o.quality==='KNOWN'&&o.evidenceIds.every(id=>b.evidence.find(e=>e.id===id)?.accessMode==='PUBLIC_API')))throw new Error('UNQUALIFIED_STAGE_INPUT');}
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
    if (b.exitProofs?.length) throw new Error('EXIT_PROOFS_REQUIRE_REASSESSMENT');
    this.persistArtifacts(b); const social=b.analysisKind==='LIVE'?b.details?.social:undefined;const result = evaluateEntry(policyFeatures(b), b.profile, b.cutoff,social?.identityReview||social?.integrityReview?'QUALIFIED_V4':social?'QUALIFIED_V3':'QUALIFIED_V2',social,b.analysisKind==='LIVE'&&!!b.details?.shared);
    if (result.binary === 'PASS' && !b.thesis) throw new Error('PASS_REQUIRES_FROZEN_THESIS');
    const details=this.assessmentDetails(b);
    const semantic = { schemaVersion: 2, policyVersion: b.analysisKind==='LIVE'&&b.details?.shared?'research-screen-shared-v1':social?.identityReview||social?.integrityReview?'research-screen-v4':social?'research-screen-v3':'research-screen-v2', featureVersion: social?2:1, token: b.token, cutoff: b.cutoff, analysisKind: b.analysisKind, features: b.features, policyFeatures:policyFeatures(b), evidence: b.evidence, profile: b.profile, thesis: b.thesis ?? null, result,details,
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
    const execution:ExecutionInputs={token:b.token,evidence:b.evidence,exitProofs:b.exitProofs??[]};
    const policyVersion=b.analysisKind==='LIVE'?'thesis-management-v8':MANAGEMENT_POLICY_VERSION;
    const result = evaluateManagementAs(policyVersion,episode, policyFeatures(b), position, events, b.profile, b.cutoff,stageInputs(b),execution,social?.identityReview||social?.integrityReview?'QUALIFIED_V4':social?'QUALIFIED_V3':'QUALIFIED_V2',social);
    const details=this.assessmentDetails(b,episode.thesis);
    const semantic = { schemaVersion: 2, policyVersion, token:b.token, exitProofs:execution.exitProofs, attentionPolicy:social?.identityReview||social?.integrityReview?'QUALIFIED_V4':social?'QUALIFIED_V3':'QUALIFIED_V2', ...(social?{featureVersion:2}:{}), episode, cutoff: b.cutoff, analysisKind: b.analysisKind, features: b.features, policyFeatures:policyFeatures(b), evidence: b.evidence, profile: b.profile, position, events, stageInputs: stageInputs(b), result,details,
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
  /**
   * Saves a successor thesis. The caller must declare how its sell plan relates to earlier sales: CONTINUE keeps the predecessor's base and
   * counts sales by leg ID; FRESH_START rebases shares to the inventory held at `at` and counts only later sales. Saved episodes are never rewritten.
   */
  successor(caseId: string, thesisInput: Thesis, at: string, basis: PlanBasisDeclaration['mode']): ThesisEpisode {
    if (basis !== 'CONTINUE' && basis !== 'FRESH_START') throw new Error('SUCCESSOR_PLAN_BASIS_REQUIRED');
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
      const planBasis: PlanBasisDeclaration = { mode: basis, anchorAt: basis === 'FRESH_START' ? at : old.planBasis?.anchorAt ?? null };
      const episode: ThesisEpisode = { id: randomUUID(), caseId, baselineSnapshotId: old.baselineSnapshotId, thesis, createdAt: at, supersedesEpisodeId: old.id, planBasis };
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
    const execution:ExecutionInputs={token:semantic.token??null,evidence:semantic.evidence??[],exitProofs:semantic.exitProofs??[]};
    const policyVersion=semantic.policyVersion??(semantic.schemaVersion===1?(row.kind==='ENTRY'?'research-screen-v0':'thesis-management-v0'):undefined);
    const modern=['thesis-management-v5','thesis-management-v6','thesis-management-v7','thesis-management-v8'].includes(policyVersion);
    const historical=['thesis-management-v0','thesis-management-v1','thesis-management-v2','thesis-management-v3','thesis-management-v4'].includes(policyVersion);
    const entryVersions=['research-screen-v0','research-screen-v1','research-screen-v2','research-screen-v3','research-screen-v4','research-screen-shared-v1'];
    if(row.kind==='ENTRY'?!entryVersions.includes(policyVersion):!modern&&!historical)throw new Error(row.kind==='ENTRY'?'UNSUPPORTED_SNAPSHOT_VERSION':'UNSUPPORTED_POLICY_VERSION');
    const recomputed = row.kind === 'ENTRY' ? evaluateEntry(effective,semantic.profile,semantic.cutoff,policyVersion==='research-screen-shared-v1'?(semantic.details?.social?.identityReview||semantic.details?.social?.integrityReview?'QUALIFIED_V4':semantic.details?.social?'QUALIFIED_V3':'QUALIFIED_V2'):policyVersion==='research-screen-v4'?'QUALIFIED_V4':policyVersion==='research-screen-v3'?'QUALIFIED_V3':policyVersion==='research-screen-v2'?'QUALIFIED_V2':policyVersion==='research-screen-v1'?'QUALIFIED':'LEGACY',semantic.details?.social,policyVersion==='research-screen-shared-v1') : modern ? evaluateManagementAs(policyVersion,semantic.episode,effective,semantic.position,semantic.events,semantic.profile,semantic.cutoff,semantic.stageInputs,execution,semantic.attentionPolicy,semantic.details?.social) : evaluateLegacyManagement(semantic.episode,effective,semantic.position,semantic.events,semantic.profile,semantic.cutoff,semantic.stageInputs,policyVersion==='thesis-management-v4'?'QUALIFIED_V4':policyVersion==='thesis-management-v3'?'QUALIFIED_V3':policyVersion==='thesis-management-v2'?'QUALIFIED_V2':policyVersion==='thesis-management-v1'?'QUALIFIED':'LEGACY',semantic.details?.social);
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
