'use strict';
// Build only reviewed public files; never copy a source directory recursively.
const fs = require('node:fs');
const path = require('node:path');
const files = require('../public-files.json');
const {readSource} = require('./plugin-pack');
const Manifest = require('../js/plugins').PluginManifest;
const root = path.resolve(__dirname, '..');
function build(output) {
  const destination = path.resolve(output);
  if (fs.existsSync(destination)) throw new Error('Build destination must not exist: ' + destination);
  const packages = new Map(['integration-studio', 'graph-developer-tools'].map(id => {
    const record = Manifest.normalizePackage(readSource(path.join(root, 'client-plugins', id)));
    return [`client-plugins/${id}/${record.id}.agentsys-plugin.json`, Manifest.exportPackage(record)];
  }));
  for (const name of files) {
    if (packages.has(name)) continue;
    const source = path.join(root, name);
    if (!fs.lstatSync(source).isFile() || fs.realpathSync(source) !== source) throw new Error('Asset must be a regular file without symlinks: ' + name);
  }
  fs.mkdirSync(destination, {recursive: true});
  for (const name of files) {
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    if (packages.has(name)) fs.writeFileSync(target, JSON.stringify(packages.get(name), null, 2) + '\n');
    else fs.copyFileSync(path.join(root, name), target);
  }
  return destination;
}
if (require.main === module) {
  const destination = path.join(root, 'dist', 'client');
  // Only the fixed generated directory may be replaced. Explicit outputs remain create-only.
  if (!process.argv[2] && fs.existsSync(destination)) {
    if (fs.realpathSync(destination) !== destination || fs.realpathSync(path.dirname(destination)) !== path.dirname(destination))
      throw new Error('Generated output must not be a symlink');
    const relative = path.relative(root, fs.realpathSync(destination));
    if (relative !== path.join('dist', 'client')) throw new Error('Output escaped the project');
    fs.rmSync(destination, {recursive: true});
  }
  console.log(build(process.argv[2] || destination));
}
module.exports = {build};
