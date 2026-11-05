import { createHash } from 'node:crypto';
import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { isDeepStrictEqual as same } from 'node:util';
import { z } from 'zod';
import { tokenRefSchema, type TokenRef } from '../domain/contracts.js';
import { s18Instant as c07Instant } from './advisory-s18-study.js';
export const C07_SOURCE_ID = 'advisory-c07-lifecycle', C07_SOURCE_PREFIX = C07_SOURCE_ID + '-', C07_CAPTURE_ID = C07_SOURCE_PREFIX + 'capture';
export const C07_ADAPTER = 'c07-fixed-cohort-lifecycle-source-v1', C07_PURPOSE = 'HISTORICAL_SELECTED_VENUE_DEMAND_LIFECYCLE_WINDOWS', C07_IMPORT_METHOD = 'c07-lifecycle-portable-v1';
export const C07_FILE_BYTES = 8 * 1024 * 1024, C07_DECODED_BYTES = 8 * 1024 * 1024, C07_RECORD_BYTES = 2 * 1024 * 1024, C07_RECORDS = 128;
export const c07Hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
export const c07Fail = (s: string): never => { throw Error('C07_LIFECYCLE_' + s); };
export const c07Check = (v: unknown, s: string): void => { if (!v)
    c07Fail(s); };
const instant = z.string().refine(v => c07Instant(v) !== null), hex = z.string().regex(/^[a-f0-9]{64}$/), bytes = z.number().int().nonnegative().max(C07_RECORD_BYTES);
export const c07ReceiptSchema = z.object({ role: z.string().regex(/^[a-z0-9][a-z0-9-]{0,95}$/), request: z.record(z.string(), z.unknown()), retrievedAt: instant, encoding: z.enum(['TEXT', 'DEFLATE_RAW_BASE64']), sourceBytes: bytes, sourceHash: hex, storedBytes: bytes, storedHash: hex, startedAt: instant.optional(), httpStatus: z.number().int().optional(), originalArchiveBytes: bytes.optional(), originalArchiveHash: hex.optional() }).strict();
export const c07ManifestSchema = z.object({ method: z.literal(C07_IMPORT_METHOD), purpose: z.literal(C07_PURPOSE), packagedAt: instant, receipts: z.array(c07ReceiptSchema).min(1).max(C07_RECORDS) }).strict();
export type C07Manifest = z.infer<typeof c07ManifestSchema>;
export type C07Receipt = z.infer<typeof c07ReceiptSchema>;
export type C07WireRecord = {
    id: string;
    raw: string;
    scope: Record<string, unknown>;
    retrievedAt: string;
};
export const c07Id = (role: string) => C07_SOURCE_PREFIX + role;
export const c07CaptureScope = () => ({ method: C07_ADAPTER, purpose: C07_PURPOSE, role: 'CAPTURE' });
export const c07RoleScope = (r: C07Receipt) => ({ method: C07_ADAPTER, purpose: C07_PURPOSE, role: r.role, request: r.request });
export const C07_ORIGINAL_RECEIPTS:Record<string,string>={"contract":"092ffc4728dda9c072afc870742c50e37afc634cba5bc72d8379929a7ec717b9","parent-selection":"fd5a8c013794ced03b3e76f76082b628f1459bed1bc5b31db9a2ae3b9be7034e","source-plan":"4391c9c20d69340e71cf057b69feca2b9dcdb9af4bbded39e9c535bb48aa4fc9","source-dto":"77158d0c900a94959776ae1c2d5ee3acbdac769a248aa9a9cc81bbf2c8618841","discovery":"92e6b8a9bc83503ef187c14cbaf13e6196ea64f39fe4112a62c18bcc4ca7a4da","native-capture":"704c64bdc03073662cdfe008cd59099ec8192ee21ad2ca4ae208534ff64f4d5a","native-requests":"0d775ad4827633194e4473978de7c44b6e087ee9490dc46721fe76913108b8ff","status-seeds":"0bdbdd4f99aa8716ee5d74f0f79441e69c62a8cd63fa142cf67fd5a3aef3a30c","hydration-scope":"0fcc9de8fe8ceaf66efb465ad6e812262d83ac3a316a980331b572fcdd11a450","hydration-receipts":"44507b9efa2d684ea1374c1fb73db70491c718cfd24b9835f771ec839d94e6fa","attention-grouping":"b05e623a15ff7bc83eb73ff8be4e87ceed75e9fa1570d4fb1c0396a9e2f166ed","attention-qualification":"16508b287a46420504ed1cfd3944c0bcacc8c8101433bc1dd5a0d805bf8e1fdd","dex-0":"1589a5d9abbf33245d4f6b9840e94a8ed8cb08ad1afb510fd6390ce680e11b70","dex-1":"046a5c5444c56f26a4ecb328e509542c2ab69fdadd554b595b0140d9b0a6f519","dex-2":"3863a81febd8a5f153d03e91e98218447f5bfcd2e7341e864822d159abe2391d","dex-3":"b3e597d100aeb239e9e7b9a74f3cfc0a151fe3f9cf80693652f185cfa28dbfb4","dex-4":"4031adc53190ea170ede1d14ec597b3a6c3fa37947bac515791b0531ebff6eb8","dex-5":"f94ca4877fde07ed5ec10f2340282f3db212d9876fb23c8c855306f240c5ebea","dex-6":"c299ae14383ec32c139caee96ac318e32e15714bd825aee4837d7d873734a0f8","native-genesis":"53fb2d83b31490bdca5404682874e9b38f8efad068f70489fe5064b6eb0e90bf","native-anchor-slot":"060eea3e4cf3fd5dc8e1f943783fb55683f8f321fad3786a5214e712f26fdbdc","native-anchor-time":"cd9704d85d5b02b9a3392c0ee3d0960d98297bdaf0470d5e9e34223ee9a4292f","native-a0-bank":"4f9cfc56eb9b0951dc36cba0eeb9be38122b75c59125674643794cf9e0aa5a23","native-a0-index-0":"69fb80dbf2a780d8b1b8d0e077a36e2d79784ae7556e13d6feca3cb1ac43cbfb","native-a0-bulk-0":"98cd01a5d89f2ce665dab1b4cc5a1ebd657add43b0d4ed8d0f25b4b3ec9d8b15","native-a0-bulk-1":"2effb424e68625aed3ea15b833be875931d855dc9101bce6a6b01204f4988fe1","native-a1-bank":"b5a1e433f8eda663dcbb46d93a7215a890e19d3f726057841fea11b5b38d3815","native-a1-index-0":"e4651ded69626879fb467ea3b1237a59204f406a64a997a9b1da168d4e141fd2","native-a1-bulk-0":"8b763ccd30785ff48c0c47170b42c06bb0cba069b5aad9dba952ccda32797cdf","native-a1-bulk-1":"ef336a50b68393b9354a20f6e7abad3c7f53357446440ed40cdbe91905e819a6","native-a5-bank":"bf297e51533fe0758e916d1c505350c05f86bf85fac61cc2a3b6ae6d1acd7112","native-a5-index-0":"11a2514ed1d3962d7fd4818bf46f55ae5294ecb0c74af564d3388c00f939d91b","native-a5-bulk-0":"1320211e545fd3951f153d34ecb73272d3eed09f5f57b3b7bb04333f5f86a059","native-a5-bulk-1":"04119c8aa1e98b0ca96c47d405a4b9f45c3e6a60284418fd68e3a73d67e35b10","search-00":"4ff56642b51ec84b248b7b78f85016a815a4c843152d7c79a6ab38c8b3a2ac67","search-01":"3ce96b905433e5cac0c1ba8a50892242f818d272a0571d3ae0f1d3ff373796fd","search-02":"da2382c6659076bc4b95b59c1331b3dd94f8bcc94a76b1248318a537fea8bea9","search-03":"7355869bc87a89375888902e25e1741eb091682e7b6f0b6b6624198e036e1b3d","search-04":"00ce29a46730bf27c654a96cba43dfa2c45e07de98abd5e459ce99b9c801a136","search-05":"abe150c5ef7b0d03a5d349b8f7546a370b956b4cbce5761c31ba394e4b236c67","search-06":"25e8acec85fa4f6130aa77cdddd7a09ef1c4b54f30e96810e6645b84f051ae80","search-07":"8d665d87e7eb19614ebbe93f19ae9c1d4613cacb7e19e9118d909adf8a65ff0d","search-08":"0d0347d17404afba6bd4537446fa328c5855081b20f2b750aba1441ba012d9eb","search-09":"53bd9335829dd8d3ae58843673f31241c9d4f7df7c9c86c523866ec6f1a7926a","search-10":"8a3eaf3a7736ad71e8c6f9772159c85679a8ab0d4da13b5efa9bd13f2884b624","search-11":"46eab32180a2d01c5e22ea309f0e4e4a484faceff931b3b1cf888e7c5c92aa64","search-12":"728e786c78f9f04ea7f8a7964f652f68ed3cb896503018812cf1593ed9800571","search-13":"ce4896ccead123996a0bd853c696302e19c94b8310d8709c1fac1d0962fa019e","2117994287451214131-syndication":"272e3a6e8c405452d0b9d711325e467db0843a20d6d582336563bdeb6a844b12","2117994287451214131-fxtwitter":"02c54d249069118721ffdc11642142bfd8e7c0e54f6a91a8ae2fe7d1228aa67d","2118125675324359102-syndication":"f6dd3da686dd071b7247260b666225ae8a1d398a925c09b0b04a3b72ff550a93","2118125675324359102-fxtwitter":"94f420c537dbf36f83b73280d0b18136fc484ea7c77b421b91946241ccba6eee","2118007494878634453-syndication":"0645dfd3151508496db8ac72f32d58430b2b58862ec1fa1df63b90a314ba7b57","2118007494878634453-fxtwitter":"ec76e29189d1ca65f38f578ca5ffaa63ed99297e4a5eb301dcd49fd39c3f3b7d","2118139164726329509-syndication":"3e8700adf893c180acefaecb3cd52774b3f179b597917549483a55d2f0a97d1f","2118139164726329509-fxtwitter":"f909464dcfe98a4cbf765c2f9c486a2461cb767bb25fd56f6dc06ddca92f0fc7","2118089215338824107-syndication":"39f977064de9d7ead1da90d5f87963a6e46fccb5c58eee5f2deb4748b7218b40","2118089215338824107-fxtwitter":"0061a6a5200cd8c52f57acaa4bb3711d12a38cd3c5cfa36955358f2a8f716f24","2117904721620930915-syndication":"ede5d971b014d77df2df759050340686911f5ce9c5e28849e640f158a54f1637","2117904721620930915-fxtwitter":"afc68339a8f24693d67cdb8720e2bd2b7fa4639ac83189f55f4fd1df66389720"};
const staticRoles=Object.keys(C07_ORIGINAL_RECEIPTS);
const canonical=(v:any):string=>JSON.stringify(v&&typeof v==='object'?(Array.isArray(v)?v.map((x:any)=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))]))):v);
function originalReceipt(r:C07Receipt){const keys=['role','request','retrievedAt','sourceBytes','sourceHash','startedAt','httpStatus','originalArchiveBytes','originalArchiveHash'];return Object.fromEntries(keys.filter(k=>(r as any)[k]!==undefined).map(k=>[k,(r as any)[k]]));}
export function decodeC07Portable(manifestRaw: string, rawSources: Record<string, string>, cutoff: string): {
    manifest: C07Manifest;
    texts: Map<string, string>;
    receipts: Map<string, C07Receipt>;
} {
    const parsed = c07ManifestSchema.safeParse(JSON.parse(manifestRaw)), manifest = parsed.success ? parsed.data : c07Fail('MANIFEST');
    c07Check(c07Instant(cutoff) !== null && c07Instant(manifest.packagedAt)! <= c07Instant(cutoff)!, 'CLOCK');
    const roles = manifest.receipts.map(r => r.role);
    c07Check(new Set(roles).size === roles.length && same([...Object.keys(rawSources)].sort(), [...roles].sort()), 'CATALOG');
    c07Check(staticRoles.every(r => roles.includes(r)) && roles.every(r => staticRoles.includes(r)), 'ROLES');
    const texts = new Map<string, string>(), receipts = new Map<string, C07Receipt>();
    let total = 0;
    for (const r of manifest.receipts) {
        c07Check(c07Hash(canonical(originalReceipt(r)))===C07_ORIGINAL_RECEIPTS[r.role],'ORIGINAL_RECEIPT');
        const raw = rawSources[r.role];
        c07Check(typeof raw === 'string', 'RAW');
        const stored = Buffer.from(raw, 'utf8');
        c07Check(stored.length === r.storedBytes && stored.length <= C07_RECORD_BYTES && c07Hash(stored) === r.storedHash, 'STORED_BYTES');
        c07Check(c07Instant(r.retrievedAt)! <= c07Instant(manifest.packagedAt)! && (!r.startedAt || c07Instant(r.startedAt)! <= c07Instant(r.retrievedAt)!), 'CLOCK');
        let body: Buffer;
        if (r.encoding === 'DEFLATE_RAW_BASE64') {
            const archive = Buffer.from(raw, 'base64');
            c07Check(archive.toString('base64') === raw && archive.length === r.originalArchiveBytes && c07Hash(archive) === r.originalArchiveHash, 'ARCHIVE');
            body = inflateRawSync(archive, { maxOutputLength: Math.min(C07_RECORD_BYTES, r.sourceBytes) });
        }
        else {
            c07Check(r.originalArchiveBytes === undefined && r.originalArchiveHash === undefined, 'ARCHIVE');
            body = stored;
        }
        total += body.length;
        c07Check(body.length === r.sourceBytes && body.length <= C07_RECORD_BYTES && c07Hash(body) === r.sourceHash && total <= C07_DECODED_BYTES, 'SOURCE_BYTES');
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
        c07Check(Buffer.from(text, 'utf8').equals(body), 'UTF8');
        texts.set(r.role, text);
        receipts.set(r.role, r);
    }
    return { manifest, texts, receipts };
}
/** One bounded, regular UTF-8 file. Manifest labels are never filesystem paths. */
function loadCapture(file: string, token: TokenRef, cutoff: string): {
    manifest: C07Manifest;
    records: C07WireRecord[];
} {
    c07Check(tokenRefSchema.safeParse(token).success && token.chain === 'solana', 'TOKEN');
    let fd: number | undefined;
    let b: Buffer;
    try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const st = fstatSync(fd);
        c07Check(st.isFile() && st.size <= C07_FILE_BYTES, 'FILE_BOUND');
        const buffer = Buffer.alloc(st.size + 1);
        let n = 0;
        while (n < buffer.length) {
            const got = readSync(fd, buffer, n, buffer.length - n, n);
            if (!got)
                break;
            n += got;
        }
        c07Check(n === st.size, 'FILE_BOUND');
        b = buffer.subarray(0, n);
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b!);
    c07Check(Buffer.from(text).equals(b!), 'UTF8');
    const p = z.object({ manifest: c07ManifestSchema, rawSources: z.record(z.string(), z.string()) }).strict().safeParse(JSON.parse(text));
    c07Check(p.success, 'FILE_SHAPE');
    if (!p.success)
        return c07Fail('FILE_SHAPE');
    const manifestRaw = JSON.stringify(p.data.manifest), decoded = decodeC07Portable(manifestRaw, p.data.rawSources, cutoff);
    return { manifest: decoded.manifest, records: [{ id: C07_CAPTURE_ID, raw: manifestRaw, scope: c07CaptureScope(), retrievedAt: decoded.manifest.packagedAt }, ...decoded.manifest.receipts.map(r => ({ id: c07Id(r.role), raw: p.data.rawSources[r.role]!, scope: c07RoleScope(r), retrievedAt: r.retrievedAt }))] };
}
export function loadC07LifecycleCapture(file: string, token: TokenRef, cutoff: string) { try {
    return loadCapture(file, token, cutoff);
}
catch (e) {
    if (e instanceof Error && /^C07_LIFECYCLE_[A-Z_]+$/.test(e.message))
        throw e;
    return c07Fail('IMPORT_INVALID');
} }
