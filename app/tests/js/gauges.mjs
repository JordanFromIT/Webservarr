// The headers' gauges (app/static/js/gauges.js): the real shell module run
// in happy-dom over the server's own markup (partials/shell-gauges.html, one
// copy in each header), with a scripted /api/integrations/system-stats and a
// fake WS.poll.
//
// Covers: one poll for the whole app, every reading written to both copies,
// the gauges hidden (data-pending) until the first answer and shown by any
// answer, nothing read while Netdata is not set up (html[data-netdata]) and
// reading again once it is, nothing read on a full-screen view (the reader)
// or with no gauges in the document, one reading at a time, whole numbers and the
// unit, the rings' dash offsets, and the network ring held at full.
//
// Run: node app/tests/js/gauges.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const GAUGES_HTML = readFileSync(join(STATIC, 'partials/shell-gauges.html'), 'utf8');
const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(
  readFileSync(join(STATIC, 'js/gauges.js'), 'utf8')));

let failed = 0;
let total = 0;
let current = '';
function check(what, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${current}: ${what}` + (info === undefined ? '' : ` (${JSON.stringify(info)})`));
  }
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

const READING = { configured: true, cpu_percent: 12.4, ram_percent: 57.6, net_download_mbps: 104.6, net_upload_mbps: 3.2,
                  net_unit: 'Mbps', net_max: 1000 };

function make(o = {}) {
  const win = new Window({ url: 'https://ws.test/' });
  const doc = win.document;
  if (o.netdata !== false) doc.documentElement.setAttribute('data-netdata', '');
  doc.body.innerHTML = '<header id="appHeader"><button id="systemStatus"></button>' + GAUGES_HTML + '</header>' +
    '<div id="mobileTopBar"><p id="wsBarTitle">Books</p>' + GAUGES_HTML + '</div>';
  const polls = [];
  const t = {
    win, doc, polls, reads: 0, answer: o.answer === undefined ? READING : o.answer, held: null,
    copies: () => Array.from(doc.querySelectorAll('[data-ws-gauges]')),
    texts: (sel) => Array.from(doc.querySelectorAll('[data-ws-gauges] ' + sel)).map((el) => el.textContent),
    start() {
      t.handle = mod.startGauges({
        document: doc,
        WS: { poll(fn, ms) { polls.push({ fn, ms }); return () => {}; } },
        fetch() {
          t.reads += 1;
          if (t.hold) return new Promise((r) => { t.held = r; });
          const a = t.answer;
          if (a && a.status) return Promise.resolve({ ok: false, status: a.status, json: () => Promise.resolve({}) });
          if (a instanceof Error) return Promise.reject(a);
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(a))) });
        }
      });
    },
    async tick() { polls[0].fn(); await flush(); }
  };
  return t;
}

async function run(name, fn) {
  current = name;
  try { await fn(); } catch (e) { failed += 1; total += 1; console.error(`FAIL ${name}: threw ${e && e.stack || e}`); }
}

await run('one poll for the app, every second, and both copies written', async () => {
  const t = make();
  check('two copies, both hidden until the first answer', t.copies().length === 2 && t.copies().every((c) => c.hasAttribute('data-pending')));
  t.start();
  check('one poll, once a second', t.polls.length === 1 && t.polls[0].ms === 1000);
  await flush();
  check('read at once', t.reads === 1);
  check('both shown once the answer is in', t.copies().every((c) => !c.hasAttribute('data-pending')));
  check('CPU and RAM as whole percentages, in both', JSON.stringify(t.texts('[data-gauge-text="cpu"]')) === '["12%","12%"]' && JSON.stringify(t.texts('[data-gauge-text="ram"]')) === '["58%","58%"]');
  check('the network as whole numbers', JSON.stringify(t.texts('[data-gauge-net="down"]')) === '["105","105"]' && JSON.stringify(t.texts('[data-gauge-net="up"]')) === '["3","3"]');
  check('the unit, short and in full', JSON.stringify(t.texts('[data-gauge-unit]')) === '["Mbps","Mbps"]' && t.texts('[data-gauge-unit-long]').every((x) => x === 'megabits per second'));
  const ring = t.doc.querySelectorAll('[data-gauge-ring="cpu"]');
  check('the rings drawn to the reading', Array.from(ring).every((el) => parseFloat(el.style.strokeDashoffset) === 251 - 251 * 12.4 / 100), ring[0].style.strokeDashoffset);
  t.answer = Object.assign({}, READING, { cpu_percent: 80, net_unit: 'MBps', net_download_mbps: 900, net_upload_mbps: 400 });
  await t.tick();
  check('the next reading in both', JSON.stringify(t.texts('[data-gauge-text="cpu"]')) === '["80%","80%"]' && JSON.stringify(t.texts('[data-gauge-unit]')) === '["MB/s","MB/s"]');
  check('the network ring held at full', Array.from(t.doc.querySelectorAll('[data-gauge-ring="net"]')).every((el) => parseFloat(el.style.strokeDashoffset) === 0));
});

await run('a failed read shows the gauges with their empty readings', async () => {
  for (const answer of [{ status: 503 }, new Error('offline'), { configured: false }, { configured: true, error: 'x' }]) {
    const t = make({ answer });
    t.start();
    await flush();
    check('shown', t.copies().every((c) => !c.hasAttribute('data-pending')), answer);
    check('the empty readings', JSON.stringify(t.texts('[data-gauge-text="cpu"]')) === '["--%","--%"]', t.texts('[data-gauge-text="cpu"]'));
  }
});

await run('without Netdata nothing is read; once it is set up, the poll reads', async () => {
  const t = make({ netdata: false });
  t.start();
  await flush();
  await t.tick();
  check('nothing read', t.reads === 0);
  check('still hidden', t.copies().every((c) => c.hasAttribute('data-pending')));
  // A soft navigation brings html[data-netdata] in step (router.js syncHtmlFlags).
  t.doc.documentElement.setAttribute('data-netdata', '');
  await t.tick();
  check('read and shown', t.reads === 1 && t.copies().every((c) => !c.hasAttribute('data-pending')));
});

await run('a full-screen view (the reader) reads nothing; back on a page with the shell, the poll reads', async () => {
  const t = make();
  t.doc.documentElement.setAttribute('data-shell', 'hidden');
  t.start();
  await flush();
  for (let i = 0; i < 5; i++) await t.tick();
  check('nothing read with the shell hidden', t.reads === 0, t.reads);
  // The router brings the flag in step on every swap (router.js syncHtmlFlags).
  t.doc.documentElement.removeAttribute('data-shell');
  await t.tick();
  check('read once the shell is back', t.reads === 1 && t.copies().every((c) => !c.hasAttribute('data-pending')));
  t.copies().forEach((c) => c.remove());
  await t.tick();
  check('nothing read with no gauges on the page', t.reads === 1, t.reads);
});

await run('one reading at a time', async () => {
  const t = make();
  t.hold = true;
  t.start();
  await t.tick();
  await t.tick();
  check('a slow answer is not overtaken', t.reads === 1);
  t.hold = false;
  t.held({ ok: true, status: 200, json: () => Promise.resolve(READING) });
  await flush();
  await t.tick();
  check('the next tick reads again', t.reads === 2);
});

console.log(`${total - failed}/${total} checks passed` + (failed ? `, ${failed} FAILED` : ''));
process.exit(failed ? 1 : 0);
