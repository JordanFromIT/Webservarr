/**
 * WebServarr — Contextual wiki links (window.WikiHook)
 *
 * Renders the "read this first" card on the pages where someone is about to
 * report something. Shared by /tickets and /issues rather than duplicated.
 *
 * The slugs come already resolved to {slug, title} in the branding payload, so
 * there is no extra fetch here. An unset hook, a deleted page, an unpublished
 * page, or a logged-out caller all arrive as null and render nothing — a
 * pointer that cannot be followed is worse than no pointer.
 *
 * A page helper for soft-navigated pages (spec 4.3): loading this file only
 * defines WikiHook. The page module calls WikiHook.init(ctx, options) from
 * mount on each visit. It reads the hooks from that visit's ctx.data (the
 * payload the server rendered with the page, so a pointer changed since the
 * first page load shows), writes only inside ctx.root, and keeps nothing.
 */
var WikiHook = (function () {
  'use strict';

  function hooksFor(ctx) {
    var branding = ctx && ctx.data && ctx.data.branding;
    if (branding && branding.wiki_hooks) return branding.wiki_hooks;
    return (window.WEBSERVARR_THEME || {}).wiki_hooks || {};
  }

  function render(el, hook, lead) {
    if (!hook || !hook.slug || !hook.title) {
      el.classList.add('hidden');
      return false;
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
    return true;
  }

  /**
   * Fills (or hides) one pointer box of this visit's page. options:
   * { container: element id inside ctx.root, hook: hook name, lead: the words
   * before the page title }. Safe to call again (a page that shows a pointer
   * only in some states calls it each time). Returns whether it is shown.
   */
  function init(ctx, options) {
    var el = ctx.root.querySelector('#' + options.container);
    if (!el) return false;
    return render(el, hooksFor(ctx)[options.hook], options.lead);
  }

  return { init: init };
})();

