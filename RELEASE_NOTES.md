# The Last Hour 1.1.0

This release adds shared desktop intelligence, narration, and one-click updates.

## Included

- On-demand Codex summaries on both macOS and Windows
- Seven-day private summary caching to avoid repeat requests
- Native macOS and Windows text-to-speech playback with stop/restart controls
- A one-button updater in the About panel
- Platform-aware download selection for Apple Silicon macOS ZIPs and Windows installers
- SHA-256 verification before any downloaded update is installed
- Automatic restart after a successful desktop update
- macOS and Windows release build targets with consistent artifact names
- A live Huntsville clock in `HH:MM AM/PM MM/DD/YYYY` format
- A built-in Open-Meteo widget for current Huntsville temperature and sky conditions

Codex summaries reuse the local Codex CLI sign-in; no OpenAI key is stored by The Last Hour.

---

# The Last Hour 1.0.0

The first public local-first release of The Last Hour.

## Included

- Apple Silicon macOS Electron application
- Signed Android APK for Android 7 and newer, including Pixel devices
- Focused, Ultra, and infinite-scroll Super feeds
- One-hour and 24-hour views across 29 favorite topics
- Direct device-to-Google News RSS fetching
- Local seven-day cache and controlled background refresh queue
- Topic filters and cosmic black, purple, blue, lavender, gold, and neon-white interface

No hosted backend, paid API, analytics, advertising, or cloud database is used.
