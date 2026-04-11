# Atayi Sensei

An AI teacher that lives next to your cursor. Press `ctrl + option`, talk to it, and it sees your screen, replies with its voice, and can point at UI elements across any of your monitors.

Runs entirely in the macOS menu bar — no dock icon, no main window. The voice session is a persistent **Gemini Live** WebSocket, but the Gemini API key never ships with the app: all calls are proxied through a Cloudflare Worker backed by a per-device JWT and a Durable Object that relays frames in both directions while counting tokens for billing.

This project is a fork of [farzaa/clicky](https://github.com/farzaa/clicky), rewritten as a full SaaS product with Stripe subscriptions, a Supabase-backed license system, and an admin dashboard.

## Architecture at a glance

```
┌──────────────────────┐                 ┌─────────────────────┐               ┌──────────────────┐
│  macOS app           │                 │  Cloudflare Worker  │               │  Supabase        │
│  (Swift / SwiftUI)   │  Bearer token   │  clicky-proxy       │  service_role │  Postgres + RLS  │
│                      │◄──────────────► │  + Durable Object   │◄─────────────►│                  │
│  LicenseManager      │  HTTPS / WS     │  GeminiSessionDO    │               │  users / subs /  │
│  ProxySession        │                 │                     │               │  devices / etc.  │
└──────────────────────┘                 └──────────┬──────────┘               └──────────────────┘
                                                    │
                                                    │ upstream WS
                                                    ▼
                                         ┌────────────────────┐
                                         │  Gemini Live API   │
                                         │  (Google)          │
                                         └────────────────────┘

┌──────────────────────┐                 ┌─────────────────────┐
│  Landing page        │                 │  Stripe             │
│  atayi-sensei        │◄──────────────► │  Checkout + webhook │
│  .pages.dev          │  Checkout URL   │  subscriptions      │
│  (static HTML+JS)    │                 │                     │
└──────────────────────┘                 └─────────────────────┘
```

### How a voice session works end-to-end

1. User presses `ctrl + option` in the macOS app.
2. `CompanionManager` calls `LicenseManager.shared.preflightSession()` which `POST /api/session/preflight` on the Worker with a Bearer device JWT.
3. Worker validates the JWT, checks the subscription status / monthly credits / daily cap, creates a `sessions` row in Supabase, and returns a short-lived session token + a `wss://` URL pointing at a Durable Object instance.
4. The Swift app opens a WebSocket to the Durable Object.
5. The Durable Object opens an upstream WebSocket to Gemini Live **on the server**, using the secret `GEMINI_API_KEY` stored in Cloudflare. The key never reaches the client.
6. Frames are relayed in both directions transparently. Every 30 seconds, the DO counts audio tokens → credits and flushes to Supabase via RPC functions.
7. When the user presses `ctrl + option` again to stop, both sockets are closed, the session row is finalized with the total credit usage.
8. If the user blows through their monthly allowance or the trial daily cap mid-session, the DO sends an `atayiServerEvent.blocked` frame to the client and closes the session. The Swift UI picks this up and shows a user-facing error.

### Plans and credits

1 credit = 1 second of talk time (user or AI audio, whichever direction). Derived from Gemini Live pricing — ~$0.013 per minute of conversation at $3/M input tokens + $12/M output tokens with a 40/60 user/AI split.

| Plan | Price / month | Credits / month | Hours of talk | Devices |
|---|---|---|---|---|
| **Trial** | free | 1 800 / day (30 min), 7 days max | ~3.5 h | 1 Mac |
| **Starter** | $19 | 40 000 | ~11 h | 1 Mac |
| **Ultra** | $49 | 160 000 | ~44 h | up to 3 Macs (shared quota) |

When the user hits their cap, the worker's session preflight returns `403 credits_exhausted` and the app surfaces an "Upgrade your plan" message in the panel. The cap auto-resets on `invoice.paid` webhook events.

## Repository layout

```
app/
├── leanring-buddy/               # Swift sources (16 files)
│   ├── leanring_buddyApp.swift     # Menu bar app entry point + LicenseManager hydration
│   ├── CompanionManager.swift      # State machine, preflight → WebSocket pipeline
│   ├── GeminiLiveSession.swift     # Proxied WebSocket to the Worker Durable Object
│   ├── LicenseManager.swift        # Activate / status / preflight calls + Keychain
│   ├── LicenseActivationView.swift # Panel view: paste license code gate
│   ├── SubscriptionStatusView.swift# Panel view: plan / credits / manage
│   ├── DeviceFingerprint.swift     # IOPlatformUUID → SHA256 fingerprint
│   ├── KeychainHelper.swift        # Store JWT device token securely
│   ├── BuddyPushToTalkShortcut.swift   # ctrl+option shortcut detection
│   ├── GlobalPushToTalkShortcutMonitor.swift  # CGEventTap for global shortcut
│   ├── BuddyAudioConversionSupport.swift      # PCM16 mic conversion
│   ├── CompanionPanelView.swift    # Menu bar dropdown UI
│   ├── MenuBarPanelManager.swift   # NSStatusItem + NSPanel lifecycle
│   ├── OverlayWindow.swift         # Full-screen transparent cursor overlay
│   ├── CompanionResponseOverlay.swift
│   ├── CompanionScreenCaptureUtility.swift
│   ├── ElementLocationDetector.swift
│   ├── DesignSystem.swift
│   ├── ClickyAnalytics.swift       # PostHog
│   ├── WindowPositionManager.swift
│   └── AppBundleConfiguration.swift
│
├── leanring-buddy.xcodeproj/     # Xcode 16+ project
│
├── worker/                       # Cloudflare Worker backend
│   ├── src/
│   │   ├── index.ts                # Router + cron scheduled() handler
│   │   ├── types.ts                # Env + DB types + Plan limits
│   │   ├── db/supabase.ts          # Typed PostgREST client
│   │   ├── auth/jwt.ts             # HS256 sign/verify via Web Crypto
│   │   ├── auth/password.ts        # PBKDF2 password hash/verify
│   │   ├── lib/response.ts         # JSON/CORS helpers
│   │   ├── lib/credit-accounting.ts# Token → credit conversion
│   │   ├── lib/license-code.ts     # ATAYI-<TYPE>-XXXX code generator
│   │   ├── lib/stripe-helpers.ts   # Stripe REST client + webhook verify
│   │   ├── routes/trial.ts         # POST /api/auth/trial-signup
│   │   ├── routes/license.ts       # /api/license/activate, /status
│   │   ├── routes/billing.ts       # Stripe checkout, webhook, session lookup
│   │   ├── routes/session.ts       # POST /api/session/preflight
│   │   ├── routes/landing.ts       # /api/landing/event + cron refresh
│   │   └── routes/admin.ts         # /api/admin/* (JWT-protected)
│   ├── wrangler.toml               # DO binding + cron + compat flags
│   ├── tsconfig.json
│   └── package.json
│
├── Landing/                      # Static landing page + admin dashboard
│   ├── index.html                  # Hero + download button + i18n (5 langs)
│   ├── trial.html                  # Email → trial signup → display code
│   ├── checkout-success.html       # Stripe redirect: retrieve + display code
│   ├── checkout-cancel.html        # "Payment cancelled" page
│   ├── account.html                # Subscription management placeholder
│   ├── admin-login.html            # Admin password gate
│   ├── admin.html                  # Dashboard (stats / users / devices)
│   ├── privacy.html
│   ├── js/api.js                   # Fetch wrapper around /api/*
│   ├── js/main.js                  # Plan chooser modal + download wiring
│   ├── js/admin.js                 # Admin dashboard logic
│   └── js/shared-styles.js         # Injected CSS for the signup pages
│
├── infra/
│   └── supabase/
│       └── schema.sql              # Full Postgres schema (idempotent)
│
├── scripts/
│   ├── release.sh                  # macOS archive → DMG (unsigned or signed)
│   └── README.md
│
├── AGENTS.md                     # Single source of truth for AI agents
├── CLAUDE.md                     # → symlink to AGENTS.md
├── README.md                     # this file
└── LICENSE                       # MIT (upstream Clicky, kept in the fork)
```

## Prerequisites

- macOS 14.2+ (required for ScreenCaptureKit)
- Xcode 16+ (uses `PBXFileSystemSynchronizedRootGroup`)
- Node.js 18+ for the Worker
- A Cloudflare account
- A Supabase account (free tier is fine)
- A Stripe account
- A Google AI Studio API key with Gemini Live access
- **Optional but strongly recommended for distribution:** an Apple Developer Program membership ($99/year) for Developer ID signing + notarization. Without it, users who download the DMG will have to right-click → Open the first time to bypass Gatekeeper.

## Setup

### 1. Supabase

1. Create a new project at [supabase.com](https://supabase.com).
2. Get the service_role key and the project URL from **Settings → API**.
3. Open **SQL Editor**, paste the contents of [`infra/supabase/schema.sql`](./infra/supabase/schema.sql), and click **Run**.

### 2. Stripe

1. Create your two subscription products (Starter and Ultra) in test mode first if you want to experiment safely.
2. Each product should have a recurring monthly price (e.g. $19 for Starter, $49 for Ultra).
3. Note the price IDs — update them in `worker/src/lib/stripe-helpers.ts` → `STRIPE_PRICE_IDS` if they differ from the hardcoded ones.
4. Get your Stripe secret key from **Developers → API keys**.

### 3. Cloudflare Worker

```bash
cd worker
npm install
```

Push all the secrets (wrangler will prompt for each value):

```bash
npx wrangler secret put GEMINI_API_KEY            # from Google AI Studio
npx wrangler secret put SUPABASE_URL              # https://<ref>.supabase.co
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY # sb_secret_... from Supabase
npx wrangler secret put STRIPE_SECRET_KEY         # sk_live_... or sk_test_...
npx wrangler secret put STRIPE_WEBHOOK_SECRET     # see step 4 below
npx wrangler secret put JWT_SIGNING_SECRET        # 32 random bytes base64
npx wrangler secret put ADMIN_PASSWORD_HASH       # see step 5 below
```

Deploy:

```bash
npx wrangler deploy
```

### 4. Stripe webhook

Once the Worker is deployed, create the webhook endpoint in Stripe pointing at `https://<your-worker>/api/billing/webhook` with these events:

- `checkout.session.completed`
- `invoice.paid`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

Copy the signing secret (starts with `whsec_`) and run `wrangler secret put STRIPE_WEBHOOK_SECRET`. Redeploy the worker.

### 5. Admin password

Generate a PBKDF2 hash of the admin password you want to use and push it as `ADMIN_PASSWORD_HASH`:

```bash
node -e "
const crypto = require('crypto');
const pwd = 'YOUR_ADMIN_PASSWORD';
const salt = crypto.randomBytes(32);
const hash = crypto.pbkdf2Sync(pwd, salt, 100000, 32, 'sha256');
console.log('100000.' + salt.toString('hex') + '.' + hash.toString('hex'));
"
```

Note: the iteration count is capped at 100 000 because Cloudflare Workers' Web Crypto enforces that limit.

### 6. Landing page (Cloudflare Pages)

```bash
cd worker  # any folder with wrangler installed
npx wrangler pages project create atayi-sensei --production-branch main
npx wrangler pages deploy ../Landing --project-name atayi-sensei --branch main
```

The page is live at `https://atayi-sensei.pages.dev/` (or your custom domain once you bind one).

### 7. macOS app

1. Open `leanring-buddy.xcodeproj` in Xcode.
2. Select the `leanring-buddy` scheme.
3. Set your signing team in **Signing & Capabilities**.
4. Update the Worker URL in `CompanionManager.swift` if you're not using `clicky-proxy.kevinyena9.workers.dev`.
5. Hit **Cmd + R** to build and run.

> ⚠️ Never run `xcodebuild` from the terminal during development — it can invalidate your TCC (screen recording, accessibility, mic) grants and force you to re-approve them. For **distribution builds** only, use `./scripts/release.sh`.

## Building a DMG for distribution

```bash
./scripts/release.sh           # unsigned / ad-hoc mode (first pass, no Apple Developer needed)
./scripts/release.sh developer-id  # full Developer ID signing + notarization
```

The script archives the app, exports it, and wraps it in a DMG using `create-dmg`. Output is written to `./releases/Atayi-Sensei-<version>.dmg`.

**Unsigned DMG limitations:**
- It runs fine on your own Mac and on any tester's Mac that does right-click → Open the first time.
- Gatekeeper will say "cannot be opened because it is from an unidentified developer" on double-click.
- Sparkle auto-update won't work (requires a Developer ID signature).
- **Not suitable for public release.** It's intended for internal alpha/beta testing while your Apple Developer Program enrollment is pending.

Once your enrollment completes and `Developer ID Application: <Your Name>` appears in Keychain, rerun `./scripts/release.sh developer-id`. You'll need to run `xcrun notarytool store-credentials "AC_PASSWORD"` once to configure notarization credentials.

## Admin dashboard

Available at `https://<landing-url>/admin-login.html` after deployment. Log in with the admin password (see step 5 above).

Features:
- **Stats tiles** — daily visits, downloads, checkouts, total users, active subscriptions (Starter/Ultra), trials in progress, estimated MRR.
- **Users table** — search by email, filter by plan, click a row to open a drawer with device list, recent sessions, and block/unblock actions.
- **Real-time updates** — stats and user list auto-refresh every 30 seconds; the `admin_user_stats` materialized view refreshes every 5 minutes via a Cloudflare cron trigger.

## Security model

- **Gemini API key** lives only in Cloudflare Worker secrets — never in the app binary, never in landing page JS.
- **Supabase service_role key** lives only in Cloudflare Worker secrets — the frontend and the macOS app never talk to Supabase directly.
- **Stripe secret key** lives only in Cloudflare Worker secrets.
- **Admin password** is hashed with PBKDF2-SHA256 (100k iterations) and stored as a Cloudflare secret. The worker uses constant-time comparison on login.
- **Device binding** uses an IOPlatformUUID SHA-256 hash so two Macs are never confused even after an OS reinstall.
- **License enforcement** happens at two layers: pre-session (preflight rejects if the subscription is inactive, credits exhausted, daily cap reached) and in-session (the Durable Object kills the socket mid-conversation if usage crosses the limit).
- **Per-session tokens** are short-lived (5 minutes) HS256 JWTs so a leaked token has a small blast radius.

## Contributing

PRs welcome. If you use an AI coding agent (Claude Code, Cursor, Copilot, etc.), point it at [`AGENTS.md`](./AGENTS.md) — the full architecture and conventions live there and are kept in sync with the code.

## Credits

Forked from [Clicky](https://github.com/farzaa/clicky) by [@FarzaTV](https://x.com/FarzaTV). The original project used Claude + AssemblyAI + ElevenLabs; this fork replaces the entire voice stack with Gemini Live proxied through a Cloudflare Worker, adds the SaaS layer (licenses, subscriptions, admin), and distributes as its own signed DMG.
