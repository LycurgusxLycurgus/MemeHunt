import { createHash } from 'node:crypto';
import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { isDeepStrictEqual as same } from 'node:util';
import { z } from 'zod';
import { tokenRefSchema, type TokenRef } from '../domain/contracts.js';
import { S18_SELECTION, s18Instant } from './advisory-s18-study.js';
export const S18_SOURCE_ID = 'advisory-s18-observability', S18_SOURCE_PREFIX = S18_SOURCE_ID + '-', S18_CAPTURE_ID = S18_SOURCE_PREFIX + 'capture';
export const S18_ADAPTER = 's18-selected-buy-observability-source-v1', S18_PURPOSE = 'HISTORICAL_SELECTED_BUY_ACTOR_OBSERVABILITY_PROXY_COMPONENTS', S18_IMPORT_METHOD = 's18-observability-portable-v1';
export const S18_FILE_BYTES = 8 * 1024 * 1024, S18_DECODED_BYTES = 8 * 1024 * 1024, S18_RECORD_BYTES = 2 * 1024 * 1024, S18_RECORDS = 64;
export const s18Hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
export const s18Fail = (s: string): never => { throw Error('S18_OBSERVABILITY_' + s); };
export const s18Check = (v: unknown, s: string): void => { if (!v)
    s18Fail(s); };
const instant = z.string().refine(v => s18Instant(v) !== null), hex = z.string().regex(/^[a-f0-9]{64}$/), bytes = z.number().int().nonnegative().max(S18_RECORD_BYTES);
export const s18ReceiptSchema = z.object({ role: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), request: z.record(z.string(), z.unknown()), retrievedAt: instant, encoding: z.enum(['TEXT', 'DEFLATE_RAW_BASE64']), sourceBytes: bytes, sourceHash: hex, storedBytes: bytes, storedHash: hex, startedAt: instant.optional(), httpStatus: z.number().int().optional(), originalArchiveBytes: bytes.optional(), originalArchiveHash: hex.optional() }).strict();
export const s18ManifestSchema = z.object({ method: z.literal(S18_IMPORT_METHOD), purpose: z.literal(S18_PURPOSE), subject: tokenRefSchema, packagedAt: instant, receipts: z.array(s18ReceiptSchema).min(1).max(S18_RECORDS) }).strict();
export type S18Manifest = z.infer<typeof s18ManifestSchema>;
export type S18Receipt = z.infer<typeof s18ReceiptSchema>;
export type S18WireRecord = {
    id: string;
    raw: string;
    scope: Record<string, unknown>;
    retrievedAt: string;
};
export const s18Id = (role: string) => S18_SOURCE_PREFIX + role;
export const s18CaptureScope = () => ({ method: S18_ADAPTER, purpose: S18_PURPOSE, role: 'CAPTURE' });
export const s18RoleScope = (r: S18Receipt) => ({ method: S18_ADAPTER, purpose: S18_PURPOSE, role: r.role, request: r.request });
const staticRoles = ['contract', 'native-capture', 'selected-native', 'public-syndication', 'public-fxtwitter', 'gmgn-observation', 'gmgn-response', 'gmgn-dom', 'semantics-commit', 'semantics-portfolio', 'semantics-track', 'abi-published', 'abi-sdk-prefix', 'native-genesis', 'native-anchor-slot', 'native-anchor-time', 'native-current-pool-mints', 'native-upper-signature', 'native-upper-native'];
export function decodeS18Portable(manifestRaw: string, rawSources: Record<string, string>, cutoff: string): {
    manifest: S18Manifest;
    texts: Map<string, string>;
    receipts: Map<string, S18Receipt>;
} {
    const parsed = s18ManifestSchema.safeParse(JSON.parse(manifestRaw)), manifest = parsed.success ? parsed.data : s18Fail('MANIFEST');
    s18Check(manifest.subject.chain === 'solana' && manifest.subject.address === S18_SELECTION.mint, 'SUBJECT');
    s18Check(s18Instant(cutoff) !== null && s18Instant(manifest.packagedAt)! <= s18Instant(cutoff)!, 'CLOCK');
    const roles = manifest.receipts.map(r => r.role);
    s18Check(new Set(roles).size === roles.length && same([...Object.keys(rawSources)].sort(), [...roles].sort()), 'CATALOG');
    s18Check(staticRoles.every(r => roles.includes(r)) && roles.every(r => staticRoles.includes(r) || /^native-(index|bulk)-[0-9]+$/.test(r)), 'ROLES');
    const texts = new Map<string, string>(), receipts = new Map<string, S18Receipt>();
    let total = 0;
    for (const r of manifest.receipts) {
        const raw = rawSources[r.role];
        s18Check(typeof raw === 'string', 'RAW');
        const stored = Buffer.from(raw, 'utf8');
        s18Check(stored.length === r.storedBytes && stored.length <= S18_RECORD_BYTES && s18Hash(stored) === r.storedHash, 'STORED_BYTES');
        s18Check(s18Instant(r.retrievedAt)! <= s18Instant(manifest.packagedAt)! && (!r.startedAt || s18Instant(r.startedAt)! <= s18Instant(r.retrievedAt)!), 'CLOCK');
        let body: Buffer;
        if (r.encoding === 'DEFLATE_RAW_BASE64') {
            const archive = Buffer.from(raw, 'base64');
            s18Check(archive.toString('base64') === raw && archive.length === r.originalArchiveBytes && s18Hash(archive) === r.originalArchiveHash, 'ARCHIVE');
            body = inflateRawSync(archive, { maxOutputLength: Math.min(S18_RECORD_BYTES, r.sourceBytes) });
        }
        else {
            s18Check(r.originalArchiveBytes === undefined && r.originalArchiveHash === undefined, 'ARCHIVE');
            body = stored;
        }
        total += body.length;
        s18Check(body.length === r.sourceBytes && body.length <= S18_RECORD_BYTES && s18Hash(body) === r.sourceHash && total <= S18_DECODED_BYTES, 'SOURCE_BYTES');
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
        s18Check(Buffer.from(text, 'utf8').equals(body), 'UTF8');
        texts.set(r.role, text);
        receipts.set(r.role, r);
    }
    return { manifest, texts, receipts };
}
/** One bounded, regular UTF-8 file. Manifest labels are never filesystem paths. */
function loadCapture(file: string, token: TokenRef, cutoff: string): {
    manifest: S18Manifest;
    records: S18WireRecord[];
} {
    s18Check(tokenRefSchema.safeParse(token).success && token.chain === 'solana', 'TOKEN');
    let fd: number | undefined;
    let b: Buffer;
    try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const st = fstatSync(fd);
        s18Check(st.isFile() && st.size <= S18_FILE_BYTES, 'FILE_BOUND');
        const buffer = Buffer.alloc(st.size + 1);
        let n = 0;
        while (n < buffer.length) {
            const got = readSync(fd, buffer, n, buffer.length - n, n);
            if (!got)
                break;
            n += got;
        }
        s18Check(n === st.size, 'FILE_BOUND');
        b = buffer.subarray(0, n);
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b!);
    s18Check(Buffer.from(text).equals(b!), 'UTF8');
    const p = z.object({ manifest: s18ManifestSchema, rawSources: z.record(z.string(), z.string()) }).strict().safeParse(JSON.parse(text));
    s18Check(p.success, 'FILE_SHAPE');
    if (!p.success)
        return s18Fail('FILE_SHAPE');
    const manifestRaw = JSON.stringify(p.data.manifest), decoded = decodeS18Portable(manifestRaw, p.data.rawSources, cutoff);
    return { manifest: decoded.manifest, records: [{ id: S18_CAPTURE_ID, raw: manifestRaw, scope: s18CaptureScope(), retrievedAt: decoded.manifest.packagedAt }, ...decoded.manifest.receipts.map(r => ({ id: s18Id(r.role), raw: p.data.rawSources[r.role]!, scope: s18RoleScope(r), retrievedAt: r.retrievedAt }))] };
}
export function loadS18ObservabilityCapture(file: string, token: TokenRef, cutoff: string) { try {
    return loadCapture(file, token, cutoff);
}
catch (e) {
    if (e instanceof Error && /^S18_OBSERVABILITY_[A-Z_]+$/.test(e.message))
        throw e;
    return s18Fail('IMPORT_INVALID');
} }
