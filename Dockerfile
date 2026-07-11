FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 7001

CMD ["npm", "start"]
