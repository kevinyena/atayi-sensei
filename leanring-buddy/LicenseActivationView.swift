//
//  LicenseActivationView.swift
//  leanring-buddy
//
//  Full-bleed view shown in the menu bar panel when the user has not yet
//  activated a license code on this device. Two paths:
//    1. Paste a license code (from trial signup or Stripe checkout) and activate.
//    2. Open the landing page to start a trial or subscribe.
//

import SwiftUI

struct LicenseActivationView: View {
    @ObservedObject var companionManager: CompanionManager
    @ObservedObject private var licenseManager = LicenseManager.shared

    @State private var licenseCodeInput: String = ""
    @State private var isActivating: Bool = false
    @State private var activationErrorMessage: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            inputField
            activateButton
            if let activationErrorMessage {
                errorBanner(message: activationErrorMessage)
            }
            Divider().background(DS.Colors.borderSubtle)
            noCodeYetFooter
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 18)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Activate Atayi Sensei")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(DS.Colors.textPrimary)
            Text("Paste the license code you received after signing up or subscribing.")
                .font(.system(size: 12))
                .foregroundColor(DS.Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Input field

    private var inputField: some View {
        TextField("ATAYI-XXXX-XXXX-XXXX-XXXX", text: $licenseCodeInput)
            .textFieldStyle(.plain)
            .font(.system(size: 13, design: .monospaced))
            .foregroundColor(DS.Colors.textPrimary)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color.white.opacity(0.12))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(DS.Colors.borderSubtle, lineWidth: 1),
            )
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .onSubmit {
                Task { await activate() }
            }
            .disabled(isActivating)
    }

    // MARK: - Activate button

    private var activateButton: some View {
        Button(action: {
            Task { await activate() }
        }) {
            HStack(spacing: 8) {
                if isActivating {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .scaleEffect(0.6)
                        .tint(.white)
                }
                Text(isActivating ? "Activating…" : "Activate")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.white)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(licenseCodeInput.isEmpty ? DS.Colors.blue600.opacity(0.5) : DS.Colors.blue600)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(licenseCodeInput.isEmpty || isActivating)
    }

    // MARK: - Error banner

    private func errorBanner(message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(.red)
                .font(.system(size: 11))
            Text(message)
                .font(.system(size: 11))
                .foregroundColor(DS.Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color.red.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    // MARK: - Footer

    private var noCodeYetFooter: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Don't have a code yet?")
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(DS.Colors.textSecondary)
            Button(action: openLandingPage) {
                HStack(spacing: 6) {
                    Image(systemName: "safari")
                        .font(.system(size: 11))
                    Text("Start a 7-day free trial")
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundColor(DS.Colors.blue400)
            }
            .buttonStyle(.plain)
            .onHover { isHovering in
                if isHovering {
                    NSCursor.pointingHand.push()
                } else {
                    NSCursor.pop()
                }
            }
        }
    }

    // MARK: - Actions

    private func activate() async {
        guard !licenseCodeInput.isEmpty else { return }
        isActivating = true
        activationErrorMessage = nil
        let result = await licenseManager.activateLicenseCode(licenseCodeInput)
        isActivating = false
        switch result {
        case .success:
            // The panel view automatically switches based on licenseManager.currentState,
            // so we don't need to manually dismiss anything here.
            licenseCodeInput = ""
        case .failure(let error):
            activationErrorMessage = error.localizedDescription
        }
    }

    private func openLandingPage() {
        // Point at the public landing page — eventually this will be the custom
        // domain, for now .pages.dev.
        if let url = URL(string: "https://atayisensei.com/") {
            NSWorkspace.shared.open(url)
        }
    }
}
