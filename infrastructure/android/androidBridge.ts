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
// Unimplemented API -> harmless stubs so the UI never crashes on a missing method.
// Getter-style calls resolve to null/false (callers usually guard with ?? / ||), others to {ok:false}.
const warned = new Set<string>();
(window as any).netcatty = new Proxy(impl, {
  get(target, prop: string) {
    if (prop in target) return target[prop];
    if (typeof prop !== 'string') return undefined;
    if (!warned.has(prop)) { warned.add(prop); console.warn('[android] netcatty.' + prop + ' not implemented'); }
    if (/^on[A-Z]/.test(prop)) return () => () => {};
    if (/^(is|has|can)[A-Z]/.test(prop)) return async () => false;
    if (/^script(Get|List)[A-Z]/.test(prop) || /Runs$|List$/.test(prop)) return async () => [];
    if (/^(get|list|read|load|fetch|query|detect|find|resolve)[A-Z]/.test(prop)) return async () => null;
    return async () => ({ ok: false, error: `Not available on Android: ${prop}` });
  },
});

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
