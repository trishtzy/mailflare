import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default {
	...defineCloudflareConfig({
		// Uncomment to enable R2 cache,
		// It should be imported as:
		// `import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";`
		// See https://opennext.js.org/cloudflare/caching for more details
		// incrementalCache: r2IncrementalCache,
	}),
	// `npm run build` wraps this OpenNext build, so OpenNext must not call the
	// package's `build` script (the OpenNext default) or it would recurse.
	buildCommand: "npx next build",
};
