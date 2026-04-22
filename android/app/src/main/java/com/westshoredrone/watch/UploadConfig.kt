package com.westshoredrone.watch

// Holds the upload endpoint + bearer token for the native detection uploader.
// JS pushes values in via BLEScanner.configure() at startup and on token
// refresh; the running service reads from here so config survives service
// restarts (e.g. foreground-service restart in Doze).
object UploadConfig {
    @Volatile var baseUrl: String? = "https://api.westshoredrone.com"
    @Volatile var authToken: String? = null
}
