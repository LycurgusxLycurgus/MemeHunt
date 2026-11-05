import { Decimal } from 'decimal.js';
import type { AdvisoryMetric } from './advisory-contracts.js';
import type { TradeHistory } from '../providers/advisory-trades.js';

/** A partial tape supplies observed components, never complete-window ratios. */
export function deriveAdvisoryDemand(history:TradeHistory,attention:AdvisoryMetric|undefined,cutoff:string,evidenceIds:string[]):AdvisoryMetric[]{
  const data=attention?.data as {scope?:{start?:string;end?:string};counts?:unknown;bucketSeconds?:number}|null;
  const start=Date.parse(data?.scope?.start??''),end=Date.parse(data?.scope?.end??''),counts=data?.counts;
  const valid=attention?.id==='A19'&&attention.quality==='KNOWN'&&Number.isFinite(start)&&Number.isFinite(end)&&start<end&&end<=Date.parse(cutoff)&&Array.isArray(counts)&&counts.length===3&&counts.every(n=>Number.isSafeInteger(n)&&n>=0)&&data?.bucketSeconds===(end-start)/3000;
  const window=valid?{start:new Date(start).toISOString(),end:new Date(end).toISOString(),interval:'[start,end)',bucketSeconds:data!.bucketSeconds}:null;
  const selected=valid&&history.poolVerified?history.trades.filter(t=>Date.parse(t.at)>=start&&Date.parse(t.at)<end):[];
  const threshold=10000000n,first=new Map<string,string>();
  for(const trade of (valid&&history.poolVerified?history.trades.filter(t=>Date.parse(t.at)<end):[]).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.slot-b.slot||a.signature.localeCompare(b.signature)||a.instructionIndex-b.instructionIndex)){
    if(trade.side==='BUY'&&BigInt(trade.quoteAtomic)>=threshold&&!first.has(trade.user))first.set(trade.user,trade.at);
  }
  for(const [user,at] of first)if(Date.parse(at)<start)first.delete(user);
  const buyerBins=[0,0,0];for(const at of first.values())buyerBins[Math.floor((Date.parse(at)-start)/((end-start)/3))]!++;
  const posts=valid?(counts as number[]).reduce((n,x)=>n+x,0):null,postChange=valid?(counts as number[])[2]!-(counts as number[])[0]!:null,buyerChange=buyerBins[2]!-buyerBins[0]!;
  const observed=valid&&history.poolVerified&&selected.length>0;
  const common={method:'sampled-buyer-attention-v1',window,quoteMint:history.quoteMint,quoteDecimals:9,meaningfulQuoteAtomic:threshold.toString(),postCounts:valid?counts:null,buyerBins,firstObservedBuyers:[...first].map(([user,at])=>({user,at})),decodedTrades:selected.length,complete:false,preWindowHistoryComplete:false,limitations:['First observed in retained pool trades is not a new person or a proven first-ever buyer.','Retained transaction caps and exclusions prevent complete-window buyer coverage.','Meaningful threshold is descriptive 0.01 WSOL, not profitability or organic demand.']};
  const ids=[...new Set([...evidenceIds,...(attention?.evidenceIds??[])])];
  return [
    {id:'A26',quality:observed&&posts!>0?'TRUNCATED':'MISSING',unit:'first-observed sampled buyers/post',data:{...common,qualifiedPosts:posts,buyers:first.size,sampleBuyersPerPost:observed&&posts!>0?new Decimal(first.size).div(posts!).toFixed():null,buyersPerPost:null},evidenceIds:ids,reasonCode:!valid?'QUALIFIED_EQUAL_WINDOW_CORPUS_REQUIRED':posts===0?'BUYER_POST_DENOMINATOR_ZERO':!observed?'DECODED_BUYER_HISTORY_UNAVAILABLE':'BUYER_POST_RATIO_INCOMPLETE_TAPE'},
    {id:'A27',quality:observed&&postChange!>0?'TRUNCATED':'MISSING',unit:'change in first-observed sampled buyers/change in posts',data:{...common,comparison:'first versus third equal-duration bin',postChange,buyerChange,sampleMarginalEfficiency:observed&&postChange!>0?new Decimal(buyerChange).div(postChange!).toFixed():null,marginalEfficiency:null},evidenceIds:ids,reasonCode:!valid?'QUALIFIED_EQUAL_WINDOW_CORPUS_REQUIRED':postChange!<=0?'ATTENTION_GROWTH_DENOMINATOR_NONPOSITIVE':!observed?'DECODED_BUYER_HISTORY_UNAVAILABLE':'MARGINAL_EFFICIENCY_INCOMPLETE_TAPE'},
  ];
}
