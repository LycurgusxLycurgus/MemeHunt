import { isDeepStrictEqual as same } from 'node:util';
import { PublicKey } from '@solana/web3.js';
import { unpackMint, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, poolPda, pumpPoolAuthorityPda } from '@pump-fun/pump-swap-sdk';
import type { TokenRef, EvidenceRecord } from '../domain/contracts.js';
import { a30NativeBodyDigests } from './advisory-demand-fx-source.js';
import { decodeWindowQuote } from './advisory-window.js';
import { decodePumpSwapReservePathTransaction } from './advisory-trades.js';
import { decodePinnedWindowEvent } from './pumpswap-window-abi.js';
import { runtimeWindowSteps } from './advisory-runtime-proof.js';
import { S18_SELECTION, S18_PROFILE_SHA256, S18_PROFILE_METHOD, S18_PROFILE_FROZEN_AT, s18Instant, deriveS18ObservabilityMetric, type S18StudyInput, type S18StudyEvent } from './advisory-s18-study.js';
import { S18_SOURCE_ID, S18_SOURCE_PREFIX, S18_CAPTURE_ID, S18_ADAPTER, S18_PURPOSE, s18Hash as sha, s18Fail, s18Check as must, decodeS18Portable, s18Id, s18CaptureScope, s18RoleScope, type S18Receipt } from './advisory-s18-observability-import.js';
export * from './advisory-s18-observability-import.js';
/** Original retained source identity for this one frozen study. Hashes preserve bytes; they do not authenticate the providers. */
const ORIGINAL_RECEIPTS: Record<string, string> = { "contract": "9e1cb91b6e729e60c323d4a70074450dce3ad2a2ef2f3403e48613e8b9cda6f5", "native-capture": "3aad1403d4a1d1e944b258146cf15b5654eb53e4e75cc45047453d218c350716", "native-genesis": "2c583dc0578ed58305af2290fc734d0507c0bc4805fec01eb4eecdf0e563d424", "native-anchor-slot": "0c805a42c50b046c1763368719854847a1a93e4cd379ae6c2222d4311bc52829", "native-anchor-time": "3046a70f486b589c5c93ca70b27fb1c7aba1dd03ea8333d4034c2889a08da090", "native-current-pool-mints": "1954fb331ba2758ae2a090d422ae0835e1e98a48ced54e78ba36f8c2044f999c", "native-upper-signature": "864fa9974a67c0ef62f7ebd508953ad61ce673ca26937621a110c5636d032a3e", "native-upper-native": "9de0e0c10531df88ebc0f47eb0766047365079d8fcef28dde6bca9d828485bf2", "native-index-0": "1980af52fe03196f37c0617679154b4de026409f66c99898c6f6a3e53dad2060", "native-bulk-0": "2ece6eda1b77d4ca64a92e0e3d296ea3ddc2823d80da01d5fe6fdab02973a636", "native-bulk-1": "dbe492a2420a50c5db5c2f19a62f866418cc77f4bd6011930ca14e55b8965c81", "selected-native": "ac57b06f0380f1f49b70895b0445de6ae2124d4067664bb12304fe5e237ffd46", "public-syndication": "e3ae68957912fb3cfc43e65f3397cceebb29f69854939f02d870e4b997668384", "public-fxtwitter": "eefe76994a0b35c9fc44b504197063dd088c82a87cbd338739c7fb8317fc22f3", "gmgn-observation": "11637ceac991f5926b623c15faf459403adaffb8741e965f2dda935ba786af9d", "gmgn-response": "fe557f959a0cd51cd5779512ac0ac9b48dbb12ff517d4232d5866ca463056700", "gmgn-dom": "0cd2773eb77fb0142a60f2f8428ea9bdc036ccdbc70568910e941d54df32ae89", "semantics-commit": "5ceaac5e4819cd9ccea895653df79235037d500094ec0091c66e786e8132a916", "semantics-portfolio": "2921f2d1846196702bea8eb3c51f6c8322e344ae04c5655a5a59910a7331d67d", "semantics-track": "531e41472a2f284b120ff21f25cd64db2bcde5542714e2c453966a99e1f1aac4", "abi-published": "9c263aca0f0f87c7d43a8f5b2620e8e4da394d3ceee2ef8d2e94b01adc0816f9", "abi-sdk-prefix": "e4c4aa95c2d5f4bbc1c868736563367285e4b1536828bf977be926cce66a3348" };
const canonical = (v: any): string => JSON.stringify(v && typeof v === 'object' ? (Array.isArray(v) ? v.map((x: any) => JSON.parse(canonical(x))) : Object.fromEntries(Object.keys(v).sort().map((k: any) => [k, JSON.parse(canonical(v[k]))]))) : v);
function originalReceipt(r: S18Receipt) { const keys = ['role', 'request', 'retrievedAt', 'sourceBytes', 'sourceHash', 'startedAt', 'httpStatus', 'originalArchiveBytes', 'originalArchiveHash']; return Object.fromEntries(keys.filter((k: any) => (r as any)[k] !== undefined).map((k: any) => [k, (r as any)[k]])); }
export const s18Owns = (e: EvidenceRecord) => e.id === S18_SOURCE_ID || e.id.startsWith(S18_SOURCE_PREFIX) || e.sourceId === S18_SOURCE_ID || e.adapterVersion === S18_ADAPTER;
const u = (x: any): bigint => { must(typeof x === 'string' && /^(0|[1-9]\d{0,19})$/.test(x) && BigInt(x) <= 18446744073709551615n, 'NATIVE_ATOMIC'); return BigInt(x); };
const clean = (x: any): any => typeof x === 'bigint' ? String(x) : x?.toBase58 ? x.toBase58() : x?.constructor?.name === 'BN' ? x.toString() : Array.isArray(x) ? x.map(clean) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, clean(v)])) : x;
function reconstruct(texts: Map<string, string>, receipts: Map<string, S18Receipt>, packagedAt: string, cutoff: string): S18StudyInput {
    const cRaw = texts.get('contract')!;
    must(sha(cRaw) === S18_PROFILE_SHA256, 'PROFILE');
    const c = JSON.parse(cRaw), s = S18_SELECTION, H = S18_PROFILE_SHA256, T = s.entrySecond, start = T - 3600, end = T + 3601, cap = JSON.parse(texts.get('native-capture')!);
    const bodies = new Map<string, any>(), raws = new Map<string, string>(), events: any[] = [];
    function request(id: string, method: string, params: any[]) { const r = cap.receipts.find((r: any) => r.id === id); must(r && same(r.request, { jsonrpc: '2.0', id: 1, method, params }), 'REQUEST'); return bodies.get(id).result; }
    function rawResult(text: string) { let depth = 0, inString = false, escape = false, stringStart = -1, key: any = null, valueStart = -1, result: any = null; for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escape) {
                escape = false;
                continue;
            }
            if (ch === '\\') {
                escape = true;
                continue;
            }
            if (ch === '"') {
                inString = false;
                if (depth === 1) {
                    let n = i + 1;
                    while (/\s/.test(text[n] ?? ''))
                        n++;
                    if (text[n] === ':') {
                        key = JSON.parse(text.slice(stringStart, i + 1));
                        if (key === 'result') {
                            must(valueStart < 0, 'DUP_ROOT_RESULT');
                            n++;
                            while (/\s/.test(text[n] ?? ''))
                                n++;
                            valueStart = n;
                        }
                    }
                }
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            stringStart = i;
            continue;
        }
        if (ch === '{' || ch === '[')
            depth++;
        else if (ch === '}' || ch === ']') {
            depth--;
            if (valueStart >= 0 && depth === 1 && result === null) {
                result = text.slice(valueStart, i + 1);
            }
        }
    } must(result !== null && same(JSON.parse(result), JSON.parse(text).result), 'LOSSLESS_RESULT_SLICE'); return result; }
    must(cap.status === 'SOURCE_CAPTURE_COMPLETE_NOT_FLOW_DECODED' && cap.contractHash === H && cap.selection.signature === s.signature && cap.selection.pool === s.pool && cap.range.startSecond === start && cap.range.endExclusiveSecond === end && cap.receipts.length <= 200, 'CAPTURE_SCOPE');
    let decoded = 0, stored = 0, lastClock = 0n;
    const ids = new Set<string>();
    for (const r of cap.receipts) {
        must(!ids.has(r.id) && r.file === r.id + '.deflate' && r.requestFile === r.id + '.request.json' && r.encoding === 'DEFLATE_RAW_BINARY' && r.httpStatus === 200 && r.completeHTTPBody && r.outcome === 'RECEIVED', 'RECEIPT');
        ids.add(r.id);
        const receipt = receipts.get('native-' + r.id)!;
        must(receipt && same(receipt.request, r.request) && receipt.retrievedAt === r.receivedAt && receipt.startedAt === r.startedAt && receipt.httpStatus === r.httpStatus && receipt.sourceHash === r.sourceHash && receipt.sourceBytes === r.sourceBytes && receipt.originalArchiveHash === r.archiveHash && receipt.originalArchiveBytes === r.archiveBytes, 'ORIGINAL_RECEIPT');
        must(Buffer.byteLength(JSON.stringify(r.request)) === r.requestBytes && sha(JSON.stringify(r.request)) === r.requestHash, 'REQUEST_WIRE');
        const raw = Buffer.from(texts.get('native-' + r.id)!);
        const archive = { length: r.archiveBytes };
        const text = new TextDecoder('utf-8', { fatal: true }).decode(raw), v = JSON.parse(text);
        must(v.jsonrpc === '2.0' && v.id === 1 && !Object.hasOwn(v, 'error') && Object.hasOwn(v, 'result'), 'RPC');
        const clock = s18Instant(r.receivedAt)!;
        must(clock >= s18Instant(r.startedAt)! && s18Instant(r.startedAt)! >= lastClock && clock >= BigInt(end) * 1000000000n, 'SOURCE_CLOCK');
        lastClock = clock;
        decoded += raw.length;
        stored += archive.length;
        must(decoded <= 8 * 1024 * 1024 && stored <= 8 * 1024 * 1024, 'SOURCE_CAP');
        bodies.set(r.id, v);
        raws.set(r.id, text);
    }
    must(decoded === cap.decodedBytes && stored === cap.storedBytes && cap.requestsIssued === cap.receipts.length, 'SOURCE_TOTALS');
    must(request('genesis', 'getGenesisHash', []) === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'GENESIS');
    const anchor = request('anchor-slot', 'getSlot', [{ commitment: 'finalized' }]);
    must(Number.isSafeInteger(anchor) && anchor === cap.anchorSlot, 'ANCHOR');
    const anchorTime = request('anchor-time', 'getBlockTime', [anchor]);
    must(anchorTime === cap.anchorBlockTime && anchorTime >= end, 'ANCHOR_TIME');
    const upperPage = request('upper-signature', 'getTransactionsForAddress', [s.pool, { transactionDetails: 'signatures', sortOrder: 'asc', commitment: 'finalized', minContextSlot: anchor, limit: 1, filters: { blockTime: { gte: end }, tokenAccounts: 'none' } }]);
    must(upperPage.data.length === 1, 'UPPER');
    const upper = upperPage.data[0], native = request('upper-native', 'getTransaction', [upper.signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1 }]);
    must(upper.blockTime >= end && upper.slot <= anchor && native.transaction.signatures[0] === upper.signature && native.slot === upper.slot && native.transactionIndex === upper.transactionIndex && native.blockTime === upper.blockTime && same(native.meta.err, upper.err) && native.transaction.message.accountKeys.some((k: any) => k.pubkey === s.pool), 'UPPER_PARITY');
    const expected = new Map<string, any>(), seen = new Set();
    let before = upper.signature, reached = false, ls = upper.slot, lt = upper.blockTime;
    const indexIds = [...ids].filter((x: any) => /^index-\d+$/.test(x)).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
    must(indexIds.length <= 32, 'INDEX_CAP');
    for (const [i, id] of indexIds.entries()) {
        must(id === 'index-' + i && !reached, 'INDEX_SEQUENCE');
        const rows = request(id, 'getSignaturesForAddress', [s.pool, { commitment: 'finalized', limit: 1000, minContextSlot: anchor, before }]);
        must(Array.isArray(rows) && rows.length <= 1000, 'INDEX');
        for (const r of rows) {
            must(!seen.has(r.signature) && Number.isSafeInteger(r.slot) && r.slot <= ls && Number.isSafeInteger(r.blockTime) && r.blockTime <= lt && r.confirmationStatus === 'finalized' && Object.hasOwn(r, 'err'), 'INDEX_ROW');
            seen.add(r.signature);
            ls = r.slot;
            lt = r.blockTime;
            if (r.blockTime >= start && r.blockTime < end && r.err === null)
                expected.set(r.signature, { slot: r.slot, blockTime: r.blockTime, indexOrder: expected.size });
        }
        before = rows.at(-1)?.signature;
        reached = rows.length < 1000 || rows.some((r: any) => r.blockTime < start);
    }
    must(reached && expected.size <= 12800 && expected.has(s.signature), 'INDEX_TERMINAL');
    let cursor = null, terminal = false, position = [Infinity, Infinity];
    const transactions: any[] = [], positions = new Set(), bodyHashes = new Map(), bulkIds = [...ids].filter((x: any) => /^bulk-\d+$/.test(x)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
    must(bulkIds.length <= 128, 'BULK_CAP');
    for (const [i, id] of bulkIds.entries()) {
        must(id === 'bulk-' + i && !terminal, 'BULK_SEQUENCE');
        const v = request(id, 'getTransactionsForAddress', [s.pool, { transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized', minContextSlot: anchor, sortOrder: 'desc', limit: 100, ...(cursor ? { paginationToken: cursor } : {}), filters: { blockTime: { gte: start, lt: end }, status: 'succeeded', tokenAccounts: 'none' } }]);
        must(Object.keys(v).sort().join() === 'data,paginationToken' && Array.isArray(v.data) && v.data.length <= 100, 'BULK');
        const digests = a30NativeBodyDigests(raws.get(id)!);
        for (const tx of v.data) {
            const sig = tx.transaction.signatures[0], e = expected.get(sig), pos = [tx.slot, tx.transactionIndex], h = digests.get(sig);
            must(e && e.indexOrder === transactions.length && e.slot === tx.slot && e.blockTime === tx.blockTime && tx.meta.err === null && !bodyHashes.has(sig) && !positions.has(pos.join(':')) && tx.transaction.message.accountKeys.some((k: any) => k.pubkey === s.pool), 'BULK_BIJECTION');
            must(pos[0] < position[0] || pos[0] === position[0] && pos[1] < position[1], 'BULK_ORDER');
            position = pos;
            positions.add(pos.join(':'));
            must(h && h.slot === tx.slot && h.blockTime === tx.blockTime && h.transactionIndex === tx.transactionIndex, 'LOSSLESS_BODY');
            bodyHashes.set(sig, h!.hash);
            transactions.push({ tx, id, at: cap.receipts.find((r: any) => r.id === id).receivedAt, hash: h!.hash });
        }
        const next = v.paginationToken;
        must(next === null || typeof next === 'string' && v.data.length > 0 && next === v.data.at(-1).slot + ':' + v.data.at(-1).transactionIndex && next !== cursor, 'CURSOR');
        cursor = next;
        terminal = next === null;
    }
    must(terminal && transactions.length === expected.size && transactions.length === 14 && [...expected.keys()].every((k: any) => bodyHashes.has(k)), 'COMPLETE_BIJECTION');
    must(ids.size === 6 + indexIds.length + bulkIds.length, 'UNEXPECTED_RECEIPTS');
    const selectedRaw = texts.get('selected-native')!, selectedSlice = rawResult(selectedRaw), selectedHash = a30NativeBodyDigests('{"jsonrpc":"2.0","id":1,"result":{"data":[' + selectedSlice + ']}}').get(s.signature)?.hash;
    must(selectedHash === bodyHashes.get(s.signature), 'SELECTED_NATIVE_PARITY');
    must(same(receipts.get('selected-native')!.request, { jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [s.signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1 }] }), 'SELECTED_REQUEST');
    const bank = request('current-pool-mints', 'getMultipleAccounts', [[s.pool, s.mint, s.quoteMint], { encoding: 'base64', commitment: 'finalized', minContextSlot: anchor }]);
    must(Number.isSafeInteger(bank.context?.slot) && bank.context.slot >= anchor && bank.value.length === 3, 'BANK');
    const account = (r: any, owner: string) => { must(r && r.owner === owner && r.executable === false && Array.isArray(r.data) && r.data[1] === 'base64', 'ACCOUNT_OWNER'); const b = Buffer.from(r.data[0], 'base64'); must(b.toString('base64') === r.data[0] && b.length <= 20000, 'ACCOUNT_DATA'); return { data: b, owner: new PublicKey(owner), lamports: r.lamports, executable: false, rentEpoch: 0 }; };
    const pool = PUMP_AMM_SDK.decodePool(account(bank.value[0], PUMP_AMM_PROGRAM_ID.toBase58())), mint = unpackMint(new PublicKey(s.mint), account(bank.value[1], TOKEN_2022_PROGRAM_ID.toBase58()), TOKEN_2022_PROGRAM_ID), quote = decodeWindowQuote(bank.value[2], s.quoteMint);
    must(mint.isInitialized && mint.decimals === 6 && quote.decimals === 9 && quote.program === TOKEN_PROGRAM_ID.toBase58(), 'MINT_INITIALIZED_DECIMALS');
    must(pool.baseMint.toBase58() === s.mint && pool.quoteMint.toBase58() === s.quoteMint && pool.index === 0 && pool.creator.equals(pumpPoolAuthorityPda(new PublicKey(s.mint))) && poolPda(pool.index, pool.creator, pool.baseMint, pool.quoteMint).toBase58() === s.pool, 'POOL_PDA_TOPOLOGY');
    must(getAssociatedTokenAddressSync(pool.baseMint, new PublicKey(s.pool), true, TOKEN_2022_PROGRAM_ID).equals(pool.poolBaseTokenAccount) && getAssociatedTokenAddressSync(pool.quoteMint, new PublicKey(s.pool), true, TOKEN_PROGRAM_ID).equals(pool.poolQuoteTokenAccount), 'POOL_VAULT_ATA_TOPOLOGY');
    const poolSummary = { baseVault: pool.poolBaseTokenAccount.toBase58(), quoteVault: pool.poolQuoteTokenAccount.toBase58() };
    for (const { tx, id, at, hash } of transactions) {
        const sig = tx.transaction.signatures[0];
        const proof = decodePumpSwapReservePathTransaction(tx, { signature: sig, slot: tx.slot, at: new Date(tx.blockTime * 1000).toISOString() }, s.pool, pool, bank.context.slot, at, quote.program, 9, {});
        must(!proof.logRecovery?.truncated && (proof.logRecovery?.unresolvedInvocations ?? 0) === 0, 'UNRESOLVED_LOGS');
        for (const trade of proof.trades)
            events.push({ ...trade, transactionIndex: tx.transactionIndex, blockTime: tx.blockTime, sourceId: id, sourceHash: cap.receipts.find((r: any) => r.id === id).sourceHash, sourceAt: at, canonicalBodyHash: hash, payloadHash: sha(Buffer.from(trade.provenance.eventPayload, 'base64')), transactionBalanceClosure: null, independentConfirmation: 'PENDING' });
        const runtime = runtimeWindowSteps(tx, false), local = [];
        for (const trade of proof.trades) {
            const p = trade.provenance, frame = runtime.list.findIndex((z: any) => z.top === p.top && z.position === p.position);
            must(frame >= 0 && runtime.list[frame].proof === 'LOGGED_SUCCESS', 'NATIVE_EVENT_FRAME');
            let parent = runtime.list[frame].parent;
            while (parent >= 0) {
                must(runtime.list[parent].proof === 'LOGGED_SUCCESS', 'NATIVE_ANCESTRY');
                parent = runtime.list[parent].parent;
            }
            must(p.hop === null && p.routeEvent === null, 'PRIVATE_TRANSFER_ROUTE_UNSUPPORTED');
            const ev = decodePinnedWindowEvent(p.eventPayload, true, true, true)!, d = ev.data;
            must(ev && d.pool.toBase58() === s.pool && d.user.toBase58() === trade.user, 'EVENT_REDECODE');
            const children = runtime.list.filter((z: any) => z.parent === frame && [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(z.ix.programId));
            const transfers = children.map((z: any) => { must(z.proof === 'LOGGED_SUCCESS', 'CHILD_TRANSFER_COMMITMENT'); const i = z.ix.parsed?.info, t = z.ix.parsed?.type; must(['transfer', 'transferChecked', 'transferCheckedWithFee'].includes(t) && i && typeof i.source === 'string' && typeof i.destination === 'string' && typeof i.authority === 'string' && !i.multisigAuthority, 'PRIVATE_TRANSFER_KIND_UNSUPPORTED'); return { source: i.source, destination: i.destination, authority: i.authority, mint: i.mint ?? null, amount: u(i.tokenAmount?.amount ?? i.amount), fee: i.feeAmount ? u(i.feeAmount.amount) : null, program: z.ix.programId }; });
            const buy = trade.side === 'BUY', baseSource = buy ? poolSummary.baseVault : d.userBaseTokenAccount.toBase58(), baseDest = buy ? d.userBaseTokenAccount.toBase58() : poolSummary.baseVault, b = transfers.filter((t: any) => t.source === baseSource && t.destination === baseDest);
            must(b.length === 1 && b[0].amount === u(trade.baseAtomic) && b[0].mint === s.mint && b[0].authority === (buy ? s.pool : trade.user), 'ACTUAL_BASE_TRANSFER');
            const qt = transfers.filter((t: any) => buy ? t.source === d.userQuoteTokenAccount.toBase58() : t.source === poolSummary.quoteVault);
            must(qt.length > 0 && qt.length + 1 === transfers.length && qt.every((t: any) => t.program === quote.program && (t.mint === null || t.mint === s.quoteMint) && t.authority === (buy ? trade.user : s.pool)), 'ACTUAL_QUOTE_TRANSFERS');
            const q = trade.quoteAccounting!, total = qt.reduce((n: bigint, t: any) => n + t.amount, 0n);
            must(q && u(trade.quoteAtomic) === u(q.coreQuoteAtomic), 'CORE_QUOTE');
            if (buy)
                must(total === u(q.walletQuoteAtomic ?? q.grossQuoteAtomic), 'BUY_GROSS_TRANSFER_TOTAL');
            else {
                must(total === u(q.coreQuoteAtomic) - u(q.lpFeeAtomic), 'SELL_POOL_DEBIT_TOTAL');
                const userLeg = qt.filter((t: any) => t.destination === d.userQuoteTokenAccount.toBase58());
                must(userLeg.length === 1 && userLeg[0].amount === u(q.walletQuoteAtomic ?? q.userQuoteAtomic), 'SELL_USER_TRANSFER');
            }
            const row = { ...trade, transactionIndex: tx.transactionIndex, blockTime: tx.blockTime, sourceId: id, sourceHash: cap.receipts.find((r: any) => r.id === id).sourceHash, sourceAt: at, canonicalBodyHash: hash, payloadHash: sha(Buffer.from(p.eventPayload, 'base64')), frame, ancestorsCommitted: true, transactionBalanceClosure: false, transfers: clean(transfers) };
            Object.assign(events.find((e: any) => e.signature === sig && e.provenance.top === trade.provenance.top && e.provenance.position === trade.provenance.position && e.payloadHash === row.payloadHash), row);
            local.push({ trade, d, frame });
        }
        // Whole-transaction token metadata conservation for selected pool vaults and actual user base accounts.
        const ks = tx.transaction.message.accountKeys, presentKeys = new Set(ks.map((k: any) => k.pubkey));
        if (local.length)
            must(presentKeys.has(poolSummary.baseVault) && presentKeys.has(poolSummary.quoteVault), 'TRADE_VAULT_KEYS');
        const watches = new Map<string, string>([[poolSummary.baseVault, s.mint], [poolSummary.quoteVault, s.quoteMint], ...local.map((e: any) => [e.d.userBaseTokenAccount.toBase58(), s.mint])].filter(([account]) => presentKeys.has(account)) as [
            string,
            string
        ][]), pre = new Map<string, any>(tx.meta.preTokenBalances.map((t: any) => [ks[t.accountIndex].pubkey, t])), post = new Map<string, any>(tx.meta.postTokenBalances.map((t: any) => [ks[t.accountIndex].pubkey, t])), balances = new Map<string, bigint>();
        for (const [a, m] of watches) {
            const z = pre.get(a);
            if (z) {
                must(z.mint === m, 'PRE_TOKEN_MINT');
                balances.set(a, u(z.uiTokenAmount.amount));
            }
            else {
                must(runtime.list.some((z: any) => z.proof === 'LOGGED_SUCCESS' && /^initializeAccount/.test(z.ix.parsed?.type ?? '') && z.ix.parsed.info.account === a && z.ix.parsed.info.mint === m), 'PRE_TOKEN_ZERO_CREATION_WITNESS');
                balances.set(a, 0n);
            }
        }
        for (const [j, z] of runtime.list.entries()) {
            for (const l of local.filter((l: any) => l.frame === j)) {
                must(balances.get(poolSummary.baseVault) === u(String(l.d.poolBaseTokenReserves)) && balances.get(poolSummary.quoteVault) === u(String(l.d.poolQuoteTokenReserves)), 'EVENT_PRESTATE_NATIVE_BALANCES');
            }
            if (![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(z.ix.programId))
                continue;
            const i = z.ix.parsed?.info, t = z.ix.parsed?.type;
            if (!i)
                continue;
            const from = watches.has(i.source), to = watches.has(i.destination);
            if (!from && !to)
                continue;
            must(z.proof === 'LOGGED_SUCCESS' && ['transfer', 'transferChecked', 'transferCheckedWithFee'].includes(t), 'WATCHED_TOKEN_OPERATION_UNSUPPORTED');
            const amount = u(i.tokenAmount?.amount ?? i.amount), fee = i.feeAmount ? u(i.feeAmount.amount) : 0n;
            if (from)
                balances.set(i.source, balances.get(i.source)! - amount);
            if (to)
                balances.set(i.destination, balances.get(i.destination)! + amount - fee);
        }
        for (const [a, m] of watches) {
            const z = post.get(a);
            if (z) {
                must(z.mint === m && balances.get(a) === u(z.uiTokenAmount.amount), 'POST_NATIVE_TOKEN_CONSERVATION');
            }
            else
                must(balances.get(a) === 0n && runtime.list.some((z: any) => z.proof === 'LOGGED_SUCCESS' && z.ix.parsed?.type === 'closeAccount' && z.ix.parsed.info.account === a), 'POST_ZERO_CLOSE_WITNESS');
        }
        for (const e of events.filter((e: any) => e.signature === sig)) {
            e.transactionBalanceClosure = true;
            e.independentConfirmation = 'TRANSFER_AND_NATIVE_BALANCE_RECONCILED';
        }
    }
    const evidenceIds = [S18_CAPTURE_ID, ...receipts.keys()].map(id => id === S18_CAPTURE_ID ? id : s18Id(id));
    const at = (role: string) => receipts.get(role)!.retrievedAt;
    const max = (roles: string[]) => roles.map(at).reduce((a, b) => s18Instant(a)! > s18Instant(b)! ? a : b);
    const studyEvents: S18StudyEvent[] = events.map(e => ({ id: { signature: e.signature, slot: e.slot, transactionIndex: e.transactionIndex, top: e.provenance.top, position: e.provenance.position, pumpOrdinal: e.provenance.pumpOrdinal, hop: e.provenance.hop, routeEvent: e.provenance.routeEvent, payloadSha256: e.payloadHash }, blockTime: e.blockTime, programTimestamp: Number(e.programTimestamp), user: e.user, side: e.side, coreQuoteAtomic: e.quoteAtomic }));
    const selected = studyEvents.filter(e => e.id.signature === s.signature && e.user === s.actor && e.side === 'BUY');
    must(selected.length === 1, 'SELECTED_ENTRY');
    const tx = JSON.parse(selectedRaw).result, selectedTrade = events.find(e => e.signature === s.signature && e.user === s.actor && e.side === 'BUY'), ev = decodePinnedWindowEvent(selectedTrade.provenance.eventPayload, true, true, true)!;
    const accountKey = ev.data.userBaseTokenAccount.toBase58(), keys = tx.transaction.message.accountKeys, accountIndex = keys.findIndex((k: any) => k.pubkey === accountKey), pre = tx.meta.preTokenBalances.filter((b: any) => b.accountIndex === accountIndex), post = tx.meta.postTokenBalances.filter((b: any) => b.accountIndex === accountIndex);
    must(accountIndex >= 0 && pre.length === 1 && post.length === 1 && pre[0].mint === s.mint && post[0].mint === s.mint && pre[0].owner === s.actor && post[0].owner === s.actor && u(pre[0].uiTokenAmount.amount) > 0n && u(post[0].uiTokenAmount.amount) > u(pre[0].uiTokenAmount.amount), 'INCREMENTAL_BASE_ACCOUNT');
    const sy = JSON.parse(texts.get('public-syndication')!), fx = JSON.parse(texts.get('public-fxtwitter')!), q = sy.quoted_tweet, fq = fx.tweet.quote;
    must(fx.code === 200 && sy.id_str === s.publicQuoteRepost && fx.tweet.id === sy.id_str && q.id_str === s.publicAnnouncement && fq.id === q.id_str && sy.user.id_str === fx.tweet.author.id && q.user.id_str === fq.author.id && sy.user.id_str !== q.user.id_str, 'PUBLIC_NATIVE_IDS');
    must(s18Instant(sy.created_at) === BigInt(fx.tweet.created_timestamp) * 1000000000n && s18Instant(q.created_at) === BigInt(fq.created_timestamp) * 1000000000n && q.entities.urls.some((v: any) => v.expanded_url === 'https://solscan.io/tx/' + s.signature) && fq.raw_text.facets.some((v: any) => v.replacement === 'https://solscan.io/tx/' + s.signature), 'PUBLIC_RECEIPT_CLOCK');
    const obs = JSON.parse(texts.get('gmgn-observation')!), gm = JSON.parse(texts.get('gmgn-response')!), gr = receipts.get('gmgn-response')!, dom = texts.get('gmgn-dom')!;
    must(same(gr.request, Object.fromEntries(['method', 'url', 'postData', 'requestFidelity', 'originalUrlSha256', 'originalMetadataSha256'].map(k => [k, obs[k]]))) && obs.bodySha256 === gr.sourceHash && obs.bodyBytes === gr.sourceBytes && obs.startedAt === gr.startedAt && obs.retrievedAt === gr.retrievedAt && obs.httpStatus === 200 && obs.domObservedAt === at('gmgn-dom'), 'TRACKING_RECEIPT');
    must(same(JSON.parse(String(gr.request.postData)), { q: s.actor, chain_filters: { sol: {} }, wallet_chains: ['sol'], with_user: true }) && gm.code === 0 && gm.message === 'success' && gm.data.wallets.length === 1, 'TRACKING_REQUEST');
    const wallet = gm.data.wallets[0];
    must(wallet.chain === 'sol' && wallet.address === s.actor && Number.isSafeInteger(wallet.follow_count) && wallet.follow_count >= 0 && dom.includes('href="/sol/address/' + s.actor + '"') && new RegExp('>Tracked</span><span[^>]*>' + wallet.follow_count + '</span>').test(dom), 'TRACKING_BODY_DOM');
    const semCommit = JSON.parse(texts.get('semantics-commit')!);
    must(semCommit[0].sha === '9657e45393ea6add27fd790aa42650797405856e' && texts.get('semantics-portfolio')!.includes('follow_count') && texts.get('semantics-portfolio')!.includes('Number of GMGN users following this wallet') && texts.get('semantics-track')!.includes('personally followed'), 'TRACKING_SEMANTICS');
    return { profile: { method: S18_PROFILE_METHOD, sha256: S18_PROFILE_SHA256, frozenAt: S18_PROFILE_FROZEN_AT, horizonSeconds: 3600 }, subject: { token: { chain: 'solana', address: s.mint }, actor: s.actor, pool: s.pool, quoteMint: s.quoteMint, quoteDecimals: 9 }, entry: { status: 'COMPLETE', availableAt: at('selected-native'), evidenceIds, value: { event: selected[0], selectedBaseAccountKey: accountKey, selectedBaseAccountPreAtomic: pre[0].uiTokenAmount.amount, selectedBaseAccountPostAtomic: post[0].uiTokenAmount.amount, retrievedAt: at('selected-native') } }, reference: { status: 'COMPLETE', availableAt: max(['public-syndication', 'public-fxtwitter']), evidenceIds, value: { signature: s.signature, original: { id: q.id_str, authorId: q.user.id_str, publishedAt: q.created_at }, quote: { id: sy.id_str, authorId: sy.user.id_str, publishedAt: sy.created_at, quotedOriginalId: q.id_str }, currentRetainedRevisionOnly: true, retrievedAt: { syndication: at('public-syndication'), fxtwitter: at('public-fxtwitter') } } }, tracker: { status: 'COMPLETE', availableAt: max(['gmgn-response', 'gmgn-dom', 'semantics-commit', 'semantics-portfolio', 'semantics-track']), evidenceIds, value: { wallet: s.actor, provider: 'GMGN', followCount: String(wallet.follow_count), responseRetrievedAt: at('gmgn-response'), domObservedAt: at('gmgn-dom'), semanticsAvailableAt: max(['semantics-commit', 'semantics-portfolio', 'semantics-track']), semantics: 'GMGN_DOCUMENTED_FIELD_SEMANTICS_SIBLING_PATH_INFERRED' } }, flow: { status: 'COMPLETE', availableAt: max(cap.receipts.map((r: any) => 'native-' + r.id)), evidenceIds, value: { range: { startSecond: start, endSecondExclusive: end }, firstRequestStartedAt: cap.receipts[0].startedAt, events: studyEvents } }, packagedAt, evaluationCutoff: cutoff };
}
function validateSource(token: TokenRef, cutoff: string, evidence: EvidenceRecord[], rawArtifacts: Record<string, string>) {
    const owned = evidence.filter(s18Owns), capture = owned.find(e => e.id === S18_CAPTURE_ID);
    must(capture && owned.filter(e => e.id === S18_CAPTURE_ID).length === 1, 'CAPTURE');
    const manifestRaw = rawArtifacts[S18_CAPTURE_ID];
    must(typeof manifestRaw === 'string', 'CAPTURE');
    const m = JSON.parse(manifestRaw), sources: Record<string, string> = {};
    for (const r of m.receipts ?? [])
        sources[r.role] = rawArtifacts[s18Id(r.role)];
    const { manifest, texts, receipts } = decodeS18Portable(manifestRaw, sources, cutoff);
    must(manifestRaw === JSON.stringify(manifest), 'CAPTURE_CANONICAL');
    must(same([...receipts.keys()].sort(), Object.keys(ORIGINAL_RECEIPTS).sort()), 'ORIGINAL_CATALOG');
    for (const r of receipts.values())
        must(sha(canonical(originalReceipt(r))) === ORIGINAL_RECEIPTS[r.role], 'ORIGINAL_RECEIPT');
    const ids = [S18_CAPTURE_ID, ...manifest.receipts.map(r => s18Id(r.role))];
    must(owned.length === ids.length && new Set(owned.map(e => e.id)).size === ids.length && owned.every(e => ids.includes(e.id)) && same(Object.keys(rawArtifacts).filter(id => id.startsWith(S18_SOURCE_PREFIX)).sort(), [...ids].sort()), 'OWNERSHIP');
    for (const e of owned) {
        const r = e.id === S18_CAPTURE_ID ? null : receipts.get(e.id.slice(S18_SOURCE_PREFIX.length));
        must(e.sourceId === S18_SOURCE_ID && e.sourceType === 'HISTORICAL_RECEIPT' && e.adapterVersion === S18_ADAPTER && e.accessMode === 'USER_IMPORT' && e.contentHash === sha(rawArtifacts[e.id]) && e.retrievedAt === e.availableAt && e.retrievedAt === (r ? r.retrievedAt : manifest.packagedAt) && same(e.scope, r ? s18RoleScope(r) : s18CaptureScope()), 'EVIDENCE');
    }
    const input = reconstruct(texts, receipts, manifest.packagedAt, cutoff);
    return { ids, input, metric: deriveS18ObservabilityMetric(token, cutoff, input, ids) };
}
/** Validate every original body before deriving either a measured member or a nonmember MISSING result. */
export function validateS18ObservabilitySource(token: TokenRef, cutoff: string, evidence: EvidenceRecord[], rawArtifacts: Record<string, string>) { try {
    return validateSource(token, cutoff, evidence, rawArtifacts);
}
catch (e) {
    if (e instanceof Error && /^S18_OBSERVABILITY_[A-Z_]+$/.test(e.message))
        throw e;
    return s18Fail('SOURCE_INVALID');
} }
