# API integration

The client requires the first Web API contract: `GET /api/meta` must report `protocol: 1` and `api_version: "1.0"`. Unknown contracts produce a connection error. Application version labels do not affect connection decisions. Optional features are advertised by `features`.

All server reads, writes and event streams use Environment transport. Explicit bearer headers support cross-origin installations. Tokens remain in tab sessionStorage, keyed by environment and exact server URL. Environment changes abort previous requests and prevent late answers from updating the newly selected environment.

Never replay a mutation after an ambiguous network failure. On SSE reconnection reload resources; events have no replay guarantee. Conditional writes preserve workflow cursors and collection record revisions.

The Server repository publishes the canonical OpenAPI contract. `contract-fixtures` contains public conformance data; neither product imports the other's implementation.
