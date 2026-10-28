// Bridging header so the Swift module can subclass RCTEventEmitter and use the
// React Native bridge types. The config plugin (plugins/withBleScanner.js)
// copies this file into the prebuilt iOS project and points the target's
// SWIFT_OBJC_BRIDGING_HEADER build setting at it.
//
// If Expo's prebuild template already generated a "<Project>-Bridging-Header.h"
// (it does whenever the template contains Swift), the plugin instead APPENDS
// these imports to that existing header rather than overwriting the build
// setting — see the plugin for the exact logic.

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
