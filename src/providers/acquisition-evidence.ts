import { z } from 'zod';
import { tokenRefSchema, type TokenRef } from '../domain/contracts.js';

export const acquisitionEvidenceMethod='bounded-acquisition-receipts-v1' as const;
const time=z.iso.datetime({offset:true});
export const acquisitionEvidenceSchema=z.object({
 id:z.string().regex(/^acquisition-(?:attention|social)-scope$/),kind:z.literal('ACQUISITION_RECEIPT'),token:tokenRefSchema,
 operation:z.literal('ACQUISITION_SCOPE'),artifactIds:z.array(z.string()).min(1).max(200),availableAt:time,text:z.string().min(8).max(120000),
}).strict();
export const acquisitionScopeSchema=z.object({method:z.literal(acquisitionEvidenceMethod),token:tokenRefSchema,group:z.enum(['PUBLIC_ENTRY','SOCIAL_ENTRY']),start:time,end:time,complete:z.boolean(),requiredEvidenceIds:z.array(z.string()).max(2),sourceIds:z.array(z.string()).max(64),blockers:z.array(z.string()).max(200),evidence:z.array(acquisitionEvidenceSchema).max(2)}).strict();
export type AcquisitionEvidence=z.infer<typeof acquisitionEvidenceSchema>;
export type AcquisitionScope=z.infer<typeof acquisitionScopeSchema>;
export type AcquisitionSearch={id:string;query:string;purpose:'EXACT_TOKEN'|'SOCIAL'|'COMPARISON'|'RECOVERY';artifactId:string;status:number;availableAt:string;required:boolean};
export type AcquisitionLedger={method:typeof acquisitionEvidenceMethod;token:TokenRef;start:string;end:string;searches:AcquisitionSearch[]};
export const acquisitionLedgerSchema=z.object({method:z.literal(acquisitionEvidenceMethod),token:tokenRefSchema,start:time,end:time,searches:z.array(z.object({id:z.string().min(1),query:z.string().min(1).max(2000),purpose:z.enum(['EXACT_TOKEN','SOCIAL','COMPARISON','RECOVERY']),artifactId:z.string().min(1),status:z.number().int().min(100).max(599),availableAt:time,required:z.boolean()}).strict()).max(40)}).strict();
export const sameAcquisitionToken=(a:TokenRef,b:TokenRef)=>a.chain===b.chain&&(a.chain==='solana'?a.address===b.address:a.address.toLowerCase()===b.address.toLowerCase());
type ScopeInput={token:TokenRef;group:AcquisitionScope['group'];cutoff:string;start:string;end:string;availableAt:string;ledgerId:string;rawArtifacts:Record<string,string>;sourceIds:string[];expectedQueries:Array<{query:string;purpose:AcquisitionSearch['purpose']}>;blockers:string[];artifactIds?:string[]};

/** One compact receipt describes actual operations, never project content or inferred activity. */
export function buildAcquisitionScope(input:ScopeInput):AcquisitionScope{
 const blockers=[...input.blockers],links=[input.ledgerId,...(input.artifactIds??[])],searches:Array<Record<string,unknown>>=[];
 let ledger:AcquisitionLedger|undefined;
 try{ledger=acquisitionLedgerSchema.parse(JSON.parse(input.rawArtifacts[input.ledgerId]));}catch{blockers.push('ACQUISITION_LEDGER_MISSING_OR_INVALID');}
 if(ledger&&(!sameAcquisitionToken(ledger.token,input.token)||ledger.start!==input.start||ledger.end!==input.end))blockers.push('ACQUISITION_SCOPE_BINDING_INVALID');
 const records=ledger?.searches??[],ids=records.map(r=>r.id);
 if(new Set(ids).size!==ids.length||new Set(input.sourceIds).size!==input.sourceIds.length)blockers.push('ACQUISITION_DUPLICATE_ID');
 for(const expected of input.expectedQueries)if(!records.some(r=>r.required&&r.query===expected.query&&r.purpose===expected.purpose))blockers.push('ACQUISITION_REQUIRED_QUERY_MISSING');
 if(!input.expectedQueries.length)blockers.push('ACQUISITION_REQUIRED_QUERY_MISSING');
 for(const record of records){
  links.push(record.artifactId);
  const age=Date.parse(input.cutoff)-Date.parse(record.availableAt);
  if(!Number.isFinite(age)||age<0||age>900000)blockers.push('ACQUISITION_RECEIPT_STALE');
  if(['EXACT_TOKEN','SOCIAL'].includes(record.purpose)&&!record.query.includes(input.token.address))blockers.push('ACQUISITION_QUERY_BINDING_INVALID');
  let value:any;try{value=JSON.parse(input.rawArtifacts[record.artifactId]);}catch{if(record.required)blockers.push('ACQUISITION_RESPONSE_MISSING');}
  const valid=record.status>=200&&record.status<300&&value&&Array.isArray(value.results)&&!value.error&&(value.errors===undefined||Array.isArray(value.errors)&&value.errors.length===0)&&value.results.every((r:any)=>r&&typeof r.url==='string');
  if(record.required&&!valid)blockers.push('ACQUISITION_SEARCH_INCOMPLETE');
  searches.push({id:record.id,query:record.query,purpose:record.purpose,status:record.status,availableAt:record.availableAt,required:record.required,outcome:valid?(value.results.length?'RESULTS':'NO_RESULTS'):'INCOMPLETE',resultCount:valid?value.results.length:null,artifactId:record.artifactId});
 }
 const at=input.availableAt,age=Date.parse(input.cutoff)-Date.parse(at);
 if(!Number.isFinite(age)||age<0||age>900000)blockers.push('ACQUISITION_RECEIPT_STALE');
 if(links.some(id=>typeof input.rawArtifacts[id]!=='string'))blockers.push('ACQUISITION_LINK_MISSING');
 if(input.sourceIds.some(id=>/^acquisition-(?:attention|social)-scope$/.test(id)))blockers.push('ACQUISITION_ID_COLLISION');
 const operational=blockers.find(code=>/TIMEOUT|TRANSPORT|NETWORK_ACCESS_DENIED|DNS_ERROR|HTTP_(?:408|429|5\d\d)|COLLECTION_BUDGET|RUN_ABORTED/.test(code));
 if(operational)blockers.unshift(operational);
 const complete=blockers.length===0,artifactIds=[...new Set(links.filter(id=>typeof input.rawArtifacts[id]==='string'))].sort(),id=input.group==='PUBLIC_ENTRY'?'acquisition-attention-scope':'acquisition-social-scope';
 if(!artifactIds.length)return acquisitionScopeSchema.parse({method:acquisitionEvidenceMethod,token:input.token,group:input.group,start:input.start,end:input.end,complete:false,requiredEvidenceIds:[],sourceIds:input.sourceIds,blockers:[...new Set(blockers)],evidence:[]});
 const text=JSON.stringify({method:acquisitionEvidenceMethod,kind:'ACQUISITION_RECEIPT',token:input.token,group:input.group,start:input.start,end:input.end,complete,meaning:'Retained bounded acquisition operations only; not project assertions, global absence, participant counts, authenticity or factual counterevidence.',sourceIds:input.sourceIds,searches,blockers:[...new Set(blockers)],artifactIds});
 const evidence:AcquisitionEvidence={id,kind:'ACQUISITION_RECEIPT',token:input.token,operation:'ACQUISITION_SCOPE',artifactIds,availableAt:at,text};
 return acquisitionScopeSchema.parse({method:acquisitionEvidenceMethod,token:input.token,group:input.group,start:input.start,end:input.end,complete,requiredEvidenceIds:[id],sourceIds:input.sourceIds,blockers:[...new Set(blockers)],evidence:[evidence]});
}

export function acquisitionCitationAllowed(scope:AcquisitionScope|undefined,ref:{sourceId:string;quote:string},token:TokenRef,cutoff:string):boolean{
 if(!scope?.complete||!sameAcquisitionToken(scope.token,token))return false;
 const record=scope.evidence.find(e=>e.id===ref.sourceId),age=record?Date.parse(cutoff)-Date.parse(record.availableAt):NaN;
 return !!record&&scope.requiredEvidenceIds.includes(record.id)&&sameAcquisitionToken(record.token,token)&&Number.isFinite(age)&&age>=0&&age<=900000&&record.text.includes(ref.quote);
}
