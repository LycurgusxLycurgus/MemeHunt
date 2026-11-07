import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveFastChecklist,
  fastPolicyId,
  fastRequiredCheckIds,
  type FastOutcome,
} from '../src/domain/fast-checklist.js';

const allSupported = () => fastRequiredCheckIds.map(checkId => ({ checkId, outcome: 'SUPPORTED' as const }));

test('stable FAST evaluates the complete checklist under research-fast-v3', () => {
  const result = deriveFastChecklist(allSupported());
  assert.equal(fastPolicyId, 'research-fast-v3');
  assert.equal(result.policyId, 'research-fast-v3');
  assert.equal(result.classification, 'FAST_SHORTLIST');
  assert.equal(result.coverage.known, 20);
  assert.equal(result.coverage.total, 20);
  assert.equal(result.rows.length, 20);
  assert.ok(result.rows.every(row => row.outcome === 'SUPPORTED'));
  assert.equal('notEvaluatedCheckIds' in result, false);
});

test('shortlist requires every decision to be SUPPORTED', async t => {
  for (const [checkId, outcome, expected] of [
    ['NAR-01', 'UNKNOWN', 'FAST_UNAVAILABLE'],
    ['SEC-01', 'UNKNOWN', 'FAST_UNAVAILABLE'],
    ['ADV-03', 'INSUFFICIENT', 'FAST_REJECTED'],
    ['EXE-02', 'CONTRADICTED', 'FAST_REJECTED'],
  ] as const) await t.test(`${checkId} ${outcome}`, () => {
    const rows = allSupported().map(row => row.checkId === checkId ? { ...row, outcome } : row);
    const result = deriveFastChecklist(rows);
    assert.equal(result.classification, expected);
    assert.equal(result.rows.find(row => row.checkId === checkId)?.outcome, outcome);
    assert.equal(result.coverage.known, outcome === 'UNKNOWN' ? 19 : 20);
  });
});

test('an actual negative rejects while preserving an unrelated unknown result', () => {
  const rows = allSupported().map(row => row.checkId === 'SEC-01'
    ? { ...row, outcome: 'CONTRADICTED' as const }
    : row.checkId === 'SEC-02' ? { ...row, outcome: 'UNKNOWN' as const } : row);
  const result = deriveFastChecklist(rows);
  assert.equal(result.classification, 'FAST_REJECTED');
  assert.equal(result.coverage.known, 19);
  assert.equal(result.rows.find(row => row.checkId === 'SEC-02')?.outcome, 'UNKNOWN');
});

test('coverage counts evaluated UNKNOWN rows as unknown rather than known', () => {
  const rows = allSupported().map(row => row.checkId === 'ADV-03'
    ? { ...row, outcome: 'UNKNOWN' as const }
    : row.checkId === 'SEC-01' ? { ...row, outcome: 'INSUFFICIENT' as const } : row);
  const result = deriveFastChecklist(rows);
  assert.equal(result.classification, 'FAST_REJECTED');
  assert.equal(result.coverage.known, 19);
  assert.equal(result.coverage.total, 20);
  assert.equal(result.rows.find(row => row.checkId === 'ADV-03')?.outcome, 'UNKNOWN');
  assert.equal(result.rows.find(row => row.checkId === 'SEC-01')?.outcome, 'INSUFFICIENT');
});

test('duplicate, omitted, or out-of-manifest IDs fail closed', () => {
  assert.throws(() => deriveFastChecklist([
    { checkId: 'NAR-01', outcome: 'SUPPORTED' },
    { checkId: 'NAR-01', outcome: 'CONTRADICTED' },
  ]), /FAST_CHECKLIST_SCOPE_INVALID/);
  assert.throws(() => deriveFastChecklist(allSupported().slice(1)), /FAST_CHECKLIST_SCOPE_INVALID/);
  assert.throws(() => deriveFastChecklist(allSupported().map(row => ({ ...row, checkId: row.checkId === 'NAR-01' ? 'A01' : row.checkId }))), /FAST_CHECKLIST_SCOPE_INVALID/);
  assert.throws(() => deriveFastChecklist([{ checkId: 'NAR-02', outcome: 'SUPPORTED' }]), /FAST_CHECKLIST_SCOPE_INVALID/);
});

test('every classification keeps binary FAIL and does not mutate its input rows', () => {
  const supported = Object.freeze(allSupported().map(row => Object.freeze(row)));
  const before = structuredClone(supported);
  const shortlist = deriveFastChecklist(supported);
  assert.equal(shortlist.binary, 'FAIL');
  assert.deepEqual(supported, before);

  const rejectedRows = allSupported().map(row => row.checkId === 'SEC-01' ? { ...row, outcome: 'CONTRADICTED' as const } : row);
  const unknownRows = allSupported().map(row => row.checkId === 'SEC-01' ? { ...row, outcome: 'UNKNOWN' as const } : row);
  const rejected = deriveFastChecklist(rejectedRows);
  const unavailable = deriveFastChecklist(unknownRows);
  assert.equal(rejected.binary, 'FAIL');
  assert.equal(unavailable.binary, 'FAIL');
  assert.equal(rejected.classification, 'FAST_REJECTED');
  assert.equal(unavailable.classification, 'FAST_UNAVAILABLE');
});

test('the helper rejects a runtime outcome outside its typed contract', () => {
  const rows: Array<{ checkId: string; outcome: FastOutcome }> = allSupported();
  rows[0] = { checkId: 'NAR-01', outcome: 'PASS' as FastOutcome };
  assert.throws(() => deriveFastChecklist(rows), /FAST_CHECKLIST_SCOPE_INVALID/);
});
