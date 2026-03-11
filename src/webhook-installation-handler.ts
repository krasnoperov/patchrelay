import type { Logger } from "pino";
import type { LinearInstallationStoreProvider } from "./installation-ports.ts";
import type { AppConfig, NormalizedEvent } from "./types.ts";

export class InstallationWebhookHandler {
  constructor(
    private readonly config: AppConfig,
    private readonly stores: LinearInstallationStoreProvider,
    private readonly logger: Logger,
  ) {}

  handle(normalized: NormalizedEvent): void {
    if (!normalized.installation) {
      return;
    }

    if (normalized.triggerEvent === "installationPermissionsChanged") {
      const matchingInstallations = normalized.installation.appUserId
        ? this.stores.linearInstallations
            .listLinearInstallations()
            .filter((installation) => installation.actorId === normalized.installation?.appUserId)
        : [];
      const links = this.stores.linearInstallations.listProjectInstallations();
      const impactedProjects = matchingInstallations.flatMap((installation) =>
        links
          .filter((link) => link.installationId === installation.id)
          .map((link) => {
            const project = this.config.projects.find((entry) => entry.id === link.projectId);
            const removedMatches =
              normalized.installation?.removedTeamIds.some((teamId) => project?.linearTeamIds.includes(teamId)) ?? false;
            const addedMatches =
              normalized.installation?.addedTeamIds.some((teamId) => project?.linearTeamIds.includes(teamId)) ?? false;
            return {
              projectId: link.projectId,
              removedMatches,
              addedMatches,
            };
          }),
      );

      this.logger.warn(
        {
          appUserId: normalized.installation.appUserId,
          addedTeamIds: normalized.installation.addedTeamIds,
          removedTeamIds: normalized.installation.removedTeamIds,
          canAccessAllPublicTeams: normalized.installation.canAccessAllPublicTeams,
          impactedProjects,
        },
        "Linear app-team permissions changed; reconnect or adjust project routing if PatchRelay lost required team access",
      );
      return;
    }

    if (normalized.triggerEvent === "installationRevoked") {
      this.logger.warn(
        {
          organizationId: normalized.installation.organizationId,
          oauthClientId: normalized.installation.oauthClientId,
        },
        "Linear OAuth app installation was revoked; reconnect affected projects with `patchrelay project apply <id> <repo-path>` or `patchrelay connect --project <id>`",
      );
      return;
    }

    if (normalized.triggerEvent === "appUserNotification") {
      this.logger.info(
        {
          appUserId: normalized.installation.appUserId,
          notificationType: normalized.installation.notificationType,
          organizationId: normalized.installation.organizationId,
        },
        "Received Linear app-user notification webhook",
      );
    }
  }
}
