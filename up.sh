#!/usr/bin/env bash
# Avvia (o ricostruisce) la dashboard: ./up.sh [opzioni di docker compose up]
set -euo pipefail
cd "$(dirname "$0")"

export VRT_UID VRT_GID
VRT_UID="$(id -u)"
VRT_GID="$(id -g)"

# Scrivo .env con il mio UID/GID reali: Docker Compose lo legge in automatico,
# così ANCHE un "docker compose up" diretto (senza queste variabili esportate)
# usa l'utente giusto. Senza, il compose cade sul default 1000:1000 e i file
# generati non appartengono all'utente host -> EACCES sui run successivi.
cat > .env <<EOF
VRT_UID=$VRT_UID
VRT_GID=$VRT_GID
EOF

docker compose up -d --build "$@"

echo
echo "Dashboard:  http://localhost:3000"
echo "Sito demo:  http://localhost:8081"
