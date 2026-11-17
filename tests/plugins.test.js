'use strict';
const {describe} = require('node:test');

describe('resource deployment', () => {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const {PluginManifest, PluginDeploy} = require('../js/plugins');
  test('Library deployment retains the verified owner and content identity', async () => {
    const record = PluginManifest.normalizePackage({formatVersion: 1, api: 1, id: 'owner', name: 'Owner',
      version: '0.1.0', source: 'exports.activate = () => {};',
      contributes: {library: [{name: 'Owned node', code: 'node.output.value = 1;'}]}});
    let created;
    const result = await PluginDeploy.deploy(record, {request: async (method, path, body) => {
      if (method === 'GET' && path === 'resources') return [];
      assert.equal(method, 'POST');
      assert.equal(path, 'library/script-nodes');
      created = body;
      return {id: 'saved-node'};
    }});
    assert.equal(result.ok, true);
    assert.equal(created.plugin.id, 'owner');
    assert.equal(created.plugin.name, 'Owned node');
    assert.equal(created.plugin.version, '0.1.0');
    assert.match(created.plugin.checksum, /^fnv1a-[a-f0-9]{8}$/);
    assert.equal(result.state.library['Owned node'].id, 'saved-node');
  });
});

describe("client-plugins", () => {
// Client plugin packages are validated and kept in this browser. The server has no plugin endpoint and no
// server-side plugin code.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');

function pluginStore(fetch = async () => ({ok: false, status: 404})) {
  const data = new Map();
  const localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(String(key), String(value)),
    removeItem: key => data.delete(key),
    get length() {
      return data.size;
    },
    key: index => [...data.keys()][index] ?? null,
  };
  const context = vm.createContext({
    console,
    localStorage,
    sessionStorage: {getItem: () => null, setItem() {}, removeItem() {}},
    crypto: globalThis.crypto,
    fetch,
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    TextDecoder,
  });
  context.self = context;
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js/model.js'), 'utf8'), context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'js/plugins.js'), 'utf8'),
    context
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'js/plugins.js'), 'utf8'),
    context
  );
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js/plugin-store.js'), 'utf8'), context);
  return vm.runInContext('PluginStore', context);
}

test('client plugin packages are validated: id, API version, source and size limits', async () => {
  const store = pluginStore();
  await store.load();
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(store.list()), []);
  assert.throws(
    () => store.install({api: 1, formatVersion: 1, id: '../evil', title: 'X', source: 'exports.activate = () => {};'}),
    error => error.code === 'invalid_request'
  );
  assert.throws(
    () => store.install({formatVersion: 1, id: 'x', title: 'X', api: 99, source: 'exports.activate = () => {};'}),
    error => error.code === 'unsupported_contract'
  );
  assert.throws(
    () => store.install({api: 1, formatVersion: 1, id: 'x', title: 'X', source: 'console.log(1)'}),
    error => error.code === 'invalid_request'
  );
  const plugin = store.install({
    api: 1,
    formatVersion: 1,
    id: 'hello',
    title: 'Hello',
    version: '1.2.3',
    description: 'demo',
    source: 'exports.activate = api => { api.ui.addPage({id: "p", render: () => "hi"}); };',
  });
  assert.equal(plugin.id, 'hello');
  assert.equal(store.list().length, 1);
  // A package that declares no capabilities is read-only; writes must be named.
  assert.deepEqual([...plugin.capabilities].sort(), ['collections.read', 'graph.read', 'library.read', 'notifications.read', 'run.read', 'settings.read']);
  assert.deepEqual(
    [...store.install({api: 1, formatVersion: 1, id: 'writer', title: 'Writer', capabilities: ['library.read', 'library.write'], source: 'exports.activate = () => {};'}).capabilities],
    ['library.read', 'library.write']
  );
  assert.throws(
    () => store.install({api: 1, formatVersion: 1, id: 'writer2', title: 'Writer', capabilities: ['root'], source: 'exports.activate = () => {};'}),
    error => error.code === 'invalid_request' && /Unknown plugin capability/.test(error.message)
  );
  store.remove('writer');
  assert.equal(store.setEnabled('hello', false).enabled, false);
  assert.equal(store.get('hello').enabled, false);
  store.storage('hello').set('settings', {n: 1});
  assert.deepEqual(plain(store.storage('hello').get('settings')), {n: 1});
  store.clear('hello');
  assert.equal(store.storage('hello').get('settings'), null);
  store.remove('hello');
  assert.deepEqual(plain(store.list()), []);
});

test('loading installed plugins never fetches or auto-installs a catalog', async () => {
  let fetches = 0;
  const store = pluginStore(async () => { fetches++; return {ok: true, json: async () => []}; });
  await store.load();
  assert.equal(fetches, 0);
  assert.equal(store.list().length, 0);
});
});

describe("plugin-capabilities", () => {
// The client plugin capability layer: what a package may ask the server to do, and what a package without a
// declaration may do (read only). The rules live in js/plugins.js so the host and these tests agree.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const Capabilities = require('../js/plugins').PluginCapabilities;

const check = (caps, method, route, body) => Capabilities.check(caps, method, route, body);
const allowed = (caps, method, route, body) => check(caps, method, route, body).ok;
const WRITER = ['graph.read', 'graph.write', 'library.read', 'library.write'];

test('an undeclared plugin is read-only and cannot write anything', () => {
  const caps = Capabilities.forPlugin({id: 'x'});
  assert.deepEqual([...caps].sort(), [...Capabilities.READ_ONLY].sort());
  assert.equal(allowed(caps, 'GET', 'projects'), true);
  assert.equal(allowed(caps, 'GET', 'projects/p1/workflow'), true);
  assert.equal(allowed(caps, 'GET', 'library/sections'), true);
  assert.equal(allowed(caps, 'GET', 'collections/providers/records'), true);
  assert.equal(allowed(caps, 'GET', 'projects/p1/execution'), true);
  for (const [method, route] of [
    ['POST', 'projects'],
    ['PUT', 'projects/p1/workflow'],
    ['POST', 'projects/p1/execution'],
    ['POST', 'library/script-nodes'],
    ['PUT', 'collections/providers'],
    ['POST', 'notifications'],
    ['PUT', 'settings'],
  ]) {
    const decision = check(caps, method, route);
    assert.equal(decision.ok, false, `${method} ${route} is a write`);
    assert.match(decision.reason, /needs /);
    assert.ok(decision.needs.length);
  }
});

test('a declared capability allows exactly its family of calls', () => {
  assert.equal(allowed(['graph.write'], 'PUT', 'projects/%6cib-owned/input-values'), false);
  assert.equal(allowed(WRITER, 'PUT', 'projects/%6cib-owned/input-values'), true);
  assert.equal(allowed(WRITER, 'POST', 'library/script-nodes'), true);
  assert.equal(allowed(WRITER, 'POST', 'projects'), true);
  assert.equal(allowed(['collections.write'], 'POST', 'collections/providers/records', {data: {}}), true);
  assert.equal(allowed(['collections.write'], 'PUT', 'collections/providers'), true);
  assert.equal(allowed(['collections.read'], 'PUT', 'collections/providers'), false);
  assert.equal(allowed(['run.start'], 'POST', 'projects/p1/execution'), true);
  assert.equal(allowed(['run.start'], 'DELETE', 'projects/p1/execution'), true);
  assert.equal(allowed(['run.read'], 'POST', 'projects/p1/execution'), false);
  assert.equal(allowed(['notifications.write'], 'POST', 'notifications'), true);
  assert.equal(allowed(['notifications.read'], 'DELETE', 'notifications/n1'), false);
  assert.equal(allowed(['settings.write'], 'PUT', 'settings'), true);
  // A capability of one family never reaches another family.
  assert.equal(allowed(['library.write'], 'POST', 'projects'), false);
  assert.equal(allowed(['graph.write'], 'POST', 'library/script-nodes'), false);
});

test('secrets are named one by one; no wildcard secret capability exists', () => {
  assert.equal(allowed(['secrets.use:openai'], 'GET', 'secrets/openai'), true);
  assert.equal(allowed(['secrets.use:openai'], 'GET', 'secrets/anthropic'), false);
  assert.equal(allowed(['secrets.use:openai'], 'PUT', 'secrets/openai', {value: 'sk-x'}), true);
  assert.equal(allowed([], 'GET', 'secrets/openai'), false);
  assert.throws(() => Capabilities.normalize(['secrets.use:*']), /Unknown plugin capability/);
  assert.equal(allowed(Capabilities.forPlugin({id: 'x'}), 'GET', 'secrets/openai'), false);
});

test('net requests need the host they reach, and secrets they inject', () => {
  assert.equal(allowed(['net.fetch:api.example.com'], 'POST', 'net', {url: 'https://api.example.com/v1'}), true);
  assert.equal(allowed(['net.fetch:api.example.com'], 'POST', 'net', {url: 'https://evil.example.com/v1'}), false);
  assert.equal(allowed(['net.fetch:*.example.com'], 'POST', 'net', {url: 'https://api.example.com/v1'}), true);
  assert.equal(allowed(['net.fetch:*.example.com'], 'POST', 'net', {url: 'https://example.com.evil.test/'}), false);
  assert.equal(
    allowed(['net.fetch:api.example.com'], 'POST', 'net', {url: 'https://api.example.com', headers: {Authorization: '{{secret:openai}}'}}),
    false,
    'injecting a secret needs its own capability'
  );
  assert.equal(
    allowed(
      ['net.fetch:api.example.com', 'secrets.use:openai'],
      'POST',
      'net',
      {url: 'https://api.example.com', headers: {Authorization: '{{secret:openai}}'}}
    ),
    true
  );
  assert.equal(allowed(['net.fetch:api.example.com'], 'POST', 'net', {url: 'file:///etc/passwd'}), false);
  assert.equal(allowed(['net.fetch:api.example.com'], 'POST', 'net', {}), false);
});

test('paths no plugin may use are refused whatever it declares', () => {
  const everything = ['graph.read', 'graph.write', 'library.read', 'library.write', 'collections.read', 'collections.write', 'run.read', 'run.start', 'notifications.read', 'notifications.write', 'settings.read', 'settings.write'];
  for (const route of ['auth/session', 'auth/logout', 'plugins', 'unknown/family']) {
    const decision = check(everything, 'POST', route);
    assert.equal(decision.ok, false, route);
    assert.match(decision.reason, /cannot|does not expose/);
  }
  // Discovery is public: a plugin may prove the connection without a capability.
  for (const route of ['meta', 'session', 'diagnostics', 'openapi.json'])
    assert.equal(allowed([], 'GET', route), true, route);
});

test('capability lists are validated and de-duplicated', () => {
  assert.deepEqual(Capabilities.normalize(['graph.read', 'graph.read']), ['graph.read']);
  assert.throws(() => Capabilities.normalize(['graph.admin']), /Unknown plugin capability/);
  assert.throws(() => Capabilities.normalize('graph.read'), /must be a list/);
  assert.throws(() => Capabilities.normalize(Array(51).fill('graph.read')), /at most 50/);
  assert.deepEqual(Capabilities.normalize(undefined), Capabilities.READ_ONLY);
});

test('the host checks the call it sends, not the label the plugin puts on it', () => {
  // A plugin that lies about the method in its own API still cannot write.
  const caps = Capabilities.forPlugin({id: 'x', capabilities: ['graph.read']});
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(allowed(caps, method, 'projects/p1/workflow'), false, method);
    assert.equal(allowed(caps, method.toLowerCase(), 'projects/p1/workflow'), false, method.toLowerCase());
  }
});

test('shipped packages declare capabilities for their literal REST requests', () => {
  const Manifest = require('../js/plugins').PluginManifest;
  const {readSource} = require('../tools/plugin-pack');
  const catalog = ['integration-studio', 'graph-developer-tools'].map(id => Manifest.normalizePackage(readSource(path.join(__dirname, '..', 'client-plugins', id))));
  for (const plugin of catalog) {
    const caps = Capabilities.normalize(plugin.capabilities);
    // The declared source only calls routes its capabilities cover: read what it requests.
    for (const match of plugin.source.matchAll(/api\.request\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/g)) {
      const decision = check(caps, match[1], match[2]);
      assert.equal(decision.ok, true, `${plugin.id} calls ${match[1]} ${match[2]}: ${decision.reason}`);
    }
    assert.equal(Capabilities.forPlugin(plugin).length, caps.length);
  }
});
});

describe("plugin-lifecycle", () => {
// Browser-side lifecycle: install, reinstall, update, enable, dependencies, export and uninstall. The host's iframe
// behaviour is covered by tests/browser_plugin_platform.py; this file covers every rule that must hold before code runs.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');

function storeWith(seed = []) {
  const data = new Map();
  if (seed.length) data.set('agentsys.client.v1.client-plugins', JSON.stringify(seed));
  const localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(String(key), String(value)),
    removeItem: key => data.delete(key),
    get length() {
      return data.size;
    },
    key: index => [...data.keys()][index] ?? null,
  };
  const context = vm.createContext({
    console,
    localStorage,
    sessionStorage: {getItem: () => null, setItem() {}, removeItem() {}},
    crypto: globalThis.crypto,
    fetch: async () => ({ok: false, status: 404}),
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    TextDecoder,
  });
  context.self = context;
  context.globalThis = context;
  for (const file of new Set(['js/model.js', 'js/plugins.js', 'js/plugins.js', 'js/plugin-store.js']))
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return {store: vm.runInContext('PluginStore', context), data, context};
}

const pkg = (overrides = {}) => ({
    api: 1,
    formatVersion: 1,
  id: 'lifecycle',
  title: 'Lifecycle',
  version: '1.0.0',
  source: 'exports.activate = () => {};',
  capabilities: ['graph.read'],
  ...overrides,
});

test('install, reinstall the same version and enable state', () => {
  const {store} = storeWith();
  const made = store.install(pkg());
  assert.equal(made.version, '1.0.0');
  assert.equal(made.enabled, true);
  const firstAt = made.installedAt;
  assert.ok(firstAt > 0);
  // Installing the same version again replaces the package, not the entry: one plugin, one record.
  const again = store.install(pkg({description: 'same version, new text'}));
  assert.equal(store.list().length, 1);
  assert.equal(again.description, 'same version, new text');
  assert.equal(again.installedAt, firstAt);
  assert.equal(store.setEnabled('lifecycle', false).enabled, false);
  assert.equal(store.install(pkg({version: '1.0.1'})).enabled, false, 'an update keeps the user choice');
  assert.equal(store.get('lifecycle').enabled, false);
});

test('updates require explicit approval for writes, wider network access and named secrets', () => {
  const {store} = storeWith();
  store.install(pkg());
  store.update('lifecycle', pkg({version: '1.1.0'}));
  const capabilities = ['graph.read'];
  for (const [version, capability] of [['2.0.0', 'graph.write'], ['2.1.0', 'net.fetch:api.example.com'], ['2.2.0', 'secrets.use:demo'], ['2.3.0', 'net.fetch:*']]) {
    capabilities.push(capability);
    const before = JSON.stringify(store.record('lifecycle'));
    const update = pkg({version, capabilities: [...capabilities]});
    assert.throws(() => store.update('lifecycle', update), error => error.code === 'plugin_permissions_required');
    assert.equal(JSON.stringify(store.record('lifecycle')), before, 'declining leaves version, data and permissions intact');
    store.update('lifecycle', update, {approveCapabilities: true});
    assert.equal(store.get('lifecycle').version, version);
  }
});

test('content replacement uses checksums regardless of version labels', () => {
  const {store} = storeWith();
  const first = store.install(pkg());
  store.markActivated(first.id, first.checksum);
  const next = store.install(pkg({source: 'exports.activate = api => api.ui.toast("new");'}));
  assert.equal(next.version, first.version);
  assert.notEqual(next.checksum, first.checksum);
  assert.equal(store.record(first.id).activatedChecksum, first.checksum);
  assert.equal(store.install(pkg({version: 'preview'})).version, 'preview');
});

test('dependency validation names the missing and disabled dependency', () => {
  const {store} = storeWith();
  assert.throws(
    () => store.install(pkg({id: 'app', dependencies: ['core']})),
    error => error.code === 'missing_dependency' && /core/.test(error.message)
  );
  store.install(pkg({id: 'core', version: '1.5.0'}));
  assert.equal(store.install(pkg({id: 'app', dependencies: ['core']})).id, 'app');
  store.install(pkg({id: 'needs-core', dependencies: ['core']}));
  store.setEnabled('core', false);
  store.setEnabled('needs-core', false);
  assert.throws(
    () => store.setEnabled('needs-core', true),
    error => error.code === 'disabled_dependency'
  );
  assert.equal(store.dependencyState('app').ok, false);
  assert.equal(store.dependencyState('core').ok, true);
});

test('a format 1 package keeps its modules and assets across export and reinstall', () => {
  const {store} = storeWith();
  const packet = {
    format: 1,
    manifest: {id: 'modular', name: 'Modular', version: '1.4.0', api: 1, capabilities: ['library.write']},
    main: 'main.js',
    files: {
      'main.js': 'const help = require("./lib/help"); exports.activate = api => help(api);',
      'lib/help.js': 'module.exports = api => api.ui.toast("help");',
    },
    contributes: {library: [{name: 'X', code: 'node.output.ok = true;'}]},
  };
  const made = store.install(packet);
  assert.equal(made.hasModules, true);
  assert.deepEqual(Object.keys(store.record('modular').files), ['lib/help.js']);
  const exported = store.export('modular');
  assert.equal(exported.format, 1);
  assert.equal(exported.main, 'main.js');
  assert.match(exported.files['main.js'], /require\("\.\/lib\/help"\)/);
  assert.match(exported.files['lib/help.js'], /module\.exports/);
  assert.equal(exported.contributes.library[0].name, 'X');
  const reinstalled = store.install(exported);
  assert.equal(reinstalled.version, '1.4.0');
  assert.equal(store.record('modular').contributes.library[0].code, 'node.output.ok = true;');
});

test('an unsupported stored record is not activated and its private data is preserved', () => {
  const legacy = {id: 'legacy', title: 'Legacy', version: '1.0.0', api: 1,
    source: 'exports.activate = () => {};', enabled: false};
  const {store, data} = storeWith([legacy]);
  data.set('agentsys-plugin-legacy@local:note', JSON.stringify({saved: true}));
  assert.equal(store.get('legacy'), undefined);
  assert.equal(data.has('agentsys-plugin-legacy@local:note'), true);
  assert.equal(JSON.parse(data.get('agentsys.client.v1.client-plugins')).length, 1, 'reading does not rewrite user data');
});

test('uninstall removes the package and every environment-scoped value', () => {
  const {store, data} = storeWith();
  store.install(pkg());
  store.storage('lifecycle').set('settings', {n: 1});
  assert.deepEqual(JSON.parse(JSON.stringify(store.storage('lifecycle').get('settings'))), {n: 1});
  store.clear('lifecycle');
  assert.equal(store.storage('lifecycle').get('settings'), null);
  store.remove('lifecycle');
  assert.deepEqual(JSON.parse(JSON.stringify(store.list())), []);
  assert.equal([...data.keys()].some(key => key.startsWith('agentsys.client.v1.plugin-lifecycle')), false);
});

test('the host storage scope is not reachable with a plugin storage key', () => {
  const {store} = storeWith();
  store.install(pkg());
  store.hostStorage('lifecycle').set('__agentsys:deployment', {ok: true});
  assert.deepEqual(JSON.parse(JSON.stringify(store.hostStorage('lifecycle').get('__agentsys:deployment'))), {ok: true});
  assert.throws(() => store.storage('lifecycle').set('__agentsys:deployment', {}), /reserved/);
  assert.equal(store.storage('lifecycle').get('__agentsys:deployment'), null);
});

test('editing a saved server URL isolates plugin data without reading or changing old storage', () => {
  const {store, context, data} = storeWith();
  let env = {id: 'saved', url: 'https://one.example'};
  context.Environment = {active: () => env};
  data.set('agentsys-plugin-lifecycle@saved:legacy', JSON.stringify({kept: true}));
  assert.equal(store.storage('lifecycle').get('legacy'), null);
  assert.equal(data.has('agentsys-plugin-lifecycle@saved:legacy'), true);
  store.storage('lifecycle').set('value', 'server one');
  env = {...env, url: 'https://two.example'};
  assert.equal(store.storage('lifecycle').get('value'), null);
  assert.equal(store.storage('lifecycle').get('legacy'), null);
  store.storage('lifecycle').set('value', 'server two');
  env = {...env, url: 'https://one.example'};
  assert.equal(store.storage('lifecycle').get('value'), 'server one');
  assert.equal(store.storage('lifecycle').get('legacy'), null);
  assert.equal(data.has('agentsys-plugin-lifecycle@saved:legacy'), true);
});
});

describe("plugin-manifest", () => {
// The package contract: manifest normalization, English semantic versions, dependencies and compatibility.
const test = require('node:test'),
  assert = require('node:assert/strict');
const Manifest = require('../js/plugins').PluginManifest;

const base = {
    formatVersion: 1,
  id: 'demo',
  name: 'Demo plugin',
  version: '1.2.3',
  api: 1,
  source: 'exports.activate = api => { api.ui.toast("hi"); };',
};

test('version labels are metadata and dependency declarations use IDs', () => {
  assert.equal(Manifest.normalizePackage({...base, version: 'preview'}).version, 'preview');
  assert.throws(() => Manifest.normalizePackage({...base, dependencies: {core: '*'}}), /list of plugin IDs/);
});

test('a format 1 package is normalized: modules, assets, contributions and metadata', () => {
  const record = Manifest.normalizePackage({
    format: 1,
    manifest: {
      id: 'com.example.data',
      name: 'Structured data',
      version: '2.1.0',
      description: 'A collection UI.',
      icon: 'database',
      api: 1,
      capabilities: ['collections.read', 'collections.write', 'library.write'],
      dependencies: ['core-tools'],
      author: 'Example',
      license: 'MIT',
    },
    main: 'main.js',
    files: {
      'main.js': 'const helper = require("./lib/helper"); exports.activate = api => helper(api);',
      'lib/helper.js': 'module.exports = api => api.ui.toast("ready");',
      'schema.json': '{"type":"object"}',
    },
    assets: {logo: {type: 'image/png', data: 'aGVsbG8='}},
    contributes: {
      collections: [{name: 'demo-notes', title: 'Notes', schema: {type: 'object'}}],
      library: [{name: 'Double', code: 'node.output.value = node.input.value * 2;', outputs: ['value']}],
      workflows: [{name: 'Demo flow', nodes: [{library: 'Double'}]}],
    },
  });
  assert.equal(record.id, 'com.example.data');
  assert.equal(record.title, 'Structured data');
  assert.equal(record.version, '2.1.0');
  assert.equal(record.api, 1);
  assert.equal(record.main, 'main.js');
  assert.match(record.source, /require\("\.\/lib\/helper"\)/);
  assert.deepEqual(Object.keys(record.files), ['lib/helper.js', 'schema.json']);
  assert.match(record.assets.logo, /^data:image\/png;base64,/);
  assert.equal(record.contributes.collections[0].name, 'demo-notes');
  assert.equal(record.contributes.library[0].name, 'Double');
  assert.equal(record.contributes.workflows[0].name, 'Demo flow');
  assert.equal(record.capabilities.length, 3);
});

test('missing and unknown package formats and API contracts are rejected', () => {
  for (const value of [
    {id: 'x', api: 1, source: base.source},
    {...base, formatVersion: 2},
    {...base, api: 2},
    {format: 2, manifest: base, files: {'main.js': base.source}},
    {format: 99, manifest: base, files: {'main.js': base.source}},
    {manifest: base, files: {'main.js': base.source}},
  ]) assert.throws(() => Manifest.normalizePackage(value), {code: 'unsupported_contract'});
});

test('current format export round-trips code, version and capabilities', () => {
  const record = Manifest.normalizePackage({...base, capabilities: ['graph.read']});
  const packet = Manifest.exportPackage(record);
  assert.equal(packet.format, 1);
  const again = Manifest.normalizePackage(packet);
  assert.equal(again.source, base.source);
  assert.equal(again.version, base.version);
  assert.deepEqual(again.capabilities, ['graph.read']);
});

test('unknown API contracts are refused', () => {
  assert.throws(() => Manifest.normalizePackage({...base, api: 99}), {code: 'unsupported_contract'});
});

test('package paths are relative, portable and cannot leave the package', () => {
  for (const path of ['../evil.js', '/etc/passwd', 'C:/evil.js', 'a\\b.js', 'a/../../b.js', './main.js']) {
    assert.throws(
      () =>
        Manifest.normalizePackage({
          ...base,
          format: 1,
          manifest: {id: 'x.y', name: 'X', version: '1.0.0', api: 1},
          main: 'main.js',
          files: {[path]: 'exports.activate = () => {};', 'main.js': 'exports.activate = () => {};'},
        }),
      error => error.code === 'invalid_request',
      path
    );
  }
  assert.throws(
    () =>
      Manifest.normalizePackage({
        ...base,
        format: 1,
        manifest: {id: 'x.y', name: 'X', version: '1.0.0', api: 1},
        main: 'main.js',
        files: {'main.js': 'exports.activate = () => {};', 'view.html': '<script></script>'},
      }),
    /JavaScript or JSON/
  );
});

test('dependencies are named and activated in order, with cycles refused', () => {
  const core = Manifest.normalizePackage({...base, id: 'core', version: '1.4.0'});
  const app = Manifest.normalizePackage({...base, id: 'app', version: '1.0.0', dependencies: ['core']});
  assert.equal(Manifest.checkDependencies(app, [core, app], {requireEnabled: true}).ok, true);
  const disabled = {...core, enabled: false};
  assert.equal(Manifest.checkDependencies(app, [disabled, app], {requireEnabled: true}).errors[0].code, 'disabled_dependency');
  const missing = Manifest.checkDependencies(app, [app]);
  assert.equal(missing.errors[0].code, 'missing_dependency');
  const wrong = {...core, version: '2.0.0'};
  assert.equal(Manifest.checkDependencies(app, [wrong, app]).ok, true);
  const order = Manifest.activationOrder([app, core]).order.map(plugin => plugin.id);
  assert.deepEqual(order, ['core', 'app']);
  const cycleA = {...app, id: 'a', dependencies: ['b']};
  const cycleB = {...app, id: 'b', dependencies: ['a']};
  assert.equal(Manifest.activationOrder([cycleA, cycleB]).errors[0].code, 'dependency_cycle');
});

test('unknown capability-shaped fields are kept out of the runtime manifest', () => {
  const record = Manifest.normalizePackage({
    ...base,
    format: 1,
    manifest: {id: 'x.y', name: 'X', version: '1.0.0', api: 1, unknown: 'ignored'},
    main: 'main.js',
    files: {'main.js': 'exports.activate = () => {};'},
  });
  assert.equal('unknown' in record, false);
  assert.equal(record.title, 'X');
});
});

describe("plugin-packages", () => {
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Manifest = require('../js/plugins').PluginManifest;
const {readSource} = require('../tools/plugin-pack');
const ROOT = path.join(__dirname, '..');

for (const id of ['integration-studio', 'graph-developer-tools']) {
  test(`${id} builds a reproducible standalone package with local imports`, () => {
    const record = Manifest.normalizePackage(readSource(path.join(ROOT, 'client-plugins', id)));
    const packet = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/client/client-plugins', id, `${id}.agentsys-plugin.json`), 'utf8'));
    assert.deepEqual(packet, Manifest.exportPackage(record));
    for (const source of [record.source, ...Object.values(record.files)]) {
      assert.doesNotMatch(source, /\bdocument\.|\bwindow\.|\blocalStorage\b|\bsessionStorage\b/);
      for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) assert.match(match[1], /^\.\//);
    }
  });
}

test('source packaging is identical for LF and CRLF checkouts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-package-lines-'));
  try {
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({id: 'line-test', name: 'Lines', version: '0.1.0', api: 1}));
    const main = path.join(dir, 'main.js');
    fs.writeFileSync(main, 'exports.activate = api => {\n  return undefined;\n};\n');
    const lf = Manifest.exportPackage(Manifest.normalizePackage(readSource(dir)));
    fs.writeFileSync(main, fs.readFileSync(main, 'utf8').replace(/\n/g, '\r\n'));
    assert.deepEqual(Manifest.exportPackage(Manifest.normalizePackage(readSource(dir))), lf);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('the SDK quickstart describes an installable package', () => {
  const guide = fs.readFileSync(path.join(ROOT, 'sdk/README.md'), 'utf8').replace(/\r\n?/g, '\n');
  const manifest = JSON.parse(guide.match(/```json\n([\s\S]*?)\n```/)[1]);
  const source = guide.match(/```js\n([\s\S]*?)\n```/)[1];
  const record = Manifest.normalizePackage({format: 1, manifest, main: 'main.js', files: {'main.js': source}});
  assert.equal(record.id, 'hello');
  assert.equal(record.api, 1);
  assert.equal(Manifest.normalizePackage(Manifest.exportPackage(record)).source, source);
});
});

describe("plugin-sandbox", () => {
// Exercise the real iframe host class without a browser, controlling the token-issuance suspension point.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function sandbox(Environment, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../js/plugin-host.js'), 'utf8');
  const context = vm.createContext({
    Environment, AbortController, URL, clearTimeout,
    window: {removeEventListener() {}},
    ...globals,
  });
  const start = source.indexOf('  class PluginSandbox {');
  const end = source.indexOf('  function cleanupRegistrations', start);
  const Class = vm.runInContext(source.slice(start, end) + '\nPluginSandbox', context);
  // Constructor DOM work is covered by browser_plugin_security; this fixture starts at the live request boundary.
  return Object.assign(Object.create(Class.prototype), {
    plugin: {id: 'demo'}, capabilities: ['graph.read'], token: null, requests: new AbortController(),
    dead: false, stopping: false, pending: new Map(),
    frame: {contentWindow: {postMessage() {}}, remove() {}},
  });
}

test('disposing a sandbox settles its open dialog and removes host callbacks', async () => {
  const callbacks = new Map();
  const modal = {
    addEventListener: (name, callback) => callbacks.set(name, callback),
    removeEventListener: (name, callback) => { if (callbacks.get(name) === callback) callbacks.delete(name); },
  };
  const host = sandbox({}, {$: () => modal, dialog() {}, sanitizeHTML: String, esc: String});
  const answer = host.showDialog({body: 'Passive body'});
  assert.equal(callbacks.size, 2);
  host.dispose();
  assert.equal((await answer).action, null);
  assert.equal(callbacks.size, 0);
});

test('disabling a plugin during token issuance revokes the late token and sends no request', async () => {
  let release;
  const revoked = [], requests = [];
  const host = sandbox({
    generation: () => 1,
    pluginToken: () => new Promise(resolve => { release = resolve; }),
    revokePluginToken: token => revoked.push(token),
    request: (...args) => requests.push(args),
  });
  const work = host.sendRequest('GET', 'projects');
  host.dispose();
  release('pst_late');
  await assert.rejects(work, /not running/);
  assert.deepEqual(revoked, ['pst_late']);
  assert.deepEqual(requests, []);
  assert.equal(host.requests.signal.aborted, true);
});

test('issuance failure does not fall back to the owner session', async () => {
  let calls = 0;
  const host = sandbox({
    generation: () => 1,
    pluginToken: async () => { throw new Error('Token service unavailable'); },
    request: () => { calls++; },
  });
  await assert.rejects(host.sendRequest('POST', 'projects', {}), /Token service unavailable/);
  assert.equal(calls, 0);
});

test('an expired scoped credential renews once with the same owner and never sends an owner credential', async () => {
  const auth = [], owners = [];
  const host = sandbox({
    generation: () => 1,
    pluginToken: async (caps, options) => { owners.push(options.owner); return 'pst_new'; },
    request: async (method, route, options) => {
      auth.push(options.auth);
      if (options.auth === 'pst_old') throw Object.assign(new Error('expired'), {code: 'plugin_token_expired'});
      return {ok: true};
    },
  });
  host.token = 'pst_old';
  assert.deepEqual(await host.sendRequest('GET', 'projects'), {ok: true});
  assert.deepEqual(auth, ['pst_old', 'pst_new']);
  assert.deepEqual(owners, ['demo']);
});

for (const reason of ['plugin_token_invalid', 'plugin_token_expired']) {
  test(`${reason} after revocation or restart cannot fall back when renewal is refused`, async () => {
    const auth = [];
    const host = sandbox({
      generation: () => 1,
      pluginToken: async () => { throw Object.assign(new Error('token service refused'), {status: 403}); },
      request: async (method, route, options) => { auth.push(options.auth); throw Object.assign(new Error('invalid'), {code: reason}); },
    });
    host.token = 'pst_old';
    await assert.rejects(host.sendRequest('POST', 'projects', {}), /token service refused/);
    assert.deepEqual(auth, ['pst_old']);
  });
}

test('a switch during token issuance cannot send the previous plugin operation to the new server', async () => {
  let release, generation = 1, calls = 0;
  const revoked = [];
  const host = sandbox({
    generation: () => generation,
    pluginToken: () => new Promise(resolve => { release = resolve; }),
    revokePluginToken: token => revoked.push(token),
    request: () => { calls++; },
  });
  const work = host.sendRequest('POST', 'projects', {});
  generation++;
  release('pst_old_server');
  await assert.rejects(work, /environment changed/);
  assert.equal(calls, 0);
  assert.deepEqual(revoked, ['pst_old_server']);
});

test('a delayed expired response reuses a token already renewed by another request', async () => {
  let release, issued = 0, oldRequests = 0;
  const host = sandbox({
    generation: () => 1,
    pluginToken: async () => { issued++; return 'pst_new'; },
    request: async (method, route, options) => {
      if (options.auth === 'pst_old') {
        if (++oldRequests === 2) await new Promise(resolve => { release = resolve; });
        throw Object.assign(new Error('expired'), {code: 'plugin_token_expired'});
      }
      return {ok: true};
    },
  });
  host.token = 'pst_old';
  const first = host.sendRequest('GET', 'projects');
  const second = host.sendRequest('GET', 'resources');
  await first;
  release();
  await second;
  assert.equal(issued, 1, 'the late old response must not revoke the fresh token');
});
});

describe("plugin-sdk", () => {
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('the SDK publishes its API declarations and standalone quickstart', () => {
  const types = read('sdk/agentsys-plugin.d.ts');
  for (const member of ['interface AgentSysPluginApi', 'interface PluginManifest', 'interface PluginPackage',
    'addPage', 'addLibrarySection', 'addSettingsSection', 'addInspectorSection', 'addResourceView',
    'showDialog', 'onUpdate', 'onUninstall']) assert.ok(types.includes(member), member);
  assert.match(types, /API version 1/);
  assert.match(read('sdk/README.md'), /activate/);
});

test('the consolidated guide covers public extension contracts and security', () => {
  const guide = read('docs/plugins.md');
  for (const section of ['Architecture', 'API', 'Manifest', 'Lifecycle', 'UI', 'Library and collections',
    'Capabilities', 'Security', 'Packaging', 'Development']) assert.ok(guide.includes('## ' + section), section);
  assert.doesNotMatch(guide, /api\.route\s*\(/);
  assert.doesNotMatch(guide, /plugins?\/<id>\/main\.js/);
});
});

describe("plugin-views", () => {
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const context = vm.createContext({PluginContent: {decorate: (html, owner) => owner + ':' + html}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/model.js'), 'utf8'), context);
  const host = fs.readFileSync(path.join(__dirname, '../js/plugin-host.js'), 'utf8');
  vm.runInContext(host.slice(host.indexOf('class PluginViews'), host.indexOf('// ---- extensions ----')), context);
  const registry = vm.runInContext('new PluginViews()', context);
  const sandbox = id => ({
    plugin: {id, title: id},
    invoke: async (name, args) => JSON.stringify({name, args}),
    checkedRequest: async () => ({records: [{data: {value: 3}}], total: 1}),
  });
  return {registry, sandbox};
}

test('removing a plugin removes every projection without removing another owner', () => {
  const {registry, sandbox} = fixture();
  for (const owner of ['first', 'second']) {
    registry.add('library', {id: 'tools', hasRender: true}, sandbox(owner));
    registry.add('resource', {id: 'records', collection: 'records', sidebar: true, hasRender: true}, sandbox(owner));
    registry.add('inspector', {id: 'node', hasRender: true}, sandbox(owner));
  }
  assert.equal(registry.pages().length, 4);
  assert.equal(registry.sidebar().length, 4);
  registry.remove('first');
  assert.equal(registry.page('first', 'tools'), undefined);
  for (const projection of [registry.pages(), registry.sidebar(), registry.list()])
    assert.ok(projection.every(item => item.plugin === 'second'));
  assert.equal(registry.page('second', 'view-records').resourceView, 'records');
});

test('page names collide across contribution kinds, with owner-local names', () => {
  const {registry, sandbox} = fixture();
  registry.add('page', {id: 'view-items', hasRender: true}, sandbox('first'));
  assert.throws(() => registry.add('resource', {id: 'items', collection: 'items', hasRender: true}, sandbox('first')), /already registered/);
  registry.add('library', {id: 'view-items', hasRender: true}, sandbox('second'));
  assert.equal(registry.pages().length, 2);
  assert.throws(() => registry.add('page', {id: '../escape', hasRender: true}, sandbox('first')), /id must/);
  assert.throws(() => registry.add('resource', {id: 'items', collection: '../secret', hasRender: true}, sandbox('first')), /collection name/);
});

test('resource rendering reads through the owning checked API and decorates for that owner', async () => {
  const {registry, sandbox} = fixture();
  const owner = sandbox('first'), calls = [];
  owner.checkedRequest = async (...args) => { calls.push(args); return {records: [{data: {value: 3}}], total: 4}; };
  registry.add('resource', {id: 'items', collection: 'items', hasRender: true}, owner);
  const root = {};
  await registry.page('first', 'view-items').render(root, {route: 'items'});
  assert.equal(calls[0][0], 'GET');
  assert.equal(calls[0][1], 'collections/items/records');
  const result = JSON.parse(root.innerHTML.slice('first:'.length));
  assert.equal(result.name, 'resource:items');
  assert.deepEqual(result.args, [{collection: 'items', records: [{data: {value: 3}}], total: 4, page: {route: 'items'}}]);
  owner.checkedRequest = async () => { throw new Error('permission denied'); };
  await assert.rejects(registry.page('first', 'view-items').render({}), /permission denied/);
});

test('returned lists cannot mutate authoritative navigation metadata', () => {
  const {registry, sandbox} = fixture();
  registry.add('page', {id: 'page', nav: false, hasRender: true}, sandbox('first'));
  registry.pages()[0].title = 'changed';
  assert.equal(registry.page('first', 'page').title, 'page');
  assert.equal(registry.sidebar().length, 0);
});
});
