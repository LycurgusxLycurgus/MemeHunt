import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { EvidenceRecord, FeatureResult, LiveBundle, Observation, Profile, Thesis, TokenRef } from '../domain/contracts.js';
import { dexArtifacts, fetchDexPairs, type DexRead, type DexRecoveryOptions } from '../providers/dexscreener.js';
import { geminiSettings } from '../providers/gemini.js';
import { decodeSolanaAddress, inspectSolanaDetails, inspectSolanaMint, type SolanaRead, type SolanaDetails } from '../providers/solana.js';
import { deriveBaseline, validateResearch } from '../domain/baseline.js';
import type { ResearchPacket } from '../domain/research.js';
import { materializeThesis } from './config.js';
import { inspectPumpSwap } from '../providers/pumpswap.js';
import { collectAttentionSources } from '../providers/attention.js';
import { qualifyAttention } from '../providers/attention-model.js';
import { deriveAttention } from '../domain/attention.js';
import { collectSocialSources } from '../providers/social.js';
import { qualifySocial } from '../providers/social-model.js';
import { deriveSocial, type SocialInput, type SocialProposal, type SocialReview } from '../domain/social.js';
import { deriveShared,expireSharedWitnesses,sharedClaims,sharedWitnesses,type SharedAudit,type SharedSource } from '../domain/shared.js';
import { qualifyShared } from '../providers/shared-model.js';


export type LiveOptions = { profile: Profile; thesis?: Thesis; thesisExpiryMode?:'HORIZON'|'FIXED'|'NONE'; research?: ResearchPacket; origins?:Record<string,string>; rpcUrl?: string; tinyfishKey?: string; geminiKey?: string; semanticEnabled: boolean; fetcher?: typeof fetch; now?: () => string };
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function collectLiveSolana(token: TokenRef, options: LiveOptions): Promise<LiveBundle> {
  if(token.chain!=='solana')throw new Error('INVALID_SOLANA_ADDRESS');
  return collectLiveToken(token,options);
}
export async function collectLiveToken(token: TokenRef, options: LiveOptions): Promise<LiveBundle> {
  if(token.chain==='solana'){if(!addressPattern.test(token.address))throw new Error('INVALID_SOLANA_ADDRESS');decodeSolanaAddress(token.address);}
  else if(!/^0x[a-fA-F0-9]{40}$/.test(token.address))throw new Error('INVALID_EVM_ADDRESS');
  const now = options.now ?? (() => new Date().toISOString());
  if(options.research)validateResearch(options.research,token,now());
  let operations=0;
  const runStartedAt=Date.now();let attentionElapsedMs:number|null=null,socialElapsedMs:number|null=null;
  const runBudgetMs=options.semanticEnabled?600_000:120_000;
  const deadline=AbortSignal.timeout(runBudgetMs);
  const fetcher:typeof fetch=(url,init)=>{
    if(deadline.aborted)throw deadline.reason;
    if(operations>=150)throw new Error('COLLECTION_BUDGET');
    operations++;
    return (options.fetcher??fetch)(url,{...init,signal:init?.signal?AbortSignal.any([deadline,init.signal]):deadline});
  };
  const evidence: EvidenceRecord[] = [];
  const rawArtifacts: Record<string,string> = {};
  const observations: Observation[] = [];
  const features: FeatureResult[] = [];
  const addEvidence = (id: string, raw: string, sourceId: string, sourceType: string, accessMode: EvidenceRecord['accessMode'], scope: Record<string,unknown>, at=now()): string => {
    evidence.push({ id, sourceId, sourceType, retrievedAt: at, availableAt: at, contentHash: hash(raw), adapterVersion: 'live-v1', accessMode, scope });
    rawArtifacts[id] = raw;
    return id;
  };
  const observe = (field: string, value: string | boolean | null, unit: string, ids: string[], at = now()) =>
    observations.push({ id: `obs-${observations.length+1}`, subject: token, field, value, unit, evidenceIds: ids, observedAt: at, availableAt: at, quality: 'KNOWN' });
  const feature = (id: string, value: boolean, ids: string[], at=now()) =>
    features.push({ id, value, unit: 'bool', quality: 'KNOWN', availableAt: at, evidenceIds: ids, applicability: 'APPLICABLE' });
  const sharedEnabled=options.semanticEnabled&&!options.research;
  const dexRecovery:DexRecoveryOptions|undefined=sharedEnabled&&options.tinyfishKey?{tinyfishKey:options.tinyfishKey,signal:deadline}:undefined;
  const ingestDex=(read:DexRead,id:string)=>{const artifacts=dexArtifacts(read,id,token.chain,token.address,now());for(const [key,a] of Object.entries(artifacts))addEvidence(key,a.raw,a.sourceId,a.sourceType,a.accessMode,a.scope,a.retrievedAt);return artifacts[id]?[id]:[];};
  let rpc!:SolanaRead;
  let dex:DexRead=sharedEnabled?await fetchDexPairs(token.chain,token.address,fetcher,now,dexRecovery):{status:'UNAVAILABLE'};
  let detailRead:SolanaDetails|undefined;
  const rpcIds:string[]=[];
  let stateCaptureStartedAt:string|null=null,stateCaptureEndedAt:string|null=null;
  const captureCanonical=async()=>{
    stateCaptureStartedAt=sharedEnabled?now():null;
  [rpc, dex] = await Promise.all([
    token.chain==='solana'?inspectSolanaMint(token.address, options.rpcUrl, fetcher, deadline,sharedEnabled?now:undefined):Promise.resolve({status:'UNAVAILABLE' as const,code:'EVM_READER_UNIMPLEMENTED',mint:undefined,genesisRaw:undefined,accountRaw:undefined,genesisHash:undefined}),
    fetchDexPairs(token.chain, token.address, fetcher,sharedEnabled?now:undefined,dexRecovery),
  ]);
  detailRead=rpc.status==='OBSERVED'&&rpc.mint?await inspectSolanaDetails(rpc.mint,token.address,options.rpcUrl,fetcher,deadline,sharedEnabled?now:undefined):undefined;
  rpcIds.length=0;
  if (rpc.genesisRaw) rpcIds.push(addEvidence('rpc-genesis', rpc.genesisRaw, 'solana-rpc', 'JSON_RPC', 'PUBLIC_API', { method: 'getGenesisHash', genesisHash: rpc.genesisHash ?? null },rpc.retrievedAt?.['rpc-genesis']));
  if (rpc.accountRaw) rpcIds.push(addEvidence('rpc-account', rpc.accountRaw, 'solana-rpc', 'JSON_RPC', 'PUBLIC_API', { method: 'getAccountInfo', commitment: 'finalized', genesisHash: rpc.genesisHash ?? null, slot: rpc.mint?.slot ?? null },rpc.retrievedAt?.['rpc-account']));
  for(const [id,raw] of Object.entries(detailRead?.rawArtifacts??{}))addEvidence(id,raw,'solana-rpc','JSON_RPC','PUBLIC_API',{operation:id,commitment:'finalized',mint:token.address},detailRead?.retrievedAt?.[id]);
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
  const marketObserve=(field:string,value:string|boolean|null,unit:string,ids:string[])=>sharedEnabled?observe(field,value,unit,ids,dex.retrievedAt??now()):observe(field,value,unit,ids);
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
  if(sharedEnabled)ingestDex(dex,'dex-discovery');
  else await captureCanonical();
  let web: LiveBundle['collection']['web'] = {state: options.semanticEnabled ? 'KEY_MISSING' : 'NOT_REQUESTED'};
  let semantic:LiveBundle['semantic']={status:options.semanticEnabled?'KEY_MISSING':'NOT_REQUESTED',claims:[]};
  let attention:ReturnType<typeof deriveAttention>|undefined;
  let sharedAudit:SharedAudit|null=null;
  let sharedSources:SharedSource[]=[];
  const semanticReceiptIds:string[]=[];
  let socialPacket:{read:SocialInput;proposal:SocialProposal|null;review:SocialReview|null;evidenceIds:string[]}|undefined;
  if(options.semanticEnabled&&options.tinyfishKey&&options.geminiKey){
    const attentionStartedAt=Date.now();
    let name:string|undefined;const discoveryUrls:string[]=[];
    try{
      const pairs=JSON.parse(dex.recovery&&!dex.recovery.selected?'[]':dex.raw??'[]') as Array<{chainId:string;baseToken?:{address:string;name?:string};quoteToken?:{address:string;name?:string};info?:{websites?:Array<{url?:string}>;socials?:Array<{url?:string}>}}>;
      const matches=(address?:string)=>token.chain==='solana'?address===token.address:address?.toLowerCase()===token.address.toLowerCase();
      const pair=pairs.find(p=>p.chainId===token.chain&&(matches(p.baseToken?.address)||matches(p.quoteToken?.address)));name=matches(pair?.baseToken?.address)?pair?.baseToken?.name:pair?.quoteToken?.name;
      // Pair metadata describes the base token; a quote-side match cannot supply its project links.
      for(const p of pairs.filter(p=>p.chainId===token.chain&&matches(p.baseToken?.address))){
        for(const link of [...(Array.isArray(p.info?.websites)?p.info.websites:[]),...(Array.isArray(p.info?.socials)?p.info.socials:[])])if(typeof link?.url==='string'&&!discoveryUrls.includes(link.url)&&discoveryUrls.length<4)discoveryUrls.push(link.url);
      }
    }catch{/* Discovery metadata is optional and untrusted, never identity evidence. */}
    const read=await collectAttentionSources(token,options.tinyfishKey,fetcher,now,name,discoveryUrls);
    web={state:read.sources.length?read.complete?'OBSERVED':'TRUNCATED':read.complete?'NO_RESULTS':'UNAVAILABLE',count:read.sources.length,...(read.codes.length?{code:read.codes[0]}:{})};
    const ids:string[]=[];
    for(const [id,raw] of Object.entries(read.rawArtifacts))ids.push(addEvidence(id,raw,id.endsWith('-metadata')?'attention-collector':id.includes('search')?'tinyfish-search':'tinyfish-fetch',id.endsWith('-metadata')?'INDEXED_LEAD':'ATTENTION_SAMPLE',id.endsWith('-metadata')?'LOCAL_DERIVED':'FREE_ACCOUNT',{queries:read.queries,discoveryUrls:read.discoveryUrls,scope:'bounded web search and DEX-linked source sample'}));
    for(const s of read.sources)ids.push(addEvidence(s.id,s.text,'tinyfish-fetch','WEB_PAGE','FREE_ACCOUNT',{url:s.url,publishedAt:s.publishedAt,authorId:s.authorId,kind:s.kind,...(s.discoveredFrom?{discoveredFrom:s.discoveredFrom}:{})},s.availableAt));
    ids.push(addEvidence('attention-acquisition-scope',JSON.stringify({comparisonAcquisition:read.comparisonAcquisition,comparisonComplete:read.comparisonComplete,comparisonSourceIds:read.comparisonSourceIds,codes:read.codes}),'attention-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:'original-comparison-acquisition-v1'}));
    const qualification=await qualifyAttention(read,token,options.geminiKey,fetcher,undefined,{tinyfishKey:options.tinyfishKey,now,signal:deadline,representationScreen:sharedEnabled});
    const scope=qualification.scope;
    ids.push(addEvidence('attention-scope',JSON.stringify({queries:scope.queries,complete:scope.complete,comparisonComplete:scope.comparisonComplete,comparisonSourceIds:scope.comparisonSourceIds,comparisonRankingSourceIds:scope.comparisonRankingSourceIds,postSampleSourceIds:scope.postSampleSourceIds,comparisonAcquisition:scope.comparisonAcquisition,comparisonQualification:scope.comparisonQualification,postSampleComplete:scope.postSampleComplete,codes:scope.codes,start:scope.start,end:scope.end,discoveryUrls:scope.discoveryUrls}),'attention-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:'comparison-scope-v2'}));
    for(const s of scope.sources.filter(s=>!read.sources.some(original=>original.id===s.id)))ids.push(addEvidence(s.id,s.text,'tinyfish-fetch','WEB_PAGE','FREE_ACCOUNT',{url:s.url,publishedAt:s.publishedAt,authorId:s.authorId,kind:s.kind,recovery:true},s.availableAt));
    for(const [id,raw] of Object.entries(qualification.rawArtifacts))ids.push(id.includes('-transport-attempt-')||id==='attention-comparison-manifest'||id==='comparison-lead-qualification'||id==='comparison-lead-wire-repair'||id.endsWith('-scope')
      ?addEvidence(id,raw,'attention-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:'complete-comparison-batches-v1'})
      :id.startsWith('attention-recovery-')?addEvidence(id,raw,id.endsWith('-metadata')?'attention-collector':id.includes('search')?'tinyfish-search':'tinyfish-fetch',id.endsWith('-metadata')?'INDEXED_LEAD':'ATTENTION_SAMPLE',id.endsWith('-metadata')?'LOCAL_DERIVED':'FREE_ACCOUNT',{method:'free-comparison-recovery-v1'},(scope.comparisonQualification as {recoveryQueries?:Array<{queryId:string;availableAt:string}>}|undefined)?.recoveryQueries?.find(q=>q.queryId===id)?.availableAt)
      :addEvidence(id,raw,'gemini',id.endsWith('prompt')?'MODEL_INPUT':'MODEL_RESPONSE','FREE_ACCOUNT',{method:'automated-source-review-v1',model:geminiSettings.model}));
    const qualifiedRead={...scope,sources:qualification.sources??scope.sources.map(s=>({...s,text:s.text.slice(0,6000)})),codes:qualification.code?[qualification.code,...scope.codes]:scope.codes};
    const fixedPosts=qualifiedRead.sources.filter(s=>s.kind==='POST'&&(!qualifiedRead.postSampleSourceIds||qualifiedRead.postSampleSourceIds.includes(s.id)));
    qualifiedRead.growthSample={method:'fixed-query-sample-v1',sourceIds:fixedPosts.map(s=>s.id),queries:qualifiedRead.queries,complete:!!(qualifiedRead.postSampleComplete??qualifiedRead.complete)&&fixedPosts.every(s=>!!s.publishedAt&&Date.parse(s.publishedAt)<Date.parse(qualifiedRead.start)||rawArtifacts[s.id]===s.text)};
    const attentionTime=now();
    semanticReceiptIds.push(addEvidence('attention-qualified-receipt',JSON.stringify({read:{...qualifiedRead,rawArtifacts:{}},proposal:qualification.proposal,review:qualification.review,token,cutoff:attentionTime,evidenceIds:ids}),'attention-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:'final-attention-review-v1'}));
    attention=deriveAttention(qualifiedRead,qualification.proposal,qualification.review,token,attentionTime,ids,!options.research);
    sharedSources=scope.sources.map(s=>({...s,text:rawArtifacts[s.id]??s.text}));
    const claims=qualification.proposal?.claims.flatMap(c=>{
      const a=attention!.find(a=>a.id===c.feature);if(a?.quality!=='KNOWN')return [];
      return [{kind:c.feature==='A01'?'NARRATIVE' as const:c.feature==='A02'?'GAME_TYPE' as const:c.feature==='A03'?'ORIGIN' as const:'TOKEN_RELATION' as const,value:c.summary,evidenceId:c.citations[0].sourceId,quote:c.citations[0].quote,assertion:'SOURCE_STATES' as const}];
    })??[];
    semantic={status:claims.length?'VALIDATED':qualification.code?/INVALID|FINISH|CONTENT|PACKET_LIMIT/.test(qualification.code)?'INVALID':'PROVIDER_UNAVAILABLE':!read.sources.length?'NO_PUBLIC_CORPUS':'CANDIDATE',claims,model:geminiSettings.model,schemaVersion:1,...(qualification.code?{validationErrors:[qualification.code]}:{})};
    attentionElapsedMs=Math.max(0,Date.now()-attentionStartedAt);
    if(!options.research){
      const socialStartedAt=Date.now();
      const socialRead=await collectSocialSources(token,scope,options.tinyfishKey,fetcher,now,deadline);
      const {rawArtifacts:acquisitionArtifacts,...socialInput}=socialRead;
      const socialQualification=await qualifySocial(socialInput,token,options.geminiKey,fetcher,undefined,deadline,{screeningRepair:!!dexRecovery});
      const socialIds=socialRead.sources.filter(s=>scope.sources.some(original=>original.id===s.id)).map(s=>s.id);
      for(const s of socialRead.sources.filter(s=>!scope.sources.some(original=>original.id===s.id)))socialIds.push(addEvidence(s.id,s.text,'tinyfish-fetch','WEB_PAGE','FREE_ACCOUNT',{url:s.url,publishedAt:s.publishedAt,authorId:s.authorId,kind:s.kind,socialSupplement:true},s.availableAt));
      for(const [id,raw] of Object.entries({...acquisitionArtifacts,...socialQualification.rawArtifacts}))socialIds.push(addEvidence(id,raw,id.startsWith('social-search-')?'tinyfish-search':id.startsWith('social-fetch-')?'tinyfish-fetch':id.includes('prompt')||id.includes('response')?'gemini':'social-collector',id.includes('prompt')?'MODEL_INPUT':id.includes('response')?'MODEL_RESPONSE':'SAMPLE_SCOPE',id.startsWith('social-search-')||id.startsWith('social-fetch-')||id.includes('prompt')||id.includes('response')?'FREE_ACCOUNT':'LOCAL_DERIVED',{method:'social-source-review-v1'}));
      socialIds.push('attention-scope');
      socialPacket={read:{...socialQualification.read,qualifiedAt:now(),codes:socialQualification.code?[socialQualification.code,...socialQualification.read.codes]:socialQualification.read.codes},proposal:socialQualification.proposal,review:socialQualification.review,evidenceIds:[...new Set(socialIds)]};
      if(socialIds.includes('social-qualified-receipt'))semanticReceiptIds.push('social-qualified-receipt');
      for(const s of socialRead.sources)if(!sharedSources.some(source=>source.id===s.id))sharedSources.push(s);
      socialElapsedMs=Math.max(0,Date.now()-socialStartedAt);
    }
    const interimSocial=socialPacket?deriveSocial(socialPacket.read,socialPacket.proposal,socialPacket.review,token,now(),socialPacket.evidenceIds):undefined;
    const auditClaims=sharedClaims(attention,interimSocial?.facts);
    for(const id of [...new Set(auditClaims.flatMap(c=>c.citations.map(c=>c.sourceId)))])if(!sharedSources.some(s=>s.id===id)){
      const e=evidence.find(e=>e.id===id&&e.sourceId==='attention-collector'&&e.sourceType==='INDEXED_LEAD');
      if(e){const descriptor=JSON.parse(rawArtifacts[id]);sharedSources.push({id,url:descriptor.normalizedUrl??descriptor.url,text:descriptor.title+'\n'+descriptor.snippet,kind:'INDEXED_METADATA',authorId:null,publishedAt:null,availableAt:e.availableAt});}
    }
    const semanticFeatures=[...new Map([...features,...attention.flatMap(a=>a.projection?[a.projection]:[]),...(interimSocial?.assessments??[]).flatMap(a=>a.projection?[a.projection]:[])].map(f=>[f.id,f])).values()];
    const semanticScope=sharedWitnesses(semanticFeatures,options.profile,now(),interimSocial?.facts).filter(w=>/^(NAR|CAN|ATT|SOC)-/.test(w.checkId));
    if(semanticScope.every(w=>w.status!=='UNKNOWN')&&auditClaims.length>0&&semanticReceiptIds.length===2){
      const audit=await qualifyShared(auditClaims,sharedSources,token,options.geminiKey,fetcher,undefined,deadline,true,
        {cutoff:now(),...(interimSocial?{socialWindow:{start:interimSocial.facts.start,end:interimSocial.facts.end},socialFacts:interimSocial.facts}:{})});
      sharedAudit=audit.audit;
      addEvidence('shared-audit-status',JSON.stringify({method:'shared-conflict-review-v1',received:!!audit.audit,code:audit.code??null}),'shared-collector','DIAGNOSTIC','LOCAL_DERIVED',{code:audit.code??'SHARED_AUDIT_RECEIVED'});
      for(const [id,raw] of Object.entries(audit.rawArtifacts))addEvidence(id,raw,id.includes('prompt')||id.includes('response')?'gemini':'shared-collector',id.includes('prompt')?'MODEL_INPUT':id.includes('response')?'MODEL_RESPONSE':'SAMPLE_SCOPE',id.includes('prompt')||id.includes('response')?'FREE_ACCOUNT':'LOCAL_DERIVED',{method:'shared-conflict-review-v1'});
    }
  }
  if(options.research)addEvidence('curated-research',JSON.stringify(options.research),'curated-research','REVIEWED_CORPUS','USER_IMPORT',{qualification:'human-adjudication-v1',scope:'user supplied bounded evidence; not live platform coverage'});
  if(sharedEnabled)await captureCanonical();
  const venueRead=token.chain==='solana'&&rpc.status==='OBSERVED'&&rpc.mint&&(rpc.mint.kind==='MINT_LEGACY'||rpc.mint.kind==='MINT_TOKEN_2022_PARTIAL')?await inspectPumpSwap(token,options.profile,detailRead?.controls,detailRead?.holders,rpc.mint.slot,options.rpcUrl,fetcher,now,deadline,dexRecovery):undefined;
  for(const [id,raw] of Object.entries(venueRead?.rawArtifacts??{})){const a=venueRead?.marketEvidence?.[id];addEvidence(id,raw,a?.sourceId??(id.endsWith('-min-context-recovery')||id==='pump-quote-calculation'?'pumpswap-derived':'pumpswap-direct'),a?.sourceType??(id.endsWith('-min-context-recovery')?'RETRY_RECEIPT':id==='pump-quote-calculation'?'CALCULATION':id==='pump-sol-usd'?'PUBLIC_MARKET':'JSON_RPC'),a?.accessMode??(id.endsWith('-min-context-recovery')||id==='pump-quote-calculation'?'LOCAL_DERIVED':'PUBLIC_API'),a?.scope??{operation:id,mint:token.address,pool:venueRead?.inspection.poolAddress},venueRead?.retrievedAt[id]);}
  if(sharedEnabled)addEvidence('live-state-capture',JSON.stringify({method:'late-state-capture-v1',token,discoveryId:evidence.some(e=>e.id==='dex-discovery')?'dex-discovery':null,startedAt:stateCaptureStartedAt,endedAt:stateCaptureEndedAt,canonical:evidence.filter(e=>e.sourceId==='solana-rpc'||e.id==='dex-pairs').map(e=>({id:e.id,retrievedAt:e.retrievedAt})),rpcState:rpc.status,dexState:dex.status}),'shared-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:'late-state-capture-v1'});
  addEvidence('analysis-context',JSON.stringify({profile:options.profile,origins:options.origins??{}}),'local-config','CONFIG','LOCAL_DERIVED',{kind:'user-selected research context'});
  const cutoff=now(),thesis=materializeThesis(options.profile,cutoff,options.thesis,options.thesisExpiryMode??'FIXED');
  const social=socialPacket?deriveSocial(socialPacket.read,socialPacket.proposal,socialPacket.review,token,cutoff,socialPacket.evidenceIds):undefined;
  if(socialPacket)addEvidence('social-derivation',JSON.stringify({...socialPacket,token,cutoff}),'social-collector','CALCULATION','LOCAL_DERIVED',{method:'social-source-review-v1'},cutoff);
  if(socialPacket)addEvidence('social-run-diagnostics',JSON.stringify({admittedRequests:operations,requestLimit:150,deadlineMs:runBudgetMs,elapsedMs:Math.max(0,Date.now()-runStartedAt),attentionElapsedMs,socialElapsedMs,deadlineReached:deadline.aborted}),'social-collector','DIAGNOSTIC','LOCAL_DERIVED',{method:'bounded-social-run-v1'},cutoff);
  const collection:LiveBundle['collection']={
      rpc: { state: rpc.status, ...(rpc.code ? { code: rpc.code } : {}) },
      dex: { state: dex.status, ...(dex.code ? { code: dex.code } : {}), count: dex.market?.retainedPairCount ?? 0 },
      web,
    };
  const baseline=deriveBaseline({sharedMode:sharedEnabled,token,cutoff,profile:options.profile,features,evidence,observations,market:dex.market,collection,semantic,research:options.research,attention,social:social?.assessments,controls:venueRead?.controls??detailRead?.controls,holders:detailRead?.holders,program:detailRead?.program,venue:venueRead?.venue,venueInspection:venueRead?.inspection,directErrors:detailRead?.errors,thesis,origins:options.origins});
  for(const assessment of baseline){if(assessment.projection){const index=features.findIndex(f=>f.id===assessment.id);if(index>=0)features[index]=assessment.projection;else features.push(assessment.projection);}if(detailRead?.errors.controls&&['O03','O04','O06','O07'].includes(assessment.id)&&!(venueRead?.controls??detailRead.controls)){assessment.causes.push({category:'EVIDENCE_UNAVAILABLE',code:detailRead.errors.controls,featureId:assessment.id,sourceId:'solana-rpc',evidenceIds:rpcIds,action:'Refresh raw finalized mint state; the control surface could not be inspected.'});assessment.collector='IMPLEMENTED';}}
  let shared:ReturnType<typeof deriveShared>|undefined;
  if(sharedEnabled){
    const input={token,cutoff,profile:options.profile,baseline:structuredClone(baseline),features:structuredClone(features),evidence:[...evidence],observations,social:social?.facts,claims:sharedClaims(baseline,social?.facts),sources:sharedSources,audit:sharedAudit,semanticReceiptIds};
    const effective=expireSharedWitnesses(input);
    for(const a of effective.baseline)baseline[baseline.findIndex(b=>b.id===a.id)]=a;
    features.splice(0,features.length,...effective.features);
    shared=deriveShared(effective);
    addEvidence('shared-derivation',JSON.stringify(input),'shared-collector','CALCULATION','LOCAL_DERIVED',{method:'shared-evidence-v1'},cutoff);
    for(const a of shared.assessments){baseline[baseline.findIndex(old=>old.id===a.id)]=a;const index=features.findIndex(f=>f.id===a.id);if(index>=0)features[index]=a.projection!;else features.push(a.projection!);}
  }
  return {
    token, cutoff, analysisKind: 'LIVE', evidence, rawArtifacts, observations, features, profile: options.profile,thesis,
    collection,semantic, market: dex.market ?? null,
    details:{version:1,profile:options.profile,thesis,baseline,origins:options.origins??{},stageInputs:{circulatingMarketCapUsd:null,tokenCreatedAt:null},...(social?{social:social.facts}:{}),...(shared?{shared:shared.facts}:{})},
  };
}
