import * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";

interface Args {
    serverName: string;
    serverType: string;
    location: string;
    image: string;
    sshKeyName: string;
    userData: pulumi.Input<string>;
    cloudflareIpRanges: pulumi.Input<string[]>;
}

export function createHetznerServer(args: Args): hcloud.Server {
    const firewall = new hcloud.Firewall("crit", {
        name: "crit",
        rules: [
            {
                description: "SSH",
                direction: "in",
                protocol: "tcp",
                port: "22",
                sourceIps: ["0.0.0.0/0", "::/0"],
            },
            {
                description: "ICMP",
                direction: "in",
                protocol: "icmp",
                sourceIps: ["0.0.0.0/0", "::/0"],
            },
            {
                description: "HTTPS from Cloudflare only",
                direction: "in",
                protocol: "tcp",
                port: "443",
                sourceIps: args.cloudflareIpRanges,
            },
        ],
    });

    return new hcloud.Server("crit", {
        name: args.serverName,
        image: args.image,
        serverType: args.serverType,
        location: args.location,
        // Reuse the project-wide key already registered in Hetzner (e.g.
        // "alon@ronin.co.il"). Server.sshKeys accepts names or IDs.
        sshKeys: [args.sshKeyName],
        firewallIds: [firewall.id.apply((id: string) => parseInt(id, 10))],
        userData: args.userData,
        labels: {
            role: "crit",
            managed_by: "pulumi",
        },
    });
}
