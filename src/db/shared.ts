import type Database from "better-sqlite3";

export type DatabaseConnection = Database.Database;

export function isoNow(): string {
  return new Date().toISOString();
}
