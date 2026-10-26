import { entryDefinitions, featureMetadata } from '../domain/catalog.js';
import { evaluatePredicate } from '../domain/policy.js';
import type { BaselineAssessment, MissingCause } from '../domain/baseline.js';
import type { AssessmentDetails, EntrySnapshot, ManagementSnapshot, Predicate } from '../domain/contracts.js';

type Snapshot=EntrySnapshot|ManagementSnapshot;
export const cleanText=(value:unknown,max=400)=>String(value??'').replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const metricValueText=(value:unknown)=>{try{return cleanText(JSON.stringify(value)??String(value),220);}catch{return '[unavailable]';}};
/** Rounded display of an exact {num,den} rational; the exact rational stays in JSON. */
const rationalText=(r:{num:string;den:string},places=2)=>{const n=BigInt(r.num),d=BigInt(r.den),neg=(n<0n)!==(d<0n),a=n<0n?-n:n,b=d<0n?-d:d,scale=10n**BigInt(places),q=(a*scale*2n+b)/(2n*b),f=(q%scale).toString().padStart(places,'0');return `${neg&&q>0n?'-':''}${(q/scale).toLocaleString('en-US')}${places?`.${f}`:''}`;};
/** Exact decimal quantity from output-mint atoms and their decimals. */
const atomsText=(atoms:string,decimals:number)=>{const s=atoms.padStart(decimals+1,'0');return decimals?`${s.slice(0,-decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/,''):s;};
const names:Record<string,string>={'ID-01':'Token identity','CTX-01':'Your trade settings','CAP-01':'Chain and venue coverage','SEC-01':'Supply authority','SEC-02':'Transfer restrictions','SEC-03':'Program controls','SEC-04':'Transfer fees','SEC-05':'Venue provenance','LIQ-01':'Liquidity withdrawal exposure','EXE-01':'Entry and acquired-size exit','EXE-02':'Trade friction and costs','EXE-03':'Read-only simulation','OWN-01':'Holder coverage','OWN-02':'Owner/control concentration','MKT-01':'Valuation and scoped activity','NAR-01':'Narrative and game','NAR-02':'Origin and catalyst','NAR-03':'Explainable thesis','CAN-01':'Competing representations','CAN-02':'Observed leadership','ATT-01':'Qualified attention sample','ATT-02':'Attention or community growth','SOC-01':'Social identity binding','SOC-02':'Source integrity','SOC-03':'Independent participation','DAT-01':'Freshness and completeness','DAT-02':'Semantic qualification','DAT-03':'Conflicts','ADV-01':'Ownership patterns','ADV-02':'Flow patterns','ADV-03':'Attention context','ADV-04':'Actor context','ADV-05':'Market and lifecycle context','MG-01':'Frozen baseline','MG-02':'Current integrity','MG-03':'Exit feasibility','MG-04':'Thesis evidence','MG-05':'Age and cap context','MG-06':'Thesis support','MG-07':'Invalidation clear','MG-08':'Catalyst','MG-09':'On-chain traction','MG-10':'External traction','MG-11':'Warnings','MG-12':'Realization trigger','MG-13':'Position and exit plan','MG-14':'Holding horizon','MG-15':'Proposal feasibility'};
export function predicateRefs(p:Predicate):string[]{return 'feature' in p?[p.feature]:p.children.flatMap(predicateRefs);}
function describePredicate(p:Predicate):string {
  if('children' in p)return '('+p.children.map(describePredicate).join(p.op==='all'?' AND ':' OR ')+')';
  const name=featureMetadata.find(f=>f.id===p.feature)?.name??p.feature;
  const operator={eq:'=',lt:'<',lte:'≤',gt:'>',gte:'≥'}[p.op];
  return `${p.feature} ${cleanText(name,70)} ${operator} ${cleanText(p.value)} ${cleanText(p.unit)}`;
}
const managementRefs=(id:string,details?:AssessmentDetails):string[]=>{
  const t=details?.thesis;
  if(id==='MG-02')return entryDefinitions.filter(d=>['SEC-01','SEC-02','SEC-03','SEC-04','SEC-05','LIQ-01'].includes(d.checkId)).flatMap(d=>d.featureIds);
  if(id==='MG-03'||id==='MG-15')return ['O10','O11','O13','O14','O15','O16'];
  if(id==='MG-05')return [];
  if(!t)return [];
  const ps=id==='MG-04'?[...t.support,...t.invalidation,...(t.catalyst?[t.catalyst]:[])]:id==='MG-06'?t.support:id==='MG-07'?t.invalidation:id==='MG-08'?t.catalyst?[t.catalyst]:[]:id==='MG-09'?t.onchainTraction?[t.onchainTraction]:[]:id==='MG-10'?t.externalTraction?[t.externalTraction]:[]:id==='MG-11'?t.warning?[t.warning]:[]:id==='MG-12'?t.legs.map(l=>l.trigger):[];
  return [...new Set(ps.flatMap(predicateRefs))];
};
const riskKeys:Record<string,string[]>={'CTX-01':['sizeUsd','horizonSeconds','maxTransferFeeBps','maxEntryImpactBps','maxExitImpactBps','maxRoundTripLossBps','maxDirectControlShare','maxRemovableLiquidityShare'],'SEC-04':['maxTransferFeeBps'],'LIQ-01':['maxRemovableLiquidityShare'],'OWN-02':['maxDirectControlShare'],'EXE-02':['sizeUsd','maxEntryImpactBps','maxExitImpactBps','maxRoundTripLossBps']};
export function unknownCauseKind(causes:MissingCause[]):'INFRA'|'COLLECTION'|'MODEL'|'IMPLEMENTATION'|'INPUT'|'EXECUTION'|'DATA'{
  const codes=causes.map(c=>c.code);
  if(causes.some(c=>c.category==='USER_INPUT_MISSING'))return 'INPUT';
  if(causes.some(c=>c.category==='COLLECTION_UNIMPLEMENTED'))return 'IMPLEMENTATION';
  if(codes.some(c=>/(?:HTTP_(?:408|429|5\d\d)|TOKEN_COUNT_UNAVAILABLE|TIMEOUT|TRANSPORT|DNS_ERROR|NETWORK_ACCESS_DENIED|RUN_ABORTED|COLLECTION_BUDGET|RUN_LIMIT|RUN_TIMEOUT|LIVE_(?:PHASE_DEADLINE|HARD_DEADLINE|OPERATION_LIMIT|CALLER_CANCELLED|DEPENDENCY_SKIPPED))/.test(c)))return 'INFRA';
  if(codes.some(c=>/^(?:PUMP|CURVE|DAMM)_(?:SIMULATION|TRANSACTION|QUOTE|FEE|PAYER|ACCOUNT)/.test(c)))return 'EXECUTION';
  if(codes.some(c=>/TEXT_CAP|PAGE_CAP|SOURCE_CAP|PACKET_LIMIT|INPUT_TOKEN_LIMIT|RESPONSE_LIMIT|FETCH_|DISCOVERY_INCOMPLETE|COLLECTION_INCOMPLETE|SCOPE_INCOMPLETE|CORPUS_REQUIRED|HOLDER_TAIL_UNKNOWN|ATT_ENTRY_(?:FETCH|ORIGIN|SOURCE_TEXT|SOURCE_CAP|TEXT_CAP|RECOVERY|COMPARISON|REQUIRED_SEARCH)/.test(c)))return 'COLLECTION';
  if(causes.some(c=>c.category==='CLAIM_UNVALIDATED')||codes.some(c=>/MODEL_|REVIEW_|UNRESOLVED|CITATION/.test(c)))return 'MODEL';
  return 'DATA';
}
export function explainChecks(snapshot:Snapshot,details=snapshot.details) {
  return snapshot.result.checks.map(check=>{
    const refs=check.featureRefs.length?check.featureRefs:managementRefs(check.checkId,details);
    const assessments=refs.flatMap(id=>details?.baseline.find(a=>a.id===id)?[details.baseline.find(a=>a.id===id)!]:[]);
    const causes:MissingCause[]=[];
    const group=details?.groups?.groups.find(item=>item.checkId===check.checkId);
    if(group&&check.status==='UNKNOWN')causes.push({category:'EVIDENCE_UNAVAILABLE',code:group.code,featureId:group.featureIds[0]??group.checkId,evidenceIds:group.evidenceIds,action:group.rationale});
    if(check.checkId==='MG-05'&&check.status==='UNKNOWN'){
      for(const field of ['circulatingMarketCapUsd','tokenCreatedAt'] as const)if(details?.stageInputs[field]===null||!details)causes.push({category:snapshot.analysisKind==='LIVE'?'COLLECTION_UNIMPLEMENTED':'EVIDENCE_UNAVAILABLE',code:field==='tokenCreatedAt'?'TOKEN_CREATION_EVIDENCE_MISSING':'CIRCULATING_CAP_EVIDENCE_MISSING',featureId:'C01',field,evidenceIds:[],action:field==='tokenCreatedAt'?'Supply independently qualified token creation evidence; pool age is not mint age.':'Supply independently qualified circulating supply and valuation; FDV is not circulating cap.'});
      if(!details?.profile.stage.ageBands.length)causes.push({category:'USER_INPUT_MISSING',code:'AGE_BANDS_MISSING',featureId:'C01',field:'stage.ageBands',evidenceIds:[],action:'Choose explicit age bands in the saved profile; no course-specific age threshold is invented.'});
    }
    if(check.status==='UNKNOWN'&&check.checkId==='MG-15'&&snapshot.result.checks.some(c=>c.checkId==='MG-13'&&c.status==='UNKNOWN'))causes.push({category:'USER_INPUT_MISSING',code:'PLAN_OR_POSITION_INCOMPLETE',featureId:'C10',evidenceIds:[],action:'Specify ordered realization legs and record a position with known cost before requesting a quantified proposal.'});
    for(const field of riskKeys[check.checkId]??[])if(!details?.profile||((field==='sizeUsd'||field==='horizonSeconds')?details.profile[field]===undefined:details.profile.risk[field]===undefined))causes.push({category:'USER_INPUT_MISSING',code:'PROFILE_FIELD_MISSING',featureId:refs[0]??'C01',field,evidenceIds:[],action:'Run config init to choose and save this setting; historical snapshots stay unchanged.'});
    if(!group&&(check.status==='UNKNOWN'||check.status==='FAIL'&&(check.checkId==='SOC-02'||check.checkId.startsWith('DAT-'))))for(const id of refs){const a=assessments.find(a=>a.id===id),f=snapshot.features.find(f=>f.id===id);if(a?.causes.length)causes.push(...a.causes);else if(!f||f.quality!=='KNOWN'||f.value===null)causes.push({category:a?.collector==='UNIMPLEMENTED'?'COLLECTION_UNIMPLEMENTED':'EVIDENCE_UNAVAILABLE',code:f?.quality??'FEATURE_ABSENT',featureId:id,evidenceIds:f?.evidenceIds??[],action:a?.collector==='UNIMPLEMENTED'?'Complete the named evidence collector.':'Supply qualified, fresh evidence for this feature in a new analysis.'});}
    if(check.status==='UNKNOWN'&&!causes.length){const missingPlan=['MG-09','MG-10','MG-12','MG-13','MG-15'].includes(check.checkId);causes.push({category:missingPlan?'USER_INPUT_MISSING':'EVIDENCE_UNAVAILABLE',code:missingPlan?'PLAN_OR_POSITION_INCOMPLETE':'DEPENDENCY_NOT_VERIFIED',featureId:refs[0]??'C10',evidenceIds:[],action:missingPlan?'Specify traction/exit predicates and record a hypothetical or reported position; no quantity is invented.':'Inspect the row evidence and frozen predicate; absence does not imply safety.'});}
    const unique=[...new Map(causes.map(c=>[`${c.category}:${c.code}:${c.featureId}:${c.field??''}`,c])).values()];
    const socialJudgment=check.checkId==='SOC-01'?details?.social?.identityReview:check.checkId==='SOC-02'?details?.social?.integrityReview:check.checkId==='SOC-03'?details?.social?.participationReview:check.checkId==='ATT-02'?details?.social?.communityBreadthReview:undefined;
    return {unknownKind:check.status==='UNKNOWN'?unknownCauseKind(unique):null,socialJudgment,group,required:'required' in check?check.required:false,checkId:check.checkId,name:names[check.checkId]??check.checkId,status:check.status,featureRefs:refs,evidenceRefs:group?group.evidenceIds:[...new Set([...check.evidenceRefs,...assessments.flatMap(a=>a.evidenceIds)])],values:refs.map(id=>{const f=snapshot.features.find(f=>f.id===id);return {id,name:details?.social&&id==='S05'?'Public account age and activity':details?.social&&id==='S04'?'Sampled synchrony contrast':featureMetadata.find(m=>m.id===id)?.name??id,value:f?.value??null,unit:f?.unit??null,quality:f?.quality??'MISSING'};}),thresholds:(riskKeys[check.checkId]??[]).map(field=>({field,value:field==='sizeUsd'?details?.profile.sizeUsd:field==='horizonSeconds'?details?.profile.horizonSeconds:details?.profile.risk[field]})),causes:unique};
  });
}
const categoryText:Record<MissingCause['category'],string>={USER_INPUT_MISSING:'missing setting',EVIDENCE_UNAVAILABLE:'evidence unavailable',COLLECTION_UNIMPLEMENTED:'collection not implemented',CLAIM_UNVALIDATED:'claim not validated'};
export function renderSnapshot(snapshot:Snapshot,options:{details?:AssessmentDetails;checklist?:boolean;check?:string;evidence?:boolean}={}):string {
  const details=options.details??snapshot.details,rows=explainChecks(snapshot,details),lines:string[]=[];
  if(options.check){const row=rows.find(r=>r.checkId===options.check);if(!row)throw new Error('CHECK_NOT_FOUND');lines.push(`${row.checkId} ${row.name}: ${row.status}${row.unknownKind?` (${row.unknownKind})`:``}`,...row.values.map(v=>`  ${v.id} ${cleanText(v.name)}: ${cleanText(v.value??'unknown')} ${cleanText(v.unit)} (${v.quality})`),...row.thresholds.map(t=>`  Your ${t.field}: ${cleanText(t.value??'unset')}`),...row.causes.map(c=>`  ${categoryText[c.category]} / ${c.code}: ${cleanText(c.action)}`));if(row.group){lines.push(`  Current group decision code: ${cleanText(row.group.code)}`,`  Current group criterion: ${cleanText(row.group.rationale,1200)}`,`  Evidence window available at: ${row.group.availableAt}`);const metrics=Object.entries(row.group.metrics).sort(([a],[b])=>a.localeCompare(b));if(metrics.length)lines.push(`  Current metrics: ${metrics.slice(0,12).map(([key,value])=>`${cleanText(key,80)}=${metricValueText(value)}`).join('; ')}${metrics.length>12?`; ${metrics.length-12} additional metrics`:''}`);for(const limitation of row.group.limitations.slice(0,8))lines.push(`  Limitation: ${cleanText(limitation,300)}`);if(row.group.limitations.length>8)lines.push(`  ${row.group.limitations.length-8} additional limitations.`);}if(row.socialJudgment){lines.push(`  Public-evidence review: ${row.socialJudgment.verdict} — ${cleanText(row.socialJudgment.rationale)}`);if(row.socialJudgment.missingIndicators.length)lines.push(`  Desired indicators unavailable: ${row.socialJudgment.missingIndicators.join(', ')}. Missing statistics are visibility risks, not proof of fraud, bots or manipulation.`);if(row.checkId==='SOC-01'&&row.status==='FAIL')lines.push('  Inadequate or contradicted public identity evidence does not prove impersonation.');}if(options.evidence)lines.push(...snapshot.evidence.filter(e=>row.evidenceRefs.includes(e.id)).map(e=>`  Evidence ${cleanText(e.id)}: ${cleanText(e.sourceId)} / ${e.accessMode}, retrieved ${e.retrievedAt}, SHA256 ${e.contentHash}`));return lines.join('\n')+'\n';}
  const title=snapshot.checklistKind==='ENTRY'?`ENTRY — ${snapshot.result.classification.replaceAll('_',' ')}`:`MANAGEMENT — ${snapshot.result.thesisState}`;
  const mode='analysisKind' in snapshot?snapshot.analysisKind:undefined;
  lines.push(title,`Evidence mode: ${mode??'saved management inputs'}${mode==='FIXTURE'?' — SYNTHETIC TEST SCENARIO; not a live token assessment':''}`,`Token: ${cleanText(snapshot.token?`${snapshot.token.chain} ${snapshot.token.address}`:'saved case '+snapshot.caseId)}`,`As of: ${snapshot.cutoff}`);
  if(details)lines.push(`Scenario: $${details.profile.sizeUsd??'unset'} / ${details.profile.horizonSeconds===undefined?'unset horizon':`${details.profile.horizonSeconds/3600} hours`} / ${cleanText(details.profile.id)}`,`Risk limits: transfer ${details.profile.risk.maxTransferFeeBps??'unset'} bps; entry ${details.profile.risk.maxEntryImpactBps??'unset'} bps; exit ${details.profile.risk.maxExitImpactBps??'unset'} bps; round trip ${details.profile.risk.maxRoundTripLossBps??'unset'} bps; control ${details.profile.risk.maxDirectControlShare??'unset'}; removable liquidity ${details.profile.risk.maxRemovableLiquidityShare??'unset'}.`,`Settings origin: ${cleanText(Object.entries(details.origins).map(([k,v])=>`${k}=${v}`).join(', '))||'frozen snapshot'}. Preset thresholds are uncalibrated; friction is not a price stop.`);
  else lines.push('Legacy snapshot: detailed settings/diagnostics were not stored in this envelope. Use explain to inspect its frozen checks.');
  if(snapshot.checklistKind==='ENTRY')lines.push(`Required coverage: ${snapshot.result.coverage.known}/${snapshot.result.coverage.total}. Unknown is missing evidence, not a detected-rug finding.`);
  if(snapshot.checklistKind==='ENTRY'){const unknown=snapshot.result.checks.filter(c=>c.status==='UNKNOWN');lines.push(`All checklist UNKNOWN rows: ${unknown.length} (${unknown.filter(c=>c.required).length} inside current required coverage; ${unknown.filter(c=>!c.required).length} outside it). Excluded rows are not completed capabilities.`);}
  else lines.push(`Baseline: ${snapshot.baselineSnapshotId} / episode ${snapshot.episodeId}`,`Proposal: ${snapshot.result.proposal}${snapshot.result.proposedQuantityAtomic?` (${snapshot.result.proposedQuantityAtomic} token atoms)`:'; no execution'}`);

  if(snapshot.checklistKind==='MANAGEMENT'){
    const position=snapshot.result.position;
    if(position?.status==='KNOWN')lines.push(`Position: ${position.mode}; remaining ${position.remainingQuantityAtomic} token atoms; decimals ${position.decimals}`);
    else if(position)lines.push('Position: missing; no quantity is invented.');
    for(const quote of snapshot.result.exitQuotes??[])lines.push(`Exit quote ${quote.request.purpose}: ${quote.status} / ${quote.reasonCode}; quantity ${quote.request.quantityAtomic} token atoms; leg ${quote.request.legId??'all remaining'}; basis ${quote.request.executionBasis.fingerprint}${quote.label?`; ${cleanText(quote.label)}`:''}`);
  }
  if(snapshot.checklistKind==='ENTRY')for(const pillar of ['ONCHAIN','ATTENTION','SOCIAL','SHARED'] as const){const checks=snapshot.result.checks.filter(c=>c.pillar===pillar&&c.required);lines.push(`${pillar.toLowerCase()} pillar: ${checks.filter(c=>c.status==='PASS').length} supported, ${checks.filter(c=>c.status==='FAIL').length} contradicted, ${checks.filter(c=>c.status==='UNKNOWN').length} unknown.`);}
  const market=snapshot.market?.pairs.find(p=>p.mintSide==='base'&&p.priceUsd!==null);
  if(market)lines.push(`Market observation: $${market.priceUsd}/token; displayed liquidity $${market.liquidityUsd??'unknown'}; rolling 24h volume $${market.volume24hUsd??'unknown'}. This is not executable depth.`);
  const execLiq=details?.executableLiquidity;
  if(execLiq){
    const a=execLiq.aggregate,f=execLiq.freshness,routes=execLiq.routes.length,known=execLiq.routes.filter(r=>r.outcome.status==='KNOWN').length;
    const asOf=`as of ${execLiq.cutoff}${f.bankClockAt?`; on-chain bank clock ${f.bankClockAt}`:''}${f.usdObservedAt?`; USD references observed ${f.usdObservedAt}`:''}${f.expiresAt?`; expires ${f.expiresAt}`:''}; ${f.freshAtCutoff?'fresh':'not fresh'} at the cutoff`;
    if(a.status==='PRIMARY_KNOWN'){
      lines.push(`Executable sell liquidity: ~$${rationalText(a.netUsd)} quote-net cash output across ${routes} enumerated direct route${routes===1?'':'s'}, each at the approved ${execLiq.impactBps} bps fee-inclusive average price impact versus its own pre-trade on-chain price; reference notional ~$${rationalText(a.referenceNotionalUsd)} for ${a.chosenInputSumAtoms} token atoms sold${a.weightedImpactBps?`; weighted impact ~${rationalText(a.weightedImpactBps,1)} bps`:''}; ${asOf}.`);
      for(const x of a.assets)lines.push(`  ${x.cashAsset}: ${atomsText(x.netAtoms,x.decimals)} net (~$${rationalText(x.netUsd)}${x.usdPerUnit?` at recorded reference ~$${rationalText(x.usdPerUnit,4)}/${x.cashAsset}`:''}) from ${x.routePools.length} route${x.routePools.length===1?'':'s'}.`);
    }else{
      lines.push(`Executable sell liquidity: not a complete total — ${known}/${routes} enumerated direct cash routes known at the ${execLiq.impactBps} bps fee-inclusive average-impact limit; blockers: ${a.blockers.map(b=>`${b.code}${b.subjects.length?` (${b.subjects.length})`:''}`).join(', ')}; ${asOf}.`);
      for(const x of a.knownSubtotals)lines.push(`  Known-route subtotal only, not a completion: ${x.cashAsset} ${atomsText(x.knownSubtotalAtoms,x.decimals)} net from ${x.knownPools.length} route${x.knownPools.length===1?'':'s'}.`);
    }
    const phys=execLiq.routes.flatMap(r=>r.outcome.status==='KNOWN'?[{asset:String(r.cashAsset),v:r.outcome.facts.vaults.output,d:r.outcome.facts.decimals.output}]:[]);
    if(phys.length){
      const byVault=new Map<string,{asset:string;mint:string;d:number;atoms:string}>(),conflictVaults=new Set<string>();
      for(const p of phys){const addr=String(p.v.address),cur={asset:p.asset,mint:String(p.v.mint),d:p.d,atoms:String(p.v.amountAtoms)},prev=byVault.get(addr);if(!prev)byVault.set(addr,cur);else if(prev.asset!==cur.asset||prev.mint!==cur.mint||prev.d!==cur.d||prev.atoms!==cur.atoms)conflictVaults.add(addr);}
      const byMint=new Map<string,{asset:string;d:number;atoms:bigint;vaults:number;conflict:boolean}>();
      for(const [addr,x] of byVault){const c=conflictVaults.has(addr),m=byMint.get(x.mint);if(!m)byMint.set(x.mint,{asset:x.asset,d:x.d,atoms:c?0n:BigInt(x.atoms),vaults:1,conflict:c});else{m.vaults++;if(c||m.asset!==x.asset||m.d!==x.d)m.conflict=true;else m.atoms+=BigInt(x.atoms);}}
      const refs=execLiq.usd?.status==='OBSERVED'?execLiq.usd.refs:[];
      let total:{num:bigint;den:bigint}|null={num:0n,den:1n};
      lines.push(`  Physical output-vault balances (separate context, not sellable capacity): from ${known}/${routes} enumerated routes known${known<routes?' — partial, not complete':''}; ${byVault.size} distinct output vault${byVault.size===1?'':'s'} after deduplicating shared vault addresses; recorded raw balances include accrued fees and dust; wrapped SOL counts the recorded token amount only, not rent or surplus lamports; ${asOf}.`);
      for(const [mint,m] of byMint){
        if(m.conflict){total=null;lines.push(`  Physical ${m.asset}: unavailable — conflicting duplicate vault metadata across ${m.vaults} vault${m.vaults===1?'':'s'}; no sum shown.`);continue;}
        const ref=refs.find(r=>r.mint===mint);
        if(ref&&ref.status==='KNOWN'&&ref.asset===m.asset){
          const num=m.atoms*BigInt(ref.priceUsd.num),den=BigInt(ref.priceUsd.den)*10n**BigInt(m.d);
          if(total)total={num:total.num*den+num*total.den,den:total.den*den};
          lines.push(`  Physical ${m.asset}: ${atomsText(m.atoms.toString(),m.d)} in ${m.vaults} vault${m.vaults===1?'':'s'} (~$${rationalText({num:num.toString(),den:den.toString()})} at recorded reference ~$${rationalText(ref.priceUsd,4)}/${m.asset}).`);
        }else{total=null;lines.push(`  Physical ${m.asset}: ${atomsText(m.atoms.toString(),m.d)} in ${m.vaults} vault${m.vaults===1?'':'s'}; USD reference unavailable.`);}
      }
      lines.push(total?`  Physical reference-USD total, known-route vaults only: ~$${rationalText({num:total.num.toString(),den:total.den.toString()})}${known<routes?' (partial coverage)':''}; not sellable capacity.`:'  No physical reference-USD total: a needed USD reference or vault binding is unavailable.');
    }
    lines.push('  Scope: direct enumerated PumpSwap, Meteora DLMM and DAMM v2 pools selling into WSOL/USDC/USDT/WBTC; only quoted trading fees are deducted, network fees, rent, account setup, priority fees and unwrapping are not included. The sale size is hypothetical, not wallet availability; physical output-vault balances are separate context, not capacity. Dollar figures are rounded; exact rationals are in JSON. This indicator is not an entry check.');
  }
  if(snapshot.collection)lines.push(`Sources: RPC ${snapshot.collection.rpc.state}${snapshot.collection.rpc.code?`/${snapshot.collection.rpc.code}`:''}; DEX ${snapshot.collection.dex.state}; web ${snapshot.collection.web.state}${snapshot.collection.web.code?`/${snapshot.collection.web.code}`:''}.`);
  const recovered=snapshot.evidence.filter(e=>e.scope.method==='tinyfish-live-dex-json-v1').map(e=>e.id);
  if(details?.advisory){
    const a=details.advisory;
    lines.push(`Advisory measurements: ${a.metrics.filter(m=>m.quality==='KNOWN').length}/${a.metrics.length} measured. Coverage is descriptive, not an investment verdict.`);
    for(const group of a.groups){
      lines.push(`  ${group.checkId}: ${group.known}/${group.total} measured; ${group.unresolved.length} unresolved.`);
      for(const id of group.unresolved){const metric=a.metrics.find(m=>m.id===id)!;lines.push(`    ${id}: ${cleanText(metric.reasonCode)}.`);}
    }
    if(snapshot.evidence.some(e=>e.id==='advisory-executor-capture'&&e.accessMode==='USER_IMPORT'))lines.push('Current advisory executor review (USER_IMPORT): fresh bounded source bodies, classified by separate Codex and Claude Code CLI executions. Operator-recorded execution provenance; entry judgments are excluded, and unresolved fields stay unknown.');
    if(snapshot.evidence.some(e=>e.id==='advisory-executor-bodies'))lines.push('  Expanded post text is provider-reported FxTwitter text. Official X receipts corroborate identity, time, revision and visible prefix; they do not authenticate the unseen suffix. Original rendered context is retained separately from the selected own body.');
    if(snapshot.evidence.some(e=>e.id==='advisory-recorded-incentives-capture'&&e.accessMode==='USER_IMPORT')){
      const metric=a.metrics.find(m=>m.id==='S08');
      lines.push(`Recorded historical public incentives (USER_IMPORT): S08 ${metric?.quality??'MISSING'}. Prior captured source bodies and operator-recorded independent classifications; hidden compensation and activity outside this sample remain unmeasured.`);
    }
    const recordedCallers=snapshot.evidence.find(e=>e.id==='advisory-recorded-callers-capture'&&e.accessMode==='USER_IMPORT');
    if(recordedCallers){
      const measured=a.metrics.filter(m=>m.evidenceIds.includes(recordedCallers.id));
      lines.push(`Recorded historical caller review (USER_IMPORT): ${measured.map(m=>`${m.id} ${m.quality}`).join('; ')||'no qualified measurements'}.`,
        '  Prior captured source bodies, classified in separate Codex and Claude Code executions; not a current platform-wide activity measure. Execution provenance is operator-recorded.');
    }
    const absorptionCapture=snapshot.evidence.find(e=>e.id==='advisory-a29-capture'&&e.accessMode==='USER_IMPORT');
    if(absorptionCapture){
      const absorption=a.metrics.find(m=>m.id==='A29');
      lines.push(`A29 distribution absorption: ${absorption?.quality??'MISSING'} / ${cleanText(absorption?.reasonCode??'ADVISORY_EVIDENCE_REQUIRED')}. Imported historical capture (USER_IMPORT); last source retrieval ${absorptionCapture.retrievedAt}; selected pool only.`, '  Depth uses modelled sell quotes at the captured states, with network and setup costs excluded.');
    }
    // Supplementary scoped report: outside the measured metrics and coverage counts, never a canonical A30 result.
    const s=a.supplements?.shortDemand;
    if(s){
      // The hour is fixed by the frozen canonical end at collection, never by the later snapshot cutoff; the proof hash is the retained derivation artifact's, not the snapshot hash.
      const derivationHash=snapshot.evidence.find(e=>e.id==='advisory-derivation')?.contentHash;
      lines.push(`Supplementary one-hour demand (not A30; not counted): ${s.status} / ${cleanText(s.reasonCode)}.`,`  Scope: one verified PumpSwap WSOL pool; baseline ${s.baseline.start} to ${s.baseline.end}; measured ${s.measured.start} to ${s.measured.end} in six 10-minute windows.`,`  Hour basis: latest completed UTC hour at collection freeze (frozen canonical end ${s.canonical.range.end}; report end ${s.reportEnd}). Snapshot cutoff ${snapshot.cutoff} is the later capture cutoff and does not move this hour.`,`  Source derivation proof SHA256: ${derivationHash?cleanText(derivationHash,128):'unavailable'}.`);
      if(s.complete)lines.push(`  Windows with a first-observed meaningful buyer and nonnegative net flow: ${s.satisfiedWindows}/${s.denominator} (share ${s.share}); conditions ${s.windows.map(w=>String(w.condition)).join(', ')}.`,`  First-observed buyers per window ${s.windows.map(w=>w.firstObservedBuyerCount).join('/')}; baseline meaningful buyers ${s.baseline.meaningfulBuyers}; net ${s.measured.flow?.netQuoteAtomic} measured vs ${s.baseline.flow?.netQuoteAtomic} baseline atomic WSOL, fee-exclusive.`);
      else lines.push('  Conditions, satisfied count and share unavailable: the two-hour source coverage is incomplete; no zero is inferred.');
      if(s.coverage.outsideScopeUnresolvedTransactions)lines.push(`  ${s.coverage.outsideScopeUnresolvedTransactions} unresolved transactions before the two-hour start were excluded.`);
      lines.push('  First observed within this two-hour pool tape only; not first-ever buyers, people, organic demand or new capital.');
    }
    lines.push('Historical data became available at retrieval time. Token movements are not automatically sales; routers are not bot or common-control identities. Undefined ratios and uncalibrated regimes remain unresolved.');
  }
  if(recovered.length)lines.push(`Market recovery: free TinyFish live Fetch (${recovered.join(', ')}); original direct responses retained. Recovery does not certify market accuracy.`);
  const feeRetries=snapshot.evidence.filter(e=>e.id.endsWith('-min-context-recovery')||/^curve-(?:entry|exit)-fee-recovery$/.test(e.id));
  if(feeRetries.length)lines.push(`Fee recovery: ${feeRetries.length} bounded retries while the RPC caught up to the required finalized slot; the slot requirement and quote expiry were preserved.`);
  if(snapshot.evidence.some(e=>e.id==='pump-slippage-refresh'))lines.push('Execution recovery: one complete fresh-state quote and unsigned simulation retry; the spending limit was not widened.');
  if((details?.baseline.find(a=>a.id==='O16')?.data as {method?:string}|undefined)?.method==='pump-budget-rejection-v1')lines.push('Execution finding: both unsigned buys exceeded their exact quoted spending limit. FAIL means the entry execution-cost standard was not met; fees, sellability and fraud are not established.');
  if(snapshot.evidence.some(e=>e.id==='social-repair-selection'))lines.push('Social review recovery: one reassessment and fresh independent review were attempted; the original rejection is retained. Only an accepted review can change the result.');
  if(snapshot.semantic)lines.push(`Semantic extraction: ${snapshot.semantic.status}, ${snapshot.semantic.claims.length} claims. ${snapshot.semantic.status==='VALIDATED'?'Validated means source-qualified by automated review, not verified real-world truth.':'Candidates are source claims, not verified checklist evidence.'}`);
  const models=[...new Set(snapshot.evidence.filter(e=>e.id.includes('-transport-attempt-')).map(e=>e.scope.model).filter((m):m is string=>typeof m==='string'))];
  if(models.length)lines.push(`Hosted models attempted: ${models.map(m=>cleanText(m,100)).join(', ')}. Each accepted claim still requires independent source review.`);
  if((details?.baseline.find(a=>a.id==='A03')?.data as {originBasis?:string}|undefined)?.originBasis==='PUBLIC_EVIDENCE_INADEQUATE')lines.push('Origin screening FAIL: reviewed public origin/catalyst evidence is inadequate within the declared discovery sample. This is poor traceability, not a finding of fraud.');
  if(details?.shared){const s=details.shared;lines.push(`Shared evidence: ${s.witnesses.filter(w=>w.status!=='UNKNOWN').length}/${s.witnesses.length} required decisions resolved; semantic receipts ${s.semanticQualified?'qualified':'incomplete'}; conflict audit ${s.auditQualified?'qualified':'incomplete'} (${s.conflicts.length} scoped conflicts).`);if(s.unresolved.length)lines.push(`Shared coverage waits for: ${s.unresolved.join(', ')}.`);lines.push('Growth compares two equal time bins in the reviewed fixed sample. Data-quality checks assess this decision scope; they do not certify token truth or platform-wide coverage.');}
  if(details?.shared?.qualityMode==='ENTRY_GATES_V1')lines.push('Data-quality FAIL means the analysis evidence standard is unmet. An incomplete conflict audit is not a detected conflict.');
  if(details?.groups||details?.shared?.qualityMode==='ENTRY_GROUPS_V1')lines.push('All five entry groups are required in this policy. Each group uses current criterion-level evidence; unlisted history and metrics were not measured and are not treated as zero.');
  for(const a of details?.baseline??[]){const d=a.data as {entryDecisionMethod?:string;entryCriterion?:string;decision?:{verdict:string;rationale:string}};if(['binary-public-support-v1','binary-public-support-v2','binary-public-support-v3','binary-public-support-v4'].includes(d?.entryDecisionMethod??'')&&d.decision)lines.push(`Entry evidence ${d.entryCriterion}: ${d.decision.verdict} — ${cleanText(d.decision.rationale)}`);}
  if(details?.social){
    const s=details.social;
    for(const [label,judgment] of [['Identity verifiability',s.identityReview],['Source integrity',s.integrityReview],['Participation evidence',s.participationReview]] as const)if(judgment){
      lines.push(`  ${label}: ${judgment.verdict} — ${cleanText(judgment.rationale)}`);
      if(judgment.missingIndicators.length)lines.push(`    Desired indicators unavailable: ${judgment.missingIndicators.map(indicator=>cleanText(indicator)).join(', ')}. Missing statistics are visibility risks, not proof of fraud, bots or manipulation.`);
    }
    if(s.identityReview?.verdict==='CONTRADICTED')lines.push('  SOC-01 FAIL concerns inadequate or contradicted public identity evidence; it does not prove impersonation.');
    lines.push(`Social assessment: automated extraction and independent source review when available, ${s.start} to ${s.end}. Accounts are not people; public binding is not an authenticity guarantee.`,
      `  Sample: ${s.qualifiedOriginalCount??'unknown'} qualified original posts; ${s.accountUpperBound??'unknown'} source accounts; ${s.sampleComplete?'complete within the declared query sample':s.participationReview&&s.participationReview.verdict!=='UNRESOLVED'?'entry evidence reviewed; exact participation counts remain unqualified':'incomplete query/review scope'}.`,
      `  Independent origins: ${s.independentGroupCount??'unknown'}; communities: ${s.independentCommunityCount??'unknown'}; ${s.lineageComplete?'source lineage qualified':'source lineage unresolved'}. Participation threshold: 3 accounts / 2 origins / 2 communities.`);
    const identity=details.baseline.find(a=>a.id==='S01')?.data as {claims?:Array<{accountId:string;status:string}>}|undefined;
    for(const claim of identity?.claims??[])lines.push(`  Account ${cleanText(claim.accountId)}: ${cleanText(claim.status)}.`);
    const metrics=details.baseline.find(a=>a.id==='S06')?.data as {required?:number;coverage?:Record<string,number>}|undefined;
    if(metrics?.coverage)lines.push(`  Exact engagement fields: likes ${metrics.coverage.likes}/${metrics.required}; replies ${metrics.coverage.replies}/${metrics.required}; reposts ${metrics.coverage.reposts}/${metrics.required}. Missing fields are not zero.`);
    const history=details.baseline.find(a=>a.id==='S05')?.data as {indicators?:Array<{createdAt:string|null;historyPosts:number}>}|undefined;
    if(history?.indicators)lines.push(`  Account evidence: ${history.indicators.filter(a=>a.createdAt!==null).length}/${history.indicators.length} exact creation dates; ${history.indicators.filter(a=>a.historyPosts>=3).length}/${history.indicators.length} accounts with at least 3 dated original history posts.`);
    const synchrony=details.baseline.find(a=>a.id==='S04')?.data as {currentPeakFraction?:string|null;previousPeakFraction?:string|null;previousOriginals?:number}|undefined;
    if(synchrony?.currentPeakFraction!==undefined)lines.push(`  Minute synchrony: current peak fraction ${synchrony.currentPeakFraction??'unknown'}; prior equal-window peak ${synchrony.previousPeakFraction??'unknown'} (${synchrony.previousOriginals??0} prior originals). This is an uncalibrated sample contrast, not manipulation proof.`);
    for(const id of ['S04','S05']){const a=details.baseline.find(a=>a.id===id);if(a?.causes.length)lines.push(`  ${id}: ${a.causes.map(c=>cleanText(c.code)).join('; ')}.`);}
    const participation=rows.find(r=>r.checkId==='SOC-03');if(participation?.status==='FAIL'&&s.sampleComplete&&s.accountUpperBound!==null&&s.accountUpperBound<3)lines.push(`  SOC-03: the complete reviewed sample contains at most ${s.accountUpperBound} qualifying accounts, below 3. This bounded shortfall does not establish platform-wide inactivity.`);
  }
  const attention=details?.baseline.filter(a=>a.limitations.some(l=>l.startsWith('automated-source-review-v1')))??[];
  if(attention.length){
    lines.push('Attention qualification: two-pass automated source review. Describes cited source claims and a bounded search sample; it does not verify real-world claims or measure all social traffic.');
    for(const a of attention.filter(a=>['A01','A05'].includes(a.id)&&a.quality==='KNOWN')){const data=a.data as {method?:string;publicSupport?:{rationale:string}};if(data.method==='narrative-public-support-v1'&&data.publicSupport)lines.push(`  ${a.id==='A01'?'Narrative':'Explainable thesis'} support: FAIL — ${cleanText(data.publicSupport.rationale)} Factual narrative remains unresolved; this is poor public support, not a proven false story or fraud.`);}
    for(const id of ['A01','A02','A03','A04','A05']){const a=attention.find(a=>a.id===id);const data=a?.data as {summary?:string}|undefined;if(data?.summary)lines.push(`  ${featureMetadata.find(f=>f.id===id)?.name}: ${cleanText(data.summary)}`);}
    const sample=attention.find(a=>a.id==='A16'),authors=attention.find(a=>a.id==='A17');
    if(sample?.quality==='KNOWN')lines.push(`  Observed qualified posts: ${sample.projection?.value}; source accounts: ${authors?.projection?.value??'unknown'} (sample threshold: 10 posts / 3 accounts).`);
    const representation=attention.find(a=>a.id==='A14')?.data as {method?:string;originRelationship?:{status:string;rationale:string};measuredAttention?:{status:string;shares:Array<{token:{chain:string;address:string};count:string;share:string|null}>};leadershipScreening?:{rationale:string};basis?:string}|undefined;
    if(representation?.method==='representation-routes-v2'){
      if(representation.leadershipScreening)lines.push(`  Entry public-support grade: FAIL — ${cleanText(representation.leadershipScreening.rationale)} (not proof of non-origin or non-leadership).`);
      lines.push(`  Origin relationship: ${representation.originRelationship?.status??'UNKNOWN'} — ${cleanText(representation.originRelationship?.rationale)}`);
      lines.push(`  Measured attention leadership: ${representation.measuredAttention?.status??'UNKNOWN'} (common-query sample; minimum 10 qualifying posts / 3 accounts / 2 representations).`);
      if(representation.basis==='ORIGIN')lines.push('  CAN-02 basis: origin-supported representation. Attention popularity is evaluated separately; origin support does not establish safety or authenticity.');
      else if(representation.basis==='MEASURED_ATTENTION')lines.push('  CAN-02 basis: unique measured attention leadership within the discovered sample.');
      const shares=representation.measuredAttention?.shares??[];
      for(const share of shares.slice(0,10))lines.push(`    ${cleanText(share.token.chain)}:${cleanText(share.token.address)} — ${cleanText(share.count)} weighted mentions${representation.measuredAttention?.status!=='UNKNOWN'?`; share ${cleanText(share.share)}`:'; insufficient comparative sample'}.`);
    }
  }
  if(snapshot.checklistKind==='ENTRY'){const failures=rows.filter(r=>r.status==='FAIL');if(failures.length)lines.push(`Known entry contradictions: ${failures.map(r=>`${r.checkId} ${r.name}`).join('; ')}. Inspect these rows before addressing missing evidence.`);}
  const modelFailures=[...new Set(details?.baseline.flatMap(a=>a.causes.map(c=>c.code)).filter(code=>/^(?:ATT|SOC|SHARED)_MODEL_(?:HTTP_\d+|TIMEOUT|RUN_TIMEOUT|RUN_ABORTED)$/.test(code))??[])];
  if(modelFailures.length)lines.push(`Unavailable model stages: ${modelFailures.map(code=>cleanText(code)).join(', ')}. Required checks blocked by these stages have no qualified result; this is not negative token evidence.`);
  const missingTopic=details?.baseline.some(a=>a.causes.some(c=>c.code==='ATT_NARRATIVE_TOKEN_BOUND_SOURCE_MISSING'));
  if(missingTopic)lines.push('Narrative evidence is missing: comparison waits for an independently qualified token-bound topic. A reference post or ticker alone is insufficient.');
  const program=details?.baseline.find(a=>a.id==='O05');if(program?.projection?.quality==='KNOWN'&&program.projection.value===false)lines.push('Program-control finding: an upgrade authority was observed on the shared token program. This fails the current immutable-program rule; it does not identify a token-specific rug.');
  const comparison=details?.baseline.find(a=>a.id==='A09');
  const adequacy=(comparison?.data as {evidenceAdequacy?:{rationale:string}}|undefined)?.evidenceAdequacy;
  if(comparison?.projection?.quality==='KNOWN'&&comparison.projection.value===false&&adequacy)lines.push(`Public representation evidence: inadequate after independent source review — ${cleanText(adequacy.rationale)}. This screening failure does not prove another competing token or fraud.`);
  if(details?.thesis){const t=details.thesis;const support=t.support.map(p=>({p,truth:evaluatePredicate(p,snapshot.features,snapshot.cutoff)})),invalid=t.invalidation.map(p=>({p,truth:evaluatePredicate(p,snapshot.features,snapshot.cutoff)}));lines.push(`Thesis: ${snapshot.checklistKind==='ENTRY'?(snapshot.result.binary==='PASS'?'eligible entry thesis':'proposed; management not started'):'frozen baseline comparison'}.`);for(const [label,xs] of [['Supports',support.filter(p=>p.truth==='TRUE')],['Contradicts',[...support.filter(p=>p.truth==='FALSE'),...invalid.filter(p=>p.truth==='TRUE')]],['Thesis unknown',[...support,...invalid].filter(p=>p.truth==='UNKNOWN')]] as const)lines.push(`${label}: ${xs.length?xs.map(x=>describePredicate(x.p)).join('; '):'none established'}.`);lines.push(`Plan readiness: ${t.legs.length&&t.onchainTraction&&t.externalTraction?'SPECIFIED':'INCOMPLETE (traction/realization not fully specified)'}. Expiry: ${t.expiryAt??'none selected'}.`);}
  lines.push('',`${snapshot.checklistKind==='ENTRY'?'Entry':'Management'} checklist:`);
  const selected=options.checklist?rows:rows.filter(r=>r.required||!r.checkId.startsWith('ADV-'));
  if(options.checklist&&rows.some(r=>r.checkId.startsWith('ADV-'))&&!details?.groups&&details?.shared?.qualityMode!=='ENTRY_GROUPS_V1')lines.push('ADV-* groups are outside the current required manifest and pillar totals. Missing collectors in these groups remain unfinished capabilities.');
  for(const id of ['A15','A18']){const a=details?.baseline.find(a=>a.id===id),d=a?.data as {method?:string;entryCriterion?:string;reason?:string}|undefined;if(d?.method==='entry-evidence-gate-v1')lines.push((id==='A18'?'Growth evidence branch':'Qualified sample evidence')+': FAIL — '+cleanText(d.reason)+ ' This does not establish zero posts or declining attention.'+(id==='A18'?' ATT-02 also evaluates community breadth independently.':''));}
  if(rows.some(r=>r.status==='UNKNOWN'))lines.push('Unknown causes: INFRA=request/quota/deadline; COLLECTION=blocked or incomplete sources; MODEL=unfinished or unqualified review; EXECUTION=quote/setup/simulation; INPUT=settings; IMPLEMENTATION=unsupported collector; DATA=missing evidence. Higher rate limits address only some INFRA failures.');
  for(const row of selected){const tags=[...new Set(row.causes.map(c=>categoryText[c.category]))];if(row.status==='UNKNOWN'&&row.featureRefs.some(id=>/^[OAS]/.test(id)))tags.push(...[...new Set(row.causes.map(c=>c.code))].slice(0,2));lines.push(`  ${(row.status+(row.unknownKind?` (${row.unknownKind})`:``)).padEnd(25)} ${row.checkId} ${row.name}${row.status==='UNKNOWN'?` — ${tags.join('; ')}`:''}${row.group?` — ${cleanText(row.group.rationale,220)} [${cleanText(row.group.code,80)}]`:''}`);}
  const actions=[...new Set(rows.flatMap(r=>r.status==='UNKNOWN'?r.causes.map(c=>c.action):[]))];
  lines.push('','Next actions:',...actions.slice(0,6).map(a=>`  - ${cleanText(a)}`),`  - Inspect a row offline: explain ${snapshot.id} --check <ID> --evidence`,`Snapshot: ${snapshot.id}`);
  return lines.join('\n')+'\n';
}
