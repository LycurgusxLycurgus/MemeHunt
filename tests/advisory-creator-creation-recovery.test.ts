import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyPublicCreatorRole,CREATOR_ROLE_RECEIPTS as R,creatorRolePageRequest,creatorRoleIndexRequest,creatorRoleTransactionRequest,PUMP_PROGRAM } from '../src/providers/advisory-creator-role.js';
import { decodeCreatorRole } from '../src/providers/advisory-creator-role-collector.js';
const mint='nxPqZ4F7ux8Vph5NFu25rEP6Kx9Gr1U6Fmj36Rjpump',wallet='FFdBLYqL9rs5fUT38ArE8GV2L3BziEgG5LJUu6sshfkF',token={chain:'solana' as const,address:mint},at='2026-10-19T16:00:00.000Z';
// Exact public finalized getTransaction bytes retained on October19; the page and one-row index below
// are CONSTRUCTED bindings for decoder regression, not an independent live creator claim.
const actual=readFileSync('tests/fixtures/s13-nxpq-creation.json','utf8'),source=JSON.parse(actual),signature=source.result.transaction.signatures[0] as string;
function receipts(tx=structuredClone(source)){
 const page={results:[{url:`https://pump.fun/coin/${mint}`,final_url:`https://pump.fun/coin/${mint}`,text:'Creator\n\nFFdB…hfkF\n',published_date:'2026-10-11T11:16:34.000Z',links:[`https://pump.fun/profile/${wallet}`]}],errors:[]};
 const index={jsonrpc:'2.0',id:1,result:[{signature,slot:source.result.slot,blockTime:source.result.blockTime,err:null,confirmationStatus:'finalized'}]};
 return{rawArtifacts:{[R.page]:JSON.stringify(page),[R.walletIndex]:JSON.stringify(index),[R.transaction]:JSON.stringify(tx)},retrievedAt:Object.fromEntries(Object.values(R).map(k=>[k,at])),requests:{[R.page]:creatorRolePageRequest(mint),[R.walletIndex]:creatorRoleIndexRequest(wallet),[R.transaction]:creatorRoleTransactionRequest(signature)}};
}
const verify=(tx=structuredClone(source))=>verifyPublicCreatorRole(token,receipts(tx),at,undefined,true);
test('exact20-account holder-reward creation closes before later truncation: signer and fee recipient stay distinct',()=>{
 const r=verify();assert.equal(r.wallet,wallet);assert.equal(r.creation.quoteMint,'TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo');
 assert.equal(r.creation.holderReward,true);assert.equal(r.creation.eventFeeRecipient,'8o6yYRnEGChhfRHm3zpmXE136Tu2mH7ChMoy741trVvJ');
 assert.equal(r.creation.logCoverage,'COMPLETE_CREATION_FRAME_BEFORE_LATER_TRUNCATION');assert.equal(r.currentFeeBeneficiaryAsserted,false);
 assert.throws(()=>verifyPublicCreatorRole(token,receipts(),at),/LOG_TRUNCATED/);
});
test('truncation before creation closure, bad quote ATA/control, event/frame mutation and failed tx never verify',()=>{
 const mutations:Array<(tx:any)=>void>=[
  x=>{const logs=x.result.meta.logMessages;const end=logs.indexOf(`Program ${PUMP_PROGRAM} success`,logs.indexOf(`Program ${PUMP_PROGRAM} invoke [2]`)+1);logs.splice(end,logs.length-end,'Log truncated');},
  x=>x.result.transaction.message.instructions[0].accounts[17]=wallet,
  x=>x.result.transaction.message.instructions[0].accounts[19]=wallet,
  x=>{x.result.meta.logMessages.push('Program log: after truncation');},
  x=>x.result.meta.err={InstructionError:[3,'Custom']},
  x=>x.result.meta.innerInstructions[0].instructions[0].stackHeight=3,
  x=>x.result.meta.innerInstructions[0].instructions.find((i:any)=>i.parsed?.type==='initializeMint2').parsed.info.mintAuthority=wallet,
 ];
 for(const mutate of mutations){const tx=structuredClone(source);mutate(tx);assert.throws(()=>verify(tx),/CREATOR_ROLE_/);}
});
test('a positive unique mint creation needs no absence assertion for unrelated retained candidates; legacy remains missing',()=>{
 const r=receipts(),rr={rawArtifacts:{page:r.rawArtifacts[R.page],index:r.rawArtifacts[R.walletIndex],'transaction-0':r.rawArtifacts[R.transaction]},retrievedAt:{page:at,index:at,'transaction-0':at},requests:{page:r.requests[R.page],index:r.requests[R.walletIndex],'transaction-0':r.requests[R.transaction]}};
 assert.equal(decodeCreatorRole(token,rr,at,true,true,true).quality,'KNOWN');
 const unrelated=structuredClone(rr),other=source.result.transaction.signatures[1];
 const ix=JSON.parse(unrelated.rawArtifacts.index);ix.result.unshift({...ix.result[0],signature:other});unrelated.rawArtifacts.index=JSON.stringify(ix);
 (unrelated.requests as any)['transaction-1']=creatorRoleTransactionRequest(signature);unrelated.requests['transaction-0']=creatorRoleTransactionRequest(other);
 (unrelated.rawArtifacts as any)['transaction-1']=rr.rawArtifacts['transaction-0'];unrelated.rawArtifacts['transaction-0']=JSON.stringify({jsonrpc:'2.0',id:1,result:null});(unrelated.retrievedAt as any)['transaction-1']=at;
 assert.equal(decodeCreatorRole(token,unrelated,at,true,true,true).quality,'KNOWN');
 assert.equal(decodeCreatorRole(token,unrelated,at,true,true,false).quality,'TRUNCATED');
 assert.equal(decodeCreatorRole(token,rr,at,true,true,false).quality,'TRUNCATED');
 const missing=structuredClone(rr);delete (missing.rawArtifacts as any)['transaction-0'];delete (missing.requests as any)['transaction-0'];delete (missing.retrievedAt as any)['transaction-0'];
 assert.notEqual(decodeCreatorRole(token,missing,at,true,true,true).quality,'KNOWN');
});
