# AgentSys Client

Static graph editor, execution controls, multiple server environments and sandboxed plugins. Web API 1.0; Plugin API and package format 1.

## Installation

For production, unzip the release static artifact into an nginx/Caddy/CDN root.
The client uses hash routes; serve files directly and return 404 for missing assets.
No Node.js or server package is required. HTTPS clients require HTTPS API URLs.

For the optional local CLI (Node.js 22+):

```sh
npm install -g ./agentsys-client-0.1.0.tgz
agentsys-client serve --port 8081
```

The first visit opens Servers disconnected. Use the Servers action menu to add
an absolute HTTP(S) URL and, when required, a token. Test it, then choose Use this
server. Multiple saved environments can be switched independently of deployment
configuration. An unavailable server leaves the application usable disconnected.

Set config.json to {"defaultServerURL":"https://server.example"} for an optional
installation default. It is public: never add credentials or API keys. Existing
user environments take precedence. The CLI also accepts --server for a default.
Add this client's exact origin to the server allowlist. Do not proxy the API
through the static client to bypass CORS. Hash routing needs no SPA rewrite.

Example nginx configuration (terminate HTTPS for remote deployments):

```nginx
server {
  listen 80;
  root /srv/agentsys-client;
  location / { try_files $uri $uri/ =404; }
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;
  add_header X-Frame-Options DENY always;
  add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http: https:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'" always;
}
```

Equivalent Caddy static hosting:

```caddyfile
client.example.com {
  root * /srv/agentsys-client
  file_server
  header {
    X-Content-Type-Options nosniff
    Referrer-Policy no-referrer
    X-Frame-Options DENY
    Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http: https:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'"
  }
}
```

Configure equivalent headers on a CDN. Keep the plugin sandbox and frame CSP;
its script policy matches the existing editor and plugin host requirements.

## Development

Requirements: Node.js 22 or 24; no external npm runtime dependencies.

```sh
npm test
npm run build
npm pack --ignore-scripts
```

The static artifact is dist/client. The npm artifact includes the static files
and optional CLI. npm pack runs prepack to build automatically; source checkout scripts are not shipped
as public assets. The default generated output can be rebuilt; explicit output
paths must not already exist. All copied source assets must be regular files
without symlink traversal. To produce a ZIP, archive the contents of dist/client.

CI independently tests Node 22/24 on Linux/Windows and uploads the npm artifact.
Cross-product browser verification belongs to the integration repository and
installs the exact independently versioned server and client tarballs.

## Tests

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

See [architecture](docs/architecture.md), [plugins](docs/plugins.md) and the [SDK](sdk/README.md).
