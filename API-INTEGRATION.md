# API integration

The client supports API major 2 independently of application releases. Discovery
uses GET /api/meta, integer protocol major and api_version (major.minor). Optional
capabilities are announced by features. No exact application-version match is
required. Incompatible majors produce an incompatible connection state.

All server reads/writes and event streams use Environment transport. Explicit
bearer headers support cross-origin installations without third-party cookies.
Tokens remain in tab sessionStorage, keyed by environment and exact server URL.
Environment changes abort previous requests and prevent late answers from
updating the newly selected environment. Never replay an ambiguous mutation.
On SSE reconnection reload current resources; the stream has no replay guarantee.

Canonical OpenAPI is published by the server repository with API release 2.0.
This client owns its adapter and model; contract-fixtures contain public JSON
conformance data and introduce no shared executable dependency.
