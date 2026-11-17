# Client plugins

Plugin API 1 and package format 1. The public TypeScript contract is [agentsys-plugin.d.ts](../sdk/agentsys-plugin.d.ts).

- [Architecture](#architecture)
- [API](#api)
- [Manifest](#manifest)
- [Lifecycle](#lifecycle)
- [UI](#ui)
- [Library and collections](#library-and-collections)
- [Capabilities](#capabilities)
- [Security](#security)
- [Packaging](#packaging)
- [Development](#development)

## Architecture

### The boundary

```
Browser (client)                                     Server
┌──────────────────────────────────────────┐         ┌─────────────────────────────┐
│ Plugins page / plugin store               │         │ API routes                  │
│  localStorage: packages, enabled state    │         │  capabilities on every call │
│  per-environment private storage          │         │  short-lived plugin tokens  │
│              │                            │         │  secrets, net egress policy │
│              ▼                            │  HTTPS  │              │              │
│ Extension host                            │ ──────► │              ▼              │
│  manifest/dependency checks               │         │ JSON data: projects,        │
│  one sandboxed iframe per plugin          │         │ workflows, Library nodes,   │
│   opaque origin, CSP, no DOM/token        │         │ collections, notifications  │
│  postMessage bridge ── capability layer   │         │                             │
│  scoped token per plugin                  │         │ Graph runtime executes      │
│  UI registries, lifecycle hooks           │         │ saved Script nodes          │
└──────────────────────────────────────────┘         └─────────────────────────────┘
```

The client is a static application. Plugins are data in `localStorage`, not files served by the server. The server
sees only the ordinary API calls a plugin makes. A package cannot install a server route, hook or background process.

### Parts

#### Package store — `js/plugin-store.js`

- Keeps at most 50 packages, validates every field and replaces matching IDs and refuses unsafe paths.
- Keeps the enabled state, the installed and updated timestamps, the activated content checksum.
- Provides private storage scoped by plugin **and active environment**. Host bookkeeping uses a reserved key a
  sandbox cannot read or write.
- Exports a package in the distributable format. It never executes code.

#### Manifest contract — `js/plugins.js`

Pure validation shared by the browser, the pack tool and the tests:

- display metadata and dependency IDs;
- package format 1, safe relative module paths and size limits;
- dependency IDs and dependency cycles;
- deterministic checksums and export/import round trips.

#### Extension host — `js/plugin-host.js`

- Starts every enabled plugin in its own `<iframe sandbox="allow-scripts">` with an opaque origin and a restrictive
  CSP. The frame is one CSS pixel and off-screen.
- Dispatches checked host calls from the public `api`: requests, storage, settings, commands, UI contributions,
  Library/collection/workflow helpers, network and secret metadata.
- Owns lifecycle: activation context (`install`, `update`, `activate`), `deactivate`, `onUninstall`, cleanup and
  failure recovery.
- Owns live sandboxes and one error map. Commands, explicit links and styles are removed with their owner.

#### Isolated SDK program — `js/plugin-host.js`

Builds the opaque iframe document from serialized package/lifecycle configuration. Module loading, SDK helpers
and plugin-side invocation handlers run inside that document. They cannot close over host state. The host-facing
interface is only `PluginFrame.document(plugin, context)`; the public plugin SDK remains unchanged.

#### Rendered contributions — `js/plugin-host.js`

One registration list owns pages, Library sections, resource views, home cards, settings and Inspector sections.
Page/navigation/section lists are derived rather than independently synchronized. Each record uses only its
owner's `invoke` and `checkedRequest` capabilities. Resource views cannot fetch records through an operator
credential. Cleanup removes all projections by removing the owner's records.

#### Passive content ? `js/plugin-host.js`

HTML/CSS sanitization and own-command decoration are separate from lifecycle/RPC. Packages cannot provide host
action attributes. See [UI](plugins.md#ui) for the supported passive syntax.

#### Capability layer — `js/plugins.js`

Classifies each API call from its method, path and body (not from the plugin's label) and rejects one the package did
not declare. The server repeats the check on a scoped token.

#### Scoped plugin tokens

The host exchanges its own credential for a short-lived token limited to the plugin's capabilities
(`POST /api/auth/plugin-session`). Requests made with it are enforced by the server. Disabling or removing a plugin
revokes its token immediately; a server switch revokes tokens at the server that issued them and never sends them to
the next environment. See [capabilities](plugins.md#capabilities) and [security](plugins.md#security).

#### Resource deployment — `js/plugins.js`

Turns a package's `contributes` section into ordinary server data, idempotently and per environment:

- collection definitions (records are never rewritten or deleted);
- Script-backed Library nodes owned by the plugin, updated in place when content changes;
- a workflow project, a workflow and its Library nodes, usually with a native Event trigger.

The deployed graph is saved by the server. Running it needs no client, plugin host or plugin token.

### Dependency direction

- A plugin never imports application internals. It receives `api` and uses `api.request` or the helpers built on it.
- The application never imports plugin code. It starts a sandbox and exchanges JSON messages.
- The server does not know that a Library node came from a plugin. It validates and runs it like any other node.
- The shared rules live in `js/model.js` and `js/plugins.js`; the
  server and the client use the same capability grammar.

### State ownership

| State | Owner | Scope |
|---|---|---|
| Package source, modules, assets | Browser (`localStorage`) | Client |
| Enabled state, dependency decisions | Browser | Client |
| Plugin private values (`api.storage`) | Browser | Client **and** environment |
| Deployment record | Browser (host key) | Client **and** environment |
| Collections, Library nodes, workflows, records | Server | Server |
| Secrets | Server | Server |
| Scoped token | Browser memory | One plugin, one server, minutes |

This split is why two servers can hold different deployments of the same plugin and why a browser can hold a package
that no server has ever seen.

## API

The SDK is the object passed to `activate(api)`. There is no package to import at runtime: AgentSys injects `api` into
the sandbox. TypeScript declarations live in [`sdk/agentsys-plugin.d.ts`](../sdk/agentsys-plugin.d.ts); plain
JavaScript is supported without a build step.

### Module shape

```js
exports.activate = async api => {
  // registrations, commands, requests
};

exports.deactivate = async api => {};
exports.onInstall = async (api, context) => {};
exports.onUpdate = async (api, context) => {};
exports.onUninstall = async (api, context) => {};
```

A package's main file may use `require('./relative')`. Only `.js` and `.json` files from the same package are
available; there is no `node_modules`, no network `require` and no external module. `module.exports` works as in
CommonJS.

`activate` may also return a cleanup function. It runs on disable, reload and uninstall, after `deactivate` when both
exist.

`activate` throwing rejects the activation. The plugin is marked failed, the rest of the client keeps working, and the
Plugins page offers **Try again**. An update that fails is rolled back to the previous package.

### `api` members

| Member | Returns | Purpose |
|---|---|---|
| `api.id`, `title`, `description`, `icon`, `version`, `api` | values | Package metadata |
| `api.capabilities` | `string[]` | The capabilities granted to this plugin |
| `api.manifest` | object | The safe subset of the manifest (`id`, `name`, `version`, `api`, `capabilities`, `icon`) |
| `api.signal` | `AbortSignal` | Aborted when the plugin stops; observe it in long work |
| `api.log(...args)` | — | Host console, prefixed with the plugin id |
| `api.asset(name)` | data URI | An image bundled in `assets` |
| `api.assets()` | object | All bundled images |
| `api.request(method, path, body?, query?)` | JSON | One checked API call; `path` is relative to `/api` |
| `api.storage.get/set/remove` | JSON | Private values, scoped by plugin and active server |
| `api.settings.get/set` | JSON | A settings object in the same private storage |
| `api.commands.register(id, handler, meta?)` | promise | A command callable from UI and `execute` |
| `api.commands.execute(id, ...args)` | any | Only this plugin's own commands |
| `api.ui.*` | promises | Interface contributions, dialogs, toasts, navigation |
| `api.library.*` | JSON | List, create, ensure and update Script-backed Library nodes |
| `api.collections.*` | JSON | Generic Collections CRUD with versions |
| `api.workflows.*` | JSON | Projects, workflows and node placement |
| `api.net.fetch(spec)` | `{status, text}` | A checked server-side HTTP request |
| `api.secrets.present(name)` | `{name, present}` | Secret **metadata**; never the value |
| `api.env.info()` | `{id,name,url,status,protocol}` | The active environment |
| `api.onDidChange(listener)` / `api.on('change', listener)` | unsubscribe | Server change keys |

### Requests

```js
const projects = await api.request('GET', 'projects');
const made = await api.request('POST', 'projects', {name: 'From a plugin'});
const page = await api.request('GET', 'collections/notes/records', undefined, {limit: 20});
```

`api.request` is capability checked twice:

1. the host classifies the call as a read or write in one family and refuses it with a message naming the missing
   capability;
2. the host attaches the plugin's scoped token; the server applies the same capability rules to that token.

Authentication endpoints (`auth/...`) are always refused. Redirects, private addresses, secrets and network hosts
follow the server's own policies.

Errors reject with a message that can be shown to a person. Do not catch and ignore a capability error: fix the
manifest or the call.

### Storage and settings

```js
const count = (await api.storage.get('count', 0)) + 1;
await api.storage.set('count', count);
const settings = await api.settings.get();
await api.settings.set({...settings, colour: 'blue'});
```

Values are JSON, at most 100 KB each. A key beginning `__agentsys:` is reserved for the host. Storage is separated by
plugin **and by server**: switching environments does not show values from the previous one.

### Commands

```js
api.commands.register('say', async (name = 'there') => {
  api.ui.toast(`Hello, ${name}`);
  return {name};
}, {title: 'Say hello', icon: 'sparkles', order: 10});
```

A command may be called from a toolbar button, a menu item, a page button (`data-command="say"`) or
`api.commands.execute('say', 'Ada')`. A foreign command (`other-plugin:say`) is refused.

Command return values are sent back as JSON. Page/card/inspector renderers return HTML strings instead.

### UI in passive HTML

A renderer returns a string. The host sanitizes it and inserts it into its own DOM. Scripts, frames, forms, event
handler attributes, external images and `javascript:` URLs are removed. The page cannot reach the application DOM.

Buttons may call a command:

```html
<button type="button" data-command="say" data-args='["Ada"]'>Say hello</button>
```

Use the application's classes (`page-facts`, `button-row`, `primary`, `muted`, `card`, `empty`, `form-error`,
`oc-table`) so a plugin looks native. Add scoped CSS with `api.ui.addStyles`; `@import` and `url(...)` are refused.

### Helpers as the stable contract

Prefer the helpers over raw paths:

```js
const node = await api.library.ensureNode({name: 'Slug', code: '...', outputs: ['slug']});
const records = await api.collections.records('notes', {limit: 50});
const made = await api.collections.create('notes', {title: 'First'});
await api.collections.update('notes', made.id, {...made.data, title: 'Second'}, made.version);
```

They compose the same public API and inherit the same capability checks. A plugin never needs an internal module of
the application.

### Contract

`api.api` is **1**. Packages use format **1**. Unsupported contracts are refused before activation. Dependencies name plugin IDs; content checksums select lifecycle hooks.

## Manifest

Plugin API `1` and package format `1` are the initial contracts. A distributable JSON package has this shape:

```json
{
  "format": 1,
  "manifest": {
    "id": "com.example.notes",
    "name": "Notes",
    "version": "0.1.0",
    "api": 1,
    "capabilities": ["collections.read", "collections.write"],
    "dependencies": ["core-tools"]
  },
  "main": "main.js",
  "files": {"main.js": "exports.activate = api => {};"},
  "assets": {},
  "contributes": {"collections": [], "library": [], "workflows": []}
}
```

`id` is stable and matches `[A-Za-z0-9][A-Za-z0-9._-]{0,79}`. `name` is a display name up to 120 characters. `version` is a display label, default `0.1.0`; it does not select code, order updates or restrict dependencies. `api` is exactly `1`. Dependencies are a list of at most 20 plugin IDs; missing, disabled or cyclic dependencies block activation. Optional metadata includes description, icon, author, license and homepage.

Capabilities name every allowed operation. Omitting them gives read-only access. See [capabilities](plugins.md#capabilities).

`main` defaults to `main.js` and must exist in `files`. Files are package-local JavaScript or JSON: relative `/` paths with no dot segments, drive letters or backslashes. A file is at most 400 KB, the package 900 KB. Modules use package-local `require('./relative')`.

Assets accept PNG, JPEG, GIF and WebP as base64 data, up to 24 images and 200 KB each. `api.asset(id)` returns the image. Contributions declare collections, Library nodes and workflow templates; they deploy only when requested. See [Library deployment](plugins.md#library-and-collections).

The packer exports an FNV-1a checksum for content identity and accidental-edit detection. It is not a signature. Browser records use normalized `formatVersion: 1`; unsupported package or API contracts are refused.

## Lifecycle

Install validates the first package/API contract, capabilities and dependency IDs, then stores the package in this browser. Installing the same ID replaces its content, preserving private data and enabled state. Expanded permissions require approval.

Activation uses package checksums. First activation runs `onInstall`, then `activate`. Replacing content runs `onUpdate`, then `activate`, even when its version label is unchanged. Unchanged content runs `activate` alone. A failed replacement restores the previous package.

```js
exports.onInstall = async (api, context) => {};
exports.onUpdate = async (api, context) => {};
exports.activate = async api => {};
exports.deactivate = async api => {};
exports.onUninstall = async (api, context) => {};
```

The lifecycle context is `{hook, previousChecksum, checksum}`. Hooks may perform private data operations; they return no persisted version counter. `activate` may return a cleanup function.

Disable runs cleanup and `deactivate`, removes registrations and the sandbox, aborts work and revokes scoped authority. Reload stops the sandbox and activates the same package. Uninstall runs `onUninstall` and cleanup, then removes the package and its environment-scoped private storage; ordinary server resources remain. Recovery retries a failed activation.

Dependencies activate first. Missing, disabled or cyclic dependencies block activation. Disabling a dependency stops its dependants. Dependencies provide ordering and availability; they do not grant access to another plugin's storage or commands.

Lifecycle hooks have bounded deadlines. A hanging or throwing plugin is stopped; unrelated plugins and the editor continue. Each plugin owns its commands, pages, styles and registrations. Private storage is scoped to plugin ID, saved environment ID and exact server URL.

## UI

A plugin extends the interface through declarations, not by editing the application DOM. Each registration belongs to
one sandbox and is removed when the plugin stops. Renderers return passive HTML; the host sanitizes it and inserts it
into its own layout, so the application's design system (classes, colours, spacing, focus states) applies.

### Pages and navigation

```js
api.ui.addPage({
  id: 'overview',
  title: 'Overview',
  description: 'What this plugin shows',
  icon: 'chart',
  order: 10,
  nav: true,
  render: async context => `<h2>Overview</h2><p>${api.ui.escape(api.id)}</p>`,
});
```

- The page is at `/ext/<plugin>/<page>`.
- `nav: false` hides the sidebar entry; `addSidebarItem` adds a separate link.
- `render` may return HTML, an element, or a promise of either. It receives the route context as plain JSON.
- `api.ui.pageHref(id)` returns the path for a link.

`addSidebarItem({id, title, icon, href?, page?, order?})` accepts either a client path (`/library`) or a registered
page id. External and `javascript:` URLs are refused at registration.

### Toolbar, menus and commands

```js
api.commands.register('hello', name => api.ui.toast(`Hello ${name}`), {title: 'Say hello', icon: 'sparkles'});
api.ui.addToolbarButton({id: 'hello', command: 'hello', title: 'Say hello', icon: 'sparkles'});
api.ui.addMenuItem('section:plugins', {label: 'Say hello', command: 'hello', icon: 'sparkles'});
api.ui.addContextMenu({label: 'Greet the selection', command: 'hello', args: [{name: 'selection'}], order: 40});
```

Known menus:

| Menu | Appears on |
|---|---|
| `canvas:add` | The canvas Add menu |
| `canvas:selection` | The canvas selection/context menu |
| `library:resource` | A Library node's “⋯” menu |
| `nodes:` / `folder:<path>` | Library nodes and group menus |
| `resource:<id>` | One Library node |
| `section:library`, `section:projects`, `section:plugins`, `section:settings` | Section menus |
| `plugin:<id>` | A plugin card/page menu |
| `ext:<plugin>:<page>` | A plugin page menu |

A menu command receives the menu's context as its first argument: `{type, id, resource?, project?, workflow?,
folder?, section?, plugin?, selection?}`. `canvas:add` receives `{project, workflow, point}`; `canvas:selection`
receives `{project, workflow, selected}`.

The same command can be a button in passive HTML:

```html
<button type="button" data-command="hello" data-args='[{"name":"Ada"}]'>Say hello</button>
```

Only this plugin's commands are accepted; `other-plugin:hello` is refused.

### Dashboard cards

```js
api.ui.addHomeCard({id: 'stats', title: 'Stats', icon: 'chart', render: async () => '<p class="muted">3 items</p>'});
```

Cards are drawn in the dashboard's grid with the application card styles. A failing card shows an error in its own
body; other cards and the page continue.

### Settings

```js
api.ui.addSettingsSection({
  id: 'preferences',
  title: 'My plugin',
  description: 'Settings stored by the plugin',
  render: async () => '<button type="button" data-command="reset">Reset</button>',
});
```

Sections are appended to the application Settings page, outside the application's own autosaving form. Use
`api.settings` for values and commands for changes.

### Inspector

```js
api.ui.addInspectorSection({
  id: 'node-info',
  title: 'Node info',
  when: 'any', // or "node" or "complex"
  render: ({node, selection, project, workflow}) => `<p>${api.ui.escape(node?.name || 'nothing')}</p>`,
});
```

Sections appear in the Inspector of the selected node, after the application's own properties. `when: "node"` limits
the section to ordinary nodes; `"complex"` to Complex Nodes.

### Library sections and custom resource views

```js
api.ui.addLibrarySection({
  id: 'notes',
  title: 'Notes',
  icon: 'database',
  render: async () => '<h2>Notes</h2>',
});
```

A Library section is a normal plugin page shown in the Library overview and in the Library navigation. Use
`api.library.list()` and `api.collections.*` for its content.

```js
api.ui.addResourceView({
  id: 'note-table',
  title: 'Note table',
  collection: 'notes',
  sidebar: true,
  render: ({records, total}) => `<table>...</table>`,
});
```

A resource view is a page at `/ext/<plugin>/view-<id>` that the host fills with the collection's records (up to 200)
before calling `render`. This is the supported way to give a collection a custom UI without direct DOM access.

### Dialogs

```js
const answer = await api.ui.showDialog({
  title: 'Endpoint',
  body: '<label class="field"><span>URL</span><input name="url" value="http://127.0.0.1:8791"></label>',
  actions: [{label: 'Save', id: 'save', command: 'save-url', variant: 'primary'}],
});
// answer = {action: "save", values: {url: "..."}, result: <command result>}
```

The dialog's form values are passed as the first command argument. `api.ui.closeDialog()` closes it. The dialog is the
application's modal, so focus, Escape and the close button behave natively.

### Notifications, toasts and navigation

```js
await api.ui.notify({title: 'Done', body: 'The import finished', level: 'success'}); // needs notifications.write
api.ui.toast('Saved');
api.ui.navigate('/plugins');
api.ui.refresh();
```

`notify` is a server write. `toast` is local. `refresh` redraws the current page.

### Styles

`api.ui.addStyles(css)` appends scoped CSS to the page. `@import`, `url(...)`, `expression(...)` and `javascript:` are
refused, so a plugin cannot load a remote resource through CSS. The style node is removed with the plugin.

### What a plugin cannot do

- It cannot access the application DOM, `document`, `window.parent.document`, `localStorage`, `sessionStorage`,
  cookies or the server token.
- It cannot inject scripts, frames, forms, event-handler attributes, external images or unsafe URLs; the host
  sanitizer removes them.
- It cannot register a server route.
- It cannot use another plugin's command, storage or token.

See [security](plugins.md#security) and the integration test fixture `reference-ui-showcase`, which registers every
extension point.

### Passive content boundary

Plugin HTML keeps `data-command` and `data-args` for its own command buttons; other `data-*` attributes are
removed before insertion. In particular, a package cannot forge `data-ext-command` or host menu/action attributes.
The host decorates a validated command with the owning plugin id. Templates, active SVG elements, MathML and
media elements are removed. Static SVG shapes and packaged raster images remain supported.

Inline styles and `addStyles` reject CSS escapes, comments and resource-loading constructs (including
`image-set`), in addition to `url`, imports and expressions. This deliberately narrows CSS syntax to prevent
obfuscated network loads. Plugin styles can still affect application presentation; install only trusted UI packages.

## Library and collections

A client plugin can add a Library section, create reusable Custom Nodes, define collections and compose a workflow
template. The server stores and runs all of it without the plugin.

### Library sections

```js
api.ui.addLibrarySection({
  id: 'pack',
  title: 'Library Pack',
  description: 'Nodes and a workflow template',
  icon: 'library',
  render: async () => {
    const nodes = (await api.library.list()).filter(item => item.payload.plugin?.id === api.id);
    return `<h2>Library Pack</h2><ul>${nodes.map(node => `<li>${api.ui.escape(node.name)}</li>`).join('')}</ul>`;
  },
});
```

The section appears in the Library overview and in the Library navigation. Its content is drawn by the plugin's
renderer; the nodes it lists are ordinary server resources.

### Creating a Custom Node

```js
const node = await api.library.createNode({
  name: 'Slug',
  code: "node.output.slug = String(node.input.text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');",
  inputs: ['text'],
  outputs: ['slug'],
  grants: ['graph.read'],
  folder: 'Text',
  description: 'A reusable slug node.',
});
```

`createNode` calls `POST /api/library/script-nodes`, which builds a normal Script-backed Custom Node. Its id is
returned. `ensureNode` returns a node with the same name when one exists, so installing twice does not duplicate it.
`updateNode(id, spec)` replaces a node **only when this plugin owns it**; a user's node is refused by the server.

Nodes are owned through a `plugin` tag in their payload: `{id, name, version, checksum}`. The tag is not a security
boundary; the server also requires the caller's `library.write` capability and, for an update, that the tag's id
matches.

A node created this way is a graph with a Script. It is saved and versioned by the server and has no dependency on the
plugin after the call.

### Custom Node code

The code of a Script runs inside the server's graph runtime. It can use the ordinary Script API:

```js
// Read data; every call is checked against the node's grants and the project policy.
const notes = await agentsys('GET', 'collections/notes/records');
const made = await agentsys('POST', 'collections/notes/records', {data: {text: 'from a node'}});
const response = await agentsys('POST', 'net', {url: 'https://example.test/', headers: {Authorization: '{{secret:api-key}}'}});
node.output.id = made.id;
node.display('stored ' + made.id);
```

The `grants` list on the node is its request budget. The enclosing project policy must also allow a capability; a new
project starts with `graph.read` only, so a node that writes collections needs a project that allows
`collections.write`. Deployment never changes a project's security policy.

### Workflow templates

A package can declare a template instead of (or in addition to) creating nodes at runtime:

```json
"contributes": {
  "library": [{"name": "Greeting", "code": "node.display('Hello');"}],
  "workflows": [{"name": "Demo flow", "project": "My pack", "nodes": [{"library": "Greeting"}]}]
}
```

**Deploy resources** creates the project if needed, creates the workflow, places each named Library node and adds a
native Event trigger wired to the placed nodes (`run: false` skips the trigger). Redeploying the same content is
idempotent; new content updates the plugin's own nodes in place. The deployment record remembers project, workflow,
node and event ids per environment.

The template is ordinary graph data. When saved, the server can run it from its own runtime with no client and no
plugin, which is the required boundary. the integration workspace?s `tests/browser_plugin_platform.py` prove it:
the browser is closed and the plugin uninstalled, then a plain HTTP request starts the workflow.

### Generic Collections

The server has a generic JSON collection API; it gives no meaning to the fields.

```js
await api.collections.define('notes', {
  title: 'Notes',
  schema: {type: 'object', properties: {title: {type: 'string'}}, required: ['title']},
});
const list = await api.collections.records('notes', {limit: 20});
const made = await api.collections.create('notes', {title: 'First'});
const updated = await api.collections.update('notes', made.id, {title: 'Second'}, made.version);
await api.collections.remove('notes', made.id);
```

- Names are lower-case letters, digits and `-`.
- Records are JSON objects, at most 1 MB, 10,000 per collection.
- The definition schema supports `type`, `properties`, `required`, `enum`, `items`, `maxLength` and
  `additionalProperties`.
- Each write returns a version. Send the version read with the record as `if_version` to make the next write
  conditional; a stale version is `409 conflict`.
- A schema update keeps records. A collection delete needs `?force=1` when records exist.
- Concurrent writes from two tabs are resolved by the version, not last-write-wins silently.

A resource view can render records:

```js
api.ui.addResourceView({
  id: 'notes',
  title: 'Notes',
  collection: 'notes',
  sidebar: true,
  render: ({records, total}) => `<h2>${total} notes</h2>`,
});
```

### Deploying declared resources

The plugin page's **Deploy resources** button runs `plugin-deploy.js` through the plugin's checked token:

| Contribution | Operation | User data |
|---|---|---|
| Collection | `PUT /api/collections/<name>` | Existing records are never rewritten; `strategy: "update"` changes the definition only |
| Library node | create, or update its own node in place | Other nodes and copies already placed on canvases are untouched |
| Workflow | create project/workflow, place nodes, add trigger | Existing project/workflow names are adopted with a warning; graphs are not deleted |

Deployment is per environment. The record is `{environment, plugin, version, collections, library, workflows}` in a
host-only storage key. Switching servers and deploying again creates new ids on the other server; forgetting the
record does not delete server data.

### Uninstall

Removing the plugin deletes the package and its browser values. It does **not** delete collections, Library nodes,
workflow templates or records. They are ordinary data, shared with the rest of the application, and the plugin page
says so before removal.

## Capabilities

A capability is a permission a plugin package declares and the host and server enforce. A package that declares
nothing is **read-only**. Writes, runs, secrets and network hosts must each be named.

### The list

| Capability | Allows |
|---|---|
| `graph.read` | Read projects, workflows, graph snapshots, search, project defaults, exchange |
| `graph.write` | Create/change projects, workflows, graph nodes, wires, groups, policies, exchange |
| `library.read` | Read Library nodes, resources, node folders |
| `library.write` | Create/change/delete Library nodes and Script nodes, deploy Custom Nodes |
| `collections.read` | Read collection definitions and records |
| `collections.write` | Define collections and create/change/delete records |
| `run.read` | Inspect a live workflow run and its results |
| `run.start` | Start, stop, pause or resume a run, evaluate a node |
| `notifications.read` | Read notifications |
| `notifications.write` | Post and clear notifications |
| `settings.read` | Read preferences and interface state |
| `settings.write` | Change preferences and interface state |
| `secrets.use:<name>` | Use one named server secret in a request body (no wildcard on the name) |
| `net.fetch:<host>` | Make the server fetch that host. `*` may appear inside the host pattern |

Read-only default: `graph.read`, `library.read`, `collections.read`, `run.read`, `notifications.read`,
`settings.read`.

Everything else is refused, including authentication endpoints, diagnostics, the OpenAPI document, unknown routes,
another plugin's secret and server administration. A plugin cannot mint another plugin token.

### Declaration

```json
{
  "manifest": {
    "id": "my-plugin",
    "capabilities": ["graph.read", "library.write", "collections.write", "secrets.use:weather", "net.fetch:api.weather.test"]
  }
}
```

A declaration is validated at install. A typo is an install error, not a silently ignored permission.

### Two checks

#### Host classification

The host decides what a call needs from its **method, path and body**, not from the plugin's label:

| Call | Needs |
|---|---|
| `GET projects`, `GET projects/…/workflow` | `graph.read` |
| `POST/PUT/DELETE projects`, graph edits | `graph.write` |
| `GET resources`, `GET library/…` | `library.read` |
| `POST/PUT/DELETE resources`, `POST library/script-nodes` | `library.write` |
| `GET collections…` | `collections.read` |
| `PUT collections/…`, record writes | `collections.write` |
| `GET projects/…/execution` | `run.read` |
| `POST projects/…/execution`, pause/resume | `run.start` |
| `GET notifications` | `notifications.read` |
| `POST/DELETE notifications` | `notifications.write` |
| `GET settings`, `GET ui-state` | `settings.read` |
| `PUT settings`, `PUT ui-state` | `settings.write` |
| `GET secrets/<name>` | `secrets.use:<name>` |
| `POST net` | `net.fetch:<host>` plus `secrets.use:<name>` for every `{{secret:name}}` in the body |
| `auth/...` | always refused |

A query string or a body cannot turn a read into a write. A body carrying a secret placeholder is classified with
the secret requirement.

#### Server token

When the server supports it, the host exchanges its own credential for a short-lived token scoped to exactly the
plugin's capabilities (`POST /api/auth/plugin-session`). The plugin's calls carry that token. The server applies the
same capability rules to it, so the boundary does **not** rely on the host page being honest. The token:

- is issued only to an authenticated caller;
- expires after one hour by default (server configurable), and is renewed once after expiry;
- is revoked immediately when the plugin is disabled, removed or the environment changes;
- is never written to plugin storage and never exposed to the sandbox.

Plugin operations require identity-bound scoped tokens from the API 1 server. Issuance errors refuse the operation.

### Secrets

A client plugin never receives a secret value. It can:

- read metadata with `api.secrets.present(name)` (for `secrets.use:<name>`);
- write `{{secret:name}}` into a `net` header/body, which the server substitutes after its checks.

The server replaces a secret in the response text with `[REDACTED]` before returning it. A placeholder in a network
URL is refused, because expanding it could move the checked host. This is tested by
the integration workspace?s `tests/browser_plugin_platform.py` (the local endpoint receives the secret in its
Authorization header; the value is not in the plugin page, the plugin record or the graph result).

### Network

`net.fetch:<host>` names a destination. The value may contain `*`; matching is case-insensitive and ignores a trailing
dot. The server's `AGENTSYS_ALLOW_NET` / `allowedNetHosts`, and a project's net policy, narrow it further. Redirects
are refused (a second redirect target would need its own permission). Private, loopback and link-local destinations
can be refused by server policy (`--deny-private-net`). `tests/network-policy.test.js` and `tests/net-allowlist.test.js`
cover the server side.

### Honest limits

- Capabilities bound a plugin inside one browser session. An operator who edits the client or calls the API with the
  owner's token is outside the plugin model.
- Installing an untrusted plugin is a real grant: a write capability is a write, and scoped CSS can restyle the
  application.
- The token is a second layer, not a replacement for the host check: both are required for a robust deployment.

## Security

### Threat model

A plugin is untrusted JavaScript installed by the user. It must not be able to:

- read or change the application DOM, cookies, browser storage or the server token;
- reach the network except through a permitted server call;
- read a secret value;
- call another plugin, read its storage or use its token;
- perform an API operation its package did not declare;
- keep working after it is disabled;
- persist a server-side hook or route.

A plugin **is** allowed to do what it declared: a `graph.write` plugin writes graphs, a `net.fetch:host` plugin makes
the server fetch that host, and a plugin with a page can draw in the application's layout. Installing a plugin is a
real grant.

### Layers

#### Sandbox

Each plugin runs in `<iframe sandbox="allow-scripts">` with an opaque origin, one CSS pixel in size, off-screen. It has
no same-origin access: `parent.document`, `localStorage`, `sessionStorage`, cookies and `fetch` are unavailable.

The sandbox document has a restrictive CSP:

```
default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none';
frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'
```

The plugin's own code is plain JavaScript loaded from a blob URL, so `'unsafe-eval'` is needed for modules; the frame
cannot use it to load remote code because `connect-src` is `none` and there is no import/network path.

#### Messages

Host ↔ plugin communication is JSON `postMessage`. The host accepts a message only when:

- `event.source === iframe.contentWindow`;
- `event.origin === 'null'` (the opaque blob origin);
- the payload has the `__agentsys: 'plugin'` marker and a known `kind`.

A frame that navigates to a real page changes its origin and is ignored. A message from the application page itself
has a different `source` and is ignored. The plugin side likewise accepts only messages whose `source === parent`.

Pages, cards, settings, inspector content and dialogs are sanitized before insertion: `<script>`, `<style>`, frames,
forms, objects, event-handler attributes, `javascript:`/`vbscript:`/`file:`/HTML data URLs and remote image `src` are
removed. CSS with `@import` or `url(...)` is refused. `data:` images must be PNG/JPEG/GIF/WebP inside an image element.

#### Capability enforcement

The host classifies every request and refuses undeclared capabilities. The server repeats the check on a short-lived
token scoped to the plugin's exact capabilities. The server also enforces its unrestricted families: a plugin token
cannot read diagnostics, the event stream, the OpenAPI contract or authentication, and cannot mint another token.
See [capabilities](plugins.md#capabilities).

#### Tokens

- Issued only to an authenticated caller.
- Held in the host page's memory, never written to storage, never sent to the iframe.
- Bounded in count and lifetime; diagnostics count them but never print a value.
- Revoked at the issuing server on disable/remove and on environment switch. A revoked token returns 401 even when a
  valid session cookie is also present.
- A 401 caused by a stale token is refreshed once, then the call fails with a readable error.

#### Secrets

- A plugin never receives a value. `api.secrets.present` returns metadata only.
- `{{secret:name}}` substitution happens on the server after capability checks.
- A secret in a network URL is refused.
- A response is scrubbed of every stored secret placeholder value before it returns.
- Stored secrets are not listed with values; `GET /api/secrets/<name>` returns `{name, present}`.

#### Isolation between plugins

- One iframe per plugin, one message listener per iframe, one scoped token per plugin.
- Storage is namespaced by plugin and environment; the sandbox cannot name another namespace.
- `api.commands.execute` accepts only this plugin's own command name.
- Resource ownership: a deployed Library node may be updated only by the plugin tag that owns it.
- Host bookkeeping (`__agentsys:` storage keys) is unreachable from `api.storage`.

#### Shutdown

Disabling or removing a plugin:

1. sets the sandbox to stopping, so a request already in flight from `deactivate` is refused;
2. runs `deactivate` (and `onUninstall` on removal) with a 3-second bound;
3. revokes the token;
4. removes the iframe (killing timers, listeners, workers and pending promises), the message listener, the blob URL,
   every UI registration, styles and commands;
5. leaves private data on disable/reload; deletes it on uninstall;
6. never deletes server data implicitly.

A plugin command that never answers is stopped after 20 seconds; a failed activation is reported and other plugins
continue.

### Independent security tests

| Check | Test |
|---|---|
| Iframe sandbox attribute, no same-origin access | `tests/browser_plugin_security.py` |
| CSP blocks direct fetch and image beacons | `tests/browser_plugin_security.py` |
| HTML sanitizer (SVG script, obfuscated `javascript:` link) | `tests/browser_plugin_security.py` |
| Host refuses write/net/secret/auth/foreign command/notification | `tests/browser_plugin_security.py` |
| Scoped token enforcement with the host layer bypassed | `tests/browser_plugin_security.py`, `tests/plugin-tokens.test.js` |
| Token expiry, revocation, bounded count | `tests/plugin-tokens.test.js` |
| Forbidden operations after disable | `tests/browser_plugin_platform.py` |
| Sandbox escape, storage, session, traversal, forged result, popup | `tests/browser_plugin_platform.py` (Plugin E) |
| Secret not in iframe, page, package or result | `tests/browser_plugin_platform.py` (Plugin D) |
| Message from the page is ignored | `tests/browser_plugin_platform.py` |
| Cross-plugin command/data isolation | `tests/browser_plugin_security.py`, Plugin E |
| Network allowlist and private-address policy | `tests/network-policy.test.js`, `tests/net-allowlist.test.js` |

### Not guaranteed

- A user who modifies the client, or uses the owner's API token directly, is outside this model.
- Scoped CSS can restyle the application; install trusted packages.
- A plugin page can display anything it likes inside its own region; sanitization prevents script, not misleading text.
- The package checksum is not a signature. There is no marketplace and no remote auto-install in this cycle; packages
  are imported from a local file chosen by the user.
- A remote endpoint that transforms a secret (for example, returns it base64-encoded or split) can defeat the
  literal-value scrubber. The plugin never receives the stored value, but an untrusted endpoint can leak a derived
  value; treat a permitted host as trusted for the secrets you send to it.

### Passive content boundary

Plugin HTML keeps `data-command` and `data-args` for its own command buttons; other `data-*` attributes are
removed before insertion. In particular, a package cannot forge `data-ext-command` or host menu/action attributes.
The host decorates a validated command with the owning plugin id. Templates, active SVG elements, MathML and
media elements are removed. Static SVG shapes and packaged raster images remain supported.

Inline styles and `addStyles` reject CSS escapes, comments and resource-loading constructs (including
`image-set`), in addition to `url`, imports and expressions. This deliberately narrows CSS syntax to prevent
obfuscated network loads. Plugin styles can still affect application presentation; install only trusted UI packages.

### Identity and ownership

Scoped tokens are bound to the host-supplied plugin identity, verified again on the server.
Unsupported or identity-unaware servers fail closed; there is no owner-session fallback.
Library definitions are shared reads, but scoped mutation requires the verified owner.
Collections and ordinary projects remain shared data under their family capabilities.
See [architecture](plugins.md#architecture) and [Library deployment](plugins.md#library-and-collections) for storage URL binding and resource safeguards.

## Packaging

A distributable plugin is one JSON file ending in `.agentsys-plugin.json`. It contains the manifest, the JavaScript
modules, images and declared server resources. AgentSys installs it from a local file chosen by the user; it does not
auto-load remote code.

### Source layout

```
my-plugin/
  plugin.json          manifest fields and contributes
  main.js              entry (or the file named by "main")
  lib/
    view.js            required as require('./lib/view')
  assets/
    logo.png           becomes api.asset('logo')
  README.md            not packaged
```

`plugin.json`:

```json
{
  "id": "com.example.notes",
  "name": "Notes",
  "version": "1.0.0",
  "description": "Notes and a custom view.",
  "icon": "database",
  "api": 1,
  "capabilities": ["collections.read", "collections.write"],
  "author": "Example",
  "license": "MIT",
  "main": "main.js",
  "contributes": {
    "collections": [{"name": "notes", "title": "Notes", "schema": {"type": "object"}}]
  }
}
```

### Build

```bash
node tools/plugin-pack.js my-plugin
## or
node tools/plugin-pack.js my-plugin
## writes my-plugin/com.example.notes.agentsys-plugin.json
```

Options:

| Command | Effect |
|---|---|
| `node tools/plugin-pack.js <dir> [--out <file>]` | Build one package |
| `node tools/plugin-pack.js --check <dir>` | Validate the source without writing |
| `node tools/plugin-pack.js --validate <file>` | Validate a built package and report checksum state |
| `node tools/plugin-pack.js --all <dir>` | Build every directory that has a `plugin.json` |

The builder:

- collects `.js` and `.json` files except `plugin.json` and built packages;
- normalizes text files to LF before computing package contents/checksums, so Windows CRLF and Unix checkouts build identically;
- puts `main` in `files`, so `require('./main')` and a re-export work;
- base64-encodes PNG/JPEG/GIF/WebP files under `assets/`;
- copies `contributes`;
- runs the same `PluginManifest.normalizePackage` validation as the client;
- writes a format 1 package and an FNV-1a checksum.

### Package

```json
{
  "format": 1,
  "manifest": {"id": "...", "name": "...", "version": "...", "api": 1, "...": "..."},
  "main": "main.js",
  "files": {"main.js": "...", "lib/view.js": "..."},
  "assets": {"logo": "data:image/png;base64,..."},
  "contributes": {"collections": [], "library": [], "workflows": []},
  "checksum": "fnv1a-..."
}
```

The checksum detects an accidental local edit. It is **not** a cryptographic signature and does not prove who built
the package. There is no marketplace and no URL installer in this MVP.

### Install and update

1. Open the **Plugins** page and choose **Install plugin…** from its **⋯** menu.
2. Write the form for a first experiment, or choose **Import JSON file…** and pick a `.agentsys-plugin.json`.
3. A package with the same id and new content updates in place from the plugin page
   (**Update from file…**). It keeps the enabled state and private data, runs `onUpdate`, and rolls back on a
   start failure.
4. **Export package** produces the same format with the current modules and contributions, ready to send to another
   user.

Installing never writes to a server. **Deploy resources** on the plugin page is the separate server action.

### Versioning

- Use semantic versions. `1.0.1` may be installed over `1.0.0`; a lower version is refused by the normal path.
- Bump the version whenever behaviour, modules, assets or `contributes` change; the deployment record uses it to decide
  whether its nodes need an update.
- Keep the id stable. A new id is a new plugin with new storage and a new deployment.

### Dependencies

```json
"dependencies": {"core-tools": "^1.0.0"}
```

The dependency must be installed and enabled before this plugin activates. Dependencies are ordering and availability
contracts, not shared memory: a plugin still cannot call another plugin's commands or read its storage. Use a
Generic Collection or Library node to share data through the server.

### Distribution checklist

- [ ] `node tools/plugin-pack.js --validate <package>` reports valid and checksum matches.
- [ ] A fresh browser installs the package without a server write.
- [ ] The manifest lists every capability the code uses, and no more.
- [ ] Secrets are referenced as `{{secret:name}}`, never embedded.
- [ ] `contributes.library` code runs without the plugin after deployment.
- [ ] A second installation on another server creates independent resources.
- [ ] The package contains no absolute paths, external imports or server modules.
- [ ] The README states what the plugin writes and how to remove it.

## Development

This is the complete loop for a third-party developer: an empty folder, a running AgentSys, an installed plugin, an
error to fix, capabilities, Library nodes, a package and an update.

### 1. Start AgentSys

```bash
node cli.js serve --port 8081 --server http://127.0.0.1:8080
```

Start AgentSys Server separately, then open the client address.

### 2. Write the smallest plugin

```
hello/
  plugin.json
  main.js
```

`plugin.json`:

```json
{
  "id": "hello-agent",
  "name": "Hello Agent",
  "version": "1.0.0",
  "description": "A first plugin.",
  "icon": "sparkles",
  "api": 1,
  "capabilities": ["graph.read"],
  "main": "main.js"
}
```

`main.js`:

```js
exports.activate = async api => {
  api.commands.register('hello', () => api.ui.toast('Hello'), {title: 'Say hello'});
  api.ui.addPage({
    id: 'home',
    title: 'Hello',
    render: async () => `<h2>Hello</h2><p>${api.ui.escape(api.id)}</p><button type="button" data-command="hello">Say hello</button>`,
  });
};
```

A standalone quickstart is in the [SDK README](../sdk/README.md).

### 3. Build and install

```bash
node tools/plugin-pack.js hello
```

Open the **Plugins** page, open its **⋯** menu, choose **Install plugin…**, then **Import JSON file…**, choose `hello/hello-agent.agentsys-plugin.json`. The
plugin is stored in this browser only. Open its card to see its state, interface contributions and package.

For a quick experiment without a file, the install form accepts the same fields and source directly.

### 4. See errors

- The plugin card says **Interface failed** and shows the message; `/plugins/<id>` shows the full error and
  **Try again**.
- `api.log(...)` writes to the browser console prefixed with the plugin id.
- A page/card render error is shown in its own region; other cards continue.
- A command error becomes a toast and is thrown to the caller.
- A package validation error is shown in the install form before anything is stored.

### 5. Capabilities

A plugin without `capabilities` is read-only. Add only what the code uses:

```json
"capabilities": ["graph.read", "graph.write", "library.write", "collections.write", "secrets.use:weather", "net.fetch:api.weather.test"]
```

A refused call names the missing capability. The server applies the same rule to the plugin's scoped token. See
[capabilities](plugins.md#capabilities).

### 6. Debug the UI

- `api.ui.addPage` gives a real route; open `/ext/<plugin>/<page>`.
- Buttons in passive HTML use `data-command` and optional `data-args` JSON:
  `<button data-command="hello" data-args='[{"name":"Ada"}]'>`.
- Use the application's classes (`page-facts`, `button-row`, `primary`, `muted`, `card`, `empty`, `form-error`,
  `oc-table`) for a native look. `api.ui.addStyles` adds scoped CSS; it cannot load external resources.
- Settings, Library, Inspector and resource-view sections are registered with `addSettingsSection`,
  `addLibrarySection`, `addInspectorSection` and `addResourceView`.
- Dialog input is read from the shared modal and passed to the action command as its first argument.

### 7. Add a Library node

```js
const node = await api.library.ensureNode({
  name: 'Slug',
  code: "node.output.slug = String(node.input.text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');",
  inputs: ['text'],
  outputs: ['slug'],
  grants: ['graph.read'],
  folder: 'Text',
});
```

The node is saved by the server. Place it on a canvas or declare it in `contributes.library`; it runs after the plugin
is gone. If the node writes a collection or fetches the network, its grants and the project policy must both allow it.
See [Library and collections](plugins.md#library-and-collections).

### 8. Declare server resources

Add `contributes` for collections, Library nodes and a workflow template. The plugin page's **Deploy resources**
button creates them on the active server through the plugin's checked token. It is idempotent per version and per
environment.

A workflow template gets a native Event trigger by default, so it can be run from the canvas or the API with no client:

```bash
curl -X POST http://127.0.0.1:8080/api/projects/<id>/execution?workflow_id=<wf> \
  -H 'X-AgentSys: 1' -H 'Content-Type: application/json' -d '{"wait":true}'
```

### 9. Update the package

1. Change the code; optionally edit its display label.
2. Build again.
3. On the plugin page choose **Update from file…** and pick the new package.

Private data and enabled state are kept. `onUpdate(api, {hook, previousChecksum, checksum})` runs before `activate` when content changes. If replacement content cannot start, the previous package is restored.

### 10. Test it

- `node tools/plugin-pack.js --check .` for the manifest and paths.
- `node tools/plugin-pack.js --validate package.agentsys-plugin.json` for a built file.
- `npm test` for the platform tests.
- For end-to-end behaviour, use the reference tests as a template:
  `tests/browser_plugin_platform.py` installs packages, exercises the UI, switches servers and runs a deployed graph
  with the browser closed.

### Common mistakes

| Symptom | Cause |
|---|---|
| `Module not found in the package` | The path is missing from `files`, is not relative, or has no `.js` |
| `The plugin must export activate(api)` | `main.js` does not assign `exports.activate` |
| `Unknown plugin capability` | A typo or an invented name; the list is closed |
| `Permission denied: graph.write` | The package did not declare it, or the project policy does not allow a node's grant |
| The deployment did nothing | The plugin is disabled, or the package's `contributes` is empty |
| A node shows a permission error | Its `grants` and the project policy must both allow the capability |
| A page is blank | The renderer threw; the error is in the console and the page body |
| An image does not show | Assets must be PNG/JPEG/GIF/WebP and used with `api.asset` in an `<img>` |

Updates adding capabilities require explicit permission approval. The API 1 server issues identity-bound plugin tokens. See the independent [Integration Studio](../client-plugins/integration-studio/README.md)
and [Graph Developer Tools](../client-plugins/graph-developer-tools/README.md) examples.
