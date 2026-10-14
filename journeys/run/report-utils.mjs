// Pure helpers for the journey runner: reading journey XML, sharding, and writing results.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(value) {
	return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]).replace(/\s+/g, " ").trim();
}

function encode(value) {
	return String(value).replace(/[&<>"']/g, (c) => `&${Object.keys(ENTITIES).find((k) => ENTITIES[k] === c)};`);
}

/** The journey's name, description and actions, in order, as written in its XML. */
export function parseJourney(id, xml) {
	const name = xml.match(/<journey\s+name="([^"]*)"/)?.[1];
	if (!name) throw new Error(`${id}: no <journey name="…">`);
	const description = xml.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "";
	const actions = [...xml.matchAll(/<action>([\s\S]*?)<\/action>/g)].map((m) => decode(m[1]));
	if (actions.length === 0) throw new Error(`${id}: no <action>s`);
	return { id, name: decode(name), description: decode(description), actions };
}

/** Shard "k/n" (1-based) of the list, dealt round-robin so the slow offline journeys spread out. */
export function shardOf(items, spec) {
	const match = /^(\d+)\/(\d+)$/.exec(spec);
	if (!match) throw new Error(`--shard must look like 1/3, got ${spec}`);
	const [k, n] = [Number(match[1]), Number(match[2])];
	if (k < 1 || k > n) throw new Error(`--shard ${spec} is out of range`);
	return items.filter((_, i) => i % n === k - 1);
}

const icon = { passed: "✅", failed: "❌", skipped: "⏭️", unscripted: "🚧" };

export function markdownSummary(results, meta = {}) {
	const lines = [];
	const passed = results.filter((r) => !r.error && !r.unscripted).length;
	lines.push(`## Journeys${meta.shard && meta.shard !== "all" ? ` (shard ${meta.shard})` : ""}: ${passed}/${results.length} passed`);
	lines.push("");
	if (meta.chrome || meta.sdk) lines.push(`Android SDK ${meta.sdk ?? "?"}, Chrome ${meta.chrome ?? "?"}, ${Math.round((meta.durationMs ?? 0) / 1000)} s.`, "");
	lines.push("| Journey | Result |", "|---|---|");
	for (const r of results) {
		const failedStep = r.steps.findIndex((s) => s.status === "failed");
		const detail = r.unscripted ? "🚧 not scripted yet" : r.error ? `❌ action ${failedStep + 1}: ${oneLine(r.error)}` : "✅";
		lines.push(`| ${r.id} | ${detail.replace(/\|/g, "\\|")} |`);
	}
	for (const r of results) {
		lines.push("", `### ${r.id}: ${r.name} ${r.unscripted ? "🚧" : r.error ? "❌" : "✅"} (${Math.round((r.durationMs ?? 0) / 100) / 10} s)`, "");
		r.steps.forEach((s, i) => {
			lines.push(`${i + 1}. ${icon[s.status]} ${s.label}`);
			if (s.error) lines.push(`   - ${oneLine(s.error)}`);
			if (s.screenshot) lines.push(`   - Screenshot: \`${s.screenshot}\``);
		});
	}
	return `${lines.join("\n")}\n`;
}

export function junitXml(results, meta = {}) {
	const cases = results.flatMap((r) => r.steps.map((s, i) => ({ r, s, i })));
	const failures = cases.filter(({ s }) => s.status === "failed").length;
	const skipped = cases.filter(({ s }) => s.status === "skipped" || s.status === "unscripted").length;
	const out = [`<?xml version="1.0" encoding="UTF-8"?>`, `<testsuites name="journeys${meta.shard && meta.shard !== "all" ? ` ${encode(meta.shard)}` : ""}" tests="${cases.length}" failures="${failures}" skipped="${skipped}" time="${((meta.durationMs ?? 0) / 1000).toFixed(1)}">`];
	for (const r of results) {
		const rf = r.steps.filter((s) => s.status === "failed").length;
		const rs = r.steps.filter((s) => s.status === "skipped" || s.status === "unscripted").length;
		out.push(`\t<testsuite name="${encode(`${r.id}: ${r.name}`)}" tests="${r.steps.length}" failures="${rf}" skipped="${rs}" time="${((r.durationMs ?? 0) / 1000).toFixed(1)}">`);
		r.steps.forEach((s, i) => {
			const name = encode(`${String(i + 1).padStart(2, "0")}. ${s.label}`);
			const time = ((s.durationMs ?? 0) / 1000).toFixed(1);
			if (s.status === "passed") out.push(`\t\t<testcase classname="${encode(r.id)}" name="${name}" time="${time}"/>`);
			else if (s.status === "unscripted") out.push(`\t\t<testcase classname="${encode(r.id)}" name="${name}" time="0"><skipped message="not scripted yet"/></testcase>`);
			else if (s.status === "skipped") out.push(`\t\t<testcase classname="${encode(r.id)}" name="${name}" time="0"><skipped message="an earlier action failed"/></testcase>`);
			else out.push(`\t\t<testcase classname="${encode(r.id)}" name="${name}" time="${time}"><failure message="${encode(oneLine(s.error ?? "failed"))}">${encode(s.error ?? "")}${s.screenshot ? encode(`\nScreenshot: ${s.screenshot}`) : ""}</failure></testcase>`);
		});
		out.push("\t</testsuite>");
	}
	out.push("</testsuites>");
	return `${out.join("\n")}\n`;
}

function oneLine(text) {
	const first = String(text).split("\n")[0];
	return first.length > 300 ? `${first.slice(0, 297)}…` : first;
}
