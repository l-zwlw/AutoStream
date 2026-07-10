#!/usr/bin/with-contenv sh

set -eu

config_file="/config/qBittorrent/qBittorrent.conf"

mkdir -p "$(dirname "$config_file")"
touch "$config_file"

if ! grep -q '^WebUI\\AuthSubnetWhitelistEnabled=' "$config_file"; then
  cat >> "$config_file" <<'EOF'

[Preferences]
WebUI\AuthSubnetWhitelist=172.16.0.0/12
WebUI\AuthSubnetWhitelistEnabled=true
EOF
fi

echo "AutoStream: enabled qBittorrent API access for the internal Docker network"
