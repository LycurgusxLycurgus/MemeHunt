import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Service } from '../src/app/service.js';
import type { Bundle, Thesis, ThesisEpisode } from '../src/domain/contracts.js';
import { completeFixtureEntryFeatures, fixtureBundle, illustrativeFixtureThesis } from '../examples/fixtures.js';

const JAN_1 = '2026-01-01T00:00:00.000Z';
const JAN_2 = '2026-01-02T00:00:00.000Z';
const JAN_3 = '2026-01-03T00:00:00.000Z';

function bundleAt(cutoff: string, thesis?: Thesis, features = completeFixtureEntryFeatures()): Bundle {
  return { ...fixtureBundle(features, thesis), cutoff };
}

function thesisInvalidatedByO03(value: boolean): Thesis {
  return {
    ...illustrativeFixtureThesis,
    invalidation: [{ op: 'eq', feature: 'O03', value, unit: 'bool' }],
  };
}

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'successor-cutoff-'));
  return { directory, file: join(directory, 'dd.sqlite') };
}

test('future thesis successor cannot change historical reassessment and remains stable after reopen', () => {
  const temp = temporaryDatabase();
  let service: Service | undefined = new Service(temp.file);
  try {
    const entry = service.analyze(bundleAt(JAN_1, illustrativeFixtureThesis));
    assert.equal(entry.result.binary, 'PASS');
    assert.equal(entry.result.classification, 'RESEARCH_ELIGIBLE');
    const tracked = service.caseFor(entry.token);
    assert.ok(tracked?.episodeId);
    const initialEpisode = service.episode(tracked.episodeId);

    const beforeBundle = bundleAt('2026-01-01T12:00:00.000Z');
    const before = service.reassess(entry.caseId, beforeBundle);
    assert.equal(before.result.thesisState, 'INVALIDATED');
    assert.equal(before.result.proposal, 'EXIT_REVIEW');

    const successor = service.successor(entry.caseId, thesisInvalidatedByO03(false), JAN_2);
    assert.equal(service.caseFor(entry.token)?.episodeId, successor.id);
    assert.deepEqual(service.episode(initialEpisode.id), initialEpisode);

    const historicalAgain = service.reassess(entry.caseId, beforeBundle);
    assert.deepEqual(historicalAgain, before);

    const after = service.reassess(entry.caseId, bundleAt(JAN_2));
    assert.equal(after.episodeId, successor.id);
    assert.equal(after.baselineSnapshotId, entry.id);
    assert.equal(after.result.thesisState, 'VALIDATED');

    service.close();
    service = undefined;
    service = new Service(temp.file);

    assert.deepEqual(service.show(entry.id), entry);
    assert.deepEqual(service.replay(entry.id), entry);
    assert.deepEqual(service.show(before.id), before);
    assert.deepEqual(service.replay(before.id), before);
    assert.deepEqual(service.show(after.id), after);
    assert.deepEqual(service.replay(after.id), after);
    assert.deepEqual(service.reassess(entry.caseId, beforeBundle), before);
    assert.deepEqual(service.reassess(entry.caseId, bundleAt(JAN_2)), after);
    assert.equal(service.caseFor(entry.token)?.episodeId, successor.id);
  } finally {
    service?.close();
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test('successive episodes resolve intermediate cutoffs to the matching thesis', () => {
  const service = new Service(':memory:');
  try {
    const entry = service.analyze(bundleAt(JAN_1, thesisInvalidatedByO03(true)));
    const initialId = service.caseFor(entry.token)?.episodeId;
    assert.ok(initialId);

    const second = service.successor(entry.caseId, thesisInvalidatedByO03(false), JAN_2);
    const third = service.successor(entry.caseId, thesisInvalidatedByO03(true), JAN_3);

    const firstPeriod = service.reassess(entry.caseId, bundleAt('2026-01-01T12:00:00.000Z'));
    const secondPeriod = service.reassess(entry.caseId, bundleAt('2026-01-02T12:00:00.000Z'));
    const thirdPeriod = service.reassess(entry.caseId, bundleAt(JAN_3));

    assert.equal(firstPeriod.episodeId, initialId);
    assert.equal(firstPeriod.result.thesisState, 'INVALIDATED');
    assert.equal(secondPeriod.episodeId, second.id);
    assert.equal(secondPeriod.result.thesisState, 'VALIDATED');
    assert.equal(thirdPeriod.episodeId, third.id);
    assert.equal(thirdPeriod.result.thesisState, 'INVALIDATED');
    for (const snapshot of [firstPeriod, secondPeriod, thirdPeriod]) {
      assert.equal(snapshot.baselineSnapshotId, entry.id);
    }
    assert.equal(service.caseFor(entry.token)?.episodeId, third.id);
  } finally {
    service.close();
  }
});

test('cutoff before initial thesis fails closed while existing inactive-case guards remain', () => {
  const service = new Service(':memory:');
  try {
    const entry = service.analyze(bundleAt(JAN_2, illustrativeFixtureThesis));
    const beforeInitial = bundleAt('2026-01-01T12:00:00.000Z');
    assert.throws(() => service.reassess(entry.caseId, beforeInitial), { message: 'NO_THESIS_AT_CUTOFF' });

    const atInitial = service.reassess(entry.caseId, bundleAt(JAN_2));
    assert.equal(atInitial.episodeId, service.caseFor(entry.token)?.episodeId);
    assert.equal(atInitial.baselineSnapshotId, entry.id);

    assert.throws(() => service.reassess('unknown-case', beforeInitial), { message: 'CASE_NOT_FOUND' });
    assert.throws(
      () => service.reassess(entry.caseId, { ...beforeInitial, token: { ...beforeInitial.token, address: 'OTHER_FIXTURE_TOKEN' } }),
      { message: 'TOKEN_CASE_MISMATCH' },
    );

    const failedInput = {
      ...bundleAt(JAN_1, undefined, []),
      token: { chain: 'solana' as const, address: 'FIXTURE_WITHOUT_THESIS' },
    };
    const failedEntry = service.analyze(failedInput);
    const failedCase = service.caseFor(failedEntry.token);
    assert.ok(failedCase);
    const failedManagementBundle = { ...bundleAt(JAN_1), token: failedInput.token };
    assert.throws(() => service.reassess(failedCase.id, failedManagementBundle), { message: 'NO_ACTIVE_THESIS' });
  } finally {
    service.close();
  }
});

test('successor ordering compares instants and rejected successors leave history unchanged', () => {
  const service = new Service(':memory:');
  try {
    const entry = service.analyze(bundleAt(JAN_1, illustrativeFixtureThesis));
    const offsetSuccessorAt = '2025-12-31T20:00:00-05:00';
    const successor = service.successor(entry.caseId, thesisInvalidatedByO03(false), offsetSuccessorAt);

    const beforeSuccessor = service.reassess(entry.caseId, bundleAt('2026-01-01T00:30:00.000Z'));
    const atSuccessor = service.reassess(entry.caseId, bundleAt(offsetSuccessorAt));
    assert.ok(offsetSuccessorAt < JAN_1, 'the successor timestamp sorts lexically before its predecessor');
    assert.ok(Date.parse(offsetSuccessorAt) > Date.parse(JAN_1), 'the successor instant is after its predecessor');
    assert.equal(beforeSuccessor.episodeId, service.episode(successor.id).supersedesEpisodeId);
    assert.equal(beforeSuccessor.result.thesisState, 'INVALIDATED');
    assert.equal(atSuccessor.episodeId, successor.id);
    assert.equal(atSuccessor.result.thesisState, 'VALIDATED');

    const rejectedTimes = ['2026-01-01T01:00:00.000Z', '2026-01-01T00:59:59.000Z'];
    for (const at of rejectedTimes) {
      assert.throws(() => service.successor(entry.caseId, thesisInvalidatedByO03(true), at), {
        message: 'SUCCESSOR_TIME_NOT_AFTER_PREDECESSOR',
      });
      assert.equal(service.caseFor(entry.token)?.episodeId, successor.id);
      assert.deepEqual(service.show(beforeSuccessor.id), beforeSuccessor);
      assert.deepEqual(service.replay(beforeSuccessor.id), beforeSuccessor);
      assert.deepEqual(service.show(atSuccessor.id), atSuccessor);
      assert.deepEqual(service.replay(atSuccessor.id), atSuccessor);
      assert.deepEqual(service.episode(successor.id), successor);
    }

    assert.throws(() => service.successor(entry.caseId, thesisInvalidatedByO03(true), 'not-a-time'), {
      message: 'INVALID_SUCCESSOR_TIME',
    });
    assert.equal(service.caseFor(entry.token)?.episodeId, successor.id);

    const later = service.successor(entry.caseId, thesisInvalidatedByO03(true), '2026-01-01T01:00:01.000Z');
    assert.equal(later.supersedesEpisodeId, successor.id);
    assert.equal(service.caseFor(entry.token)?.episodeId, later.id);
  } finally {
    service.close();
  }
});

test('legacy non-increasing episode timeline fails closed without changing saved entry replay', () => {
  const temp = temporaryDatabase();
  let service: Service | undefined = new Service(temp.file);
  try {
    const entry = service.analyze(bundleAt(JAN_1, illustrativeFixtureThesis));
    const initialId = service.caseFor(entry.token)?.episodeId;
    assert.ok(initialId);
    service.close();
    service = undefined;

    const db = new DatabaseSync(temp.file);
    try {
      const row = db.prepare('SELECT payload FROM episodes WHERE id=?').get(initialId) as { payload: string } | undefined;
      assert.ok(row);
      const initial = JSON.parse(String(row.payload)) as ThesisEpisode;
      const legacy: ThesisEpisode = {
        ...initial,
        id: randomUUID(),
        createdAt: initial.createdAt,
        supersedesEpisodeId: initial.id,
      };
      db.prepare('INSERT INTO episodes(id,case_id,payload) VALUES(?,?,?)').run(legacy.id, legacy.caseId, JSON.stringify(legacy));
      db.prepare('UPDATE cases SET episode_id=? WHERE id=?').run(legacy.id, legacy.caseId);
    } finally {
      db.close();
    }

    const reopened = new Service(temp.file);
    service = reopened;
    assert.throws(() => reopened.reassess(entry.caseId, bundleAt('2026-01-01T12:00:00.000Z')), {
      message: 'INVALID_EPISODE_TIMELINE',
    });
    assert.throws(() => reopened.successor(entry.caseId, thesisInvalidatedByO03(false), JAN_3), {
      message: 'INVALID_EPISODE_TIMELINE',
    });
    assert.deepEqual(reopened.show(entry.id), entry);
    assert.deepEqual(reopened.replay(entry.id), entry);
  } finally {
    service?.close();
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test('closed cases reject new historical management while saved snapshots still replay', () => {
  const service = new Service(':memory:');
  try {
    const entry = service.analyze(bundleAt(JAN_1, illustrativeFixtureThesis));
    const oldBundle = bundleAt('2026-01-01T12:00:00.000Z');
    const management = service.reassess(entry.caseId, oldBundle);
    const successor = service.successor(entry.caseId, thesisInvalidatedByO03(false), JAN_2);

    service.closeCase(entry.caseId);
    assert.throws(() => service.reassess(entry.caseId, oldBundle), { message: 'NO_ACTIVE_THESIS' });
    assert.throws(() => service.successor(entry.caseId, thesisInvalidatedByO03(true), JAN_3), { message: 'NO_ACTIVE_THESIS' });
    assert.equal(service.caseFor(entry.token)?.episodeId, successor.id);
    assert.deepEqual(service.show(management.id), management);
    assert.deepEqual(service.replay(management.id), management);
  } finally {
    service.close();
  }
});
