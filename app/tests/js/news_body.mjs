// A news post's body as people read it, in happy-dom with the site's real
// stylesheets (app.css, then theme.css), on both places that show it: Home's
// News & Updates card (renderNewsCard in pages/home.js; the server's copy is
// held to it by news_cards.mjs) and the News page's card (renderCard in
// pages/news.js), open as after Read more.
//  * Tailwind's reset takes list markers and block margins off everything,
//    so the body carries .news-body (theme.css), whose rules are the editor's
//    own (news.html #postContent): bullets and numbers with their indent, the
//    editor's paragraph and list spacing, its blank-line paragraphs kept.
//  * The old stand-ins for those rules are gone, so nothing else changes the
//    spacing the editor shows.
// The post is a real post's shape (prod, October 2026) with its words replaced.
// Run: node app/tests/js/news_body.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const read = (rel) => readFileSync(join(STATIC, rel), 'utf8');
const APP_CSS = read('css/app.css');
const THEME = read('css/theme.css');
const EDITOR_CSS = read('news.html').match(/<style>([\s\S]*?)<\/style>/)[1];
const home = read('js/pages/home.js');
const news = read('js/pages/news.js');
const auth = read('js/auth.js');

let failed = 0;
let total = 0;
function check(what, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${what}` + (info === undefined ? '' : ` (${JSON.stringify(info)})`));
  }
}

function slice(src, from, to, what) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(what + ' not found');
  return src.slice(a, b);
}
const escSrc = slice(auth, 'function escapeHtml(', '\n}\n', 'escapeHtml in auth.js') + '\n}\n';
const homeSrc = slice(home, 'const NEWS_FRESH_MS', '\nfunction toggleNewsCard(', 'renderNewsCard in home.js');
const newsSrc = slice(news, 'const FRESH_MS', '\nfunction emptyState(', 'renderCard in news.js');

const POST = {
  id: 6, title: 'An update', author_name: 'Admin', published: true, pinned: true,
  created_at: new Date(Date.now() - 3600000).toISOString(),
  content_html: '<p>Intro line</p><p><br></p><strong><ul><li><strong>One</strong> first point</li>' +
    '<li><strong>Two</strong> second point</li></ul><div><br></div></strong><p>After the list</p>' +
    '<p><br></p><p>Last line</p><ol><li>a</li><li>b</li></ol>'
};

function page() {
  const w = new Window();
  w.document.head.innerHTML = '<style>' + APP_CSS + '</style><style>' + THEME + '</style>';
  return w;
}

function homeCard(w) {
  const fns = new Function('document', escSrc + homeSrc + '\nreturn { renderNewsCard: renderNewsCard };')(w.document);
  w.document.body.innerHTML = fns.renderNewsCard(POST, true);
  return w.document.body.querySelector('.news-body');
}

function newsCard(w) {
  const fns = new Function('document', 'getTimeAgo', escSrc + newsSrc + '\nreturn { renderCard: renderCard };')(
    w.document, () => '1h ago');
  w.document.body.innerHTML = fns.renderCard(POST, false);
  const body = w.document.body.querySelector('[data-news-body]');
  if (body) body.classList.remove('hidden');   // what Read more does
  return body && body.classList.contains('news-body') ? body : null;
}

const px = (v) => parseFloat(v) || 0;

for (const [where, render] of [['Home card', homeCard], ['News page card', newsCard]]) {
  const w = page();
  const body = render(w);
  check(where + ': the body carries .news-body', !!body);
  if (!body) { await w.happyDOM.close(); continue; }
  const cs = (sel) => w.getComputedStyle(body.querySelector(sel));
  check(where + ': no old stand-ins for the editor rules',
        !/\[&_br\]:block|\[&>p\]:mb-2|\[&>div\]:mb-2/.test(body.className), body.className);
  check(where + ': bulleted list shows bullets', cs('ul').listStyleType === 'disc', cs('ul').listStyleType);
  check(where + ': and is indented', px(cs('ul').paddingLeft) === 24, cs('ul').paddingLeft);
  check(where + ': with the editor margin around it', px(cs('ul').marginTop) === 8 && px(cs('ul').marginBottom) === 8,
        [cs('ul').marginTop, cs('ul').marginBottom]);
  check(where + ': numbered list shows numbers', cs('ol').listStyleType === 'decimal', cs('ol').listStyleType);
  check(where + ': and is indented too', px(cs('ol').paddingLeft) === 24, cs('ol').paddingLeft);
  check(where + ': list items are spaced as in the editor', px(cs('li').marginTop) === 4 && px(cs('li').marginBottom) === 4,
        [cs('li').marginTop, cs('li').marginBottom]);
  check(where + ': paragraphs are spaced as in the editor', px(cs('p').marginTop) === 8 && px(cs('p').marginBottom) === 8,
        [cs('p').marginTop, cs('p').marginBottom]);
  check(where + ': a blank-line paragraph keeps its line break', body.querySelectorAll('p > br').length === 2);
  check(where + ': line breaks are left as the browser draws them', cs('br').display !== 'block', cs('br').display);
  await w.happyDOM.close();
}

// The editor and the read view share their rules: the same values for the
// same elements, so a change to one shows up here until both are changed.
function rules(css, scope) {
  const out = {};
  const re = new RegExp(scope.replace(/[.#]/g, '\\$&') + '\\s+([a-z0-9]+)\\s*\\{([^}]*)\\}', 'g');
  let m;
  while ((m = re.exec(css))) {
    out[m[1]] = m[2].split(';').map((d) => d.trim().replace(/\s+/g, ' ')).filter(Boolean).sort().join('; ');
  }
  return out;
}
const editor = rules(EDITOR_CSS, '#postContent');
const reader = rules(THEME, '.news-body');
for (const tag of ['p', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'blockquote', 'pre', 'code', 'img', 'hr']) {
  check('.news-body ' + tag + ' is the editor rule', !!editor[tag] && editor[tag] === reader[tag], [editor[tag], reader[tag]]);
}

console.log(`news_body: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
