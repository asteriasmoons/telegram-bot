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

    const titleRaw = String(req.body?.title || "").trim();
    const authorRaw = String(req.body?.author || "").trim();

    if (!titleRaw) return res.status(400).json({ error: "Title is required" });

    // ---------- matching helpers ----------
    const norm = (s: any) =>
      String(s || "")
        .toLowerCase()
        .trim()
        .replace(/[:\-–--()"'’.,!?]/g, "")
        .replace(/\s+/g, " ");

    const score = (candidateTitle: string, candidateAuthor: string, wantTitle: string, wantAuthor: string) => {
      const ct = norm(candidateTitle);
      const ca = norm(candidateAuthor);
      const wt = norm(wantTitle);
      const wa = norm(wantAuthor);

      let s = 0;

      // title weighting
      if (ct === wt) s += 100;
      else if (ct.includes(wt) || wt.includes(ct)) s += 60;

      // author weighting (optional)
      if (wantAuthor) {
        if (ca.includes(wa) || wa.includes(ca)) s += 40;
      }

      return s;
    };

    // ---------- 1) Google Books (prefer, often has description) ----------
    // Use intitle/inauthor to get better results than a raw q string.
    try {
      const qParts = [`intitle:${titleRaw}`];
      if (authorRaw) qParts.push(`inauthor:${authorRaw}`);
      const gbUrl =
        "https://www.googleapis.com/books/v1/volumes?q=" +
        encodeURIComponent(qParts.join(" ")) +
        "&maxResults=10";

      const gbResp = await fetch(gbUrl);
      if (gbResp.ok) {
        const gb = await gbResp.json();
        const items = Array.isArray(gb?.items) ? gb.items : [];

        // pick best-scoring item that actually has a description
        let best: any = null;
        let bestScore = -1;

        for (const item of items) {
          const info = item?.volumeInfo || {};
          const foundTitle = String(info?.title || "");
          const foundAuthors = Array.isArray(info?.authors) ? info.authors.join(", ") : "";
          const desc = info?.description;

          if (!desc || !String(desc).trim()) continue;

          const s = score(foundTitle, foundAuthors, titleRaw, authorRaw);
          if (s > bestScore) {
            bestScore = s;
            best = { foundTitle, foundAuthors, desc: String(desc).trim() };
          }
        }

        // If we found something reasonable, return it.
        if (best && bestScore >= 40) {
          return res.json({
            found: true,
            source: "google_books",
            title: best.foundTitle || titleRaw,
            author: best.foundAuthors || authorRaw,
            summary: best.desc,
          });
        }
      }
    } catch {
      // ignore and fallback
    }

    // ---------- 2) Open Library fallback ----------
    try {
      // Search more than 1, then pick best match.
      const t = encodeURIComponent(titleRaw);
      const a = encodeURIComponent(authorRaw);

      const olUrl = authorRaw
        ? `https://openlibrary.org/search.json?title=${t}&author=${a}&limit=10`
        : `https://openlibrary.org/search.json?title=${t}&limit=10`;

      const olResp = await fetch(olUrl);
      if (olResp.ok) {
        const ol = await olResp.json();
        const docs = Array.isArray(ol?.docs) ? ol.docs : [];

        let bestDoc: any = null;
        let bestScore = -1;

        for (const doc of docs) {
          const foundTitle = String(doc?.title || "");
          const foundAuthor = Array.isArray(doc?.author_name) ? String(doc.author_name[0] || "") : "";
          const s = score(foundTitle, foundAuthor, titleRaw, authorRaw);
          if (s > bestScore) {
            bestScore = s;
            bestDoc = doc;
          }
        }

        const workKey = bestDoc?.key; // "/works/OLxxxxW"
        if (workKey && bestScore >= 40) {
          const workResp = await fetch(`https://openlibrary.org${workKey}.json`);
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
              const foundTitle = String(bestDoc?.title || "");
              const foundAuthor = Array.isArray(bestDoc?.author_name) ? String(bestDoc.author_name[0] || "") : "";

              return res.json({
                found: true,
                source: "open_library",
                title: foundTitle || titleRaw,
                author: foundAuthor || authorRaw,
                summary: String(summary).trim(),
              });
            }
          }
        }
      }
    } catch {
      // ignore
    }

    // IMPORTANT: return 200 so frontend doesn't treat this as a "crash"
    return res.json({
      found: false,
      source: "none",
      title: titleRaw,
      author: authorRaw,
      summary: "",
      message: "No summary found. Try adding the author or adjusting the title.",
    });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to fetch summary" });
  }
});

export default router;