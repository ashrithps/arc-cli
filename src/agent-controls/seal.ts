/**
 * Seal and open, byte-compatible with the phone's `deviceLinkCrypto` and the
 * contract's §4.8 (different HKDF info string):
 *
 *   shared = ECDH(ephemeral, recipientPublic)              -> 32-byte x coordinate
 *   key    = HKDF-SHA256(shared, salt=utf8(context), info="arc-agent-seal-v1", 32)
 *   box    = AES-256-GCM(key, iv[12], aad=utf8(context))  -> ciphertext || tag
 *   wire   = b64url(utf8(canonicalJson({v:1, ek, iv, ct, kid?})))
 *
 * Contexts bind a box to its use: "bootstrap:<connectionId>" (to this CLI),
 * "args:<opHash>" and "detail:<auditId>" (to the user's seal key). A box
 * opened under the wrong context fails authentication, so the server cannot
 * replay one request's arguments under another request.
 */
import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { canonicalJson, fromBase64Url, toBase64Url } from './canonical.js';

export const SEAL_HKDF_INFO = 'arc-agent-seal-v1';
const CURVE = 'prime256v1';

export interface P256KeyPair {
  /** Raw 32-byte private scalar. */
  secret: Uint8Array;
  /** Raw uncompressed 65-byte point. */
  publicKey: Uint8Array;
}

export function generateKeyPair(): P256KeyPair {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return { secret: new Uint8Array(ecdh.getPrivateKey()), publicKey: new Uint8Array(ecdh.getPublicKey()) };
}

export function publicKeyFromSecret(secret: Uint8Array): Uint8Array {
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(Buffer.from(secret));
  return new Uint8Array(ecdh.getPublicKey());
}

function deriveKey(sharedX: Uint8Array, context: string): Buffer {
  return Buffer.from(hkdfSync('sha256', sharedX, Buffer.from(context, 'utf8'), Buffer.from(SEAL_HKDF_INFO, 'utf8'), 32));
}

export interface SealOptions {
  kid?: string;
  /** Test vectors only: a fixed ephemeral scalar and IV. */
  ephemeralSecret?: Uint8Array;
  iv?: Uint8Array;
}

export function sealJson(
  recipientPublicKeyB64: string,
  context: string,
  plaintext: unknown,
  options: SealOptions = {}
): string {
  const ecdh = createECDH(CURVE);
  if (options.ephemeralSecret) ecdh.setPrivateKey(Buffer.from(options.ephemeralSecret));
  else ecdh.generateKeys();
  const sharedX = ecdh.computeSecret(Buffer.from(fromBase64Url(recipientPublicKeyB64)));
  const key = deriveKey(sharedX, context);
  const iv = options.iv ? Buffer.from(options.iv) : randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(canonicalJson(plaintext), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  key.fill(0);
  sharedX.fill(0);
  const envelope = {
    v: 1,
    ek: toBase64Url(ecdh.getPublicKey()),
    iv: toBase64Url(iv),
    ct: toBase64Url(body),
    kid: options.kid,
  };
  return toBase64Url(Buffer.from(canonicalJson(envelope), 'utf8'));
}

export function openJson<T = unknown>(recipientSecret: Uint8Array, context: string, wire: string): T {
  const envelope = JSON.parse(Buffer.from(fromBase64Url(wire)).toString('utf8')) as {
    v: number; ek: string; iv: string; ct: string;
  };
  if (envelope.v !== 1) throw new Error(`Unsupported seal version ${envelope.v}`);
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(Buffer.from(recipientSecret));
  const sharedX = ecdh.computeSecret(Buffer.from(fromBase64Url(envelope.ek)));
  const key = deriveKey(sharedX, context);
  const box = Buffer.from(fromBase64Url(envelope.ct));
  if (box.length < 16) throw new Error('Sealed box too short');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(fromBase64Url(envelope.iv)));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(box.subarray(box.length - 16));
  const plain = Buffer.concat([decipher.update(box.subarray(0, box.length - 16)), decipher.final()]);
  key.fill(0);
  sharedX.fill(0);
  return JSON.parse(plain.toString('utf8')) as T;
}
