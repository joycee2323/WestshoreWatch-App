import React, { useCallback, useEffect, useRef, useState } from 'react';
import { NativeModules, Platform, StyleSheet, Text, TouchableOpacity } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme';

export const KEEP_SCREEN_ON_STORAGE_KEY = 'keep_screen_on';

// Android uses a custom Kotlin native module (KeepScreenOnModule.kt) because
// expo-keep-awake's Android path resolves the Activity through the legacy Expo
// moduleRegistry ActivityProvider, which silently fails under Bridgeless / New
// Architecture (ERR_NO_ACTIVITY). iOS uses expo-keep-awake directly — the iOS
// Swift implementation uses UIApplication.shared.isIdleTimerDisabled and does
// not go through ActivityProvider.
//
// On Android the tag is diagnostic-only (single global FLAG_KEEP_SCREEN_ON,
// last call wins). On iOS the tag is honored via expo-keep-awake's ref-counted
// tag set. In practice the difference doesn't manifest because only one
// KeepScreenOnToggle is mounted at a time.
type KeepAwakeAdapter = {
  activate: (tag: string) => Promise<void>;
  deactivate: (tag: string) => Promise<void>;
};

const keepAwake: KeepAwakeAdapter = Platform.OS === 'android'
  ? (() => {
      const native = (NativeModules as { KeepScreenOn?: { activate: () => Promise<void>; deactivate: () => Promise<void> } }).KeepScreenOn;
      return {
        activate: (_tag: string) => native ? native.activate() : Promise.resolve(),
        deactivate: (_tag: string) => native ? native.deactivate() : Promise.resolve(),
      };
    })()
  : {
      activate: (tag: string) => activateKeepAwakeAsync(tag),
      deactivate: (tag: string) => deactivateKeepAwake(tag),
    };

type Props = {
  keepAwakeTag: string;
};

export default function KeepScreenOnToggle({ keepAwakeTag }: Props) {
  const colors = useTheme();
  const [enabled, setEnabled] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(KEEP_SCREEN_ON_STORAGE_KEY)
      .then(raw => {
        console.info('[keepAwake] AsyncStorage load, tag=', keepAwakeTag, 'raw=', raw);
        if (raw === 'true') setEnabled(true);
      })
      .catch(err => console.warn('[keepAwake] Failed to load keepScreenOn:', err))
      .finally(() => { loaded.current = true; });
  }, [keepAwakeTag]);

  useEffect(() => {
    if (!loaded.current) return;
    console.info('[keepAwake] enabled changed, tag=', keepAwakeTag, 'enabled=', enabled);
    AsyncStorage.setItem(KEEP_SCREEN_ON_STORAGE_KEY, enabled ? 'true' : 'false')
      .catch(err => console.warn('[keepAwake] Failed to save keepScreenOn:', err));
  }, [enabled, keepAwakeTag]);

  useFocusEffect(
    useCallback(() => {
      console.info('[keepAwake] focus effect, tag=', keepAwakeTag, 'enabled=', enabled);
      if (enabled) {
        console.info('[keepAwake] calling activate, tag=', keepAwakeTag);
        keepAwake.activate(keepAwakeTag)
          .then(() => console.info('[keepAwake] activate resolved, tag=', keepAwakeTag))
          .catch(err => console.warn('[keepAwake] activate rejected, tag=', keepAwakeTag, 'err=', err));
      }
      return () => {
        console.info('[keepAwake] cleanup, calling deactivate, tag=', keepAwakeTag);
        keepAwake.deactivate(keepAwakeTag)
          .then(() => console.info('[keepAwake] deactivate resolved, tag=', keepAwakeTag))
          .catch(err => console.warn('[keepAwake] deactivate rejected, tag=', keepAwakeTag, 'err=', err));
      };
    }, [enabled, keepAwakeTag])
  );

  const s = styles(colors);
  return (
    <TouchableOpacity
      onPress={() => setEnabled(prev => !prev)}
      accessibilityLabel="Keep screen on"
      accessibilityRole="switch"
      accessibilityState={{ checked: enabled }}
      style={[s.btn, enabled && s.btnActive]}
    >
      <Ionicons
        name={enabled ? 'sunny' : 'sunny-outline'}
        size={18}
        color={enabled ? colors.green : colors.textMuted}
      />
      <Text style={[s.label, { color: enabled ? colors.green : colors.textMuted }]}>
        SCREEN ON
      </Text>
    </TouchableOpacity>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  btn: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  btnActive: {
    borderColor: 'rgba(0,255,136,0.4)',
    backgroundColor: 'rgba(0,255,136,0.12)',
  },
  label: {
    fontSize: 8,
    letterSpacing: 0.5,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
});
