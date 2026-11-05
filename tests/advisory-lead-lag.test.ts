import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  A25_PROFILE,
  deriveA25LeadLagStudy,
  type A25LeadLagInput,
  type A25LeadLagLag,
  type A25LeadLagNullShift,
  type A25LeadLagStudy,
} from '../src/domain/advisory-lead-lag.js';

// Synthetic vectors only; expectations follow from closed-form properties of the generators.
const START = '2026-01-01T00:00:00.000Z';
const BINS = 361;
const DIFFERENCED = BINS - 1;
const ROUNDING = 1e-9;
const REPLICATES = 1000;

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

// Period-17 quadratic residues: first differences are nonconstant in every window.
function q(i: number): number {
  return positiveModulo(i * i + 3 * i + 7, 17);
}

// Period-20 triangle: first differences are +1 for ten bins, then -1 for ten bins.
function tri(i: number): number {
  const r = positiveModulo(i, 20);
  return r <= 10 ? r : 20 - r;
}

function series(length: number, at: (i: number) => number): number[] {
  return Array.from({ length }, (_, i) => at(i));
}

function makeInput(attentionCounts: number[], priceCloses: number[], seed = 12345): A25LeadLagInput {
  return { windowStart: START, attentionCounts, priceCloses, seed };
}

function complete(input: A25LeadLagInput): A25LeadLagStudy {
  const result = deriveA25LeadLagStudy(input);
  if (result.status !== 'COMPLETE') assert.fail(`expected COMPLETE, got ${result.reasonCode}`);
  return result.study;
}

function reasonOf(input: unknown): string {
  const result = deriveA25LeadLagStudy(input as A25LeadLagInput);
  if (result.status !== 'MISSING') assert.fail('expected MISSING');
  return result.reasonCode;
}

function lagAt(study: A25LeadLagStudy, lagMinutes: number): A25LeadLagLag {
  const entry = study.lags.find((lag) => lag.lagMinutes === lagMinutes);
  assert.ok(entry, `lag ${lagMinutes} missing`);
  return entry;
}

function shiftAt(study: A25LeadLagStudy, shift: number): A25LeadLagNullShift {
  const entry = study.null.shifts.find((candidate) => candidate.shift === shift);
  assert.ok(entry, `shift ${shift} missing`);
  return entry;
}

function assertClose(actual: number, expected: number, label = ''): void {
  assert.ok(Math.abs(actual - expected) <= ROUNDING, `${label} expected ${expected}, got ${actual}`);
}

function replaced(values: number[], index: number, value: unknown): unknown[] {
  const copy: unknown[] = values.slice();
  copy[index] = value;
  return copy;
}

function withHole(values: number[], index: number): number[] {
  const holed = new Array<number>(values.length);
  values.forEach((value, i) => {
    if (i !== index) holed[i] = value;
  });
  return holed;
}

function assertBootstrapArithmetic(study: A25LeadLagStudy): void {
  for (const lag of study.lags) {
    const { lower95, upper95, definedReplicates, undefinedReplicates } = lag.bootstrap;
    assert.equal(definedReplicates + undefinedReplicates, REPLICATES);
    assert.ok(definedReplicates >= A25_PROFILE.bootstrap.minimumDefinedReplicatesPerLag);
    assert.ok(Number.isFinite(lower95) && Number.isFinite(upper95));
    assert.ok(-1 <= lower95 && lower95 <= upper95 && upper95 <= 1, `lag ${lag.lagMinutes} interval order`);
  }
  const uncertainty = study.uncertainty;
  assert.equal(uncertainty.replicates, REPLICATES);
  assert.equal(uncertainty.blockMinutes, 60);
  assert.equal(uncertainty.eligiblePeakReplicates + uncertainty.undefinedPeakReplicates, REPLICATES);
  assert.deepEqual(
    uncertainty.peakLagFrequencies.map((entry) => entry.lagMinutes),
    [...A25_PROFILE.lagsMinutes],
  );
  const counted = uncertainty.peakLagFrequencies.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(counted, uncertainty.eligiblePeakReplicates);
  for (const entry of uncertainty.peakLagFrequencies) {
    if (uncertainty.eligiblePeakReplicates > 0) {
      assert.equal(entry.frequency, entry.count / uncertainty.eligiblePeakReplicates);
    } else {
      assert.equal(entry.frequency, null);
    }
  }
  const undefinedPerLag = study.lags.map((lag) => lag.bootstrap.undefinedReplicates);
  assert.ok(uncertainty.undefinedPeakReplicates >= Math.max(...undefinedPerLag));
  assert.ok(uncertainty.undefinedPeakReplicates <= undefinedPerLag.reduce((sum, value) => sum + value, 0));
}

// P[t] = 0.001 * A[t - 10]: attention leads price by ten minutes, so r = 1 at +10.
const leadCounts = series(BINS, q);
const leadPrices = series(BINS, (i) => Math.exp(0.001 * q(i - 10)));
// P[t] = 0.001 * A[t + 10]: price leads attention, so r = 1 at -10.
const lagPrices = series(BINS, (i) => Math.exp(0.001 * q(i + 10)));

// Attention differences cycle [1, -1, 2, 1, -3]: mean 0, sum of squares 16, circular
// lag products -7 (shift 1 or 4) and -1 (shift 2 or 3). Price differences are 0.001x.
const cycle = [0, 1, 0, 2, 3];
const cycleCounts = series(BINS, (i) => cycle[i % 5]!);
const cyclePrices = cycleCounts.map((count) => Math.exp(0.001 * count));

// Square-wave differences with P[t] = 0.001 * A[t - 5]: r(+5) = 1 and r(-5) = -1.
const triangleCounts = series(BINS, tri);
const trianglePrices = series(BINS, (i) => Math.exp(0.001 * tri(i - 5)));

test('A25 profile is frozen with the exact published values and key order', () => {
  const expected = {
    method: 'a25-lead-lag-statistics-v1',
    binSeconds: 60,
    lagsMinutes: [-30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30],
    minimumPairs: 120,
    peak: 'MAX_ABS_THEN_ABS_LAG_THEN_SIGNED_LAG',
    tieTolerance: 1e-12,
    null: 'ALL_NONZERO_CIRCULAR_ATTENTION_PHASE_SHIFTS_MAX_ABS',
    bootstrap: {
      blockMinutes: 60,
      replicates: 1000,
      minimumDefinedReplicatesPerLag: 900,
      confidenceLevel: 0.95,
      generator: 'XORSHIFT32_13_17_5',
      percentiles: 'FLOOR_LOWER_CEIL_UPPER',
    },
  };
  assert.equal(JSON.stringify(A25_PROFILE), JSON.stringify(expected));
  assert.ok(Object.isFrozen(A25_PROFILE));
  assert.ok(Object.isFrozen(A25_PROFILE.lagsMinutes));
  assert.ok(Object.isFrozen(A25_PROFILE.bootstrap));
});

test('positive lag means attention differences precede log-price differences', () => {
  const study = complete(makeInput(leadCounts, leadPrices));
  assert.deepEqual(study.window, {
    start: START,
    end: '2026-01-01T06:01:00.000Z',
    binSeconds: 60,
    bins: BINS,
    differencedLength: DIFFERENCED,
  });
  assert.deepEqual(
    study.lags.map((lag) => lag.lagMinutes),
    [...A25_PROFILE.lagsMinutes],
  );
  for (const lag of study.lags) {
    assert.equal(lag.overlap, DIFFERENCED - Math.abs(lag.lagMinutes));
    assert.ok(Number.isFinite(lag.correlation) && Math.abs(lag.correlation) <= 1);
    if (lag.lagMinutes !== 10) {
      assert.ok(Math.abs(lag.correlation) < 1 - 1e-6, `lag ${lag.lagMinutes} is not an exact linear relation`);
    }
  }
  assertClose(lagAt(study, 10).correlation, 1, 'lag +10');
  assert.equal(study.peak.lagMinutes, 10);
  assert.equal(study.peak.overlap, 350);
  assertClose(study.peak.correlation, 1, 'peak');
  assert.equal(study.peak.absoluteCorrelation, Math.abs(study.peak.correlation));
  assert.equal(study.maximumAbsoluteCorrelation, study.peak.absoluteCorrelation);
});

test('negative lag means price differences precede attention differences', () => {
  const study = complete(makeInput(leadCounts, lagPrices));
  assertClose(lagAt(study, -10).correlation, 1, 'lag -10');
  assert.equal(study.peak.lagMinutes, -10);
  assert.equal(study.peak.overlap, 350);
  assertClose(study.peak.correlation, 1, 'peak');
});

test('exact tie across all lags selects lag 0 and phase-equivalent null shifts reach the observed maximum', () => {
  const study = complete(makeInput(cycleCounts, cyclePrices));
  for (const lag of study.lags) assertClose(lag.correlation, 1, `lag ${lag.lagMinutes}`);
  assert.equal(study.peak.lagMinutes, 0);
  assert.equal(study.peak.overlap, DIFFERENCED);
  assertClose(study.peak.correlation, 1, 'peak');

  assert.equal(study.null.denominator, DIFFERENCED);
  assert.deepEqual(
    study.null.shifts.map((entry) => entry.shift),
    series(DIFFERENCED - 1, (i) => i + 1),
  );
  // Shift 5 reproduces the same attention vector, so its maximum equals the observed one exactly.
  assert.equal(shiftAt(study, 5).maximumAbsoluteCorrelation, study.maximumAbsoluteCorrelation);
  assertClose(shiftAt(study, 1).maximumAbsoluteCorrelation, 7 / 16, 'shift 1');
  assertClose(shiftAt(study, 2).maximumAbsoluteCorrelation, 1 / 16, 'shift 2');
  assertClose(shiftAt(study, 3).maximumAbsoluteCorrelation, 1 / 16, 'shift 3');
  assertClose(shiftAt(study, 4).maximumAbsoluteCorrelation, 7 / 16, 'shift 4');
  // 71 multiples of 5 in 1..359 reach the observed maximum: p = (1 + 71) / 360.
  assert.equal(study.null.pValue, 72 / 360);
});

test('signed tie at equal absolute lag chooses the smaller signed lag', () => {
  const study = complete(makeInput(triangleCounts, trianglePrices));
  assertClose(lagAt(study, 5).correlation, 1, 'lag +5');
  assertClose(lagAt(study, -5).correlation, -1, 'lag -5');
  assertClose(lagAt(study, 15).correlation, -1, 'lag +15');
  assertClose(lagAt(study, -15).correlation, 1, 'lag -15');
  assert.equal(study.peak.lagMinutes, -5);
  assertClose(study.peak.correlation, -1, 'peak');
  assert.equal(study.peak.absoluteCorrelation, Math.abs(study.peak.correlation));
  assert.ok(study.maximumAbsoluteCorrelation >= study.peak.absoluteCorrelation);
  assert.ok(study.maximumAbsoluteCorrelation - study.peak.absoluteCorrelation <= A25_PROFILE.tieTolerance);
  // Only shifts that are multiples of 5 realign the square wave with some profile lag.
  assert.equal(study.null.pValue, 72 / 360);
});

test('null covers every nonzero circular shift with denominator M', () => {
  const study = complete(makeInput(leadCounts, leadPrices));
  assert.equal(study.null.denominator, DIFFERENCED);
  assert.deepEqual(
    study.null.shifts.map((entry) => entry.shift),
    series(DIFFERENCED - 1, (i) => i + 1),
  );
  for (const entry of study.null.shifts) {
    assert.ok(Number.isFinite(entry.maximumAbsoluteCorrelation));
    assert.ok(entry.maximumAbsoluteCorrelation >= 0 && entry.maximumAbsoluteCorrelation <= 1);
  }
  const reaching = study.null.shifts.filter(
    (entry) => entry.maximumAbsoluteCorrelation + A25_PROFILE.tieTolerance >= study.maximumAbsoluteCorrelation,
  ).length;
  assert.equal(study.null.pValue, (1 + reaching) / DIFFERENCED);
  assert.ok(study.null.pValue >= 1 / DIFFERENCED && study.null.pValue <= 1);
});

test('bootstrap is reproducible, maps seed 0 and keeps originals and null seed-independent', () => {
  const first = complete(makeInput(leadCounts, leadPrices, 12345));
  const again = complete(makeInput(leadCounts, leadPrices, 12345));
  assert.deepEqual(first, again);
  assert.equal(first.uncertainty.seed, 12345);

  const zero = complete(makeInput(leadCounts, leadPrices, 0));
  const mapped = complete(makeInput(leadCounts, leadPrices, 0x6d2b79f5));
  assert.equal(zero.uncertainty.seed, 0x6d2b79f5);
  assert.deepEqual(zero, mapped);

  const other = complete(makeInput(leadCounts, leadPrices, 54321));
  const originals = (study: A25LeadLagStudy) =>
    study.lags.map(({ lagMinutes, overlap, correlation }) => ({ lagMinutes, overlap, correlation }));
  assert.deepEqual(originals(other), originals(first));
  assert.deepEqual(other.window, first.window);
  assert.deepEqual(other.peak, first.peak);
  assert.deepEqual(other.null, first.null);
  assert.equal(other.maximumAbsoluteCorrelation, first.maximumAbsoluteCorrelation);
  assert.equal(other.uncertainty.seed, 54321);
  assert.notDeepEqual(
    other.lags.map((lag) => lag.bootstrap),
    first.lags.map((lag) => lag.bootstrap),
  );

  const maximumSeed = complete(makeInput(leadCounts, leadPrices, 0xffffffff));
  assert.equal(maximumSeed.uncertainty.seed, 0xffffffff);
});

test('bootstrap intervals are finite and ordered with consistent replicate arithmetic', () => {
  const study = complete(makeInput(leadCounts, leadPrices));
  assertBootstrapArithmetic(study);
  assert.equal(study.uncertainty.eligiblePeakReplicates, REPLICATES);
  assert.equal(study.uncertainty.undefinedPeakReplicates, 0);
  assert.equal(typeof study.uncertainty.method, 'string');
});

test('bootstrap tolerates sparse undefined replicates while keeping all 1000 accounted for', () => {
  // Log-price moves only around bins 60, 180 and 300; a resample missing all three is undefined.
  const sparsePrices = series(BINS, (i) => (i === 60 || i === 180 || i === 300 ? 2 : 1));
  const study = complete(makeInput(leadCounts, sparsePrices));
  assert.ok(study.lags.some((lag) => lag.bootstrap.undefinedReplicates > 0));
  assert.ok(study.uncertainty.undefinedPeakReplicates > 0);
  assertBootstrapArithmetic(study);
});

test('a lag with fewer than 900 defined bootstrap replicates makes the study MISSING', () => {
  // Only P[179] and P[180] are nonzero; each 60-bin block covers them with probability 61/360,
  // so roughly a third of six-block resamples have constant price differences.
  const singleMovePrices = series(BINS, (i) => (i === 180 ? 2 : 1));
  assert.equal(
    reasonOf(makeInput(leadCounts, singleMovePrices, 7)),
    'INSUFFICIENT_DEFINED_BOOTSTRAP_REPLICATES',
  );
});

test('differencing removes levels: constant differences are undefined, never zero', () => {
  const ramp = series(BINS, (i) => i);
  assert.equal(reasonOf(makeInput(ramp, leadPrices)), 'UNDEFINED_ORIGINAL_CORRELATION');
  const flatPrices = series(BINS, () => 5);
  assert.equal(reasonOf(makeInput(leadCounts, flatPrices)), 'UNDEFINED_ORIGINAL_CORRELATION');
  const flatCounts = series(BINS, () => 3);
  assert.equal(reasonOf(makeInput(flatCounts, leadPrices)), 'UNDEFINED_ORIGINAL_CORRELATION');
});

test('a single lag window without attention variance makes the whole study MISSING', () => {
  // A[0] = -1 and A[t] = 0 otherwise: every negative-lag window starts after index 0.
  const firstOnly = series(BINS, (i) => (i === 0 ? 1 : 0));
  assert.equal(reasonOf(makeInput(firstOnly, leadPrices)), 'UNDEFINED_ORIGINAL_CORRELATION');
});

test('a null shift with an undefined lag makes the whole study MISSING', () => {
  // A is nonzero only at 179 and 180, inside every original window; shifts >= 151 move
  // both entries into the first 30 bins, which negative-lag windows exclude.
  const middleBump = series(BINS, (i) => (i === 180 ? 1 : 0));
  assert.equal(reasonOf(makeInput(middleBump, leadPrices)), 'UNDEFINED_NULL_CORRELATION');
});

test('every lag needs at least 120 pairs: 151 bins is the smallest complete window', () => {
  for (const bins of [0, 1, 2, 150]) {
    const counts = series(bins, q);
    const prices = series(bins, (i) => Math.exp(0.001 * q(i - 10)));
    assert.equal(reasonOf(makeInput(counts, prices)), 'INSUFFICIENT_OVERLAP', `bins=${bins}`);
  }
  const study = complete(makeInput(series(151, q), series(151, (i) => Math.exp(0.001 * q(i - 10)))));
  assert.equal(study.window.differencedLength, 150);
  assert.equal(lagAt(study, -30).overlap, 120);
  assert.equal(lagAt(study, 30).overlap, 120);
  assert.equal(study.null.denominator, 150);
  assert.equal(study.null.shifts.length, 149);
  assert.equal(study.peak.lagMinutes, 10);
  assertBootstrapArithmetic(study);
});

test('array bounds are checked before element work', () => {
  assert.equal(reasonOf(makeInput(series(1001, q), series(1001, () => 1))), 'TOO_MANY_BINS');
  assert.equal(reasonOf(makeInput(new Array<number>(1_000_000), leadPrices)), 'TOO_MANY_BINS');
  assert.equal(reasonOf(makeInput(leadCounts, [...leadPrices, 1])), 'LENGTH_MISMATCH');
});

test('malformed inputs are rejected with stage-specific reason codes', () => {
  const base = { windowStart: START, attentionCounts: leadCounts, priceCloses: leadPrices, seed: 1 };

  for (const input of [null, undefined, 'input', 42, []]) {
    assert.equal(reasonOf(input), 'INVALID_INPUT', String(input));
  }

  for (const windowStart of [
    '2026-01-01T00:00:30.000Z',
    '2026-01-01T00:00:00.500Z',
    '2026-02-30T00:00:00.000Z',
    '2026-13-01T00:00:00.000Z',
    '2026-01-01T24:00:00.000Z',
    '2026-01-01T00:00:00+00:00',
    '2026-01-01 00:00:00Z',
    '2026-01-01',
    'garbage',
    '',
    0,
    undefined,
  ]) {
    assert.equal(reasonOf({ ...base, windowStart }), 'INVALID_WINDOW_START', String(windowStart));
  }

  for (const seed of [-1, 2 ** 32, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', undefined, null]) {
    assert.equal(reasonOf({ ...base, seed }), 'INVALID_SEED', String(seed));
  }

  for (const attentionCounts of [undefined, 'counts', { length: BINS }, new Float64Array(BINS)]) {
    assert.equal(reasonOf({ ...base, attentionCounts }), 'INVALID_ATTENTION_COUNTS');
  }
  assert.equal(reasonOf({ ...base, attentionCounts: withHole(leadCounts, 100) }), 'INVALID_ATTENTION_COUNTS');
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1', undefined, null]) {
    assert.equal(
      reasonOf({ ...base, attentionCounts: replaced(leadCounts, 100, value) }),
      'INVALID_ATTENTION_COUNTS',
      String(value),
    );
  }

  for (const priceCloses of [undefined, 'prices', { length: BINS }, new Float64Array(BINS)]) {
    assert.equal(reasonOf({ ...base, priceCloses }), 'INVALID_PRICE_CLOSES');
  }
  assert.equal(reasonOf({ ...base, priceCloses: withHole(leadPrices, 100) }), 'INVALID_PRICE_CLOSES');
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1', undefined, null]) {
    assert.equal(
      reasonOf({ ...base, priceCloses: replaced(leadPrices, 100, value) }),
      'INVALID_PRICE_CLOSES',
      String(value),
    );
  }

  // 361 minutes past this start lands in year 10000, outside four-digit ISO form.
  assert.equal(reasonOf({ ...base, windowStart: '9999-12-31T23:00:00.000Z' }), 'INVALID_WINDOW_END');
});

test('second-precision timestamps without milliseconds are accepted and normalised', () => {
  const study = complete({ ...makeInput(leadCounts, leadPrices), windowStart: '2026-03-04T05:06:00Z' });
  assert.equal(study.window.start, '2026-03-04T05:06:00.000Z');
  assert.equal(study.window.end, '2026-03-04T11:07:00.000Z');
});
