import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {GLOBAL_CONFIG_PDA} from '@pump-fun/pump-swap-sdk';
import {a12ProposalPrompt,a12ReviewPrompt,EXIT_CAPACITY_SCOPE,type A12CandidateSet} from '../src/providers/advisory-exit-capacity-custom.js';
import {a29LiveFetcher} from './a29-fixtures.js';

export const a12ZeroShareHash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function a12ZeroShareNativeFixture():any{
 return JSON.parse(readFileSync(new URL('../../tests/fixtures/advisory-a12-zero-share-native.json',import.meta.url),'utf8'));
}
/** Genuine six-lead source preimages, but explicitly CONSTRUCTED catalog, review executions,
 * request-sized response wrappers and test clocks. No actual factual qualification is claimed.
 * The five-member positive test is not a proposed real catalog; the six-member negative keeps NULL.
 */
export function a12ZeroShareFixture(includeAbsent=false){
 const capture=a12ZeroShareNativeFixture(),cutoff='2026-10-30T11:52:45.000Z',members=(capture.members as any[]).filter(m=>includeAbsent||m.label!=='Dwbz');
 const token={chain:'solana' as const,address:capture.members[0].mint};
 const sources=members.map((m,i)=>({id:'constructed-a12-source-'+i,url:'https://example.invalid/constructed-a12/'+m.mint,text:`CONSTRUCTED TEST ONLY: same test narrative representation ${m.mint}; canonical pool ${m.pool}; quote mint ${m.quote}. This is not genuine catalog qualification.`,availableAt:'2026-10-30T11:52:40.000Z'}));
 const p:any={method:'a12-reviewed-candidate-set-v2',token,scope:{description:'Explicitly CONSTRUCTED test catalog, not accepted real-world membership',queries:['CONSTRUCTED test-only token representations'],routeUniverse:EXIT_CAPACITY_SCOPE},sources,acquisition:{complete:true,sourceIds:sources.map(s=>s.id),requests:sources.map(s=>({url:s.url,availableAt:s.availableAt,body:s.text}))},routeHints:members.map((m,i)=>({token:{chain:'solana',address:m.mint},pool:m.pool,quoteMint:m.quote,sourceId:sources[i]!.id,quote:sources[i]!.text}))};
 const proposal={claims:[],posts:[],competitors:members.map((m,i)=>({id:'constructed-a12-candidate-'+i,token:{chain:'solana',address:m.mint},sourceId:sources[i]!.id,quote:sources[i]!.text}))};
 p.proposal={executor:'CODEX_NATIVE',invocationId:'CONSTRUCTED-A12-PROPOSAL-NOT-ACTUAL-EXECUTION',prompt:a12ProposalPrompt(p),response:JSON.stringify(proposal),availableAt:'2026-10-30T11:52:41.000Z'};
 p.review={executor:'CLAUDE_CODE',invocationId:'CONSTRUCTED-A12-REVIEW-NOT-ACTUAL-EXECUTION',prompt:a12ReviewPrompt(p,proposal),response:JSON.stringify({decisions:proposal.competitors.map(c=>({id:c.id,accepted:true,rationale:'Constructed test source, not an actual independent semantic execution'})),candidateSet:{complete:true,rationale:'Complete only within explicitly constructed test catalog'},originRelationship:{status:'UNKNOWN',citations:[],rationale:'Not measured by the test catalog'}}),availableAt:'2026-10-30T11:52:42.000Z'};
 const packet=p as A12CandidateSet,calls:Array<{method:string;params:any[]}>=[],projections:Array<{kind:string;request:unknown;raw:string;nativeSourceHash:string}>=[];
 const maps=new Map<string,Map<string,unknown>>(),contexts=new Map<string,any>();
 for(const record of capture.records){assert.equal(Buffer.byteLength(record.raw),record.sourceBytes);assert.equal(a12ZeroShareHash(record.raw),record.sourceHash);const decoded=JSON.parse(record.raw);maps.set(record.id,new Map(record.request.params[0].map((key:string,i:number)=>[key,decoded.result.value[i]])));contexts.set(record.id,decoded.result.context);}
 const baseline=a29LiveFetcher(token.address,cutoff);
 const fetcher:typeof fetch=async(input,init)=>{
  if(init?.method==='POST'){
   const q=JSON.parse(String(init.body));calls.push(q);
   if(q.method==='getMultipleAccounts'&&q.params?.[0]?.[0]===GLOBAL_CONFIG_PDA.toBase58()){
    const kind=q.params[0].length===members.length+2?'discovery':'bank',source=capture.records.find((r:any)=>r.id===kind),values=maps.get(kind)!;
    for(const key of q.params[0])assert.ok(values.has(key),'requested key has a retained native preimage');
    const raw=JSON.stringify({jsonrpc:'2.0',id:1,result:{context:contexts.get(kind),value:q.params[0].map((key:string)=>values.get(key))}});
    projections.push({kind,request:q,raw,nativeSourceHash:source.sourceHash});return new Response(raw);
   }
  }
  return baseline(input,init);
 };
 return {token,cutoff,packet,capture,fetcher,calls,projections,construction:'CONSTRUCTED catalog/model responses/transport envelopes; exact genuine native account preimages and bank contexts retained'};
}
