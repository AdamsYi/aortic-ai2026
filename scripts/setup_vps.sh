#!/bin/bash
set -e
# 仓库地址已硬编码，无需设置 AORTICAI_REPO_URL 环境变量

PROJECT_DIR="/srv/aorticai"
REPO_URL="https://github.com/AdamsYi/aortic-ai2026.git"
NGINX_AVAILABLE="/etc/nginx/sites-available/aorticai"
NGINX_ENABLED="/etc/nginx/sites-enabled/aorticai"
NGINX_SOURCE="$PROJECT_DIR/scripts/nginx_aorticai.conf"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

ensure_package() {
  local pkg="$1"
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    $SUDO apt-get install -y "$pkg"
  fi
}

$SUDO apt-get update -y
ensure_package git
ensure_package curl
ensure_package unzip
ensure_package nginx
ensure_package certbot
ensure_package python3-certbot-nginx

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -ne 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi

if ! command -v wrangler >/dev/null 2>&1; then
  $SUDO npm install -g wrangler
else
  WRANGLER_PATH="$(command -v wrangler)"
  if [ ! -x "$WRANGLER_PATH" ]; then
    $SUDO npm install -g wrangler
  fi
fi

$SUDO mkdir -p /srv

if [ -d "$PROJECT_DIR/.git" ]; then
  git -C "$PROJECT_DIR" pull --ff-only
else
  if [ -d "$PROJECT_DIR" ]; then
    $SUDO rm -rf "$PROJECT_DIR"
  fi
  $SUDO git clone "$REPO_URL" "$PROJECT_DIR"
fi

if [ ! -f "$NGINX_SOURCE" ]; then
  echo "Missing nginx config template: $NGINX_SOURCE"
  exit 1
fi

$SUDO cp "$NGINX_SOURCE" "$NGINX_AVAILABLE"
$SUDO ln -sfn "$NGINX_AVAILABLE" "$NGINX_ENABLED"
$SUDO rm -f /etc/nginx/sites-enabled/default
$SUDO nginx -t
$SUDO systemctl restart nginx

echo "VPS setup complete. Run: cd /srv/aorticai && npm ci && npm run deploy"
