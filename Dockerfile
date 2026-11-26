FROM node:24-alpine
WORKDIR /opt/pappai
RUN apk add --no-cache bubblewrap git jq nano python3
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
RUN install -m 0755 src/pappai /usr/local/bin/pappai
COPY scripts/install-web.mjs scripts/prepare-runner.mjs scripts/runner-storage.mjs ./scripts/
COPY examples ./examples
ENV HOST=0.0.0.0 PORT=8080 PAPPAI_DB=/var/lib/pappai/workspace.sqlite PAPPAI_TEMP_ROOT=/var/lib/pappai/tmp PAPPAI_WEB_ROOT=/run/pappai/web
RUN mkdir -p /var/lib/pappai/tmp
EXPOSE 8080
CMD ["node", "src/server.ts"]
