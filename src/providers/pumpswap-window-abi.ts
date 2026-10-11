import { PublicKey } from '@solana/web3.js';
import { OFFLINE_PUMP_AMM_PROGRAM } from '@pump-fun/pump-swap-sdk';

// Official pump-public-docs/idl/pump_amm.json, retrieved 2026-10-11.
// SHA-256 b7d8c57a4d9c4dd0109a9ab893052352333252d4eedced10ac091d4d66cab89b.
// Only the three observed v2 swaps and two observed fee sweeps extend the pinned SDK.
export const PUMP_WINDOW_ABI_SOURCE='https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump_amm.json';
export const PUMP_WINDOW_ABI_HASH='b7d8c57a4d9c4dd0109a9ab893052352333252d4eedced10ac091d4d66cab89b';
const instructions=[
 {name:'buy_exact_quote_in_v2',tag:[194,171,28,70,104,77,91,47],side:'BUY',args:['spendableQuoteIn','minBaseAmountOut']},
 {name:'buy_v2',tag:[184,23,238,97,103,197,211,61],side:'BUY',args:['baseAmountOut','maxQuoteAmountIn']},
 {name:'sell_v2',tag:[93,246,130,60,231,233,64,178],side:'SELL',args:['baseAmountIn','minQuoteAmountOut']},
 {name:'sweep_creator_fee',tag:[32,246,191,52,8,201,73,186],side:null,args:[]},
 {name:'sweep_protocol_fee',tag:[8,48,190,7,182,68,183,229],side:null,args:[]},
] as const;
export type PinnedWindowInstruction={name:typeof instructions[number]['name'];side:'BUY'|'SELL'|null;args:Record<string,string>};
export function decodePinnedWindowInstruction(bytes:Buffer):PinnedWindowInstruction|null{
 const definition=instructions.find(i=>Buffer.from(i.tag).equals(bytes.subarray(0,8)));if(!definition)return null;
 if(bytes.length!==(definition.side?24:8))throw new Error('ADVISORY_TRADE_INSTRUCTION_DECODE');
 return {name:definition.name,side:definition.side,args:Object.fromEntries(definition.args.map((name,i)=>[name,bytes.readBigUInt64LE(8+i*8).toString()]))};
}
const sweepEventTag=Buffer.from([130,164,36,97,228,130,135,165]);
/** Current swaps retain the exact old event prefix and append exactly three u64 fields. */
export function decodePinnedWindowEvent(payload:string,accounting=false):{name:string;data:any}|null{
 const bytes=Buffer.from(payload,'base64');
 if(bytes.subarray(0,8).equals(sweepEventTag)){
  if(bytes.length!==185)throw new Error('ADVISORY_TRADE_EVENT_ENCODING');
  const key=(offset:number)=>new PublicKey(bytes.subarray(offset,offset+32));
  return {name:'sweepPoolFeeEvent',data:{timestamp:bytes.readBigInt64LE(8),pool:key(16),baseMint:key(48),quoteMint:key(80),recipient:key(112),payer:key(144),amount:bytes.readBigUInt64LE(176),bucket:bytes[184]}};
 }
 const event=OFFLINE_PUMP_AMM_PROGRAM.coder.events.decode(payload);if(!event)return null;
 if(['buyEvent','sellEvent'].includes(event.name)){
  const definition=OFFLINE_PUMP_AMM_PROGRAM.idl.events!.find(e=>e.name===event.name)!;
  const prefix=Buffer.concat([Buffer.from(definition.discriminator),OFFLINE_PUMP_AMM_PROGRAM.coder.types.encode(event.name,event.data)]);
  if((bytes.length!==prefix.length&&bytes.length!==prefix.length+24)||!bytes.subarray(0,prefix.length).equals(prefix))throw new Error('ADVISORY_TRADE_EVENT_ENCODING');
  if(accounting){
   const current=bytes.length===prefix.length+24;
   Object.assign(event.data,{eventLayout:current?'CURRENT_APPENDIX':'SDK_PREFIX',holderRewardsBps:current?bytes.readBigUInt64LE(prefix.length):null,holderRewards:current?bytes.readBigUInt64LE(prefix.length+8):null,creatorFeeUnclaimed:current?bytes.readBigUInt64LE(prefix.length+16):null});
  }
 }
 return event;
}

export type QuoteAccounting={method:'pumpswap-event-fee-exclusive-v1';basis:'BUY_CORE'|'EXACT_QUOTE_BUY_GROSS'|'SELL_CORE';eventLayout:'SDK_PREFIX'|'CURRENT_APPENDIX';eventQuoteAtomic:string;userQuoteAtomic:string;coreQuoteAtomic:string;grossQuoteAtomic:string;lpFeeAtomic:string;protocolFeeAtomic:string;creatorFeeAtomic:string;totalFeeAtomic:string;buybackFeeAtomic:string;cashbackAtomic:string;holderRewardsBps:string|null;holderRewardsAtomic:string|null;creatorFeeUnclaimedAtomic:string|null};
/** Method-specific observed event identities; protocol subdivisions and accrued state are never added twice. */
export function reconcileWindowQuote(name:string,d:any):QuoteAccounting{
 const fail=():never=>{throw new Error('ADVISORY_TRADE_FEE_BINDING');};
 const amount=(value:unknown):bigint=>{const s=String(value);if(!/^(0|[1-9]\d{0,19})$/.test(s)||BigInt(s)>18446744073709551615n)fail();return BigInt(s);};
 const buy=['buy','buy_v2'].includes(name),exact=['buy_exact_quote_in','buy_exact_quote_in_v2'].includes(name),sell=['sell','sell_v2'].includes(name);
 if(!buy&&!exact&&!sell||!['SDK_PREFIX','CURRENT_APPENDIX'].includes(d.eventLayout))fail();
 if(!sell&&d.ixName!==name)fail();
 const lp=amount(d.lpFee),protocol=amount(d.protocolFee),creator=amount(d.coinCreatorFee),fees=lp+protocol+creator;
 const quote=amount(sell?d.quoteAmountOut:d.quoteAmountIn),user=amount(sell?d.userQuoteAmountOut:d.userQuoteAmountIn),buyback=amount(d.buybackFee),cashback=amount(d.cashback);
 // No retained/source-verified accounting contract exists for nonzero rebates or holder rewards.
 // creatorFeeUnclaimed is an accrued state field, not this trade's creator fee.
 const current=d.eventLayout==='CURRENT_APPENDIX',holderBps=current?amount(d.holderRewardsBps):null,holder=current?amount(d.holderRewards):null,unclaimed=current?amount(d.creatorFeeUnclaimed):null;
 if(cashback!==0n||amount(d.cashbackFeeBasisPoints)!==0n||holderBps!==null&&holderBps!==0n||holder!==null&&holder!==0n||buyback>protocol||fees>18446744073709551615n)fail();
 const core=exact?user:quote,gross=sell?quote:exact?quote:user;
 if(exact?(quote!==user+fees||amount(d.quoteAmountInWithLpFee)!==user+lp):buy?(user!==quote+fees||amount(d.quoteAmountInWithLpFee)!==quote+lp):(quote!==user+fees||amount(d.quoteAmountOutWithoutLpFee)+lp!==quote))fail();
 if(core<=0n)fail();
 return {method:'pumpswap-event-fee-exclusive-v1',basis:exact?'EXACT_QUOTE_BUY_GROSS':buy?'BUY_CORE':'SELL_CORE',eventLayout:d.eventLayout,eventQuoteAtomic:String(quote),userQuoteAtomic:String(user),coreQuoteAtomic:String(core),grossQuoteAtomic:String(gross),lpFeeAtomic:String(lp),protocolFeeAtomic:String(protocol),creatorFeeAtomic:String(creator),totalFeeAtomic:String(fees),buybackFeeAtomic:String(buyback),cashbackAtomic:String(cashback),holderRewardsBps:holderBps===null?null:String(holderBps),holderRewardsAtomic:holder===null?null:String(holder),creatorFeeUnclaimedAtomic:unclaimed===null?null:String(unclaimed)};
}
