package com.westshoredrone.watch.auto

import android.content.pm.PackageInfo
import android.content.pm.Signature
import androidx.car.app.HostInfo
import androidx.car.app.validation.HostValidator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Release builds only bind to Google's real hosts. A wrong allowlist means the
 * release app silently fails to appear in cars, so pin what we rely on.
 * (A positive "real Android Auto is accepted" test isn't possible here: it needs
 * Google's actual signing certificate, and Robolectric 4.14 can't fabricate a
 * SigningInfo. That part is checked on a device; see android-auto-STATUS.md.)
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = android.app.Application::class)
class CarHostValidatorsTest {
    private val app get() = RuntimeEnvironment.getApplication()

    /** Entries are "<sha256 hex>,\n<whitespace><package>" in the library resource. */
    private fun allowlist(): List<Pair<String, String>> =
        app.resources.getStringArray(androidx.car.app.R.array.hosts_allowlist_sample).map { item ->
            val (digest, pkg) = item.split(',').map { it.trim() }
            digest.lowercase() to pkg
        }

    @Test fun `library allowlist still carries the Android Auto and AAOS host certificates`() {
        // Car App Library 1.7.0. If a library upgrade changes this list, this test
        // fails on purpose: re-read the release notes and update the expectation.
        val expected = setOf(
            "fdb00c43dbde8b51cb312aa81d3b5fa17713adb94b28f598d77f8eb89daceedf" to GEARHEAD,
            "70811a3eacfd2e83e18da9bfede52df16ce91f2e69a44d21f18ab66991130771" to GEARHEAD,
            "1975b2f17177bc89a5dff31f9e64a6cae281a53dc1d1d59b1d147fe1c82afa00" to GEARHEAD,
            "c241ffbc8e287c4e9a4ad19632ba1b1351ad361d5177b7d7b29859bd2b7fc631" to TEMPLATES_HOST,
            "dd66deaf312d8daec7adbe85a218ecc8c64f3b152f9b5998d5b29300c2623f61" to TEMPLATES_HOST,
            "50e603d333c6049a37bd751375d08f3bd0abebd33facd30bd17b64b89658b421" to TEMPLATES_HOST,
        )
        assertEquals(expected, allowlist().toSet())
    }

    @Test fun `debuggable builds accept any host`() {
        assertSame(HostValidator.ALLOW_ALL_HOSTS_VALIDATOR, CarHostValidators.forBuild(app, debuggable = true))
    }

    @Test fun `release validator is a real allowlist, not allow-all`() {
        val v = CarHostValidators.forBuild(app, debuggable = false)
        assertNotSame(HostValidator.ALLOW_ALL_HOSTS_VALIDATOR, v)
        // Every allow-listed digest is registered under its host package.
        val byPkg = allowlist().groupBy({ it.second }, { it.first })
        for ((pkg, digests) in byPkg) {
            assertEquals(digests.toSet(), v.allowedHosts[pkg]?.map { it.lowercase() }?.toSet())
        }
    }

    @Test fun `release validator rejects a host that isn't installed`() {
        val v = CarHostValidators.forBuild(app, debuggable = false)
        assertFalse(v.isValidHost(HostInfo("com.example.not.a.host", 10_123)))
    }

    @Test fun `release validator rejects an app impersonating Android Auto with another key`() {
        val pi = PackageInfo().apply {
            packageName = GEARHEAD
            @Suppress("DEPRECATION")
            signatures = arrayOf(Signature("0102030405060708"))
        }
        shadowOf(app.packageManager).installPackage(pi)
        val uid = app.packageManager.getPackageUid(GEARHEAD, 0)
        val v = CarHostValidators.forBuild(app, debuggable = false)
        assertFalse(v.isValidHost(HostInfo(GEARHEAD, uid)))
    }

    private companion object {
        const val GEARHEAD = "com.google.android.projection.gearhead"
        const val TEMPLATES_HOST = "com.google.android.apps.automotive.templates.host"
    }
}
