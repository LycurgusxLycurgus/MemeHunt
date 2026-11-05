import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {EvidenceRecord} from '../src/domain/contracts.js';
import {callerSeedFromEvidence,CALLER_SELECTION_ID,CALLER_SEED_METHOD} from '../src/providers/advisory-caller-measures.js';
import {collectCallerHistory} from '../src/providers/advisory-caller-history.js';
import {decodeRecordedCallerCapture,deriveRecordedCallerMetrics,recordedCallerProposalPrompt,recordedCallerReviewPrompt,RECORDED_CALLER_METHOD,type RecordedCallerCapture} from '../src/providers/advisory-recorded-callers.js';
import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {Service} from '../src/app/service.js';
import {starterProfile} from '../src/app/config.js';
import {runCli} from '../src/cli.js';
import {a29LiveFetcher} from './a29-fixtures.js';
const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const at = (s: number) => `2026-10-12T00:00:${String(s).padStart(2, '0')}.000Z`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const POST_AT = '2026-10-11T12:00:00.000Z', id = String(((BigInt(Date.parse(POST_AT)) - 1288834974657n) << 22n) + 1n), url = `https://x.com/alpha/status/${id}`;
const rec = (id: string, sourceId: string, sourceType: string, accessMode: EvidenceRecord['accessMode'], scope: Record<string, unknown>, raw: string): EvidenceRecord => ({ id, sourceId, sourceType, accessMode, scope, retrievedAt: at(0), availableAt: at(0), contentHash: sha(raw), adapterVersion: 'live-v1' });
/** Constructed complete public-receipt fixture; never represented as actual model/provider evidence. */
async function fixture(): Promise<RecordedCallerCapture> {
  const text = `Early entry Ca: ${token.address}`, rawArtifacts: Record<string, string> = {
    'attention-scope': JSON.stringify({ queries: [`${token.address} site:x.com`], postSampleSourceIds: ['attention-page-1'] }), 'attention-page-1': text,
  };
  const evidence = [rec('attention-scope', 'attention-collector', 'SAMPLE_SCOPE', 'LOCAL_DERIVED', { method: 'comparison-scope-v2' }, rawArtifacts['attention-scope']!), rec('attention-page-1', 'tinyfish-fetch', 'WEB_PAGE', 'FREE_ACCOUNT', { kind: 'POST', url, publishedAt: POST_AT }, text)];
  const seed = callerSeedFromEvidence(token, evidence, rawArtifacts, at(0)); assert.ok(seed.selection);
  rawArtifacts[CALLER_SELECTION_ID] = seed.raw; evidence.push(rec(CALLER_SELECTION_ID, 'advisory-collector', 'SAMPLE_SCOPE', 'LOCAL_DERIVED', { method: CALLER_SEED_METHOD }, seed.raw));
  const payloads = {
    oembed: { url, author_url: 'https://twitter.com/alpha' },
    syndication: { __typename: 'Tweet', id_str: id, created_at: POST_AT, text, user: { screen_name: 'alpha' }, edit_control: { edit_tweet_ids: [id], editable_until_msecs: String(Date.parse(POST_AT) + 3600000) }, isEdited: false, isStaleEdit: false },
    fxtwitter: { code: 200, message: 'OK', tweet: { id, text, raw_text: { text, facets: [] }, author: { screen_name: 'alpha' }, created_timestamp: Date.parse(POST_AT) / 1000, is_note_tweet: false, replying_to_status: null, reposted_by: null } },
  };
  const collected = await collectCallerHistory(seed.selection, (async (input: unknown) => { const u = String(input); return new Response(JSON.stringify(payloads[u.includes('oembed') ? 'oembed' : u.includes('syndication') ? 'syndication' : 'fxtwitter'])); }) as typeof fetch, () => at(5));
  return { method: RECORDED_CALLER_METHOD, token, seed: { evidence, rawArtifacts }, callers: { requests: collected.requests, rawArtifacts: collected.rawArtifacts, times: Object.fromEntries(Object.keys(collected.rawArtifacts).map(k => [k, at(5)])) }, qualification: null };
}
function classified(c: RecordedCallerCapture, patch: Record<string, unknown> = {}, accept = true): RecordedCallerCapture {
  const d = decodeRecordedCallerCapture(JSON.stringify(c), token, at(30));
  assert.equal(d.history.complete, true);
  const proposalPrompt = recordedCallerProposalPrompt(d), catalog = JSON.parse(proposalPrompt).sources;
  const proposalResponse = JSON.stringify({ sources: catalog.map((s: any) => ({ id: s.id, binding: 'EXACT_CONTRACT', event: 'FORWARD_CALL', category: 'CRYPTO_CALLER', topic: 'PRICE_CHART', citations: [{ sourceId: s.id, spanId: s.spans.find((p: any) => p.text.includes(token.address)).id }], rationale: 'Synthetic fixture classification only.', ...patch })) });
  const reviewPrompt = recordedCallerReviewPrompt(d, proposalResponse), reviewResponse = JSON.stringify({ sources: catalog.map((s: any) => ({ id: s.id, complete: true, binding: accept, event: accept, category: accept, topic: accept })) });
  const pass = (executor: 'CODEX' | 'CLAUDE_CODE', prompt: string, response: string, start: number, finish: number) => ({ prompt, response, execution: { executor, executionId: `synthetic-${executor}`, modelId: null, modelIdSource: 'UNREPORTED' as const, tools: 'NONE' as const, freshSession: true as const, startedAt: at(start), finishedAt: at(finish), promptSha256: sha(prompt), responseSha256: sha(response) } });
  return { ...c, qualification: { proposal: pass('CODEX', proposalPrompt, proposalResponse, 6, 10), review: pass('CLAUDE_CODE', reviewPrompt, reviewResponse, 11, 15) } };
}
const CAP='advisory-recorded-callers-capture',CUT=at(30);
const collect=(raw?:string,clock=CUT)=>collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher:a29LiveFetcher(token.address,clock),now:()=>clock,...(raw===undefined?{}:{recordedCallersCapture:raw})});
type Run=Awaited<ReturnType<typeof collect>>;
const proof=(b:Run)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const record=(b:Run)=>b.evidence.find(e=>e.id===CAP)!;
const reconstruct=(b:Run,p=proof(b))=>reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,p,b.thesis??null,b.features);

test('explicit recorded callers import preserves raw bytes, rederives only four rows and persists/replays with new labels',async()=>{
 const raw=JSON.stringify(classified(await fixture())),b=await collect(raw),p=proof(b);
 assert.equal(p.method,'advisory-provenance-v41');assert.deepEqual(p.recordedCallers,{captureId:CAP});assert.equal(b.details!.advisory!.method,'advisory-measurements-v40');
 assert.equal(b.rawArtifacts[CAP],raw);assert.deepEqual([record(b).sourceId,record(b).accessMode,record(b).sourceType,record(b).adapterVersion,record(b).retrievedAt,record(b).availableAt],['advisory-recorded-callers','USER_IMPORT','HISTORICAL_RECEIPT',RECORDED_CALLER_METHOD,CUT,CUT]);
 const rows=b.details!.advisory!.metrics.filter(m=>['S07','S09','A21','A23'].includes(m.id));assert.equal(rows.length,4);assert.ok(rows.every(m=>m.quality==='KNOWN'));assert.deepEqual(rows,deriveRecordedCallerMetrics(raw,token,CUT,[CAP]).sort((a,c)=>b.details!.advisory!.metrics.findIndex(m=>m.id===a.id)-b.details!.advisory!.metrics.findIndex(m=>m.id===c.id)));
 assert.deepEqual(reconstruct(b),b.details!.advisory);assert.ok(b.features.every(f=>!f.evidenceIds.includes(CAP)));assert.ok(b.details!.baseline.every(a=>!a.evidenceIds.includes(CAP)));
 const dir=mkdtempSync(join(tmpdir(),'recorded-callers-service-')),file=join(dir,'test.sqlite'),service=new Service(file);
 try{const saved=service.analyzeLive(b);assert.deepEqual(service.replay(saved.id),saved);assert.deepEqual(service.analyzeLive(b),saved);const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string).policyVersion,'research-screen-advisory-v38');}finally{db.close();}const reopened=new Service(file);try{assert.deepEqual(reopened.replay(saved.id),saved);}finally{reopened.close();}}finally{service.close();rmSync(dir,{recursive:true,force:true});}
});

test('ordinary collection keeps proof40/facts39/policy37 and cannot admit recorded namespace or descriptor',async()=>{
 const b=await collect(),p=proof(b);assert.equal(p.method,'advisory-provenance-v40');assert.equal(p.recordedCallers,undefined);assert.equal(b.details!.advisory!.method,'advisory-measurements-v39');assert.deepEqual(reconstruct(b),b.details!.advisory);
 const orphan=structuredClone(b);orphan.rawArtifacts[CAP]='{}';assert.throws(()=>reconstruct(orphan),/ADVISORY_PROOF_INVALID/);
 assert.throws(()=>reconstruct(b,{...p,recordedCallers:null}),/ADVISORY_PROOF_INVALID/);assert.throws(()=>reconstruct(b,{...p,method:'advisory-provenance-v41'}),/ADVISORY_PROOF_INVALID/);
 const imported=await collect(JSON.stringify(classified(await fixture()))),downgrade=proof(imported);downgrade.method='advisory-provenance-v38';delete downgrade.recordedCallers;assert.throws(()=>reconstruct(imported,downgrade),/ADVISORY_PROOF_INVALID/);
});

test('provenance membership, source clocks, hashes and token binding reject forged imports',async()=>{
 const raw=JSON.stringify(classified(await fixture())),original=await collect(raw);
 const cases:Array<(b:Run)=>void>=[
 b=>{record(b).sourceId='advisory-context';},b=>{record(b).adapterVersion='live-v1';},b=>{record(b).sourceType='REVIEWED_CORPUS';},b=>{record(b).accessMode='PUBLIC_API';},b=>{record(b).scope.extra=true;},b=>{record(b).contentHash='0'.repeat(64);},b=>{record(b).availableAt=at(29);},b=>{record(b).retrievedAt=at(31);},
 b=>{const r=structuredClone(record(b));r.id='advisory-recorded-callers-shadow';b.evidence.push(r);b.rawArtifacts[r.id]=raw;},
 b=>{b.rawArtifacts[CAP]=JSON.stringify({...JSON.parse(raw),token:{...token,address:'other'}});record(b).contentHash=sha(b.rawArtifacts[CAP]!);},
 b=>{const c=JSON.parse(raw);c.qualification.review.execution.finishedAt=at(31);b.rawArtifacts[CAP]=JSON.stringify(c);record(b).contentHash=sha(b.rawArtifacts[CAP]!);},
 ];for(const change of cases){const b=structuredClone(original);change(b);assert.throws(()=>reconstruct(b),/ADVISORY_PROOF_INVALID/);}
 const p=proof(original);assert.throws(()=>reconstruct(original,{...p,recordedCallers:null}),/ADVISORY_PROOF_INVALID/);
});

test('capture provenance cannot supply entry features, baseline, observations, semantic, shared, social or other advisory metrics',async()=>{
 const b=await collect(JSON.stringify(classified(await fixture()))),dir=mkdtempSync(join(tmpdir(),'recorded-exclusivity-')),service=new Service(join(dir,'test.sqlite'));
 try{
 const cases:Array<(b:Run)=>void>=[x=>{x.features[0]!.evidenceIds.push(CAP);},x=>{x.details!.baseline[0]!.evidenceIds.push(CAP);},x=>{x.semantic.claims.push({claim:'invalid',evidenceId:CAP} as any);},x=>{x.details!.advisory!.metrics.find(m=>m.id==='O21')!.evidenceIds.push(CAP);}];
 for(const mutate of cases){const x=structuredClone(b);mutate(x);assert.throws(()=>service.analyzeLive(x),/ADVISORY_PROOF_INVALID|invalid|Invalid/);}
 const changed=structuredClone(b);changed.details!.advisory!.metrics.find(m=>m.id==='A21')!.data={forged:true};assert.throws(()=>service.analyzeLive(changed),/ADVISORY_PROOF_INVALID/);
 }finally{service.close();rmSync(dir,{recursive:true,force:true});}
});

test('explicit capture without qualification keeps four rows unresolved; early option gates perform zero reads',async()=>{
 const b=await collect(JSON.stringify(await fixture()));assert.ok(b.details!.advisory!.metrics.filter(m=>['S07','S09','A21','A23'].includes(m.id)).every(m=>m.quality==='MISSING'));
 let reads=0;const fetcher=(async()=>{reads++;throw Error('Unexpected read');}) as typeof fetch;
 await assert.rejects(collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:false,recordedCallersCapture:'{}',fetcher}),/RECORDED_CALLER_ADVISORY_REQUIRED/);
 await assert.rejects(collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,recordedCallersCapture:'{}',fetcher}),/RECORDED_CALLER_CAPTURE_INVALID/);assert.equal(reads,0);
});

test('CLI exact strict UTF8 capture path saves/replays; wrong modes, oversized and malformed inputs reject',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'recorded-callers-cli-')),file=join(dir,'capture.json'),db=join(dir,'cli.sqlite');let out='',err='';
 const run=(args:string[])=>runCli(args,{env:{},fetcher:a29LiveFetcher(token.address,CUT),now:()=>CUT,isInteractive:false,stdout:s=>{out+=s;},stderr:s=>{err+=s;}});
 try{writeFileSync(file,JSON.stringify(classified(await fixture()))+' '.repeat(2_000_001));assert.equal(await run(['analyze',token.address,'--partial','--advisory','--recorded-callers-capture',file,'--db',db,'--json']),0,err);const saved=JSON.parse(out);assert.equal(saved.details.advisory.method,'advisory-measurements-v40');out='';assert.equal(await run(['replay',saved.id,'--db',db,'--json']),0,err);assert.deepEqual(JSON.parse(out),saved);
 for(const args of [['analyze',token.address,'--partial'],['reassess','id'],['analyze',token.address,'--bundle',file]]){out='';err='';assert.notEqual(await run([...args,'--recorded-callers-capture',file,'--db',db,'--json']),0);}
 writeFileSync(file,Buffer.from([0xc3,0x28]));err='';assert.notEqual(await run(['analyze',token.address,'--partial','--advisory','--recorded-callers-capture',file,'--db',db,'--json']),0);assert.match(err,/RECORDED_CALLER_CAPTURE_INVALID/);
 writeFileSync(file,' '.repeat(8_388_609));err='';assert.notEqual(await run(['analyze',token.address,'--partial','--advisory','--recorded-callers-capture',file,'--db',db,'--json']),0);assert.match(err,/FILE_TOO_LARGE/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('grouped entry preserves sharedv4 policy precedence while caller proof41/facts40 retain the imported historical metrics',async()=>{
 const raw=JSON.stringify(classified(await fixture()));
 const bundle=await collectLiveToken(token,{profile:starterProfile(),semanticEnabled:true,advisoryEnabled:true,recordedCallersCapture:raw,fetcher:a29LiveFetcher(token.address,CUT),now:()=>CUT});
 assert.ok(bundle.details!.groups);assert.equal(proof(bundle).method,'advisory-provenance-v41');assert.equal(bundle.details!.advisory!.method,'advisory-measurements-v40');
 const dir=mkdtempSync(join(tmpdir(),'recorded-callers-grouped-')),file=join(dir,'test.sqlite'),service=new Service(file);
 try{const saved=service.analyzeLive(bundle);assert.deepEqual(service.replay(saved.id),saved);const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string).policyVersion,'research-screen-shared-v4');}finally{db.close();}}finally{service.close();rmSync(dir,{recursive:true,force:true});}
});

test('independent rejection of one relevant field leaves unrelated historical metrics measured',async()=>{
 for(const [field,missing] of [['event',['S07','S09']],['topic',['A23']],['category',['A21']],['binding',['S07','S09','A21','A23']],['complete',['S07','S09','A21','A23']]] as const){
  const c=classified(await fixture()),review=JSON.parse(c.qualification!.review.response);review.sources[0][field]=false;c.qualification!.review.response=JSON.stringify(review);c.qualification!.review.execution.responseSha256=sha(c.qualification!.review.response);
  const b=await collect(JSON.stringify(c)),rows=b.details!.advisory!.metrics.filter(m=>['S07','S09','A21','A23'].includes(m.id));for(const row of rows)assert.equal(row.quality,(missing as readonly string[]).includes(row.id)?'MISSING':'KNOWN',`${field}:${row.id}`);
 }
});
