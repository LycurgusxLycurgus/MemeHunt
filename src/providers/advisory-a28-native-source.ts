import assert from 'node:assert/strict';
// Reconstruct this fixed A28 original-source study from in-memory UTF8 preimages.
// JSON edges are runtime-validated; no retained completeness/classification cache is source authority.
// Public decoder stays unchanged: only nonterminal prefix is passed to it.
import { createHash } from 'node:crypto';
import { reconstructXStream, uiWitness, boundText, containsMint, type XPage, type BoundText, type XStream, type UiWitness } from './advisory-saturation.js';
// Audited helper implementation consumes q.query only. No fake A24 windows or scope.
const reconstructQuery = reconstructXStream as (pages:XPage[], observations:BoundText[], q:{query:string}, mint:string)=>XStream;
const queryWitness = uiWitness as (raw:string,q:{query:string})=>UiWitness|null;
export const LIMITS = { portableBytes: 4194304, roles: 64, perBodyBytes: 500000 } as const;
export const CODE_PINS = { publicNativeHelperSourceSha256: '8ec981fbe7f35aa11a59dcf77a03f1e2fc5efe216c78410e3aa3dda4ab4cc7ab', ownUrlProjectorSha256: '743746f0f922c25d2a89b7c945d33e8670c9208a46fbad126241e2d0011d9c56' } as const;
const sha = (x: any): any => createHash('sha256').update(x).digest('hex');
function need(x: unknown, c: string): asserts x { if (!x) throw Error('A28_SOURCE_' + c); }
const object = (x: any): any => x !== null && typeof x === 'object' && !Array.isArray(x);
const same = (a: any, b: any): any => JSON.stringify(a) === JSON.stringify(b);
const time = (x: any): any => typeof x === 'string' && Number.isFinite(Date.parse(x));
const safe = (x: any): any => Number.isSafeInteger(x) && x >= 0;
const exact = (x: any, keys: any, c: any): any => need(object(x) && Object.keys(x).sort().join() === keys.slice().sort().join(), c);
const instructions = (raw: any): any => JSON.parse(raw)?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
const withoutCursor = (v: any): any => Object.fromEntries(Object.entries(v).filter(([k]: any): any => k !== 'cursor'));
const OPTIONAL: any = ['observation-notes', 'qualification-contract', 'root-qualification-context', 'catalyst-dispositions', 'model-profile', 'parent-context-receipts', 'parent-context-syndication', 'parent-context-fxtwitter', 'omission-context-catalog', 'omission-native-manifest', 'omission-fx-receipt'];
function request(url: any): any {
    let u;
    try {
        u = new URL(url);
    }
    catch { }
    need(u && u.protocol === 'https:' && u.host === 'x.com' && !u.username && !u.password && !u.hash && /^\/i\/api\/graphql\/[A-Za-z0-9_-]{8,64}\/SearchTimeline$/.test(u.pathname) && [...u.searchParams.keys()].join() === 'variables,features', 'REQUEST_URL');
    const variables = JSON.parse(u.searchParams.get('variables')!), features = JSON.parse(u.searchParams.get('features')!);
    need(object(variables) && object(features) && Object.values(features).every((x: any): any => typeof x === 'boolean'), 'REQUEST_SHAPE');
    need(Object.keys(variables).every((k: any): any => ['rawQuery', 'count', 'querySource', 'product', 'cursor', 'withGrokTranslatedBio', 'withQuickPromoteEligibilityTweetFields'].includes(k)), 'VARIABLE_KEYS');
    for (const k of ['withGrokTranslatedBio', 'withQuickPromoteEligibilityTweetFields'])
        if (k in variables)
            need(typeof variables[k] === 'boolean', 'VARIABLE_BOOLEAN');
    return { operation: u.pathname.split('/')[4], variables, features };
}
function readPages(manifest: any, records: any, prefix: any, query: any, packageAt: any, frozenAt: any): any {
    need(Array.isArray(manifest.entries) && manifest.entries.length > 0 && manifest.entries.length <= 20, 'PAGE_CATALOG');
    const pages = manifest.entries.map((e: any, i: any): any => {
        need(e.file === 'page-' + String(i).padStart(2, '0') + '.json' && e.method === 'GET' && e.httpStatus === 200, 'PAGE_DESCRIPTOR');
        const body = records.get(prefix + String(i).padStart(2, '0'));
        need(body && body.bytes === e.bytes && body.sha256 === e.sha256, 'PAGE_ORIGINAL_PIN');
        const q = request(e.url);
        need(same(q.variables, e.variables) && q.variables.rawQuery === query && q.variables.product === 'Latest' && q.variables.count === 20 && q.variables.querySource === 'typed_query', 'PAGE_REQUEST_SCOPE');
        need(time(e.startedAt) && Date.parse(e.startedAt) >= frozenAt && Date.parse(e.startedAt) <= packageAt && Number.isFinite(e.durationMs) && e.durationMs >= 0 && e.durationMs <= 900000 && Date.parse(e.startedAt) + e.durationMs <= packageAt, 'PAGE_CLOCK');
        if (e.responseHeaders !== undefined)
            need(Array.isArray(e.responseHeaders) && e.responseHeaders.every((h: any): any => object(h) && ['content-encoding', 'content-length', 'content-type', 'date'].includes(h.name) && typeof h.value === 'string' && h.value.length <= 512), 'CONTEXT_SAFE_RESPONSE_METADATA_ONLY');
        return { method: e.method, url: e.url, httpStatus: e.httpStatus, startedAt: e.startedAt, durationMs: e.durationMs, body };
    });
    const owned = [...records.keys()].filter((k: any): any => k.startsWith(prefix));
    need(owned.length === pages.length, 'ORPHAN_PAGE_ROLE');
    need(pages.reduce((n: any, p: any): any => n + p.body.bytes, 0) === manifest.responseBytesTotal, 'PAGE_TOTAL_BYTES');
    need(time(manifest.capturedAt) && Date.parse(manifest.capturedAt) <= packageAt && Date.parse(manifest.capturedAt) >= Math.max(...pages.map((p: any): any => Date.parse(p.startedAt) + p.durationMs)), 'MANIFEST_PACKAGING_CLOCK');
    return pages;
}
function cursorRows(raw: any): any { const is = instructions(raw); need(Array.isArray(is), 'TIMELINE'); const out: any = []; for (const i of is) {
    if (i.type === 'TimelineAddEntries') {
        need(Array.isArray(i.entries), 'ENTRIES');
        out.push(...i.entries);
    }
    else if (i.type === 'TimelineReplaceEntry')
        out.push(i.entry);
} return out.filter((e: any): any => e?.content?.__typename === 'TimelineTimelineCursor'); }
function terminalExtension(pages: any, observations: any, query: any, mint: any): any {
    need(pages.length >= 2, 'BOTTOM_CONTINUATION_REQUIRED');
    const prefix = pages.slice(0, -1);
    const partial = reconstructQuery(prefix, [], { query }, mint);
    need(partial.status === 'INCOMPLETE' && partial.reasonCode === 'X_STREAM_END_NOT_OBSERVED', 'PREFIX_MUST_BE_NONTERMINAL');
    const k = pages.length - 1, p = pages[k], raw = p.body.raw, v = JSON.parse(raw), is = instructions(raw);
    need(object(v) && Object.keys(v).join() === 'data' && Array.isArray(is) && is.length === 3, 'FINAL_ORIGINAL_SHAPE');
    exact(is[2], ['type', 'direction'], 'TERMINATION_KEYS');
    need(is.slice(0, 2).every((i: any): any => i.type === 'TimelineReplaceEntry') && is[2].type === 'TimelineTerminateTimeline' && is[2].direction === 'Bottom', 'EXACT_BOTTOM_TERMINATION');
    const prior = cursorRows(prefix.at(-1).body.raw), seen = new Set(prefix.flatMap((p: any): any => cursorRows(p.body.raw).filter((x: any): any => x.content.cursorType === 'Bottom').map((x: any): any => x.content.value)));
    need(prior.length === 2 && new Set(prior.map((e: any): any => e.content.cursorType)).size === 2, 'ADJACENT_CURSOR_ROWS');
    const rows: any = {};
    for (const i of is.slice(0, 2)) {
        exact(i, ['type', 'entry_id_to_replace', 'entry'], 'REPLACEMENT_KEYS');
        const e = i.entry, c = e?.content;
        need(c?.__typename === 'TimelineTimelineCursor' && ['Top', 'Bottom'].includes(c.cursorType) && typeof c.value === 'string' && c.value.length > 0 && typeof e.entryId === 'string' && e.entryId === i.entry_id_to_replace && !rows[c.cursorType], 'FINAL_CURSOR');
        need(prior.some((x: any): any => x.content.cursorType === c.cursorType && x.entryId === e.entryId), 'FINAL_ADJACENT_ROW_TARGET');
        rows[c.cursorType] = c;
    }
    need(rows.Top && rows.Bottom && !seen.has(rows.Bottom.value), 'FINAL_CURSOR_LOOP');
    const first = request(prefix[0].url), last = request(p.url), previous = request(prefix.at(-1).url), bottom = prior.find((x: any): any => x.content.cursorType === 'Bottom').content.value;
    need(last.operation === first.operation && same(last.features, first.features) && same(withoutCursor(last.variables), withoutCursor(first.variables)) && last.variables.cursor === bottom, 'FINAL_REQUEST_CHAIN');
    need(Date.parse(p.startedAt) >= Date.parse(prefix.at(-1).startedAt), 'FINAL_REQUEST_ORDER');
    const lastEnd = Math.max(...pages.map((x: any): any => Date.parse(x.startedAt) + x.durationMs)), lastResponseAt = new Date(lastEnd).toISOString();
    const witnesses = observations.map((o: any): any => queryWitness(boundText(o, 'A28_UI_ORIGINAL_HASH'), { query })).filter((w: any): any => w && Date.parse(w.observedAt) >= lastEnd && !w.loadingOrError && w.requestCountBefore === pages.length && w.requestCountAfter === pages.length);
    return { status: witnesses.length ? 'COMPLETE' : 'INCOMPLETE', reasonCode: witnesses.length ? null : 'A28_CLIENT_SETTLED_END_NOT_OBSERVED', endRule: witnesses.length ? 'OBSERVED_X_CLIENT_STREAM_EXHAUSTED_V1' : null, operation: first.operation, startedAt: pages[0].startedAt, lastResponseAt, pages: pages.length, posts: partial.posts, witness: witnesses[0] ?? null, terminalProof: { version: 'A28_EXACT_FINAL_BOTTOM_TERMINATE_EXTENSION_V1', originalTerminalPage: k, originalTerminalBodySha256: p.body.sha256, originalBodyNeverStrippedOrRewritten: true, prefixPublicStatus: partial.status, prefixPublicReason: partial.reasonCode } };
}
export function rederiveA28Source(raw: any, { now = Date.now() }: any = {}): any {
    need(typeof raw === 'string' && Buffer.byteLength(raw) <= LIMITS.portableBytes, 'PORTABLE_SIZE');
    const packet = JSON.parse(raw);
    exact(packet, ['kind', 'method', 'namespace', 'sourceId', 'purpose', 'packagedAt', 'token', 'codePins', 'records'], 'PORTABLE_KEYS');
    need(packet.kind === 'A28_PORTABLE_ORIGINAL_NATIVE_SOURCE_V1' && packet.method === 'a28-native-interval-decay-source-v1' && packet.namespace === 'advisory-a28-decay' && packet.sourceId === 'advisory-a28-decay-capture' && packet.purpose === 'HISTORICAL_MODEL_CONDITIONAL_PROVIDED_ATTENTION_DECAY', 'NEW_PURPOSE_OWNERSHIP');
    need(time(packet.packagedAt) && Date.parse(packet.packagedAt) <= now, 'PACKAGE_CLOCK');
    const packaged = Date.parse(packet.packagedAt);
    exact(packet.token, ['chain', 'address'], 'TOKEN_KEYS');
    need(packet.token.chain === 'solana' && typeof packet.token.address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(packet.token.address), 'TOKEN');
    need(same(packet.codePins, CODE_PINS), 'EXPLICIT_CODE_VERSION');
    need(Array.isArray(packet.records) && packet.records.length > 0 && packet.records.length <= LIMITS.roles, 'ROLE_LIMIT');
    const records = new Map();
    for (const r of packet.records) {
        exact(r, ['role', 'body'], 'RECORD_KEYS');
        need(typeof r.role === 'string' && !records.has(r.role) && (['original-scope', 'original-manifest', 'client-end-witness', ...OPTIONAL].includes(r.role) || /^(native-page|omission-native-page)-[0-9]{2}$/.test(r.role)), 'ROLE_CATALOG');
        exact(r.body, ['raw', 'bytes', 'sha256'], 'BODY_KEYS');
        need(typeof r.body.raw === 'string' && safe(r.body.bytes) && r.body.bytes <= LIMITS.perBodyBytes && /^[a-f0-9]{64}$/.test(r.body.sha256), 'BODY_BOUND');
        boundText(r.body, 'A28_ORIGINAL_BODY_HASH');
        records.set(r.role, r.body);
    }
    const get = (role: any): any => { const b = records.get(role); need(b, 'REQUIRED_ROLE_' + role); return JSON.parse(b.raw); };
    const scope = get('original-scope'), manifest = get('original-manifest'), observation = get('client-end-witness'), mint = packet.token.address;
    need(scope.kind === 'A28_NATIVE_X_CAPTURE_SCOPE_V1' && scope.purpose === 'FIXED_HISTORICAL_QUALIFIED_ATTENTION_AND_CATALYST_SOURCE' && same(scope.token, packet.token) && scope.product === 'Latest' && scope.count === 20 && scope.querySource === 'typed_query', 'ORIGINAL_SCOPE');
    need(time(scope.frozenAt) && scope.window?.convention === 'HALF_OPEN' && time(scope.window.start) && time(scope.window.end) && Date.parse(scope.window.end) > Date.parse(scope.window.start), 'SCOPE_CLOCK_WINDOW');
    need((scope.queryMintStyle ?? 'QUOTED_LITERAL') === 'QUOTED_LITERAL' && scope.query === JSON.stringify(mint) + ' since_time:' + Math.floor(Date.parse(scope.window.start) / 1000) + ' until_time:' + Math.floor(Date.parse(scope.window.end) / 1000), 'EXACT_QUOTED_QUERY');
    need(same(scope.limits, { timelinePages: 20, detailPages: 40, captureWallSeconds: 900, retainedBytes: 8388608, perResponseBytes: 500000, cursorRetries: 1 }), 'ORIGINAL_LIMITS');
    need(manifest.kind === 'A28_PRIVATE_NATIVE_SEARCH_TIMELINE_RESPONSES_V1' && manifest.frozenScopeSha256 === records.get('original-scope').sha256 && manifest.query === scope.query && manifest.allHeadersCookiesAndUnselectedTrafficExcluded === true, 'ORIGINAL_MANIFEST_SCOPE');
    const pages = readPages(manifest, records, 'native-page-', scope.query, packaged, Date.parse(scope.frozenAt));
    need(observation.kind === 'NATIVE_CHROME_CLIENT_END_OBSERVATION_V1' && observation.query === scope.query && ['Latest', 'Neueste'].includes(observation.selected) && time(observation.observedAt) && Date.parse(observation.observedAt) <= packaged, 'ORIGINAL_UI_ROLE_CLOCK');
    const stream = terminalExtension(pages, [records.get('client-end-witness')], scope.query, mint);
    need(Date.parse(observation.observedAt) >= Math.max(...pages.map((p: any): any => Date.parse(p.startedAt) + p.durationMs)) && Date.parse(observation.observedAt) - Date.parse(pages[0].startedAt) <= 900000, 'ORIGINAL_CAPTURE_WALL');
    const urls = projectOwnUrlContexts(pages, stream.posts), posts = stream.posts.map((p: any, i: any): any => ({ ...p, ownUrlEntities: urls[i], sourceUrl: `https://x.com/${p.handle}/status/${p.postId}`, withinFrozenInterval: Date.parse(p.createdAt) >= Date.parse(scope.window.start) && Date.parse(p.createdAt) < Date.parse(scope.window.end) }));
    need(posts.every((p: any): any => p.withinFrozenInterval), 'PRIMARY_INTERVAL');
    const primaryIds = new Set(posts.map((p: any): any => p.postId));
    const contextOnly: any = [];
    // Retained HolDEX parent is separately clocked CONTEXT_ONLY, never primary/commentary borrowed by child.
    const parentRoles: any = ['parent-context-receipts', 'parent-context-syndication', 'parent-context-fxtwitter'];
    if (parentRoles.some((r: any): any => records.has(r))) {
        need(parentRoles.every((r: any): any => records.has(r)), 'PARENT_CONTEXT_ROLE_CLOSURE');
        const receipts = get(parentRoles[0]), synd = get(parentRoles[1]), fx = get(parentRoles[2]);
        need(Array.isArray(receipts), 'PARENT_RECEIPTS');
        for (const r of receipts) {
            const role = r.file === 'syndication.body' ? parentRoles[1] : r.file === 'fxtwitter.body' ? parentRoles[2] : null;
            need(role && r.httpStatus === 200 && r.bytes === records.get(role).bytes && r.sha256 === records.get(role).sha256 && time(r.startedAt) && time(r.receivedAt) && Date.parse(r.receivedAt) >= Date.parse(r.startedAt) && Date.parse(r.receivedAt) <= packaged, 'PARENT_ORIGINAL_RECEIPT');
        }
        need(receipts.length === 2 && new Set(receipts.map((r: any): any => r.file)).size === 2 && fx.tweet?.id === synd.id_str, 'PARENT_RECEIPT_CENSUS');
        const child = posts.find((p: any): any => p.postId === synd.id_str), parent = synd.parent;
        need(child && parent && synd.in_reply_to_status_id_str === parent.id_str && typeof parent.text === 'string', 'PARENT_NATIVE_IDENTITY');
        const original = JSON.parse(pages[child.page].body.raw).data.search_by_raw_query.search_timeline.timeline.instructions[0].entries[child.entry].content.itemContent.tweet_results.result;
        need(original.legacy.in_reply_to_status_id_str === parent.id_str && !primaryIds.has(parent.id_str), 'PARENT_NATIVE_REPLY_BINDING');
        contextOnly.push({ role: 'PARENT_CONTEXT_ONLY_NOT_PRIMARY', postId: parent.id_str, referencingPrimaryId: child.postId, authorId: parent.user.id_str, handle: parent.user.screen_name, createdAt: new Date(parent.created_at).toISOString(), body: parent.text, bodySha256: sha(parent.text), sourceRole: parentRoles[1], sourceSha256: records.get(parentRoles[1]).sha256, sourceJsonPath: '$.parent', availableAt: receipts.find((r: any): any => r.file === 'syndication.body').receivedAt, originalCommentaryBorrowed: false });
    }
    // Old omitted witnesses keep their different original query/receipt identities and never join posts.
    const omitRoles: any = ['omission-context-catalog', 'omission-native-manifest', 'omission-fx-receipt'];
    if ([...records.keys()].some((r: any): any => r.startsWith('omission-'))) {
        need(omitRoles.every((r: any): any => records.has(r)), 'OMISSION_CONTEXT_CLOSURE');
        const catalog = get(omitRoles[0]), m = get(omitRoles[1]), oldPages = readPages(m, records, 'omission-native-page-', m.query, packaged, 0);
        need(catalog.newQuery === scope.query && catalog.oldNativeQuery === m.query && Array.isArray(catalog.witnesses), 'OMISSION_QUERY_ROLES');
        const old = reconstructQuery(oldPages, [], { query: m.query }, mint);
        need(old.status === 'INCOMPLETE' && old.reasonCode === 'X_CLIENT_SETTLED_END_NOT_OBSERVED', 'OLD_CONTEXT_NOT_SOURCE_CLOSURE');
        const native = new Map<string, any>(old.posts.map((p: any): any => [p.postId, p]));
        const fx = get(omitRoles[2]);
        need(fx.provider === 'fxtwitter' && fx.status === 200 && time(fx.retrievedAt) && Date.parse(fx.retrievedAt) <= packaged && typeof fx.body === 'string', 'OMISSION_FX_RECEIPT');
        const ft = JSON.parse(fx.body).tweet;
        need(ft && typeof ft.id === 'string' && typeof ft.text === 'string' && safe(ft.created_timestamp), 'OMISSION_FX_BODY');
        const seen = new Set();
        for (const w of catalog.witnesses) {
            need(!seen.has(w.statusId) && !primaryIds.has(w.statusId), 'OMISSION_NONPRIMARY_IDENTITY');
            seen.add(w.statusId);
            const p = native.get(w.statusId);
            let row: any;
            if (p) {
                need(p.bodySha256 === w.oldPrimaryBodySha256, 'OMISSION_NATIVE_BODY');
                row = { ...p, sourceRole: 'omission-native-page-' + String(p.page).padStart(2, '0'), sourceSha256: oldPages[p.page].body.sha256, availableAt: new Date(Date.parse(oldPages[p.page].startedAt) + oldPages[p.page].durationMs).toISOString(), sourceQuery: m.query };
            }
            else {
                need(ft.id === w.statusId && sha(ft.text) === w.oldPrimaryBodySha256 && ft.author?.id && typeof ft.author.screen_name === 'string', 'OMISSION_FX_BINDING');
                row = { postId: ft.id, authorId: ft.author.id, handle: ft.author.screen_name, createdAt: new Date(ft.created_timestamp * 1000).toISOString(), body: ft.text, bodySha256: sha(ft.text), bodySource: 'ORIGINAL_RECORDED_FX_PUBLIC_FULL_TEXT', revision: 'UNVERIFIED', sourceRole: omitRoles[2], sourceSha256: records.get(omitRoles[2]).sha256, availableAt: fx.retrievedAt, sourceQuery: null };
            }
            need(row.handle.toLowerCase() === w.handle.toLowerCase() && Date.parse(row.createdAt) === Date.parse(w.publishedAt), 'OMISSION_CONTEXT_ID_CLOCK');
            contextOnly.push({ ...row, role: 'OLD_OMISSION_CONTEXT_ONLY_NOT_PRIMARY' });
        }
    }
    const qRoles: any = ['qualification-contract', 'root-qualification-context'];
    let qualificationContext: any = null;
    if (qRoles.some((r: any): any => records.has(r))) {
        need(qRoles.every((r: any): any => records.has(r)), 'QUALIFICATION_CONTEXT_CLOSURE');
        const qc = get(qRoles[0]), qualified = get(qRoles[1]);
        need(qualified.contractSha256 === records.get(qRoles[0]).sha256 && time(qc.frozenAt) && time(qualified.adoptedAt) && Date.parse(qualified.adoptedAt) >= Date.parse(qc.frozenAt) && Date.parse(qualified.adoptedAt) <= packaged && Array.isArray(qualified.rows), 'QUALIFICATION_CONTEXT_CLOCK_HASH');
        const bodyMap = new Map<string, string>(posts.map((p: any): any => [p.bodySha256, p.body])), used = new Set();
        for (const r of qualified.rows) {
            const p = posts.find((p: any): any => p.postId === r.postId);
            need(p && !used.has(r.postId) && r.source.postId === p.postId && r.source.authorId === p.authorId && r.source.bodySha256 === p.bodySha256 && r.source.publicationAt === p.createdAt && r.source.page === p.page && r.source.entry === p.entry && r.source.nativePageSha256 === pages[p.page].body.sha256, 'QUALIFICATION_PRIMARY_BINDING');
            used.add(r.postId);
        }
        need(used.size === primaryIds.size, 'QUALIFICATION_FULL_PRIMARY_CENSUS');
        for(const r of qualified.rows){
            const p=posts.find((p:any)=>p.postId===r.postId)!;
            const ownLinks=p.ownUrlEntities.filter((e:any)=>e.shortUrlInSelectedOwnBody&&containsMint(e.entity.expanded_url,mint));
            need(r.binding.literalOwnMint===p.bodyBindsMint&&r.binding.exactSelectedOwnUrlMint===(ownLinks.length>0)&&same(r.binding.ownUrlEvidence,ownLinks),'QUALIFICATION_BINDING_SOURCE');
            need(['ELIGIBLE','EXCLUDED'].includes(r.rootDecision)&&r.rootDecision===r.eligibility.value,'ROOT_ADJUDICATION_DECISION');
            const normalized=p.body.normalize('NFC').replace(/\s+/gu,' ').trim(),digest=sha(normalized);
            const group=posts.filter((x:any)=>sha(x.body.normalize('NFC').replace(/\s+/gu,' ').trim())===digest).sort((a:any,b:any)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)||(BigInt(a.postId)<BigInt(b.postId)?-1:1)).map((x:any)=>x.postId);
            need(r.copy.normalizedOwnTextSha256===digest&&r.copy.groupId==='SELECTED_OWN_TEXT:'+digest&&same(r.copy.memberPostIds,group)&&r.copy.representativePostId===group[0],'QUALIFICATION_RECONSTRUCTED_GROUP');
        }
        need(same(qualified.sensitivityUniverseBeforeFit,[{id:'ROOT_PRIMARY',overrides:{}},{id:'FRANKIE_EXCLUDED_ALTERNATIVE',overrides:{'2114795091244015796':'EXCLUDED'}}]),'EXACT_FROZEN_SENSITIVITY');

        const citations = (x: any): any => { if (Array.isArray(x))
            return x.forEach(citations); if (!object(x))
            return; if (x.field === 'SELECTED_OWN_BODY') {
            const body = bodyMap.get(x.bodySha256);
            need(body && typeof x.text === 'string' && body.includes(x.text), 'QUALIFICATION_OWN_SOURCE_SPAN');
            if (x.startCodepoint !== undefined)
                need(Array.from(body).slice(x.startCodepoint, x.endCodepointExclusive).join('') === x.text, 'QUALIFICATION_SPAN_OFFSET');
            if (x.startUTF16 !== undefined)
                need(body.slice(x.startUTF16, x.endUTF16Exclusive) === x.text, 'QUALIFICATION_SPAN_UTF16');
        } for (const v of Object.values(x))
            citations(v); };
        citations(qualified.rows);
        qualificationContext = { role: 'ROOT_QUALIFICATION_CONTEXT_NOT_MODEL_OR_METRIC_AUTHORITY', sourceRole: qRoles[1], sha256: records.get(qRoles[1]).sha256, contractSha256: records.get(qRoles[0]).sha256, adoptedAt: qualified.adoptedAt, sourcePrimaryBindingsVerified: true, semanticDecisionsRecomputed: false, countsOrFitAdopted: false };
    }
    const profile = get('model-profile'), dispositions = get('catalyst-dispositions'), rootQualification = get('root-qualification-context');
    need(records.get('model-profile').sha256 === 'd08352c04405b80c41bf9c1b53d2f3c54571bceb8d87d8692cd707484894401c' && profile.purpose === packet.purpose && same(profile.subject, packet.token) && profile.qualificationSha256 === records.get('root-qualification-context').sha256 && profile.catalystDispositionsSha256 === records.get('catalyst-dispositions').sha256 && profile.adjudicationContractSha256 === records.get('qualification-contract').sha256, 'FROZEN_MODEL_PROFILE_BINDING');
    need(dispositions.qualificationSha256 === records.get('root-qualification-context').sha256 && time(dispositions.frozenAt) && time(profile.frozenAt) && Date.parse(dispositions.frozenAt) <= Date.parse(profile.frozenAt) && Date.parse(profile.frozenAt) <= packaged, 'STUDY_SOURCE_CLOCKS');
    need(Array.isArray(dispositions.items) && dispositions.items.length === posts.length && new Set(dispositions.items.map((x: any): any => x.postId)).size === posts.length, 'CATALYST_PRIMARY_CENSUS');
    for (const c of dispositions.items) {
        const p = posts.find((p: any): any => p.postId === c.postId), q = rootQualification.rows.find((x: any): any => x.postId === c.postId);
        need(p && c.at === p.createdAt && typeof c.barrierForAnyLaterFitStartingBeforeThisPublication === 'boolean' && c.sourceAssessment === q.catalyst.renewalAssessment, 'CATALYST_NATIVE_BINDING');
    }
    for (const c of dispositions.contextOnly ?? []) {
        const p = contextOnly.find((p: any): any => p.postId === c.id);
        need(p && c.at === p.createdAt && typeof c.barrierForAnyLaterFitStartingBeforeThisPublication === 'boolean', 'CATALYST_CONTEXT_BINDING');
    }
    const { posts: unused, ...streamWithoutPosts } = stream;
    return { kind: 'A28_RECONSTRUCTED_ORIGINAL_NATIVE_SOURCE_V1', method: packet.method, purpose: packet.purpose, knownClaim: false, qualification: 'CONTEXT_ONLY_NOT_REDERIVED', fit: 'NOT_RUN', availableAt: packet.packagedAt, sourceScope: { sha256: records.get('original-scope').sha256, queryMintStyle: 'QUOTED_LITERAL', query: scope.query, window: scope.window, frozenAt: scope.frozenAt, limits: scope.limits }, sourceCatalog: { records: packet.records.map((r: any): any => ({ role: r.role, bytes: r.body.bytes, sha256: r.body.sha256 })), originalManifestSha256: records.get('original-manifest').sha256, originalWitnessSha256: records.get('client-end-witness').sha256, originalSanitizedHarSha256ReferenceOnly: manifest.originalSanitizedHarSha256, ownUrlContextProjectionSha256: packet.codePins.ownUrlProjectorSha256, externalPathsDereferenced: false }, nativeReuse: { publicHelper: 'advisory-saturation::reconstructXStream', onlyQueryProjection: true, oldFrozenQueryNotCalled: true, A24MetricAuthority: false, privateDecoderCopy: false, originalTerminalBytesUnchanged: true }, stream: streamWithoutPosts, posts, contextOnly, qualificationContext, studyDocuments: { profile, qualification: rootQualification, catalystDispositions: dispositions }, sourceLimitations: ['Complete means only original delivered viewer-query stream with actual settled witness, not all-X recall.', 'Old omitted/parent contexts retain source roles and never join primary census.', 'No count/bin/grid/peak/model/fit or provider/author authentication derived.', 'Published source/header hashes are provenance under retained source premises; original HAR preimage is not packaged or independently certified.'] };
}
// Public source metadata only. No semantic eligibility, catalyst, count or fit authority.
const urlHash = (s: any): any => createHash('sha256').update(s).digest('hex');
const urlNeed = (v: any, code: any): any => assert(v, 'A28_OWN_URL_' + code);
function contexts(result: any, path: any): any {
    const selected = result.note_tweet === undefined ? result.legacy?.full_text : result.note_tweet?.note_tweet_results?.result?.text;
    const representations: any = [['LEGACY', result.legacy?.full_text, result.legacy?.entities?.urls, path + '/legacy/entities/urls'], ['NOTE', result.note_tweet?.note_tweet_results?.result?.text, result.note_tweet?.note_tweet_results?.result?.entity_set?.urls, path + '/note_tweet/note_tweet_results/result/entity_set/urls']];
    const urls: any = [];
    for (const [source, body, entities, jsonPath] of representations) {
        if (entities === undefined)
            continue;
        urlNeed(typeof body === 'string' && Array.isArray(entities), 'SHAPE');
        for (const [i, e] of entities.entries()) {
            urlNeed(e && typeof e === 'object' && typeof e.url === 'string' && typeof e.expanded_url === 'string' && (e.display_url === undefined || typeof e.display_url === 'string'), 'ENTITY');
            for (const value of [e.url, e.expanded_url]) {
                let u;
                try {
                    u = new URL(value);
                }
                catch { }
                urlNeed(u && ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password, 'URL');
            }
            urlNeed(Array.isArray(e.indices) && e.indices.length === 2 && e.indices.every(Number.isSafeInteger) && e.indices[0] >= 0 && e.indices[1] > e.indices[0], 'INDICES');
            const [a, b] = e.indices, codepoints = Array.from(body), cp = b <= codepoints.length && codepoints.slice(a, b).join('') === e.url, utf16 = b <= body.length && body.slice(a, b) === e.url;
            urlNeed(cp || utf16, 'OFFSET');
            urls.push({ source, representationBodySha256: urlHash(body), jsonPath: jsonPath + '/' + i, entity: { url: e.url, expanded_url: e.expanded_url, ...(e.display_url === undefined ? {} : { display_url: e.display_url }), indices: [a, b] }, offsetInterpretation: cp && utf16 ? 'CODEPOINT_AND_UTF16' : cp ? 'CODEPOINT_ONLY' : 'UTF16_ONLY', shortUrlInSelectedOwnBody: typeof selected === 'string' && selected.includes(e.url) });
        }
    }
    return urls;
}
export function projectOwnUrlContexts(pages: any, posts: any): any {
    const catalog = new Map();
    for (const [page, p] of pages.entries()) {
        urlNeed(p?.body && typeof p.body.raw === 'string' && p.body.bytes === Buffer.byteLength(p.body.raw) && p.body.sha256 === urlHash(p.body.raw), 'PAGE_BYTES');
        const instructions = JSON.parse(p.body.raw)?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
        urlNeed(Array.isArray(instructions), 'TIMELINE');
        for (const [ii, instruction] of instructions.entries()) {
            if (instruction?.type !== 'TimelineAddEntries')
                continue;
            urlNeed(Array.isArray(instruction.entries), 'ENTRIES');
            for (const [entry, e] of instruction.entries.entries()) {
                if (e?.content?.__typename !== 'TimelineTimelineItem')
                    continue;
                const r = e.content?.itemContent?.tweet_results?.result;
                urlNeed(r?.__typename === 'Tweet' && typeof r.rest_id === 'string' && e.entryId === 'tweet-' + r.rest_id, 'PRIMARY');
                const bodySource = r.note_tweet === undefined ? 'LEGACY' : 'NOTE', body = bodySource === 'LEGACY' ? r.legacy?.full_text : r.note_tweet?.note_tweet_results?.result?.text;
                urlNeed(typeof body === 'string' && r.legacy?.id_str === r.rest_id && r.legacy.user_id_str === r.core?.user_results?.result?.rest_id, 'IDENTITY');
                const jsonPath = '/data/search_by_raw_query/search_timeline/timeline/instructions/' + ii + '/entries/' + entry + '/content/itemContent/tweet_results/result';
                const row: any = { postId: r.rest_id, authorId: r.legacy.user_id_str, bodySource, bodySha256: urlHash(body), page, entry, ownUrlEntities: contexts(r, jsonPath) };
                const prior = catalog.get(row.postId);
                if (prior) {
                    const stable = (x: any): any => ({ authorId: x.authorId, bodySource: x.bodySource, bodySha256: x.bodySha256, urls: x.ownUrlEntities.map(({ jsonPath, ...v }: any): any => v) });
                    urlNeed(JSON.stringify(stable(prior)) === JSON.stringify(stable(row)), 'DUPLICATE_CONFLICT');
                }
                else
                    catalog.set(row.postId, row);
            }
        }
    }
    return posts.map((post: any): any => {
        const row = catalog.get(post.postId);
        urlNeed(row && row.authorId === post.authorId && row.bodySource === post.bodySource && row.bodySha256 === post.bodySha256 && urlHash(post.body) === post.bodySha256 && row.page === post.page && row.entry === post.entry, 'POST_BINDING');
        return row.ownUrlEntities;
    });
}
