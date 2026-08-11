#!/usr/bin/env bash
# Generates the secrets the cloud project needs and records them locally.
#
# nhost.toml resolves {{ secrets.X }} at deploy time from the *project's* secrets. The
# .secrets file in this repo only feeds `nhost up`, so a cloud project starts with none of
# them and the deployment fails on the first unresolved reference before applying
# anything.
#
# Values are written to .cloud-secrets.local (gitignored) rather than printed, so they do
# not end up in a terminal transcript.
set -euo pipefail

OUTPUT=".cloud-secrets.local"
ENV_CLOUD=".env.cloud"

if [ ! -f "$ENV_CLOUD" ]; then
  echo "Missing $ENV_CLOUD — copy it from .env.cloud.example first." >&2
  exit 1
fi

admin_secret="$(openssl rand -hex 24)"
jwt_secret="$(openssl rand -hex 32)"
webhook_secret="$(openssl rand -hex 24)"
grafana_password="$(openssl rand -hex 16)"

llm_key=""
if [ -f .env ]; then
  llm_key="$(grep -E '^LLM_API_KEY=' .env | cut -d= -f2- | tr -d '"'"'"'' || true)"
fi

{
  echo "# Secrets for the nhost Cloud project. Gitignored. Create each of these in"
  echo "# Settings -> Secrets, or with: nhost secrets create <NAME> <VALUE>"
  echo
  echo "HASURA_GRAPHQL_ADMIN_SECRET=$admin_secret"
  echo "HASURA_GRAPHQL_JWT_SECRET=$jwt_secret"
  echo "NHOST_WEBHOOK_SECRET=$webhook_secret"
  echo "GRAFANA_ADMIN_PASSWORD=$grafana_password"
  if [ -n "$llm_key" ]; then
    echo "LLM_API_KEY=$llm_key"
  else
    echo "LLM_API_KEY=<your Groq key>"
  fi
} > "$OUTPUT"

chmod 600 "$OUTPUT"

# The admin secret only becomes the project's once the config applies, so .env.cloud has
# to carry the same value or every admin request keeps failing after a successful deploy.
if grep -qE '^NHOST_ADMIN_SECRET=' "$ENV_CLOUD"; then
  tmp="$(mktemp)"
  sed "s|^NHOST_ADMIN_SECRET=.*|NHOST_ADMIN_SECRET=$admin_secret|" "$ENV_CLOUD" > "$tmp"
  mv "$tmp" "$ENV_CLOUD"
else
  echo "NHOST_ADMIN_SECRET=$admin_secret" >> "$ENV_CLOUD"
fi

echo "Wrote $OUTPUT with 5 secrets, and updated NHOST_ADMIN_SECRET in $ENV_CLOUD."
echo
echo "Create them in the project, either with the CLI:"
echo
echo "  while IFS='=' read -r name value; do"
echo "    case \"\$name\" in ''|'#'*) continue;; esac"
echo "    nhost secrets create \"\$name\" \"\$value\" || nhost secrets update \"\$name\" \"\$value\""
echo "  done < $OUTPUT"
echo
echo "or by pasting each line into Settings -> Secrets in the dashboard."
