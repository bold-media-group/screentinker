package com.remotedisplay.player.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #139: coverage for the OTA throttle state machine (the stateful core that the OTA
 * re-download-loop fix depends on), independent of Android. UpdateChecker is just the shell.
 */
class OtaThrottleTest {

    private val V = "1.9.1-beta6"
    private val MAX = OtaThrottle.MAX_INSTALL_ATTEMPTS
    private val WINDOW = OtaThrottle.BACKOFF_MS

    // Launch `n` installs from `start`, returning the resulting state.
    private fun launch(start: OtaThrottle.State, n: Int, now: Long = 1000L): OtaThrottle.State {
        var s = start
        repeat(n) { s = OtaThrottle.onInstallLaunched(s, now + it).first }
        return s
    }

    @Test fun newTargetResetsBudget() {
        val stale = OtaThrottle.State(targetVersion = "1.9.1-beta5", attempts = 2, lastAttemptAt = 1000, backoffReported = true)
        assertTrue(OtaThrottle.isNewTarget(stale, V))
        val (s, action) = OtaThrottle.onUpdateAvailable(stale, V, now = 5000)
        assertEquals(V, s.targetVersion)
        assertEquals(0, s.attempts)
        assertEquals(0L, s.lastAttemptAt)
        assertFalse(s.backoffReported)
        assertEquals(OtaThrottle.Action.ATTEMPT, action)
    }

    @Test fun aCheckNeverConsumesBudget_onlyInstallLaunchedDoes() {
        var s = OtaThrottle.State(targetVersion = V, attempts = 0)
        // Repeated checks (e.g. each followed by a failed download) must not advance the counter.
        repeat(5) {
            val (ns, action) = OtaThrottle.onUpdateAvailable(s, V, now = 100)
            assertEquals(OtaThrottle.Action.ATTEMPT, action)
            assertEquals(0, ns.attempts)
            s = ns
        }
        // Only a launched install increments.
        assertEquals(1, OtaThrottle.onInstallLaunched(s, now = 200).first.attempts)
    }

    @Test fun capThenBackoffWithinWindow() {
        val s = launch(OtaThrottle.State(targetVersion = V), MAX, now = 1000L)
        assertEquals(MAX, s.attempts)
        assertTrue(s.backoffReported)
        // A check inside the window → BACKOFF, no further attempt, state unchanged.
        val (ns, action) = OtaThrottle.onUpdateAvailable(s, V, now = 1000L + WINDOW - 1)
        assertEquals(OtaThrottle.Action.BACKOFF, action)
        assertEquals(MAX, ns.attempts)
    }

    @Test fun enterBackoffSignalsExactlyOnce() {
        var s = OtaThrottle.State(targetVersion = V)
        var crossings = 0
        repeat(MAX + 3) { i ->
            val (ns, entered) = OtaThrottle.onInstallLaunched(s, now = i.toLong())
            if (entered) crossings++
            s = ns
        }
        assertEquals("enter-backoff fires only on the crossing", 1, crossings)
    }

    @Test fun retryAfterWindowElapsedDoesNotReReport() {
        val capped = OtaThrottle.State(targetVersion = V, attempts = MAX, lastAttemptAt = 0L, backoffReported = true)
        val (afterCheck, action) = OtaThrottle.onUpdateAvailable(capped, V, now = WINDOW + 1)
        assertEquals(OtaThrottle.Action.ATTEMPT, action) // window elapsed → one retry allowed
        val (_, entered) = OtaThrottle.onInstallLaunched(afterCheck, now = WINDOW + 2)
        assertFalse("already reported entering backoff — must not report again", entered)
    }

    @Test fun clearsOnSuccessOnlyWhenPending() {
        assertTrue(OtaThrottle.shouldClearOnUpToDate(OtaThrottle.State(targetVersion = V, attempts = 2)))
        assertFalse(OtaThrottle.shouldClearOnUpToDate(OtaThrottle.State())) // nothing pending
    }

    @Test fun statusForReflectsBackoffWindow() {
        val now = 10_000L
        // no target → none
        assertEquals("none", OtaThrottle.statusFor(OtaThrottle.State(), now))
        // under the cap → pending
        assertEquals("pending", OtaThrottle.statusFor(
            OtaThrottle.State(targetVersion = V, attempts = 1, lastAttemptAt = now), now))
        // capped AND inside the window → manual update required
        assertEquals("manual_update_required", OtaThrottle.statusFor(
            OtaThrottle.State(targetVersion = V, attempts = MAX, lastAttemptAt = now), now + WINDOW - 1))
        // capped but window elapsed (a retry is due) → pending, not stuck
        assertEquals("pending", OtaThrottle.statusFor(
            OtaThrottle.State(targetVersion = V, attempts = MAX, lastAttemptAt = now), now + WINDOW + 1))
    }
}
