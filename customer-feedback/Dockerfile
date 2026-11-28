FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
CMD ["node","server.mjs"]
