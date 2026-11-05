import { archiveDemandReceipt } from '../src/providers/advisory-demand-windows.js';
import { A29_V2_BOUNDS,A29_FREEZE_KIND_V2 } from '../src/providers/advisory-absorption-v2.js';
import { buildA29Capture } from './a29-fixtures.js';

/** SYNTHETIC: rewrites the constructed v1 WSOL capture as an a29-retained-sources-v2 packet by archiving every raw receipt and mapping freeze, bounds and native units. Never a genuine capture. The optional pad appends JSON whitespace to exercise the size bound. */
export async function buildA29CaptureV2(options:{pad?:number}={}){
  const v1=await buildA29Capture(),w=JSON.parse(v1.raw);
  const tokens=w.freeze.tokens.map((t:any)=>{const e=t.endpoint0;return {label:t.label,endpoint1Attempt:1,mint:t.mint,pool:t.pool,program:t.program,baseVault:t.baseVault,quoteMint:t.bankKeys[2],quoteProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',quoteDecimals:9,quoteVault:t.bankKeys[6],fxPool:null,bankKeys:t.bankKeys,cohort:t.cohort,
    endpoint0:{attempt:e.attempt,bankSlot:e.bankSlot,populationSlot:e.populationSlot,exactSameSlot:true,populationComplete:true,supplyReconciled:true,accounts:e.accounts,chainTime:e.chainTime,supplyAtomic:e.supplyAtomic,totalAtomic:e.totalAtomic,baseVaultAtomic:'100000000000000',quoteVaultAtomic:'700000000000',meaningfulQuoteAtomic:'10000000',fx:null}};});
  const freeze={kind:A29_FREEZE_KIND_V2,frozenAt:w.freeze.frozenAt,evidenceBasedRevisions:[],measurement:w.freeze.measurement,bounds:{...A29_V2_BOUNDS},tokens};
  const records=w.provenance.records.map((r:any)=>({key:r.key,sourceBytes:r.sourceBytes,sourceSha256:r.sourceSha256,startedAt:r.startedAt,completedAt:r.completedAt,httpStatus:200,requestSha256:r.requestSha256}));
  const rawArtifacts=Object.fromEntries(Object.entries(w.rawArtifacts as Record<string,string>).map(([k,v])=>[k,archiveDemandReceipt(v)]));
  const raw=JSON.stringify({freeze,label:w.label,method:'a29-retained-sources-v2',provenance:{accessMode:'USER_IMPORT',claim:'SYNTHETIC constructed v2 test capture; not genuine RPC.',records},rawArtifacts,requests:w.requests,retrievedAt:w.retrievedAt,token:w.token})+' '.repeat(options.pad??0);
  return {...v1,raw};
}
