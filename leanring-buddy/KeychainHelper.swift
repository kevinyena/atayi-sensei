//
//  KeychainHelper.swift
//  leanring-buddy
//
//  Thin wrapper around the macOS Keychain for storing secrets the app
//  needs to survive relaunches. Used to persist the `device_token` JWT
//  returned by the worker after license activation.
//
//  Why Keychain and not UserDefaults?
//  - UserDefaults is plain text on disk. Anyone with file-system access
//    can read it. A stolen JWT in UserDefaults could be reused from a
//    different machine.
//  - Keychain items marked `.whenUnlockedThisDeviceOnly` are encrypted
//    at rest, tied to the current Mac's Secure Enclave keys, and never
//    synced to iCloud. If someone clones the user's home directory to
//    another machine, the token won't decrypt.
//

import Foundation
import Security

enum KeychainHelper {
    private static let serviceName = "com.atayisensei.app"

    enum KeychainError: Error {
        case notFound
        case unexpectedData
        case osStatus(OSStatus)
    }

    /// Save a string value to the Keychain under the given account key.
    /// Overwrites any existing value at the same key.
    static func saveString(_ value: String, forAccount accountKey: String) throws {
        guard let valueData = value.data(using: .utf8) else {
            throw KeychainError.unexpectedData
        }
        try saveData(valueData, forAccount: accountKey)
    }

    static func saveData(_ valueData: Data, forAccount accountKey: String) throws {
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: accountKey,
        ]

        // Try update first — if the item already exists, this is the fast path.
        let updateAttributes: [String: Any] = [
            kSecValueData as String: valueData,
        ]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, updateAttributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        if updateStatus != errSecItemNotFound {
            throw KeychainError.osStatus(updateStatus)
        }

        // Doesn't exist yet — add a new item.
        var addQuery = baseQuery
        addQuery[kSecValueData as String] = valueData
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        if addStatus != errSecSuccess {
            throw KeychainError.osStatus(addStatus)
        }
    }

    /// Read a string value from the Keychain, or nil if not found.
    static func readString(forAccount accountKey: String) -> String? {
        guard let valueData = readData(forAccount: accountKey) else { return nil }
        return String(data: valueData, encoding: .utf8)
    }

    static func readData(forAccount accountKey: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: accountKey,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
        ]
        var resultRef: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &resultRef)
        if status == errSecItemNotFound { return nil }
        if status != errSecSuccess { return nil }
        return resultRef as? Data
    }

    /// Delete a stored value. Idempotent (no-op if the item doesn't exist).
    static func delete(forAccount accountKey: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: accountKey,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

enum KeychainAccount {
    static let deviceToken = "atayi.device_token"
    static let licenseCode = "atayi.license_code" // stored for display in the panel, not for auth
}
