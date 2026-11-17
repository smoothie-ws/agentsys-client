'use strict';

// ---- router ----
// Hash routing: parse the URL, open pages, leave guards, link handling.

// ----- routing -----
// Pages: / (the dashboard), /projects, /api, /settings, /p/{project}, /p/{project}/settings, /p/{project}/w/{workflow},
// /plugins (the plugins as cards) and /plugins/{id} (one plugin),
// /library (the Library: its sections as cards), /library/nodes[?folder=…] (the Nodes section: nodes and groups as cards)
// and /library/nodes/{id} (one node).
// Hash routes work on every static host.
const urlOf = path => '#' + path;
const routeTarget = () => location.hash.replace(/^#/, '') || '/';
const routePath = () => routeTarget().split('?')[0] || '/';
const routeQuery = () => new URLSearchParams(routeTarget().split('?')[1] || '');
const routeURL = () => urlOf(routeTarget());
function parseRoute(path = routePath(), query = routeQuery()) {
  let parts;
  try {
    parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return {page: 'not-found'};
  }
  if (!parts.length) return {page: 'home'};
  if (parts[0] === 'ext') {
    // A page a plugin registered with api.ui.addPage (see js/plugin-host.js).
    return parts.length === 3 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parts[1]) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parts[2])
      ? {page: 'ext', plugin: parts[1], id: parts[2]}
      : {page: 'not-found'};
  }
  if (parts[0] === 'p' && parts[1]) {
    if (parts.length === 4 && parts[2] === 'w') return {page: 'workflow', project: parts[1], workflow: parts[3]};
    if (parts.length === 2 || (parts.length === 3 && parts[2] === 'settings'))
      return {page: parts.length === 3 ? 'project-settings' : 'project', project: parts[1]};
    return {page: 'not-found'};
  }
  const page =
    {projects: 'projects', settings: 'settings', environments: 'environments', library: 'resources', api: 'api', plugins: 'plugins'}[
      parts[0]
    ] || 'not-found';
  if (page === 'plugins') return parts.length <= 2 ? {page, id: parts[1]} : {page: 'not-found'};
  if (page !== 'resources') return parts.length === 1 ? {page} : {page: 'not-found'};
  if (parts.length > 3 || (parts[1] && parts[1] !== 'nodes' && !/^[a-z][a-z0-9-]*$/.test(parts[1])))
    return {page: 'not-found'};
  return parts[1] ? {page, section: parts[1], id: parts[2], folder: query.get('folder') ?? undefined} : {page};
}
/** A deterministic way out of a deep link, including one opened without browser history. */
function parentPage(route) {
  if (route.workflow && route.project?.startsWith('lib-')) {
    const item = app.resources.find(r => r.id === route.project.slice(4));
    return [item?.payload.folder ? baseName(item.payload.folder) : 'Nodes', folderHref(item?.payload.folder || '')];
  }
  if (route.project)
    return route.page === 'project'
      ? ['Projects', '/projects']
      : ['Project', `/p/${encodeURIComponent(route.project)}`];
  if (route.page === 'resources' && route.section) {
    if (route.folder && !route.id)
      return [
        parentPath(route.folder) ? baseName(parentPath(route.folder)) : 'Nodes',
        folderHref(parentPath(route.folder)),
      ];
    return ['Library', '/library'];
  }
  if (route.page === 'plugins' && route.id) return ['Plugins', '/plugins'];
  if (route.page === 'ext') return ['Plugins', '/plugins'];
  if (route.page === 'environments') return ['Dashboard', '/'];
  return ['Dashboard', '/'];
}
let navigationRevision = 0,
  renderRevision = 0;
async function go(path, replace = false) {
  const revision = ++navigationRevision;
  if (!(await leaveView())) return;
  if (revision !== navigationRevision) return;
  if (document.body.classList.contains('mobile-subnav-open')) toggleMobileNavigation(false);
  if (urlOf(path) !== routeURL()) history[replace ? 'replaceState' : 'pushState']({}, '', urlOf(path));
  await render();
}
let leaveGuards = [];
let leavingView = null;
function leaveView() {
  if (leavingView) return leavingView;
  const guards = [...leaveGuards];
  leavingView = (async () => {
    for (const guard of guards) if ((await guard()) === false) return false;
    leaveGuards = leaveGuards.filter(guard => !guards.includes(guard));
    return true;
  })().finally(() => {
    leavingView = null;
  });
  return leavingView;
}
async function render() {
  const revision = ++renderRevision;
  const requested = parseRoute();
  if (
    requested.project?.startsWith('lib-') ||
    (requested.page === 'resources' && requested.section === 'nodes' && requested.id)
  ) {
    await loadLibrary();
    if (revision !== renderRevision) return;
    if (!developerMode()) {
      Tabs.items = Tabs.items.filter(tab => !tab.library && !tab.project.startsWith('lib-'));
      Tabs.save();
      history.replaceState({}, '', urlOf('/library'));
      return render();
    }
  }
  app.currentURL = routeURL();
  app.pageDispose?.();
  app.pageDispose = null;
  const view = $('#view'),
    previous = Tabs.stateOf();
  if (previous) previous.scroll = view.scrollTop; // the tab being left remembers how far it was scrolled
  const route = (app.route = parseRoute());
  app.pageSave = null;
  closePopup();
  document.body.dataset.page = route.page;
  view.className = 'view-' + route.page;
  view.setAttribute('aria-busy', 'true');
  view.inert = true;
  try {
    await (PAGES[route.page] || showMissingPage)(view, route);
  } catch (error) {
    if (revision !== renderRevision) return;
    const [label, href] = parentPage(route);
    // Keep the page the reader asked for: its title, what failed, and a way forward. Replacing the whole view
    // with a bare error loses the place the reader is in, which matters most while the server is away.
    const title =
      {projects: 'Projects', resources: 'Library', settings: 'Settings', plugins: 'Plugins', api: 'API', environments: 'Server'}[
        route.page
      ] || 'This page';
    const offline = error.code === 'network_error' || (typeof Environment !== 'undefined' && Environment.status?.().status === 'disconnected');
    view.innerHTML = `<div class="page">${pageHead({title: esc(title), menu: ''})}<div class="empty"><h2>${
      offline ? 'The server could not be reached' : 'This page could not be opened'
    }</h2><p class="muted">${esc(
      offline ? 'Check the environment this client is connected to, then try again.' : error.message
    )}</p>${offline ? `<p class="muted small">${esc(error.message)}</p>` : ''}<p><button type="button" class="primary" data-retry>Try again</button> <a class="button" href="${esc(
      href
    )}" data-link>Back to ${esc(label)}</a></p></div></div>`;
    $('[data-retry]', view)?.addEventListener('click', () => render().catch(fail));
  }
  if (revision !== renderRevision) return;
  view.removeAttribute('aria-busy');
  view.inert = false;
  app.currentURL = routeURL();
  renderSidebar();
  Tabs.render(); // an editor has opened its own tab; a page has none, so no tab is the open one
  const now = Tabs.stateOf();
  if (now && now !== previous) view.scrollTop = now.scroll || 0;
  // The project list in the second panel shows workflow counts; refresh them on the way (the projects page loads them itself).
  if (sectionOf(route) === 'projects' && route.page !== 'projects') {
    loadProjects().catch(() => {});
    if (route.project) loadProjectWorkflows(route.project, true);
  }
}
async function showMissingPage(view) {
  view.innerHTML = `<div class="page">${pageHead({title: 'Page not found'})}<p class="muted">This address does not match a page.</p></div>`;
}
// Links are written as plain paths; give them their real address so middle-click and "copy link" work too.
const linkPath = link => {
  if (link.dataset.path !== undefined) return link.dataset.path;
  const raw = link.getAttribute('href') || '/';
  if (raw.startsWith('#/')) return (link.dataset.path = raw.slice(1));
  const url = new URL(raw, location.href);
  if (url.origin !== location.origin) return null;
  return (link.dataset.path = url.pathname + url.search);
};
const addressed = event => {
  const link = event.target.closest?.('a[data-link]');
  if (!link) return;
  const path = linkPath(link);
  if (path !== null) link.setAttribute('href', urlOf(path));
};
document.addEventListener('mouseover', addressed);
document.addEventListener('focusin', addressed);
document.addEventListener('pointerdown', addressed);
document.addEventListener('contextmenu', addressed, true);
document.addEventListener('click', event => {
  if (event.target.closest('.inline-rename')) return;
  const link = event.target.closest('a[data-link]');
  if (
    !link ||
    event.defaultPrevented ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey ||
    event.button ||
    link.hasAttribute('download') ||
    (link.target && link.target !== '_self')
  )
    return;
  const path = linkPath(link);
  if (path === null) return;
  event.preventDefault();
  go(path).catch(fail);
});
window.addEventListener('popstate', async () => {
  ++navigationRevision;
  try {
    if (await leaveView()) await render();
    else history.pushState({}, '', app.currentURL);
  } catch (error) {
    fail(error);
  }
});

// ---- tabs ----
// Tabs of the open graph editors (workflows and Custom Nodes), like files in a code editor; persisted in the application data store.
// Every other page (Dashboard, Projects, a project, Library, Settings) is reached through the sidebar and the second panel;
// it has no tab; Tabs.pages remembers scroll and local filters, while the URL selects the page and subsection.

const Tabs = {
  items: [],
  runtimes: new Map(),
  /** Editors shown during this page session: reopening one keeps its camera, a fresh open fits the view. */
  seen: new Set(),
  /** Scroll and local filters of non-editor pages, by page key. */
  pages: {},
  /** An editor tab is told apart by project/workflow. */
  key: tab => tab.project + '/' + tab.workflow,
  /** The key of a page that has no tab (an editor's key is its project/workflow). */
  pageKey(route) {
    return (
      {
        home: 'home',
        projects: 'projects',
        project: 'p:' + route.project,
        'project-settings': 'ps:' + route.project,
        settings: 'settings',
        environments: 'environments',
        // (no "/" in a key: an editor's key is project/workflow)
        resources: ['res', route.section, route.id || (route.folder ? 'in:' + encodeURIComponent(route.folder) : '')]
          .filter(Boolean)
          .join(':'),
        api: 'api',
        plugins: ['plugins', route.id].filter(Boolean).join(':'),
        'not-found': 'missing',
      }[route.page] || 'home'
    );
  },
  /** What the open page remembers: the Settings section, the scroll position. An editor tab holds its own. */
  stateOf(key = this.keyOf(app.route || {})) {
    const tab = this.items.find(t => this.key(t) === key);
    return tab || (key.includes('/') ? undefined : (this.pages[key] ??= {})); // an editor key is project/workflow
  },
  keyOf(route) {
    return route.workflow ? this.key(route) : this.pageKey(route);
  },
  load() {
    const saved = store.get('agentsys.client.v1.tabs', []);
    this.items = Array.isArray(saved) ? saved.filter(t => t && t.project && t.workflow) : [];
    const pages = store.get('agentsys.client.v1.pages', {});
    this.pages = pages && typeof pages === 'object' && !Array.isArray(pages) ? pages : {};
  },
  save() {
    for (const key of this.runtimes.keys())
      if (!this.items.some(tab => this.key(tab) === key)) this.runtimes.delete(key);
    for (const key of this.seen) if (!this.items.some(t => this.key(t) === key)) this.seen.delete(key);
    store.set('agentsys.client.v1.tabs', this.items);
    store.set('agentsys.client.v1.pages', this.pages);
  },
  /** Adds the editor to the bar (or refreshes its name) when its page opens. */
  open(tab) {
    const found = this.items.find(t => this.key(t) === this.key(tab));
    if (found) Object.assign(found, tab);
    else this.items.push(tab);
    this.arrange();
    this.save();
    this.render();
  },
  /** Pinned tabs form a stack on the left; the order inside each part is kept. */
  arrange() {
    this.items = [...this.items.filter(t => t.pinned), ...this.items.filter(t => !t.pinned)];
  },
  pin(key, pinned) {
    const tab = this.items.find(t => this.key(t) === key);
    if (!tab) return;
    if (pinned) tab.pinned = true;
    else delete tab.pinned;
    this.arrange();
    this.save();
    this.render();
  },
  rename(workflow, title) {
    const tab = this.items.find(t => t.workflow === workflow);
    if (!tab || tab.title === title) return;
    tab.title = title;
    this.save();
    this.render();
  },
  setIcon(workflow, icon) {
    const tab = this.items.find(t => t.workflow === workflow);
    if (!tab || tab.icon === icon) return;
    tab.icon = icon;
    this.save();
    this.render();
  },
  renameProject(project, sub) {
    for (const tab of this.items.filter(t => t.project === project && !t.library)) tab.sub = sub;
    this.save();
    this.render();
  },
  drop(workflow) {
    this.items = this.items.filter(t => t.workflow !== workflow);
    this.save();
    this.render();
  },
  dropProject(project) {
    this.items = this.items.filter(t => t.project !== project);
    for (const key of ['p:' + project, 'ps:' + project]) delete this.pages[key];
    this.save();
    this.render();
  },
  /** Closes a tab; when it was the open one, the neighbouring tab (or the project list) takes its place. */
  async close(key) {
    const index = this.items.findIndex(t => this.key(t) === key);
    if (index < 0 || this.items[index].pinned) return;
    const active = this.keyOf(app.route || {}) === key;
    const fallback = parentPage(app.route || {})[1];
    if (active && !(await leaveView())) return;
    this.items.splice(index, 1);
    this.save();
    if (!active) return this.render();
    const next = this.items[index] || this.items[index - 1];
    if (next) await go(this.href(next));
    else await go(fallback);
  },
  /** Closes several tabs at once (never the pinned ones); `stay` is the tab to show if the open one goes. */
  async closeMany(keys, stay) {
    const gone = new Set(keys.filter(k => !this.items.find(t => this.key(t) === k)?.pinned));
    if (!gone.size) return;
    const active = gone.has(this.keyOf(app.route || {}));
    const fallback = parentPage(app.route || {})[1];
    if (active && !(await leaveView())) return;
    this.items = this.items.filter(t => !gone.has(this.key(t)));
    this.save();
    if (!active) return this.render();
    const next = this.items.find(t => this.key(t) === stay) || this.items[0];
    await go(next ? this.href(next) : fallback);
  },
  menu(key, x, y) {
    const index = this.items.findIndex(t => this.key(t) === key),
      tab = this.items[index];
    if (!tab) return;
    const keys = list => list.map(t => this.key(t));
    popup(x, y, [
      [tab.pinned ? 'Unpin' : 'Pin', () => this.pin(key, !tab.pinned), {icon: tab.pinned ? 'unpin' : 'pin'}],
      null,
      ['Close', () => this.close(key).catch(fail), {icon: 'x', disabled: !!tab.pinned}],
      [
        'Close All',
        () => this.closeMany(keys(this.items), key).catch(fail),
        {icon: 'collapse', disabled: this.items.every(t => t.pinned)},
      ],
      [
        'Close to the right',
        () => this.closeMany(keys(this.items.slice(index + 1)), key).catch(fail),
        {icon: 'chevron', disabled: this.items.slice(index + 1).every(t => t.pinned)},
      ],
    ]);
  },
  href: tab => tab.href || `/p/${encodeURIComponent(tab.project)}/w/${encodeURIComponent(tab.workflow)}`,
  setRuntime(tab, detail) {
    const key = this.key(tab);
    const status = detail.paused ? 'paused' : detail.active_signals > 0 ? 'running' : 'idle';
    this.runtimes.set(key, status);
    const element = [...$('#tabs').children].find(el => el.dataset.tab === key && !el.classList.contains('closing'));
    if (element) this.paintRuntime(element, status);
  },
  paintRuntime(element, status) {
    element.classList.toggle('is-running', status === 'running');
    element.classList.toggle('is-paused', status === 'paused');
    element.dataset.runtime = status || 'idle';
    element.setAttribute(
      'aria-label',
      element.title + (status === 'running' ? ' (running)' : status === 'paused' ? ' (paused)' : '')
    );
  },
  async refreshRuntimes(workflows = null) {
    const current = app.route || {};
    const tabs = this.items.filter(
      tab =>
        !tab.library &&
        (!workflows || workflows.has(tab.workflow)) &&
        !(current.workflow === tab.workflow && W.executionReady)
    );
    await Promise.all(
      tabs.map(async tab => {
        try {
          const detail = await api(`projects/${tab.project}/execution`, {query: {workflow_id: tab.workflow}});
          if (this.items.includes(tab)) this.setRuntime(tab, detail);
        } catch (error) {
          if (error.status === 404) this.setRuntime(tab, {active_signals: 0});
        }
      })
    );
  },
  /** A closed tab fades and shrinks to nothing, so the tabs to its right glide over (the bar is a flex row; its width is animated in CSS). */
  dismiss(el) {
    if (document.documentElement.dataset.motion === 'false' || !el.isConnected) return el.remove();
    el.classList.remove('active');
    el.style.maxWidth = el.offsetWidth + 'px';
    el.style.pointerEvents = 'none';
    void el.offsetWidth; // the start width must be applied before the end width, or nothing animates
    el.classList.add('closing');
    el.addEventListener('transitionend', event => event.propertyName === 'max-width' && el.remove());
    setTimeout(() => el.remove(), 600); // in case no transition ends (hidden page)
  },
  /** Redraws the bar in place: a tab keeps its element, so switching the open one animates (CSS transitions) instead of flashing. */
  render() {
    const bar = $('#tabs');
    if (!bar) return;
    const current = this.keyOf(app.route || {}),
      old = new Map([...bar.children].filter(el => !el.classList.contains('closing')).map(el => [el.dataset.tab, el]));
    const tabs = this.items
      .filter(tab => developerMode() || (!tab.library && !tab.project.startsWith('lib-')))
      .map(tab => {
        const key = this.key(tab),
          el = old.get(key) || Object.assign(document.createElement('a'), {role: 'tab'}),
          sub = tab.library || tab.project.startsWith('lib-') ? 'Library' : tab.sub;
        old.delete(key);
        const html = `${icon(tab.icon || (tab.library ? 'complex' : 'node'))}<span class="tab-title">${esc(tab.title)}</span>${sub ? `<span class="tab-sub">${esc(sub)}</span>` : ''}${tab.pinned ? `<span class="tab-pin" title="Pinned">${icon('pin')}</span>` : `<button type="button" class="icon tab-close" data-close-tab="${esc(key)}" title="Close" aria-label="Close tab">${icon('x')}</button>`}`;
        el.dataset.tab = key;
        el.draggable = false;
        el.toggleAttribute('data-link', true);
        el.dataset.path = this.href(tab);
        el.href = urlOf(el.dataset.path);
        el.title = (sub ? sub + ' / ' : '') + tab.title;
        el.className = 'tab' + (key === current ? ' active' : '') + (tab.pinned ? ' is-pinned' : '');
        this.paintRuntime(el, this.runtimes.get(key));
        el.setAttribute('aria-selected', String(key === current));
        el.tabIndex =
          key === current || (!this.items.some(t => this.key(t) === current) && tab === this.items[0]) ? 0 : -1;
        if (el.dataset.html !== html) el.innerHTML = el.dataset.html = html;
        return el;
      });
    old.forEach(el => this.dismiss(el));
    // Tabs keep their order; a tab that is leaving stays where it was until it has shrunk away.
    let cursor = bar.firstElementChild;
    for (const el of tabs) {
      while (cursor && cursor !== el && cursor.classList.contains('closing')) cursor = cursor.nextElementSibling;
      if (cursor === el) cursor = cursor.nextElementSibling;
      else bar.insertBefore(el, cursor);
    }
    if (!this.sorting) $('.tab.active', bar)?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  },
};
Tabs.arrange();
$('#tabs').addEventListener('contextmenu', event => {
  const tab = event.target.closest('[data-tab]');
  if (!tab) return;
  event.preventDefault();
  if (Tabs.sorting) return;
  Tabs.menu(tab.dataset.tab, event.clientX, event.clientY);
});
$('#tabs').addEventListener('click', event => {
  const close = event.target.closest('[data-close-tab]');
  if (!close) return;
  event.preventDefault();
  event.stopPropagation();
  Tabs.close(close.dataset.closeTab).catch(fail);
});
$('#tabs').addEventListener('auxclick', event => {
  const tab = event.target.closest('[data-tab]');
  if (event.button !== 1 || !tab) return;
  event.preventDefault();
  Tabs.close(tab.dataset.tab).catch(fail);
});
$('#tabs').addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest('button')) return;
  const tab = event.target.closest('.tab:not(.closing)');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete'].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Delete') return Tabs.close(tab.dataset.tab).catch(fail);
  const tabs = $$('#tabs > .tab:not(.closing)'),
    index = tabs.indexOf(tab);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  go(tabs[next].dataset.path).catch(fail);
});
$('#tabs').addEventListener(
  'wheel',
  event => {
    if (event.deltaY && !event.deltaX) {
      event.currentTarget.scrollLeft += event.deltaY;
      event.preventDefault();
    }
  },
  {passive: false}
);

// Mouse drag reorders immediately; on touch, swipe scrolls and hold-then-drag reorders.
let suppressTabClick = false;
$('#tabs').addEventListener(
  'click',
  event => {
    if (suppressTabClick) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true
);
$('#tabs').addEventListener('pointerdown', event => {
  const tab = event.target.closest('.tab:not(.closing)');
  if (event.button !== 0 || !tab || event.target.closest('button,input')) return;
  const bar = event.currentTarget,
    key = tab.dataset.tab,
    moving = Tabs.items.find(t => Tabs.key(t) === key);
  if (!moving) return;
  const controller = new AbortController(),
    initial = Tabs.items.map(Tabs.key),
    scroll = bar.scrollLeft;
  let mode = '',
    timer,
    pointerX = event.clientX,
    grab = 0,
    frame = 0;
  const elOf = t => $(`[data-tab="${CSS.escape(Tabs.key(t))}"]`, bar);
  /** Where the pointer is in the bar's own coordinates (they do not change when the bar scrolls under it). */
  const contentX = () => pointerX - bar.getBoundingClientRect().left + bar.scrollLeft;
  /** The dragged tab follows the pointer exactly: its place in the row plus an offset that makes up the difference. */
  const follow = () => {
    // ...but never past the ends of the row: a tab pulled out of it would stretch the bar and make the other tabs scroll away.
    const last = bar.lastElementChild,
      left = Math.max(0, Math.min(contentX() - grab, last.offsetLeft + last.offsetWidth - tab.offsetWidth));
    tab.style.transform = `translateX(${left - tab.offsetLeft}px)`;
  };
  const start = () => {
    mode = 'sort';
    Tabs.sorting = true;
    grab = event.clientX - tab.getBoundingClientRect().left;
    tab.classList.add('sorting');
    follow();
    const edge = () => {
      // the bar scrolls on its own while the pointer rests at an edge
      if (mode !== 'sort') return;
      const rect = bar.getBoundingClientRect(),
        before = bar.scrollLeft;
      if (pointerX < rect.left + 40) bar.scrollLeft -= Math.min(18, (rect.left + 40 - pointerX) / 2 + 2);
      else if (pointerX > rect.right - 40) bar.scrollLeft += Math.min(18, (pointerX - rect.right + 40) / 2 + 2);
      if (bar.scrollLeft !== before) {
        follow();
        place();
      }
      frame = requestAnimationFrame(edge);
    };
    frame = requestAnimationFrame(edge);
  };
  /** Puts the dragged tab where the pointer is; the tabs it passes glide aside instead of jumping. */
  const place = () => {
    const x = contentX(),
      rest = Tabs.items.filter(t => t !== moving),
      peers = rest.filter(t => !!t.pinned === !!moving.pinned);
    const before = peers.find(t => {
      const el = elOf(t);
      return el && x < el.offsetLeft + el.offsetWidth / 2;
    });
    let index = before ? rest.indexOf(before) : moving.pinned ? rest.findIndex(t => !t.pinned) : rest.length;
    if (index < 0) index = rest.length;
    const unchanged = Tabs.items.indexOf(moving) === index;
    rest.splice(index, 0, moving);
    if (unchanged) {
      follow();
      return;
    }
    const others = [...bar.children].filter(el => el !== tab),
      from = new Map(others.map(el => [el, el.offsetLeft]));
    Tabs.items = rest;
    const next = rest[index + 1],
      ref = next && elOf(next);
    bar.insertBefore(tab, ref && ref.parentNode === bar ? ref : null);
    follow();
    for (const el of others) {
      const delta = from.get(el) - el.offsetLeft;
      if (!delta) continue;
      el.style.transition = 'none';
      el.style.transform = `translateX(${delta}px)`;
      void el.offsetWidth;
      el.style.transition = '';
      el.style.transform = '';
    }
  };
  if (event.pointerType === 'touch') timer = setTimeout(start, 300);
  const finish = cancel => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    controller.abort();
    if (cancel && mode === 'sort')
      Tabs.items.sort((a, b) => initial.indexOf(Tabs.key(a)) - initial.indexOf(Tabs.key(b)));
    Tabs.sorting = false;
    tab.classList.remove('sorting');
    if (mode === 'sort') {
      // the tab settles into its place
      const from = tab.getBoundingClientRect().left;
      tab.style.transition = 'none';
      tab.style.transform = '';
      Tabs.render();
      const delta = from - tab.getBoundingClientRect().left;
      if (delta && document.documentElement.dataset.motion !== 'false') {
        tab.style.transform = `translateX(${delta}px)`;
        void tab.offsetWidth;
        tab.style.transition = '';
        tab.style.transform = '';
      } else tab.style.transition = '';
    }
    if (mode) {
      suppressTabClick = true;
      setTimeout(() => (suppressTabClick = false), 0);
      Tabs.save();
      if (mode !== 'sort') Tabs.render();
    }
  };
  window.addEventListener(
    'pointermove',
    move => {
      if (move.pointerId !== event.pointerId) return;
      pointerX = move.clientX;
      const dx = move.clientX - event.clientX;
      if (!mode && Math.hypot(dx, move.clientY - event.clientY) < 6) return;
      if (!mode) {
        clearTimeout(timer);
        if (event.pointerType === 'touch') mode = 'scroll';
        else start();
      }
      move.preventDefault();
      if (mode === 'scroll') {
        bar.scrollLeft = scroll - dx;
        return;
      }
      follow();
      place();
    },
    {signal: controller.signal, passive: false}
  );
  for (const type of ['pointerup', 'pointercancel'])
    window.addEventListener(
      type,
      up => {
        if (up.pointerId === event.pointerId) finish(type === 'pointercancel');
      },
      {signal: controller.signal}
    );
  window.addEventListener(
    'keydown',
    key => {
      if (key.key === 'Escape') {
        key.preventDefault();
        finish(true);
      }
    },
    {signal: controller.signal}
  );
});

// Runtime commits also update tabs whose canvases are closed. Coalesce bursts of state/value events.
const changedTabRuntimes = new Set();
let tabRuntimeTimer = null;
Environment.subscribe(
  keys => {
    for (const key of keys) {
      const match = /^workflows\/([^/]+)\/runtime$/.exec(key);
      if (match && Tabs.items.some(tab => tab.workflow === match[1])) changedTabRuntimes.add(match[1]);
    }
    if (!changedTabRuntimes.size || tabRuntimeTimer) return;
    tabRuntimeTimer = setTimeout(() => {
      tabRuntimeTimer = null;
      const workflows = new Set(changedTabRuntimes);
      changedTabRuntimes.clear();
      Tabs.refreshRuntimes(workflows);
    }, 100);
  },
  {commits: true}
);

// ---- nav ----
// Navigation: the sidebar sections and the second panel. Every section is a tree of rows shown in the second panel
// (projects → workflows, Library groups → nodes) and the page beside it shows the open row's children as cards.
// Also the sliding highlight of "connected navigation" (css/app.css).

// ----- connected navigation follows the Effects appearance preference -----
let navJoinedKey = null;
const applyNavJoined = (on, layoutKey = '') => {
  const switched = document.body.classList.contains('nav-joined') !== on;
  document.body.classList.toggle('nav-joined', on);
  document.documentElement.classList.toggle('nav-joined-root', on);
  if (!switched && layoutKey === navJoinedKey) return; // a colour change leaves every row where it was: no layout pass for it
  navJoinedKey = layoutKey;
  requestAnimationFrame(() => placePills(true, true));
};

/** Which primary section owns a route; Dashboard contains its overview and API. */
function sectionOf(route) {
  if (route.page === 'ext') return 'ext:' + route.plugin;
  if (route.project?.startsWith('lib-')) return 'library'; // a Custom Node is edited as a workflow
  if (route.project || route.page === 'projects') return 'projects';
  return {resources: 'library', plugins: 'plugins', environments: 'environments', settings: 'settings', api: 'home'}[route.page] || 'home';
}
const SECTION_TITLES = {
  home: 'Dashboard',
  plugins: 'Plugins',
  projects: 'Projects',
  library: 'Library',
  environments: 'Server',
  settings: 'Settings',
  api: 'API reference',
};
/** A plugin page's section is named after its plugin. */
const sectionTitle = section =>
  section.startsWith('ext:') && typeof Extensions !== 'undefined'
    ? Extensions.sectionTitle(section)
    : SECTION_TITLES[section];

// ----- the second panel -----
/** The second panel's content: a section fills it from its tree (below), Settings from its page (`mount`). */
const Subnav = {
  changed: false,
  html: '',
  set(section, {title, body = ''}) {
    const panel = $('#subnav'),
      area = $('#subnav-body'),
      list = $('#subnav-list'),
      scroll = area.scrollTop,
      changed = panel.dataset.section !== section;
    panel.dataset.section = section;
    panel.setAttribute('aria-label', title + ' navigation');
    if (typeof body !== 'string') {
      list.replaceChildren(body);
      this.html = '';
    } else if (changed || body !== this.html) {
      list.innerHTML = this.html = body; // the rows are replaced; the highlight is not among them, so it glides
    }
    if (changed) {
      this.changed = true;
      list.classList.remove('enter');
      void list.offsetWidth; // restart the fade
      list.classList.add('enter');
    }
    area.scrollTop = changed ? 0 : scroll;
    if (typeof syncMobileNavigation === 'function') syncMobileNavigation();
  },
};

// ----- the rows -----
/** The unfolded groups of the trees. Every tree starts folded on each visit; a group opens only when you open it. */
const navOpen = new Set();

/**
 * One row: {key, label, icon, href, count, menu, children, drop, drag}. `children` (an array, or null while they load)
 * makes it a group with a chevron and a branch that unfolds; `menu` is what its "⋯" opens (see menuItems);
 * `drag`/`drop` make it a Custom Node that can be moved, or a place it can be moved to.
 */
const holdsActive = (n, active) => !!n.children?.some(c => c.key === active || holdsActive(c, active));
function navRow(n, active) {
  const group = n.children !== undefined,
    open = group && (n.open ?? navOpen.has(n.key)),
    here = n.key === active;
  const row = `<div class="subnav-row ${here ? 'active' : ''}" data-key="${esc(n.key)}"${n.drop !== undefined ? ` data-drop-folder="${esc(n.drop)}"` : ''}${n.drag ? ` draggable="true" data-drag="${esc(n.drag)}"` : ''}>${
    group
      ? `<button type="button" class="subnav-toggle" aria-label="Show or hide ${esc(n.label)}" aria-expanded="${open}">${icon('chevron')}</button>`
      : ''
  }${n.href ? `<a href="${esc(n.href)}" data-link title="${esc(n.label)}" ${here ? 'aria-current="page"' : ''}>${icon(n.icon)}<span>${esc(n.label)}</span></a>` : `<div class="subnav-static">${icon(n.icon)}<span>${esc(n.label)}</span></div>`}${n.menu ? `<button type="button" class="icon subnav-menu" data-menu="${esc(n.menu)}" aria-label="Actions of ${esc(n.label)}">${icon('dots')}</button>` : ''}</div>`;
  if (!group) return row;
  const kids = n.children ? n.children.map(c => navRow(c, active)).join('') : '';
  return `<div class="subnav-group ${open ? 'open' : ''}${holdsActive(n, active) ? ' on-path' : ''}" data-group="${esc(n.key)}">${row}<div class="subnav-branch"><div>${kids || `<p class="muted small">${n.children ? 'Nothing here yet.' : '…'}</p>`}</div></div></div>`;
}

/** Opens or closes a group; its branch slides, and the highlight follows the rows below it while they move. */
function setGroupOpen(group, open, remember = true) {
  group.classList.toggle('open', open);
  $(':scope > .subnav-row > .subnav-toggle', group)?.setAttribute('aria-expanded', String(open));
  if (remember) {
    open ? navOpen.add(group.dataset.group) : navOpen.delete(group.dataset.group);
  }
  if (open && group.dataset.group.startsWith('p:')) loadProjectWorkflows(group.dataset.group.slice(2));
  followPills();
}

// ----- the trees of the sections -----
// Projects form a tree like the API calls: a project, and under it its workflows.
const projectTree = {workflows: new Map()};
async function loadProjects() {
  app.projects = await api('projects');
  renderSidebar();
  return app.projects;
}
async function loadProjectWorkflows(id, force = false) {
  if (!force && projectTree.workflows.has(id)) return;
  try {
    projectTree.workflows.set(id, (await api(`projects/${id}`)).workflows);
  } catch {
    return;
  }
  renderSidebar();
}
/** The groups of Custom Nodes below `parent` with the nodes inside them. */
function folderRows(parent) {
  return [
    ...app.nodeFolders
      .filter(f => parentPath(f) === parent)
      .map(path => ({
        key: folderKey(path),
        label: baseName(path),
        icon: (app.nodeFolderIcons || {})[path] || 'folder',
        href: folderHref(path),
        menu: 'folder:' + path,
        drop: developerMode() ? path : undefined,
        children: folderRows(path),
      })),
    ...app.resources.filter(r => (r.payload.folder || '') === parent).map(resourceRow),
  ];
}
const resourceRow = r => ({
  key: 'r:' + r.id,
  label: r.name,
  icon: resourceIcon(r),
  href: developerMode() ? resourceHref(r) : null,
  menu: 'resource:' + r.id,
  drag: developerMode() ? r.id : undefined,
});
/** What each section shows: the open row (`active`), the groups to unfold to reach it, and the rows. */
// One definition of each primary section. Pages never replace this tree.
const SECTION_PANELS = {
  home: [['overview', 'Overview', 'chart']],
  settings: [
    ['editing', 'Editing', 'settings'],
    ['appearance', 'Appearance', 'palette'],
    ['keyboard-shortcuts', 'Keyboard shortcuts', 'keyboard'],
  ],
};
const sectionHref = (section, key) =>
  (section === 'home' ? '/' : '/' + section) + (SECTION_PANELS[section]?.length > 1 ? '?section=' + key : '');
function panelTree(section) {
  const current = selectedPanel(section);
  return {
    active: 'panel:' + current,
    rows: () =>
      SECTION_PANELS[section].map(([key, label, glyph]) => ({
        key: 'panel:' + key,
        label,
        icon: glyph,
        href: sectionHref(section, key),
      })),
  };
}
function selectedPanel(section) {
  const definitions = SECTION_PANELS[section],
    requested = routeQuery().get('section');
  return definitions.some(([key]) => key === requested) ? requested : definitions[0][0];
}
const NAV_TREES = {
  home: route => ({
    active: route.page === 'api' ? 'dashboard:api' : 'panel:overview',
    rows: () => [
      ...panelTree('home').rows(),
      {key: 'dashboard:api', label: 'API', icon: 'code', href: '/api', menu: 'section:api'},
    ],
  }),
  settings: () => panelTree('settings'),
  projects: route => ({
    active: route.workflow ? 'w:' + route.workflow : route.project ? 'p:' + route.project : 'overview:projects',
    rows: () => [
      ...(app.projects || []).map(p => {
        const loaded = projectTree.workflows.get(p.id);
        if (!loaded && navOpen.has('p:' + p.id)) loadProjectWorkflows(p.id);
        return {
          key: 'p:' + p.id,
          label: p.name,
          icon: 'folder',
          href: `/p/${p.id}`,
          menu: 'project:' + p.id,
          children: loaded
            ? [
                ...loaded.map(w => ({
                  key: 'w:' + w.id,
                  label: w.name,
                  icon: 'node',
                  href: `/p/${p.id}/w/${w.id}`,
                  menu: `workflow:${p.id}:${w.id}`,
                })),
              ]
            : null,
        };
      }),
    ],
  }),
  plugins: route => ({
    active: route.id ? 'pl:' + route.id : 'overview:plugins',
    rows: () =>
      (app.plugins || []).map(p => ({
        key: 'pl:' + p.id,
        label: p.title,
        icon: p.icon || 'plug',
        href: '/plugins/' + encodeURIComponent(p.id),
        menu: 'plugin:' + p.id,
      })),
  }),
  library: route => {
    const nodeId = route.project?.startsWith('lib-') ? route.project.slice(4) : route.id;
    return {
      active: nodeId
        ? 'r:' + nodeId
        : route.section
          ? route.folder
            ? folderKey(route.folder)
            : 's:' + route.section
          : 'overview:library',
      rows: () => [
        {key: 's:nodes', label: 'Nodes', icon: 'complex', href: NODES_PATH, menu: 'nodes:', children: folderRows('')},
        ...(app.librarySections || []).map(s => ({
          key: 's:' + s.id,
          label: s.title,
          icon: s.icon || 'plug',
          href: '/library/' + s.id,
          menu: 'collection:' + s.id,
        })),
        ...(typeof Extensions === 'undefined'
          ? []
          : Extensions.librarySections().map(s => ({
              key: 'x:' + s.plugin + ':' + s.id,
              label: s.title,
              icon: s.icon || 'database',
              href: s.href,
              menu: '',
            }))),
      ],
    };
  },
};
function pageMenu(route = app.route || {}) {
  if (route.page === 'ext') return '';
  if (route.page === 'resources' && !route.section) return 'section:library';
  if (route.page === 'resources' && route.section !== 'nodes') return 'collection:' + route.section;
  if (route.page === 'resources')
    return route.id ? 'resource:' + route.id : route.folder ? 'folder:' + route.folder : 'nodes:';
  // A section root page uses the same menu spec as its sidebar row: one source of actions, two entrances.
  if (route.page === 'projects') return 'section:projects';
  if (route.page === 'plugins' && !route.id) return 'section:plugins';
  if (route.page === 'environments') return 'section:environments';
  if (route.page === 'settings') return 'section:settings';
  if (route.page === 'api') return 'section:api';
  if (route.page === 'plugins' && route.id) return 'plugin:' + route.id;
  if (route.project) return route.workflow ? `workflow:${route.project}:${route.workflow}` : 'project:' + route.project;
  return '';
}
let shownSection = '',
  shownTarget = '';
/** The second panel of a plugin section: the pages that plugin registered. */
function extensionTree(route) {
  if (typeof Extensions === 'undefined') return null;
  return {
    active: 'x:' + route.id,
    rows: () =>
      Extensions.pagesOf(route.plugin).map(page => ({
        key: 'x:' + page.id,
        label: page.title,
        icon: page.icon || 'plug',
        href: Extensions.pageHref(route.plugin, page.id),
      })),
  };
}
function renderSubnav(route) {
  const section = sectionOf(route),
    tree = section.startsWith('ext:') ? extensionTree(route) : NAV_TREES[section]?.(route),
    target = Tabs.keyOf(route) + (route.page === 'api' ? ':' + (routeQuery().get('call') || '') : ''),
    changed = section !== shownSection || target !== shownTarget;
  $('#subnav').hidden = false;
  if (section !== shownSection) {
    navOpen.clear(); // Only an explicit toggle opens a Library branch.
  }
  shownSection = section;
  shownTarget = target;
  const title = sectionTitle(section) || 'Navigation';
  if (!tree) return Subnav.set(section, {title});
  if (changed && section === 'projects' && route.project) navOpen.add('p:' + route.project);
  const rows = tree.rows();
  Subnav.set(section, {
    title,
    body: `<nav class="subnav-tree" aria-label="${esc(title)}">${rows.map(n => navRow(n, tree.active)).join('')}${rows.length ? '' : `<p class="muted small">Nothing here yet.</p>`}</nav>`,
  });
}

// ----- the sliding highlight -----
/** One element per panel that glides to the open row, and the glow that flows out of it into the next panel (css/app.css). */
const navPills = {
  side: document.createElement('i'),
  sub: document.createElement('i'),
  mobile: document.createElement('i'),
};
for (const pill of Object.values(navPills)) pill.className = 'nav-pill off';
$('#sidebar').append(navPills.side);
$('#subnav-body').prepend(navPills.sub);
$('#mobile-secondary').prepend(navPills.mobile);
/** The glow of a panel is created on demand: one `.nav-seam` per host panel. */
function navSeam(host) {
  let seam = $(':scope > .nav-seam', host);
  if (!seam) {
    seam = document.createElement('i');
    seam.className = 'nav-seam off';
    host.prepend(seam);
  }
  return seam;
}
/** `jump`: the element moves at once (no transition) and starts gliding again two frames later. */
function settle(el, jump) {
  el.classList.toggle('jump', jump);
  const generation = (el.generation = (el.generation || 0) + 1);
  if (jump)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => el.generation === generation && el.classList.remove('jump'))
    );
}
/** What makes two rows "the same row" even when the list was redrawn between them. */
const rowId = el =>
  el.dataset.key || el.dataset.section || el.dataset.sideTab || el.dataset.method || el.querySelector('a[data-section]')?.dataset.section || el.textContent.trim();
const GLIDE_MS = 340; // a little more than the transition (--slow)
/**
 * Puts `pill` (inside `box`) over `row`, and the seam of the next panel (`host`) at the same height.
 * Another row than before: the pill glides there. The same row (it only moved: a group unfolded, the list scrolled): the pill
 * stays glued to it. `instant` (first placement, resize, another section) moves it at once.
 */
function placePill(pill, row, box, instant, host) {
  const seam = host && navSeam(host);
  const outgoing = box.closest('#subnav');
  if (!row || !row.offsetParent) {
    pill.classList.add('off');
    seam?.classList.add('off');
    host?.classList.remove('join-in-top', 'join-in-bottom');
    outgoing?.classList.remove('join-out-top', 'join-out-bottom');
    pill.classList.remove('join-top', 'join-bottom');
    return;
  }
  const r = row.getBoundingClientRect(),
    b = box.getBoundingClientRect(),
    now = performance.now(),
    id = rowId(row),
    other = pill.rowId !== id;
  pill.rowId = id;
  pill.style.setProperty('--x', r.left - b.left + box.scrollLeft - box.clientLeft + 'px');
  let jump = instant || pill.classList.contains('off');
  if (other && !jump) pill.glideUntil = now + GLIDE_MS;
  else jump = jump || now > (pill.glideUntil || 0); // still gliding to this row: only the target moves
  pill.style.setProperty('--y', r.top - b.top + box.scrollTop - box.clientTop + 'px');
  pill.style.setProperty('--h', r.height + 'px');
  pill.style.setProperty('--w', r.width + 'px');
  pill.classList.remove('off');
  settle(pill, jump);
  if (!seam) return;
  // A row scrolled out of its list keeps its pill (it scrolls along) but sends no glow into the next panel.
  if (r.bottom <= b.top || r.top >= b.bottom) {
    seam.classList.add('off');
    host.classList.remove('join-in-top', 'join-in-bottom');
    outgoing?.classList.remove('join-out-top', 'join-out-bottom');
    pill.classList.remove('join-top', 'join-bottom');
    return;
  }
  const h = host.getBoundingClientRect();
  const atTop = Math.abs(r.top - h.top) < 1;
  const atBottom = Math.abs(r.bottom - h.bottom) < 1;
  pill.classList.toggle('join-top', atTop);
  pill.classList.toggle('join-bottom', atBottom);
  host.classList.toggle('join-in-top', atTop);
  host.classList.toggle('join-in-bottom', atBottom);
  outgoing?.classList.toggle('join-out-top', atTop);
  outgoing?.classList.toggle('join-out-bottom', atBottom);
  settle(seam, jump || seam.classList.contains('off'));
  seam.style.setProperty('--y', r.top - h.top - host.clientTop + 'px');
  seam.style.setProperty('--h', r.height + 'px');
  seam.style.setProperty('--host-h', h.height + 'px');
  seam.style.setProperty('--x', r.left - h.left - host.clientLeft + 'px');
  seam.style.setProperty('--w', r.width + 'px');
  seam.style.setProperty('--host-w', h.width + 'px');
  seam.classList.remove('off');
}
/** A row inside a closed group (or in the folded panel) is represented by the group's own row. */
function shownRow(row) {
  const folded = document.body.classList.contains('subnav-collapsed');
  let shown = row;
  for (let branch = row?.closest('.subnav-branch'); branch; branch = branch.parentElement.closest('.subnav-branch')) {
    const group = branch.parentElement;
    if (folded || !group.classList.contains('open')) shown = $(':scope > .subnav-row', group);
  }
  return shown;
}
/** `list`: the second panel's pill jumps (another section filled it); `all`: both jump (resize, switching the design on). */
function placePills(list = false, all = false) {
  if (!document.body.classList.contains('nav-joined')) return;
  placeRailPill(all);
  if (typeof phoneLayout !== 'undefined' && phoneLayout.matches) {
    const sheet = document.body.classList.contains('mobile-subnav-open');
    const host = sheet ? $('#subnav') : $('#mobile-secondary');
    const inactive = sheet ? $('#mobile-secondary') : $('#subnav');
    $(':scope > .nav-seam', inactive)?.classList.add('off');
    placePill(navPills.side, $('#sidebar .sidebar-item.active'), $('#sidebar'), all, host);
    placePill(navPills.mobile, $('#mobile-browse'), $('#mobile-secondary'), list || all, $('main'));
    navPills.sub.classList.add('off');
    return;
  }
  placePill(navPills.side, $('#sidebar .sidebar-item.active'), $('#sidebar'), all, $('#subnav'));
  placePill(navPills.sub, shownRow($('#subnav .subnav-row.active')), $('#subnav-body'), list || all, $('main'));
}
/** The Properties panel's icon rail has its own pill (it flows left into the panel); the editor calls this when the open section changes. */
function placeRailPill(instant = false) {
  const nav = $('.side-tabs');
  if (!nav || !document.body.classList.contains('nav-joined')) return;
  let pill = $('.nav-pill', nav);
  if (!pill) {
    pill = document.createElement('i');
    pill.className = 'nav-pill off';
    nav.prepend(pill);
  }
  placePill(pill, $('button.active', nav), nav, instant, $('.side-content'));
}
/** Keeps the highlight on its row for a while: rows move while a group unfolds or the panel changes its width. */
let followUntil = 0,
  following = false;
function followPills(ms = 400) {
  followUntil = performance.now() + ms;
  if (following) return;
  following = true;
  const step = () => {
    placePills();
    if (performance.now() < followUntil) requestAnimationFrame(step);
    else following = false;
  };
  requestAnimationFrame(step);
}
addEventListener('resize', () => placePills(true, true));
// Follow both left highlights on every frame of a panel resize or collapse.
// Watching the list alone misses changes to the sidebar width and panel padding.
const pillResizeObserver = new ResizeObserver(() => {
  const dragging = document.body.classList.contains('resizing-panel');
  placePills(dragging, dragging);
});
for (const pill of Object.values(navPills)) pillResizeObserver.observe(pill);
for (const panel of [$('#sidebar'), $('#subnav')]) pillResizeObserver.observe(panel);
// Whatever changes the size of the list (a row added, a group unfolded, the panel folded) moves the rows: the highlight follows.
pillResizeObserver.observe($('#subnav-list'));
$('#subnav').addEventListener('transitionend', event => event.target === event.currentTarget && placePills());
// The glow in the content panel follows the open row while the second panel's list scrolls.
let seamFrame = 0;
$('#subnav-body').addEventListener('scroll', () => {
  if (seamFrame) return;
  seamFrame = requestAnimationFrame(() => {
    seamFrame = 0;
    placePills();
  });
});

function renderSidebar() {
  const route = app.route || {},
    section = sectionOf(route);
  if (typeof Extensions !== 'undefined') Extensions.renderSidebar();
  for (const link of $$('#sidebar [data-section], #brand')) {
    const on =
      link.dataset.section === section &&
      (!link.dataset.extPage || link.dataset.extPage === (route.page === 'ext' ? route.id : ''));
    link.classList.toggle('active', on);
    link.closest('.sidebar-item')?.classList.toggle('active', on);
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  renderSubnav(route);
  placePills(Subnav.changed);
  Subnav.changed = false;
  if (typeof syncMobileNavigation === 'function') syncMobileNavigation();
}

// ----- menus and folding -----
/** The menu behind a "⋯" (`data-menu="type:argument"`) on a row of the second panel or on a card. In the panel a rename asks in a dialog; on a card it happens on the spot. */
async function menuItems(spec, owner) {
  const items = await resolveMenuItems(spec, owner);
  return items?.map(item => {
    if (!item || typeof item[1] !== 'function') return item;
    const [label, action, options] = item;
    return [
      label,
      async (...args) => {
        if (app.pageSave && (await app.pageSave()) === false) return;
        return action(...args);
      },
      options,
    ];
  });
}
async function resolveMenuItems(spec, owner) {
  const items = await resolveBuiltinMenuItems(spec, owner);
  const extra = typeof Extensions === 'undefined' ? [] : Extensions.menuItems(spec, [menuContext(spec)]);
  if (!extra.length) return items;
  if (!items?.length) return extra;
  return [...items, null, ...extra];
}
/** The data a plugin's menu command receives: the object the menu belongs to, not a DOM node. */
function menuContext(spec) {
  const colon = String(spec || '').indexOf(':'),
    type = colon < 0 ? String(spec || '') : String(spec).slice(0, colon),
    arg = colon < 0 ? '' : String(spec).slice(colon + 1);
  if (type === 'resource') return {type, resource: (app.resources || []).find(r => r.id === arg) || null, id: arg};
  if (type === 'folder') return {type, folder: arg, resources: (app.resources || []).filter(r => underPath(r.payload.folder || '', arg))};
  if (type === 'plugin') return {type, plugin: (app.plugins || []).find(p => p.id === arg) || null, id: arg};
  if (type === 'project') return {type, project: (app.projects || []).find(p => p.id === arg) || null, id: arg};
  if (type === 'workflow') {
    const [project, workflow] = arg.split(':');
    return {type, project, workflow};
  }
  if (type === 'section') return {type, section: arg};
  if (type === 'collection') return {type, collection: arg};
  if (type === 'provider') return {type, provider: arg};
  if (type === 'nodes') return {type, section: 'nodes'};
  return {type, id: arg};
}
/** What the application itself puts in a menu; plugins add theirs after it (see Extensions.menuItems). */
async function resolveBuiltinMenuItems(spec, owner) {
  const colon = spec.indexOf(':'),
    type = spec.slice(0, colon),
    arg = spec.slice(colon + 1),
    title = () => menuTitle(spec, owner);
  if (type === 'project') {
    const project = app.projects.find(p => p.id === arg);
    return project && projectActions(project, title);
  }
  if (type === 'workflow') {
    const [projectId, workflowId] = arg.split(':'),
      workflow =
        (projectTree.workflows.get(projectId) || []).find(w => w.id === workflowId) ||
        (await api(`projects/${projectId}`)).workflows.find(w => w.id === workflowId);
    return workflow && workflowActions(projectId, workflow, title);
  }
  if (type === 'section') return sectionActions(arg);
  if (type === 'environment') return environmentActions(arg, title);
  if (type === 'nodes') return nodesActions();
  if (type === 'collection') return collectionActions(arg);
  if (type === 'provider') return providerActions(arg);
  if (type === 'resource')
    return resourceActions(
      app.resources.find(r => r.id === arg),
      title
    );
  if (type === 'folder') return folderActions(arg, title);
  if (type === 'plugin') return pluginActions((app.plugins || []).find(p => p.id === arg));
}

function sectionActions(section) {
  if (section === 'library') return nodesActions(false);
  if (section === 'projects')
    return [
      ['New project', newProjectDialog, {icon: 'plus'}],
      ['Import project', importProjects, {icon: 'download'}],
    ];
  if (section === 'plugins')
    return [
      ['Install plugin…', installPluginDialog, {icon: 'plus'}],
      ['Reload plugins', reloadPlugins, {icon: 'refresh'}],
    ];
  if (section === 'environments') return environmentSectionActions();
  if (section === 'settings')
    return [['Restore defaults', () => app.restoreSettings?.(), {icon: 'refresh', disabled: !app.restoreSettings}]];
  if (section === 'api')
    return [['Download OpenAPI', () => app.apiReference?.download(), {icon: 'download', disabled: !app.apiReference}]];
  return [];
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-menu]');
  if (!button) return;
  event.preventDefault();
  const rect = button.getBoundingClientRect();
  menuItems(button.dataset.menu, button)
    .then(items => items && popup(rect.left, rect.bottom + 4, items))
    .catch(fail);
});
// Cards and rows with actions keep their own menu; ordinary links retain native open/copy-link actions.
const plainNavigationLink = target => {
  const link = target.closest?.('a[data-link]');
  if (!link || link.closest('#tabs')) return false;
  return !link.closest('.card,.subnav-row,.sidebar-item')?.querySelector('[data-menu]');
};
// Text is the exception to every other menu: right-click on a text field (or on selected text) always opens the text menu.
const TEXT_FIELD =
  'textarea, input:not([type]), input[type=text], input[type=search], input[type=url], input[type=tel], input[type=email], input[type=password], input[type=number], [contenteditable=""], [contenteditable=true]';
function textMenuItems(field, selected) {
  const mod = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+',
    editable = !!field && !field.readOnly && !field.disabled,
    secret = field?.type === 'password',
    range = field && 'selectionStart' in field ? [field.selectionStart, field.selectionEnd] : null,
    back = () => {
      field?.focus();
      if (range && field.setSelectionRange) field.setSelectionRange(...range);
    };
  const run = command => () => {
    back();
    document.execCommand(command);
  };
  const paste = async () => {
    back();
    const text = await navigator.clipboard.readText();
    if (text && !document.execCommand('insertText', false, text) && field.setRangeText) {
      field.setRangeText(text, field.selectionStart, field.selectionEnd, 'end');
      field.dispatchEvent(new Event('input', {bubbles: true}));
    }
  };
  const all = () => {
    if (field) {
      back();
      if (field.select) field.select();
      else document.execCommand('selectAll');
    } else document.execCommand('selectAll');
  };
  return [
    ['Cut', run('cut'), {icon: 'cut', hint: mod + 'X', disabled: !editable || secret || !selected}],
    ['Copy', run('copy'), {icon: 'copy', hint: mod + 'C', disabled: secret || !selected}],
    ['Paste', paste, {icon: 'paste', hint: mod + 'V', disabled: !editable}],
    null,
    [
      'Select all',
      all,
      {icon: 'expand', hint: mod + 'A', disabled: field ? !(field.value ?? field.textContent) : false},
    ],
  ];
}
document.addEventListener(
  'contextmenu',
  event => {
    event.preventDefault();
    const field = event.target.closest?.(TEXT_FIELD),
      selection = getSelection();
    const picked =
      field && 'selectionStart' in field ? field.selectionStart !== field.selectionEnd : !!selection?.toString();
    if (!field && !(picked && selection.containsNode(event.target, true))) return;
    event.stopImmediatePropagation();
    if (field && document.activeElement !== field) field.focus();
    const items = field
        ? textMenuItems(
            field,
            'selectionStart' in field ? field.selectionStart !== field.selectionEnd : !!getSelection().toString()
          )
        : [textMenuItems(null, true)[1]],
      menu = popup(event.clientX, event.clientY, items),
      dialog = event.target.closest('dialog');
    // Inside a modal dialog everything else is inert, so the menu goes into the dialog.
    if (dialog) {
      dialog.append(menu);
      menu.classList.add('in-dialog');
    }
  },
  true
);
document.addEventListener('contextmenu', event => {
  if (plainNavigationLink(event.target)) return;
  const custom = event.target.closest('[data-context-menu]');
  if (custom) return custom.click();
  if (!event.target.closest('[data-menu]') && event.target.closest('#canvas, #tabs, .popup')) return;
  const owner = event.target.closest('[data-menu], .card, .subnav-row, .sidebar-item');
  const button = owner?.matches('[data-menu]') ? owner : owner?.querySelector('[data-menu]');
  if (!button) return;
  menuItems(button.dataset.menu, button)
    .then(items => items && popup(event.clientX, event.clientY, items))
    .catch(fail);
});
$('#subnav').addEventListener('click', event => {
  const toggle = event.target.closest('.subnav-toggle');
  if (!toggle) return;
  event.preventDefault();
  const group = toggle.closest('.subnav-group');
  setGroupOpen(group, !group.classList.contains('open'));
});

// ---- notifications ----
// The notification bell (top right, beside Search): an icon with a dot while the list is not empty; it opens a list of the messages
// kept by `notifications` (backend/routes-notifications.js). Plugins (api.notify) and Scripts (POST notifications) post to it.

const Notifications = {items: [], total: 0, open: false};
async function loadNotifications() {
  const result = await api('notifications', {query: {limit: 100}});
  Notifications.items = result.items;
  Notifications.total = result.total;
  drawNotifications();
}
function drawNotifications() {
  const bell = $('#open-notifications');
  if (!bell) return;
  bell.classList.toggle('has', Notifications.total > 0);
  bell.setAttribute('aria-label', Notifications.total ? `Notifications, ${Notifications.total}` : 'Notifications');
  if (!Notifications.open) return;
  $('#notifications-list').innerHTML = Notifications.items.length
    ? Notifications.items
        .map(
          n =>
            `<div class="notif lvl-${esc(n.level)}" data-id="${esc(n.id)}"><span class="notif-dot" aria-hidden="true"></span>${
              n.href ? `<a class="notif-main" href="${esc(n.href)}" data-link>` : '<div class="notif-main">'
            }<strong>${esc(n.title)}</strong>${n.body ? `<span class="notif-body">${esc(n.body)}</span>` : ''}<small class="muted">${esc([when(n.created), n.source].filter(Boolean).join(' · '))}</small>${n.href ? '</a>' : '</div>'}<button type="button" class="icon" data-notif-delete aria-label="Delete notification">${icon('x')}</button></div>`
        )
        .join('')
    : '<p class="muted notif-empty">No notifications.</p>';
  $('#notifications-clear').disabled = !Notifications.items.length;
}
function setNotificationsOpen(open) {
  Notifications.open = open;
  const panel = $('#notifications-panel');
  panel.inert = !open;
  panel.classList.toggle('open', open);
  $('#open-notifications').setAttribute('aria-expanded', String(open));
  if (open) loadNotifications().catch(fail);
}
const notificationAction = (path, options) => api(path, options).then(loadNotifications).catch(fail);
document.addEventListener('click', event => {
  const bell = event.target.closest('#open-notifications');
  if (bell) return setNotificationsOpen(!Notifications.open);
  if (!Notifications.open) return;
  const inside = event.target.closest('#notifications-panel');
  if (!inside) return setNotificationsOpen(false);
  if (event.target.closest('#notifications-close')) {
    setNotificationsOpen(false);
    $('#open-notifications').focus();
    return;
  }
  const row = event.target.closest('.notif');
  if (event.target.closest('#notifications-clear')) return notificationAction('notifications', {method: 'DELETE'});
  if (!row) return;
  if (event.target.closest('[data-notif-delete]'))
    return notificationAction('notifications/' + row.dataset.id, {method: 'DELETE'});
  if (event.target.closest('a')) setNotificationsOpen(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && Notifications.open) {
    setNotificationsOpen(false);
    $('#open-notifications').focus();
  }
});
Environment.subscribe(keys => {
  if (keys.includes('notifications')) loadNotifications().catch(() => {});
});
document.addEventListener('DOMContentLoaded', () => setTimeout(() => loadNotifications().catch(() => {}), 0));
