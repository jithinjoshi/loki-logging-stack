// logger.js — one Winston logger shared by the whole app.
//
// Every log line is written as JSON to two places:
//   1. the console  (so you can still see logs in the terminal)
//   2. Alloy        (pushed over HTTP to Alloy's Loki-compatible endpoint; Alloy forwards to Loki)

const winston = require('winston');
const LokiTransport = require('winston-loki');
const context = require('./context');

const ALLOY_URL = process.env.ALLOY_URL || 'http://localhost:3500';

// winston-loki also sends every meta field (port, path, stack, ...) as Loki structured
// metadata. They are already in the JSON line, so drop them after the line is built.
const lineOnly = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (!['level', 'message', 'timestamp'].includes(key)) delete info[key];
  }
  return info;
});

// Stamp the current request's traceId (if any) on every log line
const withTraceId = winston.format((info) => {
  const store = context.getStore();
  if (store) info.traceId = store.traceId;
  return info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',

  // JSON lines like: {"level":"info","message":"...","service":"express-poc","timestamp":"2026-..."}
  format: winston.format.combine(
    withTraceId(),
    winston.format.timestamp(), // ISO-8601 timestamp, Alloy uses it as the log time
    winston.format.json()
  ),

  // Added to every log line
  defaultMeta: { service: 'express-poc' },

  transports: [
    new winston.transports.Console(),
    new LokiTransport({
      host: ALLOY_URL, // winston-loki appends /loki/api/v1/push
      headers: { Authorization: `Bearer ${process.env.ALLOY_API_KEY}` }, // checked by the log gateway
      labels: { job: 'express-app', env: 'poc' }, // keep labels few and low-cardinality
      format: winston.format.combine(winston.format.json(), lineOnly()), // send the JSON line as-is so Alloy can parse it
      json: true,
      batching: true, // buffer logs and push every `interval` seconds
      interval: 5,
      onConnectionError: (err) => console.error('[logger] cannot reach Alloy:', err.message),
    }),
  ],
});

// Flush the last batch before the process exits
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    const loki = logger.transports.find((t) => t instanceof LokiTransport);
    await loki.flush();
    process.exit(0);
  });
}

module.exports = logger;
