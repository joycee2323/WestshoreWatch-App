package com.westshoredrone.watch.auto

import android.content.Context

/**
 * RELEASE variant: intentionally empty. The debug variant (src/debug) wires in
 * the fake-drone simulator; release builds must not contain it.
 */
internal object AutoDebugHooks {
    @Suppress("UNUSED_PARAMETER")
    fun onSessionStarted(context: Context, controller: AutoController) {}
    @Suppress("UNUSED_PARAMETER")
    fun onSessionStopped(controller: AutoController) {}
}
