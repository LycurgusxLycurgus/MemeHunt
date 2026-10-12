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
    outsideScopeUnresolvedTransactions:count.nullable(),logRecovery:z.object({truncatedTransactions:count,unresolvedNonFlowInvocations:count,emptyForeignSweeps:count}).strict().nullable()}).strict(),
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

export const advisoryGroups=entryDefinitions.filter(row=>row.checkId.startsWith('ADV-'));
export const advisoryIds=advisoryGroups.flatMap(row=>row.featureIds);
export const advisoryMetricSchema=z.object({
  id:z.string(),quality:z.enum(['KNOWN','MISSING','TRUNCATED','INVALID']),unit:z.string().min(1),
  data:z.unknown(),evidenceIds:z.array(z.string()),reasonCode:z.string().min(1),
}).strict();
export type AdvisoryMetric=z.infer<typeof advisoryMetricSchema>;
export const advisoryFactsSchema=z.object({
  method:z.enum(['advisory-measurements-v1','advisory-measurements-v2','advisory-measurements-v3','advisory-measurements-v4','advisory-measurements-v5','advisory-measurements-v6','advisory-measurements-v7','advisory-measurements-v8','advisory-measurements-v9','advisory-measurements-v10','advisory-measurements-v11','advisory-measurements-v12','advisory-measurements-v13','advisory-measurements-v14','advisory-measurements-v15','advisory-measurements-v16','advisory-measurements-v17','advisory-measurements-v18','advisory-measurements-v19','advisory-measurements-v20','advisory-measurements-v21']),
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
  if((facts.method==='advisory-measurements-v17'||facts.method==='advisory-measurements-v18'||facts.method==='advisory-measurements-v19'||facts.method==='advisory-measurements-v20'||facts.method==='advisory-measurements-v21')!==(facts.supplements!==undefined))ctx.addIssue({code:'custom',message:'ADVISORY_SUPPLEMENT_VERSION'});
  const short=facts.supplements?.shortDemand;
  if(short&&(short.token.chain!==facts.token.chain||short.token.address!==facts.token.address))ctx.addIssue({code:'custom',message:'ADVISORY_SUPPLEMENT_TOKEN'});
});
export type AdvisoryFacts=z.infer<typeof advisoryFactsSchema>;
