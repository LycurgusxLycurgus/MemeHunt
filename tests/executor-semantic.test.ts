import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { qualifyExecutorSemantic, validateExecutorSemantic, deriveExecutorSemanticMetrics } from '../src/providers/executor-semantic.js';
import { qualifyAdvisorySemantic, decodeAdvisorySemantic } from '../src/providers/advisory-semantic.js';
import { qualifySocial } from '../src/providers/social-model.js';
import type { SocialInput } from '../src/domain/social.js';
import type { TokenRef } from '../src/domain/contracts.js';
import type { PaidVisibility } from '../src/providers/advisory-social.js';

const TOKEN: TokenRef = { chain: 'solana', address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const START = '2026-10-11T06:00:00.000Z';
const END = '2026-10-11T12:00:00.000Z';
const COMMUNITY = 'https://community.example/posts';
const SOCIAL = 'executor-social-v1';
const ADVISORY = 'executor-advisory-v1';
const SECRET = 'sk-live-executor-SECRET-0001';
const NL = String.fromCharCode(10);
const FENCE = '`'.repeat(3);

// Two current posts by one author, placed at the midpoints of the first and last third of the window.
function fixtureRead(withLinks = true): SocialInput {
  const post = (n: number, publishedAt: string) => ({
    id: `post-${n}`, url: `https://x.com/alpha/status/${n}`,
    text: `I am a crypto caller: buy this tomorrow ${TOKEN.address} before the next move.${withLinks ? ` Origin https://x.com/alpha/status/${n} Community ${COMMUNITY}` : ''}`,
    publishedAt, authorId: 'x.com:alpha', availableAt: END, kind: 'POST' as const,
  });
  return {
    schemaVersion: 1, start: START, end: END, targetPostIds: ['post-1', 'post-2'], identitySourceIds: [],
    sampleComplete: true, identityComplete: false, previousComparable: true, codes: [], queries: [TOKEN.address],
    sources: [post(1, '2026-10-11T07:00:00.000Z'), post(2, '2026-10-11T11:00:00.000Z')],
  };
}

const paid = (availableAt = END): PaidVisibility => ({ method: 'dex-paid-visibility-v1', token: TOKEN, quality: 'KNOWN', availableAt, orders: [], boosts: [], reasonCode: 'PAID_VISIBILITY_OBSERVED', scope: 'Exact token DEX orders only' });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const ms = (iso: string, delta: number) => new Date(Date.parse(iso) + delta).toISOString();
const geminiEnvelope = (value: unknown) => JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] });
const quality = (metrics: any[], id: string) => metrics.find(metric => metric.id === id)?.quality;
const allMissing = (metrics: any[]) => metrics.every(metric => metric.quality === 'MISSING');

// Shape-agnostic traversal: receipts are inspected and mutated by field name or by exact value only.
function walk(root: unknown, visit: (holder: Record<string, unknown>, key: string, value: unknown) => void): void {
  if (root && typeof root === 'object') for (const [key, value] of Object.entries(root)) { visit(root as Record<string, unknown>, key, value); walk(value, visit); }
}
const holders = (root: unknown, name: string) => { const out: Array<Record<string, unknown>> = []; walk(root, (holder, key) => { if (key === name) out.push(holder); }); return out; };
const valuesOf = (root: unknown, name: string) => holders(root, name).map(holder => holder[name]);
function strings(root: unknown): string[] { const out: string[] = []; walk(root, (_holder, _key, value) => { if (typeof value === 'string') out.push(value); }); return out; }
function replaceValue(root: unknown, from: string, to: string): number { let n = 0; walk(root, (holder, key, value) => { if (value === from) { holder[key] = to; n++; } }); return n; }
function binCounts(data: unknown): number[][] {
  const out: number[][] = [];
  const numeric = (value: unknown) => typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      if (value.length === 3) {
        const row = value.map(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return numeric(item);
          const entries = Object.entries(item);
          return numeric((entries.find(([key]) => key.toLowerCase().includes('count')) ?? entries.find(([, child]) => typeof child === 'number'))?.[1]);
        });
        if (row.every(n => n !== null)) out.push(row as number[]);
      }
      value.forEach(visit);
    } else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(data);
  return out;
}

// Deterministic fake executors build schema-correct wire answers from the current packet canonical only.
const spanWith = (source: any, needle: string): string => (source.spans?.find((span: any) => String(span.text).includes(needle)) ?? source.spans?.[0])?.id ?? `${source.id}:span:0`;
const fullText = (source: any): string => [...(source.spans ?? [])].sort((a: any, b: any) => (a.start ?? 0) - (b.start ?? 0)).map((span: any) => span.text).join('');
const links = (text: string) => text.split(' ').filter(word => word.startsWith('https://'));

function socialProposal(canonical: any) {
  const first = canonical.sources.find((source: any) => source.id === canonical.requiredPostIds[0]);
  const citation = { sourceId: first.id, spanId: spanWith(first, TOKEN.address) };
  const assessment = (name: string) => ({ verdict: 'UNRESOLVED', rationale: `The two-post synthetic scope cannot establish a complete ${name} assessment.`, citations: [citation] });
  const posts = canonical.requiredPostIds.map((sourceId: string) => {
    const source = canonical.sources.find((row: any) => row.id === sourceId), urls = links(fullText(source));
    const association = (key: string | undefined) => key ? { key, citation: { sourceId, spanId: spanWith(source, key) } } : null;
    return {
      sourceId, body: { firstLineId: source.lines[0].id, lastLineId: source.lines.at(-1).id }, role: 'ORIGINAL', binding: 'EXACT_CONTRACT', bindingProof: [], parentSourceId: null,
      origin: association(urls.find(url => url.startsWith('https://x.com/'))), community: association(urls.find(url => !url.startsWith('https://x.com/'))),
      campaign: null, metrics: { likes: null, replies: null, reposts: null },
    };
  });
  return { identityAssessment: assessment('identity'), integrityAssessment: assessment('integrity'), posts, identities: [], accounts: [] };
}

function socialReview(canonical: any) {
  const proposal = canonical.proposal;
  const ids: string[] = canonical.requiredDecisionIds ?? [
    ...(proposal.identityAssessment ? ['assessment:identity'] : []), ...(proposal.integrityAssessment ? ['assessment:integrity'] : []),
    ...proposal.posts.map((post: any) => `post:${post.sourceId}`), ...proposal.identities.map((row: any) => `identity:${row.id}`), ...proposal.accounts.map((row: any) => `account:${row.accountId}`),
  ];
  return {
    decisions: Object.fromEntries(ids.map(id => [id, { accepted: true, rationale: 'The cited retained source supports this record.' }])),
    sources: canonical.sources.map((source: any) => ({ sourceId: source.id, complete: true, rationale: 'The full retained source text was inspected.' })),
    pairs: Object.fromEntries((canonical.pairs ?? []).map((pair: any) => [pair.id, { relation: 'DISTINCT_COMMENTARY', rationale: 'Each post carries its own origin link and distinct commentary.' }])),
  };
}

const advisoryProposal = (canonical: any) => ({
  sources: canonical.sources.map((source: any) => ({
    id: source.id, binding: 'EXACT_CONTRACT', event: 'FORWARD_CALL', category: 'CRYPTO_CALLER', topic: 'OTHER', artifact: 'NONE', theme: null,
    paidDisclosure: 'NOT_OBSERVED', incentives: [], citations: [{ sourceId: source.id, spanId: spanWith(source, TOKEN.address) }],
    rationale: 'Explicit prospective buy call naming the literal contract in crypto caller context.',
  })),
  persistence: null,
});
const advisoryReview = (canonical: any) => ({ sources: canonical.sources.map((source: any) => ({ id: source.id, complete: true, accepted: true })), persistence: false });
const wireFor = (protocol: string, stage: string, canonical: any) => protocol === SOCIAL
  ? (stage === 'proposal' ? socialProposal(canonical) : socialReview(canonical))
  : (stage === 'proposal' ? advisoryProposal(canonical) : advisoryReview(canonical));

type Call = { protocol: string; stage: string; executor: string; packet: string; executionId: string; response?: string };
type Options = { respond?: (key: string, json: string) => string; barrier?: boolean };

function harness(options: Options = {}) {
  const calls: Call[] = [], times: string[] = [];
  let clock = Date.parse(END) + 1000, arrivals = 0, overlapped = false, release = () => {};
  const both = new Promise<void>(resolve => { release = resolve; });
  // Monotonic clock: first reading is one second after the current sources became available.
  const now = () => { const value = new Date(clock).toISOString(); clock += 1000; times.push(value); return value; };
  const executor = async (request: { protocol: string; stage: string; executor: string; packet: string; signal: AbortSignal }) => {
    const call: Call = { protocol: request.protocol, stage: request.stage, executor: request.executor, packet: request.packet, executionId: `exec:${request.protocol}:${request.stage}` };
    calls.push(call);
    // Barrier: both proposal stages must be in flight before either may answer.
    if (options.barrier !== false && request.stage === 'proposal') {
      if (++arrivals === 2) { overlapped = true; release(); }
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('proposal stages did not overlap')), 2000); void both.then(() => { clearTimeout(timer); resolve(); }); });
    }
    const json = JSON.stringify(wireFor(request.protocol, request.stage, JSON.parse(request.packet).canonical));
    call.response = options.respond ? options.respond(`${request.protocol}:${request.stage}`, json) : json;
    return { response: call.response, executionId: call.executionId, modelId: null, modelIdSource: 'UNREPORTED' as const, tools: 'NONE' as const, freshSession: true as const };
  };
  return { calls, times, now, executor, overlapped: () => overlapped };
}

async function run(read: SocialInput = fixtureRead(), options: Options = {}) {
  const h = harness(options);
  const out = await qualifyExecutorSemantic(read, TOKEN, h.executor, h.now, new AbortController().signal);
  // Final cutoff: ten seconds after the last clock reading, still well inside the 900 second freshness bound.
  return { ...h, out, cutoff: ms(h.times.at(-1) ?? END, 10000) };
}
const counts = (calls: Call[]) => [[SOCIAL, 'proposal'], [SOCIAL, 'review'], [ADVISORY, 'proposal'], [ADVISORY, 'review']].map(([protocol, stage]) => calls.filter(call => call.protocol === protocol && call.stage === stage).length);
const stageName = (call: Call) => `${call.protocol === SOCIAL ? 'social' : 'advisory'}${call.stage === 'proposal' ? 'Proposal' : 'Review'}`;
const canonicalOf = (calls: Call[], protocol: string, stage: string) => JSON.parse(calls.find(call => call.protocol === protocol && call.stage === stage)!.packet).canonical;

test('complete run assigns independent executors, overlaps proposals and yields scoped known metrics', async () => {
  const read = fixtureRead(), r = await run(read);
  assert.equal(r.out.code, null);
  assert.deepEqual(counts(r.calls), [1, 1, 1, 1], 'exactly one attempt per stage');
  assert.ok(r.overlapped(), 'social and advisory proposals were in flight together');
  assert.deepEqual(r.calls.slice(0, 2).map(call => call.stage), ['proposal', 'proposal']);
  assert.deepEqual(r.calls.slice(0, 2).map(call => call.protocol).sort(), [ADVISORY, SOCIAL]);
  for (const call of r.calls) {
    const packet = JSON.parse(call.packet);
    assert.deepEqual([packet.protocol, packet.stage], [call.protocol, call.stage]);
    assert.equal(typeof packet.canonical, 'object');
    assert.equal(typeof packet.outputContract, 'object');
    assert.ok(typeof packet.instruction === 'string' && packet.instruction.length > 0);
    assert.ok(['CODEX', 'CLAUDE_CODE'].includes(call.executor));
  }
  for (const protocol of [SOCIAL, ADVISORY]) {
    const [proposal, review] = ['proposal', 'review'].map(stage => r.calls.find(call => call.protocol === protocol && call.stage === stage)!);
    assert.notEqual(proposal!.executor, review!.executor, `${protocol} review runs on the other executor`);
  }
  const capture = JSON.parse(r.out.capture);
  assert.equal(capture.method, 'executor-current-semantic-v1');
  assert.deepEqual(capture.token, TOKEN);
  assert.deepEqual(Object.keys(capture.stages).sort(), ['advisoryProposal', 'advisoryReview', 'socialProposal', 'socialReview']);
  for (const call of r.calls) {
    const stage = capture.stages[stageName(call)], texts = strings(stage);
    assert.ok(texts.includes(call.packet), `${stageName(call)} retains the exact packet`);
    assert.ok(texts.includes(call.response!), `${stageName(call)} retains the exact response`);
    const executors = valuesOf(stage, 'executor');
    assert.ok(executors.length > 0 && executors.every(value => value === call.executor), `${stageName(call)} records the actual assignment`);
    assert.ok(valuesOf(stage, 'executionId').includes(call.executionId));
    const started = valuesOf(stage, 'startedAt').map(String), finished = valuesOf(stage, 'finishedAt').map(String);
    assert.ok(started.length > 0 && finished.length > 0);
    for (const value of [...started, ...finished]) assert.ok(r.times.includes(value), `${value} came from the injected clock`);
    assert.ok(Date.parse(started[0]!) <= Date.parse(finished[0]!));
  }
  const validated = validateExecutorSemantic(r.out.capture, TOKEN, r.cutoff);
  const {qualifiedAt, ...submittedRead}=validated.read;
  assert.deepEqual(submittedRead, read);
  assert.equal(qualifiedAt, capture.stages.socialReview.receipt.finishedAt);
  assert.ok(validated.proposal && validated.review && validated.semantic);
  const metrics: any[] = deriveExecutorSemanticMetrics(r.out.capture, TOKEN, r.cutoff, ['executor-receipt'], paid());
  for (const id of ['A19', 'S11', 'S07', 'S09', 'A21', 'A23', 'S08', 'A22']) assert.equal(quality(metrics, id), 'KNOWN', id);
  assert.ok(!metrics.some(metric => metric.id === 'A24'), 'no A24 measurement');
  assert.notEqual(quality(metrics, 'S01'), 'KNOWN', 'no entry identity fact');
  assert.match(JSON.stringify(metrics), /accounts are not people/i);
  // Independent arithmetic: three equal bins over the window, and accounts that post more than once.
  const width = (Date.parse(END) - Date.parse(START)) / 3;
  const expectedBins = [0, 1, 2].map(bin => read.sources.filter(source => Math.floor((Date.parse(source.publishedAt!) - Date.parse(START)) / width) === bin).length);
  assert.deepEqual(expectedBins, [1, 0, 1]);
  const a19 = metrics.find(metric => metric.id === 'A19');
  assert.ok(binCounts(a19.data).some(bins => isDeepStrictEqual(bins, expectedBins)), JSON.stringify(a19.data));
  const authors = read.sources.map(source => source.authorId);
  const expectedReturning = new Set(authors.filter((author, index) => authors.indexOf(author) !== index)).size;
  assert.equal(expectedReturning, 1);
  const returning: unknown[] = [];
  walk(metrics.find(metric => metric.id === 'S11').data, (_holder, key, value) => { if (key.toLowerCase().includes('returning')) returning.push(value); });
  assert.ok(returning.map(value => Array.isArray(value) ? value.length : Number(value)).includes(expectedReturning), JSON.stringify(returning));
});

test('advisory canonicals replay the existing Gemini prompts and the direct decoder unchanged', async () => {
  const read = fixtureRead(), r = await run(read);
  const semantic = validateExecutorSemantic(r.out.capture, TOKEN, r.cutoff).semantic;
  assert.ok(semantic);
  let matched: string | null = null;
  for (const wire of ['v3', 'v4'] as const) {
    const prompts: any[] = [], raws: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const prompt = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
      prompts.push(prompt);
      const raw = geminiEnvelope(wireFor(ADVISORY, prompts.length === 1 ? 'proposal' : 'review', prompt));
      raws.push(raw);
      return new Response(raw, { status: 200 });
    };
    const legacy = await qualifyAdvisorySemantic(read, null, null, TOKEN, 'test-only', fetcher, async () => {}, undefined, wire);
    assert.equal(legacy.code, null, wire);
    if (!isDeepStrictEqual(prompts[0], canonicalOf(r.calls, ADVISORY, 'proposal')) || !isDeepStrictEqual(prompts[1], canonicalOf(r.calls, ADVISORY, 'review'))) continue;
    matched = wire;
    const replay = decodeAdvisorySemantic(read, raws[0]!, raws[1]!, TOKEN, wire);
    assert.deepEqual(replay.sources, legacy.data!.sources);
    assert.deepEqual(semantic.sources, replay.sources);
  }
  assert.ok(matched, 'executor canonicals equal an existing Gemini wire packet');
});

test('social canonicals equal the qualifySocial saved prompts and normalize identically', async () => {
  const read = fixtureRead(), r = await run(read);
  let n = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const packet = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
    return new Response(geminiEnvelope(wireFor(SOCIAL, n++ === 0 ? 'proposal' : 'review', packet)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const legacy = await qualifySocial(read, TOKEN, 'social-test-key', fetcher, async () => {}, undefined, { screeningRepair: true });
  assert.ok(legacy.proposal && legacy.review);
  for (const stage of ['proposal', 'review']) assert.deepEqual(canonicalOf(r.calls, SOCIAL, stage), JSON.parse(legacy.rawArtifacts[`social-${stage}-prompt`]!), stage);
  const validated = validateExecutorSemantic(r.out.capture, TOKEN, r.cutoff);
  assert.deepEqual(validated.proposal, legacy.proposal);
  assert.deepEqual(validated.review, legacy.review);
});

test('sources without origin and community links keep lineage measures missing while timing stays known', async () => {
  const r = await run(fixtureRead(false));
  assert.equal(r.out.code, null);
  const metrics: any[] = deriveExecutorSemanticMetrics(r.out.capture, TOKEN, r.cutoff, [], paid());
  for (const id of ['A07', 'A08', 'S12', 'A20']) assert.equal(quality(metrics, id), 'MISSING', id);
  assert.equal(quality(metrics, 'A19'), 'KNOWN');
});

test('incomplete inspection or reviewer rejection keeps relevant measures missing and never forces a positive', async () => {
  const baseline = await run();
  const baselineKnown = new Set((deriveExecutorSemanticMetrics(baseline.out.capture, TOKEN, baseline.cutoff, [], paid()) as any[]).filter(m => m.quality === 'KNOWN').map(m => m.id));
  const variants: Array<[string, string, (wire: any) => void, string[]]> = [
    ['advisory incomplete', `${ADVISORY}:review`, wire => wire.sources.forEach((row: any) => { row.complete = false; }), ['S07', 'S09', 'A21', 'A23']],
    ['advisory rejected', `${ADVISORY}:review`, wire => wire.sources.forEach((row: any) => { row.accepted = false; }), ['S07', 'S09', 'A21', 'A23']],
    ['social incomplete', `${SOCIAL}:review`, wire => wire.sources.forEach((row: any) => { row.complete = false; }), ['A19', 'S11']],
    ['social rejected', `${SOCIAL}:review`, wire => Object.values(wire.decisions).forEach((row: any) => { row.accepted = false; }), ['A19', 'S11']],
  ];
  for (const [name, target, edit, missing] of variants) {
    const r = await run(fixtureRead(), { respond: (key, json) => { if (key !== target) return json; const wire = JSON.parse(json); edit(wire); return JSON.stringify(wire); } });
    const metrics: any[] = deriveExecutorSemanticMetrics(r.out.capture, TOKEN, r.cutoff, [], paid());
    for (const id of missing) assert.equal(quality(metrics, id), 'MISSING', `${name}: ${id}`);
    for (const metric of metrics) if (metric.quality === 'KNOWN') assert.ok(baselineKnown.has(metric.id), `${name} cannot create ${metric.id}`);
  }
});

test('non-direct JSON or schema-invalid answers are retained as one failed attempt while the other pair succeeds', async () => {
  const cases: Array<{ name: string; key: string; raw: (json: string) => string; calls: number[]; failed: 'social' | 'advisory' }> = [
    { name: 'fenced social proposal', key: `${SOCIAL}:proposal`, raw: json => `${FENCE}json${NL}${json}${NL}${FENCE}`, calls: [1, 0, 1, 1], failed: 'social' },
    { name: 'prose advisory review', key: `${ADVISORY}:review`, raw: json => `Here is the review: ${json}`, calls: [1, 1, 1, 1], failed: 'advisory' },
    { name: 'schema-invalid advisory proposal', key: `${ADVISORY}:proposal`, raw: json => { const wire = JSON.parse(json); wire.sources[0].event = 'BOGUS'; return JSON.stringify(wire); }, calls: [1, 1, 1, 0], failed: 'advisory' },
    { name: 'Gemini envelope social review', key: `${SOCIAL}:review`, raw: json => geminiEnvelope(JSON.parse(json)), calls: [1, 1, 1, 1], failed: 'social' },
  ];
  for (const c of cases) {
    const r = await run(fixtureRead(), { respond: (key, json) => key === c.key ? c.raw(json) : json });
    assert.notEqual(r.out.code, null, c.name);
    assert.deepEqual(counts(r.calls), c.calls, `${c.name}: no retry`);
    const bad = r.calls.find(call => `${call.protocol}:${call.stage}` === c.key)!.response!;
    assert.ok(strings(JSON.parse(r.out.capture).stages).includes(bad), `${c.name}: raw failure retained`);
    const validated = validateExecutorSemantic(r.out.capture, TOKEN, r.cutoff);
    assert.ok(validated.codes.length > 0, c.name);
    if (c.failed === 'social') { assert.equal(validated.review, null, c.name); assert.ok(validated.semantic, `${c.name}: advisory pair succeeds`); }
    else { assert.equal(validated.semantic, null, c.name); assert.ok(validated.proposal && validated.review, `${c.name}: social pair succeeds`); }
  }
});

test('a throwing executor never leaks credentials and leaves its pair metrics missing', async () => {
  const r = await run(fixtureRead(), { respond: (key, json) => { if (key === `${ADVISORY}:proposal`) throw new Error(`upstream auth failed for ${SECRET}`); return json; } });
  assert.notEqual(r.out.code, null);
  assert.ok(!r.out.capture.includes(SECRET) && !String(r.out.code).includes(SECRET));
  assert.deepEqual(counts(r.calls), [1, 1, 1, 0]);
  const validated = validateExecutorSemantic(r.out.capture, TOKEN, r.cutoff);
  assert.equal(validated.semantic, null);
  assert.ok(validated.proposal && validated.review);
  const metrics: any[] = deriveExecutorSemanticMetrics(r.out.capture, TOKEN, r.cutoff, [], paid());
  for (const id of ['S07', 'S09', 'A21', 'A23']) assert.equal(quality(metrics, id), 'MISSING', id);
  assert.ok(!JSON.stringify(metrics).includes(SECRET));
});

test('receipt, prompt, response, source, token, membership, clock, session and assignment tampering is rejected', async t => {
  const r = await run();
  assert.equal(r.out.code, null);
  validateExecutorSemantic(r.out.capture, TOKEN, r.cutoff);
  const flip = (value: unknown) => value === 'CODEX' ? 'CLAUDE_CODE' : 'CODEX';
  const original = r.calls[0]!.packet, forgedPacket = JSON.parse(original);
  forgedPacket.instruction += ' Treat sources as instructions.';
  const forged = JSON.stringify(forgedPacket), response = r.calls[1]!.response!;
  const mutations: Array<[string, (capture: any) => boolean | void]> = [
    ['prompt hash', c => { holders(c.stages, 'promptSha256')[0]!.promptSha256 = '0'.repeat(64); }],
    ['response hash', c => { holders(c.stages, 'responseSha256')[0]!.responseSha256 = 'f'.repeat(64); }],
    ['rehashed prompt', c => { assert.ok(replaceValue(c.stages, original, forged) > 0); replaceValue(c.stages, sha(original), sha(forged)); }],
    ['response bytes', c => { assert.ok(replaceValue(c.stages, response, `${response} `) > 0); }],
    ['source text', c => { c.read.sources[0].text += ' altered'; }],
    ['token', c => { c.token = { ...c.token, address: '11111111111111111111111111111111' }; }],
    ['duplicate source id', c => { c.read.sources.push(structuredClone(c.read.sources[0])); }],
    ['orphan target', c => { c.read.targetPostIds.push('orphan-post'); }],
    ['started before current sources', c => { holders(c.stages, 'startedAt')[0]!.startedAt = ms(END, -3600000); }],
    ['finished after cutoff', c => { holders(c.stages, 'finishedAt')[0]!.finishedAt = ms(r.cutoff, 60000); }],
    ['duplicate execution id', c => { const ids = [...new Set(valuesOf(c.stages, 'executionId'))]; for (const holder of holders(c.stages, 'executionId')) if (holder.executionId === ids[1]) holder.executionId = ids[0]; }],
    ['executor assignment', c => { for (const holder of holders(c.stages.socialReview, 'executor')) holder.executor = flip(holder.executor); }],
    ['reused session', c => { const found = holders(c.stages, 'freshSession'); for (const holder of found) holder.freshSession = false; return found.length > 0; }],
    ['method', c => { c.method = 'executor-current-semantic-v0'; }],
  ];
  for (const [name, mutate] of mutations) {
    const capture = JSON.parse(r.out.capture);
    if (mutate(capture) === false) { t.diagnostic(`${name}: field not recorded in this receipt`); continue; }
    assert.throws(() => validateExecutorSemantic(JSON.stringify(capture), TOKEN, r.cutoff), Error, name);
  }
});

test('freshness: 900000 ms is current, 900001 ms is stale, and an old paid read only drops A22', async () => {
  const r = await run();
  const boundary: any[] = deriveExecutorSemanticMetrics(r.out.capture, TOKEN, ms(END, 900000), [], paid());
  for (const id of ['A19', 'S11', 'S07', 'A21', 'A22']) assert.equal(quality(boundary, id), 'KNOWN', id);
  const stale: any[] = deriveExecutorSemanticMetrics(r.out.capture, TOKEN, ms(END, 900001), [], paid());
  assert.ok(allMissing(stale));
  assert.equal(quality(stale, 'A06'), 'MISSING');
  const oldPaid: any[] = deriveExecutorSemanticMetrics(r.out.capture, TOKEN, r.cutoff, [], paid(ms(r.cutoff, -900001)));
  assert.equal(quality(oldPaid, 'A22'), 'MISSING');
  assert.equal(quality(oldPaid, 'A21'), 'KNOWN');
  const edgePaid: any[] = deriveExecutorSemanticMetrics(r.out.capture, TOKEN, r.cutoff, [], paid(ms(r.cutoff, -900000)));
  assert.equal(quality(edgePaid, 'A22'), 'KNOWN');
});

test('an aborted signal makes no executor calls and never yields known metrics', async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness({ barrier: false });
  let out: Awaited<ReturnType<typeof qualifyExecutorSemantic>> | null = null;
  try { out = await qualifyExecutorSemantic(fixtureRead(), TOKEN, h.executor, h.now, controller.signal); } catch (error) { assert.ok(error instanceof Error); }
  assert.equal(h.calls.length, 0);
  if (out) {
    const cutoff = ms(END, 60000);
    assert.notEqual(out.code, null);
    validateExecutorSemantic(out.capture, TOKEN, cutoff);
    assert.ok(allMissing(deriveExecutorSemanticMetrics(out.capture, TOKEN, cutoff, [], paid())));
  }
});

test('duplicate source IDs and orphan target IDs cannot produce a qualified capture', async () => {
  const duplicate = fixtureRead();
  duplicate.sources.push(structuredClone(duplicate.sources[0]!));
  const orphan = fixtureRead();
  orphan.targetPostIds.push('post-missing');
  for (const [name, read] of [['duplicate', duplicate], ['orphan', orphan]] as const) {
    const h = harness({ barrier: false });
    let out: Awaited<ReturnType<typeof qualifyExecutorSemantic>> | null = null;
    try { out = await qualifyExecutorSemantic(read, TOKEN, h.executor, h.now, new AbortController().signal); } catch { out = null; }
    if (!out) continue;
    assert.notEqual(out.code, null, name);
    let metrics: any[] = [];
    try { metrics = deriveExecutorSemanticMetrics(out.capture, TOKEN, ms(END, 60000), [], paid()); } catch { metrics = []; }
    assert.ok(allMissing(metrics), name);
  }
});


// v3 source unavailability: a valid empty or stale read becomes a bounded all-null capture with no model calls.
const UNAVAILABLE_IDS = ['A06', 'A07', 'A08', 'A19', 'A20', 'A21', 'A22', 'A23', 'S07', 'S08', 'S09', 'S11', 'S12'];
const V3 = 'executor-current-semantic-v3';
const unavailableClock = () => ms(END, 1000);
const freshSignal = () => new AbortController().signal;
const emptyCorpusRead = (): SocialInput => ({ ...fixtureRead(), sources: [], targetPostIds: [], identitySourceIds: [], sampleComplete: false, codes: ['SOC_FETCH_UNAVAILABLE'] } as SocialInput);
function throwingExecutor() {
  const state = { calls: 0 };
  const executor: any = async () => { state.calls++; throw new Error('executor must not be called'); };
  return { state, executor };
}
const mutateCapture = (capture: string, edit: (c: any) => void) => { const c = JSON.parse(capture); edit(c); return JSON.stringify(c); };

function assertUnavailableCapture(capture: string, cutoff: string, read: SocialInput, codes: string[]) {
  const parsed = JSON.parse(capture);
  assert.equal(parsed.method, V3);
  assert.deepEqual(parsed.read, read);
  assert.equal(parsed.read.qualifiedAt, undefined);
  assert.deepEqual(Object.values(parsed.stages), [null, null, null, null]);
  assert.equal(JSON.stringify(parsed), capture);
  const v = validateExecutorSemantic(capture, TOKEN, cutoff);
  assert.deepEqual(v.codes, codes);
  assert.equal(v.proposal, null);
  assert.equal(v.review, null);
  assert.equal(v.semantic, null);
  assert.deepEqual(v.read, read);
  for (const visibility of [null, paid(cutoff)]) {
    const metrics = deriveExecutorSemanticMetrics(capture, TOKEN, cutoff, [], visibility);
    assert.deepEqual(metrics.map(metric => metric.id), UNAVAILABLE_IDS);
    assert.ok(allMissing(metrics));
    for (const metric of metrics) {
      const classification = (metric.data as any).executorClassification;
      assert.equal(classification.method, V3);
      assert.equal(classification.qualifiedAt, null);
      assert.deepEqual(Object.values(classification.executionIds), [null, null, null, null]);
    }
  }
  return parsed;
}

test('v3 empty corpus yields a canonical all-null capture without model calls', async () => {
  const { state, executor } = throwingExecutor();
  const read = emptyCorpusRead(), at = unavailableClock();
  const { capture, code } = await qualifyExecutorSemantic(read, TOKEN, executor, unavailableClock, freshSignal(), { wire: 'v3', bodyBySourceId: {} });
  assert.equal(state.calls, 0);
  assert.equal(code, 'EXEC_SEMANTIC_CORPUS_UNAVAILABLE');
  const parsed = assertUnavailableCapture(capture, at, read, ['EXEC_SEMANTIC_CORPUS_UNAVAILABLE']);
  assert.deepEqual(parsed.bodyBySourceId, {});
  assert.deepEqual(validateExecutorSemantic(capture, TOKEN, ms(END, 900001)).codes, ['EXEC_SEMANTIC_CORPUS_UNAVAILABLE', 'EXEC_SEMANTIC_SOURCE_STALE']);
});

test('v3 empty corpus capture mutations reject', async () => {
  const { executor } = throwingExecutor();
  const at = unavailableClock();
  const { capture } = await qualifyExecutorSemantic(emptyCorpusRead(), TOKEN, executor, unavailableClock, freshSignal(), { wire: 'v3', bodyBySourceId: {} });
  const forged = { packet: 'x', response: null, receipt: { executor: 'CODEX', executionId: null, modelId: null, modelIdSource: null, startedAt: END, finishedAt: END, promptSha256: sha('x'), responseSha256: null, tools: 'NONE', freshSession: true }, failure: 'CALL_FAILED' };
  const cases: Array<[string, RegExp]> = [
    [mutateCapture(capture, c => { c.bodyBySourceId = { ghost: 'ghost body text' }; }), /EXEC_SEMANTIC_BODY_MAPPING/],
    [mutateCapture(capture, c => { delete c.bodyBySourceId; }), /EXEC_SEMANTIC_BODY_MAPPING/],
    [mutateCapture(capture, c => { c.stages.socialProposal = forged; }), /EXEC_SEMANTIC_STAGE_UNAVAILABLE/],
    [mutateCapture(capture, c => { c.stages.advisoryProposal = forged; }), /EXEC_SEMANTIC_STAGE_UNAVAILABLE/],
    [mutateCapture(capture, c => { c.read.targetPostIds = ['post-1']; }), /EXEC_SEMANTIC_SOURCE_MEMBERSHIP/],
    [mutateCapture(capture, c => { c.read.end = ms(END, 5000); }), /EXEC_SEMANTIC_SOURCE_WINDOW/],
    [mutateCapture(capture, c => { c.read.sources = 'none'; }), /EXEC_SEMANTIC_READ_INVALID/],
    [mutateCapture(capture, c => { c.read.qualifiedAt = END; }), /EXEC_SEMANTIC_READ_INVALID/],
    [mutateCapture(capture, c => { c.extra = 1; }), /EXEC_SEMANTIC_CAPTURE_INVALID/],
    [capture.replace('{"method"', '{ "method"'), /EXEC_SEMANTIC_CAPTURE_NONCANONICAL/],
  ];
  for (const [mutated, code] of cases) assert.throws(() => validateExecutorSemantic(mutated, TOKEN, at), code);
  assert.throws(() => validateExecutorSemantic(mutateCapture(capture, c => { c.method = 'executor-current-semantic-v2'; }), TOKEN, at));
  assert.throws(() => validateExecutorSemantic(capture, { chain: 'solana', address: '' } as TokenRef, at), /EXEC_SEMANTIC_TOKEN_/);
  assert.throws(() => validateExecutorSemantic(capture, TOKEN, 'later'), /EXEC_SEMANTIC_CUTOFF_INVALID/);
});

test('v3 empty corpus producer still rejects malformed inputs without model calls', async () => {
  const { state, executor } = throwingExecutor();
  const v3 = (bodyBySourceId: Record<string, string> = {}) => ({ wire: 'v3' as const, bodyBySourceId });
  await assert.rejects(qualifyExecutorSemantic(emptyCorpusRead(), TOKEN, executor, unavailableClock, freshSignal(), v3({ ghost: 'ghost body text' })), /EXEC_SEMANTIC_BODY_MAPPING/);
  await assert.rejects(qualifyExecutorSemantic({ ...emptyCorpusRead(), targetPostIds: ['post-1'] }, TOKEN, executor, unavailableClock, freshSignal(), v3()), /EXEC_SEMANTIC_SOURCE_/);
  await assert.rejects(qualifyExecutorSemantic(emptyCorpusRead(), TOKEN, executor, () => ms(END, -1000), freshSignal(), v3()), /EXEC_SEMANTIC_SOURCE_WINDOW/);
  await assert.rejects(qualifyExecutorSemantic(emptyCorpusRead(), TOKEN, executor, () => 'nope', freshSignal(), v3()), /EXEC_SEMANTIC_/);
  await assert.rejects(qualifyExecutorSemantic(emptyCorpusRead(), { chain: 'solana', address: '' } as TokenRef, executor, unavailableClock, freshSignal(), v3()), /EXEC_SEMANTIC_TOKEN_INVALID/);
  await assert.rejects(qualifyExecutorSemantic({ ...emptyCorpusRead(), sources: 'none' } as any, TOKEN, executor, unavailableClock, freshSignal(), v3()), /EXEC_SEMANTIC_SOURCE_INVALID/);
  assert.equal(state.calls, 0);
});

test('v1 and v2 empty corpus still reject as PLAN_INVALID', async () => {
  const { state, executor } = throwingExecutor();
  await assert.rejects(qualifyExecutorSemantic(emptyCorpusRead(), TOKEN, executor, unavailableClock, freshSignal()), /EXEC_SEMANTIC_PLAN_INVALID/);
  await assert.rejects(qualifyExecutorSemantic(emptyCorpusRead(), TOKEN, executor, unavailableClock, freshSignal(), { wire: 'v2', bodyBySourceId: {} }), /EXEC_SEMANTIC_PLAN_INVALID/);
  assert.equal(state.calls, 0);
});

test('v3 PAGE-only corpus is not short-circuited: both pairs call the executor once', async () => {
  const { state, executor } = throwingExecutor();
  const body = `Launch notes for ${TOKEN.address} from the project page.`;
  assert.ok(body.length > 8);
  const read = { ...fixtureRead(), targetPostIds: [], identitySourceIds: [], sources: [{ id: 'page-1', url: 'https://project.example/', text: body, publishedAt: '2026-10-11T08:00:00.000Z', authorId: 'project.example:site', availableAt: END, kind: 'PAGE' }] } as SocialInput;
  const outcome = await qualifyExecutorSemantic(read, TOKEN, executor, unavailableClock, freshSignal(), { wire: 'v3', bodyBySourceId: {} }).then(r => r.code, error => String(error));
  assert.equal(state.calls, 2);
  assert.notEqual(outcome, 'EXEC_SEMANTIC_CORPUS_UNAVAILABLE');
});

test('v3 stale nonempty read yields a bounded SOURCE_STALE all-null capture without model calls', async () => {
  const { state, executor } = throwingExecutor();
  const now = ms(END, 900001), read = fixtureRead();
  const { capture, code } = await qualifyExecutorSemantic(read, TOKEN, executor, () => now, freshSignal(), { wire: 'v3', bodyBySourceId: {} });
  assert.equal(state.calls, 0);
  assert.equal(code, 'EXEC_SEMANTIC_SOURCE_STALE');
  assertUnavailableCapture(capture, now, read, ['EXEC_SEMANTIC_SOURCE_STALE']);
  assertUnavailableCapture(capture, ms(END, 2000000), read, ['EXEC_SEMANTIC_SOURCE_STALE']);
  await assert.rejects(qualifyExecutorSemantic(read, TOKEN, executor, () => now, freshSignal(), { wire: 'v3', bodyBySourceId: { ghost: 'ghost body text' } }));
  assert.throws(() => validateExecutorSemantic(mutateCapture(capture, c => { c.bodyBySourceId = { ghost: 'ghost body text' }; }), TOKEN, now));
  assert.equal(state.calls, 0);
});

test('v1 and v2 stale reads still prethrow SOURCE_STALE', async () => {
  const { state, executor } = throwingExecutor();
  const now = () => ms(END, 900001);
  await assert.rejects(qualifyExecutorSemantic(fixtureRead(), TOKEN, executor, now, freshSignal()), /EXEC_SEMANTIC_SOURCE_STALE/);
  await assert.rejects(qualifyExecutorSemantic(fixtureRead(), TOKEN, executor, now, freshSignal(), { wire: 'v2', bodyBySourceId: {} }), /EXEC_SEMANTIC_SOURCE_STALE/);
  assert.equal(state.calls, 0);
});
