import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bundleSchema } from '../src/domain/contracts.js';

test('CLI example bundles are versioned sanitized fixtures with a matching token and uncalibrated profile', () => {
  const entry = bundleSchema.parse(JSON.parse(readFileSync('examples/entry.json', 'utf8')));
  const reassessment = bundleSchema.parse(JSON.parse(readFileSync('examples/reassessment.json', 'utf8')));

  assert.equal(entry.analysisKind, 'FIXTURE');
  assert.equal(entry.evidence[0]?.sourceType, 'FIXTURE');
  assert.equal(entry.evidence[0]?.scope.fixtureVersion, 1);
  assert.equal(entry.evidence[0]?.scope.calibratedForLiveUse, false);
  assert.equal(entry.profile.id, 'fixture-illustrative-uncalibrated');
  assert.equal(entry.token.address, 'FIXTURE_TOKEN');
  assert.deepEqual(reassessment.token, entry.token);
  assert.equal(reassessment.analysisKind, 'FIXTURE');
  assert.equal(reassessment.evidence[0]?.scope.fixtureVersion, 1);
  assert.equal(reassessment.thesis, undefined);
  assert.deepEqual(reassessment.observations.map(row => row.field).sort(), ['circulatingMarketCapUsd', 'tokenCreatedAt']);
});
