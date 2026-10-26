import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_MINT } from '@solana/spl-token';
import { decodeAdvisoryWindow, deriveO28Window } from '../src/providers/advisory-window.js';
import { decodeAdvisoryWindowAccounts } from '../src/providers/advisory-window-accounts.js';
import { decodePumpSwapWindowTransaction } from '../src/providers/advisory-trades.js';

// Proof36 version seams: the defaultfalse `extended` flag (arg 14) must throw a dedicated *_EXTENDED_SCOPE
// error unless `modern` is already on, the new WSOL window method v6 must keep the WSOL O28 shape, and the
// native-only readers (accounts/demand/automation) must reject a v6 window because they only admit v3/v4.
const WSOL = NATIVE_MINT.toBase58();
const BOUNCER = 'Gv6jKrrjJW9NLZujVZdxj6D9xL21qcLbHso8LYFMpump';
const POOL_BASE = 'EwwakfDng22Qv5f7qCPGH1ohrQDWocb38MHRJtcWYEv2';
const LEGACY_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const base = (over: Record<string, unknown> = {}): any => ({
  method: 'pumpswap-selected-pool-window-v4', token: { chain: 'solana', address: BOUNCER }, pool: POOL_BASE,
  window: { start: '2026-10-24T09:00:00.000Z', end: '2026-10-24T10:00:00.000Z' }, genesisVerified: true,
  anchorSlot: 1, anchorTime: '2026-10-24T10:00:30.000Z', poolVerified: true, stateSlot: 2, coverageReachedStart: true,
  indexComplete: true, complete: true, sourceUniverseComplete: false, pages: [], successfulSignatures: 1, failedReferences: 0,
  transactions: [{ signature: 's', slot: 1, at: '2026-10-24T09:30:00.000Z', status: 'OBSERVED', trades: 1 }],
  trades: [], buyQuoteAtomic: '0', sellQuoteAtomic: '0', netQuoteAtomic: '0', foreignSwapLegs: 0, nonSwapInvocations: 0,
  cpiAuthorizedAccounts: [], limitations: [], reasonCode: 'SELECTED_POOL_WINDOW_FLOW_OBSERVED', ...over });
const empty = { rawArtifacts: {}, retrievedAt: {}, requests: {} };
const cutoff = '2026-10-24T11:00:00.000Z';

test('decodeAdvisoryWindow with extended on but modern off throws the dedicated extended-scope error', () => {
  assert.throws(() => decodeAdvisoryWindow({ chain: 'solana', address: BOUNCER }, POOL_BASE, '2026-10-24T10:00:00.000Z', {}, {}, {}, cutoff, true, true, true, true, true, false, true), /ADVISORY_WINDOW_EXTENDED_SCOPE/);
});

test('decodePumpSwapWindowTransaction with extended on but modern off throws the dedicated extended-scope error', () => {
  assert.throws(() => decodePumpSwapWindowTransaction({}, { signature: 's', slot: 1, at: '2026-10-24T09:30:00.000Z' }, 'p', {} as any, 2, '2026-10-24T10:00:00.000Z', true, true, false, false, false, false, undefined, true), /ADVISORY_TRADE_EXTENDED_SCOPE/);
});

test('deriveO28Window keeps the WSOL scope/unit for a v6 window while recording the verified quote program', () => {
  const d = deriveO28Window(base({ method: 'pumpswap-selected-pool-window-v6', quote: { mint: WSOL, decimals: 9, program: LEGACY_TOKEN } }), ['e']).data as any;
  assert.equal(d.scope, 'VERIFIED_PUMPSWAP_WSOL_POOL');
  assert.equal(d.quoteMint, WSOL);
  assert.equal(d.quoteDecimals, 9);
  assert.equal(d.quoteProgram, LEGACY_TOKEN);
});

test('the accounts reader rejects a v6 window at the method gate but admits a v4 window past it', () => {
  const token = { chain: 'solana' as const, address: BOUNCER };
  const v6 = decodeAdvisoryWindowAccounts(token, base({ method: 'pumpswap-selected-pool-window-v6' }), empty as any, {}, {}, {}, cutoff);
  assert.equal(v6.complete, false);
  assert.equal(v6.reasonCode, 'ADVISORY_ACCOUNTS_WINDOW_INCOMPLETE');
  // A v4 window passes the method gate and only then fails for the missing window receipt, proving the
  // rejection above is method-specific and native v3/v4 scope does not regress.
  const v4 = decodeAdvisoryWindowAccounts(token, base({}), empty as any, {}, {}, {}, cutoff);
  assert.equal(v4.reasonCode, 'ADVISORY_ACCOUNTS_WINDOW_RECEIPT');
});
