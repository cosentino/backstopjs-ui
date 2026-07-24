#!/usr/bin/env bash
# Ferma la dashboard: ./down.sh [opzioni di docker compose down]
set -euo pipefail
cd "$(dirname "$0")"

docker compose down "$@"
