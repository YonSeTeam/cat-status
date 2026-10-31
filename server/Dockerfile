FROM node:24-alpine
WORKDIR /app
COPY server.js .
ENV PORT=9797
EXPOSE 9797
USER node
CMD ["node", "server.js"]
