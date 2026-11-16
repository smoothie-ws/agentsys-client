# Installation

For production, unzip the release static artifact into an nginx/Caddy/CDN root.
Serve index.html for application routes; missing asset paths must remain 404.
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
through this static client to bypass CORS. For nginx use `try_files $uri $uri/
/index.html` only for application routes and return 404 for missing asset paths.
