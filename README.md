# Westshore Watch Mobile App

React Native app for Westshore Watch X1 Remote ID operations.

## Features

- **Guest mode** — passive BLE scan for nearby drone ODID broadcasts, no login required
- **Authenticated mode** — live map connected to Westshore Watch backend via WebSocket, deployment management, node status

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
    api.ts                — Westshore Watch backend REST + WebSocket
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
- Nodes are recognized by their company-`0x08FE` identity advert (handle 3 in
  firmware `ble_relay.c`), not by MAC OUI — so any OUI is supported. Recognition
  keys only on the identity advert: ODID relay/pack adverts (service data
  `0xFFFA`) and the detection advert (company `0x08FF`) are never treated as a
  node, so relayed drone broadcasts don't trip "NODE IN RANGE" or the add-node
  list. The relay-advert upload path (which carries no `0x08FE`) recognizes a
  source as a node only after a `0x08FE` advert has been seen from that MAC.
