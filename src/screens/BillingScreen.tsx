import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Platform, ActivityIndicator,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as SecureStore from 'expo-secure-store';

const BILLING_URL = 'https://watch.westshoredrone.com/billing';

const COLORS = {
  bg: '#0a0a0f', surface: '#12121a', border: '#1e1e2e', text: '#e2e8f0', cyan: '#00d4ff',
};

const HIDE_CHROME_JS = `
(function() {
  var style = document.createElement('style');
  style.textContent = \`
    aside, nav, [class*="sidebar"], [class*="Sidebar"],
    [class*="side-bar"], [class*="SideBar"],
    [class*="left-nav"], [class*="LeftNav"] { display: none !important; }
    main, [class*="main-content"], [class*="MainContent"],
    [class*="content-area"], [class*="ContentArea"] {
      margin-left: 0 !important; padding-left: 16px !important;
      width: 100% !important; max-width: 100% !important;
    }
    header, [class*="topbar"], [class*="Topbar"],
    [class*="top-bar"], [class*="navbar"], [class*="Navbar"] { display: none !important; }
    body { background: #0a0a0f !important; }
  \`;
  document.head.appendChild(style);
})();
true;
`;

export default function BillingScreen({ onDone }: { onDone: () => void }) {
  const [loading, setLoading] = useState(true);
  const [preloadJs, setPreloadJs] = useState<string | null>(null);
  const loadingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    SecureStore.getItemAsync('auth_token').then(token => {
      const tokenJs = token ? `try{localStorage.setItem('auth_token','${token}');}catch(e){}` : '';
      setPreloadJs(`(function(){${tokenJs}})();true;`);
    });
    return () => { if (loadingTimer.current) clearTimeout(loadingTimer.current); };
  }, []);

  const startLoadingTimer = () => {
    if (loadingTimer.current) clearTimeout(loadingTimer.current);
    // Force-hide spinner after 8 seconds no matter what
    loadingTimer.current = setTimeout(() => setLoading(false), 8000);
  };

  if (preloadJs === null) {
    return (
      <View style={[s.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={COLORS.cyan} size="large" />
      </View>
    );
  }

  return (
    <View style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={onDone} style={s.backBtn}>
          <Text style={s.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>BILLING</Text>
        <View style={{ width: 60 }} />
      </View>

      <WebView
        source={{ uri: BILLING_URL }}
        style={{ flex: 1, backgroundColor: COLORS.bg }}
        injectedJavaScriptBeforeContentLoaded={preloadJs}
        injectedJavaScript={HIDE_CHROME_JS}
        onLoadStart={() => { setLoading(true); startLoadingTimer(); }}
        onLoadEnd={() => { setLoading(false); if (loadingTimer.current) clearTimeout(loadingTimer.current); }}
        onError={() => setLoading(false)}
        onHttpError={() => setLoading(false)}
        javaScriptEnabled
        domStorageEnabled
        thirdPartyCookiesEnabled
        sharedCookiesEnabled
        userAgent="Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
      />

      {loading && (
        <View style={s.loadingOverlay}>
          <ActivityIndicator color={COLORS.cyan} size="large" />
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
  backText: { color: COLORS.cyan, fontSize: 14 },
  title: {
    color: COLORS.text, fontSize: 13, fontWeight: '700', letterSpacing: 3,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.bg, justifyContent: 'center', alignItems: 'center',
  },
});
