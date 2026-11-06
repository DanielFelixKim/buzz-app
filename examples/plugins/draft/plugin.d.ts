import type { AddedTool } from "../../../src/plugins/author";
export const inject: readonly string[];
export function apply(ctx: {
  agents: { addTool(tool: AddedTool): void };
}): void;
