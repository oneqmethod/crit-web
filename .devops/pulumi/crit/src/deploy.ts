import * as path from "node:path";

import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";

const ASSETS_DIR = path.join(__dirname, "assets");

interface Args {
    serverIp: pulumi.Input<string>;
    sshPrivateKey: pulumi.Input<string>;
    appFqdn: pulumi.Input<string>;
    secretKeyBase: pulumi.Input<string>;
    postgresPassword: pulumi.Input<string>;
    adminPassword: pulumi.Input<string>;
    originCert: pulumi.Input<string>;
    originKey: pulumi.Input<string>;
    serverDependsOn: pulumi.Resource;
}

export function deployStacks(args: Args): void {
    const conn: command.types.input.remote.ConnectionArgs = {
        host: args.serverIp,
        user: "root",
        privateKey: args.sshPrivateKey,
    };

    // Wait for cloud-init to finish before doing anything else.
    const waitBootstrap = new command.remote.Command(
        "wait-bootstrap",
        {
            connection: conn,
            create: "cloud-init status --wait",
            triggers: [args.serverIp],
        },
        { dependsOn: [args.serverDependsOn] },
    );

    // Static stack files from assets.
    const traefikStack = new command.remote.CopyToRemote(
        "traefik-stack",
        {
            connection: conn,
            source: new pulumi.asset.FileAsset(path.join(ASSETS_DIR, "stacks", "traefik.yaml")),
            remotePath: "/opt/crit/stacks/traefik.yaml",
        },
        { dependsOn: [waitBootstrap] },
    );

    const critStack = new command.remote.CopyToRemote(
        "crit-stack",
        {
            connection: conn,
            source: new pulumi.asset.FileAsset(path.join(ASSETS_DIR, "stacks", "crit-web.yaml")),
            remotePath: "/opt/crit/stacks/crit-web.yaml",
        },
        { dependsOn: [waitBootstrap] },
    );

    const tlsDynamic = new command.remote.CopyToRemote(
        "traefik-tls-dynamic",
        {
            connection: conn,
            source: new pulumi.asset.FileAsset(
                path.join(ASSETS_DIR, "traefik-dynamic", "tls.yml"),
            ),
            remotePath: "/opt/crit/traefik-dynamic/tls.yml",
        },
        { dependsOn: [waitBootstrap] },
    );

    // Rendered (secret) files via inline string assets.
    const critEnv = pulumi.interpolate`DATABASE_URL=ecto://crit:${args.postgresPassword}@db/crit_prod
SECRET_KEY_BASE=${args.secretKeyBase}
PHX_HOST=${args.appFqdn}
PHX_SERVER=true
PORT=4000
SELFHOSTED=true
ADMIN_PASSWORD=${args.adminPassword}
`;

    const postgresEnv = pulumi.interpolate`POSTGRES_USER=crit
POSTGRES_PASSWORD=${args.postgresPassword}
POSTGRES_DB=crit_prod
`;

    const critEnvCopy = new command.remote.CopyToRemote(
        "crit-env",
        {
            connection: conn,
            source: critEnv.apply((c) => new pulumi.asset.StringAsset(c)),
            remotePath: "/opt/crit/envs/crit-web.env",
        },
        { dependsOn: [waitBootstrap] },
    );

    const postgresEnvCopy = new command.remote.CopyToRemote(
        "postgres-env",
        {
            connection: conn,
            source: postgresEnv.apply((c) => new pulumi.asset.StringAsset(c)),
            remotePath: "/opt/crit/envs/postgres.env",
        },
        { dependsOn: [waitBootstrap] },
    );

    // Cert + key go through `Command` (not `CopyToRemote`) because their
    // values are pulumi.Output from tls.PrivateKey / OriginCaCertificate —
    // unknown at preview time, and pulumi.asset.StringAsset must resolve
    // synchronously. Base64-pipe avoids shell quoting issues.
    const certB64 = pulumi.output(args.originCert).apply((c) =>
        Buffer.from(c).toString("base64"),
    );
    const keyB64 = pulumi.output(args.originKey).apply((k) =>
        Buffer.from(k).toString("base64"),
    );

    const certCopy = new command.remote.Command(
        "origin-cert",
        {
            connection: conn,
            create: pulumi.interpolate`echo '${certB64}' | base64 -d > /opt/crit/certs/cert.pem && chmod 644 /opt/crit/certs/cert.pem`,
            update: pulumi.interpolate`echo '${certB64}' | base64 -d > /opt/crit/certs/cert.pem && chmod 644 /opt/crit/certs/cert.pem`,
            triggers: [args.originCert],
        },
        { dependsOn: [waitBootstrap] },
    );

    const keyCopy = new command.remote.Command(
        "origin-key",
        {
            connection: conn,
            create: pulumi.interpolate`echo '${keyB64}' | base64 -d > /opt/crit/certs/key.pem && chmod 600 /opt/crit/certs/key.pem`,
            update: pulumi.interpolate`echo '${keyB64}' | base64 -d > /opt/crit/certs/key.pem && chmod 600 /opt/crit/certs/key.pem`,
            triggers: [args.originKey],
        },
        { dependsOn: [waitBootstrap] },
    );

    new command.remote.Command(
        "deploy-traefik",
        {
            connection: conn,
            create: "docker stack deploy -c /opt/crit/stacks/traefik.yaml traefik",
            update: "docker stack deploy -c /opt/crit/stacks/traefik.yaml traefik",
            triggers: [args.originCert, args.originKey],
        },
        {
            dependsOn: [traefikStack, tlsDynamic, certCopy, keyCopy],
        },
    );

    new command.remote.Command(
        "deploy-crit",
        {
            connection: conn,
            create: "docker stack deploy -c /opt/crit/stacks/crit-web.yaml crit-web",
            update: "docker stack deploy -c /opt/crit/stacks/crit-web.yaml crit-web",
            triggers: [args.secretKeyBase, args.postgresPassword, args.appFqdn],
        },
        {
            dependsOn: [critStack, critEnvCopy, postgresEnvCopy],
        },
    );
}
