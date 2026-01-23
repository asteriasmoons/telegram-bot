import { DailyPromptUsage } from "../models/DailyPromptUsage";
import { chicagoDateKey } from "../utils/chicagoDateKey";

const DAILY_LIMIT = 2;

export async function claimDailyPrompt(userId: number): Promise<{
  allowed: boolean;
  remaining: number;
  dateKey: string;
}> {
  const dateKey = chicagoDateKey(new Date());

  // 1) Try to increment if existing doc has room (< 2)
  const incRes = await DailyPromptUsage.updateOne(
    { userId, dateKey, count: { $lt: DAILY_LIMIT } },
    { $inc: { count: 1 } }
  );

  if (incRes.modifiedCount === 1) {
    const doc = await DailyPromptUsage.findOne({ userId, dateKey }).lean();
    const count = doc?.count ?? 1;
    return { allowed: true, remaining: Math.max(0, DAILY_LIMIT - count), dateKey };
  }

  // 2) If no increment happened, either:
  //    - doc doesn't exist yet, OR
  //    - count is already at limit
  // Try to create the first use for today
  try {
    await DailyPromptUsage.create({ userId, dateKey, count: 1 });
    return { allowed: true, remaining: DAILY_LIMIT - 1, dateKey };
  } catch (err: any) {
    // Duplicate key means another request created it first (or it already exists at limit)
    if (err?.code === 11000) {
      const doc = await DailyPromptUsage.findOne({ userId, dateKey }).lean();
      const count = doc?.count ?? DAILY_LIMIT;
      return { allowed: false, remaining: Math.max(0, DAILY_LIMIT - count), dateKey };
    }
    throw err;
  }
}