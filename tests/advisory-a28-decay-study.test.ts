import test from 'node:test';
import assert from 'node:assert/strict';
import { A28_METHOD, A28_PROFILE_SHA256, A28_SUBJECT, A28_START, A28_END, A28_BIN_SECONDS, A28_FRANKIE, a28StudyInputSchema, evaluateA28Study, deriveA28DecayMetric, roundedShiftLogA, roundedMeanStart, roundedVarianceStart, roundedProfileRelative, roundedIntervalMass, classifyRounded, fitRoundedSeconds, type A28StudyInput } from '../src/providers/advisory-a28-decay-study.js';
const near = (a: number, b: number, tol = 1e-10) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b)), `${a} != ${b}`);
const START = Date.parse(A28_START) / 1000, END = Date.parse(A28_END) / 1000;
const iso = (s: number) => new Date(s * 1000).toISOString();
function input(counts = [1, 4, 3, 2, 1, 0, 0, 0, 0]): A28StudyInput {
    let id = 1000;
    const posts: A28StudyInput['posts'] = [];
    for (const [i, n] of counts.entries())
        for (let j = 0; j < n; j++)
            posts.push({ postId: String(id++), groupId: 'group-' + id, publishedAt: iso(START + i * A28_BIN_SECONDS + 3600 + j * 100), primaryEligible: true, alternativeEligible: true });
    return { method: A28_METHOD, profileSha256: A28_PROFILE_SHA256, sourceFrameSha256: '8528d7480e8bc9ee39a98a4dd0ee0a02cbaf04aa711f116b3a4f5119451eeacc', qualificationSha256: '3ddc464a8cadb28831abfd1dd6b2ce75cd3309712206610d9f33e9b0a58b8fb8', catalystDispositionsSha256: '233bff0e84e63df15a2a27e05cd3f9d97f4753442911ed542bd27ea27eedf103', adjudicationContractSha256: 'a18c9f2476e9ad2da772520790fb367b1c4be2ae8992f76d35851eab636b7b3d', packagedAt: '2026-11-05T12:00:00.000Z', evaluationCutoff: '2026-11-05T13:00:00.000Z', source: { status: 'COMPLETE', reason: null, availableAt: '2026-11-05T11:00:00.000Z', sourceIds: ['source'] }, posts, catalysts: [] };
}
test('stable signed rounded kernels match independent finite geometric enumeration', () => {
    for (const T of [2, 4, 16, 5000])
        for (const x of [-20, -1, -.001, 0, .001, 1, 20]) {
            const logs = Array.from({ length: T }, (_, j) => -x * j / T), max = Math.max(...logs), weights = logs.map(l => Math.exp(l - max)), total = weights.reduce((a, b) => a + b, 0), mean = weights.reduce((s, w, j) => s + w * j / T, 0) / total, variance = weights.reduce((s, w, j) => s + w * (j / T - mean) ** 2, 0) / total;
            near(roundedShiftLogA(x, T), max + Math.log(total) - Math.log(T));
            near(roundedMeanStart(x, T), mean);
            near(roundedVarianceStart(x, T), variance);
            near(roundedMeanStart(x, T) + roundedMeanStart(-x, T), 1 - 1 / T);
        }
});
test('rounded profile equals the full Poisson cell likelihood retaining zero cells', () => {
    const indices = [0, 1, 1, 3], T = 4, n = indices.length, Z = (k: number, t: number) => k === 0 ? t : -Math.expm1(-k * t) / k;
    const logL = (x: number) => { const k = x / T, a = n / Z(k, T); return Array.from({ length: T }, (_, j) => { const count = indices.filter(i => i === j).length, mu = a * Math.exp(-k * j) * Z(k, 1); return count * Math.log(mu) - mu; }).reduce((a, b) => a + b, 0); };
    for (const x of [-8, -1, 0, 1, 8])
        near(roundedProfileRelative(x, indices, T), logL(x) - logL(0), 1e-12);
    const continuousApprox = -n * Math.log(-Math.expm1(-8) / 8) - 8 * indices.reduce((a, b) => a + b, 0) / T;
    assert.ok(Math.abs(continuousApprox - roundedProfileRelative(8, indices, T)) > .1, 'one-second normalization cannot be discarded');
});
test('closed-form two-cell MLE, flat/growth symmetry and signed support roots', () => {
    const pos = fitRoundedSeconds([0, 0, 0, 1], 2), neg = fitRoundedSeconds([0, 1, 1, 1], 2), flat = fitRoundedSeconds([0, 1], 2);
    near(pos.x, 2 * Math.log(3));
    near(neg.x, -pos.x);
    assert.equal(flat.x, 0);
    assert.equal(neg.halfLifePointSeconds, null);
    assert.equal(flat.halfLifePointSeconds, null);
    for (const f of [pos, neg, flat])
        for (const edge of [f.signedRateSupport.lowerX, f.signedRateSupport.upperX])
            near(2 * (f.profileRelativeToFlat - roundedProfileRelative(edge, f === pos ? [0, 0, 0, 1] : f === neg ? [0, 1, 1, 1] : [0, 1], 2)), 4);
    near(pos.signedRateSupport.lowerX, -neg.signedRateSupport.upperX);
    near(pos.signedRateSupport.upperX, -neg.signedRateSupport.lowerX);
    assert.ok(pos.solver.relativeWidth <= 1e-10 && pos.solver.objectiveError <= 1e-10);
});
test('empty, one-cell and interval-endpoint concentrations do not manufacture finite MLE', () => {
    assert.equal(classifyRounded([], 10), 'NO_EVENTS');
    assert.equal(classifyRounded([0], 1), 'ONE_CELL');
    assert.equal(classifyRounded([0, 0], 10), 'FIRST_CELL_BOUNDARY');
    assert.equal(classifyRounded([9, 9], 10), 'LAST_CELL_BOUNDARY');
    for (const [indices, T] of [[[], 10], [[0], 1], [[0, 0], 10], [[9, 9], 10]] as [
        number[],
        number
    ][])
        assert.throws(() => fitRoundedSeconds(indices, T), /NO_FINITE_UNIQUE_MLE/);
    near(roundedProfileRelative(10000, [0, 0], 10), 2 * Math.log(10));
    near(roundedProfileRelative(-10000, [9, 9], 10), 2 * Math.log(10));
});
test('signed support crossing zero keeps unbounded positive half-life and nondecay flags', () => {
    const fit = fitRoundedSeconds([100, 200], 1000);
    assert.ok(fit.x > 0);
    assert.ok(fit.signedRateSupport.lowerK < 0 && fit.signedRateSupport.upperK > 0);
    assert.equal(fit.signedRateSupport.nonDecaySupported, true);
    assert.equal(fit.positiveHalfLifeSupport.upper.kind, 'UNBOUNDED');
    assert.ok(fit.positiveHalfLifeSupport.lowerSeconds! > 0);
    assert.match(fit.signedRateSupport.interpretation, /NOT_95_PERCENT/);
});
test('all-negative signed support has no positive half-life support', () => { const f = fitRoundedSeconds([8, 9, 9, 9], 10); assert.ok(f.signedRateSupport.upperK < 0); assert.equal(f.positiveHalfLifeSupport.positiveDecaySupported, false); assert.equal(f.positiveHalfLifeSupport.lowerSeconds, null); assert.equal(f.positiveHalfLifeSupport.upper.kind, 'NONE'); assert.equal(f.halfLifePointSeconds, null); });
test('large finite slopes bracket without clipping and exact interval masses retain zeros', () => {
    const indices = [...Array(127).fill(0), 1], T = 201600, fit = fitRoundedSeconds(indices, T);
    assert.ok(fit.x > 100000);
    assert.ok(fit.solver.doublings > 10);
    assert.ok(fit.signedRateSupport.lowerSolver.objectiveError <= 1e-10);
    assert.ok(fit.signedRateSupport.upperSolver.objectiveError <= 1e-10);
    near(Array.from({ length: 7 }, (_, i) => roundedIntervalMass(fit.x, i * 28800, (i + 1) * 28800, T)).reduce((a, b) => a + b, 0), 1);
    near(roundedIntervalMass(-2, 0, 2, 10), roundedIntervalMass(2, 8, 10, 10));
});
test('valid descriptive two-case fit retains fixed exposure, zero residual bins and event recording intervals', () => {
    const result = evaluateA28Study(input());
    assert.equal(result.quality, 'KNOWN');
    assert.equal(result.interpretations.length, 2);
    assert.ok(result.sensitivityEnvelope.allCasesIndividuallyFitted);
    for (const v of result.interpretations) {
        assert.deepEqual(v.binCounts, [1, 4, 3, 2, 1, 0, 0, 0, 0]);
        assert.equal(v.peak!.lastBin, 1);
        assert.equal(v.peak!.tailBins, 7);
        assert.ok(v.fit!.halfLifePointSeconds! > 0);
        assert.equal(v.fit!.residuals.length, 7);
        near(v.fit!.residuals.reduce((s, r) => s + r.expected, 0), v.fit!.n);
        near(v.fit!.residuals.reduce((s, r) => s + r.residual, 0), 0);
        assert.ok(v.fit!.residuals.some(r => r.observed === 0 && r.expected > 0));
        assert.ok(v.fit!.eventTimeVector.every(e => e.recordingIntervalEndSecondExclusive - e.recordingIntervalStartSecond === 1 && e.fittedCumulativeAtStart <= e.fittedCumulativeAtEnd));
        assert.equal(v.fit!.cumulativeIntensity.at(-1)!.at, A28_END);
        near(v.fit!.cumulativeIntensity.at(-1)!.fittedExpectedCount, v.fit!.n);
        assert.equal(v.fit!.censoring.wholeTrailingExposureRetained, true);
        assert.ok(v.fit!.censoring.trailingExposureAfterLastPublicationCellSeconds > 0);
    }
});
test('group dedup uses earliest eligible second and native decimal ID tie independently of input order', () => {
    const x = input(), first = x.posts[0]!;
    x.posts.push({ ...first, postId: '9' });
    x.posts.push({ ...first, postId: '1', publishedAt: iso(Date.parse(first.publishedAt) / 1000 + 1) });
    x.posts.reverse();
    const r = evaluateA28Study(x);
    for (const v of r.interpretations) {
        assert.equal(v.representatives.find(p => p.groupId === first.groupId)!.postId, '9');
        assert.equal(v.representatives.length, input().posts.length);
    }
});
test('all declared alternatives are fitted separately; only the optional Frankie membership may differ', () => {
    const x = input(), last = x.posts.find(p => Math.floor((Date.parse(p.publishedAt) / 1000 - START) / 28800) === 4)!;
    last.postId = A28_FRANKIE;
    last.alternativeEligible = false;
    const r = evaluateA28Study(x);
    assert.equal(r.quality, 'KNOWN');
    assert.notEqual(r.interpretations[0]!.fit!.halfLifePointSeconds, r.interpretations[1]!.fit!.halfLifePointSeconds);
    assert.deepEqual(r.sensitivityEnvelope.caseNames, ['PRIMARY', 'FRANKIE_EXCLUDED']);
    const wrong = input();
    wrong.posts[0]!.alternativeEligible = false;
    assert.throws(() => evaluateA28Study(wrong), /UNDECLARED_MEMBERSHIP_ALTERNATIVE/);
    const included = input();
    included.posts[0]!.postId = A28_FRANKIE;
    assert.throws(() => evaluateA28Study(included), /FRANKIE_EXCLUDED_ALTERNATIVE/);
});
test('last global maximum and contiguous plateau are fixed, including disconnected earlier equal maxima', () => {
    const last = evaluateA28Study(input([1, 4, 1, 4, 2, 1, 0, 0, 0]));
    assert.equal(last.quality, 'KNOWN');
    assert.equal(last.interpretations[0]!.peak!.firstBin, 3);
    assert.equal(last.interpretations[0]!.peak!.lastBin, 3);
    const plateau = evaluateA28Study(input([1, 4, 4, 3, 1, 0, 0, 0, 0]));
    assert.equal(plateau.quality, 'KNOWN');
    assert.equal(plateau.interpretations[0]!.peak!.firstBin, 1);
    assert.equal(plateau.interpretations[0]!.peak!.lastBin, 2);
});
test('peak disagreement across the complete alternative set clears all fits before numeric fitting', () => {
    const x = input([1, 4, 4, 2, 1, 0, 0, 0, 0]), frankie = x.posts.find(p => Math.floor((Date.parse(p.publishedAt) / 1000 - START) / 28800) === 2)!;
    frankie.postId = A28_FRANKIE;
    frankie.alternativeEligible = false;
    const r = evaluateA28Study(x);
    assert.equal(r.quality, 'MISSING');
    assert.equal(r.reasonCode, 'A28_QUALIFICATION_PEAK_DISAGREEMENT');
    assert.ok(r.interpretations.every(v => v.fit === null));
});
test('boundary/no-tail/quiet-tail failures return missing and never shift or truncate the window', () => {
    for (const counts of [[4, 3, 2, 1, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0, 0, 4], [1, 0, 0, 0, 0, 0, 0, 4, 1], [1, 4, 0, 0, 0, 0, 0, 0, 0], [1, 4, 3, 0, 0, 0, 0, 0, 3]]) {
        const r = evaluateA28Study(input(counts));
        assert.equal(r.quality, 'MISSING');
        assert.ok(r.interpretations.every(v => v.fit === null));
        assert.equal(r.sensitivityEnvelope, null);
    }
});
test('one interior tail event is allowed without an arbitrary minimum while support may include nondecay', () => {
    const x = input([1, 0, 0, 0, 0, 0, 2, 1, 0]);
    x.posts.at(-1)!.publishedAt = iso(START + 7 * 28800 + 20000);
    const r = evaluateA28Study(x);
    assert.equal(r.quality, 'KNOWN');
    assert.equal(r.interpretations[0]!.fit!.n, 1);
    assert.equal(r.interpretations[0]!.fit!.positiveHalfLifeSupport.upper.kind, 'UNBOUNDED');
});
test('exact integer rounded flat/growth/boundary gates fail despite first-tail count exceeding final', () => {
    const flat = input([1, 0, 0, 3, 2, 0, 0, 1, 1]), fitStart = START + 4 * 28800, tail = flat.posts.filter(p => Date.parse(p.publishedAt) / 1000 >= fitStart);
    assert.equal(tail.length, 4);
    for (const [i, j] of [20000, 23999, 100000, 143999].entries())
        tail[i]!.publishedAt = iso(fitStart + j);
    assert.equal(evaluateA28Study(flat).reasonCode, 'A28_FINITE_FLAT');
    const growth = structuredClone(flat);
    growth.posts.find(p => p.postId === tail[1]!.postId)!.publishedAt = iso(fitStart + 24000);
    assert.equal(evaluateA28Study(growth).reasonCode, 'A28_FINITE_GROWTH');
    const decay = structuredClone(flat);
    decay.posts.find(p => p.postId === tail[1]!.postId)!.publishedAt = iso(fitStart + 23998);
    assert.equal(evaluateA28Study(decay).quality, 'KNOWN');
    const boundary = input([1, 3, 2, 0, 0, 0, 0, 0, 0]);
    for (const p of boundary.posts.filter(p => Date.parse(p.publishedAt) / 1000 >= START + 2 * 28800))
        p.publishedAt = iso(START + 2 * 28800);
    assert.equal(evaluateA28Study(boundary).reasonCode, 'A28_FIRST_CELL_BOUNDARY');
});
test('catalyst context barriers include excluded-source context anywhere in the whole half-open fit range', () => {
    const x = input(), fitStart = START + 2 * 28800;
    x.catalysts = [{ id: 'excluded-source-context', publishedAt: iso(fitStart), barrier: true, sourceIds: ['context'] }];
    let r = evaluateA28Study(x);
    assert.equal(r.reasonCode, 'A28_RETAINED_CATALYST_BARRIER');
    assert.ok(r.interpretations.every(v => v.fit === null));
    x.catalysts[0]!.publishedAt = iso(END - 1);
    assert.equal(evaluateA28Study(x).quality, 'MISSING');
    x.catalysts[0]!.publishedAt = iso(END);
    assert.equal(evaluateA28Study(x).quality, 'KNOWN');
    x.catalysts[0]!.publishedAt = iso(fitStart - 1);
    assert.equal(evaluateA28Study(x).quality, 'KNOWN');
    x.catalysts[0]!.publishedAt = iso(fitStart);
    x.catalysts[0]!.barrier = false;
    assert.equal(evaluateA28Study(x).quality, 'KNOWN');
});
test('strict full DTO/source/precision/ownership validation precedes missing and outside-subject returns', () => {
    const owned = new Set(['source']), x = input(), metric = deriveA28DecayMetric(A28_SUBJECT, x.evaluationCutoff, x, owned);
    assert.equal(metric.id, 'A28');
    assert.equal(metric.quality, 'KNOWN');
    const other = { chain: 'solana', address: 'So11111111111111111111111111111111111111112' };
    assert.equal(deriveA28DecayMetric(other, x.evaluationCutoff, x, owned).reasonCode, 'A28_OUTSIDE_FROZEN_SUBJECT');
    for (const edit of [(v: any) => v.posts.push({ ...v.posts[0] }), (v: any) => v.posts[0].publishedAt = '2026-10-23T20:00:00.500Z', (v: any) => v.posts[0].publishedAt = A28_END, (v: any) => v.profileSha256 = '0'.repeat(64), (v: any) => v.source.claimedComplete = true, (v: any) => v.packagedAt = '2026-11-06T00:00:00Z', (v: any) => v.posts[0].alternativeEligible = false]) {
        const bad = structuredClone(x);
        edit(bad);
        assert.throws(() => deriveA28DecayMetric(other, x.evaluationCutoff, bad, owned));
    }
    assert.throws(() => deriveA28DecayMetric(A28_SUBJECT, x.evaluationCutoff, x, new Set()), /UNOWNED_SOURCE/);
    assert.throws(() => deriveA28DecayMetric(A28_SUBJECT, '2026-11-05T13:00:01Z', x, owned), /CUTOFF/);
    const missing = input();
    missing.source.status = 'MISSING';
    missing.source.reason = 'SOURCE_MEMBERSHIP_UNRESOLVED';
    assert.equal(evaluateA28Study(missing).quality, 'MISSING');
    assert.deepEqual(evaluateA28Study(missing).interpretations, []);
    const max = input();
    max.posts = Array.from({ length: 129 }, (_, i) => ({ ...x.posts[0]!, postId: String(10000 + i), groupId: 'g' + i }));
    assert.equal(a28StudyInputSchema.safeParse(max).success, false);
});
