import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { tokenRefSchema, socialJudgmentSchema, socialPolicyFactsSchema, type TokenRef, type SocialPolicyFacts } from './contracts.js';
import type { BaselineAssessment } from './baseline.js';
export { socialPolicyFactsSchema } from './contracts.js';
export type { SocialPolicyFacts } from './contracts.js';

const timestamp=z.iso.datetime({offset:true});
const citation=z.object({sourceId:z.string().min(1),quote:z.string().min(8).max(1000)}).strict();
const field=z.object({text:z.string().min(1).max(200),citation}).strict();
const association=z.object({key:z.string().min(1).max(300),citation}).strict();
export const socialSourceSchema=z.object({id:z.string().min(1),url:z.string().url(),text:z.string().max(120000),publishedAt:timestamp.nullable(),authorId:z.string().nullable(),availableAt:timestamp,kind:z.enum(['POST','PAGE']),discoveredFrom:z.string().optional()}).strict();
export const socialInputSchema=z.object({
  schemaVersion:z.literal(1),sources:z.array(socialSourceSchema).max(32),start:timestamp,end:timestamp,
  targetPostIds:z.array(z.string()).max(32),identitySourceIds:z.array(z.string()).max(32),sampleComplete:z.boolean(),identityComplete:z.boolean(),
  previousComparable:z.boolean(),codes:z.array(z.string()).max(200),queries:z.array(z.string()).max(20),qualifiedAt:timestamp.optional(),
}).strict();
export const socialProposalSchema=z.object({
  identityAssessment:socialJudgmentSchema.optional(),integrityAssessment:socialJudgmentSchema.optional(),
  posts:z.array(z.object({sourceId:z.string(),body:citation,bodyComplete:z.boolean().optional(),role:z.enum(['ORIGINAL','REPOST','COMMENTARY','EXCLUDED','UNCLEAR']),binding:z.enum(['EXACT_CONTRACT','PROVEN_ACCOUNT','UNRELATED','UNCLEAR']),bindingProof:z.array(citation).max(5),
    parentSourceId:z.string().nullable(),origin:association.nullable(),community:association.nullable(),campaign:association.nullable(),
    metrics:z.object({likes:field.nullable(),replies:field.nullable(),reposts:field.nullable()}).strict(),
  }).strict()).max(32),
  identities:z.array(z.object({id:z.string(),accountId:z.string(),status:z.enum(['CLAIMED','PUBLIC_BINDING_SUPPORTED','DISAVOWED']),citations:z.array(citation).min(1).max(5)}).strict()).max(32),
  accounts:z.array(z.object({accountId:z.string(),createdAt:field.nullable(),historySourceIds:z.array(z.string()).max(32)}).strict()).max(32),
}).strict();
export const socialReviewSchema=z.object({
  decisions:z.array(z.object({id:z.string(),accepted:z.boolean(),rationale:z.string().min(1).max(500)}).strict()).max(200),
  sources:z.array(z.object({sourceId:z.string(),complete:z.boolean(),rationale:z.string().min(1).max(500)}).strict()).max(32),
  pairs:z.array(z.object({id:z.string(),relation:z.enum(['COPIED_ENDORSEMENT','DISTINCT_COMMENTARY','UNRESOLVED']),rationale:z.string().min(1).max(500)}).strict()).max(496),
}).strict();
export type SocialInput=z.infer<typeof socialInputSchema>;
export type SocialProposal=z.infer<typeof socialProposalSchema>;
export type SocialReview=z.infer<typeof socialReviewSchema>;
export type SocialResult={assessments:BaselineAssessment[];facts:SocialPolicyFacts};
const ids=['S01','S02','S03','S04','S05','S06','S10'] as const;
export const socialNamesAddress=(text:string,token:TokenRef)=>{const escaped=token.address.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return new RegExp(token.chain==='solana'?`(?<![1-9A-HJ-NP-Za-km-z])${escaped}(?![1-9A-HJ-NP-Za-km-z])`:`(?<![0-9a-f])${escaped}(?![0-9a-f])`,token.chain==='solana'?'':'i').test(text);};
export function socialAccount(url:string):string|null {
  try{const u=new URL(url);return /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)&&/^\/[A-Za-z0-9_]+(?:\/status\/\d+)?\/?$/.test(u.pathname)?`x.com:${u.pathname.split('/')[1]!.toLowerCase()}`:null;}catch{return null;}
}
export const canonicalSocialUrl=(url:string)=>{try{const u=new URL(url);const a=socialAccount(url);return a?`https://x.com/${a.slice(6)}${/\/status\/\d+/.exec(u.pathname)?.[0]??''}`:u.toString();}catch{return url;}};
const associationKey=(key:string)=>{try{const u=new URL(key);if(u.protocol!=='https:'||u.username||u.password)return null;u.hash='';u.search='';return canonicalSocialUrl(u.toString());}catch{return null;}};
const communityKey=(key:string)=>{const normalized=associationKey(key);return normalized&&socialAccount(normalized)===null?normalized:null;};
const namesAccount=(text:string,accountId:string)=>new RegExp(`(?:@|https://(?:www\\.)?(?:x|twitter)\\.com/)${accountId.slice(6)}(?![A-Za-z0-9_])`,'i').test(text);
const normalize=(body:string,token:TokenRef)=>body.replaceAll(token.address,'').normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
function similarity(a:string,b:string):number {
  const grams=(s:string)=>{const c=[...s];return new Set(c.slice(0,-2).map((_,i)=>c.slice(i,i+3).join('')));};
  const x=grams(a),y=grams(b),intersection=[...x].filter(g=>y.has(g)).length;return intersection/(x.size+y.size-intersection||1);
}
/** Candidates only: semantic review decides whether near copies are endorsements or commentary. */
export function socialCopyPairs(proposal:SocialProposal,token:TokenRef):Array<{id:string;left:string;right:string}> {
  const posts=proposal.posts.filter(post=>post.bodyComplete!==false).sort((a,b)=>a.sourceId.localeCompare(b.sourceId)),out:Array<{id:string;left:string;right:string}>=[];
  for(let i=0;i<posts.length;i++)for(let j=i+1;j<posts.length;j++){
    const a=normalize(posts[i]!.body.quote,token),b=normalize(posts[j]!.body.quote,token);
    if(a&&b&&(a===b||[...a].length>=80&&[...b].length>=80&&similarity(a,b)>=.9))out.push({id:`copy:${posts[i]!.sourceId}:${posts[j]!.sourceId}`,left:posts[i]!.sourceId,right:posts[j]!.sourceId});
  }
  return out;
}
export function deriveSocial(input:SocialInput,proposalInput:SocialProposal|null,reviewInput:SocialReview|null,token:TokenRef,cutoff:string,evidenceIds:string[]):SocialResult {
  const read=socialInputSchema.parse(input),byId=new Map(read.sources.map(s=>[s.id,s])),at=Date.parse(cutoff);
  const availableAt=new Date(Math.max(Date.parse(read.qualifiedAt??read.end),Date.parse(read.end),...read.sources.map(s=>Date.parse(s.availableAt)))).toISOString();
  const facts:SocialPolicyFacts={version:'social-policy-v1',method:'social-source-review-v1',token,start:read.start,end:read.end,availableAt,evidenceIds:[...new Set(evidenceIds)],postCorpusObserved:read.targetPostIds.length>0,sampleComplete:false,lineageComplete:false,qualifiedOriginalCount:null,accountUpperBound:null,independentGroupCount:null,independentCommunityCount:null};
  const output=new Map<string,BaselineAssessment>();
  const set=(id:typeof ids[number],value:boolean|null,code:string,data:unknown={})=>{
    const quality=value===null?'MISSING':'KNOWN';output.set(id,{id,version:'baseline-v1',evaluator:'IMPLEMENTED',collector:'IMPLEMENTED',quality,unit:'scoped-record',data:{method:'social-source-review-v1',definitionVersion:`${id}-social-v2`,window:{start:read.start,end:read.end},...data as object},observationIds:[],evidenceIds:facts.evidenceIds,limitations:['social-source-review-v1: bounded public-source claims; accounts are not people; no authenticity, organic-traffic or bot verdict'],causes:value===null?[{category:/CITATION|REVIEW|PAIR|FIELD_INVALID|POST_OMITTED|MODEL_INVALID|ASSOCIATION_INVALID|ACCOUNT_INVALID|HISTORY_INVALID/.test(code)?'CLAIM_UNVALIDATED':'EVIDENCE_UNAVAILABLE',code,featureId:id,evidenceIds:facts.evidenceIds,action:'Refresh the named public-source scope automatically; unavailable fields remain missing rather than fabricated.'}]:[],projection:{id,value,unit:'bool',quality,availableAt,evidenceIds:facts.evidenceIds,applicability:'APPLICABLE'}});
  };
  for(const id of ids)set(id,null,read.codes[0]??'SOC_REVIEW_REJECTED');
  const finish=()=>({assessments:ids.map(id=>output.get(id)!),facts:socialPolicyFactsSchema.parse(facts)});
  let p:SocialProposal,r:SocialReview;
  try{
    if(byId.size!==read.sources.length||new Set(read.targetPostIds).size!==read.targetPostIds.length||new Set(read.identitySourceIds).size!==read.identitySourceIds.length||[...read.targetPostIds,...read.identitySourceIds].some(id=>!byId.has(id))||read.targetPostIds.some(id=>byId.get(id)?.kind!=='POST')||Date.parse(read.start)>=Date.parse(read.end)||Date.parse(read.end)>at||Date.parse(availableAt)>at||read.sources.some(s=>s.publishedAt&&Date.parse(s.publishedAt)>Date.parse(s.availableAt)))throw new Error('SOC_SCOPE_INVALID');
    if(at-Date.parse(read.end)>900000||read.sources.some(s=>at-Date.parse(s.availableAt)>900000))throw new Error('SOC_SOURCE_STALE');
    if(proposalInput===null||reviewInput===null)return finish();
    p=socialProposalSchema.parse(proposalInput);r=socialReviewSchema.parse(reviewInput);
    const cite=(c:z.infer<typeof citation>)=>{const s=byId.get(c.sourceId);if(!s||!s.text.includes(c.quote))throw new Error('SOC_CITATION_INVALID');return s;};
    const unique=(values:string[])=>{if(new Set(values).size!==values.length)throw new Error('SOC_REVIEW_INVALID');};
    unique(p.posts.map(x=>x.sourceId));unique(p.identities.map(x=>x.id));unique(p.accounts.map(x=>x.accountId));unique(r.decisions.map(x=>x.id));unique(r.sources.map(x=>x.sourceId));unique(r.pairs.map(x=>x.id));
    const expected=[...p.posts.map(x=>`post:${x.sourceId}`),...p.identities.map(x=>`identity:${x.id}`),...p.accounts.map(x=>`account:${x.accountId}`),...(p.identityAssessment?['assessment:identity']:[]),...(p.integrityAssessment?['assessment:integrity']:[])];
    if(r.decisions.length!==expected.length||r.decisions.some(d=>!expected.includes(d.id))||r.sources.length!==read.sources.length||r.sources.some(s=>!byId.has(s.sourceId)))throw new Error('SOC_REVIEW_INVALID');
    if(p.posts.length!==read.sources.filter(s=>s.kind==='POST').length||p.posts.some(x=>byId.get(x.sourceId)?.kind!=='POST'||x.body.sourceId!==x.sourceId))throw new Error('SOC_POST_OMITTED');
    for(const post of p.posts){cite(post.body);for(const c of post.bindingProof)cite(c);for(const assoc of [post.origin,post.community,post.campaign])if(assoc){cite(assoc.citation);if(!assoc.citation.quote.includes(assoc.key))throw new Error('SOC_ASSOCIATION_INVALID');}for(const f of Object.values(post.metrics))if(f){cite(f.citation);if(f.citation.sourceId!==post.sourceId||!f.citation.quote.includes(f.text))throw new Error('SOC_FIELD_INVALID');}}
    for(const claim of p.identities){if(!/^x\.com:[a-z0-9_]+$/.test(claim.accountId))throw new Error('SOC_ACCOUNT_INVALID');for(const c of claim.citations)cite(c);}
    for(const account of p.accounts){if(!/^x\.com:[a-z0-9_]+$/.test(account.accountId))throw new Error('SOC_ACCOUNT_INVALID');if(account.createdAt){const s=cite(account.createdAt.citation);if(socialAccount(s.url)!==account.accountId||!account.createdAt.citation.quote.includes(account.createdAt.text))throw new Error('SOC_FIELD_INVALID');}for(const id of account.historySourceIds)if(!byId.has(id)||socialAccount(byId.get(id)!.url)!==account.accountId)throw new Error('SOC_HISTORY_INVALID');}
    for(const judgment of [p.identityAssessment,p.integrityAssessment])if(judgment)for(const c of judgment.citations)cite(c);
    const pairs=socialCopyPairs(p,token);if(r.pairs.length!==pairs.length||r.pairs.some(x=>!pairs.some(pair=>pair.id===x.id)))throw new Error('SOC_PAIR_REVIEW_INVALID');
  }catch(error){const code=error instanceof Error&&/^SOC_/.test(error.message)?error.message:'SOC_REVIEW_REJECTED';for(const id of ids)set(id,null,code);return finish();}
  const accepted=(id:string)=>r.decisions.find(d=>d.id===id)?.accepted===true;
  const reviewed=(id:string)=>r.sources.find(s=>s.sourceId===id)?.complete===true;
  const bound=(post:SocialProposal['posts'][number])=>post.bodyComplete!==false&&(post.binding==='EXACT_CONTRACT'?socialNamesAddress(post.body.quote,token):post.binding==='PROVEN_ACCOUNT'&&post.bindingProof.length>=2&&post.bindingProof.every(c=>reviewed(c.sourceId))&&new Set(post.bindingProof.map(c=>c.sourceId)).size>=2&&!!byId.get(post.sourceId)?.authorId&&post.bindingProof.some(c=>socialNamesAddress(c.quote,token))&&post.bindingProof.some(c=>namesAccount(c.quote,byId.get(post.sourceId)!.authorId!)));
  const inWindow=(id:string,start=read.start,end=read.end)=>{const s=byId.get(id)!;return !!s.publishedAt&&Date.parse(s.publishedAt)>=Date.parse(start)&&Date.parse(s.publishedAt)<Date.parse(end);};
  // A reviewed unrelated/excluded source is a valid disposition; a claimed bound source must prove its binding.
  facts.sampleComplete=read.sampleComplete&&read.targetPostIds.every(id=>{const s=byId.get(id)!,post=p.posts.find(x=>x.sourceId===id);if(!s.publishedAt)return false;/* A source-evidenced date outside this window cannot contribute to current participation. Prior-window qualification is checked separately below. */if(!inWindow(id))return true;return reviewed(id)&&!!s.authorId&&socialAccount(s.url)===s.authorId&&!!post&&accepted(`post:${id}`)&&post.bodyComplete!==false&&post.role!=='UNCLEAR'&&post.binding!=='UNCLEAR'&&(post.binding==='UNRELATED'||bound(post));});
  const qualified=p.posts.filter(post=>read.targetPostIds.includes(post.sourceId)&&accepted(`post:${post.sourceId}`)&&reviewed(post.sourceId)&&['ORIGINAL','COMMENTARY'].includes(post.role)&&bound(post)&&inWindow(post.sourceId));
  const canonicalPosts=new Map<string,SocialProposal['posts'][number]>();
  for(const post of qualified){const key=canonicalSocialUrl(byId.get(post.sourceId)!.url),prior=canonicalPosts.get(key);if(prior&&prior.body.quote!==post.body.quote)facts.sampleComplete=false;else if(!prior)canonicalPosts.set(key,post);}
  const posts=[...canonicalPosts.values()];
  const accounts=[...new Set(posts.map(post=>byId.get(post.sourceId)!.authorId).filter((a):a is string=>!!a))];
  if(facts.sampleComplete&&facts.postCorpusObserved){facts.qualifiedOriginalCount=posts.length;facts.accountUpperBound=accounts.length;}
  const identityComplete=read.identityComplete&&read.identitySourceIds.length>0&&read.identitySourceIds.every(reviewed)&&p.identities.every(claim=>accepted(`identity:${claim.id}`));
  const identityBinding=(claim:SocialProposal['identities'][number])=>{
    const own=claim.citations.filter(c=>socialAccount(byId.get(c.sourceId)!.url)===claim.accountId&&socialNamesAddress(c.quote,token));
    const primary=claim.citations.filter(c=>socialAccount(byId.get(c.sourceId)!.url)!==claim.accountId&&socialNamesAddress(c.quote,token)&&namesAccount(c.quote,claim.accountId));
    return claim.citations.every(c=>reviewed(c.sourceId))&&own.length>0&&primary.some(c=>own.every(a=>a.sourceId!==c.sourceId));
  };
  const disavowals=p.identities.filter(c=>accepted(`identity:${c.id}`)&&c.status==='DISAVOWED'&&c.citations.every(ref=>reviewed(ref.sourceId))&&c.citations.some(ref=>socialNamesAddress(ref.quote,token)&&namesAccount(ref.quote,c.accountId)&&socialAccount(byId.get(ref.sourceId)!.url)!==c.accountId));
  const identityConflict=disavowals.some(c=>p.identities.some(other=>other.accountId===c.accountId&&other.status==='PUBLIC_BINDING_SUPPORTED'&&accepted(`identity:${other.id}`)&&identityBinding(other)));
  const incompleteOpposingBinding=disavowals.some(c=>p.identities.some(other=>other.accountId===c.accountId&&other.status==='PUBLIC_BINDING_SUPPORTED'&&accepted(`identity:${other.id}`)&&!identityBinding(other)));
  const identityKnown=identityComplete&&(p.identities.length===0||p.identities.every(c=>c.status==='PUBLIC_BINDING_SUPPORTED'&&identityBinding(c)));
  set('S01',identityConflict||incompleteOpposingBinding?null:disavowals.length?false:identityKnown?true:null,identityConflict?'SOC_IDENTITY_CONFLICT':'SOC_IDENTITY_PROOF_UNRESOLVED',{claims:p.identities,scopeComplete:identityComplete,meaning:'Public source binding only; no real-world authenticity guarantee'});
  const parent=new Map(posts.map(post=>[post.sourceId,post.sourceId]));
  const root=(id:string):string=>{let next=id;while(parent.get(next)!==next)next=parent.get(next)!;return next;};
  const union=(a:string,b:string)=>{if(!parent.has(a)||!parent.has(b))return;const x=root(a),y=root(b);if(x!==y)parent.set(x<y?y:x,x<y?x:y);};
  let copyComplete=facts.sampleComplete&&facts.postCorpusObserved;
  for(const post of p.posts.filter(post=>read.targetPostIds.includes(post.sourceId)&&inWindow(post.sourceId)&&post.role==='REPOST'))if(!post.parentSourceId||!p.posts.some(p=>p.sourceId===post.parentSourceId))copyComplete=false;
  for(const post of posts){const seen=new Set<string>();let current:SocialProposal['posts'][number]|undefined=post;while(current?.parentSourceId){if(seen.has(current.sourceId)){copyComplete=false;break;}seen.add(current.sourceId);current=p.posts.find(p=>p.sourceId===current!.parentSourceId);}}
  for(const pair of socialCopyPairs(p,token)){const decision=r.pairs.find(d=>d.id===pair.id)!;if(parent.has(pair.left)&&parent.has(pair.right)){if(decision.relation==='COPIED_ENDORSEMENT')union(pair.left,pair.right);else if(decision.relation==='UNRESOLVED')copyComplete=false;}}
  for(const post of posts)if(post.parentSourceId){if(!parent.has(post.parentSourceId)||post.parentSourceId===post.sourceId)copyComplete=false;else union(post.sourceId,post.parentSourceId);}
  for(const post of posts)for(const other of posts)if(post!==other&&(post.origin&&other.origin&&(associationKey(post.origin.key)??post.origin.key)===(associationKey(other.origin.key)??other.origin.key)||post.campaign&&other.campaign&&(associationKey(post.campaign.key)??post.campaign.key)===(associationKey(other.campaign.key)??other.campaign.key)))union(post.sourceId,other.sourceId);
  const lineageComplete=copyComplete&&posts.every(post=>!!post.origin&&reviewed(post.origin.citation.sourceId)&&!!associationKey(post.origin.key)&&!!post.community&&reviewed(post.community.citation.sourceId)&&!!communityKey(post.community.key));
  facts.lineageComplete=lineageComplete;
  if(lineageComplete){const components=[...new Set(posts.map(post=>root(post.sourceId)))];facts.independentGroupCount=components.length;facts.independentCommunityCount=new Set(components.map(group=>posts.filter(post=>root(post.sourceId)===group).map(post=>communityKey(post.community!.key)!).sort()[0]!)).size;}
  const grouping={accounts:accounts.length,qualifiedOriginals:posts.length,copyGroups:[...new Set(posts.map(post=>root(post.sourceId)))],lineageComplete,independentOrigins:facts.independentGroupCount,independentCommunities:facts.independentCommunityCount};
  set('S02',copyComplete?true:null,'SOC_LINEAGE_UNRESOLVED',grouping);
  set('S03',lineageComplete?(accounts.length>=3&&(facts.independentGroupCount??0)>=2):null,'SOC_LINEAGE_UNRESOLVED',grouping);
  set('S10',lineageComplete?(facts.independentCommunityCount??0)>=3:null,'SOC_LINEAGE_UNRESOLVED',{...grouping,threshold:3});
  const peak=(xs:SocialProposal['posts'])=>{const bins=new Map<number,number>();for(const x of xs){const minute=Math.floor(Date.parse(byId.get(x.sourceId)!.publishedAt!)/60000);bins.set(minute,(bins.get(minute)??0)+1);}return xs.length?new Decimal(Math.max(...bins.values())).div(xs.length).toFixed():null;};
  const priorStart=new Date(Date.parse(read.start)-(Date.parse(read.end)-Date.parse(read.start))).toISOString();
  const previous=p.posts.filter(post=>read.targetPostIds.includes(post.sourceId)&&accepted(`post:${post.sourceId}`)&&reviewed(post.sourceId)&&['ORIGINAL','COMMENTARY'].includes(post.role)&&bound(post)&&inWindow(post.sourceId,priorStart,read.start));
  const currentPeak=peak(posts),previousPeak=peak(previous);
  const baselineKnown=facts.sampleComplete&&read.previousComparable&&posts.length>=3&&previous.length>=3&&p.posts.filter(post=>inWindow(post.sourceId,priorStart,read.start)).every(post=>accepted(`post:${post.sourceId}`)&&reviewed(post.sourceId));
  set('S04',baselineKnown?new Decimal(currentPeak!).lte(previousPeak!):null,'SOC_COORDINATION_BASELINE_MISSING',{currentPeakFraction:currentPeak,previousPeakFraction:previousPeak,previousOriginals:previous.length,minimumOriginals:3,calibration:'UNCALIBRATED',meaning:'Equal-window sampled synchrony contrast, not manipulation proof'});
  const indicators=accounts.map(accountId=>{const record=p.accounts.find(a=>a.accountId===accountId);const first=Math.min(...posts.filter(p=>byId.get(p.sourceId)!.authorId===accountId).map(p=>Date.parse(byId.get(p.sourceId)!.publishedAt!)));let creation:string|null=null;
    if(record&&accepted(`account:${accountId}`)&&record.createdAt&&reviewed(record.createdAt.citation.sourceId)&&timestamp.safeParse(record.createdAt.text).success&&/\b(?:joined|created|creation)\b/i.test(record.createdAt.citation.quote)&&Date.parse(record.createdAt.text)<=first)creation=record.createdAt.text;
    const history=record&&accepted(`account:${accountId}`)?[...new Map(record.historySourceIds.map(id=>byId.get(id)!).filter(s=>s.kind==='POST'&&s.publishedAt&&Date.parse(s.publishedAt)<=at&&reviewed(s.id)&&accepted(`post:${s.id}`)&&p.posts.some(post=>post.sourceId===s.id&&post.bodyComplete!==false&&['ORIGINAL','COMMENTARY'].includes(post.role))).map(s=>[canonicalSocialUrl(s.url),s])).values()].sort((a,b)=>Date.parse(a.publishedAt!)-Date.parse(b.publishedAt!)):[];
    return {accountId,createdAt:creation,ageSeconds:creation?Math.floor((first-Date.parse(creation))/1000):null,historyPosts:history.length,activityIntervalsSeconds:history.slice(1).map((s,i)=>(Date.parse(s.publishedAt!)-Date.parse(history[i]!.publishedAt!))/1000)};});
  set('S05',facts.sampleComplete&&posts.length>0&&indicators.every(a=>a.createdAt&&a.historyPosts>=3)?true:null,indicators.some(a=>!a.createdAt)?'SOC_ACCOUNT_DATE_PRECISION':'SOC_ACCOUNT_HISTORY_MISSING',{indicators,meaning:'Descriptive public account age/activity; no bot classifier'});
  const metric=(f:z.infer<typeof field>|null,name:string):string|null=>{
    if(!f||!/^\d+(?:\.\d+)?$/.test(f.text))return null;
    const source=byId.get(f.citation.sourceId)!.text;
    const quoted:Array<{start:number;end:number}>=[];
    for(let offset=source.indexOf(f.citation.quote);offset!==-1;offset=source.indexOf(f.citation.quote,offset+1))quoted.push({start:offset,end:offset+f.citation.quote.length});
    const labels=name==='reposts'?'(?:reposts?|retweets?)':name==='replies'?'(?:replies|reply)':'likes?';
    const numericNeighbor=(text:string)=>/^[+\-\u2212.,]*\p{N}/u.test(text)||/^[+\-\u2212.,]+$/.test(text);
    // Inspect retained source context, including text outside the citation. A
    // whitespace separator or clipped quote cannot make a grouped count exact.
    for(const label of source.matchAll(new RegExp(`\\b${labels}\\b`,'gi'))){
      const labelStart=label.index!,labelEnd=labelStart+label[0].length;
      const delimiter=/^\s*[:=]\s*/.exec(source.slice(labelEnd));
      let token:string,start:number;
      if(delimiter){
        start=labelEnd+delimiter[0].length;
        const next=/^\S+/.exec(source.slice(start));if(!next)continue;
        token=next[0];
      }else{
        const previous=/(\S+)\s+$/.exec(source.slice(0,labelStart));if(!previous)continue;
        token=previous[1]!;start=previous.index;
      }
      const end=start+token.length;
      if(!quoted.some(q=>q.start<=Math.min(start,labelStart)&&q.end>=Math.max(end,labelEnd)))continue;
      const before=/(\S+)\s+$/.exec(source.slice(0,start))?.[1];
      const after=/^\s+(\S+)/.exec(source.slice(end))?.[1];
      if(before&&numericNeighbor(before)||after&&(numericNeighbor(after)||/^[KkMm]\b/.test(after)))continue;
      if(token===f.text&&/^\d+(?:\.\d+)?$/.test(token))return new Decimal(token).toFixed();
    }
    return null;
  };
  const engagement=posts.map(post=>({sourceId:post.sourceId,platform:'x.com',observedAt:byId.get(post.sourceId)!.availableAt,likes:metric(post.metrics.likes,'likes'),replies:metric(post.metrics.replies,'replies'),reposts:metric(post.metrics.reposts,'reposts')}));
  const coverage=Object.fromEntries(['likes','replies','reposts'].map(name=>[name,engagement.filter(row=>row[name as 'likes']!==null).length]));
  const median=(name:'likes'|'replies'|'reposts')=>{const values=engagement.map(row=>row[name]).filter((v):v is string=>v!==null).map(v=>new Decimal(v)).sort((a,b)=>a.cmp(b));if(!values.length)return null;const i=Math.floor(values.length/2);return values.length%2?values[i]!.toFixed():values[i-1]!.add(values[i]!).div(2).toFixed();};
  set('S06',facts.sampleComplete&&posts.length>0&&Object.values(coverage).every(n=>n===posts.length)?true:null,'SOC_METRIC_FIELDS_MISSING',{required:posts.length,coverage,engagement,median:{likes:median('likes'),replies:median('replies'),reposts:median('reposts')},meaning:'Exact labeled observed metrics; views/followers/unlabeled numbers are excluded'});
  const missingIndicators:Array<'ACCOUNT_HISTORY'|'ENGAGEMENT'|'COMPARABLE_HISTORY'>=[];
  if(output.get('S05')?.quality!=='KNOWN')missingIndicators.push('ACCOUNT_HISTORY');
  if(output.get('S06')?.quality!=='KNOWN')missingIndicators.push('ENGAGEMENT');
  if(output.get('S04')?.quality!=='KNOWN')missingIndicators.push('COMPARABLE_HISTORY');
  for(const [name,judgment] of [['identity',p.identityAssessment],['integrity',p.integrityAssessment]] as const)if(judgment){
    const scopeQualified=name==='identity'?identityComplete:read.sampleComplete&&facts.sampleComplete&&facts.postCorpusObserved&&read.sources.every(source=>reviewed(source.id));
    const sourceQualified=scopeQualified&&accepted(`assessment:${name}`)&&judgment.citations.every(c=>reviewed(c.sourceId));
    const invalidMetric=posts.some(post=>Object.entries(post.metrics).some(([metricName,value])=>value!==null&&metric(value,metricName)===null));
    const supportQualified=name==='identity'?output.get('S01')?.projection?.value===true&&p.identities.some(claim=>claim.status==='PUBLIC_BINDING_SUPPORTED'&&identityBinding(claim)&&claim.citations.some(c=>{const source=byId.get(c.sourceId)!;return source.kind==='PAGE'&&socialAccount(source.url)===null&&socialNamesAddress(c.quote,token)&&namesAccount(c.quote,claim.accountId);})):facts.sampleComplete&&facts.lineageComplete&&posts.length>0&&output.get('S02')?.projection?.value===true&&output.get('S04')?.projection?.value!==false&&!invalidMetric;
    const verdict=sourceQualified&&(judgment.verdict!=='SUPPORTED'||supportQualified)?judgment.verdict:'UNRESOLVED';
    facts[name==='identity'?'identityReview':'integrityReview']={...judgment,verdict,method:'source-transparency-review-v1',missingIndicators:name==='integrity'?missingIndicators:[]};
  }
  return finish();
}
