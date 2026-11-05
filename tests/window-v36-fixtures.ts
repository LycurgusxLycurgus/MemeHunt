import assert from 'node:assert/strict';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { OFFLINE_PUMP_AMM_PROGRAM } from '@pump-fun/pump-swap-sdk';

// CONSTRUCTED_SOURCE_CONFORMANCE shared encoders for the proof36 extended-mode regressions. Buy/sell event
// prefixes are produced with the installed SDK coder exactly as pumpswap-window-abi re-encodes them, then a
// chosen appendix (0/16/24/32 bytes) is appended. These are authored vectors only; no .data corpus is read
// and nothing here is labelled mainnet-tested. Imported by the abi and recovery suites.
export const sdk = OFFLINE_PUMP_AMM_PROGRAM;
export const toCamel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
type EventIdl = { events: Array<{ name: string; discriminator: number[] }>; types: Array<{ name: string; type: { fields: Array<{ name: string; type: unknown }> } }> };

// Encode a canonical BuyEvent/SellEvent prefix. Every unset field takes the coder's zero value so the prefix
// round-trips byte-for-byte, matching the decoder's re-encode guard.
export function eventPrefix(name: 'buyEvent' | 'sellEvent', overrides: Record<string, bigint | string | boolean | PublicKey> = {}): Buffer {
  const idl = sdk.idl as unknown as EventIdl;
  const event = idl.events.find(e => e.name === name)!, type = idl.types.find(t => t.name === name)!;
  assert.ok(event && type, `installed SDK IDL carries ${name}`);
  const data: Record<string, unknown> = {};
  const put = (k: string, v: bigint | string | boolean | PublicKey): void => { const val = typeof v === 'bigint' ? new BN(v.toString()) : v; data[k] = val; data[toCamel(k)] = val; };
  for (const field of type.type.fields) put(field.name, field.type === 'pubkey' ? PublicKey.default : field.type === 'bool' ? false : field.type === 'string' ? (name === 'buyEvent' ? 'buy' : 'sell') : 0n);
  for (const [k, v] of Object.entries(overrides)) put(k, v);
  return Buffer.concat([Buffer.from(event.discriminator), Buffer.from(sdk.coder.types.encode(name, data as never))]);
}
export function u64le(v: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; }
export function payload(prefix: Buffer, ...tail: bigint[]): string { return Buffer.concat([prefix, ...tail.map(u64le)]).toString('base64'); }
export const EMIT_DISCRIMINATOR = 'e445a52e51cb9a1d';
export function emitData(bytes: Buffer): Buffer { return Buffer.concat([Buffer.from(EMIT_DISCRIMINATOR, 'hex'), bytes]); }
