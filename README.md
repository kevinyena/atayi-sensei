# Atayi Sensei

An AI teacher that lives next to your cursor. Press a hotkey, talk to it, and it sees your screen, replies with its voice, and can point at things on any of your monitors.

Runs entirely in your macOS menu bar — no dock icon, no main window. The voice session is a persistent **Gemini Live** WebSocket that handles voice activity detection, vision, reasoning, speech-to-text, and audio output natively in a single model.

This project is a fork of [farzaa/clicky](https://github.com/farzaa/clicky), rewritten around Gemini Live. All the legacy Anthropic / AssemblyAI / ElevenLabs / OpenAI code paths have been removed — only the Gemini Live runtime remains.

## What it does

- **Push-to-talk**: press `ctrl + option` once to open a live voice session, press again to close it.
- **Sees your screen**: screenshots are streamed to Gemini Live on demand so the model can talk about what you're actually looking at.
- **Speaks back**: Gemini Live generates audio responses natively — no external TTS.
- **Points at things**: the model can call `annotate_element(x, y, width, height, shape, label, screen_index)` to draw circles, rectangles, underlines, highlights, or arrows on any connected monitor. The overlay fades out as soon as your cursor approaches the annotation.

## Architecture overview

- **App type**: menu bar only (`LSUIElement = true`), no dock icon, no main window.
- **Framework**: SwiftUI with AppKit bridging for the menu bar panel and the full-screen cursor overlay.
- **Voice**: single persistent Gemini Live WebSocket. The Swift client fetches the Gemini API key from a Cloudflare Worker endpoint at session open, then opens the WebSocket directly.
- **Screen capture**: ScreenCaptureKit (macOS 14.2+), multi-monitor support.
- **Push-to-talk**: a listen-only `CGEvent` tap captures `ctrl + option` system-wide, even when the app is not focused.
- **Analytics**: PostHog.

### API proxy (Cloudflare Worker)

The Gemini API key never ships in the app binary. A tiny Cloudflare Worker (`worker/src/index.ts`) holds it as a secret and hands it to the Swift client at session start.

| Route | Purpose |
|---|---|
| `POST /gemini-live-token` | Returns the Gemini API key so the Swift client can open a Gemini Live WebSocket directly |

Worker secret: `GEMINI_API_KEY`

For the full technical breakdown (state machine, overlay rendering, multi-monitor coordinate mapping, etc.), read [`AGENTS.md`](./AGENTS.md).

## Prerequisites

- macOS 14.2 or later (required for ScreenCaptureKit)
- Xcode 16 or later (the project uses `PBXFileSystemSynchronizedRootGroup`)
- Node.js 18 or later (for the Cloudflare Worker)
- A [Cloudflare](https://cloudflare.com) account (free tier works)
- A [Google AI Studio](https://aistudio.google.com/apikey) API key with Gemini Live access

## Setup

### 1. Deploy the Cloudflare Worker

The Worker is a ~50-line proxy that holds your Gemini API key as a Cloudflare secret and returns it to the Swift client at session open.

```bash
cd worker
npm install

# Paste your Gemini API key when prompted
npx wrangler secret put GEMINI_API_KEY

# Deploy
npx wrangler deploy
```

Wrangler will print the deployed URL, something like `https://<your-worker-name>.<your-subdomain>.workers.dev`. Copy it.

#### Local development (optional)

If you want to iterate on the Worker without redeploying each time:

```bash
cd worker
echo 'GEMINI_API_KEY=<your-key>' > .dev.vars
npx wrangler dev
```

This starts a local server at `http://localhost:8787` that behaves like the deployed Worker. Point the Swift client at it while developing (see step 2).

### 2. Point the app at your Worker

Open `leanring-buddy/CompanionManager.swift` and update the Worker URL:

```swift
private static let workerBaseURL = "https://<your-worker-name>.<your-subdomain>.workers.dev"
```

(The current value is hardcoded to the author's own Worker. There's no config file — just this one line.)

### 3. Build in Xcode

```bash
open leanring-buddy.xcodeproj
```

In Xcode:
1. Select the `leanring-buddy` scheme (the "leanring" typo is legacy and intentional — renaming it breaks derived data and the Sparkle update signing flow).
2. Set your signing team under **Signing & Capabilities**.
3. Hit **Cmd + R** to build and run.

The app shows up in your menu bar. Click the icon to open the panel and grant the permissions it requests.

> ⚠️ Do **not** run `xcodebuild` from the terminal — it invalidates TCC (Transparency, Consent, Control) permissions and the app will lose screen recording, accessibility, and microphone access until you re-grant them manually.

### 4. Grant the permissions

The app asks for four things on first launch:

- **Microphone** — for voice capture into the Gemini Live session.
- **Accessibility** — for the global `ctrl + option` keyboard shortcut.
- **Screen Recording** — for taking screenshots to send to Gemini.
- **Screen Content** — for ScreenCaptureKit multi-monitor capture.

## Project structure

```
app/
├── leanring-buddy/              # Swift sources (15 files)
│   ├── leanring_buddyApp.swift     # Menu bar app entry point
│   ├── CompanionManager.swift      # Central state machine
│   ├── GeminiLiveSession.swift     # Gemini Live WebSocket session
│   ├── MenuBarPanelManager.swift   # NSStatusItem + floating NSPanel
│   ├── CompanionPanelView.swift    # SwiftUI panel content
│   ├── OverlayWindow.swift         # Full-screen transparent cursor overlay
│   ├── CompanionResponseOverlay.swift
│   ├── CompanionScreenCaptureUtility.swift
│   ├── BuddyAudioConversionSupport.swift  # PCM16 mic audio converter
│   ├── BuddyPushToTalkShortcut.swift      # ctrl+option detection
│   ├── GlobalPushToTalkShortcutMonitor.swift
│   ├── ElementLocationDetector.swift
│   ├── DesignSystem.swift
│   ├── ClickyAnalytics.swift
│   ├── WindowPositionManager.swift
│   └── AppBundleConfiguration.swift
├── leanring-buddy.xcodeproj/    # Xcode 16+ (PBXFileSystemSynchronizedRootGroup)
├── worker/                      # Cloudflare Worker proxy
│   └── src/index.ts                # One route: /gemini-live-token
├── scripts/                     # Release automation (release.sh)
├── AGENTS.md                    # Full architecture doc for AI agents
└── CLAUDE.md                    # → symlink to AGENTS.md
```

## Contributing

PRs welcome. If you use an AI coding agent (Claude Code, Cursor, Copilot, etc.), they can read [`AGENTS.md`](./AGENTS.md) for the full architecture — it's the single source of truth and is kept in sync with the code.

## Credits

Forked from [Clicky](https://github.com/farzaa/clicky) by [@FarzaTV](https://x.com/FarzaTV). The original project used Claude + AssemblyAI + ElevenLabs; this fork replaces the entire voice stack with Gemini Live and strips out the unused code paths.
