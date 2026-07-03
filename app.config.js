module.exports = ({ config }) => ({
  expo: {
    name: 'Westshore Watch',
    slug: 'westshorewatch',
    version: '1.1.2',
    orientation: 'default',
    icon: './assets/icon.png',
    scheme: 'westshorewatch',
    userInterfaceStyle: 'automatic',
    jsEngine: 'hermes',
    splash: {
      image: './assets/splash.png',
      resizeMode: 'contain',
      backgroundColor: '#0a0e1a',
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.westshoredrone.watch',
      buildNumber: '1',
      config: {
        usesNonExemptEncryption: false,
      },
      infoPlist: {
        NSLocationWhenInUseUsageDescription:
          'Westshore Watch uses your location to center the map on your area and show nearby detections.',
        ITSAppUsesNonExemptEncryption: false,
      },
      entitlements: {
        'aps-environment': 'production',
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#0a0e1a',
      },
      // `package` intentionally omitted — the native android/ directory
      // exists, so EAS reads applicationId from android/app/build.gradle
      // (com.westshoredrone.watch). Keeping it here too just produced an
      // EAS warning about the dupe being ignored.
      // versionCode here is the source of truth ONLY for builds that
      // skip native prebuild; once android/app/build.gradle exists EAS
      // uses the gradle value. We still keep these aligned to prevent
      // future confusion when someone greps app.config.js for "what
      // version is shipping".
      versionCode: 22,
      // FCM credentials for push delivery on standalone builds. EAS
      // Build resolves GOOGLE_SERVICES_JSON (set as an EAS secret with
      // type=file) and substitutes the path; the local fallback is
      // ./google-services.json (gitignored, the source of truth for
      // local builds and prebuild). The Google Services gradle plugin
      // ALSO needs the file at android/app/google-services.json — see
      // android/app/build.gradle apply plugin line.
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON || './google-services.json',
      permissions: [
        'BLUETOOTH',
        'BLUETOOTH_ADMIN',
        'BLUETOOTH_SCAN',
        'BLUETOOTH_CONNECT',
        'ACCESS_FINE_LOCATION',
        'ACCESS_COARSE_LOCATION',
        'FOREGROUND_SERVICE',
        'FOREGROUND_SERVICE_CONNECTED_DEVICE',
      ],
    },
    plugins: [
      [
        '@rnmapbox/maps',
        {
          RNMapboxMapsDownloadToken: process.env.MAPBOX_DOWNLOAD_TOKEN,
        },
      ],
      'expo-secure-store',
      'expo-location',
      // Notification icon defaults to the app icon. Add `icon` and
      // `color` here once a dedicated 96×96 monochrome notification
      // PNG is committed under ./assets/notification-icon.png.
      [
        'expo-notifications',
        {
          color: '#00d4ff',
          mode: 'production',
          enableBackgroundRemoteNotifications: true,
        },
      ],
    ],
    extra: {
      eas: {
        projectId: 'f40c2ea3-94c9-4552-a71a-bedb70251ba9',
      },
    },
  },
});