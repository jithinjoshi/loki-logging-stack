# Logging & Alerting Stack: VM Installation (no Docker)

This guide installs our central logging stack on one Ubuntu VM as plain **systemd services**, with **no Docker**.
Our Node.js microservices (starting with `users-ms`) push their logs to this VM. The team searches them in
Grafana, and an email goes out when a service logs an error.

- **Target OS:** Ubuntu 22.04 or 24.04 LTS (64-bit)
- **Suggested size:** 2 vCPU, 4 GB RAM, 50 GB+ disk (logs are kept for 7 days)
- **Time needed:** about 30–45 minutes

---

## 1. What gets installed

```
 app servers (users-ms, ...)
        │  HTTP POST /loki/api/v1/push   +  header  Authorization: Bearer <LOG_INGEST_KEY>
        ▼
 ┌──────────────────────────────── this VM ────────────────────────────────┐
 │  nginx :3500  ──(key OK)──►  Alloy 127.0.0.1:3501  ──►  Loki 127.0.0.1:3100 │
 │  (log gateway: rejects requests without the key)            ▲               │
 │                                                             │ queries       │
 │  nginx :80/:443  ──►  Grafana 127.0.0.1:3000  ──────────────┘               │
 │                          │ alert fires (webhook)                            │
 │                          ▼                                                  │
 │                    alert-mailer :8080  ──► reads log lines from Loki        │
 │                          │                                                  │
 └──────────────────────────┼──────────────────────────────────────────────────┘
                            ▼
                   SendGrid SMTP (smtp.sendgrid.net:587)  ──►  team inbox
```

| Component | What it does | Source | Runs as |
|---|---|---|---|
| **nginx** (log gateway) | Accepts log pushes on `:3500` only with the correct secret key (`401` otherwise) | apt | `nginx.service` |
| **nginx** (Grafana proxy) | Serves Grafana on `:80` / `:443` | apt | `nginx.service` |
| **Grafana Alloy** | Parses the JSON log lines, adds labels, forwards to Loki | apt (Grafana repo) | `alloy.service` |
| **Grafana Loki** | Stores the logs (7-day retention) | apt (Grafana repo) | `loki.service` |
| **Grafana** | UI, dashboard, alert rule | apt (Grafana repo) | `grafana-server.service` |
| **alert-mailer** | Small Node.js service from our repo. Turns Grafana alerts into incident emails that include the log lines | our repo | `alert-mailer.service` |

### Ports

| Port | Bind | Who must reach it |
|---|---|---|
| 22 | all | admins (SSH) |
| 80 / 443 | all | team (Grafana in the browser) |
| **3500** | all | **app servers only**: restrict by IP |
| 3000 (Grafana), 3100 (Loki), 3501 + 12345 (Alloy) | `127.0.0.1` | nothing outside the VM |
| 8080 (alert-mailer) | all, **blocked by firewall** | Grafana on the same VM only |

---

## 2. Before you start: get these from the dev team (Jithin)

| Item | Used for | Example |
|---|---|---|
| Repo access to `express-loki-poc` | config files + alert-mailer code | — |
| `LOG_INGEST_KEY` | secret key apps must send | 64-char hex string (or generate one, see step 9) |
| SendGrid API key (restricted, *Mail Send* only) | sending alert emails | `SG.xxxx` |
| Sender address, verified in SendGrid | `From:` of alert emails | `alerts@pekoapp.com` |
| Alert recipients | `To:` of alert emails | `dev-alerts@peko.one` |
| IP addresses of the app servers | firewall rule for port 3500 | — |
| Domain for Grafana (optional, recommended) | HTTPS | `grafana.peko.one` |

> Throughout this guide, replace every `<PLACEHOLDER>` with the real value. **Never commit these values to git.**

---

## 3. Install packages

```bash
sudo apt-get update
sudo apt-get install -y apt-transport-https gpg curl git nginx

# Grafana's apt repository (provides loki, alloy and grafana)
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://apt.grafana.com/gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/grafana.gpg
echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" \
  | sudo tee /etc/apt/sources.list.d/grafana.list
sudo apt-get update
sudo apt-get install -y loki alloy grafana

# Node.js 22 (for alert-mailer)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

node -v    # should print v22.x
```

## 4. Get the repo onto the VM

```bash
sudo git clone <REPO_URL> /opt/express-loki-poc
SRC=/opt/express-loki-poc
```

Only these folders are used: `grafana/provisioning/` and `alert-mailer/`. The `docker-compose.yml`,
`Dockerfile`s and `log-gateway/` template in the repo are for local Docker use and are **not** needed here.

---

## 5. Loki

Write the config (paths and listen addresses adjusted for a VM):

```bash
sudo tee /etc/loki/config.yml >/dev/null <<'EOF'
# Single-node Loki, local disk, 7-day retention.
auth_enabled: false

server:
  http_listen_address: 127.0.0.1
  http_listen_port: 3100
  grpc_listen_address: 127.0.0.1

common:
  instance_addr: 127.0.0.1
  path_prefix: /var/lib/loki
  storage:
    filesystem:
      chunks_directory: /var/lib/loki/chunks
      rules_directory: /var/lib/loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  retention_period: 168h   # keep logs for 7 days

compactor:
  working_directory: /var/lib/loki/compactor
  retention_enabled: true
  delete_request_store: filesystem
EOF

id loki >/dev/null 2>&1 || sudo useradd --system --no-create-home loki
sudo mkdir -p /var/lib/loki && sudo chown -R loki:loki /var/lib/loki
```

## 6. Alloy

```bash
sudo tee /etc/alloy/config.alloy >/dev/null <<'EOF'
// Receives log pushes (from nginx on :3500), parses the JSON lines, forwards to Loki.

// [1] Loki-compatible push endpoint. Only nginx talks to it (127.0.0.1:3501).
loki.source.api "app_logs" {
  http {
    listen_address = "127.0.0.1"
    listen_port    = 3501
  }
  forward_to = [loki.process.app_logs.receiver]
}

// [2] Parse each JSON log line
loki.process "app_logs" {
  stage.json {
    expressions = {
      level     = "level",
      service   = "service || service_name",
      timestamp = "timestamp || \"@timestamp\"",
      traceId   = "traceId",
    }
  }

  // traceId is per-request: store as structured metadata, never as a label
  stage.structured_metadata {
    values = {
      traceId = "",
    }
  }

  // Low-cardinality labels only
  stage.labels {
    values = {
      level   = "",
      service = "",
    }
  }

  // Use the app's own timestamp
  stage.timestamp {
    source = "timestamp"
    format = "RFC3339"
  }

  forward_to = [loki.write.local.receiver]
}

// [3] Push to Loki
loki.write "local" {
  endpoint {
    url = "http://127.0.0.1:3100/loki/api/v1/push"
  }
}
EOF

# Keep Alloy's own UI local-only
sudo sed -i 's#^CUSTOM_ARGS=.*#CUSTOM_ARGS="--server.http.listen-addr=127.0.0.1:12345"#' /etc/default/alloy
grep CUSTOM_ARGS /etc/default/alloy
```

## 7. Grafana

Copy the provisioning files (datasource, dashboard, alert rule) from the repo and point them at `127.0.0.1`:

```bash
sudo cp -r $SRC/grafana/provisioning/* /etc/grafana/provisioning/
sudo sed -i 's#http://loki:3100#http://127.0.0.1:3100#' /etc/grafana/provisioning/datasources/loki.yaml
sudo sed -i 's#http://alert-mailer:8080#http://127.0.0.1:8080#' /etc/grafana/provisioning/alerting/contact-points.yaml
sudo chown -R root:grafana /etc/grafana/provisioning

# Check: both should print the 127.0.0.1 URLs
grep -h "127.0.0.1" /etc/grafana/provisioning/datasources/loki.yaml /etc/grafana/provisioning/alerting/contact-points.yaml
```

Grafana settings:

```bash
sudo tee -a /etc/default/grafana-server >/dev/null <<'EOF'
GF_SERVER_HTTP_ADDR=127.0.0.1
GF_SERVER_ROOT_URL=<GRAFANA_PUBLIC_URL>
GF_SECURITY_ADMIN_PASSWORD=<STRONG_ADMIN_PASSWORD>
EOF
```

- `GF_SERVER_ROOT_URL`: the URL people open Grafana with, e.g. `https://grafana.peko.one` or `http://<VM_IP>`.
  The buttons in alert emails link here.
- `GF_SECURITY_ADMIN_PASSWORD` is only applied on Grafana's **first** start. To change it later:
  `sudo grafana cli admin reset-admin-password <NEW_PASSWORD>`.

## 8. alert-mailer

```bash
sudo cp -r $SRC/alert-mailer /opt/alert-mailer
cd /opt/alert-mailer && sudo npm install --omit=dev
sudo useradd --system --no-create-home alertmailer
```

Secrets file (readable by root only; systemd loads it before dropping privileges):

```bash
sudo tee /etc/alert-mailer.env >/dev/null <<'EOF'
LOKI_URL=http://127.0.0.1:3100
SMTP_HOST=smtp.sendgrid.net:587
SMTP_USER=apikey
SMTP_PASSWORD=<SENDGRID_API_KEY>
SMTP_FROM=<VERIFIED_SENDER_ADDRESS>
ALERT_EMAILS=<COMMA_SEPARATED_RECIPIENTS>
ALERT_TIMEZONE=Asia/Dubai
EOF
sudo chmod 600 /etc/alert-mailer.env
```

`SMTP_USER` is literally the word `apikey` for SendGrid.

systemd unit:

```bash
sudo tee /etc/systemd/system/alert-mailer.service >/dev/null <<'EOF'
[Unit]
Description=alert-mailer (Grafana alert webhook -> incident email)
After=network-online.target loki.service
Wants=network-online.target

[Service]
User=alertmailer
WorkingDirectory=/opt/alert-mailer
EnvironmentFile=/etc/alert-mailer.env
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

> alert-mailer listens on port **8080**. If something else on the VM already uses 8080, tell the dev team.

## 9. nginx: log gateway (port 3500)

If the dev team hasn't given you a key, generate one and **send it to them securely**. Every app needs it:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```bash
sudo tee /etc/nginx/conf.d/log-gateway.conf >/dev/null <<'EOF'
# Log gateway: the only way into Alloy. Rejects pushes without the secret key.
server {
  listen 3500;
  client_max_body_size 10m;

  location = /loki/api/v1/push {
    if ($http_authorization != "Bearer <LOG_INGEST_KEY>") {
      return 401;
    }
    proxy_set_header Authorization "";   # Alloy doesn't need the key
    proxy_pass http://127.0.0.1:3501;
  }

  location / {
    return 404;
  }
}
EOF
sudo chmod 640 /etc/nginx/conf.d/log-gateway.conf    # contains the key
```

## 10. nginx: Grafana (port 80)

```bash
sudo tee /etc/nginx/conf.d/grafana.conf >/dev/null <<'EOF'
server {
  listen 80;
  server_name <GRAFANA_DOMAIN_OR_UNDERSCORE>;   # e.g. grafana.peko.one, or _ when using the IP

  location / {
    proxy_set_header Host $host;
    proxy_pass http://127.0.0.1:3000;
  }

  # Grafana Live (websocket)
  location /api/live/ {
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_pass http://127.0.0.1:3000;
  }
}
EOF
sudo rm -f /etc/nginx/sites-enabled/default    # frees port 80
sudo nginx -t
```

## 11. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow from <APP_SERVER_IP_1> to any port 3500 proto tcp
# repeat for each app server IP
sudo ufw enable
sudo ufw status
```

**Azure VM:** add matching inbound rules in the VM's **Network Security Group** (22, 80, 443 and 3500 from the app
server IPs only). Do **not** open 3000, 3100, 3501, 8080 or 12345.

## 12. Start everything

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now loki alloy grafana-server alert-mailer
sudo systemctl restart nginx
```

---

## 13. Verify

Wait about 20 seconds after starting (Loki warms up), then run:

```bash
# All services active?
systemctl is-active loki alloy grafana-server alert-mailer nginx
#   expect five lines of: active

# Loki ready?
curl -s http://127.0.0.1:3100/ready
#   expect: ready

# Gateway rejects a push without the key...
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" \
  -d '{"streams":[]}' http://localhost:3500/loki/api/v1/push
#   expect: 401

# ...and accepts it with the key
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer <LOG_INGEST_KEY>" \
  -d '{"streams":[]}' http://localhost:3500/loki/api/v1/push
#   expect: 204

# alert-mailer started?
journalctl -u alert-mailer -n 5 --no-pager
#   expect: [alert-mailer] listening on :8080, sending to ... via smtp.sendgrid.net:587
```

In a browser, open `<GRAFANA_PUBLIC_URL>` and log in as `admin`. Check:
- **Dashboards → POC → App Logs** exists
- **Alerting → Alert rules → Error logs detected** exists
- **Connections → Data sources → Loki → Test** is green

### End-to-end test (with the dev team)
1. Dev team sets in the app's `.env`:
   ```ini
   LOG_TO_ALLOY=true
   ALLOY_URL=http://<VM_IP_OR_DOMAIN>:3500
   ALLOY_API_KEY=<LOG_INGEST_KEY>
   ```
2. They trigger an error (`users-ms`: `curl http://localhost:4445/api/v1/test-error-log`).
3. Within seconds the line appears in Grafana (**Service = users**, **Level = error**).
4. Within about 1–1.5 minutes an email **"🔴 New incident: [users]"** reaches the recipients.

---

## 14. Hand back to the dev team

- Grafana URL and admin credentials (send securely)
- The log push URL: `http://<VM_IP_OR_DOMAIN>:3500` (or `https://...` if you did step 15)
- `LOG_INGEST_KEY`, if you generated it (send securely)

---

## 15. HTTPS (strongly recommended)

Over plain HTTP, the log key and Grafana passwords travel in clear text. With a domain pointing at the VM:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <GRAFANA_DOMAIN>
```

For the log gateway, the simplest option is a second hostname on 443 (e.g. `logs.peko.one`). Duplicate the
`server` block from step 9 with `listen 80; server_name <LOGS_DOMAIN>;` instead of `listen 3500;`, run
`sudo certbot --nginx -d <LOGS_DOMAIN>`, then give the dev team `ALLOY_URL=https://<LOGS_DOMAIN>` and close port
3500. Afterwards update `GF_SERVER_ROOT_URL` to the `https://` URL and restart Grafana.

---

## Operations

| Task | Command |
|---|---|
| Service logs | `journalctl -u <loki\|alloy\|grafana-server\|alert-mailer\|nginx> -f` |
| Restart after a config change | `sudo systemctl restart <service>` (nginx: `sudo nginx -t && sudo systemctl reload nginx`) |
| Rotate the log key | edit `/etc/nginx/conf.d/log-gateway.conf` → reload nginx → dev team updates `ALLOY_API_KEY` in each app |
| Change alert recipients / SMTP | edit `/etc/alert-mailer.env` → `sudo systemctl restart alert-mailer` |
| Update alert-mailer code | `cd /opt/express-loki-poc && sudo git pull && sudo cp alert-mailer/index.js /opt/alert-mailer/ && sudo systemctl restart alert-mailer` |
| Update dashboard / alert rule | `sudo git pull`, repeat step 7's `cp` + `sed` commands, `sudo systemctl restart grafana-server` |
| Upgrade Loki / Alloy / Grafana | `sudo apt-get update && sudo apt-get install --only-upgrade loki alloy grafana` |
| Disk usage of logs | `sudo du -sh /var/lib/loki` |

**Back up:** `/var/lib/grafana` (Grafana state), `/etc/alert-mailer.env`, `/etc/nginx/conf.d/log-gateway.conf`,
`/etc/default/grafana-server`. Everything else can be recreated from the repo and this guide.
Log data in `/var/lib/loki` only covers 7 days, so backing it up is optional.

## Troubleshooting

| Symptom | Check |
|---|---|
| App gets `401` on push | Key in the app ≠ key in `log-gateway.conf` (watch for spaces/newlines) |
| App can't connect at all | `ufw status`, Azure NSG, `sudo ss -ltnp \| grep 3500` |
| Gateway returns `502` | Alloy down: `journalctl -u alloy -n 50` |
| Logs not in Grafana | `journalctl -u alloy -n 50` (parse/push errors), `curl -s 127.0.0.1:3100/ready` |
| Grafana shows no dashboard / alert rule | `journalctl -u grafana-server \| grep -i provision` |
| Alert fires but no email | `journalctl -u alert-mailer -n 50` (SMTP auth errors = wrong SendGrid key or unverified sender) |
| Email buttons open the wrong host | `GF_SERVER_ROOT_URL` in `/etc/default/grafana-server`, then restart Grafana |
| Loki won't start | `journalctl -u loki -n 50`; usually ownership of `/var/lib/loki` (`sudo chown -R loki:loki /var/lib/loki`) |
