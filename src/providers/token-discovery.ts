import { PublicKey } from '@solana/web3.js';
import { unpackMint, getExtensionData, ExtensionType, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { metadataPda, MPL_TOKEN_METADATA_PROGRAM_ID } from '@pump-fun/pump-swap-sdk';
import { solanaRpc, PUBLIC_SOLANA_RPC, safeRpcCode } from './solana.js';
import { publicHttpsUrl } from './tinyfish.js';

/** Decode the retained mint/metadata bank without additional network requests. */
export function decodeTokenMetadataUri(raw:string,address:string){
    const mint=new PublicKey(address),body=JSON.parse(raw);
    const value=body.result as {value:Array<{owner:string;data:[string,string];lamports:number;executable:boolean}|null>};
    if(body.error||!value)throw new Error('TOKEN_METADATA_SHAPE');
    if(!Array.isArray(value.value)||value.value.length!==2)throw new Error('TOKEN_METADATA_SHAPE');
    let uri:string|undefined;
    const account=value.value[0];
    if(account?.owner===TOKEN_2022_PROGRAM_ID.toBase58()){
      const info={...account,owner:new PublicKey(account.owner),data:Buffer.from(account.data[0],'base64'),rentEpoch:0};
      const bytes=getExtensionData(ExtensionType.TokenMetadata,unpackMint(mint,info,TOKEN_2022_PROGRAM_ID).tlvData);
      if(bytes){
        if(bytes.length<64||!bytes.subarray(32,64).equals(mint.toBuffer()))throw new Error('TOKEN_METADATA_BINDING');
        let offset=64;
        for(let i=0;i<3;i++){
          if(offset+4>bytes.length)throw new Error('TOKEN_METADATA_SHAPE');
          const n=bytes.readUInt32LE(offset);offset+=4;
          if(n>2048||offset+n>bytes.length)throw new Error('TOKEN_METADATA_SHAPE');
          const text=bytes.subarray(offset,offset+n).toString('utf8').trim();offset+=n;if(i===2)uri=text;
        }
      }
    }else{
      const account=value.value[1];
      if(account?.owner===MPL_TOKEN_METADATA_PROGRAM_ID.toBase58()){
        const data=Buffer.from(account.data[0],'base64');
        if(data.length<65||data[0]!==4||!data.subarray(33,65).equals(mint.toBuffer()))throw new Error('TOKEN_METADATA_BINDING');
        let offset=65;const string=()=>{if(offset+4>data.length)throw new Error('TOKEN_METADATA_SHAPE');const n=data.readUInt32LE(offset);offset+=4;if(n>2048||offset+n>data.length)throw new Error('TOKEN_METADATA_SHAPE');const s=data.subarray(offset,offset+n).toString('utf8').replace(/\0/g,'').trim();offset+=n;return s;};
        string();string();uri=string();
      }
    }
    const safe=uri?publicHttpsUrl(uri,true):null;
    return {uri:safe??undefined,...(uri&&!safe?{code:'TOKEN_METADATA_URL_UNSAFE'}:{})};
}
/** Public mint-owned metadata is discovery, never a market quote or identity certificate. */
export async function discoverTokenMetadata(address:string,url=PUBLIC_SOLANA_RPC,fetcher:typeof fetch=fetch,now:()=>string=()=>new Date().toISOString(),signal?:AbortSignal){
  const mint=new PublicKey(address),rawArtifacts:Record<string,string>={},retrievedAt:Record<string,string>={};
  try{
    const result=await solanaRpc(url,'getMultipleAccounts',[[address,metadataPda(mint).toBase58()],{encoding:'base64',commitment:'finalized'}],fetcher,undefined,signal);
    rawArtifacts['discovery-token-metadata']=result.raw;retrievedAt['discovery-token-metadata']=now();
    return {...await decodeTokenMetadataUri(result.raw,address),rawArtifacts,retrievedAt};
  }catch(error){return {uri:undefined,rawArtifacts,retrievedAt,code:error instanceof Error&&error.message.startsWith('TOKEN_METADATA_')?error.message:safeRpcCode(error)};}
}
