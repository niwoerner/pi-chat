import { Buffer } from "node:buffer";

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

import type { ResolvedConversation, SlackAccountConfig } from "../core/config-types.js";
import type { InboundMessageInput } from "../core/runtime-types.js";
import { chunkText } from "../render/chunking.js";
import { formatMarkdownForService, maxMessageLength } from "../render/format.js";
import { StreamingPreview } from "../render/streaming.js";
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
	if (event.channel !== channelId) {
		console.log(`[slack] skip: channel ${event.channel} !== ${channelId}`);
		return false;
	}
	if (event.subtype !== undefined && !ALLOWED_SUBTYPES.has(event.subtype)) {
		console.log(`[slack] skip: subtype=${event.subtype}`);
		return false;
	}
	if (account.botUserId && event.user === account.botUserId) {
		console.log(`[slack] skip: own message`);
		return false;
	}
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

function createEditThrottle(): (id: string) => Promise<void> {
	const nextAllowedAt = new Map<string, number>();
	const MIN_INTERVAL_MS = 400;
	return async (id: string) => {
		const now = Date.now();
		const readyAt = nextAllowedAt.get(id) ?? 0;
		if (readyAt > now) await new Promise((resolve) => setTimeout(resolve, readyAt - now));
		nextAllowedAt.set(id, Math.max(Date.now(), readyAt) + MIN_INTERVAL_MS);
	};
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

export async function connectSlackLive(
	conversation: ResolvedConversation,
	handlers: LiveConnectionHandlers,
	resumeState?: ResumeState,
): Promise<LiveConnection> {
	const account = conversation.account as SlackAccountConfig;
	const client = new WebClient(account.botToken);
	const socketClient = new SocketModeClient({ appToken: account.appToken });
	const channelId = conversation.channel.id;
	let currentThreadTs: string | undefined;
	const throttleEdit = createEditThrottle();
	const preview = new StreamingPreview(conversation.service, {
		create: async (text, _parseMode, replyToMessageId) => {
			const response = (await client.chat.postMessage({
				channel: channelId,
				text,
				thread_ts: replyToMessageId,
				unfurl_links: false,
				unfurl_media: false,
			})) as { ts?: string };
			if (!response.ts) throw new Error("Slack chat.postMessage returned no ts");
			return response.ts;
		},
		edit: async (id, text) => {
			await throttleEdit(id);
			try {
				await client.chat.update({ channel: channelId, ts: id, text });
			} catch (error) {
				const code = slackErrorCode(error);
				if (code === "msg_too_long") {
					const limit = maxMessageLength("slack");
					try {
						await client.chat.update({ channel: channelId, ts: id, text: text.slice(0, limit) });
					} catch (inner) {
						if (slackErrorCode(inner) !== "message_not_found") throw inner;
					}
					return;
				}
				if (code === "message_not_found") return;
				throw error;
			}
		},
		delete: async (id) => {
			try {
				await client.chat.delete({ channel: channelId, ts: id });
			} catch (error) {
				if (slackErrorCode(error) !== "message_not_found") throw error;
			}
		},
	});
	const setThread = (ts: string | undefined) => {
		currentThreadTs = ts;
		preview.setReplyTo(ts);
	};
	await catchUp(client, conversation, account, handlers, setThread, resumeState?.cursor);
	await handlers.onCaughtUp();
	const onMessage = async ({ event, ack }: SlackMessageHandlerArgs) => {
		console.log(`[slack] message handler: type=${event?.type} subtype=${event?.subtype ?? "-"} channel=${event?.channel} user=${event?.user ?? event?.bot_id ?? "?"}`);
		try {
			await ack();
		} catch (error) {
			await handlers.onError(error instanceof Error ? error : new Error(String(error)));
		}
		try {
			const input = await eventToInput(conversation, account, event);
			console.log(`[slack] eventToInput: ${input ? `ok text="${input.text.slice(0, 40)}"` : "null"}`);
			if (!input) return;
			setThread(event.thread_ts || event.ts);
			await handlers.onMessage(input, { cursor: event.ts, messageId: event.ts });
			console.log(`[slack] handlers.onMessage done`);
		} catch (error) {
			console.log(`[slack] onMessage error: ${error}`);
			await handlers.onError(error instanceof Error ? error : new Error(String(error)));
		}
	};
	socketClient.on("message", onMessage);
	socketClient.on("slack_event", ({ type, body }: { type?: string; body?: { event?: { type?: string } } }) => {
		const inner = body?.event?.type;
		console.log(`[slack] socket event: outer=${type ?? "?"} inner=${inner ?? "?"}`);
	});
	await socketClient.start();
	return {
		conversation,
		disconnect: async () => {
			socketClient.off("message", onMessage);
			await socketClient.disconnect().catch(() => undefined);
		},
		sendImmediate: async (text, replyToMessageId) =>
			sendSlackText(client, channelId, text, replyToMessageId ?? currentThreadTs),
		send: async (text, attachmentPaths = [], _signal, replyToMessageId) => {
			const threadTs = replyToMessageId ?? currentThreadTs;
			if (attachmentPaths.length === 0) return sendSlackText(client, channelId, text, threadTs);
			return sendSlackAttachments(client, channelId, text, attachmentPaths, threadTs);
		},
		startTyping: async () => {},
		stopTyping: async () => {},
		syncPreview: async (markdown, done = false) => preview.update(markdown, done),
		clearPreview: async () => preview.clear(),
		setReplyTo: (messageId) => setThread(messageId),
	};
}
