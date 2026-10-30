/** Selector 2's supported Token-2022 TLVs, pinned to Rust 1f2b10a.
 * The on-chain program remains authoritative; this gate keeps unsupported
 * candidates from consuming the preview's eligible-account limit. */
export function cleanupExtensions(data: Buffer, kind: 'mint' | 'account'): Set<number> | null {
  const baseSize = kind === 'mint' ? 82 : 165;
  if (data.length === baseSize) return new Set();
  // Extended mints pad their base to 165 bytes, then carry the account type.
  // 355 bytes is reserved for multisig accounts by the token decoder.
  if (data.length < 166 || data.length === 355 || data[165] !== (kind === 'mint' ? 1 : 2)) return null;
  if (kind === 'mint' && data.subarray(82, 165).some(byte => byte !== 0)) return null;
  const supported = kind === 'mint' ? new Map([[1, 108]]) : new Map([[2, 8], [7, 0]]);
  const types = new Set<number>();
  let offset = 166;
  while (offset < data.length) {
    if (data.subarray(offset).every(byte => byte === 0)) return types;
    if (offset + 4 > data.length) return null;
    const type = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    if (types.has(type) || supported.get(type) !== length || offset + 4 + length > data.length) return null;
    types.add(type);
    offset += 4 + length;
  }
  return types;
}
