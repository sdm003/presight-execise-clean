FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY client/package*.json client/
COPY server/package*.json server/
RUN npm install
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app /app
RUN npm run seed
EXPOSE 3001
CMD ["npm", "start", "--workspace", "server"]
