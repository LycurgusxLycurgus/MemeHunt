import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { originSourceScope } from '../src/domain/attention.js';
import type { AttentionRead, AttentionSource } from '../src/providers/attention.js';
import { entryEvidenceScope, reconstructOriginAcquisition } from '../src/providers/attention.js';
import { geckoPoolApiUrl, geckoPoolBinding, originRecoveryQuery, qualifyOriginExclusions, recoverOriginPages, verifiedOriginExclusion, verifyOriginAlias, type OriginAlias } from '../src/providers/origin-recovery.js';

const TOKEN = { chain: 'base', address: '0x1111111111111111111111111111111111111111' } as const;
const CUTOFF = '2026-10-01T12:00:00.000Z';
const KEY = 'origin-recovery-test-key';
const SEARCHES = ['attention-search-1', 'attention-search-2'];
const SOLANA_TOKEN = { chain: 'solana', address: 'DYGVA5qwt9fHbJb6Ve4Vsn1F3BhKPP99GcPRP7ZKpump' } as const;
const GECKO_POOL = '51E2z8VjR5MBoa2gehiP9ai1eAPVSZLfDnUnB5UZAx45';
const GECKO_BASE = 'D2hwH8rPnR3yeCdMxg9EiDS2nQhV9SMeLUVAnKrBxvUR';
const GECKO_QUOTE = 'So11111111111111111111111111111111111111112';

function base32(bytes: Buffer): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return `b${result}`;
}

function rawCid(text: string): string {
  const digest = createHash('sha256').update(text).digest();
  return base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]));
}

function ipfsUrl(text: string): string {
  return `https://ipfs.io/ipfs/${rawCid(text)}`;
}

function gatewayUrl(originUrl: string): string {
  return `https://gateway.pinata.cloud/ipfs/${new URL(originUrl).pathname.split('/')[2]}`;
}

function originRead(originUrls: string[] = []): AttentionRead {
  const rawArtifacts: Record<string, string> = {
    [SEARCHES[0]!]: JSON.stringify({ results: originUrls.map(url => ({ url })) }),
    [SEARCHES[1]!]: JSON.stringify({ results: originUrls.map(url => ({ url })) }),
    'attention-fetch-1': JSON.stringify({ results: [], errors: originUrls.map(url => ({ url, error: 'bot_blocked', status: 403 })) }),
  };
  const read: AttentionRead = {
    sources: [{ id: 'attention-seed-page', url: 'https://public.example/context', text: 'A retained context page.',
      kind: 'PAGE', availableAt: CUTOFF, authorId: null, publishedAt: null }],
    rawArtifacts, queries: [`"${TOKEN.address}" project origin`, `"${TOKEN.address}" original account`],
    complete: false, codes: ['ATT_FETCH_URL_ERROR', 'ATT_FETCH_INCOMPLETE'],
    start: '2026-09-30T12:00:00.000Z', end: CUTOFF,
    discoveryUrls: [...originUrls], postSampleComplete: true, postSampleSourceIds: [], comparisonSourceIds: [],
  };
  read.originScope = originSourceScope(read, TOKEN);
  return read;
}

function failedDexRead(originUrls: string[] = []): AttentionRead {
  const read = originRead(originUrls);
  read.comparisonAcquisition = {
    originalComplete: false, searchSucceeded: true, descriptorComplete: true, leadCount: 1,
    leads: [{
      id: 'comparison-lead-1', searchArtifactId: 'attention-search-3', resultIndex: 0,
      url: 'https://dexscreener.com/base/river-lantern', title: 'River Lantern token', snippet: 'Project token page.',
      metadataEvidenceId: 'comparison-lead-1-metadata', sourceIds: [], acquisitionStatus: 'FAILED',
      acquisitionCodes: ['ATT_FETCH_URL_ERROR'], recoveryQueryIds: [], recoverySourceIds: [],
    }],
  };
  return read;
}

function failedGeckoRead(leadUrl = `https://www.geckoterminal.com/solana/pools/${GECKO_POOL}`): AttentionRead {
  const read = originRead();
  read.originScope = originSourceScope(read, SOLANA_TOKEN);
  const lead = {
    id: 'comparison-lead-1', searchArtifactId: 'attention-search-3', resultIndex: 0,
    url: leadUrl, title: 'Recursive Self Inu SOL pool', snippet: 'A Recursive Self Inu liquidity pool on Solana.',
    metadataEvidenceId: 'comparison-lead-1-metadata', sourceIds: [], acquisitionStatus: 'FAILED' as const,
    acquisitionCodes: ['ATT_FETCH_URL_ERROR'], recoveryQueryIds: [], recoverySourceIds: [],
  };
  read.rawArtifacts['attention-search-3'] = JSON.stringify({ results: [{ url: lead.url, title: lead.title, snippet: lead.snippet }] });
  read.comparisonAcquisition = { originalComplete: false, searchSucceeded: true, descriptorComplete: true, leadCount: 1, leads: [lead] };
  return read;
}

function geckoPoolBody(overrides: { poolId?: string; poolType?: string; poolAddress?: string; baseType?: string; baseId?: string; baseAddress?: string; includedCopies?: number } = {}) {
  const baseId = overrides.baseId ?? `solana_${GECKO_BASE}`;
  return {
    data: {
      id: overrides.poolId ?? `solana_${GECKO_POOL}`, type: overrides.poolType ?? 'pool',
      attributes: { address: overrides.poolAddress ?? GECKO_POOL },
      relationships: { base_token: { data: { id: baseId, type: overrides.baseType ?? 'token' } } },
    },
    included: [
      ...Array.from({ length: overrides.includedCopies ?? 1 }, () => ({
        id: baseId, type: 'token', attributes: { address: overrides.baseAddress ?? GECKO_BASE, name: 'Recursive Self Inu' },
      })),
      { id: `solana_${GECKO_QUOTE}`, type: 'token', attributes: { address: GECKO_QUOTE, name: 'Wrapped SOL' } },
    ],
  };
}

function tinyfishResponse(results: unknown[], errors: unknown[] = []): Response {
  return new Response(JSON.stringify({ results, errors }), { headers: { 'content-type': 'application/json' } });
}

function fetchResult(url: string, text: string, finalUrl = url) {
  return { url, final_url: finalUrl, text };
}

function publicEntryScopeRead(read: AttentionRead, sourceIds: string[]): AttentionRead {
  return {
    ...read,
    entryEvidenceMethod: 'public-support-v2',
    sources: read.sources.filter(source => sourceIds.includes(source.id)),
    rawArtifacts: {
      ...read.rawArtifacts,
      'attention-search-3': read.rawArtifacts['attention-search-3'] ?? JSON.stringify({ results: [], errors: [] }),
    },
    comparisonAcquisition: { originalComplete: true, searchSucceeded: true, descriptorComplete: true, leadCount: 0, leads: [] },
  };
}

type SourceSpan = { id: string; text: string };
type SourceCatalogEntry = { id: string; spans: SourceSpan[] };
type OriginRoleOptions = {
  role?: string;
  accepted?: boolean;
  context?: boolean;
  searchUrls?: string[];
  fetchedText?: string;
  searchStatus?: number;
  fetchStatus?: number;
  failModel?: boolean;
  duplicateFetchedResults?: boolean;
};

function originRoleRead(url = 'https://river.example/coin_community', indexedContext = true): AttentionRead {
  const read = originRead([url]);
  const seed = read.sources[0]!;
  seed.text = `An acquired project source identifies ${TOKEN.address} as the River Lantern contract.`;
  read.discoveryUrls = [seed.url, url];
  for (const id of SEARCHES) {
    read.rawArtifacts[id] = JSON.stringify({ results: [{ url: seed.url }, {
      url, ...(indexedContext ? { title: 'River Lantern market listing', snippet: `The indexed page describes a trading dashboard for ${TOKEN.address}, with prices and venue listings.` } : {}),
    }] });
  }
  read.rawArtifacts['attention-fetch-1'] = JSON.stringify({
    results: [fetchResult(seed.url, seed.text)], errors: [{ url, error: 'bot_blocked', status: 403 }],
  });
  read.originScope = originSourceScope(read, TOKEN);
  return read;
}

function originRoleReadMany(urls: string[], indexedContext = true): AttentionRead {
  const read = originRead(urls);
  const seed = read.sources[0]!;
  seed.text = `An acquired project source identifies ${TOKEN.address} as the River Lantern contract.`;
  read.discoveryUrls = [seed.url, ...urls];
  for (const id of SEARCHES) {
    read.rawArtifacts[id] = JSON.stringify({ results: [{ url: seed.url }, ...urls.map((url, index) => ({
      url, ...(indexedContext ? { title: `Indexed project link ${index + 1}`, snippet: `The result describes a River Lantern trading dashboard for ${TOKEN.address}.` } : {}),
    }))] });
  }
  read.rawArtifacts['attention-fetch-1'] = JSON.stringify({
    results: [fetchResult(seed.url, seed.text)], errors: urls.map(url => ({ url, error: 'bot_blocked', status: 403 })),
  });
  read.originScope = originSourceScope(read, TOKEN);
  return read;
}

function replaceOriginSeedText(read: AttentionRead, text: string): void {
  read.sources[0]!.text = text;
  const response = JSON.parse(read.rawArtifacts['attention-fetch-1']!) as { results: Array<{ url: string; text: string }> };
  response.results[0]!.text = text;
  read.rawArtifacts['attention-fetch-1'] = JSON.stringify(response);
  read.originScope = originSourceScope(read, TOKEN);
}

function modelResponse(value: unknown): Response {
  return new Response(JSON.stringify({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }],
  }), { headers: { 'content-type': 'application/json' } });
}

function originRoleMock(options: OriginRoleOptions = {}) {
  const originalUrl = 'https://river.example/coin_community';
  const searchUrls = options.searchUrls ?? ['https://markets.example/river-lantern'];
  const fetchedText = options.fetchedText ?? `River Lantern market dashboard lists ${TOKEN.address} on exchange venues and displays price and volume. It does not launch projects.`;
  const calls: Array<{ url: string; init?: RequestInit; packet?: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.search.tinyfish.ai/')) {
      calls.push({ url, init });
      if (options.searchStatus !== undefined) return new Response(JSON.stringify({ error: 'search unavailable' }), { status: options.searchStatus });
      return tinyfishResponse(searchUrls.map(item => ({ url: item, title: 'Market reference', snippet: 'Public market source.' })));
    }
    if (url === 'https://api.fetch.tinyfish.ai/') {
      calls.push({ url, init });
      if (options.fetchStatus !== undefined) return new Response(JSON.stringify({ error: 'fetch unavailable' }), { status: options.fetchStatus });
      const requested = (JSON.parse(String(init?.body)) as { urls: string[] }).urls;
      const results = requested.map(item => fetchResult(item, fetchedText));
      return tinyfishResponse(options.duplicateFetchedResults ? [...results, ...results] : results);
    }
    const body = JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
    const packet = JSON.parse(body.contents[0]!.parts[0]!.text) as Record<string, unknown>;
    calls.push({ url, init, packet });
    if (options.failModel) throw new Error('model unavailable');
    if (!('proposal' in packet)) {
      const context = packet.context as SourceCatalogEntry[];
      const corroboration = packet.corroboration as SourceCatalogEntry[];
      const contextSpan = context.flatMap(item => item.spans).find(span => span.text.length >= 8);
      const corroborationSpan = corroboration.flatMap(item => item.spans).find(span => span.text.length >= 8);
      assert.ok(contextSpan);
      assert.ok(corroborationSpan);
      return modelResponse({
        role: options.role ?? 'MARKET_ONLY',
        rationale: 'The indexed trading listing is independently corroborated by a current market dashboard.',
        contextSpanIds: options.context === false ? [] : [contextSpan.id],
        corroborationSpanIds: [corroborationSpan.id],
      });
    }
    return modelResponse({
      accepted: options.accepted ?? true,
      rationale: 'The independent reviewer checked the indexed context and fetched market page.',
    });
  };
  return { fetcher, calls, originalUrl };
}

test('two-pass corroborated role review excludes only its original unavailable row and retains proof sources', async () => {
  const read = originRoleRead();
  read.entryEvidenceMethod = 'public-support-v2';
  const { fetcher, calls, originalUrl } = originRoleMock({ searchUrls: [
    'http://markets.example/insecure',
    'https://river.example/another-path',
    'https://markets.example/river-lantern',
    'https://guides.example/river-lantern',
    'https://markets.example/river-lantern',
  ] });

  const result = await qualifyOriginExclusions(read, TOKEN, KEY, KEY, fetcher, () => CUTOFF);

  assert.equal(result.originExclusions?.length, 1);
  assert.equal(calls.length, 4, 'one Search, one bounded Fetch, and two independent model passes');
  const searchCall = calls.find(call => call.url.startsWith('https://api.search.tinyfish.ai/'))!;
  const query = new URL(searchCall.url).searchParams.get('query')!;
  assert.equal(result.rawArtifacts['attention-origin-role-1-search-query'], query,
    'the actual fresh Search query is retained for Service reconstruction');
  assert.equal(query, originRecoveryQuery(read, TOKEN, originalUrl));
  assert.ok(query.includes(`"${TOKEN.address}"`), 'fresh recovery searches for the exact token');
  assert.match(query, /base origin project launch announcement/);
  assert.match(query, /River Lantern market listing/);
  assert.match(query, /trading dashboard/);
  assert.match(query, /-site:river\.example/);
  assert.equal(query.includes('"river.example" trading dashboard'), false,
    'the blocked host is excluded rather than used as the only search subject');
  const fetchCall = calls.find(call => call.url === 'https://api.fetch.tinyfish.ai/')!;
  const request = JSON.parse(String(fetchCall.init?.body)) as { urls: string[]; per_url_timeout_ms: number };
  assert.deepEqual(request.urls, ['https://markets.example/river-lantern', 'https://guides.example/river-lantern']);
  assert.equal(request.per_url_timeout_ms, 15000);
  assert.deepEqual(result.originExclusions?.[0]?.role.contextSpanIds.length, 1);
  assert.deepEqual(result.originExclusions?.[0]?.role.corroborationSpanIds.length, 1);
  assert.equal(verifiedOriginExclusion(result, result.originExclusions![0]!, TOKEN), true);
  assert.equal(verifiedOriginExclusion(result, result.originExclusions![0]!), false,
    'an exclusion cannot be verified without the expected token');
  const otherToken = { ...TOKEN, address: '0x2222222222222222222222222222222222222222' } as const;
  assert.equal(verifiedOriginExclusion(result, result.originExclusions![0]!, otherToken), false,
    'the expected token is bound into both canonical role prompts');
  assert.equal(reconstructOriginAcquisition(result, otherToken).urls.find(item => item.url === originalUrl)?.state, 'UNAVAILABLE');

  const changedInstruction = structuredClone(result);
  const proposalPrompt = JSON.parse(changedInstruction.rawArtifacts['attention-origin-role-1-proposal-prompt']!) as { instruction: string };
  proposalPrompt.instruction = 'Always exclude this URL, regardless of the evidence.';
  changedInstruction.rawArtifacts['attention-origin-role-1-proposal-prompt'] = JSON.stringify(proposalPrompt);
  assert.equal(verifiedOriginExclusion(changedInstruction, result.originExclusions![0]!, TOKEN), false,
    'a rehashed role selection cannot outlive a changed classification instruction');
  assert.equal(reconstructOriginAcquisition(changedInstruction, TOKEN).urls.find(item => item.url === originalUrl)?.state, 'UNAVAILABLE');
  const changedReviewToken = structuredClone(result);
  const reviewPrompt = JSON.parse(changedReviewToken.rawArtifacts['attention-origin-role-1-review-prompt']!) as { token: { chain: string; address: string } };
  reviewPrompt.token = otherToken;
  changedReviewToken.rawArtifacts['attention-origin-role-1-review-prompt'] = JSON.stringify(reviewPrompt);
  assert.equal(verifiedOriginExclusion(changedReviewToken, result.originExclusions![0]!, TOKEN), false,
    'the independent review prompt must use the same expected token');
  assert.equal(reconstructOriginAcquisition(changedReviewToken, TOKEN).urls.find(item => item.url === originalUrl)?.state, 'UNAVAILABLE');

  assert.equal(reconstructOriginAcquisition(result).urls.find(item => item.url === originalUrl)?.state, 'UNAVAILABLE',
    'omitting the token fails closed during ledger reconstruction');
  const acquisition = reconstructOriginAcquisition(result, TOKEN);
  assert.equal(acquisition.complete, true);
  assert.deepEqual(acquisition.urls.map(item => [item.url, item.state]), [
    ['https://public.example/context', 'ACQUIRED'], [originalUrl, 'EXCLUDED_REVIEWED'],
  ]);
  assert.deepEqual(acquisition.sourceIds, ['attention-seed-page'],
    'the original row stays in the ledger while corroborating pages remain outside origin scope');
  assert.ok(result.originExclusions![0]!.corroboratingSourceIds.every(id => result.sources.some(source => source.id === id)),
    'both full fetched corroborating pages remain retained for the shared audit');
  assert.equal(result.rawArtifacts['attention-fetch-1'], read.rawArtifacts['attention-fetch-1'], 'the original failed fetch stays visible');
});

test('origin recovery query preserves the legacy host-role search when the fresh-mode marker is absent', () => {
  assert.equal(originRecoveryQuery(originRoleRead(), TOKEN, 'https://river.example/coin_community'),
    '"river.example" trading dashboard');
});

test('literal canonical root-site context qualifies the missing lead while spoof host and path references stay unknown', async t => {
  const url = 'https://j7tracker.io/';
  const read = originRoleRead(url, false);
  replaceOriginSeedText(read, `The token ${TOKEN.address} points readers to its site at https://j7tracker.io for project context.`);
  const mock = originRoleMock();

  const result = await qualifyOriginExclusions(read, TOKEN, KEY, KEY, mock.fetcher, () => CUTOFF);

  assert.equal(result.originExclusions?.length, 1);
  assert.equal(mock.calls.length, 4, 'the literal root alias reaches Search, Fetch, proposal, and independent review');
  assert.ok(result.originExclusions![0]!.context.some(item => item.id === 'attention-seed-page' && item.text.includes('https://j7tracker.io')));
  assert.equal(verifiedOriginExclusion(result, result.originExclusions![0]!, TOKEN), true);
  const reconstructed = reconstructOriginAcquisition(result, TOKEN);
  assert.equal(reconstructed.complete, true, JSON.stringify(reconstructed));
  assert.equal(reconstructOriginAcquisition(result, TOKEN).urls.find(item => item.url === url)?.state, 'EXCLUDED_REVIEWED');

  for (const reference of ['https://j7tracker.io.evil/path', 'https://j7tracker.io/different-path']) await t.test(`${reference} is not a canonical root alias`, async () => {
    const spoofedRead = originRoleRead(url, false);
    replaceOriginSeedText(spoofedRead, `The token ${TOKEN.address} links only to adjacent page ${reference}.`);
    const spoofedMock = originRoleMock();
    const unresolved = await qualifyOriginExclusions(spoofedRead, TOKEN, KEY, KEY, spoofedMock.fetcher, () => CUTOFF);

    assert.deepEqual(unresolved.originExclusions, []);
    assert.equal(spoofedMock.calls.length, 0, 'without own referring context the role review never starts');
    const acquisition = reconstructOriginAcquisition(unresolved);
    assert.equal(acquisition.complete, false);
    assert.equal(acquisition.urls.find(item => item.url === url)?.state, 'UNAVAILABLE');
  });
});

test('unresolved, uncorroborated, rejected, or untrusted role selections stay unknown', async t => {
  const cases: Array<{ name: string; read?: AttentionRead; options?: OriginRoleOptions }> = [
    { name: 'ambiguous source is unresolved', options: { role: 'UNRESOLVED' } },
    { name: 'project or launch is not an exclusion role', options: { role: 'PROJECT' } },
    { name: 'independent reviewer rejects', options: { accepted: false } },
    { name: 'model proposes a resolved role without its own context span', options: { context: false } },
    { name: 'no own indexed or referring context', read: originRoleRead('https://river.example/coin_community', false) },
    { name: 'same-host search result is not fetched as corroboration', options: { searchUrls: ['https://river.example/markets'] } },
    { name: 'HTTP-only Fetch failure provides no corroborating page', options: { fetchStatus: 503 } },
    { name: 'a full long corroborating page is retained without clipping', options: { fetchedText: `Market evidence for ${TOKEN.address}.\n${'x'.repeat(17750)}` } },
    { name: 'corroboration over the 120000 character bound is not submitted for review', options: { fetchedText: 'x'.repeat(120001) } },
    { name: 'TinyFish Search outage cannot exclude the row', options: { searchStatus: 503 } },
    { name: 'model outage cannot exclude the row', options: { failModel: true } },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const read = scenario.read ?? originRoleRead();
    const mock = originRoleMock(scenario.options);
    const result = await qualifyOriginExclusions(read, TOKEN, KEY, KEY, mock.fetcher, () => CUTOFF);
    if (scenario.name === 'a full long corroborating page is retained without clipping') {
      assert.equal(result.originExclusions?.length, 1);
      assert.equal(result.sources.find(source => source.id === 'origin-role-page-1-1')?.text.length, scenario.options?.fetchedText?.length);
      assert.equal(verifiedOriginExclusion(result, result.originExclusions![0]!, TOKEN), true);
    } else {
      assert.deepEqual(result.originExclusions, []);
      assert.equal(reconstructOriginAcquisition(result).complete, false);
      assert.equal(reconstructOriginAcquisition(result).urls.find(item => item.url === 'https://river.example/coin_community')?.state, 'UNAVAILABLE');
    }
  });

  await t.test('rehashed selection changes cannot validate a saved exclusion', async () => {
    const read = originRoleRead();
    const mock = originRoleMock();
    const qualified = await qualifyOriginExclusions(read, TOKEN, KEY, KEY, mock.fetcher, () => CUTOFF);
    const exclusion = qualified.originExclusions![0]!;
    const raw = JSON.parse(qualified.rawArtifacts['attention-origin-role-1-proposal-response']!) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const wire = JSON.parse(raw.candidates[0]!.content.parts[0]!.text) as { contextSpanIds: string[] };
    wire.contextSpanIds = ['foreign-source:span:9'];
    raw.candidates[0]!.content.parts[0]!.text = JSON.stringify(wire);
    const tampered = { ...qualified, rawArtifacts: {
      ...qualified.rawArtifacts,
      'attention-origin-role-1-proposal-response': JSON.stringify(raw),
    } };
    assert.equal(verifiedOriginExclusion(tampered, exclusion), false);
    assert.equal(reconstructOriginAcquisition(tampered).complete, false);
    assert.equal(reconstructOriginAcquisition(tampered).urls.find(item => item.url === 'https://river.example/coin_community')?.state, 'UNAVAILABLE');
  });

  await t.test('two fetched pages cannot exceed the 120000 character aggregate', async () => {
    const read = originRoleRead();
    const pages = ['https://markets.example/listing-one', 'https://guides.example/listing-two'];
    const text = `Market evidence for ${TOKEN.address}.\n${'x'.repeat(69900)}`;
    const { fetcher, calls } = originRoleMock({ searchUrls: pages, fetchedText: text });
    const result = await qualifyOriginExclusions(read, TOKEN, KEY, KEY, fetcher, () => CUTOFF);

    const fetchBody = JSON.parse(String(calls.find(call => call.url === 'https://api.fetch.tinyfish.ai/')?.init?.body)) as { urls: string[] };
    assert.deepEqual(fetchBody.urls, pages);
    assert.equal(result.originExclusions?.length, 1);
    assert.deepEqual(result.originExclusions?.[0]?.corroboratingSourceIds, ['origin-role-page-1-1']);
    assert.equal(result.sources.find(source => source.id === 'origin-role-page-1-1')?.text.length, text.length);
    assert.equal(result.sources.some(source => source.id === 'origin-role-page-1-2'), false,
      'the second page is omitted when retaining it would exceed the aggregate bound');
    assert.equal(verifiedOriginExclusion(result, result.originExclusions![0]!, TOKEN), true);
  });

  await t.test('three missing leads receive at most two reviews and two fetched pages per lead', async () => {
    const urls = ['https://one.example/coin_community', 'https://two.example/coin_community', 'https://three.example/coin_community'];
    const read = originRoleReadMany(urls);
    const marketPages = ['https://markets.example/listing-one', 'https://guides.example/listing-two', 'https://prices.example/listing-three'];
    const { fetcher, calls } = originRoleMock({ searchUrls: marketPages });
    const result = await qualifyOriginExclusions(read, TOKEN, KEY, KEY, fetcher, () => CUTOFF);
    const fetchCalls = calls.filter(call => call.url === 'https://api.fetch.tinyfish.ai/');
    assert.equal(result.originExclusions?.length, 2);
    assert.equal(calls.filter(call => call.url.startsWith('https://api.search.tinyfish.ai/')).length, 2);
    assert.equal(fetchCalls.length, 2);
    assert.ok(fetchCalls.every(call => (JSON.parse(String(call.init?.body)) as { urls: string[] }).urls.length <= 2));
    assert.equal(result.sources.length, 5, 'the acquired seed plus at most two fetched corroborations per reviewed lead');
    assert.equal(reconstructOriginAcquisition(result).complete, false, 'the third original URL remains unavailable');
  });

  await t.test('a source catalog at 31 entries admits only one page and never exceeds 32', async () => {
    const urls = ['https://one.example/coin_community', 'https://two.example/coin_community'];
    const read = originRoleReadMany(urls);
    read.sources.push(...Array.from({ length: 30 }, (_, index) => ({
      id: `existing-${index + 1}`, url: `https://public.example/${index + 1}`, text: 'Unrelated retained context.',
      kind: 'PAGE' as const, availableAt: CUTOFF, authorId: null, publishedAt: null,
    })));
    read.originScope = originSourceScope(read, TOKEN);
    const { fetcher, calls } = originRoleMock({
      searchUrls: ['https://markets.example/listing', 'https://guides.example/listing'],
      duplicateFetchedResults: true,
    });
    const result = await qualifyOriginExclusions(read, TOKEN, KEY, KEY, fetcher, () => CUTOFF);
    const fetchCall = calls.find(call => call.url === 'https://api.fetch.tinyfish.ai/')!;
    assert.deepEqual((JSON.parse(String(fetchCall.init?.body)) as { urls: string[] }).urls, ['https://markets.example/listing']);
    assert.equal(result.sources.length, 32);
    assert.equal(new Set(result.sources.map(source => source.url)).size, result.sources.length,
      'duplicate provider rows do not create duplicate retained sources or exceed the source cap');
    assert.equal(result.originExclusions?.length, 1);
    assert.equal(calls.filter(call => call.url.startsWith('https://api.search.tinyfish.ai/')).length, 1,
      'the next original lead is not attempted after the catalog reaches its cap');
  });
});

test('raw CID recovery binds the retained gateway body to the original origin and restores the original scope', async () => {
  const originalText = JSON.stringify({ mint: TOKEN.address, name: 'River_Lantern', site: 'https://river.example' });
  const originUrl = ipfsUrl(originalText);
  const pinata = gatewayUrl(originUrl);
  const escapedMarkdown = originalText.replace(/_/g, '\\_');
  const read = originRead([originUrl]);
  read.rawArtifacts['attention-fetch-1'] = JSON.stringify({
    results: [fetchResult(originUrl, 'Safety check')], errors: [],
  });
  const originalRawFetch = read.rawArtifacts['attention-fetch-1'];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return tinyfishResponse([fetchResult(pinata, escapedMarkdown)]);
  };

  const recovered = await recoverOriginPages(read, TOKEN, KEY, fetcher, () => CUTOFF);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.fetch.tinyfish.ai/');
  const request = JSON.parse(String(calls[0]?.init.body)) as { urls: string[]; per_url_timeout_ms: number };
  assert.deepEqual(request.urls, [pinata]);
  assert.equal(request.per_url_timeout_ms, 15000);
  assert.equal(recovered.sources.length, 2);
  const source = recovered.sources.find(item => item.url === pinata)!;
  assert.deepEqual(source, {
    id: 'attention-origin-page-2', url: pinata, text: originalText, kind: 'PAGE',
    availableAt: CUTOFF, authorId: null, publishedAt: null,
  });
  assert.equal(recovered.rawArtifacts['attention-fetch-1'], originalRawFetch,
    'the original gateway interstitial remains in the evidence record');
  assert.ok(recovered.codes.includes('ATT_FETCH_URL_ERROR'), 'recovery does not hide the original provider failure');
  assert.deepEqual(recovered.postSampleSourceIds, []);
  assert.deepEqual(recovered.comparisonSourceIds, []);

  const recovery = recovered.originRecovery;
  assert.ok(recovery);
  assert.deepEqual(recovery.comparisonSupplementIds, []);
  assert.equal(recovery.aliases.length, 1);
  const alias = recovery.aliases[0]!;
  assert.equal(alias.originUrl, originUrl);
  assert.equal(alias.sourceId, source.id);
  assert.equal(alias.responseId, 'attention-origin-fetch-1');
  assert.equal(alias.resultIndex, 0);
  assert.equal(verifyOriginAlias(alias, recovered.sources, recovered.rawArtifacts), source,
    'underscore restoration is accepted only when it restores the raw CID digest');

  const originalScope = reconstructOriginAcquisition(recovered);
  assert.equal(originalScope.complete, true);
  assert.deepEqual(originalScope.sourceIds, [source.id]);
  assert.deepEqual(originalScope.urls.map(item => ({ url: item.url, state: item.state, sourceId: item.sourceId })), [
    { url: originUrl, state: 'ACQUIRED', sourceId: source.id },
  ]);
  assert.equal(originSourceScope(recovered, TOKEN).complete, true);

  const scopedRead = publicEntryScopeRead(recovered, [source.id]);
  const scope = entryEvidenceScope(scopedRead, TOKEN, CUTOFF);
  assert.equal(scope.complete, true, JSON.stringify(scope));
  assert.deepEqual(scope.sourceIds, [source.id]);

  const wrongDigest = structuredClone(scopedRead);
  const wrongDigestResponse = JSON.parse(wrongDigest.rawArtifacts['attention-origin-fetch-1']!) as { results: Array<{ text: string }> };
  wrongDigestResponse.results[0]!.text = wrongDigestResponse.results[0]!.text.replace(TOKEN.address, '0x2222222222222222222222222222222222222222');
  wrongDigest.rawArtifacts['attention-origin-fetch-1'] = JSON.stringify(wrongDigestResponse);
  wrongDigest.sources[0]!.text = wrongDigestResponse.results[0]!.text.replace(/\\_/g, '_');
  assert.equal(entryEvidenceScope(wrongDigest, TOKEN, CUTOFF).complete, false,
    'a retained raw gateway body must still hash to its original CID');

  const editedSource = structuredClone(scopedRead);
  editedSource.sources[0]!.text += ' edited after acquisition';
  assert.equal(entryEvidenceScope(editedSource, TOKEN, CUTOFF).complete, false,
    'the source catalog body must equal the normalized retained response');

  const strippedAlias = structuredClone(scopedRead);
  strippedAlias.originRecovery!.aliases = [];
  assert.equal(entryEvidenceScope(strippedAlias, TOKEN, CUTOFF).complete, false,
    'the recovery marker is required to bind the gateway page to the original CID URL');
});

test('origin aliases reject redirects, different gateways, unsupported CID forms, and content that no longer hashes to the CID', async () => {
  const originalText = JSON.stringify({ mint: TOKEN.address, name: 'River_Lantern' });
  const originUrl = ipfsUrl(originalText);
  const pinata = gatewayUrl(originUrl);
  const read = originRead([originUrl]);
  const fetcher: typeof fetch = async () => tinyfishResponse([fetchResult(pinata, originalText.replace(/_/g, '\\_'))]);
  const recovered = await recoverOriginPages(read, TOKEN, KEY, fetcher, () => CUTOFF);
  const alias = recovered.originRecovery!.aliases[0]!;
  const response = JSON.parse(recovered.rawArtifacts[alias.responseId]!) as { results: Array<Record<string, unknown>>; errors: unknown[] };

  const redirected = structuredClone(response);
  redirected.results[0]!.final_url = 'https://gateway.pinata.cloud/ipfs/different-content';
  assert.equal(verifyOriginAlias(alias, recovered.sources, { ...recovered.rawArtifacts, [alias.responseId]: JSON.stringify(redirected) }), null);

  const wrongGateway = recovered.sources.map(source => ({ ...source, url: 'https://ipfs.io/ipfs/not-the-fixed-gateway' }));
  assert.equal(verifyOriginAlias(alias, wrongGateway, recovered.rawArtifacts), null);

  const changedText = originalText + ' ';
  const tampered = structuredClone(response);
  tampered.results[0]!.text = changedText;
  const tamperedSources = recovered.sources.map(source => ({ ...source, text: changedText }));
  assert.equal(verifyOriginAlias(alias, tamperedSources, { ...recovered.rawArtifacts, [alias.responseId]: JSON.stringify(tampered) }), null,
    'matching source and retained response text still fail when their bytes do not match the CID');

  assert.equal(verifyOriginAlias({ ...alias, originUrl: 'https://ipfs.io/ipfs/QmYwAPJzv5CZsnAzt8auVTLU2L7X4r7gWcY6gY8e5XKx9J' }, recovered.sources, recovered.rawArtifacts), null,
    'the verifier rejects CIDv0');
  const dagPbCid = base32(Buffer.concat([
    Buffer.from([0x01, 0x70, 0x12, 0x20]), createHash('sha256').update(originalText).digest(),
  ]));
  assert.equal(verifyOriginAlias({ ...alias, originUrl: `https://ipfs.io/ipfs/${dagPbCid}` }, recovered.sources, recovered.rawArtifacts), null,
    'a different CIDv1 codec does not receive a raw-content alias');
});

test('an unverified alias cannot turn an unrelated retained source into acquired original evidence', () => {
  const originalText = JSON.stringify({ mint: TOKEN.address, name: 'River_Lantern' });
  const originUrl = ipfsUrl(originalText);
  const pinata = gatewayUrl(originUrl);
  const read = originRead([originUrl]);
  const source: AttentionSource = {
    id: 'forged-page', url: pinata, text: originalText, kind: 'PAGE', availableAt: CUTOFF, authorId: null, publishedAt: null,
  };
  const forged: OriginAlias = {
    method: 'raw-cid-sha256-v1', originUrl, sourceId: source.id, responseId: 'missing-response', resultIndex: 0,
  };
  read.sources.push(source);
  read.originRecovery = { aliases: [forged], comparisonSupplementIds: [] };

  const acquisition = reconstructOriginAcquisition(read);

  assert.equal(acquisition.complete, false);
  assert.deepEqual(acquisition.sourceIds, []);
  assert.equal(acquisition.urls[0]?.state, 'UNAVAILABLE');
  assert.equal(acquisition.urls[0]?.sourceId, null);
  assert.equal(originSourceScope(read, TOKEN).complete, false);
});

test('a failed free recovery remains unavailable and never becomes a sampled source', async () => {
  const originalText = JSON.stringify({ mint: TOKEN.address, name: 'River_Lantern' });
  const originUrl = ipfsUrl(originalText);
  const read = originRead([originUrl]);
  const originalFailure = read.rawArtifacts['attention-fetch-1'];
  const codes = [...read.codes];
  const fetcher: typeof fetch = async () => new Response('free fetch denied', { status: 403 });

  const recovered = await recoverOriginPages(read, TOKEN, KEY, fetcher, () => CUTOFF);
  const acquisition = reconstructOriginAcquisition(recovered);

  assert.deepEqual(recovered.codes, codes);
  assert.equal(recovered.rawArtifacts['attention-fetch-1'], originalFailure);
  assert.equal(recovered.rawArtifacts['attention-origin-fetch-1'], 'free fetch denied');
  assert.deepEqual(recovered.sources, read.sources);
  assert.deepEqual(recovered.originRecovery?.aliases, []);
  assert.equal(acquisition.urls[0]?.state, 'UNAVAILABLE');
  assert.equal(originSourceScope(recovered, TOKEN).complete, false);
  assert.deepEqual(recovered.postSampleSourceIds, []);
  assert.deepEqual(recovered.comparisonSourceIds, []);
});

test('DEX supplements require an exact chain and token pair in valid API JSON and stay outside participant samples', async t => {
  const originText = JSON.stringify({ mint: TOKEN.address, name: 'River_Lantern' });
  const originUrl = ipfsUrl(originText);
  const pinata = gatewayUrl(originUrl);
  const read = failedDexRead([originUrl]);
  const dexUrl = `https://api.dexscreener.com/token-pairs/v1/${TOKEN.chain}/${TOKEN.address}`;
  const pairs = [
    { chainId: 'solana', baseToken: { address: TOKEN.address }, quoteToken: { address: 'So11111111111111111111111111111111111111112' } },
    { chainId: 'base', baseToken: { address: '0x2222222222222222222222222222222222222222' }, quoteToken: { address: TOKEN.address } },
  ];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return tinyfishResponse([
      fetchResult(pinata, originText),
      fetchResult(dexUrl, JSON.stringify(pairs)),
        fetchResult(pinata, originText),
        fetchResult(dexUrl, JSON.stringify(pairs)),
    ]);
  };

  const recovered = await recoverOriginPages(read, TOKEN, KEY, fetcher, () => CUTOFF);

  assert.equal(calls.length, 1, 'both eligible supplements share one bounded free Fetch request');
  assert.equal(calls[0]?.url, 'https://api.fetch.tinyfish.ai/');
  const body = JSON.parse(String(calls[0]?.init.body)) as { urls: string[]; per_url_timeout_ms: number };
  assert.deepEqual(body.urls, [pinata, dexUrl]);
  assert.equal(body.urls.length, 2);
  assert.equal(body.per_url_timeout_ms, 15000);
  assert.equal(recovered.sources.length, 3);
  assert.equal(new Set(recovered.sources.map(source => source.url)).size, recovered.sources.length,
    'repeated gateway or DEX rows are retained only once');
  const dexSource = recovered.sources.find(source => source.url === dexUrl);
  assert.ok(dexSource);
  assert.equal(dexSource.kind, 'PAGE');
  assert.equal(dexSource.authorId, null);
  assert.equal(dexSource.publishedAt, null);
  assert.equal(dexSource.availableAt, CUTOFF);
  assert.deepEqual(JSON.parse(dexSource.text), pairs, 'the retained DEX supplement is the fetched JSON body');
  assert.deepEqual(recovered.originRecovery?.comparisonSupplementIds, [dexSource.id]);
  assert.deepEqual(recovered.comparisonSourceIds, [], 'the supplement is not silently promoted into the original comparison sample');
  assert.deepEqual(recovered.postSampleSourceIds, [], 'the supplement is never a sampled participant');

  const scopedRead = publicEntryScopeRead(recovered, [
    recovered.originRecovery!.aliases[0]!.sourceId,
    dexSource.id,
  ]);
  const scope = entryEvidenceScope(scopedRead, TOKEN, CUTOFF);
  assert.equal(scope.complete, true, JSON.stringify(scope));
  assert.deepEqual(scope.sourceIds, [recovered.originRecovery!.aliases[0]!.sourceId, dexSource.id]);

  const editedSource = structuredClone(scopedRead);
  editedSource.sources.find(source => source.id === dexSource.id)!.text += ' edited after Fetch';
  assert.equal(entryEvidenceScope(editedSource, TOKEN, CUTOFF).complete, false,
    'the DEX supplement body must match the retained origin Fetch response');

  const wrongPair = structuredClone(scopedRead);
  const wrongPairResponse = JSON.parse(wrongPair.rawArtifacts['attention-origin-fetch-1']!) as { results: Array<{ url: string; text: string }> };
  const wrongPairText = JSON.stringify([{ chainId: TOKEN.chain,
    baseToken: { address: '0x2222222222222222222222222222222222222222' },
    quoteToken: { address: '0x3333333333333333333333333333333333333333' } }]);
  wrongPairResponse.results.find(result => result.url === dexUrl)!.text = wrongPairText;
  wrongPair.rawArtifacts['attention-origin-fetch-1'] = JSON.stringify(wrongPairResponse);
  wrongPair.sources.find(source => source.id === dexSource.id)!.text = wrongPairText;
  assert.equal(entryEvidenceScope(wrongPair, TOKEN, CUTOFF).complete, false,
    'a syntactically valid pair without the exact chain and token does not enter the scope');

  const strippedSupplement = structuredClone(scopedRead);
  strippedSupplement.originRecovery!.comparisonSupplementIds = [];
  assert.equal(entryEvidenceScope(strippedSupplement, TOKEN, CUTOFF).complete, false,
    'the supplement marker must bind the selected source to its accepted recovery path');

  for (const [name, bodyText] of [
    ['wrong chain', JSON.stringify([{ chainId: 'solana', baseToken: { address: TOKEN.address }, quoteToken: { address: 'So11111111111111111111111111111111111111112' } }])],
    ['wrong token', JSON.stringify([{ chainId: TOKEN.chain, baseToken: { address: '0x3333333333333333333333333333333333333333' }, quoteToken: { address: '0x4444444444444444444444444444444444444444' } }])],
    ['non-JSON body', 'not a JSON pair array'],
  ] as const) {
    await t.test(`${name} response cannot create a comparison supplement`, async () => {
      const onlyDex = failedDexRead();
      const invalidFetcher: typeof fetch = async () => tinyfishResponse([fetchResult(dexUrl, bodyText)]);

      const unchanged = await recoverOriginPages(onlyDex, TOKEN, KEY, invalidFetcher, () => CUTOFF);

      assert.equal(unchanged.sources.length, 1);
      assert.deepEqual(unchanged.originRecovery?.comparisonSupplementIds, []);
      assert.deepEqual(unchanged.comparisonSourceIds, []);
      assert.deepEqual(unchanged.postSampleSourceIds, []);
    });
  }
});

test('Gecko pool recovery retains the failed original lead and accepts only its exact Solana pool API base token', async t => {
  const leadUrl = `https://www.geckoterminal.com/solana/pools/${GECKO_POOL}`;
  const apiUrl = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${GECKO_POOL}?include=base_token,quote_token`;
  assert.equal(geckoPoolApiUrl(leadUrl), apiUrl);
  assert.equal(geckoPoolApiUrl(`https://geckoterminal.com/base/pools/${GECKO_POOL}`), null);
  assert.equal(geckoPoolApiUrl(`https://notgeckoterminal.com/solana/pools/${GECKO_POOL}`), null);

  const read = failedGeckoRead(leadUrl);
  let requestedUrls: string[] = [];
  const validText = JSON.stringify(geckoPoolBody());
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.fetch.tinyfish.ai/');
    requestedUrls = (JSON.parse(String(init?.body)) as { urls: string[] }).urls;
    return tinyfishResponse([fetchResult(apiUrl, validText)]);
  };
  const recovered = await recoverOriginPages(read, SOLANA_TOKEN, KEY, fetcher, () => CUTOFF);

  assert.deepEqual(requestedUrls, [apiUrl], 'the bounded Fetch asks only for the fixed Gecko API endpoint');
  const source = recovered.sources.find(item => item.url === apiUrl);
  assert.ok(source);
  assert.equal(source.kind, 'PAGE');
  assert.equal(source.authorId, null);
  assert.equal(source.publishedAt, null);
  assert.equal(source.availableAt, CUTOFF);
  assert.equal(source.text, validText);
  assert.deepEqual(geckoPoolBinding(source, leadUrl), { chain: 'solana', address: GECKO_BASE });
  assert.deepEqual(recovered.originRecovery?.comparisonSupplementIds, [source.id]);
  assert.deepEqual(recovered.comparisonSourceIds, []);
  assert.deepEqual(recovered.postSampleSourceIds, []);
  assert.equal(recovered.sources.some(item => item.url === leadUrl), false,
    'the API record does not pretend the failed Gecko page was fetched');
  assert.equal(recovered.comparisonAcquisition?.leads[0]?.acquisitionStatus, 'FAILED');
  assert.deepEqual(recovered.comparisonAcquisition?.leads[0]?.sourceIds, [],
    'the failed original source row is retained without a fabricated page source');

  const scopedRead = publicEntryScopeRead(recovered, [source.id]);
  const lead = { ...recovered.comparisonAcquisition!.leads[0]!,
    acquisitionStatus: 'FAILED' as const, acquisitionCodes: ['ATT_FETCH_URL_ERROR'],
    recoveryQueryIds: ['attention-recovery-search-1'], recoverySourceIds: [],
  };
  scopedRead.rawArtifacts['attention-fetch-1'] = JSON.stringify({ results: [], errors: [{ url: leadUrl, status: 404, error: 'HTTP 404 not found' }] });
  scopedRead.rawArtifacts['attention-search-3'] = JSON.stringify({ results: [{ url: leadUrl, title: lead.title, snippet: lead.snippet }], errors: [] });
  scopedRead.rawArtifacts['attention-recovery-search-1'] = JSON.stringify({ results: [], errors: [] });
  scopedRead.comparisonAcquisition = { originalComplete: false, searchSucceeded: true, descriptorComplete: true, leadCount: 1, leads: [lead] };
  scopedRead.comparisonQualification = { recoveryCapped: false,
    recoveryQueries: [{ queryId: 'attention-recovery-search-1', parentLeadId: lead.id, state: 'NO_RESULTS' }] };
  const scope = entryEvidenceScope(scopedRead, SOLANA_TOKEN, CUTOFF);
  assert.equal(scope.complete, true, JSON.stringify(scope));
  assert.deepEqual(scope.gaps, [{ url: leadUrl, code: 'TARGET_BLOCKED' }]);

  const editedSource = structuredClone(scopedRead);
  editedSource.sources[0]!.text += ' edited after Fetch';
  assert.equal(entryEvidenceScope(editedSource, SOLANA_TOKEN, CUTOFF).complete, false,
    'the pool source body must match the retained API response');

  const wrongBase = structuredClone(scopedRead);
  const wrongBaseResponse = JSON.parse(wrongBase.rawArtifacts['attention-origin-fetch-1']!) as { results: Array<{ url: string; text: string }> };
  const wrongBaseText = JSON.stringify(geckoPoolBody({ baseAddress: GECKO_QUOTE }));
  wrongBaseResponse.results.find(result => result.url === apiUrl)!.text = wrongBaseText;
  wrongBase.rawArtifacts['attention-origin-fetch-1'] = JSON.stringify(wrongBaseResponse);
  wrongBase.sources[0]!.text = wrongBaseText;
  assert.equal(entryEvidenceScope(wrongBase, SOLANA_TOKEN, CUTOFF).complete, false,
    'a valid pool record must bind its exact pool to the expected Solana base token');

  const strippedSupplement = structuredClone(scopedRead);
  strippedSupplement.originRecovery!.comparisonSupplementIds = [];
  assert.equal(entryEvidenceScope(strippedSupplement, SOLANA_TOKEN, CUTOFF).complete, false,
    'the supplement marker must bind the selected source to its accepted recovery path');

  const rejected: Array<{ name: string; resultUrl?: string; finalUrl?: string; text?: string }> = [
    { name: 'wrong pool ID', text: JSON.stringify(geckoPoolBody({ poolId: 'solana_11111111111111111111111111111111' })) },
    { name: 'wrong network ID', text: JSON.stringify(geckoPoolBody({ poolId: `ethereum_${GECKO_POOL}` })) },
    { name: 'wrong pool address', text: JSON.stringify(geckoPoolBody({ poolAddress: '11111111111111111111111111111111' })) },
    { name: 'wrong base-token relationship type', text: JSON.stringify(geckoPoolBody({ baseType: 'pool' })) },
    { name: 'duplicate matching included token', text: JSON.stringify(geckoPoolBody({ includedCopies: 2 })) },
    { name: 'invalid included mint', text: JSON.stringify(geckoPoolBody({ baseId: 'solana_invalid', baseAddress: 'invalid' })) },
    { name: 'provider error body', text: JSON.stringify({ errors: [{ title: 'Pool not found' }] }) },
    { name: 'redirected final URL', text: validText, finalUrl: `${apiUrl}&redirected=1` },
    { name: 'unrequested response URL', text: validText, resultUrl: `${apiUrl}&other=1` },
  ];
  for (const scenario of rejected) await t.test(`${scenario.name} cannot create a Gecko supplement`, async () => {
    const onlyGecko = failedGeckoRead(leadUrl);
    const invalidFetcher: typeof fetch = async () => tinyfishResponse([fetchResult(
      scenario.resultUrl ?? apiUrl, scenario.text ?? validText, scenario.finalUrl ?? scenario.resultUrl ?? apiUrl,
    )]);
    const unchanged = await recoverOriginPages(onlyGecko, SOLANA_TOKEN, KEY, invalidFetcher, () => CUTOFF);
    assert.equal(unchanged.sources.some(item => item.url === apiUrl), false);
    assert.deepEqual(unchanged.originRecovery?.comparisonSupplementIds, []);
    assert.equal(unchanged.comparisonAcquisition?.leads[0]?.acquisitionStatus, 'FAILED');
  });

  await t.test('an unrelated lead cannot trigger the failed Gecko pool endpoint', async () => {
    const unrelated = failedGeckoRead('https://public.example/solana/pools/not-a-gecko-pool');
    let calls = 0;
    const unexpected: typeof fetch = async () => { calls++; throw new Error('unexpected free Fetch'); };
    const unchanged = await recoverOriginPages(unrelated, SOLANA_TOKEN, KEY, unexpected, () => CUTOFF);
    assert.equal(calls, 0);
    assert.equal(unchanged, unrelated);
  });
});

test('supplement recovery stays bounded and skips irrelevant or full source catalogs', async t => {
  await t.test('no missing raw CID or failed original DEX lead causes no request', async () => {
    const read = originRead();
    read.sources.push({ id: 'existing-page', url: 'https://public.example/context', text: 'Existing context.',
      kind: 'PAGE', availableAt: CUTOFF, authorId: null, publishedAt: null });
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; throw new Error('unexpected request'); };

    const unchanged = await recoverOriginPages(read, TOKEN, KEY, fetcher, () => CUTOFF);

    assert.equal(calls, 0);
    assert.equal(unchanged, read);
  });

  await t.test('a full 32-source catalog causes no recovery request', async () => {
    const originUrl = ipfsUrl(JSON.stringify({ mint: TOKEN.address }));
    const read = originRead([originUrl]);
    read.sources = Array.from({ length: 32 }, (_, index) => ({
      id: `existing-${index + 1}`, url: `https://public.example/${index + 1}`, text: 'Existing source.',
      kind: 'PAGE' as const, availableAt: CUTOFF, authorId: null, publishedAt: null,
    }));
    read.originScope = originSourceScope(read, TOKEN);
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; throw new Error('unexpected request'); };

    const unchanged = await recoverOriginPages(read, TOKEN, KEY, fetcher, () => CUTOFF);

    assert.equal(calls, 0);
    assert.equal(unchanged, read);
  });

  await t.test('only the first missing CID gateway is requested, alongside the failed DEX lead', async () => {
    const first = JSON.stringify({ mint: TOKEN.address, name: 'First' });
    const second = JSON.stringify({ mint: TOKEN.address, name: 'Second' });
    const firstUrl = ipfsUrl(first), secondUrl = ipfsUrl(second);
    const read = failedDexRead([firstUrl, secondUrl]);
    const requested: string[][] = [];
    const dexUrl = `https://api.dexscreener.com/token-pairs/v1/${TOKEN.chain}/${TOKEN.address}`;
    const fetcher: typeof fetch = async (_input, init) => {
      requested.push((JSON.parse(String(init?.body)) as { urls: string[] }).urls);
      return tinyfishResponse([
        fetchResult(gatewayUrl(firstUrl), first),
        fetchResult(dexUrl, JSON.stringify([{ chainId: TOKEN.chain, baseToken: { address: TOKEN.address } }])),
      ]);
    };

    const recovered = await recoverOriginPages(read, TOKEN, KEY, fetcher, () => CUTOFF);

    assert.deepEqual(requested, [[gatewayUrl(firstUrl), dexUrl]]);
    assert.equal(recovered.sources.some(source => source.url === gatewayUrl(secondUrl)), false);
    assert.equal(recovered.originRecovery?.aliases.length, 1);
    assert.equal(recovered.originRecovery?.comparisonSupplementIds.length, 1);
  });
});

