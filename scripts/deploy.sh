#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="pdf-viewer"
DEST="/home/deck/homebrew/plugins/${PLUGIN_ID}"

sudo mkdir -p "${DEST}"
sudo rsync -a --delete \
  ./dist/ \
  ./main.py ./plugin.json ./package.json \
  "${DEST}/"
echo "Deployed to ${DEST}"
