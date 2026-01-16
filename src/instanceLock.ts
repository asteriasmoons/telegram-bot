import { BotLock } from "./models/BotLock";

type InstanceLockOptions = {
  key: string;
  instanceId: string;
  leaseMs: number;
  renewEveryMs: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addMs(d: Date, ms: number) {
  return new Date(d.getTime() + ms);
}

export function createInstanceLock(opts: InstanceLockOptions) {
  let renewTimer: NodeJS.Timeout | null = null;

  async function tryAcquireOnce(): Promise<boolean> {
    const now = new Date();
    const leaseUntil = addMs(now, opts.leaseMs);

    // Acquire if:
    // - lock doesn't exist (upsert)
    // - lock is expired
    // - OR we already own it (re-entrant / renew)
    const doc = await BotLock.findOneAndUpdate(
      {
        key: opts.key,
        $or: [
          { lockExpiresAt: { $lte: now } },
          { lockedBy: opts.instanceId }
        ]
      },
      {
        $set: {
          lockedBy: opts.instanceId,
          lockExpiresAt: leaseUntil
        }
      },
      {
        upsert: true,
        new: true
      }
    ).lean();

    return doc.lockedBy === opts.instanceId;
  }

  async function waitForAcquire() {
    while (true) {
      try {
        const ok = await tryAcquireOnce();
        if (ok) {
          console.log(`[LOCK] Acquired lock key="${opts.key}" as instance="${opts.instanceId}"`);
          return;
        }
        console.log(`[LOCK] Lock is held by another instance. Waiting... key="${opts.key}"`);
        await sleep(2000);
      } catch (e) {
        console.error("[LOCK] Acquire error, retrying in 2s:", e);
        await sleep(2000);
      }
    }
  }

  async function renewOnce() {
    const now = new Date();
    const leaseUntil = addMs(now, opts.leaseMs);

    // Only renew if we still own it
    await BotLock.updateOne(
      { key: opts.key, lockedBy: opts.instanceId },
      { $set: { lockExpiresAt: leaseUntil } }
    );
  }

  function startRenewal() {
    if (renewTimer) return;
    renewTimer = setInterval(() => {
      void renewOnce().catch((e) => console.error("[LOCK] Renew error:", e));
    }, opts.renewEveryMs);
  }

  function stopRenewal() {
    if (!renewTimer) return;
    clearInterval(renewTimer);
    renewTimer = null;
  }

  async function release() {
    try {
      stopRenewal();
      const now = new Date();
      await BotLock.updateOne(
        { key: opts.key, lockedBy: opts.instanceId },
        { $set: { lockExpiresAt: now } }
      );
      console.log(`[LOCK] Released lock key="${opts.key}" instance="${opts.instanceId}"`);
    } catch (e) {
      console.error("[LOCK] Release error:", e);
    }
  }

  return {
    waitForAcquire,
    startRenewal,
    release
  };
}