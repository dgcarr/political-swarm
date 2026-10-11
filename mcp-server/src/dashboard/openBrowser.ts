import { spawn } from 'node:child_process';
import { logger } from '../util/logger.js';

/** Only ever used on a URL this process just bound on loopback. */
const SAFE_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/$/;

/**
 * Opens the dashboard in the user's default browser, best-effort.
 *
 * Disabled with SWARM_DASHBOARD_OPEN=0 for headless or browser-free use.
 * The URL is checked against a loopback pattern rather than trusted: this is the one
 * place the dashboard hands a string to the shell, and it must not become a way to launch
 * something else.
 */
export function openInBrowser(url: string): void {
  if (!SAFE_URL.test(url)) {
    logger.warn('Refusing to open a non-loopback URL', { url });
    return;
  }

  try {
    const child =
      process.platform === 'win32'
        ? // `start` is a cmd builtin; the empty string is the window title, which cmd otherwise
          // takes from the first quoted argument and then fails to open the URL at all.
          spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
        : process.platform === 'darwin'
          ? spawn('open', [url], { detached: true, stdio: 'ignore' })
          : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });

    // Never let a missing browser or a failed launch reach the MCP server.
    child.on('error', (err) => logger.info('Could not open a browser', { error: String(err) }));
    child.unref();
  } catch (err) {
    logger.info('Could not open a browser', { error: err instanceof Error ? err.message : String(err) });
  }
}
