package com.remotedisplay.player.service

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What the retry cadence ACTUALLY is once a device caps out, driven through the real OtaThrottle
 * on a simulated timeline rather than read off the source.
 *
 * The question this settles: after MAX_INSTALL_ATTEMPTS, does a device get a fresh budget of 3
 * attempts every BACKOFF_MS, or a single attempt? It matters for a fleet whose installs fail at
 * the confirm dialog — it is the difference between 3 dialogs a day and 1.
 */
class OtaBackoffCadenceTest {

    private val CHECK_INTERVAL = 30 * 60 * 1000L   // UpdateChecker.CHECK_INTERVAL
    private val TARGET = "1.9.23"

    /** Run `hours` of checks at the real 30-minute cadence; return the ms of each launched install. */
    private fun simulate(hours: Int, installSucceeds: Boolean = false): List<Long> {
        var state = OtaThrottle.State()
        val attemptsAt = mutableListOf<Long>()
        var now = 0L
        val end = hours.toLong() * 60 * 60 * 1000
        while (now <= end) {
            val (afterCheck, action) = OtaThrottle.onUpdateAvailable(state, TARGET, now)
            state = afterCheck
            if (action == OtaThrottle.Action.ATTEMPT) {
                // The device downloaded + verified an APK and launched the installer. It failing is
                // the case under test: the install never completes, so the target never changes.
                if (installSucceeds) break
                val (afterLaunch, _) = OtaThrottle.onInstallLaunched(state, now)
                state = afterLaunch
                attemptsAt.add(now)
            }
            now += CHECK_INTERVAL
        }
        return attemptsAt
    }

    @Test fun the_first_three_attempts_burn_fast_at_the_check_cadence() {
        val at = simulate(hours = 2)
        assertEquals(3, at.size)
        // Back to back on consecutive 30-min checks, so the cap is reached within about an hour.
        assertEquals(listOf(0L, CHECK_INTERVAL, CHECK_INTERVAL * 2), at)
    }

    @Test fun THE_QUESTION_after_the_cap_it_is_ONE_attempt_per_24h_not_three() {
        val at = simulate(hours = 24 * 3 + 2)   // three full days
        // 3 in the opening burst, then one per 24h window.
        assertEquals(6, at.size)
        val afterBurst = at.drop(3)
        assertEquals(3, afterBurst.size)
        for (i in 1 until afterBurst.size) {
            val gap = afterBurst[i] - afterBurst[i - 1]
            assertEquals("post-cap retries must be 24h apart", OtaThrottle.BACKOFF_MS, gap)
        }
    }

    @Test fun why_it_is_one_and_not_three_attempts_never_reset_with_time() {
        // Each post-cap attempt increments attempts AND refreshes lastAttemptAt, so the device is
        // immediately back inside a fresh 24h window. Only a NEW target version resets the budget
        // (isNewTarget -> State(targetVersion = ...)), never the passage of time.
        var s = OtaThrottle.State(targetVersion = TARGET, attempts = OtaThrottle.MAX_INSTALL_ATTEMPTS,
            lastAttemptAt = 0L, backoffReported = true)
        val justPastWindow = OtaThrottle.BACKOFF_MS + 1
        assertEquals(OtaThrottle.Action.ATTEMPT, OtaThrottle.onUpdateAvailable(s, TARGET, justPastWindow).second)
        s = OtaThrottle.onInstallLaunched(s, justPastWindow).first
        assertEquals(OtaThrottle.MAX_INSTALL_ATTEMPTS + 1, s.attempts)   // grows, never resets
        // 30 minutes later it is capped again.
        assertEquals(OtaThrottle.Action.BACKOFF,
            OtaThrottle.onUpdateAvailable(s, TARGET, justPastWindow + CHECK_INTERVAL).second)
    }

    @Test fun a_new_release_DOES_hand_back_a_full_budget_of_three() {
        var s = OtaThrottle.State(targetVersion = TARGET, attempts = 9,
            lastAttemptAt = 1_000L, backoffReported = true)
        val (fresh, action) = OtaThrottle.onUpdateAvailable(s, "1.9.24", 2_000L)
        assertEquals(OtaThrottle.Action.ATTEMPT, action)
        assertEquals(0, fresh.attempts)
        assertEquals("1.9.24", fresh.targetVersion)
    }
}
