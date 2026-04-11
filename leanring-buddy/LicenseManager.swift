//
//  LicenseManager.swift
//  leanring-buddy
//
//  Handles the full license lifecycle client-side:
//    1. Activate a license code + current device fingerprint against the
//       worker → receive a JWT device_token, store it in Keychain.
//    2. On app launch, load the cached device_token and hit /api/license/status
//       to verify the subscription is still active and learn current credits.
//    3. Before each Gemini Live session, call /api/session/preflight to get
//       a short-lived session_token + ws_url.
//    4. Surface state through @Published properties that the panel UI binds to.
//

import Combine
import Foundation

@MainActor
final class LicenseManager: ObservableObject {

    // MARK: - Shared instance

    static let shared = LicenseManager()

    // MARK: - Published state

    enum LicenseState: Equatable {
        case unknown                                    // not yet loaded from disk
        case notActivated                               // no token stored
        case activating                                 // POST /api/license/activate in flight
        case active(plan: String, creditsUsed: Int, creditsAllowance: Int, maxDevices: Int)
        case expired(reason: String)                    // trial expired / subscription canceled
        case blocked(reason: String)                    // admin blocked
        case error(message: String)                     // transient network/server error
    }

    @Published private(set) var currentState: LicenseState = .unknown
    @Published private(set) var dailyUsed: Int = 0
    @Published private(set) var dailyCap: Int? = nil

    // MARK: - Configuration

    private let workerBaseURL: String

    private init() {
        self.workerBaseURL = AppBundleConfiguration.stringValue(forKey: "AtayiWorkerBaseURL")
            ?? "https://clicky-proxy.kevinyena9.workers.dev"
    }

    // MARK: - Cached token access

    var cachedDeviceToken: String? {
        return KeychainHelper.readString(forAccount: KeychainAccount.deviceToken)
    }

    var cachedLicenseCode: String? {
        return KeychainHelper.readString(forAccount: KeychainAccount.licenseCode)
    }

    var isActivated: Bool {
        if case .active = currentState { return true }
        return false
    }

    // MARK: - App-launch hydration

    /// Called from CompanionAppDelegate during applicationDidFinishLaunching.
    /// If a device_token is cached, hit /api/license/status to refresh state.
    /// Otherwise mark as notActivated so the panel shows the activation UI.
    func hydrateFromCache() async {
        guard let token = cachedDeviceToken else {
            currentState = .notActivated
            return
        }
        await refreshStatus(usingToken: token)
    }

    // MARK: - Activation flow

    /// Binds a license code to this device. On success, stores the JWT
    /// device_token in Keychain and updates `currentState` to `.active`.
    func activateLicenseCode(_ rawLicenseCode: String) async -> Result<Void, LicenseError> {
        currentState = .activating

        let normalizedCode = rawLicenseCode.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard let deviceFingerprint = DeviceFingerprint.currentFingerprint() else {
            currentState = .error(message: "Could not read device fingerprint")
            return .failure(.fingerprintUnavailable)
        }

        let requestBody: [String: Any] = [
            "license_code": normalizedCode,
            "device_fingerprint": deviceFingerprint,
            "device_name": DeviceFingerprint.currentDeviceName(),
            "os_version": DeviceFingerprint.currentOSVersion(),
            "app_version": DeviceFingerprint.currentAppVersion(),
        ]

        do {
            let (responseJSON, statusCode) = try await postJSON(
                path: "/api/license/activate",
                body: requestBody,
                authorizationHeader: nil,
            )

            if statusCode == 200 {
                guard
                    let deviceToken = responseJSON["device_token"] as? String,
                    let plan = responseJSON["plan"] as? String,
                    let creditsUsed = responseJSON["credits_used"] as? Int,
                    let creditsAllowance = responseJSON["credits_allowance"] as? Int,
                    let maxDevices = responseJSON["max_devices"] as? Int
                else {
                    currentState = .error(message: "Server response missing required fields")
                    return .failure(.malformedResponse)
                }

                try? KeychainHelper.saveString(deviceToken, forAccount: KeychainAccount.deviceToken)
                try? KeychainHelper.saveString(normalizedCode, forAccount: KeychainAccount.licenseCode)

                currentState = .active(
                    plan: plan,
                    creditsUsed: creditsUsed,
                    creditsAllowance: creditsAllowance,
                    maxDevices: maxDevices,
                )
                return .success(())
            }

            // Translate server error codes into typed errors
            let errorCode = responseJSON["error"] as? String ?? "unknown_error"
            let errorMessage = responseJSON["message"] as? String ?? "Activation failed"

            switch errorCode {
            case "invalid_license":
                currentState = .error(message: "License code not recognized")
                return .failure(.invalidLicense)
            case "subscription_inactive", "trial_expired":
                currentState = .expired(reason: errorMessage)
                return .failure(.subscriptionInactive(errorMessage))
            case "device_limit_reached":
                let activeDeviceCount = responseJSON["active_devices"] as? Int ?? 0
                let maxDevices = responseJSON["max_devices"] as? Int ?? 1
                currentState = .error(message: errorMessage)
                return .failure(.deviceLimitReached(active: activeDeviceCount, max: maxDevices))
            case "device_blocked", "account_blocked":
                currentState = .blocked(reason: errorMessage)
                return .failure(.blocked(errorMessage))
            default:
                currentState = .error(message: errorMessage)
                return .failure(.serverError(errorMessage))
            }
        } catch {
            currentState = .error(message: error.localizedDescription)
            return .failure(.networkError(error.localizedDescription))
        }
    }

    /// Forgets the cached license on this device. Used when the user wants
    /// to activate a different license code, or for debugging.
    func signOut() {
        KeychainHelper.delete(forAccount: KeychainAccount.deviceToken)
        KeychainHelper.delete(forAccount: KeychainAccount.licenseCode)
        currentState = .notActivated
    }

    // MARK: - Status refresh

    /// Hits GET /api/license/status with the cached token. Updates the local
    /// state to match what the server thinks. Called at app launch and after
    /// notable events (session close, etc.)
    func refreshStatus() async {
        guard let token = cachedDeviceToken else {
            currentState = .notActivated
            return
        }
        await refreshStatus(usingToken: token)
    }

    private func refreshStatus(usingToken token: String) async {
        do {
            let (responseJSON, statusCode) = try await getJSON(
                path: "/api/license/status",
                authorizationHeader: "Bearer \(token)",
            )

            if statusCode == 200 {
                guard
                    let plan = responseJSON["plan"] as? String,
                    let creditsUsed = responseJSON["credits_used"] as? Int,
                    let creditsAllowance = responseJSON["credits_allowance"] as? Int
                else {
                    currentState = .error(message: "Server response missing required fields")
                    return
                }
                let maxDevices = responseJSON["max_devices"] as? Int ?? 1
                currentState = .active(
                    plan: plan,
                    creditsUsed: creditsUsed,
                    creditsAllowance: creditsAllowance,
                    maxDevices: maxDevices,
                )
                self.dailyUsed = responseJSON["daily_used"] as? Int ?? 0
                self.dailyCap = responseJSON["daily_cap"] as? Int
                return
            }

            let errorCode = responseJSON["error"] as? String ?? "unknown_error"
            let errorMessage = responseJSON["message"] as? String ?? "Status check failed"

            switch errorCode {
            case "subscription_inactive", "trial_expired":
                currentState = .expired(reason: errorMessage)
            case "device_blocked", "account_blocked":
                currentState = .blocked(reason: errorMessage)
                // Forget the token because the server has explicitly revoked this device
                KeychainHelper.delete(forAccount: KeychainAccount.deviceToken)
            case "unauthorized":
                // Token expired or invalid — force re-activation
                currentState = .notActivated
                KeychainHelper.delete(forAccount: KeychainAccount.deviceToken)
            default:
                currentState = .error(message: errorMessage)
            }
        } catch {
            currentState = .error(message: error.localizedDescription)
        }
    }

    // MARK: - Session preflight

    struct SessionPreflightResult {
        let sessionId: String
        let wsURL: String
        let sessionToken: String
        let creditsRemaining: Int
        let dailyRemaining: Int?
        let plan: String
    }

    /// Called by CompanionManager just before opening the Gemini Live WebSocket.
    /// Hits POST /api/session/preflight with the cached device_token and returns
    /// the session token + WS URL so the client can connect to the Durable Object.
    func preflightSession() async -> Result<SessionPreflightResult, LicenseError> {
        guard let token = cachedDeviceToken else {
            return .failure(.notActivated)
        }

        do {
            let (responseJSON, statusCode) = try await postJSON(
                path: "/api/session/preflight",
                body: [:],
                authorizationHeader: "Bearer \(token)",
            )

            if statusCode == 200 {
                guard
                    let sessionId = responseJSON["session_id"] as? String,
                    let wsURL = responseJSON["ws_url"] as? String,
                    let sessionToken = responseJSON["session_token"] as? String,
                    let creditsRemaining = responseJSON["credits_remaining"] as? Int,
                    let plan = responseJSON["plan"] as? String
                else {
                    return .failure(.malformedResponse)
                }
                let dailyRemaining = responseJSON["daily_remaining"] as? Int
                return .success(SessionPreflightResult(
                    sessionId: sessionId,
                    wsURL: wsURL,
                    sessionToken: sessionToken,
                    creditsRemaining: creditsRemaining,
                    dailyRemaining: dailyRemaining,
                    plan: plan,
                ))
            }

            let errorCode = responseJSON["error"] as? String ?? "unknown_error"
            let errorMessage = responseJSON["message"] as? String ?? "Session preflight failed"

            switch errorCode {
            case "subscription_inactive", "trial_expired":
                currentState = .expired(reason: errorMessage)
                return .failure(.subscriptionInactive(errorMessage))
            case "credits_exhausted":
                return .failure(.creditsExhausted)
            case "daily_cap_reached":
                return .failure(.dailyCapReached)
            case "device_blocked", "account_blocked":
                currentState = .blocked(reason: errorMessage)
                return .failure(.blocked(errorMessage))
            case "unauthorized":
                currentState = .notActivated
                return .failure(.notActivated)
            default:
                return .failure(.serverError(errorMessage))
            }
        } catch {
            return .failure(.networkError(error.localizedDescription))
        }
    }

    // MARK: - HTTP helpers

    private func postJSON(
        path: String,
        body: [String: Any],
        authorizationHeader: String?,
    ) async throws -> (json: [String: Any], statusCode: Int) {
        guard let requestURL = URL(string: "\(workerBaseURL)\(path)") else {
            throw LicenseError.invalidWorkerURL
        }
        var request = URLRequest(url: requestURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let authorizationHeader {
            request.setValue(authorizationHeader, forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (responseData, httpResponse) = try await URLSession.shared.data(for: request)
        guard let httpStatusResponse = httpResponse as? HTTPURLResponse else {
            throw LicenseError.networkError("No HTTP response")
        }
        let parsedJSON = (try? JSONSerialization.jsonObject(with: responseData)) as? [String: Any] ?? [:]
        return (parsedJSON, httpStatusResponse.statusCode)
    }

    private func getJSON(
        path: String,
        authorizationHeader: String?,
    ) async throws -> (json: [String: Any], statusCode: Int) {
        guard let requestURL = URL(string: "\(workerBaseURL)\(path)") else {
            throw LicenseError.invalidWorkerURL
        }
        var request = URLRequest(url: requestURL)
        request.httpMethod = "GET"
        if let authorizationHeader {
            request.setValue(authorizationHeader, forHTTPHeaderField: "Authorization")
        }
        let (responseData, httpResponse) = try await URLSession.shared.data(for: request)
        guard let httpStatusResponse = httpResponse as? HTTPURLResponse else {
            throw LicenseError.networkError("No HTTP response")
        }
        let parsedJSON = (try? JSONSerialization.jsonObject(with: responseData)) as? [String: Any] ?? [:]
        return (parsedJSON, httpStatusResponse.statusCode)
    }
}

enum LicenseError: Error, LocalizedError {
    case invalidWorkerURL
    case fingerprintUnavailable
    case notActivated
    case invalidLicense
    case malformedResponse
    case subscriptionInactive(String)
    case deviceLimitReached(active: Int, max: Int)
    case blocked(String)
    case creditsExhausted
    case dailyCapReached
    case networkError(String)
    case serverError(String)

    var errorDescription: String? {
        switch self {
        case .invalidWorkerURL:
            return "Worker URL is misconfigured"
        case .fingerprintUnavailable:
            return "Could not read this Mac's hardware identifier"
        case .notActivated:
            return "No license activated on this device"
        case .invalidLicense:
            return "License code not recognized"
        case .malformedResponse:
            return "Server response was malformed"
        case .subscriptionInactive(let reason):
            return reason
        case .deviceLimitReached(let active, let max):
            return "This license is already active on \(active) of \(max) devices"
        case .blocked(let reason):
            return reason
        case .creditsExhausted:
            return "Monthly credits exhausted. Upgrade your plan to continue."
        case .dailyCapReached:
            return "Daily trial cap reached. Come back tomorrow or upgrade."
        case .networkError(let message):
            return "Network error: \(message)"
        case .serverError(let message):
            return "Server error: \(message)"
        }
    }
}
