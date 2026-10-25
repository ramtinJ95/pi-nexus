import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Bm25Ranker, createToolSearchDocument } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/tool-search/tool.js";
import nexusExtension from "../extensions/nexus/index.ts";
import { createNexus } from "../extensions/nexus/cli.ts";
import { nexusTools } from "../extensions/nexus/tools.ts";
import { memoryStores } from "./console-fixture.ts";

describe("tool discovery", () => {
	test("pi's search matches every Nexus tool by nexus, thread, pylon and project", () => {
		const tools = nexusTools(createNexus());
		const documents = tools.map((tool) => createToolSearchDocument(tool));
		for (const query of ["nexus", "thread", "pylon", "project"]) {
			expect(new Bm25Ranker().rank(query, documents, tools.length).map((match) => match.name).sort()).toEqual(tools.map((tool) => tool.name).sort());
		}
	});

	for (const search of ["active", "inactive", "missing", "replaced"] as const) {
		test(`${search} search chooses reachable exposure and reconciles changes`, () => {
			const tools = new Map<string, ToolDefinition>();
			const handlers = new Map<string, (...args: any[]) => void>();
			let active = search === "active" || search === "replaced";
			const pi = {
				registerEntryRenderer() {},
				registerCommand() {},
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler),
				getAllTools: () => search === "missing" ? [] : [{ name: "tool_search", sourceInfo: { path: search === "replaced" ? "/extension.ts" : "builtin:tool-search" } }],
				getActiveTools: () => active ? ["tool_search"] : [],
			} as unknown as ExtensionAPI;
			nexusExtension(pi, createNexus(), undefined, memoryStores());
			expect([...tools.values()].every((tool) => tool.exposure === "deferred")).toBe(true);
			handlers.get("session_start")!({}, { hasUI: false });
			expect([...tools.values()].every((tool) => tool.exposure === (search === "active" ? "deferred" : "direct"))).toBe(true);
			active = !active;
			for (const event of ["before_agent_start", "session_tree", "model_select"]) {
				handlers.get(event)!();
				expect([...tools.values()].every((tool) => tool.exposure === (search === "inactive" ? "deferred" : "direct"))).toBe(true);
			}
		});
	}
});
