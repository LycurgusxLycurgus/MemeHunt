import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { bundleSchema, positionEventSchema, positionRecordSchema, thesisSchema, type Bundle, type EntrySnapshot, type ManagementSnapshot, type PositionEvent, type PositionRecord, type Thesis, type ThesisEpisode, type TokenRef } from '../domain/contracts.js';
import { evaluateEntry, evaluateManagement, evaluatePredicate, type StageInputs } from '../domain/policy.js';
import { reduceLedger } from '../domain/ledger.js';

function stable(v: unknown): string {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('NONFINITE_NUMBER'); return JSON.stringify(v); }
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v === 'object' && v) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  throw new Error('UNSERIALIZABLE_VALUE');
}
export const decisionHash = (v: unknown) => createHash('sha256').update(stable(v)).digest('hex');
const tokenKey = (t: TokenRef) => `${t.chain}:${t.address}`;
const normalizeToken = (t: TokenRef, fixture: boolean): TokenRef => {
  if (fixture) return t;
  if (t.chain === 'solana') { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.address)) throw new Error('INVALID_SOLANA_ADDRESS'); return t; }
  if (!/^0x[a-fA-F0-9]{40}$/.test(t.address)) throw new Error('INVALID_EVM_ADDRESS');
  return { ...t, address: t.address.toLowerCase() };
};
const readJson = <T>(v: unknown): T => JSON.parse(String(v)) as T;
const directOnly = new Set(['O01','O03','O04','O05','O06','O07','O08','O09','O10','O11','O12','O13','O14','O15','O16','O17','O18','O19','O20','C02']);
const policyFeatures = (b: Bundle) => b.analysisKind === 'FIXTURE' ? b.features : b.features.map(f => directOnly.has(f.id) && f.quality === 'KNOWN' ? { ...f, quality: 'MISSING' as const } : f);
const stageInputs = (b: Bundle): StageInputs => {
  if (b.analysisKind !== 'FIXTURE') return { circulatingMarketCapUsd: null, tokenCreatedAt: null };
  const value = (field: string) => b.observations.find(o => o.field === field && o.quality === 'KNOWN' && Date.parse(o.availableAt) <= Date.parse(b.cutoff))?.value;
  const cap = value('circulatingMarketCapUsd'), created = value('tokenCreatedAt');
  return { circulatingMarketCapUsd: typeof cap === 'string' ? cap : null, tokenCreatedAt: typeof created === 'string' ? created : null };
};

export class Service {
  private db: DatabaseSync;
  private artifactDir: string;
  constructor(file = '.data/dd.sqlite') {
    mkdirSync(dirname(file), { recursive: true });
    this.artifactDir = join(dirname(file), 'artifacts');
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, hash TEXT NOT NULL, semantic TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, token_key TEXT NOT NULL UNIQUE, token_json TEXT NOT NULL, status TEXT NOT NULL, episode_id TEXT);
      CREATE TABLE IF NOT EXISTS episodes(id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS positions(id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS position_events(id TEXT PRIMARY KEY, position_id TEXT NOT NULL REFERENCES positions(id), idempotency_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal(id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), at TEXT NOT NULL, text TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS snapshots_no_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SNAPSHOT'); END;
      CREATE TRIGGER IF NOT EXISTS snapshots_no_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SNAPSHOT'); END;
      CREATE TRIGGER IF NOT EXISTS episodes_no_update BEFORE UPDATE ON episodes BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EPISODE'); END;
      CREATE TRIGGER IF NOT EXISTS episodes_no_delete BEFORE DELETE ON episodes BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EPISODE'); END;`);
  }
  close() { this.db.close(); }
  private validateBundle(input: Bundle): Bundle {
    const parsed = bundleSchema.parse(input);
    const b: Bundle = { ...parsed, token: normalizeToken(parsed.token, parsed.analysisKind === 'FIXTURE') };
    if (b.analysisKind === 'MANUAL_EMPTY' && (b.evidence.length || b.features.length || b.observations.length)) throw new Error('MANUAL_EMPTY_MUST_BE_EMPTY');
    if (b.evidence.length > 1000 || b.features.length > 1000 || b.observations.length > 1000) throw new Error('BUNDLE_LIMIT');
    const ids = new Set(b.evidence.map(e => e.id));
    if (ids.size !== b.evidence.length || new Set(b.features.map(f => f.id)).size !== b.features.length) throw new Error('DUPLICATE_BUNDLE_ID');
    for (const e of b.evidence) if (Date.parse(e.availableAt) > Date.parse(b.cutoff) || Date.parse(e.retrievedAt) > Date.parse(b.cutoff)) throw new Error('FUTURE_EVIDENCE');
    if (b.rawArtifacts && Object.keys(b.rawArtifacts).some(id => !ids.has(id))) throw new Error('UNREFERENCED_ARTIFACT');
    if (b.analysisKind === 'USER_IMPORT' && b.evidence.some(e => b.rawArtifacts?.[e.id] === undefined)) throw new Error('RAW_ARTIFACT_REQUIRED');
    let artifactBytes = 0;
    for (const e of b.evidence) if (b.rawArtifacts?.[e.id] !== undefined) {
      const raw = b.rawArtifacts[e.id]; artifactBytes += Buffer.byteLength(raw);
      if (artifactBytes > 2_000_000 || createHash('sha256').update(raw).digest('hex') !== e.contentHash) throw new Error('ARTIFACT_HASH_OR_SIZE');
    }
    for (const e of b.evidence) if (e.accessMode !== 'USER_IMPORT' && b.analysisKind !== 'FIXTURE') throw new Error('IMPORT_PROVENANCE_FORGED');
    for (const f of b.features) {
      if (f.evidenceIds.some(id => !ids.has(id))) throw new Error('UNKNOWN_EVIDENCE_REF');
      if (Date.parse(f.availableAt) > Date.parse(b.cutoff)) throw new Error('FUTURE_FEATURE');
    }
    for (const o of b.observations) {
      if (tokenKey(o.subject) !== tokenKey(b.token) || o.evidenceIds.some(id => !ids.has(id))) throw new Error('INVALID_OBSERVATION_REF');
      if (Date.parse(o.availableAt) > Date.parse(b.cutoff)) throw new Error('FUTURE_OBSERVATION');
    }
    if (b.thesis) {
      for (const p of [...b.thesis.support,...b.thesis.invalidation,...[b.thesis.catalyst,b.thesis.onchainTraction,b.thesis.externalTraction,b.thesis.warning].filter(x => x !== null),...b.thesis.legs.map(l => l.trigger)]) evaluatePredicate(p,[],b.cutoff);
    }
    return b;
  }
  private persistArtifacts(b: Bundle) {
    if (!b.rawArtifacts) return;
    mkdirSync(this.artifactDir,{ recursive: true });
    for (const e of b.evidence) {
      const raw = b.rawArtifacts[e.id]; if (raw === undefined) continue;
      const final = join(this.artifactDir,e.contentHash);
      if (existsSync(final)) continue;
      const temp = join(this.artifactDir,`${e.contentHash}.${randomUUID()}.tmp`);
      writeFileSync(temp,raw,{ flag:'wx' }); renameSync(temp,final);
    }
  }
  private transact<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const v = fn(); this.db.exec('COMMIT'); return v; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  caseFor(token: TokenRef): { id: string; status: string; episodeId: string | null } | null {
    const row = this.db.prepare('SELECT id,status,episode_id FROM cases WHERE token_key=?').get(tokenKey(token));
    return row ? { id: String(row.id), status: String(row.status), episodeId: row.episode_id ? String(row.episode_id) : null } : null;
  }
  analyze(input: Bundle): EntrySnapshot {
    const b = this.validateBundle(input); this.persistArtifacts(b); const result = evaluateEntry(policyFeatures(b), b.profile, b.cutoff);
    if (result.binary === 'PASS' && !b.thesis) throw new Error('PASS_REQUIRES_FROZEN_THESIS');
    const semantic = { schemaVersion: 1, policyVersion: 'research-screen-v0', featureVersion: 1, token: b.token, cutoff: b.cutoff, analysisKind: b.analysisKind, features: b.features, evidence: b.evidence, profile: b.profile, thesis: b.thesis ?? null, result };
    const hash = decisionHash(semantic);
    const existing = this.db.prepare('SELECT payload FROM snapshots WHERE hash=? AND kind=?').get(hash, 'ENTRY');
    if (existing) return readJson<EntrySnapshot>(existing.payload);
    return this.transact(() => {
      const id = randomUUID();
      let c = this.caseFor(b.token);
      if (!c) { const caseId = randomUUID(); this.db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run(caseId, tokenKey(b.token), JSON.stringify(b.token), 'INITIAL_RESEARCH', null); c = { id: caseId, status: 'INITIAL_RESEARCH', episodeId: null }; }
      const snapshot: EntrySnapshot = { id, caseId: c.id, checklistKind: 'ENTRY', token: b.token, cutoff: b.cutoff, analysisKind: b.analysisKind, features: b.features, evidence: b.evidence, result, hash };
      this.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?)').run(id, 'ENTRY', JSON.stringify(snapshot), hash, JSON.stringify(semantic));
      if (result.binary === 'PASS' && c.status === 'INITIAL_RESEARCH') {
        const episode: ThesisEpisode = { id: randomUUID(), caseId: c.id, baselineSnapshotId: id, thesis: b.thesis!, createdAt: b.cutoff };
        this.db.prepare('INSERT INTO episodes VALUES(?,?,?)').run(episode.id, c.id, JSON.stringify(episode));
        this.db.prepare('UPDATE cases SET status=?,episode_id=? WHERE id=?').run('THESIS_TRACKED', episode.id, c.id);
      }
      return snapshot;
    });
  }
  reassess(caseId: string, input: Bundle): ManagementSnapshot {
    const b = this.validateBundle(input);
    this.persistArtifacts(b);
    const row = this.db.prepare('SELECT token_key,status,episode_id FROM cases WHERE id=?').get(caseId);
    if (!row) throw new Error('CASE_NOT_FOUND');
    if (String(row.token_key) !== tokenKey(b.token)) throw new Error('TOKEN_CASE_MISMATCH');
    if (!row.episode_id || row.status !== 'THESIS_TRACKED') throw new Error('NO_ACTIVE_THESIS');
    const episode = this.episodeAt(caseId, String(row.episode_id), b.cutoff);
    const pRow = this.db.prepare('SELECT payload,id FROM positions WHERE case_id=?').get(caseId);
    const savedPosition = pRow ? readJson<PositionRecord>(pRow.payload) : null;
    const position = savedPosition && Date.parse(savedPosition.entryAt) <= Date.parse(b.cutoff) && Date.parse(savedPosition.recordedAt) <= Date.parse(b.cutoff) ? savedPosition : null;
    const events = position && pRow ? this.db.prepare('SELECT payload FROM position_events WHERE position_id=?').all(String(pRow.id)).map(x => readJson<PositionEvent>(x.payload)).filter(e => Date.parse(e.recordedAt) <= Date.parse(b.cutoff)) : [];
    const result = evaluateManagement(episode, policyFeatures(b), position, events, b.profile, b.cutoff,stageInputs(b));
    const semantic = { schemaVersion: 1, policyVersion: 'thesis-management-v0', episode, cutoff: b.cutoff, analysisKind: b.analysisKind, features: b.features, evidence: b.evidence, profile: b.profile, position, events, stageInputs: stageInputs(b), result };
    const hash = decisionHash(semantic);
    const existing = this.db.prepare('SELECT payload FROM snapshots WHERE hash=? AND kind=?').get(hash, 'MANAGEMENT');
    if (existing) return readJson<ManagementSnapshot>(existing.payload);
    return this.transact(() => { const id = randomUUID(); const snapshot: ManagementSnapshot = { id, checklistKind: 'MANAGEMENT', caseId, episodeId: episode.id, baselineSnapshotId: episode.baselineSnapshotId, cutoff: b.cutoff, features: b.features, evidence: b.evidence, result, hash }; this.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?)').run(id, 'MANAGEMENT', JSON.stringify(snapshot), hash, JSON.stringify(semantic)); return snapshot; });
  }
  episode(id: string): ThesisEpisode { const row = this.db.prepare('SELECT payload FROM episodes WHERE id=?').get(id); if (!row) throw new Error('EPISODE_NOT_FOUND'); return readJson<ThesisEpisode>(row.payload); }
  private episodeAt(caseId: string, headId: string, cutoff: string): ThesisEpisode {
    const cutoffMs = Date.parse(cutoff);
    const seen = new Set<string>();
    let id: string | undefined = headId;
    let childAt = Number.POSITIVE_INFINITY;
    let selected: ThesisEpisode | undefined;
    while (id !== undefined) {
      if (seen.has(id)) throw new Error('INVALID_EPISODE_TIMELINE');
      seen.add(id);
      const row: Record<string, unknown> | undefined = this.db.prepare('SELECT payload FROM episodes WHERE id=? AND case_id=?').get(id, caseId);
      if (!row) throw new Error('INVALID_EPISODE_TIMELINE');
      const episode: ThesisEpisode = readJson<ThesisEpisode>(row.payload);
      const at = Date.parse(episode.createdAt);
      if (episode.id !== id || episode.caseId !== caseId || !Number.isFinite(at) || at >= childAt) {
        throw new Error('INVALID_EPISODE_TIMELINE');
      }
      if (!selected && at <= cutoffMs) selected = episode;
      childAt = at;
      id = episode.supersedesEpisodeId;
    }
    if (!selected) throw new Error('NO_THESIS_AT_CUTOFF');
    return selected;
  }
  successor(caseId: string, thesisInput: Thesis, at: string): ThesisEpisode {
    const thesis = thesisSchema.parse(thesisInput);
    if (!Number.isFinite(Date.parse(at))) throw new Error('INVALID_SUCCESSOR_TIME');
    for (const p of [...thesis.support,...thesis.invalidation,...[thesis.catalyst,thesis.onchainTraction,thesis.externalTraction,thesis.warning].filter(x => x !== null),...thesis.legs.map(l => l.trigger)]) evaluatePredicate(p,[],at);
    return this.transact(() => {
      const row = this.db.prepare('SELECT episode_id,status FROM cases WHERE id=?').get(caseId);
      if (!row) throw new Error('CASE_NOT_FOUND');
      if (row.status !== 'THESIS_TRACKED' || !row.episode_id) throw new Error('NO_ACTIVE_THESIS');
      const headId = String(row.episode_id);
      const head = this.db.prepare('SELECT payload FROM episodes WHERE id=? AND case_id=?').get(headId, caseId);
      if (!head) throw new Error('INVALID_EPISODE_TIMELINE');
      const old = readJson<ThesisEpisode>(head.payload);
      this.episodeAt(caseId, headId, old.createdAt);
      if (Date.parse(at) <= Date.parse(old.createdAt)) throw new Error('SUCCESSOR_TIME_NOT_AFTER_PREDECESSOR');
      const episode: ThesisEpisode = { id: randomUUID(), caseId, baselineSnapshotId: old.baselineSnapshotId, thesis, createdAt: at, supersedesEpisodeId: old.id };
      this.db.prepare('INSERT INTO episodes VALUES(?,?,?)').run(episode.id,caseId,JSON.stringify(episode));
      this.db.prepare('UPDATE cases SET episode_id=? WHERE id=?').run(episode.id,caseId);
      return episode;
    });
  }
  show(id: string): EntrySnapshot | ManagementSnapshot { const row = this.db.prepare('SELECT payload FROM snapshots WHERE id=?').get(id); if (!row) throw new Error('SNAPSHOT_NOT_FOUND'); return readJson<EntrySnapshot | ManagementSnapshot>(row.payload); }
  replay(id: string): EntrySnapshot | ManagementSnapshot {
    const row = this.db.prepare('SELECT payload,hash,semantic,kind FROM snapshots WHERE id=?').get(id); if (!row) throw new Error('SNAPSHOT_NOT_FOUND');
    const semantic = readJson<Record<string, any>>(row.semantic);
    if (decisionHash(semantic) !== row.hash) throw new Error('SNAPSHOT_HASH_MISMATCH');
    const replayBundle = { analysisKind: semantic.analysisKind, features: semantic.features } as Bundle;
    const recomputed = row.kind === 'ENTRY' ? evaluateEntry(policyFeatures(replayBundle),semantic.profile,semantic.cutoff) : evaluateManagement(semantic.episode,policyFeatures(replayBundle),semantic.position,semantic.events,semantic.profile,semantic.cutoff,semantic.stageInputs);
    if (decisionHash(recomputed) !== decisionHash(semantic.result)) throw new Error('REPLAY_RESULT_MISMATCH');
    return readJson<EntrySnapshot | ManagementSnapshot>(row.payload);
  }
  recordPosition(position: PositionRecord): PositionRecord {
    position = positionRecordSchema.parse(position);
    const row = this.db.prepare('SELECT id,status FROM cases WHERE id=?').get(position.caseId); if (!row) throw new Error('CASE_NOT_FOUND');
    if (row.status !== 'THESIS_TRACKED') throw new Error('NO_ACTIVE_THESIS');
    if (this.db.prepare('SELECT id FROM positions WHERE case_id=?').get(position.caseId)) throw new Error('POSITION_ALREADY_EXISTS');
    reduceLedger(position, []);
    this.db.prepare('INSERT INTO positions VALUES(?,?,?)').run(position.id, position.caseId, JSON.stringify(position)); return position;
  }
  appendPositionEvent(positionId: string, event: PositionEvent) {
    event = positionEventSchema.parse(event);
    const p = this.db.prepare('SELECT payload FROM positions WHERE id=?').get(positionId); if (!p) throw new Error('POSITION_NOT_FOUND');
    const prior = this.db.prepare('SELECT payload FROM position_events WHERE idempotency_key=?').get(event.idempotencyKey);
    if (prior) { if (String(prior.payload) !== JSON.stringify(event)) throw new Error('IDEMPOTENCY_CONFLICT'); return this.positionState(positionId); }
    const current = this.db.prepare('SELECT payload FROM position_events WHERE position_id=?').all(positionId).map(x => readJson<PositionEvent>(x.payload));
    const next = [...current, event]; const state = reduceLedger(readJson<PositionRecord>(p.payload), next);
    this.db.prepare('INSERT INTO position_events VALUES(?,?,?,?)').run(event.id, positionId, event.idempotencyKey, JSON.stringify(event));
    return state;
  }
  positionState(positionId: string) { const p = this.db.prepare('SELECT payload FROM positions WHERE id=?').get(positionId); if (!p) throw new Error('POSITION_NOT_FOUND'); const events = this.db.prepare('SELECT payload FROM position_events WHERE position_id=?').all(positionId).map(x => readJson<PositionEvent>(x.payload)); return reduceLedger(readJson<PositionRecord>(p.payload),events); }
  showCase(id: string) { const row = this.db.prepare('SELECT id,token_json,status,episode_id FROM cases WHERE id=?').get(id); if (!row) throw new Error('CASE_NOT_FOUND'); return { id: String(row.id), token: readJson<TokenRef>(row.token_json), status: String(row.status), episodeId: row.episode_id ? String(row.episode_id) : null }; }
  diff(a: string,b: string) {
    const x = this.show(a), y = this.show(b);
    const sx = readJson<Record<string, unknown>>(this.db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(a)!.semantic);
    const sy = readJson<Record<string, unknown>>(this.db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(b)!.semantic);
    const changed = (k: string) => decisionHash(sx[k] ?? null) !== decisionHash(sy[k] ?? null);
    return { from: a, to: b, checklistChanged: x.checklistKind !== y.checklistKind, policyChanged: changed('policyVersion') || changed('profile'), evidenceChanged: changed('evidence'), featuresChanged: changed('features'), thesisChanged: changed('episode') || changed('thesis'), stageChanged: changed('stageInputs'), positionChanged: changed('position') || changed('events'), resultChanged: changed('result'), semanticChanged: null, semanticReason: 'No hosted semantic output is persisted in this increment' };
  }
  closeCase(id: string) { const row = this.db.prepare('UPDATE cases SET status=? WHERE id=?').run('CLOSED',id); if (!row.changes) throw new Error('CASE_NOT_FOUND'); }
  journal(caseId: string, text: string) { if (text.length > 4000) throw new Error('JOURNAL_LIMIT'); this.db.prepare('INSERT INTO journal VALUES(?,?,?,?)').run(randomUUID(),caseId,new Date().toISOString(),text); }
  async backup(directory: string) {
    if (existsSync(directory)) throw new Error('BACKUP_TARGET_EXISTS');
    mkdirSync(directory,{ recursive: true });
    await backup(this.db,join(directory,'dd.sqlite'));
    if (existsSync(this.artifactDir)) cpSync(this.artifactDir,join(directory,'artifacts'),{ recursive: true });
    return { directory, database: join(directory,'dd.sqlite'), artifacts: existsSync(this.artifactDir) };
  }
}
