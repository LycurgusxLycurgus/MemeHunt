/**
 * A25 lead-lag statistics.
 *
 * Exploratory retained-series study under a secondary analysis plan disclosed
 * after prior data exposure. Outputs are descriptive diagnostics only: no
 * causal, population, confirmatory, executable-trading or source-authority
 * claim. The circular phase-shift null is a conditional phase reference for this
 * retained series, and bootstrap percentile intervals are pointwise approximate
 * variability per lag, not confidence in the selected peak.
 */

export const A25_PROFILE = Object.freeze({
  method: 'a25-lead-lag-statistics-v1',
  binSeconds: 60,
  lagsMinutes: Object.freeze([-30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30] as const),
  minimumPairs: 120,
  peak: 'MAX_ABS_THEN_ABS_LAG_THEN_SIGNED_LAG',
  tieTolerance: 1e-12,
  null: 'ALL_NONZERO_CIRCULAR_ATTENTION_PHASE_SHIFTS_MAX_ABS',
  bootstrap: Object.freeze({
    blockMinutes: 60,
    replicates: 1000,
    minimumDefinedReplicatesPerLag: 900,
    confidenceLevel: 0.95,
    generator: 'XORSHIFT32_13_17_5',
    percentiles: 'FLOOR_LOWER_CEIL_UPPER',
  } as const),
} as const);

export type A25LeadLagProfile = typeof A25_PROFILE;

export interface A25LeadLagInput {
  readonly windowStart: string;
  readonly attentionCounts: readonly number[];
  readonly priceCloses: readonly number[];
  readonly seed: number;
}

export type A25LeadLagReasonCode =
  | 'INVALID_INPUT'
  | 'INVALID_WINDOW_START'
  | 'INVALID_SEED'
  | 'INVALID_ATTENTION_COUNTS'
  | 'INVALID_PRICE_CLOSES'
  | 'TOO_MANY_BINS'
  | 'LENGTH_MISMATCH'
  | 'INSUFFICIENT_OVERLAP'
  | 'INVALID_WINDOW_END'
  | 'UNDEFINED_ORIGINAL_CORRELATION'
  | 'UNDEFINED_NULL_CORRELATION'
  | 'INSUFFICIENT_DEFINED_BOOTSTRAP_REPLICATES';

export interface A25LeadLagWindow {
  readonly start: string;
  /** Exclusive end of the last bin: start + bins * binSeconds. */
  readonly end: string;
  readonly binSeconds: 60;
  readonly bins: number;
  readonly differencedLength: number;
}

export interface A25LeadLagBootstrapInterval {
  readonly lower95: number;
  readonly upper95: number;
  readonly definedReplicates: number;
  readonly undefinedReplicates: number;
}

export interface A25LeadLagLag {
  readonly lagMinutes: number;
  readonly overlap: number;
  readonly correlation: number;
  readonly bootstrap: A25LeadLagBootstrapInterval;
}

export interface A25LeadLagPeak {
  readonly lagMinutes: number;
  readonly correlation: number;
  readonly absoluteCorrelation: number;
  readonly overlap: number;
}

export interface A25LeadLagNullShift {
  readonly shift: number;
  readonly maximumAbsoluteCorrelation: number;
}

export interface A25LeadLagNull {
  readonly shifts: readonly A25LeadLagNullShift[];
  readonly pValue: number;
  readonly denominator: number;
}

export interface A25LeadLagPeakLagFrequency {
  readonly lagMinutes: number;
  readonly count: number;
  readonly frequency: number | null;
}

export interface A25LeadLagUncertainty {
  readonly method: string;
  readonly blockMinutes: 60;
  readonly replicates: 1000;
  readonly seed: number;
  readonly peakLagFrequencies: readonly A25LeadLagPeakLagFrequency[];
  readonly eligiblePeakReplicates: number;
  readonly undefinedPeakReplicates: number;
}

export interface A25LeadLagStudy {
  readonly window: A25LeadLagWindow;
  readonly lags: readonly A25LeadLagLag[];
  /** True global maximum |r| over the original lags (null threshold). */
  readonly maximumAbsoluteCorrelation: number;
  readonly peak: A25LeadLagPeak;
  readonly null: A25LeadLagNull;
  readonly uncertainty: A25LeadLagUncertainty;
}

export interface A25LeadLagComplete {
  readonly status: 'COMPLETE';
  readonly study: A25LeadLagStudy;
}

export interface A25LeadLagMissing {
  readonly status: 'MISSING';
  readonly reasonCode: A25LeadLagReasonCode;
}

export type A25LeadLagResult = A25LeadLagComplete | A25LeadLagMissing;

const MAX_BINS = 1000;
const UINT32_MAX = 0xffffffff;
const UINT32_RANGE = 4294967296;
const ZERO_SEED_REPLACEMENT = 0x6d2b79f5;
const MAX_DATE_MS = 8.64e15;
const BOOTSTRAP_METHOD = 'CIRCULAR_MOVING_PAIRED_BLOCK_BOOTSTRAP_PERCENTILE';

const LAG_MINUTES: readonly number[] = A25_PROFILE.lagsMinutes;
const LAG_COUNT = LAG_MINUTES.length;
const LAG_BINS: readonly number[] = LAG_MINUTES.map((minutes) => (minutes * 60) / A25_PROFILE.binSeconds);
const MAX_ABS_LAG_BINS = Math.max(...LAG_BINS.map((lag) => Math.abs(lag)));
const MINIMUM_BINS = A25_PROFILE.minimumPairs + MAX_ABS_LAG_BINS + 1;
const BLOCK_BINS = (A25_PROFILE.bootstrap.blockMinutes * 60) / A25_PROFILE.binSeconds;
const TIE_TOLERANCE = A25_PROFILE.tieTolerance;
// Two-sided tail in per-mille (25 for 0.95) so percentile indices use exact integer arithmetic.
const TAIL_PER_MILLE = Math.round(((1 - A25_PROFILE.bootstrap.confidenceLevel) / 2) * 1000);

const MINUTE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/;
const FOUR_DIGIT_YEAR_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface ValidatedInput {
  readonly status: 'VALID';
  readonly start: string;
  readonly end: string;
  readonly counts: readonly number[];
  readonly prices: readonly number[];
  readonly seed: number;
}

interface NullReference {
  readonly shifts: A25LeadLagNullShift[];
  readonly exceedances: number;
}

interface BootstrapSummary {
  readonly intervals: A25LeadLagBootstrapInterval[];
  readonly peakCounts: number[];
  readonly eligible: number;
}

function missing(reasonCode: A25LeadLagReasonCode): A25LeadLagMissing {
  return { status: 'MISSING', reasonCode };
}

function parseMinuteTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !MINUTE_TIMESTAMP.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  // Round-trip rejects calendar overflow such as Feb 30 or hour 24.
  const expanded = value.endsWith('.000Z') ? value : `${value.slice(0, -1)}.000Z`;
  return new Date(ms).toISOString() === expanded ? ms : null;
}

function formatTimestamp(ms: number): string | null {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return null;
  const text = new Date(ms).toISOString();
  return FOUR_DIGIT_YEAR_ISO.test(text) ? text : null;
}

function readCounts(values: readonly unknown[]): number[] | null {
  const counts: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (!Object.hasOwn(values, i)) return null;
    const value = values[i];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
    counts.push(value);
  }
  return counts;
}

function readPrices(values: readonly unknown[]): number[] | null {
  const prices: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (!Object.hasOwn(values, i)) return null;
    const value = values[i];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    prices.push(value);
  }
  return prices;
}

function validateInput(input: unknown): ValidatedInput | A25LeadLagMissing {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return missing('INVALID_INPUT');
  const record = input as Record<string, unknown>;

  const startMs = parseMinuteTimestamp(record['windowStart']);
  if (startMs === null) return missing('INVALID_WINDOW_START');

  const seed = record['seed'];
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > UINT32_MAX) {
    return missing('INVALID_SEED');
  }

  const rawCounts = record['attentionCounts'];
  if (!Array.isArray(rawCounts)) return missing('INVALID_ATTENTION_COUNTS');
  const rawPrices = record['priceCloses'];
  if (!Array.isArray(rawPrices)) return missing('INVALID_PRICE_CLOSES');

  // Bounds before any element work.
  const bins = rawCounts.length;
  if (bins > MAX_BINS || rawPrices.length > MAX_BINS) return missing('TOO_MANY_BINS');
  if (rawPrices.length !== bins) return missing('LENGTH_MISMATCH');
  if (bins < MINIMUM_BINS) return missing('INSUFFICIENT_OVERLAP');

  const end = formatTimestamp(startMs + bins * A25_PROFILE.binSeconds * 1000);
  if (end === null) return missing('INVALID_WINDOW_END');

  const counts = readCounts(rawCounts);
  if (counts === null) return missing('INVALID_ATTENTION_COUNTS');
  const prices = readPrices(rawPrices);
  if (prices === null) return missing('INVALID_PRICE_CLOSES');

  return { status: 'VALID', start: new Date(startMs).toISOString(), end, counts, prices, seed };
}

function pearson(x: Float64Array, xStart: number, y: Float64Array, yStart: number, count: number): number | null {
  const xFirst = x[xStart]!;
  const yFirst = y[yStart]!;
  let xVaries = false;
  let yVaries = false;
  let xSum = 0;
  let ySum = 0;
  for (let i = 0; i < count; i++) {
    const xi = x[xStart + i]!;
    const yi = y[yStart + i]!;
    if (xi !== xFirst) xVaries = true;
    if (yi !== yFirst) yVaries = true;
    xSum += xi;
    ySum += yi;
  }
  // Exactly constant windows have zero variance; no epsilon threshold.
  if (!xVaries || !yVaries) return null;

  const xMean = xSum / count;
  const yMean = ySum / count;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let i = 0; i < count; i++) {
    const dx = x[xStart + i]! - xMean;
    const dy = y[yStart + i]! - yMean;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  if (!(xx > 0) || !(yy > 0)) return null;
  const r = xy / (Math.sqrt(xx) * Math.sqrt(yy));
  if (!Number.isFinite(r)) return null;
  return r > 1 ? 1 : r < -1 ? -1 : r;
}

/** Pearson(A[t], P[t + lag]) over valid boundaries only; positive lag means attention precedes price. */
function laggedCorrelation(attention: Float64Array, price: Float64Array, length: number, lag: number): number | null {
  return lag >= 0
    ? pearson(attention, 0, price, lag, length - lag)
    : pearson(attention, -lag, price, 0, length + lag);
}

/** Global max |r| first, then candidates within tolerance by smallest |lag|, then smaller signed lag. */
function selectPeak(correlations: ArrayLike<number>): { index: number; globalMaximum: number } {
  let globalMaximum = 0;
  for (let k = 0; k < LAG_COUNT; k++) {
    const absolute = Math.abs(correlations[k]!);
    if (absolute > globalMaximum) globalMaximum = absolute;
  }
  let index = -1;
  for (let k = 0; k < LAG_COUNT; k++) {
    if (globalMaximum - Math.abs(correlations[k]!) > TIE_TOLERANCE) continue;
    if (index === -1) {
      index = k;
      continue;
    }
    const lag = LAG_MINUTES[k]!;
    const best = LAG_MINUTES[index]!;
    if (Math.abs(lag) < Math.abs(best) || (Math.abs(lag) === Math.abs(best) && lag < best)) index = k;
  }
  return { index, globalMaximum };
}

function circularShiftNull(
  attention: Float64Array,
  price: Float64Array,
  length: number,
  observedMaximum: number,
): NullReference | null {
  const shifted = new Float64Array(length);
  const shifts: A25LeadLagNullShift[] = [];
  let exceedances = 0;
  for (let shift = 1; shift < length; shift++) {
    for (let t = 0; t < length; t++) {
      const source = t + shift;
      shifted[t] = attention[source < length ? source : source - length]!;
    }
    let maximum = 0;
    for (let k = 0; k < LAG_COUNT; k++) {
      const correlation = laggedCorrelation(shifted, price, length, LAG_BINS[k]!);
      if (correlation === null) return null;
      const absolute = Math.abs(correlation);
      if (absolute > maximum) maximum = absolute;
    }
    if (maximum + TIE_TOLERANCE >= observedMaximum) exceedances++;
    shifts.push({ shift, maximumAbsoluteCorrelation: maximum });
  }
  return { shifts, exceedances };
}

function createXorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / UINT32_RANGE;
  };
}

function pairedBlockBootstrap(
  attention: Float64Array,
  price: Float64Array,
  length: number,
  seed: number,
): BootstrapSummary | null {
  const { replicates, minimumDefinedReplicatesPerLag } = A25_PROFILE.bootstrap;
  const next = createXorshift32(seed);
  const sampledAttention = new Float64Array(length);
  const sampledPrice = new Float64Array(length);
  const replicateCorrelations = new Float64Array(LAG_COUNT);
  const defined: number[][] = LAG_BINS.map(() => []);
  const peakCounts = new Array<number>(LAG_COUNT).fill(0);
  let eligible = 0;

  for (let replicate = 0; replicate < replicates; replicate++) {
    let filled = 0;
    while (filled < length) {
      const start = Math.floor(next() * length);
      for (let j = 0; j < BLOCK_BINS && filled < length; j++) {
        const source = start + j;
        const index = source < length ? source : source - length;
        sampledAttention[filled] = attention[index]!;
        sampledPrice[filled] = price[index]!;
        filled++;
      }
    }

    // The same paired resample feeds every lag; no per-lag draws or rejections.
    let allDefined = true;
    for (let k = 0; k < LAG_COUNT; k++) {
      const correlation = laggedCorrelation(sampledAttention, sampledPrice, length, LAG_BINS[k]!);
      if (correlation === null) {
        allDefined = false;
        continue;
      }
      defined[k]!.push(correlation);
      replicateCorrelations[k] = correlation;
    }
    if (allDefined) {
      eligible++;
      const { index } = selectPeak(replicateCorrelations);
      peakCounts[index] = peakCounts[index]! + 1;
    }
  }

  const intervals: A25LeadLagBootstrapInterval[] = [];
  for (let k = 0; k < LAG_COUNT; k++) {
    const values = defined[k]!;
    if (values.length < minimumDefinedReplicatesPerLag) return null;
    values.sort((left, right) => left - right);
    const last = values.length - 1;
    // Percentile interval as-is: never widened, recentred or forced to contain the original r.
    const lowerIndex = Math.floor((last * TAIL_PER_MILLE) / 1000);
    const upperIndex = Math.ceil((last * (1000 - TAIL_PER_MILLE)) / 1000);
    intervals.push({
      lower95: values[lowerIndex]!,
      upper95: values[upperIndex]!,
      definedReplicates: values.length,
      undefinedReplicates: replicates - values.length,
    });
  }
  return { intervals, peakCounts, eligible };
}

export function deriveA25LeadLagStudy(input: A25LeadLagInput): A25LeadLagResult {
  const validated = validateInput(input);
  if (validated.status === 'MISSING') return validated;

  const { counts, prices } = validated;
  const bins = counts.length;
  const length = bins - 1;
  const attention = new Float64Array(length);
  const price = new Float64Array(length);
  let previousLog = Math.log(prices[0]!);
  for (let i = 0; i < length; i++) {
    const nextLog = Math.log(prices[i + 1]!);
    attention[i] = counts[i + 1]! - counts[i]!;
    price[i] = nextLog - previousLog;
    previousLog = nextLog;
  }

  const overlaps = LAG_BINS.map((lag) => length - Math.abs(lag));
  const correlations = new Float64Array(LAG_COUNT);
  for (let k = 0; k < LAG_COUNT; k++) {
    const correlation = laggedCorrelation(attention, price, length, LAG_BINS[k]!);
    if (correlation === null) return missing('UNDEFINED_ORIGINAL_CORRELATION');
    correlations[k] = correlation;
  }
  const observed = selectPeak(correlations);

  const nullReference = circularShiftNull(attention, price, length, observed.globalMaximum);
  if (nullReference === null) return missing('UNDEFINED_NULL_CORRELATION');

  const effectiveSeed = validated.seed === 0 ? ZERO_SEED_REPLACEMENT : validated.seed;
  const bootstrap = pairedBlockBootstrap(attention, price, length, effectiveSeed);
  if (bootstrap === null) return missing('INSUFFICIENT_DEFINED_BOOTSTRAP_REPLICATES');

  const peakCorrelation = correlations[observed.index]!;
  const replicates = A25_PROFILE.bootstrap.replicates;
  return {
    status: 'COMPLETE',
    study: {
      window: {
        start: validated.start,
        end: validated.end,
        binSeconds: A25_PROFILE.binSeconds,
        bins,
        differencedLength: length,
      },
      lags: LAG_MINUTES.map((lagMinutes, k) => ({
        lagMinutes,
        overlap: overlaps[k]!,
        correlation: correlations[k]!,
        bootstrap: bootstrap.intervals[k]!,
      })),
      maximumAbsoluteCorrelation: observed.globalMaximum,
      peak: {
        lagMinutes: LAG_MINUTES[observed.index]!,
        correlation: peakCorrelation,
        absoluteCorrelation: Math.abs(peakCorrelation),
        overlap: overlaps[observed.index]!,
      },
      null: {
        shifts: nullReference.shifts,
        pValue: (1 + nullReference.exceedances) / length,
        denominator: length,
      },
      uncertainty: {
        method: BOOTSTRAP_METHOD,
        blockMinutes: A25_PROFILE.bootstrap.blockMinutes,
        replicates,
        seed: effectiveSeed,
        peakLagFrequencies: LAG_MINUTES.map((lagMinutes, k) => {
          const count = bootstrap.peakCounts[k]!;
          return { lagMinutes, count, frequency: bootstrap.eligible > 0 ? count / bootstrap.eligible : null };
        }),
        eligiblePeakReplicates: bootstrap.eligible,
        undefinedPeakReplicates: replicates - bootstrap.eligible,
      },
    },
  };
}
