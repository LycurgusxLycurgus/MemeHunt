import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, userVolumeAccumulatorPda, poolPda } from '@pump-fun/pump-swap-sdk';
import { SOLANA_MAINNET_GENESIS, encodeSolanaAddress } from '../src/providers/solana.js';
import { eventPrefix, sdk } from './window-v36-fixtures.js';
import { a29LiveFetcher } from './a29-fixtures.js';

/** Constructed direct-quote sell tape. No captured trades, economic identities or real-market claims. */
export async function busyWindowFixture(successful = 1061) {
  const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
  const mint = key(61), creator = key(62), user = key(63), baseVault = key(64), quoteVault = key(65);
  const quote = new PublicKey('3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'), token = { chain: 'solana' as const, address: mint.toBase58() };
  const pool = poolPda(0, creator, mint, quote).toBase58(), program = PUMP_AMM_PROGRAM_ID.toBase58(), eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_AMM_PROGRAM_ID)[0].toBase58();
  const end = '2026-10-26T08:00:00.000Z', cutoff = '2026-10-26T08:01:00.000Z', at = Date.parse(end) / 1000 - 1800, anchor = 1_010_000;
  const defaults: Record<string, unknown> = {};
  for (const f of (sdk.idl.types!.find(t => t.name === 'pool')!.type as any).fields) defaults[f.name] = f.type === 'pubkey' ? creator : f.type === 'bool' ? false : f.type === 'u8' || f.type === 'u16' ? 0 : new BN(0);
  const poolBytes = await sdk.coder.accounts.encode('pool', { ...defaults, index: 0, creator, baseMint: mint, quoteMint: quote, poolBaseTokenAccount: baseVault, poolQuoteTokenAccount: quoteVault });
  const mintBytes = Buffer.alloc(82); mintBytes[44] = 8; mintBytes[45] = 1;
  const account = (owner: string, bytes: Buffer) => ({ owner, executable: false, data: [bytes.toString('base64'), 'base64'], lamports: 1 });
  const bank = { context: { slot: anchor + 1 }, value: [account(program, poolBytes), account(TOKEN_PROGRAM_ID.toBase58(), mintBytes)] };
  const signature = (n: number) => { const bytes = Buffer.alloc(64, 13); bytes.writeUInt32LE(n); return encodeSolanaAddress(bytes); };
  const rows = Array.from({ length: successful + 3 }, (_, i) => ({ signature: signature(i), slot: anchor - i - 1, blockTime: i < successful + 2 ? at : at - 3600, err: i >= successful && i < successful + 2 ? { InstructionError: [0, 'Custom'] } : null, confirmationStatus: 'finalized' }));
  const pages = Array.from({ length: Math.ceil(rows.length / 1000) }, (_, i) => rows.slice(i * 1000, (i + 1) * 1000));
  const event = eventPrefix('sellEvent', { timestamp: BigInt(at), pool: new PublicKey(pool), user, userBaseTokenAccount: baseVault, userQuoteTokenAccount: quoteVault, poolBaseTokenReserves: 100000n, poolQuoteTokenReserves: 1000000n, baseAmountIn: 500n, quoteAmountOut: 1000n, userQuoteAmountOut: 1000n, quoteAmountOutWithoutLpFee: 1000n, minQuoteAmountOut: 0n }).toString('base64');
  const data = Buffer.alloc(24); Buffer.from([93, 246, 130, 60, 231, 233, 64, 178]).copy(data); data.writeBigUInt64LE(500n, 8);
  const accounts = [pool, user.toBase58(), GLOBAL_CONFIG_PDA.toBase58(), token.address, quote.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), TOKEN_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58(), '11111111111111111111111111111111', userVolumeAccumulatorPda(user).toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(), user.toBase58(), eventAuthority, program];
  const template = { version: 1, slot: 0, blockTime: at, transaction: { signatures: [''], message: { accountKeys: [...new Set(accounts)].map(pubkey => ({ pubkey, signer: pubkey === user.toBase58(), writable: true })), instructions: [{ programId: program, accounts, data: encodeSolanaAddress(data) }] } }, meta: { err: null, innerInstructions: [], logMessages: [`Program ${program} invoke [1]`, `Program data: ${event}`, `Program ${program} success`] } };
  const calls: Array<{ method: string; params: any[] }> = [], bodies = new Map<string, string>();
  let inFlight = 0, maxInFlight = 0;
  const fallback = a29LiveFetcher(token.address, cutoff);
  const fetcher: typeof fetch = async (input, init) => {
    if (init?.method !== 'POST') { const raw = await (await fallback(input, init)).text(); return new Response(raw.replaceAll('4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E', pool)); }
    const request = JSON.parse(String(init.body)) as { method: string; params: any[] }; calls.push(request);
    let value: any;
    if (request.method === 'getGenesisHash') value = SOLANA_MAINNET_GENESIS;
    else if (request.method === 'getSlot') value = anchor;
    else if (request.method === 'getBlockTime') value = at + 1830;
    else if (request.method === 'getSignaturesForAddress' && request.params[1].limit === 1000) { const before = request.params[1].before, index = before ? pages.findIndex(p => p.at(-1)?.signature === before) + 1 : 0; value = pages[index] ?? []; }
    else if (request.method === 'getAccountInfo' && request.params[0] === pool) value = { context: bank.context, value: bank.value[0] };
    else if (request.method === 'getMultipleAccounts' && request.params[0][0] === pool && request.params[0].length === 2) value = bank;
    else if (request.method === 'getTransaction' && rows.some(r => r.signature === request.params[0])) {
      const row = rows.find(r => r.signature === request.params[0])!;
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise(resolve => setTimeout(resolve, 0)); inFlight--;
      value = { ...template, slot: row.slot, transaction: { ...template.transaction, signatures: [row.signature] } };
    } else return fallback(input, init);
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, result: value }); bodies.set(JSON.stringify({ method: request.method, params: request.params }), raw); return new Response(raw);
  };
  return { token, pool, quote: quote.toBase58(), end, cutoff, rows, pages, fetcher, calls, bodies, maxInFlight: () => maxInFlight };
}
