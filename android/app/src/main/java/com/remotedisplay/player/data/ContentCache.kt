package com.remotedisplay.player.data

import android.content.Context
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

/**
 * Root-2 caching fixes vs the "stuck downloading / frozen" bug:
 *  - a hard OVERALL [callTimeout] so a slow-drip/stalled download on a HEALTHY socket can't hang
 *    forever (the old client only had a per-read timeout, which a trickle never trips),
 *  - download to a `.part` temp + integrity-check (Content-Length) via [CacheValidation] + atomic
 *    rename, so a truncated/interrupted body is NEVER promoted to the cache and played as if whole,
 *  - exact-prefix cache lookup that also excludes in-flight `.part` files.
 *
 * The primary constructor takes the cache dir + client directly so the real download logic is
 * unit-testable (see ContentDownloadTest) against a local server without an Android Context; the
 * [Context] convenience constructor is what the app uses.
 */
class ContentCache internal constructor(
    private val cacheDir: File,
    private val client: OkHttpClient
) {
    constructor(context: Context) : this(
        File(context.filesDir, "content_cache").also { it.mkdirs() },
        defaultClient()
    )

    fun getCachedFile(contentId: String): File? {
        // Match "<id>.<ext>" exactly: the trailing dot stops an id that PREFIXES another id from
        // cross-matching, and `.part` temps (partial/in-flight downloads) are never returned.
        val files = cacheDir.listFiles { _, name -> name.startsWith("$contentId.") && !name.endsWith(PART_SUFFIX) }
        val hit = files?.firstOrNull()?.takeIf { it.exists() && it.length() > 0 }
        com.remotedisplay.player.util.DebugLog.v("ContentCache", "getCachedFile($contentId): dir=${cacheDir.absolutePath} listFiles=${files?.size} -> ${hit?.name ?: "MISS"}")
        return hit
    }

    fun isContentCached(contentId: String): Boolean {
        return getCachedFile(contentId) != null
    }

    fun downloadContent(serverUrl: String, contentId: String, filename: String): File? {
        val ext = filename.substringAfterLast('.', "mp4")
        val finalFile = File(cacheDir, "${contentId}.${ext}")
        val partFile = File(cacheDir, "${contentId}.${ext}${PART_SUFFIX}")
        try {
            val url = "${serverUrl}/api/content/${contentId}/file"
            val request = Request.Builder().url(url).build()
            // .use closes the Response (and its body) on every path — also fixes the prior
            // error-path body/connection leak.
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.e("ContentCache", "Download failed: ${response.code}")
                    return null
                }
                // We issue a plain (no-Range) GET, so a 206 Partial Content means a proxy/CDN
                // returned a PARTIAL body whose Content-Length matches that partial — which would
                // pass the byte-count integrity check and promote a truncated file. Require a full 200.
                if (response.code == 206) {
                    Log.e("ContentCache", "Refusing 206 Partial Content for $filename — not a complete file")
                    return null
                }
                partFile.delete() // clear any earlier partial before writing
                val body = response.body ?: return null
                val expected = body.contentLength() // -1 when unknown (chunked)
                var written = 0L
                body.byteStream().use { input ->
                    FileOutputStream(partFile).use { output -> written = input.copyTo(output) }
                }
                // Root-2: a truncated body must NOT be promoted to the cache and played as whole.
                if (!CacheValidation.isComplete(written, expected)) {
                    Log.e("ContentCache", "Incomplete download ($written/$expected bytes) for $filename — discarding partial")
                    partFile.delete()
                    return null
                }
                finalFile.delete()
                if (!partFile.renameTo(finalFile)) {
                    Log.e("ContentCache", "Rename failed for $filename")
                    partFile.delete()
                    return null
                }
                Log.i("ContentCache", "Downloaded: $filename -> ${finalFile.absolutePath} ($written bytes)")
                return finalFile
            }
        } catch (e: Exception) {
            // Includes callTimeout / readTimeout (a stalled download on a healthy socket) and any
            // mid-stream break — never leave a partial at the real path.
            Log.e("ContentCache", "Download error: ${e.message}")
            partFile.delete()
            return null
        }
    }

    fun deleteContent(contentId: String) {
        // Exact-prefix (with the dot) so we don't delete a different id's file — and this also
        // sweeps the "<id>.<ext>.part" temp.
        cacheDir.listFiles { _, name -> name.startsWith("$contentId.") }?.forEach { it.delete() }
        Log.i("ContentCache", "Deleted cached content: $contentId")
    }

    fun clearAll() {
        cacheDir.listFiles()?.forEach { it.delete() }
    }

    fun getCacheSize(): Long {
        return cacheDir.listFiles()?.sumOf { it.length() } ?: 0L
    }

    companion object {
        private const val PART_SUFFIX = ".part"

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)   // Root-2: a stalled stream (no bytes 30s) aborts (was 5min)
            .writeTimeout(30, TimeUnit.SECONDS)
            .callTimeout(5, TimeUnit.MINUTES)    // Root-2: hard OVERALL cap so a slow-drip can't hang forever
            .build()
    }
}
