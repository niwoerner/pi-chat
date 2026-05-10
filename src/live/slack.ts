import { Buffer } from "node:buffer";

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

import type { ResolvedConversation, SlackAccountConfig } from "../core/config-types.js";
import type { InboundMessageInput } from "../core/runtime-types.js";
import { chunkText } from "../render/chunking.js";
import { formatMarkdownForService, maxMessageLength } from "../render/format.js";
import { fetchBinary, readLocalAttachment, storeDownloadedAttachment, textMentionsBot } from "./common.js";
import type { LiveConnection, LiveConnectionHandlers, ResumeState } from "./types.js";

interface SlackFile {
	id?: string;
	name?: string;
	mimetype?: string;
	url_private?: string;
}

interface SlackMessageEvent {
	type: string;
	subtype?: string;
	channel?: string;
	user?: string;
	bot_id?: string;
	text?: string;
	ts: string;
	thread_ts?: string;
	files?: SlackFile[];
}

interface SlackMessageHandlerArgs {
	event: SlackMessageEvent;
	ack: () => Promise<void>;
}

interface SlackErrorLike {
	data?: { error?: string };
}

function slackErrorCode(error: unknown): string | undefined {
	if (error && typeof error === "object") return (error as SlackErrorLike).data?.error;
	return undefined;
}

const ALLOWED_SUBTYPES = new Set(["file_share", "me_message"]);

function isRelevantMessage(event: SlackMessageEvent, account: SlackAccountConfig, channelId: string): boolean {
	if (event.channel !== channelId) return false;
	if (event.subtype !== undefined && !ALLOWED_SUBTYPES.has(event.subtype)) return false;
	if (account.botUserId && event.user === account.botUserId) return false;
	return true;
}

async function downloadSlackFile(
	conversation: ResolvedConversation,
	botToken: string,
	messageTs: string,
	index: number,
	file: SlackFile,
) {
	if (!file.url_private) return undefined;
	const data = await fetchBinary(file.url_private, { Authorization: `Bearer ${botToken}` });
	return storeDownloadedAttachment(
		conversation,
		messageTs,
		index,
		file.name || `attachment-${index}`,
		data,
		file.mimetype,
		file.url_private,
	);
}

async function eventToInput(
	conversation: ResolvedConversation,
	account: SlackAccountConfig,
	event: SlackMessageEvent,
): Promise<InboundMessageInput | undefined> {
	if (!isRelevantMessage(event, account, conversation.channel.id)) return undefined;
	const text = event.text || "";
	const attachments: NonNullable<InboundMessageInput["attachments"]> = [];
	let index = 0;
	for (const file of event.files ?? []) {
		const stored = await downloadSlackFile(conversation, account.botToken, event.ts, ++index, file);
		if (stored) attachments.push(stored);
	}
	const mentionToken = account.botUserId ? `<@${account.botUserId}>` : undefined;
	const mentionedBot =
		(mentionToken ? text.includes(mentionToken) : false) || textMentionsBot(text, account.botUsername, account.botUserId);
	return {
		messageId: event.ts,
		userId: event.user || event.bot_id || "unknown",
		userName: event.user,
		text,
		mentionedBot,
		isBot: Boolean(event.bot_id),
		attachments,
	};
}

async function catchUp(
	client: WebClient,
	conversation: ResolvedConversation,
	account: SlackAccountConfig,
	handlers: LiveConnectionHandlers,
	setThread: (ts: string | undefined) => void,
	oldest?: string,
): Promise<void> {
	if (!oldest) return;
	const response = (await client.conversations.history({
		channel: conversation.channel.id,
		oldest,
		limit: 100,
	})) as { messages?: SlackMessageEvent[] };
	const messages = [...(response.messages ?? [])].reverse();
	for (const raw of messages) {
		const event = { ...raw, channel: conversation.channel.id } as SlackMessageEvent;
		if (event.ts === oldest) continue;
		const input = await eventToInput(conversation, account, event);
		if (!input) continue;
		setThread(event.thread_ts || event.ts);
		await handlers.onMessage(input, { cursor: event.ts, messageId: event.ts });
	}
}

async function sendSlackText(client: WebClient, channel: string, text: string, threadTs?: string): Promise<string> {
	const rendered = formatMarkdownForService("slack", text);
	const chunks = chunkText(rendered.text, maxMessageLength("slack"));
	let firstTs: string | undefined;
	for (const chunk of chunks) {
		const response = (await client.chat.postMessage({
			channel,
			text: chunk,
			thread_ts: threadTs,
			unfurl_links: false,
			unfurl_media: false,
		})) as { ts?: string };
		if (!response.ts) throw new Error("Slack chat.postMessage returned no ts");
		firstTs ??= response.ts;
	}
	return firstTs || "";
}

async function sendSlackAttachments(
	client: WebClient,
	channel: string,
	text: string,
	attachmentPaths: string[],
	threadTs?: string,
): Promise<string> {
	const rendered = text ? formatMarkdownForService("slack", text).text : "";
	let firstTs: string | undefined;
	for (const [index, path] of attachmentPaths.entries()) {
		const file = await readLocalAttachment(path);
		const response = (await client.files.uploadV2({
			channel_id: channel,
			thread_ts: threadTs,
			initial_comment: index === 0 && rendered ? rendered : undefined,
			file_uploads: [{ file: Buffer.from(file.data), filename: file.name, title: file.name }],
		})) as { files?: Array<{ ts?: string; id?: string }>; file?: { ts?: string; id?: string } };
		const ts = response.files?.[0]?.ts || response.file?.ts;
		if (ts) firstTs ??= ts;
	}
	return firstTs || "";
}

// --- Shared socket per appToken ---
// Slack delivers events to only one WebSocket connection per app token.
// All channels on the same account must share one SocketModeClient.

interface SharedSocketEntry {
	client: SocketModeClient;
	refCount: number;
	disconnectHandlers: Set<() => Promise<void>>;
}

const sharedSlackSockets = new Map<string, SharedSocketEntry>();

async function acquireSocket(appToken: string): Promise<SocketModeClient> {
	const existing = sharedSlackSockets.get(appToken);
	if (existing) {
		existing.refCount++;
		console.log(`[slack] reusing shared socket (refCount=${existing.refCount})`);
		return existing.client;
	}
	const client = new SocketModeClient({ appToken });
	const entry: SharedSocketEntry = { client, refCount: 1, disconnectHandlers: new Set() };
	// Set before await so concurrent acquireSocket calls see the entry immediately.
	sharedSlackSockets.set(appToken, entry);
	client.on("disconnected", async () => {
		console.log(`[slack] shared socket disconnected`);
		sharedSlackSockets.delete(appToken);
		for (const handler of [...entry.disconnectHandlers]) {
			await handler().catch(() => undefined);
		}
	});
	console.log(`[slack] starting new shared socket`);
	await client.start();
	return client;
}

function releaseSocket(appToken: string, disconnectHandler: (() => Promise<void>) | undefined): void {
	const entry = sharedSlackSockets.get(appToken);
	if (!entry) return;
	if (disconnectHandler) entry.disconnectHandlers.delete(disconnectHandler);
	entry.refCount--;
	console.log(`[slack] release socket (refCount=${entry.refCount})`);
	if (entry.refCount <= 0) {
		sharedSlackSockets.delete(appToken);
		entry.client.disconnect().catch(() => undefined);
	}
}

export async function connectSlackLive(
	conversation: ResolvedConversation,
	handlers: LiveConnectionHandlers,
	resumeState?: ResumeState,
): Promise<LiveConnection> {
	const account = conversation.account as SlackAccountConfig;
	const client = new WebClient(account.botToken);
	const channelId = conversation.channel.id;
	let currentThreadTs: string | undefined;
	let currentReplyToTs: string | undefined;

	const setThread = (ts: string | undefined) => {
		// Don't thread in DM channels — Slack shows thread replies in the main
		// DM view too, causing the message to appear twice.
		if (!conversation.channel.dm) {
			currentThreadTs = ts;
		}
	};

	async function addReaction(ts: string, name: string): Promise<void> {
		await client.reactions.add({ channel: channelId, timestamp: ts, name }).catch(() => undefined);
	}

	async function removeReaction(ts: string, name: string): Promise<void> {
		await client.reactions.remove({ channel: channelId, timestamp: ts, name }).catch(() => undefined);
	}

	await catchUp(client, conversation, account, handlers, setThread, resumeState?.cursor);
	await handlers.onCaughtUp();

	const socketClient = await acquireSocket(account.appToken);

	const disconnectHandler = handlers.onDisconnect
		? async () => {
				await handlers.onDisconnect!();
			}
		: undefined;
	if (disconnectHandler) {
		const entry = sharedSlackSockets.get(account.appToken);
		if (entry) entry.disconnectHandlers.add(disconnectHandler);
	}

	const onMessage = async ({ event, ack }: SlackMessageHandlerArgs) => {
		try {
			await ack();
		} catch (error) {
			await handlers.onError(error instanceof Error ? error : new Error(String(error)));
		}
		try {
			const input = await eventToInput(conversation, account, event);
			if (!input) return;
			console.log(`[slack:${channelId}] message from ${input.userId}: "${input.text.slice(0, 60)}"`);
			setThread(event.thread_ts || event.ts);
			await handlers.onMessage(input, { cursor: event.ts, messageId: event.ts });
		} catch (error) {
			console.log(`[slack:${channelId}] onMessage error: ${error}`);
			await handlers.onError(error instanceof Error ? error : new Error(String(error)));
		}
	};

	socketClient.on("message", onMessage);

	return {
		conversation,
		disconnect: async () => {
			socketClient.off("message", onMessage);
			releaseSocket(account.appToken, disconnectHandler);
		},
		sendImmediate: async (text, replyToMessageId) =>
			sendSlackText(client, channelId, text, replyToMessageId ?? currentThreadTs),
		send: async (text, attachmentPaths = [], _signal, replyToMessageId) => {
			const threadTs = replyToMessageId ?? currentThreadTs;
			if (attachmentPaths.length === 0) return sendSlackText(client, channelId, text, threadTs);
			return sendSlackAttachments(client, channelId, text, attachmentPaths, threadTs);
		},
		startTyping: async () => {
			if (currentReplyToTs) await addReaction(currentReplyToTs, "hourglass_flowing_sand");
		},
		stopTyping: async () => {
			if (!currentReplyToTs) return;
			await removeReaction(currentReplyToTs, "hourglass_flowing_sand");
			await addReaction(currentReplyToTs, "rose");
		},
		syncPreview: async () => [],
		clearPreview: async () => {},
		setReplyTo: (messageId) => {
			currentReplyToTs = messageId;
			setThread(messageId);
		},
	};
}
