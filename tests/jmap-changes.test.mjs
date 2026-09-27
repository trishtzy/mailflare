import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The JMAP /changes methods answer from a trigger-maintained change log, so
 * they are exercised against a real SQLite database: the repository's own
 * migrations applied through the self-hosted runtime's D1-compatible wrapper,
 * which is the same path the Node server takes at start. No Workers binding
 * is involved; the database lives in memory.
 */
// The bundle keeps better-sqlite3 (a native module) external, so it is written
// under node_modules where Node can resolve that package from it.
const cacheDir = join(root, "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const outDir = mkdtempSync(join(cacheDir, "mailflare-jmap-changes-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createDb } from "./src/db/index.ts";
			export { users, domains, mailboxes, folders, messages, jmapChangeLog } from "./src/db/schema/index.ts";
			export { processRequest, validateRequest } from "./src/lib/jmap/processor.ts";
			export { getEmailState, getMailboxState } from "./src/lib/jmap/state.ts";
			export { pruneChangeLog, resetPruneTimer, loadChangeRows } from "./src/lib/jmap/changes.ts";
			export { sessionState } from "./src/lib/jmap/processor.ts";
			export { classifyChanges, takeChangeWindow, diffQueryResults, parseSeqState } from "./src/lib/jmap/changes-utils.ts";
			export { encodeMailboxRef } from "./src/lib/jmap/ids.ts";
			export { eq, sql } from "drizzle-orm";
		`,
		resolveDir: root,
		sourcefile: "jmap-changes-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3"],
	logLevel: "silent",
});

const m = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const USER = { id: "usr_test", email: "me@example.test", role: "user" };
const MAILBOX = "mbx_test";
const INBOX = m.encodeMailboxRef({ kind: "role", mailboxId: MAILBOX, role: "inbox" });

let database;
let db;
let ctx;
let messageCounter = 0;

before(async () => {
	database = new m.SqliteDatabase(":memory:");
	await m.applyMigrations(database, join(root, "drizzle", "migrations"));
	db = m.createDb(database);
	await db.insert(m.users).values({ id: USER.id, email: USER.email, passwordHash: "x", name: "Test" });
	await db.insert(m.domains).values({ id: "dom_test", userId: USER.id, hostname: "example.test", zoneId: "zone", status: "active" });
	await db.insert(m.mailboxes).values({ id: MAILBOX, userId: USER.id, domainId: "dom_test", localPart: "me" });
	ctx = {
		env: { DB: database },
		db,
		auth: { userId: USER.id, email: USER.email, scopes: ["jmap"], user: USER },
		accountId: USER.id,
		origin: "http://localhost",
		createdIds: {},
	};
});

async function call(name, args) {
	const response = await m.processRequest(ctx, m.validateRequest({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: [[name, { accountId: USER.id, ...args }, "c1"]] }));
	const [responseName, result] = response.methodResponses[0];
	return { name: responseName, ...result };
}

async function insertMessage(overrides = {}) {
	messageCounter += 1;
	const id = `msg_${messageCounter}`;
	await db.insert(m.messages).values({
		id,
		userId: USER.id,
		mailboxId: MAILBOX,
		direction: "inbound",
		fromAddr: "sender@example.org",
		toAddr: "me@example.test",
		subject: `Message ${messageCounter}`,
		status: "received",
		createdAt: new Date(1_700_000_000_000 + messageCounter * 60_000),
		...overrides,
	});
	return id;
}

test("states start at zero and a client at the current state gets an empty change set", async () => {
	assert.equal(await m.getEmailState(ctx), "0");
	const changes = await call("Email/changes", { sinceState: "0" });
	assert.equal(changes.name, "Email/changes");
	assert.deepEqual([changes.created, changes.updated, changes.destroyed, changes.hasMoreChanges], [[], [], [], false]);
	assert.equal(changes.newState, "0");
});

test("a delivered message is reported as created, then updated, then destroyed", async () => {
	const before = await m.getEmailState(ctx);
	const id = await insertMessage();
	const created = await call("Email/changes", { sinceState: before });
	assert.deepEqual(created.created, [id]);
	assert.deepEqual(created.updated, []);
	assert.notEqual(created.newState, before);

	await db.update(m.messages).set({ read: true }).where(m.eq(m.messages.id, id));
	const updated = await call("Email/changes", { sinceState: created.newState });
	assert.deepEqual(updated.updated, [id]);
	assert.deepEqual(updated.created, []);

	// The whole history from before the insert still reads as a single create.
	const sinceStart = await call("Email/changes", { sinceState: before });
	assert.deepEqual(sinceStart.created, [id]);
	assert.deepEqual(sinceStart.updated, []);

	await db.delete(m.messages).where(m.eq(m.messages.id, id));
	const destroyed = await call("Email/changes", { sinceState: updated.newState });
	assert.deepEqual(destroyed.destroyed, [id]);
	// Created and destroyed inside one window cancels out.
	const whole = await call("Email/changes", { sinceState: before });
	assert.deepEqual([whole.created, whole.updated, whole.destroyed], [[], [], []]);
});

test("the session state depends on the account only, never on mail", async () => {
	const before = await m.sessionState(ctx);
	await insertMessage();
	assert.equal(await m.sessionState(ctx), before);
	assert.notEqual(await m.getMailboxState(ctx), before);
});

test("change rows are read only up to the sequence reported as the new state", async () => {
	const since = Number(await m.getEmailState(ctx));
	const first = await insertMessage();
	const upper = Number(await m.getEmailState(ctx));
	await insertMessage();
	const rows = await m.loadChangeRows(ctx, [MAILBOX], since, upper, "email");
	assert.deepEqual(rows.map((row) => row.objectId), [first]);
});

test("writes that do not change the JMAP Email object do not move the state", async () => {
	const id = await insertMessage({ read: true });
	const state = await m.getEmailState(ctx);
	await db.update(m.messages).set({ spamScore: 3, spamVerdict: "inbox", spamAnalyzedAt: new Date() }).where(m.eq(m.messages.id, id));
	await db.update(m.messages).set({ read: true }).where(m.eq(m.messages.id, id));
	assert.equal(await m.getEmailState(ctx), state);
});

test("unknown, outdated and future states answer cannotCalculateChanges", async () => {
	const legacy = await call("Email/changes", { sinceState: "12.345.6.7.8.0" });
	assert.equal(legacy.name, "error");
	assert.equal(legacy.type, "cannotCalculateChanges");
	const future = await call("Email/changes", { sinceState: String(Number(await m.getEmailState(ctx)) + 50) });
	assert.equal(future.type, "cannotCalculateChanges");
	const thread = await call("Thread/changes", { sinceState: "nonsense" });
	assert.equal(thread.type, "cannotCalculateChanges");
	const mailbox = await call("Mailbox/changes", { sinceState: "3.4.5.6.7.8.9.0" });
	assert.equal(mailbox.type, "cannotCalculateChanges");
});

test("maxChanges cuts on a sequence boundary and hasMoreChanges resumes from newState", async () => {
	const before = await m.getEmailState(ctx);
	const ids = [await insertMessage(), await insertMessage(), await insertMessage()];
	const first = await call("Email/changes", { sinceState: before, maxChanges: 2 });
	assert.deepEqual(first.created, ids.slice(0, 2));
	assert.equal(first.hasMoreChanges, true);
	const second = await call("Email/changes", { sinceState: first.newState, maxChanges: 2 });
	assert.deepEqual(second.created, [ids[2]]);
	assert.equal(second.hasMoreChanges, false);
	assert.equal(second.newState, await m.getEmailState(ctx));
	const invalid = await call("Email/changes", { sinceState: before, maxChanges: 0 });
	assert.equal(invalid.type, "invalidArguments");
});

test("Thread/changes follows the messages in a thread", async () => {
	const before = await m.getEmailState(ctx);
	const root = await insertMessage();
	const created = await call("Thread/changes", { sinceState: before });
	assert.deepEqual(created.created, [root]);

	const reply = await insertMessage({ threadId: root });
	const updated = await call("Thread/changes", { sinceState: created.newState });
	assert.deepEqual(updated.updated, [root]);
	assert.deepEqual(updated.created, []);

	const got = await call("Thread/get", { ids: [root] });
	assert.deepEqual(got.list, [{ id: root, emailIds: [root, reply] }]);

	await db.delete(m.messages).where(m.eq(m.messages.threadId, root));
	await db.delete(m.messages).where(m.eq(m.messages.id, root));
	const destroyed = await call("Thread/changes", { sinceState: updated.newState });
	assert.deepEqual(destroyed.destroyed, [root]);
});

test("Mailbox/changes reports count-only updates and folder lifecycle", async () => {
	const before = await m.getMailboxState(ctx);
	await insertMessage();
	const counts = await call("Mailbox/changes", { sinceState: before });
	assert.equal(counts.name, "Mailbox/changes");
	assert.ok(counts.updated.includes(INBOX));
	assert.ok(counts.updated.includes(MAILBOX));
	assert.deepEqual(counts.updatedProperties, ["totalEmails", "unreadEmails", "totalThreads", "unreadThreads"]);
	assert.deepEqual(counts.created, []);

	await db.insert(m.folders).values({ id: "fld_1", userId: USER.id, mailboxId: MAILBOX, name: "Receipts" });
	const folderRef = m.encodeMailboxRef({ kind: "folder", mailboxId: MAILBOX, folderId: "fld_1" });
	const created = await call("Mailbox/changes", { sinceState: counts.newState });
	assert.deepEqual(created.created, [folderRef]);

	await db.update(m.folders).set({ name: "Invoices" }).where(m.eq(m.folders.id, "fld_1"));
	const renamed = await call("Mailbox/changes", { sinceState: created.newState });
	assert.deepEqual(renamed.updated, [folderRef]);
	assert.equal(renamed.updatedProperties, null);

	await db.delete(m.folders).where(m.eq(m.folders.id, "fld_1"));
	const destroyed = await call("Mailbox/changes", { sinceState: renamed.newState });
	assert.deepEqual(destroyed.destroyed, [folderRef]);

	// A different set of accessible mailboxes invalidates the digest.
	const foreign = await call("Mailbox/changes", { sinceState: `${destroyed.newState.split("-")[0]}-00000000` });
	assert.equal(foreign.type, "cannotCalculateChanges");
});

test("Email/queryChanges removes changed ids and adds back the ones that still match", async () => {
	const query = { filter: { inMailbox: INBOX }, sort: [{ property: "receivedAt", isAscending: false }] };
	const initial = await call("Email/query", query);
	assert.equal(initial.canCalculateChanges, true);
	const newest = await insertMessage();
	const added = await call("Email/queryChanges", { ...query, sinceQueryState: initial.queryState, calculateTotal: true });
	assert.equal(added.name, "Email/queryChanges");
	assert.deepEqual(added.removed, [newest]);
	assert.deepEqual(added.added, [{ id: newest, index: 0 }]);
	assert.equal(added.total, initial.ids.length + 1);
	// One id removed and re-added counts twice against maxChanges.
	const capped = await call("Email/queryChanges", { ...query, sinceQueryState: initial.queryState, maxChanges: 1 });
	assert.equal(capped.type, "tooManyChanges");

	await db.update(m.messages).set({ status: "archived" }).where(m.eq(m.messages.id, newest));
	const removed = await call("Email/queryChanges", { ...query, sinceQueryState: added.newQueryState });
	assert.deepEqual(removed.removed, [newest]);
	assert.deepEqual(removed.added, []);
});

test("Email/queryChanges with collapseThreads re-adds the thread's current representative", async () => {
	const query = { filter: { inMailbox: INBOX }, sort: [{ property: "receivedAt", isAscending: false }], collapseThreads: true };
	const root = await insertMessage();
	const initial = await call("Email/query", query);
	assert.equal(initial.ids[0], root);
	const reply = await insertMessage({ threadId: root });
	const changes = await call("Email/queryChanges", { ...query, sinceQueryState: initial.queryState });
	// The old representative has no change row of its own but is displaced, so it is removed too.
	assert.deepEqual(new Set(changes.removed), new Set([root, reply]));
	assert.deepEqual(changes.added, [{ id: reply, index: 0 }]);
});

test("pruning drops old history from the front and keeps the newest row", async () => {
	const before = await m.getEmailState(ctx);
	await insertMessage();
	const middle = await m.getEmailState(ctx);
	await insertMessage();
	const fortyDaysAgo = Math.floor(Date.now() / 1000) - 40 * 24 * 60 * 60;
	await db.run(m.sql`update jmap_change_log set created_at = ${fortyDaysAgo} where seq <= ${Number(middle)}`);
	m.resetPruneTimer();
	await m.pruneChangeLog(ctx);
	const [{ oldest }] = await db.all(m.sql`select min(seq) as oldest from jmap_change_log`);
	assert.equal(oldest, Number(middle) + 1);

	const stale = await call("Email/changes", { sinceState: before });
	assert.equal(stale.type, "cannotCalculateChanges");
	const fresh = await call("Email/changes", { sinceState: middle });
	assert.equal(fresh.name, "Email/changes");
	assert.equal(fresh.created.length, 1);

	// Everything old on a quiet server: the newest row survives so the state does not regress.
	await db.run(m.sql`update jmap_change_log set created_at = ${fortyDaysAgo}`);
	m.resetPruneTimer();
	await m.pruneChangeLog(ctx);
	assert.equal(await m.getEmailState(ctx), fresh.newState);
});

test("pure helpers: window cutting and classification", () => {
	const rows = [
		{ seq: 1, type: "email", objectId: "a", mailboxId: "m", threadKey: "a", kind: "created" },
		{ seq: 2, type: "email", objectId: "a", mailboxId: "m", threadKey: "a", kind: "updated" },
		{ seq: 3, type: "email", objectId: "b", mailboxId: "m", threadKey: "b", kind: "updated" },
		{ seq: 4, type: "email", objectId: "c", mailboxId: "m", threadKey: "c", kind: "created" },
		{ seq: 5, type: "email", objectId: "c", mailboxId: "m", threadKey: "c", kind: "destroyed" },
		{ seq: 6, type: "email", objectId: "d", mailboxId: "m", threadKey: "d", kind: "destroyed" },
	];
	assert.deepEqual(m.classifyChanges(rows), { created: ["a"], updated: ["b"], destroyed: ["d"] });
	const window = m.takeChangeWindow(rows, (row) => row.objectId, 2, 9);
	assert.deepEqual(window.rows.map((row) => row.seq), [1, 2, 3]);
	assert.deepEqual([window.newSeq, window.hasMore], [3, true]);
	assert.deepEqual(m.takeChangeWindow(rows, (row) => row.objectId, null, 9), { rows, newSeq: 9, hasMore: false });
	assert.deepEqual(m.diffQueryResults(["b", "x"], ["a", "b", "c"], null), { removed: ["b", "x"], added: [{ id: "b", index: 1 }] });
	assert.deepEqual(m.diffQueryResults(["c"], ["a", "b", "c"], "b").added, []);
	assert.equal(m.parseSeqState("42"), 42);
	assert.equal(m.parseSeqState("4.2"), null);
	assert.equal(m.parseSeqState(42), null);
});
