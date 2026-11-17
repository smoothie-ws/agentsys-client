# Plugin lifecycle

Install validates the first package/API contract, capabilities and dependency IDs, then stores the package in this browser. Installing the same ID replaces its content, preserving private data and enabled state. Expanded permissions require approval.

Activation uses package checksums. First activation runs `onInstall`, then `activate`. Replacing content runs `onUpdate`, then `activate`, even when its version label is unchanged. Unchanged content runs `activate` alone. A failed replacement restores the previous package.

```js
exports.onInstall = async (api, context) => {};
exports.onUpdate = async (api, context) => {};
exports.activate = async api => {};
exports.deactivate = async api => {};
exports.onUninstall = async (api, context) => {};
```

The lifecycle context is `{hook, previousChecksum, checksum}`. Hooks may perform private data operations; they return no persisted version counter. `activate` may return a cleanup function.

Disable runs cleanup and `deactivate`, removes registrations and the sandbox, aborts work and revokes scoped authority. Reload stops the sandbox and activates the same package. Uninstall runs `onUninstall` and cleanup, then removes the package and its environment-scoped private storage; ordinary server resources remain. Recovery retries a failed activation.

Dependencies activate first. Missing, disabled or cyclic dependencies block activation. Disabling a dependency stops its dependants. Dependencies provide ordering and availability; they do not grant access to another plugin's storage or commands.

Lifecycle hooks have bounded deadlines. A hanging or throwing plugin is stopped; unrelated plugins and the editor continue. Each plugin owns its commands, pages, styles and registrations. Private storage is scoped to plugin ID, saved environment ID and exact server URL.
