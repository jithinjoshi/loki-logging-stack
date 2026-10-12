# Logging & Alerting Stack: Winston → Alloy → Loki → Grafana

A self-hosted logging and alerting stack. Apps push their logs here; Grafana shows them and emails the team when errors happen.
Everything in this folder is **one deployment**: start it with a single `docker compose up -d --build`.

```
                       ┌───────────────── monitoring stack (this folder, one docker-compose) ─────────────────┐
┌──────────────┐ push  │ ┌─────────────┐    ┌─────────┐    ┌────────┐ query ┌─────────┐ webhook ┌──────────────┐│ SMTP  ┌──────────┐
│ users-ms,    │──────▶│ │ log-gateway │───▶│  Alloy  │───▶│  Loki  │◀──────│ Grafana │────────▶│ alert-mailer ││──────▶│ SendGrid │
│ POC app, ... │ :3500 │ │ (secret key)│    │ (parse) │    │ (store)│◀──┐   │ (UI +   │         │ (incident    ││       └──────────┘
└──────────────┘       │ └─────────────┘    └─────────┘    └────────┘   │   │ alerts) │         │  emails)     ││
                       │                                                └───┼─────────┼─────────┴──────────────┘│
                       │                                     reads matching log lines for the email            │
                       └────────────────────────────────────────────────────────────────────────────────────────┘
```

| Service | What it does |
|---------|--------------|
| **log-gateway** | nginx. The only way in: accepts log pushes on port 3500 only with `Authorization: Bearer <LOG_INGEST_KEY>`, otherwise `401`. |
| **Alloy** | Parses each JSON log line (`level`, `service`, `timestamp`, `traceId`), adds labels and pushes to Loki. |
| **Loki** | Stores the logs (7-day retention) and indexes them by label. |
| **Grafana** | Dashboard **POC → App Logs**, Explore, and the alert rule **Error logs detected**. |
| **alert-mailer** | Small Node service. When an alert fires, Grafana calls it; it fetches the matching log lines from Loki and sends the incident email. |
| **mailpit** | Local test inbox (http://localhost:8025). Only used when no real SMTP is configured. |

### Why alert-mailer is part of this stack
Grafana's own emails can't contain log lines: an alert only knows numbers and labels. alert-mailer adds the
"Surrounding logs" and stack trace. It belongs to the monitoring stack, **not** to an app:

- it deploys with Grafana (same compose file, no separate repo or pipeline);
- it has no public port; only Grafana talks to it;
- if an app (e.g. users-ms) is down, its alerts still go out.

## Run it

```bash
cp .env.example .env      # then fill in the values (see below)
docker compose up -d --build
```

| URL | |
|-----|---|
| http://localhost:3001 | Grafana (`admin` / `admin`, change it) |
| http://localhost:3500 | Log push endpoint for apps (needs the secret key) |
| http://localhost:8025 | Mailpit test inbox |
| http://localhost:12345 | Alloy UI (this machine only) |
| http://localhost:3100/ready | Loki health (this machine only) |

## Configuration (`.env`, never commit it)

| Variable | Used by | Meaning |
|----------|---------|---------|
| `LOG_INGEST_KEY` | log-gateway | Secret key apps must send. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ALERT_EMAILS` | alert-mailer | Comma-separated recipients |
| `SMTP_HOST` | alert-mailer, Grafana | e.g. `smtp.sendgrid.net:587`. Empty = local Mailpit |
| `SMTP_USER` / `SMTP_PASSWORD` | alert-mailer, Grafana | SendGrid: `apikey` / a restricted *Mail Send* API key |
| `SMTP_FROM` | alert-mailer, Grafana | Verified sender, e.g. `alerts@pekoapp.com` |

## Connecting an app (users-ms example)

The app pushes logs with [`winston-loki`](https://github.com/JaniAnttonen/winston-loki) to the gateway. In the app's `.env`:

```ini
LOG_TO_ALLOY=true
ALLOY_URL=http://localhost:3500        # or the server's gateway URL (use https:// off the local machine)
ALLOY_API_KEY=<same value as LOG_INGEST_KEY>
```

Each app uses its own `job` label (`users`, `express-app`, …), so the dashboard's **Service** dropdown and the
alerts can tell them apart.

## Alerts

Rule: [grafana/provisioning/alerting/error-logs.yaml](grafana/provisioning/alerting/error-logs.yaml)

- Every minute Grafana counts `level="error"` lines per **service + error message** over the last 5 minutes.
- A **new** error → incident email within ~1–1.5 min (subject `🔴 New incident: [<service>]`).
- The **same** error again within 5 minutes → no new email; still happening → one reminder every 5 minutes.
- No "resolved" emails.

Email layout: `renderEmail()` in [alert-mailer/index.js](alert-mailer/index.js). After changing it:
`docker compose up -d --build alert-mailer`.

**Test it** (users-ms running locally): `curl http://localhost:4445/api/v1/test-error-log` → users-ms logs
"Session key missing" at error level → email arrives. To test without real emails, empty the `SMTP_*` values and
check http://localhost:8025.

## Searching logs (Grafana)

Dashboard **POC → App Logs**: pick **Service** / **Level**, paste a **Trace ID**, or type any text in **Search**
(case-insensitive). For field filters use **Explore → Loki → Code**:

```logql
{job="users"} | traceId="<id>"
{job="express-app"} | json | status >= 500
{job="users"} | json | line_format "{{.message}}" | json | request_httpMethod="POST"
```

Labels stay few (`job`, `env`, `level`, `service`). `traceId` is stored as structured metadata, not a label;
never make per-request values (user IDs, trace IDs, paths) into labels.

## Project layout

```
├── docker-compose.yml                  # the whole stack
├── .env                                # secrets + email settings (gitignored)
├── log-gateway/default.conf.template   # secret-key check in front of Alloy
├── alloy/config.alloy                  # receive push → parse JSON → Loki
├── loki/loki-config.yaml               # single-node Loki, local disk, 7-day retention
├── alert-mailer/                       # Grafana webhook → incident email with log lines
│   ├── Dockerfile
│   └── index.js
├── grafana/provisioning/
│   ├── datasources/loki.yaml           # Loki + clickable traceId links
│   ├── dashboards/express-logs.json    # App Logs dashboard
│   └── alerting/                       # alert rule, contact point (→ alert-mailer), policy
└── app/                                # POC Express app (runs locally: cd app && npm start)
```

## Deploying to a server

Deploy **this whole folder** as one unit; alert-mailer comes with it.

1. Copy the folder, create `.env` with production values, run `docker compose up -d --build`.
2. Change the Grafana admin password (`GF_SECURITY_ADMIN_PASSWORD`) or put Grafana behind Azure AD SSO.
3. Put HTTPS in front of the gateway (port 3500) and Grafana (port 3001). The secret key travels in a header, so
   plain HTTP outside a private network would expose it.
4. Set `GRAFANA_URL` in `.env` to Grafana's public URL, so the email buttons open the right place.
5. Keep Loki (3100), Alloy (12345), alert-mailer and Mailpit private (already bound to localhost or not published).

On Azure Container Apps, run the same services in one Container Apps environment: gateway and Grafana with ingress,
the rest internal-only. alert-mailer can also run as a sidecar container in Grafana's app.

## Stop / reset

```bash
docker compose down        # stop, keep data
docker compose down -v     # stop and delete all logs, Grafana data and alert state
```
