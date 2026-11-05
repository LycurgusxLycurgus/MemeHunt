import { PublicKey } from '@solana/web3.js';
import { OFFLINE_PUMP_AMM_PROGRAM } from '@pump-fun/pump-swap-sdk';

// Official pump-public-docs/idl/pump_amm.json, retrieved 2026-10-11.
// SHA-256 b7d8c57a4d9c4dd0109a9ab893052352333252d4eedced10ac091d4d66cab89b.
// Only the three observed v2 swaps and two observed fee sweeps extend the pinned SDK.
export const PUMP_WINDOW_ABI_SOURCE='https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump_amm.json';
export const PUMP_WINDOW_ABI_HASH='b7d8c57a4d9c4dd0109a9ab893052352333252d4eedced10ac091d4d66cab89b';
// @pump-fun/pump-swap-sdk@2.2.0 (and byte-identical pump-rust-client@0.5.0) publish pump_amm.json with
// BuyEvent field 41 / SellEvent field 34 = quote_transfer_fee:u64, the fourth u64 after the installed
// SDK's base_supply prefix (tail order: holder_rewards_bps, holder_rewards, creator_fee_unclaimed,
// quote_transfer_fee). The source URI is the official npm artifact (SHA-256
// b3afc4bcb1cca18c4460c3f41c08be8022bf44b4d6f7de22fac28b7c3edf2a57); the hash is the canonical IDL
// SHA-256. See source-input/source-report.md. Producers select this constant by flag; it is pinned here
// only, with no dependency upgrade.
export const PUMP_WINDOW_V35_ABI_SOURCE='https://registry.npmjs.org/@pump-fun/pump-swap-sdk/-/pump-swap-sdk-2.2.0.tgz';
export const PUMP_WINDOW_V35_ABI_HASH='c2f8ce0bc0a740d9125644b2d95494c97199fce1604802f5ab0497184bdcce61';
// Official pump-public-docs idl/pump_amm.json at commit e0687ae9b7e064a0f54efc7297c65eecfbba3a8f (the September 12 IDL): its
// BuyEvent/SellEvent tail after the installed SDK base_supply prefix is exactly holder_rewards_bps, holder_rewards (+16 bytes).
// Only the proof36 holderAppendix flag selects this layout; no dependency is upgraded.
export const PUMP_WINDOW_V36_HOLDER_ABI_SOURCE='https://raw.githubusercontent.com/pump-fun/pump-public-docs/e0687ae9b7e064a0f54efc7297c65eecfbba3a8f/idl/pump_amm.json';
export const PUMP_WINDOW_V36_HOLDER_ABI_HASH='2091433899b07d003d98118ae6cd3c628960fd393b40710b6e15bce6d0e7f2d1';
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
/**
 * Current swaps retain the exact old event prefix. Default mode appends at most the three holder/creator
 * u64 (CURRENT_APPENDIX, +24) and rejects anything else. `modern` additionally accepts the v35
 * TRANSFER_FEE_APPENDIX (+32), whose fourth u64 is quote_transfer_fee, parsed under `accounting` only in
 * that mode; absent (null) is distinguished from a declared 0. All prefix bytes must re-encode exactly and
 * no other length / trailing bytes are tolerated. `holderAppendix` (proof36 only, effective with `modern`) additionally
 * admits the historical +16 HOLDER_APPENDIX (holder_rewards_bps, holder_rewards) with null creator_fee_unclaimed and quote_transfer_fee.
 */
export function decodePinnedWindowEvent(payload:string,accounting=false,modern=false,holderAppendix=false):{name:string;data:any}|null{
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
  const extra=bytes.length-prefix.length;
  if(!(modern?holderAppendix?[0,16,24,32]:[0,24,32]:[0,24]).includes(extra)||!bytes.subarray(0,prefix.length).equals(prefix))throw new Error('ADVISORY_TRADE_EVENT_ENCODING');
  if(accounting){
   const graded=extra>=16;
   Object.assign(event.data,{eventLayout:extra===32?'TRANSFER_FEE_APPENDIX':extra===16?'HOLDER_APPENDIX':graded?'CURRENT_APPENDIX':'SDK_PREFIX',holderRewardsBps:graded?bytes.readBigUInt64LE(prefix.length):null,holderRewards:graded?bytes.readBigUInt64LE(prefix.length+8):null,creatorFeeUnclaimed:extra>=24?bytes.readBigUInt64LE(prefix.length+16):null});
   if(modern)event.data.quoteTransferFee=extra===32?bytes.readBigUInt64LE(prefix.length+24):null;
  }
 }
 return event;
}

export type QuoteAccounting={method:'pumpswap-event-fee-exclusive-v1'|'pumpswap-event-fee-exclusive-v2'|'pumpswap-event-fee-exclusive-v3'|'pumpswap-event-fee-exclusive-v4';basis:'BUY_CORE'|'EXACT_QUOTE_BUY_GROSS'|'SELL_CORE';eventLayout:'SDK_PREFIX'|'CURRENT_APPENDIX'|'TRANSFER_FEE_APPENDIX'|'HOLDER_APPENDIX';eventQuoteAtomic:string;userQuoteAtomic:string;coreQuoteAtomic:string;grossQuoteAtomic:string;lpFeeAtomic:string;protocolFeeAtomic:string;creatorFeeAtomic:string;totalFeeAtomic:string;buybackFeeAtomic:string;cashbackAtomic:string;holderRewardsBps:string|null;holderRewardsAtomic:string|null;creatorFeeUnclaimedAtomic:string|null;quoteTransferFeeAtomic?:string|null;bookedQuoteAtomic?:string;walletQuoteAtomic?:string|null;budgetRemainderAtomic?:string|null;budgetAtomic?:string|null;route?:QuoteRoute|null;transferWitness?:'NONE'|'TRANSFER_CHECKED'|'TRANSFER_CHECKED_WITH_FEE'};
/** Proof36 position of one multi_hop_swap PumpSwap hop event: its index among all route hops and the route hop count. */
export type QuoteRoute={hop:number;hops:number};
const U64_MAX=18446744073709551615n;
/**
 * Proof36 accounting, reached only through `extended`. Untaxed, cashback-free, non-holder direct swaps and route SELL hops
 * after the first return the exact frozen v2 object. Every other admitted event returns v3 with its booked and wallet quote:
 * direct BUY core=Q, booked=U=Q+F, W=Q+LP, wallet=U+tax; exact-in core=U, booked=U+F, W=U+LP, wallet=booked+tax within the
 * declared budget Q (untaxed Q==booked; the remainder is never flow); SELL core=booked=Q=U+F, W+LP=Q, landed wallet=U-tax;
 * route BUY hop core=U, booked=Q=U+F, W=U+LP, wallet=Q+tax on the first hop only. F counts v1 cashback once. Route masks put
 * protocol only on the first BUY / last SELL hop and LP, creator and holder only on the target hop; a tax is admitted only on
 * the first BUY / last SELL hop. Cashback is a direct v1 charge only, and holder rewards must duplicate the creator charge.
 */
function reconcileExtendedQuote(name:string,d:any,route?:QuoteRoute,budgetExact=false):QuoteAccounting{
 const fail=():never=>{throw new Error('ADVISORY_TRADE_FEE_BINDING');};
 const amount=(value:unknown):bigint=>{const s=String(value);if(!/^(0|[1-9]\d{0,19})$/.test(s)||BigInt(s)>U64_MAX)fail();return BigInt(s);};
 const routeBuy=name==='multi_hop_swap',buy=['buy','buy_v2'].includes(name),exact=['buy_exact_quote_in','buy_exact_quote_in_v2'].includes(name),sell=['sell','sell_v2'].includes(name),layout=d.eventLayout;
 if(!routeBuy&&!buy&&!exact&&!sell||!['SDK_PREFIX','CURRENT_APPENDIX','TRANSFER_FEE_APPENDIX','HOLDER_APPENDIX'].includes(layout))fail();
 if(route?!routeBuy&&name!=='sell'||!Number.isSafeInteger(route.hop)||!Number.isSafeInteger(route.hops)||route.hop<0||route.hop>=route.hops:routeBuy)fail();
 if(!sell&&d.ixName!==name)fail();
 const lp=amount(d.lpFee),protocol=amount(d.protocolFee),creator=amount(d.coinCreatorFee),cashback=amount(d.cashback),buyback=amount(d.buybackFee);
 const lpBps=amount(d.lpFeeBasisPoints),protocolBps=amount(d.protocolFeeBasisPoints),creatorBps=amount(d.coinCreatorFeeBasisPoints),cashbackBps=amount(d.cashbackFeeBasisPoints);amount(d.buybackFeeBasisPoints);
 const fees=lp+protocol+creator+cashback,quote=amount(sell?d.quoteAmountOut:d.quoteAmountIn),user=amount(sell?d.userQuoteAmountOut:d.userQuoteAmountIn),lpLeg=amount(sell?d.quoteAmountOutWithoutLpFee:d.quoteAmountInWithLpFee);
 const graded=layout!=='SDK_PREFIX',holderBps=graded?amount(d.holderRewardsBps):null,holder=graded?amount(d.holderRewards):null;
 const unclaimed=layout==='CURRENT_APPENDIX'||layout==='TRANSFER_FEE_APPENDIX'?amount(d.creatorFeeUnclaimed):null,transfer=layout==='TRANSFER_FEE_APPENDIX'?amount(d.quoteTransferFee):null,tax=transfer??0n;
 const holderPresent=holderBps!==null&&holderBps!==0n||holder!==null&&holder!==0n;
 if(buyback>protocol||fees>U64_MAX||holderPresent&&(holder!==creator||holderBps!==creatorBps))fail();
 if((cashback!==0n||cashbackBps!==0n)&&(route||!['buy','buy_exact_quote_in','sell'].includes(name)))fail();
 // A29 recovery v4 only: a direct untaxed cashback-free exact-in books core+event fees within the declared budget Q, and the remainder Q-booked is never flow.
 // The pinned SDK buyQuoteInput/fee() ceil integer path (dist SHA-256 1ede6b4184a808cf986cd20a89d7c7487c4623054065238c5b9656f6b7309547) must reproduce U and every fee exactly; it is a consistency check, not an on-chain theorem.
 if(budgetExact&&exact&&!route&&tax===0n&&cashback===0n&&cashbackBps===0n&&quote>user+fees){
  const ceil=(x:bigint,bps:bigint)=>(x*bps+9999n)/10000n,creatorOn=d.coinCreator?.toBase58?.()!==PublicKey.default.toBase58(),cBps=creatorOn?creatorBps:0n;
  let e=quote*10000n/(10000n+lpBps+protocolBps+cBps);const over=e+ceil(e,lpBps)+ceil(e,protocolBps)+ceil(e,cBps);if(over>quote)e-=over-quote;
  const booked=user+fees;
  if(amount(d.maxQuoteAmountIn)!==quote||lpLeg!==user+lp||booked>quote||user<=0n||user!==e||lp!==ceil(e,lpBps)||protocol!==ceil(e,protocolBps)||creator!==ceil(e,cBps))fail();
  return {method:'pumpswap-event-fee-exclusive-v4',basis:'EXACT_QUOTE_BUY_GROSS',eventLayout:layout,eventQuoteAtomic:String(quote),userQuoteAtomic:String(user),coreQuoteAtomic:String(user),grossQuoteAtomic:String(booked),lpFeeAtomic:String(lp),protocolFeeAtomic:String(protocol),creatorFeeAtomic:String(creator),totalFeeAtomic:String(fees),buybackFeeAtomic:String(buyback),cashbackAtomic:'0',holderRewardsBps:holderBps===null?null:String(holderBps),holderRewardsAtomic:holder===null?null:String(holder),creatorFeeUnclaimedAtomic:unclaimed===null?null:String(unclaimed),quoteTransferFeeAtomic:transfer===null?null:String(transfer),bookedQuoteAtomic:String(booked),walletQuoteAtomic:String(booked),budgetAtomic:String(quote),budgetRemainderAtomic:String(quote-booked),route:null,transferWitness:'NONE'};
 }
 if(route){
  const last=route.hops-1,protocolLeg=routeBuy?route.hop===0:route.hop===last,targetLeg=routeBuy?route.hop===last:route.hop===0;
  if(!protocolLeg&&(protocol!==0n||protocolBps!==0n)||!targetLeg&&(lp!==0n||lpBps!==0n||creator!==0n||creatorBps!==0n||holderPresent))fail();
  if(tax!==0n&&route.hop!==(routeBuy?0:last))throw new Error('ADVISORY_TRADE_MULTIHOP_EVENT_BINDING');
 }
 let core:bigint,booked:bigint,wallet:bigint|null;
 if(buy){if(user!==quote+fees||lpLeg!==quote+lp)fail();core=quote;booked=user;wallet=user+tax;}
 else if(exact){booked=user+fees;if(lpLeg!==user+lp||(tax===0n?quote!==booked:booked+tax>quote))fail();core=user;wallet=booked+tax;}
 else if(routeBuy){if(quote!==user+fees||lpLeg!==user+lp)fail();core=user;booked=quote;wallet=route!.hop===0?quote+tax:null;}
 else{if(quote!==user+fees||lpLeg+lp!==quote||user<tax)fail();core=quote;booked=quote;wallet=!route||route.hop===route.hops-1?user-tax:null;}
 if(core<=0n||wallet!==null&&wallet>U64_MAX)fail();
 if(tax===0n&&cashback===0n&&cashbackBps===0n&&layout!=='HOLDER_APPENDIX'&&!routeBuy&&(!route||route.hop>0))return reconcileWindowQuote(name,d,true);
 return {method:'pumpswap-event-fee-exclusive-v3',basis:exact||routeBuy?'EXACT_QUOTE_BUY_GROSS':buy?'BUY_CORE':'SELL_CORE',eventLayout:layout,eventQuoteAtomic:String(quote),userQuoteAtomic:String(user),coreQuoteAtomic:String(core),grossQuoteAtomic:String(booked),lpFeeAtomic:String(lp),protocolFeeAtomic:String(protocol),creatorFeeAtomic:String(creator),totalFeeAtomic:String(fees),buybackFeeAtomic:String(buyback),cashbackAtomic:String(cashback),holderRewardsBps:holderBps===null?null:String(holderBps),holderRewardsAtomic:holder===null?null:String(holder),creatorFeeUnclaimedAtomic:unclaimed===null?null:String(unclaimed),quoteTransferFeeAtomic:transfer===null?null:String(transfer),bookedQuoteAtomic:String(booked),walletQuoteAtomic:wallet===null?null:String(wallet),budgetRemainderAtomic:exact?String(quote-booked-tax):null,route:route?{hop:route.hop,hops:route.hops}:null,transferWitness:'NONE'};
}
/**
 * Method-specific observed event identities; protocol subdivisions and accrued state are never added
 * twice. Default `modern=false` returns the exact v1 contract. `modern=true` returns v2
 * (pumpswap-event-fee-exclusive-v2) with quoteTransferFeeAtomic and admits the TRANSFER_FEE_APPENDIX
 * layout: a holder reward that duplicates the coin creator fee is accepted but not re-added, and a nonzero
 * quote transfer fee is explicitly unsupported rather than ignored.
 */
export function reconcileWindowQuote(name:string,d:any,modern=false,extended=false,route?:QuoteRoute,budgetExact=false):QuoteAccounting{
 if(extended)return reconcileExtendedQuote(name,d,route,budgetExact);
 const fail=():never=>{throw new Error('ADVISORY_TRADE_FEE_BINDING');};
 const amount=(value:unknown):bigint=>{const s=String(value);if(!/^(0|[1-9]\d{0,19})$/.test(s)||BigInt(s)>18446744073709551615n)fail();return BigInt(s);};
 const buy=['buy','buy_v2'].includes(name),exact=['buy_exact_quote_in','buy_exact_quote_in_v2'].includes(name),sell=['sell','sell_v2'].includes(name);
 const layouts=modern?['SDK_PREFIX','CURRENT_APPENDIX','TRANSFER_FEE_APPENDIX']:['SDK_PREFIX','CURRENT_APPENDIX'];
 if(!buy&&!exact&&!sell||!layouts.includes(d.eventLayout))fail();
 if(!sell&&d.ixName!==name)fail();
 const lp=amount(d.lpFee),protocol=amount(d.protocolFee),creator=amount(d.coinCreatorFee),fees=lp+protocol+creator;
 const quote=amount(sell?d.quoteAmountOut:d.quoteAmountIn),user=amount(sell?d.userQuoteAmountOut:d.userQuoteAmountIn),buyback=amount(d.buybackFee),cashback=amount(d.cashback);
 const graded=d.eventLayout==='CURRENT_APPENDIX'||d.eventLayout==='TRANSFER_FEE_APPENDIX';
 const holderBps=graded?amount(d.holderRewardsBps):null,holder=graded?amount(d.holderRewards):null,unclaimed=graded?amount(d.creatorFeeUnclaimed):null;
 const transfer=d.eventLayout==='TRANSFER_FEE_APPENDIX'?amount(d.quoteTransferFee):null;
 const holderPresent=holderBps!==null&&holderBps!==0n||holder!==null&&holder!==0n;
 if(cashback!==0n||amount(d.cashbackFeeBasisPoints)!==0n||buyback>protocol||fees>18446744073709551615n)fail();
 // Source-proven: holder rewards duplicate the coin creator fee. A nonzero pair is admitted only when it
 // exactly mirrors that fee, and it is never added to the fee total. Ordinary pools report 0/0 here.
 if(holderPresent&&(!modern||holder!==creator||holderBps!==amount(d.coinCreatorFeeBasisPoints)))fail();
 // The decoder preserves the full quote_transfer_fee field, but no taxed-event identity is proven, so a
 // nonzero tax is explicitly unsupported rather than silently dropped or faked as zero.
 if(transfer!==null&&transfer!==0n)throw new Error('ADVISORY_TRADE_QUOTE_TRANSFER_FEE_UNSUPPORTED');
 const core=exact?user:quote,gross=sell?quote:exact?quote:user;
 if(exact?(quote!==user+fees||amount(d.quoteAmountInWithLpFee)!==user+lp):buy?(user!==quote+fees||amount(d.quoteAmountInWithLpFee)!==quote+lp):(quote!==user+fees||amount(d.quoteAmountOutWithoutLpFee)+lp!==quote))fail();
 if(core<=0n)fail();
 return {method:modern?'pumpswap-event-fee-exclusive-v2':'pumpswap-event-fee-exclusive-v1',basis:exact?'EXACT_QUOTE_BUY_GROSS':buy?'BUY_CORE':'SELL_CORE',eventLayout:d.eventLayout,eventQuoteAtomic:String(quote),userQuoteAtomic:String(user),coreQuoteAtomic:String(core),grossQuoteAtomic:String(gross),lpFeeAtomic:String(lp),protocolFeeAtomic:String(protocol),creatorFeeAtomic:String(creator),totalFeeAtomic:String(fees),buybackFeeAtomic:String(buyback),cashbackAtomic:String(cashback),holderRewardsBps:holderBps===null?null:String(holderBps),holderRewardsAtomic:holder===null?null:String(holder),creatorFeeUnclaimedAtomic:unclaimed===null?null:String(unclaimed),...(modern?{quoteTransferFeeAtomic:transfer===null?null:String(transfer)}:{})};
}
