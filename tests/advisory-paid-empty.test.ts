import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {proveEmptyCurrentPosts} from '../src/providers/advisory-paid-empty.js';
import type {SocialInput} from '../src/domain/social.js';
const fixture=()=>JSON.parse(readFileSync(new URL('../../tests/fixtures/advisory-paid-empty-actual.json',import.meta.url),'utf8')) as {acquisition:any;read:SocialInput};
const change=(raw:string,edit:(value:any)=>void)=>{const v=JSON.parse(raw);edit(v);return JSON.stringify(v);};
const editFetch=(f:ReturnType<typeof fixture>,edit:(v:any)=>void,key='attention-fetch-1')=>{f.acquisition.attention[key]=change(f.acquisition.attention[key],edit);};
const editScope=(f:ReturnType<typeof fixture>,edit:(v:any)=>void)=>{f.acquisition.social['social-acquisition-scope']=change(f.acquisition.social['social-acquisition-scope'],edit);};
const prove=(f:ReturnType<typeof fixture>)=>proveEmptyCurrentPosts(f.acquisition,f.read);

test('genuine retained four-source acquisition proves three old posts while preserving comparison PAGE timeout',()=>{
 const f=fixture(),before=JSON.stringify(f),p=prove(f);assert.ok(p);assert.equal(p.method,'raw-acquisition-empty-current-posts-v1');assert.deepEqual(p.currentPostIds,[]);assert.equal(p.rawCounts.postCandidates,3);assert.equal(p.rawCounts.postAliases,3);assert.equal(p.rawCounts.comparisonPageFailures,2);assert.equal(p.rawCounts.searches,3);assert.equal(p.rawCounts.fetches,2);assert.equal(JSON.stringify(f),before);
});
test('proof ignores cached completion/zero claims and qualifiedAt is a separate integration clock',()=>{
 const f=fixture();f.read.qualifiedAt='2026-10-30T18:33:42.580Z';f.read.postSampleScope!.complete=false;f.read.sampleComplete=false;assert.ok(prove(f),'raw proof does not borrow sampleComplete or terminal negative scope');
});
test('one current, missing, invalid, or conflicting alias publication date rejects before canonical dedup',()=>{
 for(const date of ['2026-10-30T00:00:00.000Z',null,'not-a-date']){const f=fixture();editFetch(f,v=>{v.results.find((r:any)=>r.url.includes('/status/')).published_date=date;});assert.equal(prove(f),null);}
 const f=fixture();editFetch(f,v=>{const row=structuredClone(v.results.find((r:any)=>r.url.includes('/status/')));row.url=row.url.replace('x.com','twitter.com');row.published_date='2026-10-30T00:00:00.000Z';v.results.push(row);});assert.equal(prove(f),null);
});
test('case/photo aliases with exactly agreeing date and source body remain real observations',()=>{
 const f=fixture();editFetch(f,v=>{const row=structuredClone(v.results.find((r:any)=>r.url.includes('/status/')));row.url=row.url.replace('x.com','twitter.com')+'/photo/1';row.final_url=row.final_url+'/photo/1';v.results.push(row);});const p=prove(f);assert.ok(p);assert.equal(p.rawCounts.postAliases,4);assert.equal(p.rawCounts.postCandidates,3);
});
test('a duplicate old alias with a different body cannot hide behind the first retained canonical row',()=>{
 const f=fixture();editFetch(f,v=>{const row=structuredClone(v.results.find((r:any)=>r.url.includes('/status/')));row.text+=' changed';v.results.push(row);});assert.equal(prove(f),null);
});
test('a raw-only, omitted, or failed primary POST never becomes zero',()=>{
 const extra='https://x.com/another/status/2119999999999999999';
 const a=fixture();a.acquisition.attention['attention-search-2']=change(a.acquisition.attention['attention-search-2'],v=>{v.results.push({url:extra});v.total_results++;});assert.equal(prove(a),null);
 const b=fixture();editFetch(b,v=>{v.results=v.results.filter((r:any)=>!r.url.includes('coiniseasy'));});assert.equal(prove(b),null);
 const c=fixture();editFetch(c,v=>{v.errors.push({url:v.results.find((r:any)=>r.url.includes('/status/')).url,error:'timeout'});});assert.equal(prove(c),null);
 const d=fixture();editFetch(d,v=>{v.results.push({url:extra,final_url:extra,published_date:'2026-10-25T00:00:00.000Z',text:'raw body not retained'});});assert.equal(prove(d),null);
});
test('raw query omission, query mismatch, page cap, or failed HTTP cannot certify a complete roster',()=>{
 for(const mutate of [(f:ReturnType<typeof fixture>)=>{delete f.acquisition.attention['attention-search-2'];},(f:ReturnType<typeof fixture>)=>{f.acquisition.attention['attention-search-2']=change(f.acquisition.attention['attention-search-2'],v=>{v.query='different query';});},(f:ReturnType<typeof fixture>)=>{f.acquisition.attention['attention-search-2']=change(f.acquisition.attention['attention-search-2'],v=>{v.total_results++;});},(f:ReturnType<typeof fixture>)=>{f.acquisition.attention['attention-http-outcomes']=change(f.acquisition.attention['attention-http-outcomes'],v=>{v.outcomes.find((r:any)=>r.artifactId==='attention-search-2').status=429;});}]){const f=fixture();mutate(f);assert.equal(prove(f),null);}
});
test('source clipping, missing/foreign target IDs, changed window, or hidden POST kind fail closed',()=>{
 const a=fixture();editScope(a,v=>{v.remainingClippedSourceIds.push('attention-page-2');});assert.equal(prove(a),null);
 const b=fixture();b.read.targetPostIds.pop();assert.equal(prove(b),null);
 const c=fixture();c.read.start='2026-10-24T18:32:14.997Z';assert.equal(prove(c),null);
 const d=fixture();d.read.sources[1]!.kind='PAGE';assert.equal(prove(d),null);
 const e=fixture();e.read.codes.push('SOC_TEXT_CAP');assert.equal(prove(e),null);
});
test('embedded reply links are not followed as a new corpus, but an eligible seed-derived POST must be accounted',()=>{
 const f=fixture();editFetch(f,v=>{v.results.find((r:any)=>r.url.includes('/status/')).links.push('https://x.com/reply/status/2119999999999999999');});assert.ok(prove(f));
 const g=fixture();editFetch(g,v=>{const row=v.results.find((r:any)=>r.url==='https://www.bigtittycoin.fun/');row.url='https://x.com/seed';row.final_url=row.url;row.links=['https://x.com/seed/status/2119999999999999999'];});editScope(g,v=>{v.selection.push({url:'https://x.com/seed',selected:true,reason:'DEX_DISCOVERY',required:true,status:'RETAINED'});});assert.equal(prove(g),null);
});
test('empty or PAGE-only retained corpus, malformed acquisition, unknown source artifacts do not prove absence',()=>{
 const a=fixture();a.read.sources=a.read.sources.filter(s=>s.kind==='PAGE');a.read.targetPostIds=[];assert.equal(prove(a),null);assert.equal(proveEmptyCurrentPosts({},fixture().read),null);
 const b=fixture();b.acquisition.attention['attention-collection-fetch-error']='{"code":"ATT_FETCH_TIMEOUT"}';assert.equal(prove(b),null);
});
