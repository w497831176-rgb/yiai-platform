# Ubuntu deployment

## Runtime layout

The active Ubuntu release is addressed through a stable link:

```text
/srv/yiai-platform/current -> /srv/yiai-platform/releases/<release>
```

Persistent and secret material is deliberately outside the release directory:

```text
/srv/yiai-platform/data/postgres      PostgreSQL data
/srv/yiai-platform/data/icon-cache    cached YIAI application icons
/srv/yiai-platform/secrets/.env       application secrets, mode 0600
/srv/yiai-platform/backup-staging     short-lived database exports and backup work
```

`compose.ubuntu.yml` is the only Compose file used by the Ubuntu runtime. The database is loopback-only on port `5432`; the API is loopback-only on port `3000`; the web reverse proxy listens on `192.168.50.112:18114`.

The API and web containers use host networking on Ubuntu. This is intentional: the existing Mihomo/TUN configuration provides the working outbound path to YIAI. No Mihomo configuration, DNS, route, forwarding rule, or existing proxy port is modified by this deployment.

## Start and inspect

```bash
sudo systemctl status yiai-platform.service
docker compose --env-file /srv/yiai-platform/secrets/.env \
  -f /srv/yiai-platform/current/compose.ubuntu.yml ps
curl --fail http://192.168.50.112:18114/api/health
```

The service is enabled at boot. It uses `--no-build`; a deliberate release update must build and validate the target release before restarting the service.

## Entry path and rollback

The Ubuntu instance is first validated through the LAN address above. Until cutover, the public HTTPS path remains served by the NAS reverse proxy and the old NAS application remains untouched.

The low-risk final topology is:

```text
public tunnel/domain -> NAS HTTPS reverse proxy -> Ubuntu 192.168.50.112:18114
```

This still leaves the public tunnel, certificate and HTTPS reverse proxy on the NAS. A later, separate change is required to move the public edge completely off the NAS.

Rollback is immediate: restore the NAS reverse-proxy upstream to the preserved local NAS application, then leave the Ubuntu containers running only for diagnosis. Do not delete the NAS source deployment or its data during the first 14 days after cutover.

## External dependency

YIAI Platform is a portal, not the YIAI/Dify server. Chatflow requests continue to use the configured YIAI API endpoint. The migration does not move, edit or stop that upstream service.
