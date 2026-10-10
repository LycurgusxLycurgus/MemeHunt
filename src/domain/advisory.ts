import { deriveMarketContext, type BaselineAssessment } from './baseline.js';
import type { TokenRef, EvidenceRecord } from './contracts.js';
import { advisoryFactsSchema, advisoryGroups, advisoryIds, type AdvisoryFacts, type AdvisoryMetric } from './advisory-contracts.js';
import type { ChainHistory } from '../providers/advisory-chain.js';
import type { MarketHistory } from '../providers/advisory-market.js';

const missing:Record<string,string>={
  O21:'STRONG_CONTROL_ASSOCIATION_EVIDENCE_REQUIRED',O22:'OLDEST_WALLET_HISTORY_REQUIRED',O23:'INDEPENDENT_INDICATORS_AND_NULL_BASELINE_REQUIRED',
  O24:'PINNED_FIXED_COHORT_ENDPOINTS_REQUIRED',O25:'INVENTORY_COST_AND_AGE_HISTORY_REQUIRED',O26:'DECODED_INVENTORY_RETURN_TRADES_REQUIRED',O27:'RELATED_PARTY_ATTRIBUTION_REQUIRED',O29:'COMPARABLE_DEPTH_AND_COHORT_BASELINE_REQUIRED',O30:'OFFICIAL_AUTOMATION_ATTRIBUTION_REQUIRED',
  A06:'REVIEWED_PERSISTENCE_HYPOTHESIS_REQUIRED',A07:'REVIEWED_ORIGINAL_THEME_HISTORY_REQUIRED',A08:'REVIEWED_ORIGINAL_ARTIFACT_INVENTORY_REQUIRED',A12:'COMPARABLE_COMPETITOR_EXECUTION_CAPACITY_REQUIRED',A13:'ECONOMIC_PARTICIPANT_AND_COMPETITOR_HISTORY_REQUIRED',A19:'QUALIFIED_EQUAL_WINDOW_CORPUS_REQUIRED',A20:'QUALIFIED_PROPAGATION_LINEAGE_REQUIRED',A21:'REVIEWED_EXTERNAL_ORIGIN_CATEGORIES_REQUIRED',A22:'PAID_DISCLOSURE_REVIEW_REQUIRED',A23:'QUALIFIED_POST_TOPIC_DENOMINATOR_REQUIRED',A24:'COMPARABLE_SATURATION_COMPONENTS_REQUIRED',A25:'PREREGISTERED_ALIGNED_LEAD_LAG_AND_NULL_TEST_REQUIRED',A26:'MEANINGFUL_FIRST_BUYER_HISTORY_REQUIRED',A27:'POSITIVE_ATTENTION_GROWTH_DENOMINATOR_REQUIRED',A28:'IDENTIFIABLE_DECAY_AND_CATALYST_HISTORY_REQUIRED',A29:'COMPARABLE_INVENTORY_AND_DEPTH_HISTORY_REQUIRED',A30:'COMPARABLE_MEANINGFUL_BUYER_AND_FLOW_WINDOWS_REQUIRED',
  S07:'FORWARD_CALL_EVENT_AND_EDIT_REVIEW_REQUIRED',S08:'CITED_INCENTIVE_DISCLOSURE_REVIEW_REQUIRED',S09:'QUALIFIED_CALL_EVENT_DENOMINATOR_REQUIRED',S11:'COMPARABLE_PARTICIPANT_WINDOWS_REQUIRED',S12:'ORIGINAL_CREATOR_AND_ASSOCIATION_EVIDENCE_REQUIRED',S13:'EXPLICIT_PUBLIC_WALLET_ASSOCIATION_REQUIRED',S14:'BOUND_ACTOR_TRADE_AND_CALL_HISTORY_REQUIRED',S15:'TRANSFER_AWARE_ACTOR_COST_BASIS_REQUIRED',S16:'PREREGISTERED_FOLLOWER_SIMULATION_REQUIRED',S17:'BOUND_ACTOR_PRE_POST_CALL_INVENTORY_REQUIRED',S18:'MEASURED_TRACKER_AND_FOLLOW_FLOW_EVIDENCE_REQUIRED',S19:'HISTORICAL_INDEPENDENT_ACTOR_GROUPS_REQUIRED',S20:'REPEATED_CAMPAIGNS_AND_NULL_BASELINE_REQUIRED',
  C07:'RECORDED_LIFECYCLE_WINDOWS_AND_HYSTERESIS_REQUIRED',C08:'MINT_BOUND_COMPLETED_CANDLES_REQUIRED',C09:'COMPLETE_DECLARED_CONTEXT_REQUIRED',C10:'FROZEN_TYPED_THESIS_CONDITIONS_REQUIRED',C11:'COMPARABLE_COMPLETED_CHAIN_VOLUMES_REQUIRED',C12:'FINALIZED_DEDUPLICATED_BRIDGE_TRANSFER_COVERAGE_REQUIRED',C13:'CONFIRMED_PIVOT_STRUCTURE_REQUIRED',C14:'CHART_CORROBORATION_CONTEXT_REQUIRED',C15:'COMPLETED_USD_MACRO_CANDLES_REQUIRED',C16:'LAUNCH_MIGRATION_AND_COHORT_HISTORY_REQUIRED',
};
export type AdvisoryInputs={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];baseline:BaselineAssessment[];chain:ChainHistory|null;market:MarketHistory|null;socialMetrics:AdvisoryMetric[];chainIds:string[];marketIds:string[];paidIds:string[]};

/** Measurements are descriptive; absence and undefined ratios are never adverse-token booleans. */
export function deriveAdvisory(input:AdvisoryInputs):AdvisoryFacts{
  const metrics=new Map(advisoryIds.map(id=>[id,{id,quality:'MISSING',unit:'scoped-record',data:null,evidenceIds:[],reasonCode:missing[id]??'ADVISORY_EVIDENCE_REQUIRED'} as AdvisoryMetric]));
  const set=(id:string,quality:AdvisoryMetric['quality'],data:unknown,evidenceIds:string[],reasonCode:string,unit='scoped-record')=>{
    metrics.set(id,{id,quality,data,evidenceIds:[...new Set(evidenceIds)],reasonCode,unit});
  };
  const validIds=(ids:string[])=>ids.every(id=>input.evidence.some(e=>e.id===id&&Date.parse(e.availableAt)<=Date.parse(input.cutoff)));
  if(!validIds([...input.chainIds,...input.marketIds,...input.paidIds]))throw new Error('ADVISORY_EVIDENCE_INVALID');
  for(const id of ['O28']){
    const assessment=input.baseline.find(a=>a.id===id);
    if(assessment?.quality==='KNOWN'&&assessment.data!==null&&assessment.evidenceIds.length&&validIds(assessment.evidenceIds))set(id,'KNOWN',assessment.data,assessment.evidenceIds,'EXISTING_QUALIFIED_MEASUREMENT',assessment.unit);
  }
  if(input.chain){
    const c=input.chain;
    if(c.token.chain!==input.token.chain||c.token.address!==input.token.address)throw new Error('ADVISORY_TOKEN_INVALID');
    const totals=new Map<string,bigint>();
    for(const movement of c.movements)totals.set(movement.owner,(totals.get(movement.owner)??0n)+BigInt(movement.deltaAtomic));
    set('O24','MISSING',{method:c.method,indexedAddresses:c.addresses,coveredInterval:c.coveredInterval,movements:c.movements,ownerNetAtomic:[...totals].sort(([a],[b])=>a.localeCompare(b)).map(([owner,delta])=>({owner,deltaAtomic:delta.toString()})),complete:c.complete,sourceUniverseComplete:c.sourceUniverseComplete,tradeCoverageComplete:c.tradeCoverageComplete,meaning:'Observed account movements only; neither endpoint-pinned cohort inventory nor decoded sales.'},input.chainIds,missing.O24,'atomic-movement-vector');
    set('O22','MISSING',{pages:c.pages,firstObservedInSample:c.coveredInterval?.start??null,meaning:'An index page cannot establish wallet creation or oldest wallet history.'},input.chainIds,missing.O22);
    set('O26','MISSING',{retainedTransactions:c.transactions.length,observedTransactions:c.transactions.filter(t=>t.status==='OBSERVED').length,sourceUniverseComplete:c.sourceUniverseComplete,tradeCoverageComplete:c.tradeCoverageComplete,meaning:'Movement returns are not certified circular trade motifs; arbitrage alternatives remain.'},input.chainIds,missing.O26);
  }
  if(input.market){
    const m=input.market;
    if(m.token.chain!==input.token.chain||m.token.address!==input.token.address||Date.parse(m.cutoff)>Date.parse(input.cutoff))throw new Error('ADVISORY_TOKEN_OR_TIME_INVALID');
    if(m.chart&&m.candles){
      const data={market:m.candles.market,quote:m.candles.quote,intervalSeconds:m.candles.intervalSeconds,start:m.candles.bars[0]?.start,end:m.candles.bars.at(-1)?.end,availableAt:m.cutoff,completedBars:m.candles.bars.length,...m.chart,limitations:m.limitations};
      set('C08',m.chart.returnFraction!==null?'KNOWN':'MISSING',data,input.marketIds,m.chart.returnFraction!==null?'COMPLETED_MARKET_CONTEXT_OBSERVED':missing.C08);
      set('C13',m.chart.trend!=='UNKNOWN'?'KNOWN':'MISSING',{...data,method:'confirmed-fractal-pivots-v1',leftBars:m.candles.leftBars,rightBars:m.candles.rightBars,toleranceBps:m.candles.comparisonToleranceBps},input.marketIds,m.chart.trend!=='UNKNOWN'?'CONFIRMED_CHART_STRUCTURE_OBSERVED':missing.C13);
      // No chart predicate is configured by --advisory. This is a genuine configuration state.
      set('C14','KNOWN',{result:'NOT_REQUESTED',predicate:null,meaning:'No named chart-thesis predicate was configured; no corroboration is claimed.'},input.marketIds,'CHART_PREDICATE_NOT_REQUESTED');
      set('O29','MISSING',{returnFraction:m.chart.returnFraction,pool:m.pool,depthChange:null,notionalAttribution:null,cohortBaseline:null},input.marketIds,missing.O29);
    }
    if(m.macro.length===3&&m.macro.every(series=>series.chart.returnFraction!==null))set('C15','KNOWN',m.macro.map(series=>({instrument:series.instrument,quote:'USD',start:series.bars[0]?.start,end:series.bars.at(-1)?.end,availableAt:m.cutoff,completedBars:series.bars.length,...series.chart})),input.marketIds,'COMPLETED_MACRO_CONTEXT_OBSERVED');
    if(m.contextWindow&&m.chainVolumes.length===3){
      const context=deriveMarketContext({window:m.contextWindow,chainVolumes:m.chainVolumes,bridges:[],bridgeComplete:false,macro:[]},input.token,input.cutoff);
      const ratiosDefined=context.activity.shareOfCoveredChains.every(chain=>chain.share!==null&&chain.changePercentagePoints!==null);
      set('C11',ratiosDefined?'KNOWN':'MISSING',context.activity,input.marketIds,ratiosDefined?'COMPARABLE_CHAIN_ACTIVITY_OBSERVED':'CHAIN_ACTIVITY_DENOMINATOR_ZERO');
    }
    set('C09','MISSING',{chains:m.chainVolumes,macroInstruments:m.macro.map(series=>series.instrument),bridge:null,launch:null,classification:null,meaning:'No fitted HOT/NORMAL/COLD regime; missing bridge and launch context remains explicit.'},input.marketIds,missing.C09);
  }
  for(const observation of input.socialMetrics){
    if(!advisoryIds.includes(observation.id)||!validIds(observation.evidenceIds))throw new Error('ADVISORY_SOCIAL_INPUT_INVALID');
    const ids=observation.id==='A22'?[...observation.evidenceIds,...input.paidIds]:observation.evidenceIds;
    set(observation.id,observation.quality,observation.data,ids,observation.reasonCode,observation.unit);
  }
  const values=advisoryIds.map(id=>metrics.get(id)!);
  return advisoryFactsSchema.parse({method:'advisory-measurements-v1',token:input.token,cutoff:input.cutoff,metrics:values,groups:advisoryGroups.map(group=>{const unresolved=group.featureIds.filter(id=>metrics.get(id)!.quality!=='KNOWN');return {checkId:group.checkId,total:group.featureIds.length,known:group.featureIds.length-unresolved.length,unresolved};})});
}
