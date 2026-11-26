import { randomUUID } from "crypto";
import { readFile, rename, rm, writeFile } from "fs/promises";

export interface PublishLogEntry {
	at: string;
	path: string;
	action: "publish" | "sync" | "overwrite";
	source: "manual" | "save" | "folder";
	status: "success" | "failed";
	code?: string;
}

type PublishLogTarget = Pick<PublishLogEntry, "path" | "action" | "source">;
const LIMIT = 500;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function validCode(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value) && value !== 0) return String(value);
	if (typeof value === "string" && value.length <= 40 && /^(?:-?[1-9]\d{0,15}|[A-Z][A-Z0-9_]{0,39}|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)$/.test(value)) return value;
	return undefined;
}

export function getPublishErrorCode(error: unknown): string {
	let local: string | undefined;
	const seen = new Set<unknown>();
	for (let current = record(error); current && !seen.has(current); current = record(current.cause)) {
		seen.add(current);
		const remote = validCode(current.larkCode);
		if (remote) return remote;
		local ??= validCode(current.code);
	}
	return local ?? "SYNC_FAILED";
}

function isEntry(value: unknown): value is PublishLogEntry {
	const row = record(value);
	return !!row && typeof row.at === "string" && Number.isFinite(Date.parse(row.at)) && typeof row.path === "string"
		&& (row.action === "publish" || row.action === "sync" || row.action === "overwrite")
		&& (row.source === "manual" || row.source === "save" || row.source === "folder")
		&& (row.status === "success" || row.status === "failed") && (row.code === undefined || validCode(row.code) === row.code);
}

/** Per-vault, local-only, newest-first history. Serializes updates from parallel folder workers. */
export class PublishLog {
	private writes: Promise<void> = Promise.resolve();

	constructor(private readonly file: string) {}

	async list(): Promise<readonly PublishLogEntry[]> {
		await this.writes;
		return this.read();
	}

	add(target: PublishLogTarget, outcome: { status: "success" } | { status: "failed"; error: unknown }): Promise<void> {
		const row: PublishLogEntry = { ...target, at: new Date().toISOString(), status: outcome.status };
		if (outcome.status === "failed") row.code = getPublishErrorCode(outcome.error);
		const next = this.writes.then(async () => {
			const entries = [row, ...(await this.read())].slice(0, LIMIT);
			const temporary = `${this.file}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, JSON.stringify(entries), { encoding: "utf8", flag: "wx" });
				await rename(temporary, this.file);
			} finally {
				await rm(temporary, { force: true }).catch(() => {});
			}
		});
		this.writes = next.catch(() => {});
		return next;
	}

	private async read(): Promise<PublishLogEntry[]> {
		let raw: string;
		try { raw = await readFile(this.file, "utf8"); }
		catch (error) {
			if (record(error)?.code === "ENOENT") return [];
			throw error;
		}
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) throw new Error("Invalid publish log");
		return parsed.filter(isEntry).slice(0, LIMIT);
	}
}

export class PublishAttempt {
	changed = false;
	constructor(public action: PublishLogEntry["action"]) {}
	markChanged = (): void => { this.changed = true; };
	markPublished = (): void => {
		if (this.action !== "overwrite") this.action = "publish";
		this.markChanged();
	};
}

export class LarkCommandError extends Error {
	constructor(message: string, public readonly larkCode?: string, public readonly cause?: unknown) {
		super(message);
	}
}

export function readLarkErrorCode(result: unknown): string | undefined {
	const envelope = record(result);
	const failure = record(envelope?.error);
	return validCode(failure?.code) ?? validCode(envelope?.code);
}