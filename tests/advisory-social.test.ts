import assert from 'node:assert/strict';
import test from 'node:test';
import { collectAdvisorySocial, decodeAdvisorySocial, deriveSocialAdvisory } from '../src/providers/advisory-social.js';
import { makeSocialFixture, SOCIAL_TOKEN, SOCIAL_CUTOFF } from './social-fixtures.js';
const TOKEN={chain:'solana' as const,address:'3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'},AT='2026-10-10T10:00:00.000Z';
const URL=`https://api.dexscreener.com/orders/v1/solana/${TOKEN.address}`;
const raw={orders:[{chainId:'solana',tokenAddress:TOKEN.address,type:'tokenProfile',status:'approved',paymentTimestamp:Date.parse(AT)-1000}],boosts:[{chainId:'solana',tokenAddress:TOKEN.address,id:'boost-1',amount:100,paymentTimestamp:Date.parse(AT)-2000}]};
const decode=(value:unknown=raw,url=URL,at=AT)=>decodeAdvisorySocial(TOKEN,{'advisory-paid-orders':JSON.stringify(value)},{'advisory-paid-orders':at},{'advisory-paid-orders':{url}});
const derive=(fixture=makeSocialFixture())=>deriveSocialAdvisory(fixture.read,fixture.proposal,fixture.review,SOCIAL_TOKEN,SOCIAL_CUTOFF,['synthetic-source'],null);
const row=(rows:ReturnType<typeof derive>,id:string)=>rows.find(x=>x.id===id)!;
test('paid orders and boosts reconstruct exact token request and do not assert organic absence',()=>{
 const result=decode();assert.equal(result.quality,'KNOWN');assert.equal(result.orders.length,1);assert.equal(result.boosts.length,1);assert.match(result.scope,/no inference of organic/);
 assert.equal(decode([]).quality,'KNOWN');assert.equal(decode([{type:'tokenProfile',status:'approved',paymentTimestamp:0}]).quality,'KNOWN');
});
test('paid visibility rejects wrong token, request, wire, duplicates and future payments',()=>{
 assert.equal(decode(raw,URL+'?token=other').quality,'INVALID');
 assert.equal(decode({...raw,orders:[{...raw.orders[0],tokenAddress:'other'}]}).quality,'INVALID');
 assert.equal(decode({...raw,orders:[{...raw.orders[0],paymentTimestamp:Date.parse(AT)+1}]}).quality,'INVALID');
 assert.equal(decode({...raw,orders:[{...raw.orders[0],status:'unknown'}]}).quality,'INVALID');
 assert.equal(decode({...raw,boosts:[raw.boosts[0],raw.boosts[0]]}).quality,'INVALID');
 assert.equal(decode(raw,URL,'broken').quality,'INVALID');assert.equal(decode({error:'upstream'}).quality,'INVALID');
});
test('paid collector retains one bounded response and exact endpoint binding',async()=>{
 let seen='',redirect='';const fake=async(url:string|URL|Request,init?:RequestInit)=>{seen=String(url);redirect=String(init?.redirect);assert.ok(init?.signal);return new Response(JSON.stringify(raw));};
 const result=await collectAdvisorySocial(TOKEN,fake as typeof fetch,()=>AT);assert.equal(seen,URL);assert.equal(redirect,'error');assert.equal(result.data.quality,'KNOWN');assert.equal(result.retrievedAt['advisory-paid-orders'],AT);
 const unavailable=await collectAdvisorySocial(TOKEN,(async()=>new Response('[]',{status:503})) as typeof fetch,()=>AT);assert.equal(unavailable.data.quality,'MISSING');assert.equal(unavailable.retrievedAt['advisory-paid-orders'],AT);assert.deepEqual(JSON.parse(unavailable.rawArtifacts['advisory-paid-orders']),{method:'paid-visibility-request-failure-v1',code:'PAID_VISIBILITY_HTTP',status:503,body:'[]',bodyComplete:true});
});
test('social bins use reviewed post bodies and preserve undefined denominators',()=>{
 const rows=derive();const acc=row(rows,'A19');assert.equal(acc.quality,'KNOWN');assert.deepEqual((acc.data as {counts:number[]}).counts,[0,6,0]);assert.equal(row(rows,'A20').quality,'KNOWN');assert.equal(row(rows,'A23').quality,'MISSING');assert.equal(row(rows,'S09').reasonCode,'FORWARD_CALL_EVENTS_UNQUALIFIED');assert.equal(row(rows,'S11').quality,'KNOWN');assert.equal((row(rows,'S11').data as {returningFraction:string}).returningFraction,'0');assert.equal(row(rows,'A24').quality,'MISSING');
 const empty=makeSocialFixture();for(const s of empty.read.sources)if(s.kind==='POST')s.publishedAt='2026-10-02T10:00:00.000Z';const zero=derive(empty);assert.deepEqual((row(zero,'A19').data as {counts:number[]}).counts,[0,0,0]);assert.equal(row(zero,'A23').reasonCode,'PRICE_FRACTION_DENOMINATOR_ZERO');assert.equal(row(zero,'S11').reasonCode,'RETURNING_DENOMINATOR_ZERO');
});
test('rejected source reviews and collection truncation never become measured zero',()=>{
 const rejected=makeSocialFixture();rejected.review.sources[0].complete=false;assert.equal(row(derive(rejected),'A19').quality,'MISSING');
 const clipped=makeSocialFixture();clipped.read.sampleComplete=false;assert.equal(row(derive(clipped),'A19').quality,'MISSING');
 const body=makeSocialFixture();body.proposal.posts.find(p=>p.sourceId==='post-alice-1')!.bodyComplete=false;assert.equal(row(derive(body),'A19').quality,'MISSING');
 const nav=makeSocialFixture();nav.proposal.posts.find(p=>p.sourceId==='post-alice-1')!.body.quote='Navigation has no binding.';nav.read.sources.find(s=>s.id==='post-alice-1')!.text+='\nNavigation has no binding.';assert.equal(row(derive(nav),'A19').quality,'MISSING');
});
test('current window is start-inclusive end-exclusive and equal-bin authors preserve churn',()=>{
 const fixture=makeSocialFixture({accountCount:1});const posts=fixture.read.sources.filter(s=>s.kind==='POST');posts[0].publishedAt=fixture.read.start;posts[1].publishedAt='2026-10-03T12:00:00.000Z';posts[2].publishedAt=fixture.read.end;
 const rows=derive(fixture);assert.deepEqual((row(rows,'A19').data as {counts:number[]}).counts,[1,1,0]);assert.equal((row(rows,'S11').data as {returningFraction:string}).returningFraction,'1');
 const rejected=makeSocialFixture();rejected.review.decisions.find(x=>x.id==='post:post-alice-1')!.accepted=false;assert.equal(row(derive(rejected),'S11').quality,'MISSING');
});
test('future or stale paid observation cannot qualify social advisory paid visibility',()=>{
 const fixture=makeSocialFixture();const paid={...decode(),token:SOCIAL_TOKEN};assert.equal(row(deriveSocialAdvisory(fixture.read,fixture.proposal,fixture.review,SOCIAL_TOKEN,SOCIAL_CUTOFF,[],paid),'A22').quality,'MISSING');
 const stale={...paid,availableAt:'2026-10-03T00:00:00.000Z'};assert.equal(row(deriveSocialAdvisory(fixture.read,fixture.proposal,fixture.review,SOCIAL_TOKEN,SOCIAL_CUTOFF,[],stale),'A22').quality,'MISSING');
});

test('external deadline covers a hanging response body, with no invented empty result',async()=>{
 const controller=new AbortController();
 const fake=async()=>new Response(new ReadableStream({start(){/* deliberately no response bytes */}}));
 const pending=collectAdvisorySocial(TOKEN,fake as typeof fetch,()=>AT,controller.signal);
 setTimeout(()=>controller.abort(),5);
 const result=await pending;assert.equal(result.data.quality,'MISSING');assert.equal(result.retrievedAt['advisory-paid-orders'],AT);assert.equal(JSON.parse(result.rawArtifacts['advisory-paid-orders']).code,'PAID_VISIBILITY_TIMEOUT');
});

test('A22 full feature remains missing when only DEX paid visibility is measured',()=>{
 const fixture=makeSocialFixture();const paid={...decode(),token:SOCIAL_TOKEN,availableAt:'2026-10-04T00:05:00.000Z'};
 const result=row(deriveSocialAdvisory(fixture.read,fixture.proposal,fixture.review,SOCIAL_TOKEN,SOCIAL_CUTOFF,[],paid),'A22');
 assert.equal(result.quality,'MISSING');assert.equal(result.reasonCode,'PAID_POST_DISCLOSURE_REVIEW_MISSING');
 const data=result.data as {dex:{quality:string};dexCoverage:string;disclosureCoverage:string};
 assert.equal(data.dex.quality,'KNOWN');assert.equal(data.dexCoverage,'OBSERVED');assert.equal(data.disclosureCoverage,'NOT_COLLECTED');
});
test('transport failure records are sanitized and decode only when request/time binding is valid',async()=>{
 const result=await collectAdvisorySocial(TOKEN,(async()=>{throw new Error('private-key=secret connection failure');}) as typeof fetch,()=>AT);
 assert.equal(result.data.quality,'MISSING');assert.equal(result.retrievedAt['advisory-paid-orders'],AT);
 assert.equal(result.rawArtifacts['advisory-paid-orders'].includes('secret'),false);
 assert.equal(decode(JSON.parse(result.rawArtifacts['advisory-paid-orders']),URL+'?wrong=1').quality,'INVALID');
});
