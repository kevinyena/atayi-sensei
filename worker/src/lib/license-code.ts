/**
 * License code generation and formatting.
 *
 * Format: ATAYI-<TYPE>-XXXX-XXXX-XXXX
 *   TYPE = TRIAL | STRT | ULTR
 *   XXXX = 4-char alphanumeric upper-case (no ambiguous chars: no 0, O, 1, I, L)
 *
 * 12 random alpha chars → 28^12 ≈ 2.3e17 combinations per type. Collision-proof.
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

export function generateLicenseCode(plan: Plan): string {
  const typeLabel = plan === "trial" ? "TRIAL" : plan === "starter" ? "STRT" : "ULTR";
  const segmentA = randomSegment(4);
  const segmentB = randomSegment(4);
  const segmentC = randomSegment(4);
  return `ATAYI-${typeLabel}-${segmentA}-${segmentB}-${segmentC}`;
}

/**
 * Parse a license code and return its plan hint (or null if the format is off).
 * Not authoritative — the actual plan is read from `license_codes.user_id → subscription`.
 */
export function parseLicenseCodeType(code: string): Plan | null {
  const upperCode = code.trim().toUpperCase();
  const match = upperCode.match(/^ATAYI-(TRIAL|STRT|ULTR)-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  if (!match) return null;
  switch (match[1]) {
    case "TRIAL":
      return "trial";
    case "STRT":
      return "starter";
    case "ULTR":
      return "ultra";
    default:
      return null;
  }
}

/**
 * Normalize a user-entered license code: trim, uppercase, remove stray whitespace.
 */
export function normalizeLicenseCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}
