#!/bin/sh
# Docker entrypoint for Rev4a
# Copies persistent .env from data/ volume to root so Next.js finds it.
# If data/.env doesn't exist, rev4a serve will generate it on first run
# and save it to data/ for future container recreates.

set -e

cd /rev4a

if [ -f /rev4a/data/.env ]; then
  echo "[entrypoint] Copying persistent .env from data/ volume..."
  cp /rev4a/data/.env /rev4a/.env
  chmod 600 /rev4a/.env
elif [ -f /rev4a/.env ]; then
  echo "[entrypoint] Copying existing .env to data/ volume for persistence..."
  cp /rev4a/.env /rev4a/data/.env
  chmod 600 /rev4a/data/.env
fi

exec "$@"
