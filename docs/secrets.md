# Secrets Management

Covers the PatchRelay harness. `review-quill` and `merge-steward` use the same three-level resolution pattern — see their operator references ([review-quill](./review-quill.md), [merge-steward](./merge-steward.md)) for the per-service credential names.

PatchRelay resolves secrets through a three-level fallback so that the application code is decoupled from the secret provider:

1. **`$CREDENTIALS_DIRECTORY/<name>`** — systemd-creds, Docker secrets, or any mount-based provider
2. **`${ENV_VAR}_FILE`** — reads the secret from a file path (any file-based encryption tool)
3. **`$ENV_VAR`** — direct environment variable (dev, `op run`, `sops exec-env`, or legacy `service.env`)

In production the recommended provider is **systemd-creds** — secrets are encrypted at rest on disk and decrypted into a private ramfs namespace visible only to the PatchRelay service process.

## Credential inventory

| Credential name | Env var fallback | Required |
|-|-|-|
| `linear-webhook-secret` | `LINEAR_WEBHOOK_SECRET` | yes |
| `token-encryption-key` | `PATCHRELAY_TOKEN_ENCRYPTION_KEY` | yes |
| `linear-oauth-client-id` | `LINEAR_OAUTH_CLIENT_ID` | yes |
| `linear-oauth-client-secret` | `LINEAR_OAUTH_CLIENT_SECRET` | yes |
| `github-app-pem` | `PATCHRELAY_GITHUB_APP_PRIVATE_KEY` | when GitHub App is configured |
| `github-app-webhook-secret` | `GITHUB_APP_WEBHOOK_SECRET` | when GitHub webhooks are configured |
| `operator-api-token` | per config `operator_api.bearer_token_env` | when operator API is enabled on non-loopback |

Non-secret identifiers (`PATCHRELAY_GITHUB_APP_ID`, `PATCHRELAY_GITHUB_APP_INSTALLATION_ID`, log paths, database path, etc.) stay in `runtime.env` or `patchrelay.json`.

## systemd-creds setup (production)

### Prerequisites

- systemd 250+ (check with `systemd --version`)
- PatchRelay installed as a **system service** (the unit uses `LoadCredentialEncrypted=`)
- root access for encrypting credentials and managing the credstore

### 1. Initialize the host encryption key

```bash
sudo systemd-creds setup
```

This creates `/var/lib/systemd/credential.secret` — a random AES key, owned `root:root 0600`. All encrypted credentials on this host are keyed from it.

If the host has a TPM2 chip, systemd-creds automatically splits the key between the TPM and this file. Without TPM2 (e.g. Hetzner dedicated servers), the file alone is used. Either way, the encrypted credentials are useless without root access to this key.

### 2. Create the encrypted credstore

```bash
sudo mkdir -p /etc/credstore.encrypted
```

This is systemd's standard search path for `LoadCredentialEncrypted=` directives that omit an explicit file path.

### 3. Encrypt each secret

Pipe from stdin so the plaintext never touches disk:

```bash
echo -n "your-linear-webhook-secret" | \
  sudo systemd-creds encrypt --name=linear-webhook-secret - \
  /etc/credstore.encrypted/linear-webhook-secret.cred

echo -n "your-token-encryption-key" | \
  sudo systemd-creds encrypt --name=token-encryption-key - \
  /etc/credstore.encrypted/token-encryption-key.cred

echo -n "your-oauth-client-id" | \
  sudo systemd-creds encrypt --name=linear-oauth-client-id - \
  /etc/credstore.encrypted/linear-oauth-client-id.cred

echo -n "your-oauth-client-secret" | \
  sudo systemd-creds encrypt --name=linear-oauth-client-secret - \
  /etc/credstore.encrypted/linear-oauth-client-secret.cred
```

For the GitHub App private key (PEM file):

```bash
# Encrypt from file, then remove the plaintext
sudo systemd-creds encrypt --name=github-app-pem \
  /tmp/github-app-private-key.pem \
  /etc/credstore.encrypted/github-app-pem.cred
rm /tmp/github-app-private-key.pem
```

### 4. Verify round-trip

```bash
sudo systemd-creds decrypt /etc/credstore.encrypted/linear-webhook-secret.cred
```

### 5. Install the system service

Copy the unit file and adjust paths:

```bash
sudo cp infra/patchrelay.service /etc/systemd/system/patchrelay.service
# Edit: replace "your-user" with your actual username
sudo systemctl daemon-reload
sudo systemctl enable --now patchrelay
```

When PatchRelay starts, systemd decrypts each `LoadCredentialEncrypted=` blob into a private ramfs directory. PatchRelay reads the decrypted secrets from `$CREDENTIALS_DIRECTORY/<name>`. No other process on the system can see this directory.

### 6. Remove the plaintext service.env

Once credstore is working, the plaintext `service.env` is no longer needed for secrets:

```bash
# Verify PatchRelay starts and operates correctly first
sudo systemctl status patchrelay

# Then remove the plaintext secrets file
rm ~/.config/patchrelay/service.env
```

## Rotating a secret

```bash
echo -n "new-webhook-secret" | \
  sudo systemd-creds encrypt --name=linear-webhook-secret - \
  /etc/credstore.encrypted/linear-webhook-secret.cred

sudo systemctl restart patchrelay
```

For the PEM key, encrypt from a temporary file and delete it:

```bash
sudo systemd-creds encrypt --name=github-app-pem \
  /tmp/new-key.pem \
  /etc/credstore.encrypted/github-app-pem.cred
rm /tmp/new-key.pem
sudo systemctl restart patchrelay
```

## Development and alternative providers

In development, secrets resolve via direct env vars. No credstore setup is needed:

```bash
# Directly
LINEAR_WEBHOOK_SECRET=dev-secret patchrelay serve

# From a file
source ~/.config/patchrelay/service.env && patchrelay serve

# Via 1Password
op run --env-file=.env.tpl -- patchrelay serve
```

The `_FILE` convention works with any file-based provider:

```bash
PATCHRELAY_GITHUB_APP_PRIVATE_KEY_FILE=/path/to/key.pem patchrelay serve
```

## How it works

`src/resolve-secret.ts` exports a single function:

```
resolveSecret(credentialName, envKey, env?) → string | undefined
```

The three-level fallback means the same PatchRelay binary works unchanged across:

| Provider | What sets the value | Layer |
|-|-|-|
| systemd-creds | `LoadCredentialEncrypted=` → `$CREDENTIALS_DIRECTORY/` | 1 |
| Docker secrets | Volume mount at `/run/secrets/` via `_FILE` | 2 |
| 1Password CLI | `op run` injects env vars | 3 |
| sops + age | `sops exec-env` injects env vars | 3 |
| Plain env vars | `service.env`, shell export, CI | 3 |

## Security model

With systemd-creds on a system service:

- Encrypted blobs at `/etc/credstore.encrypted/` are AES256-GCM ciphertext — useless without `/var/lib/systemd/credential.secret` (root-only)
- Decrypted secrets live in a ramfs (non-swappable) mounted in a private namespace
- User-level processes and npm scripts cannot see `$CREDENTIALS_DIRECTORY`
- The well-known paths that supply-chain malware targets (`~/.config/gh/`, `.env`, `~/.npmrc`) contain no secrets

Without TPM2 (Hetzner, most cloud dedicated servers), the encryption key and ciphertext live on the same disk. This protects against user-level exfiltration (the threat model for npm supply-chain attacks) but not against root-level compromise or offline disk imaging. For the latter, combine with full-disk encryption.

## Migrating from service.env

Before credstore:

```
~/.config/patchrelay/service.env  (plaintext, EnvironmentFile=)
  └── LINEAR_WEBHOOK_SECRET=actual-secret
```

After credstore:

```
/etc/credstore.encrypted/linear-webhook-secret.cred  (AES256-GCM ciphertext)
  └── decrypted at service start → $CREDENTIALS_DIRECTORY/linear-webhook-secret
```

The service.env file can still be used for backwards compatibility — if `$CREDENTIALS_DIRECTORY` is not set (dev mode without credstore), PatchRelay falls through to the env var layer. To complete the migration, remove the plaintext file after verifying credstore works.
