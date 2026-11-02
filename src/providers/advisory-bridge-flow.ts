import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import { decodeC12BridgeCapture, type C12BridgeCapture } from './advisory-bridge-import.js';
import { reconstructC12NativeTransfers } from './advisory-bridge-native.js';

const METHOD='completed-all-asset-native-bridge-flow-v1';
const fail:(code:string)=>never=(code)=>{throw Error('C12_BRIDGE_'+code);};
const numeric=Symbol('original JSON number');
type JsonNumber={ [numeric]:string };
type Exact={coefficient:bigint;scale:number};
const isRecord=(x:unknown):x is Record<string,any>=>typeof x==='object'&&x!==null&&!Array.isArray(x);
/** Symbol-tagged values retain the original decimal lexeme; JSON cannot manufacture this tag. */
function lossless(raw:string):any{
 return (JSON.parse as any)(raw,(_key:string,value:unknown,context?:{source?:string})=>typeof value==='number'?{[numeric]:context?.source??fail('PRICE_NUMBER_LEXEME')}:value);
}
function decimal(text:string):Exact{
 if(text.length>1100||! /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text))return fail('PRICE_DECIMAL');
 const [mantissa,exponent='0']=text.toLowerCase().split('e'),e=Number(exponent);
 if(!Number.isSafeInteger(e)||Math.abs(e)>1000)return fail('PRICE_EXPONENT');
 const fraction=mantissa!.split('.')[1]?.length??0,coefficient=BigInt(mantissa!.replace('.',''));
 let scale=fraction-e;
 if(Math.abs(scale)>2100)return fail('PRICE_SCALE');
 if(scale<0)return{coefficient:coefficient*10n**BigInt(-scale),scale:0};
 return{coefficient,scale};
}
const add=(a:Exact,b:Exact):Exact=>{const scale=Math.max(a.scale,b.scale);return{coefficient:a.coefficient*10n**BigInt(scale-a.scale)+b.coefficient*10n**BigInt(scale-b.scale),scale};};
const negate=(a:Exact):Exact=>({...a,coefficient:-a.coefficient});
const multiply=(a:Exact,b:Exact):Exact=>({coefficient:a.coefficient*b.coefficient,scale:a.scale+b.scale});
function format(a:Exact):string{
 const negative=a.coefficient<0n,absolute=(negative?-a.coefficient:a.coefficient).toString().padStart(a.scale+1,'0');
 const value=a.scale?absolute.slice(0,-a.scale)+'.'+absolute.slice(-a.scale):absolute;
 const clean=value.includes('.')?value.replace(/0+$/,'').replace(/\.$/,''):value;
 return (negative&&a.coefficient!==0n?'-':'')+clean;
}
function numberLexeme(value:unknown):string{
 if(typeof value!=='object'||value===null||!(numeric in value)||typeof value[numeric]!=='string')return fail('PRICE_NUMBER');
 return (value as JsonNumber)[numeric];
}
function integer(value:unknown):number{
 const text=numberLexeme(value);if(!/^(0|[1-9]\d*)$/.test(text))return fail('PRICE_INTEGER');
 const n=Number(text);if(!Number.isSafeInteger(n))return fail('PRICE_INTEGER');return n;
}
const equalDecimal=(a:Exact,b:Exact)=>add(a,negate(b)).coefficient===0n;
type Mark={instrument:string;price:string;at:number;confidence:string|null;symbol:string|null;decimals:number|null;sourceRecordIds:string[]};
function marks(capture:C12BridgeCapture,end:number,assets:Map<string,number>):Map<string,Mark>{
 const policy=capture.valuationPolicy,p=policy.request;
 if(policy.method!=='ALL_ASSET_COMMON_END_ANCHORED_INDEPENDENT_USD_REFERENCE_V1'||policy.requestedMarkUnix!==end||policy.currency!=='USD'||!isRecord(p)||p.start!==end-900||p.period!=='5m'||p.span!==4||p.searchWidth!=='5m'||typeof policy.frozenAt!=='string'||!Number.isFinite(Date.parse(policy.frozenAt)))fail('VALUATION_POLICY');
 if(assets.size===0)return new Map();
 const points=new Map<string,Map<number,{price:Exact;confidence:string|null;symbol:string|null;decimals:number|null;ids:string[]}>>();
 let requests=0;
 for(const record of capture.records){
  const req=record.receipt.request;
  if(record.receipt.chain!=='market')continue;
  if(!('url' in req))fail('PRICE_REQUEST');
  const url=new URL(req.url);
  if(url.origin!=='https://coins.llama.fi'||!url.pathname.startsWith('/chart/'))fail('PRICE_REQUEST');
  const keys=decodeURIComponent(url.pathname.slice(7)).split(',');
  if(!keys.length||new Set(keys).size!==keys.length||keys.some(k=>!assets.has(k))||url.searchParams.size!==4||url.searchParams.get('start')!==String(end-900)||url.searchParams.get('period')!=='5m'||url.searchParams.get('span')!=='4'||url.searchParams.get('searchWidth')!=='5m')fail('PRICE_REQUEST_SCOPE');
  if(Date.parse(record.receipt.startedAt)<Date.parse(policy.frozenAt))fail('PRICE_BEFORE_POLICY');
  if(record.receipt.httpStatus!==200||record.receipt.transportError!==null||record.receipt.truncated)continue;
  let value:any;try{value=lossless(record.raw);}catch(error){if(error instanceof Error&&error.message.startsWith('C12_BRIDGE_'))throw error;return fail('PRICE_JSON');}
  if(!isRecord(value)||!isRecord(value.coins)||Object.keys(value.coins).some(k=>!keys.includes(k)))fail('PRICE_RESPONSE');
  requests++;
  for(const [asset,coin] of Object.entries(value.coins)){
   if(!isRecord(coin)||!Array.isArray(coin.prices))fail('PRICE_ASSET');
   const decimals=coin.decimals===undefined?null:integer(coin.decimals);
   if(decimals!==null&&decimals!==assets.get(asset))fail('PRICE_DECIMALS');
   let confidence:string|null=null;
   if(coin.confidence!==undefined){const c=decimal(numberLexeme(coin.confidence));if(c.coefficient<0n||add(c,{coefficient:-1n,scale:0}).coefficient>0n)fail('PRICE_CONFIDENCE');confidence=format(c);}
   if(coin.symbol!==undefined&&typeof coin.symbol!=='string')fail('PRICE_SYMBOL');
   const byTime=points.get(asset)??new Map();points.set(asset,byTime);
   for(const point of coin.prices){
    if(!isRecord(point))fail('PRICE_POINT');const at=integer(point.timestamp),price=decimal(numberLexeme(point.price));
    if(price.coefficient<=0n)continue;
    if(at>end||at<end-900)continue;
    const prior=byTime.get(at);
    if(prior&&!equalDecimal(prior.price,price))fail('PRICE_TIMESTAMP_CONFLICT');
    if(prior){prior.ids.push(record.id);continue;}
    byTime.set(at,{price,confidence,symbol:coin.symbol??null,decimals,ids:[record.id]});
   }
  }
 }
 if(!requests)fail('PRICE_UNAVAILABLE');
 const selected=new Map<string,Mark>();
 for(const asset of assets.keys()){
  const values=points.get(asset);if(!values?.size)fail('UNPRICED_CANONICAL_ASSET');
  const at=Math.max(...values.keys()),p=values.get(at)!;
  selected.set(asset,{instrument:asset,price:format(p.price),at,confidence:p.confidence,symbol:p.symbol,decimals:p.decimals,sourceRecordIds:[...new Set(p.ids)].sort()});
 }
 return selected;
}

/** Native census/body binding is all-or-nothing before any independent reference USD aggregation. */
export function deriveC12NativeBridgeFlow(raw:string,cutoff:string,evidenceIds:string[]):AdvisoryMetric{
 const base={id:'C12',unit:'canonical_native_units_and_reference_USD',evidenceIds:[...evidenceIds]};
 try{
  const capture=decodeC12BridgeCapture(raw,cutoff),native=reconstructC12NativeTransfers(capture);
  const {start,end}=native.scope;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end-start!==3600||end%3600!==0)fail('NATIVE_SCOPE');
  const assetDecimals=new Map<string,number>();
  for(const t of native.transfers){const prior=assetDecimals.get(t.canonicalAssetId);if(!Number.isInteger(t.originalDecimals)||t.originalDecimals<0||t.originalDecimals>255||prior!==undefined&&prior!==t.originalDecimals)fail('ASSET_DECIMALS_CONFLICT');assetDecimals.set(t.canonicalAssetId,t.originalDecimals);}
  const selected=marks(capture,end,assetDecimals),zero=()=>({coefficient:0n,scale:0});
  const totals=new Map<number,{inflow:Exact;outflow:Exact}>([[1,{inflow:zero(),outflow:zero()}],[2,{inflow:zero(),outflow:zero()}]]);
  const assets=[...assetDecimals].sort(([a],[b])=>a.localeCompare(b)).map(([asset,decimals])=>{
   const mark=selected.get(asset)!,price=decimal(mark.price),directions=new Map<number,{inflow:bigint;outflow:bigint}>([[1,{inflow:0n,outflow:0n}],[2,{inflow:0n,outflow:0n}]]);
   const transfers=native.transfers.filter(t=>t.canonicalAssetId===asset);
   const rows=transfers.map(t=>{
    if(!/^(0|[1-9]\d{0,77})$/.test(t.normalizedAmount)||!directions.has(t.sourceChain)||!directions.has(t.destinationChain)||t.sourceChain===t.destinationChain)fail('TRANSFER_UNITS');
    const amount=BigInt(t.normalizedAmount),normalizationDecimals=Math.min(decimals,8),atomic=amount*10n**BigInt(decimals-normalizationDecimals);
    directions.get(t.sourceChain)!.outflow+=atomic;directions.get(t.destinationChain)!.inflow+=atomic;
    const checkFee=(fee:string|null)=>{if(fee===null)return null;if(!/^(0|[1-9]\d{0,77})$/.test(fee)||BigInt(fee)>amount)fail('TRANSFER_FEE');return BigInt(fee);};
    const fee=checkFee(t.normalizedFee),recipient=checkFee(t.recipientNormalizedAmount);
    if(fee!==null&&recipient!==null&&recipient!==amount-fee)fail('TRANSFER_RECIPIENT');
    return{...t,canonicalAtomic:atomic.toString(),canonicalUnits:format({coefficient:atomic,scale:decimals}),normalizedFee:t.normalizedFee,recipientNormalizedAmount:t.recipientNormalizedAmount,grossReferenceUsd:format(multiply({coefficient:atomic,scale:decimals},price))};
   });
   const chains=[...directions].map(([chain,d])=>{
    const inflow={coefficient:d.inflow,scale:decimals},outflow={coefficient:d.outflow,scale:decimals},inUsd=multiply(inflow,price),outUsd=multiply(outflow,price),total=totals.get(chain)!;
    total.inflow=add(total.inflow,inUsd);total.outflow=add(total.outflow,outUsd);
    return{chain:chain===1?'solana':'ethereum',inflowAtomic:d.inflow.toString(),outflowAtomic:d.outflow.toString(),netAtomic:(d.inflow-d.outflow).toString(),inflowNative:format(inflow),outflowNative:format(outflow),netNative:format(add(inflow,negate(outflow))),inflowReferenceUsd:format(inUsd),outflowReferenceUsd:format(outUsd),netReferenceUsd:format(add(inUsd,negate(outUsd)))};
   });
   return{canonicalAssetId:asset,originalDecimals:decimals,normalizationDecimals:Math.min(decimals,8),mark:{...mark,role:'CANONICAL_ORIGIN_REFERENCE',requestedAt:end,ageSeconds:end-mark.at},chains,transfers:rows};
  });
  const chains=[...totals].map(([chain,t])=>({chain:chain===1?'solana':'ethereum',inflowReferenceUsd:format(t.inflow),outflowReferenceUsd:format(t.outflow),netReferenceUsd:format(add(t.inflow,negate(t.outflow)))}));
  if(!equalDecimal(totals.get(1)!.inflow,totals.get(2)!.outflow)||!equalDecimal(totals.get(1)!.outflow,totals.get(2)!.inflow))fail('PAIR_CONSERVATION');
  return{...base,quality:'KNOWN',reasonCode:'COMPLETE_ALL_ASSET_NATIVE_BRIDGE_FLOW',data:{method:METHOD,status:'COMPLETE',window:{start:new Date(start*1000).toISOString(),end:new Date(end*1000).toISOString(),basis:'NATIVE_DESTINATION_COMPLETION_HALF_OPEN'},scope:{bridge:'WORMHOLE_TOKEN_BRIDGE',chains:['solana','ethereum'],assets:'ALL_CANONICAL_ASSETS',directions:'BOTH'},coverage:native.coverage,completedTransfers:native.transfers.length,canonicalAssets:assets.length,assets,chains,pending:null,premises:native.premises,limitations:['Covered bridge and chain pair only; no whole-network or net-new-capital claim.','Common END-anchored independent USD reference marks are not executable bids or cash.','Bridge-reported immutable asset metadata and published protocol semantics do not independently certify foreign origin, guardian cryptography or consensus.'],feeBasis:'Gross normalized transfer; explicit payload fees separate; absent type3 fee stays null.'}};
 }catch(error){
  const code=error instanceof Error&&/^C12_[A-Z0-9_]+$/.test(error.message)?error.message:'C12_BRIDGE_NATIVE_GRAPH_INVALID';
  return{...base,quality:'MISSING',reasonCode:code,data:{method:METHOD,status:'INCOMPLETE',authoritativeReferenceUsd:null,chains:null,pending:null,cause:code}};
 }
}
