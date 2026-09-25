export async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error('PROVIDER_EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > maxBytes) throw new Error('PROVIDER_RESPONSE_LIMIT');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
