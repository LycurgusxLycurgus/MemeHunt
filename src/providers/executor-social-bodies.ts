import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tokenRefSchema, type TokenRef } from '../domain/contracts.js';
import { canonicalSocialUrl, socialInputSchema, socialNamesAddress, type SocialInput } from '../domain/social.js';
import { callerHistorySelectionSchema, collectCallerHistory, decodeCallerHistory, type CallerHistory, type CallerHistorySelection, type CallerSourceLayer } from './advisory-caller-history.js';

/**
 * Current-read body expansion v1 (advisory only). Each dated in-window current target keeps its source id; its text becomes a provider-trust
 * line, newline, the exact FxTwitter tweet.text, separator, an original-page delimiter line, newline and the unchanged original text.
 * url/authorId/publishedAt/availableAt come from the strict official+Fx triplet; the original page, its clocks and any paid-partnership label
 * stay in the same source. One unmodified collectCallerHistory attempt over the current read window; replay recomputes the identical read
 * and the code-owned body line pairs offline through the unmodified decodeCallerHistory.
 */
export const EXECUTOR_SOCIAL_BODIES_METHOD = 'executor-social-bodies-v1' as const;
export const EXECUTOR_SOCIAL_BODIES_LIMIT=8*1024*1024;
const CALLER_BODY_METHOD=EXECUTOR_SOCIAL_BODIES_METHOD;
export const EXECUTOR_SOCIAL_BODIES_TRUST = 'Compound source: only the text between the provider-trust line and the original-page delimiter is the post body, FxTwitter tweet.text (third-party reported); official X corroborates id, author handle, creation second, current revision and the visible official prefix only. The original rendered page is unchanged context and never establishes the native body binding.';
const CALLER_BODY_TRUST=EXECUTOR_SOCIAL_BODIES_TRUST;
const BODY_MAX = 120_000, CORPUS_MAX = 120_000, SHORT_QUOTE_MAX = 1000, QUOTE_MIN = 8, POSTS_MAX = 32;
const STATUS = /^https:\/\/x\.com\/[a-z0-9_]{1,15}\/status\/[1-9][0-9]{0,19}$/;
const timestamp = z.iso.datetime({ offset: true });
const captureSchema = z.object({
  method: z.literal(CALLER_BODY_METHOD), token: tokenRefSchema, original: z.unknown(), startedAt: timestamp, finishedAt: timestamp,
  selection: callerHistorySelectionSchema.nullable(), rawArtifacts: z.record(z.string(), z.string()).nullable(), code: z.literal('CALLER_BODY_COLLECT_FAILED').nullable(),
}).strict();

type SocialSource = SocialInput['sources'][number];
export type CallerBodyRange = {
  sourceId: string; statusId: string; bodyStart: number; bodyEnd: number; firstLineId: string; lastLineId: string; bodySha256: string; bodyUtf16: number;
  literalContract: boolean; completeness: CallerSourceLayer['completeness']; mintLocation: CallerSourceLayer['mintLocation'];
};
type Plan = { codes: string[]; selection: CallerHistorySelection | null };

function fail(code: string): never { throw new Error(code); }
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const wellFormed = (text: string) => Buffer.from(text, 'utf8').toString('utf8') === text;
const ms = (at: string) => Date.parse(at);

/** Same line semantics as socialCatalog: CRLF, CR and LF each end a line; a line's end excludes its terminator. */
export function executorSocialBodyCatalogLines(text: string): Array<{ start: number; end: number }> {
  const lines: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) { lines.push({ start, end: match.index! }); start = match.index! + match[0].length; }
  lines.push({ start, end: text.length });
  return lines;
}
function originalOf(input: unknown): SocialInput {
  const parsed = socialInputSchema.safeParse(input);
  if (!parsed.success) fail('CALLER_BODY_READ_INVALID');
  const { qualifiedAt: _qualifiedAt, ...read } = parsed.data;
  if(new Set(read.sources.map(s=>s.id)).size!==read.sources.length||new Set(read.targetPostIds).size!==read.targetPostIds.length||new Set(read.identitySourceIds).size!==read.identitySourceIds.length||[...read.targetPostIds,...read.identitySourceIds].some(id=>!read.sources.some(s=>s.id===id))||read.targetPostIds.some(id=>read.sources.find(s=>s.id===id)?.kind!=='POST')||!(ms(read.start)<ms(read.end)))fail('CALLER_BODY_READ_INVALID');
  return read;
}
const scopeHash = (read: SocialInput) => sha(JSON.stringify({ start: read.start, end: read.end, targetPostIds: read.targetPostIds,
  sources: read.sources.map(s => ({ id: s.id, kind: s.kind, url: s.url, publishedAt: s.publishedAt, availableAt: s.availableAt, textSha256: sha(s.text) })) }));

/** Pure: every current target is selected (dated, in window, canonical status URL), left unchanged (dated outside the window) or blocking. */
function plan(read: SocialInput, token: TokenRef, frozenAt: string): Plan {
  if(!timestamp.safeParse(frozenAt).success||[read.end,...read.sources.map(s=>s.availableAt)].some(at=>ms(at)>ms(frozenAt)))fail('CALLER_BODY_CLOCK');
  const codes: string[] = [], byId = new Map(read.sources.map(s => [s.id, s])), posts: Array<{ seedSourceId: string; url: string }> = [];
  for (const id of read.targetPostIds) {
    const source = byId.get(id);
    if (!source) fail('CALLER_BODY_READ_INVALID');
    if (source.publishedAt === null) { codes.push(`CALLER_BODY_TARGET_UNDATED:${id}`); continue; }
    if (ms(source.publishedAt) < ms(read.start) || ms(source.publishedAt) >= ms(read.end)) continue;
    if (id.length > 120 || !STATUS.test(source.url) || canonicalSocialUrl(source.url) !== source.url) { codes.push(`CALLER_BODY_TARGET_UNSUPPORTED:${id}`); continue; }
    posts.push({ seedSourceId: id, url: source.url });
  }
  const urls = posts.map(p => p.url), unique = posts.filter(p => urls.indexOf(p.url) === urls.lastIndexOf(p.url));
  for (const p of posts) if (!unique.includes(p)) codes.push(`CALLER_BODY_TARGET_DUPLICATE:${p.seedSourceId}`);
  if (!unique.length) return { codes, selection: null };
  if (unique.length > POSTS_MAX) return { codes: [...codes, 'CALLER_BODY_TARGET_LIMIT'], selection: null };
  const selection = callerHistorySelectionSchema.safeParse({ schemaVersion: 1, token, period: { start: read.start, end: read.end }, frozenAt,
    sourceScopeHash: scopeHash(read), queries: read.queries, posts: unique });
  if (!selection.success || !(ms(read.start) < ms(read.end)) || ms(read.end) > ms(frozenAt)) return { codes: [...codes, 'CALLER_BODY_SELECTION_INVALID'], selection: null };
  return { codes, selection: selection.data };
}

/** Compound text plus the code-owned line pair whose catalog slice is exactly the Fx body, trailing line breaks included. A body ending in a
 *  break leaves an empty catalog line at bodyEnd that the separator ends; a trailing lone CR takes a CRLF separator so the two cannot merge. */
function compose(original: SocialSource, fx: SocialSource, layer: CallerSourceLayer, token: TokenRef): { source: SocialSource; range: CallerBodyRange } | null {
  const body = fx.text;
  const head = `[[PROVIDER_TRUST ${JSON.stringify({ method: CALLER_BODY_METHOD, statusId: layer.statusId, body: 'fxtwitter tweet.text', trust: 'THIRD_PARTY_PROVIDER_REPORTED', completeness: layer.completeness,
    mintLocation: layer.mintLocation, edit: layer.edit?.state ?? null, officialCorroborates: 'id, author handle, creation second, current revision, visible prefix only', bodyUtf16: body.length })}]]`;
  const tail = `[[ORIGINAL_RENDERED_PAGE ${JSON.stringify({ provider: 'tinyfish', role: 'unchanged original source text; context only, not the post body', url: original.url,
    authorId: original.authorId, publishedAt: original.publishedAt, availableAt: original.availableAt, textUtf16: original.text.length })}]]`;
  if (/[\r\n]/.test(head + tail) || socialNamesAddress(head, token)) return null;
  const separator = body.endsWith('\r') ? '\r\n' : '\n';
  const text = `${head}\n${body}${separator}${tail}\n${original.text}`;
  const bodyStart = head.length + 1, bodyEnd = bodyStart + body.length, lines = executorSocialBodyCatalogLines(text);
  const first = lines.findIndex(l => l.start === bodyStart), last = lines.findIndex(l => l.end === bodyEnd);
  if (first < 0 || last < first || text.slice(lines[first]!.start, lines[last]!.end) !== body) return null;
  return {
    source: { ...original, url: fx.url, text, publishedAt: fx.publishedAt, authorId: fx.authorId, availableAt: fx.availableAt, kind: 'POST' },
    range: { sourceId: original.id, statusId: layer.statusId, bodyStart, bodyEnd, firstLineId: `${original.id}:line:${first}`, lastLineId: `${original.id}:line:${last}`,
      bodySha256: sha(body), bodyUtf16: body.length, literalContract: socialNamesAddress(body, token), completeness: layer.completeness, mintLocation: layer.mintLocation },
  };
}

/** Pure assembly shared by capture self-replay and replay. A source that cannot be composed exactly stays original and blocks coverage. */
function assemble(read: SocialInput, token: TokenRef, p: Plan, history: CallerHistory | null, collectCode: string | null) {
  const codes = [...p.codes, ...(collectCode ? [collectCode] : [])], quoteMax = read.entryDecisionMethod ? BODY_MAX : SHORT_QUOTE_MAX;
  const layers = new Map((history?.layers ?? []).map(l => [l.seedSourceId, l])), decoded = new Map((history?.socialInput.sources ?? []).map(s => [s.id, s]));
  const built = new Map<string, { source: SocialSource; range: CallerBodyRange }>();
  for (const post of p.selection?.posts ?? []) {
    const id = post.seedSourceId, layer = layers.get(id), fx = layer && decoded.get(layer.sourceId), original = read.sources.find(s => s.id === id)!;
    if (!layer || !layer.bodyComplete || !fx || fx.url !== post.url) { codes.push(`${layer?.failure ?? 'CALLER_BODY_TRIPLET_UNAVAILABLE'}:${id}`); continue; }
    if (!wellFormed(fx.text) || fx.text.length < QUOTE_MIN || fx.text.length > quoteMax) { codes.push(`CALLER_BODY_UNSELECTABLE:${id}`); continue; }
    const compound = compose(original, fx, layer, token);
    if (!compound) { codes.push(`CALLER_BODY_RANGE_UNRESOLVED:${id}`); continue; }
    built.set(id, compound);
  }
  let sources = read.sources.map(s => built.get(s.id)?.source ?? s);
  // The corpus cap is unchanged: an over-cap expansion keeps every original rather than truncating any body or page.
  if (sources.reduce((n, s) => n + s.text.length, 0) > CORPUS_MAX) { codes.push('CALLER_BODY_CORPUS_CAP'); built.clear(); sources = read.sources; }
  const next = socialInputSchema.parse({ ...read, sources, sampleComplete: read.sampleComplete && codes.length === 0, codes: [...codes, ...read.codes] });
  return { read: next, ranges: new Map([...built].map(([id, b]) => [id, b.range])) as ReadonlyMap<string, CallerBodyRange>, codes };
}

const serialize = (token: TokenRef, original: SocialInput, startedAt: string, finishedAt: string, selection: CallerHistorySelection | null, rawArtifacts: Record<string, string> | null, code: string | null) =>
  JSON.stringify({ method: CALLER_BODY_METHOD, token, original, startedAt, finishedAt, selection, rawArtifacts, code });

/** One collection attempt, finished before any model call; raw receipts are retained exactly and the capture is self-replayed. */
async function captureCallerBodies(input: SocialInput, tokenInput: TokenRef, options: { now: () => string; fetcher?: typeof fetch; signal?: AbortSignal }): Promise<{ capture: string; bodyCaptureId: string }> {
  const token = tokenRefSchema.parse(tokenInput), original = originalOf(input), startedAt = options.now(), p = plan(original, token, startedAt);
  let rawArtifacts: Record<string, string> | null = null, code: string | null = null;
  if (p.selection) {
    try { rawArtifacts = (await collectCallerHistory(p.selection, options.fetcher ?? fetch, options.now, options.signal)).rawArtifacts; }
    catch { code = 'CALLER_BODY_COLLECT_FAILED'; }
  }
  const capture = serialize(token, original, startedAt, options.now(), p.selection, rawArtifacts, code);
  return { capture, bodyCaptureId: replayCallerBodies(capture, token).bodyCaptureId };
}

/** Offline: recomputes selection, decode, compound read and body ranges from the exact capture; structural problems throw. */
function replayCallerBodies(capture: string, tokenInput: TokenRef): { read: SocialInput; bodyBySourceId: ReadonlyMap<string, CallerBodyRange>; codes: string[]; layers: CallerSourceLayer[]; selectionHash: string | null; startedAt: string; finishedAt: string; bodyCaptureId: string } {
  const token = tokenRefSchema.parse(tokenInput);
  if(typeof capture!=='string'||Buffer.byteLength(capture,'utf8')>EXECUTOR_SOCIAL_BODIES_LIMIT||!wellFormed(capture))fail('CALLER_BODY_CAPTURE_LIMIT');
  let raw: unknown;
  try { raw = JSON.parse(capture); } catch { fail('CALLER_BODY_CAPTURE_INVALID'); }
  const parsed = captureSchema.safeParse(raw);
  if (!parsed.success) fail('CALLER_BODY_CAPTURE_INVALID');
  const c = parsed.data, original = originalOf(c.original);
  if (JSON.stringify(c.token) !== JSON.stringify(token)) fail('CALLER_BODY_TOKEN_MISMATCH');
  if (ms(c.finishedAt) < ms(c.startedAt)) fail('CALLER_BODY_CLOCK');
  const p = plan(original, token, c.startedAt);
  if (JSON.stringify(p.selection) !== JSON.stringify(c.selection)) fail('CALLER_BODY_SELECTION_BINDING');
  if (p.selection ? (c.rawArtifacts === null) === (c.code === null) : c.rawArtifacts !== null || c.code !== null) fail('CALLER_BODY_CAPTURE_INVALID');
  const history = p.selection && c.rawArtifacts ? decodeCallerHistory(p.selection, c.rawArtifacts) : null;
  if (history && ms(history.analysisCutoff) > ms(c.finishedAt)) fail('CALLER_BODY_CLOCK');
  if (serialize(token, original, c.startedAt, c.finishedAt, p.selection, c.rawArtifacts, c.code) !== capture) fail('CALLER_BODY_CAPTURE_NONCANONICAL');
  const { read, ranges, codes } = assemble(original, token, p, history, c.code);
  return { read, bodyBySourceId: ranges, codes, layers: history?.layers ?? [], selectionHash: history?.selectionHash ?? null, startedAt: c.startedAt, finishedAt: c.finishedAt, bodyCaptureId: sha(capture) };
}

/** Public root wiring: one complete current-target collection, then deterministic offline reconstruction. */
export async function collectExecutorSocialBodies(originalRead:SocialInput,token:TokenRef,fetcher:typeof fetch=fetch,now:()=>string=()=>new Date().toISOString(),signal?:AbortSignal){
  const result=await captureCallerBodies(originalRead,token,{fetcher,now,signal});
  const decoded=decodeExecutorSocialBodies(result.capture,token,now());
  return {capture:result.capture,read:decoded.read,bodyBySourceId:decoded.bodyBySourceId};
}
export function decodeExecutorSocialBodies(capture:string,token:TokenRef,cutoff:string){
  if(!timestamp.safeParse(cutoff).success)fail('CALLER_BODY_CUTOFF_INVALID');
  const decoded=replayCallerBodies(capture,token),raw=JSON.parse(capture),originalRead=originalOf(raw.original);
  if(ms(decoded.finishedAt)>ms(cutoff))fail('CALLER_BODY_AFTER_CUTOFF');
  const bodyBySourceId=Object.fromEntries([...decoded.bodyBySourceId].map(([id,r])=>[id,decoded.read.sources.find(s=>s.id===id)!.text.slice(r.bodyStart,r.bodyEnd)]));
  const sourceBindings=originalRead.targetPostIds.map(id=>{const range=decoded.bodyBySourceId.get(id),layer=decoded.layers.find(l=>l.seedSourceId===id)??null;
    return {sourceId:id,original:originalRead.sources.find(s=>s.id===id)!,range:range??null,layer,trust:CALLER_BODY_TRUST,code:decoded.codes.find(code=>code.endsWith(':'+id))??null};});
  return {originalRead,read:decoded.read,bodyBySourceId,sourceBindings,availableAt:decoded.finishedAt};
}
/** v2 executor guard derives exact full-body selectors from the already source-bound compound read. */
export function executorSocialBodyRanges(read:SocialInput,bodyBySourceId:Record<string,string>,token:TokenRef):ReadonlyMap<string,CallerBodyRange>{
  const result=new Map<string,CallerBodyRange>();
  for(const [id,body]of Object.entries(bodyBySourceId)){
    const source=read.sources.find(s=>s.id===id);if(!source||source.kind!=='POST'||!read.targetPostIds.includes(id)||typeof body!=='string'||!wellFormed(body)||body.length<8||!source.text.startsWith('[[PROVIDER_TRUST '))fail('CALLER_BODY_MAPPING');
    const start=source.text.indexOf('\n')+1,end=start+body.length,lines=executorSocialBodyCatalogLines(source.text),first=lines.findIndex(l=>l.start===start),last=lines.findIndex(l=>l.end===end);
    if(start<=0||source.text.slice(start,end)!==body||first<0||last<first)fail('CALLER_BODY_MAPPING');
    result.set(id,{sourceId:id,statusId:source.url.split('/').at(-1)!,bodyStart:start,bodyEnd:end,firstLineId:`${id}:line:${first}`,lastLineId:`${id}:line:${last}`,bodySha256:sha(body),bodyUtf16:body.length,literalContract:socialNamesAddress(body,token),completeness:null,mintLocation:null});
  }
  return result;
}
