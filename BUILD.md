# Build and release

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
