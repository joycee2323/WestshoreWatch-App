package com.westshoredrone.watch

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class WearBridgePackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
        return if (name == WearBridgeModule.NAME) WearBridgeModule(reactContext) else null
    }

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
        return ReactModuleInfoProvider {
            mapOf(
                WearBridgeModule.NAME to ReactModuleInfo(
                    WearBridgeModule.NAME,
                    WearBridgeModule::class.java.name,
                    false, // canOverrideExistingModule
                    false, // needsEagerInit
                    false, // isCxxModule
                    false, // isTurboModule — legacy bridge, accessed via NativeModules.WearBridge
                )
            )
        }
    }
}
