//
//  SubscriptionStatusView.swift
//  leanring-buddy
//
//  Compact status chip shown in the menu bar panel once a license is active.
//  Displays plan, credits used / allowance, and a button to open the account
//  page for subscription management.
//

import SwiftUI

struct SubscriptionStatusView: View {
    @ObservedObject var companionManager: CompanionManager
    @ObservedObject private var licenseManager = LicenseManager.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            topRow
            progressBar
            if let errorMessage = companionManager.licenseErrorMessage {
                errorBanner(message: errorMessage)
            }
            bottomRow
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(DS.Colors.surface2)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(DS.Colors.borderSubtle, lineWidth: 1),
        )
    }

    // MARK: - Top row: plan name + credits fraction

    private var topRow: some View {
        HStack {
            HStack(spacing: 6) {
                Image(systemName: planIconName)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(planIconColor)
                Text(planDisplayName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(DS.Colors.textPrimary)
            }
            Spacer()
            creditsLabel
        }
    }

    private var creditsLabel: some View {
        Group {
            if case .active(_, let used, let allowance, _) = licenseManager.currentState {
                Text("\(formatCredits(used)) / \(formatCredits(allowance))")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundColor(DS.Colors.textSecondary)
            } else {
                EmptyView()
            }
        }
    }

    // MARK: - Progress bar

    private var progressBar: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3)
                    .fill(DS.Colors.surface4)
                RoundedRectangle(cornerRadius: 3)
                    .fill(progressFillColor)
                    .frame(width: geometry.size.width * CGFloat(progressFraction))
            }
        }
        .frame(height: 6)
    }

    // MARK: - Error banner

    private func errorBanner(message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.system(size: 11))
                .foregroundColor(.red)
            Text(message)
                .font(.system(size: 11))
                .foregroundColor(DS.Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Color.red.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    // MARK: - Bottom row: daily usage (trial) + manage button

    private var bottomRow: some View {
        HStack {
            if licenseManager.dailyCap != nil {
                dailyUsageHint
            } else {
                Text(planSubtext)
                    .font(.system(size: 11))
                    .foregroundColor(DS.Colors.textTertiary)
            }
            Spacer()
            manageButton
        }
    }

    private var dailyUsageHint: some View {
        Text("\(minutesUsedToday) / \(dailyCapMinutes) min today")
            .font(.system(size: 11))
            .foregroundColor(DS.Colors.textTertiary)
    }

    private var manageButton: some View {
        Button(action: openManage) {
            Text("Manage")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(DS.Colors.blue400)
        }
        .buttonStyle(.plain)
        .onHover { isHovering in
            if isHovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }

    // MARK: - Derived values

    private var planDisplayName: String {
        guard case .active(let plan, _, _, _) = licenseManager.currentState else { return "Not activated" }
        switch plan {
        case "trial": return "Free Trial"
        case "starter": return "Starter"
        case "ultra": return "Ultra"
        default: return plan.capitalized
        }
    }

    private var planIconName: String {
        guard case .active(let plan, _, _, _) = licenseManager.currentState else { return "questionmark.circle" }
        switch plan {
        case "trial": return "gift.fill"
        case "starter": return "bolt.fill"
        case "ultra": return "star.fill"
        default: return "questionmark.circle"
        }
    }

    private var planIconColor: Color {
        guard case .active(let plan, _, _, _) = licenseManager.currentState else { return DS.Colors.textTertiary }
        switch plan {
        case "trial": return DS.Colors.blue400
        case "starter": return .yellow
        case "ultra": return .purple
        default: return DS.Colors.textTertiary
        }
    }

    private var planSubtext: String {
        guard case .active(let plan, _, _, let maxDevices) = licenseManager.currentState else { return "" }
        if plan == "ultra" {
            return "Shared across \(maxDevices) devices"
        }
        return "\(maxDevices) device"
    }

    private var progressFraction: Double {
        guard case .active(_, let used, let allowance, _) = licenseManager.currentState else { return 0 }
        guard allowance > 0 else { return 0 }
        return min(1.0, Double(used) / Double(allowance))
    }

    private var progressFillColor: Color {
        let fraction = progressFraction
        if fraction > 0.9 { return .red }
        if fraction > 0.75 { return .orange }
        return DS.Colors.blue500
    }

    private var minutesUsedToday: Int {
        licenseManager.dailyUsed / 60
    }

    private var dailyCapMinutes: Int {
        (licenseManager.dailyCap ?? 0) / 60
    }

    private func formatCredits(_ value: Int) -> String {
        if value >= 1000 {
            let kValue = Double(value) / 1000
            return String(format: "%.1fk", kValue)
        }
        return "\(value)"
    }

    private func openManage() {
        // Open the account page where the user can upgrade / change plan.
        if let url = URL(string: "https://atayisensei.com/account") {
            NSWorkspace.shared.open(url)
        }
    }
}
