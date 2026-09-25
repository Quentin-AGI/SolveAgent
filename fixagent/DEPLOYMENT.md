# FixAgent lightweight-server deployment

This deployment preserves the existing FixAgent runtime: one Claude Agent SDK
Agent, the native Bash/Read/Edit/Write/Skill capabilities, and the FixAgent MCP
server. Docker is only the process and filesystem boundary; it does not replace
the Agent runtime or introduce a workflow engine.

## Server layout

- Application directory: `/opt/fixagent`
- Public demo port: `4174`
- Persistent state: `/opt/fixagent/.runtime`
- Container: `fixagent-v0`

The `.runtime` directory contains private Case workspaces and provider profiles.
It must not be committed, copied into the image, or served as static content.

## Deploy

```bash
git clone --branch codex/deploy-fixagent --single-branch \
  https://github.com/Quentin-AGI/SolveAgent.git /opt/fixagent-src
mkdir -p /opt/fixagent
cp -a /opt/fixagent-src/fixagent/. /opt/fixagent/
cd /opt/fixagent
install -d -m 700 -o 1000 -g 1000 .runtime
docker compose up -d --build
docker compose ps
```

Verify locally on the server before opening the firewall:

```bash
curl --fail http://127.0.0.1:4174/api/models
docker inspect --format '{{json .State.Health}}' fixagent-v0
```

## Provider credentials

Do not put provider API keys in the image, Git repository, command output, or
deployment logs. The default deployment intentionally starts with Qwen, Kimi,
Zhipu, and DeepSeek marked as pending. Configure a private provider registry only
through an approved secret-management path.

The current application accepts model-configuration writes only from loopback.
This is a deliberate security boundary. Do not weaken it merely to make the
public demo settings screen writable. Add an authenticated HTTPS administration
surface before enabling remote provider configuration.

## Coexistence

This stack binds only host port `4174` and does not stop, rename, or reconfigure
other containers. If that port is already occupied, change only the host side of
the mapping in `compose.yaml`, for example `4180:4174`.
