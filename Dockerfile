FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
COPY sync ./sync
COPY public ./public
ENV HOST=0.0.0.0 PORT=3311
EXPOSE 3311
VOLUME ["/app/data"]
CMD ["node", "server.mjs"]
