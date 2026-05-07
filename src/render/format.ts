// Formatting adapted from Vercel Chat SDK service converters (MIT).
// Source inspiration:
// - packages/adapter-telegram/src/markdown.ts
// - packages/adapter-discord/src/markdown.ts

import type { ChatService } from "../core/config-types.js";

export interface RenderedChunkPayload {
	text: string;
	parseMode?: "Markdown";
}

function normalizeTelegram(markdown: string): string {
	return markdown
		.replace(/\|(.+)\|/g, (match) => (match.includes("\n") ? match : match))
		.replace(/\r\n/g, "\n")
		.trim();
}

function normalizeDiscord(markdown: string): string {
	return markdown.replace(/(?<!<)@(\w+)/g, "<@$1>").trim();
}

function normalizeSlack(markdown: string): string {
	const codeBlocks: string[] = [];
	const inlineCodes: string[] = [];
	let working = markdown.replace(/\r\n/g, "\n");
	working = working.replace(/```[\s\S]*?```/g, (match) => {
		const token = `\uE000CODEBLOCK${codeBlocks.length}\uE001`;
		codeBlocks.push(match);
		return token;
	});
	working = working.replace(/`[^`\n]+`/g, (match) => {
		const token = `\uE000INLINE${inlineCodes.length}\uE001`;
		inlineCodes.push(match);
		return token;
	});
	working = working.replace(/\[uid:([A-Z0-9]+)\]/g, "<@$1>");
	working = working.replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, title) => `*${title.trim()}*`);
	working = working.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
	working = working.replace(/\*\*([^\n*]+)\*\*/g, "*$1*");
	working = working.replace(/(^|[^*])\*([^\n*]+)\*(?!\*)/g, (_match, prefix, inner) => `${prefix}_${inner}_`);
	working = working.replace(/~~([^~\n]+)~~/g, "~$1~");
	working = working.replace(/\uE000INLINE(\d+)\uE001/g, (_match, idx) => inlineCodes[Number(idx)] ?? "");
	working = working.replace(/\uE000CODEBLOCK(\d+)\uE001/g, (_match, idx) => codeBlocks[Number(idx)] ?? "");
	return working.trim();
}

export function formatMarkdownForService(service: ChatService, markdown: string): RenderedChunkPayload {
	if (service === "telegram") return { text: normalizeTelegram(markdown), parseMode: "Markdown" };
	if (service === "slack") return { text: normalizeSlack(markdown) };
	return { text: normalizeDiscord(markdown) };
}

export function maxMessageLength(service: ChatService): number {
	if (service === "telegram") return 4096;
	if (service === "slack") return 3000;
	return 2000;
}
