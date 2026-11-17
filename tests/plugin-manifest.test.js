'use strict';
// The package contract: manifest normalization, English semantic versions, dependencies and compatibility.
const test = require('node:test'),
  assert = require('node:assert/strict');
const Manifest = require('../js/app/plugin-manifest');

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
