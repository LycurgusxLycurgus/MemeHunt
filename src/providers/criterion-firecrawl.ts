import { decodeFirecrawlArtifact } from './firecrawl.js';
import type { AttentionRead } from './attention.js';

/** Reconstruct native fallback results from retained producer bytes and requests. */
export function criterionFirecrawlProjection(read:AttentionRead){
  const pages:Array<{producerArtifactId:string;sourceId:string;requestedUrl:string;finalUrl:string;text:string}>=[];
  let search:{replacesSearchId:string;urls:string[]}|null=null;
  if(read.criterionReviewMethod!=='criterion-review-v1'||!read.sourceBindings)return {pages,search};
  let manifest:{requests:Array<{artifactId:string;urls:string[];failureCode?:string}>};
  try{manifest=JSON.parse(read.rawArtifacts['criterion-fetch-requests']);if(!Array.isArray(manifest.requests))return {pages,search};}catch{return {pages,search};}
  for(const binding of read.sourceBindings){
    if(!/^firecrawl-scrape-[12]$/.test(binding.producerArtifactId)||binding.transform!=='IDENTITY'||binding.resultIndex!==0)continue;
    try{
      const id=binding.producerArtifactId,op=JSON.parse(read.rawArtifacts[id+'-request']);
      if(op.method!=='firecrawl-native-operation-v1'||op.request?.operation!=='SCRAPE'||op.request.url!==binding.requestedUrl||typeof op.httpStatus!=='number')continue;
      const result=decodeFirecrawlArtifact(op.request,read.rawArtifacts[id],op.httpStatus),page=result.pages[0];
      if(result.status!=='OBSERVED'||op.status!==result.status||(op.code??null)!==(result.code??null)||!page)continue;
      const upstream=manifest.requests.filter(request=>/^attention-fetch-\d+$/.test(request.artifactId)&&request.urls.includes(binding.requestedUrl));
      const failed=upstream.some(request=>{try{
        const original=JSON.parse(read.rawArtifacts[request.artifactId]),retry=JSON.parse(read.rawArtifacts[request.artifactId+'-retry-1']??'null'),rows=[...(original.results??[]),...(retry?.results??[])];
        const usable=(row:any)=>row?.url===binding.requestedUrl&&typeof row.text==='string'&&!!row.text.trim()&&!/^\s*(?:safety check|access denied|forbidden)\s*$/i.test(row.text);
        return Array.isArray(original.errors)&&(original.errors.some((error:any)=>error?.url===binding.requestedUrl)||rows.some((row:any)=>row?.url===binding.requestedUrl&&!usable(row)))&&!rows.some(usable);
      }catch{return typeof request.failureCode==='string'&&/^ATT_FETCH_[A-Z0-9_]+$/.test(request.failureCode);}});
      const source=read.sources.find(item=>item.id===binding.sourceId);
      if(!failed||!source||page.url!==binding.requestedUrl||page.text!==source.text||!Number.isFinite(Date.parse(source.availableAt))||Date.parse(source.availableAt)<Date.parse(op.request.at))continue;
      const requested=new URL(page.url),final=new URL(page.finalUrl??page.url),post=(u:URL)=>/^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)&&/^\/[A-Za-z0-9_]+\/status\/\d+(?:\/.*)?$/.test(u.pathname);final.hash='';
      if(post(requested)&&(!post(final)||requested.pathname.split('/')[3]!==final.pathname.split('/')[3]))continue;
      const finalUrl=post(final)?`https://x.com/${final.pathname.split('/')[1].toLowerCase()}/status/${final.pathname.split('/')[3]}`:final.toString();
      const author=post(final)?`${final.hostname.replace(/^www\./,'').replace('twitter.com','x.com')}:${final.pathname.split('/')[1].toLowerCase()}`:null;
      if(source.url!==finalUrl||source.kind!==(post(final)?'POST':'PAGE')||source.authorId!==author||source.publishedAt!==null)continue;
      pages.push({producerArtifactId:id,sourceId:source.id,requestedUrl:page.url,finalUrl,text:page.text});
    }catch{/* An invalid native operation cannot establish a source. */}
  }
  try{
    const op=JSON.parse(read.rawArtifacts['firecrawl-search-1-request']),id=op.replacesSearchId;
    if(op.method!=='firecrawl-native-operation-v1'||op.request?.operation!=='SEARCH'||!/^attention-search-[12]$/.test(id)||typeof op.httpStatus!=='number')throw Error();
    const original=JSON.parse(read.rawArtifacts[`attention-acquisition-${id}-request`]),http=read.rawArtifacts[`attention-acquisition-${id}-http`]?JSON.parse(read.rawArtifacts[`attention-acquisition-${id}-http`]):null,body=read.rawArtifacts[`attention-acquisition-${id}-response`]?JSON.parse(read.rawArtifacts[`attention-acquisition-${id}-response`]):null;
    if(original.query!==op.request.query||!http&&!read.rawArtifacts[`attention-acquisition-${id}-attempt`]||http?.status===200&&Array.isArray(body?.results)&&!body.error&&(!body.errors||Array.isArray(body.errors)&&!body.errors.length))throw Error();
    const result=decodeFirecrawlArtifact(op.request,read.rawArtifacts['firecrawl-search-1'],op.httpStatus);
    if(result.status!==op.status||(result.code??null)!==(op.code??null)||!['OBSERVED','NO_RESULTS'].includes(result.status))throw Error();
    search={replacesSearchId:id,urls:(result.results??[]).map(row=>row.url)};
  }catch{/* Failed or unbound search never replaces the original operation. */}
  return {pages,search};
}
