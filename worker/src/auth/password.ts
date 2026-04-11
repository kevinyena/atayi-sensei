/**
 * Password hashing and verification using PBKDF2-SHA256 (native in Cloudflare Workers via Web Crypto).
 *
 * We use this for the admin dashboard login. The admin password is hashed once
 * offline (with a local Node script) and the resulting string is stored in
 * `env.ADMIN_PASSWORD_HASH`. The worker verifies incoming login attempts by
 * re-computing the hash with the same parameters and comparing in constant time.
 *
 * Format: "iterations.saltHex.hashHex"
 *
 * We deliberately do NOT use argon2 because the native argon2 packages don't
 * run in Cloudflare Workers, and WASM argon2 adds ~200 KB to the worker bundle.
 * PBKDF2 with 600k iterations is well above OWASP's 2023 recommendation for SHA-256.
 */

const PBKDF2_ITERATIONS = 600_000;
const HASH_BYTE_LENGTH = 32;
const SALT_BYTE_LENGTH = 32;

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const byteArray = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(byteArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const length = hex.length / 2;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function pbkdf2Hash(password: string, salt: Uint8Array, iterations: number, byteLength: number): Promise<Uint8Array> {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    passwordKey,
    byteLength * 8,
  );
  return new Uint8Array(derivedBits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTE_LENGTH);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2Hash(password, salt, PBKDF2_ITERATIONS, HASH_BYTE_LENGTH);
  return `${PBKDF2_ITERATIONS}.${toHex(salt)}.${toHex(hash)}`;
}

/**
 * Constant-time comparison to avoid timing attacks on the admin login.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a[i] ^ b[i];
  }
  return mismatch === 0;
}

export async function verifyPassword(password: string, storedHashString: string): Promise<boolean> {
  const parts = storedHashString.split(".");
  if (parts.length !== 3) return false;
  const [iterationsString, saltHex, hashHex] = parts;
  const iterations = parseInt(iterationsString, 10);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;

  const salt = fromHex(saltHex);
  const storedHash = fromHex(hashHex);
  const computedHash = await pbkdf2Hash(password, salt, iterations, storedHash.length);
  return timingSafeEqual(computedHash, storedHash);
}
