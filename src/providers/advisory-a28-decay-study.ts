import { z } from 'zod';
import { s18Instant } from './advisory-s18-study.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
export const A28_METHOD = 'a28-native-provided-sample-interval-nhpp-decay-v1' as const;
export const A28_PROFILE_SHA256 = 'd08352c04405b80c41bf9c1b53d2f3c54571bceb8d87d8692cd707484894401c';
export const A28_SOURCE_FRAME_SHA256 = '8528d7480e8bc9ee39a98a4dd0ee0a02cbaf04aa711f116b3a4f5119451eeacc';
export const A28_QUALIFICATION_SHA256 = '3ddc464a8cadb28831abfd1dd6b2ce75cd3309712206610d9f33e9b0a58b8fb8';
export const A28_CATALYST_DISPOSITIONS_SHA256 = '233bff0e84e63df15a2a27e05cd3f9d97f4753442911ed542bd27ea27eedf103';
export const A28_ADJUDICATION_SHA256 = 'a18c9f2476e9ad2da772520790fb367b1c4be2ae8992f76d35851eab636b7b3d';
export const A28_SUBJECT = { chain: 'solana' as const, address: 'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump' };
export const A28_START = '2026-10-23T20:00:00.000Z', A28_END = '2026-10-26T20:00:00.000Z', A28_BIN_SECONDS = 28800, A28_FRANKIE = '2114795091244015796';
export const A28_LIMITS = {
    scope: 'FINITE_NATIVE_QUOTED_LITERAL_DELIVERED_VIEWERQUERY_CATALOGUE_NOT_ALL_X_RECALL_OR_POPULATION_RATE',
    sourceAuthority: 'EXTERNAL_ORIGINAL_SOURCE_AUTHENTICATOR_REQUIRED_DTO_FLAGS_IDS_AND_STATUS_DO_NOT_AUTHENTICATE_SOURCE',
    qualification: 'TWO_COMPLETE_DECLARED_MEMBERSHIP_CASES_EARLIEST_GROUP_REPRESENTATIVES_NOT_INDEPENDENT_PEOPLE_OR_ORIGINS',
    exposure: 'SAME_DECLARED_CATALOGUE_INSTRUMENT_RANGE_EXPOSURE_NOT_VERIFIED_CONSTANT_POPULATION_INCLUSION',
    model: 'DESCRIPTIVE_INDEPENDENT_POISSON_ZERO_BACKGROUND_ASSUMPTION_NOT_EMPIRICAL_MODEL_ADEQUACY',
    selection: 'RETROSPECTIVE_FIXED_9X8H_LAST_GLOBAL_MAX_PLATEAU_NOT_PREREGISTERED_OR_SELECTION_ADJUSTED',
    timing: 'NATIVE_PUBLICATION_SECONDS_AS_ONE_SECOND_INTERVALS_NO_JITTER_OR_ID_CLOCK_SUBSTITUTION',
    uncertainty: 'RELATIVE_WORKING_LIKELIHOOD_SUPPORT_CUTOFF4_NOT_95_PERCENT_CI_PVALUE_OR_CALIBRATED_COVERAGE',
    interpretation: 'KNOWN_MEANS_COMPLETE_IDENTIFIED_SCOPED_MODEL_FIT_VECTOR_NOT_PHYSICAL_POPULATION_DECAY_CAUSAL_OR_PREDICTIVE',
    censoring: 'FIXED_SOURCE_END_RETAINS_TRAILING_EMPTY_EXPOSURE_NO_EXTINCTION_OR_GLOBAL_NO_CATALYST_CLAIM',
    residuals: 'DESCRIPTIVE_FITTED_SELECTED_SPARSE_RESIDUALS_NO_CHI_SQUARE_KS_OR_OTHER_REFERENCE_PVALUE',
} as const;
const instant = z.string().refine(v => s18Instant(v) !== null), id = z.string().min(1).max(256), postId = z.string().regex(/^[1-9][0-9]{0,29}$/);
const second = instant.refine(v => s18Instant(v)! % 1000000000n === 0n, 'NATIVE_SECOND_REQUIRED');
const ids = z.array(id).max(10000).refine(a => new Set(a).size === a.length);
export const a28StudyInputSchema = z.object({
    method: z.literal(A28_METHOD), profileSha256: z.literal(A28_PROFILE_SHA256),
    sourceFrameSha256: z.literal(A28_SOURCE_FRAME_SHA256),
    qualificationSha256: z.literal(A28_QUALIFICATION_SHA256),
    catalystDispositionsSha256: z.literal(A28_CATALYST_DISPOSITIONS_SHA256),
    adjudicationContractSha256: z.literal(A28_ADJUDICATION_SHA256),
    packagedAt: instant, evaluationCutoff: instant,
    source: z.object({ status: z.enum(['COMPLETE', 'MISSING']), reason: id.nullable(), availableAt: instant, sourceIds: ids }).strict(),
    posts: z.array(z.object({ postId, groupId: id, publishedAt: second, primaryEligible: z.boolean(), alternativeEligible: z.boolean() }).strict()).max(128).refine(a => new Set(a.map(p => p.postId)).size === a.length),
    catalysts: z.array(z.object({ id, publishedAt: second, barrier: z.boolean(), sourceIds: ids.min(1) }).strict()).max(512).refine(a => new Set(a.map(c => c.id)).size === a.length),
}).strict();
export type A28StudyInput = z.infer<typeof a28StudyInputSchema>;
export type A28Post = A28StudyInput['posts'][number];
const fail = (code: string): never => { throw new Error('A28_' + code); };
function must(v: unknown, code: string): asserts v { if (!v)
    fail(code); }
const ns = (v: string) => s18Instant(v)!;
const sec = (v: string) => Number(ns(v) / 1000000000n);
const startSecond = sec(A28_START), endSecond = sec(A28_END);
function prepare(raw: unknown): A28StudyInput {
    const x = a28StudyInputSchema.parse(raw), packaged = ns(x.packagedAt), available = ns(x.source.availableAt);
    must(packaged <= ns(x.evaluationCutoff) && available <= packaged && available >= ns(A28_END), 'SOURCE_PACKAGING_CLOCK');
    must((x.source.status === 'COMPLETE') === (x.source.reason === null), 'SOURCE_REASON');
    must(x.source.status !== 'COMPLETE' || x.source.sourceIds.length > 0, 'SOURCE_IDS');
    for (const p of x.posts) {
        must(sec(p.publishedAt) >= startSecond && sec(p.publishedAt) < endSecond && ns(p.publishedAt) <= available, 'POST_SOURCE_RANGE');
        must(p.primaryEligible === p.alternativeEligible || p.postId === A28_FRANKIE && p.primaryEligible === true && p.alternativeEligible === false, 'UNDECLARED_MEMBERSHIP_ALTERNATIVE');
        if (p.postId === A28_FRANKIE)
            must(!p.alternativeEligible, 'FRANKIE_EXCLUDED_ALTERNATIVE');
    }
    for (const c of x.catalysts)
        must(ns(c.publishedAt) <= available, 'CATALYST_SOURCE_CLOCK');
    return x;
}
const TOL = 1e-10, MAX_DOUBLINGS = 128, MAX_BISECTIONS = 256;
function finite(x: number, code = 'NUMERIC_NONFINITE'): number { must(Number.isFinite(x), code); return x; }
function validateMath(indices: number[], T: number) { must(Number.isSafeInteger(T) && T >= 1 && indices.length <= 128 && indices.every(j => Number.isSafeInteger(j) && j >= 0 && j < T), 'MATH_CELL_INPUT'); must(indices.reduce((s, j) => s + BigInt(j), 0n) <= BigInt(Number.MAX_SAFE_INTEGER) && BigInt(indices.length) * BigInt(T - 1) <= BigInt(Number.MAX_SAFE_INTEGER), 'MATH_INTEGER_SUM_RANGE'); }
export function roundedShiftLogA(x: number, T: number): number {
    must(Number.isSafeInteger(T) && T >= 1, 'MATH_EXPOSURE');
    finite(x);
    if (T === 1)
        return 0;
    const r = 1 / T;
    if (Math.abs(x) < .1)
        return -(1 - r) * x / 2 + (1 - r * r) * x * x / 24 - (1 - r ** 4) * x ** 4 / 2880 + (1 - r ** 6) * x ** 6 / 181440 - (1 - r ** 8) * x ** 8 / 9676800;
    const y = Math.abs(x), v = Math.log(-Math.expm1(-y)) - Math.log(-Math.expm1(-r * y)) - Math.log(T);
    return finite(x >= 0 ? v : y * (1 - r) + v);
}
export function roundedMeanStart(x: number, T: number): number {
    must(Number.isSafeInteger(T) && T >= 1, 'MATH_EXPOSURE');
    finite(x);
    if (T === 1)
        return 0;
    const r = 1 / T;
    if (Math.abs(x) < .1)
        return (1 - r) / 2 - (1 - r * r) * x / 12 + (1 - r ** 4) * x ** 3 / 720 - (1 - r ** 6) * x ** 5 / 30240 + (1 - r ** 8) * x ** 7 / 1209600 - (1 - r ** 10) * x ** 9 / 47900160;
    if (x < 0)
        return (1 - r) - roundedMeanStart(-x, T);
    const B = (y: number) => Math.exp(-y) / (-Math.expm1(-y));
    return finite(r * B(r * x) - B(x));
}
export function roundedVarianceStart(x: number, T: number): number {
    must(Number.isSafeInteger(T) && T >= 1, 'MATH_EXPOSURE');
    finite(x);
    if (T === 1)
        return 0;
    const r = 1 / T, y = Math.abs(x);
    if (y < .1)
        return (1 - r * r) / 12 - (1 - r ** 4) * x * x / 240 + (1 - r ** 6) * x ** 4 / 6048 - (1 - r ** 8) * x ** 6 / 172800 + (1 - r ** 10) * x ** 8 / 5322240;
    const C = (z: number) => Math.exp(-z) / (-Math.expm1(-z)) ** 2;
    return finite(r * r * C(r * y) - C(y));
}
export function roundedProfileRelative(x: number, indices: number[], T: number): number {
    validateMath(indices, T);
    finite(x);
    if (x < 0)
        return roundedProfileRelative(-x, indices.map(j => T - 1 - j), T);
    return finite(-indices.length * roundedShiftLogA(x, T) - x * (indices.reduce((s, j) => s + j, 0) / T));
}
export function roundedIntervalMass(x: number, lo: number, hi: number, T: number): number {
    must(Number.isSafeInteger(T) && T >= 1 && Number.isSafeInteger(lo) && Number.isSafeInteger(hi) && 0 <= lo && lo <= hi && hi <= T, 'MATH_INTERVAL');
    finite(x);
    if (lo === hi)
        return 0;
    if (x === 0)
        return (hi - lo) / T;
    if (x < 0)
        return roundedIntervalMass(-x, T - hi, T - lo, T);
    return finite(Math.exp(-x * lo / T + Math.log(-Math.expm1(-x * (hi - lo) / T)) - Math.log(-Math.expm1(-x))));
}
export type RoundedCase = 'NO_EVENTS' | 'ONE_CELL' | 'FIRST_CELL_BOUNDARY' | 'LAST_CELL_BOUNDARY' | 'FINITE_FLAT' | 'FINITE_GROWTH' | 'FINITE_DECAY';
export function classifyRounded(indices: number[], T: number): RoundedCase {
    validateMath(indices, T);
    const n = indices.length;
    if (!n)
        return 'NO_EVENTS';
    if (T === 1)
        return 'ONE_CELL';
    const s = indices.reduce((v, j) => v + BigInt(j), 0n), max = BigInt(n) * BigInt(T - 1);
    if (s === 0n)
        return 'FIRST_CELL_BOUNDARY';
    if (s === max)
        return 'LAST_CELL_BOUNDARY';
    return 2n * s === max ? 'FINITE_FLAT' : 2n * s < max ? 'FINITE_DECAY' : 'FINITE_GROWTH';
}
type SolverProof = {
    lower: number;
    upper: number;
    iterations: number;
    doublings: number;
    absoluteWidth: number;
    relativeWidth: number;
    objectiveError: number;
};
function bisect(lo: number, hi: number, fn: (x: number) => number, increasing: boolean): {
    x: number;
    proof: SolverProof;
} {
    let a = lo, b = hi, iterations = 0;
    for (; iterations < MAX_BISECTIONS;) {
        iterations++;
        const m = a + (b - a) / 2;
        if (m === a || m === b)
            break;
        const y = finite(fn(m));
        if ((y > 0) === increasing)
            b = m;
        else
            a = m;
        if (b - a <= 1e-12 * Math.max(1, Math.abs(m)) && Math.abs(y) <= 1e-12)
            break;
    }
    const x = a + (b - a) / 2, absoluteWidth = b - a, relativeWidth = absoluteWidth / Math.max(1, Math.abs(x)), objectiveError = Math.abs(finite(fn(x)));
    must(relativeWidth <= TOL && objectiveError <= TOL, 'SOLVER_ERROR_BOUND');
    return { x, proof: { lower: a, upper: b, iterations, doublings: 0, absoluteWidth, relativeWidth, objectiveError } };
}
function mle(indices: number[], T: number): {
    x: number;
    solver: SolverProof;
} {
    const kind = classifyRounded(indices, T);
    must(kind.startsWith('FINITE_'), 'NO_FINITE_UNIQUE_MLE');
    if (kind === 'FINITE_FLAT')
        return { x: 0, solver: { lower: 0, upper: 0, iterations: 0, doublings: 0, absoluteWidth: 0, relativeWidth: 0, objectiveError: 0 } };
    const positive = kind === 'FINITE_DECAY', ix = positive ? indices : indices.map(j => T - 1 - j), target = ix.reduce((s, j) => s + j, 0) / T, score = (v: number) => ix.length * roundedMeanStart(v, T) - target;
    let hi = 1, doublings = 0;
    while (score(hi) > 0 && doublings < MAX_DOUBLINGS) {
        hi *= 2;
        doublings++;
        finite(hi);
    }
    must(score(hi) <= 0, 'MLE_BRACKET_LIMIT');
    const solved = bisect(0, hi, score, false);
    solved.proof.doublings = doublings;
    return positive ? { x: solved.x, solver: solved.proof } : { x: -solved.x, solver: { ...solved.proof, lower: -solved.proof.upper, upper: -solved.proof.lower } };
}
function support(indices: number[], T: number, x: number) {
    const max = roundedProfileRelative(x, indices, T), loss = (v: number) => 2 * (max - roundedProfileRelative(v, indices, T)) - 4;
    let lo = x - 1, hi = x + 1, leftDoublings = 0, rightDoublings = 0;
    while (loss(lo) < 0 && leftDoublings < MAX_DOUBLINGS) {
        lo = x - 2 * (x - lo);
        leftDoublings++;
        finite(lo);
    }
    while (loss(hi) < 0 && rightDoublings < MAX_DOUBLINGS) {
        hi = x + 2 * (hi - x);
        rightDoublings++;
        finite(hi);
    }
    must(loss(lo) >= 0 && loss(hi) >= 0, 'SUPPORT_BRACKET_LIMIT');
    const lower = bisect(lo, x, loss, false), upper = bisect(x, hi, loss, true);
    lower.proof.doublings = leftDoublings;
    upper.proof.doublings = rightDoublings;
    return { lowerX: lower.x, upperX: upper.x, lowerK: lower.x / T, upperK: upper.x / T, cutoff: 4 as const, nonDecaySupported: lower.x <= 0, growthSupported: lower.x < 0, includesZero: lower.x <= 0 && upper.x >= 0, lowerSolver: lower.proof, upperSolver: upper.proof, interpretation: A28_LIMITS.uncertainty };
}
export function fitRoundedSeconds(indices: number[], T: number) {
    const kind = classifyRounded(indices, T), solved = mle(indices, T), x = solved.x, k = x / T, n = indices.length;
    const logZ = x === 0 ? Math.log(T) : Math.log(T) + Math.log(-Math.expm1(-Math.abs(x))) - Math.log(Math.abs(x)) + (x < 0 ? -x : 0), logAmplitude = Math.log(n) - logZ, amplitude = Math.exp(logAmplitude);
    must(amplitude > 0 && Number.isFinite(amplitude), 'AMPLITUDE_NONFINITE');
    const signedRateSupport = support(indices, T, x), positive = signedRateSupport.upperK > 0;
    return { case: kind, n, exposureSeconds: T, publicationIntervalSeconds: 1, x, kPerSecond: k, amplitudeAtFitStartPerSecond: amplitude, logAmplitude, profileRelativeToFlat: roundedProfileRelative(x, indices, T), scoreAtMaximum: finite(n * roundedMeanStart(x, T) - indices.reduce((s, j) => s + j, 0) / T), solver: solved.solver, halfLifePointSeconds: k > 0 ? finite(Math.LN2 / k) : null, signedRateSupport, positiveHalfLifeSupport: { positiveDecaySupported: positive, lowerSeconds: positive ? finite(Math.LN2 / signedRateSupport.upperK) : null, upper: !positive ? { kind: 'NONE' as const } : signedRateSupport.lowerK <= 0 ? { kind: 'UNBOUNDED' as const } : { kind: 'FINITE' as const, seconds: finite(Math.LN2 / signedRateSupport.lowerK) }, nonDecaySupported: signedRateSupport.nonDecaySupported } };
}
export type A28Fit = ReturnType<typeof fitRoundedSeconds>;
type CaseName = 'PRIMARY' | 'FRANKIE_EXCLUDED';
type Representative = {
    postId: string;
    groupId: string;
    publishedAt: string;
};
type Peak = {
    firstBin: number;
    lastBin: number;
    count: number;
    fitStart: string;
    fitEnd: string;
    tailBins: number;
};
export type A28Interpretation = {
    name: CaseName;
    representatives: Representative[];
    binCounts: number[];
    peak: Peak | null;
    gate: {
        status: 'PASS' | 'MISSING';
        reason: string | null;
    };
    fit: (A28Fit & {
        residuals: any[];
        residualSummary: any;
        eventTimeVector: any[];
        cumulativeIntensity: any[];
        censoring: any;
    }) | null;
};
function comparePost(a: A28Post, b: A28Post) { return sec(a.publishedAt) - sec(b.publishedAt) || (BigInt(a.postId) < BigInt(b.postId) ? -1 : BigInt(a.postId) > BigInt(b.postId) ? 1 : 0); }
function interpretation(x: A28StudyInput, name: CaseName): A28Interpretation {
    const first = new Map<string, A28Post>();
    for (const p of x.posts.filter(p => name === 'PRIMARY' ? p.primaryEligible : p.alternativeEligible).sort(comparePost))
        if (!first.has(p.groupId))
            first.set(p.groupId, p);
    const representatives = [...first.values()].sort(comparePost).map(({ postId, groupId, publishedAt }) => ({ postId, groupId, publishedAt })), binCounts = Array.from({ length: 9 }, () => 0);
    for (const p of representatives)
        binCounts[Math.floor((sec(p.publishedAt) - startSecond) / A28_BIN_SECONDS)]++;
    const result: A28Interpretation = { name, representatives, binCounts, peak: null, gate: { status: 'PASS', reason: null }, fit: null }, missing = (reason: string) => { result.gate = { status: 'MISSING', reason }; return result; };
    const max = Math.max(...binCounts);
    if (max <= 0)
        return missing('A28_NO_POSITIVE_PEAK');
    let last = binCounts.lastIndexOf(max), firstBin = last;
    while (firstBin > 0 && binCounts[firstBin - 1] === max)
        firstBin--;
    if (firstBin === 0 || last === 8 || binCounts[firstBin - 1] >= max || binCounts[last + 1] >= max)
        return missing('A28_PEAK_NOT_INTERIOR_BRACKETED');
    const fitStart = startSecond + (last + 1) * A28_BIN_SECONDS, tailBins = 8 - last;
    result.peak = { firstBin, lastBin: last, count: max, fitStart: new Date(fitStart * 1000).toISOString(), fitEnd: A28_END, tailBins };
    if (tailBins < 2)
        return missing('A28_INSUFFICIENT_FULL_TAIL_BINS');
    if (binCounts[last + 1] <= binCounts[8])
        return missing('A28_FIRST_TAIL_NOT_GREATER_THAN_FINAL');
    if (x.catalysts.some(c => c.barrier && sec(c.publishedAt) >= fitStart && sec(c.publishedAt) < endSecond))
        return missing('A28_RETAINED_CATALYST_BARRIER');
    const indices = representatives.filter(p => sec(p.publishedAt) >= fitStart).map(p => sec(p.publishedAt) - fitStart), kind = classifyRounded(indices, endSecond - fitStart);
    if (kind !== 'FINITE_DECAY')
        return missing('A28_' + kind);
    return result;
}
function addFit(view: A28Interpretation) {
    const fitStart = sec(view.peak!.fitStart), T = endSecond - fitStart, tail = view.representatives.filter(p => sec(p.publishedAt) >= fitStart), indices = tail.map(p => sec(p.publishedAt) - fitStart), fit = fitRoundedSeconds(indices, T);
    must(fit.case === 'FINITE_DECAY' && fit.halfLifePointSeconds !== null, 'POSITIVE_FINITE_FIT');
    const residuals = Array.from({ length: view.peak!.tailBins }, (_, i) => { const lo = i * A28_BIN_SECONDS, hi = lo + A28_BIN_SECONDS, observed = indices.filter(j => j >= lo && j < hi).length, expected = finite(fit.n * roundedIntervalMass(fit.x, lo, hi, T)); must(expected > 0 || observed === 0, 'EXPECTED_UNDERFLOW_WITH_OBSERVATION'); const residual = observed - expected, pearson = expected === 0 ? 0 : residual / Math.sqrt(expected), deviance = expected === 0 ? 0 : 2 * (observed === 0 ? expected : observed * Math.log(observed / expected) - (observed - expected)); return { start: new Date((fitStart + lo) * 1000).toISOString(), end: new Date((fitStart + hi) * 1000).toISOString(), observed, expected, residual, pearsonResidual: finite(pearson), devianceContribution: finite(deviance), expectedUnderflow: expected === 0 }; });
    must(Math.abs(residuals.reduce((s, r) => s + r.expected, 0) - fit.n) <= TOL * Math.max(1, fit.n), 'RESIDUAL_EXPECTATION_CONSERVATION');
    const eventTimeVector = tail.map(p => { const j = sec(p.publishedAt) - fitStart; return { ...p, recordingIntervalStartSecond: j, recordingIntervalEndSecondExclusive: j + 1, fittedCumulativeAtStart: fit.n * roundedIntervalMass(fit.x, 0, j, T), fittedCumulativeAtEnd: fit.n * roundedIntervalMass(fit.x, 0, j + 1, T) }; });
    const cumulativeIntensity = Array.from({ length: view.peak!.tailBins + 1 }, (_, i) => ({ at: new Date((fitStart + i * A28_BIN_SECONDS) * 1000).toISOString(), fittedExpectedCount: fit.n * roundedIntervalMass(fit.x, 0, i * A28_BIN_SECONDS, T) }));
    view.fit = { ...fit, residuals, residualSummary: { observedTotal: fit.n, expectedTotal: residuals.reduce((s, r) => s + r.expected, 0), residualTotal: residuals.reduce((s, r) => s + r.residual, 0), pearsonStatistic: residuals.reduce((s, r) => s + r.pearsonResidual ** 2, 0), devianceStatistic: residuals.reduce((s, r) => s + r.devianceContribution, 0), referenceDistributionUsed: false }, eventTimeVector, cumulativeIntensity, censoring: { observationStart: view.peak!.fitStart, observationEnd: A28_END, wholeTrailingExposureRetained: true, trailingExposureAfterLastPublicationCellSeconds: T - Math.max(...indices) - 1, futureTrajectoryRightCensored: true, extinctionAfterLastPostAsserted: false } };
}
export type A28StudyResult = {
    method: typeof A28_METHOD;
    profileSha256: typeof A28_PROFILE_SHA256;
    subject: typeof A28_SUBJECT;
    quality: 'KNOWN' | 'MISSING';
    reasonCode: string;
    source: A28StudyInput['source'];
    packagedAt: string;
    evaluationCutoff: string;
    sourceFrameSha256: typeof A28_SOURCE_FRAME_SHA256;
    qualificationSha256: typeof A28_QUALIFICATION_SHA256;
    catalystDispositionsSha256: typeof A28_CATALYST_DISPOSITIONS_SHA256;
    adjudicationContractSha256: typeof A28_ADJUDICATION_SHA256;
    catalystRecords: A28StudyInput['catalysts'];
    sourceRange: {
        start: typeof A28_START;
        end: typeof A28_END;
        convention: 'HALF_OPEN';
    };
    interpretations: A28Interpretation[];
    sensitivityEnvelope: any;
    limits: typeof A28_LIMITS;
};
export function evaluateA28Study(raw: unknown): A28StudyResult {
    const x = prepare(raw), base: A28StudyResult = { method: A28_METHOD, profileSha256: A28_PROFILE_SHA256, subject: A28_SUBJECT, quality: 'MISSING', reasonCode: 'A28_SOURCE_MISSING', source: x.source, packagedAt: x.packagedAt, evaluationCutoff: x.evaluationCutoff, sourceFrameSha256: x.sourceFrameSha256, qualificationSha256: x.qualificationSha256, catalystDispositionsSha256: x.catalystDispositionsSha256, adjudicationContractSha256: x.adjudicationContractSha256, catalystRecords: x.catalysts, sourceRange: { start: A28_START, end: A28_END, convention: 'HALF_OPEN' }, interpretations: [], sensitivityEnvelope: null, limits: A28_LIMITS };
    if (x.source.status !== 'COMPLETE')
        return base;
    const views = [interpretation(x, 'PRIMARY'), interpretation(x, 'FRANKIE_EXCLUDED')];
    base.interpretations = views;
    const bad = views.find(v => v.gate.status === 'MISSING');
    if (bad) {
        base.reasonCode = bad.gate.reason!;
        return base;
    }
    if (views[0].peak!.firstBin !== views[1].peak!.firstBin || views[0].peak!.lastBin !== views[1].peak!.lastBin) {
        base.reasonCode = 'A28_QUALIFICATION_PEAK_DISAGREEMENT';
        return base;
    }
    try {
        for (const v of views)
            addFit(v);
    }
    catch {
        base.reasonCode = 'A28_NUMERIC_FIT_OR_SUPPORT_FAILURE';
        for (const v of views)
            v.fit = null;
        return base;
    }
    const fits = views.map(v => v.fit!), lower = Math.min(...fits.map(f => f.positiveHalfLifeSupport.lowerSeconds!)), unbounded = fits.some(f => f.positiveHalfLifeSupport.upper.kind === 'UNBOUNDED');
    base.quality = 'KNOWN';
    base.reasonCode = 'A28_SCOPED_INTERVAL_MODEL_DECAY_VECTOR_IDENTIFIED';
    base.sensitivityEnvelope = { caseNames: views.map(v => v.name), allCasesIndividuallyFitted: true, pointHalfLifeSeconds: { minimum: Math.min(...fits.map(f => f.halfLifePointSeconds!)), maximum: Math.max(...fits.map(f => f.halfLifePointSeconds!)) }, signedRateSupportEnvelope: { lower: Math.min(...fits.map(f => f.signedRateSupport.lowerK)), upper: Math.max(...fits.map(f => f.signedRateSupport.upperK)) }, positiveHalfLifeSupportEnvelope: { lowerSeconds: lower, upper: unbounded ? { kind: 'UNBOUNDED' } : { kind: 'FINITE', seconds: Math.max(...fits.map(f => f.positiveHalfLifeSupport.upper.kind === 'FINITE' ? f.positiveHalfLifeSupport.upper.seconds : 0)) }, nonDecaySupported: fits.some(f => f.signedRateSupport.nonDecaySupported) }, interpretation: 'COMPLETE_TWO_CASE_SENSITIVITY_ENVELOPE_NOT_CALIBRATED_CONFIDENCE_COVERAGE' };
    return base;
}
export function deriveA28DecayMetric(token: {
    chain: string;
    address: string;
}, cutoff: string, raw: unknown, ownedIds: ReadonlySet<string>): AdvisoryMetric {
    const input = prepare(raw), result = evaluateA28Study(input);
    must(s18Instant(cutoff) !== null && ns(cutoff) === ns(input.evaluationCutoff), 'CUTOFF');
    const evidenceIds = [...new Set([...input.source.sourceIds, ...input.catalysts.flatMap(c => c.sourceIds)])].sort();
    must(evidenceIds.every(id => ownedIds.has(id)), 'UNOWNED_SOURCE');
    if (token.chain !== A28_SUBJECT.chain || token.address !== A28_SUBJECT.address)
        return { id: 'A28', quality: 'MISSING', unit: 'MODEL_CONDITIONAL_SECONDS', data: null, evidenceIds: [], reasonCode: 'A28_OUTSIDE_FROZEN_SUBJECT' };
    return { id: 'A28', quality: result.quality, unit: 'MODEL_CONDITIONAL_SECONDS', data: result, evidenceIds, reasonCode: result.reasonCode };
}
