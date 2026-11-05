import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {derivePublicSourceIncentives,PUBLIC_SOURCE_INCENTIVES_METHOD,type PublicSourceIncentivesBodyContext} from '../src/providers/advisory-public-incentives.js';
import {decodeAdvisorySemanticValues,type AdvisorySemantic} from '../src/providers/advisory-semantic.js';
import type {SocialInput} from '../src/domain/social.js';
import type {TokenRef} from '../src/domain/contracts.js';
import type {AdvisoryMetric} from '../src/domain/advisory-contracts.js';

type Frame={token:TokenRef;cutoff:string;read:SocialInput;proposal:unknown;review:unknown;legacyPost:AdvisoryMetric;acquisition:any};
function fixture(which:'current'|'oldRejected'='current'){
 const f=(JSON.parse(readFileSync(new URL('../../tests/fixtures/advisory-public-incentives-actual.json',import.meta.url),'utf8')) as Record<string,Frame>)[which]!;
 return{...f,semantic:decodeAdvisorySemanticValues(f.read,f.proposal,f.review,f.token,'v4')};
}
type Fixture=ReturnType<typeof fixture>;
const scope=(f:Fixture)=>JSON.parse(f.acquisition.social['social-acquisition-scope']);
const editScope=(f:Fixture,edit:(v:any)=>void)=>{const v=scope(f);edit(v);f.acquisition.social['social-acquisition-scope']=JSON.stringify(v);};
const editAttention=(f:Fixture,id:string,edit:(v:any)=>void)=>{const v=JSON.parse(f.acquisition.attention[id]);edit(v);f.acquisition.attention[id]=JSON.stringify(v);};
const page=(f:Fixture)=>f.read.sources.find(s=>s.kind==='PAGE')!;
const pageClaim=(f:Fixture)=>f.semantic.sources.find(s=>s.id===page(f).id)!;
const derive=(f:Fixture,semantic:AdvisorySemantic|null=f.semantic,legacy:AdvisoryMetric|undefined=f.legacyPost,bodyContext?:PublicSourceIncentivesBodyContext)=>derivePublicSourceIncentives(f.read,semantic,f.token,f.cutoff,['advisory-executor-capture'],legacy,f.acquisition,bodyContext);
const data=(m:AdvisoryMetric)=>m.data as {method:string;scope:any;disclosures:any[]|null;currentPostMeasurement:any;hiddenCompensation:null;underlyingAdvisoryCorpusAccepted:boolean;primarySourceAcquisition:any;interpretation:any;excludedUnrelatedSourceIds:string[]|null};

test('genuine accepted corpus retains the PAGE affiliation with original observedAt and unknown publication/author',()=>{
 const f=fixture(),before=JSON.stringify(f),m=derive(f),d=data(m);assert.equal(m.quality,'KNOWN');assert.equal(m.reasonCode,'PUBLIC_SOURCE_INCENTIVES_OBSERVED');assert.equal(d.method,PUBLIC_SOURCE_INCENTIVES_METHOD);
 assert.equal(d.disclosures!.length,1);const item=d.disclosures![0],source=page(f);assert.equal(item.sourceId,source.id);assert.equal(item.url,source.url);assert.equal(item.sourceKind,'PAGE');assert.deepEqual(item.token,f.token);assert.deepEqual(item.incentives,['AFFILIATION']);assert.deepEqual(item.citations,pageClaim(f).citations);
 assert.equal(item.publishedAt,null);assert.equal(item.authorId,null);assert.equal(item.incentiveSubject,null);assert.equal(item.observedAt,source.availableAt);assert.equal(item.editHistory,'PRIOR_VERSIONS_UNOBSERVED');assert.equal(d.hiddenCompensation,null);assert.equal(d.underlyingAdvisoryCorpusAccepted,true);assert.equal(d.primarySourceAcquisition.complete,true);
 assert.match(d.interpretation.authorId,/not the incentive subject/);assert.match(d.interpretation.citations,/not a separate proof for each category/);assert.match(d.interpretation.observedAt,/availability bound/);
 assert.equal(d.scope.sourceIds.length,4);assert.equal(d.scope.currentPostWindow.targetPostIds.length,3);assert.equal(d.currentPostMeasurement.quality,'KNOWN');assert.deepEqual(d.currentPostMeasurement.incentives,[]);assert.equal(JSON.stringify(f),before);
});

test('genuine older rejected website keeps the entire broader disclosure measurement missing',()=>{
 const f=fixture('oldRejected'),d=data(derive(f));assert.equal(derive(f).quality,'MISSING');assert.equal(d.disclosures,null);assert.equal(d.underlyingAdvisoryCorpusAccepted,false);assert.equal(pageClaim(f).accepted,false);assert.equal(f.legacyPost.quality,'MISSING');
});

test('a legacy KNOWN empty POST list never rescues a rejected or missing whole-source classification',()=>{
 for(const id of fixture().read.sources.map(s=>s.id)){const f=fixture();f.semantic.sources.find(s=>s.id===id)!.accepted=false;const m=derive(f);assert.equal(m.quality,'MISSING');assert.equal(data(m).disclosures,null);assert.equal(data(m).currentPostMeasurement.quality,'KNOWN');assert.deepEqual(data(m).currentPostMeasurement.incentives,[]);}
 const f=fixture();assert.equal(derive(f,null).quality,'MISSING');f.semantic.sources.pop();assert.equal(derive(f).quality,'MISSING');
});

test('incomplete identity or POST acquisition, clipped text and pending discovery cannot certify the inventory',()=>{
 const mutations:Array<(f:Fixture)=>void>=[f=>{f.read.identityComplete=false;},f=>{f.read.sampleComplete=false;},f=>{f.read.codes.push('SOC_TEXT_CAP');},f=>{f.read.identityUnavailableSources=[{url:page(f).url,code:'HTTP_404'}];},f=>editScope(f,s=>{s.remainingClippedSourceIds.push(page(f).id);}),f=>editScope(f,s=>{s.selection[0].status='PENDING';}),f=>editScope(f,s=>{s.submittedSocialSourceCount--;})];
 for(const mutate of mutations){const f=fixture();mutate(f);assert.equal(derive(f).quality,'MISSING');assert.equal(data(derive(f)).disclosures,null);}
 const acceptedButIncomplete=fixture();acceptedButIncomplete.read.identityComplete=false;assert.equal(data(derive(acceptedButIncomplete)).underlyingAdvisoryCorpusAccepted,true,'A factual-scope gap does not invent a model rejection');
});

test('an omitted or failed nonidentity PAGE from a primary query stays missing despite true SOCIAL completeness flags',()=>{
 for(const outcome of ['OMITTED','UNAVAILABLE'] as const){
  // Synthetic omission in the raw primary roster, without changing true read flags.
  const f=fixture(),url='https://news.example/primary-token-page';editAttention(f,'attention-search-1',p=>{p.results.push({url});p.total_results++;});
  if(outcome==='UNAVAILABLE')editAttention(f,'attention-fetch-1',p=>{p.errors.push({url,error:'timeout'});});
  assert.equal(f.read.sampleComplete,true);assert.equal(f.read.identityComplete,true);assert.equal(scope(f).read.sampleComplete,true);assert.equal(scope(f).read.identityComplete,true);
  const m=derive(f);assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,'S08_PUBLIC_PRIMARY_ACQUISITION_INCOMPLETE');assert.equal(data(m).disclosures,null);assert.equal(data(m).currentPostMeasurement.quality,'KNOWN');assert.equal(data(m).primarySourceAcquisition.urls.find((p:any)=>p.url===url).state,outcome);
 }
});

test('a constructed primary PAGE recovery qualifies only with the exact retained raw body counterpart',()=>{
 const f=fixture(),url='https://news.example/primary-token-page',text=`A neutral public source about ${f.token.address}.`;
 editAttention(f,'attention-search-1',p=>{p.results.push({url});p.total_results++;});editAttention(f,'attention-fetch-1',p=>{p.errors.push({url,error:'timeout'});});
 editAttention(f,'attention-fetch-1-retry-1',p=>{p.results.push({url,final_url:url,text,links:[]});});
 assert.equal(derive(f).quality,'MISSING','A raw body absent from the retained source corpus is not complete');
 const id='constructed-nonidentity-page',source={id,url,text,kind:'PAGE' as const,publishedAt:null,authorId:null,availableAt:page(f).availableAt};
 f.read.sources.push(source);f.semantic.sources.push({...structuredClone(pageClaim(f)),id,event:'OTHER',incentives:[],citations:[{sourceId:id,quote:text}]});editScope(f,s=>{s.read=structuredClone(f.read);s.submittedSocialSourceCount=f.read.sources.length;s.baseSocialSourceCount=f.read.sources.length;});
 const m=derive(f);assert.equal(m.quality,'KNOWN');assert.equal(data(m).disclosures!.length,1);assert.equal(data(m).primarySourceAcquisition.urls.find((p:any)=>p.url===url).state,'ACQUIRED');
 const mismatch=structuredClone(f);mismatch.read.sources.find(s=>s.id===id)!.text+=' altered';editScope(mismatch,s=>{s.read=structuredClone(mismatch.read);});assert.equal(derive(mismatch).quality,'MISSING');
});

test('normal-looking JSON from non-200 primary responses cannot supply acquisition proof, while later 200 recovery can',()=>{
 const query=fixture();editAttention(query,'attention-http-outcomes',p=>{p.outcomes.find((x:any)=>x.artifactId==='attention-search-1').status=500;});assert.equal(derive(query).quality,'MISSING');
 const fetch=fixture(),first=JSON.parse(fetch.acquisition.attention['attention-fetch-1']);editAttention(fetch,'attention-http-outcomes',p=>{p.outcomes.find((x:any)=>x.artifactId==='attention-fetch-1').status=500;});assert.equal(derive(fetch).quality,'MISSING');
 // Synthetic successful later response containing every exact primary body.
 editAttention(fetch,'attention-fetch-1-retry-1',p=>{p.results.push(...first.results);});const m=derive(fetch);assert.equal(m.quality,'KNOWN');assert.equal(data(m).primarySourceAcquisition.complete,true);
});

test('primary query identity and malformed error packets cannot hide behind complete SOCIAL flags',()=>{
 const mismatch=fixture();editAttention(mismatch,'attention-search-1',p=>{p.query='another query';});assert.equal(derive(mismatch).quality,'MISSING');
 const malformed=fixture();editAttention(malformed,'attention-search-1',p=>{p.errors='timeout';});assert.equal(malformed.read.sampleComplete,true);assert.equal(malformed.read.identityComplete,true);assert.equal(derive(malformed).quality,'MISSING');
});

test('source/end freshness, future observations and future publication fail closed without restamping',()=>{
 const stale=fixture();stale.cutoff=new Date(Date.parse(stale.cutoff)+900001).toISOString();assert.equal(derive(stale).quality,'MISSING');
 const future=fixture();page(future).availableAt=new Date(Date.parse(future.cutoff)+1).toISOString();assert.equal(derive(future).quality,'MISSING');
 const publication=fixture();page(publication).publishedAt=new Date(Date.parse(publication.cutoff)+1).toISOString();assert.equal(derive(publication).quality,'MISSING');
 const f=fixture(),observed=page(f).availableAt;f.cutoff=new Date(Date.parse(f.cutoff)+1000).toISOString();assert.equal(data(derive(f)).disclosures![0].observedAt,observed);assert.equal(data(derive(f)).disclosures![0].publishedAt,null);
});

test('foreign token and uncertain positive binding block the full inventory; unrelated positives are explicitly excluded',()=>{
 const foreign=fixture();foreign.semantic.token={...foreign.token,address:'3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'};assert.equal(derive(foreign).quality,'MISSING');
 const uncertain=fixture();pageClaim(uncertain).binding='UNCLEAR';assert.equal(derive(uncertain).quality,'MISSING');assert.equal(data(derive(uncertain)).disclosures,null);
 const unrelated=fixture();pageClaim(unrelated).binding='UNRELATED';const m=derive(unrelated);assert.equal(m.quality,'KNOWN');assert.deepEqual(data(m).disclosures,[]);assert.deepEqual(data(m).excludedUnrelatedSourceIds,[page(unrelated).id]);
});

test('resolved citations must remain literal, own-source and exact-token bound',()=>{
 const madeUp=fixture();pageClaim(madeUp).citations[0]!.quote+=' invented';assert.equal(derive(madeUp).quality,'MISSING');
 const foreign=fixture();pageClaim(foreign).citations[0]!.sourceId=foreign.read.targetPostIds[0]!;assert.equal(derive(foreign).quality,'MISSING');
 const noToken=fixture();pageClaim(noToken).citations=[{sourceId:page(noToken).id,quote:'A Solana community with a simple idea'}];assert.equal(derive(noToken).quality,'MISSING');
 const absent=fixture();pageClaim(absent).citations=[];assert.equal(derive(absent).quality,'MISSING');
});

test('duplicate canonical PAGE or status aliases cannot double-count source disclosures',()=>{
 for(const original of ['PAGE','POST'] as const){
  const f=fixture(),s=f.read.sources.find(s=>s.kind===original)!,copy={...s,id:s.id+'-duplicate',url:original==='PAGE'?s.url:s.url.replace('x.com','twitter.com')+'/photo/1'};f.read.sources.push(copy);if(original==='POST')f.read.targetPostIds.push(copy.id);else f.read.identitySourceIds.push(copy.id);
  const claim=f.semantic.sources.find(c=>c.id===s.id)!;f.semantic.sources.push({...structuredClone(claim),id:copy.id,citations:claim.citations.map(c=>({...c,sourceId:copy.id}))});editScope(f,scope=>{scope.read=structuredClone(f.read);scope.submittedSocialSourceCount=f.read.sources.length;});assert.equal(derive(f).quality,'MISSING');assert.equal(derive(f).reasonCode,'S08_PUBLIC_SOURCE_CANONICAL_CONFLICT');
 }
});

test('mismatched acquisition metadata, queries, source kinds and an empty read stay missing',()=>{
 const a=fixture();editScope(a,s=>{s.read.sources[0].publishedAt='2026-10-01T00:00:00.000Z';});assert.equal(derive(a).quality,'MISSING');
 const b=fixture();editScope(b,s=>{s.read.queries[0]='different scope';});assert.equal(derive(b).quality,'MISSING');
 const c=fixture();page(c).kind='POST';editScope(c,s=>{s.read=structuredClone(c.read);});assert.equal(derive(c).quality,'MISSING');
 const d=fixture();d.read.sources=[];d.read.targetPostIds=[];d.read.identitySourceIds=[];assert.equal(derive(d).quality,'MISSING');
 const e=fixture();e.acquisition={};assert.equal(derive(e).quality,'MISSING');
});

test('PAGE metadata never becomes an inferred author or an additional incentive category',()=>{
 const f=fixture();page(f).authorId='x.com:unverified';editScope(f,s=>{s.read.sources.find((s:any)=>s.id===page(f).id).authorId='x.com:unverified';});const m=derive(f);assert.equal(m.quality,'KNOWN');assert.equal(data(m).disclosures![0].authorId,null);assert.deepEqual(data(m).disclosures![0].incentives,['AFFILIATION']);
 const bad=fixture();(pageClaim(bad).incentives as string[]).push('UNKNOWN');assert.equal(derive(bad).quality,'MISSING');const repeated=fixture();pageClaim(repeated).incentives.push('AFFILIATION');assert.equal(derive(repeated).quality,'MISSING');
});

test('the full-source inventory does not turn a missing legacy POST component into an empty known component',()=>{
 const f=fixture();f.legacyPost.quality='MISSING';const m=derive(f);assert.equal(m.quality,'KNOWN');assert.equal(data(m).currentPostMeasurement.quality,'MISSING');assert.equal(data(m).currentPostMeasurement.incentives,null);
 const other=fixture();other.legacyPost.id='A07';assert.equal(data(derive(other)).currentPostMeasurement.quality,'MISSING');assert.equal(data(derive(other)).currentPostMeasurement.incentives,null);
});

test('a legacy semantic rubric is not relabeled as the new full-source protocol',()=>{
 const f=fixture();f.semantic.method='advisory-source-classification-v2';const m=derive(f);assert.equal(m.quality,'MISSING');assert.equal(data(m).method,PUBLIC_SOURCE_INCENTIVES_METHOD);assert.equal(data(m).disclosures,null);
});

test('constructed historical reporter metadata is not treated as the incentive subject or first disclosure time',()=>{
 // Synthetic unit mutation, not another actual source or model observation.
 const f=fixture(),s=f.read.sources.find(s=>s.id===f.read.targetPostIds[1])!,statement=`Public report: a third party holds ${f.token.address} in their wallet.`;s.text+='\n'+statement;
 const claim=f.semantic.sources.find(c=>c.id===s.id)!;claim.binding='EXACT_CONTRACT';claim.incentives=['PUBLIC_HOLDINGS'];claim.citations=[{sourceId:s.id,quote:statement}];editScope(f,scope=>{scope.read.sources.find((x:any)=>x.id===s.id).text=s.text;});
 editAttention(f,'attention-fetch-1',p=>{p.results.find((r:any)=>r.url===s.url).text=s.text;});
 const m=derive(f);assert.equal(m.quality,'KNOWN');const record=data(m).disclosures!.find(d=>d.sourceId===s.id);assert.equal(record.sourceKind,'POST');assert.equal(record.publishedAt,s.publishedAt);assert.equal(record.observedAt,s.availableAt);assert.equal(record.authorId,s.authorId);assert.equal(record.incentiveSubject,null);assert.equal(record.editHistory,'PRIOR_VERSIONS_UNOBSERVED');assert.deepEqual(record.incentives,['PUBLIC_HOLDINGS']);assert.deepEqual(data(m).currentPostMeasurement.incentives,[]);
});

function constructedBodyRefinement(){
 // Synthetic unit context only; the integration suite exercises real body-triplet
 // collection/decode. Original source evidence and genuine fixture stay intact.
 const f=fixture(),originalRead=structuredClone(f.read),source=f.read.sources.find(s=>s.kind==='POST')!,quote=`Refined public report of holdings in ${f.token.address}.`;
 source.text+='\n'+quote;source.publishedAt=new Date(Date.parse(f.cutoff)-120000).toISOString();source.availableAt=new Date(Date.parse(f.cutoff)-5000).toISOString();
 const claim=f.semantic.sources.find(s=>s.id===source.id)!;claim.binding='EXACT_CONTRACT';claim.incentives=['PUBLIC_HOLDINGS'];claim.citations=[{sourceId:source.id,quote}];
 return{f,source,context:{originalRead,read:structuredClone(f.read)} satisfies PublicSourceIncentivesBodyContext};
}

test('bound body refinement retains refined POST text and precise clocks alongside original PAGE observation',()=>{
 const {f,source,context}=constructedBodyRefinement(),before=JSON.stringify({f,context});
 const m=derive(f,f.semantic,f.legacyPost,context);assert.equal(m.quality,'KNOWN');assert.equal(data(m).primarySourceAcquisition.complete,true);
 const record=data(m).disclosures!.find(s=>s.sourceId===source.id);assert.equal(record.publishedAt,source.publishedAt);assert.equal(record.observedAt,source.availableAt);assert.deepEqual(record.citations,f.semantic.sources.find(s=>s.id===source.id)!.citations);
 assert.notEqual(record.publishedAt,context.originalRead.sources.find(s=>s.id===source.id)!.publishedAt);assert.notEqual(record.observedAt,context.originalRead.sources.find(s=>s.id===source.id)!.availableAt);
 assert.equal(data(m).disclosures!.find(s=>s.sourceKind==='PAGE').observedAt,page(f).availableAt);assert.equal(JSON.stringify({f,context}),before);
 f.read.qualifiedAt=f.cutoff;context.originalRead.qualifiedAt=f.cutoff;assert.equal(derive(f,f.semantic,f.legacyPost,context).quality,'KNOWN','Only qualification stamps may differ across bound parsed reads');
});

test('a differing full read needs body context and either side of that context must match exactly',()=>{
 const noContext=constructedBodyRefinement();assert.equal(derive(noContext.f).reasonCode,'S08_PUBLIC_ACQUISITION_BINDING');
 const textOnly=fixture();page(textOnly).text+='\nUnbound source text.';assert.equal(derive(textOnly).reasonCode,'S08_PUBLIC_ACQUISITION_BINDING','No-context binding includes source text, not just metadata');
 const mutations:Array<(read:SocialInput)=>void>=[r=>{r.sources[0]!.text+=' tampered';},r=>{r.sources[0]!.availableAt=new Date(Date.parse(r.sources[0]!.availableAt)+1).toISOString();},r=>{r.sources.find(s=>s.kind==='POST')!.publishedAt=null;},r=>{r.queries[0]+=' changed';},r=>{r.sampleComplete=false;},r=>{r.codes.push('UNBOUND_NOTE');},r=>{r.previousComparable=!r.previousComparable;},r=>{r.targetPostIds.reverse();}];
 for(const side of ['originalRead','read'] as const)for(const mutate of mutations){const {f,context}=constructedBodyRefinement();
  mutate(context[side]);assert.equal(derive(f,f.semantic,f.legacyPost,context).reasonCode,'S08_PUBLIC_ACQUISITION_BINDING',`Tampered ${side} must not bind`);
 }
 const unexpanded=fixture();unexpanded.read.qualifiedAt=unexpanded.cutoff;assert.equal(derive(unexpanded).quality,'KNOWN');
});

test('matching refined context does not bypass refined source freshness or citation checks',()=>{
 const future=constructedBodyRefinement();future.source.availableAt=new Date(Date.parse(future.f.cutoff)+1).toISOString();future.context.read=structuredClone(future.f.read);assert.equal(derive(future.f,future.f.semantic,future.f.legacyPost,future.context).reasonCode,'S08_PUBLIC_SOURCE_STALE_OR_FUTURE');
 const citation=constructedBodyRefinement();citation.f.semantic.sources.find(s=>s.id===citation.source.id)!.citations[0]!.quote+=' fabricated';assert.equal(derive(citation.f,citation.f.semantic,citation.f.legacyPost,citation.context).reasonCode,'S08_PUBLIC_SOURCE_CITATION_INVALID');
});
