//
//  DeviceFingerprint.swift
//  leanring-buddy
//
//  Reads the hardware-level IOPlatformUUID via IOKit, hashes it with SHA-256,
//  and exposes it as a stable, anonymous device fingerprint used to bind a
//  license code to this exact Mac.
//
//  Why hash the UUID?
//  - The raw IOPlatformUUID is a PII-like machine identifier. Hashing it
//    means the worker/database never stores the raw value, only an opaque
//    32-byte hex string. If the DB ever leaks, the original UUID is
//    unrecoverable without a rainbow table of every possible UUID.
//  - Two different Macs produce two different hashes, same Mac always
//    produces the same hash — exactly what a device-binding system needs.
//
//  Why not just random UUID stored in UserDefaults?
//  - UserDefaults gets wiped if the app is reinstalled → the user would
//    look like a brand new device and burn through their device slots.
//    IOPlatformUUID survives reinstalls, OS updates, even reformats of
//    the user partition on modern macOS.
//

import CryptoKit
import Foundation
import IOKit

enum DeviceFingerprint {
    /// Returns a stable 64-char hex SHA-256 hash of this Mac's IOPlatformUUID,
    /// or nil if IOKit cannot read the UUID (extremely rare, would indicate a
    /// locked-down environment or a developer VM).
    static func currentFingerprint() -> String? {
        guard let rawPlatformUUID = readIOPlatformUUID() else {
            return nil
        }

        let hashedBytes = SHA256.hash(data: Data(rawPlatformUUID.utf8))
        return hashedBytes.map { String(format: "%02x", $0) }.joined()
    }

    /// Human-readable label for this Mac, shown to the user in the device
    /// list (e.g. "Kevin's MacBook Pro"). Falls back to the host name if
    /// the `ComputerName` preference isn't readable.
    static func currentDeviceName() -> String {
        if let computerName = Host.current().localizedName, !computerName.isEmpty {
            return computerName
        }
        return Host.current().name ?? "Unknown Mac"
    }

    /// Current macOS version as a marketing string (e.g. "macOS 14.5").
    /// Sent to the worker alongside the fingerprint so the admin dashboard
    /// can surface which OS versions are in the wild.
    static func currentOSVersion() -> String {
        let osVersion = ProcessInfo.processInfo.operatingSystemVersion
        return "macOS \(osVersion.majorVersion).\(osVersion.minorVersion).\(osVersion.patchVersion)"
    }

    /// Current app marketing version, read from the bundle.
    static func currentAppVersion() -> String {
        let bundleVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        return bundleVersion
    }

    // MARK: - Private: IOKit access

    private static func readIOPlatformUUID() -> String? {
        let platformExpertService = IOServiceGetMatchingService(
            kIOMainPortDefault,
            IOServiceMatching("IOPlatformExpertDevice"),
        )
        guard platformExpertService != 0 else { return nil }
        defer { IOObjectRelease(platformExpertService) }

        guard let uuidCFTypeRef = IORegistryEntryCreateCFProperty(
            platformExpertService,
            "IOPlatformUUID" as CFString,
            kCFAllocatorDefault,
            0,
        )?.takeRetainedValue() else {
            return nil
        }

        return uuidCFTypeRef as? String
    }
}
