import {advisoryMetricSchema,type AdvisoryMetric} from './advisory-contracts.js';

export const C09_CONTEXT_METHOD='source-backed-descriptive-chain-market-context-v1' as const;
const IDS=['C11','C12','C15','C16'] as const;
type ComponentId=typeof IDS[number];
export type C09ContextComponent={metricId:ComponentId;quality:AdvisoryMetric['quality'];reasonCode:string;unit:string;evidenceIds:string[];scope:unknown;windows:unknown;availability:unknown;coverage:unknown;history:unknown;values:unknown};
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const record=(v:unknown):Record<string,unknown>=>object(v)?v:{};
const list=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const copy=(v:unknown):unknown=>structuredClone(v??null);
const fields=(v:unknown,names:string[])=>{const d=record(v);return Object.fromEntries(names.map(k=>[k,copy(d[k])]));};
const missing=(id:ComponentId):AdvisoryMetric=>({id,quality:'MISSING',unit:'unavailable-component',data:null,evidenceIds:[],reasonCode:'C09_COMPONENT_NOT_PRESENT'});
function bridgeComplete(row:AdvisoryMetric,cutoff:number):boolean{
 const d=record(row.data),w=record(d.window),s=record(d.scope),end=typeof w.end==='string'?Date.parse(w.end):NaN;
 return row.quality==='KNOWN'&&row.reasonCode==='COMPLETE_ALL_ASSET_NATIVE_BRIDGE_FLOW'&&d.method==='completed-all-asset-native-bridge-flow-v1'&&d.status==='COMPLETE'&&s.bridge==='WORMHOLE_TOKEN_BRIDGE'&&s.assets==='ALL_CANONICAL_ASSETS'&&s.directions==='BOTH'&&Array.isArray(d.chains)&&Array.isArray(d.assets)&&row.evidenceIds.length>0&&Number.isFinite(end)&&end<=cutoff;
}
function component(row:AdvisoryMetric,id:ComponentId,acceptedBridge:boolean):C09ContextComponent{
 const d=record(row.data),base={metricId:id,quality:row.quality,reasonCode:row.reasonCode,unit:row.unit,evidenceIds:[...row.evidenceIds]};
 if(id==='C11')return{...base,scope:{comparisonUniverse:['solana','bsc','base','robinhood'],coveredChains:list(d.shareOfCoveredChains).map(v=>record(v).chain??null),excludedChains:copy(d.excludedChains)},windows:copy(d.window),availability:copy(record(d.window).availableAt),coverage:{shareOfCoveredChains:copy(d.shareOfCoveredChains),excludedChains:copy(d.excludedChains)},history:{comparison:'CURRENT_MINUS_PRIOR_COMPARABLE_SHARE_PERCENTAGE_POINTS',changes:list(d.shareOfCoveredChains).map(v=>fields(v,['chain','changePercentagePoints']))},values:copy(row.data)};
 if(id==='C12'){
  const values=acceptedBridge?{...fields(d,['method','status','scope','window','coverage','completedTransfers','canonicalAssets','chains','pending','feeBasis','premises','limitations']),assets:list(d.assets).map(v=>fields(v,['canonicalAssetId','originalDecimals','normalizationDecimals','mark','chains']))}:null;
  return{...base,scope:copy(d.scope),windows:copy(d.window),availability:{at:null,basis:'RETAINED_COMPONENT_EVIDENCE',evidenceIds:[...row.evidenceIds],meaning:'Source acquisition clocks are retained in cited evidence; snapshot cutoff is an upper bound, not a refreshed observation time.'},coverage:copy(d.coverage),history:{completionWindow:copy(d.window),pending:copy(d.pending),limitations:copy(d.limitations)},values};
 }
 if(id==='C15'){
  const rows=list(row.data);return{...base,scope:{instruments:rows.map(v=>fields(v,['instrument','quote']))},windows:rows.map(v=>fields(v,['instrument','start','end'])),availability:rows.map(v=>fields(v,['instrument','availableAt'])),coverage:rows.map(v=>fields(v,['instrument','completedBars'])),history:rows.map(v=>fields(v,['instrument','start','end','completedBars'])),values:copy(row.data)};
 }
 const counts=record(d.counts),money=record(d.money);
 return{...base,scope:copy(d.cohort),windows:{rolling:d.counts===null||d.counts===undefined?null:{...fields(counts,['observedBy','endNotBefore','asOf']),launches:list(counts.launches).map(v=>fields(v,['window','durationSeconds'])),migrations:list(counts.migrations).map(v=>fields(v,['window','durationSeconds']))},completedMoneyDay:copy(money.day)},availability:{counts:copy(counts.clock),money:copy(money.clocks)},coverage:{countsAvailable:d.counts!==undefined&&d.counts!==null,moneyAvailable:d.money!==undefined&&d.money!==null,causes:copy(d.causes)},history:{survival:copy(d.survival),comparability:copy(d.comparability),clockMeaning:copy(d.clockMeaning),limitations:copy(d.limitations)},values:copy(row.data)};
}

/** Compose only finalized source-reconstructed child rows. This function creates no
 * source authority: the explicit live profile and Service reconstruction gate its use. */
export function deriveC09MarketContext(metrics:AdvisoryMetric[],cutoff:string):AdvisoryMetric{
 const end=Date.parse(cutoff);if(!Number.isFinite(end))throw Error('C09_CONTEXT_CUTOFF_INVALID');
 const rows=IDS.map(id=>{const matches=metrics.filter(m=>m.id===id);if(matches.length>1)throw Error('C09_CONTEXT_COMPONENT_DUPLICATE');return matches.length?advisoryMetricSchema.parse(matches[0]):missing(id);});
 const completeBridge=bridgeComplete(rows[1],end),coverageComplete=completeBridge&&rows.every(row=>row.quality==='KNOWN');
 const components=Object.fromEntries(rows.map((row,i)=>[IDS[i],component(row,IDS[i],completeBridge)]));
 return{id:'C09',quality:completeBridge?'KNOWN':'MISSING',unit:'descriptive-chain-market-context',reasonCode:completeBridge?coverageComplete?'DESCRIPTIVE_MARKET_CONTEXT_COMPLETE_COVERAGE':'DESCRIPTIVE_MARKET_CONTEXT_PARTIAL_COVERAGE':'C09_COMPLETE_NATIVE_BRIDGE_CONTEXT_REQUIRED',evidenceIds:[...new Set(rows.flatMap(row=>row.evidenceIds))],data:{method:C09_CONTEXT_METHOD,cutoff,qualityMeaning:'KNOWN is a faithfully reconstructed descriptive vector with complete native C12 authority; component coverage remains separate.',coverageComplete,components,classification:null,classificationStatus:'NOT_ACTIVATED',limitations:['Different component intervals and source populations remain separate; no common-window total or combined score is defined.','Covered-chain DEX activity is not net new capital; covered bridge movement is not all chain inflow or memecoin demand.','Macro instruments are context, not a universal SOL multiplier or causal explanation.','Launch rolling aggregation ends are unpublished; completed money days and matured-cohort follow-up remain separate.']}};
}
