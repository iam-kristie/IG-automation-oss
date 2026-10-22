FROM node:22.23.4-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /usr/local/share/empty-ca-directory
ENV NODE_OPTIONS=--use-openssl-ca \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_DIR=/usr/local/share/empty-ca-directory
WORKDIR /app
COPY scripts/verify-tls.cjs ./scripts/verify-tls.cjs
RUN node scripts/verify-tls.cjs --offline
COPY package.json package-lock.json ./
RUN npm ci --production
COPY . .
EXPOSE 3100
CMD ["node", "webhook/server.js"]
