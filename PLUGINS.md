# Client plugins

The client owns Plugin Host, Store, packaging, Integration Studio, Graph Developer
Tools and reference packages. The server accepts ordinary API operations and
does not install client packages. Plugin UI runs in sandboxed iframes with CSP;
Host RPC validates identity and declared capabilities. Server-scoped tokens
independently enforce capabilities for deployed server resources.

SDK: sdk/README.md and sdk/agentsys-plugin.d.ts. The declarations package has its
own package version and can be packed with `cd sdk && npm pack`. It has no server
source dependency. Packaging: `node tools/plugin-pack.js <plugin-directory>`;
see docs/plugin-packaging.md for options. Detailed lifecycle, permissions and
extension points are documented in docs/plugin-architecture.md and docs/plugins.md.

Published Library nodes and workflow templates are server-owned data and keep
executing after a plugin or the whole client disconnects. Uninstalling a plugin
does not silently delete user server data.
