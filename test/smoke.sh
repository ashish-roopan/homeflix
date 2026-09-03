#!/bin/bash
# End-to-end smoke test: builds a hostile 1500-file library, runs the real Electron
# app against a mock TMDB server with a throwaway userData dir, and reports timings.
# Usage: npm run smoke        (add KEEP=1 to keep the temp dirs)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=45199
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ml-smoke-XXXXXX")
LIB="$WORK/library"
UD="$WORK/userdata"
mkdir -p "$UD"
trap 'kill $MOCK_PID 2>/dev/null || true; [ -n "${KEEP:-}" ] || { chmod -R u+rwx "$WORK" 2>/dev/null; rm -rf "$WORK"; }' EXIT

echo "== building fixture tree in $LIB"
node -e "
const { buildHostileTree } = require('./test/fixtures');
const fsp = require('fs/promises');
(async () => {
  const fx = await buildHostileTree({ count: Number(process.env.COUNT || 1500) });
  await fsp.rename(fx.root, process.argv[1]);
  console.log('   expected videos (min 50MB):', fx.expected.videosMin50, 'partials:', fx.expected.partials);
})();
" "$LIB"

echo "== starting mock TMDB on :$PORT"
node test/mock-tmdb.js $PORT > "$WORK/mock.log" 2>&1 &
MOCK_PID=$!
sleep 0.5

cat > "$UD/settings.json" <<EOF
{ "moviesDir": "$LIB", "tmdbApiKey": "mockkey0123456789abcdef0123456789", "minFileSizeMB": 50 }
EOF

run() { # name delay [script]
  local name=$1 delay=$2 script=${3:-test/measure.js}
  echo "== run: $name (waiting ${delay}ms)"
  TMDB_API_BASE="http://127.0.0.1:$PORT/3" TMDB_IMG_BASE="http://127.0.0.1:$PORT/img" \
  MOVIE_LAUNCHER_USER_DATA="$UD" MOVIE_LAUNCHER_SCRIPT="$script" \
  MOVIE_LAUNCHER_SHOT="$WORK/$name.png" MOVIE_LAUNCHER_SHOT_DELAY="$delay" \
    npx electron . 2>&1 | grep -E '^\[(dev|perf|main|library|scanner|store|media|ipc)\]|unhandled|Uncaught|Error' | grep -v 'cannot read' || true
}

# 1) cold start: scan + identify 1500 titles against the mock
run cold 25000
# 2) warm start: everything cached, must render instantly and make no TMDB calls
BEFORE=$(curl -s "http://127.0.0.1:$PORT/__stats")
run warm 4000
AFTER=$(curl -s "http://127.0.0.1:$PORT/__stats")
echo "   TMDB requests during warm start: before=$BEFORE after=$AFTER (should be equal)"
# 3) folder missing: rename the library away, app must keep everything and show the banner
mv "$LIB" "$LIB-away"
run missing 4000
mv "$LIB-away" "$LIB"
# 4) TMDB down: new file + server returns 500 -> stays pending, banner shown
curl -s "http://127.0.0.1:$PORT/__fail/500" > /dev/null
node -e "require('./test/fixtures').sparseFile(process.argv[1], 70*1024*1024)" "$LIB/Folder 0/Brand.New.Film.2024.1080p.mkv"
run tmdbdown 6000
curl -s "http://127.0.0.1:$PORT/__fail/none" > /dev/null

echo "== library.json size: $(du -h "$UD/library.json" | cut -f1), posters cached: $(ls "$UD/images/posters" | wc -l | tr -d ' ')"
echo "== screenshots in $WORK (set KEEP=1 to keep)"
[ -n "${KEEP:-}" ] && echo "   kept: $WORK"
