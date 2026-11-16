# Client architecture

The client is a static application. index.html loads presentation helpers, the
editing snapshot model, environment transport, UI and sandboxed client plugins.
js/app/environments.js is the single transport for server resources and SSE.
Browser preferences, environment lists and plugin records remain browser-local;
projects, workflows, collections, secrets and runtime state belong to the server.
Switching environments aborts old requests and invalidates caches. Credentials
are scoped to the exact URL and tab session. No server implementation is imported.

client/public-files.json is the exact distribution allowlist. client/build.js
copies only those files to dist/client. Optional bin/agentsys-client.js serves
that artifact and does not proxy API calls. Production needs only static hosting.
