import assert from 'node:assert/strict';
import test from 'node:test';
import { collectSocialSources } from '../src/providers/social.js';
import type { AttentionRead, AttentionSource } from '../src/providers/attention.js';
import { SOCIAL_AVAILABLE, SOCIAL_END, SOCIAL_START, SOCIAL_TOKEN } from './social-fixtures.js';

const POST: AttentionSource = {
  id: 'target-post', url: 'https://x.com/alice/status/100', text: `${SOCIAL_TOKEN.address} has a public note.`,
  publishedAt: '2026-10-03T10:00:00.000Z', authorId: 'x.com:alice', availableAt: SOCIAL_AVAILABLE, kind: 'POST',
};

function attention(sources: AttentionSource[], overrides: Partial<AttentionRead> = {}): AttentionRead {
  return {
    sources, rawArtifacts: {}, queries: ['synthetic original target query'], complete: true, postSampleComplete: true,
    codes: [], start: SOCIAL_START, end: SOCIAL_END, postSampleSourceIds: [POST.id],
    ...overrides,
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('social supplements use their own eight-source budget, exclude comparison pages, and preserve the frozen post sample', async () => {
  const docs = Array.from({ length: 7 }, (_, index) => `https://project.example/docs/about-${index + 1}`);
  const projectPage: AttentionSource = {
    id: 'project-page', url: 'https://project.example/', text: docs.map((url, index) => `[About ${index + 1}](${url})`).join('\n'),
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
  };
  const comparisonOnly: AttentionSource[] = Array.from({ length: 8 }, (_, index) => ({
    id: `comparison-only-${index + 1}`, url: `https://unrelated${index + 1}.example/representation`, text: 'unrelated '.repeat(7000),
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
  }));
  const otherPages: AttentionSource[] = Array.from({ length: 22 }, (_, index) => ({
    id: `context-${index + 1}`, url: `https://context${index + 1}.example/about`, text: `Public context page ${index + 1}.`,
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
  }));
  const retained = [POST, projectPage, ...comparisonOnly, ...otherPages];
  assert.equal(retained.length, 32);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === 'https://api.search.tinyfish.ai/') return response({ results: [] });
    if (url === 'https://api.fetch.tinyfish.ai/') {
      const body = JSON.parse(String(init?.body)) as { urls: string[] };
      return response({ results: body.urls.map(requested => ({
        url: requested, final_url: requested,
        text: requested.startsWith('https://x.com/') ? 'Public profile for alice.' : `Public project source for ${SOCIAL_TOKEN.address}.`,
      })), errors: [] });
    }
    throw new Error(`Unexpected hosted request: ${url}`);
  };
  const read = await collectSocialSources(SOCIAL_TOKEN, attention(retained, {
    discoveryUrls: ['https://project.example/'], comparisonSourceIds: comparisonOnly.map(source => source.id),
  }), 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);

  const acquisition = JSON.parse(read.rawArtifacts['social-acquisition-scope']!) as {
    retainedAttentionSourceCount: number; excludedComparisonSourceIds: string[]; supplementLimit: number;
    requestedUrls: string[]; clippedSourceIds: string[]; method: string; baseSocialSourceCount: number;
    submittedSocialSourceCount: number; socialSourceLimit: number; actualSupplements: number;
  };
  const fetchCalls = calls.filter(call => call.url === 'https://api.fetch.tinyfish.ai/');
  assert.equal(fetchCalls.length, 1, 'all eight bounded social supplements fit in one Fetch batch');
  const requested = { urls: fetchCalls.flatMap(call => (JSON.parse(String(call.init?.body)) as { urls: string[] }).urls) };
  assert.deepEqual(requested.urls, [...docs, 'https://x.com/alice']);
  assert.equal(read.sources.length, 32, 'the social source limit is independent from the retained attention count');
  assert.ok(read.sources.length <= 32);
  assert.deepEqual(read.targetPostIds, [POST.id]);
  assert.equal(read.sources.filter(source => read.targetPostIds.includes(source.id)).length, 1);
  assert.ok(comparisonOnly.every(source => !read.sources.some(retainedSource => retainedSource.id === source.id)));
  assert.equal(read.sources.some(source => source.text.includes('unrelated unrelated unrelated')), false);
  assert.equal(acquisition.retainedAttentionSourceCount, 32);
  assert.deepEqual(acquisition.excludedComparisonSourceIds, comparisonOnly.map(source => source.id));
  assert.equal(acquisition.supplementLimit, 8);
  assert.deepEqual(acquisition.requestedUrls, requested.urls);
  assert.deepEqual(acquisition.clippedSourceIds, []);
  assert.equal(acquisition.baseSocialSourceCount, 24);
  assert.equal(acquisition.submittedSocialSourceCount, 32);
  assert.equal(acquisition.socialSourceLimit, 32);
  assert.equal(acquisition.actualSupplements, 8);
  assert.equal(acquisition.method, 'free-social-supplements-v2');
});

function clippedRead(clippedSourceId: string, contextCount = 30): AttentionRead {
  const sources: AttentionSource[] = [
    { ...POST, text: POST.text },
    { id: 'identity-profile', url: 'https://x.com/alice', text: 'Account profile identifies this public source.', publishedAt: null, authorId: 'x.com:alice', availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' },
    ...Array.from({ length: contextCount }, (_, index) => ({
      id: `page-${index + 1}`, url: `https://source${index + 1}.example/about`, text: `Short public page ${index + 1}.`,
      publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' as const,
    })),
  ];
  assert.ok(sources.length <= 32);
  const source = sources.find(item => item.id === clippedSourceId)!;
  source.text = `${source.text}${'x'.repeat(12000 - source.text.length)}`;
  const rawText = `${source.text} additional text omitted from the retained attention excerpt`;
  return attention(sources, {
    rawArtifacts: { 'attention-fetch-1': JSON.stringify({ results: [{ url: source.url, final_url: source.url, text: rawText }], errors: [] }) },
  });
}

test('clipped identity text can be completed from an exact verified prefix with an additive social source ID', async () => {
  const clipped = clippedRead('identity-profile', 29);
  const originalSources = structuredClone(clipped.sources);
  const attentionSample = {
    targetPostIds: [...clipped.postSampleSourceIds!],
    postSampleComplete: clipped.postSampleComplete,
    comparisonSourceIds: clipped.comparisonSourceIds,
    discoveryUrls: clipped.discoveryUrls,
  };
  const priorPage = clipped.sources.find(source => source.id === 'identity-profile')!;
  const fullText = (JSON.parse(clipped.rawArtifacts['attention-fetch-1']!) as { results: Array<{ text: string }> }).results[0]!.text;
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url === 'https://api.fetch.tinyfish.ai/') {
      const body = JSON.parse(String(init?.body)) as { urls: string[] };
      return response({ results: body.urls.map(requested => ({ url: requested, final_url: requested, text: fullText })), errors: [] });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  };
  const read = await collectSocialSources(SOCIAL_TOKEN, clipped, 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);
  const page = read.sources.find(source => source.kind === 'PAGE' && source.text === fullText);
  assert.ok(page);
  assert.equal(page.id, 'social-page-32', 'the completed source receives a fresh ID after retained sources and additions');
  assert.equal(page.availableAt, priorPage.availableAt, 'completion preserves the original availability timestamp');
  assert.equal(page.discoveredFrom, 'https://x.com/alice');
  assert.equal(read.sources.some(source => source.id === 'identity-profile'), false, 'the clipped page is removed from the social packet');
  assert.equal(read.identityComplete, true);
  assert.deepEqual(read.targetPostIds, [POST.id]);
  assert.deepEqual(read.sources.filter(source => source.kind === 'POST').map(source => source.id), [POST.id]);
  assert.equal(read.sources.length, originalSources.length, 'completion replaces the clipped social page and retains every other source');
  assert.equal(JSON.stringify(read.sources).includes('additional text omitted from the retained attention excerpt'), true);
  assert.deepEqual(clipped.sources, originalSources, 'completion never edits shared attention source text');
  assert.deepEqual({
    targetPostIds: clipped.postSampleSourceIds,
    postSampleComplete: clipped.postSampleComplete,
    comparisonSourceIds: clipped.comparisonSourceIds,
    discoveryUrls: clipped.discoveryUrls,
  }, attentionSample, 'completion does not change attention scope or counters');
  assert.equal(calls.some(call => call.url === 'https://api.fetch.tinyfish.ai/'), false, 'an exact full-text prefix already retained in fetch artifacts completes the clipped page without another request');
  const manifest = JSON.parse(read.rawArtifacts['social-acquisition-scope']!) as { clippedSourceIds: string[]; supplementLimit: number; method: string };
  assert.deepEqual(manifest.clippedSourceIds, ['identity-profile']);
  assert.equal(manifest.supplementLimit, 8);
  assert.equal(manifest.method, 'free-social-supplements-v2');
});

test('required identity failures and exhausted source capacity cannot imply completion', async t => {
  const noNetwork: typeof fetch = async () => { throw new Error('No supplementary request fits the 32-source budget.'); };
  const targetClipped = await collectSocialSources(SOCIAL_TOKEN, clippedRead(POST.id), 'synthetic-provider-key', noNetwork, () => SOCIAL_AVAILABLE);
  const targetManifest = JSON.parse(targetClipped.rawArtifacts['social-acquisition-scope']!) as { clippedSourceIds: string[] };
  assert.deepEqual(targetManifest.clippedSourceIds, [POST.id]);
  assert.equal(targetClipped.sampleComplete, false);

  const saturated = attention([POST, ...Array.from({ length: 31 }, (_, index) => ({
    id: `retained-${index + 1}`, url: `https://retained${index + 1}.example/about`, text: `Retained identity source ${index + 1}.`,
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' as const,
  }))], { discoveryUrls: ['https://required-project.example/about'] });
  const saturatedFetch: typeof fetch = async input => {
    if (String(input) === 'https://api.search.tinyfish.ai/') return response({ results: [] });
    throw new Error('A source-cap rejected lead must not trigger a Fetch request.');
  };
  const fullInput = await collectSocialSources(SOCIAL_TOKEN, saturated, 'synthetic-provider-key', saturatedFetch, () => SOCIAL_AVAILABLE);
  const fullManifest = JSON.parse(fullInput.rawArtifacts['social-acquisition-scope']!) as { selection: Array<{ url: string; required: boolean; status: string }>; submittedSocialSourceCount: number; requestedUrls: string[] };
  assert.equal(fullManifest.submittedSocialSourceCount, 32);
  assert.deepEqual(fullManifest.requestedUrls, []);
  assert.ok(fullManifest.selection.some(item => item.url === 'https://required-project.example/about' && item.required && item.status === 'SOC_SOURCE_CAP'));
  assert.equal(fullInput.identityComplete, false, 'a required identity lead rejected at the social-input capacity bound remains unresolved');
  assert.ok(fullInput.codes.includes('SOC_SOURCE_CAP'));

  const nineClipped: AttentionSource[] = [{ ...POST }];
  const fullResults: Array<{ url: string; final_url: string; text: string }> = [];
  for (let index = 0; index < 9; index++) {
    const url = `https://identity${index + 1}.example/about`;
    const prefix = `Complete public identity source ${index + 1}: ${'x'.repeat(11950)}`;
    nineClipped.push({ id: `identity-${index + 1}`, url, text: prefix, publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' });
    fullResults.push({ url, final_url: url, text: `${prefix} verified suffix` });
  }
  nineClipped.push(...Array.from({ length: 22 }, (_, index) => ({
    id: `unrelated-${index + 1}`, url: `https://unrelated${index + 1}.example/about`, text: `Context ${index + 1}.`,
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' as const,
  })));
  assert.equal(nineClipped.length, 32);
  const nineRaw = nineClipped.slice(1, 10).map(source => {
    const complete = fullResults.find(item => item.url === source.url)!;
    return complete;
  });
  const nineInput = attention(nineClipped, { rawArtifacts: { 'attention-fetch-1': JSON.stringify({ results: nineRaw, errors: [] }) } });
  const eightFetch: typeof fetch = async (input, init) => {
    if (String(input) !== 'https://api.fetch.tinyfish.ai/') throw new Error('All eight completion URLs are selected before optional search.');
    const request = JSON.parse(String(init?.body)) as { urls: string[] };
    return response({ results: request.urls.map(url => fullResults.find(item => item.url === url)!), errors: [] });
  };
  const eightOnly = await collectSocialSources(SOCIAL_TOKEN, nineInput, 'synthetic-provider-key', eightFetch, () => SOCIAL_AVAILABLE);
  const eightManifest = JSON.parse(eightOnly.rawArtifacts['social-acquisition-scope']!) as { requestedUrlsByBatch: string[][]; selection: Array<{ url: string; required: boolean; status: string }>; remainingClippedSourceIds: string[]; actualSupplements: number };
  assert.equal(eightManifest.requestedUrlsByBatch.flat().length, 0, 'verified complete-prefix text is reused without another fetch');
  assert.equal(eightManifest.actualSupplements, 8);
  assert.equal(eightManifest.selection.filter(item => item.status === 'RETAINED').length, 8);
  assert.equal(eightManifest.selection.find(item => item.status === 'SOC_SOURCE_CAP')?.required, true);
  assert.deepEqual(eightManifest.remainingClippedSourceIds, ['identity-9']);
  assert.equal(eightOnly.identityComplete, false, 'the ninth required clipped identity page cannot be silently treated as complete');

  for (const scenario of ['non-prefix', 'oversized'] as const) await t.test(scenario, async () => {
    const clipped = clippedRead('identity-profile', 29);
    const old = clipped.sources.find(source => source.id === 'identity-profile')!;
    const oversizedRetainedArtifact = `${old.text}${'x'.repeat(120000 - old.text.length + 1)}`;
    clipped.rawArtifacts = { 'attention-fetch-1': JSON.stringify({
      results: [{ url: old.url, final_url: old.url, text: oversizedRetainedArtifact }], errors: [],
    }) };
    const text = scenario === 'non-prefix'
      ? `replacement starts differently from retained prefix ${'x'.repeat(12000)}`
      : `${old.text}${'x'.repeat(120000 - old.text.length + 1)}`;
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input) !== 'https://api.fetch.tinyfish.ai/') return response({ results: [] });
      const request = JSON.parse(String(init?.body)) as { urls: string[] };
      return response({ results: request.urls.map(requested => ({ url: requested, final_url: requested, text })), errors: [] });
    };
    const result = await collectSocialSources(SOCIAL_TOKEN, clipped, 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);
    assert.equal(result.identityComplete, false, 'conflict or cap cannot turn a clipped source complete');
    assert.equal(result.sources.some(source => source.id === 'identity-profile'), true, 'the previous clipped evidence remains retained for diagnosis');
    assert.equal(result.sources.some(source => source.text === text), false);
    if (scenario === 'non-prefix') assert.ok(result.codes.includes('SOC_SOURCE_CONFLICT'));
    else assert.ok(result.codes.includes('SOC_TEXT_CAP'));
  });
});

test('optional account profile cap does not invalidate complete identity pages and only current accounts get ordinary profiles', async () => {
  const projectPage: AttentionSource = {
    id: 'primary-project-page', url: 'https://project.example/about', text: `The public project page discusses ${SOCIAL_TOKEN.address}.`,
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
  };
  const crowded = attention([POST, projectPage, ...Array.from({ length: 30 }, (_, index) => ({
    id: `context-${index + 1}`, url: `https://context${index + 1}.example/about`, text: `Public context ${index + 1}.`,
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' as const,
  }))]);
  const noNetwork: typeof fetch = async () => { throw new Error('No ordinary profile fetch slot is available.'); };
  const capped = await collectSocialSources(SOCIAL_TOKEN, crowded, 'synthetic-provider-key', noNetwork, () => SOCIAL_AVAILABLE);
  assert.equal(capped.identityComplete, true, 'ordinary account context is optional when the reviewed identity page itself is complete');
  const cappedManifest = JSON.parse(capped.rawArtifacts['social-acquisition-scope']!) as { selection: Array<{ reason: string; required: boolean; status: string }> };
  assert.ok(cappedManifest.selection.some(item => item.reason === 'PUBLIC_ACCOUNT_PROFILE' && !item.required && item.status === 'SOC_ACCOUNT_CONTEXT_CAP'));
  assert.equal(capped.codes.includes('SOC_SOURCE_CAP'), false);

  const historical: AttentionSource = {
    id: 'historical-post', url: 'https://x.com/olduser/status/88', text: `${SOCIAL_TOKEN.address} historical post.`,
    publishedAt: '2026-10-02T10:00:00.000Z', authorId: 'x.com:olduser', availableAt: SOCIAL_AVAILABLE, kind: 'POST',
  };
  const currentAndHistorical = attention([POST, historical], { postSampleSourceIds: [POST.id, historical.id] });
  const requestedProfiles: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://api.search.tinyfish.ai/') return response({ results: [] });
    if (url === 'https://api.fetch.tinyfish.ai/') {
      const request = JSON.parse(String(init?.body)) as { urls: string[] };
      requestedProfiles.push(...request.urls.filter(value => /^https:\/\/x\.com\/[^/]+$/.test(value)));
      return response({ results: request.urls.map(requested => ({ url: requested, final_url: requested, text: `Public profile text for ${new URL(requested).pathname.slice(1)}.` })), errors: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const current = await collectSocialSources(SOCIAL_TOKEN, currentAndHistorical, 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);
  assert.deepEqual(requestedProfiles, ['https://x.com/alice']);
  assert.equal(current.sources.some(source => source.id === 'historical-post'), true);
  assert.deepEqual(current.targetPostIds, [POST.id, historical.id]);
  assert.equal(current.sources.filter(source => source.kind === 'POST').length, 2, 'ordinary profile collection never adds historical/profile records as sampled posts');
});

test('a pre-aborted signal prevents supplemental search and fetch while retaining the original sample', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error('aborted run must not call fetch'); };
  const read = await collectSocialSources(SOCIAL_TOKEN, attention([POST]), 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE, controller.signal);
  assert.equal(calls, 0);
  assert.deepEqual(read.targetPostIds, [POST.id]);
  assert.equal(read.sampleComplete, true);
  assert.ok(read.codes.includes('SOC_COLLECTION_BUDGET'));
});
