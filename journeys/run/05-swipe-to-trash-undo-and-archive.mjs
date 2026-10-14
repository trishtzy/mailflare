import { expect } from "./harness.mjs";

const firstRow = () => {
	const row = [...document.querySelectorAll("li[data-row]")].find(window.__j.visible);
	return row ? { id: row.dataset.id, subject: window.__j.text(row.querySelector(".row-subject")) } : null;
};

// A toast near the bottom of the screen with this text.
const toast = (text) => {
	const el = [...document.querySelectorAll("#toast .toast")].find((t) => window.__j.visible(t) && window.__j.text(t).includes(text));
	return el && el.getBoundingClientRect().top > innerHeight / 2 ? window.__j.text(el) : null;
};

const rowSwipe = (towards) => ({ from: towards === "left" ? [0.97, 0.5] : [0.03, 0.5], to: towards === "left" ? [0.03, 0.5] : [0.97, 0.5], ms: 350, screenEdge: true });

export default {
	setup: ({ device }) => device.startSignedIn({ rows: 3 }),
	steps: [
		[
			"Swipe the first conversation row from the right edge of the screen towards the left edge",
			async ({ device, state }) => {
				state.trashed = await device.eval(firstRow);
				await device.swipe("li[data-row]", rowSwipe("left"));
			},
		],
		[
			'Verify that a message reading "Conversation moved to Trash." with an "Undo" button appears near the bottom of the screen',
			async ({ device }) => {
				await device.until(toast, "Conversation moved to Trash.", { message: 'the "Conversation moved to Trash." message near the bottom' });
				await device.see("Undo", { selector: "#toast [data-undo]" });
			},
		],
		['Tap "Undo" in that message', ({ device }) => device.tap({ selector: "#toast [data-undo]", text: "Undo" })],
		[
			"Verify that the conversation that was swiped is back at the top of the inbox list",
			({ device, state }) =>
				device.until((id) => location.pathname === "/v2/inbox" && document.querySelector("li[data-row]")?.dataset.id === id, state.trashed.id, { timeout: 10_000, message: `"${state.trashed.subject}" back at the top of the inbox` }),
		],
		[
			"Swipe the first conversation row from the left edge of the screen towards the right edge",
			async ({ device, state }) => {
				state.archived = await device.eval(firstRow);
				await device.swipe("li[data-row]", rowSwipe("right"));
			},
		],
		[
			'Verify that a message reading "Conversation archived." appears near the bottom of the screen and that row is no longer in the inbox list',
			async ({ device, state }) => {
				await device.until(toast, "Conversation archived.", { message: 'the "Conversation archived." message near the bottom' });
				await device.until((id) => ![...document.querySelectorAll("li[data-row]")].some((row) => row.dataset.id === id && window.__j.visible(row)), state.archived.id, { message: `"${state.archived.subject}" to leave the inbox list` });
			},
		],
		[
			'Tap the menu button at the top left of the screen and tap "Archive" in the drawer',
			async ({ device }) => {
				await device.tap("[data-nav-toggle]");
				await device.tap({ selector: "#nav .nav-item", text: "Archive" });
			},
		],
		[
			"Verify that the archived conversation is listed in Archive",
			async ({ device, state }) => {
				await device.until(() => location.pathname === "/v2/archive" && window.__j.byText(".tb-title", "Archive"), null, { message: "the Archive list" });
				const listed = await device.until((id) => [...document.querySelectorAll("li[data-row]")].some((row) => row.dataset.id === id && window.__j.visible(row)), state.archived.id, { message: `"${state.archived.subject}" in Archive` }).catch(() => false);
				expect(listed, `"${state.archived.subject}" (${state.archived.id}) is not listed in Archive`);
			},
		],
	],
};
