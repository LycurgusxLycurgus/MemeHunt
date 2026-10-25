import {a12CandidateSetSchema,collectExitCapacity,type A12CandidateSet} from '../providers/advisory-exit-capacity-custom.js';
import {collectCreatorEpisode} from '../providers/advisory-creator-episode.js';
import {A24_CAPTURE_METHOD,decodeA24Capture} from '../providers/advisory-saturation.js';
import {collectCreatorRoutes} from '../providers/advisory-creator-routes.js';
import {collectCreatorCoverage} from '../providers/advisory-creator-coverage.js';
import {decodeCreatorQuoteAccounting} from '../providers/advisory-creator-quote.js';
import { collectCreatorQuoteAccounting } from '../providers/advisory-creator-quote.js';
import { archiveHolderPopulation, collectAuthorityTopology, HOLDER_ARCHIVE_ADAPTER } from '../providers/advisory-topology.js';
import { collectAdvisoryAutomation } from '../providers/advisory-automation.js';
import { recoverOriginPages, qualifyOriginExclusions } from '../providers/origin-recovery.js';
import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { EvidenceRecord, FeatureResult, LiveBundle, Observation, Profile, Thesis, TokenRef } from '../domain/contracts.js';
import { dexArtifacts, fetchDexPairs, type DexRead, type DexRecoveryOptions } from '../providers/dexscreener.js';
import { geminiSettings } from '../providers/gemini.js';
import { geminiPacerForKey } from '../providers/gemini-pacing.js';
import { decodeSolanaAddress, inspectSolanaDetails, TOKEN_2022_PROGRAM,inspectSolanaMint, type SolanaRead, type SolanaDetails } from '../providers/solana.js';
import { deriveBaseline, validateResearch, type VenueOutcome } from '../domain/baseline.js';
import type { ResearchPacket } from '../domain/research.js';
import { materializeThesis } from './config.js';
import { inspectPumpSwap } from '../providers/pumpswap.js';
import { collectAttentionSources } from '../providers/attention.js';
import { qualifyAttention } from '../providers/attention-model.js';
import { deriveAttention, originSourceScope } from '../domain/attention.js';
import { collectSocialSources } from '../providers/social.js';
import { qualifySocial } from '../providers/social-model.js';
import { deriveSocial, type SocialInput, type SocialProposal, type SocialReview } from '../domain/social.js';
import { deriveShared,expireSharedWitnesses,sharedClaims,sharedWitnesses,comparisonEntryGrade,attentionEntryGates,type SharedAudit,type SharedSource } from '../domain/shared.js';
import { qualifyShared } from '../providers/shared-model.js';
import { collectAdvisoryWalletHistory } from '../providers/advisory-wallet-history.js';
import { archiveAdvisoryWindowReceipts, collectAdvisoryWindow, WINDOW_ARCHIVE_ADAPTER, WINDOW_EXPANDED_REQUEST_CAP } from '../providers/advisory-window.js';
import { collectAdvisoryWindowAccounts, ACCOUNT_RECEIPT_CAP } from '../providers/advisory-window-accounts.js';
import { collectAdvisoryDemandWindows, DEMAND_REQUEST_CAP, DEMAND_ARCHIVE_ADAPTER } from '../providers/advisory-demand-windows.js';
import { decodeAdvisoryTrades, collectAdvisoryTrades } from '../providers/advisory-trades.js';
import { collectAdvisoryContextHistory } from '../providers/advisory-context-history.js';
import { qualifyAdvisorySemantic,advisorySemanticRequests } from '../providers/advisory-semantic.js';
import { collectCallerHistory,CALLER_REQUEST_CAP } from '../providers/advisory-caller-history.js';
import { callerSeedFromEvidence,CALLER_SEED_METHOD,CALLER_SELECTION_ID } from '../providers/advisory-caller-measures.js';
import { collectAdvisoryChain } from '../providers/advisory-chain.js';
import { collectAdvisoryMarket } from '../providers/advisory-market.js';
import { collectAdvisorySocial } from '../providers/advisory-social.js';
import { PUBLIC_SOLANA_RPC } from '../providers/solana.js';
import { reconstructAdvisory,type AdvisoryProof } from './advisory.js';
import { collectCreatorRole,decodeCreatorRole } from '../providers/advisory-creator-role-collector.js';
import { collectLaunchpadContext } from '../providers/advisory-launchpad.js';
import { collectCreatorInventoryRun,CREATOR_INVENTORY_REQUEST_CAP } from '../providers/advisory-creator-inventory-collector.js';
import { collectCreatorFailedFeesRun,EXPANDED_CREATOR_FAILED_FEE_REQUEST_CAP,type CreatorFailedFeeReceipts } from '../providers/advisory-creator-performance-collector.js';
import { FAILED_FEE_ADAPTER,FAILED_FEE_SOURCE_ID } from '../providers/advisory-creator-failed-fees.js';
import { discoverTokenMetadata } from '../providers/token-discovery.js';
import { inspectDammV2 } from '../providers/meteora-damm-v2.js';
import { solanaRpc, safeRpcCode } from '../providers/solana.js';
import { inspectPumpCurve } from '../providers/pumpcurve.js';
import { createLiveRun, type LiveRuntime } from './live-phases.js';
import { entryGroupsForBundle } from '../providers/entry-groups.js';


export type LiveOptions = { a12CandidateSet?:A12CandidateSet; a24Capture?:string; profile: Profile; thesis?: Thesis; thesisExpiryMode?:'HORIZON'|'FIXED'|'NONE'; research?: ResearchPacket; origins?:Record<string,string>; rpcUrl?: string; tinyfishKey?: string; geminiKey?: string; solanaTrackerKey?: string; heliusKey?:string; creatorRolePrior?: import('../providers/advisory-creator-role.js').CreatorRoleReceipts; creatorCoveragePrior?: import('../providers/advisory-creator-quote.js').CreatorQuoteReceipts; semanticEnabled: boolean; advisoryEnabled?:boolean; fetcher?: typeof fetch; now?: () => string; signal?:AbortSignal; runtime?:LiveRuntime };
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
/** Wrapped admission: ordinary collectors share 150 requests; trader-account, demand-window, historical caller, creator-inventory, creator failed-fee and dense selected-window reads have their own explicit allowances. */
export function admittedFetchers(base:typeof fetch,deadline:AbortSignal,accountLimit:number,demandLimit=0,callerLimit=0,inventoryLimit=0,failedFeeLimit=0,windowLimit=0){
  const limit={shared:150,accounts:accountLimit,demand:demandLimit,callers:callerLimit,inventory:inventoryLimit,failedFees:failedFeeLimit,window:windowLimit},counts={shared:0,accounts:0,demand:0,callers:0,inventory:0,failedFees:0,window:0};
  const wrap=(pool:'shared'|'accounts'|'demand'|'callers'|'inventory'|'failedFees'|'window'):typeof fetch=>(url,init)=>{
    if(deadline.aborted)throw deadline.reason;
    if(counts[pool]>=limit[pool])throw new Error('COLLECTION_BUDGET');
    counts[pool]++;
    return base(url,{...init,signal:init?.signal?AbortSignal.any([deadline,init.signal]):deadline});
  };
  return {fetcher:wrap('shared'),accountFetcher:wrap('accounts'),demandFetcher:wrap('demand'),callerFetcher:wrap('callers'),inventoryFetcher:wrap('inventory'),failedFeeFetcher:wrap('failedFees'),windowFetcher:wrap('window'),limit,counts};
}
const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Caller work stops this long before the run deadline so late canonical, topology and venue capture keep their time. */
const CALLER_RESERVE_MS=120_000;
/** The unchanged live artifact cap; the late failed-fee stage is kept only when the projected whole bundle stays under it. The margin covers the late records' own metadata. */
const LIVE_ARTIFACT_CAP=24_000_000,FAILED_FEE_TAIL_MARGIN=65_536;

export async function collectLiveSolana(token: TokenRef, options: LiveOptions): Promise<LiveBundle> {
  if(token.chain!=='solana')throw new Error('INVALID_SOLANA_ADDRESS');
  return collectLiveToken(token,options);
}
export async function collectLiveToken(token: TokenRef, options: LiveOptions): Promise<LiveBundle> {
  if(options.a12CandidateSet){if(!options.advisoryEnabled||token.chain!=='solana')throw Error('A12_ADVISORY_REQUIRED');a12CandidateSetSchema.parse(options.a12CandidateSet);}
  // The A24 capture stays the original file text so its exact bytes are retained; this only validates schema and size, and the metric is re-derived at the final cutoff.
  if(options.a24Capture!==undefined){if(!options.advisoryEnabled||token.chain!=='solana')throw Error('A24_ADVISORY_REQUIRED');try{decodeA24Capture(options.a24Capture);}catch{throw Error('A24_CAPTURE_INVALID');}}
  if(token.chain==='solana'){if(!addressPattern.test(token.address))throw new Error('INVALID_SOLANA_ADDRESS');decodeSolanaAddress(token.address);}
  else if(!/^0x[a-fA-F0-9]{40}$/.test(token.address))throw new Error('INVALID_EVM_ADDRESS');
  if(options.advisoryEnabled&&token.chain!=='solana')throw new Error('ADVISORY_CHAIN_UNSUPPORTED');
  const now = options.now ?? (() => new Date().toISOString());
  if(options.research)validateResearch(options.research,token,now());
  const sharedEnabled=options.semanticEnabled&&!options.research;
  const runStartedAt=Date.now();
  const runBudgetMs=!options.semanticEnabled&&options.advisoryEnabled&&(options.tinyfishKey||options.creatorRolePrior)?1_800_000:sharedEnabled?840_000:120_000;
  const baseDeadline=AbortSignal.any([AbortSignal.timeout(runBudgetMs),...(options.signal?[options.signal]:[])]);
  const admission=admittedFetchers(options.fetcher??fetch,baseDeadline,options.advisoryEnabled?ACCOUNT_RECEIPT_CAP:0,options.advisoryEnabled?DEMAND_REQUEST_CAP:0,options.advisoryEnabled&&options.semanticEnabled?CALLER_REQUEST_CAP:0,options.advisoryEnabled&&(options.tinyfishKey||options.creatorRolePrior)?CREATOR_INVENTORY_REQUEST_CAP:0,options.advisoryEnabled&&(options.tinyfishKey||options.creatorRolePrior)?EXPANDED_CREATOR_FAILED_FEE_REQUEST_CAP:0,options.advisoryEnabled?WINDOW_EXPANDED_REQUEST_CAP:0),{fetcher:advisoryFetcher,accountFetcher,demandFetcher,callerFetcher,inventoryFetcher,failedFeeFetcher,windowFetcher}=admission;
  const run=createLiveRun(sharedEnabled,advisoryFetcher,now,options.runtime,options.signal);
  const collectionDeadline=AbortSignal.any([baseDeadline,...(sharedEnabled?[run.hardSignal]:[])]);
  let currentStage=run.begin(sharedEnabled?'PREFLIGHT':'FINALIZE');
  let fetcher=!sharedEnabled&&options.advisoryEnabled?advisoryFetcher:currentStage.fetcher,deadline=!sharedEnabled&&options.advisoryEnabled?collectionDeadline:currentStage.signal;
  let attentionElapsedMs:number|null=null,socialElapsedMs:number|null=null;
  const modelRouting={fallbackActive:false,...(options.semanticEnabled&&options.geminiKey?{pacing:geminiPacerForKey(options.geminiKey)}:{})};
  const evidence: EvidenceRecord[] = [];
  const rawArtifacts: Record<string,string> = {};
  const observations: Observation[] = [];
  const features: FeatureResult[] = [];
  const addEvidence = (id: string, raw: string, sourceId: string, sourceType: string, accessMode: EvidenceRecord['accessMode'], scope: Record<string,unknown>, at=now(), adapterVersion='live-v1'): string => {
    if(!('request' in scope)&&id.includes('-transport-attempt-'))try{const r=JSON.parse(raw);if(r.kind==='LOCAL_MODEL_TRANSPORT'&&[geminiSettings.model,geminiSettings.fallbackModel].includes(r.model))scope={...scope,model:r.model};}catch{/* Local receipt validation remains with its producer. */}
    if(!('request' in scope)&&sourceId==='gemini'&&sourceType==='MODEL_RESPONSE')try{const model=JSON.parse(raw).modelVersion;if(typeof model==='string'&&/^gemini-[a-zA-Z0-9.\-]{1,100}$/.test(model))scope={...scope,model};}catch{/* Failed response remains retained without an invented model version. */}
    evidence.push({ id, sourceId, sourceType, retrievedAt: at, availableAt: at, contentHash: hash(raw), adapterVersion, accessMode, scope });
    rawArtifacts[id] = raw;
    return id;
  };
  const observe = (field: string, value: string | boolean | null, unit: string, ids: string[], at = now()) =>
    observations.push({ id: `obs-${observations.length+1}`, subject: token, field, value, unit, evidenceIds: ids, observedAt: at, availableAt: at, quality: 'KNOWN' });
  const feature = (id: string, value: boolean, ids: string[], at=now()) =>
    features.push({ id, value, unit: 'bool', quality: 'KNOWN', availableAt: at, evidenceIds: ids, applicability: 'APPLICABLE' });
  let dexRecovery:DexRecoveryOptions|undefined=(sharedEnabled||options.advisoryEnabled)&&options.tinyfishKey?{tinyfishKey:options.tinyfishKey,signal:deadline}:undefined;
  const ingestDex=(read:DexRead,id:string)=>{const artifacts=dexArtifacts(read,id,token.chain,token.address,now());for(const [key,a] of Object.entries(artifacts))addEvidence(key,a.raw,a.sourceId,a.sourceType,a.accessMode,a.scope,a.retrievedAt);return artifacts[id]?[id]:[];};
  let rpc!:SolanaRead;
  let dex:DexRead=sharedEnabled?await fetchDexPairs(token.chain,token.address,fetcher,now,dexRecovery):{status:'UNAVAILABLE'};
  let detailRead:SolanaDetails|undefined;
  const rpcIds:string[]=[];
  let stateCaptureStartedAt:string|null=null,stateCaptureEndedAt:string|null=null;
  const ownStop=()=>{const code=deadline.aborted&&deadline.reason instanceof Error?deadline.reason.message:undefined;const origins:Record<string,VenueOutcome['origin']>={LIVE_PHASE_DEADLINE:'PHASE_DEADLINE',LIVE_HARD_DEADLINE:'HARD_DEADLINE',LIVE_CALLER_CANCELLED:'CALLER',LIVE_OPERATION_LIMIT:'OPERATION_LIMIT'};return code&&origins[code]?{code,origin:origins[code]}:undefined;};
  const captureCanonical=async()=>{
    stateCaptureStartedAt=sharedEnabled?now():null;
  [rpc, dex] = await Promise.all([
    token.chain==='solana'?inspectSolanaMint(token.address, options.rpcUrl, fetcher, deadline,sharedEnabled?now:undefined,preflightSlot):Promise.resolve({status:'UNAVAILABLE' as const,code:'EVM_READER_UNIMPLEMENTED',mint:undefined,genesisRaw:undefined,accountRaw:undefined,genesisHash:undefined}),
    fetchDexPairs(token.chain, token.address, fetcher,now,dexRecovery),
  ]);
  detailRead=rpc.status==='OBSERVED'&&rpc.mint?await inspectSolanaDetails(rpc.mint,token.address,options.rpcUrl,fetcher,deadline,sharedEnabled?now:undefined,options.advisoryEnabled?20_000_000:64_000_000):undefined;
  const interrupted=ownStop();if(interrupted){if(rpc.status==='UNAVAILABLE')rpc.code=interrupted.code;if(dex.status==='UNAVAILABLE')dex.code=interrupted.code;for(const key of Object.keys(detailRead?.errors??{}))detailRead!.errors[key]=interrupted.code;}
  rpcIds.length=0;
  if (rpc.genesisRaw) rpcIds.push(addEvidence('rpc-genesis', rpc.genesisRaw, 'solana-rpc', 'JSON_RPC', 'PUBLIC_API', { method: 'getGenesisHash', genesisHash: rpc.genesisHash ?? null },rpc.retrievedAt?.['rpc-genesis']));
  if (rpc.accountRaw) rpcIds.push(addEvidence('rpc-account', rpc.accountRaw, 'solana-rpc', 'JSON_RPC', 'PUBLIC_API', { method: 'getAccountInfo', commitment: 'finalized', genesisHash: rpc.genesisHash ?? null, slot: rpc.mint?.slot ?? null },rpc.retrievedAt?.['rpc-account']));
  if(detailRead&&Object.keys(detailRead.errors).length)addEvidence('rpc-detail-errors',JSON.stringify({method:'rpc-detail-errors-v1',errors:detailRead.errors}),'solana-rpc-diagnostics','DIAGNOSTIC','LOCAL_DERIVED',{method:'rpc-detail-errors-v1'});
  // Advisory runs (proof v22) store the canonical holder population as its exact holder archive under the same id, source, scope and clock; the provider already decoded the plain body.
  for(const [id,raw] of Object.entries(detailRead?.rawArtifacts??{})){const archived=!!options.advisoryEnabled&&id==='rpc-holder-population';addEvidence(id,archived?archiveHolderPopulation(raw):raw,'solana-rpc','JSON_RPC','PUBLIC_API',{operation:id,commitment:'finalized',mint:token.address,...(id==='rpc-holder-population'&&rpc.mint?.programId===TOKEN_2022_PROGRAM?{fullAccountData:true}:{})},detailRead?.retrievedAt?.[id],archived?HOLDER_ARCHIVE_ADAPTER:'live-v1');}
  const mintAt=sharedEnabled?(rpc.retrievedAt?.['rpc-account']??now()):'';
  const mintFeature=(id:string,value:boolean,ids:string[])=>sharedEnabled?feature(id,value,ids,mintAt):feature(id,value,ids);
  const mintObserve=(field:string,value:string|boolean|null,unit:string,ids:string[])=>sharedEnabled?observe(field,value,unit,ids,mintAt):observe(field,value,unit,ids);
  if (rpc.status === 'OBSERVED' && rpc.mint && rpcIds.length === 2) {
    const accountId = ['rpc-genesis', 'rpc-account'];
    const mint = rpc.mint;
    if (mint.kind === 'NON_MINT') {
      mintFeature('O01', false, accountId);
      mintObserve('mintAccountKind', mint.reason, 'enum', accountId);
    } else if (mint.kind === 'MINT_LEGACY' || mint.kind === 'MINT_TOKEN_2022_PARTIAL') {
      mintFeature('O01', true, accountId);
      mintObserve('mintProgramId', mint.programId, 'base58', accountId);
      mintObserve('supplyAtomic', mint.supplyAtomic, 'atomic', accountId);
      mintObserve('decimals', String(mint.decimals), 'count', accountId);
      mintObserve('mintAuthority', mint.mintAuthority, 'base58', accountId);
      mintObserve('freezeAuthority', mint.freezeAuthority, 'base58', accountId);
      if (mint.kind === 'MINT_LEGACY') {
        if (mint.mintAuthority === null) mintFeature('O03', true, accountId);
        if (mint.freezeAuthority === null) mintFeature('O04', true, accountId);
        mintFeature('O06', true, accountId);
      }
    }
  }
  const dexIds: string[] = ingestDex(dex,'dex-pairs');
  const marketObserve=(field:string,value:string|boolean|null,unit:string,ids:string[])=>(sharedEnabled||dex.recovery?.selected)?observe(field,value,unit,ids,dex.retrievedAt??now()):observe(field,value,unit,ids);
  if (dex.market && dexIds.length) {
    marketObserve('reportedPairCount', String(dex.market.reportedPairCount), 'count', dexIds);
    marketObserve('retainedPairCount', String(dex.market.retainedPairCount), 'count', dexIds);
    for (const [i,p] of dex.market.pairs.entries()) {
      const stem = `pair.${i+1}`;
      marketObserve(`${stem}.address`, p.pairAddress, 'base58', dexIds);
      marketObserve(`${stem}.mintSide`, p.mintSide, 'enum', dexIds);
      if (p.priceUsd !== null) marketObserve(`${stem}.priceUsd`, p.priceUsd, 'USD/token', dexIds);
      if (p.liquidityUsd !== null) marketObserve(`${stem}.liquidityUsd`, p.liquidityUsd, 'USD', dexIds);
      if (p.volume24hUsd !== null) marketObserve(`${stem}.volume24hUsd`, p.volume24hUsd, 'USD/24h', dexIds);
      if (p.buys24h !== null) marketObserve(`${stem}.buys24h`, String(p.buys24h), 'trades/24h', dexIds);
      if (p.sells24h !== null) marketObserve(`${stem}.sells24h`, String(p.sells24h), 'trades/24h', dexIds);
      if (p.pairCreatedAt) marketObserve(`${stem}.poolCreatedAt`, p.pairCreatedAt, 'datetime', dexIds);
    }
    const mint = rpc.mint;
    const price = dex.market.pairs.find(p => p.mintSide === 'base' && p.priceUsd !== null)?.priceUsd;
    if (price && mint && (mint.kind === 'MINT_LEGACY' || mint.kind === 'MINT_TOKEN_2022_PARTIAL') && rpcIds.length === 2) {
      const fdv = new Decimal(mint.supplyAtomic).div(new Decimal(10).pow(mint.decimals)).mul(price);
      if (fdv.isFinite()) {
        observe('derivedFdvUsd', fdv.toFixed(), 'USD', [...rpcIds,...dexIds],sharedEnabled?new Date(Math.max(Date.parse(mintAt),Date.parse(dex.retrievedAt??now()))).toISOString():undefined);
        feature('O02', true, [...rpcIds,...dexIds],sharedEnabled?new Date(Math.max(Date.parse(mintAt),Date.parse(dex.retrievedAt??now()))).toISOString():undefined);
      }
    }
  }
    stateCaptureEndedAt=sharedEnabled?now():null;
  };
  let preflightSlot:number|undefined;
  if(sharedEnabled){
    ingestDex(dex,'dex-discovery');
    if(token.chain==='solana'){
      const probe=await inspectSolanaMint(token.address,options.rpcUrl,fetcher,deadline,now);
      preflightSlot=probe.status==='OBSERVED'?probe.mint?.slot??undefined:undefined;
      if(probe.genesisRaw)addEvidence('preflight-rpc-genesis',probe.genesisRaw,'solana-rpc-preflight','JSON_RPC','PUBLIC_API',{method:'getGenesisHash',role:'discovery only'},probe.retrievedAt?.['rpc-genesis']);
      if(probe.accountRaw)addEvidence('preflight-rpc-account',probe.accountRaw,'solana-rpc-preflight','JSON_RPC','PUBLIC_API',{method:'getAccountInfo',role:'discovery only',slot:preflightSlot??null},probe.retrievedAt?.['rpc-account']);
    }
  }
  else await captureCanonical();
  const advisoryPool=dex.market?.pairs.find(pair=>pair.baseAddress===token.address||pair.quoteAddress===token.address)?.pairAddress??null;
  const advisoryAddresses=[token.address,...(advisoryPool?[advisoryPool]:[])];
  // Preregister one completed UTC hour; this is separate from the holding horizon.
  const advisoryWindowEnd=new Date(Math.floor(Date.parse(now())/3_600_000)*3_600_000).toISOString();
  // Creator-role reads run first on the shared pool, so its few candidate receipts are not rate-limited by the bulk historical reads; a mint already read under another token program is skipped.
  const creatorPending=options.advisoryEnabled&&(options.tinyfishKey||options.creatorRolePrior)&&!(rpc?.mint&&typeof rpc.mint.programId==='string'&&rpc.mint.programId!==TOKEN_2022_PROGRAM)?Promise.resolve().then(()=>{if(options.creatorRolePrior){if(decodeCreatorRole(token,options.creatorRolePrior,now(),true,true,true).quality!=='KNOWN')throw new Error('CREATOR_ROLE_REUSE_UNVERIFIED');return options.creatorRolePrior;}return collectCreatorRole(token,options.tinyfishKey!,options.rpcUrl??PUBLIC_SOLANA_RPC,advisoryFetcher,now,collectionDeadline);}).catch(error=>({error})):null;
  const accountingPending=creatorPending?Promise.resolve(creatorPending).then(creator=>'error' in creator?null:collectCreatorQuoteAccounting(token,creator,options.rpcUrl??PUBLIC_SOLANA_RPC,options.fetcher??fetch,now,collectionDeadline,true)).catch(()=>null):null;
  const routesPending=options.heliusKey&&accountingPending&&creatorPending?Promise.all([accountingPending,creatorPending]).then(([accounting,creator])=>{if(!accounting||'error' in creator)return null;const role=decodeCreatorRole(token,creator,now(),true,true,true);return collectCreatorRoutes(decodeCreatorQuoteAccounting(token,role,accounting,now(),true),accounting,options.heliusKey!,options.fetcher??fetch,now,collectionDeadline);}).catch(()=>null):null;
  const episodePending=options.heliusKey&&accountingPending&&creatorPending?Promise.all([accountingPending,creatorPending]).then(([accounting,creator])=>{if(!accounting||'error' in creator)return null;const role=decodeCreatorRole(token,creator,now(),true,true,true);return collectCreatorEpisode(role,decodeCreatorQuoteAccounting(token,role,accounting,now(),true),accounting,options.rpcUrl??PUBLIC_SOLANA_RPC,options.heliusKey!,options.fetcher??fetch,now,collectionDeadline);}).catch(()=>null):null;
  const coveragePending=accountingPending&&creatorPending?Promise.all([accountingPending,creatorPending]).then(async([accounting,creator])=>{if(!accounting||'error' in creator)return null;const role=decodeCreatorRole(token,creator,now(),true,true,true),native=decodeCreatorQuoteAccounting(token,role,accounting,now(),true);return collectCreatorCoverage(token,role,native.account,options.creatorCoveragePrior?{requests:{...options.creatorCoveragePrior.requests,...accounting.requests},rawArtifacts:{...options.creatorCoveragePrior.rawArtifacts,...accounting.rawArtifacts},retrievedAt:{...options.creatorCoveragePrior.retrievedAt,...accounting.retrievedAt}}:accounting,options.rpcUrl??PUBLIC_SOLANA_RPC,options.fetcher??fetch,now,AbortSignal.any([collectionDeadline,AbortSignal.timeout(Math.max(1,runStartedAt+runBudgetMs-120_000-Date.now()))]),true);}).catch(()=>null):null;
  // Historical reads overlap semantic review but start only once creator-role and any native-quote/coverage collection have settled, whatever its outcome; canonical execution state is still captured late.
  const advisoryPending=options.advisoryEnabled?Promise.resolve(coveragePending??accountingPending??creatorPending).then(()=>Promise.all([
    collectAdvisoryChain(token,advisoryAddresses,options.rpcUrl??PUBLIC_SOLANA_RPC,advisoryFetcher,now,collectionDeadline,true),
    collectAdvisoryMarket(token,advisoryPool,advisoryFetcher,now,collectionDeadline),
    collectAdvisorySocial(token,advisoryFetcher,now,collectionDeadline),
    collectAdvisoryTrades(token,advisoryPool,options.rpcUrl??PUBLIC_SOLANA_RPC,advisoryFetcher,now,collectionDeadline),
    collectAdvisoryContextHistory(token,advisoryFetcher,now,collectionDeadline),
  ])).then(async value=>{
    const [chain,,,trades]=value;
    const decoded=decodeAdvisoryTrades(token,advisoryPool,chain.data,chain.rawArtifacts,chain.retrievedAt,chain.requests,trades.rawArtifacts,trades.retrievedAt,trades.requests);
    const [wallets,{window,accounts,automation,demand}]=await Promise.all([
      collectAdvisoryWalletHistory(decoded,options.rpcUrl??PUBLIC_SOLANA_RPC,advisoryFetcher,now,collectionDeadline),
      // Proof v28: the expanded selected hour opts into guarded truncation recovery and pool-quote admission on its own1045-request allowance; every in-run consumer below receives the same guarded decoded tape.
      collectAdvisoryWindow(token,advisoryPool,options.rpcUrl??PUBLIC_SOLANA_RPC,windowFetcher,now,advisoryWindowEnd,collectionDeadline,chain,true,true,true,true,true,true,true)
        .then(async window=>{const [accounts,automation,demand]=await Promise.all([collectAdvisoryWindowAccounts(token,window,options.rpcUrl??PUBLIC_SOLANA_RPC,accountFetcher,now,collectionDeadline),collectAdvisoryAutomation(token,window.data,options.rpcUrl??PUBLIC_SOLANA_RPC,advisoryFetcher,now,collectionDeadline),collectAdvisoryDemandWindows(token,window,options.rpcUrl??PUBLIC_SOLANA_RPC,demandFetcher,now,collectionDeadline)]);return {window,accounts,automation,demand};}),
    ]);
    return {value,wallets,window,accounts,automation,demand};
  },error=>({error})):null;
  // Launchpad reads (one keyed Lighthouse, three public Llama) run independently on the shared pool and collectionDeadline; without a key nothing is requested, and a failed collector retains nothing.
  const launchpadPending=options.advisoryEnabled&&options.solanaTrackerKey?collectLaunchpadContext(options.solanaTrackerKey,advisoryFetcher,now,collectionDeadline).catch(()=>null):null;
  // Creator inventory starts once S13 and the complete A30 tape have both finished, reads only on its own allowance and, in the 600 s mode, stops at the caller reserve so late capture keeps its time.
  const inventoryPending=advisoryPending&&creatorPending?Promise.all([advisoryPending,creatorPending]).then(([advisory,creator])=>'error' in advisory||'error' in creator?null:collectCreatorInventoryRun(token,creator,advisory.window,advisory.demand,options.rpcUrl??PUBLIC_SOLANA_RPC,inventoryFetcher,now,options.semanticEnabled?AbortSignal.any([collectionDeadline,AbortSignal.timeout(Math.max(1,runStartedAt+runBudgetMs-CALLER_RESERVE_MS-Date.now()))]):collectionDeadline,true,true)).catch(error=>({error})):null;
  // Failed-fee receipts start once the inventory task has finished with receipts that will be ingested; they read only on their own allowance, stop at the same reserve, and the collector admits a read only after the recomputed S13/A30/O24/O25 gate holds.
  const failedFeesPending=inventoryPending?Promise.all([advisoryPending!,creatorPending!,inventoryPending]).then(([advisory,creator,inventory])=>'error' in advisory||'error' in creator||!inventory||'error' in inventory||!Object.keys(inventory.rawArtifacts).length?null:collectCreatorFailedFeesRun(token,creator,advisory.window,advisory.demand,inventory,options.rpcUrl??PUBLIC_SOLANA_RPC,failedFeeFetcher,now,options.semanticEnabled?AbortSignal.any([collectionDeadline,AbortSignal.timeout(Math.max(1,runStartedAt+runBudgetMs-CALLER_RESERVE_MS-Date.now()))]):collectionDeadline,true,true,true)).catch(error=>({error})):null;
  let web: LiveBundle['collection']['web'] = {state: options.semanticEnabled ? 'KEY_MISSING' : 'NOT_REQUESTED'};
  let semantic:LiveBundle['semantic']={status:options.semanticEnabled?'KEY_MISSING':'NOT_REQUESTED',claims:[]};
  let attention:ReturnType<typeof deriveAttention>|undefined;
  let sharedAudit:SharedAudit|null=null;
  let sharedSources:SharedSource[]=[];
  const semanticReceiptIds:string[]=[];
  let socialPacket:{read:SocialInput;proposal:SocialProposal|null;review:SocialReview|null;evidenceIds:string[]}|undefined;
  // Historical caller reads and their independent classification run in one background task on the caller pool; the late block only ingests its finished result once.
  type CallerRun={history:Awaited<ReturnType<typeof collectCallerHistory>>;classified:Awaited<ReturnType<typeof qualifyAdvisorySemantic>>|null;classifiedAt:string|null;status:string};
  let callerPending:Promise<CallerRun|{error:unknown}>|null=null,callerStatus='NOT_ATTEMPTED';
  if(options.semanticEnabled&&options.tinyfishKey&&options.geminiKey){
    let attentionStartedAt=run.runtime.nowMs();
    let name:string|undefined,metadataUri:string|undefined;const discoveryUrls:string[]=[];
    try{
      const pairs=JSON.parse(dex.recovery&&!dex.recovery.selected?'[]':dex.raw??'[]') as Array<{chainId:string;baseToken?:{address:string;name?:string};quoteToken?:{address:string;name?:string};info?:{websites?:Array<{url?:string}>;socials?:Array<{url?:string}>}}>;
      const matches=(address?:string)=>token.chain==='solana'?address===token.address:address?.toLowerCase()===token.address.toLowerCase();
      const pair=pairs.find(p=>p.chainId===token.chain&&(matches(p.baseToken?.address)||matches(p.quoteToken?.address)));name=matches(pair?.baseToken?.address)?pair?.baseToken?.name:pair?.quoteToken?.name;
      // Pair metadata describes the base token; a quote-side match cannot supply its project links.
      for(const p of pairs.filter(p=>p.chainId===token.chain&&matches(p.baseToken?.address))){
        for(const link of [...(Array.isArray(p.info?.websites)?p.info.websites:[]),...(Array.isArray(p.info?.socials)?p.info.socials:[])])if(typeof link?.url==='string'&&!discoveryUrls.includes(link.url)&&discoveryUrls.length<4)discoveryUrls.push(link.url);
      }
    }catch{/* Discovery metadata is optional and untrusted, never identity evidence. */}
    if(sharedEnabled&&token.chain==='solana'){
      const discovery=await discoverTokenMetadata(token.address,options.rpcUrl,currentStage.fetcher,now,currentStage.signal);
      for(const [id,raw] of Object.entries(discovery.rawArtifacts))addEvidence(id,raw,'token-metadata-discovery','JSON_RPC','PUBLIC_API',{mint:token.address,role:'discovery only'},discovery.retrievedAt[id]);
      if(discovery.uri){metadataUri=discovery.uri;if(!discoveryUrls.includes(discovery.uri))discoveryUrls.unshift(discovery.uri);}
    }
    if(sharedEnabled)currentStage.finish();
    const attentionStage=sharedEnabled?run.begin('ATTENTION'):currentStage;
    const fetcher=attentionStage.fetcher,deadline=attentionStage.signal;
    const dexRecovery=sharedEnabled&&options.tinyfishKey?{tinyfishKey:options.tinyfishKey,signal:deadline}:undefined;
    attentionStartedAt=run.runtime.nowMs();
    let read=await collectAttentionSources(token,options.tinyfishKey,fetcher,now,name,discoveryUrls,undefined,sharedEnabled?'public-support-v2':undefined);
    if(metadataUri){read.metadataLinks=true;read.metadataUri=metadataUri;if(sharedEnabled)read.metadataLinkMethod='onchain-metadata-v1';}
    if(sharedEnabled){read.originScope=originSourceScope(read,token);read=await recoverOriginPages(read,token,options.tinyfishKey,fetcher,now);read.originScope=originSourceScope(read,token);read=await qualifyOriginExclusions(read,token,options.tinyfishKey,options.geminiKey,fetcher,now,deadline,modelRouting);read.originScope=originSourceScope(read,token);}
    web={state:read.sources.length?read.complete?'OBSERVED':'TRUNCATED':read.complete?'NO_RESULTS':'UNAVAILABLE',count:read.sources.length,...(read.codes.length?{code:read.codes[0]}:{})};
    const ids:string[]=[];
    for(const [id,raw] of Object.entries(read.rawArtifacts))ids.push(id.endsWith('-http-outcomes')?addEvidence(id,raw,'attention-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:'fetch-http-outcomes-v1'}):id.startsWith('attention-origin-role-')&&id.endsWith('-search-query')?addEvidence(id,raw,'attention-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:'origin-recovery-query-v1'}):id.startsWith('attention-origin-role-')&&!id.endsWith('-search')&&!id.endsWith('-fetch')?addEvidence(id,raw,'gemini',id.endsWith('-prompt')?'MODEL_INPUT':'MODEL_RESPONSE','FREE_ACCOUNT',{method:'origin-role-review-v1'}):addEvidence(id,raw,(id==='attention-origin-recovery-scope'||id==='attention-origin-exclusion-scope')||id.endsWith('-metadata')?'attention-collector':id.includes('search')?'tinyfish-search':'tinyfish-fetch',(id==='attention-origin-recovery-scope'||id==='attention-origin-exclusion-scope')?'SAMPLE_SCOPE':id.endsWith('-metadata')?'INDEXED_LEAD':'ATTENTION_SAMPLE',(id==='attention-origin-recovery-scope'||id==='attention-origin-exclusion-scope')||id.endsWith('-metadata')?'LOCAL_DERIVED':'FREE_ACCOUNT',{queries:read.queries,discoveryUrls:read.discoveryUrls,scope:'bounded web search and DEX-linked source sample'}));
    for(const s of read.sources)ids.push(addEvidence(s.id,s.text,'tinyfish-fetch','WEB_PAGE','FREE_ACCOUNT',{url:s.url,publishedAt:s.publishedAt,authorId:s.authorId,kind:s.kind,...(s.discoveredFrom?{discoveredFrom:s.discoveredFrom}:{})},s.availableAt));
    ids.push(addEvidence('attention-acquisition-scope',JSON.stringify({...(read.metadataLinkMethod?{metadataLinkMethod:read.metadataLinkMethod}:{}),...(read.leadershipPositiveMethod?{leadershipPositiveMethod:read.leadershipPositiveMethod}:{}),...(read.collectionMethod?{collectionMethod:read.collectionMethod}:{}),entryEvidenceMethod:read.entryEvidenceMethod,comparisonAcquisition:read.comparisonAcquisition,comparisonComplete:read.comparisonComplete,comparisonSourceIds:read.comparisonSourceIds,codes:read.codes}),'attention-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:'original-comparison-acquisition-v1'}));
    // Freeze original target posts and identity sources before comparison-only recovery.
    const socialSeed=structuredClone(read);
    const socialSeedAt=now();
    if(!options.research)addEvidence('social-attention-seed',JSON.stringify({method:'attention-social-seed-v1',read:{...socialSeed,rawArtifacts:{},sources:socialSeed.sources.map(({text,...source})=>source)}}),'social-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:'attention-social-seed-v1'},socialSeedAt);
    const socialWork=!options.research?(async()=>{
      const stage=run.begin('SOCIAL'),started=run.runtime.nowMs();
      try{
        const socialRead=await collectSocialSources(token,socialSeed,options.tinyfishKey!,stage.fetcher,now,stage.signal);
        const {rawArtifacts:acquisitionArtifacts,...socialInput}=socialRead;
        const qualification=await qualifySocial(socialInput,token,options.geminiKey!,stage.fetcher,options.runtime?.wait,stage.signal,{screeningRepair:sharedEnabled,modelRouting});
        const qualifiedAt=now();stage.finish(qualification.code?{code:qualification.code,origin:'PROVIDER'}:undefined);
        return {socialRead,acquisitionArtifacts,qualification,qualifiedAt,elapsedMs:Math.max(0,run.runtime.nowMs()-started)};
      }catch{stage.finish({code:'SOC_COLLECTION_FAILED',origin:'PROVIDER'});return null;}
    })():null;
    const qualification=await qualifyAttention(read,token,options.geminiKey,fetcher,options.runtime?.wait,{tinyfishKey:options.tinyfishKey,now,signal:deadline,representationScreen:sharedEnabled,modelRouting});
    const scope=qualification.scope;
    ids.push(addEvidence('attention-scope',JSON.stringify({...(scope.metadataLinkMethod?{metadataLinkMethod:scope.metadataLinkMethod}:{}),...(scope.leadershipPositiveMethod?{leadershipPositiveMethod:scope.leadershipPositiveMethod}:{}),entryEvidenceMethod:scope.entryEvidenceMethod,queries:scope.queries,complete:scope.complete,comparisonComplete:scope.comparisonComplete,comparisonSourceIds:scope.comparisonSourceIds,comparisonRankingSourceIds:scope.comparisonRankingSourceIds,postSampleSourceIds:scope.postSampleSourceIds,comparisonAcquisition:scope.comparisonAcquisition,comparisonQualification:scope.comparisonQualification,comparisonCoverage:scope.comparisonCoverage,comparisonPublicSupport:scope.comparisonPublicSupport,postSampleComplete:scope.postSampleComplete,codes:scope.codes,start:scope.start,end:scope.end,discoveryUrls:scope.discoveryUrls}),'attention-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:'comparison-scope-v2'}));
    for(const s of scope.sources.filter(s=>!read.sources.some(original=>original.id===s.id)))ids.push(addEvidence(s.id,s.text,'tinyfish-fetch','WEB_PAGE','FREE_ACCOUNT',{url:s.url,publishedAt:s.publishedAt,authorId:s.authorId,kind:s.kind,recovery:true},s.availableAt));
    for(const [id,raw] of Object.entries(qualification.rawArtifacts))ids.push(id.includes('-transport-attempt-')||id==='attention-entry-first-acquisition'||id==='attention-narrative-public-support'||(id==='attention-comparison-manifest'||id==='attention-comparison-coverage'||id==='attention-comparison-public-support')||id==='comparison-lead-qualification'||id==='comparison-lead-wire-repair'||id.endsWith('-scope')
      ?addEvidence(id,raw,'attention-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:'complete-comparison-batches-v1'})
      :id.endsWith('-http-outcomes')?addEvidence(id,raw,'attention-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:'fetch-http-outcomes-v1'})
      :id.startsWith('attention-recovery-')?addEvidence(id,raw,id.endsWith('-metadata')?'attention-collector':id.includes('search')?'tinyfish-search':'tinyfish-fetch',id.endsWith('-metadata')?'INDEXED_LEAD':'ATTENTION_SAMPLE',id.endsWith('-metadata')?'LOCAL_DERIVED':'FREE_ACCOUNT',{method:'free-comparison-recovery-v1'},((scope.comparisonRecovery??scope.comparisonQualification) as {recoveryQueries?:Array<{queryId:string;availableAt:string}>}|undefined)?.recoveryQueries?.find(q=>q.queryId===id)?.availableAt)
      :addEvidence(id,raw,'gemini',id.endsWith('prompt')?'MODEL_INPUT':'MODEL_RESPONSE','FREE_ACCOUNT',{method:'automated-source-review-v1',model:geminiSettings.model}));
    // The historical caller corpus is frozen here, after attention acquisition and recovery but before any caller read; bodies are read as current revisions.
    if(options.advisoryEnabled){
      const frozenAt=now(),seed=callerSeedFromEvidence(token,evidence,rawArtifacts,frozenAt);
      if(seed.selection===null)callerStatus=seed.code;
      else{
        addEvidence(CALLER_SELECTION_ID,seed.raw,'advisory-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:CALLER_SEED_METHOD},frozenAt);
        const selection=seed.selection,callerKey=options.geminiKey,callerSignal=AbortSignal.any([collectionDeadline,AbortSignal.timeout(Math.max(1,runStartedAt+runBudgetMs-CALLER_RESERVE_MS-Date.now()))]);callerStatus='RUNNING';
        // Only the public reads and the model pair run here, overlapping social, shared and historical RPC work; no evidence is added until the late block.
        callerPending=(async():Promise<CallerRun>=>{
          const history=await collectCallerHistory(selection,callerFetcher,now,callerSignal);
          if(!history.data.complete)return {history,classified:null,classifiedAt:null,status:'BODIES_INCOMPLETE'};
          if(!history.data.socialInput.sources.length)return {history,classified:null,classifiedAt:null,status:'NO_SOURCES'};
          if(callerSignal.aborted)return {history,classified:null,classifiedAt:null,status:'CLASSIFICATION_RESERVE_REACHED'};
          const classified=await qualifyAdvisorySemantic(history.data.socialInput,null,null,token,callerKey,advisoryFetcher,undefined,callerSignal);
          return {history,classified,classifiedAt:now(),status:classified.code??'CLASSIFIED'};
        })().catch(error=>({error}));
      }
    }
    const qualifiedRead={...scope,sources:qualification.sources??scope.sources.map(s=>({...s,text:scope.entryEvidenceMethod?s.text:s.text.slice(0,6000)})),codes:qualification.code?[qualification.code,...scope.codes]:scope.codes};
    const fixedPosts=qualifiedRead.sources.filter(s=>s.kind==='POST'&&(!qualifiedRead.postSampleSourceIds||qualifiedRead.postSampleSourceIds.includes(s.id)));
    qualifiedRead.growthSample={method:'fixed-query-sample-v1',sourceIds:fixedPosts.map(s=>s.id),queries:qualifiedRead.queries,complete:!!(qualifiedRead.postSampleComplete??qualifiedRead.complete)&&fixedPosts.every(s=>!!s.publishedAt&&Date.parse(s.publishedAt)<Date.parse(qualifiedRead.start)||rawArtifacts[s.id]===s.text)};
    const attentionTime=now();
    semanticReceiptIds.push(addEvidence('attention-qualified-receipt',JSON.stringify({read:{...qualifiedRead,rawArtifacts:{}},proposal:qualification.proposal,review:qualification.review,token,cutoff:attentionTime,evidenceIds:ids}),'attention-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:'final-attention-review-v1'}));
    attention=deriveAttention(qualifiedRead,qualification.proposal,qualification.review,token,attentionTime,ids,!options.research,!!sharedEnabled);
    sharedSources=scope.sources.map(s=>({...s,text:rawArtifacts[s.id]??s.text}));
    const claims=qualification.proposal?.claims.flatMap(c=>{
      const a=attention!.find(a=>a.id===c.feature);if(a?.quality!=='KNOWN'||!qualification.review?.decisions.some(d=>d.id===c.id&&d.accepted)||['narrative-public-support-v1','origin-traceability-screen-v2','binary-public-support-v1','binary-public-support-v2','binary-public-support-v3','binary-public-support-v4'].includes((a.data as {method?:string}).method??''))return [];
      return [{kind:c.feature==='A01'?'NARRATIVE' as const:c.feature==='A02'?'GAME_TYPE' as const:c.feature==='A03'?'ORIGIN' as const:'TOKEN_RELATION' as const,value:c.summary,evidenceId:c.citations[0].sourceId,quote:c.citations[0].quote,assertion:c.originBasis==='PUBLIC_EVIDENCE_INADEQUATE'?'MODEL_INFERENCE' as const:'SOURCE_STATES' as const}];
    })??[];
    const originGrade=attention.find(a=>a.id==='A03'&&a.quality==='KNOWN'&&['origin-traceability-screen-v2','binary-public-support-v1','binary-public-support-v2','binary-public-support-v3','binary-public-support-v4'].includes((a.data as {method?:string}).method??''));
    if(originGrade){const d=originGrade.data as {summary:string;citations:Array<{sourceId:string;quote:string}>};claims.push({kind:'ORIGIN',value:d.summary,evidenceId:d.citations[0].sourceId,quote:d.citations[0].quote,assertion:'MODEL_INFERENCE'});}
    semantic={status:claims.length?'VALIDATED':qualification.code?/INVALID|FINISH|CONTENT|PACKET_LIMIT/.test(qualification.code)?'INVALID':'PROVIDER_UNAVAILABLE':!read.sources.length?'NO_PUBLIC_CORPUS':'CANDIDATE',claims,model:geminiSettings.model,schemaVersion:1,...(qualification.code?{validationErrors:[qualification.code]}:{})};
    attentionElapsedMs=Math.max(0,run.runtime.nowMs()-attentionStartedAt);
    const attentionFailure=qualification.code??scope.codes.find(code=>/^ATT_MODEL_ENTRY_FAILED:[A-Z0-9_:-]+$/.test(code));
    if(sharedEnabled)attentionStage.finish(attentionFailure?{code:attentionFailure,origin:'PROVIDER'}:undefined);
    if(!options.research){
      const result=await socialWork;
      if(result){
        const {socialRead,acquisitionArtifacts,qualification:socialQualification,qualifiedAt}=result;
        const socialIds=socialRead.sources.filter(s=>socialSeed.sources.some(original=>original.id===s.id)).map(s=>s.id);
        for(const s of socialRead.sources.filter(s=>!socialSeed.sources.some(original=>original.id===s.id)))socialIds.push(addEvidence(s.id,s.text,'tinyfish-fetch','WEB_PAGE','FREE_ACCOUNT',{url:s.url,publishedAt:s.publishedAt,authorId:s.authorId,kind:s.kind,socialSupplement:true},s.availableAt));
        for(const [id,raw] of Object.entries({...acquisitionArtifacts,...socialQualification.rawArtifacts}))socialIds.push(addEvidence(id,raw,id.startsWith('social-search-')?'tinyfish-search':id.startsWith('social-fetch-')?'tinyfish-fetch':id.includes('prompt')||id.includes('response')?'gemini':'social-collector',id.includes('prompt')?'MODEL_INPUT':id.includes('response')?'MODEL_RESPONSE':'SAMPLE_SCOPE',id.startsWith('social-search-')||id.startsWith('social-fetch-')||id.includes('prompt')||id.includes('response')?'FREE_ACCOUNT':'LOCAL_DERIVED',{method:'social-source-review-v1'},qualifiedAt));
        socialIds.push('social-attention-seed');
        socialPacket={read:{...socialQualification.read,qualifiedAt,codes:socialQualification.code?[socialQualification.code,...socialQualification.read.codes]:socialQualification.read.codes},proposal:socialQualification.proposal,review:socialQualification.review,evidenceIds:[...new Set(socialIds)]};
        if(socialIds.includes('social-qualified-receipt'))semanticReceiptIds.push('social-qualified-receipt');
        for(const s of socialRead.sources)if(!sharedSources.some(source=>source.id===s.id))sharedSources.push(s);
        socialElapsedMs=result.elapsedMs;
      }else addEvidence('social-stage-failure',JSON.stringify({code:'SOC_COLLECTION_FAILED'}),'social-collector','DIAGNOSTIC','LOCAL_DERIVED',{code:'SOC_COLLECTION_FAILED'});
    }

    const interimSocial=socialPacket?deriveSocial(socialPacket.read,socialPacket.proposal,socialPacket.review,token,now(),socialPacket.evidenceIds):undefined;
    const auditClaims=sharedClaims(attention,interimSocial?.facts);
    for(const id of [...new Set(auditClaims.flatMap(c=>c.citations.map(c=>c.sourceId)))])if(!sharedSources.some(s=>s.id===id)){
      const e=evidence.find(e=>e.id===id&&e.sourceId==='attention-collector'&&e.sourceType==='INDEXED_LEAD');
      if(e){const descriptor=JSON.parse(rawArtifacts[id]);sharedSources.push({id,url:descriptor.normalizedUrl??descriptor.url,text:descriptor.title+'\n'+descriptor.snippet,kind:'INDEXED_METADATA',authorId:null,publishedAt:null,availableAt:e.availableAt});}
    }
    const semanticFeatures=[...new Map([...features,...attention.flatMap(a=>a.projection?[a.projection]:[]),...(interimSocial?.assessments??[]).flatMap(a=>a.projection?[a.projection]:[])].map(f=>[f.id,f])).values()];
    const semanticScope=sharedWitnesses(semanticFeatures,options.profile,now(),interimSocial?.facts,comparisonEntryGrade(attention),attentionEntryGates(attention,!!sharedEnabled)).filter(w=>/^(NAR|CAN|ATT|SOC)-/.test(w.checkId));
    if(semanticScope.every(w=>w.status!=='UNKNOWN')&&auditClaims.length>0&&semanticReceiptIds.length===2){
      const sharedStage=run.begin('SHARED');
      const audit=await qualifyShared(auditClaims,sharedSources,token,options.geminiKey,sharedStage.fetcher,options.runtime?.wait,sharedStage.signal,true,{cutoff:now(),...(interimSocial?{socialWindow:{start:interimSocial.facts.start,end:interimSocial.facts.end},socialFacts:interimSocial.facts}:{})},modelRouting);
      sharedStage.finish(audit.code?{code:audit.code,origin:'PROVIDER'}:undefined);
      sharedAudit=audit.audit;
      addEvidence('shared-audit-status',JSON.stringify({method:'shared-conflict-review-v1',received:!!audit.audit,code:audit.code??null}),'shared-collector','DIAGNOSTIC','LOCAL_DERIVED',{code:audit.code??'SHARED_AUDIT_RECEIVED'});
      for(const [id,raw] of Object.entries(audit.rawArtifacts))addEvidence(id,raw,id.includes('prompt')||id.includes('response')?'gemini':'shared-collector',id.includes('prompt')?'MODEL_INPUT':id.includes('response')?'MODEL_RESPONSE':'SAMPLE_SCOPE',id.includes('prompt')||id.includes('response')?'FREE_ACCOUNT':'LOCAL_DERIVED',{method:'shared-conflict-review-v1'});
    }else if(sharedEnabled)run.skip('SHARED',socialPacket?'ATTENTION':'SOCIAL');
  }
  if(options.research)addEvidence('curated-research',JSON.stringify(options.research),'curated-research','REVIEWED_CORPUS','USER_IMPORT',{qualification:'human-adjudication-v1',scope:'user supplied bounded evidence; not live platform coverage'});
  const ingest=(namespace:'chain'|'market'|'paid'|'trades'|'context'|'semantic'|'wallets'|'window'|'accounts'|'automation'|'topology'|'demand'|'callers'|'callerSemantic'|'creatorRole'|'launchpad'|'creatorInventory'|'creatorFailedFees'|'creatorAccounting'|'creatorCoverage'|'creatorRoutes'|'creatorEpisode'|'exitCapacity',read:{rawArtifacts:Record<string,string>;retrievedAt:string|Record<string,string>;requests:Record<string,unknown>})=>{
      const artifactIds:Record<string,string>={};
      for(const [key,raw] of Object.entries(read.rawArtifacts)){
        const id=`advisory-${namespace}-${key}`,at=typeof read.retrievedAt==='string'?read.retrievedAt:read.retrievedAt[key];
        if(!at||read.requests[key]===undefined)throw new Error('ADVISORY_COLLECTION_INVALID');
        const model=namespace==='semantic'||namespace==='callerSemantic',hosted=model&&(key.includes('prompt')||key.includes('response'));
        artifactIds[key]=addEvidence(id,raw,model?(hosted?'gemini':'advisory-collector'):namespace==='creatorRole'?'advisory-creator-role':namespace==='creatorInventory'?'advisory-creator-inventory':namespace==='creatorFailedFees'?FAILED_FEE_SOURCE_ID:`advisory-${namespace}`,'HISTORICAL_RECEIPT',model?(hosted?'FREE_ACCOUNT':'LOCAL_DERIVED'):namespace==='creatorRoutes'||namespace==='creatorEpisode'&&key==='helius'||namespace==='launchpad'&&key==='lighthouse'?'FREE_ACCOUNT':'PUBLIC_API',{request:read.requests[key]},at,namespace==='window'?WINDOW_ARCHIVE_ADAPTER:namespace==='demand'?DEMAND_ARCHIVE_ADAPTER:namespace==='creatorFailedFees'?FAILED_FEE_ADAPTER:'live-v1');
      }
      return {requests:read.requests,artifactIds};
    };
  let advisoryProof:Omit<AdvisoryProof,'cutoff'|'socialDerivationId'|'thesisContextId'>|undefined;
  let failedFeeRead:CreatorFailedFeeReceipts|null=null;
  if(advisoryPending){
    const result=await advisoryPending;
    if('error' in result)throw new Error('ADVISORY_COLLECTION_INVALID');
    const [chain,market,paid,trades,context]=result.value;
    let classification:AdvisoryProof['semantic']=null;
    if(socialPacket&&options.geminiKey){
      const classified=await qualifyAdvisorySemantic(socialPacket.read,socialPacket.proposal,socialPacket.review,token,options.geminiKey,advisoryFetcher,undefined,collectionDeadline,'v4');
      const requests=Object.fromEntries(Object.keys(classified.rawArtifacts).map(key=>[key,{operation:key,modelRequests:advisorySemanticRequests()}]));
      if(Object.keys(classified.rawArtifacts).length)classification=ingest('semantic',{rawArtifacts:classified.rawArtifacts,retrievedAt:now(),requests});
    }
    // The background caller task already read the bodies and ran the independent pair; its finished result is ingested exactly once here.
    let callers:AdvisoryProof['callers']=null,callerSemantic:AdvisoryProof['callerSemantic']=null;
    if(callerPending){
      const caller=await callerPending;
      if('error' in caller)throw new Error('ADVISORY_COLLECTION_INVALID');
      const {history,classified,classifiedAt}=caller;
      const times=Object.fromEntries(Object.entries(history.rawArtifacts).map(([key,raw])=>[key,JSON.parse(raw).retrievedAt as string]));
      callerStatus=caller.status;
      callers={...ingest('callers',{rawArtifacts:history.rawArtifacts,retrievedAt:times,requests:history.requests}),selectionId:CALLER_SELECTION_ID};
      if(classified&&classifiedAt&&Object.keys(classified.rawArtifacts).length){
        const requests=Object.fromEntries(Object.keys(classified.rawArtifacts).map(key=>[key,{operation:key,modelRequests:advisorySemanticRequests()}]));
        callerSemantic=ingest('callerSemantic',{rawArtifacts:classified.rawArtifacts,retrievedAt:classifiedAt,requests});
      }
    }
    // The creator-role task already finished its bounded reads; every retained receipt, including error envelopes, is ingested once.
    let creatorRoutes:AdvisoryProof['creatorRoutes']=null;
    if(routesPending){const routes=await routesPending;if(routes&&Object.keys(routes.rawArtifacts).length)creatorRoutes=ingest('creatorRoutes',routes);}
    let creatorEpisode:AdvisoryProof['creatorEpisode']=null;
    const episode=episodePending?await episodePending:null;
    let creatorCoverage:AdvisoryProof['creatorCoverage']=null;
    if(coveragePending){const coverage=await coveragePending;if(coverage&&Object.keys(coverage.rawArtifacts).length)creatorCoverage=ingest('creatorCoverage',coverage);}
    let creatorAccounting:AdvisoryProof['creatorAccounting']=null;
    if(accountingPending){const accounting=await accountingPending;if(accounting&&Object.keys(accounting.rawArtifacts).length)creatorAccounting=ingest('creatorAccounting',accounting);}
    let creatorRole:AdvisoryProof['creatorRole']=null;
    if(creatorPending){const creator=await creatorPending;if(!('error' in creator)&&Object.keys(creator.rawArtifacts).length)creatorRole=ingest('creatorRole',creator);}
    // The launchpad task settled before the cutoff; its receipts, error envelopes included, are ingested once, and the diagnostic records only availability and receipt count.
    let launchpad:AdvisoryProof['launchpad']=null,launchpadAvailability=options.solanaTrackerKey?'COLLECTION_FAILED':'SOLANA_TRACKER_API_KEY_MISSING',launchpadReceipts=0;
    if(launchpadPending){const read=await launchpadPending;if(read){launchpad=ingest('launchpad',read);launchpadAvailability='COLLECTED';launchpadReceipts=Object.keys(read.rawArtifacts).length;}}
    addEvidence('launchpad-run-diagnostics',JSON.stringify({method:'launchpad-run-v1',availability:launchpadAvailability,receipts:launchpadReceipts}),'launchpad-collector','DIAGNOSTIC','LOCAL_DERIVED',{method:'launchpad-run-v1'});
    // The creator-inventory task already finished on its own allowance after S13 and A30; every retained receipt, including error envelopes, is ingested once.
    let creatorInventory:AdvisoryProof['creatorInventory']=null;
    if(inventoryPending){const inventory=await inventoryPending;if(inventory&&!('error' in inventory)&&Object.keys(inventory.rawArtifacts).length)creatorInventory=ingest('creatorInventory',inventory);}
    // The failed-fee task settles here, before the cutoff, on its own allowance; its receipts are held for the late cap-guarded ingestion and only beside an ingested inventory.
    if(failedFeesPending){const read=await failedFeesPending;if(creatorRole&&creatorInventory&&read&&!('error' in read))failedFeeRead=read;}
    // Window receipts are stored as exact window-archive-v1 archives under the 1.25 MB namespace ceiling (fail closed above it); the plain collected window already fed accounts, automation, demand, inventory and failed fees.
    // Proof v22 additionally binds the canonical rpc-holder-population receipt stored as one holder-population-archive-v1 archive.
    if(episode&&creatorRoutes&&creatorCoverage&&Object.keys(episode.rawArtifacts).length)creatorEpisode=ingest('creatorEpisode',episode);
    advisoryProof={method:'advisory-provenance-v37',saturation:null,exitCapacity:null,launchpad,creatorEpisode,creatorRoutes,creatorCoverage,creatorAccounting,creatorRole,creatorInventory,creatorFailedFees:null,topology:{requests:{},artifactIds:{}},window:{...ingest('window',archiveAdvisoryWindowReceipts(result.window,true)),end:advisoryWindowEnd},accounts:ingest('accounts',result.accounts),automation:ingest('automation',result.automation),demand:ingest('demand',result.demand),wallets:ingest('wallets',result.wallets),token:{chain:'solana',address:token.address},pool:advisoryPool,addresses:advisoryAddresses,chain:ingest('chain',chain),market:ingest('market',market),paid:ingest('paid',paid),trades:ingest('trades',trades),context:ingest('context',context),semantic:classification,callers,callerSemantic};
  }
  if(sharedEnabled){
    currentStage.finish();currentStage=run.begin('FINALIZE');fetcher=currentStage.fetcher;deadline=currentStage.signal;
    dexRecovery=options.tinyfishKey?{tinyfishKey:options.tinyfishKey,signal:deadline}:undefined;
    await captureCanonical();
  }
  if(advisoryProof&&!detailRead?.rawArtifacts['rpc-holder-population']){const topology=await collectAuthorityTopology(token,detailRead?.rawArtifacts['rpc-mint-raw'],options.rpcUrl??PUBLIC_SOLANA_RPC,fetcher,now,deadline);advisoryProof.topology=ingest('topology',topology);}
  let venueRead=token.chain==='solana'&&rpc.status==='OBSERVED'&&rpc.mint&&(rpc.mint.kind==='MINT_LEGACY'||rpc.mint.kind==='MINT_TOKEN_2022_PARTIAL')?await inspectPumpSwap(token,options.profile,detailRead?.controls,detailRead?.holders,rpc.mint.slot,options.rpcUrl,fetcher,now,deadline,dexRecovery,undefined,sharedEnabled):undefined;
  if(sharedEnabled&&typeof rpc.mint?.slot==='number'&&venueRead&&!venueRead.inspection.bindingVerified&&venueRead.rawArtifacts['pump-pool-config']&&JSON.parse(venueRead.rawArtifacts['pump-pool-config']).result?.value?.[0]===null){
    const curve=await inspectPumpCurve(token,options.profile,detailRead?.holders,rpc.mint!.slot,options.rpcUrl,fetcher,now,deadline,dexRecovery);
    const selection=JSON.stringify({method:'pump-venue-selection-v1',primaryStateId:'pump-pool-config',selected:curve.inspection.bindingVerified?'BONDING_CURVE':'UNVERIFIED',reason:'Canonical PumpSwap pool account absent'});
    venueRead={...curve,rawArtifacts:{...venueRead.rawArtifacts,...curve.rawArtifacts,'venue-route-selection':selection},retrievedAt:{...venueRead.retrievedAt,...curve.retrievedAt,'venue-route-selection':now()}};
  }
  if(sharedEnabled&&rpc.status==='OBSERVED'&&typeof rpc.mint?.slot==='number'&&!venueRead?.inspection.bindingVerified){
    const candidates=(dex.market?.pairs??[]).filter(p=>p.baseAddress===token.address&&p.quoteAddress==='So11111111111111111111111111111111111111112').sort((a,b)=>new Decimal(b.liquidityUsd??0).cmp(a.liquidityUsd??0)).slice(0,2);
    if(candidates.length)try{
      const scout=await solanaRpc(options.rpcUrl??'https://api.mainnet.solana.com','getMultipleAccounts',[candidates.map(p=>p.pairAddress),{encoding:'base64',commitment:'finalized',minContextSlot:rpc.mint.slot}],fetcher,undefined,deadline);
      addEvidence('native-route-scout',scout.raw,'venue-discovery-rpc','JSON_RPC','PUBLIC_API',{method:'getMultipleAccounts',mint:token.address,candidatePools:candidates.map(p=>p.pairAddress)});
      const result=scout.value as {context:{slot:number};value:Array<{owner:string;executable:boolean;data:[string,string]}|null>};
      if(!Number.isSafeInteger(result?.context?.slot)||result.context.slot<rpc.mint.slot||!Array.isArray(result.value)||result.value.length!==candidates.length)throw Error('RPC_SHAPE');
      const selected=result.value.findIndex(a=>a?.owner==='cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'&&!a.executable&&a.data?.[1]==='base64'&&Buffer.from(a.data[0],'base64').length===1112);
      if(selected>=0){
        const previous=venueRead;if(previous){delete previous.rawArtifacts['venue-route-selection'];delete previous.retrievedAt['venue-route-selection'];}
        const damm=await inspectDammV2(token,candidates[selected].pairAddress,options.profile,detailRead?.holders,result.context.slot,options.rpcUrl,fetcher,now,deadline,dexRecovery);
        venueRead={...damm,rawArtifacts:{...previous?.rawArtifacts,...damm.rawArtifacts},retrievedAt:{...previous?.retrievedAt,...damm.retrievedAt},marketEvidence:{...previous?.marketEvidence,...damm.marketEvidence}};
        addEvidence('damm-route-selection',JSON.stringify({method:'verified-native-route-v1',selected:'METEORA_DAMM_V2',pool:candidates[selected].pairAddress,candidatePools:candidates.map(p=>p.pairAddress),scoutId:'native-route-scout',reason:'Selected supported native-SOL program among bounded exact-mint candidates; not a best-depth claim.'}),'meteora-damm-derived','CALCULATION','LOCAL_DERIVED',{method:'verified-native-route-v1'});
      }
    }catch(error){addEvidence('native-route-scout-error',JSON.stringify({code:safeRpcCode(error)}),'shared-collector','DIAGNOSTIC','LOCAL_DERIVED',{code:safeRpcCode(error)});}
  }
  if(venueRead&&ownStop())for(const key of Object.keys(venueRead.inspection.errors))venueRead.inspection.errors[key]=ownStop()!.code;
  const venueOutcome:VenueOutcome=venueRead?{state:'COMPLETED',origin:'PROVIDER',code:'VENUE_INSPECTED',evidenceIds:venueRead.inspection.evidenceIds}:token.chain!=='solana'?{state:'UNSUPPORTED',origin:'UNSUPPORTED',code:'EVM_READER_UNIMPLEMENTED',evidenceIds:[]}:{state:deadline.aborted?'CANCELLED':'NOT_STARTED',origin:ownStop()?.origin??'DEPENDENCY',code:ownStop()?.code??rpc.code??'LIVE_DEPENDENCY_SKIPPED',blockedBy:'FINALIZE',evidenceIds:rpcIds};
  for(const [id,raw] of Object.entries(venueRead?.rawArtifacts??{})){const a=venueRead?.marketEvidence?.[id],curve=id.startsWith('curve-'),derived=id==='venue-route-selection'||id==='curve-quote-calculation'||id==='curve-simulation-proof'||id==='curve-fee-requests'||/^curve-(?:entry|exit)-fee-recovery$/.test(id);addEvidence(id,raw,a?.sourceId??(id.startsWith('damm-')?(id==='damm-calculation'||id==='damm-requests'||/^damm-.*-recovery$/.test(id)?'meteora-damm-derived':'meteora-damm-direct'):derived?'pump-curve-derived':curve?'pump-curve-direct':id.endsWith('-min-context-recovery')||['pump-quote-calculation','pump-simulation-request','pump-slippage-refresh'].includes(id)?'pumpswap-derived':'pumpswap-direct'),a?.sourceType??(id==='damm-calculation'||id==='damm-requests'||/^damm-.*-recovery$/.test(id)?'CALCULATION':derived?'CALCULATION':id.endsWith('-min-context-recovery')?'RETRY_RECEIPT':['pump-quote-calculation','pump-simulation-request','pump-slippage-refresh'].includes(id)?'CALCULATION':id==='pump-sol-usd'?'PUBLIC_MARKET':'JSON_RPC'),a?.accessMode??(id==='damm-calculation'||id==='damm-requests'||/^damm-.*-recovery$/.test(id)||derived||id.endsWith('-min-context-recovery')||['pump-quote-calculation','pump-simulation-request','pump-slippage-refresh'].includes(id)?'LOCAL_DERIVED':'PUBLIC_API'),a?.scope??{operation:id,mint:token.address,pool:venueRead?.inspection.poolAddress},venueRead?.retrievedAt[id]);}
  if(sharedEnabled)addEvidence('live-state-capture',JSON.stringify({method:'late-state-capture-v1',entryGroupMethod:'mandatory-entry-groups-v1',token,discoveryId:evidence.some(e=>e.id==='dex-discovery')?'dex-discovery':null,startedAt:stateCaptureStartedAt,endedAt:stateCaptureEndedAt,canonical:evidence.filter(e=>e.sourceId==='solana-rpc'||e.id==='dex-pairs').map(e=>({id:e.id,retrievedAt:e.retrievedAt})),rpcState:rpc.status,dexState:dex.status}),'shared-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:'late-state-capture-v1'});
  currentStage.finish(rpc.status==='UNAVAILABLE'?{code:rpc.code??'RPC_UNAVAILABLE',origin:'PROVIDER'}:undefined);
  if(sharedEnabled)addEvidence('live-run-scope',JSON.stringify(run.receipt(token)),'shared-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:'phase-isolated-live-v1'});
  addEvidence('analysis-context',JSON.stringify({profile:options.profile,origins:options.origins??{}}),'local-config','CONFIG','LOCAL_DERIVED',{kind:'user-selected research context'});
  if(options.a12CandidateSet){
    if(!advisoryProof)throw Error('A12_ADVISORY_REQUIRED');
    const packet=a12CandidateSetSchema.parse(options.a12CandidateSet);
    const capacity=await collectExitCapacity(packet,token,options.profile.risk.maxExitImpactBps,rpc.mint?.slot??0,options.rpcUrl??PUBLIC_SOLANA_RPC,advisoryFetcher,now,deadline);
    addEvidence('a12-reviewed-candidate-set',JSON.stringify(packet),'a12-reviewed-candidate-set','REVIEWED_CORPUS','USER_IMPORT',{method:packet.method},now());
    advisoryProof.exitCapacity={...ingest('exitCapacity',capacity),candidateSetId:'a12-reviewed-candidate-set',impactBps:options.profile.risk.maxExitImpactBps??null};
  }
  if(options.a24Capture!==undefined){
    if(!advisoryProof)throw Error('A24_ADVISORY_REQUIRED');
    advisoryProof.saturation={captureId:addEvidence('advisory-saturation-capture',options.a24Capture,'advisory-saturation','HISTORICAL_RECEIPT','USER_IMPORT',{method:A24_CAPTURE_METHOD},now(),A24_CAPTURE_METHOD) as 'advisory-saturation-capture'};
  }
  const cutoff=now(),thesis=materializeThesis(options.profile,cutoff,options.thesis,options.thesisExpiryMode??'FIXED');
  const social=socialPacket?deriveSocial(socialPacket.read,socialPacket.proposal,socialPacket.review,token,cutoff,socialPacket.evidenceIds):undefined;
  if(socialPacket)addEvidence('social-derivation',JSON.stringify({...socialPacket,token,cutoff}),'social-collector','CALCULATION','LOCAL_DERIVED',{method:'social-source-review-v1'},cutoff);
  if(socialPacket)addEvidence('social-run-diagnostics',JSON.stringify({admittedRequests:run.operations(),requestLimit:admission.limit.shared,admittedAccountHistoryRequests:admission.counts.accounts,accountHistoryRequestLimit:admission.limit.accounts,admittedCallerRequests:admission.counts.callers,callerRequestLimit:admission.limit.callers,callerStatus,deadlineMs:runBudgetMs,elapsedMs:run.elapsed(),attentionElapsedMs,socialElapsedMs,deadlineReached:deadline.aborted}),'social-collector','DIAGNOSTIC','LOCAL_DERIVED',{method:'bounded-social-run-v1'},cutoff);
  const collection:LiveBundle['collection']={
      rpc: { state: rpc.status, ...(rpc.code ? { code: rpc.code } : {}) },
      dex: { state: dex.status, ...(dex.code ? { code: dex.code } : {}), count: dex.market?.retainedPairCount ?? 0 },
      web,
    };
  const baseline=deriveBaseline({sharedMode:sharedEnabled,token,cutoff,profile:options.profile,features,evidence,observations,market:dex.market,collection,semantic,research:options.research,attention,social:social?.assessments,controls:venueRead?.controls??detailRead?.controls,holders:detailRead?.holders,program:detailRead?.program,venue:venueRead?.venue,venueInspection:venueRead?.inspection,venueOutcome,directErrors:detailRead?.errors,thesis,origins:options.origins});
  for(const assessment of baseline){if(assessment.projection){const index=features.findIndex(f=>f.id===assessment.id);if(index>=0)features[index]=assessment.projection;else features.push(assessment.projection);}if(detailRead?.errors.controls&&['O03','O04','O06','O07'].includes(assessment.id)&&!(venueRead?.controls??detailRead.controls)){assessment.causes.push({category:'EVIDENCE_UNAVAILABLE',code:detailRead.errors.controls,featureId:assessment.id,sourceId:'solana-rpc',evidenceIds:rpcIds,action:'Refresh raw finalized mint state; the control surface could not be inspected.'});assessment.collector='IMPLEMENTED';}}
  // The failed-fee stage is ingested last and kept only when the projected bundle stays under the unchanged 24 MB cap: every retained byte, these archives, and the remaining thesis, derivation and shared artifacts that serialize their metadata. Otherwise every receipt is dropped and S15 stays not collected, never a known zero.
  if(advisoryProof&&failedFeeRead){
    const mark=evidence.length,descriptor=ingest('creatorFailedFees',failedFeeRead),bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
    const projected=Object.values(rawArtifacts).reduce((n,raw)=>n+Buffer.byteLength(raw),0)+bytes({method:'frozen-advisory-thesis-v1',token,cutoff,thesis})+bytes({...advisoryProof,creatorFailedFees:descriptor,cutoff,socialDerivationId:socialPacket?'social-derivation':null,thesisContextId:'advisory-thesis-context'})
      +(sharedEnabled?bytes({token,cutoff,profile:options.profile,baseline,features,evidence,observations,social:social?.facts,claims:sharedClaims(baseline,social?.facts),sources:sharedSources,audit:sharedAudit,semanticReceiptIds}):0)+FAILED_FEE_TAIL_MARGIN;
    if(projected<=LIVE_ARTIFACT_CAP)advisoryProof.creatorFailedFees=descriptor;
    else for(const e of evidence.splice(mark))delete rawArtifacts[e.id];
  }

  if(advisoryProof)addEvidence('advisory-thesis-context',JSON.stringify({method:'frozen-advisory-thesis-v1',token,cutoff,thesis}),'local-config','CONFIG','LOCAL_DERIVED',{method:'frozen-advisory-thesis-v1'},cutoff);
  if(advisoryProof)addEvidence('advisory-derivation',JSON.stringify({...advisoryProof,cutoff,socialDerivationId:socialPacket?'social-derivation':null,thesisContextId:'advisory-thesis-context'}),'advisory-collector','CALCULATION','LOCAL_DERIVED',{method:'advisory-provenance-v37'},cutoff);
  const groups=sharedEnabled?entryGroupsForBundle({token,cutoff,profile:options.profile,evidence,rawArtifacts,collection,market:dex.market,details:{baseline,...(social?{social:social.facts}:{})}}):undefined;
  if(groups)addEvidence('entry-groups-derivation',JSON.stringify(groups),'shared-collector','CALCULATION','LOCAL_DERIVED',{method:groups.method},cutoff);
  let shared:ReturnType<typeof deriveShared>|undefined;
  if(sharedEnabled){
    const input={qualityMode:'ENTRY_GROUPS_V1' as const,groups,...(rawArtifacts['venue-route-selection']||rawArtifacts['damm-route-selection']?{venueInspection:venueRead!.inspection,venue:venueRead!.venue}:{}),token,cutoff,profile:options.profile,baseline:structuredClone(baseline),features:structuredClone(features),evidence:[...evidence],observations,social:social?.facts,claims:sharedClaims(baseline,social?.facts),sources:sharedSources,audit:sharedAudit,semanticReceiptIds};
    const effective=expireSharedWitnesses(input);
    for(const a of effective.baseline)baseline[baseline.findIndex(b=>b.id===a.id)]=a;
    features.splice(0,features.length,...effective.features);
    shared=deriveShared(effective);
    addEvidence('shared-derivation',JSON.stringify(input),'shared-collector','CALCULATION','LOCAL_DERIVED',{method:'shared-evidence-v1',qualityMode:input.qualityMode},cutoff);
    for(const a of shared.assessments){baseline[baseline.findIndex(old=>old.id===a.id)]=a;const index=features.findIndex(f=>f.id===a.id);if(index>=0)features[index]=a.projection!;else features.push(a.projection!);}
  }
  const advisory=advisoryProof?reconstructAdvisory(token,cutoff,baseline,evidence,rawArtifacts,{...advisoryProof,cutoff,socialDerivationId:socialPacket?'social-derivation':null,thesisContextId:'advisory-thesis-context'},thesis,features):undefined;
  const attentionModels=[...new Set(Object.entries(rawArtifacts).filter(([id])=>id.startsWith('attention-')&&id.includes('-transport-attempt-')).flatMap(([,raw])=>{const r=JSON.parse(raw);return r.code==='ATT_MODEL_HTTP_200'&&typeof r.model==='string'?[r.model]:[]}))];
  if(attentionModels.length)semantic.model=attentionModels.join(', ');
  return {
    token, cutoff, analysisKind: 'LIVE', evidence, rawArtifacts, observations, features, profile: options.profile,thesis,
    collection,semantic, market: dex.market ?? null,
    details:{version:1,profile:options.profile,thesis,baseline,origins:options.origins??{},stageInputs:{circulatingMarketCapUsd:null,tokenCreatedAt:null},...(social?{social:social.facts}:{}),...(shared?{shared:shared.facts}:{}),...(advisory?{advisory}:{}),...(groups?{groups}:{})},
  };
}
