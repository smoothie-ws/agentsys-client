'use strict';
const {describe} = require('node:test');

describe("canvas-geometry", () => {
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const context = vm.createContext({}); // No DOM, workflow or global appearance state.
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/geometry.js'), 'utf8'), context);
const {wirePath, edgePoints} = context;

test('wire rendering and hit testing preserve endpoints for every style, including backward and zero-length wires', () => {
  for (const wire_style of ['linear', 'step', 'rounded', 'bezier'])
    for (const b of [{x: 300, y: -40}, {x: -200, y: 90}, {x: 0, y: 0}]) {
      const a = {x: 0, y: 0}, style = {wire_style, wire_curve: 50};
      const drawn = wirePath(a, b, style), points = edgePoints(a, b, style);
      assert.match(drawn, /^M0,0/);
      assert.doesNotMatch(drawn, /NaN|Infinity/);
      assert.deepEqual([points[0].x, points[0].y], [a.x, a.y]);
      assert.deepEqual([points.at(-1).x, points.at(-1).y], [b.x, b.y]);
      assert.ok(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
    }
});

test('wire curvature is supplied by its caller and does not leak between views', () => {
  const a = {x: 0, y: 0}, b = {x: 500, y: 50};
  const low = {wire_style: 'bezier', wire_curve: 10};
  const high = {wire_style: 'bezier', wire_curve: 100};
  const original = wirePath(a, b, low);
  assert.notEqual(wirePath(a, b, high), original);
  assert.equal(wirePath(a, b, low), original);
});
});

describe("graph-developer-tools", () => {
const test = require('node:test');
const assert = require('node:assert/strict');
const {analyze} = require('../client-plugins/graph-developer-tools/analyze');

test('graph tools finds disconnected nodes, invalid links and Custom Node references', () => {
  const graph = {nodes: [{id: 'event'}, {id: 'alone'}, {id: 'inner-script'}], complex: [{id: 'wrapper', source: {resource_id: 'lib1'},
    interface: {inputs: [{id: 'in', bound: [{node_id: 'inner-script', port_id: 'in'}]}]}}],
    edges: [{source: 'event', target: 'complex:wrapper'}, {source: 'missing', target: 'event'}]};
  const report = analyze(graph);
  assert.deepEqual(report.disconnected, ['alone']);
  assert.equal(report.errors.length, 1);
  assert.deepEqual(report.customNodes, [{id: 'wrapper', resource: 'lib1'}]);
});
});

describe("markdown", () => {
const test = require('node:test');
const assert = require('node:assert/strict');
test('markdown rendering escapes unsafe content and preserves formatting', () => {
  const {renderMarkdown} = require('../js/markdown.js');
  assert.match(
    renderMarkdown('# T\n\n**b** _i_ `<x>`'),
    /<h1>T<\/h1><p><strong>b<\/strong> <em>i<\/em> <code>&lt;x&gt;<\/code><\/p>/
  );
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.doesNotMatch(renderMarkdown('[x](javascript:alert(1)) ![i](https://e.com/a.png)'), /<img|href="javascript/);
  assert.match(
    renderMarkdown('[x](https://e.com)'),
    /<a href="https:\/\/e\.com" target="_blank" rel="noopener noreferrer">x<\/a>/
  );
  assert.match(
    renderMarkdown('- a\n  - b\n- [x] c'),
    /<ul><li>a<ul><li>b<\/li><\/ul><\/li><li><span class="md-task">☑<\/span> c<\/li><\/ul>/
  );
  assert.match(renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'), /<table><thead><tr><th>a<\/th><th>b<\/th>/);
});

test('markdownSlug names Settings sections; a note gets no page links and no images', () => {
  const {renderMarkdown, markdownSlug} = require('../js/markdown.js');
  assert.equal(markdownSlug('Keyboard shortcuts'), 'keyboard-shortcuts');
  assert.doesNotMatch(renderMarkdown('[x](javascript:alert(1)) <script>x</script>'), /<script|href="javascript/);
  assert.doesNotMatch(renderMarkdown('[a](/x) ![i](docs/a.png)'), /<a |<figure|<img/);
});
});
