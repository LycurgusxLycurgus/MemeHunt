/** CONSTRUCTED source/model/HTTP protocol receipts over genuine retained native account
 * objects. This is neither actual pair qualification nor a fresh two-RPC acquisition. */
import assert from 'node:assert/strict';
import {GLOBAL_CONFIG_PDA} from '@pump-fun/pump-swap-sdk';
import {a12WitnessSourcesFromAcquisition,type A12ZeroWitnessCapture} from '../src/providers/advisory-exit-capacity-witness.js';
import {a12WitnessSourceFixture,rebindA12WitnessFixture} from './a12-witness-source-fixtures.js';
import {a12ZeroShareNativeFixture,a12ZeroShareHash} from './a12-zero-share-fixtures.js';
import {a29LiveFetcher} from './a29-fixtures.js';

export function a12WitnessIntegrationFixture(rejected=false){
 const native=a12ZeroShareNativeFixture(),members=native.members as Array<{label:string;mint:string;pool:string;quote:string}>,pair=members.slice(0,2),capture=a12WitnessSourceFixture(rejected),cutoff='2026-10-30T11:52:45.000Z';
 const token={chain:'solana' as const,address:pair[0]!.mint};
 capture.target=token;capture.witness={chain:'solana',address:pair[1]!.mint};capture.createdAt='2026-10-30T11:52:42.000Z';capture.acquisition.startedAt='2026-10-30T11:52:39.000Z';
 const batch=capture.acquisition.batches[0]!;batch.availableAt='2026-10-30T11:52:40.000Z';batch.requestedUrls=members.map(m=>'https://constructed.example/a12/'+m.mint);
 batch.raw=JSON.stringify({results:members.map((m,i)=>({url:batch.requestedUrls[i],text:` CONSTRUCTED protocol text only: ${m.mint} shares this test narrative. Canonical pool ${m.pool} quote mint ${m.quote}.\n Full source body retained. `,links:['https://constructed.example/disclosure'],metadata:{construction:'Not actual semantic execution or factual membership evidence'}})),errors:[]});
 const rebuilt=a12WitnessSourcesFromAcquisition(capture.acquisition);capture.sources=rebuilt.sources;capture.acquisition.sourceIds=rebuilt.sourceIds;capture.acquisition.complete=rebuilt.complete;
 capture.routeHints=pair.map((m,i)=>({token:{chain:'solana',address:m.mint},pool:m.pool,quoteMint:m.quote,sourceId:capture.sources[i]!.id,quote:capture.sources[i]!.text})) as A12ZeroWitnessCapture['routeHints'];
 capture.diagnostics={membershipComplete:false,knownLeads:members.slice(2).map((m,i)=>({token:{chain:'solana',address:m.mint},sourceIds:[capture.sources[i+2]!.id],status:m.label==='Dwbz'?'UNRESOLVED_RESEARCH_LEAD':'NOT_ADJUDICATED',rationale:'Disclosed unmeasured lead; no membership, support or capacity is inferred from the constructed pair.'})),priorCatalog:null};
 capture.executions[0].startedAt='2026-10-30T11:52:40.100Z';capture.executions[0].finishedAt='2026-10-30T11:52:41.000Z';capture.executions[1].startedAt='2026-10-30T11:52:41.000Z';capture.executions[1].finishedAt=capture.createdAt;
 const proposal={claims:[],posts:[],competitors:capture.routeHints.map((h,i)=>({id:i===0?'target':'witness',token:h.token,sourceId:h.sourceId,quote:h.quote}))};rebindA12WitnessFixture(capture,proposal);
 const maps=new Map<string,Map<string,unknown>>(),contexts=new Map<string,unknown>();
 for(const record of native.records){assert.equal(Buffer.byteLength(record.raw),record.sourceBytes);assert.equal(a12ZeroShareHash(record.raw),record.sourceHash);const d=JSON.parse(record.raw);maps.set(record.id,new Map(record.request.params[0].map((key:string,i:number)=>[key,d.result.value[i]])));contexts.set(record.id,d.result.context);}
 const baseline=a29LiveFetcher(token.address,cutoff),projections:Array<{kind:string;request:any;raw:string;nativeSourceHash:string}>=[],calls:Array<any>=[];
 const fetcher:typeof fetch=async(input,init)=>{
  if(init?.method==='POST'){
   const request=JSON.parse(String(init.body));calls.push(request);
   if(request.method==='getMultipleAccounts'&&request.params?.[0]?.[0]===GLOBAL_CONFIG_PDA.toBase58()){
    const kind=request.params[0].length===pair.length+2?'discovery':'bank',record=native.records.find((r:any)=>r.id===kind),map=maps.get(kind)!;
    for(const key of request.params[0])assert.ok(map.has(key),'every requested account has a genuine retained preimage');
    const raw=JSON.stringify({jsonrpc:'2.0',id:1,result:{context:contexts.get(kind),value:request.params[0].map((key:string)=>map.get(key))}});projections.push({kind,request,raw,nativeSourceHash:record.sourceHash});return new Response(raw);
   }
  }
  return baseline(input,init);
 };
 return {token,cutoff,capture,native,fetcher,calls,projections,construction:'CONSTRUCTED source/model/request-sized HTTP receipts; exact genuine historical native account objects and contexts'};
}
