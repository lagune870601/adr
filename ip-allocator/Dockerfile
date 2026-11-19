FROM node:20-alpine

LABEL description="mybid unique IP allocator"

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./

EXPOSE 18010
CMD ["node", "index.js"]