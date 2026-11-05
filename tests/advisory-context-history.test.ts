import assert from 'node:assert/strict';
import test from 'node:test';
import { collectAdvisoryContextHistory, decodeAdvisoryContextHistory } from '../src/providers/advisory-context-history.js';

const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const cutoff = '2026-10-11T12:00:00.000Z';
function transfer(sequence = '1', fromChain = 2, toChain = 1): any {
  const emitter = 'a'.repeat(64);
  return { id: `${fromChain}/${emitter}/${sequence}`, emitterChain: fromChain, emitterAddress: { hex: emitter }, sequence,
    content: { standarizedProperties: { fromChain, toChain, tokenChain: 2, tokenAddress: 'asset', amount: '200000000', normalizedDecimals: 8 } },
    sourceChain: { chainId: fromChain, status: 'confirmed', timestamp: '2026-10-11T11:00:00Z', transaction: { txHash: 'source-tx' } },
    targetChain: { chainId: toChain, status: 'completed', timestamp: '2026-10-11T11:01:00Z', transaction: { txHash: 'target-tx' } },
    data: { tokenAmount: '2', usdAmount: '20' } };
}
const collect = (pages: any[][]) => collectAdvisoryContextHistory(token, async input => {
  const page = Number(new URL(String(input)).searchParams.get('page'));
  return new Response(JSON.stringify({ operations: pages[page] ?? [] }));
}, () => cutoff);

test('bounded canonical bridge samples replay offline and never claim complete net flow or verified valuation/finality', async () => {
  const run = await collect([[transfer(), transfer('2', 1, 2)], [transfer()]]);
  assert.equal(Object.keys(run.requests).length, 2);
  assert.equal(run.data.bridge.transfers.length, 2);
  assert.equal(run.data.bridge.duplicateRecords, 1);
  assert.equal(run.data.bridge.complete, false);
  assert.equal(run.data.bridge.finalityVerified, false);
  assert.equal(run.data.bridge.valuationVerified, false);
  assert.deepEqual(run.data.bridge.providerReportedUsd, { inflow: '20', outflow: '20' });
  assert.ok(run.data.missingCauses.C12);
  assert.ok(run.data.missingCauses.C16);
  assert.deepEqual(decodeAdvisoryContextHistory(token, run.rawArtifacts, run.retrievedAt, run.requests), run.data);
});

test('wrong direction identity, unrelated chains, incomplete messages and future completion cannot enter sample subtotals', async () => {
  const wrong = transfer('2'); wrong.targetChain.chainId = 4;
  const incomplete = transfer('3'); delete incomplete.targetChain;
  const future = transfer('4'); future.targetChain.timestamp = '2026-10-12T00:00:00Z';
  const message = transfer('5'); message.content.standarizedProperties.fromChain = 0;
  const run = await collect([[wrong, incomplete, future, message, transfer('6', 2, 4)], []]);
  assert.equal(run.data.bridge.transfers.length, 0);
  assert.deepEqual(run.data.bridge.providerReportedUsd, { inflow: '0', outflow: '0' });
  assert.equal(run.data.bridge.excluded.CONTEXT_TRANSFER_BINDING, 1);
  assert.equal(run.data.bridge.excluded.NOT_PROVIDER_COMPLETED, 1);
  assert.equal(run.data.bridge.excluded.CONTEXT_RECORD_TIME, 1);
  assert.equal(run.data.bridge.excluded.NON_TRANSFER_MESSAGE, 1);
  assert.equal(run.data.bridge.excluded.OTHER_CHAIN, 1);
});

test('duplicate conflicting canonical transfer is removed rather than counted twice or selecting a convenient version', async () => {
  const original = transfer(), conflict = transfer(); conflict.data.usdAmount = '200';
  const run = await collect([[original], [conflict]]);
  assert.equal(run.data.bridge.transfers.length, 0);
  assert.equal(run.data.bridge.excluded.CONTEXT_DUPLICATE_CONFLICT, 1);
});

test('missing and inconsistent valuation retains completed record without adding it to provider dollar subtotals', async () => {
  const noValue = transfer(); delete noValue.data;
  const inconsistent = transfer('2'); inconsistent.data.tokenAmount = '200';
  const run = await collect([[noValue, inconsistent], []]);
  assert.equal(run.data.bridge.transfers.length, 2);
  assert.ok(run.data.bridge.transfers.every(record => record.providerUsd === null));
  assert.equal(run.data.bridge.providerReportedUsd.inflow, '0');
});

test('noncanonical VAA ID and invalid amount normalization do not manufacture trade quantities', async () => {
  const wrongId = transfer(); wrongId.id = 'another-id';
  const wrongAmount = transfer('2'); wrongAmount.content.standarizedProperties.normalizedDecimals = -1;
  const run = await collect([[wrongId, wrongAmount], []]);
  assert.equal(run.data.bridge.transfers.length, 1);
  assert.equal(run.data.bridge.transfers[0]?.amount, null);
  assert.equal(run.data.bridge.transfers[0]?.providerUsd, null);
  assert.equal(run.data.bridge.excluded.CONTEXT_CANONICAL_ID, 1);
});

test('fixed endpoint catalog cannot be substituted or truncated on replay', async () => {
  const run = await collect([[], []]);
  assert.throws(() => decodeAdvisoryContextHistory(token, run.rawArtifacts, run.retrievedAt,
    { ...run.requests, 'bridge-page-0': { url: 'https://example.com' } }), /CONTEXT_REQUEST_SCOPE/);
  const raw = { ...run.rawArtifacts }; delete raw['bridge-page-1'];
  assert.throws(() => decodeAdvisoryContextHistory(token, raw, run.retrievedAt, run.requests), /CONTEXT_REQUEST_SCOPE/);
});

test('HTTP failure and malformed oversized page remain retained missing evidence, never imply zero flow', async () => {
  const http = await collectAdvisoryContextHistory(token, async () => new Response('unavailable', { status: 503 }), () => cutoff);
  assert.equal(http.data.missingCauses['bridge-page-0'], 'CONTEXT_HTTP_UNAVAILABLE');
  assert.equal(JSON.parse(http.rawArtifacts['bridge-page-0']!).body, 'unavailable');
  const oversized = await collect([Array.from({ length: 101 }, (_, index) => transfer(String(index))), []]);
  assert.equal(oversized.data.missingCauses['bridge-page-0'], 'CONTEXT_RESPONSE_INVALID');
  assert.equal(oversized.data.bridge.complete, false);
});

test('transport failures are sanitized and retained with retrieval clock', async () => {
  const run = await collectAdvisoryContextHistory(token, async () => { throw new Error('secret URL'); }, () => cutoff);
  assert.equal(run.retrievedAt, cutoff);
  assert.equal(run.rawArtifacts['bridge-page-0'], '{"code":"CONTEXT_TRANSPORT"}');
  assert.equal(run.data.missingCauses['bridge-page-0'], 'CONTEXT_TRANSPORT');
});
