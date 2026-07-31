// theme.ts
import { vars } from "nativewind";

// ============================================================================
// FONT CONFIGURATION
// ============================================================================
// Each theme can define its own font families. Fonts are loaded in _layout.tsx
// using expo-font and referenced via CSS variables in tailwind.config.js.
//
// Font families:
// - heading: Used for h1-h4 headings
// - body: Used for body text, labels, captions
// - mono: Used for code snippets
// ============================================================================

export interface ThemeFonts {
  heading: {
    family: string;
    weights: Record<string, string>; // weight name -> font file key
  };
  body: {
    family: string;
    weights: Record<string, string>;
  };
  mono: {
    family: string;
    weights: Record<string, string>;
  };
}

// Default theme fonts: Inter for clean, modern typography
export const themeFonts: ThemeFonts = {
  heading: {
    family: 'Inter',
    weights: {
      normal: 'Inter_400Regular',
      medium: 'Inter_500Medium',
      semibold: 'Inter_600SemiBold',
      bold: 'Inter_700Bold',
    },
  },
  body: {
    family: 'Inter',
    weights: {
      normal: 'Inter_400Regular',
      medium: 'Inter_500Medium',
      semibold: 'Inter_600SemiBold',
    },
  },
  mono: {
    family: 'JetBrainsMono',
    weights: {
      normal: 'JetBrainsMono_400Regular',
      medium: 'JetBrainsMono_500Medium',
    },
  },
};


// 🔴 AI: These are PLACEHOLDER values — you MUST replace ALL colors below
// with a custom palette that matches the app's personality.
// Do NOT keep these defaults. Generate your own unique colors.
export const lightTheme = vars({
  "--radius": "10", // 0.625rem = 10px

  // Core semantic colors
  "--background": "255 255 255",
  "--foreground": "23 23 23",

  "--card": "255 255 255",
  "--card-foreground": "23 23 23",

  "--popover": "255 255 255",
  "--popover-foreground": "23 23 23",

  "--primary": "24 24 27",
  "--primary-foreground": "250 250 250",

  "--secondary": "244 244 245",
  "--secondary-foreground": "24 24 27",

  "--muted": "244 244 245",
  "--muted-foreground": "113 113 122",

  "--accent": "244 244 245",
  "--accent-foreground": "24 24 27",

  "--destructive": "220 38 38",

  "--border": "228 228 231",
  "--input": "228 228 231",
  "--ring": "161 161 170",

  // Chart colors
  "--chart-1": "231 111 81",
  "--chart-2": "42 157 143",
  "--chart-3": "38 70 83",
  "--chart-4": "233 196 106",
  "--chart-5": "244 162 97",

  // Sidebar colors
  "--sidebar": "250 250 250",
  "--sidebar-foreground": "23 23 23",
  "--sidebar-primary": "24 24 27",
  "--sidebar-primary-foreground": "250 250 250",
  "--sidebar-accent": "244 244 245",
  "--sidebar-accent-foreground": "24 24 27",
  "--sidebar-border": "228 228 231",
  "--sidebar-ring": "161 161 170",
});

// 🔴 AI: Replace ALL dark theme colors too — tint backgrounds with your brand color.
export const darkTheme = vars({
  "--radius": "10",

  // Core semantic colors — REPLACE with brand-tinted dark values
  "--background": "23 23 23",
  "--foreground": "250 250 250",

  "--card": "30 30 30",
  "--card-foreground": "250 250 250",

  "--popover": "45 45 45",
  "--popover-foreground": "250 250 250",

  "--primary": "228 228 231",
  "--primary-foreground": "24 24 27",

  "--secondary": "45 45 45",
  "--secondary-foreground": "250 250 250",

  "--muted": "45 45 45",
  "--muted-foreground": "161 161 170",

  "--accent": "64 64 64",
  "--accent-foreground": "250 250 250",

  "--destructive": "239 68 68",

  "--border": "38 38 38",
  "--input": "45 45 45",
  "--ring": "113 113 122",

  // Chart colors
  "--chart-1": "99 102 241",
  "--chart-2": "34 197 94",
  "--chart-3": "244 162 97",
  "--chart-4": "168 85 247",
  "--chart-5": "239 68 68",

  // Sidebar colors
  "--sidebar": "30 30 30",
  "--sidebar-foreground": "250 250 250",
  "--sidebar-primary": "99 102 241",
  "--sidebar-primary-foreground": "250 250 250",
  "--sidebar-accent": "45 45 45",
  "--sidebar-accent-foreground": "250 250 250",
  "--sidebar-border": "38 38 38",
  "--sidebar-ring": "82 82 82",
});