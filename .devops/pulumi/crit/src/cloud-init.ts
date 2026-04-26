import * as fs from "node:fs";
import * as path from "node:path";

const ASSETS_DIR = path.join(__dirname, "assets");
const SSHD_HARDENED = fs.readFileSync(path.join(ASSETS_DIR, "sshd_hardened.conf"), "utf-8");
const BOOTSTRAP = fs.readFileSync(path.join(ASSETS_DIR, "bootstrap.sh"), "utf-8");

const indent = (text: string, spaces: number): string => {
    const pad = " ".repeat(spaces);
    return text
        .split("\n")
        .map((line) => (line.length > 0 ? pad + line : line))
        .join("\n");
};

// Cloud-init: install Docker, harden SSH, init Swarm, create overlay, prep dirs.
// Stacks are deployed by `src/deploy.ts` after boot completes.
export function renderCloudInit(): string {
    return `#cloud-config
ssh_pwauth: false

write_files:
  - path: /etc/ssh/sshd_config.d/99-hardened.conf
    permissions: "0644"
    content: |
${indent(SSHD_HARDENED, 6)}
  - path: /opt/crit/bootstrap.sh
    permissions: "0755"
    content: |
${indent(BOOTSTRAP, 6)}

runcmd:
  - /opt/crit/bootstrap.sh
`;
}
