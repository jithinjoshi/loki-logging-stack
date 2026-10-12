// index.js — a tiny Express app that produces a mix of info / warn / error logs.

const crypto = require('crypto');
const express = require('express');
const logger = require('./logger');
const context = require('./context');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------
// Middleware: give every request a traceId
//   - reuse the caller's W3C `traceparent` (00-<traceId>-<spanId>-01) or `x-request-id`
//   - otherwise make a new one
//   - echo it back in the `x-trace-id` response header, so you can search Grafana for it
// ---------------------------------------------------------------
app.use((req, res, next) => {
  const traceparent = req.get('traceparent');
  const traceId =
    (traceparent && traceparent.split('-')[1]) ||
    req.get('x-request-id') ||
    crypto.randomBytes(16).toString('hex');

  res.set('x-trace-id', traceId);
  context.run({ traceId }, next);
});

// ---------------------------------------------------------------
// Middleware: log every request once it finishes
// ---------------------------------------------------------------
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const entry = {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
      traceId: res.get('x-trace-id'), // 'finish' can fire outside the request context
    };

    // Set by the error handler, so a crash is one log line (with stack), not two
    const err = res.locals.err;
    if (err) Object.assign(entry, { error: err.message, stack: err.stack });

    // Choose the log level from the HTTP status code
    if (res.statusCode >= 500) logger.error('request failed', entry);
    else if (res.statusCode >= 400) logger.warn('request rejected', entry);
    else logger.info('request completed', entry);
  });

  next();
});

// ---------------------------------------------------------------
// Routes
// ---------------------------------------------------------------

// Happy path
app.get('/', (req, res) => {
  res.json({ message: 'Hello from the Express POC' });
});

// Sometimes 200, sometimes 404 -> mix of info and warn logs
app.get('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id > 100) {
    return res.status(404).json({ error: `User ${id} not found` });
  }
  logger.info('user fetched', { userId: id });
  res.json({ id, name: `User ${id}` });
});

// Simulated payment -> random failures produce error logs
app.post('/payments', (req, res) => {
  const amount = Math.floor(Math.random() * 1000) + 1;

  if (Math.random() < 0.3) {
    logger.error('payment gateway timeout', { amount, gateway: 'demo-gateway' });
    return res.status(502).json({ error: 'Payment failed' });
  }

  logger.info('payment processed', { amount, currency: 'AED' });
  res.json({ status: 'ok', amount });
});

// Slow endpoint -> useful for spotting high durationMs in Grafana
app.get('/slow', async (req, res) => {
  const delay = Math.floor(Math.random() * 2000);
  await new Promise((resolve) => setTimeout(resolve, delay));
  if (delay > 1500) logger.warn('slow response', { delayMs: delay });
  res.json({ delayMs: delay });
});

// Always throws -> handled by the error handler below
app.get('/error', () => {
  throw new Error('Something broke on purpose');
});

// ---------------------------------------------------------------
// Error handler: hand the error to the request logger above, return 500
// ---------------------------------------------------------------
app.use((err, req, res, next) => {
  res.locals.err = err;
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  logger.info('server started', { port: PORT });
});
