import {constants,openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {z} from 'zod';

export const C12_CAPTURE_METHOD='c12-all-assets-wtt-source-v1' as const;
export const C12_SOURCE_ID='advisory-c12-bridge' as const;
export const C12_CAPTURE_ID='advisory-c12-bridge-capture' as const;
export const C12_SOURCE_ADAPTER='c12-native-bridge-flow-source-v1' as const;
export const C12_SOURCE_PURPOSE='COMPLETED_ALL_ASSET_BRIDGE_FLOW' as const;
export const C12_CAPTURE_BYTES=8*1024*1024;
export const C12_RECORD_LIMIT=1000;
const instant=z.iso.datetime({offset:true}),label=z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
const rpcRequest=z.object({jsonrpc:z.literal('2.0'),id:z.union([z.number().int().nonnegative(),z.string().min(1).max(100)]),method:z.string().min(1).max(100),params:z.array(z.unknown()).max(8)}).strict();
const getRequest=z.object({method:z.literal('GET'),url:z.string().max(8000)}).strict();
const receiptSchema=z.object({chain:z.enum(['solana','ethereum','discovery','market']),label,requestNumber:z.number().int().positive(),transport:z.string().min(1).max(150),request:z.union([rpcRequest,getRequest]),startedAt:instant,finishedAt:instant,httpStatus:z.number().int().min(100).max(599).nullable(),transportError:z.string().min(1).max(150).nullable(),truncated:z.boolean(),response:z.object({file:z.string().min(1).max(200),bytes:z.number().int().nonnegative().max(C12_CAPTURE_BYTES),sha256:hash}).strict()}).strict();
const recordSchema=z.object({id:label,receipt:receiptSchema,raw:z.string()}).strict();
export const c12CaptureSchema=z.object({method:z.literal(C12_CAPTURE_METHOD),scopeRule:z.record(z.string(),z.unknown()),scopeManifest:z.record(z.string(),z.unknown()),emitterManifest:z.record(z.string(),z.unknown()),valuationPolicy:z.record(z.string(),z.unknown()),captureCreatedAt:instant,records:z.array(recordSchema).min(1).max(C12_RECORD_LIMIT)}).strict();
export type C12BridgeCapture=z.infer<typeof c12CaptureSchema>;
export type C12BridgeSourceRecord=C12BridgeCapture['records'][number];
export const c12BridgeScope=()=>({method:C12_SOURCE_ADAPTER,purpose:C12_SOURCE_PURPOSE});
const READS=new Set(['getGenesisHash','getSlot','getBlockTime','getBlock','getAccountInfo','getMultipleAccounts','getSignaturesForAddress','getSignatureStatuses','getTransaction','eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getLogs','eth_call','eth_getStorageAt','eth_getCode','debug_traceTransaction','trace_transaction']);
const fail=(code:string):never=>{throw Error('C12_BRIDGE_SOURCE_'+code);};

/** Structural source validation never trusts a producer's completeness flags.
 * Native population, execution and valuation are reconstructed separately.
 */
export function decodeC12BridgeCapture(raw:string,cutoff:string):C12BridgeCapture{
 if(typeof raw!=='string'||Buffer.byteLength(raw)>C12_CAPTURE_BYTES||Buffer.from(raw,'utf8').toString('utf8')!==raw)fail('SIZE_OR_UTF8');
 let c:C12BridgeCapture;try{c=c12CaptureSchema.parse(JSON.parse(raw));}catch{return fail('SCHEMA');}
 const at=Date.parse(cutoff),created=Date.parse(c.captureCreatedAt);if(!Number.isFinite(at)||created>at)fail('CLOCK');
 const ids=new Set<string>();
 for(const record of c.records){
  const r=record.receipt;if(ids.has(record.id)||record.id!==r.label)fail('DUPLICATE_OR_BINDING');ids.add(record.id);
  if(r.response.file!==`raw/${record.id}.json`||Buffer.from(record.raw,'utf8').toString('utf8')!==record.raw||Buffer.byteLength(record.raw)!==r.response.bytes||createHash('sha256').update(record.raw).digest('hex')!==r.response.sha256)fail('RAW_HASH_OR_PATH');
  if(Date.parse(r.startedAt)>Date.parse(r.finishedAt)||Date.parse(r.finishedAt)>created)fail('RECORD_CLOCK');
  if('params'in r.request&&!READS.has(r.request.method))fail('METHOD');
  if('url'in r.request){let u:URL;try{u=new URL(r.request.url);}catch{return fail('URL');}if(u.protocol!=='https:'||u.username||u.password||u.hash||!['api.wormholescan.io','coins.llama.fi'].includes(u.hostname)||u.port)fail('URL');}
 }
 return c;
}

/** Import the original file bytes. Import time never replaces source clocks. */
export function loadC12BridgeCapture(file:string,cutoff:string):{raw:string;capture:C12BridgeCapture}{
 let fd:number|undefined;
 try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(fd);if(!stat.isFile()||stat.size>C12_CAPTURE_BYTES)fail('FILE_BOUND');const bytes=readFileSync(fd);if(bytes.length!==stat.size||bytes.length>C12_CAPTURE_BYTES)fail('FILE_BOUND');const raw=bytes.toString('utf8');if(!Buffer.from(raw,'utf8').equals(bytes))fail('UTF8');return{raw,capture:decodeC12BridgeCapture(raw,cutoff)};}
 catch(error){if(error instanceof Error&&error.message.startsWith('C12_BRIDGE_SOURCE_'))throw error;return fail('FILE');}
 finally{if(fd!==undefined)closeSync(fd);}
}
