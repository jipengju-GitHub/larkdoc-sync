import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { outputFiles } = await build({ entryPoints: ["src/local-attachments.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { prepareLocalAttachments, syncLocalAttachments, stripAttachmentCards, hasRemoteFileBlocks, buildAttachmentInsertArgs } =
	await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
const root = await mkdtemp(join(tmpdir(), "lark-attachments-"));
try {
	await mkdir(join(root, "docs"));
	await mkdir(join(root, "other"));
	await writeFile(join(root, "other", "private.csv"), "private");
	for (const file of ["report 1.pdf", "budget.xlsx", "never.zip", "picture.png"]) await writeFile(join(root, "docs", file), file);
	const content = '[[report 1.pdf|Report]] [budget](budget.xlsx) [[budget.xlsx]] ![[report 1.pdf#page=2]] ![[picture.png]] [old](missing.csv) [[missing/never.zip]] `[[never.zip]]` [web](https://example.com/n.zip)';
	const input = { content, markdownPath: "docs/note.md", getVaultRoot: () => root,
		getPaths: () => ["docs/report 1.pdf", "docs/budget.xlsx", "docs/never.zip", "docs/picture.png"] };
	const prepared = await prepareLocalAttachments(input);
	assert.deepEqual(prepared.attachments.map(({ vaultPath }) => vaultPath), ["docs/report 1.pdf", "docs/budget.xlsx"]);
	assert.match(prepared.content, /Report · report 1\.pdf/);
	assert.match(prepared.content, /!\[\[report 1\.pdf#page=2\]\] !\[\[picture\.png\]\]/);
	assert.ok(prepared.content.includes('[old](missing.csv) [[missing/never.zip]] `[[never.zip]]` [web](https://example.com/n.zip)'));
	await assert.rejects(prepareLocalAttachments({ ...input, managedPaths: ["docs/missing.csv"] }), { attachmentPath: "docs/missing.csv" });
	const explicit = await prepareLocalAttachments({ ...input, content: "[missing](./private.csv) [explicit](../other/private.csv)", getPaths: () => ["other/private.csv"] });
	assert.deepEqual(explicit.attachments.map(({ vaultPath }) => vaultPath), ["other/private.csv"]);
	assert.match(explicit.content, /missing.*\.\/private\.csv/);
} finally { await rm(root, { recursive: true, force: true }); }
assert.deepEqual(buildAttachmentInsertArgs("doc1", "file a.pdf"), ["docs", "+media-insert", "--as", "user", "--doc", "doc1", "--file", "./file a.pdf", "--type", "file", "--file-view", "card", "--json"]);
const card = (id, child) => `<figure id="${id}" view-type="card"><source id="${child}" name="budget.xlsx"/></figure>`;
const manual = card("manual", "manual-source");
const preview = `<figure id="video" view-type="preview"><source id="v"/></figure>`;
assert.equal(stripAttachmentCards(`<p id="text">Text</p>${manual}<source id="standalone"/>${preview}`), `<p id="text">Text</p>${preview}`);
assert.equal(hasRemoteFileBlocks(preview), true);
const cards = new Map([["manual", manual]]);
let state; let writes = []; let n = 0; let failInsert = false; let failDelete = false; let revisionId = 1;
const file = { vaultPath: "docs/budget.xlsx", absolutePath: "budget.xlsx", contentHash: "one" };
const host = {
	fetch: async () => ({ content: `<p id="text">Text</p>${[...cards.values()].join("")}`, revisionId }),
	insert: async (_file, begin) => {
		if (failInsert) throw new Error("local staging failed");
		await begin();
		assert.equal(state.pending.blockId, undefined);
		const id = `owned${++n}`; cards.set(id, card(id, `${id}-source`)); writes.push(`insert:${id}`); revisionId++;
		return `${id}-source`;
	},
	delete: async (id, revision) => {
		assert.equal(revision, revisionId);
		if (failDelete) throw new Error("revision changed");
		assert.notEqual(id, "manual");
		writes.push(`delete:${id}`); cards.delete(id); revisionId++;
	},
	save: async (next) => { state = structuredClone(next); }
};
await syncLocalAttachments([file], state, host);
assert.equal(state.current[file.vaultPath].blockId, "owned1");
await syncLocalAttachments([file], state, host);
assert.deepEqual(writes, ["insert:owned1"]);
const updated = { ...file, contentHash: "two" };
failInsert = true;
await assert.rejects(syncLocalAttachments([updated], state, host), { code: "ATTACHMENT_SYNC_FAILED", attachmentPath: file.vaultPath });
assert.deepEqual([...cards.keys()], ["manual", "owned1"]);
failInsert = false; failDelete = true;
await assert.rejects(syncLocalAttachments([updated], state, host), /revision changed/);
assert.equal(state.pending.blockId, "owned2-source");
assert.deepEqual([...cards.keys()], ["manual", "owned1", "owned2"]);
failDelete = false;
await syncLocalAttachments([updated], state, host);
assert.deepEqual(writes, ["insert:owned1", "insert:owned2", "delete:owned1"]);
assert.equal(state.pending, undefined);
await syncLocalAttachments([], state, host);
assert.deepEqual([...cards.keys()], ["manual"]);
assert.deepEqual(writes, ["insert:owned1", "insert:owned2", "delete:owned1", "delete:owned2"]);
let uncertainCalls = 0;
const uncertainHost = { ...host, insert: async (_file, begin) => {
	await begin();
	uncertainCalls++;
	throw new Error("response lost");
} };
await assert.rejects(syncLocalAttachments([file], state, uncertainHost), { code: "ATTACHMENT_RECONCILE_REQUIRED" });
await assert.rejects(syncLocalAttachments([file], state, uncertainHost), /outcome unknown/);
assert.equal(uncertainCalls, 1);
assert.equal(state.pending.path, file.vaultPath);
await assert.rejects(syncLocalAttachments([file], { current: { [file.vaultPath]: { hash: "one", blockId: "invalid.*" } } }, host), /Invalid persisted/);
state = { current: {} };
await assert.rejects(syncLocalAttachments([file], state, { ...host, insert: async (_file, begin) => {
	await begin();
	throw Object.assign(new Error("permission denied"), { larkCode: "missing_scope" });
} }), { code: "ATTACHMENT_SYNC_FAILED" });
assert.equal(state.pending, undefined);
console.log("Local attachment resolution, no-op, update, retry, and removal tests passed");
