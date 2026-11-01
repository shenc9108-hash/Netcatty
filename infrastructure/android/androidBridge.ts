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
const warned = new Set<string>();
(window as any).netcatty = new Proxy(impl, {
  get(target, prop: string) {
    if (prop in target) return target[prop];
    if (typeof prop !== 'string') return undefined;
    if (!warned.has(prop)) { warned.add(prop); console.warn('[android] netcatty.' + prop + ' not implemented'); }
    if (/^on[A-Z]/.test(prop)) return () => () => {};
    return async () => ({ ok: false, error: `Not available on Android: ${prop}` });
  },
});
}
