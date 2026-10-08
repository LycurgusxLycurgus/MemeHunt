import { Decimal } from 'decimal.js';
import type { EntryCheckResult, EntryResult, FeatureResult, ManagementCheckResult, ManagementResult, PositionEvent, PositionRecord, Predicate, Profile, ThesisEpisode, SocialPolicyFacts } from './contracts.js';
import { entryDefinitions, managementDefinitions, featureMetadata } from './catalog.js';
import { proposeLeg, reduceLedger } from './ledger.js';

export type Truth = 'TRUE' | 'FALSE' | 'UNKNOWN';
export type StageInputs = { circulatingMarketCapUsd: string | null; tokenCreatedAt: string | null };
const usable = (f: FeatureResult | undefined, cutoff: string) => !!f && f.quality === 'KNOWN' && f.applicability === 'APPLICABLE' && Date.parse(f.availableAt) <= Date.parse(cutoff) && f.value !== null;
const lookup = (fs: FeatureResult[], id: string, cutoff: string) => { const f = fs.find(x => x.id === id); return usable(f, cutoff) ? f! : undefined; };
const decimal = (v: string | boolean) => { if (typeof v !== 'string') throw new Error('PREDICATE_TYPE'); const d = new Decimal(v); if (!d.isFinite()) throw new Error('PREDICATE_NUMBER'); return d; };
export function evaluatePredicate(ast: Predicate, features: FeatureResult[], cutoff: string): Truth {
  let nodes = 0;
  function visit(p: Predicate, depth: number): Truth {
    if (++nodes > 64 || depth > 8) throw new Error('PREDICATE_LIMIT');
    if (p.op === 'all' || p.op === 'any') {
      if (!p.children.length) throw new Error('PREDICATE_EMPTY');
      const xs = p.children.map(x => visit(x, depth + 1));
      if (p.op === 'all') return xs.includes('FALSE') ? 'FALSE' : xs.includes('UNKNOWN') ? 'UNKNOWN' : 'TRUE';
      return xs.includes('TRUE') ? 'TRUE' : xs.includes('UNKNOWN') ? 'UNKNOWN' : 'FALSE';
    }
    if (!('feature' in p)) throw new Error('PREDICATE_SHAPE');
    if (!featureMetadata.some(x => x.id === p.feature)) throw new Error(`UNKNOWN_FEATURE:${p.feature}`);
    if (p.op !== 'eq') decimal(p.value);
    if (typeof p.value === 'boolean' && p.unit !== 'bool') throw new Error('PREDICATE_UNIT');
    const f = lookup(features, p.feature, cutoff);
    if (!f) return 'UNKNOWN';
    if (f.unit !== p.unit) throw new Error(`UNIT_MISMATCH:${p.feature}`);
    if (p.op === 'eq') return typeof f.value === 'string' && typeof p.value === 'string' && /^(0|[1-9]\d*)(\.\d+)?$/.test(f.value) && /^(0|[1-9]\d*)(\.\d+)?$/.test(p.value) ? (new Decimal(f.value).eq(p.value) ? 'TRUE' : 'FALSE') : f.value === p.value ? 'TRUE' : 'FALSE';
    const actual = decimal(f.value!), expected = decimal(p.value);
    const result = p.op === 'lt' ? actual.lt(expected) : p.op === 'lte' ? actual.lte(expected) : p.op === 'gt' ? actual.gt(expected) : actual.gte(expected);
    return result ? 'TRUE' : 'FALSE';
  }
  return visit(ast, 0);
}

function boolRule(features: FeatureResult[], ids: string[], cutoff: string): 'PASS' | 'FAIL' | 'UNKNOWN' {
  const values = ids.map(id => lookup(features, id, cutoff));
  if (values.some(v => v?.value === false)) return 'FAIL';
  if (values.some(v => !v || v.value !== true)) return 'UNKNOWN';
  return 'PASS';
}
function numericLimit(features: FeatureResult[], id: string, limit: string | undefined, unit: string, cutoff: string): 'PASS'|'FAIL'|'UNKNOWN' {
  const f = lookup(features, id, cutoff);
  if (!f || typeof f.value !== 'string' || f.unit !== unit || limit === undefined || !/^(0|[1-9]\d*)(\.\d+)?$/.test(f.value)) return 'UNKNOWN';
  return new Decimal(f.value).lte(new Decimal(limit)) ? 'PASS' : 'FAIL';
}
const combineNumeric = (statuses: Array<'PASS'|'FAIL'|'UNKNOWN'>): 'PASS'|'FAIL'|'UNKNOWN' => statuses.includes('FAIL') ? 'FAIL' : statuses.includes('UNKNOWN') ? 'UNKNOWN' : 'PASS';
const predicateRefs = (p: Predicate): string[] => {
  if (p.op === 'all' || p.op === 'any') return p.children.flatMap(predicateRefs);
  if (!('feature' in p)) throw new Error('PREDICATE_SHAPE');
  return [p.feature];
};
export function resolveStage(cap: string | null, tokenCreatedAt: string | null, cutoff: string, profile: Profile): { capBand: 'MICRO'|'SMALL'|'ESTABLISHED'|'LARGE'|'UNKNOWN'; ageBand: string | null } {
  let capBand: 'MICRO'|'SMALL'|'ESTABLISHED'|'LARGE'|'UNKNOWN' = 'UNKNOWN';
  if (cap !== null && /^(0|[1-9]\d*)(\.\d+)?$/.test(cap) && new Decimal(cap).isFinite() && new Decimal(cap).gte(0)) {
    const n = new Decimal(cap); capBand = n.lt(100000) ? 'MICRO' : n.lt(1000000) ? 'SMALL' : n.lt(10000000) ? 'ESTABLISHED' : 'LARGE';
  }
  let ageBand: string | null = null;
  if (tokenCreatedAt && Number.isFinite(Date.parse(tokenCreatedAt))) {
    const age = (Date.parse(cutoff) - Date.parse(tokenCreatedAt)) / 1000;
    if (age >= 0) ageBand = profile.stage.ageBands.find(b => age >= b.minSeconds && (b.maxSeconds === null || age < b.maxSeconds))?.name ?? null;
  }
  return { capBand, ageBand };
}

export function evaluateEntry(features: FeatureResult[], profile: Profile, cutoff: string, attentionPolicy:'LEGACY'|'QUALIFIED'|'QUALIFIED_V2'|'QUALIFIED_V3'|'QUALIFIED_V4'='LEGACY', social?:SocialPolicyFacts, shared=false): EntryResult {
  const socialUsable=(attentionPolicy==='QUALIFIED_V3'||attentionPolicy==='QUALIFIED_V4')&&social&&Date.parse(social.availableAt)<=Date.parse(cutoff)&&Date.parse(social.end)<=Date.parse(cutoff)&&Date.parse(social.start)<Date.parse(social.end)&&Date.parse(cutoff)-Date.parse(social.availableAt)<=900000;
  const checks: EntryCheckResult[] = entryDefinitions.map(d => {
    let status: EntryCheckResult['status'] = boolRule(features, d.featureIds, cutoff);
    if (d.checkId === 'CTX-01') status = !profile.sizeUsd || !profile.horizonSeconds || ['maxTransferFeeBps','maxDirectControlShare','maxEntryImpactBps','maxExitImpactBps','maxRoundTripLossBps','maxRemovableLiquidityShare'].some(k => profile.risk[k] === undefined) ? 'UNKNOWN' : status;
    if (d.checkId === 'CAP-01' && (features.find(f => f.id === 'C02')?.quality === 'UNSUPPORTED' || lookup(features,'C02',cutoff)?.value === false)) status = 'UNKNOWN';
    if (d.checkId === 'SEC-04') status = numericLimit(features, 'O07', profile.risk.maxTransferFeeBps, 'bps', cutoff);
    if (d.checkId === 'OWN-02') status = combineNumeric([numericLimit(features, 'O19', profile.risk.maxDirectControlShare, 'fraction', cutoff),numericLimit(features, 'O20', profile.risk.maxDirectControlShare, 'fraction', cutoff)]);
    if (d.checkId === 'LIQ-01') status = numericLimit(features, 'O09', profile.risk.maxRemovableLiquidityShare, 'fraction', cutoff);
    if (d.checkId === 'EXE-02') {
      const rules = [numericLimit(features,'O13',profile.risk.maxEntryImpactBps,'bps',cutoff),numericLimit(features,'O14',profile.risk.maxExitImpactBps,'bps',cutoff),numericLimit(features,'O15',profile.risk.maxRoundTripLossBps,'bps',cutoff),boolRule(features,['O16'],cutoff)];
      status = combineNumeric(rules);
    }
    if (d.checkId === 'ATT-01') {
      const posts = lookup(features, 'A16', cutoff), authors = lookup(features, 'A17', cutoff);
      const measured=posts&&authors&&typeof posts.value==='string'&&typeof authors.value==='string'&&(attentionPolicy==='LEGACY'||lookup(features,'A15',cutoff)?.value===true);
      status = measured ? new Decimal(posts.value as string).gte(10)&&new Decimal(authors.value as string).gte(3)?'PASS':attentionPolicy!=='LEGACY'?'FAIL':'UNKNOWN' : 'UNKNOWN';
    }
    if (d.checkId === 'CAN-02' && (attentionPolicy==='QUALIFIED_V2'||attentionPolicy==='QUALIFIED_V3'||attentionPolicy==='QUALIFIED_V4')) status = boolRule(features,['A14'],cutoff);
    if((attentionPolicy==='QUALIFIED_V3'||attentionPolicy==='QUALIFIED_V4')&&d.pillar==='SOCIAL'){
      if(d.checkId==='SOC-01')status=socialUsable?boolRule(features,['S01'],cutoff):'UNKNOWN';
      if(d.checkId==='SOC-02')status=socialUsable?combineNumeric([boolRule(features,['S02','S04','S05','S06'],cutoff),social.lineageComplete?'PASS':'UNKNOWN']):'UNKNOWN';
      if(d.checkId==='SOC-03')status=!socialUsable||!social.postCorpusObserved||!social.sampleComplete?'UNKNOWN':social.accountUpperBound!==null&&social.accountUpperBound<3?'FAIL':!social.lineageComplete||social.accountUpperBound===null||social.independentGroupCount===null||social.independentCommunityCount===null?'UNKNOWN':social.accountUpperBound>=3&&social.independentGroupCount>=2&&social.independentCommunityCount>=2?'PASS':'FAIL';
    }
    if(attentionPolicy==='QUALIFIED_V4'&&['SOC-01','SOC-02'].includes(d.checkId)){
      const judgment=d.checkId==='SOC-01'?social?.identityReview:social?.integrityReview;
      status=!socialUsable||!judgment||judgment.verdict==='UNRESOLVED'?'UNKNOWN':judgment.verdict==='SUPPORTED'?'PASS':'FAIL';
    }
    if (d.checkId === 'ATT-02') { const a = boolRule(features,['A18'],cutoff), s = boolRule(features,['S10'],cutoff); status = a === 'PASS' || s === 'PASS' ? 'PASS' : a === 'FAIL' && s === 'FAIL' ? 'FAIL' : 'UNKNOWN'; }
    if (d.role === 'REQUIRED_EVIDENCE' && status === 'FAIL' && !(shared&&d.checkId.startsWith('DAT-')||attentionPolicy!=='LEGACY'&&d.pillar==='ATTENTION'||(attentionPolicy==='QUALIFIED_V3'||attentionPolicy==='QUALIFIED_V4')&&d.pillar==='SOCIAL')) status = 'UNKNOWN';
    if (d.role === 'ADVISORY' && d.featureIds.length === 0) status = 'UNKNOWN';
    const evidenceRefs = [...new Set(d.featureIds.flatMap(id => features.find(f => f.id === id)?.evidenceIds ?? []))];
    const reasonCode = d.checkId === 'CAP-01' && status === 'UNKNOWN' && (features.find(f => f.id === 'C02')?.quality === 'UNSUPPORTED' || lookup(features,'C02',cutoff)?.value === false) ? 'UNSUPPORTED_CAPABILITY' : status === 'UNKNOWN' ? (d.checkId === 'CTX-01' ? 'POLICY_PARAMETER_MISSING' : 'INSUFFICIENT_EVIDENCE') : status === 'FAIL' ? 'RULE_FAILED' : 'RULE_SATISFIED';
    return { checkId: d.checkId, checklistKind: 'ENTRY' as const, role: d.role, pillar: d.pillar, required: d.required, status, reasonCode, featureRefs: d.featureIds, evidenceRefs };
  }).sort((a,b) => a.checkId.localeCompare(b.checkId));
  const required = checks.filter(c => c.required && c.status !== 'NOT_APPLICABLE');
  const has = (role: EntryCheckResult['role'], status: EntryCheckResult['status']) => checks.some(c => c.required && c.role === role && c.status === status);
  const unsupported = checks.some(c => c.required && c.reasonCode === 'UNSUPPORTED_CAPABILITY');
  const classification: EntryResult['classification'] = has('HARD_GATE','FAIL') ? 'REJECTED' : unsupported ? 'UNSUPPORTED' : required.some(c => c.status === 'UNKNOWN') ? 'INSUFFICIENT_DATA' : has('OPPORTUNITY','FAIL')||shared&&checks.some(c=>c.required&&c.checkId.startsWith('DAT-')&&c.status==='FAIL')||attentionPolicy!=='LEGACY'&&checks.some(c=>c.required&&(c.pillar==='ATTENTION'||(attentionPolicy==='QUALIFIED_V3'||attentionPolicy==='QUALIFIED_V4')&&c.pillar==='SOCIAL')&&c.status==='FAIL') ? 'WATCH' : 'RESEARCH_ELIGIBLE';
  return { checks, binary: classification === 'RESEARCH_ELIGIBLE' ? 'PASS' : 'FAIL', classification, coverage: { known: required.filter(c => c.status === 'PASS' || c.status === 'FAIL').length, total: required.length } };
}

const truthStatus = (truth: Truth, falseMeansFail = true): ManagementCheckResult['status'] => truth === 'UNKNOWN' ? 'UNKNOWN' : truth === 'TRUE' ? (falseMeansFail ? 'PASS' : 'FAIL') : (falseMeansFail ? 'FAIL' : 'PASS');
export function evaluateManagement(episode: ThesisEpisode, features: FeatureResult[], position: PositionRecord | null, events: PositionEvent[], profile: Profile, cutoff: string, stageInputs: StageInputs = { circulatingMarketCapUsd: null, tokenCreatedAt: null }, attentionPolicy:'LEGACY'|'QUALIFIED'|'QUALIFIED_V2'|'QUALIFIED_V3'|'QUALIFIED_V4'='LEGACY',social?:SocialPolicyFacts): ManagementResult {
  const t = episode.thesis;
  const support = t.support.map(p => evaluatePredicate(p, features, cutoff));
  const invalidation = t.invalidation.map(p => evaluatePredicate(p, features, cutoff));
  const supportStatus: Truth = support.includes('FALSE') ? 'FALSE' : support.includes('UNKNOWN') ? 'UNKNOWN' : 'TRUE';
  const invalidationStatus: Truth = invalidation.includes('TRUE') ? 'TRUE' : invalidation.includes('UNKNOWN') ? 'UNKNOWN' : 'FALSE';
  const entryChecks = evaluateEntry(features, profile, cutoff,attentionPolicy,social).checks;
  const combine = (ids: string[]): 'PASS'|'FAIL'|'UNKNOWN' => { const rows = entryChecks.filter(c => ids.includes(c.checkId)); return rows.some(r => r.status === 'FAIL') ? 'FAIL' : rows.some(r => r.status !== 'PASS') ? 'UNKNOWN' : 'PASS'; };
  const safety = combine(['SEC-01','SEC-02','SEC-03','SEC-04','SEC-05','LIQ-01']);
  const exit = combine(['EXE-01','EXE-02']);
  const stage = resolveStage(stageInputs.circulatingMarketCapUsd,stageInputs.tokenCreatedAt,cutoff,profile);
  const knownPosition = position && Date.parse(position.entryAt) <= Date.parse(cutoff) && Date.parse(position.recordedAt) <= Date.parse(cutoff) ? position : null;
  const ledger = knownPosition ? reduceLedger(knownPosition, events, cutoff) : null;
  const candidate = ledger ? proposeLeg(episode, ledger, features, cutoff) : null;
  const legTruths = t.legs.map(l => evaluatePredicate(l.trigger, features, cutoff));
  const due = legTruths.includes('TRUE');
  const triggerStatus: ManagementCheckResult['status'] = !t.legs.length || legTruths.includes('UNKNOWN') ? 'UNKNOWN' : due ? 'PASS' : 'FAIL';
  const rules: Record<string, ManagementCheckResult['status']> = {
    'MG-01': episode.baselineSnapshotId ? 'PASS' : 'UNKNOWN', 'MG-02': safety, 'MG-03': exit,
    'MG-04': [...new Set([...t.support,...t.invalidation,...(t.catalyst ? [t.catalyst] : [])].flatMap(predicateRefs))].some(id => !lookup(features,id,cutoff)) ? 'UNKNOWN' : 'PASS',
    'MG-05': stage.capBand !== 'UNKNOWN' && stage.ageBand ? 'PASS' : 'UNKNOWN',
    'MG-06': truthStatus(supportStatus), 'MG-07': truthStatus(invalidationStatus, false),
    'MG-08': t.catalyst ? truthStatus(evaluatePredicate(t.catalyst, features, cutoff)) : 'NOT_APPLICABLE',
    'MG-09': t.onchainTraction ? truthStatus(evaluatePredicate(t.onchainTraction, features, cutoff)) : 'UNKNOWN',
    'MG-10': t.externalTraction ? truthStatus(evaluatePredicate(t.externalTraction, features, cutoff)) : 'UNKNOWN',
    'MG-11': t.warning ? truthStatus(evaluatePredicate(t.warning, features, cutoff), false) : 'NOT_APPLICABLE',
    'MG-12': triggerStatus, 'MG-13': ledger && ledger.knownCost !== null && t.legs.length ? 'PASS' : 'UNKNOWN',
    'MG-14': t.expiryAt ? (Date.parse(cutoff) >= Date.parse(t.expiryAt) ? 'FAIL' : 'PASS') : 'NOT_APPLICABLE',
    'MG-15': candidate && exit === 'PASS' ? 'PASS' : 'UNKNOWN',
  };
  const checks = managementDefinitions.map(d => ({ checkId: d.checkId, checklistKind: 'MANAGEMENT' as const, managementRole: d.managementRole, requiredFor: d.requiredFor, status: rules[d.checkId] ?? 'UNKNOWN', reasonCode: rules[d.checkId] === 'UNKNOWN' ? 'INSUFFICIENT_EVIDENCE' : rules[d.checkId] === 'FAIL' ? 'RULE_FAILED' : 'RULE_SATISFIED', featureRefs: [], evidenceRefs: [] })).sort((a,b) => a.checkId.localeCompare(b.checkId));
  const thesisUnknown = checks.some(c => c.requiredFor === 'THESIS' && c.status === 'UNKNOWN');
  const thesisState: ManagementResult['thesisState'] = safety === 'FAIL' || exit === 'FAIL' || invalidationStatus === 'TRUE' || rules['MG-14'] === 'FAIL' ? 'INVALIDATED' : thesisUnknown ? 'UNVERIFIABLE' : supportStatus === 'FALSE' || rules['MG-08'] === 'FAIL' ? 'WEAKENING' : 'VALIDATED';
  const proposal: ManagementResult['proposal'] = thesisState === 'INVALIDATED' ? 'EXIT_REVIEW' : thesisState === 'UNVERIFIABLE' ? 'REASSESS_REQUIRED' : thesisState === 'WEAKENING' ? 'REDUCE_REVIEW' : rules['MG-09'] === 'PASS' && rules['MG-10'] === 'PASS' && triggerStatus === 'PASS' && rules['MG-13'] === 'PASS' && rules['MG-15'] === 'PASS' ? 'DCA_OUT_PROPOSED' : triggerStatus === 'FAIL' && rules['MG-09'] !== 'UNKNOWN' && rules['MG-10'] !== 'UNKNOWN' ? 'MAINTAIN_THESIS' : 'REASSESS_REQUIRED';
  return { checks, thesisState, proposal, ...(proposal === 'DCA_OUT_PROPOSED' && candidate ? { proposedQuantityAtomic: candidate.quantityAtomic, proposedLegId: candidate.legId } : {}) };
}
