// Package contracts, permission decisions and resource deployment share these pure utilities.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
    isObject(value) ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' :
    JSON.stringify(value === undefined ? null : value);
  const fnv1a = text => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return 'fnv1a-' + hash.toString(16).padStart(8, '0');
  };

  const PluginCapabilities = (() => {
// A plugin that declares nothing gets read-only access to the ordinary data.
  const READ_ONLY = ['graph.read', 'library.read', 'collections.read', 'run.read', 'notifications.read', 'settings.read'];
  const PATTERN =
    /^(graph\.(read|write)|library\.(read|write)|collections\.(read|write)|run\.(read|start)|notifications\.(read|write)|settings\.(read|write)|net\.fetch:[A-Za-z0-9.*:\[\]-]+|secrets\.use:[A-Za-z0-9_-]+)$/;
  const MAX = 50;

  /** Validates and de-duplicates a capability list. Throws with a message a person can act on. */
  function normalize(list) {
    if (list === undefined || list === null) return READ_ONLY.slice();
    if (!Array.isArray(list)) throw new Error('capabilities must be a list');
    if (list.length > MAX) throw new Error(`A plugin declares at most ${MAX} capabilities`);
    if (!list.length) return READ_ONLY.slice(); // an explicit empty list means the same as no declaration
    const out = [];
    for (const value of list) {
      if (typeof value !== 'string' || !PATTERN.test(value))
        throw new Error(`Unknown plugin capability: ${String(value).slice(0, 80)}`);
      if (!out.includes(value)) out.push(value);
    }
    return out;
  }

  /** The capabilities of a stored plugin package (older packages declared nothing: they are read-only). */
  const forPlugin = plugin => {
    try {
      return normalize(plugin?.capabilities);
    } catch {
      return READ_ONLY.slice();
    }
  };

  /** A capability is exact, or a glob where `*` stands for any run of characters (`net.fetch:*.example.com`). */
  const matches = (grant, need) => {
    if (grant === need) return true;
    if (!grant.includes('*')) return false;
    const pattern = grant.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + pattern + '$').test(need);
  };
  const allows = (capabilities, need) => (Array.isArray(capabilities) ? capabilities : []).some(grant => typeof grant === 'string' && matches(grant, need));

  /**
   * The capability one API call needs: `{capability}` (null for a public read), `{denied}` for a call no plugin may
   * make, or `{needs: [...]}` for a call whose needs depend on its body (net, secrets).
   */
  function classify(method, path, body) {
    const clean = String(path || '').replace(/^\/+/, '').replace(/^api\//, '').replace(/\/+$/, '');
    const parts = clean ? clean.split('/') : [];
    const top = parts[0] || '';
    const read = ['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase());
    if (!clean || top === 'meta' || top === 'diagnostics' || top === 'openapi.json' || top === 'session')
      return {capability: null};
    if (top === 'auth') return {denied: 'A client plugin cannot use authentication endpoints'};
    if (top === 'net') {
      let host = '';
      try {
        host = new URL(body?.url).host;
      } catch {
        return {denied: 'A network request needs an absolute http(s) url'};
      }
      if (!host) return {denied: 'A network request needs an absolute http(s) url'};
      const needs = ['net.fetch:' + host];
      for (const match of JSON.stringify(body ?? {}).matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g))
        needs.push('secrets.use:' + match[1]);
      return {needs};
    }
    if (top === 'secrets') {
      const name = parts[1] || '';
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(name)) return {denied: 'A secret name is required'};
      return {needs: ['secrets.use:' + name]};
    }
    if (top === 'settings')
      return {needs: [read ? 'settings.read' : 'settings.write']};
    if (top === 'collections') return {needs: [read ? 'collections.read' : 'collections.write']};
    if (top === 'notifications') return {needs: [read ? 'notifications.read' : 'notifications.write']};
    if (top === 'library' || top === 'resources' || top === 'node-folders')
      return {needs: [read ? 'library.read' : 'library.write']};
    if (top === 'search' || top === 'node-hooks' || top === 'project-defaults' || top === 'exchange')
      return {needs: [read ? 'graph.read' : 'graph.write']};
    if (top === 'projects') {
      let projectId;
      try { projectId = decodeURIComponent(parts[1] || ''); }
      catch { return {denied: 'Invalid API path escape'}; }
      if (!read && projectId.startsWith('lib-')) return {needs: ['graph.write', 'library.write']};
      if (parts.includes('execution')) return {needs: [read ? 'run.read' : 'run.start']};
      if (parts.includes('batch') || parts.length > 2) return {needs: [read ? 'graph.read' : 'graph.write']};
      return {needs: [read ? 'graph.read' : 'graph.write']};
    }
    return {denied: `The client plugin API does not expose "${clean.split('/').slice(0, 3).join('/')}"`};
  }

  /** `{ok: true}` or `{ok: false, reason, needs}`. */
  function check(capabilities, method, path, body) {
    const plan = classify(method, path, body);
    if (plan.denied) return {ok: false, reason: plan.denied, needs: []};
    const needs = plan.needs ?? (plan.capability ? [plan.capability] : []);
    const missing = needs.filter(need => !allows(capabilities, need));
    if (missing.length)
      return {
        ok: false,
        needs: missing,
        reason:
          `This plugin is not allowed to ${String(method || 'GET').toUpperCase()} ${String(path || '').replace(/^\/+/, '')}: ` +
          `it needs ${missing.join(', ')}. Its package declares: ${capabilities.length ? capabilities.join(', ') : 'nothing'}.`,
      };
    return {ok: true, needs};
  }

  /** The capabilities a package should carry after an install: explicit, or the read-only default. */
  const fromPackage = pkg => {
    try {
      return normalize(pkg?.capabilities);
    } catch {
      return null;
    }
  };

  return {
    READ_ONLY,
    PATTERN,
    MAX,
    normalize,
    forPlugin,
    allows,
    classify,
    check,
    fromPackage,
    /** A one-line summary for the interface. */
    describe: list => (list && list.length ? list.join(', ') : 'read-only'),
  };
  })();

  const PluginManifest = (() => {
const API_VERSION = 1; // the plugin API this client implements
  const FORMAT_VERSION = 1; // the only supported package format
  const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
  const ICON = /^[a-z][a-z0-9-]{0,39}$/;
  const MAX_FILES = 64;
  const MAX_FILE = 400000;
  const MAX_TOTAL = 900000;
  const MAX_ASSETS = 24;
  const MAX_ASSET = 200000;
  const MAX_CAPABILITIES = 50;
  const MAX_DEPENDENCIES = 20;
  const MAX_LIBRARY = 50;
  const MAX_WORKFLOWS = 20;
  const MAX_COLLECTIONS = 20;
  const ASSET_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

  const fail = (message, code = 'invalid_request') => {
    const error = new Error(message);
    error.code = code;
    return error;
  };

  // ----- files and package fields -----
  const safePath = value => {
    const text = String(value ?? '');
    if (!text || text.length > 200 || text.includes('\\') || text.startsWith('/') || /^[A-Za-z]:/.test(text))
      throw fail('A package file path must be relative and use "/": ' + text.slice(0, 80));
    if (!/^[A-Za-z0-9._/-]+$/.test(text) || text.split('/').some(part => !part || part === '.' || part === '..' || RESERVED.has(part)))
      throw fail('A package file path is not safe: ' + text.slice(0, 80));
    return text;
  };
  const safeKey = value => {
    const text = String(value ?? '');
    if (!text || text.length > 100 || !/^[A-Za-z0-9._/-]+$/.test(text) || RESERVED.has(text))
      throw fail('A package key is not valid: ' + text.slice(0, 80));
    return text;
  };
  function normalizeAssets(value) {
    if (value === undefined) return {};
    if (!isObject(value)) throw fail('assets must be an object of images');
    const keys = Object.keys(value);
    if (keys.length > MAX_ASSETS) throw fail(`A package has at most ${MAX_ASSETS} assets`);
    const out = {};
    for (const key of keys) {
      const name = safeKey(key),
        asset = value[key];
      let uri;
      if (typeof asset === 'string') uri = asset;
      else if (isObject(asset) && typeof asset.data === 'string') {
        const type = String(asset.type || 'image/png').toLowerCase();
        if (!ASSET_TYPES.has(type)) throw fail('An asset must be a PNG, JPEG, GIF or WebP image');
        uri = `data:${type};base64,${asset.data}`;
      } else throw fail('An asset is a data URI or {type, data}');
      if (uri.length > MAX_ASSET) throw fail('An asset is too large (200 KB maximum)');
      if (!/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(uri))
        throw fail('An asset must be a base64 PNG, JPEG, GIF or WebP data URI');
      out[name] = uri;
    }
    return out;
  }
  function normalizeCapabilities(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw fail('capabilities must be a list');
    if (value.length > MAX_CAPABILITIES) throw fail(`A plugin declares at most ${MAX_CAPABILITIES} capabilities`);
    if (value.some(item => typeof item !== 'string' || !item || item.length > 120))
      throw fail('Every capability must be a short string');
    return [...new Set(value)];
  }
  function normalizeDependencies(value = []) {
    if (!Array.isArray(value) || value.length > MAX_DEPENDENCIES || value.some(id => typeof id !== 'string' || !ID.test(id)))
      throw fail('dependencies must be a list of plugin IDs');
    return [...new Set(value)];
  }
  function normalizeContributes(value) {
    if (value === undefined) return {collections: [], library: [], workflows: []};
    if (!isObject(value)) throw fail('contributes must be an object');
    const collections = value.collections === undefined ? [] : value.collections;
    const library = value.library === undefined ? [] : value.library;
    const workflows = value.workflows === undefined ? [] : value.workflows;
    for (const [name, list, max] of [
      ['collections', collections, MAX_COLLECTIONS],
      ['library', library, MAX_LIBRARY],
      ['workflows', workflows, MAX_WORKFLOWS],
    ]) {
      if (!Array.isArray(list) || list.length > max) throw fail(`contributes.${name} must be a list of at most ${max}`);
    }
    const collectionNames = new Set();
    for (const item of collections) {
      if (!isObject(item) || !/^[a-z][a-z0-9-]{0,63}$/.test(String(item.name || '')))
        throw fail('A contributed collection needs a lower-case name');
      if (collectionNames.has(item.name)) throw fail('Two contributed collections share the name ' + item.name);
      collectionNames.add(item.name);
      if (item.schema !== undefined && !isObject(item.schema)) throw fail('A collection schema must be an object');
      if (JSON.stringify(item).length > 100000) throw fail('A contributed collection is too large');
    }
    const nodeNames = new Set();
    for (const item of library) {
      if (!isObject(item) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100)
        throw fail('A contributed Library node needs a name of 1 to 100 characters');
      if (nodeNames.has(item.name)) throw fail('Two contributed Library nodes share the name ' + item.name);
      nodeNames.add(item.name);
      if (typeof item.code !== 'string' || !item.code.trim() || item.code.length > 200000)
        throw fail('A contributed Library node needs Script code (up to 200000 characters)');
      for (const key of ['inputs', 'outputs'])
        if (item[key] !== undefined && (!Array.isArray(item[key]) || item[key].length > 64))
          throw fail(`A contributed node has at most 64 ${key}`);
      if (item.grants !== undefined && (!Array.isArray(item.grants) || item.grants.some(v => typeof v !== 'string')))
        throw fail('A contributed node grants must be a list of capability names');
    }
    for (const item of workflows) {
      if (!isObject(item) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100)
        throw fail('A contributed workflow needs a name of 1 to 100 characters');
      if (item.project !== undefined && (typeof item.project !== 'string' || !item.project.trim() || item.project.length > 100))
        throw fail('A contributed workflow project name has 1 to 100 characters');
      if (item.nodes !== undefined && (!Array.isArray(item.nodes) || item.nodes.length > 100))
        throw fail('A contributed workflow has at most 100 nodes');
      for (const node of item.nodes || []) {
        if (!isObject(node) || typeof node.library !== 'string' || !nodeNames.has(node.library))
          throw fail(`A workflow node must name a contributed Library node (${String(node?.library).slice(0, 80)})`);
      }
    }
    return {collections: clone(collections), library: clone(library), workflows: clone(workflows)};
  }

  /**
   * Reads a format 1 package or its normalized internal record into the record PluginStore keeps. Throws an actionable error on bad input.
   */
  function normalizePackage(value, {allowSource = true} = {}) {
    if (!isObject(value)) throw fail('A plugin package must be a JSON object.');
    const packet = value.format === FORMAT_VERSION;
    if ((value.format !== undefined && !packet) || (!packet && value.formatVersion !== FORMAT_VERSION))
      throw fail('Only plugin package format 1 is supported.', 'unsupported_contract');
    const manifest = packet ? value.manifest : value;
    if (!isObject(manifest)) throw fail('manifest must be an object');
    const id = String(manifest.id ?? value.id ?? '');
    if (!ID.test(id)) throw fail('Plugin id must be letters, digits, ".", "_" or "-" (at most 80).');
    const title = String(manifest.name ?? manifest.title ?? value.title ?? '').trim();
    if (!title || title.length > 120) throw fail('A plugin needs a name of 1 to 120 characters.');
    const version = String(manifest.version ?? value.version ?? '0.1.0');
    const api = Number(manifest.api ?? value.api);
    if (api !== API_VERSION) throw fail('Plugin API 1 is required.', 'unsupported_contract');
    const dependencies = normalizeDependencies(manifest.dependencies ?? value.dependencies);
    if (dependencies.includes(id)) throw fail('A plugin cannot depend on itself');

    const main = safePath(value.main || 'main.js');
    const files = {};
    if (value.files !== undefined && !isObject(value.files)) throw fail('files must be an object of path to text');
    const entries = Object.entries(value.files || {});
    if (entries.length > MAX_FILES) throw fail(`A package has at most ${MAX_FILES} files`);
    let total = 0;
    for (const [path, text] of entries) {
      const clean = safePath(path);
      if (!/\.(?:js|json)$/i.test(clean)) throw fail('A package file must be JavaScript or JSON: ' + clean);
      if (typeof text !== 'string') throw fail('A package file must be text: ' + clean);
      if (text.length > MAX_FILE) throw fail('A package file is too large: ' + clean);
      total += text.length;
      if (total > MAX_TOTAL) throw fail('The plugin package is too large (900 KB maximum)');
      if (RESERVED.has(clean)) throw fail('A package file name is reserved: ' + clean);
      files[clean] = text;
    }
    const sourceText = packet ? files[main] : value.source;
    if (typeof sourceText !== 'string') throw fail('The package main file "' + main + '" is missing from files.');
    let source = sourceText;
    delete files[main];
    if (allowSource) {
      if (typeof source !== 'string' || !source.trim()) throw fail('A plugin needs JavaScript source.');
      if (source.length > MAX_FILE) throw fail('The plugin source is too large (400 KB maximum).');
      if (!/\bactivate\b/.test(source)) throw fail('The plugin source must export activate(api).');
    } else source = typeof source === 'string' ? source : '';
    const assetMap = normalizeAssets(value.assets);
    const contributes = normalizeContributes(value.contributes ?? manifest.contributes);
    const icon = ICON.test(String(manifest.icon || '')) ? String(manifest.icon) : 'plug';

    return {
      formatVersion: FORMAT_VERSION,
      id,
      title,
      name: title,
      description: String(manifest.description ?? value.description ?? '').slice(0, 2000),
      icon,
      version,
      api,
      dependencies,
      capabilities: normalizeCapabilities(manifest.capabilities ?? value.capabilities),
      author: String(manifest.author ?? value.author ?? '').slice(0, 120),
      license: String(manifest.license ?? value.license ?? '').slice(0, 60),
      homepage: String(manifest.homepage ?? value.homepage ?? '').slice(0, 300),
      main,
      source,
      files,
      assets: assetMap,
      contributes,
      // These are set by the store, not by a package.
      enabled: value.enabled !== false,
      origin: String(value.origin || 'installed').slice(0, 80),
      installedAt: Number(value.installedAt) || 0,
      updatedAt: Number(value.updatedAt) || 0,
      activatedChecksum: String(value.activatedChecksum || ''),
      checksum: String(value.checksum || ''),
    };
  }

  /** The dependency state of one plugin against the packages installed beside it. */
  function checkDependencies(plugin, plugins, {requireEnabled = false} = {}) {
    const list = (plugins || []).filter(item => item && item.id);
    const byId = new Map(list.map(item => [item.id, item]));
    const errors = [];
    for (const id of plugin?.dependencies || []) {
      const found = byId.get(id);
      if (!found) {
        errors.push({code: 'missing_dependency', id, message: `Needs the plugin "${id}".`});
        continue;
      }
      if (requireEnabled && found.enabled === false)
        errors.push({code: 'disabled_dependency', id, message: `The plugin "${id}" it needs is turned off.`});
    }
    return {ok: !errors.length, errors};
  }

  /**
   * Activation order: dependencies first, remaining plugins by id. Cycles and missing dependencies are reported
   * rather than silently activated in an arbitrary order.
   */
  function activationOrder(plugins) {
    const list = (plugins || []).filter(item => item && item.id);
    const byId = new Map(list.map(item => [item.id, item]));
    const state = new Map(),
      order = [],
      errors = [];
    const visit = (plugin, trail) => {
      if (state.get(plugin.id) === 'done') return;
      if (state.get(plugin.id) === 'visiting') {
        errors.push({code: 'dependency_cycle', id: plugin.id, message: `Dependency cycle: ${[...trail, plugin.id].join(' → ')}`});
        return;
      }
      state.set(plugin.id, 'visiting');
      for (const id of plugin.dependencies || []) {
        const next = byId.get(id);
        if (!next) {
          errors.push({code: 'missing_dependency', id: plugin.id, message: `Needs the plugin "${id}", which is not installed.`});
          continue;
        }
        visit(next, [...trail, plugin.id]);
      }
      state.set(plugin.id, 'done');
      order.push(plugin);
    };
    for (const plugin of [...list].sort((a, b) => a.id.localeCompare(b.id))) visit(plugin, []);
    return {order, errors};
  }

  /** A deterministic, non-cryptographic checksum for change detection and package identity. */
  function fingerprint(record) {
    const text = JSON.stringify([
      record.id,
      record.version,
      record.main,
      record.source,
      Object.keys(record.files || {}).sort().map(key => [key, record.files[key]]),
      record.assets || {},
      record.contributes || {},
      record.capabilities || [],
      record.dependencies || [],
    ]);
    return fnv1a(text);
  }

  /** The distributable form: format 1, the main file inside files, and the checksum. */
  function exportPackage(record) {
    const clean = normalizePackage(record, {allowSource: true});
    const files = {...clean.files, [clean.main]: clean.source};
    return {
      format: FORMAT_VERSION,
      manifest: {
        id: clean.id,
        name: clean.title,
        version: clean.version,
        description: clean.description,
        icon: clean.icon,
        api: clean.api,
        capabilities: clean.capabilities || [],
        dependencies: clean.dependencies,
        author: clean.author,
        license: clean.license,
        homepage: clean.homepage,
      },
      main: clean.main,
      files,
      assets: clean.assets,
      contributes: clean.contributes,
      checksum: fingerprint(clean),
    };
  }

  /** Validates the current stored record; private plugin data belongs to its lifecycle hooks. */
  function readRecord(value) {
    if (!isObject(value) || value.formatVersion !== FORMAT_VERSION)
      throw fail('Only stored plugin format 1 is supported.', 'unsupported_contract');
    const record = normalizePackage(value);
    return {...record, checksum: value.checksum || fingerprint(record)};
  }

  return {
    API_VERSION,
    FORMAT_VERSION,
    ID,
    MAX_FILES,
    MAX_FILE,
    MAX_TOTAL,
    MAX_ASSETS,
    MAX_ASSET,
    MAX_CAPABILITIES,
    MAX_DEPENDENCIES,
    safePath,
    normalizePackage,
    normalizeAssets,
    normalizeCapabilities,
    normalizeDependencies,
    normalizeContributes,
    checkDependencies,
    activationOrder,
    fingerprint,
    exportPackage,
    readRecord,
  };
  })();

  const PluginDeploy = (() => {
const STATE_VERSION = 1;

  const checksum = value => fnv1a(canonical(value));
  const librarySpec = node => ({
    name: node.name, code: String(node.code || ''),
    inputs: Array.isArray(node.inputs) ? node.inputs : [], outputs: Array.isArray(node.outputs) ? node.outputs : [],
    grants: Array.isArray(node.grants) ? node.grants : ['graph.read'],
    description: String(node.description || '').slice(0, 2000), folder: String(node.folder || '').slice(0, 200), icon: node.icon,
  });

  const freshState = (pluginId, environment = 'local') => ({
    version: STATE_VERSION,
    plugin: pluginId,
    environment,
    deployedAt: 0,
    collections: {},
    library: {},
    workflows: {},
  });
  function readState(value, pluginId, environment = 'local') {
    const base = freshState(pluginId, environment);
    if (!isObject(value)) return base;
    const copy = object => (isObject(object) ? JSON.parse(JSON.stringify(object)) : {});
    return {
      ...base,
      ...value,
      plugin: pluginId,
      environment: environment || value.environment || 'local',
      collections: copy(value.collections),
      library: copy(value.library),
      workflows: copy(value.workflows),
    };
  }
  const error = (code, message, extra = {}) => ({code, message, ...extra});
  /** Read-only preview. Every mutation is checked again during deployment; this is not a transaction. */
  async function plan(record, {request, force = false} = {}) {
    const contributes = record.contributes || {}, actions = [], permissions = new Set();
    const collections = (contributes.collections || []).length ? await request('GET', 'collections') : [];
    const resources = (contributes.library || []).length ? await request('GET', 'resources') : [];
    const projects = (contributes.workflows || []).length ? await request('GET', 'projects') : [];
    for (const definition of contributes.collections || []) {
      permissions.add('collections.read'); permissions.add('collections.write');
      const existing = collections.find(item => item.name === definition.name);
      const same = existing && checksum({title: existing.title, description: existing.description || '', schema: existing.schema}) ===
        checksum({title: definition.title || definition.name, description: definition.description || '', schema: definition.schema || {type: 'object'}});
      actions.push({kind: 'collection', name: definition.name, action: !existing ? 'create' : same || (!force && definition.strategy !== 'update') ? 'skip' : 'update'});
    }
    for (const node of contributes.library || []) {
      permissions.add('library.read'); permissions.add('library.write');
      const existing = resources.find(item => item.payload?.plugin?.id === record.id && item.payload.plugin.name === node.name) || resources.find(item => item.name === node.name);
      let action = 'create', reason = '';
      if (existing) {
        if (existing.payload?.plugin?.id !== record.id) { action = 'conflict'; reason = 'Existing resource belongs to another owner.'; }
        else if (!existing.payload.plugin.contentChecksum || checksum({...existing.payload, plugin: undefined}) !== existing.payload.plugin.contentChecksum) {
          action = 'conflict'; reason = 'Resource was edited after deployment.';
        }
        else {
          const wanted = {...librarySpec(node), plugin: undefined};
          action = existing.payload.plugin.checksum === checksum(wanted) ? 'skip' : 'update';
        }
      }
      actions.push({kind: 'library', name: node.name, action, reason});
    }
    for (const template of contributes.workflows || []) {
      permissions.add('graph.read'); permissions.add('graph.write');
      const tag = `Deployed by the AgentSys plugin ${record.id} · ${template.name}`;
      const existing = projects.find(item => item.description === tag || item.name === (template.project || `${record.title} templates`));
      actions.push({kind: 'workflow', name: template.name, action: existing ? 'inspect' : 'create', reason: existing ? 'Existing workflow is preserved; only missing template elements may be created.' : ''});
    }
    return {actions, permissions: [...permissions], atomic: false, conflicts: actions.filter(item => item.action === 'conflict')};
  }

  /**
   * Deploys (or re-deploys) one plugin's declared resources. Idempotent: the same content makes no duplicates, and
   * redeploying after a switch recreates only what the current server lacks. User edits to data are preserved.
   *
   * @param record   a normalized plugin record (PluginManifest)
   * @param request  (method, path, body, query) => Promise<json> on the active environment
   * @param state    the deployment record for this plugin and environment (PluginDeploy.freshState)
   * @param environment  the environment id the record belongs to
   * @param force    update a collection definition even when its strategy is "create"
   * @param log      (message) => void
   */
  async function deploy(record, {request, state, environment = 'local', force = false, log = () => {}} = {}) {
    if (!record || !record.id) throw new TypeError('A plugin record is required');
    if (typeof request !== 'function') throw new TypeError('A request function is required');
    const next = readState(state, record.id, environment);
    const errors = [];
    const warnings = [];
    const summary = {collections: 0, library: 0, workflows: 0, nodes: 0, created: 0, updated: 0, skipped: 0};
    const contributes = record.contributes || {collections: [], library: [], workflows: []};
    const attempt = async (kind, name, work) => {
      try {
        const answer = await work();
        if (answer?.warning) warnings.push(error('warning', answer.warning, {kind, name}));
        return answer;
      } catch (failure) {
        errors.push(error(failure.code || 'deploy_failed', `${kind} "${name}": ${failure.message}`, {kind, name}));
        return null;
      }
    };

    // ----- collections: definitions are updated in place; records are never deleted or rewritten -----
    for (const definition of contributes.collections || []) {
      await attempt('collection', definition.name, async () => {
        const existing = (await request('GET', 'collections')).find(item => item.name === definition.name);
        const wanted = {
          title: String(definition.title || definition.name).slice(0, 120),
          description: String(definition.description || '').slice(0, 2000),
          schema: definition.schema || {type: 'object'},
        };
        const mark = checksum(wanted);
        const previous = next.collections[definition.name];
        if (existing) {
          const same = checksum({title: existing.title, description: existing.description || '', schema: existing.schema}) === mark;
          if (same) {
            next.collections[definition.name] = {...previous, checksum: mark, mode: definition.strategy || 'create'};
            summary.skipped++;
            return;
          }
          if ((definition.strategy || 'create') !== 'update' && !force) {
            warnings.push(
              error(
                'collection_exists',
                `The collection "${definition.name}" already exists with another definition; its records were kept. Set "strategy": "update" in the package to change it.`,
                {kind: 'collection', name: definition.name}
              )
            );
            next.collections[definition.name] = {...previous, checksum: mark, mode: 'create'};
            summary.skipped++;
            return;
          }
          await request('PUT', 'collections/' + encodeURIComponent(definition.name), wanted);
          summary.updated++;
        } else {
          await request('PUT', 'collections/' + encodeURIComponent(definition.name), wanted);
          summary.created++;
        }
        next.collections[definition.name] = {
          checksum: mark,
          mode: definition.strategy || 'create',
          deployedAt: Date.now(),
        };
        summary.collections++;
      });
    }

    // ----- Library nodes: ordinary Script-backed Custom Nodes, tagged with their owner -----
    const resourceNames = new Map();
    for (const node of contributes.library || []) {
      await attempt('library node', node.name, async () => {
        const wanted = {...librarySpec(node), plugin: {id: record.id, name: node.name, version: record.version, checksum: ''}};
        const mark = checksum({...wanted, plugin: undefined});
        wanted.plugin.checksum = mark;
        const resources = await request('GET', 'resources');
        const owned = resources.filter(
          item => item.payload?.plugin?.id === record.id && item.payload?.plugin?.name === node.name
        );
        let existing = (next.library[node.name]?.id && resources.find(item => item.id === next.library[node.name].id)) || owned[0];
        if (!existing && node.adopt === true) existing = resources.find(item => item.name === node.name);
        if (existing && existing.payload?.plugin && existing.payload.plugin.id !== record.id)
          throw Object.assign(new Error(`“${existing.name}” belongs to the plugin "${existing.payload.plugin.id}"`), {
            code: 'resource_conflict',
          });
        if (existing && !existing.payload?.plugin?.contentChecksum)
          throw Object.assign(new Error(`“${existing.name}” has no deployment edit baseline; back it up and explicitly redeploy it.`), {code: 'resource_conflict'});
        if (existing?.payload?.plugin?.contentChecksum &&
            checksum({...existing.payload, plugin: undefined}) !== existing.payload.plugin.contentChecksum)
          throw Object.assign(new Error(`“${existing.name}” was edited after deployment; it was kept.`), {code: 'resource_conflict'});
        let saved;
        if (!existing) {
          saved = await request('POST', 'library/script-nodes', wanted);
          summary.created++;
        } else {
          const previous = existing.payload?.plugin?.checksum;
          if (previous === mark) {
            next.library[node.name] = {...next.library[node.name], id: existing.id, checksum: mark, version: record.version};
            resourceNames.set(node.name, existing.id);
            summary.skipped++;
            return;
          }
          saved = await request('POST', 'library/script-nodes', {...wanted, resource_id: existing.id});
          summary.updated++;
        }
        if (!saved?.id) throw new Error('The server did not return the Library node');
        next.library[node.name] = {
          id: saved.id,
          checksum: mark,
          version: record.version,
          folder: wanted.folder,
          deployedAt: Date.now(),
        };
        resourceNames.set(node.name, saved.id);
        summary.library++;
        summary.nodes++;
      });
    }
    // Contributions placed earlier in this deployment are usable by a workflow even if their step failed.
    for (const [name, entry] of Object.entries(next.library)) if (entry?.id) resourceNames.set(name, entry.id);

    // ----- workflow templates: a project, a workflow, its Library nodes, and a run trigger -----
    for (const template of contributes.workflows || []) {
      await attempt('workflow template', template.name, async () => {
        const key = template.name;
        const projectTitle = String(template.project || `${record.title} templates`).slice(0, 100);
        const tag = `Deployed by the AgentSys plugin ${record.id} · ${key}`;
        const projects = await request('GET', 'projects');
        let previous = next.workflows[key] || {};
        let project = (previous.project_id && projects.find(item => item.id === previous.project_id)) || null;
        if (!project) {
          project = projects.find(item => item.description === tag) || null;
          if (!project) {
            const exact = projects.find(item => item.name === projectTitle);
            if (exact) {
              project = exact;
              warnings.push(
                error('project_adopted', `The workflow template uses the existing project “${projectTitle}”.`, {
                  kind: 'workflow',
                  name: key,
                })
              );
            }
          }
        }
        if (!project) {
          const made = await request('POST', 'projects', {name: projectTitle});
          await request('PUT', `projects/${made.id}`, {name: projectTitle, description: tag});
          project = {id: made.id, name: projectTitle, description: tag};
          summary.created++;
        } else if (!String(project.description || '').includes(tag)) {
          const info = await request('GET', `projects/${project.id}`);
          await request('PUT', `projects/${project.id}`, {
            name: info.project.name,
            description: info.project.description || tag,
          });
        }
        let workflow = (previous.workflow_id && (await request('GET', `projects/${project.id}`)).workflows.find(w => w.id === previous.workflow_id)) || null;
        if (!workflow) {
          const info = await request('GET', `projects/${project.id}`);
          workflow = info.workflows.find(item => item.name === template.name) || null;
          if (!workflow) {
            const made = await request('POST', `projects/${project.id}/workflows`, {name: template.name});
            workflow = {id: made.id, name: template.name};
            summary.created++;
          }
        }
        const graph = await request('GET', `projects/${project.id}/workflow`, undefined, {workflow_id: workflow.id});
        if (previous.workflow_id === workflow.id && previous.checksum) {
          summary.skipped++;
          if (previous.checksum !== checksum({nodes: template.nodes || [], run: template.run !== false}))
            warnings.push(error('workflow_preserved', `Workflow "${key}" already exists; package changes were not applied to the user's graph.`, {kind: 'workflow', name: key}));
          return;
        }
        const placed = {};
        const siblings = (template.nodes || []).filter(node => node.library !== undefined);
        let offset = 0;
        for (const node of siblings) {
          const resourceId = resourceNames.get(node.library);
          if (!resourceId) {
            errors.push(
              error('missing_library', `Workflow "${key}" names the Library node "${node.library}", which this package does not contribute.`, {
                kind: 'workflow',
                name: key,
              })
            );
            continue;
          }
          let existing = (graph.complex || []).find(complex => complex.source?.resource_id === resourceId);
          if (!existing) {
            const made = await request('POST', `projects/${project.id}/custom-nodes/${resourceId}`, {
              point: node.point || {x: 0, y: offset * 260},
            }, {workflow_id: workflow.id});
            offset++;
            const group = made?.roots?.[0];
            existing = group ? {id: group} : null;
            // A placement returns the new group id; `${complex:}` is the node id the canvas and wires use.
            if (existing) (graph.complex || (graph.complex = [])).push({id: existing.id, source: {resource_id: resourceId}});
          }
          if (existing) placed[node.library] = 'complex:' + existing.id;
        }
        // A trigger makes the template runnable as saved. The Event is a native primitive, not plugin code.
        if (template.run !== false) {
          const snapshot = await request('GET', `projects/${project.id}/workflow`, undefined, {workflow_id: workflow.id});
          let event =
            (previous.event_id && snapshot.nodes.find(node => node.id === previous.event_id)) ||
            snapshot.nodes.find(node => node.node_type === 'custom' && node.config?.op === 'on_run') ||
            null;
          if (!event) {
            const made = await request('POST', `projects/${project.id}/primitives`, {
              primitive: 'event',
              point: {x: -360, y: 0},
            }, {workflow_id: workflow.id});
            event = {id: made.id};
            summary.created++;
          }
          const connections = [...snapshot.edges];
          for (const nodeId of Object.values(placed)) {
            const wired = connections.some(edge => edge.source === event.id && edge.target === nodeId);
            if (wired) continue;
            await request('POST', `projects/${project.id}/port-connections`, {
              add: [{source: event.id, source_port: 'out', target: nodeId, target_port: 'in'}],
            }, {workflow_id: workflow.id});
          }
          previous = {...previous, event_id: event.id};
        }
        next.workflows[key] = {
          ...previous,
          project_id: project.id,
          workflow_id: workflow.id,
          nodes: placed,
          checksum: checksum({nodes: template.nodes || [], run: template.run !== false}),
          deployedAt: Date.now(),
        };
        summary.workflows++;
      });
    }

    next.version = STATE_VERSION;
    next.deployedAt = Date.now();
    next.pluginVersion = record.version;
    if (errors.length) log(`${record.id}: ${errors.length} deployment problem(s)`);
    return {ok: errors.length === 0, errors, warnings, state: next, summary};
  }

  /** What the record says was deployed here, for the plugin page. It contacts no server. */
  function status(record, state) {
    const clean = readState(state, record?.id, state?.environment);
    const counts = {
      collections: Object.keys(clean.collections).length,
      library: Object.keys(clean.library).length,
      workflows: Object.keys(clean.workflows).length,
    };
    return {
      deployed: !!(counts.collections || counts.library || counts.workflows),
      deployedAt: clean.deployedAt || 0,
      pluginVersion: clean.pluginVersion || '',
      environment: clean.environment,
      counts,
    };
  }

  /** Drops the local record of a deployment. Server resources stay: deleting user data is never implicit. */
  function forget(pluginId, environment = 'local') {
    return freshState(pluginId, environment);
  }

  return {STATE_VERSION, canonical, checksum, freshState, readState, plan, deploy, status, forget};
  })();

  return {PluginCapabilities, PluginManifest, PluginDeploy};
});
