# OpenClaw release parser fixtures

These fixtures are trimmed from the real local 2026.9.3, 2026.9.9 and 2026.10.10
evaluation snapshots captured on 2026-11-06. Each JSON file names its source snapshot
items. The 10.10 pending-browser sample comes from the later after-sync snapshot.

Only fields consumed by the tested production parsers are retained. Identifiers,
names, model names, account addresses, device details, timestamps, quantities and
the bot token are deterministic placeholders. No transcripts, prompts, delivery
destinations, public keys, credential values, host paths or native tokens remain.
Cron schedule expressions, declaration ownership and enum values retain their
recorded meaning. List samples are trimmed; their counters describe the retained
rows. A populated history entry records an earlier successful run and does not
prove that executing the job on the target release succeeds.

Run `node scripts/test-openclaw-contracts.mjs`. The suite loads actual production
parsers, blocks external transports and compares their normalized fields. It also
checks malformed versus valid-empty answers where the parser exposes that
distinction. Quota and browser row conversion tests do not validate complete error
envelopes or authentication. No daemon, Docker or model provider is started.

This suite changes no runtime code, schema, files inside agents, image support,
startup behavior or public API. Existing data and rollback formats are untouched;
the older releases remain explicit fixture inputs. Live delivery, authorization,
mutations, migrations and recovery require their separate acceptance tests.
