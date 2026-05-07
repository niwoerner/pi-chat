import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { saveChatConfig } from "../config.js";
import type { ChatConfig, SlackAccountConfig } from "../core/config-types.js";
import { makeAccountKey } from "../core/keys.js";
import { refreshAccountSnapshot, updateAccountIdentityFromSnapshot, validateAccountDraft } from "../services/index.js";
import { runWithLoader, showNotice } from "./dialogs.js";

function ensureUniqueKey(existing: Record<string, unknown>, base: string): string {
	if (!existing[base]) return base;
	let index = 2;
	while (existing[`${base}-${index}`]) index += 1;
	return `${base}-${index}`;
}

interface SlackDraft {
	name: string;
	botToken: string;
	appToken: string;
}

async function promptSlackDraft(ctx: ExtensionContext): Promise<SlackDraft | undefined> {
	await showNotice(
		ctx,
		"Slack app install",
		"Create/install the Slack app from slack-app-manifest.yaml first, then paste both tokens below.",
		"info",
	);
	const label = await ctx.ui.input("Slack account label", "slack-bot");
	if (label === undefined) return undefined;
	const botToken = await ctx.ui.input("Slack bot token (xoxb-...)", "");
	if (botToken === undefined || !botToken.trim()) return undefined;
	const appToken = await ctx.ui.input("Slack app-level token (xapp-...)", "");
	if (appToken === undefined || !appToken.trim()) return undefined;
	return { name: label.trim() || "slack-bot", botToken: botToken.trim(), appToken: appToken.trim() };
}

export async function createSlackAccountWithGuidedSetup(
	ctx: ExtensionContext,
	config: ChatConfig,
): Promise<string | undefined> {
	const draft = await promptSlackDraft(ctx);
	if (!draft) return undefined;
	const validation = await runWithLoader(ctx, "Validating Slack bot token...", () =>
		validateAccountDraft({ service: "slack", botToken: draft.botToken, name: draft.name }),
	);
	if (validation.error) {
		await showNotice(ctx, "Slack setup error", validation.error, "error");
		return undefined;
	}
	if (!validation.value) return undefined;
	const identity = validation.value.identity;
	const workspaceName = identity.workspaceName || identity.workspaceId || "slack";
	const key = ensureUniqueKey(config.accounts, makeAccountKey("slack", draft.name || workspaceName));
	let account: SlackAccountConfig = {
		service: "slack",
		name: draft.name,
		botToken: draft.botToken,
		appToken: draft.appToken,
		teamId: identity.workspaceId || "",
		teamName: identity.workspaceName || "",
		teamDomain: identity.workspaceDomain,
		botUserId: identity.id,
		botUsername: identity.userName,
		channels: {},
		access: { ignoreBots: true },
	};
	const snapshot = await runWithLoader(ctx, `Discovering channels in ${workspaceName}...`, () =>
		refreshAccountSnapshot(key, account),
	);
	if (snapshot.error) {
		await showNotice(ctx, "Slack setup error", snapshot.error, "error");
		return undefined;
	}
	if (!snapshot.value) return undefined;
	account = updateAccountIdentityFromSnapshot(account, snapshot.value) as SlackAccountConfig;
	config.accounts[key] = account;
	await saveChatConfig(config);
	if ((validation.value.warnings?.length ?? 0) > 0) {
		await showNotice(ctx, "Slack setup warnings", (validation.value.warnings ?? []).join("\n"), "warning");
	}
	await showNotice(ctx, "Slack account created", `Created ${key}`, "info");
	return key;
}
