module.exports = ({ config }) => ({
  expo: {
    name: 'AirAware',
    slug: 'airaware',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    scheme: 'airaware',
    userInterfaceStyle: 'automatic',
    jsEngine: 'hermes',
    splash: {
      image: './assets/splash.png',
      resizeMode: 'contain',
      backgroundColor: '#0a0e1a',
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.westshoredrone.airaware',
      infoPlist: {
        NSBluetoothAlwaysUsageDescription: 'AirAware uses Bluetooth to detect nearby drones broadcasting Remote ID signals.',
        NSLocationWhenInUseUsageDescription: 'AirAware uses your location to show detected drones relative to your position.',
        NSLocationAlwaysAndWhenInUseUsageDescription: 'AirAware uses your location to show detected drones relative to your position.',
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#0a0e1a',
      },
      package: 'com.westshoredrone.airaware',
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
          bluetoothAlwaysPermission: 'AirAware uses Bluetooth to detect nearby drones broadcasting Remote ID signals.',
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
        projectId: 'bd1e6717-6d7d-4103-87ba-d86c812ebe30',
      },
    },
  },
});
