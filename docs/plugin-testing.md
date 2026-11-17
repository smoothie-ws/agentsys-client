# Plugin testing

Run the pure contract and browser-host unit tests with Node.js 22 or 24:

```sh
npm test
node --test tests/plugin-manifest.test.js tests/plugin-lifecycle.test.js tests/plugin-packages.test.js
```

These cover the first package/API contract, safe modules and assets, checksum replacement, ID dependencies and cycles, permissions, export/import, private storage isolation, sandbox messages and UI registration cleanup.

`python tests/browser_static.py` checks static startup, the initial plugin install form and browser storage isolation. Set `AGENTSYS_BROWSER` to Chromium, Firefox or WebKit's lowercase name.

The [integration workspace](https://github.com/smoothie-ws/agentsys) owns these artifact-based browser scenarios:

- `browser_plugin_platform.py`: reference UI, Library deployment, collections/schema editing, secrets, lifecycle, same-label content replacement, dependencies, multiple servers and autonomous execution.
- `browser_plugin_security.py`: denied capabilities, sandbox escapes, foreign commands and storage, scoped tokens and passive HTML sanitization.
- `browser_plugin_certification.py`: Integration Studio and Graph Developer Tools, permission approval/cancel, export to a fresh client, deployment ownership, lifecycle stress and mobile reconnect.

Run `tools/artifact-smoke.py` there with `AGENTSYS_FULL_UI=1` after building both independent npm artifacts. All scenarios use disposable stores and browser contexts. CI runs browser scenarios in Chromium, Firefox and WebKit, with each product's unit tests on Node.js 22/24 on Linux/Windows.
