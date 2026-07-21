# NAS backup and recovery

## Implemented backup design

The NAS SSH service supports normal SSH commands but not the SFTP subsystem required by Restic's SFTP backend. The implemented fallback is therefore:

```text
consistent PostgreSQL dump + icon cache + deployment config + .env
  -> tar.gz
  -> age encryption
  -> SHA-256 manifest
  -> atomic SSH upload to NAS dedicated backup directory
```

The NAS only receives encrypted archives. Transfer is encrypted by SSH as well. The NAS account is `yiai_backup`, has no administrator membership, and is limited to its home and dedicated backup directory. Its random password is not retained; automated access uses the Ubuntu-only SSH key.

The backup contains the PostgreSQL logical dump, icon cache, Compose and Docker configuration, systemd unit files, a release/image manifest, and encrypted application `.env`. It intentionally excludes logs, build cache, node modules, Docker layers and temporary files.

## Schedule and retention

```bash
systemctl list-timers --all yiai-platform-backup.timer yiai-platform-backup-check.timer
```

- Backup: every six hours (`00:15`, `06:15`, `12:15`, `18:15` in the host timezone).
- Retention: all archives from the current day, then 14 daily, 8 weekly and 6 monthly restore points.
- Integrity check: monthly; downloads the newest archive, checks SHA-256, decrypts it and validates the archive listing.

The practical database RPO is six hours. The same-host isolated restore drill completed in under two minutes, far below the two-hour RTO target; hardware replacement and large future data volumes can increase real recovery time.

Useful day-to-day commands:

```bash
sudo systemctl start yiai-platform-backup.service
/srv/yiai-platform/current/ops/backup-status.sh
sudo systemctl start yiai-platform-backup-check.service
journalctl -u yiai-platform-backup.service -n 100 --no-pager
```

## Recovery key

The age identity remains in `/srv/yiai-platform/secrets/backup-age-key.txt` for automated recovery. Its independent recovery copy is stored in the current Windows user's Credential Manager under `YIAI-Platform-Age-Recovery`; it is never committed or printed.

Copy that recovery identity to an offline password manager or encrypted removable medium that is not kept with the Ubuntu machine. Losing both copies makes the encrypted NAS backups unrecoverable.

## Isolated restore drill

Run:

```bash
/srv/yiai-platform/current/ops/restore-drill.sh
```

The script restores the newest archive under `/srv/yiai-platform/restore-drill/`, starts a separate Compose project, uses PostgreSQL port `15432`, API port `13000` and web port `18115`, imports the restored dump, checks health, registers/deletes a temporary account, retrieves the application list and performs a real streaming YIAI chat. It does not alter the primary database or service.

After recording the evidence, clean up only that exact drill directory and project:

```bash
docker compose -p yiai-platform-restore-drill \
  --env-file /srv/yiai-platform/restore-drill/<timestamp>/restored.env \
  -f /srv/yiai-platform/current/compose.restore-drill.yml down
sudo rm -rf /srv/yiai-platform/restore-drill/<timestamp>
```

Never run this command against the primary Compose project and never add `-v` to a primary-service command.

## Full-service recovery

1. Keep the NAS source deployment stopped or read-only; do not delete it.
2. Restore into a fresh release/data path with `ops/restore-drill.sh` and verify it first on the drill ports.
3. Promote only after verifying data counts, login, application list and a real streaming response.
4. Point `current` to the verified release, restore `/srv/yiai-platform/data` from the drill data, then start `yiai-platform.service`.
5. Switch the reverse proxy only after the new primary health check passes. If any step fails, return the reverse proxy to the NAS source upstream.

NAS and Ubuntu are in the same residence. This backup protects against single-machine failure, not a house-wide event. The next recommended step is an opt-in encrypted third copy to a user-chosen off-site destination; it has not been enabled.
