package com.remotedisplay.player.service

/**
 * #139: pure OTA throttle decision logic — no Android dependencies, so it's unit-testable
 * (see OtaThrottleTest). UpdateChecker is the imperative shell: it reads/writes the persisted
 * fields (ServerConfig / EncryptedSharedPreferences) and performs the actual download + install;
 * this object owns the stateful RULES so they have coverage beyond a compile:
 *
 *  - a new target version resets the attempt budget,
 *  - a check NEVER consumes the budget — only a launched install does (so a transient
 *    download/network failure can't park a healthy device in backoff),
 *  - after MAX_INSTALL_ATTEMPTS failed installs, back off to one retry per BACKOFF_MS,
 *  - the "entering backoff" signal fires on the crossing only (report-on-transition).
 */
object OtaThrottle {
    const val MAX_INSTALL_ATTEMPTS = 3
    const val BACKOFF_MS = 24L * 60 * 60 * 1000

    /** Persisted OTA state for the version we are currently trying to install. */
    data class State(
        val targetVersion: String = "",
        val attempts: Int = 0,
        val lastAttemptAt: Long = 0L,
        val backoffReported: Boolean = false
    )

    enum class Action { ATTEMPT, BACKOFF }

    /** True when [latestVersion] differs from the persisted target — caller drops stale APKs. */
    fun isNewTarget(state: State, latestVersion: String): Boolean = state.targetVersion != latestVersion

    /**
     * A check found [latestVersion] available. Returns the state to persist (reset on a new
     * target) and whether to attempt now. Does NOT count an attempt: the budget is consumed
     * only once an install is actually launched (see [onInstallLaunched]).
     */
    fun onUpdateAvailable(state: State, latestVersion: String, now: Long): Pair<State, Action> {
        val s = if (isNewTarget(state, latestVersion)) State(targetVersion = latestVersion) else state
        if (s.attempts >= MAX_INSTALL_ATTEMPTS && now - s.lastAttemptAt < BACKOFF_MS) {
            return s to Action.BACKOFF
        }
        return s to Action.ATTEMPT
    }

    /**
     * An install was actually launched (a verified APK was in hand). Consumes one attempt and
     * returns the new state plus whether this attempt is the FIRST to cross the cap into backoff
     * (true => caller reports "manual update required" once; false on all later polls).
     */
    fun onInstallLaunched(state: State, now: Long): Pair<State, Boolean> {
        val attempts = state.attempts + 1
        var s = state.copy(attempts = attempts, lastAttemptAt = now)
        val enteredBackoff = attempts >= MAX_INSTALL_ATTEMPTS && !s.backoffReported
        if (enteredBackoff) s = s.copy(backoffReported = true)
        return s to enteredBackoff
    }

    /** A check found us already on the latest. True if there was pending OTA state to clear. */
    fun shouldClearOnUpToDate(state: State): Boolean = state.targetVersion.isNotEmpty()

    /**
     * #139 Phase 2: operator-facing status for the dashboard.
     *  - "none"                    : no update pending.
     *  - "manual_update_required"  : capped AND still inside the backoff window — this device
     *                                can't self-install; a human needs to update it.
     *  - "pending"                 : an update is in progress / will retry (under the cap, or the
     *                                window has elapsed so a retry is due).
     */
    fun statusFor(state: State, now: Long): String = when {
        state.targetVersion.isEmpty() -> "none"
        state.attempts >= MAX_INSTALL_ATTEMPTS && now - state.lastAttemptAt < BACKOFF_MS -> "manual_update_required"
        else -> "pending"
    }
}
