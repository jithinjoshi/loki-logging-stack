// context.js — per-request storage, so any log written while handling a request
// (in a route, a service, a callback) automatically carries that request's traceId.

const { AsyncLocalStorage } = require('async_hooks');

module.exports = new AsyncLocalStorage();
