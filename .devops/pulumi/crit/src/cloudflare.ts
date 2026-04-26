import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import * as tls from "@pulumi/tls";

interface Args {
    accountId: string;
    zoneId: string;
    domain: string;
    appSubdomain: string;
    traefikSubdomain: string;
    accessAllowedEmails: string[];
    serverIp: pulumi.Input<string>;
    apiToken: pulumi.Input<string>;
    originCaKey: pulumi.Input<string>;
}

export interface CloudflareResources {
    originCert: pulumi.Output<string>;
    originKey: pulumi.Output<string>;
}

export function getCloudflareIpRanges(): pulumi.Output<string[]> {
    const ranges = cloudflare.getIpRangesOutput();
    return pulumi.all([ranges.ipv4Cidrs, ranges.ipv6Cidrs]).apply(
        ([v4, v6]) => [...v4, ...v6],
    );
}

export function createCloudflareResources(args: Args): CloudflareResources {
    const {
        accountId,
        zoneId,
        domain,
        appSubdomain,
        traefikSubdomain,
        accessAllowedEmails,
        serverIp,
    } = args;

    const traefikFqdn = `${traefikSubdomain}.${domain}`;

    // Explicit API-token provider for DNS + Access. Pulumi secret config used
    // (not env vars) — CF provider errors if both API_TOKEN and
    // API_USER_SERVICE_KEY env vars are present.
    const apiTokenProvider = new cloudflare.Provider("api-token", {
        apiToken: args.apiToken,
    });

    // Generate keypair for the origin cert.
    const originPrivateKey = new tls.PrivateKey("crit-origin", {
        algorithm: "RSA",
        rsaBits: 2048,
    });

    const originCsr = new tls.CertRequest("crit-origin", {
        privateKeyPem: originPrivateKey.privateKeyPem,
        subject: {
            commonName: `*.${domain}`,
            organization: "Crit",
        },
        dnsNames: [domain, `*.${domain}`],
    });

    // OriginCaCertificate uses a different auth than DNS/Access (Origin CA Key
    // instead of API Token). Two providers needed.
    const originCaProvider = new cloudflare.Provider("origin-ca", {
        apiUserServiceKey: args.originCaKey,
    });

    const originCert = new cloudflare.OriginCaCertificate(
        "crit-origin",
        {
            csr: originCsr.certRequestPem,
            hostnames: [domain, `*.${domain}`],
            requestType: "origin-rsa",
            requestedValidity: 5475, // 15 years
        },
        { provider: originCaProvider },
    );

    // Proxied A records pointing at the Hetzner VM.
    new cloudflare.DnsRecord(
        "crit-app",
        {
            zoneId,
            name: appSubdomain,
            content: serverIp,
            type: "A",
            proxied: true,
            ttl: 1,
        },
        { provider: apiTokenProvider },
    );

    new cloudflare.DnsRecord(
        "crit-traefik",
        {
            zoneId,
            name: traefikSubdomain,
            content: serverIp,
            type: "A",
            proxied: true,
            ttl: 1,
        },
        { provider: apiTokenProvider },
    );

    // Zero Trust Access app gating the Traefik dashboard by email allowlist.
    new cloudflare.ZeroTrustAccessApplication(
        "crit-traefik",
        {
            accountId,
            name: "Crit Traefik Dashboard",
            domain: traefikFqdn,
            type: "self_hosted",
            sessionDuration: "24h",
            policies: [
                {
                    name: "Allow approved emails",
                    decision: "allow",
                    includes: accessAllowedEmails.map((email) => ({
                        email: { email },
                    })),
                },
            ],
        },
        { provider: apiTokenProvider },
    );

    return {
        originCert: originCert.certificate,
        originKey: originPrivateKey.privateKeyPem,
    };
}
