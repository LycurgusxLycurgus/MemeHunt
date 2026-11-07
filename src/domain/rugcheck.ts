import { Decimal } from 'decimal.js';

export type RugLiquidity={pool:string;marketType:string;removableFraction:string;evidenceId:string;source?:'PROGRAM_BONDING_CURVE'};
export function rugRoutePools(raw:Record<string,string>,mint:string):string[]{try{const q=JSON.parse(raw['jupiter-buy-quote']),status=JSON.parse(raw['jupiter-buy-quote-status']);if(status.status!==200||q.outputMint!==mint||!Array.isArray(q.routePlan))return [];return q.routePlan.flatMap((r:{swapInfo?:{ammKey?:unknown}})=>typeof r.swapInfo?.ammKey==='string'?[r.swapInfo.ammKey]:[]);}catch{return [];}}
export function rugOwnerTypes(raw:string,mint:string):Map<string,'AMM'|'LOCKER'>{
 const result=new Map<string,'AMM'|'LOCKER'>();try{const report=JSON.parse(raw);if(report?.mint!==mint||!report.knownAccounts||typeof report.knownAccounts!=='object'||Array.isArray(report.knownAccounts))return result;for(const [address,value] of Object.entries(report.knownAccounts)){const type=(value as {type?:unknown}|null)?.type;if(type==='AMM'||type==='LOCKER')result.set(address,type);}}catch{/* An invalid report supplies no labels. */}return result;
}

/** Qualify a third-party market report for the exact mint; it is not chain certification. */
export function rugLiquidity(raw:string,mint:string,routePools:string[],artifacts?:Record<string,string>):RugLiquidity|undefined{
 if(routePools.length&&artifacts)for(const id of Object.keys(artifacts).filter(key=>/^jupiter-buy-accounts-\d+$/.test(key)))try{
  const addresses:string[]=JSON.parse(artifacts[id+'-request']).params[0];const accounts:Array<{owner?:string}|null>=JSON.parse(artifacts[id]).result.value;
  for(const pool of routePools){const index=addresses.indexOf(pool),owner=accounts[index]?.owner;if(index>=0&&owner&&['dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN','6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'].includes(owner))return {pool,marketType:'bonding curve',removableFraction:'0',evidenceId:id,source:'PROGRAM_BONDING_CURVE'};}
 }catch{/* Missing account data does not establish pool ownership. */}
 try{
  const report=JSON.parse(raw);if(report?.mint!==mint||!Array.isArray(report.markets))return undefined;
  const markets=report.markets.flatMap((market:any)=>{
   if(typeof market?.pubkey!=='string'||typeof market.marketType!=='string'||!market.marketType.trim()||market.mintA!==mint&&market.mintB!==mint||typeof market.lp?.lpLockedPct!=='number'||!Number.isFinite(market.lp.lpLockedPct)||market.lp.lpLockedPct<0||market.lp.lpLockedPct>100)return [];
   const quote=market.lp.quoteUSD;if((typeof quote!=='number'||!Number.isFinite(quote)||quote<0)&&!routePools.includes(market.pubkey))return [];
   return [{pool:market.pubkey,marketType:market.marketType,locked:market.lp.lpLockedPct,quote:typeof quote==='number'&&Number.isFinite(quote)&&quote>=0?quote:-1}];
  });
  markets.sort((a:any,b:any)=>Number(routePools.includes(b.pool))-Number(routePools.includes(a.pool))||b.quote-a.quote||(a.pool<b.pool?-1:a.pool>b.pool?1:0));
  const market=routePools.length?markets.find((m:{pool:string})=>routePools.includes(m.pool)):markets[0];return market?{pool:market.pool,marketType:market.marketType,removableFraction:new Decimal(1).sub(new Decimal(market.locked).div(100)).toFixed(),evidenceId:'rugcheck-report'}:undefined;
 }catch{return undefined;}
}
