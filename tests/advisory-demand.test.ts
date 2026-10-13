import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAdvisoryDemand } from '../src/domain/advisory-demand.js';
import type { TradeHistory,DecodedTrade } from '../src/providers/advisory-trades.js';
import type { AdvisoryMetric } from '../src/domain/advisory-contracts.js';
const cutoff='2026-10-11T12:00:00.000Z';
const post=(counts=[1,2,3]):AdvisoryMetric=>({id:'A19',quality:'KNOWN',unit:'posts/second^2',data:{scope:{start:'2026-10-11T06:00:00.000Z',end:cutoff},counts,bucketSeconds:7200},evidenceIds:['post-raw'],reasonCode:'OBSERVED'});
const trade=(user:string,at:string,quoteAtomic='10000000',side:'BUY'|'SELL'='BUY'):DecodedTrade=>({user,at,quoteAtomic,side,signature:user+at,slot:10,instructionIndex:0,baseAtomic:'500',poolBaseReservesAtomic:'10000',poolQuoteReservesAtomic:'10000'});
const history=(trades:DecodedTrade[]):TradeHistory=>({method:'pumpswap-decoded-sample-v1',token:{chain:'solana',address:'mint'},pool:'pool',quoteMint:'WSOL',quoteDecimals:9,poolVerified:true,stateSlot:100,trades,buyQuoteAtomic:'0',sellQuoteAtomic:'0',netQuoteAtomic:'0',coveredInterval:null,sourceUniverseComplete:false,complete:false,transactionsInspected:trades.length,transactionsExcluded:0,excluded:[],limitations:[]});
test('buyer/post components exclude dust, sells, duplicate buyers and outside half-open window',()=>{
 const h=history([trade('same','2026-10-11T10:00:00.000Z'),trade('same','2026-10-11T06:30:00.000Z'),trade('dust','2026-10-11T10:10:00.000Z','9999999'),trade('sell','2026-10-11T10:10:00.000Z','10000000','SELL'),trade('last','2026-10-11T10:30:00.000Z'),trade('before','2026-10-11T05:59:59.999Z'),trade('end',cutoff),trade('future','2026-10-11T13:00:00.000Z')]);
 const [a,b]=deriveAdvisoryDemand(h,post(),cutoff,['trade-raw']);
 assert.equal(a!.quality,'TRUNCATED');assert.deepEqual((a!.data as any).buyerBins,[1,0,1]);assert.equal((a!.data as any).buyers,2);assert.equal((a!.data as any).qualifiedPosts,6);assert.equal((a!.data as any).sampleBuyersPerPost,'0.33333333333333333333');assert.equal((a!.data as any).buyersPerPost,null);
 assert.equal((b!.data as any).postChange,2);assert.equal((b!.data as any).sampleMarginalEfficiency,'0');assert.equal((b!.data as any).marginalEfficiency,null);assert.deepEqual(a!.evidenceIds,['trade-raw','post-raw']);
});
test('zero posts or nonpositive post growth never become zero-valued known ratios',()=>{
 const h=history([trade('buyer','2026-10-11T10:01:00.000Z')]);
 for(const counts of [[0,0,0],[3,2,3],[4,2,1]]){const [a,b]=deriveAdvisoryDemand(h,post(counts),cutoff,[]);assert.equal(b!.quality,'MISSING');assert.equal((b!.data as any).sampleMarginalEfficiency,null);assert.equal(b!.reasonCode,'ATTENTION_GROWTH_DENOMINATOR_NONPOSITIVE');if(counts.every(n=>n===0)){assert.equal(a!.quality,'MISSING');assert.equal((a!.data as any).sampleBuyersPerPost,null);assert.equal(a!.reasonCode,'BUYER_POST_DENOMINATOR_ZERO');}}
});
test('no decoded tape is unavailable, never zero buyers evidence',()=>{
 const [a,b]=deriveAdvisoryDemand(history([]),post(),cutoff,[]);assert.equal(a!.quality,'MISSING');assert.equal(b!.quality,'MISSING');assert.equal((a!.data as any).sampleBuyersPerPost,null);
});
test('invalid or unavailable qualified attention windows cannot supply demand measurements',()=>{
 for(const change of [(a:AdvisoryMetric)=>{a.quality='MISSING';},(a:AdvisoryMetric)=>{(a.data as any).counts=[1,-1,3];},(a:AdvisoryMetric)=>{(a.data as any).bucketSeconds=2;},(a:AdvisoryMetric)=>{(a.data as any).scope.end='2026-10-12T12:00:00.000Z';}]){
 const a=post();change(a);const result=deriveAdvisoryDemand(history([trade('a','2026-10-11T07:00:00.000Z')]),a,cutoff,[]);assert.ok(result.every(m=>m.quality==='MISSING'&&m.reasonCode==='QUALIFIED_EQUAL_WINDOW_CORPUS_REQUIRED'));
 }
});
test('unverified pool cannot supply sampled buyer counts',()=>{
 const h=history([trade('a','2026-10-11T07:00:00.000Z')]);h.poolVerified=false;assert.ok(deriveAdvisoryDemand(h,post(),cutoff,[]).every(m=>m.quality==='MISSING'));
});

test('meaningful pre-window buys suppress repeat buyers but pre-window dust and sells do not',()=>{
 const h=history([trade('old','2026-10-11T05:00:00.000Z'),trade('old','2026-10-11T10:30:00.000Z'),trade('dust','2026-10-11T05:00:00.000Z','9999999'),trade('dust','2026-10-11T10:30:00.000Z'),trade('seller','2026-10-11T05:00:00.000Z','10000000','SELL'),trade('seller','2026-10-11T10:30:00.000Z')]);
 const [a,b]=deriveAdvisoryDemand(h,post(),cutoff,[]);
 assert.deepEqual((a!.data as any).firstObservedBuyers.map((x:any)=>x.user).sort(),['dust','seller']);
 assert.deepEqual((a!.data as any).buyerBins,[0,0,2]);assert.equal((b!.data as any).sampleMarginalEfficiency,'1');assert.equal(a!.quality,'TRUNCATED');
});
