import type { ThemeTokens } from '@cyborg/contracts';

const COMMON = {
  '--cy-font': 'system-ui, sans-serif',
  '--cy-font-mono': 'ui-monospace, monospace',
  '--cy-font-size': '12px',
  '--cy-gap': '6px',
  '--cy-radius': '4px',
} as const;

const LIGHT = {
  '--cy-scheme': 'light',
  '--cy-bg': '#ffffff',
  '--cy-surface': '#f6f8fa',
  '--cy-fg': '#1f2328',
  '--cy-muted': '#656d76',
  '--cy-border': '#d0d7de',
  '--cy-accent': '#0969da',
  '--cy-danger': '#cf222e',
} as const;

const DARK: Record<keyof typeof LIGHT, string> = {
  '--cy-scheme': 'dark',
  '--cy-bg': '#0d1117',
  '--cy-surface': '#161b22',
  '--cy-fg': '#e6edf3',
  '--cy-muted': '#8d96a0',
  '--cy-border': '#30363d',
  '--cy-accent': '#4493f8',
  '--cy-danger': '#f85149',
};

/** Токены темы для видов плагинов; набор имён один для обеих схем, меняются только значения. */
export function themeTokens(dark: boolean): ThemeTokens {
  return { ...COMMON, ...(dark ? DARK : LIGHT) };
}
