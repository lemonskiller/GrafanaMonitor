FROM docker.m.daocloud.io/library/node:24.4.1-alpine3.22

WORKDIR /app
COPY server.mjs /app/server.mjs

USER node
EXPOSE 11435
CMD ["node", "/app/server.mjs"]
