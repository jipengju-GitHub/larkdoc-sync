import { createHash } from "crypto";
import { createReadStream } from "fs";
import { realpath, stat } from "fs/promises";
import { basename, extname, isAbsolute, posix, relative, resolve, sep } from "path";
import { isSupportedLocalMediaPath, resolveLocalImageVaultPath, type LocalImageFileIndex } from "./local-image";
import { transformProse } from "./obsidian-export";

export interface LocalAttachment {
	vaultPath: string;
	absolutePath: string;
	contentHash: string;
}

function isAttachmentPath(path: string): boolean {
	return Boolean(extname(path)) && !/\.(?:md|markdown)$/i.test(path) && !isSupportedLocalMediaPath(path)
		&& !path.replace(/\\/g, "/").split("/").some((part) => part.startsWith("."));
}

export async function hashAttachment(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

export async function resolveAttachmentFile(vaultRoot: string, vaultPath: string): Promise<string> {
	const root = await realpath(vaultRoot);
	const absolutePath = await realpath(resolve(root, vaultPath));
	const rel = relative(root, absolutePath);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !(await stat(absolutePath)).isFile()) {
		throw new Error("附件必须位于 Vault 内 / Attachment must be a file inside the vault");
	}
	return absolutePath;
}

export async function prepareLocalAttachments(input: {
	content: string;
	markdownPath: string;
	managedPaths?: readonly string[];
	getVaultRoot(): string;
	getPaths(): Iterable<string>;
	resolvePath?(target: string, sourcePath: string): string | null;
	isExcluded?(path: string): boolean;
}): Promise<{ content: string; attachments: LocalAttachment[] }> {
	let index: LocalImageFileIndex | undefined;
	const paths = new Set<string>();
	const content = transformProse(input.content, (text) => text.replace(
		/!?\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]|!?\[([^\]\n]*)\]\((<[^>\n]+>|(?:\\[ ()]|[^\s()\\])+)(?:\s+["'][^\n]*?["'])?\)/g,
		(syntax: string, wiki: string | undefined, alias: string | undefined, label: string | undefined, md: string | undefined, start: number) => {
			let escapes = 0;
			for (let i = start - 1; i >= 0 && text[i] === "\\"; i--) escapes++;
			if (escapes % 2) return syntax;
			const raw = (wiki ?? md ?? "").trim().replace(/^<|>$/g, "").replace(/\\([ ()])/g, "$1");
			const [encoded = "", fragment = ""] = raw.split("#", 2);
			if (!encoded || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|[/\\])/.test(encoded)) return syntax;
			let target: string;
			try { target = decodeURIComponent(encoded).replace(/\\/g, "/"); } catch { return syntax; }
			if (isAbsolute(target) || /^[A-Za-z]:/.test(target)
				|| !isAttachmentPath(target.replace(/^(?:\.{1,2}\/)+/, ""))) return syntax;
			// Explicit PDF page embeds belong to the PDF renderer, including its error handling.
			if (syntax.startsWith("!") && /\.pdf$/i.test(target) && new URLSearchParams(fragment).has("page")) return syntax;
			if (!index) {
				index = { paths: new Set(), pathsByBasename: new Map() };
				for (const path of input.getPaths()) {
					if (!isAttachmentPath(path)) continue;
					index.paths.add(path);
					const name = basename(path);
					const same = index.pathsByBasename.get(name) ?? [];
					same.push(path);
					index.pathsByBasename.set(name, same);
				}
			}
			const normalized = posix.normalize(target);
			const sourceRelative = posix.normalize(posix.join(posix.dirname(input.markdownPath), target));
			const explicit = !wiki || target.startsWith("./") || target.startsWith("../");
			const metadataPath = !explicit && !normalized.includes("/") ? input.resolvePath?.(target, input.markdownPath) : null;
			const path = explicit ? (index.paths.has(sourceRelative) ? sourceRelative : null)
				: normalized.includes("/") ? (index.paths.has(sourceRelative) ? sourceRelative : index.paths.has(normalized) ? normalized : null)
				: metadataPath && index.paths.has(metadataPath) ? metadataPath
				: resolveLocalImageVaultPath(encodeURI(target), input.markdownPath, index);
			if (!path) {
				const owned = input.managedPaths?.find((candidate) => candidate === sourceRelative || (!explicit &&
					(candidate === normalized || (!normalized.includes("/") && basename(candidate) === normalized))));
				if (owned) throw new AttachmentSyncError(owned, new Error("找不到本地附件 / Local attachment not found"));
				return syntax;
			}
			const name = basename(path);
			const display = alias || label || name;
			const page = /\.pdf$/i.test(target) ? new URLSearchParams(fragment).get("page") : null;
			const printable = (display === name ? name : `${display} · ${name}`) + (page ? ` · p.${page}` : "");
			if (!input.isExcluded?.(path)) paths.add(path);
			return printable.replace(/[\\`*_[\]<>$~|]/g, "\\$&");
		}
	));
	if (!paths.size) return { content, attachments: [] };
	const root = input.getVaultRoot();
	const attachments: LocalAttachment[] = [];
	for (const vaultPath of paths) {
		try {
			const absolutePath = await resolveAttachmentFile(root, vaultPath);
			attachments.push({ vaultPath, absolutePath, contentHash: await hashAttachment(absolutePath) });
		} catch (error) {
			throw new AttachmentSyncError(vaultPath, error);
		}
	}
	return { content, attachments };
}

export function buildAttachmentInsertArgs(doc: string, name: string): string[] {
	return ["docs", "+media-insert", "--as", "user", "--doc", doc, "--file", `./${name}`, "--type", "file", "--file-view", "card", "--json"];
}

function attr(attrs: string, names: string): string | undefined {
	return attrs.match(new RegExp(`(?:^|\\s)(?:${names})\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2];
}

function isBlockId(id: unknown): id is string {
	return typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(id);
}

function blockId(attrs: string): string | undefined {
	const id = attr(attrs, "id|block-id|block_id|blockId|data-block-id");
	return isBlockId(id) ? id : undefined;
}

export interface AttachmentCard {
	blockId?: string;
	sourceId?: string;
	start: number;
	end: number;
}

/** Parse card-form figure and standalone source. Never match files by their name. */
export function readAttachmentCards(xml: string): AttachmentCard[] {
	return [...xml.matchAll(/<figure\b([^>]*)>[\s\S]*?<\/figure\s*>|<source\b([^>]*?)(?:\/\s*>|>\s*<\/source\s*>)/gi)]
		.flatMap((match) => {
			const start = match.index!;
			const end = start + match[0].length;
			if (match[1] === undefined) return [{ blockId: blockId(match[2] || ""), start, end }];
			const source = /<source\b([^>]*)>/i.exec(match[0]);
			if (!source || attr(match[1], "view-type")?.toLowerCase() === "preview") return [];
			return [{ blockId: blockId(match[1]) || blockId(source[1] || ""), sourceId: blockId(source[1] || ""), start, end }];
		});
}

/** Protect both manual card and preview forms, even when their IDs are unavailable. */
export function hasRemoteFileBlocks(xml: string): boolean {
	return /<source(?=[\s/>])/i.test(xml);
}

export function stripAttachmentCards(xml: string): string {
	let text = xml;
	for (const { start, end } of readAttachmentCards(xml).reverse()) text = text.slice(0, start) + text.slice(end);
	return text;
}

interface StoredAttachment { hash: string; blockId: string }
export interface AttachmentState {
	current: Record<string, StoredAttachment>;
	pending?: { path: string; hash: string; blockId?: string };
}

interface AttachmentSyncHost {
	fetch(): Promise<{ content: string; revisionId?: number }>;
	insert(file: LocalAttachment, begin: () => Promise<void>): Promise<string>;
	delete(blockId: string, revisionId: number): Promise<void>;
	save(state: AttachmentState): Promise<void>;
}

export const ATTACHMENT_RECOVERY_HINT = "检查飞书文档末尾是否已出现新卡片；不要改动旧卡或手工附件。若确认是未登记的新卡，先在飞书删除该新卡。关闭 Obsidian 并备份插件 data.json，再仅移除该文档 attachmentStates 条目下的 pending，重开后同步。 / Check the document end for a new card. Keep prior and manual cards. If the new untracked card is confirmed, remove only that card. Close Obsidian, back up plugin data.json, remove only that document’s pending field in attachmentStates, then reopen and sync.";

export class AttachmentSyncError extends Error {
	readonly code: string;
	constructor(public readonly attachmentPath: string, public readonly cause: unknown, recoveryNeeded = false) {
		super(`附件同步失败 / Attachment sync failed: ${attachmentPath}: ${cause instanceof Error ? cause.message : cause}`);
		this.code = recoveryNeeded ? "ATTACHMENT_RECONCILE_REQUIRED" : "ATTACHMENT_SYNC_FAILED";
	}
}

/** Durable insert-before-delete, with exact ownership IDs and revision-guarded deletes. */
export async function syncLocalAttachments(files: LocalAttachment[], previous: AttachmentState | undefined, host: AttachmentSyncHost): Promise<void> {
	if (!files.length && !previous?.pending && !Object.keys(previous?.current || {}).length) return;
	const state: AttachmentState = { current: Object.assign(Object.create(null) as Record<string, StoredAttachment>, previous?.current),
		...(previous?.pending ? { pending: { ...previous.pending } } : {}) };
	for (const [path, entry] of Object.entries(state.current)) {
		if (!entry || !isBlockId(entry.blockId)) throw new AttachmentSyncError(path, new Error("Invalid persisted attachment block ID"));
	}
	if (state.pending && state.pending.blockId !== undefined && !isBlockId(state.pending.blockId)) {
		throw new AttachmentSyncError(state.pending.path, new Error("Invalid pending attachment block ID"));
	}
	const wanted = new Map(files.map((file) => [file.vaultPath, file]));
	async function remove(id: string): Promise<void> {
		const snapshot = await host.fetch();
		const card = readAttachmentCards(snapshot.content).find((candidate) => candidate.blockId === id);
		if (!card) {
			if (new RegExp(`\\b(?:id|block-id|block_id)=["']${id}["']`).test(snapshot.content)) {
				throw new Error("已记录的块不再是可识别的附件卡片 / Managed block is no longer a recognizable attachment card");
			}
			return;
		}
		if (snapshot.revisionId === undefined) throw new Error("Missing document revision; attachment was not deleted");
		await host.delete(id, snapshot.revisionId);
	}
	async function finishPending(): Promise<void> {
		const pending = state.pending!;
		if (!pending.blockId) throw new Error(`Previous upload outcome unknown. ${ATTACHMENT_RECOVERY_HINT}`);
		const snapshot = await host.fetch();
		const card = readAttachmentCards(snapshot.content).find(({ blockId, sourceId }) => pending.blockId === blockId || pending.blockId === sourceId);
		if (!card?.blockId) throw new Error("无法确认已上传卡片，旧附件已保留；请重试 / Uploaded card is not confirmed; prior attachment retained. Retry sync.");
		const prior = state.current[pending.path];
		if (prior && prior.blockId !== card.blockId) await remove(prior.blockId);
		state.current[pending.path] = { hash: pending.hash, blockId: card.blockId };
		delete state.pending;
		await host.save(state);
	}
	if (state.pending) {
		const path = state.pending.path;
		try { await finishPending(); } catch (error) { throw new AttachmentSyncError(path, error, !state.pending?.blockId); }
	}
	let snapshot = await host.fetch();
	for (const file of files) {
		const path = file.vaultPath;
		try {
			const previousCard = state.current[path];
			if (previousCard?.hash === file.contentHash && readAttachmentCards(snapshot.content).some(({ blockId }) => blockId === previousCard.blockId)) continue;
			const id = await host.insert(file, async () => {
				state.pending = { path, hash: file.contentHash };
				await host.save(state);
			});
			if (!state.pending || !isBlockId(id)) throw new Error("Attachment insert returned no valid block ID");
			state.pending.blockId = id;
			await host.save(state);
			await finishPending();
			snapshot = await host.fetch();
		} catch (error) {
			// A documented permission rejection happens before any mutation; transport errors are ambiguous.
			const code = (error as { larkCode?: string } | undefined)?.larkCode;
			if (state.pending && !state.pending.blockId && (code === "missing_scope" || code === "99991672")) {
				delete state.pending;
				await host.save(state);
			}
			throw new AttachmentSyncError(path, error, Boolean(state.pending && !state.pending.blockId));
		}
	}
	for (const [path, entry] of Object.entries(state.current)) {
		if (wanted.has(path)) continue;
		try {
			await remove(entry.blockId);
			delete state.current[path];
			await host.save(state);
		} catch (error) { throw new AttachmentSyncError(path, error); }
	}
}
