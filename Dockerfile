# VOIDRUN — one image serving the 3D client + the Colyseus game server (same origin).
# Build context = this folder (voidrun-online/).  Build: docker build -t voidrun .
# Run:  docker run -p 2567:2567 voidrun   →   http://localhost:2567/
FROM node:20-slim
WORKDIR /app

# Install production server deps first (tsx is a prod dep, so --omit=dev is lean and still runs).
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund

# App source: server code + the 3D client (with vendored three.js/GLTFLoader/colyseus.js + GLB assets).
COPY server ./server
COPY client3d ./client3d

ENV NODE_ENV=production PORT=2567
EXPOSE 2567
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2567)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "--prefix", "server", "start"]
