import { Bot, InlineKeyboard } from "grammy/mod.ts";

// deno-lint-ignore no-explicit-any
export function useBot(token: string, adminChatId: number, fetchPosts: (force: boolean) => Promise<any>) {
  const bot = new Bot(token);

  bot.command("start", (ctx) => {
    InlineKeyboard.text("CHECK");
    ctx.reply("Click to check for updates", {
      reply_markup: new InlineKeyboard().text("CHECK", "check"),
    });
  });

  bot
    .filter((ctx) => ctx.hasChatType("private"))
    .filter((ctx) => ctx.from.id === adminChatId)
    .callbackQuery(
      "check",
      async (ctx) => {
        await ctx.reply("Fetching...");

        await fetchPosts(true);

        await ctx.reply("Done");
      },
    );
  return bot;
}
