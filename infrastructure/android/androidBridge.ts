/**
 * Android implementation of the `window.netcatty` bridge (replaces electron/preload).
 * Covers: AI streaming, aiExec, credentials, SSH shell sessions.
 * Everything else falls back to a safe stub (see Proxy at the bottom).
 * Import this BEFORE React mounts:  import './androidBridge';  at top of index.tsx
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

type Cb<T = any> = (v: T) => void;
const IS_ANDROID = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
const Native: any = IS_ANDROID ? registerPlugin('NetcattyNative') : null;

// ---- event fan-out: one native listener per event, many JS subscribers ----
const subs = new Map<string, Set<Cb>>(); // key: `${event}:${id}`
const wired = new Set<string>();
function subscribe(event: string, id: string, cb: Cb): () => void {
  if (!wired.has(event)) {
    wired.add(event);
    Native.addListener(event, (p: any) => {
      subs.get(`${event}:${p.requestId ?? p.sessionId}`)?.forEach((f) => f(p));
    });
  }
  const key = `${event}:${id}`;
  if (!subs.has(key)) subs.set(key, new Set());
  subs.get(key)!.add(cb);
  return () => {
    subs.get(key)?.delete(cb);
    if (subs.get(key)?.size === 0) subs.delete(key);
  };
}

const impl: Record<string, any> = {
  // ---------- App lock: report "initialized, unlocked" so AppLockGate renders the UI ----------
  getAppLockRuntimeState: async () => ({
    initialized: true, locked: false, reason: null, version: 1,
    lastLockedAt: null, lastUnlockedAt: Date.now(), lastActivityAt: Date.now(),
  }),
  requestAppLockUnlock: async () => ({ ok: true }),
  setAppLockRuntimeLocked: async () => ({ ok: true }),
  reportAppLockActivity: () => {},
  notifyRendererReady: () => {},
  getAppLockSystemUnlockStatus: async () => ({
    supported: false, available: false, enabled: false, platform: 'unsupported', label: null, reason: null,
  }),

  // ---------- Safe defaults with the shapes the renderer expects ----------
  // scriptGetRuns must resolve to an ARRAY; the generic {ok:false} stub made the UI read .length of a non-array.
  scriptGetRuns: async () => [],
  getAppLockSettings: async () => ({
    enabled: false, timeoutMinutes: 15, systemUnlockEnabled: false,
    systemUnlockAutoPromptEnabled: false, passwordVerifier: null,
  }),
  getAutoUpdate: async () => ({ enabled: false }),
  getExplorerContextMenuEnabled: async () => false,
  getSshDeepLinkEnabled: async () => false,
  getJmsDeepLinkEnabled: async () => false,
  getAutoLaunch: async () => false,

  // ---------- Window management: Android has a single full-screen window ----------
  // Settings is a separate BrowserWindow on desktop (#/settings route). Here we navigate in-page;
  // the hashchange listener below reloads so index.tsx re-evaluates the route.
  openSettingsWindow: async () => { window.location.hash = '#/settings'; return { ok: true }; },
  closeSettingsWindow: async () => { window.location.hash = ''; return { ok: true }; },
  windowMinimize: async () => undefined,
  windowMaximize: async () => false,
  windowClose: async () => undefined,
  windowIsMaximized: async () => false,
  windowIsFullscreen: async () => false,

  // ---------- Features that do not exist on Android ----------
  // monitorSnapshot MUST reject: the renderer catches that and shows "monitor unavailable".
  // Resolving to the generic {ok:false} stub put a snapshot without `running` into the store and
  // crashed the first render (useMonitorHostKeyVerification: snapshot.running.length).
  monitorSnapshot: () => Promise.reject(new Error('monitor not available on Android')),
  monitorUpdate: async () => undefined,
  getPortForwardSnapshot: () => Promise.reject(new Error('port forwarding not available on Android')),
  subscribePortForwardRuntime: () => Promise.reject(new Error('port forwarding not available on Android')),
  discoverShells: async () => [],
  credentialsAvailable: async () => true,

  // ---------- credentials (Android Keystore, AES-GCM, "enc:v1:" prefix) ----------
  credentialsEncrypt: (plaintext: string) =>
    Native.credentialsEncrypt({ plaintext }).then((r: any) => r.value),
  credentialsDecrypt: (value: string) =>
    Native.credentialsDecrypt({ value }).then((r: any) => r.value),

  // ---------- AI: provider config + streaming ----------
  aiSyncProviders: (providers: unknown[]) => Native.aiSyncProviders({ providers }),
  aiSyncWebSearch: async () => ({ ok: true }),
  aiAllowlistAddHost: async () => ({ ok: true }),
  // resolves {statusCode,statusText} once headers arrive; body arrives via events
  aiChatStream: (requestId: string, url: string, headers: Record<string, string>, body: string,
                 providerId?: string, idleTimeoutMs?: number) =>
    Native.aiChatStream({ requestId, url, headers, body, providerId, idleTimeoutMs: idleTimeoutMs ?? 120000 }),
  aiChatCancel: (requestId: string) => Native.aiChatCancel({ requestId }),
  onAiStreamData: (id: string, cb: Cb) => subscribe('aiStreamData', id, (p) => cb(p.data)),
  onAiStreamEnd: (id: string, cb: Cb) => subscribe('aiStreamEnd', id, () => cb(undefined)),
  onAiStreamError: (id: string, cb: Cb) => subscribe('aiStreamError', id, (p) => cb(p.error)),
  aiFetch: (url: string, method = 'GET', headers: Record<string, string> = {}, body?: string,
            providerId?: string, _skipHost?: boolean, followRedirects?: boolean, skipTLSVerify?: boolean) =>
    Native.aiFetch({ url, method, headers, body, providerId, followRedirects, skipTLSVerify }),

  // ---------- AI: tool execution ----------
  // Runs on a dedicated SSH exec channel of the same connection (not the visible shell).
  aiExec: (sessionId: string, command: string, chatSessionId?: string) =>
    Native.sshExec({ sessionId, command, chatSessionId, timeoutMs: 60000 }),
  aiCattyCancelExec: (chatSessionId: string) => Native.sshCancelExec({ chatSessionId }),
  aiSetChatSessionCancelled: async (chatSessionId: string, cancelled = true) => {
    if (cancelled) await Native.sshCancelExec({ chatSessionId });
    return { ok: true };
  },
  aiCapability: async (rpcMethod: string) =>
    ({ ok: false, error: `capability not implemented on Android: ${rpcMethod}` }),

  // ---------- SSH shell sessions ----------
  startSSHSession: (options: any) => Native.sshStart(options).then((r: any) => r.sessionId),
  writeToSession: (sessionId: string, data: string) => { Native.sshWrite({ sessionId, data }); },
  resizeSession: (sessionId: string, cols: number, rows: number) => { Native.sshResize({ sessionId, cols, rows }); },
  closeSession: (sessionId: string) => Native.sshClose({ sessionId }),
  execCommand: (options: any) => Native.sshExec({ ...options, timeoutMs: options?.timeoutMs ?? 60000 }),
  onSessionData: (sessionId: string, cb: Cb) => subscribe('sshData', sessionId, (p) => cb(p.data)),
  onSessionExit: (sessionId: string, cb: Cb) => subscribe('sshExit', sessionId, (p) => cb(p)),
};
if (IS_ANDROID) {
// Unimplemented API -> stubs whose SHAPE matches the real contract.
//
// History: this used to return `null` for every get*-style call and `{ok:false}` otherwise.
// That crashed the UI on APIs whose callers treat the result as a collection:
//   getPluginThemes().themes.find(...)        -> Cannot read properties of null (reading 'find')
//   getHostBrowserBookmarks().map(...)        -> Cannot read properties of null (reading 'map')
//   getPluginContributions().plugins.length   -> Cannot read properties of null (reading 'length')
// The renderer has no reason to null-guard an API that is declared to return a collection,
// so the stub must return the empty collection, not null.
const warned = new Set<string>();

// Empty value with the right container type for a known collection-returning API.
const EMPTY_ARRAY_APIS = new Set([
  'getHostBrowserBookmarks',
  'getPluginThemes',
  'getPluginContributions',
  'getPluginCatalog',
  'getPluginInstalledList',
  'listPluginExtensionProviders',
  'getKnownHosts',
  'getSnippets',
  'getScripts',
  'getIdentities',
  'getGroups',
  'getProxyProfiles',
  'getPortForwardRules',
  'getWorkspaces',
  'getSessionList',
  'getEditorTabs',
  'getRecentHosts',
]);

// Structured empty snapshots for APIs whose callers read named fields.
const EMPTY_OBJECT_APIS: Record<string, () => unknown> = {
  // Must match ThemePackCatalog exactly: the registry stores this verbatim and then
  // reads catalog.entries / catalog.selection[mode] / catalog.diagnostics.
  getPluginThemes: () => ({
    selection: { formatVersion: 1, revision: 0, light: null, dark: null },
    entries: [],
    diagnostics: [],
  }),
  getPluginContributions: () => ({ locale: 'en', plugins: [], revision: 0 }),
  getPluginPermissions: () => ({ granted: [], denied: [], revision: 0 }),
  getPluginLogStatus: () => ({ entries: [], level: 'info' }),
  getPluginScopeCatalog: () => ({ scopes: [], revision: 0 }),
  // The plugin runtime is absent on Android. available:false makes every consumer
  // (usePluginContributions / settings tabs) take the empty-snapshot path instead of
  // reading named fields off a stub. Returning {ok:false} here left `available`
  // undefined and downstream code threw "Cannot read properties of undefined (reading 'filter')".
  getPluginRuntimeStatus: () => ({ available: false, status: 'unavailable', plugins: [], error: null }),
  getPluginCatalog: () => ({ plugins: [], revision: 0, sources: [] }),
  getPluginInstalledList: () => [],
  getPluginLogStatusDetail: () => ({ entries: [], level: 'info' }),
  getAppInfo: () => ({ version: '0.0.0', platform: 'android', arch: 'arm64', isPackaged: true }),
  getSystemInfo: () => ({ platform: 'android', arch: 'arm64', cpus: [], totalmem: 0, freemem: 0 }),
  getUpdateStatus: () => ({ status: 'not-available', available: false }),

  // ---- Settings > System ----------------------------------------------------
  // Every one of these is read directly into component state and then used as an
  // array (crashLogs.length, logEntries.length, ...). The generic {ok:false} stub
  // made them objects, which crashed the tab with
  // "Cannot read properties of undefined (reading 'length')".
  getCrashLogs: () => [],
  readCrashLog: () => [],
  getTempDirInfo: () => ({ path: '', isCustom: false, sizeBytes: 0, fileCount: 0, defaultPath: '' }),
  getSshDebugLogInfo: () => ({ enabled: false, path: '', sizeBytes: 0, defaultPath: '' }),
  clearCrashLogs: () => ({ ok: true, removed: 0 }),
  clearTempDir: () => ({ ok: true, removed: 0, freedBytes: 0 }),
  setCustomTempDir: () => ({ ok: true }),
  selectSessionLogsDir: () => null,
  clearSessionLogsDir: () => ({ ok: true, removed: 0 }),
  openCrashLogsDir: async () => undefined,
  openTempDir: async () => undefined,
  openSessionLogsDir: async () => undefined,
  openSshDebugLogDir: async () => undefined,

  // ---- Settings > AI --------------------------------------------------------
  // SettingsAITab reads result.skills.length / .map and treats the Codex CLI as
  // absent. Shape these so the tab renders its "not available" state instead of
  // throwing on a missing field.
  // ---- AI privacy ------------------------------------------------------------
  // infrastructure/ai/harness/modelPrivacy.ts refuses to send anything unless
  // aiPrivacyStatus resolves ok with a boolean `enabled`, and aiPrivacyTransform
  // exists. Leaving both to the generic stub is a hard block: every turn failed
  // with "AI privacy protection is unavailable. No unprotected request was sent."
  //
  // The host implementation (electron/shared/aiPrivacyService.cjs) is a no-op when
  // the policy is disabled: redact/restore return the value unchanged. There is no
  // MCP/tool bridge on Android, so there is no outbound context to redact and the
  // disabled policy is the accurate one. Identity transform, reported honestly.
  aiPrivacyStatus: () => ({ ok: true, enabled: false }),
  aiPrivacyTransform: ({ value }: { value: unknown }) => ({ ok: true, value }),
  aiUserSkillsGetStatus: () => ({ ok: false, skills: [], error: 'Not available on Android' }),
  aiUserSkillsOpenFolder: () => ({ ok: false }),
  aiCodexGetStatus: () => ({ available: false, status: 'unavailable', version: null }),
  aiCodexGetIntegration: () => ({ installed: false, enabled: false, version: null }),
  aiCodexGetLoginSession: () => ({ status: 'signed-out', session: null }),
  aiCodexStartLogin: () => ({ ok: false, status: 'unavailable' }),
  aiCodexCancelLogin: () => ({ ok: false }),
  aiCodexLogout: () => ({ ok: false }),
  codexAppServerGetStatus: () => ({ running: false, status: 'unavailable' }),
  aiResolveCli: () => ({ available: false, path: null }),
  aiPrewarmShellEnv: async () => undefined,
};

(window as any).netcatty = new Proxy(impl, {
  get(target, prop: string) {
    if (prop in target) return target[prop];
    if (typeof prop !== 'string') return undefined;
    if (!warned.has(prop)) {
      warned.add(prop);
      console.warn('[android] netcatty.' + prop + ' not implemented');
    }

    // Event subscriptions: return an unsubscribe function.
    if (/^on[A-Z]/.test(prop)) return () => () => {};

    // Boolean probes.
    if (/^(is|has|can)[A-Z]/.test(prop)) return async () => false;

    // APIs with a known structured-empty response.
    const shaped = EMPTY_OBJECT_APIS[prop];
    if (shaped) return async () => shaped();

    // Known collection APIs -> [].
    if (EMPTY_ARRAY_APIS.has(prop)) return async () => [];
    if (/^script(Get|List)[A-Z]/.test(prop) || /Runs$|List$/.test(prop)) return async () => [];

    // ---- Shape inference for the remaining ~280 bridge methods -----------------
    // The app has 300+ bridge methods and only a fraction are listed above. Rather
    // than enumerate them (and get the shape wrong again), infer the container type
    // from the method name. The rule is: never hand the renderer something it will
    // call .filter/.map/.some/.find/.length on unless it is a real array.
    //
    // Plural nouns and the classic list verbs return collections.
    // Snapshots and metrics are objects with named fields (cpu, memory, running, ...),
    // and useMonitorHostKeyVerification reads snapshot.running directly. Check these
    // before the plural-noun rule below, which would otherwise return an array.
    if (/(Stats|Metrics|Snapshot|Status|Info|Usage|Summary|Overview)$/.test(prop)) {
      return async () => ({ ok: false, available: false, running: [], error: `Not available on Android: ${prop}` });
    }
    if (/(List|Rules|Entries|Items|Sessions|Hosts|Profiles|Identities|Groups|Scripts|Snippets|Workspaces|Tabs|Keys|Agents|Skills|Providers|Themes|Logs|Bookmarks|Events|History|Messages|Files|Accounts|Servers|Images|Containers|Volumes|Networks|Distros|Shells)$/.test(prop)) {
      return async () => [];
    }
    if (/^(list|getAll|enumerate|discover|scan|collect)[A-Z]/.test(prop)) {
      return async () => [];
    }
    if (/^list/.test(prop)) return async () => [];

    // Explicit capability probes.
    if (/^(supports|check)[A-Z]/.test(prop)) return async () => false;

    // Pure actions (open/close/cancel/delete/write/apply/...): resolve to undefined
    // so nothing tries to read fields off the result.
    if (/^(open|close|cancel|delete|remove|clear|set|apply|update|write|save|send|start|stop|kill|dispose|cleanup|resize|chmod|rename|move|copy|register|unregister|notify|dispatch|trigger|log|ack|mark|reset|refresh|reload|invalidate|warm|prewarm|preheat|emit|push|show|hide|focus|blur|navigate|scroll|select)[A-Z]/.test(prop)) {
      return async () => undefined;
    }
    if (/^(open|close|cancel|delete|clear|apply|reset|refresh|reload|dispose|cleanup)$/.test(prop)) {
      return async () => undefined;
    }

    // Everything else that reads like a getter/probe: undefined, never null. Null is
    // what `?? fallback` and optional chaining are designed to ignore, but plenty of
    // call sites use `Array.isArray(x) ? ... : []` which mis-handles it, and a truthy
    // `{ok:false}` is worse because it enters state and then explodes on .length.
    if (/^(get|read|load|fetch|query|detect|find|resolve|check|is|has|can|needs|should|describe|inspect|probe|validate|test|convert|transform|parse|format|build|make|create|compose|derive|compute|calculate|generate|render)[A-Z]/.test(prop)) {
      return async () => undefined;
    }

    // Last resort: an empty, non-truthy-object result. Callers that require
    // result.ok get a safe false; callers that expect data get undefined.
    return async () => ({ ok: false, error: `Not available on Android: ${prop}` });
  },
});

// ---------- Phone chrome: android class, safe-area insets, touch tweaks, route reload ----------
document.documentElement.classList.add('android');
const phoneCss = document.createElement('style');
phoneCss.textContent = `
  html.android, html.android body { overscroll-behavior: none; -webkit-tap-highlight-color: transparent; }
  html.android #root { padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom);
    padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); box-sizing: border-box; }
  html.android .app-drag { -webkit-app-region: no-drag; }
  html.android button, html.android [role="button"] { touch-action: manipulation; }
  /* Fill the real visible height (100vh overshoots in WebView -> bottom bar cut off). */
  html.android, html.android body { height: 100%; }
  html.android #root { height: 100dvh; }
  html.android .h-screen { height: 100% !important; }
  html.android .min-h-screen { min-height: 100% !important; }
  /* Right-hand detail panels (host editor etc.) take the whole content area on phones. */
  html.android .split-panel-enter { position: absolute !important; inset: 0; width: 100% !important; max-width: 100% !important; z-index: 40; }

  /* ---- Side panels on phones -------------------------------------------------
     Android forces the bottom dock (see TerminalLayer: sidePanelPosition), so the
     panel stacks above the terminal and the built-in vertical resize handle stays
     usable. These rules only remove the desktop assumptions that break there:
     do not let the flex ROW push the terminal off-screen, and keep both panes
     within the viewport. Heights stay under the app's control so dragging works. */
  html.android [data-section="terminal-workspace"] {
    flex-direction: column !important;
  }
  html.android [data-section="terminal-side-panel-shell"] {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    flex: 0 0 auto !important;
  }
  html.android [data-section="terminal-workspace-row"],
  html.android [data-section="terminal-workspace-column"] {
    min-width: 0 !important;
    min-height: 0 !important;
  }
  /* The resize handle is a 8px strip; make it easier to grab with a finger. */
  html.android [data-section="terminal-side-panel-resizer"] {
    height: 14px !important;
    top: -7px !important;
    touch-action: none;
  }
`;
document.head.appendChild(phoneCss);
window.addEventListener('hashchange', () => window.location.reload());

// ---------- On-screen diagnostics: turns a silent white screen into readable text ----------
const errors: string[] = [];
function showDiag(reason: string) {
  let el = document.getElementById('android-diag');
  if (!el) {
    el = document.createElement('pre');
    el.id = 'android-diag';
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;margin:0;padding:16px;overflow:auto;' +
      'background:#111;color:#f88;font:12px/1.4 monospace;white-space:pre-wrap;';
    document.body.appendChild(el);
  }
  el.textContent = `[Netcatty Android diagnostics] ${reason}\n\n` +
    `Errors:\n${errors.join('\n---\n') || '(none)'}\n\n` +
    `Unimplemented bridge calls:\n${[...warned].join(', ') || '(none)'}\n\n(tap to dismiss)`;
  el.onclick = () => el!.remove();
}
window.addEventListener('error', (e) => { errors.push(String(e.error?.stack || e.message)); showDiag('uncaught error'); });
window.addEventListener('unhandledrejection', (e) => {
  errors.push('unhandledrejection: ' + String((e.reason as any)?.stack || e.reason)); showDiag('unhandled promise rejection');
});
// Watchdog: if nothing rendered into #root after 10s, show what we know.
setTimeout(() => {
  const root = document.getElementById('root');
  if (!root || root.childElementCount === 0) showDiag('UI did not render within 10s');
}, 10000);
}
