module.exports = ({ config }) => ({
  expo: {
    name: 'Westshore Watch',
    slug: 'westshorewatch',
    version: '1.0.2',
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
        NSBluetoothAlwaysUsageDescription:
          'Westshore Watch uses Bluetooth to receive Remote ID broadcasts relayed from your Westshore Watch detection nodes.',
        // remote-notification comes from the expo-notifications plugin at
        // prebuild; we declare it explicitly here alongside bluetooth-central
        // so an explicit infoPlist.UIBackgroundModes (which takes precedence)
        // doesn't drop push background delivery. bluetooth-central lets the
        // CBCentralManager keep receiving ODID adverts for a limited,
        // OS-throttled window after backgrounding — see ios/BLEScannerModule.
        UIBackgroundModes: ['remote-notification', 'bluetooth-central'],
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
      versionCode: 18,
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
      [
        'expo-secure-store',
        {
          // Real purpose string for NSFaceIDUsageDescription (we store the
          // auth_token / login credentials in SecureStore). Without this the
          // plugin injects a generic "$(PRODUCT_NAME)" placeholder — Apple
          // Guideline 5.1.1 risk.
          faceIDPermission:
            'Westshore Watch uses Face ID to protect your saved login credentials.',
        },
      ],
      [
        'expo-location',
        {
          // The app only calls requestWhenInUseAuthorization, so suppress the
          // Always-location keys (passing false makes @expo/config-plugins
          // applyPermissions DELETE the key) to avoid the generic
          // "$(PRODUCT_NAME)" placeholders the plugin injects by default. The
          // real WhenInUse string is also declared in ios.infoPlist; set it
          // here too so it doesn't depend on prebuild mod ordering.
          locationWhenInUsePermission:
            'Westshore Watch uses your location to center the map on your area and show nearby detections.',
          locationAlwaysAndWhenInUsePermission: false,
          locationAlwaysPermission: false,
        },
      ],
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
      // Injects the hand-written iOS BLEScanner Swift module (Swift + Obj-C
      // bridge) into the prebuilt Xcode project. Source lives in
      // plugins/ios/BLEScanner/. See plugins/withBleScanner.js. No-op on Android
      // (the Android module ships as committed Kotlin under android/).
      './plugins/withBleScanner',
    ],
    extra: {
      eas: {
        projectId: 'f40c2ea3-94c9-4552-a71a-bedb70251ba9',
      },
    },
  },
});