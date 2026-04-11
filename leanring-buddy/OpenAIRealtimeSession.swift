//
//  OpenAIRealtimeSession.swift
//  leanring-buddy
//
//  Manages a persistent WebSocket connection to the OpenAI Realtime API.
//  Handles bidirectional audio — mic audio streams to OpenAI continuously,
//  and OpenAI's PCM16 audio response is played back in real time through
//  the speakers via AVAudioPlayerNode.
//
//  Session lifecycle (toggle model):
//    1. connect()  → WebSocket opens, session is configured, mic starts
//    2. User speaks → server VAD detects speech, commits audio
//    3. We inject a fresh screenshot, then call response.create
//    4. OpenAI streams audio + transcript back
//    5. We play the audio and accumulate the transcript
//    6. response.done fires → onResponseComplete is called with full text
//    7. Mic stays live — user can speak again immediately
//    8. disconnect() → WebSocket closes, mic stops, speaker stops
//

import AVFoundation
import Combine
import Foundation
import ScreenCaptureKit

@MainActor
final class OpenAIRealtimeSession: NSObject, ObservableObject {

    // MARK: - Session state

    enum SessionState {
        case disconnected
        case connecting
        /// Mic is live and streaming to OpenAI. Waiting for user to speak.
        case connected
        /// OpenAI is generating and streaming the audio response.
        case aiResponding
    }

    @Published private(set) var sessionState: SessionState = .disconnected
    /// Audio power level from the mic, 0–1. Drives the waveform UI.
    @Published private(set) var currentAudioPowerLevel: CGFloat = 0

    // MARK: - Callbacks

    /// Called when OpenAI finishes a complete response turn.
    /// The string contains the full transcript including any [POINT:x,y:label] tag.
    /// The array contains the screen captures that were sent for this turn,
    /// used by CompanionManager for coordinate mapping.
    var onResponseComplete: ((String, [CompanionScreenCapture]) -> Void)?

    /// Called to capture all screens. CompanionManager provides this so the session
    /// never needs to import ScreenCaptureKit directly.
    var captureScreenshots: (() async throws -> [CompanionScreenCapture])?

    // MARK: - Private: WebSocket

    private var webSocketTask: URLSessionWebSocketTask?
    private let webSocketURLSession: URLSession

    // MARK: - Private: Worker proxy base URL

    /// Base URL of the Cloudflare Worker proxy (e.g. "https://clicky-proxy.*.workers.dev").
    /// Set on connect() and used to call /chat for Claude Vision screen descriptions.
    private var workerBaseURL: String = ""

    // MARK: - Private: Audio input (mic → OpenAI)

    private let micAudioEngine = AVAudioEngine()
    /// Converts native mic format (e.g. Float32 at 44100 Hz) to PCM16 at 24 kHz,
    /// the format the OpenAI Realtime API expects.
    private let micPCM16Converter = BuddyPCM16AudioConverter(targetSampleRate: 24000)

    // MARK: - Private: Audio output (OpenAI → speakers)

    private let speakerAudioEngine = AVAudioEngine()
    private let speakerPlayerNode = AVAudioPlayerNode()
    /// Float32 at 24 kHz, mono — we convert from OpenAI's PCM16 Int16 to this
    /// before scheduling buffers on the player node.
    private let speakerPlaybackFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 24000,
        channels: 1,
        interleaved: false
    )!

    // MARK: - Private: Response accumulation

    /// Audio transcript of what the Realtime model spoke, built from response.audio_transcript.delta.
    private var accumulatedTranscriptForCurrentTurn: String = ""
    /// Screen captures taken for the current turn, used for cursor coordinate mapping.
    private var currentTurnScreenCaptures: [CompanionScreenCapture] = []

    // MARK: - Private: Claude Vision pipeline state

    /// The user's spoken words for the current turn, filled once Whisper finishes
    /// transcribing (conversation.item.input_audio_transcription.completed).
    private var currentTurnUserTranscript: String = ""

    /// The full response Claude Vision generated for this turn, including the
    /// [POINT:x,y:label] tag. Passed to onResponseComplete so the coordinate
    /// parser works on Claude's authoritative text — the Realtime model's audio
    /// transcript has the tag stripped since we told it not to speak it.
    private var claudeFullResponseForCurrentTurn: String = ""

    /// Rolling conversation history sent to Claude on each turn for multi-turn context.
    /// Each entry is {"role": "user"|"assistant", "content": "..."}.
    /// Capped at the last 10 messages (5 user + 5 assistant exchanges).
    private var claudeConversationHistory: [[String: String]] = []

    /// Screenshots captured immediately on input_audio_buffer.committed, in parallel
    /// with Whisper transcription. By the time the transcript arrives (~1-2s later),
    /// the screenshot is already done — eliminating the sequential wait.
    private var pendingScreenCapturesForCurrentTurn: [CompanionScreenCapture] = []

    // MARK: - Init

    override init() {
        let urlSessionConfig = URLSessionConfiguration.default
        self.webSocketURLSession = URLSession(configuration: urlSessionConfig)
        super.init()
        setupSpeakerAudioEngine()
    }

    // MARK: - Public interface

    /// Fetches an ephemeral token via the Worker proxy, then opens a WebSocket
    /// to the OpenAI Realtime API and starts streaming microphone audio.
    func connect(tokenProxyURL: String) async {
        guard sessionState == .disconnected else { return }
        sessionState = .connecting
        print("🤖 OpenAI Realtime: connecting...")

        // Derive the worker base URL by stripping the "/openai-realtime-token" suffix.
        // Used later to call /chat for Claude Vision screen descriptions.
        let tokenPathSuffix = "/openai-realtime-token"
        if tokenProxyURL.hasSuffix(tokenPathSuffix) {
            workerBaseURL = String(tokenProxyURL.dropLast(tokenPathSuffix.count))
        }

        guard let ephemeralToken = await fetchEphemeralToken(from: tokenProxyURL) else {
            print("❌ OpenAI Realtime: failed to fetch ephemeral token")
            sessionState = .disconnected
            return
        }

        var webSocketRequest = URLRequest(
            url: URL(string: "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview")!
        )
        webSocketRequest.setValue("Bearer \(ephemeralToken)", forHTTPHeaderField: "Authorization")
        webSocketRequest.setValue("realtime=v1", forHTTPHeaderField: "OpenAI-Beta")

        let task = webSocketURLSession.webSocketTask(with: webSocketRequest)
        self.webSocketTask = task
        task.resume()

        receiveNextWebSocketMessage()
    }

    /// Closes the WebSocket, stops mic capture, and stops speaker playback.
    func disconnect() {
        print("🤖 OpenAI Realtime: disconnecting")
        stopMicCapture()
        stopAndResetSpeakerPlayback()
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        accumulatedTranscriptForCurrentTurn = ""
        currentTurnScreenCaptures = []
        currentTurnUserTranscript = ""
        claudeFullResponseForCurrentTurn = ""
        pendingScreenCapturesForCurrentTurn = []
        claudeConversationHistory = []
        currentAudioPowerLevel = 0
        sessionState = .disconnected
    }

    /// True when the session WebSocket is open (connecting, connected, or responding).
    var isConnected: Bool {
        sessionState != .disconnected
    }

    /// Whether the speaker player node currently has audio playing or buffered.
    func isSpeakerPlayingAudio() -> Bool {
        speakerPlayerNode.isPlaying
    }

    // MARK: - Private: Ephemeral token fetch

    private func fetchEphemeralToken(from proxyURL: String) async -> String? {
        guard let requestURL = URL(string: proxyURL) else { return nil }
        var httpRequest = URLRequest(url: requestURL)
        httpRequest.httpMethod = "POST"

        do {
            let (responseData, httpResponse) = try await URLSession.shared.data(for: httpRequest)
            guard let httpURLResponse = httpResponse as? HTTPURLResponse,
                  (200...299).contains(httpURLResponse.statusCode) else {
                print("❌ OpenAI Realtime: token proxy returned non-200 status")
                return nil
            }

            let jsonObject = try JSONSerialization.jsonObject(with: responseData) as? [String: Any]
            let clientSecretObject = jsonObject?["client_secret"] as? [String: Any]
            return clientSecretObject?["value"] as? String
        } catch {
            print("❌ OpenAI Realtime: token fetch error: \(error)")
            return nil
        }
    }

    // MARK: - Private: WebSocket receive loop

    private func receiveNextWebSocketMessage() {
        webSocketTask?.receive { [weak self] receiveResult in
            Task { @MainActor [weak self] in
                guard let self else { return }

                switch receiveResult {
                case .success(let webSocketMessage):
                    self.handleIncomingWebSocketMessage(webSocketMessage)
                    // Keep the receive loop alive as long as the socket is open
                    if self.webSocketTask != nil {
                        self.receiveNextWebSocketMessage()
                    }
                case .failure(let error):
                    if self.sessionState != .disconnected {
                        print("❌ OpenAI Realtime: WebSocket receive error: \(error)")
                        self.sessionState = .disconnected
                    }
                }
            }
        }
    }

    private func handleIncomingWebSocketMessage(_ message: URLSessionWebSocketTask.Message) {
        guard case .string(let jsonText) = message,
              let jsonData = jsonText.data(using: .utf8),
              let jsonObject = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
              let eventType = jsonObject["type"] as? String else { return }

        switch eventType {

        case "session.created":
            // Session is ready on the OpenAI side — send our configuration
            print("🤖 OpenAI Realtime: session created, sending config")
            sendSessionConfiguration()

        case "session.updated":
            // Our configuration was accepted — start the mic
            if sessionState == .connecting {
                print("🤖 OpenAI Realtime: session configured, starting mic")
                sessionState = .connected
                startMicCapture()
            }

        case "input_audio_buffer.speech_started":
            // Server VAD detected the user started speaking.
            // We intentionally do NOT stop playback here — on macOS there is no
            // hardware echo cancellation, so the speaker output is picked up by
            // the mic and triggers VAD continuously, causing choppy audio loops.
            // OpenAI's server-side VAD handles interruption on its end.
            print("🤖 OpenAI Realtime: user speech detected")

        case "input_audio_buffer.committed":
            // Server VAD committed the user's audio. Reset per-turn state, then
            // immediately kick off the screenshot capture in a background Task —
            // in parallel with Whisper transcription. Whisper typically takes 1-2s,
            // during which the screenshot (~300ms) completes. By the time
            // conversation.item.input_audio_transcription.completed fires, the
            // screenshot is already waiting and Claude can be called with zero
            // additional wait for the screenshot.
            print("🤖 OpenAI Realtime: audio committed — pre-capturing screenshot in parallel with Whisper...")
            accumulatedTranscriptForCurrentTurn = ""
            claudeFullResponseForCurrentTurn = ""
            currentTurnScreenCaptures = []
            pendingScreenCapturesForCurrentTurn = []
            currentTurnUserTranscript = ""

            Task { [weak self] in
                guard let self, let captureScreenshots = self.captureScreenshots else { return }
                do {
                    let screenshots = try await captureScreenshots()
                    await MainActor.run { self.pendingScreenCapturesForCurrentTurn = screenshots }
                    print("🖼️ OpenAI Realtime: screenshot pre-captured (parallel with Whisper)")
                } catch {
                    print("⚠️ OpenAI Realtime: parallel screenshot failed: \(error)")
                }
            }

        case "conversation.item.input_audio_transcription.completed":
            // Whisper has finished transcribing what the user said. We now have
            // everything we need: the question and we can take a fresh screenshot.
            // Hand off to the Claude Vision pipeline which will capture the screen,
            // call Claude, and ask the Realtime model to speak the result.
            guard let userTranscript = jsonObject["transcript"] as? String,
                  !userTranscript.trimmingCharacters(in: .whitespaces).isEmpty else { return }
            currentTurnUserTranscript = userTranscript
            print("🎙️ User said: \"\(userTranscript.prefix(100))\"")
            Task { await self.callClaudeVisionAndGetResponse() }

        case "response.audio.delta":
            if let base64AudioDelta = jsonObject["delta"] as? String {
                playIncomingAudioDelta(base64EncodedPCM16: base64AudioDelta)
                if sessionState != .aiResponding {
                    sessionState = .aiResponding
                }
            }

        case "response.audio_transcript.delta":
            if let transcriptDelta = jsonObject["delta"] as? String {
                accumulatedTranscriptForCurrentTurn += transcriptDelta
            }

        case "response.audio.done":
            // The server has sent all audio deltas for this turn. The audio
            // is now fully queued in AVAudioPlayerNode but may not have played
            // out yet. Schedule a silent sentinel buffer — its completion fires
            // exactly when the speaker finishes draining all queued audio.
            // This delays the mic from resuming until the speaker is truly silent,
            // which prevents the mic from picking up the tail of the AI's speech
            // and feeding it back as a new user turn.
            scheduleSentinelPlaybackCompletion()

        case "response.done":
            // The server has finished generating the full response (audio + text).
            // We intentionally do NOT transition to .connected here — we wait
            // for the sentinel buffer (scheduled above) to fire after the speaker
            // finishes draining. This prevents the mic from resuming while the
            // speaker is still playing, which would cause echo feedback loops.
            //
            // Exception: if no audio was generated (text-only response), the
            // speaker never played, so we transition immediately.
            print("🤖 OpenAI Realtime: response done — \"\(accumulatedTranscriptForCurrentTurn.prefix(80))...\"")

            // CRITICAL: Delete every item the Realtime model just generated from the
            // session's conversation history. Without this, the model accumulates its
            // own responses turn after turn and uses them as context — which causes it
            // to ignore the per-turn instructions and generate its own content instead
            // of speaking Claude's text. Wiping the output items after each turn keeps
            // the Realtime session history clean so the instruction override always wins.
            if let responseObject = jsonObject["response"] as? [String: Any],
               let outputItems = responseObject["output"] as? [[String: Any]] {
                for outputItem in outputItems {
                    if let itemId = outputItem["id"] as? String {
                        sendJSONEvent(["type": "conversation.item.delete", "item_id": itemId])
                    }
                }
            }

            // Also wipe any user audio buffer items that accumulated during the session.
            // We track all of Claude's context ourselves (claudeConversationHistory),
            // so the Realtime model doesn't need conversation history at all.
            sendJSONEvent(["type": "input_audio_buffer.clear"])

            // Pass Claude's full response to the coordinate parser — it contains the
            // [POINT:x,y:label] tag that CompanionManager needs to animate the cursor.
            // Fall back to the Realtime audio transcript if Claude Vision failed.
            let responseTextWithCoordinates = claudeFullResponseForCurrentTurn.isEmpty
                ? accumulatedTranscriptForCurrentTurn
                : claudeFullResponseForCurrentTurn
            let screensCaptures = currentTurnScreenCaptures
            onResponseComplete?(responseTextWithCoordinates, screensCaptures)

            // Fallback: if the speaker is already silent (no audio in this response),
            // the sentinel will never fire, so we transition now.
            if !speakerPlayerNode.isPlaying {
                print("🤖 OpenAI Realtime: no audio to drain, ready for next turn")
                sessionState = .connected
            } else {
                print("🤖 OpenAI Realtime: waiting for speaker to drain before re-enabling mic...")
            }

        case "error":
            let errorDetails = jsonObject["error"] as? [String: Any]
            print("❌ OpenAI Realtime API error: \(errorDetails ?? jsonObject)")

        default:
            break
        }
    }

    // MARK: - Private: Session configuration

    private func sendSessionConfiguration() {
        let sessionUpdateEvent: [String: Any] = [
            "type": "session.update",
            "session": [
                "modalities": ["text", "audio"],
                "instructions": Self.realtimeSystemPrompt,
                "voice": "alloy",
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "input_audio_transcription": [
                    "model": "whisper-1"
                ],
                // Semantic VAD: uses the model's understanding of conversational
                // context to decide when a turn ends, rather than just listening
                // for an acoustic silence threshold. This is far more robust on
                // macOS where there is no hardware echo cancellation — acoustic
                // VAD would trigger on the speaker output picked up by the mic,
                // whereas semantic VAD understands the audio is AI speech and
                // won't commit it as a new user turn.
                // eagerness "low" = waits longer to confirm the turn is done.
                // create_response: false so we fire response.create manually
                // after injecting the screenshot context.
                // eagerness "auto" = balanced between false-positive resistance and
                // responsiveness. "low" was too slow (waited too long before committing).
                "turn_detection": [
                    "type": "semantic_vad",
                    "eagerness": "auto",
                    "create_response": false
                ]
            ]
        ]
        sendJSONEvent(sessionUpdateEvent)
    }

    // MARK: - Private: Claude Vision + Realtime voice pipeline

    /// Full pipeline for a single user turn:
    ///   1. Capture a fresh screenshot of all displays (mandatory — retried up to 3 times)
    ///   2. Send screenshot + user transcript + conversation history to Claude Vision
    ///   3. Claude returns the spoken response text + [POINT:x,y:label] coordinates
    ///   4. Strip the coordinate tag and ask the Realtime model to speak the text verbatim
    private func callClaudeVisionAndGetResponse() async {
        // Use the screenshot pre-captured in parallel with Whisper (zero wait).
        // If it's already ready, great. If not (rare — Whisper was unusually fast),
        // take a fresh screenshot now. Retry up to 3 times on failure.
        if !pendingScreenCapturesForCurrentTurn.isEmpty {
            currentTurnScreenCaptures = pendingScreenCapturesForCurrentTurn
            print("🖼️ OpenAI Realtime: using pre-captured screenshot (no wait)")
        } else if let captureScreenshots {
            print("🖼️ OpenAI Realtime: pre-capture not ready, taking fresh screenshot...")
            for screenshotAttemptNumber in 1...3 {
                do {
                    currentTurnScreenCaptures = try await captureScreenshots()
                    print("🖼️ OpenAI Realtime: screenshot captured (attempt \(screenshotAttemptNumber))")
                    break
                } catch {
                    print("⚠️ OpenAI Realtime: screenshot attempt \(screenshotAttemptNumber)/3 failed: \(error)")
                    if screenshotAttemptNumber < 3 {
                        try? await Task.sleep(nanoseconds: 300_000_000)
                    }
                }
            }
        }

        // Hard stop: no screenshot means no response. Responding without seeing the
        // screen would cause the AI to answer based on stale conversation history,
        // which leads to wrong or irrelevant answers when the user has navigated away.
        guard !currentTurnScreenCaptures.isEmpty else {
            print("❌ OpenAI Realtime: all screenshot attempts failed — aborting response")
            // Tell the user Clicky couldn't see the screen rather than staying silent.
            let errorResponseEvent: [String: Any] = [
                "type": "response.create",
                "response": [
                    "modalities": ["text", "audio"],
                    "instructions": "Say exactly: sorry, i couldn't capture your screen. can you try again?"
                ]
            ]
            sendJSONEvent(errorResponseEvent)
            sessionState = .connected
            return
        }

        if let claudeResponse = await callClaudeVisionAPI(
            screenshots: currentTurnScreenCaptures,
            userTranscript: currentTurnUserTranscript
        ) {
            claudeFullResponseForCurrentTurn = claudeResponse

            // Update rolling conversation history for future turns.
            claudeConversationHistory.append(["role": "user", "content": currentTurnUserTranscript])
            claudeConversationHistory.append(["role": "assistant", "content": claudeResponse])
            if claudeConversationHistory.count > 10 {
                claudeConversationHistory.removeFirst(claudeConversationHistory.count - 10)
            }

            // Strip the [POINT:...] tag before passing to the voice model — we don't
            // want it to say "point 450 comma 300 colon close button" aloud.
            let textToSpeak = stripPointingTag(from: claudeResponse)
            print("🤖 Claude response: \"\(claudeResponse.prefix(120))\"")

            // Tell the Realtime model to speak Claude's text verbatim.
            // The instruction is intentionally very strict — the model tends to
            // improvise if given any wiggle room, especially when it has residual
            // context from previous turns. The conversation history is wiped after
            // each turn (see response.done handler) to reinforce this.
            let responseCreateEvent: [String: Any] = [
                "type": "response.create",
                "response": [
                    "modalities": ["text", "audio"],
                    "instructions": """
                    You are a text-to-speech engine. Read the text below out loud, \
                    word for word, exactly as written. Do NOT use your own knowledge. \
                    Do NOT improvise. Do NOT add, remove, or rephrase anything. \
                    Use the same language as the text. Start speaking immediately:

                    \(textToSpeak)
                    """
                ]
            ]
            sendJSONEvent(responseCreateEvent)
        } else {
            // Claude Vision failed — let the Realtime model respond on its own
            // as a fallback (no screen context, but still helpful).
            print("⚠️ OpenAI Realtime: Claude Vision failed, falling back to Realtime model")
            sendJSONEvent(["type": "response.create"])
        }
    }

    /// Calls Claude via the worker's /chat route with screenshots + user transcript
    /// + conversation history. Returns Claude's full response string including the
    /// [POINT:x,y:label] tag (or [POINT:none]) at the end.
    private func callClaudeVisionAPI(
        screenshots: [CompanionScreenCapture],
        userTranscript: String
    ) async -> String? {
        guard !workerBaseURL.isEmpty,
              let chatEndpointURL = URL(string: "\(workerBaseURL)/chat") else {
            print("⚠️ OpenAI Realtime: worker base URL not set, skipping Claude Vision")
            return nil
        }

        // Build the user content for this turn: screenshots first, then the question.
        var currentTurnContentBlocks: [[String: Any]] = []

        for screenCapture in screenshots {
            currentTurnContentBlocks.append([
                "type": "image",
                "source": [
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": screenCapture.imageData.base64EncodedString()
                ]
            ])
            currentTurnContentBlocks.append([
                "type": "text",
                "text": "Screen: \(screenCapture.label). " +
                        "Screenshot size: \(screenCapture.screenshotWidthInPixels)×\(screenCapture.screenshotHeightInPixels)px " +
                        "(display: \(screenCapture.displayWidthInPoints)×\(screenCapture.displayHeightInPoints)pt)."
            ])
        }

        currentTurnContentBlocks.append([
            "type": "text",
            "text": "The user just said (via voice): \"\(userTranscript)\""
        ])

        // Build the full messages array: history entries (text-only) + current turn (with images).
        var messagesArray: [[String: Any]] = claudeConversationHistory.map { historyEntry in
            [
                "role": historyEntry["role"] ?? "user",
                "content": historyEntry["content"] ?? ""
            ]
        }
        messagesArray.append(["role": "user", "content": currentTurnContentBlocks])

        // Haiku 4.5 is ~3-4x faster than Sonnet for the same task.
        // For screen description + short conversational replies, Haiku is
        // more than capable — and the speed gain is critical for voice UX.
        let claudeRequestBody: [String: Any] = [
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 256,
            "system": Self.claudeVisionSystemPrompt,
            "messages": messagesArray
        ]

        guard let requestBodyData = try? JSONSerialization.data(withJSONObject: claudeRequestBody) else {
            return nil
        }

        var httpRequest = URLRequest(url: chatEndpointURL)
        httpRequest.httpMethod = "POST"
        httpRequest.httpBody = requestBodyData
        httpRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")

        do {
            let (responseData, httpURLResponse) = try await URLSession.shared.data(for: httpRequest)
            guard let castedHTTPResponse = httpURLResponse as? HTTPURLResponse,
                  (200...299).contains(castedHTTPResponse.statusCode) else {
                let statusCode = (httpURLResponse as? HTTPURLResponse)?.statusCode ?? -1
                print("⚠️ OpenAI Realtime: Claude Vision HTTP \(statusCode)")
                return nil
            }

            let responseJSON = try JSONSerialization.jsonObject(with: responseData) as? [String: Any]
            let contentBlocks = responseJSON?["content"] as? [[String: Any]]
            let firstTextBlock = contentBlocks?.first(where: { $0["type"] as? String == "text" })
            return firstTextBlock?["text"] as? String
        } catch {
            print("⚠️ OpenAI Realtime: Claude Vision request error: \(error)")
            return nil
        }
    }

    /// Strips the trailing [POINT:x,y:label] or [POINT:none] tag from Claude's response
    /// so the Realtime voice model doesn't read the coordinate tag aloud.
    private func stripPointingTag(from claudeResponse: String) -> String {
        let pointTagPattern = #"\s*\[POINT:[^\]]*\]\s*$"#
        if let tagRange = claudeResponse.range(of: pointTagPattern, options: [.regularExpression, .caseInsensitive]) {
            return String(claudeResponse[claudeResponse.startIndex..<tagRange.lowerBound])
                .trimmingCharacters(in: .whitespaces)
        }
        return claudeResponse
    }

    // MARK: - Private: Mic audio capture

    private func startMicCapture() {
        let micInputNode = micAudioEngine.inputNode
        let nativeMicFormat = micInputNode.outputFormat(forBus: 0)

        micInputNode.removeTap(onBus: 0)
        micInputNode.installTap(
            onBus: 0,
            bufferSize: 4096,
            format: nativeMicFormat
        ) { [weak self] audioBuffer, _ in
            guard let self else { return }

            // While the AI is speaking, the mic picks up the speaker output
            // (macOS has no hardware echo cancellation). Sending that audio to
            // OpenAI would trigger the server VAD, interrupt the response, and
            // cause choppy "saccadé" audio. We pause mic streaming to OpenAI
            // for the duration of the AI's response and resume once it's done.
            guard self.sessionState != .aiResponding else {
                // Still sample power so the waveform UI stays active.
                self.sampleAudioPowerLevel(from: audioBuffer)
                return
            }

            // Convert from native mic format (Float32, native sample rate) to
            // PCM16 mono at 24 kHz — the format OpenAI Realtime expects.
            if let pcm16AudioData = self.micPCM16Converter.convertToPCM16Data(from: audioBuffer) {
                let base64EncodedAudio = pcm16AudioData.base64EncodedString()
                let audioAppendEvent: [String: Any] = [
                    "type": "input_audio_buffer.append",
                    "audio": base64EncodedAudio
                ]
                Task { @MainActor [weak self] in
                    self?.sendJSONEvent(audioAppendEvent)
                }
            }

            // Update the waveform power level for the listening UI
            self.sampleAudioPowerLevel(from: audioBuffer)
        }

        micAudioEngine.prepare()
        do {
            try micAudioEngine.start()
            print("🎤 OpenAI Realtime: mic capture started")
        } catch {
            print("❌ OpenAI Realtime: mic capture failed to start: \(error)")
        }
    }

    private func stopMicCapture() {
        micAudioEngine.inputNode.removeTap(onBus: 0)
        micAudioEngine.stop()
    }

    // MARK: - Private: Speaker audio playback

    private func setupSpeakerAudioEngine() {
        speakerAudioEngine.attach(speakerPlayerNode)
        speakerAudioEngine.connect(
            speakerPlayerNode,
            to: speakerAudioEngine.mainMixerNode,
            format: speakerPlaybackFormat
        )
        speakerAudioEngine.prepare()
        do {
            try speakerAudioEngine.start()
        } catch {
            print("❌ OpenAI Realtime: speaker engine failed to start: \(error)")
        }
    }

    /// Decodes a base64 PCM16 chunk from OpenAI and schedules it on the player node.
    /// Multiple scheduled buffers play back-to-back without gaps.
    private func playIncomingAudioDelta(base64EncodedPCM16: String) {
        guard let pcm16AudioData = Data(base64Encoded: base64EncodedPCM16) else { return }

        // PCM16 = 2 bytes per sample (Int16). Convert to Float32 for AVAudioPlayerNode.
        let numberOfSamples = pcm16AudioData.count / 2
        guard numberOfSamples > 0 else { return }

        guard let float32Buffer = AVAudioPCMBuffer(
            pcmFormat: speakerPlaybackFormat,
            frameCapacity: AVAudioFrameCount(numberOfSamples)
        ) else { return }

        float32Buffer.frameLength = AVAudioFrameCount(numberOfSamples)

        // Normalize Int16 [-32768, 32767] → Float32 [-1.0, 1.0]
        pcm16AudioData.withUnsafeBytes { rawBufferPointer in
            guard let int16BaseAddress = rawBufferPointer.bindMemory(to: Int16.self).baseAddress,
                  let float32BaseAddress = float32Buffer.floatChannelData?[0] else { return }
            for sampleIndex in 0..<numberOfSamples {
                float32BaseAddress[sampleIndex] = Float(int16BaseAddress[sampleIndex]) / 32768.0
            }
        }

        // Buffers queue up automatically — call play() once to start the stream.
        speakerPlayerNode.scheduleBuffer(float32Buffer)
        if !speakerPlayerNode.isPlaying {
            speakerPlayerNode.play()
        }
    }

    /// Stops playback immediately and resets the player node so it's ready for
    /// the next turn. Called when the user interrupts the AI by speaking.
    private func stopAndResetSpeakerPlayback() {
        speakerPlayerNode.stop()
    }

    /// Schedules a 1-frame silent buffer at the end of the audio queue.
    /// Its completion handler fires exactly when AVAudioPlayerNode finishes
    /// playing all previously queued audio — at that point it is safe to
    /// re-enable the mic without risk of the speaker output leaking in.
    private func scheduleSentinelPlaybackCompletion() {
        guard let sentinelBuffer = AVAudioPCMBuffer(
            pcmFormat: speakerPlaybackFormat,
            frameCapacity: 1
        ) else { return }
        // 1 frame of silence at 24 kHz ≈ 0.04 ms — inaudible, but enough to
        // give AVAudioPlayerNode a concrete buffer whose completion we can observe.
        sentinelBuffer.frameLength = 1
        sentinelBuffer.floatChannelData?[0][0] = 0.0

        speakerPlayerNode.scheduleBuffer(sentinelBuffer) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                // Only transition if we are still in the responding state —
                // a disconnect() or interruption may have already moved us out.
                if self.sessionState == .aiResponding {
                    print("🤖 OpenAI Realtime: speaker drained — mic re-enabled, ready for next turn")
                    self.sessionState = .connected
                }
            }
        }
    }

    // MARK: - Private: WebSocket send helper

    private func sendJSONEvent(_ eventDictionary: [String: Any]) {
        guard let jsonData = try? JSONSerialization.data(withJSONObject: eventDictionary),
              let jsonString = String(data: jsonData, encoding: .utf8) else { return }

        webSocketTask?.send(.string(jsonString)) { sendError in
            if let sendError {
                // Error code 57 = "Socket is not connected" — normal during disconnect, ignore it
                let nsError = sendError as NSError
                if nsError.code != 57 {
                    print("⚠️ OpenAI Realtime: WebSocket send error: \(sendError)")
                }
            }
        }
    }

    // MARK: - Private: Audio power level (for waveform UI)

    private func sampleAudioPowerLevel(from audioBuffer: AVAudioPCMBuffer) {
        guard let floatChannelData = audioBuffer.floatChannelData else { return }
        let frameCount = Int(audioBuffer.frameLength)
        guard frameCount > 0 else { return }

        // Compute RMS (root mean square) power of this audio chunk
        var sumOfSquares: Float = 0
        for frameIndex in 0..<frameCount {
            let sample = floatChannelData[0][frameIndex]
            sumOfSquares += sample * sample
        }
        let rootMeanSquarePower = sqrt(sumOfSquares / Float(frameCount))
        let boostedPowerLevel = min(max(rootMeanSquarePower * 10.2, 0), 1)

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            // Apply smoothing so the waveform decays gradually instead of snapping to zero
            self.currentAudioPowerLevel = max(CGFloat(boostedPowerLevel), self.currentAudioPowerLevel * 0.72)
        }
    }

    // MARK: - System prompts

    /// Minimal prompt for the Realtime voice model. Claude Vision generates the actual
    /// response content and coordinates — the Realtime model just speaks it aloud.
    private static let realtimeSystemPrompt = """
    you are a friendly voice assistant. you will receive specific text to say each turn via \
    the response instructions. say it exactly, naturally and conversationally, in the same \
    language as the text given. do not add, skip, or change anything.
    """

    /// Full prompt for Claude Vision — the AI brain that sees the screen, understands
    /// the user's question, and produces both the spoken response and cursor coordinates.
    private static let claudeVisionSystemPrompt = """
    you're clicky, a friendly macOS AI companion. you receive screenshots of the user's screen \
    and their spoken question (transcribed to text). your response is spoken aloud by a voice \
    agent, so write like you talk — all lowercase, casual, warm, no markdown, no bullet points, \
    no emojis. keep responses concise.

    when helping with a multi-step task, go one step at a time:
    - describe the current step in one or two natural sentences
    - point at the relevant UI element using [POINT:x,y:label]
    - wait for the user to say something like "and then?" or "next step?" before continuing
    - when all steps are done, say you're finished but remind them the conversation is still open

    pointing rules:
    - use [POINT:x,y:label] whenever pointing at a specific UI element would genuinely help
    - coordinates are in screenshot pixels, top-left origin, x rightward, y downward
    - if the element is on a secondary screen, append :screenN (e.g. [POINT:400,300:terminal:screen2])
    - if nothing specific to point at, append [POINT:none] at the very end
    - always put the [POINT:...] tag at the very end of your response — the voice agent strips it before speaking

    a few more things:
    - reference specific things visible on screen when it's relevant
    - don't read code verbatim — describe what it does conversationally
    - never say "simply" or "just"
    - write out small numbers, use "for example" not "e.g."
    - if multiple screens are shown, the one labeled "cursor is here" is the primary focus
    """
}

// MARK: - CompanionScreenCapture extension for image data access

private extension CompanionScreenCapture {
    /// Returns the raw JPEG bytes of this screen capture.
    var data: Data { imageData }
}
