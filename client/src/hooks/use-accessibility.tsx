import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type ColorMode = "light" | "dark" | "high-contrast";
export type FontChoice = "default" | "serif" | "accessible";
export type FontSize = "small" | "default" | "large" | "x-large";

export interface AccessibilitySettings {
  colorMode: ColorMode;
  fontFamily: FontChoice;
  fontSize: FontSize;
}

export const ACCESSIBILITY_STORAGE_KEY = "cpm:accessibility";

export const DEFAULT_ACCESSIBILITY_SETTINGS: AccessibilitySettings = {
  colorMode: "light",
  fontFamily: "default",
  fontSize: "default",
};

/**
 * Applies settings to <html> via class/data attributes so CSS in index.css can key off them.
 * Exported (not just called internally) because index.html's no-flash inline script needs the
 * exact same attribute names — keep the two in sync if either changes.
 */
export function applyAccessibilitySettings(settings: AccessibilitySettings) {
  const root = document.documentElement;
  root.classList.toggle("dark", settings.colorMode === "dark");
  root.setAttribute("data-contrast", settings.colorMode === "high-contrast" ? "high" : "normal");
  root.setAttribute("data-font", settings.fontFamily);
  root.setAttribute("data-fontsize", settings.fontSize);
}

function readStoredSettings(): AccessibilitySettings {
  try {
    const raw = localStorage.getItem(ACCESSIBILITY_STORAGE_KEY);
    if (!raw) return DEFAULT_ACCESSIBILITY_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_ACCESSIBILITY_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_ACCESSIBILITY_SETTINGS;
  }
}

interface AccessibilityContextValue {
  settings: AccessibilitySettings;
  setColorMode: (mode: ColorMode) => void;
  setFontFamily: (font: FontChoice) => void;
  setFontSize: (size: FontSize) => void;
}

const AccessibilityContext = createContext<AccessibilityContextValue | null>(null);

/**
 * These are visitor-level display preferences (readable on the unauthenticated landing/auth/legal
 * pages same as inside the app), not account data — stored client-side only, per Phase 4.3.
 */
export function AccessibilityProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AccessibilitySettings>(readStoredSettings);

  useEffect(() => {
    applyAccessibilitySettings(settings);
    try {
      localStorage.setItem(ACCESSIBILITY_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Private browsing / storage disabled: setting still applies for this page view.
    }
  }, [settings]);

  const setColorMode = useCallback((colorMode: ColorMode) => {
    setSettings(prev => ({ ...prev, colorMode }));
  }, []);
  const setFontFamily = useCallback((fontFamily: FontChoice) => {
    setSettings(prev => ({ ...prev, fontFamily }));
  }, []);
  const setFontSize = useCallback((fontSize: FontSize) => {
    setSettings(prev => ({ ...prev, fontSize }));
  }, []);

  return (
    <AccessibilityContext.Provider value={{ settings, setColorMode, setFontFamily, setFontSize }}>
      {children}
    </AccessibilityContext.Provider>
  );
}

export function useAccessibility() {
  const ctx = useContext(AccessibilityContext);
  if (!ctx) throw new Error("useAccessibility must be used within AccessibilityProvider");
  return ctx;
}
