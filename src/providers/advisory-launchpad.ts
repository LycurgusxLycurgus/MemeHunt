import { Decimal } from 'decimal.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import { readLimitedText } from './http.js';

/** C16 launchpad context for one declared cohort: receipt-bound rolling launch/migration counts from SolanaTracker
 * Lighthouse and separately named completed-UTC-day volume/fees/revenue from DefiLlama. The two families never share
 * a window, so no ratio between them is defined; matured-cohort survival stays null without follow-up history. */
export const LAUNCHPAD_METHOD='launchpad-activity-context-v1';
export const LAUNCHPAD_COHORT={lighthouseMarket:'pumpfun',llamaSlug:'pump.fun',llamaId:'4449',meaning:'Declared pump.fun bonding-curve launchpad cohort joined by provider venue labels, not a proven identical token universe.'} as const;
export type LaunchpadKey='lighthouse'|'llama-volume'|'llama-fees'|'llama-revenue';
export type LaunchpadRequest={url:string;auth:'x-api-key-header'|'none'};
export type LaunchpadReceipts={rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;requests:Record<string,LaunchpadRequest>};
export const LAUNCHPAD_REQUESTS:Record<LaunchpadKey,LaunchpadRequest>={
  lighthouse:{url:'https://data.solanatracker.io/lighthouse',auth:'x-api-key-header'},
  'llama-volume':{url:'https://api.llama.fi/summary/dexs/pump.fun?dataType=dailyVolume',auth:'none'},
  'llama-fees':{url:'https://api.llama.fi/summary/fees/pump.fun?dataType=dailyFees',auth:'none'},
  'llama-revenue':{url:'https://api.llama.fi/summary/fees/pump.fun?dataType=dailyRevenue',auth:'none'},
};
const KEYS=Object.keys(LAUNCHPAD_REQUESTS) as LaunchpadKey[];
const WINDOWS=[['5m',300],['1h',3600],['6h',21600],['24h',86400]] as const;
const SERIES=[{key:'llama-volume',methodology:'Volume'},{key:'llama-fees',methodology:'Fees'},{key:'llama-revenue',methodology:'Revenue'}] as const;
const BYTE_LIMIT:Record<LaunchpadKey,number>={lighthouse:2_000_000,'llama-volume':2_000_000,'llama-fees':2_000_000,'llama-revenue':2_000_000};
const TRANSPORT_CODES=new Set(['LAUNCHPAD_TIMEOUT','LAUNCHPAD_TRANSPORT','LAUNCHPAD_RESPONSE_LIMIT','LAUNCHPAD_RESPONSE_EMPTY']);
const MARKET_KEYS=['market','label','icon','url','stats'],DAY=86_400_000;
const ISO_TIME=/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const HTTP_DATE=/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;
const LIMITATIONS=[
  'Lighthouse windows are live rolling provider windows ending no later than the receipt; the provider publishes no as-of time, so the window end has no lower bound and these are not completed UTC days.',
  'Lighthouse changePct is 0 when the previous window is 0 and is not retained; wallet counts are approximate HyperLogLog values and transaction sides are not reconciled, so neither is used.',
  'DefiLlama values are provider-priced USD for the completed UTC day bucket labelled by its start; fees and revenue are different provider definitions, retained with their methodology text.',
  'The Lighthouse pumpfun market and the DefiLlama pump.fun slug are joined by declared venue labels, not proven to cover an identical token universe.',
  'Matured-cohort survival requires launch-cohort follow-up history and stays null.',
  'Each read keeps its local request start and completion; the provider HTTP Date header is kept only as the provider response clock, is never an aggregation end or a freshness bound, and is null when the provider sent none.',
];
const CLOCK_MEANING='requestStartedAt and retrievedAt are the local bounds of each read and retrievedAt is its availability; httpDate is the provider HTTP response clock at whole-second resolution, checked against that bracket, and is not an aggregation end or a freshness bound.';

export type LaunchpadClock={requestStartedAt:string;retrievedAt:string;httpDate:string|null};
type Rolling={window:typeof WINDOWS[number][0];durationSeconds:number;total:number};
export type LaunchpadCounts={source:'solanatracker-lighthouse';market:string;observedBy:string;endNotBefore:null;asOf:'PROVIDER_UNPUBLISHED';clock:LaunchpadClock;meaning:string;launches:Rolling[];migrations:Rolling[]};
export type LaunchpadMoney={source:'defillama-summary';day:{start:string;end:string;interval:'[start,end)'};volumeUsd:string;feesUsd:string;revenueUsd:string;methodology:{volume:string;fees:string;revenue:string};clocks:{volume:LaunchpadClock;fees:LaunchpadClock;revenue:LaunchpadClock}};
export type LaunchpadContext={method:typeof LAUNCHPAD_METHOD;cohort:typeof LAUNCHPAD_COHORT;counts:LaunchpadCounts|null;money:LaunchpadMoney|null;survival:{fraction:null;reasonCode:'MATURED_COHORT_FOLLOWUP_UNAVAILABLE'};comparability:string;clockMeaning:string;causes:Record<string,string>;limitations:string[]};
type Days={values:Map<number,string>;methodology:string;clock:LaunchpadClock};
type Envelope={httpStatus:number;httpDate:string|null;startedAt:string;body:string}|{code:string;startedAt:string};

const object=(v:unknown):v is Record<string,any>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
function fail(code:string):never{throw new Error(code);}
const coded=(e:unknown)=>e instanceof Error&&/^LAUNCHPAD_[A-Z_]+$/.test(e.message)?e.message:'LAUNCHPAD_RESPONSE_INVALID';
const keysAre=(v:Record<string,unknown>,keys:readonly string[])=>Object.keys(v).sort().join()===[...keys].sort().join();
const iso=(ms:number)=>new Date(ms).toISOString();

/** One sequential read per fixed endpoint, no retries; the key travels only in x-api-key to Lighthouse and is never retained.
 * Each receipt keeps the exact bounded body, the local request start and, of all response headers, only Date. */
export async function collectLaunchpadContext(apiKey:string,fetcher:typeof fetch,now:()=>string,signal?:AbortSignal):Promise<LaunchpadReceipts>{
  if(typeof apiKey!=='string'||!/^[!-~]{8,256}$/.test(apiKey))fail('LAUNCHPAD_KEY');
  const out:LaunchpadReceipts={rawArtifacts:{},retrievedAt:{},requests:{}};
  for(const key of KEYS){
    const request=LAUNCHPAD_REQUESTS[key],startedAt=now();let raw:string;
    try{
      const timeout=AbortSignal.timeout(15_000);
      const response=await fetcher(request.url,{method:'GET',headers:request.auth==='x-api-key-header'?{'x-api-key':apiKey,accept:'application/json'}:{accept:'application/json'},redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});
      raw=JSON.stringify({httpStatus:response.status,httpDate:response.headers.get('date'),startedAt,body:await readLimitedText(response,BYTE_LIMIT[key])});
    }catch(e){
      signal?.throwIfAborted();
      const message=e instanceof Error?e.message:'';
      raw=JSON.stringify({code:e instanceof Error&&e.name==='TimeoutError'?'LAUNCHPAD_TIMEOUT':message==='PROVIDER_RESPONSE_LIMIT'?'LAUNCHPAD_RESPONSE_LIMIT':message==='PROVIDER_EMPTY_RESPONSE'?'LAUNCHPAD_RESPONSE_EMPTY':'LAUNCHPAD_TRANSPORT',startedAt});
    }
    if(raw.includes(apiKey))fail('LAUNCHPAD_CREDENTIAL_ECHO');
    out.rawArtifacts[key]=raw;out.retrievedAt[key]=now();out.requests[key]={...request};
  }
  return out;
}

/** IMF-fixdate only, with an exact round trip; the header has whole-second resolution, so the local read bracket widens only to whole seconds and allows no skew. */
function httpClock(value:string|null,started:number,completed:number):string|null{
  if(value===null)return null;
  const at=Date.parse(value);
  if(!HTTP_DATE.test(value)||!Number.isFinite(at)||new Date(at).toUTCString()!==value)fail('LAUNCHPAD_HTTP_DATE_INVALID');
  if(at<Math.floor(started/1000)*1000||at>Math.ceil(completed/1000)*1000)fail('LAUNCHPAD_HTTP_DATE_INCONSISTENT');
  return value;
}

function metric(v:unknown,split:boolean):void{
  if(!object(v)||!keysAre(v,split?['total','buys','sells','changePct']:['total','changePct']))fail('LAUNCHPAD_LIGHTHOUSE_SHAPE');
  for(const [k,n] of Object.entries(v))if(typeof n!=='number'||!Number.isFinite(n)||(k!=='changePct'&&n<0))fail('LAUNCHPAD_LIGHTHOUSE_SHAPE');
}
function count(v:Record<string,any>):number{if(!Number.isSafeInteger(v.total))fail('LAUNCHPAD_COUNT_INVALID');return v.total;}
/** Strict documented shape; approximate wallet and transaction-side fields are shape-checked, never reconciled or used. */
function lighthouseCounts(body:unknown,clock:LaunchpadClock):LaunchpadCounts{
  if(!Array.isArray(body)||!body.length||body.length>20_000)fail('LAUNCHPAD_LIGHTHOUSE_SHAPE');
  const seen=new Set<string>();let cohort:Record<string,any>|null=null;
  for(const entry of body){
    if(!object(entry)||MARKET_KEYS.some(k=>!Object.hasOwn(entry,k))||Object.keys(entry).some(k=>k!=='parent'&&!MARKET_KEYS.includes(k)))fail('LAUNCHPAD_LIGHTHOUSE_SHAPE');
    if(typeof entry.market!=='string'||!entry.market||['label','icon','url'].some(k=>typeof entry[k]!=='string')||(Object.hasOwn(entry,'parent')&&typeof entry.parent!=='string'))fail('LAUNCHPAD_LIGHTHOUSE_SHAPE');
    if(seen.has(entry.market))fail('LAUNCHPAD_LIGHTHOUSE_DUPLICATE_MARKET');seen.add(entry.market);
    if(!object(entry.stats)||!keysAre(entry.stats,WINDOWS.map(([w])=>w)))fail('LAUNCHPAD_LIGHTHOUSE_SHAPE');
    for(const [w] of WINDOWS){
      const t=entry.stats[w];
      if(!object(t)||!keysAre(t,['transactions','wallets','volume','tokensCreated','migrations']))fail('LAUNCHPAD_LIGHTHOUSE_SHAPE');
      metric(t.transactions,true);metric(t.wallets,false);metric(t.volume,true);metric(t.tokensCreated,false);metric(t.migrations,false);
    }
    if(entry.market===LAUNCHPAD_COHORT.lighthouseMarket)cohort=entry;
  }
  if(!cohort||Object.hasOwn(cohort,'parent'))fail('LAUNCHPAD_COHORT_UNBOUND');
  const bound=cohort,rolling=(field:'tokensCreated'|'migrations'):Rolling[]=>WINDOWS.map(([window,durationSeconds])=>({window,durationSeconds,total:count(bound.stats[window][field])}));
  return {source:'solanatracker-lighthouse',market:LAUNCHPAD_COHORT.lighthouseMarket,observedBy:clock.retrievedAt,endNotBefore:null,asOf:'PROVIDER_UNPUBLISHED',clock,meaning:'Live rolling windows of the stated duration ending at or before observedBy; not completed UTC days.',launches:rolling('tokensCreated'),migrations:rolling('migrations')};
}
function llamaDays(body:unknown,methodologyKey:string,clock:LaunchpadClock):Days{
  const retrievedAt=Date.parse(clock.retrievedAt);
  if(!object(body)||body.slug!==LAUNCHPAD_COHORT.llamaSlug||body.defillamaId!==LAUNCHPAD_COHORT.llamaId||!Array.isArray(body.totalDataChart)||body.totalDataChart.length>20_000)fail('LAUNCHPAD_LLAMA_BINDING');
  const methodology=object(body.methodology)?body.methodology[methodologyKey]:undefined;
  if(typeof methodology!=='string'||!methodology)fail('LAUNCHPAD_LLAMA_METHODOLOGY');
  const seen=new Set<number>(),values=new Map<number,string>();
  for(const row of body.totalDataChart){
    if(!Array.isArray(row)||row.length!==2||!Number.isSafeInteger(row[0])||row[0]<0||row[0]%86400!==0||seen.has(row[0]))fail('LAUNCHPAD_LLAMA_SHAPE');
    seen.add(row[0]);const start=row[0]*1000;
    if(start>retrievedAt)fail('LAUNCHPAD_LLAMA_FUTURE');
    if(typeof row[1]!=='number'||!Number.isFinite(row[1])||row[1]<0)fail('LAUNCHPAD_LLAMA_NUMBER');
    // The provider's current UTC day is still accumulating; only completed day buckets are observations.
    if(start+DAY<=retrievedAt)values.set(start,new Decimal(String(row[1])).toFixed());
  }
  return {values,methodology,clock};
}

/** Deterministic replay of the four fixed receipts; scope, envelope or read-clock violations throw, provider gaps and HTTP Date faults become named causes. */
export function decodeLaunchpadContext(receipts:LaunchpadReceipts,cutoff:string):LaunchpadContext{
  const cut=Date.parse(cutoff);if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(cutoff)||!Number.isFinite(cut))fail('LAUNCHPAD_TIME');
  const expected=[...KEYS].sort().join();
  if([receipts.rawArtifacts,receipts.retrievedAt,receipts.requests].some(part=>!object(part)||Object.keys(part).sort().join()!==expected))fail('LAUNCHPAD_REQUEST_SCOPE');
  const envelopes:Partial<Record<LaunchpadKey,Envelope>>={};let previous=-Infinity;
  for(const key of KEYS){
    const r:unknown=receipts.requests[key],retrievedAt=receipts.retrievedAt[key],at=typeof retrievedAt==='string'&&ISO_TIME.test(retrievedAt)?Date.parse(retrievedAt):NaN;
    if(!object(r)||!keysAre(r,['url','auth'])||r.url!==LAUNCHPAD_REQUESTS[key].url||r.auth!==LAUNCHPAD_REQUESTS[key].auth)fail('LAUNCHPAD_REQUEST_SCOPE');
    if(typeof receipts.rawArtifacts[key]!=='string'||!Number.isFinite(at)||at>cut)fail('LAUNCHPAD_TIME');
    let envelope:unknown;
    try{envelope=JSON.parse(receipts.rawArtifacts[key]!);}catch{fail('LAUNCHPAD_RECEIPT_INVALID');}
    // Every retained envelope, error receipts included, has the exact collector shape; anything else was not captured by this read.
    if(!object(envelope)||!(keysAre(envelope,['code','startedAt'])&&TRANSPORT_CODES.has(envelope.code)||keysAre(envelope,['body','httpDate','httpStatus','startedAt'])&&Number.isInteger(envelope.httpStatus)&&typeof envelope.body==='string'&&(envelope.httpDate===null||typeof envelope.httpDate==='string')))fail('LAUNCHPAD_RECEIPT_INVALID');
    const started=typeof envelope.startedAt==='string'&&ISO_TIME.test(envelope.startedAt)?Date.parse(envelope.startedAt):NaN;
    // Reads are sequential: each starts no earlier than the previous completion and completes no earlier than its own start.
    if(!Number.isFinite(started)||started>at||started<previous)fail('LAUNCHPAD_TIME');
    previous=at;envelopes[key]=envelope as Envelope;
  }
  const read=(key:LaunchpadKey):{body:unknown;clock:LaunchpadClock}=>{
    const envelope=envelopes[key]!;
    if('code' in envelope)fail(envelope.code);
    if(envelope.httpStatus!==200)fail('LAUNCHPAD_HTTP_UNAVAILABLE');
    const retrievedAt=receipts.retrievedAt[key]!;
    const clock:LaunchpadClock={requestStartedAt:envelope.startedAt,retrievedAt,httpDate:httpClock(envelope.httpDate,Date.parse(envelope.startedAt),Date.parse(retrievedAt))};
    try{return {body:JSON.parse(envelope.body),clock};}catch{return fail('LAUNCHPAD_RESPONSE_INVALID');}
  };
  const causes:Record<string,string>={};
  const attempt=<T>(key:string,operation:()=>T):T|null=>{try{return operation();}catch(e){causes[key]=coded(e);return null;}};
  const counts=attempt('lighthouse',()=>{const r=read('lighthouse');return lighthouseCounts(r.body,r.clock);});
  const [volume,fees,revenue]=SERIES.map(s=>attempt(s.key,()=>{const r=read(s.key);return llamaDays(r.body,s.methodology,r.clock);}));
  let money:LaunchpadMoney|null=null;
  if(volume&&fees&&revenue){
    const common=[...volume.values.keys()].filter(day=>fees.values.has(day)&&revenue.values.has(day));
    const day=common.length?Math.max(...common):null;
    // At most one completed day of provider publication lag, measured from each series' own receipt.
    if(day===null)causes.money='LAUNCHPAD_COMMON_COMPLETED_DAY_MISSING';
    else if(SERIES.some(s=>day+DAY<Math.floor(Date.parse(receipts.retrievedAt[s.key]!)/DAY)*DAY-DAY))causes.money='LAUNCHPAD_LLAMA_STALE';
    else money={source:'defillama-summary',day:{start:iso(day),end:iso(day+DAY),interval:'[start,end)'},volumeUsd:volume.values.get(day)!,feesUsd:fees.values.get(day)!,revenueUsd:revenue.values.get(day)!,methodology:{volume:volume.methodology,fees:fees.methodology,revenue:revenue.methodology},clocks:{volume:volume.clock,fees:fees.clock,revenue:revenue.clock}};
  }
  return {method:LAUNCHPAD_METHOD,cohort:LAUNCHPAD_COHORT,counts,money,survival:{fraction:null,reasonCode:'MATURED_COHORT_FOLLOWUP_UNAVAILABLE'},comparability:'Rolling counts and completed-day money series use different windows and sources; no ratio or same-window comparison is defined.',clockMeaning:CLOCK_MEANING,causes,limitations:[...LIMITATIONS]};
}

/** KNOWN needs both counts and the named money series; survival null is a component state, not a missing-evidence cause. */
export function deriveC16Launchpad(context:LaunchpadContext,evidenceIds:string[]):AdvisoryMetric{
  const known=context.counts!==null&&context.money!==null;
  return {id:'C16',quality:known?'KNOWN':'MISSING',unit:'launchpad-activity-context',data:context,evidenceIds:[...new Set(evidenceIds)],reasonCode:known?'LAUNCHPAD_COUNTS_AND_COMPLETED_DAY_SERIES_OBSERVED':context.counts===null?'LAUNCH_AND_MIGRATION_COUNTS_UNAVAILABLE':'COMPLETED_DAY_MONEY_SERIES_UNAVAILABLE'};
}

/** A current proof whose run retained no launchpad receipts (no key, or a failed collector); the run diagnostic says which. */
export function uncollectedC16():AdvisoryMetric{
  return {id:'C16',quality:'MISSING',unit:'launchpad-activity-context',data:{method:LAUNCHPAD_METHOD,collected:false,meaning:'No launchpad receipts were collected for this run; see launchpad-run-diagnostics.'},evidenceIds:[],reasonCode:'LAUNCHPAD_RECEIPTS_NOT_COLLECTED'};
}
