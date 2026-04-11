# AirAware Mobile App

React Native app for AirAware X1 Remote ID operations.

## Features

- **Guest mode** — passive BLE scan for nearby drone ODID broadcasts, no login required
- **Authenticated mode** — live map connected to AirAware backend via WebSocket, deployment management, node status

## Setup

### Prerequisites
- Node.js 18+
- EAS CLI: `npm install -g eas-cli`
- Expo CLI: `npm install -g expo-cli`

### Install dependencies
```bash
npm install
```

### Run on device (development build required due to BLE)
```bash
# First time — create a development build
eas build --profile development --platform android

# Install the .apk on your device, then:
npx expo start --dev-client
```

### Build for testing (APK)
```bash
eas build --profile preview --platform android
```

### Build for production
```bash
eas build --profile production --platform android
eas build --profile production --platform ios
```

## Project Structure
```
src/
  screens/
    LoginScreen.tsx       — Login + guest entry point
    GuestScanScreen.tsx   — BLE passive scan map (no login)
    LiveMapScreen.tsx     — Backend WebSocket map (authenticated)
    DeploymentsScreen.tsx — Deployment management
    NodesScreen.tsx       — Node status list
  services/
    api.ts                — AirAware backend REST + WebSocket
    bleScanner.ts         — BLE passive scan using react-native-ble-plx
    odidParser.ts         — ASTM F3411-22a ODID message parser
  store/
    droneStore.ts         — Zustand drone state (BLE + backend)
    authStore.ts          — Auth token + user state
  navigation/
    AppNavigator.tsx      — Stack + tab navigation
  theme/
    index.ts              — Colors, theme hook
```

## Notes

- BLE scanning requires a physical device — does not work in simulators
- Location permission required for BLE scanning on Android 12+
- The OUI filter (`98:A3:16:7D`) prevents nodes from detecting each other's relay broadcasts
