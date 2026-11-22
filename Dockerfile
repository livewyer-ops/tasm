# syntax=docker/dockerfile:1
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS node
FROM rust:1.99.1-bookworm@sha256:e6f2cff35d0f309acf8433b4f05878ed77092602c5065cc81801177da0bb3a9c AS build
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
WORKDIR /app
COPY rust-toolchain.toml ./
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && rustup target add wasm32-unknown-unknown \
    && cargo install wasm-bindgen-cli --version 0.2.104 --locked
COPY package.json package-lock.json ./
RUN npm ci
COPY Cargo.toml Cargo.lock tsconfig.json LICENSE NOTICE ./
COPY core/ core/
COPY apps/ apps/
COPY contracts/tams/api/ contracts/tams/api/
COPY deploy/_headers deploy/_headers
COPY licenses/ licenses/
COPY tests/browser/ tests/browser/
COPY tests/contract/ tests/contract/
COPY tests/app-logic.test.ts tests/pglite-core.test.ts tests/
COPY scripts/build.mjs scripts/cloudflare.mjs scripts/package-cloudflare.mjs scripts/bundle-options.mjs scripts/apps.mjs scripts/deploy.mjs scripts/notices.mjs scripts/
RUN npm run build && npm run check

FROM build AS checks
COPY tests/segmentation.mjs tests/artifacts.mjs tests/ui-preview.mjs tests/cloudflare.mjs tests/
COPY scripts/serve.mjs scripts/check-cloudflare-package.sh scripts/
COPY tests/media/ tests/media/
RUN cargo test --locked \
    && cargo clippy --locked --all-targets -- -D warnings \
    && npm run test:segments \
    && npm run test:logic \
    && npm run test:pglite \
    && npm run test:preview \
    && npm run test:artifacts \
    && npm run check:cloudflare \
    && npm run test:cloudflare \
    && node scripts/package-cloudflare.mjs \
    && sh scripts/check-cloudflare-package.sh

FROM node AS test-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ARG PLAYWRIGHT_BROWSER="chromium firefox webkit"
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg pulseaudio \
    && npx playwright install --with-deps ${PLAYWRIGHT_BROWSER} \
    && mkdir -p /app/.local /app/test-results /app/playwright-report \
    && chown node:node /app /app/.local /app/test-results /app/playwright-report

FROM test-deps AS test-runner
COPY --from=build /app/pkg/operations.json pkg/operations.json
COPY tests/browser/ tests/browser/
COPY tests/contract/ tests/contract/
COPY tests/media/ tests/media/
COPY playwright.config.ts ./
COPY apps/ apps/
COPY core/browser/ core/browser/
COPY deploy/_headers deploy/_headers
COPY tsconfig.json ./
COPY scripts/serve.mjs scripts/apps.mjs scripts/test-browser.sh scripts/
USER node
ENV HOME=/home/node
CMD ["sh", "scripts/test-browser.sh"]

FROM test-runner AS test
COPY --from=checks /app/dist/ dist/
RUN sh scripts/test-browser.sh
