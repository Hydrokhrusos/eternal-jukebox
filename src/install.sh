#!/bin/sh
set -eu

cat >&2 <<'EOF'
This fork currently ships the seamless Web Audio helper for Windows only.

Use the Windows PowerShell installer from the README, or install the app files
manually if you are deliberately setting up your own helper service.
EOF

exit 1
