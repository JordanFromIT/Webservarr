/**
 * WebServarr — News editor (window.NewsEditor)
 *
 * The rich-text editor admins use on /news, moved off the Settings page. It
 * posts the editor's HTML to /api/news/, which sanitises it (bleach) before it
 * is stored or shown. Links and images are asked for in the shared dialog
 * (WSUI), never in a native browser dialog.
 */
var NewsEditor = (function () {
  'use strict';

  var UI = window.WSUI, el = UI.el, icon = UI.icon, cls = UI.cls;
  // editor, toolbar and previewing belong to the panel on screen (the toolbar
  // drives them). Which post a save writes, and whom it tells, belongs to the
  // session its panel was opened with (see open), never to module state: a
  // save can answer after another post has been opened.
  var host = null, editor = null, toolbar = null, previewing = false, current = null;
  // Counts every open and every dismissal. /news reads it when Edit is clicked
  // and opens the fetched post only if it has not moved, so a Cancel (or any
  // other open) meanwhile beats a fetch still in flight.
  var generation = 0;
  var TOOLS = [
    ['bold', 'format_bold', 'Bold (Ctrl+B)'], ['italic', 'format_italic', 'Italic (Ctrl+I)'],
    ['underline', 'format_underlined', 'Underline (Ctrl+U)'], ['strikeThrough', 'strikethrough_s', 'Strikethrough'],
    null,
    ['insertUnorderedList', 'format_list_bulleted', 'Bulleted list'], ['insertOrderedList', 'format_list_numbered', 'Numbered list'],
    ['quote', 'format_quote', 'Quote'],
    null,
    ['link', 'link', 'Insert a link'], ['image', 'image', 'Insert an image'], ['codeblock', 'code_blocks', 'Code block'],
    ['code', 'code', 'Inline code'], ['hr', 'horizontal_rule', 'Divider']
  ];

  // Load saved HTML without letting active markup run (belt and braces behind
  // the server's sanitiser): parse in an inert document, drop executable and
  // loading elements and inline handlers, then move the nodes in.
  function setEditorHtml(target, html) {
    target.innerHTML = '';
    var doc = new DOMParser().parseFromString(String(html == null ? '' : html), 'text/html');
    doc.querySelectorAll('script, style, iframe, object, embed, link, meta, base').forEach(function (n) { n.remove(); });
    doc.querySelectorAll('*').forEach(function (n) {
      Array.prototype.slice.call(n.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        if (name.indexOf('on') === 0) n.removeAttribute(attr.name);
        else if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*javascript:/i.test(attr.value || '')) {
          n.removeAttribute(attr.name);
        }
      });
    });
    while (doc.body.firstChild) target.appendChild(doc.body.firstChild);
  }

  function saveRange() {
    var s = window.getSelection();
    if (!s.rangeCount) return null;
    var r = s.getRangeAt(0);
    return editor.contains(r.commonAncestorContainer) ? r.cloneRange() : null;
  }

  function place(node, range) {
    if (range) {
      range.deleteContents();
      range.insertNode(node);
      var after = document.createRange();
      after.setStartAfter(node);
      after.collapse(true);
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(after);
    } else {
      editor.appendChild(node);
    }
  }

  function ask(title, fields) {
    var form = el('div', 'space-y-4 mt-2');
    var inputs = {};
    fields.forEach(function (f) {
      var box = el('div');
      var i = el('input', cls.input);
      i.id = 'newsAsk-' + f[0];
      i.placeholder = f[2] || '';
      var l = el('label', cls.label, f[1]);
      l.htmlFor = i.id;
      box.appendChild(l);
      box.appendChild(i);
      form.appendChild(box);
      inputs[f[0]] = i;
    });
    setTimeout(function () { inputs[fields[0][0]].focus(); }, 30);
    return UI.confirm({ title: title, body: form, confirmLabel: 'Insert', cancelLabel: 'Cancel' }).then(function (ok) {
      if (!ok) return null;
      var out = {};
      Object.keys(inputs).forEach(function (k) { out[k] = inputs[k].value.trim(); });
      return out;
    });
  }

  // An address the editor may insert: http(s) anywhere, a path on this site,
  // or mailto:. It is parsed the way the browser will resolve it, so an
  // address that only looks local ("/\evil.com": a backslash counts as "/",
  // or "//evil.com") is refused. The server's sanitiser strips both as well.
  function safeUrl(raw) {
    var v = String(raw == null ? '' : raw).trim();
    if (!v || v.indexOf('\\') !== -1 || /[\t\n\r]/.test(v) || v.indexOf('//') === 0) return null;
    var u;
    try { u = new URL(v, location.origin); } catch (e) { return null; }
    if (u.protocol === 'mailto:') return v;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (/^https?:\/\//i.test(v)) return v;
    return v.charAt(0) === '/' && u.origin === location.origin ? v : null;
  }

  function run(cmd) {
    if (previewing) return;
    var range = saveRange();
    editor.focus();
    if (cmd === 'quote') { document.execCommand('formatBlock', false, '<blockquote>'); return; }
    if (cmd === 'hr') { document.execCommand('insertHorizontalRule', false, null); return; }
    if (cmd === 'code') {
      var code = el('code', null, window.getSelection().toString() || 'code');
      place(code, range);
      return;
    }
    if (cmd === 'codeblock') {
      var pre = el('pre');
      pre.appendChild(el('code', null, window.getSelection().toString() || 'code here'));
      place(pre, range);
      var p = el('p');
      p.appendChild(document.createElement('br'));
      pre.parentNode.insertBefore(p, pre.nextSibling);
      return;
    }
    if (cmd === 'link') {
      var text = range ? range.toString() : '';
      ask('Insert a link', [['url', 'Web address', 'https://']]).then(function (v) {
        if (!v || !v.url) return;
        var url = safeUrl(v.url);
        if (!url) { UI.toast('Use an address that starts with https://', 'err'); return; }
        editor.focus();
        var a = el('a', null, text || url);
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        place(a, range);
      });
      return;
    }
    if (cmd === 'image') {
      ask('Insert an image', [['url', 'Image address', 'https://'], ['alt', 'Describe the image (optional)', '']]).then(function (v) {
        if (!v || !v.url) return;
        var url = safeUrl(v.url);
        if (!url) { UI.toast('Use an address that starts with https://', 'err'); return; }
        editor.focus();
        var img = el('img');
        img.src = url;
        img.alt = v.alt || '';
        place(img, range);
      });
      return;
    }
    document.execCommand(cmd, false, null);
    paintTools();
  }

  function paintTools() {
    ['bold', 'italic', 'underline', 'strikeThrough'].forEach(function (c) {
      var b = toolbar.querySelector('[data-cmd="' + c + '"]');
      if (b) b.classList.toggle('active', !previewing && document.queryCommandState(c));
    });
  }

  function setPreview(on) {
    previewing = on;
    editor.setAttribute('contenteditable', on ? 'false' : 'true');
    editor.classList.toggle('preview-mode', on);
    toolbar.querySelectorAll('[data-cmd], select').forEach(function (b) { b.disabled = on; });
    var pv = toolbar.querySelector('[data-preview]');
    pv.lastChild.textContent = on ? 'Edit' : 'Preview';
    pv.firstChild.textContent = on ? 'edit' : 'visibility';
  }

  function build(post, session) {
    var wrap = el('div', 'rounded-2xl border border-frosted-blue/10 bg-frosted-blue/[0.04] p-5 space-y-5');
    wrap.appendChild(el('h2', 'text-[20px] font-bold tracking-tight text-frosted-blue', post ? 'Edit post' : 'New post'));

    var titleBox = el('div');
    var title = el('input', cls.input);
    title.id = 'newsPostTitle';
    title.maxLength = 200;
    title.value = post ? post.title : '';
    title.placeholder = 'What’s the news?';
    var tl = el('label', cls.label, 'Title');
    tl.htmlFor = title.id;
    titleBox.appendChild(tl);
    titleBox.appendChild(title);
    wrap.appendChild(titleBox);

    var body = el('div');
    body.appendChild(el('p', cls.label, 'Post'));
    toolbar = el('div', 'flex flex-wrap items-center gap-1 rounded-t-[10px] border border-b-0 border-frosted-blue/10 bg-frosted-blue/[0.06] px-2 py-1.5');
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Formatting');
    var heading = el('select', 'rounded-[10px] bg-transparent border border-frosted-blue/10 px-2 py-1 text-[13px] text-frosted-blue');
    heading.setAttribute('aria-label', 'Text style');
    [['p', 'Paragraph'], ['h2', 'Heading'], ['h3', 'Subheading']].forEach(function (o) {
      var op = el('option', null, o[1]);
      op.value = o[0];
      heading.appendChild(op);
    });
    heading.addEventListener('change', function () {
      if (previewing) return;
      editor.focus();
      document.execCommand('formatBlock', false, '<' + heading.value + '>');
    });
    toolbar.appendChild(heading);
    TOOLS.forEach(function (t) {
      if (!t) { toolbar.appendChild(el('span', 'w-px h-6 bg-frosted-blue/10 mx-1')); return; }
      var b = el('button', 'toolbar-btn p-1.5 rounded-[8px] text-frosted-blue/70 hover:text-frosted-blue hover:bg-frosted-blue/10 transition-colors');
      b.type = 'button';
      b.setAttribute('data-cmd', t[0]);
      b.setAttribute('aria-label', t[2]);
      b.title = t[2];
      b.appendChild(icon(t[1], 'text-[20px]'));
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep the selection
      b.addEventListener('click', function () { run(t[0]); });
      toolbar.appendChild(b);
    });
    var pv = el('button', 'ml-auto inline-flex items-center gap-1 p-1.5 rounded-[8px] text-frosted-blue/70 hover:text-frosted-blue hover:bg-frosted-blue/10');
    pv.type = 'button';
    pv.setAttribute('data-preview', '');
    pv.appendChild(icon('visibility', 'text-[20px]'));
    pv.appendChild(el('span', 'text-[13px] font-semibold', 'Preview'));
    pv.addEventListener('click', function () { setPreview(!previewing); });
    toolbar.appendChild(pv);
    body.appendChild(toolbar);

    editor = el('div', 'w-full rounded-b-[10px] border border-frosted-blue/10 bg-frosted-blue/[0.02] px-4 py-3 text-[15px] ' +
      'text-frosted-blue leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary overflow-y-auto custom-scrollbar');
    editor.id = 'postContent';
    editor.setAttribute('contenteditable', 'true');
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', 'true');
    editor.setAttribute('aria-label', 'Post');
    editor.style.minHeight = '300px';
    editor.style.maxHeight = '600px';
    var box = editor;   // this panel's own editor, for its save
    // content_html is the server's sanitised HTML. Seeded posts keep Markdown
    // in content, which would open as raw text, so that copy is the fallback.
    if (post) setEditorHtml(editor, post.content_html || post.content);
    editor.addEventListener('keydown', function (e) {
      if (previewing || !(e.ctrlKey || e.metaKey)) return;
      var k = e.key.toLowerCase();
      var map = { b: 'bold', i: 'italic', u: 'underline' };
      if (map[k]) { e.preventDefault(); document.execCommand(map[k], false, null); paintTools(); }
    });
    editor.addEventListener('keyup', paintTools);
    editor.addEventListener('mouseup', paintTools);
    body.appendChild(editor);
    wrap.appendChild(body);

    var pinLabel = el('label', 'inline-flex items-center gap-3 text-[15px] text-frosted-blue cursor-pointer');
    var pin = el('input', 'size-5 rounded border-frosted-blue/20 bg-transparent text-primary focus:ring-primary');
    pin.type = 'checkbox';
    pin.checked = !!(post && post.pinned);
    pinLabel.appendChild(pin);
    pinLabel.appendChild(document.createTextNode('Pin to the top'));
    wrap.appendChild(pinLabel);

    var state = el('p', 'flex items-center gap-2 text-[13px] text-frosted-blue/70');
    if (post) {
      state.appendChild(el('span', 'ws-light ' + (post.published ? 'ws-light-ok' : 'ws-light-unconfigured')));
      state.appendChild(el('span', '', post.published ? 'Published — live on the site.' : 'Draft — only admins can see it.'));
      wrap.appendChild(state);
    }

    var actions = el('div', 'flex flex-wrap gap-2');
    var publish = el('button', cls.btnPrimary);
    publish.type = 'button';
    publish.appendChild(icon('send', 'text-base'));
    publish.appendChild(document.createTextNode(post && post.published ? 'Save changes' : 'Publish'));
    var draft = el('button', cls.btnGhost);
    draft.type = 'button';
    draft.appendChild(icon('draft', 'text-base'));
    draft.appendChild(document.createTextNode(post && post.published ? 'Unpublish to draft' : 'Save draft'));
    var cancel = el('button', cls.btnQuiet, 'Cancel');
    cancel.type = 'button';
    actions.appendChild(publish);
    actions.appendChild(draft);
    actions.appendChild(cancel);
    wrap.appendChild(actions);

    function save(published) {
      var s = session;   // the post this panel edits and whom to tell; fixed for this save
      if (!title.value.trim()) { UI.toast('Give the post a title.', 'err'); title.focus(); return; }
      if (!box.textContent.trim() && !box.querySelector('img, hr')) {
        UI.toast('Write something in the post first.', 'err');
        box.focus();
        return;
      }
      // Cancel waits for the answer. Another post may be opened meanwhile, so
      // the answer closes this panel only if it is still the one on screen,
      // and always refreshes the list through this session's own callback.
      publish.disabled = draft.disabled = cancel.disabled = true;
      var payload = { title: title.value.trim(), content: box.innerHTML.trim(), published: published, pinned: pin.checked };
      fetch(s.id ? '/api/news/' + s.id : '/api/news/', {
        method: s.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      }).then(function (r) {
        if (r.status === 401) { window.location.href = '/login'; return; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        UI.toast(published ? 'Published. It’s live on the site.' : 'Draft saved. Only admins can see it.', 'ok');
        // Not close(): this is the save finishing, not a dismissal, so an Edit
        // clicked while it was in flight still opens.
        if (current === s) hide();
        if (s.onDone) s.onDone();
      }).catch(function () {
        // "Your text is still here" holds only while this panel is on screen.
        // Once another post's panel replaced it, say which post (the title this
        // save sent, shown as text) and how to get back to it.
        if (current === s) UI.toast('The post wasn’t saved. Your text is still here — try again.', 'err');
        else if (!s.id) UI.toast('Your new post “' + payload.title + '” wasn’t saved. Open New post and try again.', 'err');
        else UI.toast('“' + payload.title + '” wasn’t saved. Open it again and retry.', 'err');
      }).then(function () { publish.disabled = draft.disabled = cancel.disabled = false; });
    }
    publish.addEventListener('click', function () { save(true); });
    draft.addEventListener('click', function () { save(false); });
    cancel.addEventListener('click', function () { if (current === session) close(); });
    setTimeout(function () { title.focus(); }, 30);
    return wrap;
  }

  function open(post, onDone) {
    host = document.getElementById('newsEditor');
    if (!host) return;
    // One session per open: its post id, its callback and (through build)
    // its own panel. current marks the session on screen.
    generation += 1;
    var session = { id: post ? post.id : null, onDone: onDone || null };
    current = session;
    previewing = false;
    host.replaceChildren(build(post, session));
    host.classList.remove('hidden');
    host.scrollIntoView({ block: 'start' });
  }

  function hide() {
    if (!host) return;
    host.replaceChildren();
    host.classList.add('hidden');
    current = null;
  }

  // Cancel, or a caller dismissing the editor: also drops any Edit still
  // fetching its post (see generation).
  function close() {
    generation += 1;
    hide();
  }

  return { open: open, close: close, generation: function () { return generation; } };
})();
