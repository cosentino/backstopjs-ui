# L'immagine ufficiale BackstopJS contiene già Node, il CLI backstop e
# Chromium: aggiungiamo solo la web UI.
FROM backstopjs/backstopjs:6.3.25

# L'entrypoint dell'immagine è "backstop": lo azzeriamo per avviare il server.
ENTRYPOINT []

WORKDIR /app
COPY app/package*.json ./
RUN npm install --omit=dev
COPY app/ ./

ENV DATA_DIR=/data \
    PORT=3000 \
    NODE_ENV=production

EXPOSE 3000
CMD ["node", "server.js"]
