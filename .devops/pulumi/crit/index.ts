import * as fs from "node:fs";
import * as pulumi from "@pulumi/pulumi";

import { renderCloudInit } from "./src/cloud-init";
import {
    createCloudflareResources,
    getCloudflareIpRanges,
} from "./src/cloudflare";
import { deployStacks } from "./src/deploy";
import { createHetznerServer } from "./src/hetzner";

const config = new pulumi.Config("crit");

// Non-secret stack config.
const serverName = config.get("serverName") ?? "crit-prod";
const serverType = config.require("serverType");
const location = config.require("location");
const image = config.get("image") ?? "ubuntu-24.04";
const domain = config.require("domain");
const appSubdomain = config.require("appSubdomain");
const traefikSubdomain = config.require("traefikSubdomain");
const cloudflareAccountId = config.require("cloudflareAccountId");
const cloudflareZoneId = config.require("cloudflareZoneId");
const accessAllowedEmails = config.requireObject<string[]>("accessAllowedEmails");

// Secret config.
const secretKeyBase = config.requireSecret("secretKeyBase");
const postgresPassword = config.requireSecret("postgresPassword");
const adminPassword = config.requireSecret("adminPassword");
const cloudflareApiToken = config.requireSecret("cloudflareApiToken");
const cloudflareOriginCaKey = config.requireSecret("cloudflareOriginCaKey");

// Local SSH key (path from .env). The Hetzner project already has this key
// registered (by its comment, e.g. "alon@ronin.co.il"); we look it up rather
// than recreate. Private key is read from the matching file (path minus .pub)
// for command.remote SSH connections.
const sshPublicKeyPath = process.env.SSH_PUBLIC_KEY_PATH;
if (!sshPublicKeyPath) {
    throw new Error("SSH_PUBLIC_KEY_PATH must be set (see .env)");
}
const rawSshKey = fs.readFileSync(sshPublicKeyPath, "utf-8").trim();
const sshKeyParts = rawSshKey.split(/\s+/);
if (sshKeyParts.length < 2) {
    throw new Error(`Invalid SSH public key at ${sshPublicKeyPath}`);
}
const sshKeyName = sshKeyParts[2] ?? "crit-admin";

const sshPrivateKeyPath = sshPublicKeyPath.replace(/\.pub$/, "");
if (sshPrivateKeyPath === sshPublicKeyPath) {
    throw new Error(`SSH_PUBLIC_KEY_PATH must end with .pub: ${sshPublicKeyPath}`);
}
const sshPrivateKey = fs.readFileSync(sshPrivateKeyPath, "utf-8");

const appFqdn = `${appSubdomain}.${domain}`;
const traefikFqdn = `${traefikSubdomain}.${domain}`;

const cloudflareIpRanges = getCloudflareIpRanges();
const userData = renderCloudInit();

const server = createHetznerServer({
    serverName,
    serverType,
    location,
    image,
    sshKeyName,
    userData,
    cloudflareIpRanges,
});

const cf = createCloudflareResources({
    accountId: cloudflareAccountId,
    zoneId: cloudflareZoneId,
    domain,
    appSubdomain,
    traefikSubdomain,
    accessAllowedEmails,
    serverIp: server.ipv4Address,
    apiToken: cloudflareApiToken,
    originCaKey: cloudflareOriginCaKey,
});

deployStacks({
    serverIp: server.ipv4Address,
    sshPrivateKey,
    appFqdn,
    secretKeyBase,
    postgresPassword,
    adminPassword,
    originCert: cf.originCert,
    originKey: cf.originKey,
    serverDependsOn: server,
});

export const serverIp = server.ipv4Address;
export const serverNameOut = server.name;
export const appUrl = `https://${appFqdn}`;
export const traefikDashboardUrl = `https://${traefikFqdn}`;
