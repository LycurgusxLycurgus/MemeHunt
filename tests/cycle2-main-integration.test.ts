import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectLiveToken } from '../src/app/live.js';
import { Service } from '../src/app/service.js';
import { starterProfile } from '../src/app/config.js';
import { runCli } from '../src/cli.js';
import { reconstructAdvisory, a29CaptureRequestV2, a29VerifiedV2Id, A29_V2_CAPTURE_ADAPTER, A29_CAPTURE_ID } from '../src/app/advisory.js';
import { decodeA29CaptureV2, deriveA29AbsorptionV2 } from '../src/providers/advisory-absorption-v2.js';
import { advisoryFactsSchema } from '../src/domain/advisory-contracts.js';
import { callerSeedFromEvidence, CALLER_SELECTION_ID } from '../src/providers/advisory-caller-measures.js';
import { decodeRecordedCallerCapture, type RecordedCallerCapture } from '../src/providers/advisory-recorded-callers.js';
import { validateExecutorSemantic, type SemanticExecutor } from '../src/providers/executor-semantic.js';
import { a29LiveFetcher } from './a29-fixtures.js';
import { buildA29CaptureV2 } from './a29-v2-integration-fixtures.js';
import { source as recordedCallerSource, token as fixtureToken } from './recorded-incentive-fixtures.js';

/** Offline only. The A29 v2 packet is the SYNTHETIC constructed WSOL capture: its KNOWN row is constructed zero activity, never a claim about real trading.
 * TinyFish search/fetch return successful EMPTY results, so the executor corpus is unavailable and must never be called. The caller import is the constructed
 * source-only fixture retargeted to the A29 mint; no classification or incentive fixture function is used. */
type Loose = Record<string, any>;
type Kind = 'ORDINARY' | 'EXECUTOR' | 'CALLERS';
const sha = (s: string) => createHash('sha256').update(s).digest('hex'), PROOF = /ADVISORY_PROOF_INVALID/, CAPTURE = 'advisory-executor-capture';
const TWITTER = ['publish.twitter.com', 'cdn.syndication.twimg.com', 'api.fxtwitter.com'];
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
const proofOf = (b: Loose) => JSON.parse(b.rawArtifacts['advisory-derivation']);
const rec = (b: Loose, id = A29_CAPTURE_ID) => (b.evidence as Loose[]).find(e => e.id === id)!;
const metric = (b: Loose) => (b.details.advisory.metrics as Loose[]).find(m => m.id === 'A29')!;
const rebuild = (b: Loose, p: unknown) => () => reconstructAdvisory(b.token, b.cutoff, b.details.baseline, b.evidence, b.rawArtifacts, p, b.thesis ?? null, b.features);
const cycle2 = (id: string) => id.startsWith('advisory-executor-') || id.startsWith('advisory-recorded-');
const policy = (file: string, id: string) => { const db = new DatabaseSync(file); try { return JSON.parse((db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(id) as { semantic: string }).semantic).policyVersion; } finally { db.close(); } };
function withDir<T>(fn: (dir: string, file: string) => T | Promise<T>) { const dir = mkdtempSync(join(tmpdir(), 'cycle2-main-')); return (async () => { try { return await fn(dir, join(dir, 'live.sqlite')); } finally { rmSync(dir, { recursive: true, force: true }); } })(); }

/** Retargets the constructed caller capture to the A29 mint: every raw string is remapped, the selection is regenerated (the scope bytes changed) and every seed hash recomputed. */
async function retarget(token: { chain: 'solana'; address: string }, cutoff: string) {
  const c = JSON.parse(JSON.stringify(await recordedCallerSource()).replaceAll(fixtureToken.address, token.address)) as RecordedCallerCapture;
  c.token = token;
  const selection = c.seed.evidence.find(e => e.id === CALLER_SELECTION_ID)!, { [CALLER_SELECTION_ID]: _old, ...raw } = c.seed.rawArtifacts;
  const seed = callerSeedFromEvidence(token, c.seed.evidence.filter(e => e.id !== CALLER_SELECTION_ID), raw, selection.availableAt); assert.ok(seed.selection);
  c.seed.rawArtifacts[CALLER_SELECTION_ID] = seed.raw;
  for (const e of c.seed.evidence) e.contentHash = sha(c.seed.rawArtifacts[e.id]!);
  const text = JSON.stringify(c); decodeRecordedCallerCapture(text, token, cutoff); return text;
}
const captures = new Map<number, ReturnType<typeof buildA29CaptureV2>>(), runs = new Map<string, Promise<Loose>>();
const capture = (pad: number) => { let p = captures.get(pad); if (!p) captures.set(pad, p = buildA29CaptureV2({ pad })); return p; };
async function collect(kind: Kind, pad: number) {
  const c = await capture(pad), token = { chain: 'solana' as const, address: c.token.address }, hosts: string[] = [], base = a29LiveFetcher(c.token.address, c.after);
  let tick = 0, executions = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const host = new URL(String(input)).host; hosts.push(host);
    if (TWITTER.includes(host)) return new Response('{}', { status: 404 });
    if (host === 'api.search.tinyfish.ai') return json({ results: [] });
    if (host === 'api.fetch.tinyfish.ai') return json({ results: [], errors: [] });
    return base(input, init);
  };
  const semanticExecutor: SemanticExecutor = async () => { executions++; throw new Error('no inference on an unavailable corpus'); };
  const callers = kind === 'CALLERS' ? await retarget(token, c.after) : undefined;
  const b = await collectLiveToken(token, { profile: starterProfile(), semanticEnabled: false, advisoryEnabled: true, fetcher, a29Capture: c.raw,
    now: () => kind === 'EXECUTOR' ? new Date(Date.parse(c.after) + tick++).toISOString() : c.after,
    ...(kind === 'EXECUTOR' ? { tinyfishKey: 'tinyfish-fixture-key', semanticExecutor } : {}), ...(callers ? { recordedCallersCapture: callers } : {}) });
  return { b: b as Loose, c, callers, hosts, executions: () => executions };
}
const live = (kind: Kind, pad = 0) => { const k = `${kind}:${pad}`; let p = runs.get(k); if (!p) runs.set(k, p = collect(kind, pad)); return p; };

for (const kind of ['EXECUTOR', 'CALLERS'] as const) test(`${kind} + synthetic A29 v2 freezes proof46/facts45/policy43 and replays offline`, async () => {
  const { b, c, callers, hosts, executions } = await live(kind), ord = (await live('ORDINARY')).b, proof = proofOf(b), r = rec(b);
  assert.deepEqual([proofOf(ord).method, ord.details.advisory.method], ['advisory-provenance-v40', 'advisory-measurements-v39'], 'ordinary uses accepted A29 recovery profile40');
  assert.deepEqual([proof.method, b.details.advisory.method], ['advisory-provenance-v46', 'advisory-measurements-v45']);
  assert.deepEqual([r.adapterVersion, b.rawArtifacts[A29_CAPTURE_ID], r.contentHash, r.retrievedAt], [A29_V2_CAPTURE_ADAPTER, c.raw, sha(c.raw), c.latestClock], 'exact original capture');
  assert.ok(Date.parse(r.retrievedAt) <= Date.parse(r.availableAt) && Date.parse(r.availableAt) <= Date.parse(b.cutoff));
  assert.deepEqual(proof.a29.requests.capture, a29CaptureRequestV2(c.raw, c.label));
  // Constructed zero activity: the full vector is re-derived from the synthetic packet; nothing about real activity is claimed.
  const x = decodeA29CaptureV2(c.raw);
  assert.deepEqual(metric(b), deriveA29AbsorptionV2(x.freeze, x.label, x.receipts, b.cutoff, [A29_CAPTURE_ID]));
  assert.equal(metric(b).quality, 'KNOWN'); assert.deepEqual(metric(b).data.vector, metric(ord).data.vector, 'every vector field survives the cycle2 composite');
  assert.equal(executions(), 0, 'zero executor calls');
  if (kind === 'EXECUTOR') {
    assert.deepEqual([proof.recordedCallers, proof.recordedIncentives], [null, null]); assert.ok(proof.executorSemantic);
    const raw = b.rawArtifacts[CAPTURE], v = validateExecutorSemantic(raw, b.token, rec(b, CAPTURE).availableAt);
    assert.deepEqual(Object.values(JSON.parse(raw).stages), [null, null, null, null]);
    assert.deepEqual([v.proposal, v.review, v.semantic, v.codes], [null, null, null, ['EXEC_SEMANTIC_CORPUS_UNAVAILABLE']]);
  } else {
    assert.deepEqual([proof.executorSemantic, proof.recordedIncentives], [null, null]); assert.ok(proof.recordedCallers);
    assert.equal(b.rawArtifacts['advisory-recorded-callers-capture'], callers);
    assert.ok(!hosts.some((h: string) => h.includes('tinyfish')), 'historical-only needs no TinyFish');
  }
  assert.ok(!hosts.some((h: string) => h.includes('generativelanguage')), 'no hosted inference');
  assert.deepEqual(rebuild(b, proof)(), b.details.advisory);
  await withDir(async (dir, file) => {
    let s = new Service(file), saved!: Loose;
    try { saved = s.analyzeLive(structuredClone(b) as any); assert.equal(s.analyzeLive(structuredClone(b) as any).id, saved.id); assert.deepEqual(s.replay(saved.id), saved); } finally { s.close(); }
    assert.equal(policy(file, saved.id), 'research-screen-advisory-v43');
    s = new Service(file); try { assert.deepEqual(s.replay(saved.id), saved); } finally { s.close(); }
    let out = '', err = '', network = 0, calls = 0;
    const exit = await runCli(['replay', saved.id, '--db', file, '--config', join(dir, 'config.json'), '--json'], { env: {}, isInteractive: false,
      fetcher: async () => { network++; throw Error('OFFLINE_NETWORK_DENIED'); }, semanticExecutor: async () => { calls++; throw Error('OFFLINE_EXECUTOR_DENIED'); },
      stdout: t => { out += t; }, stderr: t => { err += t; } });
    assert.equal(exit, 0, err); assert.deepEqual(JSON.parse(out), saved); assert.deepEqual([network, calls], [0, 0]);
  });
});

test('A29 v2 is admitted only under proof39||40||46 with facts38||39||45; downgrades and nullability fail closed', async () => {
  const ord = (await live('ORDINARY')).b;
  assert.equal(a29VerifiedV2Id(ord.token, ord.cutoff, ord.evidence, ord.rawArtifacts), A29_CAPTURE_ID, 'valid v40');
  assert.ok(advisoryFactsSchema.safeParse(ord.details.advisory).success, 'facts39 accepts v2');
  const legacy = rebuild(ord, { ...proofOf(ord), method: 'advisory-provenance-v39' })();
  assert.equal(legacy.method, 'advisory-measurements-v38');
  assert.ok(advisoryFactsSchema.safeParse(legacy).success, 'historical facts38 still accepts v2');
  assert.ok(advisoryFactsSchema.safeParse({ ...ord.details.advisory, method: 'advisory-measurements-v39' }).success);
  for (const kind of ['EXECUTOR', 'CALLERS'] as const) {
    const { b } = await live(kind), p = proofOf(b), facts = b.details.advisory;
    assert.equal(a29VerifiedV2Id(b.token, b.cutoff, b.evidence, b.rawArtifacts), A29_CAPTURE_ID, `${kind} valid v46`);
    const unregistered = structuredClone(b); unregistered.rawArtifacts['advisory-derivation'] = JSON.stringify({ ...p, method: 'advisory-provenance-v47' });
    assert.throws(rebuild(b, { ...p, method: 'advisory-provenance-v47' }), Error, 'unregistered proof47 rejects');
    assert.equal(a29VerifiedV2Id(unregistered.token, unregistered.cutoff, unregistered.evidence, unregistered.rawArtifacts), null, 'unregistered proof47 cannot earn a v2 budget');
    for (const v of [41, 42, 43, 44, 45]) {
      const q = { ...p, method: `advisory-provenance-v${v}` }, x = structuredClone(b);
      assert.throws(rebuild(b, q), PROOF, `${kind} proof${v}`);
      x.rawArtifacts['advisory-derivation'] = JSON.stringify(q);
      assert.equal(a29VerifiedV2Id(x.token, x.cutoff, x.evidence, x.rawArtifacts), null, `${kind} budget proof${v}`);
    }
    assert.throws(rebuild(b, { ...p, method: 'advisory-provenance-v39' }), PROOF, 'downgrade 46->39 with cycle2 descriptors');
    for (const key of ['executorSemantic', 'recordedCallers', 'recordedIncentives']) { const q = structuredClone(p); delete q[key]; assert.throws(rebuild(b, q), `${kind} ${key} key required`); }
    const bare = structuredClone(b); bare.evidence = bare.evidence.filter((e: Loose) => !cycle2(e.id));
    for (const id of Object.keys(bare.rawArtifacts)) if (cycle2(id)) delete bare.rawArtifacts[id];
    assert.throws(rebuild(bare, { ...p, executorSemantic: null, recordedCallers: null, recordedIncentives: null }), PROOF, 'v46 needs a cycle2 namespace even with v2 A29');
    assert.ok(advisoryFactsSchema.safeParse(facts).success, 'facts45 accepts v2');
    for (const v of [40, 41, 42, 43, 44]) assert.ok(!advisoryFactsSchema.safeParse({ ...facts, method: `advisory-measurements-v${v}` }).success, `facts${v} rejects v2`);
  }
});

test('a 25 MB synthetic v2 capture earns its own budget under proof46; foreign padding cannot inherit it', async () => {
  const { b } = await live('CALLERS', 25_000_000);
  assert.equal(proofOf(b).method, 'advisory-provenance-v46'); assert.ok(Buffer.byteLength(b.rawArtifacts[A29_CAPTURE_ID]) > 24_000_000);
  await withDir((_dir, file) => {
    const s = new Service(file);
    try {
      const saved = s.analyzeLive(structuredClone(b) as any); assert.deepEqual(s.replay(saved.id), saved);
      const foreign = structuredClone(b), pad = ' '.repeat(24_000_000);
      foreign.evidence.push({ id: 'cycle2-foreign-pad', sourceId: 'local-config', sourceType: 'CONFIG', retrievedAt: b.cutoff, availableAt: b.cutoff, contentHash: sha(pad), adapterVersion: 'live-v1', accessMode: 'LOCAL_DERIVED', scope: {} });
      foreign.rawArtifacts['cycle2-foreign-pad'] = pad;
      assert.throws(() => s.analyzeLive(foreign as any), /ARTIFACT_HASH_OR_SIZE/);
    } finally { s.close(); }
  });
});

test('cycle2 namespaces stay closed beside an admitted A29 v2 capture', async () => {
  const cases: [Kind, string, (b: Loose) => void, RegExp][] = [
    ['CALLERS', 'orphan executor artifact', b => { b.rawArtifacts['advisory-executor-orphan'] = '{}'; }, /UNREFERENCED_ARTIFACT/],
    ['EXECUTOR', 'orphan recorded-incentives artifact', b => { b.rawArtifacts['advisory-recorded-incentives-orphan'] = '{}'; }, /UNREFERENCED_ARTIFACT/],
    ['EXECUTOR', 'executor capture cited by an entry feature', b => { assert.ok(b.features.length); b.features[0].evidenceIds.push(CAPTURE); }, PROOF],
  ];
  for (const [kind, name, mutate, code] of cases) {
    const b = structuredClone((await live(kind)).b); mutate(b);
    await withDir((_dir, file) => { const s = new Service(file); try { assert.throws(() => s.analyzeLive(b as any), code, name); } finally { s.close(); } });
  }
});
