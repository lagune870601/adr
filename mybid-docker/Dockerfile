FROM cloakhq/cloakbrowser:latest

LABEL description="mybid visitor with local mitmproxy and bundled ip-allocator"
LABEL maintainer="dev"

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

RUN pip3 install --no-cache-dir --upgrade pip \
 && pip3 install --no-cache-dir mitmproxy requests

COPY botAnti3.py entrypoint.single.sh prefix.sh mybid.js ./
COPY shared/ ./shared/
COPY ip-allocator/index.js ./ip-allocator/index.js
RUN chmod +x entrypoint.single.sh prefix.sh

EXPOSE 18008 18010
STOPSIGNAL SIGTERM

CMD ["/app/entrypoint.single.sh"]