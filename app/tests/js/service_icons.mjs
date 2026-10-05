// Home's Service Health icons: getServiceIconUrl (pages/home.js) picks an
// icon by a name's substring, and the most specific match wins, so "Plex
// Requests" is the request app's icon, not Plex's. Runs the function as it
// is in home.js, not a copy.
// Run: node app/tests/js/service_icons.mjs (CI job js-checks; npm run test:js).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const home = readFileSync(join(here, '../../static/js/pages/home.js'), 'utf8');

const from = home.indexOf('const HOMELAB_ICONS');
const to = home.indexOf('\n}\n', home.indexOf('function getServiceIconUrl('));
if (from < 0 || to < 0) throw new Error('HOMELAB_ICONS and getServiceIconUrl not found in home.js');
const getServiceIconUrl = new Function(home.slice(from, to) + '\n}\nreturn getServiceIconUrl;')();

const icon = (name) => {
  const url = getServiceIconUrl(name);
  return url === null ? null : url.replace(/^.*\/svg\/|\.svg$/g, '');
};

const CASES = [
  // The bug: "plex" used to match first.
  ['Plex Requests', 'seerr'],
  ['plex requests', 'seerr'],
  ['Requests', 'seerr'],
  ['Overseerr', 'seerr'],
  ['Jellyseerr', 'seerr'],
  ['Seerr', 'seerr'],
  // Unchanged.
  ['Plex', 'plex'],
  ['Plex Media Server', 'plex'],
  ['Sonarr', 'sonarr'],
  ['Radarr 4K', 'radarr'],
  ['Uptime Kuma', 'uptime-kuma'],
  ['Home Assistant', 'home-assistant'],
  ['AdGuard', 'adguard-home'],
  ['Audiobooks', null],
  ['', null],
];

let failed = 0;
for (const [name, want] of CASES) {
  const got = icon(name);
  if (got !== want) {
    failed += 1;
    console.error(`FAIL ${JSON.stringify(name)}: want ${want}, got ${got}`);
  }
}
if (failed) {
  console.error(`service_icons: ${failed} of ${CASES.length} failed`);
  process.exit(1);
}
console.log(`service_icons: ${CASES.length}/${CASES.length} ok`);
