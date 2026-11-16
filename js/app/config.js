// Public deployment configuration. Contains no tokens or secrets.
'use strict';
globalThis.AGENTSYS_CONFIG_READY = (async () => {
  try {
    const response = await fetch(new URL('../../config.json', document.currentScript.src), {cache: 'no-store', signal: AbortSignal.timeout(5000)});
    if (!response.ok) return;
    const config = await response.json();
    if (!globalThis.AGENTSYS_DEFAULT_SERVER && typeof config.defaultServerURL === 'string' && config.defaultServerURL) {
      const url = new URL(config.defaultServerURL);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
        globalThis.AGENTSYS_DEFAULT_SERVER = config.defaultServerURL;
    }
  } catch { /* An unavailable or invalid optional configuration leaves the client disconnected. */ }
})();
