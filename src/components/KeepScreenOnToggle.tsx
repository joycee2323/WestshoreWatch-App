import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useTheme } from '../theme';

export const KEEP_SCREEN_ON_STORAGE_KEY = 'keep_screen_on';

type Props = {
  /** Unique tag passed to expo-keep-awake so concurrent callers don't clobber each other. */
  keepAwakeTag: string;
};

export default function KeepScreenOnToggle({ keepAwakeTag }: Props) {
  const colors = useTheme();
  const [enabled, setEnabled] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(KEEP_SCREEN_ON_STORAGE_KEY)
      .then(raw => {
        if (raw === 'true') setEnabled(true);
      })
      .catch(err => console.warn('Failed to load keepScreenOn:', err))
      .finally(() => { loaded.current = true; });
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    AsyncStorage.setItem(KEEP_SCREEN_ON_STORAGE_KEY, enabled ? 'true' : 'false')
      .catch(err => console.warn('Failed to save keepScreenOn:', err));
  }, [enabled]);

  useFocusEffect(
    useCallback(() => {
      if (enabled) void activateKeepAwakeAsync(keepAwakeTag);
      return () => { deactivateKeepAwake(keepAwakeTag); };
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
