#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Exposes the Swift WSWBLEScanner class to React Native under the JS module name
// "BLEScanner" — matching android/.../BLEScannerModule NAME and the lookup in
// src/specs/NativeBLEScanner.ts (TurboModuleRegistry.get('BLEScanner')).
//
// RCT_EXTERN_REMAP_MODULE(jsName, swiftClass, superClass): the first argument is
// the JS-visible name, so it stays "BLEScanner" even though the Swift class is
// WSWBLEScanner (prefixed to avoid colliding with the codegen-generated
// NativeBLEScannerSpec symbol from Android's TurboModule spec).
@interface RCT_EXTERN_REMAP_MODULE(BLEScanner, WSWBLEScanner, RCTEventEmitter)

RCT_EXTERN_METHOD(startService:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopService:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(configure:(NSDictionary *)config
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getWatchdogStats:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// RCTEventEmitter supplies addListener:/removeListeners: itself, so the
// NativeEventEmitter contract in the spec is satisfied without explicit
// RCT_EXTERN_METHOD declarations here.

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

@end
