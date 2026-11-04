import {assertEntryCliSnapshot} from './entry-cli-snapshot.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { collectAdvisoryWindow, decodeAdvisoryWindow, deriveO28Window, archiveAdvisoryWindowReceipts, unpackAdvisoryWindowReceipts, WINDOW_BUSY_REQUEST_CAP, WINDOW_BUSY_TRANSACTION_CAP, WINDOW_BUSY_STORED_BYTES, WINDOW_BUSY_SOURCE_BYTES } from '../src/providers/advisory-window.js';
import { archiveDemandReceipt } from '../src/providers/advisory-demand-windows.js';
import { collectLiveToken } from '../src/app/live.js';
import { Service } from '../src/app/service.js';
import { starterProfile } from '../src/app/config.js';
import { runCli } from '../src/cli.js';
import { busyWindowFixture } from './window-busy-fixtures.js';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const tape = async (count = 1061, busy = true) => { const f = await busyWindowFixture(count), set = await collectAdvisoryWindow(f.token, f.pool, 'https://rpc.example', f.fetcher, () => f.cutoff, f.end, undefined, undefined, true, true, true, true, true, true, true, busy); return { f, set }; };

test('busy O28 completes1061 constructed successful transactions; frozen1024profile stays capped', async () => {
  assert.deepEqual([WINDOW_BUSY_TRANSACTION_CAP, WINDOW_BUSY_REQUEST_CAP, WINDOW_BUSY_STORED_BYTES, WINDOW_BUSY_SOURCE_BYTES], [2048, 2069, 16_000_000, 128_000_000]);
  const { f, set } = await tape();
  assert.deepEqual([set.data.complete, set.data.successfulSignatures, set.data.failedReferences, set.data.trades.length, set.data.sellQuoteAtomic], [true, 1061, 2, 1061, '1061000']);
  assert.equal(set.data.acquisition?.version, 'window-dense-v3'); assert.equal(f.maxInFlight(), 2);
  assert.equal(deriveO28Window(set.data, []).quality, 'KNOWN');
  const archived = archiveAdvisoryWindowReceipts(set, true, true), plain = unpackAdvisoryWindowReceipts(archived, true, true);
  assert.deepEqual(plain.rawArtifacts, set.rawArtifacts);
  assert.throws(() => unpackAdvisoryWindowReceipts(archived, true), /ARCHIVE_MEMBERSHIP/);
  const old = await tape(1061, false); assert.equal(old.set.data.reasonCode, 'ADVISORY_WINDOW_TRANSACTION_CAP'); assert.equal(old.f.calls.filter(r => r.method === 'getTransaction').length, 0);
  const missing = structuredClone(set); delete missing.rawArtifacts['window-transaction-1060']; delete missing.requests['window-transaction-1060']; delete missing.retrievedAt['window-transaction-1060'];
  const decoded = decodeAdvisoryWindow(f.token, f.pool, f.end, missing.rawArtifacts, missing.retrievedAt, missing.requests, f.cutoff, true, true, true, true, true, true, true, true);
  assert.equal(decoded.complete, false); assert.notEqual(deriveO28Window(decoded, []).quality, 'KNOWN');
});

test('busy O28 caps2049references before transaction acquisition and requires the modern extended scope', async () => {
  const { f, set } = await tape(2049); assert.equal(set.data.reasonCode, 'ADVISORY_WINDOW_TRANSACTION_CAP'); assert.equal(f.calls.filter(r => r.method === 'getTransaction').length, 0);
  assert.throws(() => decodeAdvisoryWindow(f.token, f.pool, f.end, {}, {}, {}, f.cutoff, true, true, true, true, true, true, false, true), /BUSY_SCOPE/);
  assert.throws(() => archiveAdvisoryWindowReceipts({ rawArtifacts: {}, retrievedAt: {}, requests: {} }, false, true), /BUSY_SCOPE/);
});

test('busy archives retain9MB exactly and reject aggregate inflation before decoding any body', () => {
  const noise = Array.from({ length: 6250 }, (_, i) => sha(String(i))).join(''), plain = { rawArtifacts: {} as Record<string, string>, retrievedAt: {} as Record<string, string>, requests: {} as Record<string, { method: string; params: unknown[] }> };
  for (let i = 0; i < 32; i++) { const k = `window-transaction-${i}`; plain.rawArtifacts[k] = noise; plain.retrievedAt[k] = '2026-10-26T08:01:00.000Z'; plain.requests[k] = { method: 'getTransaction', params: [] }; }
  const stored = archiveAdvisoryWindowReceipts(plain, true, true); assert.ok(stored.storage.storedBytes > 8_000_000); assert.deepEqual(unpackAdvisoryWindowReceipts(stored, true, true).rawArtifacts, plain.rawArtifacts);
  assert.throws(() => archiveAdvisoryWindowReceipts(plain, true), /STORAGE_CAP/);
  const bomb = structuredClone(plain); for (let i = 0; i < 87; i++) { const k = `window-transaction-${i}`; bomb.rawArtifacts[k] = JSON.stringify({ ...JSON.parse(archiveDemandReceipt('x')), sourceBytes: 1_500_000 }); bomb.retrievedAt[k] = plain.retrievedAt['window-transaction-0']!; bomb.requests[k] = plain.requests['window-transaction-0']!; }
  assert.throws(() => unpackAdvisoryWindowReceipts(bomb, true, true), /STORAGE_CAP/);
});

test('proof48 persists over1000ownedwindowrecords, retains exact replay and rejects downgraded/orphan sources', async () => {
  const f = await busyWindowFixture(), b = await collectLiveToken(f.token, { profile: starterProfile(), semanticEnabled: false, advisoryEnabled: true, o28Expanded: true, fetcher: f.fetcher, now: () => f.cutoff });
  const proof = JSON.parse(b.rawArtifacts['advisory-derivation']!), metric = b.details!.advisory!.metrics.find(m => m.id === 'O28')!;
  assert.deepEqual([proof.method, b.details!.advisory!.method, metric.quality], ['advisory-provenance-v48', 'advisory-measurements-v47', 'KNOWN']); assert.ok(b.evidence.length > 1000); assert.equal(b.evidence.filter(e => e.sourceId === 'advisory-window').length, 1068);
  const directory = mkdtempSync(join(tmpdir(), 'o28-busy-')), file = join(directory, 'live.sqlite');
  try {
    let service = new Service(file), saved;
    try { saved = service.analyzeLive(b); assert.equal(service.analyzeLive(b).id, saved.id); assert.deepEqual(service.replay(saved.id), saved);
      const downgraded = structuredClone(b); const p = { ...proof, method: 'advisory-provenance-v40' }; delete p.executorSemantic; delete p.recordedCallers; delete p.recordedIncentives; downgraded.rawArtifacts['advisory-derivation'] = JSON.stringify(p); downgraded.evidence.find(e => e.id === 'advisory-derivation')!.contentHash = sha(downgraded.rawArtifacts['advisory-derivation']); assert.throws(() => service.analyzeLive(downgraded), /BUNDLE_LIMIT|ADVISORY_PROOF_INVALID/);
      const orphan = structuredClone(b); orphan.evidence.push({ ...orphan.evidence.find(e => e.sourceId === 'advisory-window')!, id: 'advisory-window-orphan' }); orphan.rawArtifacts['advisory-window-orphan'] = orphan.rawArtifacts['advisory-window-window-genesis']!; assert.throws(() => service.analyzeLive(orphan), /ADVISORY_PROOF_INVALID/);
    } finally { service.close(); }
    service = new Service(file); try { assert.deepEqual(service.replay(saved!.id), saved!); } finally { service.close(); }
    const db = new DatabaseSync(file); try { assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved!.id)!.semantic as string).policyVersion, 'research-screen-advisory-v45'); } finally { db.close(); }
    let output = '', error = '', network = 0; const code = await runCli(['replay', saved!.id, '--db', file, '--json'], { env: {}, isInteractive: false, fetcher: async () => { network++; throw Error('NETWORK_DENIED'); }, stdout: s => { output += s; }, stderr: s => { error += s; } }); assert.equal(code, 0, error); assertEntryCliSnapshot(JSON.parse(output),saved!); assert.equal(network, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI O28expanded requires explicit Solanaadvisory mode before network and persistence', async () => {
  let calls = 0, err = ''; const code = await runCli(['analyze', '11111111111111111111111111111111', '--chain', 'solana', '--partial', '--o28-expanded', '--json'], { env: {}, isInteractive: false, fetcher: async () => { calls++; throw Error('UNEXPECTED_NETWORK'); }, stdout: () => {}, stderr: s => { err += s; } });
  assert.equal(code, 2); assert.match(err, /O28_ADVISORY_REQUIRED/); assert.equal(calls, 0);
});

test('busy native reuse preserves historical index and transaction clocks while refreshing the final bank', async () => {
  const { f, set } = await tape(3), before = f.calls.length, later = '2026-10-26T10:01:00.000Z';
  const reused = await collectAdvisoryWindow(f.token, f.pool, 'https://rpc.example', f.fetcher, () => later, f.end, undefined, set, true, true, true, true, true, true, true, true);
  assert.equal(reused.data.complete, true); assert.equal(f.calls.length - before, 2);
  for (const k of ['window-genesis', 'window-anchor-slot', 'window-anchor-time', 'window-page-0', 'window-transaction-0']) { assert.equal(reused.rawArtifacts[k], set.rawArtifacts[k]); assert.equal(reused.retrievedAt[k], f.cutoff); }
  assert.equal(reused.retrievedAt['window-pool'], later); assert.equal(reused.data.window.end, f.end);
});

test('actual CLI analyze propagates O28expanded into proof48 and keeps the default proof40 path', async () => {
  const f = await busyWindowFixture(3), directory = mkdtempSync(join(tmpdir(), 'o28-cli-'));
  try {
    for (const expanded of [false, true]) {
      let output = '', error = '';
      const code = await runCli(['analyze', f.token.address, '--chain', 'solana', '--partial', '--advisory', ...(expanded ? ['--o28-expanded'] : []), '--db', join(directory, `${expanded}.sqlite`), '--config', join(directory, `${expanded}.json`), '--json'], { env: {}, isInteractive: false, fetcher: f.fetcher, now: () => f.cutoff, stdout: s => { output += s; }, stderr: s => { error += s; } });
      assert.equal(code, 0, error); const saved = JSON.parse(output), s = new Service(join(directory, `${expanded}.sqlite`));
      try { const raw = s.show(saved.id); assert.deepEqual(s.replay(saved.id), raw); assert.equal(raw.details!.advisory!.method, expanded ? 'advisory-measurements-v47' : 'advisory-measurements-v39'); assert.equal(raw.details!.advisory!.metrics.find(m => m.id === 'O28')!.quality, 'KNOWN'); } finally { s.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
