// src/miniapp/api.ts
// Backend API for the Telegram Mini App

import { Router } from "express";
import { Reminder } from "../models/Reminder";
import { UserSettings } from "../models/UserSettings";
import crypto from "crypto";

const router = Router();

// Middleware to validate Telegram Mini App init data
function validateTelegramWebAppData(initData: string, botToken: string): number | null {
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get("hash");
  urlParams.delete("hash");
  
  if (!hash) return null;
  
  const dataCheckString = Array.from(urlParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  
  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");
  
  if (calculatedHash !== hash) return null;
  
  const userParam = urlParams.get("user");
  if (!userParam) return null;
  
  const user = JSON.parse(userParam);
  return user.id;
}

// Middleware to authenticate requests
router.use((req, res, next) => {
  const initData = req.headers["x-telegram-init-data"] as string;
  const botToken = process.env.BOT_TOKEN;
  
  if (!botToken) {
    return res.status(500).json({ error: "Bot token not configured" });
  }
  
  const userId = validateTelegramWebAppData(initData, botToken);
  
  if (!userId) {
    return res.status(401).json({ error: "Invalid Telegram data" });
  }
  
  req.userId = userId;
  next();
});

// GET /api/miniapp/reminders - Get all reminders for user
router.get("/reminders", async (req, res) => {
  try {
    const { status = "scheduled", includeHistory = "false" } = req.query;
    
    const query: any = { userId: req.userId };
    
    if (includeHistory === "true") {
      query.status = { $in: ["scheduled", "sent"] };
    } else {
      query.status = status;
    }
    
    const reminders = await Reminder.find(query)
      .sort({ nextRunAt: 1 })
      .lean();
    
    res.json({ reminders });
  } catch (error) {
    console.error("Error fetching reminders:", error);
    res.status(500).json({ error: "Failed to fetch reminders" });
  }
});

// GET /api/miniapp/reminders/:id - Get single reminder
router.get("/reminders/:id", async (req, res) => {
  try {
    const reminder = await Reminder.findOne({
      _id: req.params.id,
      userId: req.userId
    }).lean();
    
    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    
    res.json({ reminder });
  } catch (error) {
    console.error("Error fetching reminder:", error);
    res.status(500).json({ error: "Failed to fetch reminder" });
  }
});

// POST /api/miniapp/reminders - Create new reminder
router.post("/reminders", async (req, res) => {
  try {
    const { text, nextRunAt, schedule, timezone } = req.body;
    
    if (!text || !nextRunAt || !timezone) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    const settings = await UserSettings.findOne({ userId: req.userId }).lean();
    
    if (!settings?.dmChatId) {
      return res.status(400).json({ error: "DM chat not configured" });
    }
    
    const reminder = await Reminder.create({
      userId: req.userId,
      chatId: settings.dmChatId,
      text,
      status: "scheduled",
      nextRunAt: new Date(nextRunAt),
      schedule: schedule || { kind: "once" },
      timezone,
      lock: {}
    });
    
    res.json({ reminder });
  } catch (error) {
    console.error("Error creating reminder:", error);
    res.status(500).json({ error: "Failed to create reminder" });
  }
});

// PUT /api/miniapp/reminders/:id - Update reminder
router.put("/reminders/:id", async (req, res) => {
  try {
    const { text, nextRunAt, schedule, status } = req.body;
    
    const update: any = {};
    if (text !== undefined) update.text = text;
    if (nextRunAt !== undefined) update.nextRunAt = new Date(nextRunAt);
    if (schedule !== undefined) update.schedule = schedule;
    if (status !== undefined) update.status = status;
    
    const reminder = await Reminder.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { $set: update },
      { new: true }
    ).lean();
    
    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    
    res.json({ reminder });
  } catch (error) {
    console.error("Error updating reminder:", error);
    res.status(500).json({ error: "Failed to update reminder" });
  }
});

// POST /api/miniapp/reminders/:id/snooze - Snooze reminder
router.post("/reminders/:id/snooze", async (req, res) => {
  try {
    const { minutes = 15 } = req.body;
    
    const newTime = new Date(Date.now() + minutes * 60 * 1000);
    
    const reminder = await Reminder.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { $set: { nextRunAt: newTime, status: "scheduled" } },
      { new: true }
    ).lean();
    
    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    
    res.json({ reminder });
  } catch (error) {
    console.error("Error snoozing reminder:", error);
    res.status(500).json({ error: "Failed to snooze reminder" });
  }
});

// POST /api/miniapp/reminders/:id/done - Mark as done
router.post("/reminders/:id/done", async (req, res) => {
  try {
    const reminder = await Reminder.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { $set: { status: "sent", lastRunAt: new Date() } },
      { new: true }
    ).lean();
    
    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    
    res.json({ reminder });
  } catch (error) {
    console.error("Error marking reminder as done:", error);
    res.status(500).json({ error: "Failed to mark as done" });
  }
});

// DELETE /api/miniapp/reminders/:id - Delete reminder
router.delete("/reminders/:id", async (req, res) => {
  try {
    const reminder = await Reminder.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { $set: { status: "deleted" } },
      { new: true }
    ).lean();
    
    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    
    res.json({ reminder });
  } catch (error) {
    console.error("Error deleting reminder:", error);
    res.status(500).json({ error: "Failed to delete reminder" });
  }
});

// GET /api/miniapp/settings - Get user settings
router.get("/settings", async (req, res) => {
  try {
    const settings = await UserSettings.findOne({ userId: req.userId }).lean();
    
    res.json({ settings });
  } catch (error) {
    console.error("Error fetching settings:", error);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

export default router;

// Type augmentation for Express Request
declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}
