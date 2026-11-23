#!/bin/sh
# Links bin/cic onto your PATH and prints the extension folder to load in Chrome.
#   ./install.sh                 links into ~/.local/bin
#   BIN_DIR=~/bin ./install.sh   links somewhere else
set -e
repo=$(cd "$(dirname "$0")" && pwd)
bin_dir=${BIN_DIR:-$HOME/.local/bin}

command -v node >/dev/null || { echo "cic needs Node 18+ on PATH" >&2; exit 1; }
mkdir -p "$bin_dir"
chmod +x "$repo/bin/cic"
ln -sf "$repo/bin/cic" "$bin_dir/cic"
echo "linked $bin_dir/cic -> $repo/bin/cic"
case ":$PATH:" in *":$bin_dir:"*) ;; *) echo "note: $bin_dir is not on your PATH" ;; esac

cat <<EOF

Now load the extension once:
  1. open chrome://extensions
  2. turn on Developer mode
  3. Load unpacked -> $repo/extension
Then check:  cic status   (expect "extension": true)
EOF
