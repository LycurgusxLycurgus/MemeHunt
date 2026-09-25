import assert from 'node:assert/strict';
import test from 'node:test';
import { entryDefinitions, featureMetadata, managementDefinitions } from '../src/domain/catalog.js';

test('catalog exposes the complete stable checklist IDs and feature inventory', () => {
  const entryIds = [
    'ID-01', 'CTX-01', 'CAP-01', 'SEC-01', 'SEC-02', 'SEC-03', 'SEC-04', 'SEC-05',
    'LIQ-01', 'EXE-01', 'EXE-02', 'EXE-03', 'OWN-01', 'OWN-02', 'MKT-01',
    'NAR-01', 'NAR-02', 'NAR-03', 'CAN-01', 'CAN-02', 'ATT-01', 'ATT-02',
    'SOC-01', 'SOC-02', 'SOC-03', 'DAT-01', 'DAT-02', 'DAT-03',
    'ADV-01', 'ADV-02', 'ADV-03', 'ADV-04', 'ADV-05',
  ];
  const managementIds = Array.from({ length: 15 }, (_, i) => `MG-${String(i + 1).padStart(2, '0')}`);

  assert.deepEqual(entryDefinitions.map(x => x.checkId), entryIds);
  assert.deepEqual(managementDefinitions.map(x => x.checkId), managementIds);
  assert.equal(new Set(entryDefinitions.map(x => x.checkId)).size, 33);
  assert.equal(new Set(managementDefinitions.map(x => x.checkId)).size, 15);

  const allFeatures = new Set(featureMetadata.map(x => x.id));
  assert.equal(featureMetadata.length, 96);
  assert.equal(allFeatures.size, 96);
  assert.ok(featureMetadata.every(row => !('implemented' in row)), 'catalog metadata must not claim implementation');
  assert.ok(featureMetadata.every(row => row.family === ({ O: 'ONCHAIN', A: 'ATTENTION', S: 'SOCIAL', C: 'SHARED' } as const)[row.id[0] as 'O'|'A'|'S'|'C']));
  for (const row of entryDefinitions) {
    assert.ok(row.featureIds.length > 0, `${row.checkId} has no feature dependencies`);
    for (const featureId of row.featureIds) assert.ok(allFeatures.has(featureId), `${row.checkId} references ${featureId}`);
  }
});

test('entry rows preserve plan roles, requiredness, shared pillars, and expanded feature ranges', () => {
  const byId = new Map(entryDefinitions.map(x => [x.checkId, x]));
  for (const id of ['ID-01', 'SEC-01', 'EXE-02']) {
    assert.equal(byId.get(id)?.role, 'HARD_GATE');
    assert.equal(byId.get(id)?.required, true);
  }
  for (const id of ['CTX-01', 'CAP-01', 'NAR-02', 'ATT-02', 'SOC-03']) {
    assert.equal(byId.get(id)?.required, true);
  }
  for (const id of ['EXE-03', 'ADV-01', 'ADV-02', 'ADV-03', 'ADV-04', 'ADV-05']) {
    assert.equal(byId.get(id)?.role, 'ADVISORY');
    assert.equal(byId.get(id)?.required, false);
  }

  assert.equal(byId.get('ID-01')?.pillar, 'SHARED');
  assert.equal(byId.get('CAP-01')?.pillar, 'SHARED');
  assert.equal(byId.get('ATT-02')?.pillar, 'SHARED');
  assert.deepEqual(byId.get('EXE-02')?.featureIds, ['O13', 'O14', 'O15', 'O16']);
  assert.deepEqual(byId.get('SOC-02')?.featureIds, ['S02', 'S03', 'S04', 'S05', 'S06']);
  assert.deepEqual(byId.get('ADV-05')?.featureIds, ['C07', 'C08', 'C09', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16']);

  const expected = [
    ['ID-01','HARD_GATE','SHARED',true,['O01']], ['CTX-01','REQUIRED_EVIDENCE','SHARED',true,['C01']],
    ['CAP-01','REQUIRED_EVIDENCE','SHARED',true,['C02','O08']], ['SEC-01','HARD_GATE','ONCHAIN',true,['O03']],
    ['SEC-02','HARD_GATE','ONCHAIN',true,['O04','O06']], ['SEC-03','HARD_GATE','ONCHAIN',true,['O05']],
    ['SEC-04','HARD_GATE','ONCHAIN',true,['O07']], ['SEC-05','HARD_GATE','ONCHAIN',true,['O08']],
    ['LIQ-01','HARD_GATE','ONCHAIN',true,['O09']], ['EXE-01','HARD_GATE','ONCHAIN',true,['O10','O11']],
    ['EXE-02','HARD_GATE','ONCHAIN',true,['O13','O14','O15','O16']], ['EXE-03','ADVISORY','ONCHAIN',false,['O12']],
    ['OWN-01','REQUIRED_EVIDENCE','ONCHAIN',true,['O17','O18']], ['OWN-02','HARD_GATE','ONCHAIN',true,['O19','O20']],
    ['MKT-01','REQUIRED_EVIDENCE','ONCHAIN',true,['O02','O28']], ['NAR-01','REQUIRED_EVIDENCE','ATTENTION',true,['A01','A02']],
    ['NAR-02','OPPORTUNITY','ATTENTION',true,['A03','A04']], ['NAR-03','OPPORTUNITY','ATTENTION',true,['A05']],
    ['CAN-01','REQUIRED_EVIDENCE','ATTENTION',true,['A09','A10']], ['CAN-02','OPPORTUNITY','ATTENTION',true,['A11','A14']],
    ['ATT-01','REQUIRED_EVIDENCE','ATTENTION',true,['A15','A16','A17']], ['ATT-02','OPPORTUNITY','SHARED',true,['A18','S10']],
    ['SOC-01','REQUIRED_EVIDENCE','SOCIAL',true,['S01']], ['SOC-02','REQUIRED_EVIDENCE','SOCIAL',true,['S02','S03','S04','S05','S06']],
    ['SOC-03','OPPORTUNITY','SOCIAL',true,['S03','S10']], ['DAT-01','REQUIRED_EVIDENCE','SHARED',true,['C03','C04']],
    ['DAT-02','REQUIRED_EVIDENCE','SHARED',true,['C05']], ['DAT-03','REQUIRED_EVIDENCE','SHARED',true,['C06']],
    ['ADV-01','ADVISORY','ONCHAIN',false,['O21','O22','O23','O24','O25']], ['ADV-02','ADVISORY','ONCHAIN',false,['O26','O27','O28','O29','O30']],
    ['ADV-03','ADVISORY','ATTENTION',false,['A06','A07','A08','A12','A13','A19','A20','A21','A22','A23','A24','A25','A26','A27','A28','A29','A30']],
    ['ADV-04','ADVISORY','SOCIAL',false,['S07','S08','S09','S11','S12','S13','S14','S15','S16','S17','S18','S19','S20']],
    ['ADV-05','ADVISORY','SHARED',false,['C07','C08','C09','C10','C11','C12','C13','C14','C15','C16']],
  ];
  assert.deepEqual(entryDefinitions.map(x => [x.checkId,x.role,x.pillar,x.required,x.featureIds]), expected);
});

test('management rows retain their separate role and requiredFor namespaces', () => {
  const byId = new Map(managementDefinitions.map(x => [x.checkId, x]));
  assert.deepEqual(byId.get('MG-02'), { checkId: 'MG-02', managementRole: 'SAFETY', requiredFor: 'THESIS' });
  assert.deepEqual(byId.get('MG-05'), { checkId: 'MG-05', managementRole: 'CONTEXT', requiredFor: 'CONTEXT' });
  assert.deepEqual(byId.get('MG-09'), { checkId: 'MG-09', managementRole: 'TRACTION', requiredFor: 'QUANTIFIED_PROPOSAL' });
  assert.deepEqual(byId.get('MG-11'), { checkId: 'MG-11', managementRole: 'WARNING', requiredFor: 'WARNING' });
  assert.deepEqual(byId.get('MG-13'), { checkId: 'MG-13', managementRole: 'REQUIRED_FOR_QUANTIFIED_PROPOSAL', requiredFor: 'QUANTIFIED_PROPOSAL' });
  assert.deepEqual(managementDefinitions.map(x => [x.checkId,x.managementRole,x.requiredFor]), [
    ['MG-01','REQUIRED_EVIDENCE','THESIS'], ['MG-02','SAFETY','THESIS'], ['MG-03','SAFETY','THESIS'],
    ['MG-04','REQUIRED_EVIDENCE','THESIS'], ['MG-05','CONTEXT','CONTEXT'], ['MG-06','VALIDATION','THESIS'],
    ['MG-07','INVALIDATION','THESIS'], ['MG-08','VALIDATION','THESIS'], ['MG-09','TRACTION','QUANTIFIED_PROPOSAL'],
    ['MG-10','TRACTION','QUANTIFIED_PROPOSAL'], ['MG-11','WARNING','WARNING'], ['MG-12','REALIZATION','QUANTIFIED_PROPOSAL'],
    ['MG-13','REQUIRED_FOR_QUANTIFIED_PROPOSAL','QUANTIFIED_PROPOSAL'], ['MG-14','INVALIDATION','THESIS'],
    ['MG-15','REQUIRED_FOR_QUANTIFIED_PROPOSAL','QUANTIFIED_PROPOSAL'],
  ]);
});
