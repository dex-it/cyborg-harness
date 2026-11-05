#!/bin/sh
# Собирает библиотеки в IIFE-бандлы, которые host-ses2.js исполняет внутри Compartment.
# Запуск из этой папки: sh build-libs.sh (нужны npm install здесь и установленный esbuild в корне репозитория).
set -e
REPO="${CYBORG_REPO:-$(cd ../../../.. && pwd)}"
mkdir -p bundles
for lib in lodash zod ajv marked dayjs; do
  "$REPO/node_modules/.bin/esbuild" "./node_modules/$lib" --bundle --format=iife --global-name=Lib \
    --platform=neutral --main-fields=module,main --outfile="bundles/$lib.js" --log-level=error
done
