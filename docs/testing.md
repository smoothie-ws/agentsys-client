# Testing

Run `npm test` on Node.js 22 or 24. Tests cover graph format conformance, transport cancellation and credential isolation, UI geometry, plugin contracts, capabilities, lifecycle, packaging, sandbox messages and static distribution boundaries.

Build and check the standalone static application:

```sh
npm run build
pip install playwright==1.57.0
python -m playwright install chromium firefox webkit
python tests/browser_static.py
```

Set `AGENTSYS_BROWSER` to select a browser engine. Product CI runs Node.js 22/24 on Linux and Windows and static browser checks in Chromium, Firefox and WebKit.

The [integration workspace](https://github.com/smoothie-ws/agentsys) owns editor, UX, plugin security, lifecycle and resource certification tests against independently installed Server and Client artifacts. It also verifies execution after the browser closes. Every scenario starts with empty temporary server directories and new browser storage.
