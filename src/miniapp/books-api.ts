// src/miniapp/books-api.ts
import { Router } from "express";
import { Book } from "../models/Book";

const router = Router();

function normalizeStatus(input: any) {
  const s = String(input || "").toLowerCase().trim();
  if (s === "tbr") return "tbr";
  if (s === "reading" || s === "active") return "reading";
  if (s === "finished" || s === "done") return "finished";
  return null;
}

/**
 * GET /api/miniapp/books?status=all|tbr|reading|finished
 */
router.get("/", async (req: any, res) => {
  try {
    const userId = req.userId as number;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const statusRaw = String(req.query.status || "all").toLowerCase();
    const filter: any = { userId };

    if (statusRaw !== "all") {
      const status = normalizeStatus(statusRaw);
      if (!status) return res.status(400).json({ error: "Invalid status" });
      filter.status = status;
    }

    const books = await Book.find(filter)
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    return res.json({ books });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to load books" });
  }
});

/**
 * POST /api/miniapp/books
 * body: { title, author?, status }
 */
router.post("/", async (req: any, res) => {
  try {
    const userId = req.userId as number;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const title = String(req.body?.title || "").trim();
    const author = String(req.body?.author || "").trim();
    const status = normalizeStatus(req.body?.status);

    if (!title) return res.status(400).json({ error: "Title is required" });
    if (!status) return res.status(400).json({ error: "Invalid status" });

    const created = await Book.create({
      userId,
      title,
      author,
      status,
    });

    return res.json({ book: created.toObject() });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to create book" });
  }
});

/**
 * PUT /api/miniapp/books/:id
 * body: { title, author?, status }
 */
router.put("/:id", async (req: any, res) => {
  try {
    const userId = req.userId as number;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing id" });

    const title = String(req.body?.title || "").trim();
    const author = String(req.body?.author || "").trim();
    const status = normalizeStatus(req.body?.status);

    if (!title) return res.status(400).json({ error: "Title is required" });
    if (!status) return res.status(400).json({ error: "Invalid status" });

    const updated = await Book.findOneAndUpdate(
      { _id: id, userId },
      { title, author, status },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ error: "Book not found" });

    return res.json({ book: updated });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to update book" });
  }
});

/**
 * DELETE /api/miniapp/books/:id
 */
router.delete("/:id", async (req: any, res) => {
  try {
    const userId = req.userId as number;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing id" });

    const deleted = await Book.findOneAndDelete({ _id: id, userId }).lean();
    if (!deleted) return res.status(404).json({ error: "Book not found" });

    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to delete book" });
  }
});

/**
 * POST /api/miniapp/books/summary
 * body: { title, author? }
 *
 * Summaries are NOT saved.
 * Uses Google Books + Open Library (fallback).
 */
router.post("/summary", async (req: any, res) => {
  try {
    const userId = req.userId as number;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const title = String(req.body?.title || "").trim();
    const author = String(req.body?.author || "").trim();
    if (!title) return res.status(400).json({ error: "Title is required" });

    const q = author ? `${title} ${author}` : title;

    // 1) Google Books
    try {
      const gbUrl =
        "https://www.googleapis.com/books/v1/volumes?q=" +
        encodeURIComponent(q) +
        "&maxResults=1";
      const gbResp = await fetch(gbUrl);
      if (gbResp.ok) {
        const gb = await gbResp.json();
        const item = gb?.items?.[0];
        const desc = item?.volumeInfo?.description;

        const foundTitle = item?.volumeInfo?.title;
        const foundAuthors = Array.isArray(item?.volumeInfo?.authors)
          ? item.volumeInfo.authors.join(", ")
          : "";

        if (desc && String(desc).trim()) {
          return res.json({
            source: "google_books",
            title: foundTitle || title,
            author: foundAuthors || author,
            summary: String(desc).trim(),
          });
        }
      }
    } catch {
      // ignore, fallback
    }

    // 2) Open Library
    try {
      const olSearchUrl =
        "https://openlibrary.org/search.json?limit=1&q=" + encodeURIComponent(q);
      const olResp = await fetch(olSearchUrl);
      if (olResp.ok) {
        const ol = await olResp.json();
        const doc = ol?.docs?.[0];
        const workKey = doc?.key; // "/works/OLxxxxW"

        const foundTitle = doc?.title;
        const foundAuthor = Array.isArray(doc?.author_name) ? doc.author_name[0] : "";

        if (workKey) {
          const workUrl = `https://openlibrary.org${workKey}.json`;
          const workResp = await fetch(workUrl);
          if (workResp.ok) {
            const work = await workResp.json();
            const desc = work?.description;

            const summary =
              typeof desc === "string"
                ? desc
                : typeof desc?.value === "string"
                ? desc.value
                : "";

            if (summary && String(summary).trim()) {
              return res.json({
                source: "open_library",
                title: foundTitle || title,
                author: foundAuthor || author,
                summary: String(summary).trim(),
              });
            }
          }
        }
      }
    } catch {
      // ignore
    }

    return res.status(404).json({
      error: "No summary found. Try adding the author or adjusting the title.",
    });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to fetch summary" });
  }
});

export default router;