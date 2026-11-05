import {createHash} from 'node:crypto';
import {z} from 'zod';
import {socialInputSchema,type SocialInput} from '../domain/social.js';
import {normalizeAttentionSearchUrl,normalizeAttentionFetchUrl,originSeedLinks} from './attention.js';

export type EmptyCurrentPostsProof={
 method:'raw-acquisition-empty-current-posts-v1';range:{start:string;end:string};targetPostIds:string[];canonicalPostUrls:string[];currentPostIds:[];
 rawCounts:{searches:number;fetches:number;postCandidates:number;postAliases:number;retainedPosts:number;comparisonPageFailures:number};acquisitionHash:string;
};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const timestamp=z.iso.datetime({offset:true});
const requireFact=(v:unknown):void=>{if(!v)throw Error('EMPTY_CURRENT_POST_SOURCE_UNPROVED');};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function url(value:unknown):string{
 requireFact(typeof value==='string');const safe=normalizeAttentionSearchUrl(value as string);requireFact(safe);return safe!;
}
/** Raw URL canonicalization is deliberately before source-ID or URL deduplication. */
function post(value:unknown):string|null{
 const safe=url(value),u=new URL(safe),m=/^\/([a-zA-Z0-9_]{1,15})\/status\/([1-9]\d{0,19})(?:\/.*)?$/.exec(u.pathname);
 return /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)&&m?`https://x.com/${m[1]!.toLowerCase()}/status/${m[2]}`:null;
}
const decode=(value:unknown):Record<string,any>=>{requireFact(typeof value==='string');const v:unknown=JSON.parse(value as string);requireFact(object(v));return v as Record<string,any>;};
const map=(v:unknown):Record<string,string>=>{requireFact(object(v)&&Object.values(v).every(s=>typeof s==='string'));return v as Record<string,string>;};
const identity=(s:SocialInput['sources'][number])=>({id:s.id,url:s.url,kind:s.kind,publishedAt:s.publishedAt,availableAt:s.availableAt,authorId:s.authorId});

/** Acquisition proof only. The caller independently proves bound provenance,
 * accepted fresh SOCIAL qualification and same-target fresh paid DEX inventory.
 * Unsupported or incomplete source profiles return null, never a partial zero.
 */
export function proveEmptyCurrentPosts(acquisition:unknown,input:SocialInput):EmptyCurrentPostsProof|null{
 try{
  const read=socialInputSchema.parse(input);requireFact(object(acquisition)&&same(Object.keys(acquisition).sort(),['attention','social']));
  const attention=map((acquisition as any).attention),social=map((acquisition as any).social),scope=decode(social['social-acquisition-scope']);
  requireFact(scope.method==='free-social-supplements-v2'&&scope.budgetBasis==='social-input');
  const original=socialInputSchema.parse(scope.read);requireFact(same(original.sources.map(identity),read.sources.map(identity))&&same(original.targetPostIds,read.targetPostIds)&&same(original.queries,read.queries)&&original.start===read.start&&original.end===read.end);
  requireFact(Array.isArray(scope.remainingClippedSourceIds)&&scope.remainingClippedSourceIds.length===0&&Array.isArray(scope.clippedSourceIds)&&scope.clippedSourceIds.length===0);
  requireFact(scope.submittedSocialSourceCount===read.sources.length&&scope.baseSocialSourceCount<=read.sources.length&&scope.socialSourceLimit===64&&scope.supplementLimit===8);
  requireFact(read.codes.every(c=>!/(?:CAP|CLIP|BUDGET|SOURCE_CONFLICT|BINDING|FETCH|SEARCH)/.test(c)));
  const start=Date.parse(read.start),end=Date.parse(read.end);requireFact(start<end);
  const byUrl=new Map<string,SocialInput['sources'][number]>(),byId=new Map(read.sources.map(s=>[s.id,s]));requireFact(byId.size===read.sources.length&&new Set(read.targetPostIds).size===read.targetPostIds.length);
  for(const s of read.sources){const key=post(s.url);requireFact((s.kind==='POST')===(key!==null));if(key){requireFact(!byUrl.has(key)&&read.targetPostIds.includes(s.id));byUrl.set(key,s);}}
  requireFact(byUrl.size>0&&read.targetPostIds.length===byUrl.size);for(const id of read.targetPostIds)requireFact(byId.get(id)?.kind==='POST');
  const candidates=new Set<string>(),seeds=new Set<string>(),comparison=new Set<string>(),observed=new Map<string,number>(),requiredPages=new Set<string>(),pageBodies=new Set<string>();let searches=0,fetches=0,aliases=0,comparisonFailures=0;
  const addCandidate=(value:unknown)=>{const key=post(value);if(key)candidates.add(key);return key;};
  // Every retained target is independently matched below to a raw fetched alias.
  for(const key of byUrl.keys())candidates.add(key);
  const http=decode(attention['attention-http-outcomes']);requireFact(http.method==='fetch-http-outcomes-v1'&&Array.isArray(http.outcomes));const statuses=new Map<string,number>();
  for(const row of http.outcomes){requireFact(object(row)&&typeof row.artifactId==='string'&&!statuses.has(row.artifactId)&&Number.isInteger(row.status));statuses.set(row.artifactId,row.status);}
  const searchIds=Object.keys(attention).filter(k=>/^attention-search-\d+$/.test(k)).sort((a,b)=>Number(a.split('-').at(-1))-Number(b.split('-').at(-1)));
  const socialSearchIds=Object.keys(social).filter(k=>/^social-search-\d+$/.test(k)).sort((a,b)=>Number(a.split('-').at(-1))-Number(b.split('-').at(-1)));
  requireFact(searchIds.length>0&&searchIds.length+socialSearchIds.length===read.queries.length);
  const searchResults=new Map<string,any[]>();
  for(const [ids,records,prefix]of [[searchIds,attention,'attention-search-'],[socialSearchIds,social,'social-search-']] as const)for(const[id,i]of ids.map((id,i)=>[id,i] as const)){
   requireFact(id===prefix+(i+1));const v=decode(records[id]);requireFact(Array.isArray(v.results)&&!v.error&&(v.errors===undefined||Array.isArray(v.errors)&&v.errors.length===0));
   requireFact(Number.isInteger(v.total_results)&&v.total_results===v.results.length&&v.page===0&&v.next_page==null&&v.paginationToken==null);requireFact(v.query===read.queries[searches]);if(prefix==='attention-search-')requireFact(statuses.get(id)===200);searches++;searchResults.set(id,v.results);
   for(const r of v.results){requireFact(object(r)&&typeof r.url==='string');const normalized=url(r.url);if(!addCandidate(normalized))requiredPages.add(normalized);}
  }
  // Comparison metadata can exempt a PAGE failure, never a POST candidate.
  for(const[key,raw]of Object.entries(attention))if(/^comparison-lead-\d+-metadata$/.test(key)){
   const v=decode(raw),rows=searchResults.get(v.searchArtifactId);requireFact(rows&&Number.isInteger(v.resultIndex)&&rows[v.resultIndex]?.url===v.url);const normalized=url(v.url);requireFact(v.normalizedUrl===normalized);if(!post(normalized))comparison.add(normalized);
  }
  requireFact(Array.isArray(scope.selection)&&Array.isArray(scope.requestedUrls)&&Array.isArray(scope.requestedUrlsByBatch));
  requireFact(same(scope.requestedUrlsByBatch.flat(),scope.requestedUrls));
  for(const lead of scope.selection){requireFact(object(lead)&&lead.selected===true&&['REUSED','RETAINED'].includes(lead.status));const normalized=url(lead.url);if(lead.reason==='DEX_DISCOVERY')seeds.add(normalized);if(!addCandidate(normalized)&&lead.required===true)requiredPages.add(normalized);}
  for(const requested of scope.requestedUrls)if(!addCandidate(requested))requiredPages.add(url(requested));
  for(const source of original.sources)if(source.kind==='PAGE'&&seeds.has(url(source.url)))for(const match of source.text.matchAll(/\]\((https:\/\/[^\s)]+)\)/g))addCandidate(match[1]);
  const fetchRecords:Array<[string,string,boolean]>=[];
  for(const[key,raw]of Object.entries(attention))if(/^attention-fetch-\d+(?:-retry-\d+)?$/.test(key))fetchRecords.push([key,raw,true]);
  for(const[key,raw]of Object.entries(social))if(/^social-fetch-\d+$/.test(key))fetchRecords.push([key,raw,false]);
  requireFact(fetchRecords.length>0);
  for(const[id,raw,isAttention]of fetchRecords){
   if(isAttention)requireFact(statuses.get(id)===200);const v=decode(raw);requireFact(Array.isArray(v.results)&&Array.isArray(v.errors)&&!v.error);fetches++;
   for(const r of v.results){
    requireFact(object(r)&&typeof r.url==='string'&&typeof r.text==='string');const requested=url(r.url),final=normalizeAttentionFetchUrl(r.final_url??r.url);requireFact(final);if(seeds.has(requested))for(const seedLink of originSeedLinks(requested,Array.isArray(r.links)?r.links:[],'project-context-v2'))addCandidate(seedLink);const key=addCandidate(requested),finalKey=addCandidate(final);
    if(key||finalKey){
     requireFact(key!==null&&key===finalKey&&r.text.trim()&&r.text.length<=120000&&!/^\s*(?:safety check|access denied|forbidden)\s*$/i.test(r.text));
     requireFact(timestamp.safeParse(r.published_date).success);const date=Date.parse(r.published_date),source=byUrl.get(key!);requireFact(source&&source.publishedAt!==null&&Date.parse(source.publishedAt)===date&&date<=Date.parse(source.availableAt)&&date<=end);
     requireFact(original.sources.find(s=>s.id===source!.id)?.text===r.text);requireFact(date<start||date>=end);const prior=observed.get(key!);requireFact(prior===undefined||prior===date);observed.set(key!,date);aliases++;
    }else{requireFact(r.text.trim()&&r.text.length<=120000);pageBodies.add(requested);pageBodies.add(final!);}
   }
   for(const error of v.errors){requireFact(object(error)&&typeof error.url==='string');const normalized=url(error.url);requireFact(!addCandidate(normalized)&&comparison.has(normalized));comparisonFailures++;}
  }
  // No raw POST may disappear through source filtering or canonical dedup.
  requireFact(candidates.size===byUrl.size&&[...candidates].every(key=>byUrl.has(key)&&observed.has(key)));
  requireFact([...requiredPages].every(key=>comparison.has(key)||pageBodies.has(key)));
  const supportedAttention=/^(?:attention-http-outcomes|attention-search-\d+(?:-intent)?|comparison-lead-\d+-metadata|attention-fetch-\d+(?:-retry-\d+)?)$/;
  const supportedSocial=/^(?:social-acquisition-scope|social-search-\d+|social-fetch-\d+|social-http-outcome-\d+)$/;
  requireFact(Object.keys(attention).every(k=>supportedAttention.test(k))&&Object.keys(social).every(k=>supportedSocial.test(k)));
  return{method:'raw-acquisition-empty-current-posts-v1',range:{start:read.start,end:read.end},targetPostIds:[...read.targetPostIds],canonicalPostUrls:[...byUrl.keys()].sort(),currentPostIds:[],rawCounts:{searches,fetches,postCandidates:candidates.size,postAliases:aliases,retainedPosts:byUrl.size,comparisonPageFailures:comparisonFailures},acquisitionHash:createHash('sha256').update(JSON.stringify(acquisition)).digest('hex')};
 }catch{return null;}
}
