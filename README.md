# The Last Hour

A local-first, cosmic Google News observatory for macOS, Windows, and Android. The app collects the newest one-hour and 24-hour stories across 29 hand-picked topics without a hosted backend, feed converter, analytics service, or cloud database.

## Download

Installers are available from the [latest GitHub release](https://github.com/jetblackrlsh/The-Last-Hour/releases/latest):

- **macOS (Apple Silicon):** download the `.dmg`, open it, and drag **The Last Hour** into Applications.
- **Windows (64-bit):** download the `.exe` installer and open it.
- **Android:** download the signed `.apk` on the phone and open it. Android may ask you to allow installs from the browser or Files app used to open it.

The macOS build is intentionally unsigned to avoid Apple Developer fees. If Gatekeeper warns on first launch, Control-click the app and choose **Open**.

## What it does

- Focused Feed for browsing one topic at a time
- Ultra Feed combining selected topics
- Super Feed with an infinite 24-hour story stream
- One-hour and 24-hour time windows
- Subject tabs and topic filters
- Direct Google News RSS fetching from each device
- Two-request refresh queue with retry and timeout controls
- Automatic 15-minute refresh while the app is running
- Seven-day private local safety cache
- Local JSON and RSS/XML snapshot exports on macOS and Windows
- On-demand Codex summaries with a seven-day private summary cache on macOS and Windows
- Native read-aloud controls for Codex summaries on macOS and Windows
- A one-button desktop updater that downloads, verifies, installs, and restarts the latest GitHub release
- A Huntsville, Alabama clock and current-weather widget with temperature and WMO sky conditions

Codex summaries reuse the locally installed Codex CLI and its saved sign-in. Install Codex and run `codex login` once if the About panel reports that Codex is unavailable. Summary requests use current web search, so they require internet access and count against the signed-in Codex account's usage.

## Why it is local-first

The original hosted version was unreliable because Google News and public RSS converters inconsistently served requests from shared cloud infrastructure. These apps make requests from the computer or Android phone instead. Successful stories are stored only on that device, so an interrupted refresh does not erase the last useful result.

There is no application server. Google News RSS is not a guaranteed public API, so Google could still change its behavior or feed format in the future. Codex summarization is optional and uses the signed-in user's existing Codex access.

## Project layout

| Path | Purpose |
| --- | --- |
| `main.js`, `preload.js`, `renderer/`, `src/` | Electron desktop application |
| `mobile/` | Mobile interface built with Vite |
| `android/` | Capacitor Android project targeting API 36 |
| `shared/topics.json` | Shared topic groups and search-query overrides |
| `build/` and `assets/` | Desktop and mobile brand artwork |

## Desktop development

Requires Node.js 22 or newer.

```bash
npm install
npm test
npm start
```

Build the Apple Silicon installer:

```bash
npm run dist
```

Build the 64-bit Windows installer and portable ZIP from Windows (or a macOS environment configured for Electron cross-compilation):

```bash
npm run dist:win
```

## Android development

Requires JDK 21, Android SDK Platform 36, Android Build Tools 35, and the Android command-line tools or Android Studio.

```bash
npm install
npm run android:sync
cd android
./gradlew assembleDebug
```

The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.

Release signing credentials are deliberately excluded from the repository. To create a signed release build, set these variables before running `./gradlew assembleRelease`:

```bash
export THE_LAST_HOUR_KEYSTORE_FILE="/absolute/path/to/your-release.jks"
export THE_LAST_HOUR_KEYSTORE_PASSWORD="your-password"
```

The keystore must contain an alias named `the-last-hour`.

## Privacy

The Last Hour has no account system, tracking, advertising, telemetry, or application server. Feed requests go to Google News, and opening a story sends the user to the linked publisher. Cached feed data stays in the application’s private storage on the device. When the user requests a Codex summary, the story metadata and URL are sent through that computer’s signed-in Codex CLI; the resulting summary is cached locally for seven days. The desktop weather widget requests current Huntsville conditions from [Open-Meteo](https://open-meteo.com/) without an API key or device location.

## License

MIT
