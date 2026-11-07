import { z } from 'zod';
import { tokenRefSchema, type TokenRef } from './contracts.js';

export const acquisitionPurposeMethod = 'acquisition-purpose-v1' as const;
export const evidencePurposeSchema = z.enum(['BODY_FACT','FACTUAL_CONFLICT','BOUNDED_MEASUREMENT','BOUNDED_SUPPORT','UNRESOLVED_CONTEXT']);
export type EvidencePurpose = z.infer<typeof evidencePurposeSchema>;
export const targetStateSchema = z.enum(['READ','TARGET_BLOCKED','UNREAD','PROVIDER_FAILED','UNATTEMPTED']);
export type TargetState = z.infer<typeof targetStateSchema>;
const nonempty = z.string().min(1);
export const acquisitionAttemptSchema = z.object({artifactId:nonempty,resultIndex:z.number().int().nonnegative().nullable(),provider:nonempty,rung:nonempty,kind:z.enum(['READ','TARGET_FAILURE','PROVIDER_FAILURE','UNREAD']),code:z.string().nullable()}).strict();
export const acquisitionFactsSchema = z.object({
  group:z.enum(['PUBLIC_ENTRY','SOCIAL_ENTRY']),token:tokenRefSchema,availableAt:z.iso.datetime({offset:true}),
  searches:z.array(z.object({id:nonempty,required:z.boolean(),outcome:z.enum(['RESULTS','NO_RESULTS','FAILED','MISSING']),artifactId:nonempty.nullable()}).strict()),
  targets:z.array(z.object({requestedUrl:nonempty,necessary:z.boolean(),sourceId:nonempty.nullable(),finalUrl:nonempty.nullable(),recoveredBySourceId:nonempty.nullable(),plannedRungs:z.array(nonempty),attempts:z.array(acquisitionAttemptSchema),budgetExhausted:z.boolean(),planKnown:z.boolean()}).strict()),
  samples:z.array(z.object({id:nonempty,searchIds:z.array(nonempty),candidateUrls:z.array(nonempty),dropped:z.boolean()}).strict()),
  fresh:z.boolean(),aborted:z.boolean(),
}).strict();
export type AcquisitionFacts = z.infer<typeof acquisitionFactsSchema>;
export const acquisitionProjectionSchema=z.object({method:z.literal(acquisitionPurposeMethod),group:z.enum(['PUBLIC_ENTRY','SOCIAL_ENTRY']),token:tokenRefSchema,availableAt:z.iso.datetime({offset:true}),accounted:z.boolean(),gaps:z.array(z.string()),searches:z.array(z.object({id:nonempty,outcome:z.enum(['RESULTS','NO_RESULTS','FAILED','MISSING'])}).strict()),samples:z.array(z.object({id:nonempty,sampleComplete:z.boolean(),searchIds:z.array(nonempty),candidateUrls:z.array(nonempty),gaps:z.array(z.string())}).strict()),targets:z.array(z.object({requestedUrl:nonempty,state:targetStateSchema,finalUrl:nonempty.nullable(),sourceId:nonempty.nullable(),recoveredBySourceId:nonempty.nullable(),attempts:z.array(acquisitionAttemptSchema)}).strict())}).strict();
export const purposeReceiptSchema=z.object({text:z.string(),facts:z.array(z.object({id:nonempty,start:z.number().int().nonnegative(),end:z.number().int().nonnegative(),purposes:z.array(evidencePurposeSchema)}).strict())}).strict();
export type AcquisitionProjection = {
  method:typeof acquisitionPurposeMethod; group:AcquisitionFacts['group']; token:TokenRef; availableAt:string; accounted:boolean; gaps:string[];
  searches:Array<{id:string;outcome:AcquisitionFacts['searches'][number]['outcome']}>;
  samples:Array<{id:string;sampleComplete:boolean;searchIds:string[];candidateUrls:string[];gaps:string[]}>;
  targets:Array<{requestedUrl:string;state:TargetState;finalUrl:string|null;sourceId:string|null;recoveredBySourceId:string|null;attempts:Array<z.infer<typeof acquisitionAttemptSchema>>}>;
};
const unique = (items:string[]) => new Set(items).size === items.length;
const successful = (outcome:string) => outcome === 'RESULTS' || outcome === 'NO_RESULTS';

export function projectAcquisition(input:AcquisitionFacts):AcquisitionProjection {
  const parsed=acquisitionFactsSchema.safeParse(input);
  if(!parsed.success) throw Error('acquisitionfactsinvalid');
  const f=parsed.data;
  if(!unique(f.searches.map(x=>x.id)) || !unique(f.targets.map(x=>x.requestedUrl)) || !unique(f.samples.map(x=>x.id)) ||
    f.targets.some(x=>!unique(x.plannedRungs) || !unique(x.attempts.map(a=>JSON.stringify([a.artifactId,a.resultIndex])))) ||
    f.samples.some(x=>!unique(x.searchIds) || !unique(x.candidateUrls))) throw Error('acquisitionfactsinvalid');
  const state=(t:AcquisitionFacts['targets'][number]):TargetState=>{
    if(t.recoveredBySourceId || (t.sourceId && t.attempts.some(a=>a.kind==='READ'))) return 'READ';
    if(!t.planKnown) return 'UNREAD';
    if(t.attempts.at(-1)?.kind==='PROVIDER_FAILURE') return 'PROVIDER_FAILED';
    if(t.attempts.some(a=>a.kind==='TARGET_FAILURE') && t.plannedRungs.length>0 && t.plannedRungs.every(r=>t.attempts.some(a=>a.rung===r && a.kind==='TARGET_FAILURE') || (t.budgetExhausted && !t.attempts.some(a=>a.rung===r)))) return 'TARGET_BLOCKED';
    return t.attempts.length===0 ? 'UNATTEMPTED' : 'UNREAD';
  };
  const targets=f.targets.map(t=>({requestedUrl:t.requestedUrl,state:state(t),finalUrl:t.finalUrl,sourceId:t.sourceId,recoveredBySourceId:t.recoveredBySourceId,attempts:t.attempts}));
  const gaps:string[]=[];
  if(!f.fresh) gaps.push('STALE');
  if(f.aborted) gaps.push('ABORTED');
  for(const s of f.searches) if(s.required && (!successful(s.outcome) || !s.artifactId)) gaps.push(`SEARCH:${s.id}:${s.outcome}`);
  for(const t of f.targets) {const projected=targets.find(x=>x.requestedUrl===t.requestedUrl)!; if(t.necessary && projected.state!=='READ' && projected.state!=='TARGET_BLOCKED') gaps.push(`TARGET:${t.requestedUrl}:${projected.state}`);}
  const samples=f.samples.map(s=>{
    const sampleGaps:string[]=[];
    if(!f.fresh) sampleGaps.push('STALE');
    if(f.aborted) sampleGaps.push('ABORTED');
    if(s.searchIds.length===0) sampleGaps.push('NO_SEARCHES');
    if(s.dropped) sampleGaps.push('DROPPED');
    for(const id of s.searchIds) {const search=f.searches.find(x=>x.id===id); if(!search || !successful(search.outcome) || !search.artifactId) sampleGaps.push(`SEARCH:${id}:${search?.outcome ?? 'MISSING'}`);}
    for(const url of s.candidateUrls) {const target=targets.find(x=>x.requestedUrl===url); if(!target || target.state!=='READ') sampleGaps.push(`TARGET:${url}:${target?.state ?? 'MISSING'}`);}
    return {id:s.id,sampleComplete:sampleGaps.length===0,searchIds:s.searchIds,candidateUrls:s.candidateUrls,gaps:sampleGaps};
  });
  return {method:acquisitionPurposeMethod,group:f.group,token:f.token,availableAt:f.availableAt,accounted:gaps.length===0,gaps,searches:f.searches.map(({id,outcome})=>({id,outcome})),samples,targets};
}

export type PurposeReceiptFact={id:string;start:number;end:number;purposes:EvidencePurpose[]};
export type PurposeReceipt={text:string;facts:PurposeReceiptFact[]};
export function renderPurposeReceipt(p:AcquisitionProjection):PurposeReceipt {
  let text=''; const facts:PurposeReceiptFact[]=[];
  const line=(id:string,value:unknown,purposes:EvidencePurpose[])=>{if(text) text+='\n'; const start=text.length; text+=JSON.stringify(value); facts.push({id,start,end:text.length,purposes:['UNRESOLVED_CONTEXT',...purposes]});};
  line('header',{method:p.method,group:p.group,token:p.token,availableAt:p.availableAt,meaning:'bounded acquisition observations'},[]);
  for(const s of p.searches) line(`search:${s.id}`,{search:s},p.accounted && s.outcome==='NO_RESULTS'?['BOUNDED_SUPPORT']:[]);
  for(const t of p.targets) line(`target:${t.requestedUrl}`,{target:t},p.accounted && t.state==='TARGET_BLOCKED'?['BOUNDED_SUPPORT']:[]);
  for(const s of p.samples) line(`sample:${s.id}`,{sample:s},s.sampleComplete?['BOUNDED_MEASUREMENT']:[]);
  line('scope',{accounted:p.accounted,gaps:p.gaps},[]);
  return {text,facts};
}
/** Exact, fact-local citation chunks; the underlying receipt remains unchanged. */
export function purposeReceiptChunks(p:AcquisitionProjection):Array<{factId:string;start:number;end:number;text:string;purposes:EvidencePurpose[]}> {
  const receipt=renderPurposeReceipt(p),chunks:Array<{factId:string;start:number;end:number;text:string;purposes:EvidencePurpose[]}>=[];
  for(const fact of receipt.facts){let start=fact.start;while(start<fact.end){let end=Math.min(start+1000,fact.end);if(end<fact.end&&fact.end-end<8)end=fact.end-8;if(end<fact.end&&/[\uD800-\uDBFF]/.test(receipt.text[end-1]!)&&/[\uDC00-\uDFFF]/.test(receipt.text[end]!))end--;chunks.push({factId:fact.id,start,end,text:receipt.text.slice(start,end),purposes:fact.purposes});start=end;}}
  return chunks;
}
export type PurposeReceiptRef={quote:string;sourceId:string;start?:number;end?:number};
export function receiptEligible(p:AcquisitionProjection,ref:PurposeReceiptRef,purpose:EvidencePurpose,token:TokenRef,cutoff:string):boolean {
  if(purpose==='BODY_FACT'||purpose==='FACTUAL_CONFLICT'||p.method!==acquisitionPurposeMethod || ref.sourceId!==(p.group==='PUBLIC_ENTRY'?'acquisition-attention-scope':'acquisition-social-scope')) return false;
  if(p.token.chain!==token.chain || (token.chain==='solana'?p.token.address!==token.address:p.token.address.toLowerCase()!==token.address.toLowerCase())) return false;
  const age=Date.parse(cutoff)-Date.parse(p.availableAt);
  if(!Number.isFinite(age)||age<0||age>900000||!ref.quote || !ref.quote.trim()) return false;
  const receipt=renderPurposeReceipt(p);
  const allowed=(start:number,end:number)=>{
    if(start<0||end>receipt.text.length||end<=start||receipt.text.slice(start,end)!==ref.quote) return false;
    const overlapping=receipt.facts.filter(f=>f.start<end&&f.end>start);
    if(!overlapping.length||overlapping.some(f=>!f.purposes.includes(purpose))) return false;
    for(let i=start;i<end;i++) if(!/\s/u.test(receipt.text[i]!) && !overlapping.some(f=>i>=f.start&&i<f.end)) return false;
    return true;
  };
  if(ref.start!==undefined || ref.end!==undefined) return Number.isInteger(ref.start)&&Number.isInteger(ref.end)&&allowed(ref.start!,ref.end!);
  const matches:number[]=[]; for(let i=receipt.text.indexOf(ref.quote);i!==-1;i=receipt.text.indexOf(ref.quote,i+1)) matches.push(i);
  return matches.length>0 && matches.every(i=>allowed(i,i+ref.quote.length));
}
export function offeredReceiptRefs(p:AcquisitionProjection,purpose:EvidencePurpose,token:TokenRef,cutoff:string):Array<{sourceId:string;quote:string;start:number;end:number;factId:string}> {
  const sourceId=p.group==='PUBLIC_ENTRY'?'acquisition-attention-scope':'acquisition-social-scope';
  return purposeReceiptChunks(p).map(f=>({sourceId,quote:f.text,start:f.start,end:f.end,factId:f.factId})).filter(ref=>receiptEligible(p,ref,purpose,token,cutoff));
}
export function criterionPurpose(outcome:'SUPPORTED'|'CONTRADICTED'|'INSUFFICIENT'|null,id:string):EvidencePurpose {
  if(outcome===null) return 'UNRESOLVED_CONTEXT';
  if(outcome==='INSUFFICIENT') return 'BOUNDED_SUPPORT';
  if(['ATT-01','ATT-02','ADV-03'].includes(id)) return 'BOUNDED_MEASUREMENT';
  return outcome==='SUPPORTED'?'BODY_FACT':'FACTUAL_CONFLICT';
}
export function socialPurpose(verdict:'SUPPORTED'|'CONTRADICTED'|'UNRESOLVED',negativeBasis?:'FACTUAL_COUNTEREVIDENCE'|'PUBLIC_SUPPORT_INADEQUATE'):EvidencePurpose {
  return verdict==='UNRESOLVED'?'UNRESOLVED_CONTEXT':verdict==='SUPPORTED'?'BODY_FACT':negativeBasis==='PUBLIC_SUPPORT_INADEQUATE'?'BOUNDED_SUPPORT':'FACTUAL_CONFLICT';
}
export function sharedPurpose(disposition:'CLEAR'|'CONFLICT'|'UNCLEAR',support:'SUPPORTED'|'INSUFFICIENT'|'UNRESOLVED'|undefined,basis:'BODY_FACT'|'BOUNDED_SUPPORT_DECISION'|'BOUNDED_MEASUREMENT'|undefined):EvidencePurpose {
  if(disposition==='CONFLICT') return 'FACTUAL_CONFLICT';
  if(disposition==='UNCLEAR'||support==='UNRESOLVED') return 'UNRESOLVED_CONTEXT';
  return basis==='BOUNDED_SUPPORT_DECISION'?'BOUNDED_SUPPORT':basis==='BOUNDED_MEASUREMENT'?'BOUNDED_MEASUREMENT':'BODY_FACT';
}
