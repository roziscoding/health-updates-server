import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import * as webpush from "@negrel/webpush";
import { encodeBase64Url } from "@std/encoding/base64url";
import { z } from "zod";
const app = new Hono();
app.use(cors());

const META = ["meta"];
const LATEST_KNOWN_POST_DATE = [...META, "latestKnownPostDate"];
const LATEST_LIKES_COUNT = [...META, "latestLikeCount"];

const SUBSCRIPTIONS = ["subscriptions"];
const LIKES = ["likes"];

const EMOJI_REGEX =
  /([\u2700-\u27BF\uE000-\uF8FF\u2011-\u26FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDD10-\uDDFF])/g;

const Subscription = z.object({
  endpoint: z.string(),
  expirationTime: z.string().nullable().optional(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
type Subscription = z.infer<typeof Subscription>;

const NotificationEvent = z.object({
  type: z.literal("notification"),
  title: z.string(),
  message: z.string(),
  tag: z.string(),

  subscription: Subscription,
});
type NotificationEvent = z.infer<typeof NotificationEvent>;

const DeleteSubscriptionEvent = z.object({
  type: z.literal("delete-subscription"),
  key: z.string(),
});
type DeleteSubscriptionEvent = z.infer<typeof DeleteSubscriptionEvent>;

const Post = z.object({
  uri: z.string(),
  record: z.object({
    createdAt: z.string().transform((value) => new Date(value)),
    text: z.string(),
  }),
});

type Post = z.infer<typeof Post>;

const VAPID_KEYS_ENV = Deno.env.get("VAPID");
if (!VAPID_KEYS_ENV) {
  throw new Error("Missing VAPID environment variable");
}

const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL");
if (!ADMIN_EMAIL) {
  throw new Error("Missing ADMIN_EMAIL environment variable");
}

const DEV_KEY = Deno.env.get("DEV_KEY");
if (!DEV_KEY) {
  console.debug("Dev key not set. Manual push disabled.");
}

const BSKY_URL = Deno.env.get("BSKY_URL");
if (!BSKY_URL) {
  throw new Error("Missing BSKY_URL environment variable");
}

const BOT_TOKEN = Deno.env.get("BOT_TOKEN");
const NOTIFICATION_CHAT_ID = Deno.env.get("NOTIFICATION_CHAT_ID");

const ENABLE_TELEGRAM_UPDATES = BOT_TOKEN && NOTIFICATION_CHAT_ID;

async function sendTelegramMessage(text: string) {
  if (!ENABLE_TELEGRAM_UPDATES) return;

  const url = new URL(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
  url.searchParams.set("chat_id", NOTIFICATION_CHAT_ID);
  url.searchParams.set("text", text);

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Error sending telegram notification: ${await response.text()}`);
    console.log(`Sent telegram notification with "${text}": ${JSON.stringify(await response.json())}`);
  } catch (err) {
    console.error(`Error sending telegram notification with text "${text}": ${err}`);
  }
}

const exportedVapidKeys = JSON.parse(VAPID_KEYS_ENV);
const vapidKeys = await webpush.importVapidKeys(exportedVapidKeys, {
  extractable: false,
});

const appServer = await webpush.ApplicationServer.new({
  contactInformation: `mailto:${ADMIN_EMAIL}`,
  vapidKeys,
});

const kv = await Deno.openKv();

async function broadcast(title: string, message: string, tag: string = crypto.randomUUID()) {
  const subscriptions = kv.list<Subscription>({ prefix: SUBSCRIPTIONS });
  let enqueued = 0;

  for await (const subscription of subscriptions) {
    kv.enqueue(
      {
        type: "notification",
        title: title,
        message: message,
        tag,
        subscription: subscription.value,
      } satisfies NotificationEvent,
    );
    enqueued++;
  }

  await sendTelegramMessage(`Broadcasted https://roz.ninja/updates/${tag} for ${enqueued} subscribers`);

  return enqueued;
}

function srtipPatterns(str: string, patterns: Array<RegExp | string>) {
  return patterns.reduce((result, pattern) => (result as string).replace(pattern, ""), str) as string;
}

export function enrichPost(post: Post) {
  if (!post) {
    return post;
  }
  const count = post.record.text.match(/lkpc:(?<count>\d+)/)?.groups?.count;

  return {
    ...post,
    recordId: post.uri.split("/").pop()!,
    record: {
      ...post.record,
      createdAt: new Date(post.record.createdAt),
      text: srtipPatterns(
        post.record.text,
        ["#healthUpdate", /lkpc:\d+/, EMOJI_REGEX],
      ),
    },
    count: count ? Number(count) : undefined,
  };
}

async function fetchPosts(force = false, noTag = false) {
  const posts = await fetch(BSKY_URL!)
    .then((response) => response.json())
    .then(z.object({ posts: z.array(Post) }).safeParse)
    .then(({ success, error, data }) => {
      if (!success) {
        throw new Error(`Invalid response from bluesky server: ${error}`);
      }

      console.log("Fetched successfully");
      return data.posts.sort((a, b) => b.record.createdAt.getTime() - a.record.createdAt.getTime());
    })
    .then((posts) => posts.map(enrichPost));

  const latestKnownPostDate = await kv.get<number>(LATEST_KNOWN_POST_DATE).then((value) => value?.value);
  const latestPost = posts[0];

  if (!force && latestKnownPostDate && latestPost.record.createdAt.getTime() <= latestKnownPostDate) {
    return;
  }

  await kv.set(LATEST_KNOWN_POST_DATE, latestPost.record.createdAt.getTime());

  const postsSinceLastPostDate = posts.filter((post) => post.record.createdAt.getTime() > (latestKnownPostDate ?? 0));

  await sendTelegramMessage(`Found ${postsSinceLastPostDate.length} new posts. Broadcasting`);

  for (const post of postsSinceLastPostDate) {
    const title = `Update do roz${post.count ? ` - ${post.count}k plaquetas` : ""}`;

    return await broadcast(title, post.record.text, noTag ? undefined : post.recordId);
  }
}

app.use(async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`[${c.req.method}] ${c.req.url} - ${c.res.status} (${ms}ms)`);
});

app.get("/vapidPublicKey", async (c) => {
  const publicKey = encodeBase64Url(
    await crypto.subtle.exportKey(
      "raw",
      vapidKeys.publicKey,
    ),
  );

  return c.text(publicKey);
});

app.post("/", async (c) => {
  const subscription = await c.req.json().then((json) => Subscription.parse(json.subscription));
  await kv.set([...SUBSCRIPTIONS, subscription.keys.auth], subscription);

  return c.json({
    success: true,
  });
});

app.delete("/", async (c) => {
  const subscription = await c.req.json().then((json) => Subscription.parse(json.subscription));
  await kv.delete([...SUBSCRIPTIONS, subscription.keys.auth]);

  return c.json({
    success: true,
  });
});

app.put("/", async (c) => {
  const body = await c.req.json();

  if (!body.key || body.key !== DEV_KEY) return new Response(null, { status: 401 });

  const enqueued = await fetchPosts(true, true);

  return c.json({ ok: true, enqueued: enqueued });
});

app.post("/:postId/likes", async (c) => {
  const postId = c.req.param("postId");
  if (!postId) {
    return c.json({ ok: false, status: 422, error: "missing postId" }, { status: 422 });
  }
  const key = [...LIKES, postId];

  let success = false;
  let attempts = 0;

  while (!success && attempts < 4) {
    const previousValue = await kv.get<number>(key);

    const result = await kv.atomic()
      .check({
        key,
        versionstamp: previousValue.versionstamp,
      })
      .mutate({
        type: "set",
        key,
        value: (previousValue.value ?? 0) + 1,
      })
      .commit();

    success = result.ok;
    attempts++;
  }

  const count = await kv.get<number>(key).then((count) => Number(count.value ?? 0));

  return c.json({ ok: success, count });
});

app.delete("/:postId/likes", async (c) => {
  const postId = c.req.param("postId");

  if (!postId) {
    return c.json({ ok: false, status: 422, error: "missing postId" }, { status: 422 });
  }

  const key = [...LIKES, postId];

  let success = false;
  let attempts = 0;

  while (!success && attempts < 4) {
    const previousValue = await kv.get<number>(key);

    if (!previousValue.value) return c.json({ ok: true, count: 0 });

    const result = await kv.atomic()
      .check({
        key,
        versionstamp: previousValue.versionstamp,
      })
      .mutate({
        type: "set",
        key,
        value: previousValue.value - 1,
      })
      .commit();

    success = result.ok;
    attempts++;
  }

  const count = await kv.get<number>(key);

  return c.json({ ok: success, count: count.value ?? 0 });
});

app.get("/likes", async (c) => {
  const likes: Record<string, number> = {};

  for await (const { key, value } of kv.list<number>({ prefix: LIKES })) {
    const [_, postId] = key;
    likes[String(postId)] = value;
  }

  return c.json({ likes });
});

kv.listenQueue(async (event) => {
  const { success, data } = NotificationEvent.safeParse(event);

  if (!success) return;

  const subscriber = appServer.subscribe(data.subscription);

  await subscriber.pushTextMessage(JSON.stringify({ title: data.title, message: data.message, tag: data.tag }), {})
    .catch(async (err) => {
      console.error(`Error sending ${data.title} to ${data.subscription.keys.auth}: ${err}`);
      await kv.enqueue(
        {
          type: "delete-subscription",
          key: data.subscription.keys.auth,
        } satisfies DeleteSubscriptionEvent,
      );
    }).then(() =>
      console.log(`Sent push notification with title ${data.title} to subscriber ${data.subscription.keys.auth}`)
    );
});

kv.listenQueue(async (event) => {
  const { success, data } = DeleteSubscriptionEvent.safeParse(event);

  if (!success) return;

  await kv.delete([...SUBSCRIPTIONS, data.key]);
  console.log(`Completed deletion of subscription ${data.key}`);
});

Deno.cron("check-for-updates", "*/1 * * * *", async () => {
  await fetchPosts();
});

Deno.cron("update-like-summary", "0 */1 * * *", async () => {
  const previousLikeCount = await kv.get<number>(LATEST_LIKES_COUNT).then((entry) => entry.value ?? 0);
  const likes = kv.list<number>({ prefix: LIKES });
  let currentLikeCount = 0;

  for await (const like of likes) {
    currentLikeCount += like.value;
  }

  const diff = previousLikeCount - currentLikeCount;

  await sendTelegramMessage(`${diff} ${diff < 0 ? "less" : "new"} likes since last hour`);
});

Deno.serve({
  port: 8080,

  onListen({ port }) {
    console.log(`Server is running on port ${port}`);
  },
}, app.fetch);
