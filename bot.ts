import { Bot } from "grammy/mod.ts";

// deno-lint-ignore no-explicit-any
export function useBot(token: string, adminChatId: number, fetchPosts: (force: boolean) => Promise<any>) {
  const bot = new Bot(token);

  bot
    .filter((ctx) => ctx.hasChatType("private"))
    .filter((ctx) => ctx.from.id === adminChatId)
    .command(
      "check",
      async (ctx) => {
        await ctx.reply("Fetching...", {
          reply_parameters: {
            message_id: ctx.msg.message_id,
            allow_sending_without_reply: true,
          },
        });

        await fetchPosts(true);

        await ctx.reply("Done");
      },
    );

  return bot;
}
