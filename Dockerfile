FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production GUC_LOCAL_DOCKER=true PORT=3000
COPY --chown=node:node package.json index.html vercel.json *.js *.css ./
COPY --chown=node:node assets ./assets
COPY --chown=node:node api/inventory.js api/quotation.js api/public-config.js api/nas.mjs ./api/
COPY --chown=node:node docker ./docker
USER node
EXPOSE 3000
CMD ["node", "docker/server.mjs"]
