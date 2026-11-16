# Installation

For production, unzip the release static artifact into an nginx/Caddy/CDN root.
The client uses hash routes; serve files directly and return 404 for missing assets.
No Node.js or server package is required. HTTPS clients require HTTPS API URLs.

For the optional local CLI (Node.js 22+):

```sh
npm install -g ./agentsys-client-0.7.0.tgz
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
