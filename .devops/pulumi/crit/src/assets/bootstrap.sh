#!/usr/bin/env bash
set -euo pipefail

log() { echo "[crit-bootstrap] $*"; }

log "apt update + upgrade"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y

log "install base packages"
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  curl ca-certificates gnupg unattended-upgrades

log "configure docker apt repo"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list

log "install docker"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

log "reload sshd to pick up hardening drop-in"
systemctl reload ssh || systemctl reload sshd

log "enable unattended-upgrades"
systemctl enable --now unattended-upgrades

log "init docker swarm"
PRIMARY_IP=$(hostname -I | awk '{print $1}')
docker swarm init --advertise-addr "$PRIMARY_IP" || log "swarm already init'd"

log "create encrypted overlay network: traefik"
docker network create --driver overlay --opt encrypted=true --attachable traefik 2>/dev/null \
  || log "network already exists"

log "mkdir runtime dirs"
mkdir -p /opt/crit/{stacks,envs,certs,traefik-dynamic}
chmod 700 /opt/crit/{envs,certs}

log "done"
