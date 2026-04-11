//
//  OverlayWindow.swift
//  leanring-buddy
//
//  Two separate windows:
//    1. OverlayWindow — full-screen transparent layer per screen (onboarding only)
//    2. SenseiHUDWindow — small floating panel with the sensei logo + animated bars.
//       Draggable anywhere on screen. Position persists across launches.
//

import AppKit
import SwiftUI

// MARK: - Full-screen Overlay (onboarding content)

class OverlayWindow: NSWindow {
    init(screen: NSScreen) {
        super.init(
            contentRect: screen.frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        self.isOpaque = false
        self.backgroundColor = .clear
        self.level = .screenSaver
        self.ignoresMouseEvents = true
        self.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        self.isReleasedWhenClosed = false
        self.hasShadow = false
        self.hidesOnDeactivate = false
        self.setFrame(screen.frame, display: true)
        if let screenForWindow = NSScreen.screens.first(where: { $0.frame == screen.frame }) {
            self.setFrameOrigin(screenForWindow.frame.origin)
        }
    }
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// MARK: - Sensei HUD Window (draggable floating panel)

/// Small floating panel that holds the sensei logo and 4 animated waveform bars.
/// The user can drag it anywhere on screen — position is saved to UserDefaults
/// so it survives app restarts.
///
/// Uses `isMovableByWindowBackground = true` so any drag on the panel content
/// moves the window without needing a title bar.
class SenseiHUDWindow: NSPanel {

    /// UserDefaults key for persisting the last dragged position.
    private static let savedPositionKey = "senseiHUDWindowOrigin"

    /// Width and height of the panel. Sized to tightly wrap sensei (75pt) + bars.
    static let panelSize = CGSize(width: 90, height: 118)

    init(companionManager: CompanionManager) {
        let origin = SenseiHUDWindow.restoredOrigin() ?? SenseiHUDWindow.defaultOrigin()
        let contentRect = NSRect(origin: origin, size: SenseiHUDWindow.panelSize)

        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        self.isOpaque = false
        self.backgroundColor = .clear
        // .screenSaver keeps the HUD visible above all normal app windows and
        // above the menu bar, matching the full-screen overlay level.
        self.level = .screenSaver
        // Allow mouse events so the user can drag the panel.
        self.ignoresMouseEvents = false
        // Any click-and-drag anywhere in the window content moves the window.
        self.isMovableByWindowBackground = true
        self.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        self.isReleasedWhenClosed = false
        self.hasShadow = false
        self.hidesOnDeactivate = false

        let hudView = SenseiHUDView(companionManager: companionManager)
        let hostingView = NSHostingView(rootView: hudView)
        hostingView.frame = NSRect(origin: .zero, size: SenseiHUDWindow.panelSize)
        self.contentView = hostingView

        // Persist position whenever the user drags the panel to a new spot.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(saveCurrentPosition),
            name: NSWindow.didMoveNotification,
            object: self
        )
    }

    @objc private func saveCurrentPosition() {
        let origin = self.frame.origin
        UserDefaults.standard.set(
            ["x": origin.x, "y": origin.y],
            forKey: Self.savedPositionKey
        )
    }

    /// Reads the last saved panel origin from UserDefaults.
    /// Returns nil if the panel has never been moved (first launch).
    private static func restoredOrigin() -> CGPoint? {
        guard let dict = UserDefaults.standard.dictionary(forKey: savedPositionKey),
              let x = dict["x"] as? CGFloat,
              let y = dict["y"] as? CGFloat else { return nil }
        return CGPoint(x: x, y: y)
    }

    /// Default position: bottom-center of the main screen, above the dock area.
    private static func defaultOrigin() -> CGPoint {
        guard let screen = NSScreen.main else { return CGPoint(x: 200, y: 200) }
        return CGPoint(
            x: screen.frame.midX - panelSize.width / 2,
            y: screen.frame.minY + 130
        )
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// MARK: - Sensei HUD View (logo + bars)

/// SwiftUI content for the draggable HUD panel.
/// Always shows: sensei logo on top, 4 animated blue bars below.
struct SenseiHUDView: View {
    @ObservedObject var companionManager: CompanionManager

    var body: some View {
        VStack(spacing: 8) {
            Image("MYE4a")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 75, height: 75)

            SenseiWaveformView(
                voiceState: companionManager.voiceState,
                micAudioPowerLevel: companionManager.currentAudioPowerLevel
            )
        }
        // Cursor changes to an open hand to hint the panel is draggable.
        .onHover { isHovering in
            if isHovering {
                NSCursor.openHand.push()
            } else {
                NSCursor.pop()
            }
        }
    }
}

// MARK: - Sensei Waveform

/// Four animated blue bars. Three visual states:
///   idle / processing  → gentle, slow ambient oscillation
///   listening          → high amplitude driven by mic audio power
///   responding         → simulated speech animation (AI is speaking)
struct SenseiWaveformView: View {
    let voiceState: CompanionVoiceState
    let micAudioPowerLevel: CGFloat

    private let barCount = 4
    private let barWidth: CGFloat = 4
    private let barSpacing: CGFloat = 4
    /// Height profile: outer bars slightly shorter than inner bars
    private let barProfile: [CGFloat] = [0.65, 1.0, 1.0, 0.65]

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 36.0)) { timelineContext in
            HStack(alignment: .center, spacing: barSpacing) {
                ForEach(0..<barCount, id: \.self) { barIndex in
                    RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                        .fill(DS.Colors.senseiOrange)
                        .frame(
                            width: barWidth,
                            height: barHeight(for: barIndex, at: timelineContext.date)
                        )
                }
            }
            .shadow(color: DS.Colors.senseiOrange.opacity(0.75), radius: 8, x: 0, y: 0)
            .animation(.linear(duration: 0.08), value: micAudioPowerLevel)
        }
    }

    private func barHeight(for barIndex: Int, at date: Date) -> CGFloat {
        let time = CGFloat(date.timeIntervalSinceReferenceDate)
        let barPhaseOffset = CGFloat(barIndex) * 0.65

        switch voiceState {

        case .idle, .processing:
            // Very gentle ambient pulse — barely moves, just enough to feel alive
            let phase = time * 1.4 + barPhaseOffset
            return 3.5 + (sin(phase) + 1) / 2 * 3.0 * barProfile[barIndex]

        case .listening:
            // User speaking — driven directly by mic audio power level
            let normalizedPower = max(micAudioPowerLevel - 0.008, 0)
            let easedPower = pow(min(normalizedPower * 2.85, 1), 0.76)
            let reactiveAmplitude = easedPower * 18 * barProfile[barIndex]
            let baselinePulse = (sin(time * 4.0 + barPhaseOffset) + 1) / 2 * 2.0
            return 3.5 + reactiveAmplitude + baselinePulse

        case .responding:
            // AI speaking — two overlapping sine waves per bar for a speech-like rhythm
            let primaryPhase   = time * 5.5 + barPhaseOffset * 1.4
            let secondaryPhase = time * 3.1 + barPhaseOffset * 0.9
            let primaryWave    = (sin(primaryPhase)   + 1) / 2
            let secondaryWave  = (sin(secondaryPhase) + 1) / 2
            let combined = (primaryWave * 0.65 + secondaryWave * 0.35) * 16 * barProfile[barIndex]
            return 3.5 + combined
        }
    }
}

// MARK: - Full-screen Overlay View (onboarding only)

/// The full-screen overlay only renders on the primary display and only
/// during onboarding (welcome bubble, video, prompt). The sensei + bars
/// live in the separate SenseiHUDWindow so they can be dragged.
struct BlueCursorView: View {
    let screenFrame: CGRect
    let isFirstAppearance: Bool
    @ObservedObject var companionManager: CompanionManager

    private var isMainScreen: Bool {
        NSScreen.main?.frame == screenFrame
    }

    @State private var welcomeText: String = ""
    @State private var showWelcome: Bool = true
    @State private var bubbleOpacity: Double = 0.0

    private let fullWelcomeMessage = "hey! i'm sensei"

    var body: some View {
        ZStack {
            Color.black.opacity(0.001)

            if isMainScreen {

                // Welcome speech bubble (first launch)
                if showWelcome && !welcomeText.isEmpty {
                    Text(welcomeText)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .fill(DS.Colors.senseiOrange)
                                .shadow(color: DS.Colors.senseiOrange.opacity(0.5), radius: 6)
                        )
                        .fixedSize()
                        .overlay(GeometryReader { geo in
                            Color.clear.preference(key: SizePreferenceKey.self, value: geo.size)
                        })
                        .opacity(bubbleOpacity)
                        .position(x: screenFrame.width / 2, y: screenFrame.height / 2 - 60)
                        .animation(.easeOut(duration: 0.5), value: bubbleOpacity)
                        .onPreferenceChange(SizePreferenceKey.self) { _ in }
                }

                // Onboarding card — explains how Sensei works, shown after welcome text
                if companionManager.showOnboardingCard {
                    SenseiOnboardingCardView()
                        .opacity(companionManager.onboardingCardOpacity)
                        .position(x: screenFrame.width / 2, y: screenFrame.height / 2 - 40)
                        .animation(.easeInOut(duration: 0.5), value: companionManager.onboardingCardOpacity)
                        .allowsHitTesting(false)
                }

                // Onboarding prompt — shown after video ends
                if companionManager.showOnboardingPrompt && !companionManager.onboardingPromptText.isEmpty {
                    Text(companionManager.onboardingPromptText)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .fill(DS.Colors.senseiOrange)
                                .shadow(color: DS.Colors.senseiOrange.opacity(0.5), radius: 6)
                        )
                        .fixedSize()
                        .opacity(companionManager.onboardingPromptOpacity)
                        .position(x: screenFrame.width / 2, y: screenFrame.height / 2 - 60)
                        .animation(.easeOut(duration: 0.4), value: companionManager.onboardingPromptOpacity)
                }
            }
        }
        .frame(width: screenFrame.width, height: screenFrame.height)
        .ignoresSafeArea()
        .onAppear {
            if isFirstAppearance && isMainScreen {
                withAnimation(.easeIn(duration: 2.0)) { }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                    startWelcomeAnimation()
                }
            }
        }
        .onDisappear {
            companionManager.tearDownOnboarding()
        }
    }

    private func startWelcomeAnimation() {
        withAnimation(.easeIn(duration: 0.4)) { self.bubbleOpacity = 1.0 }
        var currentIndex = 0
        Timer.scheduledTimer(withTimeInterval: 0.03, repeats: true) { timer in
            guard currentIndex < self.fullWelcomeMessage.count else {
                timer.invalidate()
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                    withAnimation(.easeOut(duration: 0.5)) { self.bubbleOpacity = 0.0 }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                    self.showWelcome = false
                    self.companionManager.setupOnboarding()
                }
                return
            }
            let index = self.fullWelcomeMessage.index(self.fullWelcomeMessage.startIndex, offsetBy: currentIndex)
            self.welcomeText.append(self.fullWelcomeMessage[index])
            currentIndex += 1
        }
    }
}

// MARK: - Onboarding Card

/// Explains how Sensei works. Shown centered on screen after the welcome
/// text fades in. Auto-dismissed by CompanionManager after ~10 seconds.
private struct SenseiOnboardingCardView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("how sensei works")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.white)

            VStack(alignment: .leading, spacing: 10) {
                hotkeyRow(shortcut: "ctrl + option", action: "start talking")
                hotkeyRow(shortcut: "ctrl + option", action: "stop")
            }

            Rectangle()
                .fill(Color.white.opacity(0.1))
                .frame(height: 1)

            Text("i help you build in unreal, unity, blender, premiere, autocad, sketch, and figma. ask me anything — i'll guide you step by step.")
                .font(.system(size: 12))
                .foregroundColor(Color.white.opacity(0.65))
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
        }
        .padding(20)
        .frame(width: 300)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(hex: "#1A1C1B"))
                .shadow(color: .black.opacity(0.6), radius: 30, x: 0, y: 10)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
    }

    private func hotkeyRow(shortcut: String, action: String) -> some View {
        HStack(spacing: 10) {
            Text(shortcut)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundColor(DS.Colors.senseiOrange)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(DS.Colors.senseiOrange.opacity(0.15))
                )
            Text("→  \(action)")
                .font(.system(size: 12))
                .foregroundColor(Color.white.opacity(0.70))
        }
    }
}

// MARK: - Preference Key (onboarding bubble sizing)

struct SizePreferenceKey: PreferenceKey {
    static var defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

// MARK: - Overlay Window Manager

@MainActor
class OverlayWindowManager {
    private var overlayWindows: [OverlayWindow] = []
    /// The draggable sensei + bars panel. Nil until the overlay is first shown.
    private var senseiHUDWindow: SenseiHUDWindow?
    var hasShownOverlayBefore = false

    func showOverlay(onScreens screens: [NSScreen], companionManager: CompanionManager) {
        hideOverlay()

        let isFirstAppearance = !hasShownOverlayBefore
        hasShownOverlayBefore = true

        // Full-screen overlay per screen (onboarding content)
        for screen in screens {
            let window = OverlayWindow(screen: screen)
            let contentView = BlueCursorView(
                screenFrame: screen.frame,
                isFirstAppearance: isFirstAppearance,
                companionManager: companionManager
            )
            let hostingView = NSHostingView(rootView: contentView)
            hostingView.frame = screen.frame
            window.contentView = hostingView
            overlayWindows.append(window)
            window.orderFrontRegardless()
        }

        // Draggable sensei HUD — one instance, always on screen
        if senseiHUDWindow == nil {
            senseiHUDWindow = SenseiHUDWindow(companionManager: companionManager)
        }
        senseiHUDWindow?.orderFrontRegardless()
    }

    func hideOverlay() {
        for window in overlayWindows {
            window.orderOut(nil)
            window.contentView = nil
        }
        overlayWindows.removeAll()
        senseiHUDWindow?.orderOut(nil)
    }

    func fadeOutAndHideOverlay(duration: TimeInterval = 0.4) {
        let windowsToFade = overlayWindows
        overlayWindows.removeAll()
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = duration
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            for window in windowsToFade { window.animator().alphaValue = 0 }
            senseiHUDWindow?.animator().alphaValue = 0
        }, completionHandler: {
            for window in windowsToFade { window.orderOut(nil); window.contentView = nil }
            self.senseiHUDWindow?.orderOut(nil)
        })
    }

    func isShowingOverlay() -> Bool { !overlayWindows.isEmpty }
}

