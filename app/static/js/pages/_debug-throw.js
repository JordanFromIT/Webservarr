/**
 * WebServarr — debug only: a page module whose mount throws.
 *
 * With ?ws-debug=throw, router.js mounts this instead of the next soft
 * navigation's own module, once, so the error path (spec, Review Focus 4)
 * can be tried without breaking a real page: the page shows its error state,
 * and the shell, header and player keep working. Nothing else imports it.
 */
export async function mount() {
  throw new Error('ws-debug=throw: this page module failed on purpose');
}
