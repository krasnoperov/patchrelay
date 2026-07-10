import type { WorkflowTaskRecord } from "../db-types.ts";
import type { WorkflowTask } from "../workflow-model.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

export interface WorkflowTaskProjection {
  task: WorkflowTask;
  authorityEpoch: number;
  gateAction: string;
  gateReason?: string | undefined;
}

export interface ReconcileWorkflowTasksResult {
  opened: WorkflowTaskRecord[];
  updated: WorkflowTaskRecord[];
  closed: WorkflowTaskRecord[];
  open: WorkflowTaskRecord[];
}

export class WorkflowTaskStore {
  constructor(
    private readonly connection: DatabaseConnection,
    private readonly mapWorkflowTaskRow: (row: Record<string, unknown>) => WorkflowTaskRecord,
  ) {}

  reconcileTasks(params: {
    projectId: string;
    subjectId: string;
    tasks: WorkflowTaskProjection[];
    reconciledAt?: string | undefined;
  }): ReconcileWorkflowTasksResult {
    const reconciledAt = params.reconciledAt ?? isoNow();
    return this.connection.transaction(() => {
      const previousOpen = this.listOpenTasks(params.projectId, params.subjectId);
      const currentTaskIds = new Set(params.tasks.map((entry) => entry.task.id));
      const opened: WorkflowTaskRecord[] = [];
      const updated: WorkflowTaskRecord[] = [];

      for (const entry of params.tasks) {
        const existing = this.getTask(params.projectId, params.subjectId, entry.task.id);
        const requirementsJson = entry.task.requirements ? JSON.stringify(entry.task.requirements) : undefined;
        this.connection.prepare(`
          INSERT INTO workflow_tasks (
            project_id, subject_id, task_id, task_type, run_type, status, reason,
            requirements_json, authority_epoch, gate_action, gate_reason,
            created_at, updated_at, closed_at
          ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(project_id, subject_id, task_id) DO UPDATE SET
            task_type = excluded.task_type,
            run_type = excluded.run_type,
            status = 'open',
            reason = excluded.reason,
            requirements_json = excluded.requirements_json,
            authority_epoch = excluded.authority_epoch,
            gate_action = excluded.gate_action,
            gate_reason = excluded.gate_reason,
            updated_at = excluded.updated_at,
            closed_at = NULL
        `).run(
          params.projectId,
          params.subjectId,
          entry.task.id,
          entry.task.type,
          entry.task.runType ?? null,
          entry.task.reason,
          requirementsJson ?? null,
          entry.authorityEpoch,
          entry.gateAction,
          entry.gateReason ?? null,
          existing?.createdAt ?? reconciledAt,
          reconciledAt,
        );
        const saved = this.getTask(params.projectId, params.subjectId, entry.task.id)!;
        if (!existing || existing.status === "closed") {
          opened.push(saved);
        } else {
          updated.push(saved);
        }
      }

      const closed: WorkflowTaskRecord[] = [];
      for (const stale of previousOpen) {
        if (currentTaskIds.has(stale.taskId)) continue;
        this.connection.prepare(`
          UPDATE workflow_tasks
          SET status = 'closed',
              updated_at = ?,
              closed_at = ?
          WHERE id = ?
            AND status = 'open'
        `).run(reconciledAt, reconciledAt, stale.id);
        const closedTask = this.getTaskById(stale.id);
        if (closedTask) {
          closed.push(closedTask);
        }
      }

      return {
        opened,
        updated,
        closed,
        open: this.listOpenTasks(params.projectId, params.subjectId),
      };
    })();
  }

  getTask(projectId: string, subjectId: string, taskId: string): WorkflowTaskRecord | undefined {
    const row = this.connection.prepare(`
      SELECT * FROM workflow_tasks
      WHERE project_id = ? AND subject_id = ? AND task_id = ?
    `).get(projectId, subjectId, taskId) as Record<string, unknown> | undefined;
    return row ? this.mapWorkflowTaskRow(row) : undefined;
  }

  getTaskById(id: number): WorkflowTaskRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM workflow_tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapWorkflowTaskRow(row) : undefined;
  }

  listTasks(projectId: string, subjectId: string): WorkflowTaskRecord[] {
    const rows = this.connection.prepare(`
      SELECT * FROM workflow_tasks
      WHERE project_id = ? AND subject_id = ?
      ORDER BY id
    `).all(projectId, subjectId) as Array<Record<string, unknown>>;
    return rows.map(this.mapWorkflowTaskRow);
  }

  listOpenTasks(projectId: string, subjectId: string): WorkflowTaskRecord[] {
    const rows = this.connection.prepare(`
      SELECT * FROM workflow_tasks
      WHERE project_id = ? AND subject_id = ? AND status = 'open'
      ORDER BY id
    `).all(projectId, subjectId) as Array<Record<string, unknown>>;
    return rows.map(this.mapWorkflowTaskRow);
  }

  listOpenRunnableTasks(projectId?: string | undefined): WorkflowTaskRecord[] {
    const rows = projectId
      ? this.connection.prepare(`
          SELECT * FROM workflow_tasks
          WHERE status = 'open' AND task_type = 'run' AND gate_action = 'start' AND project_id = ?
          ORDER BY updated_at, id
        `).all(projectId) as Array<Record<string, unknown>>
      : this.connection.prepare(`
          SELECT * FROM workflow_tasks
          WHERE status = 'open' AND task_type = 'run' AND gate_action = 'start'
          ORDER BY updated_at, id
        `).all() as Array<Record<string, unknown>>;
    return rows.map(this.mapWorkflowTaskRow);
  }
}
