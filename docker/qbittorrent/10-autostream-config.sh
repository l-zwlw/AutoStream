#!/usr/bin/with-contenv sh

set -eu

config_file="/config/qBittorrent/qBittorrent.conf"

mkdir -p "$(dirname "$config_file")"
touch "$config_file"

if ! grep -q '^\[Preferences\]' "$config_file"; then
  printf '\n[Preferences]\n' >> "$config_file"
fi

if grep -q '^WebUI\\AuthSubnetWhitelist=' "$config_file"; then
  sed -i 's|^WebUI\\AuthSubnetWhitelist=.*|WebUI\\AuthSubnetWhitelist=10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16|' "$config_file"
else
  printf 'WebUI\\AuthSubnetWhitelist=10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16\n' >> "$config_file"
fi

if grep -q '^WebUI\\AuthSubnetWhitelistEnabled=' "$config_file"; then
  sed -i 's|^WebUI\\AuthSubnetWhitelistEnabled=.*|WebUI\\AuthSubnetWhitelistEnabled=true|' "$config_file"
else
  printf 'WebUI\\AuthSubnetWhitelistEnabled=true\n' >> "$config_file"
fi

echo "AutoStream: enabled qBittorrent API access for private Docker networks"
