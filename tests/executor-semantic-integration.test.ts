import { decodeExecutorSocialBodies, EXECUTOR_SOCIAL_BODIES_METHOD } from '../src/providers/executor-social-bodies.js';
import { DatabaseSync } from 'node:sqlite';
import { reconstructAdvisory } from '../src/app/advisory.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectLiveToken } from '../src/app/live.js';
import { Service } from '../src/app/service.js';
import { starterProfile } from '../src/app/config.js';
import { runCli } from '../src/cli.js';
import { EXECUTOR_SEMANTIC_METHOD, qualifyExecutorSemantic, EXECUTOR_SEMANTIC_METHOD_V2, EXECUTOR_SEMANTIC_METHOD_V3, EXECUTOR_SEMANTIC_METRIC_IDS, EXECUTOR_SEMANTIC_TRUST, validateExecutorSemantic, type SemanticExecutor } from '../src/providers/executor-semantic.js';
import { a29LiveFetcher } from './a29-fixtures.js';

/** Offline only: TinyFish Search/Fetch are synthetic, every other read is the shared public a29 fixture (which throws on unknown hosts), and the executor never classifies. */
const MINT = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump', token = { chain: 'solana' as const, address: MINT };
const AT = '2026-10-20T12:00:00.000Z', CAPTURE = 'advisory-executor-capture', ACQUISITION = 'advisory-executor-acquisition', BODIES='advisory-executor-bodies', PROOF = /ADVISORY_PROOF_INVALID/;
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const idAt = (iso: string) => String(((BigInt(Date.parse(iso)) - 1288834974657n) << 22n) + 1n);
/** Two current, complete synthetic X posts naming the exact mint, each with its author URL and a published_date minutes before the run. */
const posts = ([['alpha_watch', 8], ['beta_watch', 4]] as const).map(([handle, minutes]) => {
  const createdAt = new Date(Date.parse(AT) - minutes * 60_000).toISOString(), id = idAt(createdAt);
  return { url: `https://x.com/${handle}/status/${id}`, createdAt, text: `Watching ${MINT} on PumpSwap right now, posted by @${handle}.` };
});
type Call = Pick<Parameters<SemanticExecutor>[0], 'protocol' | 'stage' | 'executor'>;
type Bundle = Awaited<ReturnType<typeof collectLiveToken>>;
type Loose = Record<string, any>;

async function collect() {
  let tick = 0;
  const hosts: string[] = [], calls: Call[] = [], base = a29LiveFetcher(MINT, AT);
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); hosts.push(new URL(url).host);
    if(['publish.twitter.com','cdn.syndication.twimg.com','api.fxtwitter.com'].includes(new URL(url).host))return new Response('{}',{status:404});
    if (url.startsWith('https://api.search.tinyfish.ai/')) return json({ results: posts.map(p => ({ url: p.url, title: 'Synthetic post', snippet: p.text })) });
    if (url.startsWith('https://api.fetch.tinyfish.ai/')) {
      const urls = (JSON.parse(String(init?.body)).urls ?? []) as string[];
      return json({ results: urls.map(u => { const p = posts.find(x => x.url === u); return { url: u, final_url: u, text: p ? p.text : `Synthetic page naming ${MINT}.`, ...(p ? { published_date: p.createdAt } : {}) }; }), errors: [] });
    }
    return base(input, init);
  };
  // The synthetic harness always throws: each pair keeps one audited CALL_FAILED proposal and no review, so nothing positive is forced.
  const semanticExecutor: SemanticExecutor = async ({ protocol, stage, executor }) => { calls.push({ protocol, stage, executor }); throw new Error('synthetic executor offline'); };
  const bundle = await collectLiveToken(token, { profile: starterProfile(), semanticEnabled: false, advisoryEnabled: true, tinyfishKey: 'tinyfish-fixture-key', semanticExecutor, fetcher, now: () => new Date(Date.parse(AT) + tick++).toISOString() });
  return { bundle, calls, hosts };
}
let pending: ReturnType<typeof collect> | undefined;
const live = () => (pending ??= collect());
const record = (b: Loose, id: string) => (b.evidence as Loose[]).find(e => e.id === id)!;
const hashed = (b: Loose, id: string) => String(record(b, id).contentHash).endsWith(sha(b.rawArtifacts[id]));
/** Recomputes a record's content hash in its existing format so only the deeper binding can reject the mutation. */
const rehash = (b: Loose, id: string) => { const r = record(b, id); r.contentHash = String(r.contentHash).slice(0, -64) + sha(b.rawArtifacts[id]); };
const proofOf = (b: Loose) => JSON.parse(b.rawArtifacts['advisory-derivation']);
const setProof = (b: Loose, proof: unknown) => { b.rawArtifacts['advisory-derivation'] = JSON.stringify(proof); rehash(b, 'advisory-derivation'); };
function withDir(fn: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'executor-semantic-'));
  try { fn(join(dir, 'live.sqlite')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('executor mode freezes a v45 proof with audited CALL_FAILED proposals, inline source provenance and quarantined advisory rows', async () => {
  const { bundle, calls, hosts } = await live(), b = bundle as Loose;
  assert.ok(!hosts.some(h => h.includes('generativelanguage')), 'no hosted model in executor mode');
  assert.deepEqual(bundle.collection.web,{state:'OBSERVED',count:posts.length},'successful nonempty TinyFish attention acquisition is reported as observed');
  assert.ok(calls.length > 0 && calls.every(c => c.stage === 'proposal'), 'failed proposals never reach a review');
  assert.deepEqual([...new Set(calls.map(c => `${c.protocol}:${c.executor}`))].sort(), ['executor-advisory-v3:CLAUDE_CODE', 'executor-social-v3:CODEX']);
  const proof = proofOf(b), d = proof.executorSemantic;
  assert.equal(proof.method, 'advisory-provenance-v45');
  assert.deepEqual([d.captureId, d.acquisitionId], [CAPTURE, ACQUISITION]);
  const raw = b.rawArtifacts[CAPTURE] as string, capture = JSON.parse(raw), r = record(b, CAPTURE);
  assert.equal(capture.method, EXECUTOR_SEMANTIC_METHOD_V3);
  assert.deepEqual([r.sourceId, r.sourceType, r.accessMode, r.availableAt], ['advisory-executor', 'MODEL_EXECUTION', 'USER_IMPORT', r.retrievedAt]);
  assert.ok(hashed(b, CAPTURE) && hashed(b, ACQUISITION));
  for (const name of ['socialProposal', 'advisoryProposal']) {
    const s = capture.stages[name];
    assert.deepEqual([s.failure, s.response, s.receipt.executionId, s.receipt.responseSha256, s.receipt.promptSha256], ['CALL_FAILED', null, null, null, sha(s.packet)], name);
  }
  assert.deepEqual([capture.stages.socialReview, capture.stages.advisoryReview], [null, null]);
  const v = validateExecutorSemantic(raw, token, r.availableAt);
  assert.deepEqual([v.proposal, v.review, v.semantic], [null, null, null]);
  for (const code of ['EXEC_SEMANTIC_SOCIAL_CALL_FAILED', 'EXEC_SEMANTIC_ADVISORY_CALL_FAILED']) assert.ok(v.codes.includes(code), code);
  // Strict source provenance: every frozen source is its own advisory-executor-input record with the exact body bytes.
  const sources = capture.read.sources as Loose[];
  assert.ok(sources.some(s => s.kind === 'POST' && s.text.includes(MINT)), 'a current post naming the exact mint is frozen');
  assert.deepEqual(d.sourceIds, sources.map(s => `advisory-executor-source-${s.id}`));
  for (const s of sources) {
    const id = `advisory-executor-source-${s.id}`, e = record(b, id);
    assert.deepEqual([e.sourceId, e.sourceType, e.accessMode, e.availableAt, e.retrievedAt, b.rawArtifacts[id]], ['advisory-executor-input', 'WEB_PAGE', 'FREE_ACCOUNT', s.availableAt, s.availableAt, s.text]);
    assert.ok(hashed(b, id)); assert.deepEqual(e.scope, { url: s.url, publishedAt: s.publishedAt, authorId: s.authorId, kind: s.kind });
  }
  assert.equal(d.bodyCaptureId,BODIES);assert.ok(hashed(b,BODIES));const bodies=decodeExecutorSocialBodies(b.rawArtifacts[BODIES],token,r.availableAt);assert.deepEqual(bodies.read,capture.read);assert.equal(bodies.read.sampleComplete,false,'failed strict current-body witnesses cannot certify a complete corpus');assert.equal(record(b,BODIES).adapterVersion,EXECUTOR_SOCIAL_BODIES_METHOD);assert.deepEqual(bodies.bodyBySourceId,{});assert.deepEqual(bodies.read.targetPostIds,bodies.originalRead.targetPostIds);for(const host of ['publish.twitter.com','cdn.syndication.twimg.com','api.fxtwitter.com'])assert.equal(hosts.filter(h=>h===host).length,posts.length,'all current posts need every strict triplet provider');
  const acquisition = JSON.parse(b.rawArtifacts[ACQUISITION]);
  assert.ok(acquisition.attention && typeof acquisition.social['social-acquisition-scope'] === 'string', 'raw acquisition bytes are retained');
  const owned = new Set((b.evidence as Loose[]).filter(e => e.id.startsWith('advisory-executor-')).map(e => e.id as string));
  assert.deepEqual([...owned].sort(), [CAPTURE, ACQUISITION, BODIES,...d.sourceIds].sort());
  // No executor reference reaches entry features, baseline or shared state.
  const { rawArtifacts: _raw, evidence: _evidence, details: _details, ...entry } = b;
  assert.ok(!JSON.stringify(entry).includes('advisory-executor'));
  for (const m of (b.details.advisory.metrics as Loose[]).filter(m => m.evidenceIds.some((id: string) => owned.has(id)))) {
    assert.ok(EXECUTOR_SEMANTIC_METRIC_IDS.includes(m.id), m.id);
    assert.ok(m.evidenceIds.includes(CAPTURE)); assert.ok(m.evidenceIds.every((id:string)=>id===CAPTURE||(m.id==='A22'&&id.startsWith('advisory-paid-'))));
    const c = m.data.executorClassification;
    assert.deepEqual([c.method, c.trust, c.qualifiedAt], [EXECUTOR_SEMANTIC_METHOD_V3, EXECUTOR_SEMANTIC_TRUST, null]);
    assert.ok(Object.values(c.executionIds).every(x => x === null));
  }
});

test('the executor bundle saves, replays, reopens and re-analyzes identically without entry authority', async () => {
  const { bundle } = await live();
  withDir(file => {
    let s = new Service(file), saved!: ReturnType<Service['analyzeLive']>, shown!: ReturnType<Service['show']>;
    try {
      saved = s.analyzeLive(structuredClone(bundle)); shown = s.show(saved.id);
      assert.deepEqual(s.replay(saved.id), shown);
      assert.deepEqual(s.analyzeLive(structuredClone(bundle)).result, saved.result);
      const text = JSON.stringify(saved);
      assert.equal(saved.details!.advisory!.method,'advisory-measurements-v44'); const db=new DatabaseSync(file);try{assert.equal(JSON.parse((db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id) as {semantic:string}).semantic).policyVersion,'research-screen-advisory-v42');}finally{db.close();} assert.deepEqual(reconstructAdvisory(bundle.token,bundle.cutoff,bundle.details!.baseline,bundle.evidence,bundle.rawArtifacts,proofOf(bundle),bundle.thesis??null,bundle.features),bundle.details!.advisory);
      assert.deepEqual(((saved as Loose).result?.checks??[]).filter((c:Loose)=>!c.checkId.startsWith('ADV-')&&JSON.stringify(c).includes('advisory-executor')).map((c:Loose)=>({checkId:c.checkId,id:c.id,status:c.status,evidenceIds:c.evidenceIds})),[]);
    } finally { s.close(); }
    s = new Service(file);
    try { assert.deepEqual(s.show(saved.id), shown); assert.deepEqual(s.replay(saved.id), shown); } finally { s.close(); }
  });
});

// Each mutation runs on its own cloned bundle; outer hashes are recomputed so the inner binding is what rejects.
const mutations: [string, (b: Loose) => void, RegExp | undefined][] = [
  ['an orphan advisory-executor namespace artifact', b => { b.rawArtifacts['advisory-executor-orphan'] = '{}'; }, /UNREFERENCED_ARTIFACT/],
  ['a descriptor downgraded to v44 while capture metadata remains v3',b=>{const p=proofOf(b);p.method='advisory-provenance-v44';setProof(b,p);},PROOF],
  ['a capture raw method changed to v2 without its record metadata',b=>{const c=JSON.parse(b.rawArtifacts[CAPTURE]);c.method=EXECUTOR_SEMANTIC_METHOD_V2;b.rawArtifacts[CAPTURE]=JSON.stringify(c);rehash(b,CAPTURE);},PROOF],
  ['a descriptor downgraded to v42 with a rehashed derivation', b => { const p = proofOf(b); p.method = 'advisory-provenance-v42'; delete p.executorSemantic; setProof(b, p); }, PROOF],
  ['a v45 descriptor with its body capture member removed',b=>{const p=proofOf(b);delete p.executorSemantic.bodyCaptureId;setProof(b,p);},PROOF],
  ['a body capture method mismatch',b=>{record(b,BODIES).scope={method:'not-the-body-codec'};},PROOF],
  ['a body original source text changed beneath rehashed capture',b=>{const c=JSON.parse(b.rawArtifacts[BODIES]);c.original.sources[0].text+=' changed';b.rawArtifacts[BODIES]=JSON.stringify(c);rehash(b,BODIES);},PROOF],
  ['a semantic native body map forged beneath rehashed capture',b=>{const c=JSON.parse(b.rawArtifacts[CAPTURE]);c.bodyBySourceId={[c.read.sources[0].id]:'forged native body'};b.rawArtifacts[CAPTURE]=JSON.stringify(c);rehash(b,CAPTURE);},PROOF],
  ['a body capture hash mismatch',b=>{b.rawArtifacts[BODIES]+=' ';},/ARTIFACT_HASH_OR_SIZE/],
  ['executor capture evidence inserted into an entry feature',b=>{assert.ok(b.features.length);b.features[0].evidenceIds.push(CAPTURE);},PROOF],
  ['a null v45 descriptor beside owned records', b => { const p = proofOf(b); p.executorSemantic = null; setProof(b, p); }, PROOF],
  ['a capture raw hash mismatch', b => { record(b, CAPTURE).contentHash = String(record(b, CAPTURE).contentHash).slice(0, -64) + sha('tampered'); }, /ARTIFACT_HASH_OR_SIZE/],
  ['a capture clock moved past the cutoff', b => { const r = record(b, CAPTURE), later = new Date(Date.parse(r.availableAt) + 86_400_000).toISOString(); r.availableAt = later; r.retrievedAt = later; }, /FUTURE_EVIDENCE/],
  ['a capture.read source body tamper with a recalculated outer hash', b => { const c = JSON.parse(b.rawArtifacts[CAPTURE]); assert.ok(c.read.sources.length); c.read.sources[0].text += ' tampered'; b.rawArtifacts[CAPTURE] = JSON.stringify(c); rehash(b, CAPTURE); }, PROOF],
  // An acquisition body tamper may already fail proof parsing outside the executor branch, so any rejection is accepted.
  ['an acquisition body tamper with a recalculated hash', b => { const a = JSON.parse(b.rawArtifacts[ACQUISITION]); a.social['social-acquisition-scope'] = JSON.stringify({ read: { sources: [] } }); b.rawArtifacts[ACQUISITION] = JSON.stringify(a); rehash(b, ACQUISITION); }, undefined],
];
for (const [name, mutate, code] of mutations) test(`rejects ${name}`, async () => {
  const b = structuredClone((await live()).bundle) as Loose;
  mutate(b);
  withDir(file => { const s = new Service(file); try { assert.throws(() => s.analyzeLive(b as Bundle), code ?? Error); } finally { s.close(); } });
});

test('direct LiveOptions guards fail before any read or executor call', async () => {
  let fetched = 0, called = 0;
  const fetcher: typeof fetch = async () => { fetched++; throw new Error('fetch denied'); };
  const semanticExecutor: SemanticExecutor = async () => { called++; throw new Error('executor denied'); };
  const base = { profile: starterProfile(), advisoryEnabled: true, semanticEnabled: false, tinyfishKey: 'k', semanticExecutor, fetcher, now: () => AT };
  await assert.rejects(collectLiveToken(token, { ...base, semanticEnabled: true }), /ADVISORY_EXECUTOR_MODE_REQUIRED/);
  await assert.rejects(collectLiveToken(token, { ...base, advisoryEnabled: false }), /ADVISORY_EXECUTOR_MODE_REQUIRED/);
  const { tinyfishKey: _key, ...keyless } = base;
  await assert.rejects(collectLiveToken(token, keyless), /TINYFISH_KEY_MISSING/);
  assert.deepEqual([fetched, called], [0, 0]);
});

test('runCli exits 2 for invalid executor modes and a missing key before fetch, DB or config', async () => {
  const cases: [string[], Record<string, string>, string][] = [
    [['--partial', '--advisory', '--advisory-executor', '--creator-history'], { TINYFISH_API_KEY: 'k' }, 'ADVISORY_EXECUTOR_MODE_REQUIRED'],
    [['--advisory', '--advisory-executor'], { TINYFISH_API_KEY: 'k' }, 'ADVISORY_EXECUTOR_MODE_REQUIRED'],
    [['--partial', '--advisory-executor'], { TINYFISH_API_KEY: 'k' }, 'ADVISORY_EXECUTOR_MODE_REQUIRED'],
    [['--bundle', '/nonexistent/bundle.json', '--advisory-executor'], { TINYFISH_API_KEY: 'k' }, 'ADVISORY_EXECUTOR_MODE_REQUIRED'],
    [['--partial', '--advisory', '--advisory-executor'], {}, 'TINYFISH_KEY_MISSING'],
  ];
  for (const [flags, keys, code] of cases) {
    const home = mkdtempSync(join(tmpdir(), 'executor-cli-')), out: string[] = [];
    let fetched = 0, called = 0;
    try {
      const exit = await runCli(['analyze', MINT, ...flags,'--db',join(home,'live.sqlite'),'--config',join(home,'config.json')], { env: keys, isInteractive: false,
        fetcher: async () => { fetched++; throw new Error('fetch denied'); }, semanticExecutor: async () => { called++; throw new Error('executor denied'); },
        stdout: t => { out.push(t); }, stderr: t => { out.push(t); } });
      assert.equal(exit, 2, flags.join(' '));
      assert.match(out.join(''), new RegExp(code));
      assert.deepEqual([fetched, called, readdirSync(home).length], [0, 0, 0], flags.join(' '));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

// Replay through the production CLI adapter with an explicitly denied network and executor.
test('production CLI replay is offline and returns the same immutable executor snapshot',async()=>{
 const {bundle}=await live(),dir=mkdtempSync(join(tmpdir(),'executor-offline-cli-')),file=join(dir,'live.sqlite');
 try{const service=new Service(file);let snapshot;try{snapshot=service.analyzeLive(bundle);}finally{service.close();}
 let output='',errors='',network=0,executions=0;const exit=await runCli(['replay',snapshot.id,'--db',file,'--config',join(dir,'config.json'),'--json'],{env:{},isInteractive:false,fetcher:async()=>{network++;throw Error('OFFLINE_NETWORK_DENIED');},semanticExecutor:async()=>{executions++;throw Error('OFFLINE_EXECUTOR_DENIED');},stdout:s=>{output+=s},stderr:s=>{errors+=s}});
 assert.equal(exit,0,errors);assert.deepEqual(JSON.parse(output),snapshot);assert.deepEqual([network,executions],[0,0]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

// Legacy v1 capture and proof43 remain reconstructible after the live producer advances.
test('portable proof43 v1 failure capture preserves frozen facts42 and policy40 replay',async()=>{
 const b=structuredClone((await live()).bundle) as Loose,p=proofOf(b),body=decodeExecutorSocialBodies(b.rawArtifacts[BODIES],token,b.cutoff);
 const old=await qualifyExecutorSemantic(body.originalRead,token,async()=>{throw Error('offline legacy failure')},()=>b.cutoff,new AbortController().signal);
 b.rawArtifacts[CAPTURE]=old.capture;const captureRecord=record(b,CAPTURE);captureRecord.adapterVersion=EXECUTOR_SEMANTIC_METHOD;captureRecord.scope={method:EXECUTOR_SEMANTIC_METHOD};captureRecord.retrievedAt=captureRecord.availableAt=b.cutoff;rehash(b,CAPTURE);
 record(b,ACQUISITION).adapterVersion=EXECUTOR_SEMANTIC_METHOD;b.evidence=b.evidence.filter((e:Loose)=>e.id!==BODIES);delete b.rawArtifacts[BODIES];p.method='advisory-provenance-v43';delete p.executorSemantic.bodyCaptureId;setProof(b,p);record(b,'advisory-derivation').scope={method:p.method};
 b.details.advisory=reconstructAdvisory(b.token,b.cutoff,b.details.baseline,b.evidence,b.rawArtifacts,p,b.thesis??null,b.features);assert.equal(b.details.advisory.method,'advisory-measurements-v42');
 withDir(file=>{const service=new Service(file);try{const saved=service.analyzeLive(b as Bundle);assert.deepEqual(service.replay(saved.id),saved);assert.equal(service.analyzeLive(b as Bundle).id,saved.id);const db=new DatabaseSync(file);try{assert.equal(JSON.parse((db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id) as {semantic:string}).semantic).policyVersion,'research-screen-advisory-v40');}finally{db.close();}}finally{service.close();}});
});

// V2 wire/capture/replay stays available, while raw methods cannot cross newer record metadata.
test('portable proof44 v2 failure capture preserves facts43 policy41 and cannot cross proof45 metadata',async()=>{
 const b=structuredClone((await live()).bundle) as Loose,p=proofOf(b),body=decodeExecutorSocialBodies(b.rawArtifacts[BODIES],token,b.cutoff);
 const old=await qualifyExecutorSemantic(body.read,token,async()=>{throw Error('offline v2 failure')},()=>b.cutoff,new AbortController().signal,{wire:'v2',bodyBySourceId:body.bodyBySourceId});
 assert.equal(JSON.parse(old.capture).method,EXECUTOR_SEMANTIC_METHOD_V2);b.rawArtifacts[CAPTURE]=old.capture;rehash(b,CAPTURE);
 const cross=structuredClone(b);record(cross,CAPTURE).retrievedAt=record(cross,CAPTURE).availableAt=cross.cutoff;withDir(file=>{const service=new Service(file);try{assert.throws(()=>service.analyzeLive(cross as Bundle),PROOF);}finally{service.close();}});
 const e=record(b,CAPTURE);e.adapterVersion=EXECUTOR_SEMANTIC_METHOD_V2;e.scope={method:EXECUTOR_SEMANTIC_METHOD_V2};e.retrievedAt=e.availableAt=b.cutoff;record(b,ACQUISITION).adapterVersion=EXECUTOR_SEMANTIC_METHOD_V2;p.method='advisory-provenance-v44';setProof(b,p);record(b,'advisory-derivation').scope={method:p.method};
 b.details.advisory=reconstructAdvisory(b.token,b.cutoff,b.details.baseline,b.evidence,b.rawArtifacts,p,b.thesis??null,b.features);assert.equal(b.details.advisory.method,'advisory-measurements-v43');
 withDir(file=>{const service=new Service(file);try{const saved=service.analyzeLive(b as Bundle);assert.deepEqual(service.replay(saved.id),saved);assert.equal(service.analyzeLive(b as Bundle).id,saved.id);const db=new DatabaseSync(file);try{assert.equal(JSON.parse((db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id) as {semantic:string}).semantic).policyVersion,'research-screen-advisory-v41');}finally{db.close();}}finally{service.close();}});
});

import { source as recordedCallerSource, classify as recordedIncentiveClassify } from './recorded-incentive-fixtures.js';

// Unavailable TinyFish corpora (HTTP 200 empty results vs HTTP 403) persist a deterministic v3 MISSING capture with no inference; recorded historical fixtures stay authoritative.
type Unavailable = 'EMPTY_200' | 'FORBIDDEN_403' | 'BASELINE';
const unavailableRuns = new Map<Unavailable, Promise<{ bundle: Bundle; executions: number; hosts: string[] }>>();
async function collectUnavailableOnce(mode: Unavailable) {
  let tick = 0, executions = 0;
  const hosts: string[] = [], base = a29LiveFetcher(MINT, AT), callers = JSON.stringify(await recordedCallerSource());
  // Constructed historical fixture (2026-10-12, before AT); same token, never actual provider or model evidence.
  const incentives = JSON.stringify(recordedIncentiveClassify(callers));
  const fetcher: typeof fetch = async (input, init) => {
    const host = new URL(String(input)).host; hosts.push(host);
    if (['publish.twitter.com', 'cdn.syndication.twimg.com', 'api.fxtwitter.com'].includes(host)) return new Response('{}', { status: 404 });
    // 403 rather than 503 so no retry policy can mask the failure.
    if (host === 'api.search.tinyfish.ai' || host === 'api.fetch.tinyfish.ai') return mode === 'FORBIDDEN_403'
      ? new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } })
      : json(host === 'api.fetch.tinyfish.ai' ? { results: [], errors: [] } : { results: [] });
    return base(input, init);
  };
  const semanticExecutor: SemanticExecutor = async () => { executions++; throw new Error('executor must not run on an unavailable corpus'); };
  const options = { profile: starterProfile(), semanticEnabled: false, advisoryEnabled: true, tinyfishKey: 'tinyfish-fixture-key', fetcher, now: () => new Date(Date.parse(AT) + tick++).toISOString(),
    recordedCallersCapture: callers, recordedIncentivesCapture: incentives, ...(mode === 'BASELINE' ? {} : { semanticExecutor }) };
  const bundle = await collectLiveToken(token, options);
  return { bundle, executions, hosts };
}
const unavailable = (mode: Unavailable) => { let p = unavailableRuns.get(mode); if (!p) unavailableRuns.set(mode, p = collectUnavailableOnce(mode)); return p; };
const unrelated = (metrics: Loose[]) => Object.fromEntries(metrics.filter(m => !EXECUTOR_SEMANTIC_METRIC_IDS.includes(m.id)).map(m => [m.id, m.quality]));

for (const mode of ['EMPTY_200', 'FORBIDDEN_403'] as const) test(`v3 ${mode} unavailable corpus persists deterministic MISSING without inference or authority loss`, async () => {
  const { bundle, executions, hosts } = await unavailable(mode), b = bundle as Loose, baseline = (await unavailable('BASELINE')).bundle as Loose;
  assert.equal(executions, 0, 'no executor call on an unavailable corpus');
  assert.ok(hosts.includes('api.search.tinyfish.ai'), 'TinyFish search was attempted');
  assert.ok(!hosts.some(h => h.includes('generativelanguage')), 'no hosted model in executor mode');
  const proof = proofOf(b), d = proof.executorSemantic, raw = b.rawArtifacts[CAPTURE] as string, capture = JSON.parse(raw), r = record(b, CAPTURE);
  assert.equal(proof.method, 'advisory-provenance-v45');
  assert.equal(bundle.collection.web.state, mode === 'EMPTY_200' ? 'NO_RESULTS' : 'UNAVAILABLE');
  const acquisition = JSON.parse(b.rawArtifacts[ACQUISITION]);
  const outcomes = JSON.parse(acquisition.attention['attention-http-outcomes']).outcomes;
  assert.ok(outcomes.length > 0 && outcomes.every((o: Loose) => o.status === (mode === 'EMPTY_200' ? 200 : 403)), 'original acquisition HTTP outcomes survive');
  if (mode === 'EMPTY_200') assert.deepEqual(JSON.parse(acquisition.attention['attention-search-1']).results, []);
  for (const id of ['advisory-recorded-callers-capture', 'advisory-recorded-incentives-capture']) assert.equal(b.rawArtifacts[id], baseline.rawArtifacts[id], 'historical import bytes stay exact');
  assert.deepEqual([d.captureId, d.acquisitionId, d.bodyCaptureId], [CAPTURE, ACQUISITION, BODIES]);
  for (const id of [CAPTURE, ACQUISITION, BODIES]) assert.ok(typeof b.rawArtifacts[id] === 'string' && hashed(b, id), `${id} retained and hash-valid`);
  assert.equal(capture.method, EXECUTOR_SEMANTIC_METHOD_V3);
  assert.deepEqual(Object.values(capture.stages), [null, null, null, null], 'no stage is invented for an unavailable corpus');
  const v = validateExecutorSemantic(raw, token, r.availableAt);
  assert.deepEqual([v.proposal, v.review, v.semantic], [null, null, null]);
  assert.deepEqual(v.codes, ['EXEC_SEMANTIC_CORPUS_UNAVAILABLE'], 'deterministic bounded diagnostic');
  assert.deepEqual(validateExecutorSemantic(raw, token, r.availableAt), v, 'replay is deterministic');
  const metrics = b.details.advisory.metrics as Loose[], baseMetrics = baseline.details.advisory.metrics as Loose[];
  assert.equal(metrics.filter(m => m.evidenceIds.includes(CAPTURE) && m.quality === 'KNOWN').length, 0, 'no executor-backed KNOWN row');
  assert.ok(Object.values(unrelated(baseMetrics)).includes('KNOWN'), 'baseline carries known market metrics');
  assert.deepEqual(unrelated(metrics), unrelated(baseMetrics), 'unrelated metrics match the ordinary baseline');
  const s08 = metrics.find(m => m.id === 'S08');
  assert.equal(s08?.quality, 'KNOWN', 'historical recorded S08 is preserved'); assert.ok(!s08!.evidenceIds.includes(CAPTURE));
  assert.equal(baseMetrics.find(m => m.id === 'S08')?.quality, 'KNOWN');
  assert.deepEqual(reconstructAdvisory(b.token, b.cutoff, b.details.baseline, b.evidence, b.rawArtifacts, proof, b.thesis ?? null, b.features), b.details.advisory);
  const dir = mkdtempSync(join(tmpdir(), 'executor-unavailable-')), file = join(dir, 'live.sqlite');
  try {
    let s = new Service(file), saved!: ReturnType<Service['analyzeLive']>, shown!: ReturnType<Service['show']>;
    try {
      saved = s.analyzeLive(structuredClone(bundle)); shown = s.show(saved.id);
      assert.deepEqual(s.replay(saved.id), shown);
      const again = s.analyzeLive(structuredClone(bundle)); assert.deepEqual([again.id, again.result], [saved.id, saved.result]);
    } finally { s.close(); }
    s = new Service(file);
    try { assert.deepEqual(s.show(saved.id), shown); assert.deepEqual(s.replay(saved.id), shown); } finally { s.close(); }
    let out = '', err = '', network = 0, calls = 0;
    const exit = await runCli(['replay', saved.id, '--db', file, '--config', join(dir, 'config.json'), '--json'], { env: {}, isInteractive: false,
      fetcher: async () => { network++; throw Error('OFFLINE_NETWORK_DENIED'); }, semanticExecutor: async () => { calls++; throw Error('OFFLINE_EXECUTOR_DENIED'); },
      stdout: t => { out += t; }, stderr: t => { err += t; } });
    assert.equal(exit, 0, err); assert.deepEqual(JSON.parse(out), saved); assert.deepEqual([network, calls], [0, 0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Optional deep tamper: a fabricated stage beneath a rehashed unavailable capture must not become an audited execution.
test('rejects a fabricated stage injected into a rehashed v3 unavailable capture', async () => {
  const b = structuredClone((await unavailable('FORBIDDEN_403')).bundle) as Loose, c = JSON.parse(b.rawArtifacts[CAPTURE]), packet = 'fabricated packet', at = record(b, CAPTURE).availableAt;
  c.stages.socialProposal = { packet, response: null, receipt: { executor: 'CODEX', executionId: null, modelId: null, modelIdSource: null, startedAt: at, finishedAt: at, promptSha256: sha(packet), responseSha256: null, tools: 'NONE', freshSession: true }, failure: 'CALL_FAILED' };
  b.rawArtifacts[CAPTURE] = JSON.stringify(c); rehash(b, CAPTURE);
  withDir(file => { const s = new Service(file); try { assert.throws(() => s.analyzeLive(b as Bundle), PROOF); } finally { s.close(); } });
});
