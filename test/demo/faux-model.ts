/** A pi extension whose model plays test/demo/conversation.ts, for the real pi side of the screenshots. */
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { model, steps } from "./conversation.ts";

export default function fauxModel(pi: ExtensionAPI) {
	const core = createFauxCore({ api: "demo-faux", provider: "demo", models: [{ id: model }], tokensPerSecond: 400 });
	core.setResponses(
		steps.map((step) =>
			fauxAssistantMessage([...(step.text ? [fauxText(step.text)] : []), fauxToolCall(step.call.name, step.call.arguments as never, { id: step.call.id })], {
				stopReason: "toolUse",
			}),
		),
	);
	pi.registerProvider("demo", {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "demo",
		api: core.api as never,
		streamSimple: core.streamSimple as never,
		models: [{ id: model, name: model, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 }],
	});
}
