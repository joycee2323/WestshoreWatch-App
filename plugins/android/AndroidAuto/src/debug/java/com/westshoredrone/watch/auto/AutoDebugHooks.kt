package com.westshoredrone.watch.auto

import android.content.Context
import com.westshoredrone.watch.auto.debugsim.FakeDroneFeed

/**
 * DEBUG variant. The release variant (src/release) has the same signature and
 * does nothing, so release builds contain no simulator code at all.
 * AutoController calls these from its session lifecycle.
 */
internal object AutoDebugHooks {
    fun onSessionStarted(context: Context, controller: AutoController) = FakeDroneFeed.attach(context, controller)
    fun onSessionStopped(controller: AutoController) = FakeDroneFeed.detach(controller)
}
