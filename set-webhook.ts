import { Api } from "grammy/mod.ts";
import { parseArgs } from "jsr:@std/cli/parse-args";

const { url } = parseArgs(Deno.args, {
  string: ["url"],
});
if (!url) throw new Error("No url given. Use --url");

const token = Deno.env.get("BOT_TOKEN");
if (!token) throw new Error("Token not set");

const api = new Api(token);
await api.setWebhook(url, { secret_token: token.replace(":", "") });
