import {createHash} from 'node:crypto';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import {decodePumpSwapReservePathTransaction} from './advisory-trades.js';
import {visitO23BulkSources,type O23BulkReceipts} from './advisory-synchrony-bulk.js';
import {deriveO29QuoteReservePath,type ReservePathHistory,type ReservePathTrade} from './advisory-reserve-path.js';

export const O29_BULK_FINANCIAL_TAPE_METHOD='complete-quote-pool-financial-tape-v1' as const;
const HOUR=3_600_000,HOURS=12,AUDIT_SAMPLE=64;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const errorCode=(error:unknown)=>error instanceof Error&&/^(ADVISORY_[A-Z0-9_]+|A29_[A-Z0-9_]+|RESERVE_[A-Z0-9_]+)$/.test(error.message)?error.message:'RESERVE_BULK_FINANCIAL_UNRESOLVED';
function fail(code:string):never{throw Error(code);}

/** Financial interpretation is exclusive to proof53/O29. The existing count DTO is never an input. */
export function deriveO29BulkReservePath(receipts:O23BulkReceipts,cutoff:string,evidenceIds:string[]):AdvisoryMetric{
 const start=Date.parse(receipts.range.start),trades:ReservePathTrade[]=[],transactions:ReservePathHistory['transactions']=[],gaps:Array<{signature:string;code:string}>=[],clockDifferences:Array<{signature:string;instructionIndex:number;programTimestamp:string;indexTime:string}>=[];
 const transactionPositions=new Map<string,number>(),pairedClockHash=createHash('sha256');let decoded=0,compiledFallbacks=0,zeroTradeTransactions=0,pairedClocks=0,clockDifferenceCount=0,maximumClockDifference=0,truncatedTransactions=0,executionProvenInvocations=0,foreignSwapLegs=0,nonSwapInvocations=0;
 const context=visitO23BulkSources(receipts,cutoff,(tx,indexed,at,companion,source)=>{
  transactionPositions.set(indexed.signature,tx.transactionIndex);
  const expected={signature:indexed.signature,slot:indexed.slot,at:new Date(indexed.blockTime*1000).toISOString()};
  try{
   let proof:ReturnType<typeof decodePumpSwapReservePathTransaction>,usedCompiled=false;
   try{proof=decodePumpSwapReservePathTransaction(tx,expected,receipts.pool,source.pool,source.stateSlot,at,source.quote.program,source.quote.decimals,{logRecovery:tx.meta.logMessages.includes('Log truncated')});}
   catch(first){
    if(companion){proof=decodePumpSwapReservePathTransaction(companion.projected,expected,receipts.pool,source.pool,source.stateSlot,companion.at,source.quote.program,source.quote.decimals,{logRecovery:true,foreignFlowRecovery:true,compiledRecovery:true});usedCompiled=true;}
    else if(!tx.meta.logMessages.includes('Log truncated'))proof=decodePumpSwapReservePathTransaction(tx,expected,receipts.pool,source.pool,source.stateSlot,at,source.quote.program,source.quote.decimals,{logRecovery:true});
    else throw first;
   }
   // Complete the transaction atomically: a bad leg never leaves a partially accepted transaction in the path.
   const financial:ReservePathTrade[]=proof.trades.map(t=>{
    if(t.signature!==indexed.signature||t.slot!==indexed.slot||t.at!==expected.at||!t.provenance||!t.quoteAccounting||t.quoteAccounting.coreQuoteAtomic!==t.quoteAtomic||!['BUY','SELL'].includes(t.side))fail('RESERVE_BULK_FINANCIAL_BINDING');
    if(typeof t.virtualQuoteReservesAtomic!=='string')fail('RESERVE_PATH_VIRTUAL_QUOTE_MISSING');
    if(typeof t.programTimestamp!=='string'||!/^(0|[1-9]\d{0,18})$/.test(t.programTimestamp)||!Number.isSafeInteger(Number(t.programTimestamp))||Number(t.programTimestamp)*1000>Date.parse(at))fail('RESERVE_BULK_PROGRAM_SOURCE_CLOCK');
    return{...t,transactionIndex:tx.transactionIndex};
   });
   for(const t of financial){pairedClocks++;pairedClockHash.update(JSON.stringify([t.signature,t.instructionIndex,t.provenance,expected.at,t.programTimestamp]));const difference=Math.abs(Number(t.programTimestamp)-indexed.blockTime);maximumClockDifference=Math.max(maximumClockDifference,difference);if(difference){clockDifferenceCount++;if(clockDifferences.length<AUDIT_SAMPLE)clockDifferences.push({signature:t.signature,instructionIndex:t.instructionIndex,programTimestamp:t.programTimestamp,indexTime:expected.at});}}
   trades.push(...financial);transactions.push({...expected,status:'OBSERVED',trades:financial.length});decoded++;if(usedCompiled)compiledFallbacks++;if(!financial.length)zeroTradeTransactions++;foreignSwapLegs+=proof.foreignSwapLegs;nonSwapInvocations+=proof.nonSwapInvocations;
   if(proof.logRecovery?.truncated){truncatedTransactions++;executionProvenInvocations+=proof.logRecovery.executionProvenInvocations??0;}
  }catch(error){const code=errorCode(error);transactions.push({...expected,status:'INVALID',trades:0,code});if(gaps.length<AUDIT_SAMPLE)gaps.push({signature:indexed.signature,code});}
 });
 // Canonical parent invocation / route-event provenance orders new53; the legacy observed instructionIndex is retained, never used as a synthetic route position.
 trades.sort((a,b)=>a.slot-b.slot||a.transactionIndex!-b.transactionIndex!||a.provenance.pumpOrdinal-b.provenance.pumpOrdinal||(a.provenance.routeEvent??-1)-(b.provenance.routeEvent??-1));
 transactions.sort((a,b)=>a.slot-b.slot||transactionPositions.get(a.signature)!-transactionPositions.get(b.signature)!);
 const history:ReservePathHistory={method:O29_BULK_FINANCIAL_TAPE_METHOD,eligible:true,pool:receipts.pool,range:receipts.range,anchorSlot:receipts.anchorSlot,stateSlot:context.stateSlot,complete:decoded===context.success.size,reasonCode:decoded===context.success.size?'RESERVE_BULK_FINANCIAL_TAPE_COMPLETE':'RESERVE_BULK_TAPE_UNRESOLVED',transactions,trades,hours:Array.from({length:HOURS},(_,hour)=>({start:new Date(start+hour*HOUR).toISOString(),end:new Date(start+(hour+1)*HOUR).toISOString(),complete:decoded===context.success.size}))};
 const metric=deriveO29QuoteReservePath(history,context.quote,evidenceIds);if(!metric)fail('RESERVE_BULK_INELIGIBLE');
 const receiptManifestHash=sha(JSON.stringify(Object.keys(receipts.requests).sort().map(id=>[id,receipts.requests[id],receipts.retrievedAt[id],sha(receipts.rawArtifacts[id]!)])));
 return{...metric,data:{...(metric.data as object),sourceTrust:'RETAINED_PROVIDER_RPC_IMPORT',sourceAuthentication:'Hashes bind retained bytes, not provider authentication or independent onchain attestation.',financialPurpose:'O29_RESERVE_PATH_ONLY',sourceCoverage:{...context.counts,financialDecodedTransactions:decoded,unresolvedFinancialTransactions:context.success.size-decoded,financialTrades:trades.length,zeroTradeTransactions,compiledFallbacks,truncatedTransactions,executionProvenInvocations,foreignSwapLegs,nonSwapInvocations,sourceBytes:context.sourceBytes,storedBytes:context.storedBytes,sourceHash:sha(JSON.stringify(context.sourceHashes)),receiptManifestHash,gaps},pairedClocks:{cohortAndHours:'CANONICAL_INDEX_BLOCK_TIME',programTime:'INDEPENDENT_NONNEGATIVE_INTEGER_AT_OR_BEFORE_EARLIEST_NATIVE_SOURCE',observations:pairedClocks,observationHash:pairedClockHash.digest('hex'),differentFromIndex:clockDifferenceCount,maximumAbsoluteDifferenceSeconds:maximumClockDifference,differenceWitnessesComplete:clockDifferenceCount<=AUDIT_SAMPLE,differences:clockDifferences}}};
}
