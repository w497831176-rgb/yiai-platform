# Ubuntu migration record — 2026-07-21

## Scope

- Source preserved on NAS: `/volume3/docker/yiai-platform-test` and `/volume3/docker/volumes/yiai-platform-test`.
- Target: Ubuntu `192.168.50.112`, application release under `/srv/yiai-platform/releases/20260721-initial`.
- NAS source was backed up before migration and is not deleted.
- The upstream YIAI/Dify service was not migrated or changed.

## Data verification

The final Ubuntu primary and the isolated restored database both contained:

| Entity | Count |
| --- | ---: |
| users | 17 |
| yiai_apps | 9 |
| token_accounts | 17 |
| token_ledger_entries | 63 |
| yiai_usage_records | 32 |

## Functional verification

- LAN web/API health endpoint returned `ok`.
- Temporary registration and login succeeded.
- The application list loaded.
- A real YIAI Chatflow streaming request reached `message_end`.
- The temporary verification account was deleted.
- The same verification passed from the isolated restore project on port `18115`.

## Backup verification

- A PostgreSQL custom-format export and icon/config archive were encrypted with age and uploaded through the NAS dedicated SSH account.
- The latest archive passed its SHA-256 check, age decryption and tar listing check.
- The isolated restoration completed in 35 seconds on the current hardware, including application build/start and a real streaming chat smoke test.

## Remaining cutover task

At the time of this record the public HTTPS reverse proxy still points at the NAS application. The Ubuntu target is ready on `192.168.50.112:18114`. Switching that reverse-proxy upstream is a separate, reversible public-entry change and requires final confirmation.
