import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { ensureChatHome, listConfiguredConversations, loadChatConfig } from "./src/config.js";
import type { ResolvedConversation } from "./src/core/config-types.js";
import { runWorker } from "./src/worker.js";

async function loadDotenv(dir: string): Promise<void> {
	let raw: string;
	try {
		raw = await readFile(join(dir, ".env"), "utf8");
	} catch {
		return;
	}
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
		if (!key || key in process.env) continue;
		let value = trimmed.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		process.env[key] = value;
	}
	console.log(`Loaded .env from ${dir}`);
}

const RESTART_DELAYS_MS = [1_000, 5_000, 15_000, 30_000, 60_000];

async function runWithRestart(conversation: ResolvedConversation, signal: AbortSignal): Promise<void> {
	let attempt = 0;
	while (!signal.aborted) {
		try {
			await runWorker(conversation, signal);
			return;
		} catch (err) {
			if (signal.aborted) return;
			const delay = RESTART_DELAYS_MS[Math.min(attempt, RESTART_DELAYS_MS.length - 1)];
			console.error(
				`[${conversation.conversationName}] crashed (attempt ${attempt + 1}):`,
				err instanceof Error ? err.message : String(err),
			);
			console.log(`[${conversation.conversationName}] restarting in ${delay}ms...`);
			attempt++;
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}

async function main(): Promise<void> {
	await loadDotenv(process.cwd());
	await ensureChatHome();
	const config = await loadChatConfig();
	const conversations = listConfiguredConversations(config);

	if (conversations.length === 0) {
		console.error(
			"No configured channels found.\n" +
				"Edit ~/.pi/agent/chat/config.json to set up accounts and channels,\n" +
				"then restart the daemon.",
		);
		process.exit(1);
	}

	console.log(`pi-chat daemon starting ${conversations.length} worker(s):`);
	for (const conv of conversations) console.log(`  • ${conv.conversationName} (${conv.service})`);

	const controller = new AbortController();
	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		process.on(sig, () => {
			console.log(`\nReceived ${sig}, shutting down...`);
			controller.abort();
		});
	}

	await Promise.all(conversations.map((conv) => runWithRestart(conv, controller.signal)));
	console.log("All workers stopped.");
}

main().catch((error) => {
	console.error("Fatal:", error);
	process.exit(1);
});
