import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import {
  A29_FX_POOLS,
  A29_WSOL_MINT,
  A29_WHIRLPOOL_PROGRAM,
  a29FxThreshold,
  decodeA29Whirlpool,
  type A29RpcAccount,
} from '../src/providers/a29-fx-whirlpool.js'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WBTC = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'

type Bank = { name: string; sha256: string; slot: number; index: number; address: string; quoteMint: string; rawBody: string }
const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/a29-fx-survey-banks.json', import.meta.url), 'utf8')) as { banks: Bank[] }

function genuine(name: string): { bank: Bank; account: A29RpcAccount } {
  const bank = fixture.banks.find((b) => b.name === name)
  assert.ok(bank, name)
  assert.equal(createHash('sha256').update(bank.rawBody).digest('hex'), bank.sha256)
  const body = JSON.parse(bank.rawBody)
  assert.equal(body.result.context.slot, bank.slot)
  return { bank, account: body.result.value[bank.index] }
}

function mutate(account: A29RpcAccount, edit: (b: Buffer) => void): A29RpcAccount {
  const b = Buffer.from(account.data[0], 'base64')
  edit(b)
  return { ...account, data: [b.toString('base64'), 'base64'] }
}

function expectCode(f: () => unknown, code: string) {
  assert.throws(f, (e: unknown) => e instanceof Error && e.message === code)
}

test('genuine WBTC whirlpool decodes with pinned state and exact threshold', () => {
  const { bank, account } = genuine('fx-candidate-bank')
  assert.ok(bank.sha256.startsWith('2fa67ddb'))
  assert.equal(bank.slot, 461414111)
  const pool = decodeA29Whirlpool(A29_FX_POOLS[WBTC], account, WBTC)
  assert.equal(pool.mintA, A29_WSOL_MINT)
  assert.equal(pool.mintB, WBTC)
  assert.equal(pool.liquidity, 2743450542141n)
  assert.equal(pool.sqrtPriceX64, 207339940462952361n)
  assert.equal(a29FxThreshold(pool.sqrtPriceX64), 1264n)
})

test('genuine USDC whirlpool decodes with pinned state', () => {
  const { bank, account } = genuine('fx-usdc-orca-bank')
  assert.equal(bank.slot, 461414930)
  const pool = decodeA29Whirlpool(A29_FX_POOLS[USDC], account, USDC)
  assert.equal(pool.liquidity, 777266125246975n)
  assert.equal(pool.sqrtPriceX64, 5868517248972121358n)
  const t = a29FxThreshold(pool.sqrtPriceX64)
  assert.ok(t > 1011000n && t < 1013000n)
})

test('threshold is the exact ceiling of 1e7*S^2/2^128', () => {
  const d = 1n << 128n
  for (const s of [1n, 4295048016n, 207339940462952361n, 5868517248972121358n, 1n << 64n, 79226673515401279992447579055n]) {
    const t = a29FxThreshold(s)
    const n = 10000000n * s * s
    assert.ok((t - 1n) * d < n && n <= t * d, String(s))
  }
  assert.equal(a29FxThreshold(1n << 64n), 10000000n)
  expectCode(() => a29FxThreshold(0n), 'A29_FX_POOL_SQRT_PRICE')
  expectCode(() => a29FxThreshold(-1n), 'A29_FX_POOL_SQRT_PRICE')
})

test('allowlist, quote and presence adversaries fail closed', () => {
  const { account } = genuine('fx-candidate-bank')
  expectCode(() => decodeA29Whirlpool(A29_FX_POOLS[WBTC], account, A29_WSOL_MINT), 'A29_FX_QUOTE_UNSUPPORTED')
  expectCode(() => decodeA29Whirlpool(A29_FX_POOLS[USDC], account, WBTC), 'A29_FX_POOL_ALLOWLIST')
  expectCode(() => decodeA29Whirlpool(A29_FX_POOLS[WBTC], account, USDC), 'A29_FX_POOL_ALLOWLIST')
  expectCode(() => decodeA29Whirlpool(A29_FX_POOLS[WBTC], null, WBTC), 'A29_FX_POOL_MISSING')
  expectCode(() => decodeA29Whirlpool(A29_FX_POOLS[WBTC], undefined, WBTC), 'A29_FX_POOL_MISSING')
})

test('program, encoding, size and discriminator adversaries fail closed', () => {
  const { account } = genuine('fx-candidate-bank')
  const pool = A29_FX_POOLS[WBTC]
  expectCode(() => decodeA29Whirlpool(pool, { ...account, owner: '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP' }, WBTC), 'A29_FX_POOL_PROGRAM')
  expectCode(() => decodeA29Whirlpool(pool, { ...account, executable: true }, WBTC), 'A29_FX_POOL_PROGRAM')
  expectCode(() => decodeA29Whirlpool(pool, { ...account, data: [account.data[0], 'base58'] }, WBTC), 'A29_FX_POOL_ENCODING')
  expectCode(() => decodeA29Whirlpool(pool, { ...account, data: [account.data[0] + '!', 'base64'] }, WBTC), 'A29_FX_POOL_ENCODING')
  const raw = Buffer.from(account.data[0], 'base64')
  expectCode(() => decodeA29Whirlpool(pool, { ...account, data: [raw.subarray(0, 652).toString('base64'), 'base64'] }, WBTC), 'A29_FX_POOL_SIZE')
  expectCode(() => decodeA29Whirlpool(pool, { ...account, data: [Buffer.concat([raw, Buffer.alloc(1)]).toString('base64'), 'base64'] }, WBTC), 'A29_FX_POOL_SIZE')
  expectCode(() => decodeA29Whirlpool(pool, mutate(account, (b) => { b[0] ^= 1 }), WBTC), 'A29_FX_POOL_DISCRIMINATOR')
})

test('mint, PDA, liquidity and sqrt-bound adversaries fail closed', () => {
  const { account } = genuine('fx-candidate-bank')
  const pool = A29_FX_POOLS[WBTC]
  const usdc = new PublicKey(USDC).toBuffer()
  const wsol = new PublicKey(A29_WSOL_MINT).toBuffer()
  expectCode(() => decodeA29Whirlpool(pool, mutate(account, (b) => { usdc.copy(b, 181) }), WBTC), 'A29_FX_POOL_MINTS')
  expectCode(() => decodeA29Whirlpool(pool, mutate(account, (b) => { usdc.copy(b, 101) }), WBTC), 'A29_FX_POOL_MINTS')
  expectCode(() => decodeA29Whirlpool(pool, mutate(account, (b) => { wsol.copy(b, 181) }), WBTC), 'A29_FX_POOL_MINTS')
  expectCode(() => decodeA29Whirlpool(pool, mutate(account, (b) => { b[8] ^= 1 }), WBTC), 'A29_FX_POOL_PDA')
  expectCode(() => decodeA29Whirlpool(pool, mutate(account, (b) => { b[43] ^= 1 }), WBTC), 'A29_FX_POOL_PDA')
  expectCode(() => decodeA29Whirlpool(pool, mutate(account, (b) => { b[40] = (b[40] + 1) & 255 }), WBTC), 'A29_FX_POOL_PDA')
  expectCode(() => decodeA29Whirlpool(pool, mutate(account, (b) => { b.fill(0, 49, 65) }), WBTC), 'A29_FX_POOL_LIQUIDITY')
  expectCode(() => decodeA29Whirlpool(pool, mutate(account, (b) => { b.fill(0, 65, 81) }), WBTC), 'A29_FX_POOL_SQRT_PRICE')
  expectCode(() => decodeA29Whirlpool(pool, mutate(account, (b) => { b.fill(0, 65, 81); b.writeBigUInt64LE(4295048015n, 65) }), WBTC), 'A29_FX_POOL_SQRT_PRICE')
  expectCode(() => decodeA29Whirlpool(pool, mutate(account, (b) => { b.fill(255, 65, 81) }), WBTC), 'A29_FX_POOL_SQRT_PRICE')
  assert.equal(account.owner, A29_WHIRLPOOL_PROGRAM)
})
