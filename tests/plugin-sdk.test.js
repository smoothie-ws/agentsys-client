'use strict';
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
