#!/bin/bash
set -euo pipefail

# Add Homebrew to PATH so create-dmg / xcodebuild / codesign are found in
# non-interactive shells.
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# =============================================================================
# release.sh — Atayi Sensei macOS distribution pipeline
#
# Three build modes:
#   - `./scripts/release.sh`                → build unsigned DMG (default for
#                                             alpha/beta without Developer ID)
#   - `./scripts/release.sh developer-id`   → build signed + notarized DMG
#                                             (requires Apple Developer Program)
#   - `./scripts/release.sh clean`          → wipe the build/ directory and exit
#
# The unsigned DMG works for local distribution to testers who know to
# right-click → Open the first time (Gatekeeper will block double-click).
# Once the user's Apple Developer Program enrollment completes, rerun with
# `developer-id` to produce a notarized DMG that installs without friction.
#
# Outputs:
#   - app/build/AtayiSensei.app    Exported application bundle
#   - app/releases/Atayi-Sensei-<version>.dmg    Final DMG ready to share
#
# Prerequisites:
#   - Xcode 16+ with command-line tools
#   - `brew install create-dmg` (Homebrew)
#   - (for developer-id mode) Apple Developer ID Application cert in Keychain
#   - (for developer-id mode) `xcrun notarytool store-credentials "AC_PASSWORD"`
# =============================================================================

MODE="${1:-unsigned}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
XCODE_PROJECT="${PROJECT_DIR}/leanring-buddy.xcodeproj"
SCHEME="leanring-buddy"
BUILD_DIR="${PROJECT_DIR}/build"
ARCHIVE_PATH="${BUILD_DIR}/AtayiSensei.xcarchive"
EXPORT_DIR="${BUILD_DIR}/export"
RELEASES_DIR="${PROJECT_DIR}/releases"
APP_NAME="Clicky"  # the scheme exports as "Clicky.app" since that's the product bundle name
DISPLAY_NAME="Atayi Sensei"

if [ "${MODE}" = "clean" ]; then
    echo "🧹 Cleaning build directory…"
    rm -rf "${BUILD_DIR}"
    echo "✅ Done."
    exit 0
fi

mkdir -p "${BUILD_DIR}" "${EXPORT_DIR}" "${RELEASES_DIR}"

# ── Version detection ───────────────────────────────────────────────────────
# Read MARKETING_VERSION from the Release config in project.pbxproj.
# Bump the build number automatically based on the Release CURRENT_PROJECT_VERSION.

MARKETING_VERSION=$(awk '/MARKETING_VERSION = / { gsub(/[;,]/, "", $3); print $3; exit }' "${XCODE_PROJECT}/project.pbxproj")
MARKETING_VERSION="${MARKETING_VERSION:-0.1.0}"
BUILD_NUMBER=$(date +%Y%m%d%H%M)

echo "📦 ${DISPLAY_NAME} v${MARKETING_VERSION} build ${BUILD_NUMBER} (${MODE})"
echo ""

# ── Step 1: Archive ─────────────────────────────────────────────────────────

echo "📥 [1/4] Archiving…"
rm -rf "${ARCHIVE_PATH}"

if [ "${MODE}" = "developer-id" ]; then
    # Full Developer ID signing path. Requires paid Apple Developer Program.
    xcodebuild archive \
        -project "${XCODE_PROJECT}" \
        -scheme "${SCHEME}" \
        -configuration Release \
        -archivePath "${ARCHIVE_PATH}" \
        -destination "generic/platform=macOS" \
        CURRENT_PROJECT_VERSION="${BUILD_NUMBER}" \
        MARKETING_VERSION="${MARKETING_VERSION}" \
        CODE_SIGN_STYLE=Automatic
else
    # Unsigned-ish build: we let Xcode apply its default ad-hoc signing.
    # The installed Apple Development cert is enough for the archive step;
    # the resulting .app will work on the developer's own Mac and can be
    # zipped/dmg'd for manual distribution to testers.
    xcodebuild archive \
        -project "${XCODE_PROJECT}" \
        -scheme "${SCHEME}" \
        -configuration Release \
        -archivePath "${ARCHIVE_PATH}" \
        -destination "generic/platform=macOS" \
        CURRENT_PROJECT_VERSION="${BUILD_NUMBER}" \
        MARKETING_VERSION="${MARKETING_VERSION}"
fi

echo "    ✅ Archive at ${ARCHIVE_PATH}"

# ── Step 2: Export .app ─────────────────────────────────────────────────────

echo "📤 [2/4] Exporting .app…"
rm -rf "${EXPORT_DIR}"
mkdir -p "${EXPORT_DIR}"

# Write a throwaway exportOptions.plist matching the build mode.
EXPORT_OPTIONS="${BUILD_DIR}/exportOptions.plist"
if [ "${MODE}" = "developer-id" ]; then
cat > "${EXPORT_OPTIONS}" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>developer-id</string>
    <key>signingStyle</key>
    <string>automatic</string>
</dict>
</plist>
EOF
else
    # Xcode 15+ accepts "mac-application" for unsigned / development exports.
cat > "${EXPORT_OPTIONS}" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>mac-application</string>
</dict>
</plist>
EOF
fi

xcodebuild -exportArchive \
    -archivePath "${ARCHIVE_PATH}" \
    -exportPath "${EXPORT_DIR}" \
    -exportOptionsPlist "${EXPORT_OPTIONS}"

EXPORTED_APP="${EXPORT_DIR}/${APP_NAME}.app"
if [ ! -d "${EXPORTED_APP}" ]; then
    echo "❌ Expected .app at ${EXPORTED_APP} not found. Contents of export dir:"
    ls -la "${EXPORT_DIR}"
    exit 1
fi

# Rename "Clicky.app" to "Atayi Sensei.app" on disk for user clarity
FINAL_APP="${EXPORT_DIR}/${DISPLAY_NAME}.app"
if [ ! -d "${FINAL_APP}" ]; then
    mv "${EXPORTED_APP}" "${FINAL_APP}"
fi

echo "    ✅ Exported to ${FINAL_APP}"

# ── Step 3 (developer-id only): Notarize ────────────────────────────────────

if [ "${MODE}" = "developer-id" ]; then
    echo "🔏 [3/4] Notarizing with Apple (this takes 2-5 minutes)…"
    NOTARIZE_ZIP="${BUILD_DIR}/AtayiSensei-notarize.zip"
    rm -f "${NOTARIZE_ZIP}"
    ditto -c -k --keepParent "${FINAL_APP}" "${NOTARIZE_ZIP}"

    xcrun notarytool submit "${NOTARIZE_ZIP}" \
        --keychain-profile "AC_PASSWORD" \
        --wait

    xcrun stapler staple "${FINAL_APP}"
    echo "    ✅ Notarized + stapled"
else
    echo "⏭️  [3/4] Skipping notarization (unsigned mode)"
fi

# ── Step 4: Build DMG ───────────────────────────────────────────────────────

echo "📀 [4/4] Building DMG…"
DMG_NAME="Atayi-Sensei-${MARKETING_VERSION}.dmg"
DMG_PATH="${RELEASES_DIR}/${DMG_NAME}"
rm -f "${DMG_PATH}"

# Generate a .icns volume icon from the MYE4a image asset (Atayi Sensei logo)
# so the mounted DMG shows the branded icon in Finder.
ICON_SOURCE="${PROJECT_DIR}/leanring-buddy/Assets.xcassets/MYE4a.imageset/MYE4a.jpg"
ICON_WORK_DIR="${BUILD_DIR}/icon"
ICONSET="${ICON_WORK_DIR}/AtayiSensei.iconset"
VOLUME_ICNS="${ICON_WORK_DIR}/AtayiSensei.icns"
if [ -f "${ICON_SOURCE}" ]; then
    rm -rf "${ICONSET}"
    mkdir -p "${ICONSET}"
    for ICON_SIZE in 16 32 64 128 256 512; do
        HD_SIZE=$((ICON_SIZE * 2))
        sips -z ${ICON_SIZE} ${ICON_SIZE} "${ICON_SOURCE}" --out "${ICONSET}/icon_${ICON_SIZE}x${ICON_SIZE}.png" > /dev/null 2>&1
        sips -z ${HD_SIZE} ${HD_SIZE} "${ICON_SOURCE}" --out "${ICONSET}/icon_${ICON_SIZE}x${ICON_SIZE}@2x.png" > /dev/null 2>&1
    done
    iconutil -c icns "${ICONSET}" -o "${VOLUME_ICNS}"
    echo "    🎨 Generated ${VOLUME_ICNS} from MYE4a.jpg"
fi

DMG_OPTIONS=(
    --volname "${DISPLAY_NAME}"
    --window-pos 200 120
    --window-size 600 400
    --icon-size 100
    --icon "${DISPLAY_NAME}.app" 150 180
    --hide-extension "${DISPLAY_NAME}.app"
    --app-drop-link 450 180
    --no-internet-enable
)

if [ -f "${VOLUME_ICNS}" ]; then
    DMG_OPTIONS+=(--volicon "${VOLUME_ICNS}")
fi

if [ -f "${PROJECT_DIR}/dmg-background.png" ]; then
    DMG_OPTIONS+=(--background "${PROJECT_DIR}/dmg-background.png")
fi

create-dmg "${DMG_OPTIONS[@]}" "${DMG_PATH}" "${FINAL_APP}"

echo ""
echo "🎉 ${DISPLAY_NAME} v${MARKETING_VERSION} DMG ready:"
echo "    ${DMG_PATH}"
echo ""

if [ "${MODE}" != "developer-id" ]; then
    echo "⚠️  This DMG is NOT signed with Developer ID + notarized."
    echo "   Testers will need to right-click → Open the first time they"
    echo "   launch the app (Gatekeeper will otherwise say 'cannot be opened')."
    echo ""
    echo "   When your Apple Developer Program enrollment is active and you"
    echo "   have a 'Developer ID Application' cert in Keychain, rerun with:"
    echo "       ./scripts/release.sh developer-id"
    echo ""
fi

echo "Upload to Cloudflare R2 when ready:"
echo "    cd worker && npx wrangler r2 object put atayi-downloads/${DMG_NAME} --file ${DMG_PATH}"
