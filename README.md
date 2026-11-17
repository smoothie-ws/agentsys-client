# AgentSys Client

Static browser UI for the AgentSys graph platform: projects, workflows, Library, collections, execution, environments and sandboxed client plugins. Initial release `0.1.0`, Web API `1.0`, Plugin API/package format `1`.

```sh
npm test
npm run build
node bin/agentsys-client.js serve --port 8081 --server http://127.0.0.1:8080
```

Node.js 22+ is required for development and the optional local server. Deploy `dist/client` to static hosting for production; browser credentials are entered at runtime. Browser preferences and plugins use the `agentsys.client.v1` namespace.

See [installation](INSTALLATION.md), [build](BUILD.md), [architecture](ARCHITECTURE.md), [API integration](API-INTEGRATION.md) and [plugins](docs/plugins.md).
