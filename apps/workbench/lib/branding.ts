import type { UiConfig } from './api';

export const DEFAULT_TITLE = 'Lab Agent';

/** Readable text color (black or white) for a #rrggbb background, by WCAG relative luminance. */
function foregroundFor(hex: string): string {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.4 ? '#0b0f14' : '#ffffff';
}

/** Apply agent.config.ts `ui` to the document: accent color and browser title. */
export function applyBranding(ui: UiConfig | undefined): void {
  const root = document.documentElement;
  if (ui?.accent && /^#[0-9a-f]{6}$/i.test(ui.accent)) {
    root.style.setProperty('--brand', ui.accent);
    root.style.setProperty('--brand-foreground', foregroundFor(ui.accent));
  } else {
    root.style.removeProperty('--brand');
    root.style.removeProperty('--brand-foreground');
  }
  document.title = `${ui?.title ?? DEFAULT_TITLE} · Workbench`;
}
