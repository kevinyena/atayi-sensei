/**
 * Credit accounting: translate Gemini Live token counts into Atayi credits.
 *
 * Atayi credit economics (locked):
 *   1 credit = 1 second of talk time (either direction)
 *   25 tokens/sec audio (input or output), derived from Gemini Live pricing
 *
 * The Durable Object uses these functions to translate incremental token
 * counts (observed on the WebSocket frames) into credit deltas that are
 * flushed to Supabase.
 */

import { AUDIO_IN_USD_PER_M_TOKENS, AUDIO_OUT_USD_PER_M_TOKENS, TOKENS_PER_SECOND } from "../types";

/**
 * Convert a raw Gemini Live token count (audio + text in/out) into
 * an integer number of credits. Rounds up so we never under-charge.
 *
 * Formula: total audio tokens ÷ 25 tokens-per-second, then rounded up.
 * Text tokens contribute in proportion to their USD cost equivalent.
 */
export function tokensToCredits(params: {
  audioInputTokens: number;
  audioOutputTokens: number;
  textInputTokens?: number;
  textOutputTokens?: number;
}): number {
  const audioInputTokensCount = params.audioInputTokens;
  const audioOutputTokensCount = params.audioOutputTokens;
  const textInputTokensCount = params.textInputTokens ?? 0;
  const textOutputTokensCount = params.textOutputTokens ?? 0;

  // Audio contribution: each 25 tokens = 1 second = 1 credit.
  // Use a shared denominator so a frame with only input OR only output still counts.
  const totalAudioTokens = audioInputTokensCount + audioOutputTokensCount;
  const audioCredits = totalAudioTokens / TOKENS_PER_SECOND;

  // Text contribution (screenshots, setup messages, tool results, etc.):
  // price-equivalent conversion — how many credits would it take to match
  // the cost of these text tokens at audio rates?
  // audio input cost per credit ≈ 25 tokens × $3/M = $0.000075
  // text input cost: $0.50/M tokens → 1 text input token = $0.0000005
  // → 1 text input credit = ~150 text tokens
  // For output: $0.30/M text vs $12/M audio → 1 text output credit = ~1000 text output tokens
  const textInputCredits = textInputTokensCount / 150;
  const textOutputCredits = textOutputTokensCount / 1000;

  const totalCredits = audioCredits + textInputCredits + textOutputCredits;
  return Math.ceil(totalCredits);
}

/**
 * Estimate the underlying USD cost of a session for logging / admin dashboard.
 */
export function tokensToUSDCost(params: {
  audioInputTokens: number;
  audioOutputTokens: number;
  textInputTokens?: number;
  textOutputTokens?: number;
}): number {
  const audioInCost = (params.audioInputTokens / 1_000_000) * AUDIO_IN_USD_PER_M_TOKENS;
  const audioOutCost = (params.audioOutputTokens / 1_000_000) * AUDIO_OUT_USD_PER_M_TOKENS;
  const textInCost = ((params.textInputTokens ?? 0) / 1_000_000) * 0.5;
  const textOutCost = ((params.textOutputTokens ?? 0) / 1_000_000) * 0.3;
  return audioInCost + audioOutCost + textInCost + textOutCost;
}

/**
 * Given audio byte count (PCM16 mono @ 16kHz or 24kHz), estimate the token count.
 * Used by the Durable Object when it observes base64 audio payloads going over
 * the WS and doesn't have a direct token count from the server yet.
 *
 * PCM16 mono 16kHz = 32 000 bytes/sec → 25 tokens/sec → 1280 bytes/token
 * PCM16 mono 24kHz = 48 000 bytes/sec → 25 tokens/sec → 1920 bytes/token
 */
export function audioBytesToTokens(byteCount: number, sampleRate: 16000 | 24000 = 16000): number {
  const bytesPerToken = sampleRate === 16000 ? 1280 : 1920;
  return Math.ceil(byteCount / bytesPerToken);
}
