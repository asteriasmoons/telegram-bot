import { Telegraf } from "telegraf";
import mongoose from "mongoose";
import { Reminder, ReminderDoc } from "./models/Reminder";
import { addMinutes } from "./utils/time";

export function makeInstanceId(prefix = "sched") {
return `${prefix}_${process.pid}_${Date.now()}`;
}

type SchedulerOptions = {
// Preferred name
pollEveryMs?: number;

// Backwards-compatible alias (in case some other file still uses it)
pollIntervalMs?: number;

// Lock TTL (preferred)
lockTtlMs?: number;

// Backwards-compatible/alternate lock settings
lockSeconds?: number;

instanceId?: string;
};

function now() {
return new Date();
}

function addSeconds(d: Date, seconds: number) {
return new Date(d.getTime() + seconds * 1000);
}

/**

- Acquire a lock on a reminder so only one instance processes it.
- Works across multiple Render deploys/instances.
  */
  async function acquireLock(reminderId: any, instanceId: string, lockSeconds: number) {
  const lockedAt = now();
  const lockExpiresAt = addSeconds(lockedAt, lockSeconds);

const res = await Reminder.updateOne(
{
_id: reminderId,
status: "scheduled",
$or: [
{ "lock.lockExpiresAt": { $exists: false } },
{ "lock.lockExpiresAt": { $lte: lockedAt } }
]
},
{
$set: {
"lock.lockedAt": lockedAt,
"lock.lockExpiresAt": lockExpiresAt,
"lock.lockedBy": instanceId
}
}
);

return res.modifiedCount === 1;
}

/**

- Release lock safely using $unset (cleaner than setting undefined).
  */
  async function releaseLock(reminderId: any, instanceId: string) {
  await Reminder.updateOne(
  { _id: reminderId, "lock.lockedBy": instanceId },
  {
  $unset: {
  "lock.lockedAt": 1,
  "lock.lockExpiresAt": 1,
  "lock.lockedBy": 1
  }
  }
  );
  }

/**

- Compute next run time for repeating reminders.
- Note: interval uses "now + intervalMinutes".
- daily/weekly just add a fixed amount of minutes from last scheduled run.
- (We can upgrade to timezone-accurate recurrence later if you want.)
  */
  function computeNextForRepeat(rem: ReminderDoc): Date | null {
  const sched = rem.schedule;
  if (!sched) return null;

if (sched.kind === "interval") {
const mins = sched.intervalMinutes;
if (!mins || mins <= 0) return null;
return addMinutes(now(), mins);
}

if (sched.kind === "daily") return addMinutes(rem.nextRunAt, 24 * 60);
if (sched.kind === "weekly") return addMinutes(rem.nextRunAt, 7 * 24 * 60);

return null;
}

/**

- SEND: important part for custom emojis + bold/italics/etc
- Telegram renders formatting ONLY if it has message entities.
- We store entities on the reminder document and replay them here.
  */
  async function sendReminder(bot: Telegraf<any>, rem: any) {
  const text = String(rem.text ?? "");

const entities =
Array.isArray(rem.entities) && rem.entities.length > 0 ? rem.entities : undefined;

// If entities exist, send them. This preserves:
// - custom emojis (type: "custom_emoji", with custom_emoji_id)
// - bold/italic/underline/spoiler/etc (entity types)
// - links (text_link, url)
const sendOpts: any = {};
if (entities) {
sendOpts.entities = entities;
}

try {
await bot.telegram.sendMessage(rem.chatId, text, sendOpts);
} catch (err: any) {
// Log the specific error for debugging
console.error(`Failed to send reminder ${rem._id} to chat ${rem.chatId}:`, err.message);
throw err; // Re-throw so the scheduler can handle it
}
}

export function startScheduler(bot: Telegraf<any>, opts: SchedulerOptions = {}) {
const pollEveryMs = opts.pollEveryMs ?? opts.pollIntervalMs ?? 10_000;

// lockSeconds priority:
// 1) explicit lockSeconds
// 2) lockTtlMs converted to seconds
// 3) default 60s
const lockSeconds =
typeof opts.lockSeconds === "number" && opts.lockSeconds > 0
? Math.floor(opts.lockSeconds)
: typeof opts.lockTtlMs === "number" && opts.lockTtlMs > 0
? Math.max(5, Math.floor(opts.lockTtlMs / 1000))
: 60;

const instanceId = opts.instanceId ?? makeInstanceId();

console.log(`Scheduler started (${instanceId}). Poll every ${pollEveryMs}ms`);

const tick = async () => {
try {
if (mongoose.connection.readyState !== 1) return;


  const due = await Reminder.find({
    status: "scheduled",
    nextRunAt: { $lte: now() }
  })
    .sort({ nextRunAt: 1 })
    .limit(25);

  for (const rem of due) {
    const got = await acquireLock(rem._id, instanceId, lockSeconds);
    if (!got) continue;

    try {
      await sendReminder(bot, rem);

      const nextForRepeat = computeNextForRepeat(rem);

      if (rem.schedule && rem.schedule.kind !== "once" && nextForRepeat) {
        await Reminder.updateOne(
          { _id: rem._id },
          {
            $set: {
              nextRunAt: nextForRepeat,
              lastRunAt: now(),
              status: "scheduled"
            }
          }
        );
      } else {
        await Reminder.updateOne(
          { _id: rem._id },
          {
            $set: { lastRunAt: now(), status: "sent" }
          }
        );
      }
    } catch (err) {
      console.error("Scheduler send error:", err);

      // If send fails, push it out 5 minutes so it doesn't hammer.
      await Reminder.updateOne(
        { _id: rem._id },
        { $set: { nextRunAt: addMinutes(now(), 5) } }
      );
    } finally {
      await releaseLock(rem._id, instanceId);
    }
  }
} catch (err) {
  console.error("Scheduler tick error:", err);
}


};

// fire once quickly
tick().catch(() => {});

const handle = setInterval(() => {
tick().catch(() => {});
}, pollEveryMs);

return () => clearInterval(handle);
}