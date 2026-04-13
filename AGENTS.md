# Atayi Sensei — Agent Instructions

<!-- This is the single source of truth for all AI coding agents. CLAUDE.md is a symlink to this file. -->
<!-- AGENTS.md spec: https://github.com/agentsmd/agents.md — supported by Claude Code, Cursor, Copilot, Gemini CLI, and others. -->

## Overview

Atayi Sensei is a macOS menu bar companion app that teaches indie game creators. It lives entirely in the status bar (no dock icon, no main window). Pressing `ctrl + option` opens a persistent **Gemini Live** WebSocket session — a multimodal model that handles voice activity detection, vision (screenshots), reasoning, speech-to-text, and audio output natively. A blue cursor overlay can fly to and point at UI elements Gemini references on any connected monitor.

The project is a SaaS product with a full backend: Cloudflare Workers + Durable Objects proxy all API calls so the Gemini API key never ships in the binary; Supabase stores users, subscriptions, devices, and sessions; Stripe handles payments; a landing page + admin dashboard are deployed on Cloudflare Pages.

## Architecture

### High-level flow

```
macOS app → Worker /api/session/preflight → Worker Durable Object → Gemini Live
                     ↓                              ↓
                  Supabase                       Supabase
                  (license + credits)            (token accounting every 30s)

Landing page → Worker /api/billing/checkout → Stripe Checkout → Worker webhook → Supabase
```

### Components

- **App type**: Menu bar-only (`LSUIElement=true`), no dock icon or main window
- **Framework**: SwiftUI (macOS native) with AppKit bridging for menu bar panel and cursor overlay
- **Pattern**: MVVM with `@StateObject` / `@Published` state management
- **Voice session**: **Gemini Live** — persistent WebSocket proxied through a Cloudflare **Durable Object** (`GeminiSessionDO`). The DO opens the upstream connection to `wss://generativelanguage.googleapis.com` with the real `GEMINI_API_KEY` on the server side, then relays frames in both directions to the Swift client. Every 30 s it flushes token counts into Supabase via RPC functions (`increment_subscription_credits`, `increment_daily_usage`). If usage exceeds the plan limit mid-session, the DO sends an `atayiServerEvent.blocked` frame and closes the sockets.
- **Screen capture**: ScreenCaptureKit (macOS 14.2+), multi-monitor support
- **Voice input**: push-to-talk via a listen-only `CGEvent` tap (`ctrl + option`) so the shortcut is captured even when the app is in the background
- **Element annotation**: Gemini calls `annotate_element(x, y, width, height, shape, label, screen_index)` when it wants to highlight a UI element. `CompanionManager` converts screenshot-pixel coordinates to AppKit global coordinates and publishes `activeAnnotation: ScreenAnnotation`. The overlay draws the shape with a blue glow and fades it out once the cursor approaches
- **Concurrency**: `@MainActor` isolation, async/await throughout
- **Analytics**: PostHog via `ClickyAnalytics.swift` + Supabase `landing_events` for the marketing funnel

### Cloudflare Worker backend (`worker/src/`)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/auth/trial-signup` | POST | Create trial account, return license code |
| `/api/license/activate` | POST | Bind a license code to `device_fingerprint`, return JWT device token (7d) |
| `/api/license/status` | GET | Check subscription state + credits + daily cap |
| `/api/session/preflight` | POST | Pre-flight: verify license, credits, cap → return session token + `ws_url` |
| `/api/session/live` | WS | WebSocket routed to a per-session `GeminiSessionDO` that proxies Gemini Live |
| `/api/billing/checkout` | POST | Create Stripe Checkout Session |
| `/api/billing/webhook` | POST | Stripe webhook receiver (checkout.completed, invoice.paid, sub.updated/deleted, payment_failed) |
| `/api/billing/session/:id` | GET | Retrieve Stripe Checkout session → return license code to the success page |
| `/api/landing/event` | POST | Record page views / downloads / checkout events for analytics |
| `/api/admin/login` | POST | Admin password gate → returns scoped JWT (24h) |
| `/api/admin/stats` | GET | Dashboard tiles (visits, downloads, MRR, trials, etc.) |
| `/api/admin/users` | GET | Filtered user list (reads `admin_user_stats` matview) |
| `/api/admin/user/:id` | GET | Single user detail + devices + recent sessions |
| `/api/admin/block-user` | POST | Block user (sets `users.is_blocked = true`) |
| `/api/admin/block-device` | POST | Block a specific device fingerprint |

Scheduled: cron `*/5 * * * *` → `REFRESH MATERIALIZED VIEW admin_user_stats` via the RPC function `refresh_admin_stats`.

### Supabase schema (`infra/supabase/schema.sql`)

Tables: `users`, `subscriptions`, `license_codes`, `devices`, `sessions`, `daily_usage`, `landing_events`, `admin_audit_log`.
Matview: `admin_user_stats` (refreshed by the cron).
RPC functions: `increment_subscription_credits`, `increment_daily_usage`, `refresh_admin_stats`.

The worker is the only client that talks to Supabase, using the `service_role` key. Row-Level Security is not enabled because the frontend never hits PostgREST directly.

### Plan economics

1 credit = 1 second of talk time. Derived from Gemini Live pricing (`$3/M` audio in, `$12/M` audio out, 25 tokens/sec).

| Plan | Price | Credits/month | Max devices | Trial daily cap |
|---|---|---|---|---|
| Trial | free | 1 800 total (= 30 min) | 1 | No daily cap |
| Starter | $19/mo | 40 000 (~11 h) | 1 | — |
| Ultra | $49/mo | 160 000 (~44 h, shared) | 3 | — |

### Security invariants

- **No API keys in the app binary.** Gemini, Stripe, Supabase service_role — all live only in Cloudflare Worker secrets.
- **Short-lived session tokens (5 min)** limit the blast radius of a leaked token mid-session.
- **Device binding** uses SHA-256 of `IOPlatformUUID` so two Macs are never conflated (and reinstall-stable).
- **Admin password** hashed with PBKDF2-SHA256, **100 000 iterations** (Cloudflare Workers Web Crypto maximum). 32-byte random salt, constant-time comparison on verify.
- **Stripe webhooks** verified against `STRIPE_WEBHOOK_SECRET` with HMAC-SHA256 and a 5-minute timestamp tolerance window.
- **Rate limiting** (planned): at the Worker level per IP/user for `/api/auth/*`, `/api/license/activate`, `/api/session/preflight`.

### Key architecture decisions

**Durable Objects for the voice proxy**: Cloudflare Workers are stateless. A bidirectional WebSocket relay needs long-lived state (the upstream connection, token counters, buffered frames). Each session gets its own DO instance keyed by `sha256(session_token)`, so concurrent sessions are fully isolated. The DO is deleted when the WebSocket closes.

**Token accounting on the Worker side, not the client**: the Swift app would lie about usage if it reported credits itself. The DO sees every frame, counts tokens by inspecting `realtimeInput.audio.data` (base64 length → bytes → tokens at 25 tokens/sec) and `serverContent.modelTurn.parts[].inlineData`, and flushes absolute totals to Supabase every 30 s. If credits run out mid-conversation, the DO sends `atayiServerEvent.blocked` before closing so the Swift UI can show a user-friendly error.

**License codes are display artifacts, JWTs do the work**: The user types a `ATAYI-...-XXXX-XXXX-XXXX` code once on activation. The worker looks it up in `license_codes`, validates the subscription, and returns a JWT `device_token`. From that point on, the app uses the JWT (stored in Keychain `.whenUnlockedThisDeviceOnly`) for all requests. The license code is only shown again on `account.html` for reference.

**Menu bar panel pattern**: uses `NSStatusItem` + a borderless non-activating `NSPanel` so the app can render a dark rounded-corner dropdown that doesn't steal focus. A global event monitor auto-dismisses on outside clicks.

**Cursor overlay**: full-screen transparent non-activating `NSPanel` joined to all Spaces. Hosts the blue cursor, waveform, spinner, and response text via `NSHostingView`.

**Global push-to-talk**: listen-only `CGEvent` tap (not an AppKit global monitor) so modifier-only combos like `ctrl + option` are detected reliably while the app is in the background.

## Key files

### Swift app (`leanring-buddy/`)

| File | ~Lines | Purpose |
|---|---|---|
| `leanring_buddyApp.swift` | ~100 | Entry point. `CompanionAppDelegate` creates `MenuBarPanelManager`, starts `CompanionManager`, calls `LicenseManager.shared.hydrateFromCache()` |
| `CompanionManager.swift` | ~1050 | State machine. Owns shortcut monitoring, overlay, and the preflight → proxied Gemini Live pipeline. Hooks on `LicenseManager.preflightSession()` before each connect |
| `GeminiLiveSession.swift` | ~475 | Opens the WebSocket to the Worker Durable Object (not directly to Google) using `Bearer <session_token>`. Handles `atayiServerEvent.blocked` frames |
| `LicenseManager.swift` | ~330 | `/api/license/activate`, `/status`, `/session/preflight` client. Stores the device JWT in Keychain. Publishes `LicenseState` for the UI |
| `DeviceFingerprint.swift` | ~75 | Reads `IOPlatformUUID` via IOKit, hashes with SHA-256. Also exposes device name, OS version, app version |
| `KeychainHelper.swift` | ~100 | Thin `SecItem*` wrapper for storing the device JWT with access control `.whenUnlockedThisDeviceOnly` |
| `LicenseActivationView.swift` | ~160 | Panel view shown when no license is cached: paste code, activate, show errors. Also links to the landing page trial |
| `SubscriptionStatusView.swift` | ~200 | Panel chip showing plan + credits used / allowance + daily usage + manage button |
| `BuddyPushToTalkShortcut.swift` | ~50 | Minimal `ctrl+option` shortcut transition detection via `CGEventType` |
| `GlobalPushToTalkShortcutMonitor.swift` | ~130 | System-wide listen-only `CGEvent` tap, publishes press/release |
| `BuddyAudioConversionSupport.swift` | ~70 | `BuddyPCM16AudioConverter`: mic buffer → PCM16 mono 16 kHz |
| `MenuBarPanelManager.swift` | ~245 | `NSStatusItem` + borderless `NSPanel` lifecycle |
| `CompanionPanelView.swift` | ~800 | Panel content: conditionally renders `LicenseActivationView` or the regular companion UI + `SubscriptionStatusView` |
| `OverlayWindow.swift` | ~880 | Full-screen transparent cursor overlay |
| `CompanionResponseOverlay.swift` | ~220 | Response text bubble + waveform shown next to the cursor |
| `CompanionScreenCaptureUtility.swift` | ~130 | Multi-monitor screenshot capture via ScreenCaptureKit |
| `ElementLocationDetector.swift` | ~335 | Screenshot → element location for cursor pointing |
| `DesignSystem.swift` | ~880 | Colors, corner radii, shared styles (`DS.Colors.*`) |
| `ClickyAnalytics.swift` | ~121 | PostHog integration |
| `WindowPositionManager.swift` | ~260 | Permission helpers (accessibility, screen recording) |
| `AppBundleConfiguration.swift` | ~28 | Runtime config reader (Info.plist → string value) |

### Cloudflare Worker (`worker/src/`)

| File | Purpose |
|---|---|
| `index.ts` | Router + `scheduled()` cron handler |
| `types.ts` | `Env` interface, DB types, `Plan` enum, `PLAN_LIMITS` |
| `db/supabase.ts` | Typed PostgREST client (users, subscriptions, devices, sessions, RPC, admin) |
| `auth/jwt.ts` | HS256 sign/verify using Web Crypto |
| `auth/password.ts` | PBKDF2-SHA256 hash/verify (100k iterations — Cloudflare Workers Web Crypto cap) |
| `lib/credit-accounting.ts` | `tokensToCredits`, `audioBytesToTokens`, `tokensToUSDCost` |
| `lib/license-code.ts` | `generateLicenseCode`, `normalizeLicenseCode` |
| `lib/stripe-helpers.ts` | `createCheckoutSession`, `retrieveSubscription`, `verifyStripeWebhookSignature` |
| `lib/response.ts` | `jsonResponse`, `errorResponse`, CORS |
| `routes/trial.ts` | Trial signup flow |
| `routes/license.ts` | Activate + status |
| `routes/billing.ts` | Stripe checkout + webhook + session retrieval |
| `routes/session.ts` | Preflight endpoint |
| `routes/landing.ts` | Analytics events + cron stats refresh |
| `routes/admin.ts` | Admin dashboard endpoints |
| `do/gemini-session.ts` | `GeminiSessionDO` Durable Object — the Gemini Live WebSocket proxy |

### Landing page (`Landing/`)

| File | Purpose |
|---|---|
| `index.html` | Existing marketing page + `js/main.js` plan chooser modal wiring |
| `trial.html` | Email → trial signup → display license code with copy button |
| `checkout-success.html` | Stripe redirect: retrieve session, display code (copy-once warning) |
| `checkout-cancel.html` | "Payment cancelled" + fallback CTAs |
| `account.html` | Subscription management placeholder |
| `admin-login.html` | Password gate → admin JWT |
| `admin.html` | Dashboard: stats tiles, user list with filters, per-user drawer |
| `js/api.js` | Fetch wrapper around `/api/*` |
| `js/main.js` | Plan chooser modal + download wiring |
| `js/admin.js` | Admin dashboard logic |
| `js/shared-styles.js` | Injected CSS for trial / success / admin pages |

### Infra (`infra/supabase/`, `scripts/`)

| File | Purpose |
|---|---|
| `infra/supabase/schema.sql` | Full Postgres schema — idempotent, runnable in the SQL editor |
| `scripts/release.sh` | macOS archive → export → DMG pipeline. Modes: `unsigned` (default) / `developer-id` / `clean` |

## Build & run

```bash
# Open in Xcode
open leanring-buddy.xcodeproj

# Select the leanring-buddy scheme, set signing team, Cmd+R to build and run
```

**Known non-blocking warnings**: Swift 6 concurrency warnings, deprecated `onChange` warning in `OverlayWindow.swift`. Do NOT attempt to fix these.

**Do NOT run `xcodebuild` from the terminal during development** — it can invalidate TCC (screen recording, accessibility, microphone) grants and force the user to re-approve them. For distribution builds only, use `./scripts/release.sh`.

## Release pipeline

```bash
./scripts/release.sh               # unsigned DMG for alpha/beta (no Apple Developer Program required)
./scripts/release.sh developer-id  # signed + notarized DMG for public release
./scripts/release.sh clean         # wipe build/ directory
```

Unsigned DMGs work for testers who right-click → Open the first time. Once the Apple Developer Program enrollment completes and a `Developer ID Application` cert is installed, rerun with `developer-id` for a Gatekeeper-friendly build.

## Cloudflare Worker deployment

```bash
cd worker
npm install
npx wrangler deploy
```

Secrets (push via `wrangler secret put`):
- `GEMINI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `JWT_SIGNING_SECRET` (32 random bytes base64)
- `ADMIN_PASSWORD_HASH` (PBKDF2 format: `iterations.saltHex.hashHex`)

## Cloudflare Pages deployment

```bash
cd worker
npx wrangler pages deploy ../Landing --project-name atayi-sensei --branch main
```

The page is live at `https://atayi-sensei.pages.dev/`.

## Code style & conventions

### Variable and method naming

- Be as clear and specific as possible
- **Optimize for clarity over concision.** A developer with zero context should understand what a variable or method does from its name alone
- Use longer names when it improves clarity. Do NOT use single-character variable names
- When passing props or arguments, keep the same names — do not shorten or abbreviate

### Code clarity

- **Clear is better than clever.** Do not write functionality in fewer lines if it makes the code harder to understand
- Comments explain "why" not "what", especially for non-obvious AppKit bridging or worker edge cases

### Swift / SwiftUI

- Use SwiftUI unless a feature is only supported in AppKit (e.g., `NSPanel` for floating windows)
- All UI state updates must be on `@MainActor`
- Use async/await for all asynchronous operations
- AppKit `NSPanel` / `NSWindow` bridged into SwiftUI via `NSHostingView`
- All buttons must show a pointer cursor on hover

### TypeScript (Worker)

- No external npm dependencies beyond `@cloudflare/workers-types` — everything via fetch() and Web Crypto
- No classes outside of Durable Objects — prefer pure functions
- All responses go through `jsonResponse` / `errorResponse` for consistent CORS and error shapes

### Do NOT

- Do not add features, refactor code, or make "improvements" beyond what was asked
- Do not add docstrings, comments, or type annotations to code you did not change
- Do not try to fix the known non-blocking Swift 6 warnings
- Do not rename the project directory or scheme (the "leanring" typo is intentional/legacy — renaming breaks DerivedData and the Xcode file system synchronized groups)
- Do not run `xcodebuild` from the terminal during dev
- Do not expose the Supabase service_role key anywhere client-side
- Do not ship any API key in the Swift binary — everything goes through the Worker

## Git workflow

- Branch naming: `feature/description` or `fix/description`
- Commit messages: imperative mood, concise, explain the "why"
- Do not force-push to main

## Self-update instructions

<!-- AI agents: follow these instructions to keep this file accurate. -->

When you make changes that affect the information in this file, update it:

1. **New files**: Add to the appropriate "Key files" table with purpose and approximate line count
2. **Deleted files**: Remove the entry
3. **Architecture changes**: Update the Architecture section
4. **New Worker routes**: Add to the routes table
5. **Schema changes**: Update the Supabase schema section
6. **New conventions**: Add to the Code style section

Do NOT update for minor edits, bug fixes, or changes that don't affect documented architecture or conventions.
