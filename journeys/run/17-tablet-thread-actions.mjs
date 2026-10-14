import { APP, expect, fail, sleep } from "./harness.mjs";

// The CI device is a phone: the journey makes it a 1280×800 screen at density 200, which Chrome
// lays out 1024 CSS pixels wide (the tablet band), and puts the phone back in teardown.
async function tabletScreen(device, on) {
	await device.shell(on ? "wm size 1280x800 && wm density 200" : "wm size reset && wm density reset");
	const size = (await device.shell("wm size")).match(/(\d+)x(\d+)\s*$/m);
	device.width = Number(size[1]);
	device.height = Number(size[2]);
}

const MENU = '#main .msg.is-last details[data-menu="message"] > summary';
const DETAILS = "#main .msg.is-last .msg-recipients [data-details]";
// A tap counts as "as soon as it opens" when it lands within this long of the conversation being swapped in.
const AT_ONCE_MS = 15;

/** Where `selector` sits on the open conversation, in page pixels. */
const centreOf = (selector) => {
	const el = document.querySelector(selector);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

/**
 * Taps the first row, then `selector` on the conversation it opens, from two `input tap` processes
 * started `gap` ms apart. Where the conversation will put `selector` is learnt in setup. The gap is
 * tuned until the second touch lands within AT_ONCE_MS after the page swaps in: a touch before the
 * swap hits the list, and one much later is not "as soon as it opens".
 */
async function openAndTapAtOnce(device, state, selector) {
	const where = state.targets[selector];
	for (let attempt = 1; attempt <= 12; attempt++) {
		if (attempt > 1) await device.goto(`${APP}/v2/inbox`);
		await device.until(() => location.pathname === "/v2/inbox" && [...document.querySelectorAll("#main li[data-row]")].some(window.__j.shown), null, { message: "the inbox list" });
		const { page, box: row } = await device.locate("#main li[data-row] .row-subject");
		const from = await device.toScreen(page, row.x, row.y);
		const to = await device.toScreen(page, where.x, where.y);
		await device.eval(() => {
			const t0 = performance.now();
			const at = () => performance.now() - t0;
			window.__jAtOnce = { downs: [], swap: null };
			addEventListener("pointerdown", (event) => window.__jAtOnce.downs.push({ t: at(), on: window.__j.describe(event.target) }), { capture: true });
			document.addEventListener("htmx:afterSwap", (event) => {
				if (event.detail.target?.id === "main" && window.__jAtOnce.swap === null) window.__jAtOnce.swap = at();
			});
		});
		await device.shell(`input tap ${Math.round(from.x)} ${Math.round(from.y)} & sleep ${(state.gap / 1000).toFixed(3)}; input tap ${Math.round(to.x)} ${Math.round(to.y)}; wait`);
		const seen = await device.until(() => window.__jAtOnce && window.__jAtOnce.swap !== null && window.__jAtOnce.downs.length >= 2 && window.__jAtOnce, null, { timeout: 8_000, message: "the conversation to open and both touches to land" }).catch(() => null);
		const second = seen?.downs[1];
		const delta = second ? second.t - seen.swap : null;
		device.log(`  attempt ${attempt}: gap ${state.gap} ms, second touch ${delta === null ? "not seen" : `${Math.round(delta)} ms after the swap`}${second ? ` on ${second.on}` : ""}`);
		if (delta !== null && delta >= 0 && delta <= AT_ONCE_MS) return;
		if (delta === null || delta < 0) state.gap += delta === null ? 10 : Math.ceil(-delta) + 3;
		else state.gap = Math.max(0, state.gap - Math.floor(delta - AT_ONCE_MS / 2));
	}
	fail(`could not land the second touch within ${AT_ONCE_MS} ms of the conversation opening`);
}

const besideList = () => {
	const pane = document.querySelector("#main > .split-list");
	const page = document.querySelector("#main > .page[data-page=thread]");
	if (!pane || !page || !window.__j.visible(pane) || !pane.querySelector("li[data-row].is-current")) return null;
	return pane.getBoundingClientRect().right <= page.getBoundingClientRect().left + 1 ? window.__j.text(document.querySelector("h1.thread-subject")) : null;
};

const journey = {
	setup: async ({ device, state }) => {
		await tabletScreen(device, true);
		await device.startSignedIn();
		await device.until(() => matchMedia("(min-width: 900px) and (max-width: 1199px)").matches, null, { message: "Chrome to lay the page out in the tablet band" });
		// Learn where the first conversation puts its menu and details toggle. Open it twice, so it is read
		// (and scrolled) as it will be when the journey opens it.
		const href = await device.eval(() => document.querySelector("#main li[data-row]")?.dataset.href);
		expect(href, "the inbox has no conversation");
		state.targets = {};
		for (let visit = 0; visit < 2; visit++) {
			await device.goto(new URL(href, APP).href);
			await device.until(() => document.querySelector("#main > .split-list li[data-row]") && document.querySelector("#main .msg.is-last"), null, { message: "the conversation beside its list" });
			await sleep(500);
		}
		for (const selector of [MENU, DETAILS]) {
			state.targets[selector] = await device.eval(centreOf, selector);
			expect(state.targets[selector], `the conversation has no ${selector}`);
		}
		state.gap = 30;
		await device.goto(`${APP}/v2/inbox`);
	},
	teardown: ({ device }) => tabletScreen(device, false),
	steps: [
		[
			"Tap the first conversation in the inbox list and, as soon as it opens, tap the three-dot button to the right of the message date",
			({ device, state }) => openAndTapAtOnce(device, state, MENU),
		],
		[
			'Verify that the conversation is shown beside the list of conversations, with a menu open listing "Reply", "Reply all", "Forward" and "Mark unread from here"',
			async ({ device }) => {
				await device.until(besideList, null, { message: "the conversation beside the list of conversations" });
				await device.until(() => !!document.querySelector('#main .msg.is-last details[data-menu="message"][open]'), null, { timeout: 3_000, message: "the message menu to be open" }).catch(async (error) => {
					fail(`${error.message}; touches ${JSON.stringify(await device.eval(() => window.__jAtOnce).catch(() => null))}`);
				});
				await device.see(["Reply", "Reply all", "Forward", "Mark unread from here"], { selector: 'details[data-menu="message"][open] .menu-item' });
			},
		],
		["Press the Android Back button once", ({ device }) => device.back()],
		[
			"Verify that the inbox list is shown",
			({ device }) => device.until(() => location.pathname === "/v2/inbox" && window.__j.byText(".tb-title", "Inbox") && [...document.querySelectorAll("#main li[data-row]")].some(window.__j.shown), null, { timeout: 10_000, message: "the inbox list after Back" }),
		],
		[
			"Tap the first conversation in the inbox list and, as soon as it opens, tap the small down-arrow next to the recipients under the sender's name",
			({ device, state }) => openAndTapAtOnce(device, state, DETAILS),
		],
		[
			'Verify that the conversation is shown beside the list of conversations, with a panel showing "from:", "to:", "date:" and "subject:" details',
			async ({ device }) => {
				await device.until(besideList, null, { message: "the conversation beside the list of conversations" });
				const text = await device.until(() => {
					const panel = [...document.querySelectorAll("#main .msg-details")].find((el) => !el.hidden && el.textContent.trim() && window.__j.visible(el));
					return panel ? window.__j.text(panel) : null;
				}, null, { timeout: 5_000, message: "the details panel to be shown" }).catch(async (error) => {
					fail(`${error.message}; touches ${JSON.stringify(await device.eval(() => window.__jAtOnce).catch(() => null))}`);
				});
				for (const label of ["from:", "to:", "date:", "subject:"]) expect(text.toLowerCase().includes(label), `the details panel does not show "${label}" (it shows: ${text.slice(0, 120)})`);
			},
		],
	],
};

export default journey;
