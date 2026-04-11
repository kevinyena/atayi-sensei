//
//  CompanionManager.swift
//  leanring-buddy
//
//  Central state manager for the companion voice mode. Owns the push-to-talk
//  pipeline (dictation manager + global shortcut monitor + overlay) and
//  exposes observable voice state for the panel UI.
//

import AVFoundation
import Combine
import Foundation
import PostHog
import ScreenCaptureKit
import SwiftUI

enum CompanionVoiceState {
    case idle
    case listening
    case processing
    case responding
}

/// Languages Sensei can respond in. Stored in UserDefaults so the choice persists.
enum SenseiLanguage: String, CaseIterable, Identifiable {
    case english  = "English"
    case french   = "French"
    case spanish  = "Spanish"
    case chinese  = "Chinese"
    case arabic   = "Arabic"

    var id: String { rawValue }

    var flag: String {
        switch self {
        case .english:  return "🇺🇸"
        case .french:   return "🇫🇷"
        case .spanish:  return "🇪🇸"
        case .chinese:  return "🇨🇳"
        case .arabic:   return "🇸🇦"
        }
    }

    /// Instruction injected into Sensei's system prompt so it always responds
    /// in the language the user has selected.
    var systemPromptInstruction: String {
        switch self {
        case .english:  return "Always respond in English."
        case .french:   return "Always respond in French."
        case .spanish:  return "Always respond in Spanish."
        case .chinese:  return "Always respond in Mandarin Chinese."
        case .arabic:   return "Always respond in Arabic."
        }
    }

    // MARK: - Localized UI strings

    var controlOptionHint: String {
        switch self {
        case .english: return "Hold Control (⌃) + Option (⌥) and say something like:\n\"Help me build an indie game like Expedition 33 with Unreal Engine\""
        case .french:  return "Maintiens Control (⌃) + Option (⌥) et dis par exemple :\n\"Aide-moi à créer un jeu indé comme Expedition 33 avec Unreal Engine\""
        case .spanish: return "Mantén Control (⌃) + Option (⌥) y di algo como:\n\"Ayúdame a crear un juego indie como Expedition 33 con Unreal Engine\""
        case .chinese: return "按住 Control (⌃) + Option (⌥) 并说例如：\n\"帮我用虚幻引擎做一个像33号远征队一样的独立游戏\""
        case .arabic:  return "اضغط مطولاً Control (⌃) + Option (⌥) وقل مثلاً:\n\"ساعدني في بناء لعبة مستقلة مثل Expedition 33 بـ Unreal Engine\""
        }
    }

    var languageLabel: String {
        switch self {
        case .english: return "Language"
        case .french:  return "Langue"
        case .spanish: return "Idioma"
        case .chinese: return "语言"
        case .arabic:  return "اللغة"
        }
    }

    var quitLabel: String {
        switch self {
        case .english: return "Quit Sensei"
        case .french:  return "Quitter Sensei"
        case .spanish: return "Salir de Sensei"
        case .chinese: return "退出 Sensei"
        case .arabic:  return "إغلاق Sensei"
        }
    }

    var feedbackTitle: String {
        switch self {
        case .english: return "Got feedback? DM me"
        case .french:  return "Un retour ? Écris-moi"
        case .spanish: return "¿Comentarios? Escríbeme"
        case .chinese: return "有反馈？给我发消息"
        case .arabic:  return "هل لديك ملاحظات؟ راسلني"
        }
    }

    var feedbackSubtitle: String {
        switch self {
        case .english: return "Bugs, ideas, anything — I read every message."
        case .french:  return "Bugs, idées, n'importe quoi — je lis tout."
        case .spanish: return "Bugs, ideas, lo que sea — leo cada mensaje."
        case .chinese: return "Bug、想法，什么都行——我全都看。"
        case .arabic:  return "أخطاء، أفكار، أي شيء — أقرأ كل رسالة."
        }
    }

    var statusSetup: String {
        switch self {
        case .english: return "Setup"
        case .french:  return "Config"
        case .spanish: return "Config"
        case .chinese: return "设置"
        case .arabic:  return "الإعداد"
        }
    }

    var statusReady: String {
        switch self {
        case .english: return "Ready"
        case .french:  return "Prêt"
        case .spanish: return "Listo"
        case .chinese: return "就绪"
        case .arabic:  return "جاهز"
        }
    }

    var statusActive: String {
        switch self {
        case .english: return "Active"
        case .french:  return "Actif"
        case .spanish: return "Activo"
        case .chinese: return "运行中"
        case .arabic:  return "نشط"
        }
    }

    var statusListening: String {
        switch self {
        case .english: return "Listening"
        case .french:  return "Écoute"
        case .spanish: return "Escuchando"
        case .chinese: return "聆听中"
        case .arabic:  return "يستمع"
        }
    }

    var statusProcessing: String {
        switch self {
        case .english: return "Processing"
        case .french:  return "Traitement"
        case .spanish: return "Procesando"
        case .chinese: return "处理中"
        case .arabic:  return "معالجة"
        }
    }

    var statusResponding: String {
        switch self {
        case .english: return "Responding"
        case .french:  return "Répond"
        case .spanish: return "Respondiendo"
        case .chinese: return "回应中"
        case .arabic:  return "يجيب"
        }
    }

    var permissionsHeader: String {
        switch self {
        case .english: return "PERMISSIONS"
        case .french:  return "AUTORISATIONS"
        case .spanish: return "PERMISOS"
        case .chinese: return "权限"
        case .arabic:  return "الأذونات"
        }
    }

    var grantLabel: String {
        switch self {
        case .english: return "Grant"
        case .french:  return "Accorder"
        case .spanish: return "Conceder"
        case .chinese: return "授权"
        case .arabic:  return "منح"
        }
    }

    var grantedLabel: String {
        switch self {
        case .english: return "Granted"
        case .french:  return "Accordé"
        case .spanish: return "Concedido"
        case .chinese: return "已授权"
        case .arabic:  return "ممنوح"
        }
    }

    var introTitle: String {
        switch self {
        case .english: return "Meet Sensei."
        case .french:  return "Voici Sensei."
        case .spanish: return "Conoce a Sensei."
        case .chinese: return "认识 Sensei。"
        case .arabic:  return "تعرّف على Sensei."
        }
    }

    var introBody: String {
        switch self {
        case .english: return "A voice AI that lives in your menu bar and helps you build in Unreal, Unity, Blender, Premiere, AutoCAD, Sketch, and Figma."
        case .french:  return "Une IA vocale dans ta barre de menu qui t'aide à créer sur Unreal, Unity, Blender, Premiere, AutoCAD, Sketch et Figma."
        case .spanish: return "Una IA de voz en tu barra de menú que te ayuda a crear en Unreal, Unity, Blender, Premiere, AutoCAD, Sketch y Figma."
        case .chinese: return "住在菜单栏里的语音 AI，帮你在 Unreal、Unity、Blender、Premiere、AutoCAD、Sketch 和 Figma 中构建项目。"
        case .arabic:  return "ذكاء اصطناعي صوتي في شريط القوائم يساعدك في Unreal وUnity وBlender وPremiere وAutoCAD وSketch وFigma."
        }
    }

    var introPrivacy: String {
        switch self {
        case .english: return "Nothing runs in the background. Sensei only looks at your screen when you press the hotkey."
        case .french:  return "Rien ne tourne en fond. Sensei ne regarde ton écran que quand tu appuies sur le raccourci."
        case .spanish: return "Nada corre en segundo plano. Sensei solo ve tu pantalla al presionar la tecla."
        case .chinese: return "没有后台运行。Sensei 只在你按下快捷键时查看你的屏幕。"
        case .arabic:  return "لا شيء يعمل في الخلفية. لا يرى Sensei شاشتك إلا عند الضغط على الاختصار."
        }
    }

    var allSetText: String {
        switch self {
        case .english: return "You're all set. Hit Start to meet Sensei."
        case .french:  return "Tout est prêt. Appuie sur Démarrer pour rencontrer Sensei."
        case .spanish: return "Todo listo. Pulsa Iniciar para conocer a Sensei."
        case .chinese: return "一切就绪。点击开始来认识 Sensei。"
        case .arabic:  return "كل شيء جاهز. اضغط ابدأ للقاء Sensei."
        }
    }

    var permissionsNeededTitle: String {
        switch self {
        case .english: return "Permissions needed"
        case .french:  return "Autorisations requises"
        case .spanish: return "Permisos necesarios"
        case .chinese: return "需要权限"
        case .arabic:  return "الأذونات مطلوبة"
        }
    }

    var permissionsNeededBody: String {
        switch self {
        case .english: return "Some permissions were revoked. Grant all four below to keep using Sensei."
        case .french:  return "Certaines autorisations ont été révoquées. Accorde les quatre ci-dessous pour continuer."
        case .spanish: return "Algunos permisos fueron revocados. Concede los cuatro abajo para continuar."
        case .chinese: return "部分权限已被撤销。请授予以下全部四项权限以继续使用。"
        case .arabic:  return "تم إلغاء بعض الأذونات. امنح الأذونات الأربعة أدناه للاستمرار."
        }
    }

    var startLabel: String {
        switch self {
        case .english: return "Start"
        case .french:  return "Démarrer"
        case .spanish: return "Iniciar"
        case .chinese: return "开始"
        case .arabic:  return "ابدأ"
        }
    }
}


@MainActor
final class CompanionManager: ObservableObject {
    @Published private(set) var voiceState: CompanionVoiceState = .idle
    @Published private(set) var lastTranscript: String?
    @Published private(set) var currentAudioPowerLevel: CGFloat = 0
    @Published private(set) var hasAccessibilityPermission = false
    @Published private(set) var hasScreenRecordingPermission = false
    @Published private(set) var hasMicrophonePermission = false
    @Published private(set) var hasScreenContentPermission = false


    // MARK: - Onboarding Card State

    /// Whether the "how sensei works" explanation card is currently visible.
    @Published var showOnboardingCard: Bool = false
    @Published var onboardingCardOpacity: Double = 0.0

    // MARK: - Onboarding Prompt Bubble

    /// Text streamed character-by-character after the onboarding card dismisses.
    @Published var onboardingPromptText: String = ""
    @Published var onboardingPromptOpacity: Double = 0.0
    @Published var showOnboardingPrompt: Bool = false

    // MARK: - Language Selection

    /// The language Sensei responds in. Persisted so the choice survives restarts.
    @Published var selectedLanguage: SenseiLanguage = {
        if let saved = UserDefaults.standard.string(forKey: "selectedSenseiLanguage"),
           let language = SenseiLanguage(rawValue: saved) {
            return language
        }
        return .english
    }()

    func setSelectedLanguage(_ language: SenseiLanguage) {
        selectedLanguage = language
        UserDefaults.standard.set(language.rawValue, forKey: "selectedSenseiLanguage")
        // Reconnect the live session so the new system prompt (with new language) takes effect.
        if geminiLiveSession.isConnected {
            userInitiatedSessionDisconnect = false
            geminiLiveSession.disconnect()
        }
    }

    // MARK: - Onboarding Music

    private var onboardingMusicPlayer: AVAudioPlayer?
    private var onboardingMusicFadeTimer: Timer?

    let globalPushToTalkShortcutMonitor = GlobalPushToTalkShortcutMonitor()
    let overlayWindowManager = OverlayWindowManager()
    // Response text is now displayed inline on the cursor overlay via
    // streamingResponseText, so no separate response overlay manager is needed.

    /// Manages the persistent Gemini Live WebSocket session. Single model that
    /// handles VAD, vision (screenshots), reasoning, and audio output natively.
    /// The session is proxied through the Cloudflare Worker so the Gemini
    /// API key never ships in this app binary.
    let geminiLiveSession = GeminiLiveSession()

    /// Most recent license/preflight error, displayed in the panel and overlay
    /// when a session fails to start (trial expired, credits exhausted, device
    /// blocked, etc.). Set by `openRealtimeConversationSession()` when the
    /// `LicenseManager.preflightSession()` call fails, cleared on success.
    @Published var licenseErrorMessage: String? = nil

    private var shortcutTransitionCancellable: AnyCancellable?
    private var voiceStateCancellable: AnyCancellable?
    private var audioPowerCancellable: AnyCancellable?
    private var blockedEventCancellable: AnyCancellable?
    private var accessibilityCheckTimer: Timer?
    /// Scheduled hide for transient cursor mode — cancelled if the user
    /// speaks again before the delay elapses.
    private var transientHideTask: Task<Void, Never>?
    /// True when the user explicitly pressed Ctrl+Option to close the session.
    /// Prevents auto-reconnect from firing on a voluntary disconnect.
    private var userInitiatedSessionDisconnect = false

    /// True when all three required permissions (accessibility, screen recording,
    /// microphone) are granted. Used by the panel to show a single "all good" state.
    var allPermissionsGranted: Bool {
        hasAccessibilityPermission && hasScreenRecordingPermission && hasMicrophonePermission && hasScreenContentPermission
    }

    /// Whether the blue cursor overlay is currently visible on screen.
    /// Used by the panel to show accurate status text ("Active" vs "Ready").
    @Published private(set) var isOverlayVisible: Bool = false


    /// User preference for whether the Clicky cursor should be shown.
    /// When toggled off, the overlay is hidden and push-to-talk is disabled.
    /// Persisted to UserDefaults so the choice survives app restarts.
    @Published var isClickyCursorEnabled: Bool = UserDefaults.standard.object(forKey: "isClickyCursorEnabled") == nil
        ? true
        : UserDefaults.standard.bool(forKey: "isClickyCursorEnabled")

    func setClickyCursorEnabled(_ enabled: Bool) {
        isClickyCursorEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: "isClickyCursorEnabled")
        transientHideTask?.cancel()
        transientHideTask = nil

        if enabled {
            overlayWindowManager.hasShownOverlayBefore = true
            overlayWindowManager.showOverlay(onScreens: NSScreen.screens, companionManager: self)
            isOverlayVisible = true
        } else {
            overlayWindowManager.hideOverlay()
            isOverlayVisible = false
        }
    }

    /// Whether the user has completed onboarding at least once. Persisted
    /// to UserDefaults so the Start button only appears on first launch.
    var hasCompletedOnboarding: Bool {
        get { UserDefaults.standard.bool(forKey: "hasCompletedOnboarding") }
        set { UserDefaults.standard.set(newValue, forKey: "hasCompletedOnboarding") }
    }

    /// Whether the user has submitted their email during onboarding.
    @Published var hasSubmittedEmail: Bool = UserDefaults.standard.bool(forKey: "hasSubmittedEmail")

    /// Submits the user's email to FormSpark and identifies them in PostHog.
    func submitEmail(_ email: String) {
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedEmail.isEmpty else { return }

        hasSubmittedEmail = true
        UserDefaults.standard.set(true, forKey: "hasSubmittedEmail")

        // Identify user in PostHog
        PostHogSDK.shared.identify(trimmedEmail, userProperties: [
            "email": trimmedEmail
        ])

        // Submit to FormSpark
        Task {
            var request = URLRequest(url: URL(string: "https://submit-form.com/RWbGJxmIs")!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["email": trimmedEmail])
            _ = try? await URLSession.shared.data(for: request)
        }
    }

    func start() {
        refreshAllPermissions()
        print("🔑 Clicky start — accessibility: \(hasAccessibilityPermission), screen: \(hasScreenRecordingPermission), mic: \(hasMicrophonePermission), screenContent: \(hasScreenContentPermission), onboarded: \(hasCompletedOnboarding)")
        startPermissionPolling()
        bindVoiceStateObservation()
        bindAudioPowerLevel()
        bindShortcutTransitions()
        bindRealtimeSessionCallbacks()
        bindBlockedEventObservation()

        // If the user already completed onboarding AND all permissions are
        // still granted, show the cursor overlay immediately. If permissions
        // were revoked (e.g. signing change), don't show the cursor — the
        // panel will show the permissions UI instead.
        if hasCompletedOnboarding && allPermissionsGranted && isClickyCursorEnabled {
            overlayWindowManager.hasShownOverlayBefore = true
            overlayWindowManager.showOverlay(onScreens: NSScreen.screens, companionManager: self)
            isOverlayVisible = true
        }
    }

    /// Called by BlueCursorView after the buddy finishes its pointing
    /// animation and returns to cursor-following mode.
    /// Triggers the onboarding sequence — dismisses the panel and restarts
    /// the overlay so the welcome animation and intro video play.
    func triggerOnboarding() {
        // Post notification so the panel manager can dismiss the panel
        NotificationCenter.default.post(name: .clickyDismissPanel, object: nil)

        // Mark onboarding as completed so the Start button won't appear
        // again on future launches — the cursor will auto-show instead
        hasCompletedOnboarding = true

        ClickyAnalytics.trackOnboardingStarted()

        // Play Besaid theme at 60% volume, fade out after 1m 30s
        startOnboardingMusic()

        // Show the overlay for the first time — isFirstAppearance triggers
        // the welcome animation and onboarding video
        overlayWindowManager.showOverlay(onScreens: NSScreen.screens, companionManager: self)
        isOverlayVisible = true
    }

    /// Replays the onboarding experience from the "Watch Onboarding Again"
    /// footer link. Same flow as triggerOnboarding but the cursor overlay
    /// is already visible so we just restart the welcome animation and video.
    func replayOnboarding() {
        NotificationCenter.default.post(name: .clickyDismissPanel, object: nil)
        ClickyAnalytics.trackOnboardingReplayed()
        startOnboardingMusic()
        // Tear down any existing overlays and recreate with isFirstAppearance = true
        overlayWindowManager.hasShownOverlayBefore = false
        overlayWindowManager.showOverlay(onScreens: NSScreen.screens, companionManager: self)
        isOverlayVisible = true
    }

    private func stopOnboardingMusic() {
        onboardingMusicFadeTimer?.invalidate()
        onboardingMusicFadeTimer = nil
        onboardingMusicPlayer?.stop()
        onboardingMusicPlayer = nil
    }

    private func startOnboardingMusic() {
        stopOnboardingMusic()
        guard let musicURL = Bundle.main.url(forResource: "ff", withExtension: "mp3") else {
            print("⚠️ Clicky: ff.mp3 not found in bundle")
            return
        }

        do {
            let player = try AVAudioPlayer(contentsOf: musicURL)
            player.volume = 0.3
            player.play()
            self.onboardingMusicPlayer = player

            // After 1m 30s, fade the music out over 3s
            onboardingMusicFadeTimer = Timer.scheduledTimer(withTimeInterval: 90.0, repeats: false) { [weak self] _ in
                self?.fadeOutOnboardingMusic()
            }
        } catch {
            print("⚠️ Clicky: Failed to play onboarding music: \(error)")
        }
    }

    private func fadeOutOnboardingMusic() {
        guard let player = onboardingMusicPlayer else { return }

        let fadeSteps = 30
        let fadeDuration: Double = 3.0
        let stepInterval = fadeDuration / Double(fadeSteps)
        let volumeDecrement = player.volume / Float(fadeSteps)
        var stepsRemaining = fadeSteps

        onboardingMusicFadeTimer = Timer.scheduledTimer(withTimeInterval: stepInterval, repeats: true) { [weak self] timer in
            stepsRemaining -= 1
            player.volume -= volumeDecrement

            if stepsRemaining <= 0 {
                timer.invalidate()
                player.stop()
                self?.onboardingMusicPlayer = nil
                self?.onboardingMusicFadeTimer = nil
            }
        }
    }


    func stop() {
        globalPushToTalkShortcutMonitor.stop()
        geminiLiveSession.disconnect()
        overlayWindowManager.hideOverlay()
        transientHideTask?.cancel()

        shortcutTransitionCancellable?.cancel()
        voiceStateCancellable?.cancel()
        audioPowerCancellable?.cancel()
        blockedEventCancellable?.cancel()
        accessibilityCheckTimer?.invalidate()
        accessibilityCheckTimer = nil
    }

    func refreshAllPermissions() {
        let previouslyHadAccessibility = hasAccessibilityPermission
        let previouslyHadScreenRecording = hasScreenRecordingPermission
        let previouslyHadMicrophone = hasMicrophonePermission
        let previouslyHadAll = allPermissionsGranted

        let currentlyHasAccessibility = WindowPositionManager.hasAccessibilityPermission()
        hasAccessibilityPermission = currentlyHasAccessibility

        if currentlyHasAccessibility {
            globalPushToTalkShortcutMonitor.start()
        } else {
            globalPushToTalkShortcutMonitor.stop()
        }

        hasScreenRecordingPermission = WindowPositionManager.hasScreenRecordingPermission()

        let micAuthStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        hasMicrophonePermission = micAuthStatus == .authorized

        // Debug: log permission state on changes
        if previouslyHadAccessibility != hasAccessibilityPermission
            || previouslyHadScreenRecording != hasScreenRecordingPermission
            || previouslyHadMicrophone != hasMicrophonePermission {
            print("🔑 Permissions — accessibility: \(hasAccessibilityPermission), screen: \(hasScreenRecordingPermission), mic: \(hasMicrophonePermission), screenContent: \(hasScreenContentPermission)")
        }

        // Track individual permission grants as they happen
        if !previouslyHadAccessibility && hasAccessibilityPermission {
            ClickyAnalytics.trackPermissionGranted(permission: "accessibility")
        }
        if !previouslyHadScreenRecording && hasScreenRecordingPermission {
            ClickyAnalytics.trackPermissionGranted(permission: "screen_recording")
        }
        if !previouslyHadMicrophone && hasMicrophonePermission {
            ClickyAnalytics.trackPermissionGranted(permission: "microphone")
        }
        // Screen content permission is persisted — once the user has approved the
        // SCShareableContent picker, we don't need to re-check it.
        if !hasScreenContentPermission {
            hasScreenContentPermission = UserDefaults.standard.bool(forKey: "hasScreenContentPermission")
        }

        if !previouslyHadAll && allPermissionsGranted {
            ClickyAnalytics.trackAllPermissionsGranted()
        }
    }

    /// Triggers the macOS screen content picker by performing a dummy
    /// screenshot capture. Once the user approves, we persist the grant
    /// so they're never asked again during onboarding.
    @Published private(set) var isRequestingScreenContent = false

    func requestScreenContentPermission() {
        guard !isRequestingScreenContent else { return }
        isRequestingScreenContent = true
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first else {
                    await MainActor.run { isRequestingScreenContent = false }
                    return
                }
                let filter = SCContentFilter(display: display, excludingWindows: [])
                let config = SCStreamConfiguration()
                config.width = 320
                config.height = 240
                let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
                // Verify the capture actually returned real content — a 0x0 or
                // fully-empty image means the user denied the prompt.
                let didCapture = image.width > 0 && image.height > 0
                print("🔑 Screen content capture result — width: \(image.width), height: \(image.height), didCapture: \(didCapture)")
                await MainActor.run {
                    isRequestingScreenContent = false
                    guard didCapture else { return }
                    hasScreenContentPermission = true
                    UserDefaults.standard.set(true, forKey: "hasScreenContentPermission")
                    ClickyAnalytics.trackPermissionGranted(permission: "screen_content")

                    // If onboarding was already completed, show the cursor overlay now
                    if hasCompletedOnboarding && allPermissionsGranted && !isOverlayVisible && isClickyCursorEnabled {
                        overlayWindowManager.hasShownOverlayBefore = true
                        overlayWindowManager.showOverlay(onScreens: NSScreen.screens, companionManager: self)
                        isOverlayVisible = true
                    }
                }
            } catch {
                print("⚠️ Screen content permission request failed: \(error)")
                await MainActor.run { isRequestingScreenContent = false }
            }
        }
    }

    // MARK: - Private

    /// Triggers the system microphone prompt if the user has never been asked.
    /// Once granted/denied the status sticks and polling picks it up.
    private func promptForMicrophoneIfNotDetermined() {
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined else { return }
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            Task { @MainActor [weak self] in
                self?.hasMicrophonePermission = granted
            }
        }
    }

    /// Polls all permissions frequently so the UI updates live after the
    /// user grants them in System Settings. Screen Recording is the exception —
    /// macOS requires an app restart for that one to take effect.
    private func startPermissionPolling() {
        accessibilityCheckTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.refreshAllPermissions()
            }
        }
    }

    /// Observes blocked frames sent by the Cloudflare Worker Durable Object.
    /// When the server terminates a session for a billing reason (credits
    /// exhausted, daily cap reached, subscription inactive, device blocked),
    /// the DO sends an `atayiServerEvent.blocked` frame. We mirror the reason
    /// into `licenseErrorMessage` so the panel + overlay can display it,
    /// then trigger a license status refresh so the UI reflects the new state.
    private func bindBlockedEventObservation() {
        blockedEventCancellable = geminiLiveSession.$atayiBlockedMessage
            .receive(on: DispatchQueue.main)
            .sink { [weak self] blockedMessage in
                guard let self, let blockedMessage, !blockedMessage.isEmpty else { return }
                self.licenseErrorMessage = blockedMessage
                // Re-query the server so the panel shows the fresh state
                Task { @MainActor in
                    await LicenseManager.shared.refreshStatus()
                }
            }
    }

    private func bindAudioPowerLevel() {
        audioPowerCancellable = geminiLiveSession.$currentAudioPowerLevel
            .receive(on: DispatchQueue.main)
            .sink { [weak self] powerLevel in
                self?.currentAudioPowerLevel = powerLevel
            }
    }

    private func bindVoiceStateObservation() {
        // Map the Gemini Live session's state to the companion voice state that
        // drives the cursor overlay UI (spinner, waveform, idle triangle, etc.)
        voiceStateCancellable = geminiLiveSession.$sessionState
            .receive(on: DispatchQueue.main)
            .sink { [weak self] realtimeState in
                guard let self else { return }
                switch realtimeState {
                case .disconnected:
                    self.voiceState = .idle
                    self.scheduleTransientHideIfNeeded()

                    // Auto-reconnect when the session closes unexpectedly (server timeout,
                    // network blip, etc.) so the user never has to re-press Ctrl+Option
                    // just to continue the conversation after Clicky finishes responding.
                    // Only skipped when the user explicitly pressed Ctrl+Option to close,
                    // or when the server refused to reopen the session (subscription
                    // expired, credits exhausted, device blocked).
                    let wasBlockedByServer = self.geminiLiveSession.atayiBlockedReason != nil
                    if !self.userInitiatedSessionDisconnect && self.isOverlayVisible && !wasBlockedByServer {
                        print("🔄 Gemini Live: session closed unexpectedly — auto-reconnecting in 0.5s")
                        Task {
                            try? await Task.sleep(nanoseconds: 500_000_000)
                            // Re-run preflight to get a fresh session token, since the
                            // previous one was consumed and the DO is gone.
                            let preflightResult = await LicenseManager.shared.preflightSession()
                            if case .success(let preflightInfo) = preflightResult {
                                self.geminiLiveSession.responseLanguage = self.selectedLanguage
                                await self.geminiLiveSession.connect(
                                    proxiedWebSocketURL: preflightInfo.wsURL,
                                    sessionToken: preflightInfo.sessionToken,
                                )
                            } else if case .failure(let error) = preflightResult {
                                print("❌ Auto-reconnect preflight failed: \(error.localizedDescription)")
                                self.licenseErrorMessage = error.localizedDescription
                            }
                        }
                    }
                    self.userInitiatedSessionDisconnect = false
                case .connecting:
                    self.voiceState = .processing
                case .connected:
                    // Mic is live — show the listening waveform
                    self.voiceState = .listening
                case .aiResponding:
                    self.voiceState = .responding
                }
            }
    }

    /// Wires up the Gemini Live session callbacks so CompanionManager reacts to
    /// completed AI responses and provides screenshots for each turn.
    private func bindRealtimeSessionCallbacks() {
        // Provide the session with a screenshot closure so it can inject
        // fresh screen captures before each AI response turn.
        geminiLiveSession.captureScreenshots = { [weak self] in
            guard let self else { throw CancellationError() }
            let rawCaptures = try await CompanionScreenCaptureUtility.captureAllScreensAsJPEG()
            return rawCaptures
        }

    }

    private func bindShortcutTransitions() {
        shortcutTransitionCancellable = globalPushToTalkShortcutMonitor
            .shortcutTransitionPublisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] transition in
                self?.handleShortcutTransition(transition)
            }
    }

    private func handleShortcutTransition(_ transition: BuddyPushToTalkShortcut.ShortcutTransition) {
        switch transition {
        case .pressed:
            // Don't interfere while the onboarding card is showing
            guard !showOnboardingCard else { return }

            if geminiLiveSession.isConnected {
                // Second press → close the conversation session
                disconnectRealtimeConversationSession()
            } else {
                // First press → open the conversation session
                openRealtimeConversationSession()
            }

        case .released:
            // Toggle model — we ignore key release. The session stays open
            // until the user presses Ctrl+Option again to close it.
            break

        case .none:
            break
        }
    }

    /// Opens the Gemini Live session and shows the cursor overlay.
    /// Called on the first Ctrl+Option press.
    ///
    /// Before opening the WebSocket, we hit `POST /api/session/preflight` on
    /// the Cloudflare Worker to verify that:
    ///   - the user has an active license activated on this device
    ///   - the subscription still has credits
    ///   - the trial daily cap isn't reached
    /// The worker responds with a `ws_url` pointing at the Durable Object that
    /// proxies Gemini Live, plus a short-lived `session_token` used as auth.
    /// The Gemini API key NEVER reaches this app.
    private func openRealtimeConversationSession() {
        // Cancel any pending transient hide so the overlay stays up
        transientHideTask?.cancel()
        transientHideTask = nil

        // Bring the cursor overlay up if it's hidden (transient mode)
        if !isOverlayVisible {
            overlayWindowManager.hasShownOverlayBefore = true
            overlayWindowManager.showOverlay(onScreens: NSScreen.screens, companionManager: self)
            isOverlayVisible = true
        }

        // Dismiss the menu bar panel so it doesn't cover the screen
        NotificationCenter.default.post(name: .clickyDismissPanel, object: nil)

        // Dismiss the onboarding prompt if it's showing
        if showOnboardingPrompt {
            withAnimation(.easeOut(duration: 0.3)) {
                onboardingPromptOpacity = 0.0
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                self.showOnboardingPrompt = false
                self.onboardingPromptText = ""
            }
        }

        ClickyAnalytics.trackPushToTalkStarted()

        Task {
            // 1. Preflight: verify license + subscription + credits + daily cap.
            let preflightResult = await LicenseManager.shared.preflightSession()
            switch preflightResult {
            case .failure(let error):
                print("❌ Session preflight failed: \(error.localizedDescription)")
                licenseErrorMessage = error.localizedDescription
                // Refresh status so the panel UI reflects the latest server state
                await LicenseManager.shared.refreshStatus()
                return
            case .success(let preflightInfo):
                print("🟢 Preflight OK — credits remaining: \(preflightInfo.creditsRemaining)")
                licenseErrorMessage = nil

                // 2. Set language before connecting so the setup message uses the correct prompt.
                geminiLiveSession.responseLanguage = selectedLanguage

                // 3. Open the WebSocket to the worker Durable Object proxy.
                //    The session_token is a short-lived HS256 JWT that the DO verifies.
                await geminiLiveSession.connect(
                    proxiedWebSocketURL: preflightInfo.wsURL,
                    sessionToken: preflightInfo.sessionToken,
                )
            }
        }
    }

    /// Closes the Gemini Live session.
    /// Called on the second Ctrl+Option press.
    private func disconnectRealtimeConversationSession() {
        ClickyAnalytics.trackPushToTalkReleased()
        // Mark as user-initiated so the auto-reconnect logic in bindVoiceStateObservation
        // knows not to reopen the session immediately after this explicit close.
        userInitiatedSessionDisconnect = true
        geminiLiveSession.disconnect()
    }

    /// Waits for the realtime session audio to finish, then fades out the overlay.
    /// Only used in transient cursor mode (user toggled "Show Clicky" off).
    private func scheduleTransientHideIfNeeded() {
        guard !isClickyCursorEnabled && isOverlayVisible else { return }

        transientHideTask?.cancel()
        transientHideTask = Task {
            while geminiLiveSession.isSpeakerPlayingAudio() {
                try? await Task.sleep(nanoseconds: 200_000_000)
                guard !Task.isCancelled else { return }
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !Task.isCancelled else { return }
            overlayWindowManager.fadeOutAndHideOverlay()
            isOverlayVisible = false
        }
    }

    // MARK: - Onboarding (text-based, no video)

    /// Shows the "how sensei works" explanation card, then auto-dismisses it
    /// and streams in the conversation prompt. Called by BlueCursorView after
    /// the welcome text animation completes.
    func setupOnboarding() {
        showOnboardingCard = true
        onboardingCardOpacity = 0.0

        withAnimation(.easeIn(duration: 0.6)) {
            onboardingCardOpacity = 1.0
        }

        // Card stays visible for 10 seconds, then fades out and the prompt appears
        DispatchQueue.main.asyncAfter(deadline: .now() + 10.0) {
            withAnimation(.easeOut(duration: 0.5)) {
                self.onboardingCardOpacity = 0.0
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.showOnboardingCard = false
                self.startOnboardingPromptStream()
            }
        }
    }

    /// Cleans up onboarding card state. Called when the overlay disappears.
    func tearDownOnboarding() {
        showOnboardingCard = false
        onboardingCardOpacity = 0.0
    }

    private func startOnboardingPromptStream() {
        let message = "press ctrl + option and start talking"
        onboardingPromptText = ""
        showOnboardingPrompt = true
        onboardingPromptOpacity = 0.0

        withAnimation(.easeIn(duration: 0.4)) {
            onboardingPromptOpacity = 1.0
        }

        var currentIndex = 0
        Timer.scheduledTimer(withTimeInterval: 0.03, repeats: true) { timer in
            guard currentIndex < message.count else {
                timer.invalidate()
                DispatchQueue.main.asyncAfter(deadline: .now() + 10.0) {
                    guard self.showOnboardingPrompt else { return }
                    withAnimation(.easeOut(duration: 0.3)) {
                        self.onboardingPromptOpacity = 0.0
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                        self.showOnboardingPrompt = false
                        self.onboardingPromptText = ""
                    }
                }
                return
            }
            let index = message.index(message.startIndex, offsetBy: currentIndex)
            self.onboardingPromptText.append(message[index])
            currentIndex += 1
        }
    }
}
