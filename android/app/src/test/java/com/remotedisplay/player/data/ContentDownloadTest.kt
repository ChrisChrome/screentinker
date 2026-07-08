package com.remotedisplay.player.data

import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.OutputStream
import java.net.ServerSocket
import java.nio.file.Files
import java.util.concurrent.TimeUnit

/**
 * Root-2 REPRODUCE-THEN-PROVE for the "stuck downloading / frozen" caching bug. Each test drives
 * the REAL ContentCache.downloadContent against a local HTTP server that reproduces a specific
 * failure mode on a HEALTHY socket (the socket is fine — the DOWNLOAD misbehaves), and proves the
 * fix: a stalled/trickling download aborts instead of hanging forever, and a truncated body is
 * never promoted to the cache (so it can't be played as if whole and wedge the playlist).
 *
 * The client uses short timeouts so the STALL reproduction is fast; the download/validation logic
 * exercised is identical to production (only the timeout VALUES differ — production is
 * callTimeout=5min / readTimeout=30s, verified by inspection in ContentCache.defaultClient()).
 */
class ContentDownloadTest {

    private lateinit var dir: java.io.File
    private lateinit var cache: ContentCache
    private var server: ServerSocket? = null

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(1, TimeUnit.SECONDS)   // a stalled stream aborts in ~1s => fast test
        .callTimeout(3, TimeUnit.SECONDS)   // hard overall cap backstop
        .build()

    @Before fun setUp() {
        dir = Files.createTempDirectory("cachetest").toFile()
        cache = ContentCache(dir, client)   // internal ctor — real logic, no Android Context
    }

    @After fun tearDown() {
        try { server?.close() } catch (_: Exception) {}
        dir.deleteRecursively()
    }

    /** Accept ONE connection, drain the request, then let [respond] write a crafted response. */
    private fun serveOnce(respond: (OutputStream) -> Unit): String {
        val s = ServerSocket(0)
        server = s
        Thread {
            try {
                s.accept().use { sock ->
                    val reader = sock.getInputStream().bufferedReader()
                    while (true) { val line = reader.readLine() ?: break; if (line.isEmpty()) break }
                    respond(sock.getOutputStream())
                }
            } catch (_: Exception) { /* client hung up on timeout — expected for the stall case */ }
        }.apply { isDaemon = true; start() }
        return "http://127.0.0.1:${s.localPort}"
    }

    private fun OutputStream.writeHttp(contentLength: Int, body: ByteArray) {
        write("HTTP/1.1 200 OK\r\nContent-Length: $contentLength\r\nContent-Type: application/octet-stream\r\n\r\n".toByteArray())
        write(body)
        flush()
    }

    private fun partFiles() = dir.listFiles { _, name -> name.endsWith(".part") }?.toList() ?: emptyList()

    // ---- positive control: a complete download IS cached ----
    @Test fun `complete download is cached with the right size and no leftover part file`() {
        val url = serveOnce { it.writeHttp(5, "hello".toByteArray()) }
        val file = cache.downloadContent(url, "cidA", "clip.bin")
        assertNotNull("a complete download should be cached", file)
        assertEquals(5L, file!!.length())
        assertNotNull(cache.getCachedFile("cidA"))
        assertTrue("no .part temp should remain", partFiles().isEmpty())
    }

    // ---- REPRODUCE: truncated body (declares 100 bytes, sends 40 then closes) on a healthy socket ----
    @Test fun `truncated download is NOT promoted to the cache — partial detected and discarded`() {
        val url = serveOnce {
            it.writeHttp(100, ByteArray(40) { 'x'.code.toByte() })
            // close after 40 of the declared 100 bytes -> truncation
        }
        val file = cache.downloadContent(url, "cidB", "clip.bin")
        assertNull("a truncated download must return null (not a usable file)", file)
        assertNull("a truncated file must NOT be served as cached", cache.getCachedFile("cidB"))
        assertTrue("the partial .part must be cleaned up, not left behind", partFiles().isEmpty())
    }

    // ---- REPRODUCE: a STALLED download (headers + a trickle, then hang) on a healthy socket ----
    @Test fun `stalled download aborts within the timeout instead of hanging forever`() {
        val url = serveOnce {
            it.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n".toByteArray())
            it.write(ByteArray(10)); it.flush()
            Thread.sleep(10_000) // hang mid-stream — the OLD client (5min readTimeout) waited here
        }
        val start = System.currentTimeMillis()
        val file = cache.downloadContent(url, "cidC", "clip.bin")
        val elapsed = System.currentTimeMillis() - start
        assertNull("a stalled download must fail, not hang", file)
        assertTrue("must abort quickly via the timeout (was ~$elapsed ms)", elapsed < 5_000)
        assertNull(cache.getCachedFile("cidC"))
        assertTrue("no partial left behind after a stall", partFiles().isEmpty())
    }

    // ---- prefix cross-match guard: an id that prefixes another must not match ----
    @Test fun `getCachedFile does not cross-match an id that is a prefix of another`() {
        serveOnce { it.writeHttp(3, "abc".toByteArray()) }.let { url ->
            assertNotNull(cache.downloadContent(url, "abc", "x.bin"))
        }
        assertNotNull(cache.getCachedFile("abc"))
        assertNull("id 'ab' must NOT match cached 'abc.x'", cache.getCachedFile("ab"))
    }
}
