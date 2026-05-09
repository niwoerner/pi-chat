import { ensureChatHome, listConfiguredConversations, loadChatConfig } from "./src/config.js";
import { ConversationAgent } from "./src/conversation-agent.js";
import type { ResolvedConversation } from "./src/core/config-types.js";

const RESTART_DELAYS_MS = [1_000, 5_000, 15_000, 30_000, 60_000];

async function runWithRestart(conversation: ResolvedConversation): Promise<void> {
	let attempt = 0;
	while (true) {
		let agent: ConversationAgent | undefined;
		try {
			agent = await ConversationAgent.start(conversation);
			await agent.waitUntilStopped();
			return;
		} catch (err) {
			const delay = RESTART_DELAYS_MS[Math.min(attempt, RESTART_DELAYS_MS.length - 1)];
			console.error(
				`[${conversation.conversationName}] crashed (attempt ${attempt + 1}):`,
				err instanceof Error ? err.message : String(err),
			);
			console.log(`[${conversation.conversationName}] restarting in ${delay}ms...`);
			attempt++;
			await sleep(delay);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
	await ensureChatHome();
	const config = await loadChatConfig();
	const conversations = listConfiguredConversations(config);

	if (conversations.length === 0) {
		console.error(
			"No configured channels found.\n" +
				"Run pi with /chat-config to set up accounts and channels first,\n" +
				"then restart the daemon.",
		);
		process.exit(1);
	}

	console.log(`pi-chat daemon starting ${conversations.length} conversation(s):`);
	for (const conv of conversations) console.log(`  • ${conv.conversationName} (${conv.service})`);

	const agents: ConversationAgent[] = [];

	async function shutdown(signal: string): Promise<void> {
		console.log(`\nReceived ${signal}, shutting down...`);
		await Promise.all(agents.map((a) => a.stop().catch(() => undefined)));
		process.exit(0);
	}

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	await Promise.all(conversations.map((conv) => runWithRestart(conv)));
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
