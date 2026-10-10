import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { TokenRef } from '../domain/contracts.js';
import { canonicalSocialUrl, deriveSocial, socialAccount, socialNamesAddress, socialInputSchema, socialProposalSchema, socialReviewSchema, type SocialInput, type SocialProposal, type SocialReview } from '../domain/social.js';
import { readLimitedText } from './http.js';

const ARTIFACT='advisory-paid-orders';
const timestamp=z.iso.datetime({offset:true});
const orderSchema=z.object({chainId:z.literal('solana').optional(),tokenAddress:z.string().optional(),type:z.string().min(1).max(100),status:z.enum(['processing','cancelled','on-hold','approved','rejected']),paymentTimestamp:z.number().int().nonnegative().safe()}).strict();
const boostSchema=z.object({chainId:z.literal('solana'),tokenAddress:z.string(),id:z.string().min(1).max(100),amount:z.number().finite().nonnegative(),paymentTimestamp:z.number().int().nonnegative().safe()}).strict();
const failureSchema=z.object({method:z.literal('paid-visibility-request-failure-v1'),code:z.enum(['PAID_VISIBILITY_HTTP','PAID_VISIBILITY_TIMEOUT','PAID_VISIBILITY_TRANSPORT','PAID_VISIBILITY_BODY_LIMIT']),status:z.number().int().min(100).max(599).nullable(),body:z.string().max(200000).nullable(),bodyComplete:z.boolean()}).strict();
const responseSchema=z.union([z.array(orderSchema).max(1000),z.object({orders:z.array(orderSchema).max(1000),boosts:z.array(boostSchema).max(1000)}).strict()]);
export type PaidVisibility={method:'dex-paid-visibility-v1';token:TokenRef;availableAt:string|null;quality:'KNOWN'|'MISSING'|'INVALID';orders:z.infer<typeof orderSchema>[];boosts:z.infer<typeof boostSchema>[];reasonCode:string;scope:string};
export type SocialAdvisoryObservation={id:string;quality:'KNOWN'|'MISSING'|'INVALID';unit:string;data:unknown;evidenceIds:string[];reasonCode:string};
const endpoint=(token:TokenRef)=>`https://api.dexscreener.com/orders/v1/solana/${encodeURIComponent(token.address)}`;
const emptyPaid=(token:TokenRef,quality:PaidVisibility['quality'],reasonCode:string):PaidVisibility=>({method:'dex-paid-visibility-v1',token,availableAt:null,quality,orders:[],boosts:[],reasonCode,scope:'Exact-token DEX Screener orders and boosts only; no inference of organic activity, hidden payment or internet-wide absence.'});

/** Request binding matters: historical array wire does not echo the token. */
export function decodeAdvisorySocial(token:TokenRef,rawArtifacts:Record<string,string>,retrievedAt:Record<string,string>,requests:Record<string,{url:string}>):PaidVisibility {
  if(token.chain!=='solana')return emptyPaid(token,'MISSING','PAID_VISIBILITY_CHAIN_UNSUPPORTED');
  if(rawArtifacts[ARTIFACT]===undefined)return emptyPaid(token,'MISSING','PAID_VISIBILITY_UNAVAILABLE');
  try{
    if(requests[ARTIFACT]?.url!==endpoint(token))throw new Error('binding');
    const at=timestamp.parse(retrievedAt[ARTIFACT]);
    const value:unknown=JSON.parse(rawArtifacts[ARTIFACT]),failure=failureSchema.safeParse(value);
    if(failure.success)return {...emptyPaid(token,'MISSING',failure.data.code),availableAt:at};
    const parsed=responseSchema.parse(value);
    const orders=Array.isArray(parsed)?parsed:parsed.orders,boosts=Array.isArray(parsed)?[]:parsed.boosts;
    for(const row of [...orders,...boosts])if(row.chainId&&row.chainId!==token.chain||row.tokenAddress&&row.tokenAddress!==token.address||row.paymentTimestamp>Date.parse(at))throw new Error('binding-or-time');
    if(new Set(boosts.map(row=>row.id)).size!==boosts.length)throw new Error('duplicate');
    return {...emptyPaid(token,'KNOWN','PAID_VISIBILITY_OBSERVED'),availableAt:at,orders,boosts};
  }catch{return emptyPaid(token,'INVALID','PAID_VISIBILITY_WIRE_INVALID');}
}

/** One bounded read; timeout covers the response body as well as headers. */
export async function collectAdvisorySocial(token:TokenRef,fetcher:typeof fetch=fetch,now:()=>string=()=>new Date().toISOString(),signal?:AbortSignal){
  const rawArtifacts:Record<string,string>={},retrievedAt:Record<string,string>={},requests:Record<string,{url:string}>={};
  if(token.chain==='solana'){
    const url=endpoint(token);requests[ARTIFACT]={url};
    const deadline=AbortSignal.timeout(8000),bounded=signal?AbortSignal.any([signal,deadline]):deadline;
    let status:number|null=null;
    try{
      bounded.throwIfAborted();
      const response=await fetcher(url,{headers:{accept:'application/json'},redirect:'error',signal:bounded});
      status=response.status;
      const raw=await Promise.race([readLimitedText(response,200000),new Promise<never>((_,reject)=>{
        if(bounded.aborted){reject(new Error('PAID_VISIBILITY_TIMEOUT'));return;}
        bounded.addEventListener('abort',()=>reject(new Error('PAID_VISIBILITY_TIMEOUT')),{once:true});
      })]);
      bounded.throwIfAborted();
      rawArtifacts[ARTIFACT]=response.ok?raw:JSON.stringify(failureSchema.parse({method:'paid-visibility-request-failure-v1',code:'PAID_VISIBILITY_HTTP',status,body:raw,bodyComplete:true}));
      retrievedAt[ARTIFACT]=now();
    }catch(error){
      const code=bounded.aborted?'PAID_VISIBILITY_TIMEOUT':error instanceof Error&&error.message==='PROVIDER_RESPONSE_LIMIT'?'PAID_VISIBILITY_BODY_LIMIT':'PAID_VISIBILITY_TRANSPORT';
      rawArtifacts[ARTIFACT]=JSON.stringify({method:'paid-visibility-request-failure-v1',code,status,body:null,bodyComplete:false});
      retrievedAt[ARTIFACT]=now();
    }
  }
  return {rawArtifacts,retrievedAt,requests,data:decodeAdvisorySocial(token,rawArtifacts,retrievedAt,requests)};
}

/** Descriptive values only. These observations do not alter admission or actor ground truth. */
export function deriveSocialAdvisory(readInput:SocialInput,proposalInput:SocialProposal|null,reviewInput:SocialReview|null,token:TokenRef,cutoff:string,evidenceIds:string[],paidVisibility:PaidVisibility|null):SocialAdvisoryObservation[]{
  const result:SocialAdvisoryObservation[]=[],ids=[...new Set(evidenceIds)];
  const set=(id:string,quality:SocialAdvisoryObservation['quality'],unit:string,data:unknown,reasonCode:string)=>result.push({id,quality,unit,data,evidenceIds:ids,reasonCode});
  const paidValid=paidVisibility?.quality==='KNOWN'&&paidVisibility.token.chain===token.chain&&paidVisibility.token.address===token.address&&!!paidVisibility.availableAt&&Date.parse(paidVisibility.availableAt)<=Date.parse(cutoff)&&Date.parse(cutoff)-Date.parse(paidVisibility.availableAt)<=900000;
  set('A22',paidVisibility?.quality==='INVALID'?'INVALID':'MISSING','scoped-record',{method:'paid-visibility-observation-v1',dex:paidValid?paidVisibility:null,dexCoverage:paidValid?'OBSERVED':'UNAVAILABLE',disclosedPosts:null,disclosureCoverage:'NOT_COLLECTED',organicActivity:null,hiddenPayments:null,meaning:'Observed DEX orders/boosts only; social paid-disclosure inventory remains uncollected.'},paidValid?'PAID_POST_DISCLOSURE_REVIEW_MISSING':'PAID_VISIBILITY_UNAVAILABLE');
  const read=socialInputSchema.safeParse(readInput),proposal=socialProposalSchema.safeParse(proposalInput),review=socialReviewSchema.safeParse(reviewInput);
  const missing=(reasonCode:string)=>{for(const id of ['A19','A20','A23','S09','S11','A24'])set(id,'MISSING','scoped-record',{method:'social-advisory-v1'},reasonCode);return result;};
  if(!read.success||!proposal.success||!review.success)return missing('SOCIAL_ADVISORY_QUALIFICATION_MISSING');
  const r=read.data,p=proposal.data,v=review.data;
  const derived=deriveSocial(r,p,v,token,cutoff,ids),facts=derived.facts;
  const inspected=r.sources.every(s=>v.sources.find(x=>x.sourceId===s.id)?.complete===true);
  if(!facts.sampleComplete||!inspected||!facts.postCorpusObserved||!r.queries.length)return missing('SOCIAL_ADVISORY_SCOPE_INCOMPLETE');
  const sources=new Map(r.sources.map(s=>[s.id,s])),accepted=(id:string)=>v.decisions.find(x=>x.id===id)?.accepted===true;
  const binds=(post:SocialProposal['posts'][number])=>post.binding==='EXACT_CONTRACT'?socialNamesAddress(post.body.quote,token):post.binding==='PROVEN_ACCOUNT'&&post.bindingProof.length>=2&&new Set(post.bindingProof.map(c=>c.sourceId)).size>=2&&post.bindingProof.some(c=>socialNamesAddress(c.quote,token))&&post.bindingProof.some(c=>{const author=sources.get(post.sourceId)?.authorId;return author&&new RegExp(`(?:@|https://(?:www\\.)?(?:x|twitter)\\.com/)${author.slice(6)}(?![A-Za-z0-9_])`,'i').test(c.quote);});
  const start=Date.parse(r.start),end=Date.parse(r.end),duration=end-start;
  const candidates=p.posts.filter(post=>r.targetPostIds.includes(post.sourceId)&&accepted(`post:${post.sourceId}`)&&post.bodyComplete!==false&&['ORIGINAL','COMMENTARY'].includes(post.role)&&binds(post));
  const posts=[...new Map(candidates.filter(post=>{const s=sources.get(post.sourceId)!;return !!s.publishedAt&&Date.parse(s.publishedAt)>=start&&Date.parse(s.publishedAt)<end&&!!s.authorId&&socialAccount(s.url)===s.authorId;}).map(post=>[canonicalSocialUrl(sources.get(post.sourceId)!.url),post])).values()];
  if(posts.length!==facts.qualifiedOriginalCount)return missing('SOCIAL_ADVISORY_ELIGIBILITY_MISMATCH');
  const scope={start:r.start,end:r.end,queries:r.queries,sourceIds:r.targetPostIds,availableAt:facts.availableAt,meaning:'Complete retained fixed-query sample only, not platform-wide participation.'};
  const bins=[0,0,0],bucketSeconds=duration/3000;
  for(const post of posts){const at=Date.parse(sources.get(post.sourceId)!.publishedAt!);bins[Math.min(2,Math.floor((at-start)/(duration/3)))]++;}
  const acceleration=new Decimal(bins[2]).sub(new Decimal(bins[1]).mul(2)).add(bins[0]).div(new Decimal(bucketSeconds).pow(2)).toFixed();
  set('A19','KNOWN','posts/second^2',{method:'fixed-sample-three-equal-bins-v1',scope,counts:bins,bucketSeconds,acceleration,smallSample:posts.length<10},'ATTENTION_ACCELERATION_OBSERVED');
  set('A20',facts.lineageComplete?'KNOWN':'MISSING','count-vector',{method:'qualified-social-groups-v1',scope,independentSourceGroups:facts.independentGroupCount,independentCommunities:facts.independentCommunityCount,platforms:[...new Set(posts.map(post=>new URL(sources.get(post.sourceId)!.url).hostname.replace(/^www\./,'')))],meaning:'Groups inherit independently reviewed copy/origin/community evidence; platforms are not independent communities.'},facts.lineageComplete?'PROPAGATION_BREADTH_OBSERVED':'PROPAGATION_LINEAGE_UNRESOLVED');
  // ORIGINAL/COMMENTARY is not a topic or forward-looking call-event classification.
  set('A23','MISSING','fraction',{method:'reviewed-topic-fraction-v1',scope,relevantOriginals:posts.length,priceOnly:null,unclassified:posts.length,fraction:null},posts.length?'POST_TOPIC_CLASSIFICATION_UNAVAILABLE':'PRICE_FRACTION_DENOMINATOR_ZERO');
  set('S09','MISSING','fraction-vector',{method:'caller-concentration-v1',scope,eligibleOriginals:posts.length,callEvents:null,shares:null},'FORWARD_CALL_EVENTS_UNQUALIFIED');
  const midpoint=start+duration/2,earlier=new Set<string>(),later=new Set<string>();
  for(const post of posts){const s=sources.get(post.sourceId)!;(Date.parse(s.publishedAt!)<midpoint?earlier:later).add(s.authorId!);}
  const returning=[...earlier].filter(a=>later.has(a)),newAuthors=[...later].filter(a=>!earlier.has(a));
  const comparable=r.previousComparable&&Number.isSafeInteger(midpoint);
  set('S11',comparable&&earlier.size?'KNOWN':'MISSING','fraction',{method:'fixed-sample-two-equal-author-bins-v1',scope,midpoint:new Date(midpoint).toISOString(),earlierAuthors:[...earlier].sort(),laterAuthors:[...later].sort(),returningAuthors:returning.sort(),newAuthors:newAuthors.sort(),churnAuthors:[...earlier].filter(a=>!later.has(a)).sort(),returningFraction:comparable&&earlier.size?new Decimal(returning.length).div(earlier.size).toFixed():null,censoring:'Search indexing, deleted posts and outside-sample authors are not observed.'},!comparable?'RETURNING_WINDOW_NOT_COMPARABLE':earlier.size?'RETURNING_AUTHORS_OBSERVED':'RETURNING_DENOMINATOR_ZERO');
  const authorCounts=new Map<string,number>();for(const post of posts){const author=sources.get(post.sourceId)!.authorId!;authorCounts.set(author,(authorCounts.get(author)??0)+1);}
  set('A24','MISSING','scoped-vector',{method:'saturation-observed-components-v1',scope,originals:posts.length,authors:authorCounts.size,repeatedAuthorPosts:[...authorCounts.values()].reduce((sum,n)=>sum+Math.max(0,n-1),0),authorCounts:[...authorCounts].sort(([a],[b])=>a.localeCompare(b)),newAuthorCount:newAuthors.length,holderGrowth:null,callerBreadth:null,paidVisibility:paidValid?paidVisibility:null,meaning:'Partial observed components; no estimate that everyone knows.'},'SATURATION_HOLDER_AND_CALLER_HISTORY_MISSING');
  return result;
}
