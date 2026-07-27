#!/bin/sh
# Docker entrypoint for Olympus
# Copies persistent .env from data/ volume to root so Next.js finds it.
# If data/.env doesn't exist, olympus serve will generate it on first run
# and save it to data/ for future container recreates.

set -e

cd /olympus

if [ -f /olympus/data/.env ]; then
  echo "[entrypoint] Copying persistent .env from data/ volume..."
  cp /olympus/data/.env /olympus/.env
  chmod 600 /olympus/.env
elif [ -f /olympus/.env ]; then
  echo "[entrypoint] Copying existing .env to data/ volume for persistence..."
  cp /olympus/.env /olympus/data/.env
  chmod 600 /olympus/data/.env
fi

exec "$@"
