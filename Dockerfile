# ── Olympus Docker Image ────────────────────────────────────────────────────
# Public image, pullable without authentication.
# Olympus self-bootstraps on first run: env, Next.js build, agent image pull.
#
# Usage:
#   docker run -d --name olympus \
#     -v olympus-data:/olympus/data \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -p 3740:3740 \
#     ghcr.io/flame0510/olympus:latest
#
# Data persistence:
#   .env is stored in /olympus/data/.env (survives container recreates)
#   and copied to /olympus/.env on startup for Next.js compatibility.
#   All databases, credentials, and tokens live in the data/ volume.
#
# To update: docker pull ghcr.io/flame0510/olympus:latest && docker rm -f olympus && docker run ... (same flags)
#     OR use the built-in update banner in the Olympus dashboard.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim

# Install Docker from official repo (Debian docker.io package is too old — v1.41 vs v1.44 required)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl ca-certificates gnupg lsb-release \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /olympus

# Copy source and install dependencies (skip postinstall — handled by olympus serve)
COPY . .
RUN npm install --omit=dev --ignore-scripts

# Entrypoint: ensures .env is copied from persistent volume to root before serve
COPY bin/docker-entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint

EXPOSE 3740
ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["node", "bin/olympus.js", "serve"]
