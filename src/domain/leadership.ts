import type { TokenRef } from './contracts.js';
import { originSeedLinks, normalizeAttentionSearchUrl, reconstructOriginAcquisition, type AttentionRead } from '../providers/attention.js';
import { sourceSpans } from '../providers/source-model.js';
import { verifyOriginAlias } from '../providers/origin-recovery.js';

export type LeadershipRoutes = {
  originRelationship?: {status?:string};
  measuredAttention?: {status?:string;sourceIds?:string[]};
  reviewedPosts?: Array<{sourceId:string;quote:string}>;
};
export type LeadershipGrade = {verdict:'PASS'|'FAIL';basis:'PRIMARY_PUBLIC_SUPPORT'|'MEASURED_ATTENTION'|'EVIDENCE_INADEQUACY';citations:Array<{sourceId:string;quote:string}>};
const names=(text:string,token:TokenRef)=>token.chain==='solana'?text.includes(token.address):text.toLowerCase().includes(token.address.toLowerCase());
const canonical=(url:string)=>normalizeAttentionSearchUrl(url);
const account=(url:string)=>{try{const u=new URL(url),m=/^\/([A-Za-z0-9_]+)(?:\/status\/\d+)?\/?$/.exec(u.pathname);return /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)&&m?'x.com:'+m[1].toLowerCase():null;}catch{return null;}};
// Shared venue/index pages are discovery records, never the originating project.
const platform=(url:string)=>{try{return /(?:^|\.)(?:pump\.fun|dexscreener\.com|dextools\.io|birdeye\.so|solscan\.io|geckoterminal\.com|raydium\.io|meteora\.ag)$/.test(new URL(url).hostname);}catch{return true;}};

/** Structural candidates only. Both actual model passes still judge primary meaning. */
export function primaryLeadershipOptions(read:AttentionRead,token:TokenRef,cutoff:string){
  const acquisition=reconstructOriginAcquisition(read,token),original=new Set(acquisition.sourceIds);
  const fetched:Array<{url:string;final:string;text:string;links:string[]}>=[];
  for(const [id,raw]of Object.entries(read.rawArtifacts))if(/^attention-(?:origin-)?fetch-/.test(id))try{
    const packet=JSON.parse(raw);
    for(const r of packet.results??[])if(typeof r.url==='string'&&typeof r.text==='string'){
      const url=canonical(r.url),final=canonical(r.final_url??r.url);
      if(url&&final)fetched.push({url,final,text:r.text,links:Array.isArray(r.links)?r.links.filter((s:unknown)=>typeof s==='string'):[]});
    }
  }catch{/* Missing acquisition never supplies ownership. */}
  const actual=(s:AttentionRead['sources'][number],requested:string)=>fetched.find(r=>r.url===canonical(requested)&&r.final===canonical(s.url)&&r.text===s.text);
  const roots=new Map<string,string>();
  for(const seed of read.discoveryUrls??[]){
    const source=read.sources.find(s=>actual(s,seed))??read.originRecovery?.aliases.filter(a=>a.originUrl===seed).map(a=>verifyOriginAlias(a,read.sources,read.rawArtifacts)).find(s=>!!s);
    if(!source||!original.has(source.id))continue;
    const isMetadata=seed===read.metadataUri||/\.json(?:[?]|$)/i.test(seed);
    if(isMetadata){
      // Exact-token metadata is itself discovery context, never an endorsement.
      if(seed!==read.metadataUri&&!names(source.text,token))continue;
      for(const match of source.text.matchAll(/https:\/\/[^"\s\\<>]+/g)){const url=canonical(match[0]);if(url&&!platform(url))roots.set(url,source.id);}
    }else if(!platform(seed))roots.set(canonical(seed)!,source.id);
  }
  // A child needs the actual parent Fetch link AND literal parent text, not discoveredFrom alone.
  for(const [root,parentId]of [...roots]){
    const parent=read.sources.find(s=>actual(s,root));if(!parent)continue;
    const response=actual(parent,root)!;
    for(const child of originSeedLinks(root,response.links,read.collectionMethod))if(parent.text.includes(child)&&!platform(child))roots.set(child,parentId);
  }
  return read.sources.flatMap(source=>{
    const age=Date.parse(cutoff)-Date.parse(source.availableAt);
    if(!original.has(source.id)||!Number.isFinite(age)||age<0||age>900000||!names(source.text,token))return [];
    const ownRoot=[...roots.keys()].find(root=>{
      if(actual(source,root))return true;
      const owner=account(root);return source.kind==='POST'&&owner!==null&&owner===source.authorId&&owner===account(source.url)&&!!actual(source,source.url);
    });
    if(!ownRoot||platform(source.url))return [];
    if(source.kind==='POST'&&(!source.publishedAt||!Number.isFinite(Date.parse(source.publishedAt))||Date.parse(source.publishedAt)>Date.parse(read.end)||Date.parse(source.publishedAt)>Date.parse(cutoff)))return [];
    return sourceSpans(source.id,source.text).filter(span=>names(span.text,token)).map(span=>({sourceId:source.id,spanId:span.id,quote:span.text,projectRoot:ownRoot,kind:source.kind}));
  });
}

/** No model-provided popularity/count/authority flag can substitute for these routes. */
export function validateLeadershipPositive(read:AttentionRead,token:TokenRef,cutoff:string,grade:LeadershipGrade,routes:LeadershipRoutes):boolean{
  if(!grade.citations.length||!grade.citations.every(c=>read.sources.some(s=>s.id===c.sourceId&&s.text.includes(c.quote))))return false;
  if(grade.verdict==='FAIL')return grade.basis==='EVIDENCE_INADEQUACY';
  if(grade.basis==='PRIMARY_PUBLIC_SUPPORT')return routes.originRelationship?.status!=='CONTRADICTED'&&grade.citations.every(c=>primaryLeadershipOptions(read,token,cutoff).some(o=>o.sourceId===c.sourceId&&o.quote===c.quote&&(o.kind!=='POST'||routes.reviewedPosts?.some(p=>p.sourceId===c.sourceId&&p.quote===c.quote&&names(p.quote,token)))));
  return grade.basis==='MEASURED_ATTENTION'&&routes.measuredAttention?.status==='SUPPORTED'&&grade.citations.every(c=>routes.measuredAttention?.sourceIds?.includes(c.sourceId)&&routes.reviewedPosts?.some(p=>p.sourceId===c.sourceId&&p.quote===c.quote));
}
