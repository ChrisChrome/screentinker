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
