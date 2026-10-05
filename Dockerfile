FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
# pg-native links against libpq (PostgreSQL's client library).
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libpq-dev python3 \
 && rm -rf /var/lib/apt/lists/* \
 && npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 UPLOAD_DIR=/data/uploads
VOLUME /data
EXPOSE 3000
CMD ["node","server.js"]
