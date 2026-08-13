FROM node:22-slim

# ffmpeg for video work; Chromium deps for Playwright (Frame.io capture)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
RUN npx playwright install --with-deps chromium

COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Persistent state (runs/, reports/, data/) lives on a mounted volume at /persist.
ENV PORT=3000
EXPOSE 3000
CMD ["./docker-entrypoint.sh"]
