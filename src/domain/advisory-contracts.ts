import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { entryDefinitions } from './catalog.js';

const HOUR_MS=3_600_000,WINDOW_MS=600_000,instant=z.iso.datetime({offset:true}),count=z.number().int().nonnegative();
const atomic=z.string().regex(/^(0|[1-9][0-9]*)$/),signedAtomic=z.string().regex(/^(0|-?[1-9][0-9]*)$/),tokenSchema=z.object({chain:z.enum(['solana','bsc','base','robinhood']),address:z.string().min(1)}).strict();
const shortFlowSchema=z.object({decodedTrades:count,buyQuoteAtomic:atomic,sellQuoteAtomic:atomic,netQuoteAtomic:signedAtomic,programAccountTrades:count,programAccountQuoteAtomic:atomic}).strict();
type ShortFlow=z.infer<typeof shortFlowSchema>;
const shortBuyerSchema=z.object({user:z.string().min(1),signature:z.string().min(1),slot:count,at:instant,coreQuoteAtomic:atomic,baselineSell:z.boolean(),baselineSubThresholdBuy:z.boolean()}).strict();
const shortWindowSchema=z.object({index:z.number().int().min(0).max(5),start:instant,end:instant,flow:shortFlowSchema.nullable(),firstObservedBuyers:z.array(shortBuyerSchema).nullable(),firstObservedBuyerCount:count.nullable(),condition:z.boolean().nullable()}).strict();
/** Supplementary [E-2h,E) demand report: fixed shape and UTC windows, all-or-nothing values, and arithmetic tied to its own windows. It is never a metric. */
export const shortDemandReportSchema=z.object({
  method:z.literal('supplementary-short-demand-windows-v1'),role:z.literal('SUPPLEMENTARY'),canonicalMetricId:z.literal('A30'),substitutesCanonical:z.literal(false),countsTowardKnownMetrics:z.literal(false),
  status:z.enum(['COMPLETE','INCOMPLETE','NOT_ELIGIBLE']),complete:z.boolean(),reasonCode:z.string().min(1),sourceReasonCode:z.string().min(1),
  token:tokenSchema,scope:z.literal('VERIFIED_PUMPSWAP_WSOL_POOL'),pool:z.string().min(1).nullable(),anchorSlot:count.nullable(),stateSlot:count.nullable(),
  canonical:z.object({method:z.string().min(1),range:z.object({start:instant,baselineEnd:instant,end:instant}).strict(),complete:z.boolean()}).strict(),
  reportEnd:instant,interval:z.object({start:instant,end:instant}).strict(),
  baseline:z.object({start:instant,end:instant,flow:shortFlowSchema.nullable(),meaningfulBuyers:count.nullable()}).strict(),
  measured:z.object({start:instant,end:instant,flow:shortFlowSchema.nullable()}).strict(),
  windowMinutes:z.literal(10),denominator:z.literal(6),windows:z.array(shortWindowSchema).length(6),satisfiedWindows:z.number().int().min(0).max(6).nullable(),share:z.string().regex(/^(0|1|0[.][0-9]+)$/).nullable(),
  comparison:z.object({buyQuoteDeltaAtomic:signedAtomic.nullable(),netQuoteDeltaAtomic:signedAtomic.nullable(),firstObservedBuyers:count.nullable(),baselineMeaningfulBuyers:count.nullable(),buyerRatio:z.string().regex(/^[0-9]+([.][0-9]+)?$/).nullable(),rule:z.string().min(1)}).strict(),
  coverage:z.object({indexReached:z.boolean(),indexComplete:z.boolean(),indexReachesScopeStart:z.boolean(),
    indexPages:z.array(z.object({id:z.string().min(1),returned:count,oldestAt:instant.nullable(),newestAt:instant.nullable(),exhausted:z.boolean(),status:z.enum(['OBSERVED','UNAVAILABLE','INVALID','TRUNCATED']),code:z.string().min(1).optional()}).strict()).max(2),
    capExceeded:z.boolean(),poolVerified:z.boolean(),transactionsCollected:z.boolean(),scopeSuccessfulReferences:count.nullable(),scopeObservedTransactions:count.nullable(),scopeReceipts:z.object({window:count,demand:count}).strict().nullable(),
    scopeUnresolvedTransactions:z.array(z.object({signature:z.string().min(1),at:instant,receipt:z.enum(['WINDOW','DEMAND']),status:z.enum(['UNAVAILABLE','INVALID','TRUNCATED']),code:z.string().min(1).nullable()}).strict()).max(20),
    outsideScopeUnresolvedTransactions:count.nullable(),logRecovery:z.object({truncatedTransactions:count,unresolvedNonFlowInvocations:count,unresolvedForeignSwaps:count.optional(),emptyForeignSweeps:count}).strict().nullable()}).strict(),
  quoteMint:z.literal('So11111111111111111111111111111111111111112'),quoteDecimals:z.literal(9),quoteBasis:z.string().min(1),meaningfulThreshold:z.object({coreQuoteAtomic:z.literal('10000000'),quoteUnits:z.literal('0.01')}).strict(),
  identityUnit:z.string().min(1),newBuyerRule:z.string().min(1),programAccounts:z.object({rule:z.string().min(1),accounts:z.array(z.string().min(1))}).strict(),evidenceIds:z.array(z.string().min(1)),limitations:z.array(z.string().min(1)).min(1),
}).strict().superRefine((r,ctx)=>{
  const issue=(message:string)=>ctx.addIssue({code:'custom',message}),ms=(value:string)=>Date.parse(value);
  const end=ms(r.reportEnd),split=end-HOUR_MS,start=end-2*HOUR_MS,canonicalEnd=ms(r.canonical.range.end);
  // E is the latest completed UTC hour at or before the canonical end; every window is fixed from it.
  if(end%HOUR_MS!==0||end>canonicalEnd||canonicalEnd-end>=HOUR_MS||start<ms(r.canonical.range.start)||ms(r.interval.start)!==start||ms(r.interval.end)!==end||ms(r.baseline.start)!==start||ms(r.baseline.end)!==split||ms(r.measured.start)!==split||ms(r.measured.end)!==end||r.windows.some((w,k)=>w.index!==k||ms(w.start)!==split+k*WINDOW_MS||ms(w.end)!==split+(k+1)*WINDOW_MS))issue('ADVISORY_SHORT_DEMAND_TIME');
  if(r.complete!==(r.status==='COMPLETE')||r.complete!==(r.reasonCode==='COMPLETE_SHORT_DEMAND_SCOPE_OBSERVED'))issue('ADVISORY_SHORT_DEMAND_STATUS');
  const c=r.comparison,base=r.baseline.flow,measured=r.measured.flow;
  if(!r.complete){
    if(r.windows.some(w=>w.flow!==null||w.firstObservedBuyers!==null||w.firstObservedBuyerCount!==null||w.condition!==null)||r.satisfiedWindows!==null||r.share!==null||base!==null||measured!==null||r.baseline.meaningfulBuyers!==null||c.buyQuoteDeltaAtomic!==null||c.netQuoteDeltaAtomic!==null||c.firstObservedBuyers!==null||c.baselineMeaningfulBuyers!==null||c.buyerRatio!==null)issue('ADVISORY_SHORT_DEMAND_NULLS');
    return;
  }
  if(!base||!measured||r.baseline.meaningfulBuyers===null||!r.coverage.transactionsCollected||r.coverage.scopeUnresolvedTransactions.length>0||r.windows.some(w=>!w.flow||!w.firstObservedBuyers||w.firstObservedBuyerCount===null||w.condition===null)){issue('ADVISORY_SHORT_DEMAND_NULLS');return;}
  const arithmetic=(f:ShortFlow)=>BigInt(f.netQuoteAtomic)===BigInt(f.buyQuoteAtomic)-BigInt(f.sellQuoteAtomic)&&f.programAccountTrades<=f.decodedTrades;
  const users=new Set<string>();let buy=0n,sell=0n,trades=0,programTrades=0,programQuote=0n,buyers=0,satisfied=0;
  for(const w of r.windows){
    const f=w.flow!,list=w.firstObservedBuyers!;
    if(!arithmetic(f)||w.firstObservedBuyerCount!==list.length||w.condition!==(list.length>0&&BigInt(f.netQuoteAtomic)>=0n))issue('ADVISORY_SHORT_DEMAND_WINDOW');
    for(const b of list){const at=ms(b.at);if(users.has(b.user)||at<ms(w.start)||at>=ms(w.end)||BigInt(b.coreQuoteAtomic)<10_000_000n)issue('ADVISORY_SHORT_DEMAND_BUYER');users.add(b.user);}
    buy+=BigInt(f.buyQuoteAtomic);sell+=BigInt(f.sellQuoteAtomic);trades+=f.decodedTrades;programTrades+=f.programAccountTrades;programQuote+=BigInt(f.programAccountQuoteAtomic);buyers+=list.length;if(w.condition)satisfied++;
  }
  if(!arithmetic(base)||!arithmetic(measured)||measured.decodedTrades!==trades||BigInt(measured.buyQuoteAtomic)!==buy||BigInt(measured.sellQuoteAtomic)!==sell||measured.programAccountTrades!==programTrades||BigInt(measured.programAccountQuoteAtomic)!==programQuote)issue('ADVISORY_SHORT_DEMAND_FLOW');
  if(r.satisfiedWindows!==satisfied||r.share!==new Decimal(satisfied).div(6).toFixed())issue('ADVISORY_SHORT_DEMAND_SHARE');
  const baseBuyers=r.baseline.meaningfulBuyers??0;
  if(c.firstObservedBuyers!==buyers||c.baselineMeaningfulBuyers!==baseBuyers||c.buyQuoteDeltaAtomic!==String(buy-BigInt(base.buyQuoteAtomic))||c.netQuoteDeltaAtomic!==String(buy-sell-BigInt(base.netQuoteAtomic))||c.buyerRatio!==(baseBuyers>0?new Decimal(buyers).div(baseBuyers).toFixed():null))issue('ADVISORY_SHORT_DEMAND_COMPARISON');
});
export type ShortDemandReportFacts=z.infer<typeof shortDemandReportSchema>;

/** A29 prospective same-slot absorption (facts v37): one frozen top-5 cohort over one actual interval of at least 600 s, every component recomputed by the provider from imported raw receipts. Descriptive only: no absorption boolean, causal or predictive claim; unresolved values are null, never zero. */
export const A29_DATA_METHOD='prospective-same-slot-absorption-v1';
const a29Hex=z.string().regex(/^[a-f0-9]{64}$/),a29Share=z.string().regex(/^(0|1|0[.][0-9]+)$/),a29Ratio=z.string().regex(/^(0|[1-9][0-9]*)([.][0-9]+)?$/),a29Signed=z.string().regex(/^-?(0|[1-9][0-9]*)([.][0-9]+)?$/);
const a29Concentration=z.object({top1:a29Share,top5:a29Share,top10:a29Share}).strict(),a29ConcentrationDelta=z.object({top1:a29Signed,top5:a29Signed,top10:a29Signed}).strict();
const a29Endpoint=z.object({slot:count,chainTime:instant,attempt:z.number().int().min(1).max(3),supplyAtomic:atomic,baseVaultAtomic:atomic,cohortAtomic:atomic,spotQuotePerBase:a29Ratio,
  depth:z.object({inputAtomic:atomic,quoteAtomic:atomic}).strict(),concentration:z.object({supply:a29Concentration,vaultAdjusted:a29Concentration}).strict()}).strict();
const a29Window=z.object({start:instant,end:instant,meaningfulBuyers:count}).strict();
const a29Vector=z.object({
  units:z.object({quoteMint:z.literal('So11111111111111111111111111111111111111112'),quoteDecimals:z.literal(9),baseDecimals:z.number().int().min(0).max(18)}).strict(),
  endpoints:z.object({e0:a29Endpoint,e1:a29Endpoint}).strict(),
  cohort:z.array(z.object({owner:z.string().min(1),e0Atomic:atomic,e1Atomic:atomic}).strict()).min(1).max(5),
  selling:z.object({trades:count,sellBaseAtomic:atomic,sellQuoteAtomic:atomic,buyBaseAtomic:atomic,buyQuoteAtomic:atomic,netSellBaseAtomic:signedAtomic}).strict(),
  priceChange:z.object({fraction:a29Signed.nullable()}).strict(),
  newBuyerGrowth:z.object({warmup:a29Window,baseline:a29Window,measured:a29Window,difference:z.number().int(),ratio:a29Ratio.nullable()}).strict(),
  depthChange:z.object({quoteDeltaAtomic:signedAtomic,ratio:a29Ratio.nullable()}).strict(),
  concentrationChange:z.object({supply:a29ConcentrationDelta,vaultAdjusted:a29ConcentrationDelta}).strict(),
  inventory:z.object({deltaAtomic:signedAtomic,residualAtomic:signedAtomic}).strict(),
}).strict();
const a29Base=z.object({
  method:z.literal(A29_DATA_METHOD),freezeKind:z.literal('A29_PROSPECTIVE_OBSERVATIONAL_SCOPE_V1'),freezeSha256:a29Hex,token:tokenSchema,label:z.string().min(1),
  status:z.enum(['KNOWN','MISSING','TRUNCATED','INVALID']),
  provenance:z.object({accessMode:z.literal('USER_IMPORT'),source:z.literal('IMPORTED_PRIOR_PUBLIC_CAPTURE'),freshLive:z.literal(false)}).strict(),
  instrument:z.object({cohortSize:z.literal(5),depthImpactBps:z.literal(300),meaningfulBuyerQuoteAtomic:z.literal('10000000'),minimumIntervalSeconds:z.literal(600)}).strict(),
  interval:z.object({slot0:count,slot1:count,t0:instant,t1:instant,seconds:count}).strict().nullable(),
  vector:a29Vector.nullable(),claim:z.literal('DESCRIPTIVE_SAME_INTERVAL_VECTOR'),limitations:z.array(z.string().min(1)).min(1),
}).strict();
type A29Common=Omit<z.infer<typeof a29Base>,'method'|'freezeKind'|'instrument'|'vector'>&{vector:Omit<NonNullable<z.infer<typeof a29Base>['vector']>,'units'>|null};
/** Shared v1/v2 status, interval, window, cohort, inventory, buyer, depth, price and concentration arithmetic. */
const a29Check=(d:A29Common,ctx:z.RefinementCtx)=>{
  const issue=(message:string)=>ctx.addIssue({code:'custom',message}),ms=(value:string)=>Date.parse(value);
  if((d.status==='KNOWN')!==(d.vector!==null)||d.vector!==null&&d.interval===null){issue('ADVISORY_A29_STATUS');return;}
  if(!d.vector||!d.interval)return;
  const v=d.vector,i=d.interval,{e0,e1}=v.endpoints,t0=ms(i.t0),t1=ms(i.t1),L=i.seconds*1000,w=v.newBuyerGrowth;
  if(i.seconds<600||t1-t0!==L||i.slot1<=i.slot0||e0.slot!==i.slot0||e1.slot!==i.slot1||ms(e0.chainTime)!==t0||ms(e1.chainTime)!==t1)issue('ADVISORY_A29_INTERVAL');
  // Three equal L windows: warmup [t0-2L,t0-L), baseline [t0-L,t0], measured (slot0,slot1].
  const spans:Array<[{start:string;end:string},number,number]>=[[w.warmup,t0-2*L,t0-L],[w.baseline,t0-L,t0],[w.measured,t0,t1]];
  if(spans.some(([x,start,end])=>ms(x.start)!==start||ms(x.end)!==end))issue('ADVISORY_A29_WINDOWS');
  const held=(key:'e0Atomic'|'e1Atomic')=>v.cohort.reduce((n,o)=>n+BigInt(o[key]),0n);
  if(new Set(v.cohort.map(o=>o.owner)).size!==v.cohort.length||held('e0Atomic')!==BigInt(e0.cohortAtomic)||held('e1Atomic')!==BigInt(e1.cohortAtomic))issue('ADVISORY_A29_COHORT');
  // The residual is descriptive arithmetic, never gated to zero.
  const s=v.selling,net=BigInt(s.sellBaseAtomic)-BigInt(s.buyBaseAtomic),delta=BigInt(e1.cohortAtomic)-BigInt(e0.cohortAtomic);
  if(BigInt(s.netSellBaseAtomic)!==net||BigInt(v.inventory.deltaAtomic)!==delta||BigInt(v.inventory.residualAtomic)!==delta+net)issue('ADVISORY_A29_INVENTORY');
  if(w.difference!==w.measured.meaningfulBuyers-w.baseline.meaningfulBuyers||(w.ratio===null)!==(w.baseline.meaningfulBuyers===0))issue('ADVISORY_A29_BUYERS');
  if(BigInt(v.depthChange.quoteDeltaAtomic)!==BigInt(e1.depth.quoteAtomic)-BigInt(e0.depth.quoteAtomic)||(v.depthChange.ratio===null)!==(e0.depth.quoteAtomic==='0'))issue('ADVISORY_A29_DEPTH');
  if((v.priceChange.fraction===null)!==new Decimal(e0.spotQuotePerBase).isZero())issue('ADVISORY_A29_PRICE');
  for(const e of [e0,e1])for(const c of [e.concentration.supply,e.concentration.vaultAdjusted])if(new Decimal(c.top1).gt(c.top5)||new Decimal(c.top5).gt(c.top10))issue('ADVISORY_A29_CONCENTRATION');
  // Concentration change is the signed share difference e1 minus e0 under the same Decimal arithmetic, never a ratio.
  const shares=['top1','top5','top10'] as const,change=v.concentrationChange;
  if((['supply','vaultAdjusted'] as const).some(k=>shares.some(x=>!new Decimal(e1.concentration[k][x]).minus(e0.concentration[k][x]).eq(change[k][x]))))issue('ADVISORY_A29_CONCENTRATION');
};
export const a29DataSchema=a29Base.superRefine(a29Check);
export type A29Data=z.infer<typeof a29DataSchema>;

/** A29 v2 (facts v38): the v1 contract over an explicit WSOL, USDC or WBTC quote; a custom-quote threshold is recomputed from the E0 Orca marginal sqrt price, never trusted. */
export const A29_DATA_METHOD_V2='prospective-same-slot-absorption-v2';
const A29_WSOL='So11111111111111111111111111111111111111112';
const a29Quotes:Record<string,{decimals:number;fxPool:string|null}>={[A29_WSOL]:{decimals:9,fxPool:null},EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:{decimals:6,fxPool:'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'},'3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh':{decimals:8,fxPool:'B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA'}};
const a29UnitsV2=z.object({quoteMint:z.enum([A29_WSOL,'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh']),quoteProgram:z.literal('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),quoteDecimals:z.number().int(),baseDecimals:z.number().int().min(0).max(18),
  fx:z.object({pool:z.string(),sqrtPriceX64:z.string().regex(/^[1-9][0-9]{0,38}$/),bankSlot:count}).strict().nullable(),quoteAuthorityRisks:z.record(z.string(),z.string().nullable())}).strict();
export const a29DataSchemaV2=a29Base.extend({
  method:z.literal(A29_DATA_METHOD_V2),freezeKind:z.literal('A29_PROSPECTIVE_OBSERVATIONAL_SCOPE_V2'),
  instrument:z.object({cohortSize:z.literal(5),depthImpactBps:z.literal(300),meaningfulBuyerQuoteAtomic:atomic,thresholdSource:z.enum(['NATIVE','E0_ORCA_WHIRLPOOL_MARGINAL']),minimumIntervalSeconds:z.literal(600)}).strict(),
  vector:a29Vector.extend({units:a29UnitsV2}).strict().nullable(),
}).strict().superRefine((d,ctx)=>{
  a29Check(d,ctx);
  if(!d.vector||!d.interval)return;
  const issue=(message:string)=>ctx.addIssue({code:'custom',message}),u=d.vector.units,q=a29Quotes[u.quoteMint]!,fx=u.fx,wsol=u.quoteMint===A29_WSOL;
  if(u.quoteDecimals!==q.decimals||wsol!==(fx===null)||fx&&(fx.pool!==q.fxPool||fx.bankSlot!==d.interval.slot0))issue('ADVISORY_A29_UNITS');
  // ceil(1e7*S^2/2^128) in exact integers.
  const S=fx?BigInt(fx.sqrtPriceX64):0n,denominator=1n<<128n,threshold=fx?String((10_000_000n*S*S+denominator-1n)/denominator):'10000000';
  if(d.instrument.meaningfulBuyerQuoteAtomic!==threshold||d.instrument.thresholdSource!==(fx?'E0_ORCA_WHIRLPOOL_MARGINAL':'NATIVE'))issue('ADVISORY_A29_THRESHOLD');
});

export const advisoryGroups=entryDefinitions.filter(row=>row.checkId.startsWith('ADV-'));
export const advisoryIds=advisoryGroups.flatMap(row=>row.featureIds);
export const advisoryMetricSchema=z.object({
  id:z.string(),quality:z.enum(['KNOWN','MISSING','TRUNCATED','INVALID']),unit:z.string().min(1),
  data:z.unknown(),evidenceIds:z.array(z.string()),reasonCode:z.string().min(1),
}).strict();
export type AdvisoryMetric=z.infer<typeof advisoryMetricSchema>;
export const advisoryFactsSchema=z.object({
  method:z.enum(['advisory-measurements-v1','advisory-measurements-v2','advisory-measurements-v3','advisory-measurements-v4','advisory-measurements-v5','advisory-measurements-v6','advisory-measurements-v7','advisory-measurements-v8','advisory-measurements-v9','advisory-measurements-v10','advisory-measurements-v11','advisory-measurements-v12','advisory-measurements-v13','advisory-measurements-v14','advisory-measurements-v15','advisory-measurements-v16','advisory-measurements-v17','advisory-measurements-v18','advisory-measurements-v19','advisory-measurements-v20','advisory-measurements-v21','advisory-measurements-v22','advisory-measurements-v23','advisory-measurements-v24','advisory-measurements-v25','advisory-measurements-v26','advisory-measurements-v27','advisory-measurements-v28','advisory-measurements-v29','advisory-measurements-v30','advisory-measurements-v31','advisory-measurements-v32','advisory-measurements-v33','advisory-measurements-v34','advisory-measurements-v35','advisory-measurements-v36','advisory-measurements-v37','advisory-measurements-v38','advisory-measurements-v39']),
  token:z.object({chain:z.enum(['solana','bsc','base','robinhood']),address:z.string().min(1)}).strict(),
  cutoff:z.iso.datetime({offset:true}),metrics:z.array(advisoryMetricSchema).length(advisoryIds.length),
  groups:z.array(z.object({checkId:z.string(),known:z.number().int().nonnegative(),total:z.number().int().positive(),unresolved:z.array(z.string())}).strict()).length(advisoryGroups.length),
  supplements:z.object({shortDemand:shortDemandReportSchema}).strict().optional(),
}).strict().superRefine((facts,ctx)=>{
  if(new Set(facts.metrics.map(m=>m.id)).size!==advisoryIds.length||facts.metrics.some(m=>!advisoryIds.includes(m.id)))ctx.addIssue({code:'custom',message:'ADVISORY_METRIC_MEMBERSHIP'});
  for(const group of advisoryGroups){
    const reported=facts.groups.filter(g=>g.checkId===group.checkId);
    const unresolved=group.featureIds.filter(id=>facts.metrics.find(m=>m.id===id)?.quality!=='KNOWN');
    if(reported.length!==1||reported[0].total!==group.featureIds.length||reported[0].known!==group.featureIds.length-unresolved.length||JSON.stringify(reported[0].unresolved)!==JSON.stringify(unresolved))ctx.addIssue({code:'custom',message:'ADVISORY_GROUP_COVERAGE'});
  }
  // Only facts v17 and later carry, and must carry, the supplementary report; it stays outside metrics, groups and KNOWN counts.
  if((facts.method==='advisory-measurements-v17'||facts.method==='advisory-measurements-v18'||facts.method==='advisory-measurements-v19'||facts.method==='advisory-measurements-v20'||facts.method==='advisory-measurements-v21'||facts.method==='advisory-measurements-v22'||facts.method==='advisory-measurements-v23'||facts.method==='advisory-measurements-v24'||facts.method==='advisory-measurements-v25'||facts.method==='advisory-measurements-v26'||facts.method==='advisory-measurements-v27'||facts.method==='advisory-measurements-v28'||facts.method==='advisory-measurements-v29'||facts.method==='advisory-measurements-v30'||facts.method==='advisory-measurements-v31'||facts.method==='advisory-measurements-v32'||facts.method==='advisory-measurements-v33'||facts.method==='advisory-measurements-v34'||facts.method==='advisory-measurements-v35'||facts.method==='advisory-measurements-v36'||facts.method==='advisory-measurements-v37'||facts.method==='advisory-measurements-v38'||facts.method==='advisory-measurements-v39')!==(facts.supplements!==undefined))ctx.addIssue({code:'custom',message:'ADVISORY_SUPPLEMENT_VERSION'});
  const short=facts.supplements?.shortDemand;
  if(short?.coverage.logRecovery?.unresolvedForeignSwaps!==undefined&&!['advisory-measurements-v23','advisory-measurements-v24','advisory-measurements-v25','advisory-measurements-v26','advisory-measurements-v27','advisory-measurements-v28','advisory-measurements-v29','advisory-measurements-v30','advisory-measurements-v31','advisory-measurements-v32','advisory-measurements-v33','advisory-measurements-v34','advisory-measurements-v35','advisory-measurements-v36','advisory-measurements-v37','advisory-measurements-v38','advisory-measurements-v39'].includes(facts.method))ctx.addIssue({code:'custom',message:'ADVISORY_RECOVERY_VERSION'});
  if(short&&(short.token.chain!==facts.token.chain||short.token.address!==facts.token.address))ctx.addIssue({code:'custom',message:'ADVISORY_SUPPLEMENT_TOKEN'});
  // Facts v37 binds an A29 that is KNOWN or carries the prospective-absorption method to its strict vector contract and the facts token; older facts keep their recorded A29.
  const a29=facts.metrics.find(m=>m.id==='A29'),a29Method=(a29?.data as {method?:unknown}|null|undefined)?.method;
  // Facts v38/v39 key the strict schema by data method (v1 or v2); facts v37 stays v1-only, so v2 data there fails the v1 schema.
  const a29Schema=(facts.method==='advisory-measurements-v38'||facts.method==='advisory-measurements-v39')&&a29Method===A29_DATA_METHOD_V2?a29DataSchemaV2:a29DataSchema;
  if((facts.method==='advisory-measurements-v37'||facts.method==='advisory-measurements-v38'||facts.method==='advisory-measurements-v39')&&a29&&(a29.quality==='KNOWN'||a29Method===A29_DATA_METHOD||a29Method===A29_DATA_METHOD_V2)){const parsed=a29Schema.safeParse(a29.data);if(!parsed.success||parsed.data.status!==a29.quality||parsed.data.token.chain!==facts.token.chain||parsed.data.token.address!==facts.token.address)ctx.addIssue({code:'custom',message:'ADVISORY_A29_DATA'});}
});
export type AdvisoryFacts=z.infer<typeof advisoryFactsSchema>;
