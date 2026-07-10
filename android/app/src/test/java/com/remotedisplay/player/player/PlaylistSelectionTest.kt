package com.remotedisplay.player.player

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Screen-resilience (FIX 2): a pending/failed/stalled content download must NEVER blank or freeze
 * a screen that is showing content. These prove the SELECTION rules that guarantee it — unready
 * items are skipped (the player keeps looping what it has), and "nothing playable" keeps the
 * current content whenever anything is on screen.
 */
class PlaylistSelectionTest {

    // helper: items 0..n-1, `ready` are the indices whose content is downloaded/available
    private fun readyPredicate(vararg ready: Int): (Int) -> Boolean = { it in ready.toSet() }

    // ===== the KEY viewer scenario: playing item 0, item 1's download is stalled =====
    @Test fun `a stalled download of the NEXT item does not interrupt current content — it loops what it has`() {
        // playlist [0 ready, 1 NOT ready(downloading)]; currently playing 0. Advancing must SKIP 1
        // and come back to 0, so the viewer keeps seeing content (no blank, no "Downloading…").
        val idx = PlaylistSelection.nextPlayableIndex(size = 2, from = 0, isPlayable = readyPredicate(0))
        assertEquals("must skip the un-downloaded item and keep playing item 0", 0, idx)
    }

    @Test fun `once the download completes the next item is picked up on the following advance`() {
        // now item 1 is downloaded too -> advancing from 0 swaps to 1 (only fully-ready content).
        val idx = PlaylistSelection.nextPlayableIndex(size = 2, from = 0, isPlayable = readyPredicate(0, 1))
        assertEquals(1, idx)
    }

    // ===== partial-file safety: an un-ready (partial/corrupt) item is never selected =====
    @Test fun `an un-ready (partial-download) item is never chosen to play`() {
        // items [0 ready, 1 partial/not-ready, 2 ready] -> selection never returns 1.
        assertEquals(0, PlaylistSelection.firstPlayableIndex(3, readyPredicate(0, 2)))
        assertEquals(2, PlaylistSelection.nextPlayableIndex(3, 0, readyPredicate(0, 2)))
        assertEquals(0, PlaylistSelection.nextPlayableIndex(3, 2, readyPredicate(0, 2)))
    }

    // ===== nothing downloaded yet =====
    @Test fun `no item ready returns -1 (nothing to play)`() {
        assertEquals(-1, PlaylistSelection.firstPlayableIndex(3, readyPredicate()))
        assertEquals(-1, PlaylistSelection.nextPlayableIndex(3, 1, readyPredicate()))
    }

    // ===== the invariant: never blank while content is on screen =====
    @Test fun `nothing-playable KEEPS current content whenever something is on screen (never blanks)`() {
        assertEquals(PlaylistSelection.NonePlayable.KEEP_CURRENT,
            PlaylistSelection.whenNonePlayable(hasContentOnScreen = true))
    }

    @Test fun `nothing-playable shows the defined waiting state only when nothing is displayed yet`() {
        assertEquals(PlaylistSelection.NonePlayable.SHOW_WAITING,
            PlaylistSelection.whenNonePlayable(hasContentOnScreen = false))
    }

    // ===== single downloaded item loops (doesn't blank waiting for others) =====
    @Test fun `a single downloaded item loops instead of blanking`() {
        assertEquals(0, PlaylistSelection.nextPlayableIndex(1, 0, readyPredicate(0)))
    }
}
