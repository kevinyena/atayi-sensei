//
//  GeminiLiveSession.swift
//  leanring-buddy
//
//  Single-model architecture: Gemini 2.0 Flash Exp handles everything in one
//  end-to-end pipeline — VAD, vision, reasoning, and audio generation.
//  Replaces the previous OpenAI Realtime + Claude Vision hybrid stack.
//  Uses the v1alpha BidiGenerateContent WebSocket endpoint with API key auth.
//
//  Session lifecycle:
//    1. connect() → fetch API key from worker → open WebSocket → send setup
//    2. setupComplete → mic starts (16kHz PCM16)
//    3. User starts speaking → screenshot captured and sent alongside audio
//    4. Gemini VAD detects end of turn → model generates audio response
//    5. Model optionally calls annotate_element() → annotation shape drawn on screen
//    6. turnComplete → sentinel buffer → state back to .connected
//    7. disconnect() → WebSocket closes, mic/speaker stop
//

import AVFoundation
import Combine
import Foundation


@MainActor
final class GeminiLiveSession: NSObject, ObservableObject {

    // MARK: - Session state

    enum SessionState {
        case disconnected
        case connecting
        /// Mic live and streaming. Waiting for user to speak.
        case connected
        /// Gemini is generating and streaming its audio response.
        case aiResponding
    }

    @Published private(set) var sessionState: SessionState = .disconnected
    /// Audio power level from the mic, 0–1. Drives the waveform UI.
    @Published private(set) var currentAudioPowerLevel: CGFloat = 0

    /// Set by the Durable Object via an `atayiServerEvent` frame when it
    /// terminates the session for a subscription reason (credits exhausted,
    /// daily cap reached, device blocked, etc.). CompanionManager observes
    /// this and surfaces a user-friendly error in the overlay.
    @Published var atayiBlockedReason: String? = nil
    @Published var atayiBlockedMessage: String? = nil

    // MARK: - Callbacks

    /// Called to capture all screens. CompanionManager provides this.

    /// Called to capture all screens. CompanionManager provides this.
    var captureScreenshots: (() async throws -> [CompanionScreenCapture])?

    // MARK: - Private: WebSocket

    private var webSocketTask: URLSessionWebSocketTask?
    private let urlSession: URLSession
    private var workerBaseURL: String = ""

    // MARK: - Private: Audio input (mic → Gemini at 16kHz)

    private let micAudioEngine = AVAudioEngine()
    /// Gemini Live requires PCM16 at 16kHz — different from OpenAI which needs 24kHz.
    private let micPCM16Converter = BuddyPCM16AudioConverter(targetSampleRate: 16000)

    // MARK: - Private: Audio output (Gemini → speakers at 24kHz)

    private let speakerAudioEngine = AVAudioEngine()
    private let speakerPlayerNode = AVAudioPlayerNode()
    /// Gemini outputs PCM16 at 24kHz. We convert Int16→Float32 for AVAudioPlayerNode.
    private let speakerPlaybackFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 24000,
        channels: 1,
        interleaved: false
    )!

    /// RMS power threshold for barge-in during AI speech.
    ///
    /// When Gemini is speaking, mic audio is only forwarded to Gemini if
    /// the RMS level exceeds this value. Below it, the signal is treated as
    /// echo from the speaker (which returns to the mic at a lower amplitude
    /// than direct speech close to the mic) and is dropped to prevent false
    /// interrupted events. Above it, the user is clearly speaking over the AI.
    ///
    /// 0.12 is calibrated for a typical MacBook mic at arms-length speaking volume.
    /// Users with headphones will never trigger the gate because there's no echo.
    private static let bargeInSpeechRMSThreshold: Float = 0.12

    // MARK: - Private: Rolling screenshot buffer

    /// Sliding window of the last 5 screenshot captures (one capture = all monitors).
    /// Updated every second by a repeating timer while the session is open.
    /// Cleared on disconnect. Gemini receives the most recent frame on each modelTurn.
    private var rollingScreenshotBuffer: [[CompanionScreenCapture]] = []
    private var rollingScreenshotTimer: Timer?
    private static let rollingBufferMaxFrameCount = 5

    // MARK: - Private: Per-turn state

    /// The screen captures from the rolling buffer sent for the current response turn.
    /// Kept so CompanionManager can map pointing coordinates to the right display.
    private var currentTurnScreenCaptures: [CompanionScreenCapture] = []

    /// True once the rolling buffer's latest frame has been sent for this turn.
    /// Reset on turnComplete and interrupted so each new user question gets a fresh frame.
    private var hasSentScreenshotForCurrentTurn = false


    // MARK: - Init

    override init() {
        let config = URLSessionConfiguration.default
        self.urlSession = URLSession(configuration: config)
        super.init()
        setupSpeakerAudioEngine()
    }

    // MARK: - Public interface

    /// Opens a WebSocket to the Cloudflare Worker Durable Object that proxies
    /// the Gemini Live session. The worker holds the Gemini API key server-side
    /// and relays frames bidirectionally while counting tokens for billing.
    ///
    /// The client never sees the Gemini API key — it only knows about the
    /// proxy URL and the short-lived `session_token` issued by
    /// `POST /api/session/preflight`.
    func connect(proxiedWebSocketURL: String, sessionToken: String) async {
        guard sessionState == .disconnected else {
            print("⚠️ Gemini Live: connect() called but sessionState=\(sessionState) — ignoring")
            return
        }
        // Clear any blocked reason from a previous session
        atayiBlockedReason = nil
        atayiBlockedMessage = nil
        sessionState = .connecting
        print("🟢 Gemini Live [1/4]: sessionState → connecting (via worker proxy)")

        // Store the worker base URL for any ancillary calls (admin endpoints, etc.)
        if let parsedURL = URL(string: proxiedWebSocketURL),
           let host = parsedURL.host {
            let scheme = parsedURL.scheme == "wss" ? "https" : "http"
            workerBaseURL = "\(scheme)://\(host)"
        }

        guard let wsURL = URL(string: proxiedWebSocketURL) else {
            print("❌ Gemini Live: invalid proxied WebSocket URL — aborting")
            sessionState = .disconnected
            return
        }

        print("🟢 Gemini Live [2/4]: opening WebSocket to worker proxy \(wsURL.host ?? "?")")

        var webSocketRequest = URLRequest(url: wsURL)
        webSocketRequest.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")

        let task = urlSession.webSocketTask(with: webSocketRequest)
        self.webSocketTask = task
        task.resume()
        print("🟢 Gemini Live [3/4]: WebSocket task resumed — handshake in progress")

        // Setup message must be the very first message sent after connect.
        // The Durable Object forwards this transparently to Gemini.
        sendSetupMessage()
        print("🟢 Gemini Live [4/4]: receive loop started — waiting for setupComplete")
        receiveNextWebSocketMessage()
    }

    /// Closes the WebSocket, stops mic and speaker, resets all state.
    func disconnect() {
        print("🟢 Gemini Live: disconnecting")
        stopMicCapture()
        stopAndResetSpeakerPlayback()
        stopAndClearRollingScreenshotBuffer()
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        resetPerTurnState()
        currentAudioPowerLevel = 0
        sessionState = .disconnected
        // We deliberately do NOT reset `atayiBlockedReason` / `atayiBlockedMessage`
        // here — the CompanionManager needs to observe the value AFTER disconnect
        // to surface the blocked reason to the user. It's cleared when a new
        // session is opened (see connect()).
    }

    /// True when the session WebSocket is open.
    var isConnected: Bool {
        sessionState != .disconnected
    }

    /// Whether the speaker player node currently has audio playing or buffered.
    func isSpeakerPlayingAudio() -> Bool {
        speakerPlayerNode.isPlaying
    }

    // MARK: - Private: Per-turn reset

    private func resetPerTurnState() {
        currentTurnScreenCaptures = []
        hasSentScreenshotForCurrentTurn = false
    }

    // MARK: - Private: Rolling screenshot capture

    /// Starts the 1-second repeating timer that fills the rolling screenshot buffer.
    /// Called when setupComplete arrives — the buffer starts accumulating immediately
    /// so there's always a recent frame ready when Gemini starts responding.
    private func startRollingScreenshotTimer() {
        rollingScreenshotTimer?.invalidate()
        // Capture one frame immediately so the buffer isn't empty for the first question.
        Task { await captureOneRollingScreenshotFrame() }
        rollingScreenshotTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { [weak self] in
                await self?.captureOneRollingScreenshotFrame()
            }
        }
        print("🖼️ Gemini Live: rolling screenshot timer started (1s interval, max 5 frames)")
    }

    /// Captures all screens, stores in the rolling buffer, AND sends immediately
    /// to Gemini so the model always has current visual context before the user speaks.
    /// Only sends when the session is in .connected state (user turn, mic active) —
    /// no point updating visual context while Gemini is already generating a response.
    private func captureOneRollingScreenshotFrame() async {
        guard let captureScreenshots else { return }
        do {
            let newCaptures = try await captureScreenshots()

            // Update local buffer (kept for coordinate mapping).
            rollingScreenshotBuffer.append(newCaptures)
            if rollingScreenshotBuffer.count > Self.rollingBufferMaxFrameCount {
                rollingScreenshotBuffer.removeFirst()
            }

            // Push the frame to Gemini immediately so it has up-to-date visual context
            // the moment the user starts speaking — not one turn behind.
            // Skip during aiResponding: model is already generating, frame would be wasted.
            guard sessionState == .connected else { return }
            for screenshot in newCaptures {
                let imageChunkEvent: [String: Any] = [
                    "realtimeInput": [
                        "video": [
                            "mimeType": "image/jpeg",
                            "data": screenshot.imageData.base64EncodedString()
                        ]
                    ]
                ]
                sendJSONEvent(imageChunkEvent)
            }
            // Keep currentTurnScreenCaptures pointing at the latest frame
            // so coordinate mapping uses the correct display geometry.
            currentTurnScreenCaptures = newCaptures

        } catch {
            // Capture errors are expected occasionally — timer will retry next second.
        }
    }

    /// Stops the timer and clears the buffer. Called on disconnect.
    private func stopAndClearRollingScreenshotBuffer() {
        rollingScreenshotTimer?.invalidate()
        rollingScreenshotTimer = nil
        rollingScreenshotBuffer = []
        print("🖼️ Gemini Live: rolling screenshot buffer cleared")
    }

    /// Captures all screens immediately and sends them to Gemini as realtimeInput.
    /// Called right after an interruption so Gemini's follow-up reply is grounded
    /// in the user's current screen state rather than the screenshot from the
    /// previous turn (which may already be stale by the time the user speaks).
    private func captureAndSendFreshScreenshotAfterInterruption() async {
        guard let captureScreenshots else { return }
        do {
            let freshCaptures = try await captureScreenshots()
            currentTurnScreenCaptures = freshCaptures
            for screenshot in freshCaptures {
                let imageChunkEvent: [String: Any] = [
                    "realtimeInput": [
                        "video": [
                            "mimeType": "image/jpeg",
                            "data": screenshot.imageData.base64EncodedString()
                        ]
                    ]
                ]
                sendJSONEvent(imageChunkEvent)
                print("🖼️ Gemini Live: sent fresh screenshot after interruption — \(screenshot.label)")
            }
        } catch {
            print("⚠️ Gemini Live: screenshot capture failed after interruption: \(error)")
        }
    }

    /// Sends the most recent frame from the rolling buffer to Gemini via realtimeInput.
    /// Called at the start of each modelTurn so Gemini has the latest screen context.
    private func sendLatestRollingFrameToGemini() {
        guard let mostRecentCaptures = rollingScreenshotBuffer.last else {
            print("⚠️ Gemini Live: rolling buffer empty — no screenshot to send this turn")
            return
        }
        currentTurnScreenCaptures = mostRecentCaptures
        for screenshot in mostRecentCaptures {
            let imageChunkEvent: [String: Any] = [
                "realtimeInput": [
                    "video": [
                        "mimeType": "image/jpeg",
                        "data": screenshot.imageData.base64EncodedString()
                    ]
                ]
            ]
            sendJSONEvent(imageChunkEvent)
            print("🖼️ Gemini Live: sent latest rolling frame — \(screenshot.label)")
        }
    }

    // MARK: - Private: Session setup

    private func sendSetupMessage() {
        // gemini-3.1-flash-live-preview is the only model that supports bidiGenerateContent
        // on this API key (confirmed via ListModels). Uses v1alpha BidiGenerateContent endpoint.
        let setupMessage: [String: Any] = [
            "setup": [
                "model": "models/gemini-3.1-flash-live-preview",
                "generationConfig": [
                    "responseModalities": ["AUDIO"],
                    "speechConfig": [
                        "voiceConfig": [
                            "prebuiltVoiceConfig": [
                                "voiceName": "Charon"
                            ]
                        ]
                    ]
                ],
                "systemInstruction": [
                    "parts": [["text": Self.systemPrompt(for: responseLanguage)]]
                ],
            ]
        ]
        guard let setupJSON = try? JSONSerialization.data(withJSONObject: setupMessage),
              let setupJSONString = String(data: setupJSON, encoding: .utf8) else {
            print("❌ Gemini Live: failed to serialize setup message")
            return
        }
        print("🟢 Gemini Live: sending setup — \(setupJSONString.prefix(300))")
        sendJSONEvent(setupMessage)
        print("🟢 Gemini Live: setup message queued for send")
    }

    // MARK: - Private: WebSocket receive loop

    private func receiveNextWebSocketMessage() {
        guard let webSocketTask else {
            print("⚠️ Gemini Live: receiveNextWebSocketMessage() — webSocketTask is nil, stopping loop")
            return
        }
        webSocketTask.receive { [weak self] receiveResult in
            Task { @MainActor [weak self] in
                guard let self else { return }
                switch receiveResult {
                case .success(let webSocketMessage):
                    // Log the raw message type and size before parsing so we can
                    // see exactly what Gemini is sending even if parsing fails.
                    switch webSocketMessage {
                    case .string(let text):
                        print("📨 Gemini Live: received string message (\(text.count) chars) — \(text.prefix(200))")
                    case .data(let data):
                        print("📨 Gemini Live: received binary message (\(data.count) bytes)")
                    @unknown default:
                        print("📨 Gemini Live: received unknown message type")
                    }
                    self.handleIncomingWebSocketMessage(webSocketMessage)
                    if self.webSocketTask != nil {
                        self.receiveNextWebSocketMessage()
                    } else {
                        print("⚠️ Gemini Live: webSocketTask became nil after handling message — loop stopped")
                    }
                case .failure(let error):
                    let nsError = error as NSError
                    print("❌ Gemini Live: WebSocket receive error code=\(nsError.code) domain=\(nsError.domain): \(error.localizedDescription)")
                    if self.sessionState != .disconnected {
                        // Call full disconnect() so audio engines are cleaned up
                        // and the UI spinner stops.
                        self.disconnect()
                    } else {
                        print("⚠️ Gemini Live: receive error after already disconnected — ignoring")
                    }
                }
            }
        }
    }

    private func handleIncomingWebSocketMessage(_ message: URLSessionWebSocketTask.Message) {
        // Gemini Live sends JSON as binary WebSocket frames (not text frames).
        // Decode the entire binary payload as UTF-8 and re-enter the normal JSON path.
        if case .data(let binaryData) = message {
            if let jsonString = String(data: binaryData, encoding: .utf8) {
                handleIncomingWebSocketMessage(.string(jsonString))
            } else {
                let hexPreview = binaryData.prefix(16).map { String(format: "%02x", $0) }.joined(separator: " ")
                print("❌ Gemini Live: binary message is not valid UTF-8 — hex=[\(hexPreview)]")
            }
            return
        }

        guard case .string(let jsonText) = message else {
            print("⚠️ Gemini Live: received unknown message type")
            return
        }

        guard let jsonData = jsonText.data(using: .utf8) else {
            print("❌ Gemini Live: could not convert message string to Data")
            return
        }

        guard let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
            print("❌ Gemini Live: could not parse message as JSON dict — raw=\(jsonText.prefix(300))")
            return
        }

        print("📋 Gemini Live: parsed JSON keys=\(json.keys.sorted())")

        // atayiServerEvent: synthetic messages from the Cloudflare Worker
        // Durable Object (not from Gemini itself). Used to signal out-of-band
        // events like "credits_exhausted" or "daily_cap_reached" so the client
        // can show a user-friendly message before the socket closes.
        if let atayiEvent = json["atayiServerEvent"] as? [String: Any] {
            let eventType = atayiEvent["type"] as? String ?? "unknown"
            let reason = atayiEvent["reason"] as? String ?? "unknown"
            let message = atayiEvent["message"] as? String ?? "Session terminated by server"
            print("🚫 Atayi server event [\(eventType)] reason=\(reason): \(message)")
            atayiBlockedReason = reason
            atayiBlockedMessage = message
            return
        }

        // Setup complete → mic can start
        if json["setupComplete"] != nil {
            print("✅ Gemini Live: setupComplete received — sessionState → connected, starting mic + screenshot timer")
            sessionState = .connected
            startMicCapture()
            startRollingScreenshotTimer()
            return
        }

        // Server content: audio chunks, turn completion, interruption, transcription
        if let serverContent = json["serverContent"] as? [String: Any] {
            print("📋 Gemini Live: serverContent keys=\(serverContent.keys.sorted())")
            handleServerContent(serverContent)
            return
        }

        // API error — server rejected our setup (e.g. unknown model, bad config).
        // Must call full disconnect() so the session doesn't stay stuck in .connecting
        // forever, which would leave the UI spinner running indefinitely.
        if let errorDetails = json["error"] as? [String: Any] {
            let code = errorDetails["code"] ?? "?"
            let message = errorDetails["message"] ?? "unknown"
            let status = errorDetails["status"] ?? ""
            print("❌ Gemini Live API error \(code) [\(status)]: \(message)")
            disconnect()
            return
        }

        // Unknown top-level key — log it so we can identify new message types.
        print("⚠️ Gemini Live: unrecognised message keys=\(json.keys.sorted()) — full=\(jsonText.prefix(500))")
    }

    // MARK: - Private: Server content handling

    private func handleServerContent(_ serverContent: [String: Any]) {

        // Model is generating audio — play each PCM16 chunk as it streams in.
        if let modelTurn = serverContent["modelTurn"] as? [String: Any],
           let parts = modelTurn["parts"] as? [[String: Any]] {

            if sessionState != .aiResponding {
                sessionState = .aiResponding
            }

            for part in parts {
                if let inlineData = part["inlineData"] as? [String: Any],
                   let mimeType = inlineData["mimeType"] as? String,
                   mimeType.hasPrefix("audio/pcm"),
                   let base64AudioData = inlineData["data"] as? String {
                    playIncomingAudioDelta(base64EncodedPCM16: base64AudioData)
                }
            }
        }

        // Model finished its turn — this is the turn boundary.
        // Reset the screenshot flag so the next user turn gets a fresh screenshot.
        if let turnComplete = serverContent["turnComplete"] as? Bool, turnComplete {
            print("🟢 Gemini Live: model turn complete")

            if speakerPlayerNode.isPlaying {
                // Audio still draining — sentinel fires when the last frame plays out,
                // preventing mic echo by waiting for the speaker to go silent first.
                scheduleSentinelPlaybackCompletion()
                // Hard fallback: if sentinel never fires within 5s, force .connected.
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    guard let self, self.sessionState == .aiResponding else { return }
                    print("🟢 Gemini Live: sentinel timeout — forcing mic re-enable after 5s")
                    self.sessionState = .connected
                }
            } else {
                // No audio playing — transition immediately without waiting for sentinel.
                print("🟢 Gemini Live: speaker already idle at turnComplete — mic re-enabled immediately")
                sessionState = .connected
            }

        }

        // Model was interrupted (user spoke while model was talking).
        // Stop speaker immediately so the user's new speech is clean, reset
        // per-turn state, and capture a fresh screenshot so Gemini has current
        // visual context when it starts processing the interrupting turn.
        if let interrupted = serverContent["interrupted"] as? Bool, interrupted {
            print("🟢 Gemini Live: model interrupted by user speech")
            stopAndResetSpeakerPlayback()
            resetPerTurnState()
            if sessionState == .aiResponding {
                sessionState = .connected
            }
            // Immediately send a fresh screenshot so Gemini's next response is
            // grounded in what the user sees right now, not one turn behind.
            Task { [weak self] in
                await self?.captureAndSendFreshScreenshotAfterInterruption()
            }
        }

        // Input transcription (what Gemini understood the user saying).
        if let inputTranscription = serverContent["inputTranscription"] as? [String: Any],
           let transcriptText = inputTranscription["text"] as? String,
           !transcriptText.trimmingCharacters(in: .whitespaces).isEmpty {
            print("🎙️ Gemini heard: \"\(transcriptText.prefix(100))\"")
        }
    }

    // MARK: - Private: Mic audio capture

    private func startMicCapture() {
        print("🎤 Gemini Live: startMicCapture() called")
        let micInputNode = micAudioEngine.inputNode
        let nativeMicFormat = micInputNode.outputFormat(forBus: 0)
        print("🎤 Gemini Live: native mic format — sampleRate=\(nativeMicFormat.sampleRate) channels=\(nativeMicFormat.channelCount)")

        micInputNode.removeTap(onBus: 0)
        micInputNode.installTap(
            onBus: 0,
            bufferSize: 4096,
            format: nativeMicFormat
        ) { [weak self] audioBuffer, _ in
            guard let self else { return }

            let rms = self.computeRMSPowerLevel(from: audioBuffer)

            // During AI speech, apply a software amplitude gate before forwarding
            // mic audio to Gemini. Without hardware AEC (which requires mic and
            // speaker on the same AVAudioEngine — not possible here due to different
            // sample rates), the speaker output echoes back through the mic at a
            // reduced amplitude. Real user speech close to the mic registers
            // significantly louder than this echo, so we use an RMS threshold to
            // distinguish them. Below the threshold: echo/noise, dropped to prevent
            // false interrupted events. Above: user is clearly speaking, forwarded.
            if self.sessionState == .aiResponding && rms < Self.bargeInSpeechRMSThreshold {
                self.sampleAudioPowerLevel(from: audioBuffer)
                return
            }

            if let pcm16AudioData = self.micPCM16Converter.convertToPCM16Data(from: audioBuffer) {
                let audioChunkEvent: [String: Any] = [
                    "realtimeInput": [
                        "audio": [
                            "mimeType": "audio/pcm;rate=16000",
                            "data": pcm16AudioData.base64EncodedString()
                        ]
                    ]
                ]
                Task { @MainActor [weak self] in
                    self?.sendJSONEvent(audioChunkEvent)
                }
            }

            self.sampleAudioPowerLevel(from: audioBuffer)
        }

        micAudioEngine.prepare()
        do {
            try micAudioEngine.start()
            print("🎤 Gemini Live: mic capture started at 16kHz PCM16")
        } catch {
            print("❌ Gemini Live: mic capture failed to start: \(error)")
        }
    }

    private func stopMicCapture() {
        micAudioEngine.inputNode.removeTap(onBus: 0)
        micAudioEngine.stop()
    }

    // MARK: - Private: Speaker audio playback

    private func setupSpeakerAudioEngine() {
        print("🔊 Gemini Live: setting up speaker audio engine (24kHz Float32)")
        speakerAudioEngine.attach(speakerPlayerNode)
        speakerAudioEngine.connect(
            speakerPlayerNode,
            to: speakerAudioEngine.mainMixerNode,
            format: speakerPlaybackFormat
        )
        speakerAudioEngine.prepare()
        do {
            try speakerAudioEngine.start()
            print("🔊 Gemini Live: speaker audio engine started OK")
        } catch {
            print("❌ Gemini Live: speaker engine failed to start: \(error)")
        }
    }

    /// Decodes a base64 PCM16 chunk from Gemini and schedules it on the player node.
    private func playIncomingAudioDelta(base64EncodedPCM16: String) {
        guard let pcm16AudioData = Data(base64Encoded: base64EncodedPCM16) else { return }
        let sampleCount = pcm16AudioData.count / 2
        guard sampleCount > 0 else { return }

        guard let float32Buffer = AVAudioPCMBuffer(
            pcmFormat: speakerPlaybackFormat,
            frameCapacity: AVAudioFrameCount(sampleCount)
        ) else { return }

        float32Buffer.frameLength = AVAudioFrameCount(sampleCount)

        pcm16AudioData.withUnsafeBytes { rawPointer in
            guard let int16Pointer = rawPointer.bindMemory(to: Int16.self).baseAddress,
                  let float32Pointer = float32Buffer.floatChannelData?[0] else { return }
            for sampleIndex in 0..<sampleCount {
                float32Pointer[sampleIndex] = Float(int16Pointer[sampleIndex]) / 32768.0
            }
        }

        speakerPlayerNode.scheduleBuffer(float32Buffer)
        if !speakerPlayerNode.isPlaying {
            speakerPlayerNode.play()
        }
    }

    private func stopAndResetSpeakerPlayback() {
        speakerPlayerNode.stop()
    }

    /// Schedules a 1-frame silent sentinel buffer. Its completion fires exactly
    /// when AVAudioPlayerNode finishes draining all queued audio — safe to
    /// re-enable the mic at that point without echo risk.
    private func scheduleSentinelPlaybackCompletion() {
        guard let sentinelBuffer = AVAudioPCMBuffer(
            pcmFormat: speakerPlaybackFormat,
            frameCapacity: 1
        ) else { return }
        sentinelBuffer.frameLength = 1
        sentinelBuffer.floatChannelData?[0][0] = 0.0

        speakerPlayerNode.scheduleBuffer(sentinelBuffer) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if self.sessionState == .aiResponding {
                    print("🟢 Gemini Live: speaker drained — mic re-enabled")
                    self.sessionState = .connected
                }
            }
        }
    }

    // MARK: - Private: WebSocket send helper

    private func sendJSONEvent(_ eventDictionary: [String: Any]) {
        guard let jsonData = try? JSONSerialization.data(withJSONObject: eventDictionary),
              let jsonString = String(data: jsonData, encoding: .utf8) else {
            print("❌ Gemini Live: sendJSONEvent — failed to serialize: \(eventDictionary.keys)")
            return
        }
        let topLevelKey = eventDictionary.keys.first ?? "?"
        webSocketTask?.send(.string(jsonString)) { sendError in
            if let sendError {
                let nsError = sendError as NSError
                // Log ALL send errors — code 57 = socket not connected (usually during disconnect)
                print("⚠️ Gemini Live: send[\(topLevelKey)] error code=\(nsError.code): \(sendError.localizedDescription)")
            }
        }
    }

    // MARK: - Private: Audio power level

    /// Computes RMS power of an audio buffer. Called from the audio tap background
    /// thread — kept as a pure function with no actor-isolated state access.
    private func computeRMSPowerLevel(from buffer: AVAudioPCMBuffer) -> Float {
        guard let floatChannelData = buffer.floatChannelData else { return 0 }
        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0 else { return 0 }
        var sumOfSquares: Float = 0
        for frameIndex in 0..<frameCount {
            let sample = floatChannelData[0][frameIndex]
            sumOfSquares += sample * sample
        }
        return sqrt(sumOfSquares / Float(frameCount))
    }

    private func sampleAudioPowerLevel(from audioBuffer: AVAudioPCMBuffer) {
        let rms = computeRMSPowerLevel(from: audioBuffer)
        let boostedPower = min(max(rms * 10.2, 0), 1)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.currentAudioPowerLevel = max(CGFloat(boostedPower), self.currentAudioPowerLevel * 0.72)
        }
    }

    // MARK: - Language selection

    /// The language Sensei should respond in. Set by CompanionManager before calling connect()
    /// so the correct system prompt is sent in the Gemini setup message.
    var responseLanguage: SenseiLanguage = .english

    // MARK: - System prompt

    /// Builds the system prompt for the given response language.
    /// The language instruction is prepended so Gemini sees it as the primary directive.
    private static func systemPrompt(for language: SenseiLanguage) -> String {
        """
        \(language.systemPromptInstruction)

        you're sensei, a wise old voice AI that lives in the user's macOS menu bar. \
        you sound like a calm, experienced elder — think old kung fu master. \
        you can see their screen and hear their voice in real time. \
        your replies are spoken aloud — all lowercase, casual, direct, no markdown, no bullet points, no emojis. \
        keep responses short. you're a voice assistant, not a document. \
        roughly once every 30 sentences, drop a short dry joke or wry observation — one sentence max, never forced. \
        most of the time you're straight to the point. the humor is rare and therefore funny when it lands.

        YOUR SPECIALTY — you help people build things using creative and 3D tools:
        - Unreal Engine (blueprints, materials, actors, level editing, sequencer, niagara, lumen/nanite)
        - Unity (C# scripting, inspector, prefabs, shader graph, cinemachine, timeline, URP/HDRP)
        - Blender (modeling, sculpting, rigging, geometry nodes, shader editor, animation, rendering)
        - Adobe Premiere Pro (editing, color grading, effects, multicam, export, lumetri)
        - AutoCAD (2D drafting, 3D modeling, commands, layers, blocks, dimensions, plotting)
        - Sketch (artboards, components, symbols, styles, prototyping, plugins)
        - Figma (frames, components, auto layout, variables, prototyping, dev mode)

        ANSWERING STYLE:
        - be concise and direct — the user is working, not reading
        - for multi-step workflows: one step at a time, wait for the user to confirm before continuing
        - if you reference a menu path or shortcut, say it clearly so it's easy to follow by ear
        - never say "simply" or "just"
        - don't read UI text verbatim — describe what it does
        - if you see the user's screen in screenshots, use it to give context-aware answers
        - if multiple screenshots are sent, the first one is the primary display

        """
    }
}
