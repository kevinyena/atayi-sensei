/**
 * License code generation and formatting.
 *
 * Format: ATAYI-XXXX-XXXX-XXXX-XXXX
 *   XXXX = 4-char alphanumeric upper-case (no ambiguous chars: no 0, O, 1, I, L)
 *
 * 16 random alpha chars → 30^16 ≈ 4.3e23 combinations. Collision-proof.
 * No plan prefix — the same code works across trial → starter → ultra upgrades.
 */

import type { Plan } from "../types";

const UNAMBIGUOUS_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomSegment(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let segment = "";
  for (let i = 0; i < length; i++) {
    segment += UNAMBIGUOUS_ALPHABET[bytes[i] % UNAMBIGUOUS_ALPHABET.length];
  }
  return segment;
}

export function generateLicenseCode(_plan: Plan): string {
  const segmentA = randomSegment(4);
  const segmentB = randomSegment(4);
  const segmentC = randomSegment(4);
  const segmentD = randomSegment(4);
  return `ATAYI-${segmentA}-${segmentB}-${segmentC}-${segmentD}`;
}

/**
 * Normalize a user-entered license code: trim, uppercase, remove stray whitespace.
 */
export function normalizeLicenseCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}
