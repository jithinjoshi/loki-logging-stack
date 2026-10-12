// alert-mailer — receives Grafana alert webhooks, looks up the matching error lines in Loki,
// and sends an incident-style HTML email (cause, source, value, surrounding logs, started at).
//
//   Grafana (contact point: webhook)  ->  POST /alert  ->  Loki query  ->  SMTP (SendGrid / Mailpit)

const http = require('http');
const nodemailer = require('nodemailer');

const PORT = 8080;
const LOKI_URL = process.env.LOKI_URL || 'http://loki:3100';
const TIMEZONE = process.env.ALERT_TIMEZONE || 'Asia/Dubai';
const TO = process.env.ALERT_EMAILS;
const FROM = process.env.SMTP_FROM || 'alerts@poc.local';
const MAX_LOG_LINES = 5;

// Must match the label_format in grafana/provisioning/alerting/error-logs.yaml,
// so we can find exactly the log lines behind an alert's error_message.
const ERROR_SIGNATURE =
  '| json err="error", merr="message.error", msg="message", path="path" ' +
  '| label_format error_message=`{{ .err | default .merr | default (printf "%s %s" .msg .path) | trunc 150 }}`';

const [smtpHost, smtpPort = '587'] = (process.env.SMTP_HOST || 'mailpit:1025').split(':');
const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: Number(smtpPort),
  secure: smtpPort === '465',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
});

// ---------------------------------------------------------------
// Loki: the latest error lines for this alert
// ---------------------------------------------------------------
const logql = (s) => JSON.stringify(String(s ?? ''));

function logQuery({ job, error_message }) {
  return `{job=${logql(job)}, level="error"} ${ERROR_SIGNATURE} | error_message=${logql(error_message)}`;
}

async function fetchLogs(labels, startsAt) {
  const params = new URLSearchParams({
    query: logQuery(labels),
    start: String((new Date(startsAt).getTime() - 5 * 60 * 1000) * 1e6),
    end: String(Date.now() * 1e6),
    limit: String(MAX_LOG_LINES),
    direction: 'backward',
  });
  const res = await fetch(`${LOKI_URL}/loki/api/v1/query_range?${params}`);
  if (!res.ok) throw new Error(`Loki ${res.status}: ${await res.text()}`);
  const { data } = await res.json();
  return data.result
    .flatMap((stream) => stream.values.map(([ts, line]) => ({ ts: Number(ts) / 1e6, line })))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_LOG_LINES);
}

// ---------------------------------------------------------------
// Make a log line readable: unwrap JSON-inside-JSON, pull out the stack trace
// ---------------------------------------------------------------
function unwrap(value) {
  if (typeof value === 'string' && /^\s*[{[]/.test(value)) {
    try { return unwrap(JSON.parse(value)); } catch { return value; }
  }
  if (Array.isArray(value)) return value.map(unwrap);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrap(v)]));
  }
  return value;
}

function readableLog(line) {
  let obj;
  try { obj = unwrap(JSON.parse(line)); } catch { return { text: line.slice(0, 1200), stack: null }; }

  const stack = obj.stack || obj.meta_data?.stack || null;
  delete obj.stack;
  delete obj.meta_data;
  delete obj.timestamp;
  delete obj['@timestamp'];

  const text = JSON.stringify(obj, null, 1).replace(/\n\s*/g, ' ');
  return { text: text.length > 1200 ? `${text.slice(0, 1200)} …` : text, stack };
}

// ---------------------------------------------------------------
// Email
// ---------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const formatTime = (date) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(date));

function exploreUrl(base, expr, fromMs) {
  const panes = {
    a: {
      datasource: 'loki',
      queries: [{ refId: 'A', expr, datasource: { type: 'loki', uid: 'loki' } }],
      range: { from: String(fromMs), to: 'now' },
    },
  };
  return `${base}explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}

const button = (href, label, primary) =>
  `<a href="${esc(href)}" style="display:inline-block;padding:10px 18px;margin:0 6px 6px 0;border-radius:6px;font-size:14px;text-decoration:none;` +
  (primary ? 'background:#FF3A3A;color:#ffffff;border:1px solid #FF3A3A;' : 'background:#ffffff;color:#FF3A3A;border:1px solid #FF3A3A;') +
  `">${esc(label)}</a>`;

const row = (label, value) =>
  `<tr><td style="padding:4px 0;width:140px;vertical-align:top;font-weight:600;color:#1f2328;">${esc(label)}</td>` +
  `<td style="padding:4px 0;color:#1f2328;">${value}</td></tr>`;

function renderEmail(alert, logs, base) {
  const { job, env, error_message } = alert.labels;
  const count = alert.values?.B ?? alert.values?.A ?? '?';
  const startsMs = new Date(alert.startsAt).getTime();
  const logsUrl = exploreUrl(base, `{job="${job}", level="error"} |~ \`(?i)${error_message.trim().replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')}\``, startsMs - 15 * 60 * 1000);

  const logHtml = logs.length
    ? logs.map(({ ts, line }) => {
        const { text } = readableLog(line);
        return `<div style="margin:0 0 10px;"><span style="color:#57606a;">${esc(new Date(ts).toISOString())} | error</span> ${esc(text)}</div>`;
      }).join('')
    : '<div style="color:#57606a;">No log lines found (they may still be arriving).</div>';

  const stack = logs.length ? readableLog(logs[0].line).stack : null;
  const stackHtml = stack
    ? `<div style="margin-top:14px;font-weight:600;color:#1f2328;font-family:Arial,sans-serif;">Stack trace (latest)</div>` +
      `<div style="margin-top:6px;white-space:pre-wrap;">${esc(stack.split('\n').slice(0, 8).join('\n'))}</div>`
    : '';

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px 0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;border-top:3px solid #e5341d;">
  <tr><td style="padding:28px 28px 8px;">
    <div style="font-size:17px;font-weight:700;color:#1f2328;"><span style="color:#e5341d;">&#9679;</span> New incident started</div>
    <p style="font-size:14px;color:#1f2328;line-height:1.6;margin:18px 0 0;">Hello team,</p>
    <p style="font-size:14px;color:#1f2328;line-height:1.6;margin:10px 0 0;">A new error was detected in <b>${esc(job)}</b>.</p>
    <p style="font-size:14px;color:#1f2328;line-height:1.6;margin:10px 0 0;">Please check the logs below and take a look.</p>
  </td></tr>
  <tr><td style="padding:16px 28px 24px;">
    ${button(logsUrl, 'View logs', true)}${button(alert.silenceURL, 'Silence')}
  </td></tr>
  <tr><td style="padding:22px 28px;background:#f6f8fa;font-size:13px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;">
      ${row('Cause:', `${esc(job)}: error count &gt; 0`)}
      ${row('Source:', esc([job, env].filter(Boolean).join(' / ')))}
      ${row('Error:', `<span style="font-family:Consolas,Menlo,monospace;">${esc(error_message)}</span>`)}
      ${row('Current value:', esc(count))}
    </table>
    <div style="margin-top:14px;font-weight:600;color:#1f2328;">Surrounding logs:</div>
    <div style="margin-top:8px;font-family:Consolas,Menlo,monospace;font-size:12px;line-height:1.7;color:#1f2328;word-break:break-word;">
      ${logHtml}${stackHtml}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;margin-top:14px;">
      ${row('Started at:', esc(formatTime(alert.startsAt)))}
    </table>
  </td></tr>
  <tr><td style="padding:14px 28px;background:#f6f8fa;border-top:1px solid #e6e8eb;font-size:12px;color:#57606a;">
    <b style="color:#1f2328;">Grafana Alerts</b> &middot; Peko logging
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  return {
    subject: `🔴 New incident: [${job}]`,
    html,
    text: `New incident started\n\nCause: ${job}: error count > 0\nSource: ${job}${env ? ` / ${env}` : ''}\nError: ${error_message}\n` +
      `Current value: ${count}\nStarted at: ${formatTime(alert.startsAt)}\n\nView logs: ${logsUrl}\n`,
  };
}

// ---------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------
async function handleWebhook(payload) {
  const base = (payload.externalURL || 'http://localhost:3001/').replace(/\/?$/, '/');
  for (const alert of payload.alerts || []) {
    if (alert.status !== 'firing') continue;
    const logs = await fetchLogs(alert.labels, alert.startsAt).catch((err) => {
      console.error('[alert-mailer] Loki lookup failed:', err.message);
      return [];
    });
    const mail = renderEmail(alert, logs, base);
    await transporter.sendMail({ from: `Grafana Alerts <${FROM}>`, to: TO, ...mail });
    console.log(`[alert-mailer] sent: ${mail.subject} (${logs.length} log lines)`);
  }
}

http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/alert') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    try {
      await handleWebhook(JSON.parse(body));
      res.writeHead(200).end('ok');
    } catch (err) {
      console.error('[alert-mailer] failed:', err.message);
      res.writeHead(500).end(err.message); // Grafana retries on 5xx
    }
  });
}).listen(PORT, () => console.log(`[alert-mailer] listening on :${PORT}, sending to ${TO} via ${smtpHost}:${smtpPort}`));
