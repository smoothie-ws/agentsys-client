# Plugin manifest and package

Plugin API `1` and package format `1` are the initial contracts. A distributable JSON package has this shape:

```json
{
  "format": 1,
  "manifest": {
    "id": "com.example.notes",
    "name": "Notes",
    "version": "0.1.0",
    "api": 1,
    "capabilities": ["collections.read", "collections.write"],
    "dependencies": ["core-tools"]
  },
  "main": "main.js",
  "files": {"main.js": "exports.activate = api => {};"},
  "assets": {},
  "contributes": {"collections": [], "library": [], "workflows": []}
}
```

`id` is stable and matches `[A-Za-z0-9][A-Za-z0-9._-]{0,79}`. `name` is a display name up to 120 characters. `version` is a display label, default `0.1.0`; it does not select code, order updates or restrict dependencies. `api` is exactly `1`. Dependencies are a list of at most 20 plugin IDs; missing, disabled or cyclic dependencies block activation. Optional metadata includes description, icon, author, license and homepage.

Capabilities name every allowed operation. Omitting them gives read-only access. See [capabilities](plugin-capabilities.md).

`main` defaults to `main.js` and must exist in `files`. Files are package-local JavaScript or JSON: relative `/` paths with no dot segments, drive letters or backslashes. A file is at most 400 KB, the package 900 KB. Modules use package-local `require('./relative')`.

Assets accept PNG, JPEG, GIF and WebP as base64 data, up to 24 images and 200 KB each. `api.asset(id)` returns the image. Contributions declare collections, Library nodes and workflow templates; they deploy only when requested. See [Library deployment](plugin-library.md).

The packer exports an FNV-1a checksum for content identity and accidental-edit detection. It is not a signature. Browser records use normalized `formatVersion: 1`; unsupported package or API contracts are refused.
