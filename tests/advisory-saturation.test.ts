import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveSaturationVector,
  hashQueryBasket,
  HOLDER_POPULATION_METHOD,
  SATURATION_INPUT_METHOD,
  SATURATION_METHOD,
  type SaturationVector,
} from '../src/domain/advisory-saturation.js';

// Synthetic fixtures only. Nothing here is observed X, Helius or DEX data, and no case claims A24 acceptance.
type Fixture = any;
const MINT = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump';
const OTHER_MINT = 'So11111111111111111111111111111111111111112';
const PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SHA = `sha256:${'a'.repeat(64)}`;
const at = (clock: string) => `2026-10-20T${clock}.000Z`;
const T0 = at('10:00:00'), T1 = at('11:00:00');
const done = (result: unknown, ref = 'raw:page-1') => ({ status: 'COMPLETE', result, refs: [ref] });
const gap = (status = 'UNAVAILABLE') => ({ status, result: null, refs: ['raw:failure-1'] });
const review = (label: string) => done({ label, rubricVersion: 'forward-call-v1' });
const CONTRACT_QUERY = { id: 'q-contract', kind: 'EXACT_CONTRACT', query: MINT, bindingProofRef: null };
const PROJECT_QUERY = { id: 'q-project', kind: 'PROVEN_ACCOUNT', query: 'from:syntheticproject', bindingProofRef: 'proof:project-account' };

const post = (postId: string, authorId: string, clock: string, extra: Record<string, unknown> = {}) => ({
  postId,
  queryId: 'q-contract',
  role: 'ORIGINAL',
  identity: done({ authorId, handle: `user${authorId}`, revisionFamilyId: postId }),
  time: done({ createdAt: at(clock) }),
  body: done({ sha256: SHA }),
  binding: done('BODY_CONTAINS_MINT'),
  forwardCall: review('OTHER'),
  paidText: done({ disclosed: false, rubricVersion: 'paid-disclosure-v1' }),
  paidLabels: done({ labels: [], evidence: 'WIRE', evidenceRef: `wire:${postId}` }),
  ...extra,
});
const snapshot = (slot: number, blockTime: string, positiveOwners: number) => ({
  mint: MINT,
  programId: PROGRAM,
  provider: 'helius',
  method: HOLDER_POPULATION_METHOD,
  exclusionPolicy: 'include-program-and-pool-owners-v1',
  commitment: 'finalized',
  slot,
  blockTime,
  population: done({ positiveOwners }, `helius:census:${slot}`),
  supply: { status: 'COMPLETE', refs: [`helius:supply:${slot}`] },
  manifestId: `holders:${slot}`,
  manifestSha256: SHA,
});
const setQueries = (f: Fixture, queries: Fixture[]) => {
  const hash = hashQueryBasket(queries as never);
  f.x.queries = queries;
  f.x.queryHash = hash;
  f.x.captures = queries.flatMap((q) =>
    ['W0', 'W1'].map((window) => ({ window, queryId: q.id, status: 'COMPLETE', reasonCode: null, queryHash: hash, manifestId: `manifest:${window}:${q.id}`, manifestSha256: SHA, refs: [`raw:${window}:${q.id}`] })),
  );
  return f;
};

// W0: authors 100, 200. W1: author 100 x3, 300, 400; one repost and one unbound post are excluded.
const fixture = (): Fixture =>
  setQueries(
    {
      method: SATURATION_INPUT_METHOD,
      token: { chain: 'solana', mint: MINT },
      frame: { t0: T0, t1: T1 },
      cutoff: at('11:20:00'),
      evidenceIds: ['evidence:b', 'evidence:a'],
      x: {
        source: 'chrome-devtools-response-export',
        sourceVersion: '0.5',
        access: 'USER_SESSION_READ',
        eligibilityVersion: 'eligibility-v1',
        forwardCallRubricVersion: 'forward-call-v1',
        paidDisclosureRubricVersion: 'paid-disclosure-v1',
        windows: { w0: { start: at('09:00:00'), end: T0 }, w1: { start: T0, end: T1 } },
        collector: { startedAt: at('11:05:00'), finishedAt: at('11:10:00'), maxClockSkewMs: 1000 },
        posts: [
          post('101', '100', '09:10:00'),
          post('102', '200', '09:20:00'),
          post('201', '100', '10:05:00', { forwardCall: review('FORWARD_CALL') }),
          post('202', '100', '10:10:00'),
          post('203', '100', '10:15:00'),
          post('204', '300', '10:20:00', { forwardCall: review('NEWS') }),
          post('205', '400', '10:30:00', {
            forwardCall: review('FORWARD_CALL'),
            paidText: done({ disclosed: true, rubricVersion: 'paid-disclosure-v1' }),
            paidLabels: done({ labels: ['PAID_PARTNERSHIP'], evidence: 'DOM_SNAPSHOT', evidenceRef: 'dom:205' }),
          }),
          post('206', '500', '10:40:00', { role: 'REPOST' }),
          post('207', '600', '10:50:00', { binding: done('NOT_BOUND') }),
        ],
      },
      holders: { s0: snapshot(1000, T0, 337), s1: snapshot(9000, T1, 336) },
      dex: {
        mint: MINT,
        source: 'dexscreener-orders-v1',
        availableAt: at('11:06:00'),
        manifestId: 'dex:orders',
        manifestSha256: SHA,
        refs: ['raw:dex-orders'],
        observations: [
          { kind: 'ORDER', venue: 'dexscreener', id: null, type: 'tokenProfile', status: 'approved', paymentAt: at('10:30:00') },
          { kind: 'BOOST', venue: 'dexscreener', id: 'boost-1', type: 'boost', status: null, paymentAt: at('08:00:00') },
        ],
      },
    },
    [{ ...CONTRACT_QUERY }],
  );

const derive = (f: Fixture): SaturationVector => deriveSaturationVector(f);
const mutate = (change: (f: Fixture) => void) => {
  const f = fixture();
  change(f);
  return f;
};
const find = (f: Fixture, postId: string) => f.x.posts.find((p: Fixture) => p.postId === postId);
const known = (f: Fixture) => {
  const v = derive(f);
  assert.equal(v.quality, 'KNOWN', `${v.reasonCode}`);
  return v.data!;
};
const missing = (f: Fixture, reasonCode: string) => {
  const v = derive(f);
  assert.deepEqual([v.quality, v.reasonCode], ['MISSING', reasonCode]);
  return v.data!;
};
const invalid = (f: Fixture, reasonCode: string) => {
  const v = derive(f);
  assert.deepEqual([v.quality, v.reasonCode, v.data, v.scope], ['INVALID', reasonCode, null, null]);
};
const invalidCases = (cases: [string, (f: Fixture) => void][]) => {
  for (const [code, change] of cases) invalid(mutate(change), code);
};

test('complete synthetic vector reports exact counts, fractions, rates and negative holder growth', () => {
  const v = derive(fixture());
  assert.deepEqual([v.id, v.method, v.quality, v.reasonCode], ['A24', SATURATION_METHOD, 'KNOWN', null]);
  assert.deepEqual(v.evidenceIds, ['evidence:a', 'evidence:b']);
  const d = v.data!;
  assert.deepEqual(d.windows.w0, {
    status: 'COMPLETE', reasonCode: null, posts: 2, authors: 2,
    countsByAuthor: [{ authorId: '100', posts: 1 }, { authorId: '200', posts: 1 }], excludedReposts: 0, excludedUnbound: 0,
  });
  assert.deepEqual(d.windows.w1.countsByAuthor, [{ authorId: '100', posts: 3 }, { authorId: '300', posts: 1 }, { authorId: '400', posts: 1 }]);
  assert.deepEqual([d.windows.w1.excludedReposts, d.windows.w1.excludedUnbound], [1, 1]);
  assert.deepEqual(d.repeatedAuthor.value, { posts: 5, authors: 3, repeatPosts: 2, share: { numerator: 2, denominator: 5, value: '0.4' } });
  const novelty = d.sourceNovelty.value!;
  assert.deepEqual([novelty.newAuthorIds, novelty.returningAuthorIds, novelty.share!.numerator, novelty.share!.denominator], [['300', '400'], ['100'], 2, 3]);
  assert.match(novelty.share!.value, /^0[.]6{49}7$/);
  assert.deepEqual(d.callerBreadth.value, { callers: 2, callerAuthorIds: ['100', '400'], reviewedPosts: 5 });
  const mention = d.mentionGrowth.value!;
  assert.deepEqual([mention.n0, mention.n1, mention.rate.change, mention.rate.durationSeconds, mention.relative, mention.relativeReason], [2, 5, 3, '3600', { numerator: 3, denominator: 2, value: '1.5' }, null]);
  assert.match(mention.rate.perSecond, /^0[.]00083{49}$/);
  const holders = d.holderGrowth.value!;
  assert.deepEqual([holders.unit, holders.h0, holders.h1, holders.rate.change, holders.s0, holders.s1], ['POSITIVE_OWNER_ADDRESSES', 337, 336, -1, { slot: 1000, blockTime: T0 }, { slot: 9000, blockTime: T1 }]);
  assert.match(holders.rate.perSecond, /^-0[.]00027{48}8$/);
  const paid = d.paidVisibility;
  assert.deepEqual([paid.status, paid.hiddenPayments], ['COMPLETE', 'NOT_MEASURED']);
  assert.deepEqual(paid.dex.value!.groups, [
    { venue: 'dexscreener', kind: 'BOOST', type: 'boost', status: null, timing: 'BEFORE_INTERVAL', count: 1 },
    { venue: 'dexscreener', kind: 'ORDER', type: 'tokenProfile', status: 'approved', timing: 'IN_INTERVAL', count: 1 },
  ]);
  assert.deepEqual([paid.x.value!.inspectedPosts, paid.x.value!.disclosedPosts, paid.x.value!.labelledPosts], [5, 1, 1]);
  assert.deepEqual(paid.x.value!.posts.find((p) => p.postId === '205'), { postId: '205', authorId: '400', disclosed: true, labels: ['PAID_PARTNERSHIP'], labelEvidence: 'DOM_SNAPSHOT' });
  const flat = known(mutate((f) => { f.holders.s1.population = done({ positiveOwners: 337 }); }));
  assert.deepEqual(flat.holderGrowth.value!.rate, { change: 0, durationSeconds: '3600', perSecond: '0' });
});

test('vector is descriptive only and echoes frozen scope without a score or gate', () => {
  const f = fixture();
  const v = derive(f);
  assert.deepEqual(Object.keys(v).sort(), ['data', 'evidenceIds', 'id', 'limitations', 'method', 'quality', 'reasonCode', 'scope']);
  assert.deepEqual(Object.keys(v.data!).sort(), ['callerBreadth', 'holderGrowth', 'mentionGrowth', 'paidVisibility', 'repeatedAuthor', 'sourceNovelty', 'windows']);
  assert.ok(v.limitations.some((l) => /not externally trusted proof/.test(l)));
  const scope = v.scope!;
  assert.deepEqual(scope.frame, { w0: { start: at('09:00:00'), end: T0 }, w1: { start: T0, end: T1 }, durationSeconds: '3600', convention: 'HALF_OPEN_START_INCLUSIVE' });
  assert.equal('queryHash' in scope.x && scope.x.queryHash, f.x.queryHash);
  assert.equal('method' in scope.holders && scope.holders.method, HOLDER_POPULATION_METHOD);
  assert.deepEqual(derive(mutate((g) => { delete g.evidenceIds; })).evidenceIds, []);
});

test('zero baseline leaves only optional relative growth undefined', () => {
  const d = known(mutate((f) => { f.x.posts = f.x.posts.filter((p: Fixture) => !['101', '102'].includes(p.postId)); }));
  const mention = d.mentionGrowth;
  assert.deepEqual([mention.reasonCode, mention.value!.n0, mention.value!.relative, mention.value!.relativeReason], [null, 0, null, 'BASELINE_ZERO']);
  assert.deepEqual(d.sourceNovelty.value!.share, { numerator: 3, denominator: 3, value: '1' });
  assert.deepEqual(d.sourceNovelty.value!.returningAuthorIds, []);
});

test('complete empty current window keeps measured zeros but leaves shares undefined', () => {
  const d = missing(mutate((f) => { f.x.posts = f.x.posts.filter((p: Fixture) => ['101', '102'].includes(p.postId)); }), 'REPEAT_DENOMINATOR_ZERO');
  assert.deepEqual(d.repeatedAuthor, { status: 'COMPLETE', reasonCode: 'REPEAT_DENOMINATOR_ZERO', value: { posts: 0, authors: 0, repeatPosts: 0, share: null } });
  assert.deepEqual([d.sourceNovelty.reasonCode, d.sourceNovelty.value!.share], ['NOVELTY_DENOMINATOR_ZERO', null]);
  assert.deepEqual(d.callerBreadth.value, { callers: 0, callerAuthorIds: [], reviewedPosts: 0 });
  assert.deepEqual([d.mentionGrowth.value!.rate.change, d.mentionGrowth.value!.relative], [-2, { numerator: -2, denominator: 2, value: '-1' }]);
  assert.deepEqual([d.paidVisibility.x.value!.inspectedPosts, d.holderGrowth.status], [0, 'COMPLETE']);
});

test('caller breadth zero needs complete review; non-call labels and W0 reviews do not count', () => {
  const labels = ['NEWS', 'JOKE', 'WARNING', 'RETROSPECTIVE', 'OTHER'];
  const zero = known(mutate((f) => {
    f.x.posts.forEach((p: Fixture, i: number) => { p.forwardCall = review(labels[i % labels.length]); });
    find(f, '101').forwardCall = gap();
  }));
  assert.deepEqual(zero.callerBreadth, { status: 'COMPLETE', reasonCode: null, value: { callers: 0, callerAuthorIds: [], reviewedPosts: 5 } });
  const pending = missing(mutate((f) => { find(f, '204').forwardCall = gap('INCOMPLETE'); }), 'FORWARD_CALL_REVIEW_INCOMPLETE');
  assert.deepEqual(pending.callerBreadth, { status: 'INCOMPLETE', reasonCode: 'FORWARD_CALL_REVIEW_INCOMPLETE', value: null });
  assert.equal(pending.repeatedAuthor.value!.share!.value, '0.4');
});

test('pending qualifications block their windows instead of shrinking denominators', () => {
  const time = missing(mutate((f) => { find(f, '202').time = gap('UNAVAILABLE'); }), 'POST_TIME_UNQUALIFIED');
  assert.deepEqual([time.windows.w0.status, time.windows.w1.status, time.repeatedAuthor.value, time.mentionGrowth.value], ['UNAVAILABLE', 'UNAVAILABLE', null, null]);
  const identity = missing(mutate((f) => { find(f, '202').identity = gap('INCOMPLETE'); }), 'POST_IDENTITY_UNQUALIFIED');
  assert.deepEqual([identity.windows.w0.status, identity.windows.w1.posts, identity.holderGrowth.status], ['COMPLETE', null, 'COMPLETE']);
  const body = missing(mutate((f) => { Object.assign(find(f, '203'), { body: gap('TRUNCATED'), binding: gap('INCOMPLETE'), forwardCall: gap(), paidText: gap() }); }), 'POST_BODY_UNQUALIFIED');
  assert.deepEqual(body.repeatedAuthor, { status: 'TRUNCATED', reasonCode: 'POST_BODY_UNQUALIFIED', value: null });
  const repost = known(mutate((f) => { find(f, '206').time = gap(); }));
  assert.equal(repost.windows.w1.excludedReposts, 0);
});

test('capture truncation yields no fractions while unaffected components remain', () => {
  const d = missing(mutate((f) => {
    Object.assign(f.x.captures.find((c: Fixture) => c.window === 'W1'), { status: 'TRUNCATED', reasonCode: 'X_PAGE_CAP_REACHED' });
  }), 'X_PAGE_CAP_REACHED');
  assert.deepEqual(d.windows.w1, { status: 'TRUNCATED', reasonCode: 'X_PAGE_CAP_REACHED', posts: null, authors: null, countsByAuthor: null, excludedReposts: null, excludedUnbound: null });
  for (const component of [d.repeatedAuthor, d.sourceNovelty, d.callerBreadth, d.mentionGrowth, d.paidVisibility.x]) {
    assert.deepEqual(component, { status: 'TRUNCATED', reasonCode: 'X_PAGE_CAP_REACHED', value: null });
  }
  assert.deepEqual([d.windows.w0.posts, d.holderGrowth.status, d.paidVisibility.dex.status], [2, 'COMPLETE', 'COMPLETE']);
});

test('paid visibility stays missing for uninspected labels or disclosure text and never reports zero ads', () => {
  const labels = missing(mutate((f) => { find(f, '203').paidLabels = gap('UNAVAILABLE'); }), 'PAID_LABEL_INSPECTION_MISSING');
  assert.deepEqual(labels.paidVisibility.x, { status: 'UNAVAILABLE', reasonCode: 'PAID_LABEL_INSPECTION_MISSING', value: null });
  assert.deepEqual([labels.paidVisibility.status, labels.paidVisibility.dex.status, labels.paidVisibility.hiddenPayments, labels.callerBreadth.status], ['UNAVAILABLE', 'COMPLETE', 'NOT_MEASURED', 'COMPLETE']);
  missing(mutate((f) => { find(f, '203').paidText = gap('INCOMPLETE'); }), 'PAID_DISCLOSURE_REVIEW_INCOMPLETE');
  const none = known(mutate((f) => {
    find(f, '205').paidText = done({ disclosed: false, rubricVersion: 'paid-disclosure-v1' });
    find(f, '205').paidLabels = done({ labels: [], evidence: 'WIRE', evidenceRef: 'wire:205' });
  }));
  const x = none.paidVisibility.x.value!;
  assert.deepEqual([x.inspectedPosts, x.disclosedPosts, x.labelledPosts, none.paidVisibility.hiddenPayments], [5, 0, 0, 'NOT_MEASURED']);
});

test('DEX paid snapshot binds to mint, cutoff and window end; observed empty is valid', () => {
  const empty = known(mutate((f) => { f.dex.observations = []; }));
  assert.deepEqual(empty.paidVisibility.dex.value, { availableAt: at('11:06:00'), observations: 0, groups: [] });
  const stale = missing(mutate((f) => { f.dex.availableAt = at('10:59:59'); }), 'DEX_SNAPSHOT_BEFORE_WINDOW_END');
  assert.deepEqual([stale.paidVisibility.dex.value, stale.paidVisibility.x.status], [null, 'COMPLETE']);
  const failed = missing(mutate((f) => { f.dex = { status: 'UNAVAILABLE', reasonCode: 'DEX_HTTP_503', refs: ['raw:dex-failure'] }; }), 'DEX_HTTP_503');
  assert.equal(failed.paidVisibility.x.value!.inspectedPosts, 5);
  invalidCases([
    ['DEX_MINT_MISMATCH', (f) => { f.dex.mint = OTHER_MINT; }],
    ['DEX_AFTER_CUTOFF', (f) => { f.dex.availableAt = at('11:20:01'); }],
    ['DEX_PAYMENT_AFTER_SNAPSHOT', (f) => { f.dex.observations[0].paymentAt = at('11:07:00'); }],
    ['DEX_DUPLICATE_OBSERVATION', (f) => { f.dex.observations.push({ ...f.dex.observations[1], paymentAt: at('08:30:00') }); }],
    ['DEX_OBSERVATION_SHAPE', (f) => { f.dex.observations[1].status = 'approved'; }],
    ['INPUT_SCHEMA_INVALID', (f) => { f.dex.observations[0].status = 'unknown'; }],
  ]);
});

test('holder growth incompleteness and source failure preserve other components', () => {
  const truncated = missing(mutate((f) => { f.holders.s1.population = gap('TRUNCATED'); }), 'HOLDER_POPULATION_INCOMPLETE');
  assert.deepEqual(truncated.holderGrowth, { status: 'TRUNCATED', reasonCode: 'HOLDER_POPULATION_INCOMPLETE', value: null });
  assert.equal(truncated.repeatedAuthor.value!.share!.value, '0.4');
  const supply = missing(mutate((f) => { f.holders.s0.supply = { status: 'INCOMPLETE', refs: ['helius:supply-mismatch'] }; }), 'HOLDER_SUPPLY_UNRECONCILED');
  assert.equal(supply.holderGrowth.value, null);
  const failed = missing(mutate((f) => { f.holders = { status: 'UNAVAILABLE', reasonCode: 'HELIUS_HTTP_503', refs: ['raw:helius-failure'] }; }), 'HELIUS_HTTP_503');
  assert.deepEqual([failed.holderGrowth.status, failed.mentionGrowth.status, failed.paidVisibility.status], ['UNAVAILABLE', 'COMPLETE', 'COMPLETE']);
});

test('X source failure is missing, not zero, and keeps holder and DEX components', () => {
  const v = derive(mutate((f) => { f.x = { status: 'UNAVAILABLE', reasonCode: 'X_LOGIN_WALL', refs: ['raw:x-login-wall'] }; }));
  assert.deepEqual([v.quality, v.reasonCode, v.scope!.x], ['MISSING', 'X_LOGIN_WALL', { status: 'UNAVAILABLE', reasonCode: 'X_LOGIN_WALL' }]);
  const d = v.data!;
  assert.deepEqual([d.windows.w1.posts, d.callerBreadth.value, d.paidVisibility.x.status], [null, null, 'UNAVAILABLE']);
  assert.deepEqual([d.holderGrowth.value!.h1, d.paidVisibility.dex.status], [336, 'COMPLETE']);
});

test('windows are adjacent half-open intervals with end-exclusive boundaries', () => {
  const d = known(mutate((f) => {
    f.x.posts.push(post('301', '700', '11:00:00'), post('302', '800', '10:00:00'), post('303', '900', '09:00:00'), post('304', '901', '08:59:59'));
  }));
  assert.deepEqual([d.windows.w0.posts, d.windows.w1.posts], [3, 6]);
  const w0 = d.windows.w0.countsByAuthor!.map((c) => c.authorId), w1 = d.windows.w1.countsByAuthor!.map((c) => c.authorId);
  assert.deepEqual([w1.includes('800'), w1.includes('700'), w0.includes('900'), w0.includes('901')], [true, false, true, false]);
});

test('identical multi-query duplicates deduplicate; conflicting or repeated entries are invalid', () => {
  const withCopy = (change: (copy: Fixture) => void) =>
    mutate((f) => {
      setQueries(f, [{ ...CONTRACT_QUERY }, { ...PROJECT_QUERY }]);
      const copy = structuredClone(find(f, '203'));
      copy.queryId = 'q-project';
      copy.time.refs = ['raw:page-9'];
      change(copy);
      f.x.posts.push(copy);
    });
  const same = known(withCopy(() => {}));
  assert.deepEqual([same.windows.w1.posts, same.repeatedAuthor.value!.repeatPosts], [5, 2]);
  invalid(withCopy((copy) => { copy.time = done({ createdAt: at('10:16:00') }); }), 'POST_DUPLICATE_CONFLICT');
  const renamed = known(withCopy((copy) => { copy.identity.result.handle = 'renamed'; }));
  assert.deepEqual([renamed.windows.w1.posts, renamed.windows.w1.authors], [5, 3]);
  invalid(withCopy((copy) => { copy.identity.result.authorId = '999'; }), 'POST_DUPLICATE_CONFLICT');
  invalid(withCopy((copy) => { copy.identity.result.revisionFamilyId = '999'; }), 'POST_DUPLICATE_CONFLICT');
  invalid(withCopy((copy) => { copy.body = done({ sha256: `sha256:${'c'.repeat(64)}` }); }), 'POST_DUPLICATE_CONFLICT');
  invalid(withCopy((copy) => { copy.forwardCall = review('FORWARD_CALL'); }), 'POST_DUPLICATE_CONFLICT');
  invalid(withCopy((copy) => { copy.paidText = done({ disclosed: true, rubricVersion: 'paid-disclosure-v1' }); }), 'POST_DUPLICATE_CONFLICT');
  invalid(withCopy((copy) => { copy.queryId = 'q-contract'; }), 'POST_DUPLICATE_CONFLICT');
});

test('stable author IDs govern identity; handles are display metadata; revisions conflict', () => {
  const renamed = known(mutate((f) => { find(f, '202').identity.result.handle = 'renamed_user'; }));
  assert.equal(renamed.windows.w1.authors, 3);
  const reused = known(mutate((f) => { find(f, '204').identity.result.handle = 'user100'; }));
  assert.deepEqual(reused.sourceNovelty.value!.newAuthorIds, ['300', '400']);
  invalid(mutate((f) => { find(f, '203').identity.result.revisionFamilyId = '202'; }), 'REVISION_FAMILY_CONFLICT');
});

test('window, query, basket and source mismatches are invalid', () => {
  invalidCases([
    ['X_WINDOW_MISMATCH', (f) => { f.x.windows.w0.start = at('09:00:01'); }],
    ['X_WINDOW_MISMATCH', (f) => { f.x.windows.w1.start = at('10:00:01'); }],
    ['QUERY_HASH_MISMATCH', (f) => { f.x.queries[0].query = `${MINT} OR synthetic`; }],
    ['CAPTURE_QUERY_HASH_MISMATCH', (f) => { f.x.captures[0].queryHash = `sha256:${'b'.repeat(64)}`; }],
    ['CAPTURE_BASKET_INCOMPLETE', (f) => { setQueries(f, [{ ...CONTRACT_QUERY }, { ...PROJECT_QUERY }]); f.x.captures.pop(); }],
    ['INPUT_SCHEMA_INVALID', (f) => { f.x.captures.pop(); }],
    ['QUERY_BINDING_INVALID', (f) => { setQueries(f, [{ ...CONTRACT_QUERY, query: 'SYNTHETIC_TICKER' }]); }],
    ['QUERY_BINDING_INVALID', (f) => { setQueries(f, [{ ...CONTRACT_QUERY, query: `${MINT}A` }]); }],
    ['QUERY_BINDING_INVALID', (f) => { setQueries(f, [{ ...CONTRACT_QUERY, query: `A${MINT} lang:en` }]); }],
    ['EXACT_CONTRACT_QUERY_MISSING', (f) => { setQueries(f, [{ ...PROJECT_QUERY }]); }],
    ['POST_QUERY_UNKNOWN', (f) => { find(f, '201').queryId = 'q-other'; }],
    ['BINDING_PROOF_QUERY_MISSING', (f) => { find(f, '201').binding = done('PROVEN_ACCOUNT'); }],
    ['INPUT_SCHEMA_INVALID', (f) => { f.x.source = 'tinyfish-fetch'; }],
    ['INPUT_SCHEMA_INVALID', (f) => { f.token.chain = 'ethereum'; }],
    ['INPUT_SCHEMA_INVALID', (f) => { f.method = 'a24-saturation-input-v2'; }],
  ]);
});

test('clock and chronology contradictions are invalid', () => {
  invalidCases([
    ['FRAME_NOT_INCREASING', (f) => { f.frame.t1 = T0; }],
    ['FRAME_AFTER_CUTOFF', (f) => { f.cutoff = at('10:59:00'); }],
    ['COLLECTOR_STARTED_BEFORE_WINDOW_END', (f) => { f.x.collector.startedAt = at('11:00:00'); }],
    ['COLLECTOR_CLOCK_REVERSED', (f) => { f.x.collector.finishedAt = at('11:04:00'); }],
    ['COLLECTOR_AFTER_CUTOFF', (f) => { f.cutoff = at('11:10:00'); }],
    ['POST_AFTER_COLLECTION', (f) => { find(f, '201').time = done({ createdAt: at('11:30:00') }); }],
    ['INPUT_SCHEMA_INVALID', (f) => { f.frame.t0 = '2026-10-20T12:00:00.000+02:00'; }],
    ['INPUT_SCHEMA_INVALID', (f) => { f.cutoff = '2026-02-30T12:00:00.000Z'; }],
    ['INPUT_SCHEMA_INVALID', (f) => { f.x.collector.maxClockSkewMs = -1; }],
  ]);
});

test('holder mint, program, policy, provider, slot and frame mismatches are invalid', () => {
  invalidCases([
    ['HOLDER_MINT_MISMATCH', (f) => { f.holders.s1.mint = OTHER_MINT; }],
    ['HOLDER_POLICY_MISMATCH', (f) => { f.holders.s1.programId = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'; }],
    ['HOLDER_POLICY_MISMATCH', (f) => { f.holders.s1.exclusionPolicy = 'exclude-pool-owners-v1'; }],
    ['HOLDER_SLOT_ORDER', (f) => { f.holders.s1.slot = 1000; }],
    ['HOLDER_FRAME_MISMATCH', (f) => { f.holders.s1.blockTime = at('11:00:01'); }],
    ['HOLDER_FRAME_MISMATCH', (f) => { f.holders.s0.blockTime = at('09:59:59'); }],
    ['INPUT_SCHEMA_INVALID', (f) => { f.holders.s0.provider = 'quicknode'; }],
    ['INPUT_SCHEMA_INVALID', (f) => { f.holders.s1.method = 'token-account-count-v1'; }],
    ['INPUT_SCHEMA_INVALID', (f) => { f.holders.s0.commitment = 'confirmed'; }],
    ['INPUT_SCHEMA_INVALID', (f) => { f.holders.s0.population = done({ positiveOwners: -1 }); }],
  ]);
});

test('injected fields and internally contradictory qualifications are rejected', () => {
  assert.equal(deriveSaturationVector(null).reasonCode, 'INPUT_SCHEMA_INVALID');
  invalidCases([
    ['INPUT_SCHEMA_INVALID', (f) => { f.quality = 'KNOWN'; }],
    ['INPUT_SCHEMA_INVALID', (f) => { f.entryGate = 'PASS'; }],
    ['INPUT_SCHEMA_INVALID', (f) => { find(f, '201').weight = 2; }],
    ['INPUT_SCHEMA_INVALID', (f) => { find(f, '201').identity.result.verifiedHuman = true; }],
    ['INPUT_SCHEMA_INVALID', (f) => { f.holders.s0.positiveOwnersOverride = 999; }],
    ['INPUT_SCHEMA_INVALID', (f) => { f.evidenceIds = ['bad id with spaces']; }],
    ['EVIDENCE_ID_DUPLICATE', (f) => { f.evidenceIds = ['evidence:a', 'evidence:a']; }],
    ['QUALIFICATION_RESULT_CONTRADICTION', (f) => { find(f, '203').identity.status = 'INCOMPLETE'; }],
    ['QUALIFICATION_RESULT_CONTRADICTION', (f) => { find(f, '203').paidLabels = { status: 'COMPLETE', result: null, refs: ['raw:page-1'] }; }],
    ['CAPTURE_STATUS_CONTRADICTION', (f) => { f.x.captures[1].status = 'TRUNCATED'; }],
    ['FORWARD_CALL_REVIEW_INCONSISTENT', (f) => { find(f, '201').forwardCall = done({ label: 'FORWARD_CALL', rubricVersion: 'forward-call-v2' }); }],
    ['BINDING_WITHOUT_FULL_BODY', (f) => { find(f, '203').body = gap('TRUNCATED'); }],
    ['PAID_TEXT_REVIEW_INCONSISTENT', (f) => { Object.assign(find(f, '203'), { body: gap('TRUNCATED'), binding: gap('INCOMPLETE'), forwardCall: gap() }); }],
    ['PAID_LABELS_NOT_CANONICAL', (f) => { find(f, '205').paidLabels = done({ labels: ['PROMOTED', 'PAID_PARTNERSHIP'], evidence: 'WIRE', evidenceRef: 'wire:205' }); }],
  ]);
});

test('DEX snapshot freshness allows exactly 15 minutes before cutoff and misses one millisecond older', () => {
  const edge = known(mutate((f) => { f.dex.availableAt = at('11:05:00'); }));
  assert.deepEqual(edge.paidVisibility.dex.value!.groups.map((g) => g.timing), ['BEFORE_INTERVAL', 'IN_INTERVAL']);
  const stale = missing(mutate((f) => { f.dex.availableAt = '2026-10-20T11:04:59.999Z'; }), 'DEX_SNAPSHOT_STALE');
  assert.deepEqual(
    [stale.paidVisibility.dex.status, stale.paidVisibility.dex.value, stale.paidVisibility.x.status, stale.holderGrowth.status],
    ['INCOMPLETE', null, 'COMPLETE', 'COMPLETE'],
  );
  const baselineZero = known(mutate((f) => {
    f.dex.availableAt = at('11:05:00');
    f.x.posts = f.x.posts.filter((p: Fixture) => !['101', '102'].includes(p.postId));
  }));
  assert.equal(baselineZero.mentionGrowth.value!.relative, null);
});

test('exact-contract query accepts a quoted full mint with a predeclared filter', () => {
  const d = known(mutate((f) => { setQueries(f, [{ ...CONTRACT_QUERY, query: `"${MINT}" lang:en` }]); }));
  assert.equal(d.windows.w1.posts, 5);
});
