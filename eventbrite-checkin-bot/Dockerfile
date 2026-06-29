# This tag's version must exactly match the "playwright" version pinned in
# package.json — the image only ships browser binaries for that one version,
# and a mismatch fails every check-in with "Executable doesn't exist".
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends xvfb \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080

# headless: false (see src/browser.ts) needs a display even with no monitor —
# xvfb-run provides a virtual one. Running headed rather than headless is
# deliberate: it avoids the navigator.webdriver / headless-only fingerprints
# that bot-detection on a commercial ticketing site is most likely to check.
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x900x24", "npm", "start"]
