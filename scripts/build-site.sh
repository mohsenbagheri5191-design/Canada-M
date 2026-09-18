#!/usr/bin/env bash
# Assemble the deployable site.
#
# Only the two things a person opens. The repository also holds migrations,
# platform notes and a .env example, and a static host that publishes the whole
# checkout serves all of it — so this copies rather than publishing the root.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/public"

rm -rf "$out"
mkdir -p "$out"

cp "$root/site/index.html" "$out/index.html"
cp -R "$root/app" "$out/app"
cp -R "$root/dashboard" "$out/dashboard"

# The app imports the registry and renderer straight out of dashboard/, by a
# relative path that walks up three levels. That path has to survive the copy,
# which it does because both directories keep their position under the root.
test -f "$out/dashboard/assets/js/data/registry.js"
test -f "$out/app/assets/js/shared.js"

find "$out" -name ".DS_Store" -delete

echo "built $(find "$out" -type f | wc -l | tr -d ' ') files into public/"
