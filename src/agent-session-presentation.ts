import type { AppConfig, LinearAgentSessionExternalUrl } from "./types.ts";
import {
  buildSessionStatusUrl,
  createSessionStatusToken,
  deriveSessionStatusSigningSecret,
} from "./public-agent-session-status.ts";

const SESSION_STATUS_TTL_SECONDS = 60 * 60 * 24 * 7;

export function buildAgentSessionExternalUrls(
  config: AppConfig,
  issueKey: string | undefined,
): LinearAgentSessionExternalUrl[] | undefined {
  if (!issueKey || !config.server.publicBaseUrl) {
    return undefined;
  }

  const token = createSessionStatusToken({
    issueKey,
    secret: deriveSessionStatusSigningSecret(config.linear.tokenEncryptionKey),
    ttlSeconds: SESSION_STATUS_TTL_SECONDS,
  });

  return [
    {
      label: "PatchRelay status",
      url: buildSessionStatusUrl({
        publicBaseUrl: config.server.publicBaseUrl,
        issueKey,
        token: token.token,
      }),
    },
  ];
}
