# crit-web on Hetzner (Pulumi)

Self-hosts `crit-web` on a Hetzner Cloud VM. Single-node Docker Swarm. Cloudflare in front (proxied) with origin TLS via a CF-issued Origin Certificate. Traefik handles routing inside Swarm. Postgres internal-only.

## Architecture

```
Browser ── HTTPS ──► Cloudflare Edge (proxied)
                          │   (Full strict TLS, origin cert)
                          ▼
                Hetzner CX22 (NBG1, ubuntu-24.04)
                  Hetzner firewall: 443 only from CF IP ranges
                          │
                          ▼
                  Traefik v3.1 (host :443)
                   ├─► crit.brainshop.app       → app:4000  (crit-web Phoenix)
                   └─► traefik.brainshop.app    → api@internal (gated by CF Access)
                          │
                  internal Swarm overlay (encrypted)
                          │
                          └─► db:5432 (postgres:17, internal-only)
```

- SSH key-only on root, password auth disabled
- HTTPS 443 firewalled to Cloudflare IP ranges (origin not directly reachable)
- Traefik dashboard gated by Cloudflare Zero Trust Access (email allowlist)
- crit-web in `SELFHOSTED=true` mode

## Prerequisites

- `pulumi` CLI (`brew install pulumi/tap/pulumi`)
- `hcloud` CLI
- Pulumi Cloud account (`pulumi login`)
- Hetzner project + API token (Read & Write)
- Cloudflare API token with scopes: `Zone:DNS:Edit`, `Zone:SSL and Certificates:Edit`, `Account:Access: Apps and Policies:Edit`, `User:User Details:Read`
- Cloudflare Origin CA Key (separate from API tokens): https://dash.cloudflare.com/profile/api-tokens → "Origin CA Key" — used only by `OriginCaCertificate` resource
- Cloudflare Account ID + Zone ID for `brainshop.app`
- SSH keypair (`~/.ssh/id_ed25519` + `.pub`) — pubkey path in `.env`

## First-time setup

```bash
cd .devops/pulumi/crit
cp .env.example .env       # fill HCLOUD_TOKEN / CLOUDFLARE_API_TOKEN / SSH_PUBLIC_KEY_PATH
npm install
pulumi stack init prod

# Non-secret config (also pre-set in Pulumi.prod.yaml):
pulumi config set crit:cloudflareAccountId <your-cf-account-id>
pulumi config set crit:cloudflareZoneId <your-cf-zone-id>

# Secrets (generated locally, encrypted by Pulumi):
pulumi config set --secret crit:secretKeyBase $(openssl rand -base64 64)
pulumi config set --secret crit:postgresPassword $(openssl rand -base64 32)
```

## Deploy

```bash
set -a && source .env && set +a
pulumi preview
pulumi up
```

Every run needs `.env` sourced first — providers read `HCLOUD_TOKEN` / `CLOUDFLARE_API_TOKEN` from environment, and `index.ts` reads `SSH_PUBLIC_KEY_PATH`.

## Outputs

```bash
pulumi stack output serverIp
pulumi stack output appUrl                   # https://crit.brainshop.app
pulumi stack output traefikDashboardUrl      # https://traefik.brainshop.app
```

## Verify

```bash
# 1. App health (via CF):
curl -fsSL https://crit.brainshop.app/health
# → {"status":"ok"}

# 2. Origin firewalled (direct IP rejected by Hetzner firewall):
curl --max-time 5 -k --resolve crit.brainshop.app:443:$(pulumi stack output serverIp) https://crit.brainshop.app/health
# → expect timeout / refused

# 3. SSH:
ssh root@$(pulumi stack output serverIp) docker service ls

# 4. Traefik dashboard requires CF Access login:
open https://traefik.brainshop.app
```

## SSH (debugging)

```bash
ssh root@$(pulumi stack output serverIp)
cloud-init status
docker service ls
docker service logs crit-web_app -f
journalctl -u docker -f
```

## Re-deploy stacks (without rebuilding server)

`pulumi up` reapplies only changed `command.remote.*` resources. Edit a file under `src/assets/stacks/`, run `pulumi up` — it copies new files and re-runs `docker stack deploy`.

## Destroy

```bash
set -a && source .env && set +a && pulumi destroy
```

Tears down VM, firewall, SSH key, Cloudflare DNS records, Origin cert, Access app — everything reversible.

## File map

```
.
├── Pulumi.yaml                     # project metadata
├── Pulumi.prod.yaml                # non-secret config
├── package.json                    # @pulumi/{pulumi,hcloud,cloudflare,command,tls,random}
├── tsconfig.json
├── .env / .env.example             # local-only secrets
├── index.ts                        # orchestration entrypoint
└── src/
    ├── hetzner.ts                  # SSH key, firewall (443→CF only), server + cloud-init
    ├── cloudflare.ts               # IP ranges, origin cert, DNS records, ZT Access gating
    ├── cloud-init.ts               # render cloud-config (sshd hardening + bootstrap.sh)
    ├── deploy.ts                   # @pulumi/command: copy + docker stack deploy
    └── assets/
        ├── bootstrap.sh                    # apt + docker + swarm init + overlay net
        ├── sshd_hardened.conf              # /etc/ssh/sshd_config.d drop-in
        ├── stacks/
        │   ├── traefik.yaml
        │   └── crit-web.yaml
        └── traefik-dynamic/
            └── tls.yml                     # file provider: cert + key paths
```
