import { fetchReadResponse, readLimitedText } from './http.js';
import type { ControlFacts, HolderFacts, ProgramFacts } from '../domain/baseline.js';

export const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const LEGACY_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const PUBLIC_SOLANA_RPC = 'https://api.mainnet.solana.com';

type JsonObject = Record<string, unknown>;
const object = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonnegativeIntegerString = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
export const safeRpcCode = (error: unknown): string => {
  if (error instanceof Error && error.message === 'PROVIDER_RESPONSE_LIMIT') return 'RPC_RESPONSE_LIMIT';
  if (error instanceof Error && error.message === 'RPC_SHAPE') return 'RPC_SHAPE';
  if (error instanceof Error && /^RPC_REMOTE_-?\d{1,6}$/.test(error.message)) return error.message;
  if (error instanceof Error && /^RPC_HTTP_\d{3}$/.test(error.message)) return error.message;
  const cause = object(error) && object(error.cause) ? error.cause : undefined;
  const codes = [object(error) ? error.code : undefined, cause?.code];
  if (error instanceof Error && error.name === 'TimeoutError' || codes.some(code => code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT')) return 'RPC_TIMEOUT';
  if (codes.some(code => code === 'EACCES' || code === 'EPERM')) return 'RPC_NETWORK_ACCESS_DENIED';
  if (codes.some(code => code === 'ENOTFOUND' || code === 'EAI_AGAIN')) return 'RPC_DNS_ERROR';
  return 'RPC_TRANSPORT';
};

export type SolanaMint =
  | { kind: 'MINT_LEGACY'; programId: string; supplyAtomic: string; decimals: number; mintAuthority: string | null; freezeAuthority: string | null; slot: number }
  | { kind: 'MINT_TOKEN_2022_PARTIAL'; programId: string; supplyAtomic: string; decimals: number; mintAuthority: string | null; freezeAuthority: string | null; slot: number }
  | { kind: 'NON_MINT'; reason: 'ACCOUNT_MISSING' | 'OTHER_PROGRAM'; programId: string | null; slot: number }
  | { kind: 'UNKNOWN'; reason: string; programId: string | null; slot: number | null };
export type SolanaRead = {
  retrievedAt?: Record<string,string>;
  status: 'OBSERVED' | 'UNAVAILABLE' | 'INVALID';
  code?: string;
  genesisRaw?: string;
  accountRaw?: string;
  genesisHash?: string;
  mint?: SolanaMint;
};

export async function solanaRpc(url: string, method: string, params: unknown[], fetcher: typeof fetch, maxBytes=350_000, signal?:AbortSignal,onResponse?:(raw:string)=>void): Promise<{raw: string; value: unknown}> {
  const init:RequestInit = {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  };
  const reads = new Set(['getGenesisHash','getAccountInfo','getProgramAccounts','getTokenLargestAccounts','getMultipleAccounts','getLatestBlockhash','getFeeForMessage','getMinimumBalanceForRentExemption','simulateTransaction']);
  const response = reads.has(method)
    ? await fetchReadResponse(url, init, fetcher, method==='getProgramAccounts'?15_000:8000, true)
    : await fetcher(url,{...init,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
  if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`);
  const raw = await readLimitedText(response, maxBytes);
  onResponse?.(raw);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('RPC_SHAPE'); }
  if (object(value) && object(value.error) && Number.isSafeInteger(value.error.code) && Math.abs(Number(value.error.code))<=999999) throw new Error(`RPC_REMOTE_${value.error.code}`);
  if (!object(value) || value.error || !('result' in value)) throw new Error('RPC_SHAPE');
  return { raw, value: value.result };
}
const rpc=solanaRpc, safeCode=safeRpcCode;

const BASE58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function decodeSolanaAddress(address:string):Buffer {
  if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))throw new Error('INVALID_SOLANA_ADDRESS');
  let value=0n;for(const character of address)value=value*58n+BigInt(BASE58.indexOf(character));
  const hex=value.toString(16);const body=value===0n?Buffer.alloc(0):Buffer.from(hex.length%2?'0'+hex:hex,'hex');
  const bytes=Buffer.concat([Buffer.alloc(address.match(/^1*/)?.[0].length??0),body]);
  if(bytes.length!==32)throw new Error('INVALID_SOLANA_ADDRESS');return bytes;
}
export const encodeSolanaAddress=(bytes:Uint8Array)=>{
  let value=BigInt('0x'+Buffer.from(bytes).toString('hex'));let text='';while(value>0n){text=BASE58[Number(value%58n)]+text;value/=58n;}
  let leading=0;while(leading<bytes.length&&bytes[leading]===0)leading++;return '1'.repeat(leading)+text;
};
const encodeAddress=encodeSolanaAddress;
function rawAccount(result:unknown) {
  if(!object(result)||!object(result.context)||!Number.isSafeInteger(result.context.slot)||Number(result.context.slot)<0||!object(result.value)||typeof result.value.owner!=='string'||!Array.isArray(result.value.data)||result.value.data[1]!=='base64'||typeof result.value.data[0]!=='string')throw new Error('RPC_SHAPE');
  const encoded=result.value.data[0],bytes=Buffer.from(encoded,'base64');if(bytes.toString('base64')!==encoded)throw new Error('RPC_SHAPE');
  return {bytes,owner:result.value.owner,slot:Number(result.context.slot),executable:result.value.executable===true};
}
export function decodeRawMintControls(result:unknown,evidenceIds:string[]=[]):ControlFacts {
  const {bytes:b,owner}=rawAccount(result);
  if((owner!==LEGACY_TOKEN_PROGRAM&&owner!==TOKEN_2022_PROGRAM)||b.length<82||b[45]!==1)throw new Error('RPC_SHAPE');
  const option=(offset:number)=>{const kind=b.readUInt32LE(offset);if(kind!==0&&kind!==1)throw new Error('RPC_SHAPE');return kind===1;};
  const mintAuthority=option(0),freezeAuthority=option(46);let fee='0',immutable=true,transferAllowed=!freezeAuthority;const controls:string[]=[],unsupported:string[]=[];
  if(mintAuthority)controls.push('MINT_AUTHORITY');if(freezeAuthority)controls.push('FREEZE_AUTHORITY');
  if(owner===LEGACY_TOKEN_PROGRAM&&b.length!==82)throw new Error('RPC_SHAPE');
  if(owner===TOKEN_2022_PROGRAM&&b.length!==82) {
    if(b.length<166||b[165]!==1||b.subarray(82,165).some(byte=>byte!==0))throw new Error('RPC_SHAPE');
    const seen=new Set<number>();let offset=166;
    while(offset<b.length){if(b.subarray(offset).every(byte=>byte===0))break;if(offset+4>b.length)throw new Error('RPC_SHAPE');const type=b.readUInt16LE(offset),length=b.readUInt16LE(offset+2);offset+=4;if(type===0||seen.has(type)||offset+length>b.length)throw new Error('RPC_SHAPE');seen.add(type);const data=b.subarray(offset,offset+length);offset+=length;
      if(type===1){if(length!==108)throw new Error('RPC_SHAPE');fee=String(Math.max(data.readUInt16LE(88),data.readUInt16LE(106)));if(Number(fee)>10000)throw new Error('RPC_SHAPE');immutable=data.subarray(0,32).every(x=>x===0);if(!immutable)controls.push('TRANSFER_FEE_AUTHORITY');}
      else if(type===6){if(length!==1||![1,2].includes(data[0]))throw new Error('RPC_SHAPE');if(data[0]===2){transferAllowed=false;controls.push('DEFAULT_FROZEN');}}
      else if(type===9){if(length!==0)throw new Error('RPC_SHAPE');transferAllowed=false;controls.push('NON_TRANSFERABLE');}
      else if(type===12){if(length!==32)throw new Error('RPC_SHAPE');if(data.some(x=>x!==0)){transferAllowed=false;controls.push('PERMANENT_DELEGATE');}}
      else if(type===14){
        if(length!==64)throw new Error('RPC_SHAPE');
        const authority=data.subarray(0,32),program=data.subarray(32,64);
        if(authority.some(x=>x!==0)){controls.push(`TRANSFER_HOOK_AUTHORITY:${encodeAddress(authority)}`);unsupported.push('MUTABLE_TRANSFER_HOOK');}
        if(program.some(x=>x!==0)){controls.push(`TRANSFER_HOOK_PROGRAM:${encodeAddress(program)}`);unsupported.push('TRANSFER_HOOK');}
      }
      else if(type===18){if(length!==64)throw new Error('RPC_SHAPE');}
      else if(type===19){if(length<80)throw new Error('RPC_SHAPE');}
      else unsupported.push(`EXTENSION_${type}`);
    }
  }
  return {complete:!unsupported.length,supplyAllowed:!mintAuthority,transferAllowed,surfaceSupported:!controls.includes('NON_TRANSFERABLE'),currentFeeBps:fee,feeImmutable:immutable,controls,unsupported,evidenceIds};
}
export type SolanaDetails={controls?:ControlFacts;holders?:HolderFacts;program?:ProgramFacts;rawArtifacts:Record<string,string>;errors:Record<string,string>;retrievedAt?:Record<string,string>};
export const UPGRADEABLE_LOADER='BPFLoaderUpgradeab1e11111111111111111111111';
export function decodeProgramHeader(result:unknown,address:string,evidenceIds:string[]=[]):ProgramFacts {
  decodeSolanaAddress(address);const account=rawAccount(result);
  if(!account.executable)throw new Error('RPC_SHAPE');
  if(['BPFLoader2111111111111111111111111111111111','BPFLoader1111111111111111111111111111111111'].includes(account.owner))return {address,loader:account.owner,immutable:true,upgradeAuthority:null,authorityResolved:true,evidenceIds};
  if(account.owner!==UPGRADEABLE_LOADER||account.bytes.length!==36||account.bytes.readUInt32LE(0)!==2)throw new Error('RPC_SHAPE');
  return {address,loader:account.owner,immutable:false,upgradeAuthority:null,programDataAddress:encodeAddress(account.bytes.subarray(4,36)),evidenceIds};
}
export function resolveProgramData(header:ProgramFacts,result:unknown,evidenceIds:string[]):ProgramFacts {
  const account=rawAccount(result);
  if(header.loader!==UPGRADEABLE_LOADER||!header.programDataAddress||account.owner!==UPGRADEABLE_LOADER||account.executable||account.bytes.length<45||account.bytes.readUInt32LE(0)!==3||![0,1].includes(account.bytes[12]))throw new Error('RPC_SHAPE');
  const slot=account.bytes.readBigUInt64LE(4);if(slot>BigInt(account.slot)||slot>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('RPC_SHAPE');
  const authority=account.bytes[12]===1?encodeAddress(account.bytes.subarray(13,45)):null;
  return {...header,upgradeAuthority:authority,immutable:authority===null,authorityResolved:true,deploymentSlot:Number(slot),evidenceIds};
}
export function decodeHolderPopulation(result:unknown,address:string,programId:string,supplyAtomic:string,minSlot:number):HolderFacts {
  if(!object(result)||!object(result.context)||!Number.isSafeInteger(result.context.slot)||Number(result.context.slot)<minSlot||!Array.isArray(result.value)||result.value.length>50000)throw new Error('RPC_SHAPE');
  const mintBytes=decodeSolanaAddress(address),seen=new Set<string>();
  const accounts=result.value.map(item=>{
    if(!object(item)||typeof item.pubkey!=='string'||seen.has(item.pubkey))throw new Error('RPC_SHAPE');decodeSolanaAddress(item.pubkey);seen.add(item.pubkey);
    const a=rawAccount({context:result.context,value:item.account});
    if(a.owner!==programId||a.executable||a.bytes.length!==165||!a.bytes.subarray(0,32).equals(mintBytes)||![1,2].includes(a.bytes[108]))throw new Error('RPC_SHAPE');
    return {address:item.pubkey,owner:encodeAddress(a.bytes.subarray(32,64)),amount:a.bytes.readBigUInt64LE(64).toString()};
  });
  const sum=accounts.reduce((s,a)=>s+BigInt(a.amount),0n);if(sum!==BigInt(supplyAtomic))throw new Error('HOLDER_SUPPLY_UNRECONCILED');
  return {supplyAtomic,accounts,complete:true,slot:Number(result.context.slot),evidenceIds:['rpc-genesis','rpc-holder-population','rpc-mint-raw']};
}
export async function inspectSolanaDetails(mint:SolanaMint,address:string,url=PUBLIC_SOLANA_RPC,fetcher:typeof fetch=fetch,signal?:AbortSignal,now?:()=>string):Promise<SolanaDetails> {
  const rpc=(endpoint:string,method:string,params:unknown[],request:typeof fetch,maxBytes=350_000)=>solanaRpc(endpoint,method,params,request,maxBytes,signal);
  const result:SolanaDetails={rawArtifacts:{},errors:{},...(now?{retrievedAt:{}}:{})};
  if(mint.kind!=='MINT_LEGACY'&&mint.kind!=='MINT_TOKEN_2022_PARTIAL')return result;
  let holderSupply=mint.supplyAtomic;
  try {const read=await rpc(url,'getAccountInfo',[address,{encoding:'base64',commitment:'finalized',minContextSlot:mint.slot}],fetcher);result.rawArtifacts['rpc-mint-raw']=read.raw;if(now)result.retrievedAt!['rpc-mint-raw']=now();const raw=rawAccount(read.value);if(raw.slot<mint.slot||raw.owner!==mint.programId||raw.bytes.length<82||raw.bytes[44]!==mint.decimals)throw new Error('RPC_SHAPE');result.controls=decodeRawMintControls(read.value,['rpc-genesis','rpc-mint-raw']);holderSupply=raw.bytes.readBigUInt64LE(36).toString();}
  catch(error){result.errors.controls=safeCode(error);}
  if(result.controls?.complete&&result.controls.currentFeeBps==='0'&&result.controls.feeImmutable)try {
    const population=await rpc(url,'getProgramAccounts',[mint.programId,{encoding:'base64',commitment:'finalized',minContextSlot:mint.slot,withContext:true,dataSlice:{offset:0,length:165},filters:[{memcmp:{offset:0,bytes:address}},...(mint.programId===LEGACY_TOKEN_PROGRAM?[{dataSize:165}]:[])]}],fetcher,20_000_000);
    result.rawArtifacts['rpc-holder-population']=population.raw;if(now)result.retrievedAt!['rpc-holder-population']=now();result.holders=decodeHolderPopulation(population.value,address,mint.programId,holderSupply,mint.slot);
  }catch(error){result.errors.holderPopulation=error instanceof Error&&error.message==='HOLDER_SUPPLY_UNRECONCILED'?error.message:safeCode(error);}
  if(!result.holders)
  try {
    const largest=await rpc(url,'getTokenLargestAccounts',[address,{commitment:'finalized'}],fetcher);result.rawArtifacts['rpc-largest']=largest.raw;if(now)result.retrievedAt!['rpc-largest']=now();
    if(!object(largest.value)||!object(largest.value.context)||!Number.isSafeInteger(largest.value.context.slot)||Number(largest.value.context.slot)<mint.slot||!Array.isArray(largest.value.value)||largest.value.value.length>20)throw new Error('RPC_SHAPE');
    const addresses:string[]=[],amounts:string[]=[];for(const item of largest.value.value){if(!object(item)||typeof item.address!=='string'||!nonnegativeIntegerString(item.amount)||item.decimals!==mint.decimals)throw new Error('RPC_SHAPE');decodeSolanaAddress(item.address);addresses.push(item.address);amounts.push(item.amount);}
    if(new Set(addresses).size!==addresses.length)throw new Error('RPC_SHAPE');
    if(addresses.length){const accounts=await rpc(url,'getMultipleAccounts',[addresses,{encoding:'base64',commitment:'finalized',minContextSlot:Math.max(mint.slot,Number(largest.value.context.slot))}],fetcher);result.rawArtifacts['rpc-holder-accounts']=accounts.raw;if(now)result.retrievedAt!['rpc-holder-accounts']=now();if(!object(accounts.value)||!object(accounts.value.context)||!Number.isSafeInteger(accounts.value.context.slot)||Number(accounts.value.context.slot)<Math.max(mint.slot,Number(largest.value.context.slot))||!Array.isArray(accounts.value.value)||accounts.value.value.length!==addresses.length)throw new Error('RPC_SHAPE');const expectedMint=decodeSolanaAddress(address);
      const owners=accounts.value.value.map((value,index)=>{const account=rawAccount({context:accounts.value&&object(accounts.value)?accounts.value.context:null,value});if(account.owner!==mint.programId||account.bytes.length<165||!account.bytes.subarray(0,32).equals(expectedMint)||![1,2].includes(account.bytes[108]))throw new Error('RPC_SHAPE');const amount=account.bytes.readBigUInt64LE(64).toString();if(amount!==amounts[index])throw new Error('RPC_SHAPE');return {address:addresses[index],owner:encodeAddress(account.bytes.subarray(32,64)),amount};});
      if(owners.reduce((sum,a)=>sum+BigInt(a.amount),0n)>BigInt(mint.supplyAtomic))throw new Error('RPC_SHAPE');result.holders={supplyAtomic:mint.supplyAtomic,accounts:owners,complete:false,slot:Number(accounts.value.context.slot),evidenceIds:['rpc-genesis','rpc-largest','rpc-holder-accounts']};
    }else result.errors.holders='HOLDER_SAMPLE_EMPTY';
  }catch(error){result.errors.holders=safeCode(error);}
  try {const program=await rpc(url,'getAccountInfo',[mint.programId,{encoding:'base64',commitment:'finalized',minContextSlot:mint.slot,dataSlice:{offset:0,length:36}}],fetcher);result.rawArtifacts['rpc-program']=program.raw;if(now)result.retrievedAt!['rpc-program']=now();if(rawAccount(program.value).slot<mint.slot)throw new Error('RPC_SHAPE');result.program=decodeProgramHeader(program.value,mint.programId,['rpc-genesis','rpc-program']);
    if(result.program.programDataAddress){const data=await rpc(url,'getAccountInfo',[result.program.programDataAddress,{encoding:'base64',commitment:'finalized',minContextSlot:mint.slot,dataSlice:{offset:0,length:45}}],fetcher);result.rawArtifacts['rpc-program-data']=data.raw;if(now)result.retrievedAt!['rpc-program-data']=now();if(rawAccount(data.value).slot<mint.slot)throw new Error('RPC_SHAPE');result.program=resolveProgramData(result.program,data.value,['rpc-genesis','rpc-program','rpc-program-data']);}
  }
  catch(error){result.errors.program=safeCode(error);}
  return result;
}

export function decodeMintAccount(result: unknown): SolanaMint {
  if (!object(result) || !object(result.context) || !Number.isSafeInteger(result.context.slot) || Number(result.context.slot) < 0) {
    return { kind: 'UNKNOWN', reason: 'ACCOUNT_SHAPE', programId: null, slot: null };
  }
  const slot = Number(result.context.slot);
  const account = result.value;
  if (account === null) return { kind: 'NON_MINT', reason: 'ACCOUNT_MISSING', programId: null, slot };
  if (!object(account) || typeof account.owner !== 'string') return { kind: 'UNKNOWN', reason: 'ACCOUNT_SHAPE', programId: null, slot };
  const programId = account.owner;
  if (programId !== LEGACY_TOKEN_PROGRAM && programId !== TOKEN_2022_PROGRAM) {
    return { kind: 'NON_MINT', reason: 'OTHER_PROGRAM', programId, slot };
  }
  if (!object(account.data) || account.data.program !== (programId === LEGACY_TOKEN_PROGRAM ? 'spl-token' : 'spl-token-2022') ||
      !object(account.data.parsed) || account.data.parsed.type !== 'mint' ||
      !object(account.data.parsed.info) || !nonnegativeIntegerString(account.data.parsed.info.supply) ||
      !Number.isInteger(account.data.parsed.info.decimals) || Number(account.data.parsed.info.decimals) < 0 ||
      Number(account.data.parsed.info.decimals) > 255) {
    return { kind: 'UNKNOWN', reason: 'UNPARSED_MINT', programId, slot };
  }
  const info = account.data.parsed.info;
  if (info.mintAuthority !== null && typeof info.mintAuthority !== 'string' ||
      info.freezeAuthority !== null && typeof info.freezeAuthority !== 'string') {
    return { kind: 'UNKNOWN', reason: 'MINT_AUTHORITY_SHAPE', programId, slot };
  }
  return {
    kind: programId === LEGACY_TOKEN_PROGRAM ? 'MINT_LEGACY' : 'MINT_TOKEN_2022_PARTIAL',
    programId, supplyAtomic: String(info.supply), decimals: Number(info.decimals),
    mintAuthority: info.mintAuthority, freezeAuthority: info.freezeAuthority, slot,
  };
}

export async function inspectSolanaRpc(url = PUBLIC_SOLANA_RPC, fetcher: typeof fetch = fetch, signal?:AbortSignal,now?:()=>string): Promise<SolanaRead> {
  let genesis: {raw: string; value: unknown};
  try { genesis = await rpc(url, 'getGenesisHash', [], fetcher, undefined, signal); }
  catch (error) {
    return { status: 'UNAVAILABLE', code: safeCode(error) };
  }
  const receipt=now?{retrievedAt:{'rpc-genesis':now()}}:{};
  if (typeof genesis.value !== 'string' || genesis.value !== SOLANA_MAINNET_GENESIS) {
    return { status: 'INVALID', code: 'WRONG_CLUSTER', genesisRaw: genesis.raw,...receipt,
      ...(typeof genesis.value === 'string' ? { genesisHash: genesis.value } : {}) };
  }
  return { status: 'OBSERVED', genesisRaw: genesis.raw, genesisHash: genesis.value,...receipt };
}

export async function inspectSolanaMint(address: string, url = PUBLIC_SOLANA_RPC, fetcher: typeof fetch = fetch, signal?:AbortSignal,now?:()=>string): Promise<SolanaRead> {
  const genesis = await inspectSolanaRpc(url, fetcher, signal,now);
  if (genesis.status !== 'OBSERVED') return genesis;
  try {
    const account = await rpc(url, 'getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'finalized' }], fetcher, undefined, signal);
    const receipt=now?{retrievedAt:{...genesis.retrievedAt,'rpc-account':now()}}:{};
    const mint = decodeMintAccount(account.value);
    return { status: mint.kind === 'UNKNOWN' ? 'INVALID' : 'OBSERVED',
      ...(mint.kind === 'UNKNOWN' ? { code: mint.reason } : {}),
      genesisRaw: genesis.genesisRaw, accountRaw: account.raw, genesisHash: genesis.genesisHash, mint,...receipt };
  } catch (error) {
    return { status: 'UNAVAILABLE', code: safeCode(error), genesisRaw: genesis.genesisRaw, genesisHash: genesis.genesisHash,...(genesis.retrievedAt?{retrievedAt:genesis.retrievedAt}:{}) };
  }
}
