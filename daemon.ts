import process from "node:process";
import { ensureChatHome, listConfiguredConversations, loadChatConfig } from "./src/config.js";
import { runWorker } from "./src/worker.js";

async function main(): Promise<void> {
	await ensureChatHome();
	const config = await loadChatConfig();
	const conversations = listConfiguredConversations(config);

	if (conversations.length === 0) {
		console.error("No channels configured. Edit ~/.pi/agent/chat/config.json");
		process.exit(1);
	}

	console.log(`pi-chat daemon starting ${conversations.length} worker(s):`);
	for (const conv of conversations) console.log(`  ${conv.conversationName}`);

	const controller = new AbortController();
	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		process.on(sig, () => {
			console.log(`\nReceived ${sig}, shutting down...`);
			controller.abort();
		});
	}

	await Promise.all(conversations.map((conv) => runWorker(conv, controller.signal)));
	console.log("All workers stopped.");
}

main().catch((error) => {
	console.error("Fatal:", error);
	process.exit(1);
});
