import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Platform, ActivityIndicator,
} from 'react-native';
import { WebView, WebViewNavigation } from 'react-native-webview';
import * as SecureStore from 'expo-secure-store';

const COLORS = {
  bg: '#0a0a0f',
  surface: '#12121a',
  border: '#1e1e2e',
  text: '#e2e8f0',
  purple: '#a855f7',
  red: '#ef4444',
};

interface Props {
  url: string;
  title: string;
  onDone: () => void;
}

export default function AdminWebScreen({ url, title, onDone }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Pass token as URL param — much more reliable than localStorage injection
    SecureStore.getItemAsync('auth_token').then(token => {
      const separator = url.includes('?') ? '&' : '?';
      setFullUrl(token ? `${url}${separator}app_token=${token}` : url);
    });
    loadTimer.current = setTimeout(() => setLoading(false), 15000);
    return () => { if (loadTimer.current) clearTimeout(loadTimer.current); };
  }, [url]);

  const handleNavigation = (request: WebViewNavigation) => {
    return request.url.startsWith('https://watch.westshoredrone.com');
  };

  if (!fullUrl) {
    return (
      <View style={[s.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={COLORS.purple} size="large" />
      </View>
    );
  }

  return (
    <View style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={onDone} style={s.backBtn}>
          <Text style={s.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>{title}</Text>
        <View style={{ width: 60 }} />
      </View>

      {error ? (
        <View style={s.errorContainer}>
          <Text style={s.errorText}>Failed to load page.</Text>
          <TouchableOpacity onPress={() => { setError(false); setLoading(true); }}>
            <Text style={[s.backText, { marginTop: 12 }]}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <WebView
          source={{ uri: fullUrl }}
          style={{ flex: 1, backgroundColor: COLORS.bg }}
          onShouldStartLoadWithRequest={handleNavigation}
          onLoadStart={() => setLoading(true)}
          onLoadEnd={() => {
            if (loadTimer.current) clearTimeout(loadTimer.current);
            setLoading(false);
          }}
          onError={() => { setLoading(false); setError(true); }}
          javaScriptEnabled
          domStorageEnabled
          thirdPartyCookiesEnabled
          sharedCookiesEnabled
          cacheEnabled={false}
          incognito={false}
          userAgent="Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
        />
      )}

      {loading && !error && (
        <View style={s.loadingOverlay}>
          <ActivityIndicator color={COLORS.purple} size="large" />
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: Platform.OS === 'ios' ? 56 : 40, paddingBottom: 12, paddingHorizontal: 16,
    backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  backBtn: { width: 60 },
  backText: { color: COLORS.purple, fontSize: 14 },
  title: {
    color: COLORS.text, fontSize: 13, fontWeight: '700', letterSpacing: 3,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.bg, justifyContent: 'center', alignItems: 'center',
  },
  errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorText: { color: COLORS.red, fontSize: 14 },
});
