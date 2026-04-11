//
//  BuddyPushToTalkShortcut.swift
//  leanring-buddy
//
//  Push-to-talk shortcut detection. The shortcut is ctrl+option — a
//  modifier-only combo that fires on .flagsChanged events.
//

import AppKit
import CoreGraphics
import Foundation

enum BuddyPushToTalkShortcut {
    enum ShortcutTransition {
        case none
        case pressed
        case released
    }

    /// Modifier flags for the push-to-talk shortcut (ctrl + option).
    private static let modifierOnlyFlags: NSEvent.ModifierFlags = [.control, .option]

    /// Derives the press/release transition from a low-level CGEvent in the
    /// global event tap. Only `.flagsChanged` events matter here because the
    /// shortcut is modifier-only.
    static func shortcutTransition(
        for eventType: CGEventType,
        keyCode: UInt16,
        modifierFlagsRawValue: UInt64,
        wasShortcutPreviouslyPressed: Bool
    ) -> ShortcutTransition {
        guard eventType == .flagsChanged else { return .none }

        let currentModifierFlags = NSEvent.ModifierFlags(rawValue: UInt(modifierFlagsRawValue))
            .intersection(.deviceIndependentFlagsMask)
        let isShortcutCurrentlyPressed = currentModifierFlags.contains(modifierOnlyFlags)

        if isShortcutCurrentlyPressed && !wasShortcutPreviouslyPressed {
            return .pressed
        }

        if !isShortcutCurrentlyPressed && wasShortcutPreviouslyPressed {
            return .released
        }

        return .none
    }
}
