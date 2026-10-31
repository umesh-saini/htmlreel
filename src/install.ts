import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BROWSER_CACHE_DIR } from './browser.js';

const PLAYWRIGHT = 'playwright@1.64.1';

function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} exited with code ${r.status}`);
}

/**
 * Installs chrome-headless-shell (the fast, deterministic BeginFrame engine) into the htmlreel cache.
 * Chrome for Testing has no Linux ARM builds, so ARM Linux uses Playwright's headless shell.
 */
export function installBrowser(dir = BROWSER_CACHE_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'linux' && process.arch !== 'x64') {
    run('npx', ['-y', PLAYWRIGHT, 'install', '--only-shell', 'chromium'], { PLAYWRIGHT_BROWSERS_PATH: path.join(dir, 'playwright') });
    console.log(`\nIf renders fail with missing shared libraries, install them once with:\n  sudo npx -y ${PLAYWRIGHT} install-deps chromium`);
  } else {
    run('npx', ['-y', '@puppeteer/browsers@2', 'install', 'chrome-headless-shell@stable', '--path', dir]);
  }
  console.log(`\nInstalled into ${dir}`);

  // Ubuntu 23.10+ blocks unprivileged user namespaces through AppArmor, so Chrome's sandbox
  // cannot start ("No usable sandbox!"). An unconfined profile with `userns` for this binary
  // fixes it without turning the sandbox off (Ubuntu ships the same kind of profile for Chrome).
  let restricted = false;
  try {
    restricted = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1';
  } catch {
    // not Linux / no AppArmor
  }
  if (restricted) {
    const profile = path.join(dir, 'htmlreel-chrome.apparmor');
    fs.writeFileSync(
      profile,
      `# AppArmor: allow the htmlreel render browser to create user namespaces (its sandbox).
abi <abi/4.0>,
include <tunables/global>

profile htmlreel-chrome ${dir}/**/chrome-headless-shell flags=(unconfined) {
  userns,

  include if exists <local/htmlreel-chrome>
}
`
    );
    console.log(`
This system restricts user namespaces (Ubuntu 23.10+), which Chrome's sandbox needs.
Allow it for the render browser only (keeps the sandbox on):
  sudo cp ${profile} /etc/apparmor.d/htmlreel-chrome && sudo apparmor_parser -r /etc/apparmor.d/htmlreel-chrome
Or turn the sandbox off instead: HTMLREEL_NO_SANDBOX=1`);
  }
}
