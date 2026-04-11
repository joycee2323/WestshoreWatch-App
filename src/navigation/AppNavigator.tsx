import React, { useEffect } from 'react';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useColorScheme, Platform, View, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuthStore } from '../store/authStore';
import { useTheme } from '../theme';

import SettingsScreen from '../screens/SettingsScreen';
import LoginScreen from '../screens/LoginScreen';
import GuestScanScreen from '../screens/GuestScanScreen';
import LiveMapScreen from '../screens/LiveMapScreen';
import DeploymentsScreen from '../screens/DeploymentsScreen';
import NodesScreen from '../screens/NodesScreen';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function AuthTabs() {
  const colors = useTheme();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
        },
        tabBarActiveTintColor: colors.cyan,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: {
          fontSize: 9,
          letterSpacing: 1,
          fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
        },
        tabBarIcon: ({ focused, color, size }) => {
          const icons: Record<string, string> = {
            LiveMap: focused ? 'map' : 'map-outline',
            Deployments: focused ? 'radio' : 'radio-outline',
            Nodes: focused ? 'hardware-chip' : 'hardware-chip-outline',
            Settings: focused ? 'person-circle' : 'person-circle-outline',
          };
          return <Ionicons name={icons[route.name] as any} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="LiveMap" component={LiveMapScreen} options={{ tabBarLabel: 'LIVE MAP' }} />
      <Tab.Screen name="Deployments" component={DeploymentsScreen} options={{ tabBarLabel: 'DEPLOYMENTS' }} />
      <Tab.Screen name="Nodes" component={NodesScreen} options={{ tabBarLabel: 'NODES' }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarLabel: 'ACCOUNT' }} />
    </Tab.Navigator>
  );
}

export default function AppNavigator() {
  const scheme = useColorScheme();
  const { token, isLoading, loadToken } = useAuthStore();
  const colors = useTheme();

  useEffect(() => { loadToken(); }, []);

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={colors.cyan} size="large" />
      </View>
    );
  }

  const navTheme = scheme === 'dark'
    ? { ...DarkTheme, colors: { ...DarkTheme.colors, background: colors.bg, card: colors.surface, border: colors.border, primary: colors.cyan, text: colors.text, notification: colors.red } }
    : { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: colors.bg, card: colors.surface, border: colors.border, primary: colors.cyan, text: colors.text, notification: colors.red } };

  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {token ? (
          <Stack.Screen name="Main" component={AuthTabs} />
        ) : (
          <>
            <Stack.Screen name="Login" component={LoginScreen} />
            <Stack.Screen name="GuestScan" component={GuestScanScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
