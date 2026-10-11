import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyAdvisorySemantic, decodeAdvisorySemantic, validateAdvisorySemanticWire, deriveAdvisorySemantic } from '../src/providers/advisory-semantic.js';
import { socialCopyPairs } from '../src/domain/social.js';
import type { SocialInput, SocialProposal, SocialReview } from '../src/domain/social.js';
import type { TokenRef } from '../src/domain/contracts.js';
import type { PaidVisibility } from '../src/providers/advisory-social.js';
const token:TokenRef={chain:'solana',address:'3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'};
const cutoff='2026-10-11T12:00:00.000Z';
const body=`I am a crypto caller: buy this tomorrow ${token.address}. Price chart: public paid promotion. I hold this token. Origin https://x.com/alpha/status/1 Community https://community.example/posts`;
const envelope=(input:unknown)=>{const value=structuredClone(input) as {sources?:Record<string,unknown>|unknown[]};if(value.sources&&!Array.isArray(value.sources))value.sources=Object.entries(value.sources).map(([id,claim])=>({id,...claim as object}));return JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});};
function fixture(old=false){
 const read:SocialInput={schemaVersion:1,start:'2026-10-11T06:00:00.000Z',end:cutoff,targetPostIds:['p'],identitySourceIds:[],sampleComplete:true,identityComplete:false,previousComparable:true,codes:[],queries:[`"${token.address}"`],sources:[{id:'p',url:'https://x.com/alpha/status/1',text:body,publishedAt:old?'2026-10-10T08:00:00.000Z':'2026-10-11T08:00:00.000Z',authorId:'x.com:alpha',availableAt:cutoff,kind:'POST'}]};
 const citation={sourceId:'p',quote:body};
 const proposal:SocialProposal={posts:[{sourceId:'p',body:citation,bodyComplete:true,role:'ORIGINAL',binding:'EXACT_CONTRACT',bindingProof:[],parentSourceId:null,origin:{key:'https://x.com/alpha/status/1',citation},community:{key:'https://community.example/posts',citation},campaign:null,metrics:{likes:null,replies:null,reposts:null}}],identities:[],accounts:[]};
 const review:SocialReview={decisions:[{id:'post:p',accepted:true,rationale:'Exact retained post.'}],sources:[{sourceId:'p',complete:true,rationale:'Full retained text inspected.'}],pairs:[]};
 const p={sources:{p:{binding:'EXACT_CONTRACT',event:'FORWARD_CALL',category:'CRYPTO_CALLER',topic:'PRICE_CHART',artifact:'NONE',theme:null,paidDisclosure:'DISCLOSED',incentives:['PUBLIC_HOLDINGS','COMPENSATION'],citations:[{sourceId:'p',spanId:'p:span:0'}],rationale:'Explicit forward call, category, price topic and disclosed public holdings.'}},persistence:null};
 const r={sources:{p:{complete:true,accepted:true}},persistence:false};
 const paid:PaidVisibility={method:'dex-paid-visibility-v1',token,quality:'KNOWN',availableAt:cutoff,orders:[],boosts:[],reasonCode:'PAID_VISIBILITY_OBSERVED',scope:'Exact token DEX orders only'};
 return {read,proposal,review,p,r,paid};
}
test('two-pass production adapter preserves identical full corpus and deterministic prompt binding',async()=>{
 const f=fixture(),packets:Record<string,unknown>[]=[];let n=0;
 const fetcher:typeof fetch=async(_url,init)=>{packets.push(JSON.parse(String(init?.body)).contents[0].parts[0].text);return new Response(envelope(n++===0?f.p:f.r),{status:200});};
 const result=await qualifyAdvisorySemantic(f.read,f.proposal,f.review,token,'test-only',fetcher,async()=>{});
 assert.equal(result.code,null);assert.equal(n,2);
 const prompts=packets.map(p=>JSON.parse(String(p)));assert.deepEqual(prompts[0].sources,prompts[1].sources);
 assert.deepEqual(validateAdvisorySemanticWire(f.read,result.rawArtifacts,token),result.data);
 const mutated={...result.rawArtifacts,'advisory-semantic-review-prompt':result.rawArtifacts['advisory-semantic-review-prompt'].replace(body,'changed')};
 assert.throws(()=>validateAdvisorySemanticWire(f.read,mutated,token),/PROMPT_BINDING/);
 assert.equal(Object.keys(result.requests).length,2);
});
test('local derivation enumerates calls, incentives and paid disclosures without model-provided counts',()=>{
 const f=fixture(),semantic=decodeAdvisorySemantic(f.read,envelope(f.p),envelope(f.r),token),metrics=deriveAdvisorySemantic(f.read,f.proposal,f.review,token,cutoff,['receipt'],semantic,f.paid);
 for(const id of ['S07','S08','A21','A22','A23'])assert.equal(metrics.find(m=>m.id===id)!.quality,'KNOWN',id);
 assert.equal((metrics.find(m=>m.id==='A23')!.data as {fraction:string}).fraction,'1');
 assert.equal((metrics.find(m=>m.id==='S07')!.data as {events:unknown[]}).events.length,1);
 assert.equal(metrics.find(m=>m.id==='A06')!.quality,'MISSING');
});
test('empty qualified current corpus permits bounded inventories but keeps ratios undefined',()=>{
 const f=fixture(true),semantic=decodeAdvisorySemantic(f.read,envelope(f.p),envelope(f.r),token),metrics=deriveAdvisorySemantic(f.read,f.proposal,f.review,token,cutoff,['receipt'],semantic,f.paid);
 for(const id of ['S07','S08','A07','A08','S12','A22'])assert.equal(metrics.find(m=>m.id===id)!.quality,'KNOWN',id);
 for(const id of ['A21','A23']){const m=metrics.find(m=>m.id===id)!;assert.equal(m.quality,'MISSING');assert.equal((m.data as {fraction:null}).fraction,null);assert.equal(m.reasonCode,'CLASSIFIED_FRACTION_DENOMINATOR_ZERO');}
});
test('independent reviewer rejection or incomplete source inspection cannot qualify measurements',()=>{
 const f=fixture();for(const flag of ['accepted','complete'] as const){const r=structuredClone(f.r);r.sources.p[flag]=false;const semantic=decodeAdvisorySemantic(f.read,envelope(f.p),envelope(r),token);assert.ok(deriveAdvisorySemantic(f.read,f.proposal,f.review,token,cutoff,[],semantic,f.paid).every(m=>m.quality==='MISSING'));}
});
test('literal citation validation rejects fabricated or cross-source selectors',()=>{
 const f=fixture();for(const citation of [{sourceId:'other',spanId:'p:span:0'},{sourceId:'p',spanId:'missing'}]){const p=structuredClone(f.p);p.sources.p.citations=[citation];assert.throws(()=>decodeAdvisorySemantic(f.read,envelope(p),envelope(f.r),token),/CITATION/);}
});
test('source keys, token binding and current corpus are exact',()=>{
 const f=fixture();assert.throws(()=>decodeAdvisorySemantic(f.read,envelope({sources:{},persistence:null}),envelope(f.r),token));
 assert.throws(()=>decodeAdvisorySemantic(f.read,envelope(f.p),envelope(f.r),{...token,address:'11111111111111111111111111111111'}),/BINDING/);
 const semantic=decodeAdvisorySemantic(f.read,envelope(f.p),envelope(f.r),token);assert.ok(deriveAdvisorySemantic(f.read,f.proposal,f.review,token,'2026-10-11T11:00:00.000Z',[],semantic,f.paid).every(m=>m.quality==='MISSING'));
});
test('model transport failure is retained without credential-bearing exception messages',async()=>{
 const f=fixture(),result=await qualifyAdvisorySemantic(f.read,f.proposal,f.review,token,'secret-test-only',async()=>{throw new Error('secret-test-only');},async()=>{});
 assert.equal(result.data,null);assert.equal(result.code,'ADV_SEMANTIC_QUALIFICATION_FAILED');assert.ok(Object.keys(result.rawArtifacts).some(id=>id.includes('transport')));assert.ok(!JSON.stringify(result).includes('secret-test-only'));
});
test('unknown persistence mechanisms do not become a known hypothesis after acceptance',()=>{
 const f=fixture(),p={...f.p,persistence:{style:'UNKNOWN',mechanism:'UNKNOWN',horizonHours:null,renewal:'No renewal evidence observed.',expiry:'No expiry evidence observed.',citations:[{sourceId:'p',spanId:'p:span:0'}],rationale:'Cannot infer persistence from a token mention.'}},r={...f.r,persistence:true};
 const semantic=decodeAdvisorySemantic(f.read,envelope(p),envelope(r),token);assert.equal(deriveAdvisorySemantic(f.read,f.proposal,f.review,token,cutoff,[],semantic,f.paid).find(m=>m.id==='A06')!.quality,'MISSING');
});

function artifactFixture(sameAuthor:boolean,campaign:boolean){
 const f=fixture(),key='https://campaign.example/common';
 const second=structuredClone(f.read.sources[0]!);second.id='q';second.authorId=sameAuthor?'x.com:alpha':'x.com:beta';second.url=`https://x.com/${sameAuthor?'alpha':'beta'}/status/2`;
 f.read.sources[0]!.text+=` I created original sculpture A. Campaign ${key}`;
 second.text=body.replace('https://x.com/alpha/status/1',second.url)+` I created original sculpture B. Campaign ${key}`;
 f.read.sources.push(second);f.read.targetPostIds.push('q');
 f.proposal.posts[0]!.body.quote=f.read.sources[0]!.text;f.proposal.posts[0]!.origin!.citation.quote=f.read.sources[0]!.text;f.proposal.posts[0]!.community!.citation.quote=f.read.sources[0]!.text;
 const post=structuredClone(f.proposal.posts[0]!);post.sourceId='q';post.body={sourceId:'q',quote:second.text};post.origin={key:second.url,citation:post.body};post.community={key:'https://community.example/posts',citation:post.body};f.proposal.posts.push(post);
 if(campaign)for(const p of f.proposal.posts)p.campaign={key,citation:p.body};
 f.review.decisions.push({id:'post:q',accepted:true,rationale:'Both original artifacts observed.'});f.review.sources.push({sourceId:'q',complete:true,rationale:'Full text inspected.'});
 // Similar text is reviewed as distinct artifact commentary, not copied endorsement.
 f.review.pairs=socialCopyPairs(f.proposal,token).map(pair=>({id:pair.id,relation:'DISTINCT_COMMENTARY' as const,rationale:'Distinct explicitly created original sculpture artifacts.'}));
 const p={...f.p,sources:{p:{...f.p.sources.p,artifact:'ORIGINAL',theme:'sculpture'},q:{...f.p.sources.p,artifact:'ORIGINAL',theme:'sculpture',citations:[{sourceId:'q',spanId:'q:span:0'}]}}};
 const r={sources:{p:{complete:true,accepted:true},q:{complete:true,accepted:true}},persistence:false};
 return {...f,p,r};
}
test('multiple original artifacts by one public author count one creator account group',()=>{
 const f=artifactFixture(true,false),semantic=decodeAdvisorySemantic(f.read,envelope(f.p),envelope(f.r),token),m=deriveAdvisorySemantic(f.read,f.proposal,f.review,token,cutoff,[],semantic,f.paid).find(m=>m.id==='S12')!;
 assert.equal(m.quality,'KNOWN');assert.equal((m.data as {independentCreatorGroups:number}).independentCreatorGroups,1);assert.equal((m.data as {originalArtifacts:unknown[]}).originalArtifacts.length,2);
});
test('distinct public authors with the same reviewed campaign collapse into one creator group',()=>{
 const f=artifactFixture(false,true),semantic=decodeAdvisorySemantic(f.read,envelope(f.p),envelope(f.r),token),m=deriveAdvisorySemantic(f.read,f.proposal,f.review,token,cutoff,[],semantic,f.paid).find(m=>m.id==='S12')!;
 assert.equal(m.quality,'KNOWN');assert.equal((m.data as {independentCreatorGroups:number}).independentCreatorGroups,1);assert.equal((m.data as {observedCreatorAccounts:string[]}).observedCreatorAccounts.length,2);
});
test('missing required creator attribution or reviewed lineage keeps creator measurements missing',()=>{
 for(const missing of ['author','lineage']){const f=artifactFixture(true,false);if(missing==='author')f.read.sources[1]!.authorId=null;else f.proposal.posts[1]!.origin=null;const semantic=decodeAdvisorySemantic(f.read,envelope(f.p),envelope(f.r),token),m=deriveAdvisorySemantic(f.read,f.proposal,f.review,token,cutoff,[],semantic,f.paid).find(m=>m.id==='S12')!;assert.equal(m.quality,'MISSING');}
});
test('hosted schema stays compact for 32 sources while local validation enforces exact membership',async()=>{
 const f=fixture(),read={...f.read,sources:Array.from({length:32},(_,i)=>({...f.read.sources[0]!,id:`source-${i}`})),targetPostIds:Array.from({length:32},(_,i)=>`source-${i}`)};
 const p={sources:read.sources.map(source=>({...f.p.sources.p,id:source.id,citations:[{sourceId:source.id,spanId:`${source.id}:span:0`}]})),persistence:null};
 const r={sources:read.sources.map(source=>({id:source.id,complete:true,accepted:true})),persistence:false};let n=0;const lengths:number[]=[];
 const fetcher:typeof fetch=async(_url,init)=>{const payload=JSON.parse(String(init?.body));lengths.push(JSON.stringify(payload.generationConfig.responseJsonSchema).length);return new Response(envelope(n++===0?p:r),{status:200});};
 const result=await qualifyAdvisorySemantic(read,null,null,token,'test-only',fetcher,async()=>{});
 assert.equal(result.code,null);assert.equal(result.data!.sources.length,32);assert.ok(lengths.every(length=>length<6000));
 const duplicated=structuredClone(p);duplicated.sources[31]=duplicated.sources[0]!;assert.throws(()=>decodeAdvisorySemantic(read,envelope(duplicated),envelope(r),token),/SOURCE_MEMBERSHIP/);
 const extra=structuredClone(r);extra.sources[0]!.id='not-in-corpus';assert.throws(()=>decodeAdvisorySemantic(read,envelope(p),envelope(extra),token),/SOURCE_MEMBERSHIP/);
});
