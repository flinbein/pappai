FROM node:24-alpine
WORKDIR /opt/pappai
RUN apk add --no-cache bubblewrap python3
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY public ./public
COPY examples ./examples
ENV HOST=0.0.0.0 PORT=8080 PAPPAI_DB=/var/lib/pappai/workspace.sqlite PAPPAI_TEMP_ROOT=/var/lib/pappai/tmp
RUN mkdir -p /var/lib/pappai/tmp
EXPOSE 8080
CMD ["node", "src/server.ts"]
