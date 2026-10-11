# OpenBot's computer service as an E2B sandbox template. Release pins are injected from
# deployment/computers/release.json by the SDK build script. Build with `npm run computers:e2b:template`.
FROM ubuntu:24.04

ARG OPENBOT_REVISION
ARG NODE_VERSION
ARG BUN_VERSION
ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Use a literal path: the E2B SDK's Dockerfile conversion does not expand ENV values.
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xz-utils procps \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
     | tar -xJ -C /usr/local --strip-components=1 --exclude='*/CHANGELOG.md' --exclude='*/README.md' \
  && curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip \
  && unzip -q /tmp/bun.zip -d /tmp && mv /tmp/bun-linux-x64/bun /usr/local/bin/bun && chmod +x /usr/local/bin/bun \
  && ln -s bun /usr/local/bin/bunx \
  && rm -rf /tmp/* /var/lib/apt/lists/*

# The computer service source, fetched from the pinned OpenBot revision. Chromium is
# installed by the service's own Playwright so the browser build always matches it.
WORKDIR /app
RUN curl -fsSL "https://github.com/CopilotKit/OpenBot/archive/${OPENBOT_REVISION}.tar.gz" \
     | tar -xz --strip-components=2 "OpenBot-${OPENBOT_REVISION}/agent-computer/package.json" \
       "OpenBot-${OPENBOT_REVISION}/agent-computer/bun.lock" "OpenBot-${OPENBOT_REVISION}/agent-computer/src" \
  && bun install --frozen-lockfile \
  && bunx playwright install --with-deps chromium \
  && chmod -R a+rX /ms-playwright \
  && rm -rf /root/.bun/install/cache /root/.cache /var/lib/apt/lists/*

# Durable directories the service uses. The app chowns them to the sandbox's `user`
# account at start, and passes WORKSPACE_DIR, PROFILES_DIR, PORT and
# PLAYWRIGHT_BROWSERS_PATH itself: Dockerfile ENV does not reach sandbox processes.
COPY deployment/computers/LICENSE.openbot /app/LICENSE.openbot
RUN mkdir -p /workspace /profiles
