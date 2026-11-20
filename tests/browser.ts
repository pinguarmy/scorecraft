import type { LaunchOptions } from '@playwright/test';

/**
 * Browser used by the renderer regressions and the end-to-end suite.
 * Defaults to the installed Google Chrome channel. Set SCORECRAFT_BROWSER_PATH to a
 * Chromium/Chrome executable to use that binary instead, e.g. on CI or in a container.
 */
export function browserLaunchOptions(): LaunchOptions {
  const executablePath = process.env.SCORECRAFT_BROWSER_PATH?.trim();
  return executablePath ? { executablePath, headless: true } : { channel: 'chrome', headless: true };
}
