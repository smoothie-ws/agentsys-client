'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Manifest = require('../js/app/plugin-manifest');
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
