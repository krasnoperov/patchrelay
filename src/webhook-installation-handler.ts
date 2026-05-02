import type { Logger } from "pino";
import type { LinearInstallationStore } from "./db/linear-installation-store.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { AppConfig, InstallationWebhookMetadata, LinearInstallationRecord, NormalizedEvent } from "./types.ts";

export class InstallationWebhookHandler {
  constructor(
    private readonly config: AppConfig,
    private readonly stores: { linearInstallations: LinearInstallationStore },
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {}

  handle(normalized: NormalizedEvent): void {
    if (!normalized.installation) return;

    if (normalized.triggerEvent === "installationPermissionsChanged") {
      const matchingInstallations = this.findMatchingInstallations(normalized.installation);
      const links = this.stores.linearInstallations.listProjectInstallations();
      const impactedProjects = matchingInstallations.flatMap((installation) =>
        links
          .filter((link) => link.installationId === installation.id)
          .map((link) => {
            const project = this.config.projects.find((entry) => entry.id === link.projectId);
            const removedMatches = normalized.installation?.removedTeamIds.some((teamId) => project?.linearTeamIds.includes(teamId)) ?? false;
            const addedMatches = normalized.installation?.addedTeamIds.some((teamId) => project?.linearTeamIds.includes(teamId)) ?? false;
            return { projectId: link.projectId, removedMatches, addedMatches };
          }),
      );
      const impactedProjectIds = impactedProjects
        .filter((project) => project.removedMatches)
        .map((project) => project.projectId);
      const healthReason = buildPermissionHealthReason(normalized.installation, impactedProjectIds);

      for (const installation of matchingInstallations) {
        this.stores.linearInstallations.updateLinearInstallationHealth(installation.id, {
          healthStatus: "permissions_changed",
          healthReason,
        });
      }

      this.feed?.publish({
        level: "warn",
        kind: "linear",
        status: "permissions_changed",
        summary: "Linear app permissions changed",
        detail: healthReason,
      });

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
      const matchingInstallations = this.findMatchingInstallations(normalized.installation, { allowOauthClientFallback: true });
      const healthReason = "Linear OAuth app installation was revoked. Reconnect the affected workspace before PatchRelay can update Linear.";
      for (const installation of matchingInstallations) {
        this.stores.linearInstallations.updateLinearInstallationHealth(installation.id, {
          healthStatus: "revoked",
          healthReason,
        });
      }
      this.feed?.publish({
        level: "error",
        kind: "linear",
        status: "revoked",
        summary: "Linear OAuth app installation was revoked",
        detail: healthReason,
      });
      this.logger.warn(
        {
          organizationId: normalized.installation.organizationId,
          oauthClientId: normalized.installation.oauthClientId,
          installationIds: matchingInstallations.map((installation) => installation.id),
        },
        "Linear OAuth app installation was revoked; reconnect affected projects",
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

  private findMatchingInstallations(
    metadata: InstallationWebhookMetadata,
    options?: { allowOauthClientFallback?: boolean },
  ): LinearInstallationRecord[] {
    const installations = this.stores.linearInstallations.listLinearInstallations();
    const specificMatches = installations.filter((installation) =>
      Boolean(
        (metadata.appUserId && installation.actorId === metadata.appUserId) ||
          (metadata.organizationId && installation.workspaceId === metadata.organizationId),
      ),
    );
    if (specificMatches.length > 0) {
      return specificMatches;
    }

    if (
      options?.allowOauthClientFallback &&
      metadata.oauthClientId &&
      metadata.oauthClientId === this.config.linear.oauth?.clientId
    ) {
      return installations;
    }

    return [];
  }
}

function buildPermissionHealthReason(metadata: InstallationWebhookMetadata, impactedProjectIds: string[]): string {
  const accessChange = metadata.removedTeamIds.length > 0
    ? `removed team access: ${metadata.removedTeamIds.join(", ")}`
    : metadata.addedTeamIds.length > 0
      ? `added team access: ${metadata.addedTeamIds.join(", ")}`
      : "team access changed";
  const allPublicTeams = metadata.canAccessAllPublicTeams === false
    ? " App no longer has access to all public teams."
    : "";
  const impactedProjects = impactedProjectIds.length > 0
    ? ` Impacted PatchRelay projects: ${impactedProjectIds.join(", ")}.`
    : " Verify routed teams and reconnect if updates start failing.";
  return `Linear app permissions changed (${accessChange}).${allPublicTeams}${impactedProjects}`;
}
