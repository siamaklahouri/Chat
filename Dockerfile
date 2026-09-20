# تصویر سبک برای اجرای پیام‌رسان روی سرور
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# فقط وابستگی‌های اجرا نصب می‌شوند تا تصویر کوچک بماند.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY scripts ./scripts

# داده‌ها (پایگاه‌داده و عکس‌ها) روی والیوم می‌مانند تا با به‌روزرسانی پاک نشوند.
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health > /dev/null || exit 1

CMD ["node", "server/index.js"]
