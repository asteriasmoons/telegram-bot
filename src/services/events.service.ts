import { Types } from "mongoose";
import { Event, EventDoc } from "../models/Event";

/**
 * Shared Events Service
 * - Single source of truth for CRUD operations
 * - Used by: miniapp API routes + Telegram bot commands/callback flows
 * - Does NOT assume any UI (no Telegram / no HTTP res objects)
 */

export type CreateEventInput = {
  title: string;
  description?: string;
  startDate: Date;
  endDate?: Date;
  allDay?: boolean;
  color?: string;
  location?: string;
  reminderId?: Types.ObjectId;
};

export type UpdateEventInput = Partial<{
  title: string;
  description?: string;
  startDate: Date;
  endDate?: Date | null; // null means "clear endDate"
  allDay: boolean;
  color?: string;
  location?: string;
  reminderId?: Types.ObjectId | null; // null means "clear reminderId"
}>;

export type ListEventsOptions = {
  startDate?: Date;
  endDate?: Date;
  limit?: number; // default 100, max 500
};

function assertUserId(userId: number) {
  if (!userId || typeof userId !== "number") throw new Error("Missing userId");
}

function clampLimit(n: number | undefined, def = 100, max = 500) {
  const v = typeof n === "number" ? n : def;
  return Math.min(Math.max(v, 1), max);
}

function assertDate(d: Date, name: string) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ${name}`);
  }
}

function isValidHexColor(c: string) {
  return /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(c);
}

/**
 * Create
 */
export async function createEvent(userId: number, input: CreateEventInput): Promise<EventDoc> {
  assertUserId(userId);

  if (!input?.title?.trim()) throw new Error("Title is required");
  assertDate(input.startDate, "startDate");
  if (input.endDate) assertDate(input.endDate, "endDate");

  if (input.color && !isValidHexColor(input.color)) {
    throw new Error("Invalid color (expected hex like #5b8def)");
  }

  const doc = await Event.create({
    userId,
    title: input.title.trim(),
    description: input.description,
    startDate: input.startDate,
    endDate: input.endDate,
    allDay: Boolean(input.allDay),
    color: input.color,
    location: input.location,
    reminderId: input.reminderId,
  });

  return doc as unknown as EventDoc;
}

/**
 * Read (one)
 */
export async function getEvent(userId: number, eventId: string): Promise<EventDoc> {
  assertUserId(userId);
  if (!Types.ObjectId.isValid(eventId)) throw new Error("Invalid eventId");

  const doc = await Event.findOne({ _id: eventId, userId });
  if (!doc) throw new Error("Event not found");

  return doc as unknown as EventDoc;
}

/**
 * List (range-aware, uses your { userId, startDate } index)
 * - If no range provided: returns upcoming-ish by sorting startDate asc and limiting
 */
export async function listEvents(userId: number, opts: ListEventsOptions = {}): Promise<EventDoc[]> {
  assertUserId(userId);

  const limit = clampLimit(opts.limit);

  const query: any = { userId };

  if (opts.startDate || opts.endDate) {
    query.startDate = {};
    if (opts.startDate) {
      assertDate(opts.startDate, "startDate");
      query.startDate.$gte = opts.startDate;
    }
    if (opts.endDate) {
      assertDate(opts.endDate, "endDate");
      query.startDate.$lte = opts.endDate;
    }
  }

  const docs = await Event.find(query).sort({ startDate: 1 }).limit(limit).lean();
  return docs as unknown as EventDoc[];
}

/**
 * Update
 */
export async function updateEvent(
  userId: number,
  eventId: string,
  updates: UpdateEventInput
): Promise<EventDoc> {
  assertUserId(userId);
  if (!Types.ObjectId.isValid(eventId)) throw new Error("Invalid eventId");
  if (!updates || Object.keys(updates).length === 0) throw new Error("No updates provided");

  const doc = await Event.findOne({ _id: eventId, userId });
  if (!doc) throw new Error("Event not found");

  if (typeof updates.title === "string") {
    const t = updates.title.trim();
    if (!t) throw new Error("Title cannot be empty");
    doc.title = t;
  }

  if (typeof updates.description === "string") doc.description = updates.description;
  if (typeof updates.location === "string") doc.location = updates.location;

  if (typeof updates.allDay === "boolean") doc.allDay = updates.allDay;

  if (typeof updates.color === "string") {
    if (!isValidHexColor(updates.color)) throw new Error("Invalid color (expected hex like #5b8def)");
    doc.color = updates.color;
  }

  if (updates.startDate instanceof Date) {
    assertDate(updates.startDate, "startDate");
    doc.startDate = updates.startDate;
  }

  // endDate: Date sets it, null clears it, undefined leaves it alone
  if (updates.endDate instanceof Date) {
    assertDate(updates.endDate, "endDate");
    doc.endDate = updates.endDate;
  } else if (updates.endDate === null) {
    doc.endDate = undefined;
  }

  // reminderId: ObjectId sets it, null clears it, undefined leaves it alone
  if (updates.reminderId instanceof Types.ObjectId) {
    doc.reminderId = updates.reminderId;
  } else if (updates.reminderId === null) {
    doc.reminderId = undefined;
  }

  await doc.save();
  return doc as unknown as EventDoc;
}

/**
 * Delete
 */
export async function deleteEvent(userId: number, eventId: string): Promise<void> {
  assertUserId(userId);
  if (!Types.ObjectId.isValid(eventId)) throw new Error("Invalid eventId");

  const res = await Event.deleteOne({ _id: eventId, userId });
  if (!res.deletedCount) throw new Error("Event not found");
}