// Headless Brave (or any Chromium) over the DevTools protocol, for live checks
// on a dev instance. No dependencies: Node 22+ (global fetch and WebSocket).
//
//   import { launch } from './browser.mjs';
//   const b = await launch({ baseUrl: process.env.DEVKIT_BASE_URL });
//   try {
//     await b.setSession(cookieValue);
//     await b.goto('/books', { width: 320 });
//     await b.screenshot('/tmp/books-320.png');
//     console.log(await b.measure());     // { cls, overflow, consoleErrors }
//   } finally { await b.close(); }
//
// The dev address comes from the caller (an option or DEVKIT_BASE_URL); there
// is no default. The profile is a fresh temp directory, deleted on close.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Layout shift and largest paint, recorded from the first script of every page.
const OBSERVERS = `(() => {
  window.__devkit = { cls: 0, shifts: [] };
  const name = (n) => !n ? '?' : (n.id ? '#' + n.id : (n.nodeName || '?').toLowerCase());
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        window.__devkit.cls += e.value;
        window.__devkit.shifts.push({ value: +e.value.toFixed(4), at: Math.round(e.startTime), nodes: (e.sources || []).map((s) => name(s.node)) });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}
})();`;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// CDP URL patterns: * matches anything, ? one character, the rest is literal.
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$');
}

/**
 * Start a headless browser with a temp profile and attach to its first page.
 * @param {object} options
 * @param {string} [options.baseUrl]    the dev site, e.g. https://dev.example.org (or DEVKIT_BASE_URL)
 * @param {string} [options.executable] browser binary (or DEVKIT_BROWSER, default "brave")
 * @param {string} [options.cookieName] session cookie name (or DEVKIT_COOKIE_NAME, default "webservarr_session")
 */
export async function launch(options = {}) {
  const baseUrl = (options.baseUrl || process.env.DEVKIT_BASE_URL || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(baseUrl)) {
    throw new Error('browser.mjs needs the dev address: pass baseUrl or set DEVKIT_BASE_URL (e.g. https://dev.example.org)');
  }
  const cookieName = options.cookieName || process.env.DEVKIT_COOKIE_NAME || 'webservarr_session';
  const executable = options.executable || process.env.DEVKIT_BROWSER || 'brave';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-profile-'));
  const port = await freePort();
  const child = spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: 'ignore', detached: true }); // own process group: Chromium's helpers die with it

  const removeProfile = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  const killTree = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
  const killNow = () => { killTree(); removeProfile(); };
  process.on('exit', killNow); // a crashed script still leaves nothing behind
  let closed = false;

  try {
    let page = null;
    for (let i = 0; i < 100 && !page; i++) {
      await sleep(200);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        page = targets.find((t) => t.type === 'page') || null;
      } catch { /* not listening yet */ }
    }
    if (!page) throw new Error(`${executable} did not open a DevTools page`);

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('DevTools connection failed')), { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    const listeners = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method) {
        listeners.forEach((fn) => fn(msg));
      }
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 20000 });
      if (r.exceptionDetails) throw new Error('page script failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result.value;
    };

    let consoleErrors = [];
    let onLoad = null;
    const rules = [];
    listeners.push((msg) => {
      const p = msg.params;
      if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
        consoleErrors.push('console.error: ' + p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push('exception: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text).slice(0, 300));
      } else if (msg.method === 'Log.entryAdded' && p.entry.level === 'error') {
        consoleErrors.push(`log: ${p.entry.text.slice(0, 200)} ${p.entry.url || ''}`.trim());
      } else if (msg.method === 'Page.loadEventFired') {
        if (onLoad) onLoad();
      } else if (msg.method === 'Fetch.requestPaused') {
        const url = p.request.url;
        const rule = rules.find((r) => r.regexp.test(url));
        if (!rule) {
          call('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
          return;
        }
        const body = rule.body ?? (rule.status >= 400 ? JSON.stringify({ detail: 'devkit: simulated failure' }) : '');
        call('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: rule.status,
          responseHeaders: [{ name: 'Content-Type', value: rule.contentType }, { name: 'Cache-Control', value: 'no-store' }],
          body: Buffer.from(body).toString('base64'),
        }).catch(() => {});
      }
    });

    await call('Page.enable');
    await call('Network.enable');
    await call('Runtime.enable');
    await call('Log.enable');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVERS });

    const syncInterception = () => call(rules.length
      ? 'Fetch.enable' : 'Fetch.disable', rules.length ? { patterns: rules.map((r) => ({ urlPattern: r.pattern })) } : {});

    return {
      /** Raw access: call(method, params) and evaluate(expression). */
      call, evaluate,

      /** Sign in: the session cookie for the dev site, as `devkit.py session` prints it. */
      async setSession(value) {
        await call('Network.setCookie', {
          name: cookieName, value, url: baseUrl + '/', path: '/', secure: new URL(baseUrl).protocol === 'https:', httpOnly: true,
        });
      },

      /**
       * Open a path (or full URL) at a viewport width and wait for it to settle.
       * Narrow widths (under 600) emulate a phone. Resets the console errors.
       */
      async goto(target, { width = 1440, height = 900, settleMs = 2500 } = {}) {
        await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
        consoleErrors = [];
        const loaded = new Promise((resolve) => { onLoad = resolve; });
        const url = /^https?:/.test(target) ? target : baseUrl + (target.startsWith('/') ? target : '/' + target);
        await call('Page.navigate', { url });
        await Promise.race([loaded, sleep(30000)]);
        await sleep(settleMs);
      },

      /** Save a PNG of the viewport (or the whole page with fullPage). */
      async screenshot(file, { fullPage = false } = {}) {
        const params = { format: 'png' };
        if (fullPage) {
          const m = await call('Page.getLayoutMetrics');
          const size = m.cssContentSize || m.contentSize;
          params.captureBeyondViewport = true;
          params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(Math.ceil(size.height), 8000), scale: 1 };
        }
        const { data } = await call('Page.captureScreenshot', params);
        fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        return file;
      },

      /**
       * Layout shift since the page started, horizontal overflow, console errors.
       * overflow.overflows is true when the page scrolls sideways at this viewport.
       */
      async measure() {
        const page = await evaluate(`(() => {
          const d = document.documentElement;
          return { cls: +(window.__devkit ? window.__devkit.cls : -1).toFixed(4),
                   shifts: window.__devkit ? window.__devkit.shifts : [],
                   scrollWidth: d.scrollWidth, clientWidth: d.clientWidth, viewport: window.innerWidth };
        })()`);
        return {
          cls: page.cls,
          shifts: page.shifts,
          overflow: { scrollWidth: page.scrollWidth, clientWidth: page.clientWidth, viewport: page.viewport,
                      overflows: page.scrollWidth > page.clientWidth },
          consoleErrors: [...consoleErrors],
        };
      },

      /**
       * Answer every request whose URL matches `pattern` (CDP wildcards: a star
       * matches anything, so a pattern is usually a star, the API path, a star)
       * with `status`, never reaching the server: how to simulate a source
       * being down. Returns a function that removes the rule.
       */
      async intercept(pattern, status, { body, contentType = 'application/json' } = {}) {
        const rule = { pattern, regexp: globToRegExp(pattern), status, body, contentType };
        rules.push(rule);
        await syncInterception();
        return async () => {
          rules.splice(rules.indexOf(rule), 1);
          await syncInterception();
        };
      },

      async clearIntercepts() {
        rules.length = 0;
        await syncInterception();
      },

      /** Close the browser and delete the temp profile. Safe to call twice. */
      async close() {
        if (closed) return;
        closed = true;
        try { ws.close(); } catch { /* already gone */ }
        const exited = new Promise((resolve) => child.once('exit', resolve));
        killTree();
        await Promise.race([exited, sleep(3000)]);
        await sleep(200); // let the helpers release the profile
        removeProfile();
        process.removeListener('exit', killNow);
      },
    };
  } catch (error) {
    if (!closed) { closed = true; killNow(); process.removeListener('exit', killNow); }
    throw error;
  }
}

// --- command line: one page, one report --------------------------------------
//   DEVKIT_BASE_URL=... DEVKIT_COOKIE=<session> node browser.mjs /books --width 320 --shot out.png \
//       [--intercept '*/api/books/continue*=503' ...]
// The cookie travels in the environment, not argv, so it never shows in `ps`.
async function main(argv) {
  const args = argv.slice(2);
  const target = args[0];
  const option = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
  const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
  if (!target || target.startsWith('--')) {
    console.error('usage: browser.mjs <path> [--width N] [--shot file.png] [--full] [--intercept PATTERN=STATUS]...');
    return 2;
  }
  const b = await launch();
  try {
    if (process.env.DEVKIT_COOKIE) await b.setSession(process.env.DEVKIT_COOKIE);
    for (const spec of all('--intercept')) {
      const cut = spec.lastIndexOf('=');
      await b.intercept(spec.slice(0, cut), Number(spec.slice(cut + 1)));
    }
    await b.goto(target, { width: Number(option('--width') || 1440) });
    const shot = option('--shot');
    if (shot) await b.screenshot(shot, { fullPage: args.includes('--full') });
    console.log(JSON.stringify(await b.measure(), null, 2));
    return 0;
  } finally {
    await b.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv).then((code) => process.exit(code), (error) => { console.error(error.message); process.exit(1); });
}
