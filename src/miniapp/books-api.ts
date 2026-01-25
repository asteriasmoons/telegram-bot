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

function toIntOrNull(v: any) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 0 ? i : null;
}

function normalizeProgress(
  status: "tbr" | "reading" | "finished",
  totalPages: number | null,
  currentPage: number | null
) {
  // Not actively reading → no progress allowed
  if (status !== "reading") {
    return {
      totalPages: null,
      currentPage: null,
    };
  }

  // totalPages of 0 or less is meaningless → treat as unknown
  if (totalPages !== null && totalPages <= 0) {
    totalPages = null;
  }

  // Clamp currentPage only if we have a known total
  if (totalPages !== null && currentPage !== null) {
    currentPage = Math.min(Math.max(currentPage, 0), totalPages);
  }

  return {
    totalPages,
    currentPage,
  };
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

    let totalPages = toIntOrNull(req.body?.totalPages);
    let currentPage = toIntOrNull(req.body?.currentPage);

    const prog = normalizeProgress(status, totalPages, currentPage);
    totalPages = prog.totalPages;
    currentPage = prog.currentPage;

    const created = await Book.create({
      userId,
      title,
      author,
      status,
      totalPages,
      currentPage,
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

    let totalPages = toIntOrNull(req.body?.totalPages);
    let currentPage = toIntOrNull(req.body?.currentPage);

    const prog = normalizeProgress(status, totalPages, currentPage);
    totalPages = prog.totalPages;
    currentPage = prog.currentPage;

    const updated = await Book.findOneAndUpdate(
      { _id: id, userId },
      { title, author, status, totalPages, currentPage },
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

    // ---------- helpers ----------
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/['']/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const stripSubtitle = (t: string) => t.split(":")[0].trim();

    const tokens = (s: string) => new Set(normalize(s).split(" ").filter(Boolean));

    const overlap = (a: Set<string>, b: Set<string>) => {
      if (!a.size || !b.size) return 0;
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      const minSize = Math.min(a.size, b.size);
      return minSize ? inter / minSize : 0;
    };

    const titleA = rawTitle;
    const titleB = stripSubtitle(rawTitle);
    const authorA = rawAuthor;

    const titleTokensFull = tokens(titleA);
    const titleTokensShort = tokens(titleB);
    const authorTokens = tokens(authorA);

    const scoreTitle = (candidateTitle: string) => {
      const cTok = tokens(candidateTitle);
      const full = overlap(titleTokensFull, cTok);
      const short = overlap(titleTokensShort, cTok);
      return Math.max(full, short);
    };

    const scoreAuthor = (candidateAuthor: string) => {
      if (!rawAuthor) return 0;
      const cTok = tokens(candidateAuthor);
      return overlap(authorTokens, cTok);
    };

    const totalScore = (candTitle: string, candAuthor: string) => {
      const t = scoreTitle(candTitle);
      const a = scoreAuthor(candAuthor);
      return rawAuthor ? (t * 0.7 + a * 0.3) : t;
    };

    const PASS_THRESHOLD = rawAuthor ? 0.25 : 0.35;
    const MIN_AUTHOR_IF_PROVIDED = rawAuthor ? 0.05 : 0;

    console.log("📚 Search input:", { rawTitle, rawAuthor });

    // ---------- 1) Google Books ----------
    try {
      // Build simpler query - Google Books is very picky
      let q = rawTitle;
      if (rawAuthor) {
        q = `${rawTitle} ${rawAuthor}`;
      }

      const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=20&printType=books&langRestrict=en`;

      console.log("🔍 Google Books URL:", gbUrl);

      const gbResp = await fetch(gbUrl);
      if (gbResp.ok) {
        const gb = await gbResp.json();
        const items = Array.isArray(gb?.items) ? gb.items : [];

        console.log(`📖 Google Books returned ${items.length} results`);

        let best: any = null;
        let bestScore = 0;

        for (const item of items) {
          const info = item?.volumeInfo || {};
          const candTitle = String(info?.title || "").trim();
          const candAuthors = Array.isArray(info?.authors) ? info.authors.join(", ") : "";

          if (!candTitle) continue;

          const aScore = scoreAuthor(candAuthors);
          const tScore = scoreTitle(candTitle);
          const s = totalScore(candTitle, candAuthors);

          const desc = typeof info?.description === "string" ? info.description.trim() : "";
          const snippet = typeof item?.searchInfo?.textSnippet === "string" ? item.searchInfo.textSnippet.trim() : "";
          const summary = desc || snippet;

          console.log({
            candidate: candTitle,
            author: candAuthors,
            titleScore: tScore.toFixed(3),
            authorScore: aScore.toFixed(3),
            totalScore: s.toFixed(3),
            threshold: PASS_THRESHOLD,
            hasSummary: !!summary,
            passes: s >= PASS_THRESHOLD && !!summary
          });

          if (!summary) continue;
          if (rawAuthor && aScore < MIN_AUTHOR_IF_PROVIDED) continue;

          if (s > bestScore) {
            bestScore = s;
            best = { candTitle, candAuthors, summary };
          }
        }

        if (best && bestScore >= PASS_THRESHOLD) {
          console.log("✅ Google Books match found:", bestScore.toFixed(3));
          return res.json({
            source: "google_books",
            title: best.candTitle || rawTitle,
            author: best.candAuthors || rawAuthor,
            summary: best.summary,
            matchScore: Number(bestScore.toFixed(3)),
          });
        } else {
          console.log("❌ No Google Books match passed threshold. Best score:", bestScore.toFixed(3));
        }
      }
    } catch (err) {
      console.error("Google Books error:", err);
    }

    // ---------- 2) Open Library ----------
    try {
      // Use simple q= parameter for both cases - more reliable
      let q = rawTitle;
      if (rawAuthor) {
        q = `${rawTitle} ${rawAuthor}`;
      }

      const olUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=20`;

      console.log("🔍 Open Library URL:", olUrl);

      const olResp = await fetch(olUrl);
      if (olResp.ok) {
        const ol = await olResp.json();
        const docs = Array.isArray(ol?.docs) ? ol.docs : [];

        console.log(`📚 Open Library returned ${docs.length} results`);

        const scored = docs
          .map((doc: any) => {
            const candTitle = String(doc?.title || "").trim();
            const candAuthor = Array.isArray(doc?.author_name) ? String(doc.author_name[0] || "").trim() : "";
            const key = String(doc?.key || "").trim();
            const s = candTitle ? totalScore(candTitle, candAuthor) : 0;
            const aScore = scoreAuthor(candAuthor);
            const tScore = scoreTitle(candTitle);
            
            console.log({
              olCandidate: candTitle,
              author: candAuthor,
              titleScore: tScore.toFixed(3),
              authorScore: aScore.toFixed(3),
              totalScore: s.toFixed(3),
              key
            });

            return { candTitle, candAuthor, key, s, aScore };
          })
          .filter((x: any) => x.key && x.candTitle)
          .sort((a: any, b: any) => b.s - a.s)
          .slice(0, 8);

        if (!scored.length) {
          console.log("❌ No Open Library results to score");
          return res.status(404).json({
            error: "No results found. Try checking the title spelling.",
          });
        }

        console.log("Top Open Library candidate:", scored[0]);

        if (scored[0].s < PASS_THRESHOLD) {
          console.log(`❌ Best match score ${scored[0].s.toFixed(3)} below threshold ${PASS_THRESHOLD}`);
          return res.status(404).json({
            error: "No strong match found. Try adjusting the title or adding the author.",
          });
        }

        for (const cand of scored) {
          if (rawAuthor && cand.aScore < MIN_AUTHOR_IF_PROVIDED) {
            console.log(`⏭️ Skipping ${cand.candTitle} - author mismatch`);
            continue;
          }

          console.log(`🔍 Fetching work details for: ${cand.candTitle}`);

          const workUrl = `https://openlibrary.org${cand.key}.json`;
          const workResp = await fetch(workUrl);
          if (!workResp.ok) {
            console.log(`❌ Failed to fetch work: ${workUrl}`);
            continue;
          }

          const work = await workResp.json();
          const desc = work?.description;

          const summary =
            typeof desc === "string"
              ? desc
              : typeof desc?.value === "string"
              ? desc.value
              : "";

          if (summary && summary.trim()) {
            console.log("✅ Open Library match found:", cand.s.toFixed(3));
            return res.json({
              source: "open_library",
              title: cand.candTitle || rawTitle,
              author: cand.candAuthor || rawAuthor,
              summary: summary.trim(),
              matchScore: Number(cand.s.toFixed(3)),
            });
          } else {
            console.log(`⏭️ ${cand.candTitle} has no description`);
          }
        }

        console.log("❌ No Open Library results had descriptions");
      } else {
        console.log("❌ Open Library request failed:", olResp.status);
      }
    } catch (err) {
      console.error("Open Library error:", err);
    }

    return res.status(404).json({
      error: "No summary found. The book may not be in these databases.",
    });
  } catch (err) {
    console.error("Summary endpoint error:", err);
    return res.status(500).json({ error: "Failed to fetch summary" });
  }
});

export default router;