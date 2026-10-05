/**
 * The byte formats every Agent Controls participant must agree on.
 *
 * The server, the phone and this CLI each hash, sign and seal the same bytes,
 * so nothing here is a style choice: `docs/agent-controls/agent-controls-vectors.json`
 * pins every function in this file and `tests/agent-vectors.test.ts` reproduces
 * it. Change a byte here and the phone refuses to sign.
 */
import { createHash } from 'node:crypto';
import type { Surface } from './wire.js';

// ── base64url (RFC 4648 §5, no padding) ─────────────────────────────────────

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  // Node's decoder silently skips junk; the contract says reject it.
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Not base64url');
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

// ── hashing ─────────────────────────────────────────────────────────────────

export function sha256(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

// ── canonicalJson ───────────────────────────────────────────────────────────

/**
 * JSON with object keys in UTF-16 code-unit order (JS default sort), no
 * whitespace, `undefined` members dropped. Non-finite numbers are an error:
 * `JSON.stringify` would quietly turn them into `null` and two sides would
 * hash different things.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        // Array holes and undefined entries become null, as JSON.stringify does.
        return `[${value.map(item => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
      return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value}`);
  }
}

// ── opHash ──────────────────────────────────────────────────────────────────

export interface OpHashInput {
  opId: string;
  /** The budget's syncId, or "" when none is selected. */
  budget: string;
  surface: Surface;
  args: Record<string, unknown>;
}

export function opHashPreimage(input: OpHashInput): string {
  return canonicalJson({ v: 1, opId: input.opId, budget: input.budget, surface: input.surface, args: input.args });
}

export function computeOpHash(input: OpHashInput): string {
  return sha256Hex(opHashPreimage(input));
}

// ── signed messages ─────────────────────────────────────────────────────────

export interface ApprovalMessageFields {
  requestId: string;
  opHash: string;
  decision: 'approve';
  scope: 'once' | 'minutes' | 'always';
  scopeMinutes: number;
  nonce: string;
  expiresAt: number;
  deviceId: string;
}

export function approvalMessage(f: ApprovalMessageFields): string {
  return [
    'arc-approval-v1',
    f.requestId,
    f.opHash,
    f.decision,
    f.scope,
    String(f.scope === 'minutes' ? f.scopeMinutes : 0),
    f.nonce,
    String(f.expiresAt),
    f.deviceId,
  ].join('\n');
}

export function connectMessage(f: {
  connectionId: string; fingerprint: string; nonce: string; expiresAt: number; deviceId: string;
}): string {
  return ['arc-connect-v1', f.connectionId, f.fingerprint, f.nonce, String(f.expiresAt), f.deviceId].join('\n');
}

export function enrollMessage(f: {
  newDeviceId: string; newPublicKey: string; nonce: string; expiresAt: number; deviceId: string;
}): string {
  return ['arc-enroll-v1', f.newDeviceId, f.newPublicKey, f.nonce, String(f.expiresAt), f.deviceId].join('\n');
}

// ── DER → raw ECDSA ─────────────────────────────────────────────────────────

/**
 * An ECDSA DER signature as the 64-byte `r‖s` WebCrypto verifies.
 *
 * Strict on purpose: a verifier that tolerates trailing bytes or non-minimal
 * integers accepts more than one encoding of the same signature, and the
 * audit chain hashes the signature string.
 */
export function derToRawSignature(der: Uint8Array): Uint8Array {
  let pos = 0;
  const fail = (why: string): never => { throw new Error(`Bad DER signature: ${why}`); };
  if (der[pos++] !== 0x30) fail('not a sequence');
  const seqLen = der[pos++];
  if (seqLen === undefined || seqLen & 0x80) fail('long-form length');
  if (pos + seqLen !== der.length) fail('length mismatch or trailing bytes');

  const readInt = (): Uint8Array => {
    if (der[pos++] !== 0x02) fail('not an integer');
    const len = der[pos++];
    if (!len || len & 0x80) fail('bad integer length');
    if (len > 33) fail('integer too long');
    const bytes = der.subarray(pos, pos + len);
    if (bytes.length !== len) fail('truncated');
    pos += len;
    if (bytes[0] & 0x80) fail('negative integer');
    if (len > 1 && bytes[0] === 0x00 && !(bytes[1] & 0x80)) fail('non-minimal integer');
    const stripped = bytes[0] === 0x00 && len > 1 ? bytes.subarray(1) : bytes;
    if (stripped.length > 32) fail('integer too large');
    const out = new Uint8Array(32);
    out.set(stripped, 32 - stripped.length);
    return out;
  };

  const r = readInt();
  const s = readInt();
  if (pos !== der.length) fail('trailing bytes');
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

/** Verify a DER/base64url signature against a raw 65-byte public key, as the server does. */
export async function verifyP256Signature(
  publicKeyB64: string,
  message: string,
  signatureDerB64: string
): Promise<boolean> {
  let raw: Uint8Array;
  try {
    raw = derToRawSignature(fromBase64Url(signatureDerB64));
  } catch {
    return false;
  }
  const key = await globalThis.crypto.subtle.importKey(
    'raw', Buffer.from(fromBase64Url(publicKeyB64)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
  );
  return globalThis.crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(raw), Buffer.from(message, 'utf8')
  );
}

// ── fingerprint ─────────────────────────────────────────────────────────────

export function fingerprintOf(publicKeyRaw: Uint8Array): string {
  const hex = sha256Hex(publicKeyRaw).slice(0, 16).toUpperCase();
  return hex.match(/.{4}/g)!.join('-');
}
