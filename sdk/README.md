# AgentSys Plugin SDK

The SDK is a **contract**, not a runtime dependency. AgentSys injects the `api` object into `activate(api)`; a plugin
never imports application internals. Plain JavaScript runs directly in the sandboxed plugin host. TypeScript is
optional: point your editor at `agentsys-plugin.d.ts` for completion and checks, then publish the compiled JavaScript
as a package.

```js
// main.js — plain JavaScript, no build step
exports.activate = async api => {
  api.commands.register('hello', () => api.ui.toast('Hello'), {title: 'Say hello'});
  api.ui.addPage({
    id: 'home',
    title: 'Hello',
    render: async () => `<h2>Hello</h2><p>${api.ui.escape(api.id)}</p>`,
  });
};
```

Save the JavaScript above as `main.js` next to `plugin.json`:

```json
{"id":"hello","name":"Hello","version":"0.1.0","api":1,"main":"main.js","capabilities":["graph.read"]}
```

From the Client source checkout, package the folder with `node tools/plugin-pack.js <folder>` and import the generated JSON on the Plugins page.

For TypeScript:

```ts
import type {PluginModule} from '@agentsys/plugin-sdk';

const plugin: PluginModule = {
  async activate(api) {
    api.ui.addSidebarItem({id: 'hello', title: 'Hello', page: 'home'});
  },
};
export = plugin;
```

`activate` may return a cleanup function; it runs on disable, reload and uninstall just like `deactivate`.

- [Plugin SDK](../docs/plugins.md#api)
- [Manifest](../docs/plugins.md#manifest)
- [Lifecycle](../docs/plugins.md#lifecycle)
- [UI extensions](../docs/plugins.md#ui)
- [Library and collections](../docs/plugins.md#library-and-collections)
- [Security model](../docs/plugins.md#security)
- [Packaging](../docs/plugins.md#packaging)
- [Development guide](../docs/plugins.md#development)

The declarations describe the initial Plugin API 1 and package format 1.
