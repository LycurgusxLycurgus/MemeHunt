import { createHash } from 'node:crypto';
import type { LiveBundle } from '../src/domain/contracts.js';
import { unpackAdvisoryWindowReceipts, WINDOW_DENSE_PAGE_LIMIT } from '../src/providers/advisory-window.js';
import { HOLDER_ARCHIVE_ADAPTER, unpackHolderPopulation } from '../src/providers/advisory-topology.js';
import { archiveDemandReceipt } from '../src/providers/advisory-demand-windows.js';

type Request = { method: string; params: any[] };
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** Construct a proof27 test fixture from a small exhausted proof28 index, dropping only its new admission receipt. Never used for real evidence. */
export function legacyDenseWindowBundle<B extends LiveBundle>(fresh:B):{bundle:B;proof:any}{
 const bundle=structuredClone(fresh),raw=bundle.rawArtifacts as Record<string,string>,proof=JSON.parse(raw['advisory-derivation']!);
 if(proof.method!=='advisory-provenance-v28'&&proof.method!=='advisory-provenance-v30'&&proof.method!=='advisory-provenance-v31'&&proof.method!=='advisory-provenance-v32'&&proof.method!=='advisory-provenance-v33'&&proof.method!=='advisory-provenance-v34'&&proof.method!=='advisory-provenance-v35'&&proof.method!=='advisory-provenance-v36'&&proof.method!=='advisory-provenance-v37'&&proof.method!=='advisory-provenance-v38'&&proof.method!=='advisory-provenance-v39'&&proof.method!=='advisory-provenance-v40')return{bundle,proof};
 // A fresh proof37 carries an explicit saturation key and a fresh proof38 also an a29 key; only a null (no capture) key is dropped, and a populated capture is never discarded by a legacy conversion.
 if(proof.saturation!==undefined&&proof.saturation!==null)throw new Error('LEGACY_SATURATION_SOURCE');delete proof.saturation;
 if(proof.a29!==undefined&&proof.a29!==null)throw new Error('LEGACY_A29_SOURCE');delete proof.a29;
 for(const [key,request] of Object.entries(proof.window.requests) as Array<[string,Request]>){
  const id=proof.window.artifactIds[key] as string;
  if(key==='window-pool-check'){
   bundle.evidence=bundle.evidence.filter(e=>e.id!==id);delete raw[id];delete proof.window.requests[key];delete proof.window.artifactIds[key];continue;
  }
  if(request.method==='getSignaturesForAddress'){
   const rows=JSON.parse(unpackAdvisoryWindowReceipts({rawArtifacts:{[key]:raw[id]!},retrievedAt:{[key]:bundle.evidence.find(e=>e.id===id)!.retrievedAt},requests:{[key]:request}},true).rawArtifacts[key]!).result;
   if(!Array.isArray(rows)||rows.length>=256)throw new Error('LEGACY_DENSE_WINDOW_PAGE');
   request.params[1]={...request.params[1],limit:256};bundle.evidence.find(e=>e.id===id)!.scope={request};
  }
 }
 // A proof35 or proof36 modern final bank is getMultipleAccounts([pool,quoteMint]); a dense proof27 window reads getAccountInfo(pool), so drop the quote bank and restore the single-account value[0] body under the same archive, clock, hash and request shape (synthetic fixture conversion only).
 const poolRequest=proof.window.requests['window-pool'] as Request|undefined;
 if(poolRequest?.method==='getMultipleAccounts'){
  const id=proof.window.artifactIds['window-pool'] as string,e=bundle.evidence.find(ev=>ev.id===id)!;
  const poolAddress=(poolRequest.params[0] as string[])[0]!;
  const plain=JSON.parse(unpackAdvisoryWindowReceipts({rawArtifacts:{'window-pool':raw[id]!},retrievedAt:{'window-pool':e.retrievedAt},requests:{'window-pool':poolRequest}},true).rawArtifacts['window-pool']!);
  plain.result={...plain.result,value:plain.result.value[0]};raw[id]=archiveDemandReceipt(JSON.stringify(plain));
  const request={method:'getAccountInfo',params:[poolAddress,poolRequest.params[1]]};
  proof.window.requests['window-pool']=request;e.scope={request};e.contentHash=sha(raw[id]);
 }
 if(proof.exitCapacity)throw Error('LEGACY_CAPACITY_SOURCE');delete proof.exitCapacity;
 proof.method='advisory-provenance-v27';raw['advisory-derivation']=JSON.stringify(proof);bundle.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=sha(raw['advisory-derivation']);
 return{bundle,proof};
}

/**
 * Test-only: the exact proof-v20 form of a small fresh proof-v21 or proof-v22 bundle, so frozen older-proof dispatch stays testable.
 * Window archives become plain live-v1 receipts and each dense signature page becomes the legacy 32-row request. This is exact
 * only when every page returned at most 32 rows, because an exhausted page answers both limits with the same body; larger pages are refused.
 * A proof-v22 holder archive becomes the plain live-v1 holder receipt under the same id, source, scope and clock.
 */
export function legacyWindowBundle<B extends LiveBundle>(fresh: B): { bundle: B; proof: any } {
  const bundle = legacyDenseWindowBundle(fresh).bundle, raw = bundle.rawArtifacts as Record<string, string>, proof = JSON.parse(raw['advisory-derivation']!);
  if (proof.method !== 'advisory-provenance-v21' && proof.method !== 'advisory-provenance-v22' && proof.method !== 'advisory-provenance-v23' && proof.method !== 'advisory-provenance-v24' && proof.method !== 'advisory-provenance-v25' && proof.method !== 'advisory-provenance-v26' && proof.method !== 'advisory-provenance-v27') throw new Error('LEGACY_WINDOW_SOURCE');
  const ids = proof.window.artifactIds as Record<string, string>, requests = structuredClone(proof.window.requests) as Record<string, Request>;
  const record = (id: string) => bundle.evidence.find(e => e.id === id)!, keys = Object.keys(ids);
  const plain = unpackAdvisoryWindowReceipts({ rawArtifacts: Object.fromEntries(keys.map(k => [k, raw[ids[k]!]!])), retrievedAt: Object.fromEntries(keys.map(k => [k, record(ids[k]!).retrievedAt])), requests }).rawArtifacts;
  for (const [key, request] of Object.entries(requests)) if (request.method === 'getSignaturesForAddress') {
    const rows = JSON.parse(plain[key]!).result;
    if (request.params[1]?.limit !== WINDOW_DENSE_PAGE_LIMIT || !Array.isArray(rows) || rows.length > 32) throw new Error('LEGACY_WINDOW_PAGE');
    request.params[1] = { ...request.params[1], limit: 32 };
  }
  // A proof35 or proof36 modern final bank is getMultipleAccounts([pool,quoteMint]); the plain legacy window consumes only the getAccountInfo(pool) envelope, so drop the quote bank and restore the single-account value[0] body (synthetic fixture conversion only; clocks, hashes and request shape stay exact).
  if (requests['window-pool']?.method === 'getMultipleAccounts') {
    const poolAddress = (requests['window-pool'].params[0] as string[])[0]!;
    requests['window-pool'] = { method: 'getAccountInfo', params: [poolAddress, requests['window-pool'].params[1]] };
    const body = JSON.parse(plain['window-pool']!); body.result = { ...body.result, value: body.result.value[0] }; plain['window-pool'] = JSON.stringify(body);
  }
  for (const key of keys) { const id = ids[key]!, e = record(id); raw[id] = plain[key]!; e.adapterVersion = 'live-v1'; e.scope = { request: requests[key] }; e.contentHash = sha(raw[id]!); }
  for (const e of bundle.evidence.filter(e => e.adapterVersion === HOLDER_ARCHIVE_ADAPTER)) { raw[e.id] = unpackHolderPopulation(raw[e.id]!); e.adapterVersion = 'live-v1'; e.contentHash = sha(raw[e.id]!); }
  const legacy = { ...proof, method: 'advisory-provenance-v20', window: { ...proof.window, requests } };
  raw['advisory-derivation'] = JSON.stringify(legacy); record('advisory-derivation').contentHash = sha(raw['advisory-derivation']);
  return { bundle, proof: legacy };
}
