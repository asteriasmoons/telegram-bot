// src/miniapp/calendar-api.ts
// Calendar API endpoints

import { Router } from "express";
import { Event } from "../models/Event";

const router = Router();

// GET /api/miniapp/calendar/events - Get events for a date range
router.get("/events", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate required" });
    }
    
    const events = await Event.find({
      userId: req.userId,
      startDate: {
        $gte: new Date(startDate as string),
        $lte: new Date(endDate as string)
      }
    })
      .sort({ startDate: 1 })
      .lean();
    
    res.json({ events });
  } catch (error) {
    console.error("Error fetching events:", error);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

// GET /api/miniapp/calendar/events/:id - Get single event
router.get("/events/:id", async (req, res) => {
  try {
    const event = await Event.findOne({
      _id: req.params.id,
      userId: req.userId
    }).lean();
    
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    
    res.json({ event });
  } catch (error) {
    console.error("Error fetching event:", error);
    res.status(500).json({ error: "Failed to fetch event" });
  }
});

// POST /api/miniapp/calendar/events - Create new event
router.post("/events", async (req, res) => {
  try {
    const { title, description, startDate, endDate, allDay, color, location } = req.body;
    
    if (!title || !startDate) {
      return res.status(400).json({ error: "title and startDate required" });
    }
    
    const event = await Event.create({
      userId: req.userId,
      title,
      description,
      startDate: new Date(startDate),
      endDate: endDate ? new Date(endDate) : undefined,
      allDay: allDay || false,
      color,
      location
    });
    
    res.json({ event });
  } catch (error) {
    console.error("Error creating event:", error);
    res.status(500).json({ error: "Failed to create event" });
  }
});

// PUT /api/miniapp/calendar/events/:id - Update event
router.put("/events/:id", async (req, res) => {
  try {
    const { title, description, startDate, endDate, allDay, color, location } = req.body;
    
    const update: any = {};
    if (title !== undefined) update.title = title;
    if (description !== undefined) update.description = description;
    if (startDate !== undefined) update.startDate = new Date(startDate);
    if (endDate !== undefined) update.endDate = endDate ? new Date(endDate) : null;
    if (allDay !== undefined) update.allDay = allDay;
    if (color !== undefined) update.color = color;
    if (location !== undefined) update.location = location;
    
    const event = await Event.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { $set: update },
      { new: true }
    ).lean();
    
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    
    res.json({ event });
  } catch (error) {
    console.error("Error updating event:", error);
    res.status(500).json({ error: "Failed to update event" });
  }
});

// DELETE /api/miniapp/calendar/events/:id - Delete event
router.delete("/events/:id", async (req, res) => {
  try {
    const event = await Event.findOneAndDelete({
      _id: req.params.id,
      userId: req.userId
    }).lean();
    
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    
    res.json({ event });
  } catch (error) {
    console.error("Error deleting event:", error);
    res.status(500).json({ error: "Failed to delete event" });
  }
});

export default router;
