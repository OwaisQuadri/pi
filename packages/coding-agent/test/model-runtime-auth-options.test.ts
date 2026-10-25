import {
	type Api,
	type AuthType,
	type CredentialStore,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	InMemoryCredentialStore,
	type Model,
	type ModelsSimpleStreamOptions,
	type OAuthCredential,
	type Provider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime, type SubscriptionSimpleStreamOptions } from "../src/core/model-runtime.ts";

function authOptions(runtime: ModelRuntime, type?: AuthType) {
	return runtime
		.getProviders()
		.flatMap((provider) => [
			...(!type || type === "oauth"
				? provider.auth.oauth
					? [{ type: "oauth" as const, provider, method: provider.auth.oauth }]
					: []
				: []),
			...(!type || type === "api_key"
				? provider.auth.apiKey
					? [{ type: "api_key" as const, provider, method: provider.auth.apiKey }]
					: []
				: []),
		]);
}

function testModel(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

describe("ModelRuntime subscription requests", () => {
	afterEach(() => vi.restoreAllMocks());

	async function setupSubscription(compat?: Model<Api>["compat"]) {
		const credentials = new InMemoryCredentialStore();
		const calls: { model: Model<Api>; options?: SimpleStreamOptions }[] = [];
		const ambient = vi.fn(async () => ({ auth: { apiKey: "ambient-key" } }));
		const toAuth = vi.fn(async (credential: OAuthCredential) => ({ apiKey: credential.access }));
		const refresh = vi.fn(async (credential: OAuthCredential) => ({
			...credential,
			expires: Date.now() + 60 * 60_000,
		}));
		const providers: Provider[] = ["openai", "anthropic"].map((id) => {
			const model: Model<Api> = {
				...testModel("subscription-model"),
				reasoning: true,
				provider: id,
				api: id === "openai" ? "openai-responses" : "anthropic-messages",
				baseUrl: id === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com",
				compat,
			};
			return {
				id,
				name: id,
				baseUrl: model.baseUrl,
				auth: {
					apiKey: { name: "Synthetic key", resolve: ambient },
					oauth: {
						name: "Synthetic subscription",
						isSubscription: true,
						login: async () => {
							throw new Error("unused");
						},
						refresh,
						toAuth,
					},
				},
				getModels: () => [model],
				stream: () => {
					throw new Error("unused");
				},
				streamSimple: (model, _context, options) => {
					calls.push({ model, options });
					const stream = createAssistantMessageEventStream();
					const message = {
						...fauxAssistantMessage("synthetic"),
						api: model.api,
						provider: model.provider,
						model: model.id,
					};
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
					return stream;
				},
			};
		});
		vi.spyOn(builtinProviderCatalog, "builtinProviders").mockReturnValue(providers);
		for (const provider of providers) {
			await credentials.modify(provider.id, async () => ({
				type: "oauth",
				access: provider.id === "anthropic" ? "sk-ant-oat-synthetic" : "subscription-access",
				refresh: "synthetic-refresh",
				expires: Date.now() + 60 * 60_000,
			}));
		}
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		return { runtime, registry: new ModelRegistry(runtime), credentials, providers, calls, ambient, refresh, toAuth };
	}

	it("dispatches the unchanged subscription selection and reasoning with frozen metadata only", async () => {
		const { registry, calls, ambient } = await setupSubscription({ supportsDeveloperRole: true });
		const model = registry.find("openai", "subscription-model")!;
		const selected = structuredClone(model);
		const onDispatch = vi.fn<NonNullable<SubscriptionSimpleStreamOptions["onDispatch"]>>((request) => {
			expect(Object.isFrozen(request)).toBe(true);
			expect(request).toEqual({ provider: "openai", modelID: model.id, api: model.api });
		});
		const result = await registry
			.streamSubscriptionSimple(model, { messages: [] }, { reasoning: "high", onDispatch })
			.result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(calls[0].model).toEqual(selected);
		expect(calls[0].options).toMatchObject({ apiKey: "subscription-access", reasoning: "high" });
		expect(calls[0].options).not.toHaveProperty("onDispatch");
		expect(model).toEqual(selected);
		expect(onDispatch).toHaveBeenCalledOnce();
		expect(ambient).not.toHaveBeenCalled();
	});

	it("rejects direct mutation of canonical transport and OAuth handlers", async () => {
		const mutations: ((provider: Provider) => void)[] = [
			(provider) => {
				provider.streamSimple = () => {
					throw new Error("mutated transport reached");
				};
			},
			(provider) => {
				provider.auth.oauth!.toAuth = async () => ({ apiKey: "subscription-shaped-other-token" });
			},
			(provider) => {
				provider.auth.oauth!.refresh = async (credential) => credential;
			},
			(provider) => {
				Object.assign(provider, { baseUrl: "https://custom.test" });
			},
			(provider) => {
				Object.assign(provider, { headers: { Authorization: "other" } });
			},
		];
		for (const mutate of mutations) {
			const { runtime, registry, calls } = await setupSubscription();
			mutate(runtime.getProvider("openai")!);
			const result = await registry
				.streamSubscriptionSimple(registry.find("openai", "subscription-model")!, { messages: [] })
				.result();
			expect(result.errorMessage).toContain("Subscription transport could not be established");
			expect(calls).toHaveLength(0);
		}
	});

	it("rechecks runtime auth after awaited OAuth resolution and observer mutations", async () => {
		const { runtime, registry, calls, toAuth } = await setupSubscription();
		const model = registry.find("openai", "subscription-model")!;
		toAuth.mockImplementationOnce(async (credential) => {
			await runtime.setRuntimeApiKey("openai", "during-resolution");
			return { apiKey: credential.access };
		});
		const result = await registry.streamSubscriptionSimple(model, { messages: [] }).result();
		expect(result.errorMessage).toContain("Stored subscription OAuth is required");
		await runtime.removeRuntimeApiKey("openai");
		const observed = await registry
			.streamSubscriptionSimple(
				model,
				{ messages: [] },
				{
					onDispatch: () => {
						runtime.getProvider("openai")!.streamSimple = () => {
							throw new Error("observer transport reached");
						};
					},
				},
			)
			.result();
		expect(observed.errorMessage).toContain("Subscription transport could not be established");
		expect(calls).toHaveLength(0);
	});

	it("rejects explicit auth, payload, header and transport overrides before dispatch", async () => {
		const { registry, calls } = await setupSubscription();
		const model = registry.find("openai", "subscription-model")!;
		const overrides: ModelsSimpleStreamOptions[] = [
			{ apiKey: "explicit-key" },
			{ env: {} },
			{ headers: { Authorization: "other" } },
			{ transformHeaders: async () => ({ Authorization: "other" }) },
			{ fetch: vi.fn() },
			{ onPayload: () => ({ model: "other" }) },
			{ onResponse: () => undefined },
			{ onProviderStreamEvent: () => undefined },
			{ samplingParams: { model: "other" } },
			{ transport: "websocket" },
		];
		for (const options of overrides) {
			const onDispatch = vi.fn();
			const result = await registry
				.streamSubscriptionSimple(model, { messages: [] }, { ...options, onDispatch })
				.result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("Subscription requests cannot override");
			expect(onDispatch).not.toHaveBeenCalled();
		}
		expect(calls).toHaveLength(0);
	});

	it("rejects runtime keys and credential changes after cached OAuth admission", async () => {
		const { registry, runtime, credentials, calls } = await setupSubscription();
		const model = registry.find("openai", "subscription-model")!;
		expect(registry.isUsingOAuth(model)).toBe(true);
		await runtime.setRuntimeApiKey("openai", "runtime-key");
		expect((await registry.streamSubscriptionSimple(model, { messages: [] }).result()).errorMessage).toContain(
			"Stored subscription OAuth is required",
		);
		await runtime.removeRuntimeApiKey("openai");
		expect(registry.isUsingOAuth(model)).toBe(true);
		await credentials.modify("openai", async () => ({ type: "api_key", key: "changed-key" }));
		expect(registry.isUsingOAuth(model)).toBe(true);
		expect((await registry.streamSubscriptionSimple(model, { messages: [] }).result()).errorMessage).toContain(
			"Stored subscription OAuth is required",
		);
		expect(calls).toHaveLength(0);
	});

	it("never falls back to an ambient key on OAuth refresh failure", async () => {
		const { registry, credentials, calls, ambient, refresh } = await setupSubscription();
		await credentials.modify("openai", async (current) =>
			current?.type === "oauth" ? { ...current, expires: 0 } : undefined,
		);
		refresh.mockRejectedValueOnce(new Error("invalid_grant"));
		const result = await registry
			.streamSubscriptionSimple(registry.find("openai", "subscription-model")!, { messages: [] })
			.result();
		expect(result.errorMessage).toContain("OAuth refresh failed for openai");
		expect(refresh).toHaveBeenCalledOnce();
		expect(ambient).not.toHaveBeenCalled();
		expect(calls).toHaveLength(0);
	});

	it("rejects malformed OAuth access that would select a metered adapter branch", async () => {
		const { registry, credentials, calls } = await setupSubscription();
		for (const provider of ["openai", "anthropic"]) {
			await credentials.modify(provider, async (current) =>
				current?.type === "oauth" ? { ...current, access: "sk-api-key-not-oauth" } : undefined,
			);
			const result = await registry
				.streamSubscriptionSimple(registry.find(provider, "subscription-model")!, { messages: [] })
				.result();
			expect(result.errorMessage).toContain("Subscription transport could not be established");
		}
		expect(calls).toHaveLength(0);
	});

	it("checks the routed physical destination and lets the metadata observer reject it", async () => {
		const { registry, credentials, calls } = await setupSubscription();
		const physical = registry.find("anthropic", "subscription-model")!;
		registry.registerVirtualModel({
			provider: "openai",
			id: "selected-alias",
			name: "Alias",
			thinkingLevels: ["high"],
			route: () => ({ model: physical, thinkingLevel: "high" }),
		});
		const alias = registry.find("openai", "selected-alias")!;
		const selected = structuredClone(alias);
		const onDispatch = vi.fn<NonNullable<SubscriptionSimpleStreamOptions["onDispatch"]>>((request) => {
			expect(request.provider).toBe("anthropic");
		});
		await registry.streamSubscriptionSimple(alias, { messages: [] }, { reasoning: "high", onDispatch }).result();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			model: { provider: "anthropic", id: physical.id },
			options: { reasoning: "high" },
		});
		expect(alias).toEqual(selected);
		expect(onDispatch).toHaveBeenCalledOnce();
		calls.length = 0;
		const rejected = await registry
			.streamSubscriptionSimple(
				alias,
				{ messages: [] },
				{
					onDispatch: () => {
						throw new Error("physical provider denied");
					},
				},
			)
			.result();
		expect(rejected.errorMessage).toBe("physical provider denied");
		expect(calls).toHaveLength(0);
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "physical-key" }));
		const result = await registry.streamSubscriptionSimple(alias, { messages: [] }, { onDispatch }).result();
		expect(result.errorMessage).toContain("Stored subscription OAuth is required for anthropic");
		expect(onDispatch).toHaveBeenCalledOnce();
		expect(calls).toHaveLength(0);
		await registry
			.streamSubscriptionSimple(alias, { messages: [] }, {
				apiKey: "caller-key",
				reasoning: "high",
			} as ModelsSimpleStreamOptions)
			.result();
		expect(calls).toHaveLength(0);
	});

	it("rejects custom model endpoints, headers, APIs, body overrides and fallbacks", async () => {
		const { registry, calls } = await setupSubscription();
		const model = registry.find("openai", "subscription-model")!;
		for (const changed of [
			{ ...model, baseUrl: "https://custom.test/v1" },
			{ ...model, api: "unknown-api" },
			{ ...model, id: "unknown-model" },
			{ ...model, reasoning: false },
			{ ...model, thinkingLevelMap: { high: "low" } },
			{ ...model, headers: { authorization: "other" } },
			{ ...model, samplingParams: { model: "other" } },
			{ ...model, samplingParamsByThinkingLevel: { high: { model: "other" } } },
			{ ...model, compat: { supportsDeveloperRole: false } },
		]) {
			expect((await registry.streamSubscriptionSimple(changed, { messages: [] }).result()).errorMessage).toContain(
				"Subscription transport could not be established",
			);
		}
		const anthropic = registry.find("anthropic", "subscription-model")!;
		const fallback = {
			...anthropic,
			compat: { allowedFallbackModels: [{ provider: "anthropic", model: "other", cost: anthropic.cost }] },
		};
		expect((await registry.streamSubscriptionSimple(fallback, { messages: [] }).result()).errorMessage).toContain(
			"Subscription transport could not be established",
		);
		expect(calls).toHaveLength(0);
	});

	it("rejects customized providers and canonical fallback transport", async () => {
		const { registry, runtime, calls, providers } = await setupSubscription({
			allowedFallbackModels: [{ provider: "anthropic", model: "other", cost: testModel("other").cost }],
		});
		const model = registry.find("anthropic", "subscription-model")!;
		expect((await registry.streamSubscriptionSimple(model, { messages: [] }).result()).errorMessage).toContain(
			"Subscription transport could not be established",
		);
		runtime.registerNativeProvider({
			...providers[0],
			streamSimple: () => {
				throw new Error("custom transport reached");
			},
		});
		expect(
			(
				await registry
					.streamSubscriptionSimple(registry.find("openai", "subscription-model")!, { messages: [] })
					.result()
			).errorMessage,
		).toContain("Subscription transport could not be established");
		expect(calls).toHaveLength(0);
	});
});

describe("ModelRuntime auth options", () => {
	it("accepts a pi-ai CredentialStore", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "stored-key" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });

		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("stored-key");
	});

	it("scopes provider availability reads and records refresh failures", async () => {
		const base = new InMemoryCredentialStore();
		const reads: string[] = [];
		let failReads = false;
		const credentials: CredentialStore = {
			read: async (providerId) => {
				reads.push(providerId);
				if (failReads) throw new Error(`read failed for ${providerId}`);
				return base.read(providerId);
			},
			list: () => base.list(),
			modify: (providerId, fn) => base.modify(providerId, fn),
			delete: (providerId) => base.delete(providerId),
		};
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });

		reads.length = 0;
		await runtime.getAvailable("anthropic");
		expect(new Set(reads)).toEqual(new Set(["anthropic"]));

		failReads = true;
		await expect(runtime.getAvailable("anthropic")).rejects.toThrow("Credential store read failed for anthropic");
		expect(runtime.getError()).toContain("Availability refresh: Credential store read failed for anthropic");

		failReads = false;
		await runtime.getAvailable();
		expect(runtime.getError()).toBeUndefined();
	});

	it("projects provider-owned methods, names, and status", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const options = authOptions(runtime);

		expect(options).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "amazon-bedrock", name: "Amazon Bedrock" }),
					method: expect.objectContaining({ name: "AWS credentials or bearer token" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "google-vertex", name: "Google Vertex AI" }),
					method: expect.objectContaining({ name: "Google Cloud credentials" }),
				}),
				expect.objectContaining({
					type: "oauth",
					provider: expect.objectContaining({ id: "anthropic", name: "Anthropic" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "cloudflare-workers-ai", name: "Cloudflare Workers AI" }),
				}),
			]),
		);
		expect(authOptions(runtime, "api_key").every((option) => option.type === "api_key")).toBe(true);
		expect(authOptions(runtime, "oauth").every((option) => option.type === "oauth")).toBe(true);
		expect(options.some((option) => option.provider.id === "openai-codex" && option.type === "api_key")).toBe(false);
	});

	it("attaches the provider's active auth status to every method option", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				anthropic: {
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 60_000,
				},
			}),
			modelsPath: null,
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "anthropic");
		expect(options).toHaveLength(2);
		expect(await runtime.checkAuth("anthropic")).toMatchObject({ type: "oauth" });
	});

	it("distinguishes subscription OAuth from generic OAuth sign-in", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				anthropic: {
					type: "oauth",
					access: "anthropic-access",
					refresh: "anthropic-refresh",
					expires: Date.now() + 60 * 60_000,
				},
				openrouter: {
					type: "oauth",
					access: "openrouter-key",
					refresh: "",
					expires: Number.MAX_SAFE_INTEGER,
				},
				radius: {
					type: "oauth",
					access: "radius-access",
					refresh: "radius-refresh",
					expires: Date.now() + 60 * 60_000,
				},
			}),
			modelsPath: null,
		});

		expect(runtime.isUsingOAuth("anthropic")).toBe(true);
		expect(runtime.isUsingSubscription("anthropic")).toBe(true);
		expect(runtime.isUsingOAuth("openrouter")).toBe(true);
		expect(runtime.isUsingSubscription("openrouter")).toBe(false);
		expect(runtime.isUsingOAuth("radius")).toBe(true);
		expect(runtime.isUsingSubscription("radius")).toBe(false);
	});

	it("constructs an API key method for an extension API-key provider", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("extension-api-key", {
			name: "Extension API Key",
			baseUrl: "https://example.test/v1",
			apiKey: "$EXTENSION_TEST_API_KEY",
			api: "openai-completions",
			models: [testModel("extension-model")],
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-api-key");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "api_key",
			provider: { id: "extension-api-key", name: "Extension API Key" },
			method: { name: "API key" },
		});
		expect(options[0]?.method.login).toBeTypeOf("function");
	});

	it("resolves configured auth from request-scoped environment overrides", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("request-env-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "$REQUEST_SCOPED_API_KEY",
			headers: { "x-request-value": "$REQUEST_SCOPED_HEADER" },
			api: "openai-completions",
			models: [testModel("request-env-model")],
		});

		const auth = await runtime.getAuth("request-env-provider", {
			env: { REQUEST_SCOPED_API_KEY: "request-key", REQUEST_SCOPED_HEADER: "request-header" },
		});

		expect(auth?.auth).toEqual({ apiKey: "request-key", headers: { "x-request-value": "request-header" } });
	});

	it("lets an explicit Authorization header override authHeader case-insensitively", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		runtime.registerProvider("auth-header-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "generated-key",
			authHeader: true,
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [testModel("auth-header-model")],
		});
		const model = runtime.getModel("auth-header-provider", "auth-header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(model!, { messages: [] }, { headers: { authorization: "Explicit token" } });

		expect(capturedHeaders).toEqual({ authorization: "Explicit token" });
	});

	it("transforms fully assembled headers once without forwarding the transform", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		let transforms = 0;
		runtime.registerProvider("header-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "generated-key",
			authHeader: true,
			headers: { "x-provider": "provider" },
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				expect(options).not.toHaveProperty("transformHeaders");
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [{ ...testModel("header-model"), headers: { "x-model": "model" } }],
		});
		const model = runtime.getModel("header-provider", "header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(
			model!,
			{ messages: [] },
			{
				headers: { "x-explicit": "explicit" },
				transformHeaders: async (headers) => {
					transforms++;
					expect(headers).toEqual({
						Authorization: "Bearer generated-key",
						"x-provider": "provider",
						"x-model": "model",
						"x-explicit": "explicit",
					});
					return { ...headers, "x-transformed": "yes" };
				},
			},
		);

		expect(transforms).toBe(1);
		expect(capturedHeaders).toEqual({
			Authorization: "Bearer generated-key",
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-transformed": "yes",
		});
	});

	it("does not cancel an extension OAuth refresh with the request", async () => {
		const credentials = AuthStorage.inMemory({
			"extension-oauth": {
				type: "oauth",
				access: "expired",
				refresh: "refresh",
				expires: 0,
			},
		});
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		let refreshSignal: AbortSignal | undefined;
		runtime.registerProvider("extension-oauth", {
			name: "Extension OAuth",
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "Extension subscription",
				login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credential, signal) => {
					refreshSignal = signal;
					return { ...credential, expires: Date.now() + 60_000 };
				},
				getApiKey: (credential) => credential.access,
			},
			models: [testModel("extension-model")],
		});
		const controller = new AbortController();

		await runtime.getAuth("extension-oauth", { signal: controller.signal });
		expect(refreshSignal).toBeInstanceOf(AbortSignal);
		const reason = new Error("cancelled");
		controller.abort(reason);
		// A started refresh may already have rotated the refresh token and must be persisted.
		expect(refreshSignal?.aborted).toBe(false);
	});

	it("does not fabricate an API key method for an extension OAuth-only provider", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("extension-oauth", {
			name: "Extension OAuth",
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "Extension subscription",
				isSubscription: true,
				login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
			},
			models: [testModel("extension-model")],
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-oauth");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "oauth",
			provider: { id: "extension-oauth", name: "Extension OAuth" },
			method: { name: "Extension subscription", isSubscription: true },
		});
	});
});
