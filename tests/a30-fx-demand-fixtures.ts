import type {ReservePathHistory,ReservePathTrade} from '../src/providers/advisory-reserve-path.js';
import type {A30FxReference,A30FxCell,A30FxWriter} from '../src/providers/advisory-demand-fx-state.js';
import {O23_BULK_QUOTE} from '../src/providers/advisory-synchrony-bulk.js';
import {A29_WSOL_MINT} from '../src/providers/a29-fx-whirlpool.js';
export const A30_TEST_START=Date.parse('2026-10-25T20:00:00.000Z'),A30_TEST_Q64=1n<<64n;
/** Constructed arithmetic inputs only: never native-source or whole-history acceptance. */
export function a30DemandTrade(user:string,hour:number,side:'BUY'|'SELL',quoteAtomic:string,slot=100+hour*10,transactionIndex=[...user].reduce((n,c)=>n+c.charCodeAt(0),0)):ReservePathTrade{
 const at=new Date(A30_TEST_START+hour*3_600_000).toISOString();return{signature:`constructed-${user}-${hour}-${side}-${slot}-${transactionIndex}`,slot,transactionIndex,at,user,side,quoteAtomic,baseAtomic:'1',poolBaseReservesAtomic:'1',poolQuoteReservesAtomic:'1',instructionIndex:0,programTimestamp:String(Date.parse(at)/1000),virtualQuoteReservesAtomic:'0',provenance:{top:0,position:-1,pumpOrdinal:0,hop:null,routeEvent:null,eventPayload:'constructed'}};
}
export function a30DemandHistory(trades:ReservePathTrade[]=[]):ReservePathHistory{
 const range={start:new Date(A30_TEST_START).toISOString(),end:new Date(A30_TEST_START+12*3_600_000).toISOString()};return{method:'CONSTRUCTED_ARITHMETIC_ONLY',eligible:true,pool:'constructed-c5',range,anchorSlot:10000,stateSlot:10000,complete:true,reasonCode:'CONSTRUCTED_COMPLETE',hours:Array.from({length:12},(_,i)=>({start:new Date(A30_TEST_START+i*3_600_000).toISOString(),end:new Date(A30_TEST_START+(i+1)*3_600_000).toISOString(),complete:true})),transactions:[...new Map(trades.map(t=>[t.signature,{signature:t.signature,slot:t.slot,at:t.at,status:'OBSERVED' as const,trades:trades.filter(v=>v.signature===t.signature).length}])).values()],trades};
}
export function a30DemandReference(sqrt=A30_TEST_Q64):A30FxReference{
 return{method:'a30-incoming-fx-state-cells-v1',complete:true,reasonCode:'CONSTRUCTED_REFERENCE_ONLY',range:a30DemandHistory().range,anchorSlot:10000,writers:[],cells:[{index:0,left:null,right:null,status:'KNOWN',sqrtPriceX64:String(sqrt),anchors:[]}],coverage:{constructed:true},sourceContext:{identity:{pool:'constructed-fx',program:'constructed-program',config:'constructed-config',tickSpacing:64,mintA:A29_WSOL_MINT,mintB:O23_BULK_QUOTE,decimalsA:9,decimalsB:8,vaultA:'constructed-a',vaultB:'constructed-b',bankSlot:10000,sourceId:'constructed-identity',sourceAt:'2026-10-30T18:00:00.000Z'},counts:{},coverage:{constructed:true},sourceHashes:[],sourceHash:'constructed',sourceBytes:0,storedBytes:0,bodyHashes:new Map()}};
}
export function a30DemandVariableReference():A30FxReference{
 const ref=a30DemandReference(),writer:A30FxWriter={signature:'constructed-writer',slot:150,transactionIndex:0,blockTime:A30_TEST_START/1000+7*3600,possibleWriters:1,first:null,last:null,missingEvents:0,unboundEventInvocations:0,unprovedEndpoints:0};
 const point={signature:writer.signature,slot:writer.slot,transactionIndex:writer.transactionIndex};ref.writers=[writer];ref.cells=[{index:0,left:null,right:point,status:'KNOWN',sqrtPriceX64:String(A30_TEST_Q64),anchors:[]},{index:1,left:point,right:null,status:'KNOWN',sqrtPriceX64:String(2n*A30_TEST_Q64),anchors:[]}] satisfies A30FxCell[];return ref;
}
