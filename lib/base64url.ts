// lib/base64url.ts
// Shared base64url (RFC 4648 §5, no padding) byte-encoder — was duplicated
// verbatim in lib/roomLink.ts, lib/crypto/derive.ts, and lib/webrtc/joinProof.ts;
// consolidated here so all three room-crypto callers stay byte-for-byte
// identical by construction instead of by copy-paste discipline.

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
