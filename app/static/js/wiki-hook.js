/**
 * WebServarr — Contextual wiki links
 *
 * Renders the "read this first" card on the pages where someone is about to
 * report something. Shared by /tickets and /issues rather than duplicated.
 *
 * The slugs come already resolved to {slug, title} in the branding payload, so
 * there is no extra fetch here. An unset hook, a deleted page, an unpublished
 * page, or a logged-out caller all arrive as null and render nothing — a
 * pointer that cannot be followed is worse than no pointer.
 */

function renderWikiHook(containerId, hookName, lead) {
  var el = document.getElementById(containerId);
  if (!el) return;

  var theme = window.WEBSERVARR_THEME || {};
  var hook = (theme.wiki_hooks || {})[hookName];
  if (!hook || !hook.slug || !hook.title) {
    el.classList.add('hidden');
    return;
  }

  while (el.firstChild) el.removeChild(el.firstChild);

  var a = document.createElement('a');
  a.href = '/wiki/' + encodeURIComponent(hook.slug);
  a.className = 'flex items-center gap-3 px-4 py-3 rounded-lg bg-frosted-blue/5 ' +
                'border border-steel-blue/30 hover:bg-frosted-blue/10 hover:border-primary/40 transition-colors';

  var icon = document.createElement('span');
  icon.className = 'material-symbols-outlined text-steel-blue shrink-0';
  icon.textContent = 'library_books';
  a.appendChild(icon);

  var text = document.createElement('span');
  text.className = 'text-sm text-steel-blue';
  text.appendChild(document.createTextNode(lead + ' '));

  var strong = document.createElement('strong');
  strong.className = 'text-frosted-blue';
  strong.textContent = hook.title;   // textContent, never innerHTML
  text.appendChild(strong);
  a.appendChild(text);

  el.appendChild(a);
  el.classList.remove('hidden');
}

/**
 * The branding payload is stamped into the page by the server, so it is
 * available before this runs; render straight away.
 */
function initWikiHook(containerId, hookName, lead) {
  renderWikiHook(containerId, hookName, lead);
}
