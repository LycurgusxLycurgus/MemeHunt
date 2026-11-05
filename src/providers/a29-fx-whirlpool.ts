import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'

// Fixed public quote FX allowlist: WSOL (mintA) -> quote (mintB) Orca Whirlpools.
// The derived threshold is a marginal pool rate at the e0 bank, not an execution price or peg.
export const A29_WSOL_MINT = 'So11111111111111111111111111111111111111112'
export const A29_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
export const A29_FX_POOLS: Readonly<Record<string, string>> = Object.freeze({
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA',
})

const SIZE = 653
const DISCRIMINATOR = createHash('sha256').update('account:Whirlpool').digest().subarray(0, 8)
const MIN_SQRT_PRICE_X64 = 4295048016n
const MAX_SQRT_PRICE_X64 = 79226673515401279992447579055n
const MEANINGFUL_LAMPORTS = 10000000n

export type A29RpcAccount = { owner: string; data: readonly [string, string]; executable?: boolean }
export type A29Whirlpool = {
  pool: string
  config: string
  mintA: string
  mintB: string
  tickSpacing: number
  feeTierIndexSeed: number
  feeRate: number
  liquidity: bigint
  sqrtPriceX64: bigint
  tickCurrentIndex: number
}

function fail(code: string): never {
  throw new Error(code)
}

const u128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n)
const key = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32)).toBase58()

export function decodeA29Whirlpool(address: string, account: A29RpcAccount | null | undefined, quoteMint: string): A29Whirlpool {
  const expected = Object.prototype.hasOwnProperty.call(A29_FX_POOLS, quoteMint) ? A29_FX_POOLS[quoteMint] : fail('A29_FX_QUOTE_UNSUPPORTED')
  if (address !== expected) fail('A29_FX_POOL_ALLOWLIST')
  if (account === null || account === undefined) fail('A29_FX_POOL_MISSING')
  if (account.owner !== A29_WHIRLPOOL_PROGRAM || account.executable === true) fail('A29_FX_POOL_PROGRAM')
  const data = account.data
  if (!Array.isArray(data) || data.length !== 2 || data[1] !== 'base64' || typeof data[0] !== 'string') fail('A29_FX_POOL_ENCODING')
  const b = Buffer.from(data[0], 'base64')
  if (b.toString('base64') !== data[0]) fail('A29_FX_POOL_ENCODING')
  if (b.length !== SIZE) fail('A29_FX_POOL_SIZE')
  if (!b.subarray(0, 8).equals(DISCRIMINATOR)) fail('A29_FX_POOL_DISCRIMINATOR')
  const config = key(b, 8)
  const mintA = key(b, 101)
  const mintB = key(b, 181)
  if (mintA !== A29_WSOL_MINT || mintB !== quoteMint) fail('A29_FX_POOL_MINTS')
  const seed = b.subarray(43, 45)
  let pda: [PublicKey, number]
  try {
    pda = PublicKey.findProgramAddressSync(
      [Buffer.from('whirlpool'), b.subarray(8, 40), b.subarray(101, 133), b.subarray(181, 213), seed],
      new PublicKey(A29_WHIRLPOOL_PROGRAM),
    )
  } catch {
    fail('A29_FX_POOL_PDA')
  }
  if (pda[0].toBase58() !== address || pda[1] !== b[40]) fail('A29_FX_POOL_PDA')
  const liquidity = u128(b, 49)
  const sqrtPriceX64 = u128(b, 65)
  if (liquidity <= 0n) fail('A29_FX_POOL_LIQUIDITY')
  if (sqrtPriceX64 < MIN_SQRT_PRICE_X64 || sqrtPriceX64 > MAX_SQRT_PRICE_X64) fail('A29_FX_POOL_SQRT_PRICE')
  return {
    pool: address,
    config,
    mintA,
    mintB,
    tickSpacing: b.readUInt16LE(41),
    feeTierIndexSeed: seed.readUInt16LE(0),
    feeRate: b.readUInt16LE(45),
    liquidity,
    sqrtPriceX64,
    tickCurrentIndex: b.readInt32LE(81),
  }
}

// Raw quote units per 0.01 SOL: price(raw B per raw A) = S^2 / 2^128, rounded up.
export function a29FxThreshold(sqrtPriceX64: bigint): bigint {
  if (typeof sqrtPriceX64 !== 'bigint' || sqrtPriceX64 <= 0n) fail('A29_FX_POOL_SQRT_PRICE')
  const numerator = MEANINGFUL_LAMPORTS * sqrtPriceX64 * sqrtPriceX64
  const denominator = 1n << 128n
  return (numerator + denominator - 1n) / denominator
}
