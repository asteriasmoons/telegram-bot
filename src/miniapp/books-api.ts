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
 * Returns 200 with found=false if no match.
 */
router.post("/summary", async (req: any, res) => {
  try {
    const userId = req.userId as number;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const rawTitle = String(req.body?.title || "").trim();
    const rawAuthor = String(req.body?.author || "").trim();
    if (!rawTitle) return res.status(400).json({ error: "Title is required" });

    // Build "fuzzy-ish" query variants (no extra libs)
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s:.-]/gu, "") // keep letters/numbers/spaces/basic punctuation
        .replace(/\s+/g, " ")
        .trim();

    const stripSubtitle = (t: string) => t.split(":")[0].trim();

    const titleNorm = normalize(rawTitle);
    const titleShort = normalize(stripSubtitle(rawTitle));
    const authorNorm = normalize(rawAuthor);

    const queries: string[] = [];

    // Most specific → least specific
    if (rawAuthor) queries.push(`intitle:${rawTitle} inauthor:${rawAuthor}`);
    if (rawAuthor) queries.push(`${rawTitle} ${rawAuthor}`);
    if (rawAuthor && titleShort !== titleNorm) queries.push(`intitle:${stripSubtitle(rawTitle)} inauthor:${rawAuthor}`);
    queries.push(`intitle:${rawTitle}`);
    if (titleShort !== titleNorm) queries.push(`intitle:${stripSubtitle(rawTitle)}`);
    queries.push(rawTitle);

    // De-dupe
    const qList = Array.from(new Set(queries.map(q => q.trim()).filter(Boolean)));

    // 1) Google Books (try multiple queries, take best description/snippet)
    for (const q of qList) {
      try {
        const gbUrl =
          "https://www.googleapis.com/books/v1/volumes?q=" +
          encodeURIComponent(q) +
          "&maxResults=5";
        const gbResp = await fetch(gbUrl);

        if (!gbResp.ok) continue;

        const gb = await gbResp.json();
        const items = Array.isArray(gb?.items) ? gb.items : [];

        for (const item of items) {
          const info = item?.volumeInfo || {};
          const foundTitle = info?.title || rawTitle;
          const foundAuthors = Array.isArray(info?.authors) ? info.authors.join(", ") : (rawAuthor || "");

          const desc = typeof info?.description === "string" ? info.description.trim() : "";
          const snippet = typeof item?.searchInfo?.textSnippet === "string" ? item.searchInfo.textSnippet.trim() : "";

          const summary = desc || snippet;

          if (summary) {
            return res.json({
              source: "google_books",
              title: foundTitle,
              author: foundAuthors,
              summary,
            });
          }
        }
      } catch {
        // try next query
      }
    }

    // 2) Open Library (try multiple queries; use first work with description)
    for (const q of qList) {
      try {
        const olSearchUrl =
          "https://openlibrary.org/search.json?limit=5&q=" + encodeURIComponent(q);

        const olResp = await fetch(olSearchUrl);
        if (!olResp.ok) continue;

        const ol = await olResp.json();
        const docs = Array.isArray(ol?.docs) ? ol.docs : [];

        for (const doc of docs) {
          const workKey = doc?.key; // "/works/OLxxxxW"
          if (!workKey) continue;

          const foundTitle = doc?.title || rawTitle;
          const foundAuthor = Array.isArray(doc?.author_name) ? doc.author_name[0] : (rawAuthor || "");

          const workUrl = `https://openlibrary.org${workKey}.json`;
          const workResp = await fetch(workUrl);
          if (!workResp.ok) continue;

          const work = await workResp.json();
          const desc = work?.description;

          const summary =
            typeof desc === "string"
              ? desc
              : typeof desc?.value === "string"
              ? desc.value
              : "";

          if (summary && summary.trim()) {
            return res.json({
              source: "open_library",
              title: foundTitle,
              author: foundAuthor,
              summary: summary.trim(),
            });
          }
        }
      } catch {
        // try next query
      }
    }

    return res.status(404).json({
      error: "No summary found. Try adjusting the title or adding the author.",
    });
  } catch {
    return res.status(500).json({ error: "Failed to fetch summary" });
  }
});

export default router;