window.tasmReady = import('./index.js').then(({ startTasm }) => startTasm({ basePath: '/', signal: window.tasmStartup.signal }));
window.tasmReady.catch(error => window.tasmStartup.fail(error));
import('./playpen.js').catch(error => window.tasmStartup.fail(error));
