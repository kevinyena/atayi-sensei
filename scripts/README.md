# Release Scripts

## `release.sh`

Automates the full release pipeline for the macOS app: build → sign → DMG → notarize → Sparkle appcast → GitHub Release.

> ⚠️ **Legacy status.** This script was inherited from the upstream `makesomething`/`clicky` pipeline and still contains hardcoded references to that project:
>
> - `APP_NAME="makesomething"`
> - `GITHUB_REPO="julianjear/makesomething-mac-app"` (an external releases repo)
> - Release notes and appcast paths all point at the old repo
>
> Before running it for Atayi Sensei you need to rewrite these constants (and probably the Sparkle appcast push logic) to point at your own app name, your own GitHub release repo, and your own signing identity. Don't run it as-is.

### What the pipeline does (for reference)

1. Fetches the latest release from GitHub to determine the next version + build number
2. Archives the app via `xcodebuild`
3. Exports a signed `.app` with Developer ID
4. Creates a DMG with the drag-to-Applications background (`dmg-background.png` at the app root)
5. Notarizes the DMG with Apple
6. Signs the DMG with the Sparkle EdDSA key
7. Generates `appcast.xml` for Sparkle auto-updates
8. Creates a GitHub Release with the DMG attached
9. Pushes the updated `appcast.xml` to the releases repo

### Prerequisites if you adapt it

1. **Xcode** with a Developer ID signing certificate
2. **Homebrew tools**: `brew install create-dmg gh`
3. **GitHub CLI auth**: `gh auth login`
4. **Apple notarization credentials** stored in Keychain:
   ```bash
   xcrun notarytool store-credentials "AC_PASSWORD" \
       --apple-id YOUR_APPLE_ID \
       --team-id YOUR_TEAM_ID
   ```
   (Generate an app-specific password at [appleid.apple.com](https://appleid.apple.com).)
5. **Sparkle EdDSA key** stored in Keychain (generated once during Sparkle setup)
6. **Build the project in Xcode at least once** so SPM downloads Sparkle and the Sparkle CLI tools become available
