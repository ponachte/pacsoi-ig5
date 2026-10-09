FROM node:20-alpine

WORKDIR /app
COPY mock/pod-server.js ./mock/pod-server.js
COPY src/mock/data.js ./src/mock/data.js

EXPOSE 3001
USER node
CMD ["node", "mock/pod-server.js"]
