import { useColorScheme } from 'react-native';

export const darkColors = {
  bg: '#0a0e1a',
  surface: '#111827',
  surface2: '#1a2235',
  border: '#1e2d45',
  border2: '#243352',
  text: '#e2e8f0',
  textMuted: '#64748b',
  textDim: '#94a3b8',
  cyan: '#00d4ff',
  green: '#00ff88',
  amber: '#f59e0b',
  red: '#ef4444',
  purple: '#a855f7',
};

export const lightColors = {
  bg: '#f8fafc',
  surface: '#ffffff',
  surface2: '#f1f5f9',
  border: '#e2e8f0',
  border2: '#cbd5e1',
  text: '#0f172a',
  textMuted: '#64748b',
  textDim: '#475569',
  cyan: '#0284c7',
  green: '#16a34a',
  amber: '#d97706',
  red: '#dc2626',
  purple: '#9333ea',
};

export function useTheme() {
  const scheme = useColorScheme();
  return scheme === 'dark' ? darkColors : lightColors;
}

export const DRONE_COLORS = [
  '#00d4ff', '#00ff88', '#f59e0b', '#a855f7',
  '#ef4444', '#06b6d4', '#84cc16', '#f97316',
];

let colorIndex = 0;
const colorCache: Record<string, string> = {};
export function getDroneColor(uasId: string): string {
  if (!colorCache[uasId]) {
    colorCache[uasId] = DRONE_COLORS[colorIndex++ % DRONE_COLORS.length];
  }
  return colorCache[uasId];
}
