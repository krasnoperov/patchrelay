import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite";

export interface StatementResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface DatabaseStatement {
  run(...parameters: unknown[]): StatementResult;
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  all(...parameters: unknown[]): Record<string, unknown>[];
}

function isSqlInputValue(value: unknown): value is SQLInputValue {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || ArrayBuffer.isView(value);
}

function toSqlInputValue(value: unknown): SQLInputValue {
  if (!isSqlInputValue(value)) {
    throw new TypeError(`Unsupported SQLite parameter type: ${typeof value}`);
  }
  return value;
}

function toNamedParameters(value: Record<string, unknown>): Record<string, SQLInputValue> {
  const normalized: Record<string, SQLInputValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    normalized[key] = toSqlInputValue(entry);
  }
  return normalized;
}

function normalizeParameters(parameters: unknown[]): SQLInputValue[] | Record<string, SQLInputValue> {
  if (parameters.length === 1) {
    const [value] = parameters;
    if (Array.isArray(value)) return value.map(toSqlInputValue);
    if (value && typeof value === "object") return toNamedParameters(value as Record<string, unknown>);
  }
  return parameters.map(toSqlInputValue);
}

class SqliteStatementAdapter implements DatabaseStatement {
  constructor(private readonly statement: StatementSync) {}

  run(...parameters: unknown[]): StatementResult {
    const normalized = normalizeParameters(parameters);
    return Array.isArray(normalized) ? this.statement.run(...normalized) : this.statement.run(normalized);
  }

  get(...parameters: unknown[]): Record<string, unknown> | undefined {
    const normalized = normalizeParameters(parameters);
    return Array.isArray(normalized)
      ? this.statement.get(...normalized) as Record<string, SQLOutputValue> | undefined
      : this.statement.get(normalized) as Record<string, SQLOutputValue> | undefined;
  }

  all(...parameters: unknown[]): Record<string, unknown>[] {
    const normalized = normalizeParameters(parameters);
    return Array.isArray(normalized)
      ? this.statement.all(...normalized) as Record<string, SQLOutputValue>[]
      : this.statement.all(normalized) as Record<string, SQLOutputValue>[];
  }
}

export class SqliteConnection {
  private readonly database: DatabaseSync;

  constructor(filePath: string) {
    this.database = new DatabaseSync(filePath);
  }

  close(): void {
    this.database.close();
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  pragma(statement: string): void {
    this.database.exec(`PRAGMA ${statement}`);
  }

  prepare(sql: string): DatabaseStatement {
    return new SqliteStatementAdapter(this.database.prepare(sql));
  }
}

export function isoNow(): string {
  return new Date().toISOString();
}
