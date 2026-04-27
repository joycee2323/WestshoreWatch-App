module.exports = ({ config }) => ({
  expo: {
    name: 'Westshore Watch',
    slug: 'westshorewatch',
    version: '1.0.1',
    orientation: 'portrait',
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
      infoPlist: {
        NSBluetoothAlwaysUsageDescription: 'Westshore Watch uses Bluetooth to detect nearby drones broadcasting Remote ID signals.',
        NSLocationWhenInUseUsageDescription: 'Westshore Watch uses your location to show detected drones relative to your position.',
        NSLocationAlwaysAndWhenInUseUsageDescription: 'Westshore Watch uses your location to show detected drones relative to your position.',
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#0a0e1a',
      },
      package: 'com.westshoredrone.watch',
      permissions: [
        'BLUETOOTH',
        'BLUETOOTH_ADMIN',
        'BLUETOOTH_SCAN',
        'BLUETOOTH_CONNECT',
        'ACCESS_FINE_LOCATION',
        'ACCESS_COARSE_LOCATION',
        'ACCESS_BACKGROUND_LOCATION',
        'FOREGROUND_SERVICE',
        'FOREGROUND_SERVICE_CONNECTED_DEVICE',
      ],
    },
    plugins: [
      [
        'react-native-ble-plx',
        {
          isBackgroundEnabled: true,
          modes: ['peripheral', 'central'],
          bluetoothAlwaysPermission: 'Westshore Watch uses Bluetooth to detect nearby drones broadcasting Remote ID signals.',
        },
      ],
      [
        '@rnmapbox/maps',
        {
          RNMapboxMapsDownloadToken: process.env.MAPBOX_DOWNLOAD_TOKEN,
        },
      ],
      'expo-secure-store',
      'expo-location',
    ],
    extra: {
      eas: {
        projectId: 'f40c2ea3-94c9-4552-a71a-bedb70251ba9',
      },
    },
  },
});