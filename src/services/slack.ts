import { WebClient } from "@slack/web-api";

import type { SlackAccountConfig } from "../core/config-types.js";
import type { AccountValidationResult, DiscoveredChannel, DiscoverySnapshot } from "../core/discovery-types.js";
import type { AccountDraft, DiscoveryProvider } from "./types.js";

interface SlackErrorLike {
	data?: { error?: string; response_metadata?: { messages?: string[] } };
	headers?: Record<string, string | string[] | undefined>;
}

function slackErrorMessage(error: unknown): string {
	if (error && typeof error === "object") {
		const cast = error as SlackErrorLike;
		if (cast.data?.error) return cast.data.error;
	}
	return error instanceof Error ? error.message : String(error);
}

async function withRetryOnRateLimit<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		const cast = error as SlackErrorLike;
		if (cast?.data?.error !== "ratelimited") throw error;
		const retryAfterRaw = cast.headers?.["retry-after"];
		const retryAfter = Array.isArray(retryAfterRaw) ? retryAfterRaw[0] : retryAfterRaw;
		const seconds = Math.max(1, Number.parseInt(retryAfter ?? "1", 10) || 1);
		await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
		return await call();
	}
}

interface SlackAuthTestResult {
	ok?: boolean;
	user_id?: string;
	user?: string;
	team_id?: string;
	team?: string;
	url?: string;
	is_enterprise_install?: boolean;
}

async function authTest(client: WebClient): Promise<SlackAuthTestResult> {
	return (await withRetryOnRateLimit(() => client.auth.test())) as SlackAuthTestResult;
}

function teamDomainFromUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const host = new URL(url).host;
		const [domain] = host.split(".");
		return domain || undefined;
	} catch {
		return undefined;
	}
}

export const slackDiscoveryProvider: DiscoveryProvider = {
	service: "slack",
	async validate(draft: AccountDraft): Promise<AccountValidationResult> {
		const client = new WebClient(draft.botToken);
		let auth: SlackAuthTestResult;
		try {
			auth = await authTest(client);
		} catch (error) {
			throw new Error(slackErrorMessage(error));
		}
		if (!auth.user_id || !auth.team_id) throw new Error("Slack auth.test returned an incomplete identity");
		const warnings: string[] = [];
		if (auth.is_enterprise_install) {
			warnings.push("Slack enterprise install detected; pi-chat treats this as a single workspace.");
		}
		return {
			identity: {
				id: auth.user_id,
				name: auth.user || auth.user_id,
				userName: auth.user,
				workspaceId: auth.team_id,
				workspaceName: auth.team,
				workspaceDomain: teamDomainFromUrl(auth.url),
			},
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	},
	async fetchSnapshot(accountId: string, account: SlackAccountConfig): Promise<DiscoverySnapshot> {
		const slackAccount = account as SlackAccountConfig;
		const client = new WebClient(slackAccount.botToken);
		let auth: SlackAuthTestResult;
		try {
			auth = await authTest(client);
		} catch (error) {
			throw new Error(slackErrorMessage(error));
		}
		const warnings: string[] = [];
		if (auth.is_enterprise_install) {
			warnings.push("Slack enterprise install detected; pi-chat treats this as a single workspace.");
		}
		const channels: DiscoveredChannel[] = [];
		const dms: DiscoveredChannel[] = [];
		const userCache = new Map<string, string>();
		const resolveUserName = async (userId: string): Promise<string> => {
			const cached = userCache.get(userId);
			if (cached) return cached;
			try {
				const info = (await withRetryOnRateLimit(() => client.users.info({ user: userId }))) as {
					user?: { real_name?: string; profile?: { real_name?: string; display_name?: string }; name?: string };
				};
				const name =
					info.user?.profile?.real_name ||
					info.user?.real_name ||
					info.user?.profile?.display_name ||
					info.user?.name ||
					userId;
				userCache.set(userId, name);
				return name;
			} catch {
				userCache.set(userId, userId);
				return userId;
			}
		};
		let cursor: string | undefined;
		try {
			while (true) {
				const page = (await withRetryOnRateLimit(() =>
					client.conversations.list({
						types: "public_channel,private_channel,mpim,im",
						limit: 200,
						cursor,
					}),
				)) as {
					channels?: Array<{
						id: string;
						name?: string;
						is_im?: boolean;
						is_mpim?: boolean;
						is_private?: boolean;
						is_archived?: boolean;
						user?: string;
					}>;
					response_metadata?: { next_cursor?: string };
				};
				for (const item of page.channels ?? []) {
					if (!item.id || item.is_archived) continue;
					if (item.is_im) {
						const name = item.user ? await resolveUserName(item.user) : item.id;
						dms.push({ id: item.id, name, dm: true });
						continue;
					}
					channels.push({ id: item.id, name: item.name || item.id });
				}
				cursor = page.response_metadata?.next_cursor || undefined;
				if (!cursor) break;
			}
		} catch (error) {
			throw new Error(slackErrorMessage(error));
		}
		channels.sort((a, b) => a.name.localeCompare(b.name));
		dms.sort((a, b) => a.name.localeCompare(b.name));
		return {
			accountId,
			service: "slack",
			fetchedAt: new Date().toISOString(),
			identity: {
				id: auth.user_id || slackAccount.botUserId || "",
				name: auth.user || slackAccount.botUsername || "",
				userName: auth.user,
				workspaceId: auth.team_id || slackAccount.teamId,
				workspaceName: auth.team || slackAccount.teamName,
				workspaceDomain: teamDomainFromUrl(auth.url) || slackAccount.teamDomain,
			},
			channels: [...channels, ...dms],
			users: [],
			roles: [],
			warnings: warnings.length > 0 ? warnings : undefined,
			capabilities: {
				canListChannels: true,
				canListUsers: false,
				canListRoles: false,
			},
		};
	},
};
