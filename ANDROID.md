# Netcatty Android (experimental, Capacitor)

The React UI and the Catty agent loop run unchanged in a WebView. Electron's main-process
services are replaced by a native plugin (`android/.../NetcattyNativePlugin.kt`) behind the same
`window.netcatty` API (`infrastructure/android/androidBridge.ts`, a no-op outside Android).

Implemented: SSH shell sessions, AI tool execution (`aiExec`, over an SSH exec channel), streaming
OpenAI-compatible requests (SSE), Keystore-backed credentials, foreground-service keep-alive.
Not yet: SFTP, port forwarding, vault sync, plugins, local terminal, Mosh. Unimplemented bridge
methods return `{ ok:false }` stubs. Host keys are NOT verified yet (PromiscuousVerifier).

## Build
```bash
npm i --ignore-scripts      # skip electron/node-pty postinstall
npm run android:sync        # vite build + cap sync
npm run android:open        # Android Studio -> Run   (JDK 21, Android SDK 36)
```
Grant notification permission and disable battery optimization for long AI/SSH sessions.
Status: written without access to an Android SDK; first build may need small fixes.
