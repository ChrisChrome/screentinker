package com.remotedisplay.player.player

/**
 * Pure, unit-testable playlist SELECTION + screen-resilience decisions (no Android deps, same
 * pattern as ConnectionGuard / OtaThrottle). PlaylistController is the imperative shell (Handler /
 * playback); this owns "which item can play right now" and "what to do when none can", so the
 * viewer-visible invariant has real coverage:
 *
 *   a pending/failed/stalled content download must NEVER blank or freeze a screen that is showing
 *   content — the player keeps showing what it already has and only swaps to new content once it's
 *   fully + validly downloaded.
 */
object PlaylistSelection {
    /** First index for which [isPlayable] holds, or -1 if none. */
    fun firstPlayableIndex(size: Int, isPlayable: (Int) -> Boolean): Int {
        for (i in 0 until size) if (isPlayable(i)) return i
        return -1
    }

    /**
     * Next index after [from] (wrapping) for which [isPlayable] holds, or -1 if none. With a single
     * playable item it returns that item (loop), so a device keeps looping the content it HAS while
     * other items are still downloading.
     */
    fun nextPlayableIndex(size: Int, from: Int, isPlayable: (Int) -> Boolean): Int {
        if (size <= 0) return -1
        for (i in 1..size) {
            val idx = (((from + i) % size) + size) % size
            if (isPlayable(idx)) return idx
        }
        return -1
    }

    enum class NonePlayable { KEEP_CURRENT, SHOW_WAITING }

    /**
     * When nothing is playable (e.g. the scheduled item's content isn't downloaded yet): NEVER
     * blank a screen that is showing content. Keep the current content if we have some on screen;
     * only fall to the defined waiting/setup state when there is genuinely nothing displayed yet
     * (a fresh device that has never successfully played anything). This is the one decision that
     * separates "nothing to show yet" (acceptable) from "had content but blanked while updating"
     * (the bug this fix forbids).
     */
    fun whenNonePlayable(hasContentOnScreen: Boolean): NonePlayable =
        if (hasContentOnScreen) NonePlayable.KEEP_CURRENT else NonePlayable.SHOW_WAITING
}

/**
 * #234 — where playback should RESUME when a playlist is (re)loaded.
 *
 * PlaylistController is created fresh with every MainActivity instance, so a recreate always handed
 * it an empty list and then a full one, which reads as "0 -> N items" and starts from the top. On a
 * panel that re-registers and relaunches itself at each item boundary, item 2 therefore never
 * survived more than a fraction of a second: the reporter of #234 had "never seen the photo, just
 * the video", and prod play_logs showed the second item logging 0-1s durations while the first
 * accumulated all the playtime.
 *
 * Starting from the top is only correct for a genuinely COLD start. If we were playing moments ago,
 * the right thing is to carry on. Kept pure so the window arithmetic is testable without a device.
 */
object PlaybackResume {
    /** How recently we must have been playing for a reload to count as a continuation. */
    const val RESUME_WINDOW_MS = 90_000L

    /**
     * Index to begin scanning from. [savedIndex] < 0, an empty/short playlist, a stale save, or a
     * clock that jumped backwards all fall back to 0 — i.e. to today's behaviour, so a real cold
     * start is unaffected.
     */
    fun resumeIndex(savedIndex: Int, savedAtMs: Long, nowMs: Long, itemCount: Int): Int {
        if (itemCount <= 0) return 0
        if (savedIndex < 0 || savedIndex >= itemCount) return 0
        if (savedAtMs <= 0L) return 0
        val age = nowMs - savedAtMs
        if (age < 0L || age > RESUME_WINDOW_MS) return 0
        return savedIndex
    }
}
