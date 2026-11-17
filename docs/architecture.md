# Client architecture

The client is a static application. index.html loads presentation helpers, the
editing snapshot model, environment transport, UI and sandboxed client plugins.
js/environments.js is the single transport for server resources and SSE.
Browser preferences, environment lists and plugin records remain browser-local;
projects, workflows, collections, secrets and runtime state belong to the server.
Switching environments aborts old requests and invalidates caches. Credentials
are scoped to the exact URL and tab session. No server implementation is imported.

public-files.json is the exact distribution allowlist. tools/build.js
copies only those files to dist/client. Optional cli.js serves
that artifact and does not proxy API calls. Production needs only static hosting.

## API transport

The client requires the first Web API contract: `GET /api/meta` must report `protocol: 1` and `api_version: "1.0"`. Unknown contracts produce a connection error. Application version labels do not affect connection decisions. Optional features are advertised by `features`.

All server reads, writes and event streams use Environment transport. Explicit bearer headers support cross-origin installations. Tokens remain in tab sessionStorage, keyed by environment and exact server URL. Environment changes abort previous requests and prevent late answers from updating the newly selected environment.

Never replay a mutation after an ambiguous network failure. On SSE reconnection reload resources; events have no replay guarantee. Conditional writes preserve workflow cursors and collection record revisions.

The Server repository publishes the canonical OpenAPI contract. `contract-fixtures` contains public conformance data; neither product imports the other's implementation.

## Client state

The client is a static browser program. It serves nothing, runs no graph JavaScript, owns no projects and
contains no storage access. It edits and observes whatever the active AgentSys Server owns.

### Running

```sh
node cli.js --port 8081 --server http://127.0.0.1:8080
## or use the npm launcher:
npm start
```

`npm start` serves the built Client on port 8081. Start AgentSys Server separately; closing the browser does not stop its workflows.

The client can also be served by any static web server. `--server` and `AGENTSYS_DEFAULT_SERVER` only choose
the initial environment for a fresh browser profile; the user can add or change servers in the interface.

### What it loads

`index.html` loads:

- `js/model.js`, `js/protocol.js` — pure helpers and the API contract.
- `js/format.js` — reading and writing `agentsys.text/1` packets for import/export.
- `js/ui.js`, `js/navigation.js`, `js/pages.js`, `js/shell.js` — presentation and navigation.
- `js/canvas.js`, `js/interactions.js`, `js/run.js`, `js/inspector.js` — graph editing and execution controls.
- `js/plugins.js`, `js/plugin-store.js`, `js/plugin-host.js` — contracts, browser storage and sandboxed plugins.

It does **not** load the graph mutation editor, schema validation, snapshot/document construction,
execution-view builder or interpreter. Server runtime and filesystem modules are refused by the static Client launcher. All graph changes go through the application API.

### API transport

`js/environments.js` is the only transport. Every request passes through it; there is no direct `fetch('/api')`
in a page or canvas module.

- Base URL of the active environment.
- Bearer token (from `sessionStorage`) or the HttpOnly session cookie.
- JSON error mapping to `ApiError`.
- Abort/timeout, and a generation counter that rejects answers from a previous environment with
  `stale_environment`.
- No automatic retry of mutations. A clean `401` may renew the session and retry once; a network failure is
  reported, not repeated.
- SSE through `fetch` streaming so the same auth applies; reconnect with exponential backoff.
- `subscribe()` and `subscribeHooks()` expose server changes without exposing the transport.

### Local storage

| Key | Contents |
|---|---|
| `agentsys-ui-store` | panel sizes, theme, tabs, camera, clipboard, filters |
| `agentsys-environments` | environment id, name and base URL (no tokens) |
| `agentsys-active-environment` | id of the last active environment |
| `agentsys-client-plugins` | installed client plugin packages |
| `agentsys-plugin-<id>@<env>:` | plugin-private JSON, scoped per plugin and server |
| `sessionStorage: agentsys-token:<env>@<encoded-url>` | per-tab token; cleared when the tab closes |

UI preferences are browser-local. The server does not read or write interface layout.

### Switching environments

1. Flush every open editor to the old server (or ask the user).
2. Abort in-flight requests and close the old event stream.
3. Clear per-server view state: tabs, project tree, Library caches.
4. Change the active endpoint.
5. Probe `/api/meta`, check the protocol, renew/exchange the session.
6. Load the new session, projects, Library.
7. Reconnect SSE and render the dashboard.

A failed save or a declined leave guard cancels the switch and preserves the old environment. Concurrent
switch requests honour the latest selection even if an older save hook finishes later.
Late answers from the old environment are rejected by the generation check; they cannot repaint the new one.
Workflows are not copied between environments. Moving data between servers is a separate future feature.

While a page loads, its view is `aria-busy` and inert, so controls from the previous page cannot be operated.
Only the latest render releases that state.

### Connection states

`connected`, `connecting`, `disconnected`, `unauthorized`, `error`. They are shown by the dot
beside the server name in the sidebar and on the Server page, with an actionable message
("Add its token", "Update the server", "The server could not be reached").

### Client plugins

Installed in this browser and run in a sandboxed iframe. See [plugins.md](plugins.md).

### Packaging later

The client is already a standalone static program with a single transport and no backend. A PWA manifest,
service worker or a desktop shell can wrap it later without changing the server contract. No Electron/Tauri
infrastructure is included in this cycle.

## Environments

An environment is a connection to one AgentSys Server instance. It is not a folder, a project or a copy of a
workflow. Each server has its own projects, Library, runtime, storage, secrets and permissions.

```text
AgentSys Client
      │
      ├── Localhost         http://127.0.0.1:8080
      ├── Home server       https://agentsys.home.example
      └── VPS Frankfurt     https://agentsys.example.com
```

### Managing environments

Open the **Server** row in the left sidebar, just above **Settings** (it shows the active server, `Local Server` by default). It opens the Manage servers page, where each saved server is a card. A card's **⋯** menu has Use/Reconnect, Test connection, Edit server and Remove server; the page heading's **⋯** has Add server and Reconnect.

- **Add**: name, base URL and, if the server asks, a token.
- **Test**: probes `/api/meta` without switching.
- **Use this server**: makes it active and loads its data.
- **Edit**: change the name or URL; leave the token field empty to keep the current one.
- **Remove**: deletes the saved connection only. No server data is touched.
- **Reconnect**: retries the active server, useful after a restart.
- **Forget token for this tab** (on an active server with a saved token): removes the tab's token and asks the server to end the cookie session.

Tokens are stored in `sessionStorage`, per tab and exact server URL. Editing a saved address does not transfer
its credential. Reconnect applies a changed address through the normal save guards; enter a new token explicitly
if that endpoint requires one. Token fields are never prefilled. They are never written to `localStorage`, never put in a URL
and never shown again by the client. A token is exchanged for an HttpOnly session cookie; plugin code cannot
read either.

### Defaults

- The split local launcher passes `http://127.0.0.1:<server port>` as the default for a new environment.
- A client served by the combined local server uses the page origin.
- A client opened on a phone or another machine does not assume that `127.0.0.1` is the user's PC. The address
  field starts with a value but must be confirmed and can be replaced by the LAN/VPS address.
- The last active environment is remembered by id.

### Switching and isolation

Switching first runs the current page's leave/save guards. A failed save or a declined guard keeps the current
server and edits in place. Switching then flushes edits, aborts old requests, closes the old stream, clears the old server's tabs and caches,
then loads the new server. Each request carries the generation of the environment it was made for. An answer
from a previous generation raises `stale_environment` and is ignored. SSE events from the old socket are
discarded because the socket is closed and the generation changed.

Client plugins remain installed across environments; their private storage is namespaced by environment id so
one server's settings do not appear on another.

### Statuses

| Status | Meaning |
|---|---|
| Connected | `/api/meta` matches the protocol and the session works. |
| Connecting | Probe, auth or initial state load in progress. |
| Disconnected | Network failure, server stopped, or SSE lost; reconnect is retried. |
| Unauthorized | The server requires a token or rejected the session. |
| Connection error | The server does not provide the API 1 contract. |
| Connection error | Any other transport/protocol error, with the message shown. |

### Scenarios covered by tests

- Client on a PC → local server.
- Client → LAN/VPS over HTTP with exact CORS (HTTPS documented in [installation](../README.md)).
- Two clients → one server (shared SSE and change notifications).
- Closing the client while a workflow runs; reopening and seeing the result.
- Server restart; client reconnects and reads the stored state.
- Two independent servers and switching between them without mixing projects or Library data.

Not implemented: copying a workflow or project between environments, and synchronising server data. This is
intentionally a separate feature because it needs dependency and runtime consistency checks.

## Graph model

The canonical graph interchange/storage format is `agentsys.text/1`; Library bundles use version 1.
Projects own workflows. A workflow contains typed ports, nodes, groups, signal/data connections, values,
layout and nested Custom Node interfaces. Shared `graph.js` resolves lookup/bindings; shared `types.js` handles
type rules. Server-only schema/documents/editor/snapshot modules validate edits and construct snapshots.

Client graph mutations go through the API. A workflow cursor supports conditional edits (`If-Match`, conflict
409); a visual position or colour change does not rebuild interpreter semantics. Runtime follows semantic
graph changes and retains its own execution scopes and JSON state. Canvas indexes are presentation caches.

The Server owns signal dispatch, fan-out, joins, recursion, nested scopes and async Script execution. Pause gates continuations; Stop aborts worker work and keeps durable values. See the [Server architecture](https://github.com/smoothie-ws/agentsys-server/blob/main/README.md#architecture).
