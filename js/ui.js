'use strict';

// ---- helpers ----
// Small shared helpers (DOM, text, formatting), the global `app` state and the api() client.

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]
  );
const isUploadedIcon = value =>
  /^(?:data:image\/png;base64,[a-z0-9+/]+=*|data:image\/svg\+xml,%3C.*)$/i.test(value || '');
const icon = name =>
  isUploadedIcon(name)
    ? `<img class="custom-icon" src="${esc(name)}" alt="" aria-hidden="true">`
    : `<svg aria-hidden="true"><use href="#i-${esc(name)}"/></svg>`;
const pretty = value => JSON.stringify(value, null, 2);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const when = seconds => {
  if (!seconds) return '';
  const date = new Date(seconds * 1000),
    today = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(
    undefined,
    today
      ? {hour: '2-digit', minute: '2-digit', second: '2-digit'}
      : {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}
  );
};
/**
 * Interface state belongs to the client: panel sizes, tabs, camera and the clipboard are kept in this browser,
 * never on the server.
 */
const store = (() => {
  const KEY = 'agentsys.client.v1.ui-store';
  let values = {};
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) values = saved;
  } catch {}
  let timer = null;
  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(values));
    } catch (error) {
      console.error('Could not save UI state:', error);
    }
  };
  const ready = Promise.resolve();
  return {
    ready,
    get: (key, fallback = null) => clone(Object.hasOwn(values, key) ? values[key] : fallback),
    set(key, value) {
      if (JSON.stringify(values[key]) !== JSON.stringify(value)) {
        values[key] = clone(value);
        if (!timer) timer = setTimeout(() => {
          timer = null;
          persist();
        }, 0);
      }
      return ready;
    },
    /** The preference storage backend. */
    kind: 'localStorage',
  };
})();
const uuid = () => crypto.randomUUID?.() ?? uid();
const app = {
  preferences: {},
  shortcutDefaults: {},
  projects: [],
  resources: [],
  route: null,
};

// ----- API -----
/**
 * Every request goes through the active environment's transport. There is no local backend in the client:
 * closing this page cannot stop a workflow, and switching servers cannot mix their data.
 */
async function api(path, {method = 'GET', body, query, edit, signal} = {}) {
  const [bare, search = ''] = path.split('?');
  const params = {
    ...Object.fromEntries(new URLSearchParams(search)),
    ...Object.fromEntries(Object.entries(query ?? {}).filter(([, value]) => value !== undefined && value !== null)),
  };
  return Environment.request(method, bare, {
    body,
    query: params,
    edit,
    signal,
  });
}

/** Icons a Custom Node or a group of Custom Nodes can wear. */
const NODE_ICONS =
  'complex package code spark branch split loop refresh skip exit merge toggle list hash text note eye file folder library server plug terminal user star heart bolt database globe mail cpu filter key lock bell chart cloud flag tag wrench shuffle timer'.split(
    ' '
  );
/** The upload button is not an icon: a wide dashed button with its own caption, so it is never mistaken for one of the icons around it. */
const uploadLabel = uploaded =>
  `${icon(uploaded || 'upload')}<span>${uploaded ? 'Replace your image' : 'Upload your own'}</span>`;
const iconGrid = (current, fallback, preview = '') =>
  `<div class="icon-grid" data-icon-grid ${preview ? `data-preview="${esc(preview)}"` : ''}><input type="hidden" name="icon" value="${esc(current || '')}">${NODE_ICONS.map(i => `<button type="button" class="icon ${i === (current || fallback) ? 'active' : ''}" data-icon-choice="${i}" title="${i}" aria-label="${i}">${icon(i)}</button>`).join('')}<button type="button" class="dashed-action ${isUploadedIcon(current) ? 'active' : ''}" data-upload-icon aria-label="Upload your own icon" title="Upload your own image as the icon">${uploadLabel(isUploadedIcon(current) ? current : '')}</button><input type="file" data-icon-file accept="image/*" hidden aria-label="Icon image"></div>`;

function chooseIcon(grid, value, selected) {
  const input = $('input[name=icon]', grid);
  input.value = value;
  for (const button of $$('[data-icon-choice], [data-upload-icon]', grid))
    button.classList.toggle('active', button === selected);
  if (grid.dataset.preview) $(grid.dataset.preview).innerHTML = icon(value);
  input.dispatchEvent(new Event('input', {bubbles: true}));
}

document.addEventListener('click', event => {
  const upload = event.target.closest('[data-upload-icon]');
  if (upload) {
    event.preventDefault();
    $('[data-icon-file]', upload.closest('[data-icon-grid]')).click();
    return;
  }
  const choice = event.target.closest('[data-icon-choice]');
  if (!choice) return;
  event.preventDefault(); // Prevent the surrounding label from activating its first button too.
  chooseIcon(choice.closest('[data-icon-grid]'), choice.dataset.iconChoice, choice);
});

document.addEventListener('change', async event => {
  const input = event.target.closest('[data-icon-file]');
  if (!input?.files[0]) return;
  const url = URL.createObjectURL(input.files[0]);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const size = Math.min(1, 128 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * size));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * size));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const value = canvas.toDataURL('image/png');
    const grid = input.closest('[data-icon-grid]'),
      button = $('[data-upload-icon]', grid);
    button.innerHTML = uploadLabel(value);
    chooseIcon(grid, value, button);
  } catch {
    fail(new Error('Could not load this icon image.'));
  } finally {
    URL.revokeObjectURL(url);
    input.value = '';
  }
});

/** One pointer drag: `move` on every move, `end` once on release or cancel (e.type tells which). Shared by the canvas and the panel resizers. */
function drag(event, move, end) {
  event.preventDefault();
  const target = event.target;
  target.setPointerCapture?.(event.pointerId);
  const onMove = e => {
      if (e.pointerId === event.pointerId) move(e);
    },
    onUp = e => {
      if (e.pointerId !== event.pointerId) return;
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onUp);
      if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
      Promise.resolve(end?.(e)).catch(fail);
    };
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('pointercancel', onUp);
}

/** Reusable JSON file exchange for Library, projects, workflows. */
function pickFiles({multiple = true, accept = '.json,application/json'} = {}) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.hidden = true;
    const finish = files => {
      input.remove();
      resolve(files);
    };
    input.onchange = () => finish([...input.files]);
    input.oncancel = () => finish([]);
    document.body.append(input);
    input.click();
  });
}
function downloadJSON(value, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}));
  link.download = `${
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '')
      .trim() || 'agentsys'
  }.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---- dialogs ----
// Toasts, the shared dialog, form helpers and autosaving forms.

// ----- toasts and dialogs -----
/** Fills `parent` with text in which `[label](target)` is a link: a page path (`/p/x/w/y`) or `node:ID` (selects that node on the canvas). Everything else is plain text. */
function linkedText(parent, message) {
  const parts = String(message).split(/(\[[^\]]+\]\([^)\s]+\))/);
  for (const part of parts) {
    const match = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (!match) {
      parent.append(part);
      continue;
    }
    const [, label, target] = match;
    if (target.startsWith('node:')) {
      const button = Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'link',
        textContent: label,
      });
      button.onclick = () => reveal(target.slice(5));
      parent.append(button);
    } else {
      const link = Object.assign(document.createElement('a'), {textContent: label, href: '#' + target});
      link.setAttribute('data-link', '');
      parent.append(link);
    }
  }
}

/** A notification. Its text may hold links (see `linkedText`); following one dismisses it. */
function toast(message, error = false) {
  const item = document.createElement('div');
  item.className = 'toast' + (error ? ' error' : '');
  item.setAttribute('role', error ? 'alert' : 'status');
  const text = document.createElement('span');
  linkedText(text, message);
  text.addEventListener('click', event => event.target.closest('a, button') && item.remove());
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.innerHTML = icon('x');
  close.onclick = () => item.remove();
  item.append(text, close);
  $('#toasts').append(item);
  setTimeout(() => item.remove(), error ? 8000 : 3500);
}
const fail = error => toast(error.message || String(error), true);

/** Opens the shared dialog. `submit` receives the form; returning false keeps the dialog open. */
function dialog(title, body, submit, label = 'Save', danger = false) {
  const modal = $('#modal');
  $('#modal-form').onchange = $('#modal-form').oninput = $('#modal-form').onclick = null;
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-error').hidden = true;
  $('#modal-actions').innerHTML = submit
    ? `<button type="button" value="cancel" class="ghost">Cancel</button><button type="submit" value="ok" class="${danger ? 'danger' : 'primary'}">${esc(label)}</button>`
    : '';
  modal.onsubmit = async event => {
    if (event.submitter?.value === 'cancel' || !submit) return;
    event.preventDefault();
    const button = event.submitter || $('#modal-actions button[value=ok]');
    button.disabled = true;
    try {
      if ((await submit($('#modal-form'))) !== false) modal.close();
    } catch (error) {
      $('#modal-error').textContent = error.message;
      $('#modal-error').hidden = false;
    } finally {
      button.disabled = false;
    }
  };
  modal.showModal();
  let backdropDown = false;
  const outside = event => {
    // A drop-down list opened inside the dialog may reach past its edge; clicking it is not clicking outside.
    if (event.target.closest?.('.popup')) return false;
    const r = modal.getBoundingClientRect();
    return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
  };
  modal.onpointerdown = event => {
    backdropDown = outside(event);
  };
  modal.onclick = event => {
    if (event.target.closest('button[value=cancel]')) return modal.close('cancel');
    if (backdropDown && outside(event)) modal.close();
    backdropDown = false;
  };
  $('[autofocus]', modal)?.focus();
}
const confirmDialog = (title, text, action, label) =>
  dialog(title, `<p class="muted">${esc(text)}</p>`, action, label, true);
const field = (label, control, help = '') => {
  const tag = control.includes('data-icon-grid') ? 'div' : 'label';
  return `<${tag} class="field"${help ? ` title="${esc(help)}"` : ''}><span>${esc(label)}</span>${control}</${tag}>`;
};
const options = (items, selected) =>
  items
    .map(
      ([value, label]) =>
        `<option value="${esc(value)}" ${String(value) === String(selected ?? '') ? 'selected' : ''}>${esc(label)}</option>`
    )
    .join('');

// Serialize autosaves and capture each edit before a later render can replace its form.
function autoForm(form, read, write) {
  let timer,
    chain = Promise.resolve(),
    inflight = 0,
    saved;
  try {
    saved = JSON.stringify(read());
  } catch {
    /* incomplete new form */
  }
  const status = document.createElement('small');
  status.className = 'save-status muted';
  status.setAttribute('role', 'status');
  form.append(status);
  const flush = () => {
    clearTimeout(timer);
    let data;
    try {
      if (!form.checkValidity()) {
        if (!flush.isDirty()) return chain;
        status.textContent = 'Complete the highlighted fields';
        return Promise.resolve(false);
      }
      data = read();
    } catch (error) {
      status.textContent = error.message;
      return Promise.resolve(false);
    }
    const key = JSON.stringify(data);
    if (key === saved) return chain;
    saved = key;
    status.classList.remove('bad');
    status.textContent = 'Saving…';
    inflight++;
    chain = chain
      .then(() => write(data))
      .then(
        () => {
          inflight--;
          status.textContent = 'Saved';
          return true;
        },
        error => {
          inflight--;
          saved = undefined;
          status.textContent = error.message;
          status.classList.add('bad');
          fail(error);
          return false;
        }
      );
    return chain;
  };
  const changed = event => {
    if (event?.target.closest('#node-connections, .conn-host, .port-conn')) return;
    clearTimeout(timer);
    status.textContent = 'Unsaved changes';
    timer = setTimeout(flush, event?.type === 'change' ? 60 : 400);
  };
  form.addEventListener('input', changed);
  form.addEventListener('change', changed);
  form.onsubmit = event => {
    event.preventDefault();
    flush();
  };
  return Object.assign(flush, {
    changed,
    element: form,
    // Dirty while a save is still on its way too: a render from the data before it would drop the edit.
    isDirty: () => {
      if (inflight) return true;
      try {
        return JSON.stringify(read()) !== saved;
      } catch {
        return true;
      }
    },
  });
}
/** An invalid field or failed save offers a visible choice instead of silently losing edits or trapping navigation. */
async function leaveAutosave(save) {
  if ((await save()) !== false) return true;
  return new Promise(resolve => {
    dialog(
      'Unsaved changes',
      '<p>Some changes could not be saved. Stay here to correct them, or discard them and leave.</p>',
      () => resolve(true),
      'Discard changes',
      true
    );
    $('#modal').addEventListener('close', () => resolve(false), {once: true});
  });
}

// ---- code-editor ----
// Syntax-highlighted code editor used for the code of Custom nodes.

function highlightJS(code) {
  const keywords = new Set(
    'async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined'.split(
      ' '
    )
  );
  const builtins = new Set(
    'Array Boolean Date Error JSON Map Math Number Object Promise RegExp Set String console Infinity NaN'.split(' ')
  );
  const tokens =
    /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\b(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|\b[A-Za-z_$][\w$]*\b/gim;
  let html = '',
    offset = 0;
  for (const match of code.matchAll(tokens)) {
    html += esc(code.slice(offset, match.index));
    const token = match[0],
      kind =
        token.startsWith('//') || token.startsWith('/*')
          ? 'comment'
          : /^['"`]/.test(token)
            ? 'string'
            : /^\d/.test(token)
              ? 'number'
              : keywords.has(token)
                ? 'keyword'
                : builtins.has(token)
                  ? 'builtin'
                  : '';
    html += kind ? `<span class="syntax-${kind}">${esc(token)}</span>` : esc(token);
    offset = match.index + token.length;
  }
  return html + esc(code.slice(offset)) + '\n';
}
function codeEditorHTML(code, attrs = '') {
  return `<div class="code-editor"><pre aria-hidden="true">${highlightJS(code || '')}</pre><textarea spellcheck="false" autocapitalize="off" autocomplete="off" ${attrs}>${esc(code)}</textarea></div>`;
}
function wireCodeEditors(root) {
  for (const area of $$('.code-editor textarea', root)) {
    if (area.dataset.enhanced) continue;
    area.dataset.enhanced = 'true';
    const pre = area.previousElementSibling;
    area.addEventListener('input', () => {
      pre.innerHTML = highlightJS(area.value);
    });
    area.addEventListener('scroll', () => {
      pre.scrollTop = area.scrollTop;
      pre.scrollLeft = area.scrollLeft;
    });
    tabIndent(area);
  }
}

// ---- popup ----
// Popup and context menus (nested submenus, search, keyboard).

/** Small popup menu anchored at a point. `items` are [label, action, {danger, disabled}] or null separators. */
// `searchItems` can supply a wider catalog than the entries shown with an empty query, also on searchable submenus.
function popup(x, y, items, {search = false, searchItems = items} = {}) {
  closePopup(true);
  const menu = document.createElement('div');
  menu.className = 'popup';
  menu.innerHTML = `${search ? `<label class="menu-search">${icon('search')}<input type="search" placeholder="Search nodes…" aria-label="Search nodes" autocomplete="off"></label>` : ''}<div class="menu-items" role="menu"></div>`;
  document.body.append(menu);
  const rootItems = $('.menu-items', menu);
  const closeSiblings = row => {
    for (const sibling of row.parentElement.children) {
      if (sibling === row) continue;
      sibling.querySelector('.submenu')?.remove();
      sibling.querySelector('button')?.setAttribute('aria-expanded', 'false');
    }
  };
  const renderItems = (root, list) => {
    root.replaceChildren();
    for (const item of list) {
      if (!item) {
        root.append(document.createElement('hr'));
        continue;
      }
      const [label, action, meta = {}] = item,
        children = meta.children;
      if (meta.header) {
        // A heading over a group of entries (the label of an <optgroup>); it cannot be chosen.
        const heading = document.createElement('div');
        heading.className = 'menu-heading';
        heading.textContent = label;
        root.append(heading);
        continue;
      }
      const row = document.createElement('div'),
        button = document.createElement('button');
      row.className = 'menu-row';
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.className = meta.danger ? 'danger' : '';
      button.disabled = !!meta.disabled;
      if ('checked' in meta) {
        button.setAttribute('role', 'menuitemradio');
        button.setAttribute('aria-checked', String(!!meta.checked));
      }
      const glyph = meta.icon || ('checked' in meta ? null : children ? 'folder' : 'play');
      button.innerHTML = `<span class="menu-label">${glyph ? icon(glyph) : ''}<span>${esc(label)}</span></span>${children ? icon('chevron') : ''}`;
      if (meta.hint) button.title = meta.hint;
      row.append(button);
      root.append(row);
      if (children) {
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        const open = () => {
          if (button.disabled) return;
          closeSiblings(row);
          if ($('.submenu', row)) return;
          const sub = document.createElement('div');
          sub.className = 'submenu';
          sub.setAttribute('role', 'menu');
          row.append(sub);
          let list = sub;
          if (meta.search) {
            // A submenu with its own search field filters all of its (nested) entries.
            sub.removeAttribute('role');
            sub.innerHTML = `<label class="menu-search">${icon('search')}<input type="search" placeholder="Search nodes…" aria-label="Search nodes" autocomplete="off"></label><div class="menu-items" role="menu"></div>`;
            list = $('.menu-items', sub);
          }
          renderItems(list, children);
          if (meta.search) {
            const field = $('input', sub);
            field.oninput = () => {
              const q = field.value.trim().toLocaleLowerCase();
              renderItems(
                list,
                q
                  ? flatten(meta.searchItems || children).filter(item => item[0].toLocaleLowerCase().includes(q))
                  : children
              );
            };
            if (!phoneLayout.matches)
              Promise.resolve().then(() => {
                if (sub.isConnected && !sub.contains(document.activeElement)) field.focus();
              });
          }
          button.setAttribute('aria-expanded', 'true');
          const r = button.getBoundingClientRect(),
            sr = sub.getBoundingClientRect();
          if (phoneLayout.matches) {
            const back = document.createElement('button');
            back.type = 'button';
            back.className = 'submenu-back';
            back.innerHTML = `${icon('chevron')}<span>Back</span>`;
            back.onclick = event => {
              event.stopPropagation();
              sub.remove();
              button.setAttribute('aria-expanded', 'false');
              button.focus();
            };
            sub.prepend(back);
          }
          sub.style.left =
            (phoneLayout.matches
              ? Math.max(8, (innerWidth - sr.width) / 2)
              : r.right + sr.width + 8 > innerWidth
                ? Math.max(8, r.left - sr.width)
                : r.right - 2) + 'px';
          sub.style.top = Math.max(8, Math.min(r.top, innerHeight - sr.height - 8)) + 'px';
        };
        row.onpointerenter = open;
        button.onclick = open;
        button.onkeydown = event => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            open();
            $('.submenu button', row)?.focus();
          }
        };
      } else {
        row.onpointerenter = () => closeSiblings(row);
        button.onclick = () => {
          closePopup();
          Promise.resolve()
            .then(() => action())
            .catch(fail);
        };
      }
    }
    if (!list.length) root.innerHTML = '<p class="muted small menu-empty">No matching nodes</p>';
  };
  renderItems(rootItems, items);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, innerWidth - rect.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - rect.height - 8)) + 'px';
  const flatten = (list, prefix = '') =>
    list
      .filter(Boolean)
      .flatMap(([label, action, meta = {}]) =>
        meta.children ? flatten(meta.children, prefix + label + ' / ') : [[prefix + label, action, meta]]
      );
  const input = $('input', menu);
  if (input)
    input.oninput = () => {
      const q = input.value.trim().toLocaleLowerCase();
      renderItems(rootItems, q ? flatten(searchItems).filter(item => item[0].toLocaleLowerCase().includes(q)) : items);
      const r = menu.getBoundingClientRect();
      menu.style.top = Math.max(8, Math.min(parseFloat(menu.style.top), innerHeight - r.height - 8)) + 'px';
    };
  menu.addEventListener('keydown', event => {
    if (event.target.matches('input:not([type=search]),textarea,select') && event.key !== 'Escape') return;
    const submenu = event.target.closest('.submenu');
    const scope = submenu ? $('.menu-items', submenu) || submenu : rootItems;
    const buttons = [...scope.children].map(row => $('button', row)).filter(b => b && !b.disabled);
    const i = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next =
        i < 0
          ? event.key === 'ArrowDown'
            ? 0
            : buttons.length - 1
          : (i + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
    if (event.key === 'ArrowLeft' && submenu) {
      event.preventDefault();
      const parent = submenu.parentElement;
      submenu.remove();
      $('button', parent).setAttribute('aria-expanded', 'false');
      $('button', parent).focus();
    }
    if (event.key === 'Escape') W.canvas?.focus();
  });
  ((!phoneLayout.matches && input) || menu.querySelector('button:not(:disabled)'))?.focus();
  return menu;
}
/** Closes the menus: they fade out first (CSS `.closing`), or at once with `immediate` or when animations are off. */
function closePopup(immediate = false) {
  for (const menu of $$('.popup')) {
    if (immediate) menu.remove();
    else if (!menu.classList.contains('closing')) {
      menu.classList.add('closing');
      const done = () => menu.remove();
      Promise.allSettled(menu.getAnimations({subtree: true}).map(a => a.finished)).then(done);
      setTimeout(done, 400);
    }
  }
}
// Must run before the listener that closes menus: a click on the field of an open list closes it.
document.addEventListener(
  'pointerdown',
  event => {
    const select = event.target.closest?.('select');
    toggledOff = !!select && select === selectMenuOf && !!$('.popup.select-menu:not(.closing)');
  },
  true
);
document.addEventListener(
  'pointerdown',
  event => {
    if (!event.target.closest('.popup')) closePopup();
  },
  true
);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closePopup();
});
// Scrolling or zooming anywhere outside a menu closes it, like a click does.
document.addEventListener(
  'wheel',
  event => {
    if (!event.target.closest('.popup')) closePopup();
  },
  {capture: true, passive: true}
);

// ----- Drop-down lists: a <select> opens one of these menus instead of the browser's own list -----
// The <select> stays the source of truth (its value, its change event, options that code rewrites), so nothing that uses it changes.
const selectable = element =>
  element instanceof HTMLSelectElement && !element.disabled && !element.multiple && !(element.size > 1);
let selectMenuOf = null; // the <select> whose menu is open
let toggledOff = false; // the pointer went down on a <select> whose menu was open: that click closes it
/** The entries of a <select>: its options, with the label of each <optgroup> as a heading over its options. */
function selectItems(select) {
  const entry = option => [
    option.textContent,
    () => {
      if (select.value === option.value) return;
      select.value = option.value;
      select.dispatchEvent(new Event('input', {bubbles: true}));
      select.dispatchEvent(new Event('change', {bubbles: true}));
    },
    {disabled: option.disabled, checked: option.selected},
  ];
  const items = [];
  for (const child of select.children) {
    if (child.tagName === 'OPTGROUP') {
      if (items.length) items.push(null);
      if (child.label) items.push([child.label, null, {header: true}]);
      items.push(...[...child.children].filter(o => o.tagName === 'OPTION').map(entry));
    } else if (child.tagName === 'OPTION') items.push(entry(child));
  }
  return items;
}
function openSelectMenu(select) {
  const r = select.getBoundingClientRect(),
    menu = popup(r.left, r.bottom + 4, selectItems(select));
  menu.classList.add('select-menu');
  menu.style.minWidth = Math.max(r.width, 120) + 'px';
  // Inside a modal dialog everything else is inert, so the menu goes into the dialog.
  const dialog = select.closest('dialog');
  if (dialog) {
    dialog.append(menu);
    menu.classList.add('in-dialog');
  }
  const below = innerHeight - r.bottom - 12,
    height = menu.getBoundingClientRect().height;
  // Not enough room below: open upwards from the top of the field.
  if (height > below && r.top > below) menu.style.top = Math.max(8, r.top - height - 4) + 'px';
  selectMenuOf = select;
  const checked = $('[aria-checked=true]', menu);
  (checked || $('button:not(:disabled)', menu))?.focus({preventScroll: true});
  checked?.scrollIntoView({block: 'nearest'});
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closePopup();
      select.focus();
    }
  });
  return menu;
}
document.addEventListener(
  'mousedown',
  event => {
    const select = event.target.closest?.('select');
    if (!select || !selectable(select) || event.button !== 0) return;
    event.preventDefault(); // no list of the browser's own
    select.focus();
    if (toggledOff) toggledOff = false;
    else openSelectMenu(select);
  },
  true
);
document.addEventListener(
  'keydown',
  event => {
    const select = event.target;
    if (!selectable(select) || select.matches('[data-no-menu]')) return;
    if (
      event.key === ' ' ||
      event.key === 'Enter' ||
      (event.altKey && event.key === 'ArrowDown') ||
      event.key === 'F4'
    ) {
      // Space and Alt+Down open the list natively; Enter only does inside a form. All open ours.
      if (event.key === 'Enter' && !event.target.closest('.port-row, .widget, .slot-field')) return;
      event.preventDefault();
      openSelectMenu(select);
    }
  },
  true
);

// ---- color-picker ----
// The colour picker: saturation/brightness, hue, opacity and RGB(A) hex. It replaces the browser's own colour dialog everywhere.

const hexOf = (h, s, v) => {
  const f = n => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return '#' + f(5) + f(3) + f(1);
};
const hsvOf = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255),
    max = Math.max(r, g, b),
    d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max === 0 ? 0 : d / max, max];
};
/**
 * The colour picker, the one every colour in the app uses. `anchor` is a rectangle to open under. `color` is #RRGGBB or #RRGGBBAA.
 * `alpha: false` leaves out opacity; `none` adds a "Default" swatch that picks null. `onPick(color)` is told at the end of each change.
 */
function colorPicker(anchor, {color: current, alpha: withOpacity = true, none = false, onPick, dialog = null} = {}) {
  let [h, s, v] = hsvOf(current);
  let alpha = withOpacity && current.length === 9 ? parseInt(current.slice(7), 16) / 255 : 1;
  const withAlpha = rgb =>
    rgb +
    (alpha < 1
      ? Math.round(alpha * 255)
          .toString(16)
          .padStart(2, '0')
      : '');
  const menu = popup(anchor.left, anchor.bottom + 5, []);
  // Inside a modal dialog everything else is inert, so the picker goes into the dialog.
  if (dialog) {
    dialog.append(menu);
    menu.classList.add('in-dialog');
  }
  menu.classList.toggle('no-alpha', !withOpacity);
  menu.innerHTML = `<div class="color-picker"><div class="color-options">${SWATCHES.filter(color => color || none)
    .map(
      color =>
        `<button type="button" class="swatch" data-node-color="${color || ''}" style="${color ? `background:${color}` : ''}" title="${color || 'Default'}" aria-label="${color || 'Default color'}"></button>`
    )
    .join('')}</div>
    <div class="sv" tabindex="0" aria-label="Saturation and brightness"><i class="sv-dot"></i></div>
    <input type="range" class="hue" min="0" max="360" step="1" aria-label="Hue">
    <label class="opacity-value"><span>Opacity</span><span class="opacity-percent"><input class="alpha-number" type="number" min="0" max="100" step="1" aria-label="Opacity percentage"><span>%</span></span></label>
    <input type="range" class="alpha" min="0" max="100" step="1" aria-label="Opacity">
    <div class="color-value"><span class="color-preview" aria-hidden="true"></span><input class="hex" maxlength="9" spellcheck="false" aria-label="Hex colour" placeholder="#RRGGBBAA"></div></div>`;
  const sv = $('.sv', menu),
    dot = $('.sv-dot', menu),
    hue = $('.hue', menu),
    opacity = $('.alpha', menu),
    percentage = $('.alpha-number', menu),
    hex = $('.hex', menu);
  const paint = () => {
    const rgb = hexOf(h, s, v);
    sv.style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,${hexOf(h, 1, 1)})`;
    dot.style.left = s * 100 + '%';
    dot.style.top = (1 - v) * 100 + '%';
    hue.value = Math.round(h);
    hex.value = withAlpha(rgb);
    opacity.value = percentage.value = Math.round(alpha * 100);
    menu.style.setProperty('--alpha-color', rgb);
    menu.style.setProperty('--picked-color', hex.value);
    dot.style.background = rgb;
  };
  const commit = () => onPick(withAlpha(hexOf(h, s, v)));
  paint();
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(anchor.left, innerWidth - rect.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(anchor.bottom + 5, innerHeight - rect.height - 8)) + 'px';
  menu.addEventListener('click', e => {
    const swatch = e.target.closest('[data-node-color]');
    if (!swatch) return;
    onPick(swatch.dataset.nodeColor ? withAlpha(swatch.dataset.nodeColor) : null);
    closePopup();
  });
  sv.addEventListener('pointerdown', e => {
    sv.setPointerCapture(e.pointerId);
    const move = ev => {
      const r = sv.getBoundingClientRect();
      s = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      v = 1 - Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      paint();
    };
    const up = () => {
      sv.removeEventListener('pointermove', move);
      sv.removeEventListener('pointerup', up);
      commit();
    };
    sv.addEventListener('pointermove', move);
    sv.addEventListener('pointerup', up);
    move(e);
  });
  hue.addEventListener('input', () => {
    h = Number(hue.value);
    paint();
  });
  hue.addEventListener('change', commit);
  opacity.addEventListener('input', () => {
    alpha = Number(opacity.value) / 100;
    paint();
  });
  opacity.addEventListener('change', commit);
  percentage.addEventListener('change', () => {
    if (percentage.value.trim() === '' || !percentage.validity.valid) return paint();
    alpha = Number(percentage.value) / 100;
    paint();
    commit();
  });
  hex.addEventListener('change', () => {
    const value = hex.value.trim().startsWith('#') ? hex.value.trim() : '#' + hex.value.trim();
    if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
      [h, s, v] = hsvOf(value);
      alpha = withOpacity && value.length === 9 ? parseInt(value.slice(7), 16) / 255 : 1;
      paint();
      commit();
    } else paint();
  });
}

/** Every <input type=color> opens this picker instead of the browser's dialog; the input keeps its value and its events. */
document.addEventListener('click', event => {
  const input = event.target.closest?.('input[type=color]');
  if (!input) return;
  event.preventDefault();
  if (input.disabled) return;
  const rect = input.getBoundingClientRect();
  colorPicker(rect, {
    color: input.value || '#000000',
    alpha: false,
    dialog: input.closest('dialog'),
    onPick: color => {
      if (!color || color === input.value) return;
      input.value = color;
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.dispatchEvent(new Event('change', {bubbles: true}));
    },
  });
});

// ---- type-ui ----
// Types in the interface: colours, the type selector of a slot, the type editor. The Library's types are every workflow's: any selector offers them next to the workflow's own.
// The only built-in type is “any”; what else is offered is what the workflow defines.
// The types themselves live in the document (js/model.js); the canvas keeps the resolved table in W.types.

/** The hue a type gets when nobody picked a colour: spread by its ID. */
const autoTypeColor = id => `hsl(${parseInt(id.slice(0, 6), 16) % 360} 58% 62%)`;
const TYPE_COLORS = new Map(); // type ID -> colour, for the canvas and the minimap

/** A class naming the colour of a type. None for any; a signal has its own look (see css/editor.css). */
function typeClass(type) {
  if (isSignal(type)) return 'signal';
  const id = typeRefs(type)[0];
  if (!id) return '';
  return 't-r' + id;
}

/** Gives each type of the document its colour as a rule for its class (and remembers it for the minimap). */
function paintTypes(types) {
  TYPE_COLORS.clear();
  for (const t of types) TYPE_COLORS.set(t.id, t.color || autoTypeColor(t.id));
  let sheet = $('#type-colors');
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.id = 'type-colors';
    document.head.append(sheet);
  }
  const rules = [...TYPE_COLORS].map(([id, color]) => `.t-r${id}{--tc:${color}}`).join('');
  // Identical type rules must not invalidate layout across the whole canvas.
  if (sheet.textContent !== rules) sheet.textContent = rules;
}

const typeLabel = (type, table = W.types ?? NO_TYPES) => table.label(type);

/** The options of a type selector: any, the Library's types and the workflow's own, and a way to make a new one. */
function typeOptionsHTML(selected, types, {create = true, skip = null, signal = false} = {}) {
  const mine = types.filter(t => t.id !== skip),
    group = (label, items) =>
      items.length ? `<optgroup label="${esc(label)}">${options(items, selected)}</optgroup>` : '';
  return (
    `<option value="any"${isAny(selected) ? ' selected' : ''}>any</option>` +
    (signal ? `<option value="signal"${isSignal(selected) ? ' selected' : ''}>signal</option>` : '') +
    group(
      'Library',
      mine.filter(t => t.library).map(t => ['t:' + t.id, t.name])
    ) +
    group(
      'This workflow',
      mine.filter(t => !t.library).map(t => ['t:' + t.id, t.name])
    ) +
    (create ? '<option value="__new">New type…</option>' : '')
  );
}

/** The type of the port an endpoint ({id, port, dir}) names on the canvas (none: no type). */
const endpointType = e =>
  (W.nodes.get(e.id)?.[e.dir === 'out' ? 'outputs' : 'inputs'] || []).find(p => p.id === e.port)?.type || 'any';
/** Whether two endpoints (an output and an input, in either order) may be wired; a group's internal face is checked by the server. */
function endpointsFit(a, b) {
  const [out, input] = a.dir === 'out' ? [a, b] : [b, a];
  if (out.face === 'internal' || input.face === 'internal') return true;
  return compatible(endpointType(out), endpointType(input), W.types ?? NO_TYPES);
}

const putTypes = async list => {
  const result = await api(`projects/${W.project}/types`, {method: 'PUT', body: wf({types: list}), edit: editToken()});
  W.snapshot.types = result.types;
  W.types = new TypeTable(result.types);
  paintTypes(result.types);
  return result.types;
};

const CONTROL_LABELS = {
  text: 'Text',
  textarea: 'Long text',
  code: 'Code',
  number: 'Number',
  checkbox: 'Checkbox',
  select: 'Choice (enum)',
};
/** What a type's control is, for its row in a list: `typed in as text`, or the options of an enum. */
const controlNote = (t, table = W.types ?? NO_TYPES) =>
  [
    t.alias ? `alias of ${table.label(t.alias)}` : '',
    !t.control
      ? ''
      : t.control === 'select'
        ? `enum: ${t.options.join(' | ')}`
        : `typed in as ${CONTROL_LABELS[t.control].toLowerCase()}`,
  ]
    .filter(Boolean)
    .join(', ');

/**
 * The type editor: a name, a colour and fields (each a name and a type). `done(typeDefinition)` runs after it was saved;
 * `current` is the type being edited (none for a new one). It is saved to the workflow; a Library type is saved to the Custom Node being
 * edited, which makes it the Library's for everybody.
 */
function typeDialog(current, done) {
  const types = W.snapshot.types,
    id = current?.id ?? uuid().replaceAll('-', ''),
    fieldRow = f =>
      `<div class="type-field" data-type-field><input data-name placeholder="field name" value="${esc(f.name)}" aria-label="Field name"><select data-type aria-label="Field type">${typeOptionsHTML(f.type, types, {create: false, skip: id})}</select><button type="button" class="icon" data-remove-field title="Remove field" aria-label="Remove field">${icon('x')}</button></div>`;
  const fields = current?.fields ?? [];
  dialog(
    current ? 'Edit type' : 'New type',
    `${field('Name', `<input name="name" maxlength="60" required autofocus value="${esc(current?.name ?? '')}">`)}
     ${field('Color', `<input type="color" name="color" value="${esc(toHex(current?.color || autoTypeColor(id)))}">`)}
     <div class="field" id="type-alias-part"><span title="(it means the same as that type, so the two fit each other; it keeps its own name, color and control)">Alias of</span>
       <select name="alias" aria-label="Alias of"><option value="">None</option>${types
         .filter(t => t.id !== id)
         .map(
           t => `<option value="t:${t.id}" ${current?.alias === 't:' + t.id ? 'selected' : ''}>${esc(t.name)}</option>`
         )
         .join('')}</select></div>
     <div class="field" id="type-fields-part"><span title="(none: a named kind, such as Text or Signal)">Fields</span><div class="type-fields" id="type-fields">${fields.map(fieldRow).join('')}</div>
     <button type="button" class="dashed-action" id="add-type-field">${icon('plus')} Add field</button></div>
     <div class="field" id="type-control-part"><span title="(how a free slot of this type is typed in on the node; the value is the default of the slot)">Control</span>
       <select name="control" aria-label="Control"><option value="">None</option>${Object.entries(CONTROL_LABELS)
         .map(([k, v]) => `<option value="${k}" ${current?.control === k ? 'selected' : ''}>${v}</option>`)
         .join('')}</select>
       <textarea name="options" rows="4" id="type-options" title="One option per line" aria-label="Options">${esc((current?.options ?? []).join('\n'))}</textarea></div>`,
    async form => {
      const next = {
        id,
        ...(current?.library ? {library: true} : {}),
        name: form.elements.name.value.trim(),
        color: form.elements.color.value,
        fields: form.elements.alias.value
          ? []
          : $$('[data-type-field]', form).map(row => ({
              name: $('[data-name]', row).value.trim(),
              type: $('[data-type]', row).value,
            })),
        ...(form.elements.alias.value ? {alias: form.elements.alias.value} : {}),
        ...(form.elements.control.value && (form.elements.alias.value || !$$('[data-type-field]', form).length)
          ? {
              control: form.elements.control.value,
              ...(form.elements.control.value === 'select'
                ? {
                    options: [
                      ...new Set(
                        form.elements.options.value
                          .split('\n')
                          .map(o => o.trim())
                          .filter(Boolean)
                      ),
                    ],
                  }
                : {}),
            }
          : {}),
      };
      const list = current ? types.map(t => (t.id === id ? next : t)) : [...types, next];
      await putTypes(list);
      await done?.(next);
      reload().catch(() => {});
    }
  );
  const form = $('#modal-form'),
    // A type with fields is a record: only a type without fields has a control or is an alias; an alias has no fields.
    sync = () => {
      const records = !!$$('[data-type-field]', form).length;
      $('#type-alias-part').hidden = records;
      $('#type-fields-part').hidden = !!form.elements.alias.value;
      $('#type-control-part').hidden = records;
      $('#type-options').hidden = form.elements.control.value !== 'select';
    };
  form.onclick = event => {
    if (event.target.closest('#add-type-field'))
      $('#type-fields').insertAdjacentHTML('beforeend', fieldRow({name: '', type: 'any'}));
    else event.target.closest('[data-remove-field]')?.closest('[data-type-field]').remove();
    sync();
  };
  form.onchange = sync;
  sync();
}

/** A colour as the #rrggbb an <input type=color> wants (types may carry any CSS colour). */
function toHex(color) {
  const probe = document.createElement('canvas').getContext('2d');
  probe.fillStyle = color;
  return probe.fillStyle.startsWith('#') ? probe.fillStyle : '#7aa2f7';
}

// ---- preferences ----
// Keyboard shortcuts and the appearance settings (palette, fonts, graph look).

// ----- preferences: shortcuts and appearance -----
const SHORTCUT_LABELS = {
  copy: 'Copy',
  cut: 'Cut',
  paste: 'Paste',
  delete: 'Delete',
  dissolve: 'Dissolve',
  group: 'Group',
  ungroup: 'Ungroup',
  renameGroup: 'Rename',
  selectAll: 'Select all',
  marquee: 'Rectangle select',
  invertSelection: 'Invert selection',
  fit: 'Fit to view',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  run: 'Run',
  pan: 'Pan (hold)',
  multiSelect: 'Add to selection (hold)',
  cancel: 'Cancel',
  left: 'Pan left',
  right: 'Pan right',
  up: 'Pan up',
  down: 'Pan down',
  undo: 'Undo',
  redo: 'Redo',
  togglePanel: 'Toggle side panel',
  disable: 'Disable or enable nodes and groups',
  fold: 'Collapse or expand nodes and groups',
  snap: 'Toggle snapping to the grid',
  hints: 'Toggle key hints',
  toolSelect: 'Select tool',
  toolMove: 'Move tool',
  toolPan: 'Pan tool',
  toolDelete: 'Delete tool',
  toolAdd: 'Add node menu',
};
/** Developer mode (Settings): Custom nodes can be made and edited by hand, and the Custom node is offered. */
const developerMode = () => !!app.preferences?.developer_mode;
const binding = action => {
  const shortcuts = app.preferences.shortcuts || {}, fallback = app.shortcutDefaults[action] ?? '';
  if (Object.hasOwn(shortcuts, action)) return shortcuts[action];
  if (action.startsWith('tool') && Object.entries(shortcuts).some(([key, value]) => key !== action && value === fallback)) return '';
  return fallback;
};
// Shortcuts follow the physical key, so they work on any layout. When the system gives no key code
// (remote desktops, some virtual machines), a Cyrillic letter is mapped to the Latin key at the same place.
const CYRILLIC_KEYS = Object.fromEntries(
  [...'йцукенгшщзфывапролдячсмить'].map((ch, i) => [ch, [...'qwertyuiopasdfghjklzxcvbnm'][i]])
);
Object.assign(CYRILLIC_KEYS, {і: 's', ї: ']', є: "'", ґ: '\\', ё: '`', х: '[', ъ: ']', ж: ';', э: "'", б: ',', ю: '.'});
const SYMBOL_CODES = {
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '`': 'Backquote',
};
function keyCode(event) {
  let code = event.code;
  if (!code || code === 'Unidentified') {
    const k = String(event.key || '').toLowerCase(),
      latin = CYRILLIC_KEYS[k] || k;
    code = /^[a-z]$/.test(latin)
      ? 'Key' + latin.toUpperCase()
      : /^[0-9]$/.test(latin)
        ? 'Digit' + latin
        : SYMBOL_CODES[latin] || (event.key === ' ' ? 'Space' : '');
  }
  return code.replace(/^(Shift|Control|Alt|Meta)(Left|Right)$/, '$1');
}
const shortcutText = action =>
  binding(action)
    .replace(/Key|Digit/g, '')
    .replace('Equal', '=')
    .replace('Minus', '-') || '—';
function matches(action, event) {
  const parts = binding(action).split('+'),
    code = parts.pop();
  if (!code || keyCode(event) !== code) return false;
  return (
    (event.ctrlKey || event.metaKey) === parts.includes('Ctrl') &&
    event.altKey === parts.includes('Alt') &&
    event.shiftKey === parts.includes('Shift')
  );
}
function recordShortcut(event) {
  const code = keyCode(event),
    parts = [];
  if ((event.ctrlKey || event.metaKey) && !['Control', 'Meta'].includes(code)) parts.push('Ctrl');
  if (event.altKey && code !== 'Alt') parts.push('Alt');
  if (event.shiftKey && code !== 'Shift') parts.push('Shift');
  return [...parts, code].join('+');
}
const THEMES = {
  Dark: {background: '#080808', surface: '#101010', text: '#ededed', accent: '#d9d9d9'},
  Graphite: {background: '#06080b', surface: '#14181f', text: '#e9ebf1', accent: '#ff7a45'},
  Light: {background: '#eef0f3', surface: '#ffffff', text: '#1d232c', accent: '#b5670f'},
  Midnight: {background: '#0b1020', surface: '#141b2e', text: '#e2e8f6', accent: '#8fb0ff'},
  Moss: {background: '#0f1612', surface: '#18221c', text: '#e1ece4', accent: '#9bd08a'},
};
/** Graph Editor look: corner radii (px), wire shape and thickness. Wire shapes are drawn by `wirePath` in canvas/geometry.js. */
const GRAPH_DEFAULTS = {node_radius: 16, group_radius: 33, wire_style: 'bezier', wire_width: 2, wire_curve: 50};
const WIRE_STYLES = [
  ['bezier', 'Bezier curve'],
  ['linear', 'Straight line'],
  ['step', 'Right angles'],
  ['rounded', 'Rounded right angles'],
];
const STYLE_DEFAULTS = {
  font_size: 14,
  font_family: 'system',
  ...THEMES.Graphite,
  effects: true,
  animations: true,
  ...GRAPH_DEFAULTS,
};
let graphStyle = GRAPH_DEFAULTS;
/** What is on the root element now. Removing a variable and setting it again to the same value would restyle the whole page for nothing,
 *  so a value is written only when it differs from the one in place (a colour drag applies on every frame). */
const rootVars = new Map();
function setRootVar(name, value) {
  const root = document.documentElement;
  if (value === null || value === undefined || value === '') {
    if (rootVars.delete(name)) root.style.removeProperty(name);
  } else if (rootVars.get(name) !== String(value)) {
    rootVars.set(name, String(value));
    root.style.setProperty(name, String(value));
  }
}
function setRootData(name, value) {
  const root = document.documentElement;
  if (root.dataset[name] !== value) root.dataset[name] = value;
}
function applyStyle(style = {}) {
  const value = {...STYLE_DEFAULTS, ...style};
  for (const key of ['background', 'surface', 'text', 'accent']) setRootVar('--' + key, value[key]);
  setRootVar('--font-size', value.font_size + 'px');
  setRootVar('--font', value.font_family !== 'system' ? `"${value.font_family}", system-ui, sans-serif` : null);
  const luminance = hex =>
    [1, 3, 5]
      .map(i => parseInt(hex.slice(i, i + 2), 16))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  setRootData('theme', luminance(value.background) > 140 ? 'light' : 'dark');
  setRootVar('--on-accent', luminance(value.accent) > 140 ? '#14171c' : '#ffffff');
  graphStyle = value;
  setRootVar('--node-radius', value.node_radius + 'px');
  setRootVar('--frame-radius', value.group_radius + 'px');
  setRootVar('--wire-width', value.wire_width);
  setRootData('motion', String(value.animations));
  setRootData('effects', String(value.effects));
  // Colours never move a row; only what changes sizes (the font) makes the highlights find their rows again.
  applyNavJoined(value.effects, value.font_size + '|' + value.font_family);
}
