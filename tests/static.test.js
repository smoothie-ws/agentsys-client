'use strict';
const {describe} = require('node:test');

describe("client-build", () => {
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {build} = require('../tools/build');
const {resolveAsset} = require('../cli');
test('static artifact runs from an isolated directory and contains only reviewed public files', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-client-build-'));
  try {
    const output = build(path.join(temporary, 'public'));
    const files = require('../public-files.json');
    for (const name of files) assert.ok(await resolveAsset(output, '/' + name), name);
    for (const name of ['server/api-server.js', 'runtime/backend.js', 'runtime/executor.js', 'data/projects.json', 'package.json']) {
      assert.equal(fs.existsSync(path.join(output, name)), false, name);
      assert.equal(await resolveAsset(output, '/' + name, {fallback: true}), null, name);
    }
    fs.writeFileSync(path.join(output, 'js', 'accidental-secret.js'), 'secret');
    assert.equal(await resolveAsset(output, '/js/accidental-secret.js'), null);
    assert.ok(await resolveAsset(output, '/p/example', {fallback: true}));
    assert.throws(() => build(output), /must not exist/);
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});
});

describe("product-boundary", () => {
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
test('product source has no sibling repository or shared runtime dependency',()=>{
assert.equal(fs.existsSync(path.join(root,'shared')),false);
const metadata=require('../package.json');
assert.equal(metadata.workspaces,undefined);
for(const dependency of Object.values(metadata.dependencies||{})) assert.doesNotMatch(dependency,/^(?:file:|link:|workspace:)/);
function walk(dir){ for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
if(['.git','node_modules','dist','tests','tools','data'].includes(entry.name)) continue;
const file=path.join(dir,entry.name);
assert.equal(entry.isSymbolicLink(),false,file);
if(entry.isDirectory()) walk(file);
else if(entry.name.endsWith('.js')){
const source=fs.readFileSync(file,'utf8');
for(const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)){
const request=match[1]; if(!request.startsWith('.'))continue;
const target=path.resolve(path.dirname(file),request),relative=path.relative(root,target);
assert.ok(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative),file+' -> '+request);
assert.ok([target,target+'.js',target+'.json',path.join(target,'index.js')].some(p=>fs.existsSync(p)),file+' -> '+request);
}
}
}} walk(root);
});
test('distribution ownership excludes the other product implementation',()=>{
for(const name of ['server','runtime','headless.js','js/backend','runtime/storage.js','runtime/executor.js']) assert.equal(fs.existsSync(path.join(root,name)),false,name);
for(const file of require('../public-files.json')) assert.doesNotMatch(file,/^(?:server|runtime|tests|data|tools|bin)\//);
});
});

describe("static-security", () => {
const test=require('node:test'), assert=require('node:assert/strict');
test('the static client sends framing and content policies', async () => {
  await require('./client-harness').withClient(async ({base}) => {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-src 'self' blob:/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  });
});
});

describe("static-serving", () => {
// The static Client: only public files, never server code, and no path trick
// (traversal, encoding, Windows drive/stream suffixes) reaches something else.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  {spawn} = require('node:child_process');
const {withClient} = require('./client-harness');

const raw = (base, pathname, method = 'GET') =>
  new Promise((resolve, reject) => {
    const url = new URL(base);
    const request = http.request({hostname: url.hostname, port: url.port, path: pathname, method}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          type: response.headers['content-type'] || '',
          body: Buffer.concat(chunks).toString('utf8'),
        })
      );
    });
    request.on('error', reject);
    request.end();
  });

test('the client serves public files and none of its own code', async () => {
  await withClient(async ({base}) => {
    for (const [pathname, type] of [
      ['/', 'text/html'],
      ['/index.html', 'text/html'],
      ['/js/ui.js', 'text/javascript'],
      ['/js/model.js', 'text/javascript'],
      ['/js/model.js', 'text/javascript'],
      ['/config.json', 'application/json'],
    ]) {
      const response = await raw(base, pathname);
      assert.equal(response.status, 200, pathname);
      assert.match(response.type, new RegExp(type.replace('/', '\\/')), pathname);
    }
    // Static root and SPA fallback stay in the client.
    const root = await raw(base, '/');
    assert.equal(root.status, 200);
  });
});

test('server-only and non-public files are never served, whatever the path spelling', async () => {
  await withClient(async ({base}) => {
    const forbidden = [
      '/server.js',
      '/headless.js',
      '/package.json',
      '/cli.js',
      '/js/backend/routes-app.js',
      '/runtime/storage.js',
      '/runtime/executor.js',
      ...['editor', 'graph', 'library', 'projects'].map(name => '/runtime/' + name + '.js'),
      '/legacy/server-plugin-host.js',
      '/data/projects.json',
      '/editor/server.js',
      '/editor/js/backend/routes-app.js',
      '/js/backend/../backend/routes-app.js',
      '/js/../server.js',
      '/%2e%2e/server.js',
      '/js/%2e%2e/%2e%2e/server.js',
      '/js%5c..%5c..%5cserver.js',
      '/index.html%00.js',
      '/server.js.',
      '/server.js%20',
      '/js/BACKEND/scripts.js',
      '/runtime/STORAGE.js',
      '/runtime/EXECUTOR.js',
      '/js/backend./scripts.js',
      '/js/backend%20/scripts.js',
    ];
    for (const pathname of forbidden) {
      const response = await raw(base, pathname);
      assert.ok([400, 404].includes(response.status), `${pathname} -> ${response.status}`);
      assert.equal(response.body.includes('createServer('), false, pathname);
      assert.equal(response.body.includes('AGENTSYS_TOKEN'), false, pathname);
    }
    // Windows alternate data streams must not turn a server-only file into a public one.
    for (const pathname of ['/runtime/storage.js::$DATA', '/runtime/executor.js::$DATA', '/server.js::$DATA', '/index.html::$DATA']) {
      const response = await raw(base, pathname);
      assert.ok([400, 404].includes(response.status), `${pathname} -> ${response.status}`);
      assert.equal(response.body.includes('const DB ='), false, pathname);
    }
  });
});

test('a public-looking symlink cannot publish server files or files outside the client root', async () => {
  const {resolveAsset} = require('../cli');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-static-links-'));
  try {
    fs.mkdirSync(path.join(dir, 'js'));
    fs.mkdirSync(path.join(dir, 'server'));
    fs.writeFileSync(path.join(dir, 'server', 'private.js'), 'private');
    fs.symlinkSync(path.join(dir, 'server'), path.join(dir, 'js', 'alias'), 'junction');
    assert.equal(await resolveAsset(dir, '/js/alias/private.js'), null);
    fs.symlinkSync(os.tmpdir(), path.join(dir, 'js', 'outside'), 'junction');
    assert.equal(await resolveAsset(dir, '/js/outside/' + path.basename(dir) + '/server/private.js'), null);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
});

describe("syntax", () => {
// Every browser script must parse: a syntax error in one file silently disables everything it defines.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const scripts = [
  ...fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/<script[^>]*\ssrc="([^"]+)"/g),
].map(m => m[1].split('?')[0]);

test('every script listed in index.html parses', () => {
  assert.ok(scripts.length > 10);
  for (const file of scripts) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, {filename: file}), file);
  }
});
});
