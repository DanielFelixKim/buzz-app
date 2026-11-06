// External API v1 plugin. The host supplies the owner-scoped read capability.
export const inject = ["agents"];
export function apply(ctx) {
  ctx.agents.addTool({
    name: "draft_get",
    description:
      "Read your owner's unsent draft on this device for one channel and optional thread. source says whether it is the live composer or saved draft. Does not send or change it. Attached files are not included.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID." },
        thread: {
          type: "string",
          description: "Thread root event ID; omit for the channel composer.",
        },
      },
      required: ["channel"],
      additionalProperties: false,
    },
    async call(client, _context, args) {
      if (
        Object.keys(args).some(
          (key) => key !== "channel" && key !== "thread",
        ) ||
        typeof args.channel !== "string" ||
        (args.thread !== undefined && typeof args.thread !== "string")
      )
        throw new Error("Provide a channel ID and optional thread root ID.");
      if (!client.readDraft)
        throw new Error(
          "Owner drafts are available only to your owner's agents running in Buzz on this device.",
        );
      return JSON.stringify({
        channel: args.channel,
        ...(args.thread === undefined ? {} : { thread: args.thread }),
        draft: client.readDraft(args.channel, args.thread) ?? null,
      });
    },
  });
}
