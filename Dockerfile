# audiolan for a computer that stays on: a Raspberry Pi, a NAS, a home server.
#
# Run it with host networking (see compose.yaml). The server has to see the
# LAN as it is: mDNS discovery is multicast on the LAN, the certificate names
# the computer's LAN addresses, and only devices on those subnets may connect.
# Behind Docker's bridge network it would see a container address instead.

FROM node:26-alpine

# openssl makes the household CA. mkcert is not used inside the image.
RUN apk add --no-cache openssl

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    AUDIOLAN_CERTS=/data/certs

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public

# The CA and the server certificate live here. Keep it on a volume: a new
# CA means every phone has to trust it again.
RUN mkdir -p /data/certs && chown -R node:node /data
VOLUME /data/certs

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "require('https').get({ host: '127.0.0.1', port: process.env.PORT, path: '/health', rejectUnauthorized: false }, (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
