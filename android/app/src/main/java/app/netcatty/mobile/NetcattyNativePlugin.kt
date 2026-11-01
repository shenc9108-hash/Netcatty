package app.netcatty.mobile

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.transport.verification.PromiscuousVerifier
import net.schmizz.sshj.userauth.password.PasswordUtils
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.io.InputStreamReader
import java.security.Security
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val PLACEHOLDER = "__IPC_SECURED__"
private const val ENC_PREFIX = "enc:v1:"
private const val MAX_OUT = 200_000

private class SshSess(val client: SSHClient, val session: Session, val shell: Session.Shell)

/**
 * Android has no native X25519 / Ed25519 JCE implementation, so sshj's transport
 * init fails with:
 *   Failed to start SSH: no such algorithm: X25519 for provider BC
 * Installing BouncyCastle gives the JCE the curves sshj already advertises. It must
 * run before the first SSHClient is constructed.
 */
private val bouncyCastleReady: Boolean by lazy {
    // Android ships a stripped-down provider already registered under the name "BC".
    // Security.addProvider() would be a no-op in that case and sshj would keep hitting
    // an implementation without X25519, so replace it outright and put the full
    // BouncyCastle first in the provider chain.
    Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
    Security.insertProviderAt(BouncyCastleProvider(), 1)
    true
}

@CapacitorPlugin(name = "NetcattyNative")
class NetcattyNativePlugin : Plugin() {
    private val pool = Executors.newCachedThreadPool()
    private val writer = Executors.newSingleThreadExecutor()
    private val sessions = ConcurrentHashMap<String, SshSess>()
    private val clients = ConcurrentHashMap<String, SSHClient>()          // sessionId -> client (for exec)
    private val streams = ConcurrentHashMap<String, Call>()
    private val execByChat = ConcurrentHashMap<String, MutableSet<Session>>()
    @Volatile private var providers: Map<String, JSONObject> = emptyMap()
    private val http: OkHttpClient = OkHttpClient.Builder()
        .retryOnConnectionFailure(true).callTimeout(0, TimeUnit.MILLISECONDS).build()

    private fun emit(event: String, build: JSObject.() -> Unit) = notifyListeners(event, JSObject().apply(build))

    // ───────────── credentials (Android Keystore, AES-GCM) ─────────────
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey("netcatty_secret", null) as? SecretKey)?.let { return it }
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        g.init(KeyGenParameterSpec.Builder("netcatty_secret",
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        return g.generateKey()
    }
    private fun enc(p: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return ENC_PREFIX + Base64.encodeToString(c.iv + c.doFinal(p.toByteArray()), Base64.NO_WRAP)
    }
    private fun dec(v: String): String {
        if (!v.startsWith(ENC_PREFIX)) return v
        val raw = Base64.decode(v.removePrefix(ENC_PREFIX), Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
            .apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12)) }
        return String(c.doFinal(raw, 12, raw.size - 12))
    }
    @PluginMethod fun credentialsEncrypt(c: PluginCall) =
        c.resolve(JSObject().put("value", enc(c.getString("plaintext") ?: "")))
    @PluginMethod fun credentialsDecrypt(c: PluginCall) =
        c.resolve(JSObject().put("value", runCatching { dec(c.getString("value") ?: "") }.getOrDefault("")))

    // ───────────── AI: providers + streaming ─────────────
    @PluginMethod fun aiSyncProviders(c: PluginCall) {
        val arr = c.getArray("providers") ?: JSArray()
        val m = HashMap<String, JSONObject>()
        for (i in 0 until arr.length()) arr.getJSONObject(i).let { m[it.optString("id")] = it }
        providers = m
        c.resolve(JSObject().put("ok", true))
    }
    private fun injectKey(headers: JSONObject?, providerId: String?): Map<String, String> {
        val key = providerId?.let { providers[it]?.optString("apiKey") }?.takeIf { it.isNotEmpty() }?.let { dec(it) }
        val out = LinkedHashMap<String, String>()
        headers?.keys()?.forEach { k ->
            val v = headers.optString(k)
            out[k] = if (key != null && v.contains(PLACEHOLDER)) v.replace(PLACEHOLDER, key) else v
        }
        return out
    }
    private fun sseData(line: String): String? {
        val t = line.trim()
        if (!t.startsWith("data:")) return null
        val p = t.removePrefix("data:")
        return if (p.startsWith(" ")) p.substring(1) else p
    }

    @PluginMethod fun aiChatStream(c: PluginCall) {
        val id = c.getString("requestId") ?: return c.reject("requestId required")
        KeepAlive.acquire(context, "AI 对话进行中")
        pool.execute {
            var released = false
            fun release() { if (!released) { released = true; KeepAlive.release(context) } }
            try {
                val hdr = injectKey(c.getObject("headers"), c.getString("providerId"))
                val req = Request.Builder().url(c.getString("url")!!).apply {
                    hdr.forEach { (k, v) -> header(k, v) }
                    post((c.getString("body") ?: "").toRequestBody((hdr["Content-Type"] ?: "application/json").toMediaType()))
                }.build()
                val idle = (c.getInt("idleTimeoutMs") ?: 120000).toLong()
                val call = http.newBuilder().readTimeout(idle, TimeUnit.MILLISECONDS).build().newCall(req)
                streams[id] = call
                call.execute().use { res ->
                    if (!res.isSuccessful) {
                        val body = res.body?.string()?.take(500) ?: ""
                        val detail = runCatching { JSONObject(body).optJSONObject("error")?.optString("message") }
                            .getOrNull().takeUnless { it.isNullOrEmpty() } ?: body.ifEmpty { res.message }
                        emit("aiStreamError") { put("requestId", id); put("error", "HTTP ${res.code}: $detail") }
                        c.resolve(JSObject().put("statusCode", res.code).put("statusText", "${res.code} $detail"))
                        return@use
                    }
                    c.resolve(JSObject().put("statusCode", res.code).put("statusText", res.message))
                    val src = res.body!!.source()
                    while (true) {
                        val line = src.readUtf8Line() ?: break
                        sseData(line)?.let { d -> emit("aiStreamData") { put("requestId", id); put("data", d) } }
                    }
                    emit("aiStreamEnd") { put("requestId", id) }
                }
            } catch (e: Exception) {
                emit("aiStreamError") { put("requestId", id); put("error", e.message ?: e.toString()) }
                if (!c.isReleased) c.reject(e.message ?: "stream failed")
            } finally { streams.remove(id); release() }
        }
    }
    @PluginMethod fun aiChatCancel(c: PluginCall) {
        streams.remove(c.getString("requestId"))?.cancel(); c.resolve(JSObject().put("ok", true))
    }
    @PluginMethod fun aiFetch(c: PluginCall) = pool.execute {
        try {
            val hdr = injectKey(c.getObject("headers"), c.getString("providerId"))
            val method = (c.getString("method") ?: "GET").uppercase()
            val body = c.getString("body")
            val req = Request.Builder().url(c.getString("url")!!).apply {
                hdr.forEach { (k, v) -> header(k, v) }
                method(method, if (body != null || method == "POST") (body ?: "").toRequestBody("application/json".toMediaType()) else null)
            }.build()
            http.newBuilder().followRedirects(c.getBoolean("followRedirects") ?: true)
                .readTimeout(60, TimeUnit.SECONDS).build().newCall(req).execute().use { r ->
                    c.resolve(JSObject().put("ok", r.isSuccessful).put("status", r.code).put("data", r.body?.string() ?: ""))
                }
        } catch (e: Exception) { c.resolve(JSObject().put("ok", false).put("error", e.message)) }
    }

    // ───────────── SSH ─────────────
    private fun connect(o: PluginCall): SSHClient {
        // Touch the lazy property so the provider is installed before sshj resolves
        // the key-exchange algorithm. Cheap after the first call.
        bouncyCastleReady
        val cl = SSHClient()
        cl.addHostKeyVerifier(PromiscuousVerifier()) // TODO: known_hosts pinning (self-use shortcut)
        cl.connectTimeout = 15000
        cl.connect(o.getString("hostname"), o.getInt("port") ?: 22)
        cl.connection.keepAlive.keepAliveInterval = 15
        val user = o.getString("username") ?: "root"
        val pk = o.getString("privateKey")
        val pass = o.getString("passphrase")
        if (!pk.isNullOrBlank()) {
            val kp = if (pass.isNullOrEmpty()) cl.loadKeys(pk, null, null)
                     else cl.loadKeys(pk, null, PasswordUtils.createOneOff(pass.toCharArray()))
            cl.authPublickey(user, kp)
        } else cl.authPassword(user, o.getString("password") ?: "")
        return cl
    }

    @PluginMethod fun sshStart(c: PluginCall) {
        val sid = c.getString("sessionId") ?: UUID.randomUUID().toString()
        KeepAlive.acquire(context, "SSH 会话保持中")
        pool.execute {
            try {
                val cl = connect(c)
                val s = cl.startSession()
                s.allocatePTY("xterm-256color", c.getInt("cols") ?: 80, c.getInt("rows") ?: 24, 0, 0, emptyMap())
                val sh = s.startShell()
                sessions[sid] = SshSess(cl, s, sh); clients[sid] = cl
                c.resolve(JSObject().put("sessionId", sid))
                val rd = InputStreamReader(sh.inputStream, Charsets.UTF_8) // streaming decoder: safe across chunk edges
                val buf = CharArray(8192)
                while (true) { val n = rd.read(buf); if (n < 0) break
                    emit("sshData") { put("sessionId", sid); put("data", String(buf, 0, n)) } }
            } catch (e: Exception) { if (!c.isReleased) c.reject(e.message ?: "ssh failed") }
            finally {
                sessions.remove(sid)?.let { runCatching { it.client.disconnect() } }; clients.remove(sid)
                emit("sshExit") { put("sessionId", sid); put("exitCode", 0) }
                KeepAlive.release(context)
            }
        }
    }
    @PluginMethod fun sshWrite(c: PluginCall) {
        val s = sessions[c.getString("sessionId")] ?: return c.resolve()
        val d = (c.getString("data") ?: "").toByteArray()
        writer.execute { runCatching { s.shell.outputStream.write(d); s.shell.outputStream.flush() } }
        c.resolve()
    }
    @PluginMethod fun sshResize(c: PluginCall) {
        sessions[c.getString("sessionId")]?.let { s ->
            pool.execute { runCatching { s.shell.changeWindowDimensions(c.getInt("cols") ?: 80, c.getInt("rows") ?: 24, 0, 0) } }
        }; c.resolve()
    }
    @PluginMethod fun sshClose(c: PluginCall) {
        sessions.remove(c.getString("sessionId"))?.let { s -> pool.execute { runCatching { s.client.disconnect() } } }
        c.resolve(JSObject().put("ok", true))
    }

    /** AI tool execution: separate exec channel on the same connection, with timeout + output cap + cancel. */
    @PluginMethod fun sshExec(c: PluginCall) {
        val cl = clients[c.getString("sessionId")] ?: return c.resolve(JSObject().put("ok", false).put("error", "Session not connected"))
        val chat = c.getString("chatSessionId") ?: ""
        val timeout = (c.getInt("timeoutMs") ?: 60000).toLong()
        pool.execute {
            var sess: Session? = null
            try {
                sess = cl.startSession()
                execByChat.getOrPut(chat) { ConcurrentHashMap.newKeySet() }.add(sess)
                val cmd = sess.exec(c.getString("command") ?: "")
                val out = StringBuffer(); val err = StringBuffer()
                fun pump(s: java.io.InputStream, sb: StringBuffer) = Thread {
                    val r = InputStreamReader(s, Charsets.UTF_8); val b = CharArray(4096)
                    try { while (true) { val n = r.read(b); if (n < 0) break; if (sb.length < MAX_OUT) sb.append(b, 0, n) } }
                    catch (_: Exception) { /* channel closed */ }
                }.apply { isDaemon = true; start() }
                val t1 = pump(cmd.inputStream, out); val t2 = pump(cmd.errorStream, err)
                cmd.join(timeout, TimeUnit.MILLISECONDS)
                val done = cmd.exitStatus != null || !cmd.isOpen
                if (!done) runCatching { sess.close() }          // enforce the timeout
                t1.join(1500); t2.join(1500)
                val res = JSObject().put("stdout", out.toString()).put("stderr", err.toString())
                    .put("exitCode", cmd.exitStatus ?: -1)
                if (done) c.resolve(res.put("ok", true))
                else c.resolve(res.put("ok", false).put("error", "Command timed out after ${timeout / 1000}s"))
            } catch (e: Exception) {
                c.resolve(JSObject().put("ok", false).put("error", e.message ?: "exec failed"))
            } finally { sess?.let { execByChat[chat]?.remove(it); runCatching { it.close() } } }
        }
    }
    @PluginMethod fun sshCancelExec(c: PluginCall) {
        execByChat.remove(c.getString("chatSessionId") ?: "")?.forEach { runCatching { it.close() } }
        c.resolve(JSObject().put("ok", true))
    }
}
