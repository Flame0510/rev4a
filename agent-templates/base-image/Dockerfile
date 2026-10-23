# OpenClaw Agent Base Image
#
# Base image for agent containers in the Rev4a ecosystem.
# Includes: Node, OpenClaw, gh CLI, jq, Vercel CLI, Supabase CLI, entrypoint.
# Built natively for linux/amd64 and linux/arm64 and published as one multi-arch tag.
#
# The agent's persistent volume is mounted at /root. Whatever this image writes
# under /root (openclaw.json, installed plugins) reaches only agents created on an
# empty volume. Settings every agent must have are re-applied by Rev4a at create
# and recreate (lib/agent-setup.ts); the config patches below only seed new volumes.
#
# Build:
#   docker build -t openclaw-agent-base:2026.9.9 -f Dockerfile .
#   docker build --build-arg OPENCLAW_VERSION=<version> -t openclaw-agent-base:<version> .
#
# Test:
#   docker run --rm openclaw-agent-base:2026.9.9 openclaw --version

FROM node:24-bookworm-slim

# The OpenClaw release this image runs, also recorded as a label so it can be read
# with `docker image inspect` without starting a container.
ARG OPENCLAW_VERSION=2026.9.9
ARG SUPABASE_VERSION=2.109.1
# The short commit sha of this build; the workflow passes it. It matches the immutable
# `<version>-<sha>` tag, which is what lib/agent-versions.json's `imageRevision` names.
ARG IMAGE_REVISION=dev

LABEL description="OpenClaw Agent Base — Rev4a multicontainer ecosystem"
LABEL maintainer="Rev4a Agency"
LABEL org.opencontainers.image.version="${OPENCLAW_VERSION}"
LABEL org.opencontainers.image.revision="${IMAGE_REVISION}"

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

# System dependencies (jq is needed by the bundled OpenClaw trello skill) + gh CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    openssl \
    gpg \
    jq \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Agent containers route model requests through Rev4a provider proxy.
#
# --allow-scripts=openclaw: npm 11.16+ blocks install scripts unless allowed, and
# without them the OpenClaw install is silently incomplete (native prebuilds and
# bundled-plugin postinstall steps never run).
#
# Supabase CLI comes from its GitHub release (npm global is not supported on Linux),
# for the architecture being built: amd64 and arm64 in CI, each on a native runner.
#
# gateway.controlUi.dangerouslyDisableDeviceAuth is not set: OpenClaw 9.x retired
# it, ignores it and `doctor --fix` removes it. Browsers pair through device approval.
RUN npm install -g "openclaw@${OPENCLAW_VERSION}" vercel --allow-scripts=openclaw \
    && ARCH="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/supabase/cli/releases/download/v${SUPABASE_VERSION}/supabase_linux_${ARCH}.tar.gz" -o /tmp/supabase.tar.gz \
    && tar xzf /tmp/supabase.tar.gz -C /usr/local/bin supabase \
    && chmod +x /usr/local/bin/supabase \
    && rm /tmp/supabase.tar.gz \
    && echo '{"gateway":{"mode":"local","controlUi":{"dangerouslyAllowHostHeaderOriginFallback":true}}}' \
       | openclaw config patch --stdin

# Default config directory + shared-skills extraDirs pre-wired.
# Also pre-wires the bootstrap-extra-files hook to inject Rev4a system rules
# from workspace/.rev4a/ (mounted read-only by the Rev4a create route).
# Note: config patch deep-merges objects, replaces arrays.
# These two sections (skills + hooks) target different config paths so they
# are merged independently — the second patch does not overwrite the first.
RUN mkdir -p /data/.openclaw \
    && echo '{"skills":{"load":{"extraDirs":["/data/.openclaw/shared-skills"]}}}' \
       | openclaw config patch --stdin \
    && echo '{"hooks":{"internal":{"entries":{"bootstrap-extra-files":{"enabled":true,"paths":[".rev4a/*.md"]}}}}}' \
       | openclaw config patch --stdin

# Plugins shipped with the image live outside /root, where the agent volume cannot
# hide them, so they reach existing agents too. Each is pinned to the OpenClaw
# release: a newer plugin can require a newer plugin API, and OpenClaw then skips it
# at load. Install scripts stay disabled, as `openclaw plugins install` does.
# The entrypoint adds these directories to plugins.load.paths.
#
# duckduckgo: key-free web_search provider. OpenClaw never auto-selects it, so the
# entrypoint sets it as the provider when none is configured.
RUN mkdir -p /opt/openclaw-plugins \
    && cd /opt/openclaw-plugins \
    && npm install --no-save --ignore-scripts "@openclaw/duckduckgo-plugin@${OPENCLAW_VERSION}" \
    && test -f node_modules/@openclaw/duckduckgo-plugin/openclaw.plugin.json

# Durable apt installs. Only /root (the agent volume) survives a recreate, an OpenClaw
# update or a restore; what an agent installs with apt lives in the container layer and
# would be lost. rev4a-apt stands in for apt-get and apt (/usr/local/sbin comes before
# /usr/bin on PATH), records what is installed in /root/.rev4a/packages.txt and saves
# the apt sources and keyrings that are not part of the image; the entrypoint starts
# rev4a-packages-restore, which installs again what is missing. The baseline lists the
# apt files this image ships, so they are not copied to the volume. It is written last,
# after every apt step above, and the symlinks come after it so no build step is recorded.
COPY rev4a-apt /usr/local/sbin/rev4a-apt
COPY rev4a-packages-restore /usr/local/sbin/rev4a-packages-restore
RUN chmod 0755 /usr/local/sbin/rev4a-apt /usr/local/sbin/rev4a-packages-restore \
    && mkdir -p /usr/local/share/rev4a \
    && /usr/local/sbin/rev4a-apt --list-config > /usr/local/share/rev4a/apt-baseline \
    && ln -s rev4a-apt /usr/local/sbin/apt-get \
    && ln -s rev4a-apt /usr/local/sbin/apt

# Tools an agent installs under /root/.local survive a recreate; this puts its bin
# directory on PATH (after the system directories, so it never shadows them).
ENV PATH="${PATH}:/root/.local/bin"

# Standard entrypoint, and the helper that decides how it hands the token to the gateway
COPY rev4a-gateway-auth /usr/local/sbin/rev4a-gateway-auth
RUN chmod 0755 /usr/local/sbin/rev4a-gateway-auth
COPY entrypoint.sh /agent-entrypoint.sh
RUN chmod +x /agent-entrypoint.sh

WORKDIR /data
EXPOSE 3000

ENTRYPOINT ["/agent-entrypoint.sh"]
CMD ["openclaw", "gateway", "--bind", "lan", "--port", "3000"]
