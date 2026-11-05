import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { z } from 'zod';

/**
 * A24 observed saturation proxies: strict pure domain contract (provisional candidate, not integrated).
 *
 * The input is an internally normalized qualified-witness bundle that a future independent raw decoder
 * produces. It is NOT externally trusted proof. Manifest IDs, hashes and reference IDs are shape-checked and
 * cross-bound here but never verified against bytes. A Service/adapter must separately reconstruct every
 * count, qualification and completeness status from retained raw evidence; this module alone cannot certify
 * acquisition, provider identity or historical X completeness.
 *
 * The output is a descriptive vector over one fixed frame W0=[t0-L,t0), W1=[t0,t1), with L=t1-t0 taken from
 * the finalized holder endpoints. It is never an entry/trading gate, a composite score or a confidence claim.
 * Non-COMPLETE components carry their status and reason and no derived numbers; malformed or contradictory
 * input is INVALID rather than partially promoted.
 */

export const SATURATION_INPUT_METHOD = 'a24-saturation-input-v1' as const;
export const SATURATION_METHOD = 'a24-observed-saturation-v1' as const;
export const HOLDER_POPULATION_METHOD = 'helius-positive-owner-aggregate-v1' as const;
export const DEX_PAID_SOURCE = 'dexscreener-orders-v1' as const;
/** Same freshness bound as advisory-social paid visibility: maximum snapshot age at cutoff. */
export const DEX_MAX_AGE_MS = 900_000;
export const SATURATION_LIMITATIONS: readonly string[] = [
  'Normalized qualified-witness input is not externally trusted proof; a Service/adapter must reconstruct it from retained raw bytes. This module alone cannot certify acquisition, provider identity or historical X completeness.',
  'X counts describe the declared query basket in the fixed W0/W1 frame only, not all X activity, people or communities.',
  'Source novelty is relative to W0 only, not first-ever authors.',
  'Holder counts are positive owner addresses including program/pool owners, not people or new economic participants.',
  'Paid visibility lists observed DEX orders/boosts and reviewed X disclosures/labels only; hidden payments are NOT_MEASURED and label absence is not evidence of organic activity.',
  'Descriptive vector only: no saturation score, confidence interval or entry/trading gate.',
];
const SCOPE_STATEMENT = 'Observed declared X query-basket sample and Solana positive-owner populations in one fixed half-open frame.';

const Dec = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_EVEN });
const STATUSES = ['COMPLETE', 'INCOMPLETE', 'TRUNCATED', 'UNAVAILABLE'] as const;
export type CoverageStatus = (typeof STATUSES)[number];

function isCanonicalInstant(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

// Input contract. Every object is strict; qualifications pair an explicit status with a result that exists
// exactly when the status is COMPLETE, plus reconstruction reference IDs.
const Status = z.enum(STATUSES);
const Instant = z.string().refine(isCanonicalInstant, 'expected canonical UTC instant YYYY-MM-DDTHH:mm:ss.sssZ');
const Ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/);
const Refs = z.array(Ref).min(1).max(64);
const XId = z.string().regex(/^[1-9][0-9]{0,24}$/);
const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Version = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);
const Code = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);
const SpanSchema = z.strictObject({ start: Instant, end: Instant });
const SourceFailure = z.strictObject({ status: z.enum(['INCOMPLETE', 'TRUNCATED', 'UNAVAILABLE']), reasonCode: Code, refs: Refs });
const Check = z.strictObject({ status: Status, refs: Refs });
const qualified = <T extends z.ZodType>(result: T) => z.strictObject({ status: Status, result: z.nullable(result), refs: Refs });

const QuerySchema = z.strictObject({
  id: Ref,
  kind: z.enum(['EXACT_CONTRACT', 'PROVEN_ACCOUNT']),
  query: z.string().min(1).max(512),
  bindingProofRef: Ref.nullable(),
});
const CaptureSchema = z.strictObject({
  window: z.enum(['W0', 'W1']),
  queryId: Ref,
  status: Status,
  reasonCode: Code.nullable(),
  queryHash: Sha256,
  manifestId: Ref,
  manifestSha256: Sha256,
  refs: Refs,
});
const PostSchema = z.strictObject({
  postId: XId,
  queryId: Ref,
  role: z.enum(['ORIGINAL', 'COMMENTARY', 'REPOST']),
  identity: qualified(z.strictObject({ authorId: XId, handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/).nullable(), revisionFamilyId: XId })),
  time: qualified(z.strictObject({ createdAt: Instant })),
  body: qualified(z.strictObject({ sha256: Sha256 })),
  binding: qualified(z.enum(['BODY_CONTAINS_MINT', 'PROVEN_ACCOUNT', 'NOT_BOUND'])),
  forwardCall: qualified(z.strictObject({ label: z.enum(['FORWARD_CALL', 'NEWS', 'JOKE', 'WARNING', 'RETROSPECTIVE', 'OTHER']), rubricVersion: Version })),
  paidText: qualified(z.strictObject({ disclosed: z.boolean(), rubricVersion: Version })),
  paidLabels: qualified(z.strictObject({ labels: z.array(z.enum(['PAID_PARTNERSHIP', 'PROMOTED'])).max(2), evidence: z.enum(['WIRE', 'DOM_SNAPSHOT']), evidenceRef: Ref })),
});
const XCollectedSchema = z.strictObject({
  source: z.literal('chrome-devtools-response-export'),
  sourceVersion: Version,
  access: z.enum(['USER_SESSION_READ', 'PUBLIC_BROWSER', 'X_API']),
  queries: z.array(QuerySchema).min(1).max(16),
  queryHash: Sha256,
  eligibilityVersion: Version,
  forwardCallRubricVersion: Version,
  paidDisclosureRubricVersion: Version,
  windows: z.strictObject({ w0: SpanSchema, w1: SpanSchema }),
  collector: z.strictObject({ startedAt: Instant, finishedAt: Instant, maxClockSkewMs: z.number().int().min(0).max(300_000) }),
  captures: z.array(CaptureSchema).min(2).max(32),
  posts: z.array(PostSchema).max(20_000),
});
const SnapshotSchema = z.strictObject({
  mint: Base58,
  programId: Base58,
  provider: z.literal('helius'),
  method: z.literal(HOLDER_POPULATION_METHOD),
  exclusionPolicy: Version,
  commitment: z.literal('finalized'),
  slot: z.number().int().positive(),
  blockTime: Instant,
  population: qualified(z.strictObject({ positiveOwners: z.number().int().min(0) })),
  supply: Check,
  manifestId: Ref,
  manifestSha256: Sha256,
});
const HoldersSchema = z.strictObject({ s0: SnapshotSchema, s1: SnapshotSchema });
const DexObservationSchema = z.strictObject({
  kind: z.enum(['ORDER', 'BOOST']),
  venue: z.literal('dexscreener'),
  id: Ref.nullable(),
  type: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  status: z.enum(['processing', 'approved', 'on-hold', 'cancelled', 'rejected']).nullable(),
  paymentAt: Instant,
});
const DexSchema = z.strictObject({
  mint: Base58,
  source: z.literal(DEX_PAID_SOURCE),
  availableAt: Instant,
  manifestId: Ref,
  manifestSha256: Sha256,
  refs: Refs,
  observations: z.array(DexObservationSchema).max(1000),
});
export const SaturationInputSchema = z.strictObject({
  method: z.literal(SATURATION_INPUT_METHOD),
  token: z.strictObject({ chain: z.literal('solana'), mint: Base58 }),
  frame: z.strictObject({ t0: Instant, t1: Instant }),
  cutoff: Instant,
  evidenceIds: z.array(Ref).max(256).optional(),
  x: z.union([XCollectedSchema, SourceFailure]),
  holders: z.union([HoldersSchema, SourceFailure]),
  dex: z.union([DexSchema, SourceFailure]),
});

export type SaturationInput = z.infer<typeof SaturationInputSchema>;
export type SaturationQuery = z.infer<typeof QuerySchema>;
type XCollected = z.infer<typeof XCollectedSchema>;
type XPost = z.infer<typeof PostSchema>;
type HolderPair = z.infer<typeof HoldersSchema>;
type DexSnapshot = z.infer<typeof DexSchema>;
type PaidLabel = 'PAID_PARTNERSHIP' | 'PROMOTED';

// Output contract.
export type Fraction = { numerator: number; denominator: number; value: string };
export type Rate = { change: number; durationSeconds: string; perSecond: string };
export type Component<T> = { status: CoverageStatus; reasonCode: string | null; value: T | null };
export type Span = { start: string; end: string };
export type SaturationFrame = { w0: Span; w1: Span; durationSeconds: string; convention: 'HALF_OPEN_START_INCLUSIVE' };
export type AuthorCount = { authorId: string; posts: number };
export type WindowSummary = {
  status: CoverageStatus;
  reasonCode: string | null;
  posts: number | null;
  authors: number | null;
  countsByAuthor: AuthorCount[] | null;
  excludedReposts: number | null;
  excludedUnbound: number | null;
};
export type RepeatedAuthor = { posts: number; authors: number; repeatPosts: number; share: Fraction | null };
export type SourceNovelty = { currentAuthors: number; newAuthors: number; newAuthorIds: string[]; returningAuthorIds: string[]; share: Fraction | null };
export type CallerBreadth = { callers: number; callerAuthorIds: string[]; reviewedPosts: number };
export type MentionGrowth = { n0: number; n1: number; rate: Rate; relative: Fraction | null; relativeReason: 'BASELINE_ZERO' | null };
export type HolderEndpoint = { slot: number; blockTime: string };
export type HolderGrowth = { unit: 'POSITIVE_OWNER_ADDRESSES'; h0: number; h1: number; rate: Rate; s0: HolderEndpoint; s1: HolderEndpoint };
export type DexPaidGroup = { venue: string; kind: 'ORDER' | 'BOOST'; type: string; status: string | null; timing: 'BEFORE_INTERVAL' | 'IN_INTERVAL' | 'AFTER_INTERVAL'; count: number };
export type DexPaid = { availableAt: string; observations: number; groups: DexPaidGroup[] };
export type XPaidPost = { postId: string; authorId: string; disclosed: boolean; labels: PaidLabel[]; labelEvidence: 'WIRE' | 'DOM_SNAPSHOT' };
export type XPaid = { inspectedPosts: number; disclosedPosts: number; labelledPosts: number; posts: XPaidPost[] };
export type PaidVisibility = { status: CoverageStatus; reasonCode: string | null; dex: Component<DexPaid>; x: Component<XPaid>; hiddenPayments: 'NOT_MEASURED' };
export type SaturationData = {
  windows: { w0: WindowSummary; w1: WindowSummary };
  repeatedAuthor: Component<RepeatedAuthor>;
  sourceNovelty: Component<SourceNovelty>;
  callerBreadth: Component<CallerBreadth>;
  mentionGrowth: Component<MentionGrowth>;
  holderGrowth: Component<HolderGrowth>;
  paidVisibility: PaidVisibility;
};
export type SaturationScope = ReturnType<typeof describeScope>;
export type SaturationVector = {
  id: 'A24';
  method: typeof SATURATION_METHOD;
  quality: 'KNOWN' | 'MISSING' | 'INVALID';
  reasonCode: string | null;
  evidenceIds: string[];
  scope: SaturationScope | null;
  data: SaturationData | null;
  limitations: readonly string[];
};

class InvalidSaturationInput extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
function need(condition: boolean, code: string): asserts condition {
  if (!condition) throw new InvalidSaturationInput(code);
}

type Gap = { status: CoverageStatus; reasonCode: string | null };
type Eligible = { post: XPost; authorId: string };
type Tally = Gap & { eligible: Eligible[]; reposts: number; unbound: number };

const COMPLETE: Gap = { status: 'COMPLETE', reasonCode: null };
const ms = (instant: string) => Date.parse(instant);
const iso = (epochMs: number) => new Date(epochMs).toISOString();
const inside = (at: number, start: number, end: number) => at >= start && at < end;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const cmpNumericId = (a: string, b: string) => a.length - b.length || cmp(a, b);
const sameSpan = (a: Span, b: Span) => a.start === b.start && a.end === b.end;
const severity = (status: CoverageStatus) => STATUSES.indexOf(status);
const worse = (gap: Gap, status: CoverageStatus, reasonCode: string): Gap => (severity(status) > severity(gap.status) ? { status, reasonCode } : gap);
const merge = (a: Gap, b: Gap): Gap => {
  const base = { status: a.status, reasonCode: a.reasonCode };
  return b.status === 'COMPLETE' ? base : worse(base, b.status, b.reasonCode ?? 'UNSPECIFIED_GAP');
};
const gapOnly = (gap: Gap): Component<never> => ({ status: gap.status, reasonCode: gap.reasonCode, value: null });
const fraction = (numerator: number, denominator: number): Fraction | null =>
  denominator > 0 ? { numerator, denominator, value: new Dec(numerator).div(denominator).toFixed() } : null;
const rate = (change: number, durationMs: number): Rate => {
  const seconds = new Dec(durationMs).div(1000);
  return { change, durationSeconds: seconds.toFixed(), perSecond: new Dec(change).div(seconds).toFixed() };
};

/** Canonical basket hash shared with the future provider: queries sorted by id, fixed field order. */
export function hashQueryBasket(queries: readonly SaturationQuery[]): string {
  const canonical = [...queries].sort((a, b) => cmp(a.id, b.id)).map((q) => [q.id, q.kind, q.query, q.bindingProofRef]);
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

// Entries for one canonical post may differ only in which query returned them, in provenance references and in
// the display-only handle. Author ID, revision family, time, body, binding and reviews must match exactly.
const NON_MEASURED_KEYS = new Set(['queryId', 'refs', 'evidenceRef', 'handle']);
const measuredContent = (post: XPost) => JSON.stringify(post, (key, value: unknown) => (NON_MEASURED_KEYS.has(key) ? undefined : value));

// An EXACT_CONTRACT query must contain the full mint as a case-sensitive token, not inside a longer string.
const ADDRESS_CHAR = /^[A-Za-z0-9]$/;
function containsExactMint(query: string, mint: string): boolean {
  for (let at = query.indexOf(mint); at !== -1; at = query.indexOf(mint, at + 1)) {
    if (!ADDRESS_CHAR.test(query[at - 1] ?? '') && !ADDRESS_CHAR.test(query[at + mint.length] ?? '')) return true;
  }
  return false;
}

function measureX(x: XCollected, mint: string, frame: SaturationFrame, cutoff: number): [Tally, Tally] {
  const queryIds = new Set(x.queries.map((q) => q.id));
  need(queryIds.size === x.queries.length, 'QUERY_ID_DUPLICATE');
  need(x.queries.some((q) => q.kind === 'EXACT_CONTRACT'), 'EXACT_CONTRACT_QUERY_MISSING');
  for (const q of x.queries) {
    need(q.kind === 'EXACT_CONTRACT' ? containsExactMint(q.query, mint) && q.bindingProofRef === null : q.bindingProofRef !== null, 'QUERY_BINDING_INVALID');
  }
  need(x.queryHash === hashQueryBasket(x.queries), 'QUERY_HASH_MISMATCH');
  need(sameSpan(x.windows.w0, frame.w0) && sameSpan(x.windows.w1, frame.w1), 'X_WINDOW_MISMATCH');
  const started = ms(x.collector.startedAt), finished = ms(x.collector.finishedAt), skew = x.collector.maxClockSkewMs;
  need(started <= finished, 'COLLECTOR_CLOCK_REVERSED');
  need(started - skew >= ms(frame.w1.end), 'COLLECTOR_STARTED_BEFORE_WINDOW_END');
  need(finished + skew <= cutoff, 'COLLECTOR_AFTER_CUTOFF');

  const gaps: Record<'W0' | 'W1', Gap> = { W0: { ...COMPLETE }, W1: { ...COMPLETE } };
  const captured = new Set<string>();
  for (const c of x.captures) {
    need(queryIds.has(c.queryId), 'CAPTURE_QUERY_UNKNOWN');
    need(c.queryHash === x.queryHash, 'CAPTURE_QUERY_HASH_MISMATCH');
    need((c.status === 'COMPLETE') === (c.reasonCode === null), 'CAPTURE_STATUS_CONTRADICTION');
    const key = `${c.window}:${c.queryId}`;
    need(!captured.has(key), 'CAPTURE_DUPLICATE');
    captured.add(key);
    if (c.reasonCode !== null) gaps[c.window] = worse(gaps[c.window], c.status, c.reasonCode);
  }
  need(captured.size === 2 * queryIds.size, 'CAPTURE_BASKET_INCOMPLETE');

  const provenAccountQuery = x.queries.some((q) => q.kind === 'PROVEN_ACCOUNT');
  const unique = new Map<string, { post: XPost; content: string; queryIds: Set<string> }>();
  for (const post of x.posts) {
    need(queryIds.has(post.queryId), 'POST_QUERY_UNKNOWN');
    for (const q of [post.identity, post.time, post.body, post.binding, post.forwardCall, post.paidText, post.paidLabels]) {
      need((q.status === 'COMPLETE') === (q.result !== null), 'QUALIFICATION_RESULT_CONTRADICTION');
    }
    const fullBody = post.body.status === 'COMPLETE';
    need(post.binding.result !== 'BODY_CONTAINS_MINT' || fullBody, 'BINDING_WITHOUT_FULL_BODY');
    need(post.binding.result !== 'PROVEN_ACCOUNT' || provenAccountQuery, 'BINDING_PROOF_QUERY_MISSING');
    const call = post.forwardCall.result, text = post.paidText.result;
    need(call === null || (fullBody && call.rubricVersion === x.forwardCallRubricVersion), 'FORWARD_CALL_REVIEW_INCONSISTENT');
    need(text === null || (fullBody && text.rubricVersion === x.paidDisclosureRubricVersion), 'PAID_TEXT_REVIEW_INCONSISTENT');
    const labels = post.paidLabels.result?.labels ?? [];
    need(labels.every((label, i) => i === 0 || labels[i - 1] < label), 'PAID_LABELS_NOT_CANONICAL');
    const time = post.time.result;
    need(time === null || ms(time.createdAt) <= finished + skew, 'POST_AFTER_COLLECTION');
    const content = measuredContent(post), prior = unique.get(post.postId);
    if (prior) {
      need(prior.content === content && !prior.queryIds.has(post.queryId), 'POST_DUPLICATE_CONFLICT');
      prior.queryIds.add(post.queryId);
    } else unique.set(post.postId, { post, content, queryIds: new Set([post.queryId]) });
  }
  // The decoder must collapse edits into one canonical record per revision family.
  const families = new Map<string, string>();
  for (const { post } of unique.values()) {
    const identity = post.identity.result;
    if (!identity) continue;
    const owner = families.get(identity.revisionFamilyId);
    need(owner === undefined || owner === post.postId, 'REVISION_FAMILY_CONFLICT');
    families.set(identity.revisionFamilyId, post.postId);
  }
  const posts = [...unique.values()].map((entry) => entry.post);
  return [tally(posts, gaps.W0, frame.w0), tally(posts, gaps.W1, frame.w1)];
}

// Pending qualifications degrade the window instead of being dropped from its denominator.
function tally(posts: XPost[], start: Gap, span: Span): Tally {
  const from = ms(span.start), to = ms(span.end);
  let gap = start, reposts = 0, unbound = 0;
  const eligible: Eligible[] = [];
  for (const post of posts) {
    const time = post.time.result;
    if (post.role === 'REPOST') {
      if (time && inside(ms(time.createdAt), from, to)) reposts++;
      continue;
    }
    if (!time) {
      gap = worse(gap, post.time.status, 'POST_TIME_UNQUALIFIED');
      continue;
    }
    if (!inside(ms(time.createdAt), from, to)) continue;
    if (post.binding.result === 'NOT_BOUND') {
      unbound++;
      continue;
    }
    const identity = post.identity.result;
    if (!identity) gap = worse(gap, post.identity.status, 'POST_IDENTITY_UNQUALIFIED');
    else if (post.body.status !== 'COMPLETE') gap = worse(gap, post.body.status, 'POST_BODY_UNQUALIFIED');
    else if (post.binding.status !== 'COMPLETE') gap = worse(gap, post.binding.status, 'POST_BINDING_UNQUALIFIED');
    else eligible.push({ post, authorId: identity.authorId });
  }
  return { ...gap, eligible, reposts, unbound };
}

function authorCounts(window: Tally): AuthorCount[] {
  const counts = new Map<string, number>();
  for (const { authorId } of window.eligible) counts.set(authorId, (counts.get(authorId) ?? 0) + 1);
  return [...counts].map(([authorId, posts]) => ({ authorId, posts })).sort((a, b) => b.posts - a.posts || cmpNumericId(a.authorId, b.authorId));
}
const authorSet = (window: Tally) => new Set(window.eligible.map((e) => e.authorId));

function summarize(window: Tally): WindowSummary {
  if (window.status !== 'COMPLETE') {
    return { status: window.status, reasonCode: window.reasonCode, posts: null, authors: null, countsByAuthor: null, excludedReposts: null, excludedUnbound: null };
  }
  const counts = authorCounts(window);
  return { status: 'COMPLETE', reasonCode: null, posts: window.eligible.length, authors: counts.length, countsByAuthor: counts, excludedReposts: window.reposts, excludedUnbound: window.unbound };
}

function repeatedAuthor(w1: Tally): Component<RepeatedAuthor> {
  if (w1.status !== 'COMPLETE') return gapOnly(w1);
  const posts = w1.eligible.length, authors = authorSet(w1).size;
  return { status: 'COMPLETE', reasonCode: posts ? null : 'REPEAT_DENOMINATOR_ZERO', value: { posts, authors, repeatPosts: posts - authors, share: fraction(posts - authors, posts) } };
}

function sourceNovelty(w0: Tally, w1: Tally): Component<SourceNovelty> {
  const gap = merge(w0, w1);
  if (gap.status !== 'COMPLETE') return gapOnly(gap);
  const prior = authorSet(w0), current = [...authorSet(w1)].sort(cmpNumericId);
  const newAuthorIds = current.filter((a) => !prior.has(a)), returningAuthorIds = current.filter((a) => prior.has(a));
  return {
    status: 'COMPLETE',
    reasonCode: current.length ? null : 'NOVELTY_DENOMINATOR_ZERO',
    value: { currentAuthors: current.length, newAuthors: newAuthorIds.length, newAuthorIds, returningAuthorIds, share: fraction(newAuthorIds.length, current.length) },
  };
}

// Zero callers is a measurement only when every eligible W1 post has a complete prospective-call review.
function callerBreadth(w1: Tally): Component<CallerBreadth> {
  if (w1.status !== 'COMPLETE') return gapOnly(w1);
  let gap: Gap = { ...COMPLETE };
  const callers = new Set<string>();
  for (const { post, authorId } of w1.eligible) {
    const review = post.forwardCall.result;
    if (!review) gap = worse(gap, post.forwardCall.status, 'FORWARD_CALL_REVIEW_INCOMPLETE');
    else if (review.label === 'FORWARD_CALL') callers.add(authorId);
  }
  if (gap.status !== 'COMPLETE') return gapOnly(gap);
  return { ...COMPLETE, value: { callers: callers.size, callerAuthorIds: [...callers].sort(cmpNumericId), reviewedPosts: w1.eligible.length } };
}

function mentionGrowth(w0: Tally, w1: Tally, durationMs: number): Component<MentionGrowth> {
  const gap = merge(w0, w1);
  if (gap.status !== 'COMPLETE') return gapOnly(gap);
  const n0 = w0.eligible.length, n1 = w1.eligible.length;
  return { ...COMPLETE, value: { n0, n1, rate: rate(n1 - n0, durationMs), relative: fraction(n1 - n0, n0), relativeReason: n0 ? null : 'BASELINE_ZERO' } };
}

function measureHolders({ s0, s1 }: HolderPair, mint: string, t0: number, t1: number): Component<HolderGrowth> {
  need(s0.mint === mint && s1.mint === mint, 'HOLDER_MINT_MISMATCH');
  need(s0.programId === s1.programId && s0.exclusionPolicy === s1.exclusionPolicy, 'HOLDER_POLICY_MISMATCH');
  need(s0.slot < s1.slot, 'HOLDER_SLOT_ORDER');
  need(ms(s0.blockTime) === t0 && ms(s1.blockTime) === t1, 'HOLDER_FRAME_MISMATCH');
  let gap: Gap = { ...COMPLETE };
  for (const s of [s0, s1]) {
    need((s.population.status === 'COMPLETE') === (s.population.result !== null), 'QUALIFICATION_RESULT_CONTRADICTION');
    if (s.population.status !== 'COMPLETE') gap = worse(gap, s.population.status, 'HOLDER_POPULATION_INCOMPLETE');
    if (s.supply.status !== 'COMPLETE') gap = worse(gap, s.supply.status, 'HOLDER_SUPPLY_UNRECONCILED');
  }
  const h0 = s0.population.result, h1 = s1.population.result;
  if (gap.status !== 'COMPLETE' || !h0 || !h1) return gapOnly(gap);
  return {
    ...COMPLETE,
    value: {
      unit: 'POSITIVE_OWNER_ADDRESSES',
      h0: h0.positiveOwners,
      h1: h1.positiveOwners,
      rate: rate(h1.positiveOwners - h0.positiveOwners, t1 - t0),
      s0: { slot: s0.slot, blockTime: s0.blockTime },
      s1: { slot: s1.slot, blockTime: s1.blockTime },
    },
  };
}

const groupKey = (g: DexPaidGroup) => [g.venue, g.kind, g.type, g.status ?? '', g.timing].join('|');

// A current DEX snapshot taken after W1 ends and at most DEX_MAX_AGE_MS before cutoff; payments are split by
// timing relative to the frame, so older inventory remains a valid observation.
function measureDex(d: DexSnapshot, mint: string, t0: number, t1: number, cutoff: number): Component<DexPaid> {
  need(d.mint === mint, 'DEX_MINT_MISMATCH');
  const availableAt = ms(d.availableAt);
  need(availableAt <= cutoff, 'DEX_AFTER_CUTOFF');
  const seen = new Set<string>(), groups = new Map<string, DexPaidGroup>();
  for (const o of d.observations) {
    need(o.kind === 'ORDER' ? o.status !== null : o.id !== null && o.status === null, 'DEX_OBSERVATION_SHAPE');
    const paidAt = ms(o.paymentAt);
    need(paidAt <= availableAt, 'DEX_PAYMENT_AFTER_SNAPSHOT');
    const identity = o.id === null ? JSON.stringify(o) : `${o.kind}:${o.id}`;
    need(!seen.has(identity), 'DEX_DUPLICATE_OBSERVATION');
    seen.add(identity);
    const timing = paidAt < t0 ? 'BEFORE_INTERVAL' : paidAt < t1 ? 'IN_INTERVAL' : 'AFTER_INTERVAL';
    const group: DexPaidGroup = { venue: o.venue, kind: o.kind, type: o.type, status: o.status, timing, count: 1 };
    const existing = groups.get(groupKey(group));
    if (existing) existing.count++;
    else groups.set(groupKey(group), group);
  }
  if (availableAt < t1) return { status: 'INCOMPLETE', reasonCode: 'DEX_SNAPSHOT_BEFORE_WINDOW_END', value: null };
  if (cutoff - availableAt > DEX_MAX_AGE_MS) return { status: 'INCOMPLETE', reasonCode: 'DEX_SNAPSHOT_STALE', value: null };
  return { ...COMPLETE, value: { availableAt: d.availableAt, observations: d.observations.length, groups: [...groups.values()].sort((a, b) => cmp(groupKey(a), groupKey(b))) } };
}

// Every eligible W1 post needs reviewed disclosure text and an inspected label record; absence is never zero.
function paidX(w1: Tally): Component<XPaid> {
  if (w1.status !== 'COMPLETE') return gapOnly(w1);
  let gap: Gap = { ...COMPLETE };
  const posts: XPaidPost[] = [];
  for (const { post, authorId } of w1.eligible) {
    const text = post.paidText.result, labels = post.paidLabels.result;
    if (!text) gap = worse(gap, post.paidText.status, 'PAID_DISCLOSURE_REVIEW_INCOMPLETE');
    else if (!labels) gap = worse(gap, post.paidLabels.status, 'PAID_LABEL_INSPECTION_MISSING');
    else posts.push({ postId: post.postId, authorId, disclosed: text.disclosed, labels: labels.labels, labelEvidence: labels.evidence });
  }
  if (gap.status !== 'COMPLETE') return gapOnly(gap);
  posts.sort((a, b) => cmpNumericId(a.postId, b.postId));
  return {
    ...COMPLETE,
    value: { inspectedPosts: posts.length, disclosedPosts: posts.filter((p) => p.disclosed).length, labelledPosts: posts.filter((p) => p.labels.length > 0).length, posts },
  };
}

function describeScope(input: SaturationInput, frame: SaturationFrame) {
  const { x, holders, dex } = input;
  return {
    token: input.token,
    cutoff: input.cutoff,
    frame,
    x:
      'queries' in x
        ? {
            source: x.source,
            sourceVersion: x.sourceVersion,
            access: x.access,
            queryHash: x.queryHash,
            queryIds: x.queries.map((q) => q.id).sort(cmp),
            eligibilityVersion: x.eligibilityVersion,
            forwardCallRubricVersion: x.forwardCallRubricVersion,
            paidDisclosureRubricVersion: x.paidDisclosureRubricVersion,
            collector: x.collector,
            captures: x.captures
              .map(({ window, queryId, status, reasonCode, manifestId, manifestSha256 }) => ({ window, queryId, status, reasonCode, manifestId, manifestSha256 }))
              .sort((a, b) => cmp(`${a.window}:${a.queryId}`, `${b.window}:${b.queryId}`)),
          }
        : { status: x.status, reasonCode: x.reasonCode },
    holders:
      's0' in holders
        ? {
            provider: holders.s0.provider,
            method: holders.s0.method,
            exclusionPolicy: holders.s0.exclusionPolicy,
            programId: holders.s0.programId,
            commitment: holders.s0.commitment,
            manifests: [holders.s0, holders.s1].map((s) => ({ slot: s.slot, manifestId: s.manifestId, manifestSha256: s.manifestSha256 })),
          }
        : { status: holders.status, reasonCode: holders.reasonCode },
    dex: 'observations' in dex ? { source: dex.source, availableAt: dex.availableAt, manifestId: dex.manifestId, manifestSha256: dex.manifestSha256 } : { status: dex.status, reasonCode: dex.reasonCode },
    statement: SCOPE_STATEMENT,
  };
}

function measure(input: SaturationInput): SaturationVector {
  const t0 = ms(input.frame.t0), t1 = ms(input.frame.t1), cutoff = ms(input.cutoff);
  need(t0 < t1, 'FRAME_NOT_INCREASING');
  need(t1 <= cutoff, 'FRAME_AFTER_CUTOFF');
  const length = t1 - t0;
  need(Number.isFinite(new Date(t0 - length).getTime()), 'FRAME_OUT_OF_RANGE');
  const evidenceIds = [...(input.evidenceIds ?? [])].sort(cmp);
  need(evidenceIds.every((id, i) => i === 0 || evidenceIds[i - 1] !== id), 'EVIDENCE_ID_DUPLICATE');
  const frame: SaturationFrame = {
    w0: { start: iso(t0 - length), end: input.frame.t0 },
    w1: { start: input.frame.t0, end: input.frame.t1 },
    durationSeconds: new Dec(length).div(1000).toFixed(),
    convention: 'HALF_OPEN_START_INCLUSIVE',
  };
  const mint = input.token.mint;
  const sourceGap = (gap: Gap): [Tally, Tally] => {
    const window: Tally = { status: gap.status, reasonCode: gap.reasonCode, eligible: [], reposts: 0, unbound: 0 };
    return [window, window];
  };
  const [w0, w1] = 'queries' in input.x ? measureX(input.x, mint, frame, cutoff) : sourceGap(input.x);
  const holderGrowth: Component<HolderGrowth> = 's0' in input.holders ? measureHolders(input.holders, mint, t0, t1) : gapOnly(input.holders);
  const dex: Component<DexPaid> = 'observations' in input.dex ? measureDex(input.dex, mint, t0, t1, cutoff) : gapOnly(input.dex);
  const xPaid = paidX(w1);
  const data: SaturationData = {
    windows: { w0: summarize(w0), w1: summarize(w1) },
    repeatedAuthor: repeatedAuthor(w1),
    sourceNovelty: sourceNovelty(w0, w1),
    callerBreadth: callerBreadth(w1),
    mentionGrowth: mentionGrowth(w0, w1, length),
    holderGrowth,
    paidVisibility: { ...merge(dex, xPaid), dex, x: xPaid, hiddenPayments: 'NOT_MEASURED' },
  };
  // KNOWN requires every required component complete and the required repeat/novelty denominators positive.
  // Optional relative mention growth may stay undefined.
  const required: Gap[] = [data.repeatedAuthor, data.sourceNovelty, data.callerBreadth, data.mentionGrowth, data.holderGrowth, data.paidVisibility];
  const blocking = required.find((c) => c.status !== 'COMPLETE');
  const undefinedShare = !data.repeatedAuthor.value?.share || !data.sourceNovelty.value?.share;
  const quality: 'KNOWN' | 'MISSING' = blocking || undefinedShare ? 'MISSING' : 'KNOWN';
  const reasonCode = blocking ? blocking.reasonCode : undefinedShare ? (data.repeatedAuthor.reasonCode ?? data.sourceNovelty.reasonCode) : null;
  return { id: 'A24', method: SATURATION_METHOD, quality, reasonCode, evidenceIds, scope: describeScope(input, frame), data, limitations: SATURATION_LIMITATIONS };
}

const invalid = (reasonCode: string): SaturationVector => ({
  id: 'A24',
  method: SATURATION_METHOD,
  quality: 'INVALID',
  reasonCode,
  evidenceIds: [],
  scope: null,
  data: null,
  limitations: SATURATION_LIMITATIONS,
});

/** Derives the A24 descriptive vector from a normalized witness bundle; validates it strictly regardless of origin. */
export function deriveSaturationVector(input: unknown): SaturationVector {
  const parsed = SaturationInputSchema.safeParse(input);
  if (!parsed.success) return invalid('INPUT_SCHEMA_INVALID');
  try {
    return measure(parsed.data);
  } catch (error) {
    if (error instanceof InvalidSaturationInput) return invalid(error.code);
    throw error;
  }
}
