'use strict';

// ---- plugin-content ----
// Passive plugin content is a separate boundary from sandbox code and host registrations.
const PluginContent = (() => {
  // Escapes/comments can hide resource-loading CSS tokens; plugin CSS has no need for either.
  const unsafeCSS = text => /\\|\/\*|@import|(?:url|image-set|src|expression)\s*\(|behavior\s*:|-moz-binding|javascript:/i.test(text);
  /** Passive HTML from a plugin page or card. Scripts, frames, external styles, event handlers and unsafe URLs are removed. */
  function sanitizeHTML(value) {
    const template = document.createElement('template');
    template.innerHTML = String(value ?? '').slice(0, 300000);
    // HTML elements report an upper-case tagName, namespaced ones (SVG, MathML) keep their lower-case name: compare
    // the local name without case, so `<svg><script>` is removed like `<script>`.
    const banned = new Set([
      'SCRIPT',
      'IFRAME',
      'FRAME',
      'FRAMESET',
      'OBJECT',
      'EMBED',
      'LINK',
      'META',
      'BASE',
      'FORM',
      'STYLE',
      'TEMPLATE',
      'AUDIO',
      'VIDEO',
      'TRACK',
      'SOURCE',
      'USE',
      'IMAGE',
      'ANIMATE',
      'SET',
      'ANIMATETRANSFORM',
    ]);
    const tagged = node => String(node.localName || node.tagName || '').toUpperCase();
    // URL parsers ignore ASCII tabs/newlines inside a scheme (`java&#10;script:` is javascript:), so normalize
    // before matching. A data URL may only be an image in an image element; SVG data can carry script.
    const compactURL = text => String(text || '').replace(/[\u0000-\u0020\u007f-\u009f]+/g, '').toLowerCase();
    const imageData = /^data:image\/(?:png|jpeg|gif|webp)[;,]/;
    const unsafeURL = (text, tag, name) => {
      const value = compactURL(text);
      const attribute = name.toLowerCase();
      // Resource URLs also occur on input[type=image], SVG feImage/textPath and other elements, not just img.
      if (attribute === 'src') return tag !== 'IMG' || !imageData.test(value);
      if (attribute === 'srcset') return true;
      if (['href', 'xlink:href'].includes(attribute) && tag !== 'A') return !value.startsWith('#');
      if (['action', 'formaction', 'ping', 'poster', 'background'].includes(attribute)) return true;
      // Only img.src above accepts data URLs. Links may navigate, but never execute code or open local files.
      if (/^(?:javascript|vbscript|file|data):/.test(value)) return true;
      return false;
    };
    const walk = node => {
      for (const child of [...node.children]) {
        const tag = tagged(child);
        if (banned.has(tag) || (child.namespaceURI && !['http://www.w3.org/1999/xhtml', 'http://www.w3.org/2000/svg'].includes(child.namespaceURI))) {
          child.remove();
          continue;
        }
        for (const attr of [...child.attributes]) {
          const name = attr.name.toLowerCase();
          const text = String(attr.value || '');
          const urlAttribute = /^(?:href|xlink:href|src|srcset|poster|action|formaction|ping|background)$/.test(name);
          if (name.startsWith('on') || name === 'srcdoc' ||
              (name.startsWith('data-') && !['data-command', 'data-args'].includes(name)) ||
              (urlAttribute && unsafeURL(text, tag, name)))
            child.removeAttribute(attr.name);
          else if (/^(?:style|fill|stroke|filter|clip-path|mask|marker-start|marker-mid|marker-end|cursor)$/.test(name) && unsafeCSS(text))
            child.removeAttribute(attr.name);
        }
        if (tag === 'A') {
          child.setAttribute('rel', 'noopener noreferrer');
          if (/^https?:/i.test(child.getAttribute('href') || '')) child.setAttribute('target', '_blank');
          else child.removeAttribute('target');
        }
        walk(child);
      }
    };
    walk(template.content);
    return template.innerHTML;
  }

  /** Sanitized passive HTML with one extra control: a button marked `data-command` runs that plugin's command. */
  function decorateHTML(value, pluginId) {
    const template = document.createElement('template');
    template.innerHTML = sanitizeHTML(value);
    for (const node of template.content.querySelectorAll('[data-command]')) {
      const command = String(node.getAttribute('data-command') || '');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(command)) {
        node.removeAttribute('data-command');
        continue;
      }
      let args = [];
      try {
        const parsed = JSON.parse(node.getAttribute('data-args') || '[]');
        if (Array.isArray(parsed)) args = parsed.slice(0, 20);
      } catch {}
      node.setAttribute('data-ext-command', `${pluginId}:${command}`);
      if (args.length) node.setAttribute('data-ext-args', JSON.stringify(args));
    }
    return template.innerHTML;
  }

  /** A sidebar item points into this client; a URL of another origin or another scheme is not a destination. */
  function internalHref(value) {
    const text = String(value || '');
    if (text.length > 2000 || !/^\/(?!\/)/.test(text) || /[\\\u0000-\u001f\u007f]/.test(text))
      throw new Error('A sidebar item href must be a path of this client, starting with "/"');
    return text;
  }

  return {sanitize: sanitizeHTML, decorate: decorateHTML, internalHref, unsafeCSS};
})();

// ---- plugin-frame ----
// The isolated plugin program and SDK bridge. No host state or DOM access is captured here.
const PluginFrame = (() => {
  /** The sandbox document: a module loader, the public API object, lifecycle hooks and the message bridge. */
  function document(plugin, context) {
    const config = JSON.stringify({
      id: plugin.id,
      title: plugin.title,
      description: plugin.description,
      icon: plugin.icon,
      version: plugin.version,
      api: plugin.api,
      capabilities: Array.isArray(plugin.capabilities) ? plugin.capabilities : [],
      main: plugin.main || 'plugin.js',
      source: plugin.source,
      files: plugin.files || {},
      assets: plugin.assets || {},
      lifecycle: {
        hook: context?.hook || 'activate',
        previousChecksum: context?.previousChecksum || null,
        checksum: context?.checksum || plugin.checksum,
      },
    }).replace(/</g, '\\u003c');
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'"><script>
(() => {
  const plugin = ${config};
  const handlers = new Map();
  const changeListeners = new Set();
  const pending = new Map();
  const moduleCache = new Map();
  const controller = new AbortController();
  let serial = 0;
  let exportsObject = {};
  const send = (kind, args) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, {resolve, reject});
    parent.postMessage({__agentsys: 'plugin', kind, id, args}, '*');
  });
  addEventListener('message', event => {
    if (event.source !== parent) return;
    const message = event.data;
    if (!message || message.__agentsys !== 'host') return;
    if (message.kind === 'result' || message.kind === 'hook-result') {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      message.error ? item.reject(new Error(message.error)) : item.resolve(message.value);
      return;
    }
    if (message.kind === 'shutdown') {
      try { controller.abort(new Error('The plugin stopped')); } catch {}
      return;
    }
    if (message.kind === 'event' && message.name === 'change') {
      for (const listener of changeListeners) { try { listener(...(message.args || [])); } catch (error) { console.error(error); } }
      return;
    }
    if (message.kind === 'invoke') {
      const handler = handlers.get(message.name);
      const render = /^(?:page|home|settings|library|inspector|resource):/.test(String(message.name || ''));
      Promise.resolve()
        .then(() => (handler ? handler(...(message.args || [])) : undefined))
        .then(value => {
          if (render && value && typeof value === 'object' && typeof value.outerHTML === 'string') value = value.outerHTML;
          const answer = render ? (value == null ? '' : String(value)) : value === undefined ? null : value;
          parent.postMessage({__agentsys: 'plugin', kind: 'invoke-result', id: message.id, value: answer}, '*');
        }, error => parent.postMessage({__agentsys: 'plugin', kind: 'invoke-result', id: message.id, error: error.message || String(error)}, '*'));
      return;
    }
    if (message.kind === 'lifecycle') {
      const name = String(message.name || '');
      const hook = typeof exportsObject[name] === 'function' ? exportsObject[name] : name === 'deactivate' ? exportsObject.__activateDispose : null;
      Promise.resolve()
        .then(() => (hook ? hook(api, message.context || message.args || {}) : undefined))
        .then(value => parent.postMessage({__agentsys: 'plugin', kind: 'hook-result', id: message.id, value: value === undefined ? null : value}, '*'))
        .catch(error => parent.postMessage({__agentsys: 'plugin', kind: 'hook-result', id: message.id, error: error.message || String(error)}, '*'));
    }
  });
  addEventListener('pagehide', () => {
    // The frame is navigating away or being destroyed; the host must not keep a sandbox that is no longer this plugin.
    try { parent.postMessage({__agentsys: 'plugin', kind: 'unloading'}, '*'); } catch {}
  });
  const remote = kind => (...args) => send(kind, args);
  const request = remote('request');
  const resolveModule = (from, name) => {
    let request = String(name || '');
    let target;
    if (request.startsWith('.')) {
      const parts = from.split('/').slice(0, -1);
      for (const part of request.split('/')) {
        if (part === '.' || part === '') continue;
        if (part === '..') { if (!parts.length) throw new Error('A module path leaves the package: ' + name); parts.pop(); }
        else parts.push(part);
      }
      target = parts.join('/');
    } else target = request;
    if (!/\.(?:js|json)$/i.test(target)) target += '.js';
    if (!Object.prototype.hasOwnProperty.call(plugin.files, target)) throw new Error('Module not found in the package: ' + name);
    return target;
  };
  const loadModule = path => {
    if (moduleCache.has(path)) return moduleCache.get(path).exports;
    const source = path === plugin.main ? null : plugin.files[path];
    const text = source === null ? plugin.source : source;
    if (typeof text !== 'string') throw new Error('The package entry is missing: ' + path);
    const module = {exports: {}};
    moduleCache.set(path, module);
    if (/\.json$/i.test(path)) {
      try {
        module.exports = JSON.parse(text);
      } catch (error) {
        moduleCache.delete(path);
        throw new Error('Invalid JSON module ' + path + ': ' + error.message);
      }
      return module.exports;
    }
    const localRequire = name => loadModule(resolveModule(path, name));
    try {
      new Function('exports', 'module', 'require', 'api', 'console', text)(module.exports, module, localRequire, api, console);
    } catch (error) {
      moduleCache.delete(path);
      throw error;
    }
    return module.exports;
  };
  const registerView = (call, kind, spec) => {
    const hasRender = typeof spec.render === 'function';
    if (hasRender) handlers.set(kind + ':' + spec.id, spec.render);
    const fields = ['id', 'title', 'description', 'icon', 'order', 'nav', 'when', 'collection', 'sidebar'];
    return send(call, [{...Object.fromEntries(fields.map(field => [field, spec[field]])), hasRender}]);
  };
  const withOwner = spec => ({...(spec || {}), plugin: {id: plugin.id}});
  const api = {
    id: plugin.id, title: plugin.title, description: plugin.description, icon: plugin.icon,
    version: plugin.version, api: plugin.api,
    capabilities: plugin.capabilities || [],
    manifest: {
      id: plugin.id, name: plugin.title, version: plugin.version, api: plugin.api,
      capabilities: plugin.capabilities || [], icon: plugin.icon,
    },
    asset: name => Object.prototype.hasOwnProperty.call(plugin.assets, name) ? plugin.assets[name] : '',
    assets: () => ({...plugin.assets}),
    signal: controller.signal,
    log: (...args) => parent.postMessage({__agentsys: 'plugin', kind: 'log', args: args.map(String)}, '*'),
    request: remote('request'),
    storage: {
      get: (key, fallback = null) => send('storage.get', [key, fallback]),
      set: remote('storage.set'),
      remove: remote('storage.remove'),
    },
    settings: {
      get: remote('settings.get'),
      set: remote('settings.set'),
    },
    commands: {
      register(command, handler, meta = {}) {
        const id = String(command);
        handlers.set('command:' + id, handler);
        return send('ui.addCommand', [{id, title: meta.title || id, icon: meta.icon, order: meta.order}]);
      },
      execute: (command, ...args) => send('commands.execute', [String(command), ...args]),
    },
    ui: {
      addPage: (spec = {}) => registerView('ui.addPage', 'page', spec),
      addSidebarItem: remote('ui.addSidebarItem'),
      addToolbarButton: remote('ui.addToolbarButton'),
      addMenuItem: (menu, item) => send('ui.addMenuItem', [{...item, menu}]),
      /** A context menu entry on the canvas selection (the same registry as addMenuItem('canvas:selection')). */
      addContextMenu(item = {}) {
        return send('ui.addMenuItem', [{...item, menu: 'canvas:selection'}]);
      },
      addHomeCard: (spec = {}) => registerView('ui.addHomeCard', 'home', spec),
      addSettingsSection: (spec = {}) => registerView('ui.addSettingsSection', 'settings', spec),
      addLibrarySection: (spec = {}) => registerView('ui.addLibrarySection', 'library', spec),
      addInspectorSection: (spec = {}) => registerView('ui.addInspectorSection', 'inspector', spec),
      addResourceView: (spec = {}) => registerView('ui.addResourceView', 'resource', spec),
      showDialog: remote('ui.showDialog'),
      closeDialog: remote('ui.closeDialog'),
      addStyles: remote('ui.addStyles'),
      escape: value =>
        String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character]),
      notify: remote('notify'),
      toast: (message, bad = false) => send('toast', [message, bad]),
      navigate: remote('navigate'),
      refresh: remote('refresh'),
      pageHref: id => '/ext/' + encodeURIComponent(plugin.id) + '/' + encodeURIComponent(id),
    },
    library: {
      list: () => request('GET', 'resources'),
      get: id => request('GET', 'resources/' + encodeURIComponent(id)),
      createNode: spec => request('POST', 'library/script-nodes', withOwner(spec)),
      ensureNode: async spec => {
        const list = await request('GET', 'resources');
        const found = list.find(item => item.name === spec.name);
        return found || request('POST', 'library/script-nodes', withOwner(spec));
      },
      updateNode: (id, spec) => request('POST', 'library/script-nodes', {...withOwner(spec), resource_id: id}),
      deleteNode: id => request('DELETE', 'resources/' + encodeURIComponent(id)),
    },
    collections: {
      list: () => request('GET', 'collections'),
      define: (name, definition) => request('PUT', 'collections/' + encodeURIComponent(name), definition),
      records: (name, query) => request('GET', 'collections/' + encodeURIComponent(name) + '/records', undefined, query),
      create: (name, data, id) => request('POST', 'collections/' + encodeURIComponent(name) + '/records', {data, id}),
      update: (name, id, data, version) =>
        request('PUT', 'collections/' + encodeURIComponent(name) + '/records/' + encodeURIComponent(id), {data}, version === undefined ? undefined : {if_version: version}),
      remove: (name, id) => request('DELETE', 'collections/' + encodeURIComponent(name) + '/records/' + encodeURIComponent(id)),
    },
    workflows: {
      projects: () => request('GET', 'projects'),
      createProject: name => request('POST', 'projects', {name}),
      workflows: project => request('GET', 'projects/' + encodeURIComponent(project)),
      createWorkflow: (project, name) => request('POST', 'projects/' + encodeURIComponent(project) + '/workflows', {name}),
      placeNode: (project, workflow, resource, point) =>
        request('POST', 'projects/' + encodeURIComponent(project) + '/custom-nodes/' + encodeURIComponent(resource), {point: point || {x: 0, y: 0}}, {workflow_id: workflow}),
    },
    net: {
      fetch: spec => request('POST', 'net', spec),
    },
    secrets: {
      /** Metadata only: a client plugin never receives a secret value. */
      present: name => request('GET', 'secrets/' + encodeURIComponent(name)),
    },
    env: {info: remote('env.info')},
    onDidChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    on(event, listener) {
      if (event !== 'change') throw new Error('Unknown event: ' + event);
      return api.onDidChange(listener);
    },
  };
  try {
    exportsObject = loadModule(plugin.main);
    if (typeof exportsObject.activate !== 'function') throw new Error('The plugin must export activate(api)');
    const run = async () => {
      const context = {...plugin.lifecycle};
      if (context.hook === 'install' && typeof exportsObject.onInstall === 'function')
        await exportsObject.onInstall(api, context);
      if (context.hook === 'update' && typeof exportsObject.onUpdate === 'function')
        await exportsObject.onUpdate(api, context);
      const dispose = await exportsObject.activate(api);
      if (typeof dispose === 'function') exportsObject.__activateDispose = dispose;
      parent.postMessage({__agentsys: 'plugin', kind: 'ready', ok: true}, '*');
    };
    run().catch(error => parent.postMessage({__agentsys: 'plugin', kind: 'ready', error: error.message || String(error)}, '*'));
  } catch (error) {
    parent.postMessage({__agentsys: 'plugin', kind: 'ready', error: error.message || String(error)}, '*');
  }
})();
</script>`;
  }

  return {document};
})();

// ---- plugin-views ----
// Declarative plugin views. One registration owns its page, navigation and section projections.
// The host supplies only the sandbox's checked request and invocation capabilities.

class PluginViews {
  constructor() {
    this.entries = [];
  }
  static href(plugin, id) {
    return `/ext/${encodeURIComponent(plugin)}/${encodeURIComponent(id)}`;
  }
  list(kind, plugin) {
    return this.entries
      .filter(item => (!kind || item.kind === kind) && (!plugin || item.plugin === plugin))
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
      .map(item => ({...item}));
  }
  pages(plugin) {
    return this.list(null, plugin).filter(item => item.page).map(item => ({
      ...item,
      id: item.page,
      ...(item.kind === 'library' ? {section: 'library'} : {}),
      ...(item.kind === 'resource' ? {
        resourceView: item.id,
        description: item.description || `Records of ${item.collection}`,
      } : {}),
    }));
  }
  page(plugin, id) {
    return this.pages(plugin).find(item => item.id === id);
  }
  sidebar() {
    return this.list().filter(item => item.page && item.nav).map(item => ({
      plugin: item.plugin, id: 'nav:' + item.page, page: item.page,
      href: item.href, title: item.title, icon: item.icon, order: item.order,
      ...(item.kind === 'library' ? {section: 'library'} : {}),
    }));
  }
  remove(plugin) {
    this.entries = this.entries.filter(item => item.plugin !== plugin);
  }
  add(kind, spec, sandbox) {
    const {plugin} = sandbox;
    const labels = {
      page: 'page', library: 'Library section', home: 'dashboard card',
      settings: 'settings section', inspector: 'inspector section', resource: 'resource view',
    };
    const label = labels[kind];
    if (!label) throw new Error('Unknown plugin view: ' + kind);
    if (typeof spec.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(spec.id))
      throw new Error(`${label} id must be letters, digits, ".", "_" or "-"`);
    if (!spec.hasRender) throw new Error(`A ${label} needs a render() function`);
    if (kind === 'resource' && !/^[a-z][a-z0-9-]{0,63}$/.test(String(spec.collection || '')))
      throw new Error('A resource view needs a collection name');
    const page = ['page', 'library', 'resource'].includes(kind)
      ? (kind === 'resource' ? 'view-' : '') + spec.id : null;
    if (page && this.page(plugin.id, page)) throw new Error(`The page "${page}" is already registered`);
    const collection = kind === 'resource' ? String(spec.collection) : undefined;
    const item = {
      kind, plugin: plugin.id, id: spec.id,
      title: String(spec.title || (kind === 'home' || kind === 'settings' || kind === 'inspector'
        ? plugin.title : collection || spec.id)).slice(0, 120),
      description: String(spec.description || '').slice(0, kind === 'settings' || kind === 'inspector' ? 500 : 2000),
      icon: spec.icon || (kind === 'library' || kind === 'resource' ? 'database' : plugin.icon || 'plug'),
      order: Number(spec.order) || 0,
      page,
      href: page ? PluginViews.href(plugin.id, page) : undefined,
      nav: kind === 'resource' ? spec.sidebar === true : spec.nav !== false,
      ...(collection ? {collection} : {}),
      ...(kind === 'inspector' ? {when: ['any', 'node', 'complex'].includes(spec.when) ? spec.when : 'any'} : {}),
      render: async (root, context) => {
        let args = ['home', 'settings'].includes(kind) ? [] : [clone(context || {})];
        if (kind === 'resource') {
          const answer = await sandbox.checkedRequest('GET', `collections/${encodeURIComponent(collection)}/records`, undefined, {limit: 200});
          args = [{collection, records: clone(answer?.records || []), total: answer?.total || 0, page: clone(context || {})}];
        }
        root.innerHTML = PluginContent.decorate(await sandbox.invoke(kind + ':' + spec.id, args), plugin.id);
      },
    };
    this.entries.push(item);
    return true;
  }
}

// ---- extensions ----
// The client extension host. Plugins are installed in this browser (js/plugin-store.js) and run inside a
// sandboxed iframe with an opaque origin: they cannot read this page's DOM, storage, cookies or server token.
// They talk to the host through a small message API: request(), storage, commands and declarative UI registrations.
//
// Lifecycle: a package is installed, enabled, reloaded, updated and removed here. The sandbox runs activate(api),
// deactivate(api) and the optional onInstall / onUpdate / onUninstall hooks. Every registration and every
// timer belongs to one sandbox and is dropped with it.
//
// This is an isolation boundary for convenience plugins, not a hardened boundary against a malicious program:
// an installed plugin can call the same API this user can, within its declared capabilities. See https://github.com/smoothie-ws/agentsys/wiki/Plugin-Reference.

const Extensions = (() => {
  const loaded = new Map(); // plugin id -> sandbox
  const errors = new Map();
  const sidebarItems = [];
  const toolbarButtons = [];
  const menuContributions = [];
  const views = new PluginViews();
  const commands = new Map();
  const styleNodes = new Map();
  let loading = null;

  const byOrder = (a, b) =>
    (a.order || 0) - (b.order || 0) ||
    String(a.title ?? a.label ?? '').localeCompare(String(b.title ?? b.label ?? ''));
  const checkId = (id, what = 'id') => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id))
      throw new Error(`${what} must be letters, digits, ".", "_" or "-"`);
    return id;
  };
  const removeWhere = (list, match) => {
    for (let i = list.length - 1; i >= 0; i--) if (match(list[i])) list.splice(i, 1);
  };
  const pagesOf = id => views.pages(id);
  const findPage = (plugin, id) => views.page(plugin, id);
  const pageHref = (plugin, id) => PluginViews.href(plugin, id);
  const pluginTitle = id => (typeof app !== 'undefined' && app.plugins?.find(p => p.id === id)?.title) || id;
  const cssId = id => String(id).replace(/[^A-Za-z0-9_-]/g, '-');

  const sanitizeHTML = value => PluginContent.sanitize(value);
  const internalHref = value => PluginContent.internalHref(value);

  /** One sandboxed iframe per plugin: no same-origin access, no direct DOM, storage or token. */
  class PluginSandbox {
    constructor(plugin, context = {}) {
      this.plugin = plugin;
      this.capabilities = PluginCapabilities.forPlugin(plugin);
      this.pending = new Map();
      this.serial = 0;
      this.dead = false;
      this.stopping = false;
      this.requests = new AbortController();
      this.token = null; // a server-issued token scoped to this plugin's capabilities
      this.onCrash = null;
      this.readyDone = false;
      this.loads = 0;
      this.ready = new Promise((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });
      this.frame = document.createElement('iframe');
      this.frame.title = `Plugin ${plugin.id}`;
      this.frame.setAttribute('sandbox', 'allow-scripts');
      this.frame.setAttribute('aria-hidden', 'true');
      this.frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-10000px;top:0;border:0;';
      this.url = URL.createObjectURL(new Blob([PluginFrame.document(plugin, context)], {type: 'text/html'}));
      this.frame.src = this.url;
      // A second document load after the plugin is running means the frame navigated or crashed: stop it rather than
      // keeping a half-alive sandbox that no longer matches the installed package.
      this.frame.addEventListener('load', () => {
        this.loads++;
        if (this.loads > 1 && this.readyDone && Date.now() - this.startedAt > 1000 && !this.dead)
          this.crash(new Error('The plugin frame stopped unexpectedly. Use Try again to restart it.'));
      });
      this.onMessage = event => {
        if (this.dead || event.source !== this.frame.contentWindow) return;
        // The blob document has an opaque origin. If the frame navigated to a real page, its messages carry that
        // page's origin and must not be mistaken for the installed plugin.
        if (event.origin !== 'null') return;
        const data = event.data;
        if (!data || data.__agentsys !== 'plugin') return;
        if (data.kind === 'unloading') {
          this.crash(new Error('The plugin frame stopped unexpectedly. Use Try again to restart it.'));
          return;
        }
        if (data.kind === 'ready') {
          if (data.error) this.rejectReady(new Error(data.error));
          else if (data.ok) {
            this.readyDone = true;
            this.startedAt = Date.now();
            this.resolveReady({});
          }
          return;
        }
        if (data.kind === 'invoke-result' || data.kind === 'hook-result') {
          const pending = this.pending.get(data.id);
          if (!pending) return;
          this.pending.delete(data.id);
          data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.value);
          return;
        }
        this.receive(data).then(
          value =>
            this.frame.contentWindow?.postMessage(
              {__agentsys: 'host', kind: 'result', id: data.id, value},
              '*'
            ),
          error =>
            this.frame.contentWindow?.postMessage(
              {__agentsys: 'host', kind: 'result', id: data.id, error: error.message || String(error) },
              '*'
            )
        );
      };
      window.addEventListener('message', this.onMessage);
      document.body.append(this.frame);
      this.timer = setTimeout(() => {
        if (this.dead) return;
        this.rejectReady(new Error('The plugin did not start within 8 seconds.'));
      }, 8000);
    }
    async start() {
      try {
        return await this.ready;
      } finally {
        clearTimeout(this.timer);
      }
    }
    post(kind, name, args) {
      if (this.dead) return Promise.reject(new Error('The plugin is not running.'));
      const id = ++this.serial;
      return new Promise((resolve, reject) => {
        // A plugin that never answers must not leave the page waiting forever.
        const timer = setTimeout(() => {
          this.pending.delete(id);
          const error = new Error('The plugin did not answer within 20 seconds.');
          this.crash(error);
          reject(error);
        }, 20000);
        this.pending.set(id, {
          resolve: value => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: error => {
            clearTimeout(timer);
            reject(error);
          },
        });
        this.frame.contentWindow?.postMessage({__agentsys: 'host', kind, id, name, args}, '*');
      });
    }
    invoke(name, args) {
      return this.post('invoke', name, args);
    }
    /** Calls a lifecycle hook in the sandbox. A plugin that never answers is stopped, not left running. */
    async lifecycle(name, context = {}, {allowRequests = false} = {}) {
      if (this.dead || this.stopping) return undefined;
      this.stopping = !allowRequests;
      let timer;
      try {
        return await Promise.race([
          this.post('lifecycle', name, context),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`The plugin did not finish ${name} within 3 seconds.`)), 3000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        this.stopping = false;
      }
    }
    emit(name, args) {
      this.frame.contentWindow?.postMessage({__agentsys: 'host', kind: 'event', name, args}, '*');
    }
    /** One API call on behalf of this plugin, checked against its capabilities, with the scoped token when the
     * server issues one and retried once after that token expires or the server restarts. */
    async sendRequest(method, path, body, query) {
      this.inFlight = (this.inFlight || 0) + 1;
      try { return await this.performRequest(method, path, body, query); }
      finally { this.inFlight--; }
    }
    async performRequest(method, path, body, query) {
      const gen = Environment.generation();
      const ensureRunning = () => {
        if (this.dead || this.stopping) throw new Error('The plugin is not running.');
        if (gen !== Environment.generation()) throw new Error('The environment changed.');
      };
      const acquire = async refresh => {
        const token = await Environment.pluginToken(this.capabilities, {owner: this.plugin.id, refresh});
        if (this.dead || this.stopping || gen !== Environment.generation()) {
          Environment.revokePluginToken(token);
          ensureRunning();
        }
        this.token = token;
      };
      ensureRunning();
      const upper = String(method || 'GET').toUpperCase();
      if (!this.token) await acquire(false);
      const send = () => {
        ensureRunning();
        return Environment.request(upper, path, {body, query, auth: this.token || undefined, signal: this.requests.signal});
      };
      const usedToken = this.token;
      try {
        return await send();
      } catch (error) {
        if (!usedToken || !['plugin_token_expired', 'plugin_token_invalid'].includes(error.code)) throw error;
        ensureRunning();
        // Another request may already have renewed this sandbox's token while this response was in flight.
        if (this.token === usedToken) await acquire(true);
        return send();
      }
    }
    /** The capability boundary for direct host helpers (resource deployment): same rules as api.request. */
    async checkedRequest(method, path, body, query) {
      const clean = String(path || '').replace(/^\/+/, '');
      if (clean.startsWith('auth/') || clean === 'auth')
        throw new Error('A client plugin cannot use authentication endpoints');
      const decision = PluginCapabilities.check(this.capabilities, String(method || 'GET').toUpperCase(), clean, body);
      if (!decision.ok) throw new Error(decision.reason);
      return this.sendRequest(String(method || 'GET').toUpperCase(), clean, body, query);
    }
    async receive(data) {
      const plugin = this.plugin;
      const viewKinds = {
        'ui.addPage': 'page', 'ui.addLibrarySection': 'library', 'ui.addHomeCard': 'home',
        'ui.addSettingsSection': 'settings', 'ui.addInspectorSection': 'inspector', 'ui.addResourceView': 'resource',
      };
      if (Object.hasOwn(viewKinds, data.kind)) return views.add(viewKinds[data.kind], data.args?.[0] || {}, this);
      switch (data.kind) {
        case 'request': {
          const [method, path, body, query] = data.args || [];
          return this.checkedRequest(method, path, body, query);
        }
        case 'storage.get':
          return PluginStore.storage(plugin.id).get(data.args?.[0], data.args?.[1]);
        case 'storage.set':
          PluginStore.storage(plugin.id).set(data.args?.[0], data.args?.[1]);
          return true;
        case 'storage.remove':
          PluginStore.storage(plugin.id).remove(data.args?.[0]);
          return true;
        case 'ui.addSidebarItem': {
          const spec = data.args?.[0] || {};
          checkId(spec.id, 'sidebar item id');
          if (sidebarItems.some(item => item.plugin === plugin.id && item.id === spec.id))
            throw new Error(`The sidebar item "${spec.id}" is already registered`);
          if (!spec.href && !spec.page) throw new Error('A sidebar item needs an href or a page');
          sidebarItems.push({
            plugin: plugin.id,
            id: spec.id,
            page: spec.page,
            href: spec.page ? pageHref(plugin.id, spec.page) : internalHref(spec.href),
            title: String(spec.title || spec.id).slice(0, 120),
            icon: spec.icon || plugin.icon || 'plug',
            order: Number(spec.order) || 0,
          });
          return true;
        }
        case 'ui.addCommand': {
          const spec = data.args?.[0] || {};
          checkId(spec.id, 'command id');
          const key = `${plugin.id}:${spec.id}`;
          commands.set(key, {
            key,
            plugin: plugin.id,
            id: spec.id,
            title: String(spec.title || spec.id).slice(0, 120),
            icon: spec.icon || '',
            order: Number(spec.order) || 0,
            run: (...args) => this.invoke('command:' + spec.id, args),
          });
          return true;
        }
        case 'ui.addToolbarButton': {
          const spec = data.args?.[0] || {};
          checkId(spec.id, 'toolbar button id');
          if (!spec.command) throw new Error('A toolbar button needs a command');
          toolbarButtons.push({
            plugin: plugin.id,
            id: spec.id,
            title: String(spec.title || spec.command).slice(0, 120),
            icon: spec.icon || plugin.icon || 'plug',
            command: spec.command,
            order: Number(spec.order) || 0,
          });
          return true;
        }
        case 'ui.addMenuItem': {
          const spec = data.args?.[0] || {};
          if (typeof spec.menu !== 'string' || !spec.menu.trim() || spec.menu.length > 80)
            throw new Error('A menu item needs a menu');
          if (typeof spec.label !== 'string' || !spec.label.trim() || spec.label.length > 120)
            throw new Error('A menu item needs a label');
          checkId(spec.command, 'command');
          if (menuContributions.length > 200) throw new Error('Too many menu items');
          menuContributions.push({
            plugin: plugin.id,
            menu: spec.menu.slice(0, 80),
            label: spec.label.slice(0, 120),
            icon: spec.icon || '',
            command: spec.command,
            order: Number(spec.order) || 0,
          });
          return true;
        }
        case 'ui.showDialog':
          return this.showDialog(data.args?.[0] || {});
        case 'ui.closeDialog':
          if (typeof $('#modal')?.close === 'function') $('#modal').close();
          return true;
        case 'ui.addStyles': {
          const css = String(data.args?.[0] || '');
          if (css.length > 100000) throw new Error('Styles are too large');
          if (PluginContent.unsafeCSS(css))
            throw new Error('Plugin styles cannot load external resources');
          const node = document.createElement('style');
          node.dataset.plugin = plugin.id;
          node.textContent = css;
          document.head.append(node);
          if (!styleNodes.has(plugin.id)) styleNodes.set(plugin.id, []);
          styleNodes.get(plugin.id).push(node);
          return true;
        }
        case 'commands.execute': {
          const [id, ...args] = data.args || [];
          // A plugin runs its own commands: a plugin id is not a way to reach another plugin's command.
          const name = String(id ?? '');
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name))
            throw new Error('A plugin can only run a command of its own, by name');
          return execute(`${plugin.id}:${name}`, ...args);
        }
        case 'notify': {
          const notification = data.args?.[0] || {};
          const body = {...notification, source: notification.source || 'plugin:' + plugin.id};
          return this.checkedRequest('POST', 'notifications', body);
        }
        case 'toast':
          toast(String(data.args?.[0] || ''), !!data.args?.[1]);
          return true;
        case 'navigate':
          go(String(data.args?.[0] || '/')).catch(fail);
          return true;
        case 'refresh':
          render().catch(fail);
          return true;
        case 'env.info':
          return {
            ...Environment.status().environment,
            protocol: globalThis.AgentSysProtocol?.PROTOCOL,
            status: Environment.status().status,
          };
        case 'log':
          console.info(`[${plugin.id}]`, ...(data.args || []));
          return true;
        case 'settings.get':
          return PluginStore.storage(plugin.id).get('settings', {});
        case 'settings.set':
          PluginStore.storage(plugin.id).set('settings', data.args?.[0] || {});
          return true;
        default:
          throw new Error('Unknown plugin call: ' + data.kind);
      }
    }
    /** A dialog drawn by the host with the plugin's passive body and its own commands as actions. */
    showDialog(spec) {
      const plugin = this.plugin;
      const title = String(spec.title || plugin.title).slice(0, 120);
      const body = sanitizeHTML(String(spec.body ?? spec.html ?? ''));
      const actions = (Array.isArray(spec.actions) ? spec.actions : [])
        .slice(0, 8)
        .map((action, index) => ({
          index,
          id: String(action.id || action.label || index).slice(0, 80),
          label: String(action.label || 'OK').slice(0, 80),
          command: action.command ? String(action.command) : '',
          args: Array.isArray(action.args) ? action.args : [],
          variant: ['primary', 'secondary', 'danger'].includes(action.variant) ? action.variant : '',
        }));
      const buttons = actions.length
        ? `<div class="button-row">${actions
            .map(
              action =>
                `<button type="button" data-plugin-dialog-action="${action.index}" class="${action.variant === 'danger' ? 'danger' : action.variant === 'primary' ? 'primary' : ''}">${esc(action.label)}</button>`
            )
            .join('')}</div>`
        : '';
      return new Promise(resolve => {
        const modal = $('#modal');
        let finished = false;
        let actionPending = false;
        const finish = value => {
          if (finished) return;
          finished = true;
          modal.removeEventListener('click', onClick);
          modal.removeEventListener('close', onClose);
          this.requests.signal.removeEventListener('abort', onAbort);
          resolve(value);
        };
        const onAbort = () => finish({action: null});
        const onClose = () => {
          if (!actionPending) finish({action: null});
        };
        const onClick = event => {
          const button = event.target.closest?.('[data-plugin-dialog-action]');
          if (!button) return;
          const action = actions[Number(button.dataset.pluginDialogAction)];
          if (!action) return;
          event.preventDefault();
          actionPending = true;
          const close = spec.close !== false;
          const values = Object.fromEntries(new FormData($('#modal-form')).entries());
          if (close) modal.close();
          if (!action.command) {
            actionPending = false;
            return finish({action: action.id, values});
          }
          Promise.resolve(execute(`${plugin.id}:${action.command}`, values, ...action.args)).then(
            result => finish({action: action.id, result: result === undefined ? null : result, values}),
            error => finish({action: action.id, error: error.message || String(error), values})
          );
        };
        dialog(title, body + buttons, null);
        modal.addEventListener('click', onClick);
        if (spec.close !== false) modal.addEventListener('close', onClose);
        this.requests.signal.addEventListener('abort', onAbort, {once: true});
      });
    }
    /** Runs the deactivate hook, then removes the frame. A plugin cannot act after this returns. */
    async stop(hook = 'deactivate', context = {}) {
      if (this.dead) return;
      try {
        if (hook === 'onUninstall') {
          // A cleanup hook may still use the API before the sandbox is removed; deactivate is the last call and
          // cannot start new work.
          await this.lifecycle('onUninstall', context, {allowRequests: true});
          await this.lifecycle('deactivate', {});
        } else if (hook) await this.lifecycle(hook, context);
      } finally {
        this.dispose();
      }
    }
    crash(error) {
      if (this.dead) return;
      this.dead = true;
      this.dispose();
      if (this.onCrash) this.onCrash(error);
    }
    dispose() {
      this.dead = true;
      this.requests.abort();
      clearTimeout(this.timer);
      // A disabled plugin's scoped token ends now, not when it happens to expire.
      if (this.token)
        Environment.revokePluginToken(this.token);
      this.token = null;
      window.removeEventListener('message', this.onMessage);
      try {
        this.frame.contentWindow?.postMessage({__agentsys: 'host', kind: 'shutdown'}, '*');
      } catch {}
      this.frame.remove();
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = null;
      for (const pending of this.pending.values()) pending.reject(new Error('The plugin stopped.'));
      this.pending.clear();
    }
    api() {
      return {
        id: this.plugin.id,
        capabilities: this.capabilities.slice(),
        request: (method, path, body, query) => this.checkedRequest(method, path, body, query),
        library: {
          list: () => this.checkedRequest('GET', 'resources'),
        },
      };
    }
  }

  function cleanupRegistrations(id) {
    views.remove(id);
    removeWhere(sidebarItems, item => item.plugin === id);
    removeWhere(toolbarButtons, item => item.plugin === id);
    removeWhere(menuContributions, item => item.plugin === id);
    for (const key of [...commands.keys()]) if (commands.get(key).plugin === id) commands.delete(key);
    for (const node of styleNodes.get(id) || []) node.remove();
    styleNodes.delete(id);
    document.body.classList.remove('plugin-' + cssId(id));
  }

  /** Stops one plugin: its deactivate hook runs, its registrations, styles and scoped token go. */
  async function stopModule(id, hook = 'deactivate', context = {}) {
    const entry = loaded.get(id);
    if (entry) {
      try {
        await entry.stop(hook, context);
      } catch (error) {
        console.error(`[plugins] ${id}: ${hook} failed:`, error);
      }
      loaded.delete(id);
    }
    cleanupRegistrations(id);
  }

  async function loadModule(plugin, hook = 'activate', from = null) {
    let sandbox;
    try {
      const context = {hook, previousChecksum: from, checksum: plugin.checksum};
      sandbox = new PluginSandbox(plugin, context);
      await sandbox.start();
      sandbox.onCrash = error => {
        errors.set(plugin.id, error.message || String(error));

        cleanupRegistrations(plugin.id);
        loaded.delete(plugin.id);
        renderAll();
      };
      loaded.set(plugin.id, sandbox);
      document.body.classList.add('plugin-' + cssId(plugin.id));
      errors.delete(plugin.id);

      PluginStore.markActivated(plugin.id, plugin.checksum);
      return true;
    } catch (error) {
      sandbox?.dispose();
      errors.set(plugin.id, error.message || String(error));

      console.error(`[plugins] ${plugin.id}: the interface could not start:`, error);
      if (typeof toast === 'function')
        toast(`The interface of ${plugin.title || plugin.id} could not start: ${error.message}`, true);
      cleanupRegistrations(plugin.id);
      return false;
    }
  }

  const hookFor = plugin => {
    if (!plugin.activatedChecksum) return {hook: 'install', from: null};
    if (plugin.activatedChecksum !== plugin.checksum) return {hook: 'update', from: plugin.activatedChecksum};
    return {hook: 'activate', from: null};
  };

  /** Activates enabled plugins and removes those that stopped. Never throws. */
  async function sync(plugins) {
    if (loading) return loading;
    loading = (async () => {
      let list = plugins;
      if (!list) {
        try {
          await PluginStore.load();
          list = PluginStore.list();
        } catch (error) {
          console.error('[plugins] could not list the client plugins:', error);
          return;
        }
      }
      app.plugins = list;
      const wanted = new Map(list.filter(p => p.enabled).map(p => [p.id, p]));
      for (const id of [...loaded.keys()]) if (!wanted.has(id)) await stopModule(id, 'deactivate');
      for (const id of [...errors.keys()]) if (!wanted.has(id)) errors.delete(id);

      // A dependency that was turned off (or removed) takes its dependants down with it, even if they are
      // already running: a plugin must not keep using a service that is no longer enabled.
      for (const plugin of wanted.values()) {
        if (!loaded.has(plugin.id)) continue;
        const deps = PluginManifest.checkDependencies(plugin, list, {requireEnabled: true});
        if (deps.ok) continue;
        await stopModule(plugin.id, 'deactivate');
        errors.set(plugin.id, deps.errors.map(item => item.message).join(' '));
      }

      const sorted = PluginManifest.activationOrder([...wanted.values()]);
      for (const problem of sorted.errors) {
        if (errors.has(problem.id)) continue;
        errors.set(problem.id, problem.message);
        console.error(`[plugins] ${problem.id}: ${problem.message}`);
      }
      const order = sorted.order;
      for (const plugin of order) {
        if (loaded.has(plugin.id) || errors.has(plugin.id)) continue;
        const deps = PluginManifest.checkDependencies(plugin, list, {requireEnabled: true});
        if (!deps.ok) {
          errors.set(plugin.id, deps.errors.map(item => item.message).join(' '));
          continue;
        }
        const {hook, from} = hookFor(plugin);
        await loadModule(plugin, hook, from);
      }
      renderAll();
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  async function reload(plugins) {
    if (loading) await loading;

    errors.clear();
    for (const id of [...loaded.keys()]) await stopModule(id, 'deactivate');
    renderAll();
    return sync(plugins);
  }

  function execute(key, ...args) {
    const command = commands.get(key);
    if (!command) {
      fail(new Error(`Unknown command: ${key}`));
      return Promise.reject(new Error(`Unknown command: ${key}`));
    }
    return Promise.resolve(command.run(...args)).catch(error => {
      fail(error);
      throw error;
    });
  }

  // ----- lifecycle actions used by the Plugins page and tests -----
  async function install(value, options) {
    const id = value?.manifest?.id || value?.id;
    const previous = id ? PluginStore.record(id) : null;
    const plugin = PluginStore.install(value, options);
    await reload();
    const problem = errors.get(plugin.id);
    if (problem) {
      // A package that cannot start does not stay installed over a working one.
      if (previous) PluginStore.install(previous, {approveCapabilities: true});
      else PluginStore.remove(plugin.id);
      await reload();
      throw new ApiError('plugin_activation_failed', `${plugin.title || plugin.id} could not start: ${problem}`, 500);
    }
    return plugin;
  }

  async function update(id, value, options) {
    const previous = PluginStore.record(id);
    if (!previous) throw new ApiError('not_found', 'Plugin not found', 404);
    const plugin = PluginStore.update(id, value, options);
    await reload();
    const problem = errors.get(id);
    if (problem) {
      PluginStore.install(previous, {approveCapabilities: true});
      await reload();
      throw new ApiError('plugin_update_failed', `${plugin.title || id} could not be updated: ${problem}`, 500);
    }
    return plugin;
  }

  async function uninstall(id) {
    const record = PluginStore.record(id);
    if (!record) throw new ApiError('not_found', 'Plugin not found', 404);
    await stopModule(id, 'onUninstall', {hook: 'uninstall', previousChecksum: null, checksum: record.checksum});
    PluginStore.clear(id);
    PluginStore.remove(id);
    errors.delete(id);
    renderAll();
    return true;
  }

  async function disable(id) {
    const plugin = PluginStore.setEnabled(id, false);
    await stopModule(id, 'deactivate');
    errors.delete(id);
    await sync();
    renderAll();
    return plugin;
  }

  async function enable(id) {
    const plugin = PluginStore.setEnabled(id, true);
    errors.delete(id);
    await sync();
    if (errors.has(id)) throw new ApiError('plugin_activation_failed', errors.get(id), 500);
    return plugin;
  }

  async function recover(id) {
    errors.delete(id);
    await sync();
    return !errors.has(id);
  }

  /** Deploys the package's declared server resources through this plugin's checked capabilities. */
  async function deploymentPlan(id) {
    const entry = loaded.get(id);
    if (!entry) throw new ApiError('plugin_not_running', 'Turn the plugin on before planning deployment.', 409);
    return PluginDeploy.plan(PluginStore.record(id), {
      request: (method, path, body, query) => entry.checkedRequest(method, path, body, query),
    });
  }

  async function deploy(id, {force = false} = {}) {
    const entry = loaded.get(id);
    if (!entry) throw new ApiError('plugin_not_running', 'Turn the plugin on before deploying its resources.', 409);
    const record = PluginStore.record(id);
    if (!record) throw new ApiError('not_found', 'Plugin not found', 404);
    const storage = PluginStore.hostStorage(id);
    const key = '__agentsys:deployment';
    const state = storage.get(key, null);
    if (typeof PluginDeploy === 'undefined')
      throw new ApiError('internal_error', 'The deployment module is not loaded.', 500);
    const result = await PluginDeploy.deploy(record, {
      request: (method, path, body, query) => entry.checkedRequest(method, path, body, query),
      state,
      environment: storage.environment,
      force,
      log: message => console.info('[plugins]', message),
    });
    storage.set(key, result.state);
    return result;
  }

  function deploymentOf(id) {
    const storage = PluginStore.hostStorage(id);
    return typeof PluginDeploy === 'undefined'
      ? {deployed: false, counts: {collections: 0, library: 0, workflows: 0}}
      : PluginDeploy.status(PluginStore.record(id), storage.get('__agentsys:deployment', null));
  }

  // ----- drawing what plugins registered -----
  function renderSidebarItems() {
    const host = typeof document === 'undefined' ? null : document.getElementById('sidebar-extensions');
    if (!host) return;
    const items = [...sidebarItems, ...views.sidebar()].sort(byOrder);
    host.hidden = !items.length;
    host.innerHTML = items
      .map(
        item =>
          `<div class="sidebar-item" data-ext="${esc(item.plugin + ':' + item.id)}"><a href="${esc(item.href)}" data-link data-section="ext:${esc(item.plugin)}" data-ext-page="${esc(item.page || '')}" title="${esc(item.title)}">${icon(item.icon)}<span>${esc(item.title)}</span></a></div>`
      )
      .join('');
  }

  function renderToolbar() {
    const host = typeof document === 'undefined' ? null : document.getElementById('toolbar-slot');
    if (!host) return;
    const items = [...toolbarButtons].sort(byOrder);
    host.hidden = !items.length;
    host.innerHTML = items
      .map(item => {
        const key = `${item.plugin}:${item.command}`;
        return `<button type="button" class="icon" data-ext-command="${esc(key)}"${commands.has(key) ? '' : ' disabled'} title="${esc(item.title)}" aria-label="${esc(item.title)}">${icon(item.icon)}</button>`;
      })
      .join('');
  }

  function renderContribution(item, body, context) {
    Promise.resolve().then(() => item.render(body, context)).catch(error => {
      body.innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
      console.error(`[plugins] ${item.plugin}: ${item.kind} failed:`, error);
    });
  }

  function renderHome(host) {
    if (!host) return;
    const cards = views.list('home');
    host.innerHTML = cards.length
      ? `<section class="ext-home"><div class="section-head"><h2>Plugins</h2></div><div class="cards">${cards.map(item =>
        `<article class="card" data-ext-home="${esc(item.plugin + ':' + item.id)}"><div class="card-main"><header class="card-head"><span class="head-icon">${icon(item.icon)}</span><h3>${esc(item.title)}</h3></header><div class="card-preview card-note"></div></div></article>`
      ).join('')}</div></section>` : '';
    $$('[data-ext-home] .card-preview', host).forEach((body, i) => renderContribution(cards[i], body));
  }

  /** Settings and Inspector sections share rendering and failure handling. */
  function renderSections(host, items, kind, context) {
    host.innerHTML = items.map(item =>
      `<section class="${kind === 'settings' ? 'plugin-settings' : 'inspector-plugin'}" data-ext-${kind}="${esc(item.plugin + ':' + item.id)}"><h2>${esc(item.title)}</h2>${kind === 'settings' && item.description ? `<p class="muted">${esc(item.description)}</p>` : ''}<div${kind === 'settings' ? ' class="plugin-settings-body"' : ''}></div></section>`
    ).join('');
    Array.from(host.children).forEach((section, i) => renderContribution(items[i], section.lastElementChild, context));
  }

  function renderSettings(host) {
    if (host) renderSections(host, views.list('settings'), 'settings');
  }

  function renderInspector(host, context = {}) {
    if (!host) return;
    const node = context.node || null;
    const kind = node?.kind === 'complex' ? 'complex' : node ? 'node' : '';
    const sections = kind ? views.list('inspector').filter(item => item.when === 'any' || item.when === kind) : [];
    host.hidden = !sections.length;
    renderSections(host, sections, 'inspector', {
      node, selection: context.selection || [], project: context.project, workflow: context.workflow,
    });
  }

  function renderAll() {
    renderSidebarItems();
    renderToolbar();
    const route = typeof app === 'undefined' ? null : app.route;
    if (route && typeof renderSidebar === 'function') renderSidebar();
    if (route?.page === 'home') render().catch(fail);
    else if (route?.page === 'ext' && typeof render === 'function') render().catch(fail);
  }

  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-ext-command]');
    if (!button) return;
    event.preventDefault();
    let args = [];
    try {
      const parsed = JSON.parse(button.dataset.extArgs || '[]');
      if (Array.isArray(parsed)) args = parsed.slice(0, 20);
    } catch {}
    execute(button.dataset.extCommand, ...args).catch(() => {});
  });

  const publicCommand = command => ({
    key: command.key,
    id: command.id,
    title: command.title,
    icon: command.icon,
    plugin: command.plugin,
    pluginTitle: pluginTitle(command.plugin),
  });

  return {
    sync,
    reload,
    install,
    update,
    uninstall,
    disable,
    enable,
    recover,
    deploy,
    deploymentPlan,
    deploymentOf,
    renderSidebar: renderSidebarItems,
    renderToolbar,
    renderHome,
    renderSettings,
    renderInspector,
    render: renderAll,
    sanitize: sanitizeHTML,
    page: findPage,
    pagesOf,
    pageHref,
    sectionTitle: section => (section.startsWith('ext:') ? pluginTitle(section.slice(4)) : 'Navigation'),
    sectionOf: route => (route?.page === 'ext' ? 'ext:' + route.plugin : null),
    destinations: () =>
      views.pages().map(page => ({
        label: page.title,
        hint: `Plugin · ${pluginTitle(page.plugin)}`,
        href: pageHref(page.plugin, page.id),
      })),
    commands: () => [...commands.values()].sort((a, b) => a.title.localeCompare(b.title)).map(publicCommand),
    /** Host diagnostics for bounded lifecycle tests; no credentials or plugin data. Not exposed to iframes. */
    diagnostics: () => ({
      sandboxes: loaded.size,
      pendingCallbacks: [...loaded.values()].reduce((sum, entry) => sum + entry.pending.size, 0),
      pendingRequests: [...loaded.values()].reduce((sum, entry) => sum + (entry.inFlight || 0), 0),
      commands: commands.size,
      contributions: sidebarItems.length + toolbarButtons.length + menuContributions.length +
        ['page', 'library', 'home', 'settings', 'inspector', 'resource'].reduce((sum, kind) => sum + views.list(kind).length, 0),
    }),
    execute,
    /** Plugin entries for a named menu; the menu infrastructure adds them after the application's own items. */
    menuItems(spec, args = []) {
      return menuContributions
        .filter(item => item.menu === spec)
        .sort(byOrder)
        .map(item => [
          item.label,
          () => execute(`${item.plugin}:${item.command}`, ...(Array.isArray(args) ? args : [args])),
          {icon: item.icon || undefined, disabled: !commands.has(`${item.plugin}:${item.command}`)},
        ]);
    },
    hasMenu: spec => menuContributions.some(item => item.menu === spec),
    errorOf: id => errors.get(id) || '',
    isFailed: id => errors.has(id),
    apiOf: id => loaded.get(id)?.api() || null,
    /** The Library sections client plugins registered, for the Library page and its navigation. */
    librarySections: () => views.list('library'),
    resourceViews: () => views.list('resource'),
    settingsSections: () => views.list('settings').map(item => ({...item})),
    inspectorSections: () => views.list('inspector').map(item => ({...item})),
    describe(id) {
      return {
        error: errors.get(id) || '',
        failed: errors.has(id),
        pages: pagesOf(id).map(page => ({id: page.id, title: page.title, icon: page.icon, href: pageHref(id, page.id)})),
        sidebar: [...sidebarItems, ...views.sidebar()].filter(item => item.plugin === id).map(item => item.title),
        toolbar: toolbarButtons.filter(item => item.plugin === id).map(item => item.title),
        menu: menuContributions.filter(item => item.plugin === id).map(item => `${item.menu}: ${item.label}`),
        home: views.list('home', id).map(item => item.title),
        commands: [...commands.values()].filter(item => item.plugin === id).map(item => item.title),
        settings: views.list('settings', id).map(item => item.title),
        library: views.list('library', id).map(item => item.title),
        inspector: views.list('inspector', id).map(item => item.title),
        views: views.list('resource', id).map(item => item.title),
        styles: (styleNodes.get(id) || []).length,
      };
    },
  };
})();
