import type { AppConfig, LinearAgentSessionExternalUrl } from "./types.ts";
import {
  buildSessionStatusUrl,
  createSessionStatusToken,
  deriveSessionStatusSigningSecret,
} from "./public-agent-session-status.ts";

const SESSION_STATUS_TTL_SECONDS = 60 * 60 * 24 * 7;

export function buildAgentSessionExternalUrls(
  config: AppConfig,
  params: {
    issueKey?: string;
    prUrl?: string;
  },
): LinearAgentSessionExternalUrl[] | undefined {
  const urls: LinearAgentSessionExternalUrl[] = [];

  if (params.issueKey && config.server.publicBaseUrl) {
    const token = createSessionStatusToken({
      issueKey: params.issueKey,
      secret: deriveSessionStatusSigningSecret(config.linear.tokenEncryptionKey),
      ttlSeconds: SESSION_STATUS_TTL_SECONDS,
    });

    urls.push({
      label: "PatchRelay status",
      url: buildSessionStatusUrl({
        publicBaseUrl: config.server.publicBaseUrl,
        issueKey: params.issueKey,
        token: token.token,
      }),
    });
  }

  if (params.prUrl) {
    urls.push({
      label: "Pull request",
      url: params.prUrl,
    });
  }

  return urls.length > 0 ? urls : undefined;
}
