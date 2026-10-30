import type { Browser, BrowserType, LaunchOptions } from 'playwright';

export function envNameWarnings(env?: NodeJS.ProcessEnv): string[];
export function missingSharedLibraries(executablePath: string | null | undefined): string[];
export function launchChromium(
  chromium: BrowserType,
  launchOptions?: LaunchOptions
): Promise<{ browser: Browser; label: string }>;
export function surveyBrowsers(
  chromium: BrowserType
): Promise<Array<{ label: string; ok: boolean; detail: string; options?: LaunchOptions }>>;
export const BROWSER_CONFIG_PATH: string;
export function readSavedBrowser(): { executablePath?: string; channel?: string } | null;
export function saveBrowser(choice: { executablePath?: string; channel?: string }): void;
