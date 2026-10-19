FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json server.js s3.js xml.js ./
COPY --chown=node:node public ./public
USER node
EXPOSE 9090
CMD ["node", "server.js"]
