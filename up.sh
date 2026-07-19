#!/usr/bin/env bash
# Avvia (o ricostruisce) la dashboard: ./up.sh [opzioni di docker compose up]
set -euo pipefail
cd "$(dirname "$0")"

export VRT_UID VRT_GID
VRT_UID="$(id -u)"
VRT_GID="$(id -g)"

docker compose up -d --build "$@"

echo
echo "Dashboard:  http://localhost:3000"
echo "Sito demo:  http://localhost:8081"
