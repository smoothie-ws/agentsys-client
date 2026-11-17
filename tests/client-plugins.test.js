'use strict';
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
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'app', 'core.js'), 'utf8'), context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'js', 'app', 'plugin-manifest.js'), 'utf8'),
    context
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'js', 'app', 'plugin-capabilities.js'), 'utf8'),
    context
  );
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'app', 'plugin-store.js'), 'utf8'), context);
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
