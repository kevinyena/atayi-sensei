# Atayi Sensei Windows Port — Complete Technical Specification

> This document is a self-contained, one-shot specification for building a Windows `.exe` that works with the existing Atayi Sensei backend (Cloudflare Workers, Durable Objects, Supabase, Stripe, Gemini Live). The backend requires **zero changes**. This spec covers everything: architecture, API contracts, audio pipeline, UI, permissions, error handling, and testing.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Project Structure](#2-project-structure)
3. [App Lifecycle & System Tray](#3-app-lifecycle--system-tray)
4. [Device Fingerprinting](#4-device-fingerprinting)
5. [Secure Storage (DPAPI)](#5-secure-storage-dpapi)
6. [License Activation & Status](#6-license-activation--status)
7. [Session Preflight & WebSocket](#7-session-preflight--websocket)
8. [Gemini Live Protocol](#8-gemini-live-protocol)
9. [Audio Pipeline](#9-audio-pipeline)
10. [Screen Capture](#10-screen-capture)
11. [Global Hotkey (Ctrl+Alt)](#11-global-hotkey-ctrlalt)
12. [Cursor Overlay & HUD](#12-cursor-overlay--hud)
13. [UI Panels & Views](#13-ui-panels--views)
14. [Onboarding Flow](#14-onboarding-flow)
15. [Credit Accounting & Blocking](#15-credit-accounting--blocking)
16. [Multi-Language Support](#16-multi-language-support)
17. [Error Handling](#17-error-handling)
18. [Permissions](#18-permissions)
19. [Design System](#19-design-system)
20. [macOS vs Windows Differences](#20-macos-vs-windows-differences)
21. [Implementation Phases](#21-implementation-phases)
22. [Testing Checklist](#22-testing-checklist)

---

## 1. Architecture Overview

### High-Level Flow

```
Windows App (.exe)
    │
    ├─ POST /api/license/activate     ─── bind license code + device fingerprint → JWT (7-day)
    ├─ GET  /api/license/status       ─── check plan, credits, daily cap
    ├─ POST /api/session/preflight    ─── verify credits → session token (5-min) + ws_url
    │
    └─ WSS /api/session/live?session_token=...
           │
           ▼
       Cloudflare Durable Object (GeminiSessionDO)
           │
           ├── Relays frames bidirectionally ──► Gemini Live API (wss://generativelanguage.googleapis.com)
           ├── Counts tokens every 30s
           ├── Flushes to Supabase (subscriptions.credits_used_this_period, daily_usage, sessions)
           └── Sends "blocked" frame + closes if credits exhausted
```

### What the Windows app does NOT do

- **Never calls Google/Gemini APIs directly.** All Gemini traffic goes through the Worker Durable Object.
- **Never stores API keys.** The Gemini key, Supabase service_role key, and Stripe key live only in Cloudflare Worker secrets.
- **Never talks to Supabase directly.** The Worker is the only PostgREST client.
- **Never handles Stripe payments.** Billing is managed via the landing page (atayisensei.com).

### What the Windows app DOES do

1. Stores a **device token** (JWT, 7-day TTL) in encrypted local storage (DPAPI).
2. Calls 3 REST endpoints on the Worker: `/api/license/activate`, `/api/license/status`, `/api/session/preflight`.
3. Opens a **WebSocket** to the Worker Durable Object and relays audio/video frames to Gemini Live.
4. Captures **microphone audio** (PCM16 mono 16 kHz), sends it as base64 over the WebSocket.
5. Receives **audio responses** (PCM16 mono 24 kHz) from Gemini, plays them through speakers.
6. Captures **screenshots** (JPEG, max 1280px) from all monitors, sends them over the WebSocket.
7. Draws a **cursor overlay** (transparent topmost window) with a waveform HUD and response text.
8. Listens for a **global hotkey** (Ctrl+Alt) to start/stop voice sessions.

### Backend Base URL

```
https://clicky-proxy.kevinyena9.workers.dev
```

All REST calls and WebSocket connections go to this URL. CORS is configured to accept any origin.

---

## 2. Project Structure

Recommended stack: **C# / WPF** (or WinUI 3 for modern Windows 11 look). NAudio for audio.

```
AtayiSensei.Windows/
├── App.xaml.cs                              // Entry point, system tray init, CompanionManager creation
├── Core/
│   ├── CompanionManager.cs                  // Central state machine (voice states, session lifecycle)
│   ├── LicenseManager.cs                    // License activation, status refresh, token caching
│   ├── GeminiLiveSession.cs                 // WebSocket client to Durable Object
│   ├── GlobalHotkeyMonitor.cs               // Ctrl+Alt system-wide listener
│   ├── AudioCaptureManager.cs               // Mic input: WASAPI → PCM16 16kHz
│   ├── AudioPlaybackManager.cs              // Speaker output: PCM16 24kHz → WASAPI
│   └── ScreenCaptureManager.cs              // DXGI multi-monitor → JPEG
├── Storage/
│   ├── SecureStorage.cs                     // DPAPI wrapper (device token persistence)
│   └── DeviceFingerprint.cs                 // Hardware ID → SHA-256 hash
├── UI/
│   ├── SystemTrayManager.cs                 // NotifyIcon + context menu
│   ├── TrayPanelWindow.xaml(.cs)            // Drop-down panel (license activation + status)
│   ├── OverlayWindow.xaml(.cs)              // Full-screen transparent cursor overlay
│   ├── WaveformControl.xaml(.cs)            // Animated waveform bars
│   ├── ResponseBubble.xaml(.cs)             // Cursor-following response text
│   ├── LicenseActivationView.xaml(.cs)      // License code entry form
│   └── SubscriptionStatusView.xaml(.cs)     // Credits bar + plan badge
├── Models/
│   ├── VoiceState.cs                        // Enum: Idle, Listening, Processing, Responding
│   ├── LicenseState.cs                      // Enum: NotActivated, Active, Expired, Blocked, Error
│   ├── SessionPreflightResult.cs            // ws_url, session_token, credits_remaining, etc.
│   ├── SenseiLanguage.cs                    // Enum: English, French, Spanish, Chinese, Arabic
│   └── ScreenCapture.cs                     // JPEG bytes + display metadata
└── Resources/
    ├── sensei-logo.png                      // HUD logo (75x75)
    ├── tray-icon.ico                        // System tray icon
    └── Strings/                             // Localized strings per language
```

---

## 3. App Lifecycle & System Tray

### App Type

- **No main window.** The app lives in the system tray (notification area).
- On Windows, this means creating a `NotifyIcon` with a context menu and a custom popup panel.
- The app should start on login (optional, configurable in settings). Use `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` registry key.

### Startup Sequence

```
1. App.xaml.cs: Application.Startup
2. Create NotifyIcon (system tray)
3. Create CompanionManager (state machine)
4. LicenseManager.hydrateFromCache()
   └─ Read device token from DPAPI-encrypted storage
   └─ If token exists and not expired: set state = Active
   └─ If token exists but expired: call GET /api/license/status to refresh
   └─ If no token: set state = NotActivated
5. If state == Active: show "Ready" in tray tooltip
6. If state == NotActivated: show tray panel with license activation form
7. Start GlobalHotkeyMonitor (Ctrl+Alt listener)
```

### System Tray Behavior

- **Left-click** on tray icon: toggle tray panel (open/close)
- **Right-click** on tray icon: context menu with "Open Panel", "Quit"
- **Tray panel**: borderless window positioned above the tray icon, auto-dismiss on click outside
- **Panel size**: 320px wide, dynamic height (up to ~400px)

### Shutdown

- On `Application.Exit`: stop GlobalHotkeyMonitor, disconnect any active WebSocket, dispose audio devices.

---

## 4. Device Fingerprinting

The backend binds a license code to a device using a SHA-256 hash of a hardware identifier. This prevents the same license from being used on more devices than the plan allows.

### Windows Implementation

```csharp
using System.Management;
using System.Security.Cryptography;
using System.Text;

public static class DeviceFingerprint
{
    /// <summary>
    /// Returns a 64-character hex SHA-256 hash of the machine's hardware ID.
    /// This value is stable across reboots and app reinstalls.
    /// </summary>
    public static string GetFingerprint()
    {
        // Option A: MachineGuid from registry (simplest, stable, unique per Windows install)
        string machineGuid = Microsoft.Win32.Registry.GetValue(
            @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography",
            "MachineGuid",
            ""
        )?.ToString() ?? "";

        // Hash it
        using var sha256 = SHA256.Create();
        byte[] hashBytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(machineGuid));
        return BitConverter.ToString(hashBytes).Replace("-", "").ToLower();
    }

    /// <summary>
    /// Human-readable device name shown in the admin dashboard.
    /// Example: "DESKTOP-36MNBDM"
    /// </summary>
    public static string GetDeviceName()
    {
        return Environment.MachineName;
    }

    /// <summary>
    /// OS version string. Example: "Windows 11 (Build 22631)"
    /// </summary>
    public static string GetOSVersion()
    {
        var os = Environment.OSVersion;
        return $"Windows {os.Version.Major} (Build {os.Version.Build})";
    }

    /// <summary>
    /// App version from assembly. Example: "1.0.0"
    /// </summary>
    public static string GetAppVersion()
    {
        return System.Reflection.Assembly.GetExecutingAssembly()
            .GetName().Version?.ToString(3) ?? "1.0.0";
    }
}
```

### What gets sent to the server

```json
{
    "device_fingerprint": "a1b2c3d4e5f6789...64 hex chars...",
    "device_name": "DESKTOP-36MNBDM",
    "os_version": "Windows 11 (Build 22631)",
    "app_version": "1.0.0"
}
```

---

## 5. Secure Storage (DPAPI)

The macOS app stores the device JWT in Keychain with `.whenUnlockedThisDeviceOnly` access control. On Windows, use DPAPI (Data Protection API) which provides equivalent per-user encryption.

```csharp
using System.Security.Cryptography;
using System.Text;
using System.IO;

public static class SecureStorage
{
    private static string StoragePath =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "AtayiSensei",
            "credentials.dat"
        );

    public static void SaveDeviceToken(string jwt)
    {
        byte[] plainBytes = Encoding.UTF8.GetBytes(jwt);
        byte[] encrypted = ProtectedData.Protect(
            plainBytes,
            null,                              // optional entropy (additional secret)
            DataProtectionScope.CurrentUser     // tied to Windows user login
        );
        Directory.CreateDirectory(Path.GetDirectoryName(StoragePath)!);
        File.WriteAllBytes(StoragePath, encrypted);
    }

    public static string? ReadDeviceToken()
    {
        if (!File.Exists(StoragePath)) return null;
        try
        {
            byte[] encrypted = File.ReadAllBytes(StoragePath);
            byte[] decrypted = ProtectedData.Unprotect(
                encrypted,
                null,
                DataProtectionScope.CurrentUser
            );
            return Encoding.UTF8.GetString(decrypted);
        }
        catch
        {
            return null; // corrupted or wrong user
        }
    }

    public static void DeleteDeviceToken()
    {
        if (File.Exists(StoragePath)) File.Delete(StoragePath);
    }
}
```

---

## 6. License Activation & Status

### 6.1 Activation Flow

User pastes a license code (format: `ATAYI-XXXX-XXXX-XXXX-XXXX`) in the tray panel. The app calls:

```
POST https://clicky-proxy.kevinyena9.workers.dev/api/license/activate
Content-Type: application/json

{
    "license_code": "ATAYI-TR-ABCD-EFGH-IJKL",
    "device_fingerprint": "a1b2c3d4...",
    "device_name": "DESKTOP-36MNBDM",
    "os_version": "Windows 11 (Build 22631)",
    "app_version": "1.0.0"
}
```

**Success response (200):**

```json
{
    "device_token": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI1NTBlODQwMC4uLiIsImRldmljZV9pZCI6Ii4uLiIsInBsYW4iOiJ0cmlhbCIsInN1YnNjcmlwdGlvbl9pZCI6Ii4uLiIsImlhdCI6MTcxODAwMDAwMCwiZXhwIjoxNzE4NjA0ODAwfQ.xxx",
    "plan": "trial",
    "credits_used": 0,
    "credits_allowance": 6300,
    "max_devices": 1,
    "active_devices": 1,
    "current_period_end": "2026-04-20T00:00:00Z",
    "reactivation": false
}
```

**On success:**
1. Store `device_token` in DPAPI-encrypted storage
2. Update `LicenseState` to `Active(plan, creditsUsed, creditsAllowance, ...)`
3. Update UI: hide activation form, show status chip

**Error responses:**

| Status | Error Code | Meaning | User Message |
|--------|-----------|---------|--------------|
| 400 | `invalid_code_format` | Code doesn't match `ATAYI-XX-XXXX-XXXX-XXXX` pattern | "Invalid code format." |
| 404 | `license_not_found` | Code not in database or revoked | "License code not found. Check and try again." |
| 403 | `subscription_inactive` | Subscription canceled/expired | "Subscription inactive. Renew at atayisensei.com." |
| 403 | `device_limit_reached` | Already activated on max devices | "License already active on the maximum number of devices." |
| 403 | `device_blocked` | Admin blocked this device | "This device has been blocked." |
| 403 | `account_blocked` | Admin blocked the account | "Account blocked. Contact support." |
| 500 | `internal_error` | Server error | "Server error. Try again in a moment." |

### 6.2 License Code Normalization

Before sending, normalize the code:
- Trim whitespace
- Uppercase
- Remove extra dashes/spaces
- Validate format: `ATAYI-XX-XXXX-XXXX-XXXX` where X is alphanumeric

```csharp
public static string NormalizeLicenseCode(string raw)
{
    string cleaned = raw.Trim().ToUpper().Replace(" ", "");
    // Remove all dashes, then re-insert at correct positions
    string digits = cleaned.Replace("-", "");
    // Expected: ATAYIXXXXXXXXXX (5 + 2 + 4 + 4 + 4 = 19 chars without dashes)
    // Reformat: ATAYI-XX-XXXX-XXXX-XXXX
    if (digits.Length >= 19 && digits.StartsWith("ATAYI"))
    {
        return $"{digits[..5]}-{digits[5..7]}-{digits[7..11]}-{digits[11..15]}-{digits[15..19]}";
    }
    return cleaned; // return as-is, server will validate
}
```

### 6.3 Status Refresh

Periodically (every 60 seconds while app is running, and on every app startup):

```
GET https://clicky-proxy.kevinyena9.workers.dev/api/license/status
Authorization: Bearer <device_token>
```

**Success response (200):**

```json
{
    "plan": "starter",
    "status": "active",
    "credits_used": 8500,
    "credits_allowance": 40000,
    "daily_used": 0,
    "daily_cap": null,
    "max_devices": 1
}
```

**On 401 (token expired/invalid):** clear cached token, set state to `NotActivated`.

### 6.4 Device Token JWT Structure

The device token is an HS256 JWT signed by the Worker's `JWT_SIGNING_SECRET`. The app does NOT verify the signature (it doesn't have the secret). It only reads the payload to extract display info.

```json
{
    "sub": "550e8400-e29b-41d4-a716-446655440000",
    "device_id": "660e8400-e29b-41d4-a716-446655440001",
    "plan": "trial",
    "subscription_id": "770e8400-e29b-41d4-a716-446655440002",
    "iat": 1718000000,
    "exp": 1718604800
}
```

**TTL:** 7 days. After expiry, the app must re-activate (call `/api/license/activate` again with the same license code and fingerprint — this is a "reactivation", not a new activation).

---

## 7. Session Preflight & WebSocket

### 7.1 Preflight

Before every voice session, call preflight to get a short-lived session token:

```
POST https://clicky-proxy.kevinyena9.workers.dev/api/session/preflight
Authorization: Bearer <device_token>
Content-Type: application/json

{}
```

**Success response (200):**

```json
{
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "ws_url": "wss://clicky-proxy.kevinyena9.workers.dev/api/session/live?session_token=eyJhbGc...",
    "session_token": "eyJhbGciOiJIUzI1NiJ9...",
    "credits_remaining": 5100,
    "daily_remaining": 900,
    "plan": "trial"
}
```

**Error responses:**

| Status | Error Code | Meaning |
|--------|-----------|---------|
| 401 | `unauthorized` | Device token invalid/expired |
| 403 | `credits_exhausted` | Monthly allowance used up |
| 403 | `daily_cap_reached` | Trial daily limit hit |
| 403 | `subscription_inactive` | Subscription not active |
| 403 | `device_blocked` | Device blocked by admin |

### 7.2 WebSocket Connection

Open a WebSocket to the `ws_url` returned by preflight. The session token is in the URL query parameter (not as a header).

```csharp
using System.Net.WebSockets;

var ws = new ClientWebSocket();
// No auth header needed — token is in the URL
await ws.ConnectAsync(new Uri(preflightResult.WsUrl), CancellationToken.None);
```

**Connection lifecycle:**

```
1. Connect to ws_url
2. Send setup message (JSON) — configures Gemini model, voice, system prompt
3. Wait for { "setupComplete": {} } frame
4. Start mic capture → send audio frames
5. Start screenshot capture → send video frames (1 per second)
6. Receive audio response frames → play through speaker
7. If blocked frame received → show error, stop session
8. On Ctrl+Alt release → send close frame, disconnect
```

---

## 8. Gemini Live Protocol

### 8.1 Setup Message (first frame sent after connection)

```json
{
    "setup": {
        "model": "models/gemini-2.0-flash-live-001",
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": {
                        "voiceName": "Charon"
                    }
                }
            }
        },
        "systemInstruction": {
            "parts": [{
                "text": "<system prompt — see Section 16 for full text per language>"
            }]
        }
    }
}
```

### 8.2 Audio Input (client → Gemini, continuous while mic is active)

```json
{
    "realtimeInput": {
        "audio": {
            "mimeType": "audio/pcm;rate=16000",
            "data": "<base64-encoded PCM16 mono 16kHz bytes>"
        }
    }
}
```

**Chunk size:** send a frame every ~100ms (1600 samples = 3200 bytes = ~4267 base64 chars).

### 8.3 Screenshot Input (client → Gemini, 1 per second)

```json
{
    "realtimeInput": {
        "video": {
            "mimeType": "image/jpeg",
            "data": "<base64-encoded JPEG, max 1280px wide>"
        }
    }
}
```

**Multi-monitor:** capture all screens, label them ("screen 1 of 2 — cursor here"), resize longest edge to 1280px, encode as JPEG quality 80%.

### 8.4 Audio Output (Gemini → client)

```json
{
    "serverContent": {
        "modelTurn": {
            "parts": [{
                "inlineData": {
                    "mimeType": "audio/pcm;rate=24000",
                    "data": "<base64-encoded PCM16 mono 24kHz bytes>"
                }
            }]
        }
    }
}
```

**Decode:** base64 → byte array → Int16 samples → float32 → queue on speaker playback buffer.

### 8.5 Setup Complete (Gemini → client)

```json
{
    "setupComplete": {}
}
```

Received after the setup message is accepted. Only after this should the app start sending audio/video.

### 8.6 Turn Complete (Gemini → client)

```json
{
    "serverContent": {
        "turnComplete": true
    }
}
```

Signals that Gemini finished its response. The app should transition from `Responding` to `Listening` state after all queued audio has played.

### 8.7 Tool Call — Element Annotation (Gemini → client)

Gemini can call a tool to highlight a UI element on screen:

```json
{
    "toolCall": {
        "functionCalls": [{
            "name": "annotate_element",
            "args": {
                "x": 450,
                "y": 320,
                "width": 120,
                "height": 40,
                "shape": "rectangle",
                "label": "This button",
                "screen_index": 0
            }
        }]
    }
}
```

**The app must:**
1. Convert screenshot-pixel coordinates to screen coordinates (accounting for DPI scaling)
2. Draw a blue glowing shape at that position on the overlay
3. Animate the cursor to point at it
4. Fade out when the real cursor approaches (within 50px)

### 8.8 Blocked Event (Durable Object → client)

```json
{
    "atayiServerEvent": {
        "type": "blocked",
        "reason": "credits_exhausted",
        "message": "Monthly credit allowance exhausted. Upgrade your plan to continue."
    }
}
```

**Possible reasons:**
- `credits_exhausted` — monthly allowance used up
- `daily_cap_reached` — trial daily limit hit (900 credits = 15 min)
- `device_blocked` — admin blocked device mid-session

**On receipt:** show error message in overlay, stop mic, close WebSocket gracefully.

---

## 9. Audio Pipeline

### 9.1 Microphone Input

**Target format:** PCM16 mono 16 kHz (required by Gemini Live)

**Recommended library:** NAudio (NuGet package `NAudio`)

```csharp
using NAudio.Wave;

public class AudioCaptureManager : IDisposable
{
    private WaveInEvent _waveIn;
    private WaveFormat _targetFormat = new WaveFormat(16000, 16, 1); // 16kHz, 16-bit, mono

    public event Action<byte[]> OnAudioChunkReady; // PCM16 bytes ready to send
    public event Action<float> OnRMSLevelChanged;  // 0.0–1.0 for waveform UI

    public void Start()
    {
        _waveIn = new WaveInEvent
        {
            WaveFormat = _targetFormat,
            BufferMilliseconds = 100 // 100ms chunks
        };
        _waveIn.DataAvailable += (sender, e) =>
        {
            // e.Buffer contains PCM16 mono 16kHz bytes
            byte[] chunk = new byte[e.BytesRecorded];
            Array.Copy(e.Buffer, chunk, e.BytesRecorded);

            // Calculate RMS for waveform
            float rms = CalculateRMS(chunk);
            OnRMSLevelChanged?.Invoke(rms);

            OnAudioChunkReady?.Invoke(chunk);
        };
        _waveIn.StartRecording();
    }

    public void Stop()
    {
        _waveIn?.StopRecording();
        _waveIn?.Dispose();
    }

    private float CalculateRMS(byte[] pcm16Bytes)
    {
        int sampleCount = pcm16Bytes.Length / 2;
        double sumOfSquares = 0;
        for (int i = 0; i < sampleCount; i++)
        {
            short sample = BitConverter.ToInt16(pcm16Bytes, i * 2);
            float normalized = sample / 32768f;
            sumOfSquares += normalized * normalized;
        }
        return (float)Math.Sqrt(sumOfSquares / sampleCount);
    }

    public void Dispose() => _waveIn?.Dispose();
}
```

**If the system mic is not at 16 kHz** (common — most Windows mics default to 48 kHz), NAudio will automatically resample when you set the `WaveFormat` to 16 kHz on `WaveInEvent`. If that doesn't work on some hardware, use `MediaFoundationResampler`:

```csharp
// Fallback: capture at native rate, then resample
_waveIn.WaveFormat = new WaveFormat(48000, 16, 1);
// ... in DataAvailable:
using var resampler = new MediaFoundationResampler(
    new RawSourceWaveStream(new MemoryStream(chunk), _waveIn.WaveFormat),
    _targetFormat
);
// Read resampled bytes from resampler
```

### 9.2 Speaker Playback

**Input format:** PCM16 mono 24 kHz (from Gemini Live responses)

```csharp
using NAudio.Wave;

public class AudioPlaybackManager : IDisposable
{
    private WaveOutEvent _waveOut;
    private BufferedWaveProvider _buffer;

    public event Action OnPlaybackFinished; // all queued audio played

    public AudioPlaybackManager()
    {
        var format = new WaveFormat(24000, 16, 1); // 24kHz, 16-bit, mono
        _buffer = new BufferedWaveProvider(format)
        {
            BufferDuration = TimeSpan.FromSeconds(30),
            DiscardOnBufferOverflow = true
        };
        _waveOut = new WaveOutEvent();
        _waveOut.Init(_buffer);
    }

    /// <summary>
    /// Queue a chunk of base64-encoded PCM16 24kHz audio for playback.
    /// Called for each serverContent.modelTurn.parts[].inlineData.data frame.
    /// </summary>
    public void QueueAudioChunk(string base64PCM16)
    {
        byte[] pcmBytes = Convert.FromBase64String(base64PCM16);
        _buffer.AddSamples(pcmBytes, 0, pcmBytes.Length);

        if (_waveOut.PlaybackState != PlaybackState.Playing)
        {
            _waveOut.Play();
        }
    }

    /// <summary>
    /// Call after receiving turnComplete from Gemini.
    /// Monitors the buffer and fires OnPlaybackFinished when drained.
    /// </summary>
    public async Task WaitForPlaybackDrain()
    {
        // Poll until buffer is empty (all audio played)
        while (_buffer.BufferedBytes > 0)
        {
            await Task.Delay(50);
        }
        // Small grace period for speaker to finish
        await Task.Delay(100);
        OnPlaybackFinished?.Invoke();
    }

    /// <summary>
    /// Immediately stop playback (user barged in).
    /// </summary>
    public void FlushAndStop()
    {
        _buffer.ClearBuffer();
        _waveOut.Stop();
    }

    public void Dispose()
    {
        _waveOut?.Dispose();
    }
}
```

### 9.3 Echo Suppression / Barge-In Gate

When Gemini is speaking (state = `Responding`), the mic picks up the speaker output. To avoid Gemini hearing itself:

```csharp
// In the audio chunk handler:
void HandleMicChunk(byte[] pcm16Chunk)
{
    float rms = CalculateRMS(pcm16Chunk);

    if (_voiceState == VoiceState.Responding)
    {
        if (rms < 0.12f)
        {
            // Below threshold: this is speaker echo, NOT user speech
            // Update waveform UI but don't send to Gemini
            UpdateWaveformUI(rms);
            return;
        }
        // Above threshold: user is barging in (speaking over AI)
        // Send to Gemini — it will handle interruption
    }

    // Send audio to WebSocket
    string base64 = Convert.ToBase64String(pcm16Chunk);
    SendAudioFrame(base64);
    UpdateWaveformUI(rms);
}
```

The threshold of **0.12** is calibrated for typical laptop/desktop speaker echo. May need tuning for different hardware.

---

## 10. Screen Capture

### 10.1 Multi-Monitor JPEG Capture

Use DXGI Desktop Duplication or `System.Drawing` for simplicity:

```csharp
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

public class ScreenCaptureManager
{
    public struct CapturedScreen
    {
        public byte[] JpegBytes;
        public string Label;        // "screen 1 of 2 — cursor here"
        public bool IsCursorScreen;
        public int ScreenIndex;
        public Rectangle Bounds;    // Virtual screen coordinates
    }

    /// <summary>
    /// Capture all screens as JPEG, cursor screen first.
    /// Returns base64-encoded JPEG for each screen.
    /// </summary>
    public List<CapturedScreen> CaptureAllScreens()
    {
        var screens = Screen.AllScreens;
        var cursorPos = Cursor.Position;
        var cursorScreen = Screen.FromPoint(cursorPos);
        var results = new List<CapturedScreen>();

        for (int i = 0; i < screens.Length; i++)
        {
            var screen = screens[i];
            bool isCursor = screen.DeviceName == cursorScreen.DeviceName;

            using var bitmap = new Bitmap(screen.Bounds.Width, screen.Bounds.Height);
            using (var g = Graphics.FromImage(bitmap))
            {
                g.CopyFromScreen(screen.Bounds.Location, Point.Empty, screen.Bounds.Size);
            }

            // Resize to max 1280px (preserve aspect ratio)
            var resized = ResizeToMax(bitmap, 1280);

            // Encode as JPEG quality 80%
            byte[] jpegBytes;
            using (var ms = new MemoryStream())
            {
                var encoder = ImageCodecInfo.GetImageEncoders()
                    .First(c => c.FormatID == ImageFormat.Jpeg.Guid);
                var encoderParams = new EncoderParameters(1);
                encoderParams.Param[0] = new EncoderParameter(
                    System.Drawing.Imaging.Encoder.Quality, 80L);
                resized.Save(ms, encoder, encoderParams);
                jpegBytes = ms.ToArray();
            }

            string label = screens.Length > 1
                ? $"screen {i + 1} of {screens.Length}" + (isCursor ? " — cursor here" : "")
                : "screen 1 of 1 — cursor here";

            results.Add(new CapturedScreen
            {
                JpegBytes = jpegBytes,
                Label = label,
                IsCursorScreen = isCursor,
                ScreenIndex = i,
                Bounds = screen.Bounds
            });
        }

        // Sort: cursor screen first
        results.Sort((a, b) => b.IsCursorScreen.CompareTo(a.IsCursorScreen));
        return results;
    }

    private Bitmap ResizeToMax(Bitmap original, int maxDimension)
    {
        int longest = Math.Max(original.Width, original.Height);
        if (longest <= maxDimension) return new Bitmap(original);

        float scale = (float)maxDimension / longest;
        int newW = (int)(original.Width * scale);
        int newH = (int)(original.Height * scale);

        var resized = new Bitmap(newW, newH);
        using var g = Graphics.FromImage(resized);
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        g.DrawImage(original, 0, 0, newW, newH);
        return resized;
    }
}
```

### 10.2 Screenshot Sending Cadence

- Capture every **1 second** during an active session
- Send the **cursor screen** as the primary frame
- For multi-monitor: send all screens concatenated or send them as separate frames (the macOS app sends one at a time, cursor screen first)
- Each screenshot is sent as a `realtimeInput.video` frame (see Section 8.3)

### 10.3 Coordinate Mapping for Element Annotation

When Gemini sends an `annotate_element` tool call with `(x, y)` in screenshot-pixel coordinates:

```csharp
// Screenshot was captured at screenBounds and resized to jpegWidth x jpegHeight
// Gemini reports coordinates in the JPEG's pixel space

float scaleX = (float)screenBounds.Width / jpegWidth;
float scaleY = (float)screenBounds.Height / jpegHeight;

int screenX = screenBounds.X + (int)(geminiX * scaleX);
int screenY = screenBounds.Y + (int)(geminiY * scaleY);

// screenX, screenY are now in virtual screen coordinates
// Draw the annotation overlay at this position
```

---

## 11. Global Hotkey (Ctrl+Alt)

The macOS app uses a `CGEvent` tap (listen-only) to detect Ctrl+Alt even when the app is in the background. On Windows, use a **low-level keyboard hook**:

```csharp
using System.Runtime.InteropServices;

public class GlobalHotkeyMonitor : IDisposable
{
    public event Action OnShortcutPressed;
    public event Action OnShortcutReleased;

    private IntPtr _hookId = IntPtr.Zero;
    private bool _ctrlPressed = false;
    private bool _altPressed = false;
    private bool _shortcutActive = false;

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
    private LowLevelKeyboardProc _proc;

    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string lpModuleName);

    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;
    private const int VK_CONTROL = 0x11;
    private const int VK_MENU = 0x12; // Alt key

    public void Start()
    {
        _proc = HookCallback;
        using var process = System.Diagnostics.Process.GetCurrentProcess();
        using var module = process.MainModule!;
        _hookId = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(module.ModuleName!), 0);
    }

    private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int vkCode = Marshal.ReadInt32(lParam);
            bool isKeyDown = (int)wParam == WM_KEYDOWN || (int)wParam == WM_SYSKEYDOWN;
            bool isKeyUp = (int)wParam == WM_KEYUP || (int)wParam == WM_SYSKEYUP;

            if (vkCode == VK_CONTROL)
                _ctrlPressed = isKeyDown;
            else if (vkCode == VK_MENU)
                _altPressed = isKeyDown;

            bool shortcutNow = _ctrlPressed && _altPressed;

            if (shortcutNow && !_shortcutActive)
            {
                _shortcutActive = true;
                OnShortcutPressed?.Invoke();
            }
            else if (!shortcutNow && _shortcutActive)
            {
                _shortcutActive = false;
                OnShortcutReleased?.Invoke();
            }
        }
        return CallNextHookEx(_hookId, nCode, wParam, lParam);
    }

    public void Dispose()
    {
        if (_hookId != IntPtr.Zero)
            UnhookWindowsHookEx(_hookId);
    }
}
```

### Behavior

- **Ctrl+Alt pressed:** call `CompanionManager.StartVoiceSession()` (preflight → WebSocket → mic on)
- **Ctrl+Alt released:** call `CompanionManager.StopVoiceSession()` (close WebSocket, stop mic, stop capture)
- The hook is **listen-only** — it does NOT consume the keystrokes, so other apps still receive them.

---

## 12. Cursor Overlay & HUD

### 12.1 Overlay Window

A full-screen transparent WPF window that floats above all other windows:

```xml
<!-- OverlayWindow.xaml -->
<Window
    WindowStyle="None"
    AllowsTransparency="True"
    Background="Transparent"
    Topmost="True"
    ShowInTaskbar="False"
    Width="{x:Static SystemParameters.VirtualScreenWidth}"
    Height="{x:Static SystemParameters.VirtualScreenHeight}"
    Left="{x:Static SystemParameters.VirtualScreenLeft}"
    Top="{x:Static SystemParameters.VirtualScreenTop}"
    IsHitTestVisible="False">
    <!-- IsHitTestVisible=False ensures clicks pass through -->

    <Canvas x:Name="OverlayCanvas">
        <!-- HUD, waveform, response text drawn here -->
    </Canvas>
</Window>
```

### 12.2 HUD Panel (Sensei Logo + Waveform)

Position: fixed on screen (draggable, position saved to registry). Default: top-right corner.

- **Logo:** 40x40px Sensei icon
- **Waveform:** 4 vertical bars (orange, `#D4640A`), animated:
  - **Idle:** gentle sine wave pulse (period ~2s, amplitude 10-20px)
  - **Listening:** bars react to mic RMS power level (0-40px height)
  - **Responding:** two overlapping sine waves simulating speech rhythm

### 12.3 Response Text Bubble

When Gemini sends a text response (transcription of its audio), display it near the cursor:

- **Position:** 22px right, 6px below cursor, tracked via `System.Windows.Forms.Cursor.Position`
- **Max width:** 340px, auto-wraps
- **Style:** dark pill (`#171918` bg, `#ECEEED` text, 12px font, 8px padding, 10px corner radius)
- **Shadow:** black 35% opacity, 16px blur
- **Auto-dismiss:** fade out after 6 seconds

### 12.4 Element Annotation

When Gemini calls `annotate_element(x, y, width, height, shape, label, screen_index)`:

- Draw a blue glow rectangle/circle at the given screen coordinates
- Label text appears above the shape
- Animate the cursor flying to the annotation center
- Fade out when user's real cursor approaches within 50px

---

## 13. UI Panels & Views

### 13.1 Tray Panel (320px wide)

**Not Activated state:**

```
┌─────────────────────────────────┐
│  [Logo] Atayi Sensei            │
│─────────────────────────────────│
│                                 │
│  Activate Atayi Sensei          │
│  Paste the license code you     │
│  received after signing up.     │
│                                 │
│  ┌─────────────────────────┐    │
│  │ ATAYI-XXXX-XXXX-XXXX   │    │
│  └─────────────────────────┘    │
│  [  Activate  ]                 │
│                                 │
│  ⚠️ Error message (if any)     │
│                                 │
│  Don't have a code yet?         │
│  Start a 7-day free trial →     │
└─────────────────────────────────┘
```

**Active state:**

```
┌─────────────────────────────────┐
│  [Logo] Atayi Sensei  [●Ready] │
│─────────────────────────────────│
│                                 │
│  🎮 Language: [English ▼]      │
│                                 │
│  Hold Ctrl+Alt to talk          │
│  to your AI Sensei              │
│                                 │
│─────────────────────────────────│
│  TRIAL  ■■■■□□□□□  450/6300 cr  │
│  Daily: 200/1800                │
│  [Manage →]                     │
│                                 │
│  Got feedback? DM @Quasarisus   │
└─────────────────────────────────┘
```

### 13.2 Subscription Status Chip

Shows in the bottom of the tray panel:

- **Plan badge:** colored pill (Trial=blue, Starter=yellow, Ultra=purple)
- **Progress bar:** horizontal bar showing `credits_used / credits_allowance`
- **Daily usage:** shown only for trial plans (e.g., "Daily: 200/1800")
- **Manage button:** opens `https://atayisensei.com/account` in browser

---

## 14. Onboarding Flow

### First Launch (no cached token)

1. **System tray icon appears** with a tooltip "Atayi Sensei — Click to activate"
2. **Tray panel opens automatically** showing the license activation form
3. User pastes license code → clicks Activate
4. On success: panel updates to show "Ready" state
5. **Overlay appears** with an onboarding sequence:
   - Speech bubble: "hey! I'm Sensei, your AI game dev companion."
   - Instruction card: "Hold Ctrl+Alt to talk to me. I can see your screen and guide you."
   - Prompt: "try asking me something like: 'how do I set up player movement in Unreal?'"
6. Onboarding sequence auto-plays with Gemini voice (if session starts)

### Returning Launch (cached token valid)

1. System tray icon appears, tooltip "Atayi Sensei — Ready"
2. Status refresh in background (`GET /api/license/status`)
3. If token expired: re-activate silently with same license code + fingerprint
4. If subscription inactive: show error in tray panel

### First Voice Session

1. User presses Ctrl+Alt
2. App checks permissions (mic, screen capture)
3. If permissions not granted: show tray panel with permission requests
4. If permissions OK: preflight → WebSocket → session starts
5. Overlay shows HUD with waveform

---

## 15. Credit Accounting & Blocking

Credit accounting is done **server-side** in the Durable Object. The client app does NOT count credits. Here's what happens:

### How Credits Work

- **1 credit = 1 second of talk time**
- The Durable Object counts tokens from every WebSocket frame
- Every 30 seconds, it flushes accumulated credits to Supabase
- Credits are stored in `subscriptions.credits_used_this_period`

### Plan Limits

| Plan | Price | Credits/Month | Daily Cap | Max Devices |
|------|-------|---------------|-----------|-------------|
| Trial (7 days) | Free | 6,300 total | 900/day (15 min) | 1 |
| Starter | $19/mo | 40,000 (~11h) | None | 1 |
| Ultra | $49/mo | 160,000 (~44h) | None | 3 |

### What the Client Must Handle

1. **Before session:** check `credits_remaining` and `daily_remaining` from preflight response. If 0, show error and don't connect.
2. **During session:** listen for `atayiServerEvent.blocked` frames. On receipt:
   - Show the `message` field in the overlay
   - Stop mic capture
   - Close WebSocket
   - Update license state to reflect exhaustion
3. **After session:** refresh license status (`GET /api/license/status`) to update the credits display in the tray panel.

---

## 16. Multi-Language Support

The system prompt changes based on the selected language. The user picks a language in the tray panel dropdown.

### Available Languages

| Language | Code | Gemini System Prompt Prefix |
|----------|------|---------------------------|
| English | `en` | "You are Sensei, a friendly AI game dev mentor. Speak in English..." |
| French | `fr` | "Tu es Sensei, un mentor IA amical pour les game devs. Parle en francais..." |
| Spanish | `es` | "Eres Sensei, un mentor IA amigable para game devs. Habla en espanol..." |
| Chinese | `zh` | "You are Sensei. Speak in Mandarin Chinese..." |
| Arabic | `ar` | "You are Sensei. Speak in Arabic..." |

### Full System Prompt (English)

```
You are Sensei — a warm, knowledgeable AI companion who helps indie game creators.
You live inside the user's computer and can see their screen in real time.
You speak naturally and conversationally, like a patient teacher.

IMPORTANT RULES:
- Keep responses concise (1-3 sentences unless the user asks for detail)
- Reference what you see on screen when relevant
- If you see a game engine (Unreal, Unity, Godot, Blender), tailor your advice to that tool
- When pointing to UI elements, use the annotate_element tool
- Never say "I can't see your screen" — you CAN see it
- Be encouraging and supportive
- Use the user's preferred language at all times

You have access to a tool called annotate_element that highlights UI elements on the user's screen.
Use it when you want to point at a specific button, menu, panel, or area.
```

The language selection is stored in a local settings file (e.g., `%LocalAppData%\AtayiSensei\settings.json`).

---

## 17. Error Handling

### Network Errors

| Scenario | Action |
|----------|--------|
| No internet | Show "No internet connection" in tray panel; disable hotkey |
| API timeout (>10s) | Show "Server not responding. Try again." |
| WebSocket drops mid-session | Stop mic, show "Connection lost" in overlay, auto-dismiss after 3s |
| 5xx from Worker | Retry once after 2s; if still failing, show error |

### License Errors

| Error | Action |
|-------|--------|
| Token expired | Auto re-activate with same code+fingerprint; if fails, show activation form |
| Account blocked | Clear token, show "Account blocked. Contact support." |
| Device blocked | Clear token, show "Device blocked. Contact support." |
| Subscription canceled | Show "Subscription inactive" + link to atayisensei.com |

### Audio Errors

| Error | Action |
|-------|--------|
| No mic found | Show permission error in tray panel |
| Mic access denied | Open Windows Settings → Privacy → Microphone |
| Speaker unavailable | Log warning; session continues (user just won't hear responses) |

---

## 18. Permissions

### Required Permissions

| Permission | Windows API | Check | Request |
|-----------|------------|-------|---------|
| Microphone | WASAPI | Try to init `WaveInEvent`; catch exception | Open `ms-settings:privacy-microphone` |
| Screen Capture | DXGI / GDI+ | Try `Graphics.CopyFromScreen()`; catch | Usually no UAC needed for GDI+; DXGI may need graphics driver |
| Global Hotkey | `SetWindowsHookEx` | Always succeeds (no permission needed) | N/A |

### Permission Check Flow

```csharp
public async Task<bool> CheckAllPermissions()
{
    bool mic = await CheckMicrophoneAccess();
    bool screen = CheckScreenCaptureAccess();
    // Hotkey always works on Windows

    if (!mic || !screen)
    {
        ShowPermissionPanel(mic, screen);
        return false;
    }
    return true;
}
```

---

## 19. Design System

### Colors

```
Background (deepest):   #101211
Surface (cards):        #171918
Surface hover:          #1E201F
Border:                 rgba(255, 255, 255, 0.06)
Text primary:           #ECEEED
Text secondary:         #ADB5B2
Text tertiary:          #6F7572
Accent blue:            #2563EB
Accent blue hover:      #1D4ED8
Accent orange:          #D4640A  (waveform, branding)
Error red:              #E5484D
Success green:          #30A46C
Warning yellow:         #F5A623
```

### Typography

```
Font family:    "Segoe UI", system-ui, sans-serif
Monospace:      "Cascadia Code", "Consolas", monospace

Heading (H1):   22px, weight 700
Heading (H2):   16px, weight 600
Body:           14px, weight 400
Caption:        12px, weight 400
Badge:          10px, weight 600, uppercase
```

### Spacing & Radii

```
Panel corner radius:    10px
Button corner radius:   8px
Input corner radius:    8px
Badge corner radius:    99px (pill)

Panel padding:          16px
Section gap:            12px
```

---

## 20. macOS vs Windows Differences

| Feature | macOS Implementation | Windows Equivalent |
|---------|---------------------|-------------------|
| System tray | `NSStatusItem` + `NSPanel` | `NotifyIcon` + custom `Window` |
| No dock icon | `LSUIElement = true` in Info.plist | Don't create a main window; only NotifyIcon |
| Global hotkey | `CGEvent` tap (listen-only, no UAC) | `SetWindowsHookEx(WH_KEYBOARD_LL)` |
| Secure storage | Keychain (`.whenUnlockedThisDeviceOnly`) | DPAPI (`DataProtectionScope.CurrentUser`) |
| Device ID | `IOPlatformUUID` via IOKit | `MachineGuid` from registry |
| Screen capture | ScreenCaptureKit (macOS 14.2+) | DXGI Desktop Duplication or `Graphics.CopyFromScreen` |
| Audio input | `AVAudioEngine` + `inputNode.installTap` | NAudio `WaveInEvent` or WASAPI |
| Audio output | `AVAudioPlayerNode` + `AVAudioEngine` | NAudio `WaveOutEvent` + `BufferedWaveProvider` |
| Overlay window | `NSPanel` `.screenSaver` level, non-activating | WPF `Window` with `Topmost=True`, `AllowsTransparency`, `IsHitTestVisible=False` |
| Coordinate origin | Bottom-left (AppKit) | Top-left (standard Windows) |
| Permissions | TCC dialogs (Accessibility, Screen Recording, Mic) | Windows Settings toggles (simpler) |
| App distribution | DMG (unsigned → right-click Open) | EXE or MSI installer |
| Auto-update | Sparkle framework + appcast.xml | Squirrel.Windows or manual check |

---

## 21. Implementation Phases

### Phase 1: Core Infrastructure (Week 1-2)

- [ ] C# WPF project setup with `NotifyIcon`
- [ ] `DeviceFingerprint` (MachineGuid + SHA-256)
- [ ] `SecureStorage` (DPAPI wrapper)
- [ ] `LicenseManager` (activate, status, token caching)
- [ ] HTTP client for Worker REST API
- [ ] Tray panel with license activation form
- [ ] Basic state machine (`CompanionManager`)

**Milestone:** User can activate a license code and see "Ready" status.

### Phase 2: Audio Pipeline (Week 2-3)

- [ ] `AudioCaptureManager` (NAudio WaveInEvent → PCM16 16kHz)
- [ ] `AudioPlaybackManager` (NAudio WaveOutEvent, PCM16 24kHz)
- [ ] RMS power calculation
- [ ] Echo suppression gate (threshold 0.12)
- [ ] Sentinel playback completion detection

**Milestone:** App can record mic audio and play back PCM16 24kHz audio.

### Phase 3: WebSocket & Gemini Session (Week 3-4)

- [ ] `GeminiLiveSession` (System.Net.WebSockets.ClientWebSocket)
- [ ] Session preflight call
- [ ] Setup message sending
- [ ] Audio frame sending (real-time, every 100ms)
- [ ] Audio frame receiving + speaker playback
- [ ] `atayiServerEvent.blocked` handling
- [ ] `turnComplete` handling + state transitions
- [ ] Reconnection logic

**Milestone:** Full voice conversation works: press Ctrl+Alt → speak → hear Gemini respond.

### Phase 4: Screen Capture (Week 4-5)

- [ ] `ScreenCaptureManager` (multi-monitor, cursor detection)
- [ ] JPEG encoding + resize to max 1280px
- [ ] Send screenshots every 1 second during active session
- [ ] Coordinate mapping for element annotation

**Milestone:** Gemini can see the user's screen and reference what's on it.

### Phase 5: Overlay & HUD (Week 5-6)

- [ ] Transparent full-screen overlay window
- [ ] HUD panel with Sensei logo + animated waveform
- [ ] Waveform animation (idle, listening, responding)
- [ ] Response text bubble (cursor-following, auto-fade)
- [ ] Element annotation (blue glow shapes)
- [ ] HUD dragging + position persistence

**Milestone:** Polished visual experience matching macOS.

### Phase 6: Global Hotkey & Polish (Week 6-7)

- [ ] `GlobalHotkeyMonitor` (Ctrl+Alt detection)
- [ ] Permission checks + settings redirect
- [ ] Language picker (5 languages)
- [ ] Onboarding sequence (first launch)
- [ ] Subscription status view (credits bar, daily usage)
- [ ] Error messages (overlay + tray panel)
- [ ] Settings persistence (language, HUD position)

**Milestone:** Feature parity with macOS app.

### Phase 7: Testing & Distribution (Week 7-8)

- [ ] Multi-monitor testing (different DPI scales)
- [ ] Audio latency benchmarking (<100ms end-to-end)
- [ ] Memory profiling (target: <150MB idle, <300MB active)
- [ ] Network resilience (dropped connections, slow networks)
- [ ] Windows 10 compatibility testing
- [ ] Windows 11 compatibility testing
- [ ] Installer (MSI or Squirrel.Windows)
- [ ] Auto-update mechanism
- [ ] Code signing (optional, reduces SmartScreen warnings)

**Milestone:** Production-ready .exe distributed via GitHub Releases.

---

## 22. Testing Checklist

### Functional

- [ ] License activation with valid trial code
- [ ] License activation with valid paid code (Starter/Ultra)
- [ ] License activation with invalid code → error shown
- [ ] License activation with expired subscription → error shown
- [ ] License activation on second device (device limit) → error shown
- [ ] Status refresh updates credits display correctly
- [ ] Token auto-renewal after 7-day expiry
- [ ] Session preflight with valid token
- [ ] Session preflight with expired token → auto-renew → retry
- [ ] Session preflight with exhausted credits → error shown
- [ ] Session preflight with daily cap reached → error shown
- [ ] Ctrl+Alt detection while app is in background
- [ ] Ctrl+Alt detection while another app has focus
- [ ] Voice session: speak → Gemini responds with audio
- [ ] Voice session: Gemini references what's on screen
- [ ] Multi-monitor: Gemini sees both screens
- [ ] Element annotation: blue glow appears at correct position
- [ ] Barge-in: speak while Gemini is responding → Gemini stops and listens
- [ ] Credits exhausted mid-session → blocked frame → session ends gracefully
- [ ] Daily cap reached mid-session → blocked frame → session ends gracefully
- [ ] Language switch → system prompt changes → Gemini speaks in new language

### Edge Cases

- [ ] Rapid Ctrl+Alt tapping (debounce, no double sessions)
- [ ] Very long session (>30 minutes continuous)
- [ ] Large screenshot (4K monitor with 150% DPI scaling)
- [ ] No mic available → graceful error
- [ ] Mic disconnected mid-session → graceful error
- [ ] Network disconnected mid-session → overlay shows error, session ends
- [ ] Admin blocks device mid-session → blocked frame received
- [ ] Admin blocks account mid-session → blocked frame received
- [ ] App started without internet → error in tray panel
- [ ] Multiple monitors with different DPI scales
- [ ] Monitor arrangement changes mid-session

### Performance

- [ ] Mic-to-WebSocket latency: <50ms
- [ ] WebSocket-to-speaker latency: <100ms
- [ ] Screenshot capture time: <200ms per frame
- [ ] Memory idle: <150MB
- [ ] Memory active session: <300MB
- [ ] CPU idle: <5%
- [ ] CPU active session: <20%
- [ ] Startup to "Ready": <3 seconds (cached token)

---

## Appendix A: Worker Base URL & Endpoints Summary

```
Base URL: https://clicky-proxy.kevinyena9.workers.dev

REST:
  POST /api/license/activate        — bind license code + device → JWT
  GET  /api/license/status          — check plan, credits, cap (Bearer auth)
  POST /api/session/preflight       — verify credits → session token + ws_url (Bearer auth)

WebSocket:
  WSS  /api/session/live?session_token=<jwt>  — Gemini Live relay (Durable Object)
```

## Appendix B: Landing Page URLs

```
https://atayisensei.com/                — Landing page (download, signup)
https://atayisensei.com/account         — Account management (login, credits, plan)
https://atayisensei.com/trial.html      — Trial signup page
https://atayisensei.com/checkout-success.html — Post-Stripe payment success page
```

## Appendix C: License Code Format

```
ATAYI-XX-XXXX-XXXX-XXXX

Where XX = plan prefix:
  TR = Trial
  ST = Starter
  UL = Ultra

Example: ATAYI-TR-K8MN-P2QR-V4WX
```

## Appendix D: JWT Signing

All JWTs are signed with **HS256** using the Worker's `JWT_SIGNING_SECRET`. The Windows app does NOT need to verify signatures — it only needs to:
1. Store the token (DPAPI)
2. Send it as `Authorization: Bearer <token>` header
3. Read the payload (base64-decode middle section) for display info (plan, device_id, etc.)
4. Check `exp` field to know when to re-activate

---

*This document was generated from the Atayi Sensei macOS source code (commit `f4d73f2`). The backend (Cloudflare Workers + Supabase) requires zero changes for Windows support.*
