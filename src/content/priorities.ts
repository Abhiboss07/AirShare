/**
 * Provider/sink priorities — resolves ambiguity when several plugins could
 * handle the same grab. Higher wins (see PluginRegistry ordering). Clipboard is
 * the most specific "grab whatever the user copied", so it ranks highest.
 */
export const CONTENT_PRIORITY = {
  clipboard: 100,
  text: 90,
  image: 80,
  file: 70,
  browser: 60,
} as const;
