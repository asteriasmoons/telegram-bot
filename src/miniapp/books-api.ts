// src/miniapp/books-api.ts
import { Router } from "express";
import { Book } from "../models/Book";
import { ReadingStreak } from "../models/ReadingStreak";
import { UserSettings } from "../models/UserSettings";

const router = Router();

// Ensure every book returned to the client has a stable string `id`
function withId<T extends { _id?: any }>(doc: T) {
  return {
    ...doc,
    id: doc?._id ? String(doc._id) : undefined,
  };
}

function normalizeStatus(input: any) {
  const s = String(input || "").toLowerCase().trim();
  if (s === "tbr") return "tbr";
  if (s === "reading" || s === "active") return "reading";
  if (s === "finished" || s === "done") return "finished";
  if (s === "paused") return "paused";
  if (s === "dnf") return "dnf";
  return null;
}

function toIntOrNull(v: any) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 0 ? i : null;
}

function toIntOrUndefined(v: any) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.floor(n);
}

function clampRating(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const i = Math.floor(n);
  if (i < 0) return 0;
  if (i > 5) return 5;
  return i;
}

function clampShortSummary(v: any) {
  // One to two short sentences is the UI goal, but enforce a safe max length.
  // If you want a different max, change 280 here.
  const s = String(v || "").trim();
  if (!s) return "";
  return s.slice(0, 800);
}

function normalizeProgress(
  status: "tbr" | "reading" | "finished" | "paused" | "dnf",
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

async function getTimezoneForUser(userId: number): Promise<string> {
  const s = await UserSettings.findOne({ userId }).lean();
  return String(s?.timezone || "America/Chicago");
}

// returns "YYYY-MM-DD" in the user's timezone
function dateKeyInTz(tz: string, d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// given "YYYY-MM-DD", return yesterday "YYYY-MM-DD"
function yesterdayKeyFromTodayKey(todayKey: string): string {
  const [y, m, d] = todayKey.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d);
  const prev = new Date(utc - 86400000);
  const yy = prev.getUTCFullYear();
  const mm = String(prev.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(prev.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
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

    // IMPORTANT: `.lean()` does NOT include virtual `id`, so add it.
    return res.json({ books: books.map(withId) });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to load books" });
  }
});

// GET streaks
router.get("/streak", async (req: any, res) => {
  try {
    const userId = req.userId as number;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const tz = await getTimezoneForUser(userId);
    const todayKey = dateKeyInTz(tz);

    let doc = await ReadingStreak.findOne({ userId }).lean();

    if (!doc) {
      const created = await ReadingStreak.create({
        userId,
        currentStreak: 0,
        bestStreak: 0,
        lastCheckInDate: null,
      });
      doc = created.toObject();
    }

    return res.json({
      streak: {
        currentStreak: doc.currentStreak || 0,
        bestStreak: doc.bestStreak || 0,
        lastCheckInDate: doc.lastCheckInDate || null,
        checkedInToday: doc.lastCheckInDate === todayKey,
        todayKey,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to load streak" });
  }
});

// POST streaks
router.post("/streak/checkin", async (req: any, res) => {
  try {
    const userId = req.userId as number;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const tz = await getTimezoneForUser(userId);
    const todayKey = dateKeyInTz(tz);
    const yesterdayKey = yesterdayKeyFromTodayKey(todayKey);

    const existing = await ReadingStreak.findOne({ userId }).lean();

    // idempotent check-in (tap twice does nothing)
    if (existing?.lastCheckInDate === todayKey) {
      return res.json({
        streak: {
          currentStreak: existing.currentStreak || 0,
          bestStreak: existing.bestStreak || 0,
          lastCheckInDate: existing.lastCheckInDate || null,
          checkedInToday: true,
          todayKey,
        },
      });
    }

    const nextStreak =
      existing?.lastCheckInDate === yesterdayKey
        ? (existing?.currentStreak || 0) + 1
        : 1;

    const nextBest = Math.max(existing?.bestStreak || 0, nextStreak);

    const updated = await ReadingStreak.findOneAndUpdate(
      { userId },
      {
        $set: {
          lastCheckInDate: todayKey,
          currentStreak: nextStreak,
          bestStreak: nextBest,
        },
      },
      { upsert: true, new: true }
    ).lean();

    return res.json({
      streak: {
        currentStreak: updated?.currentStreak ?? nextStreak,
        bestStreak: updated?.bestStreak ?? nextBest,
        lastCheckInDate: updated?.lastCheckInDate ?? todayKey,
        checkedInToday: true,
        todayKey,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to check in" });
  }
});

/**
 * POST /api/miniapp/books
 * body: { title, author?, status, shortSummary?, totalPages?, currentPage? }
 */
router.post("/", async (req: any, res) => {
  try {
    const userId = req.userId as number;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const title = String(req.body?.title || "").trim();
    const author = String(req.body?.author || "").trim();
    const shortSummary = clampShortSummary(req.body?.shortSummary);
    const status = normalizeStatus(req.body?.status);
    const rating = clampRating(req.body?.rating);

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
      shortSummary,
      status,
      totalPages,
      currentPage,
      rating,
    });

    // Ensure response has `id` even if client expects `book.id`
    const obj: any = created.toObject();
    return res.json({ book: { ...obj, id: String(obj._id) } });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to create book" });
  }
});

/**
 * POST /api/miniapp/books/recs
 * body: { genre: string }
 *
 * Returns: { recs: [{ title, author, summary }] }
 * Uses Google Books search by subject + optional keyword boost.
 */
router.post("/recs", async (req: any, res) => {
console.log("🎯 /recs route HIT", {
    userId: req.userId,
    genre: req.body?.genre,
    headers: req.headers,
  });
  try {
    const userId = req.userId as number;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const genreRaw = String(req.body?.genre || "").trim();
    if (!genreRaw) return res.status(400).json({ error: "Genre is required" });

    // Keep it simple & safe
    const genre = genreRaw.slice(0, 60);

    // Google Books "subject:" is the easiest genre-ish recommender
    const q = `subject:${genre}`;

    const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(
      q
    )}&maxResults=12&printType=books&langRestrict=en`;

    const gbResp = await fetch(gbUrl);
    if (!gbResp.ok) {
      return res.status(500).json({ error: "Failed to fetch recommendations" });
    }

    const gb = await gbResp.json();
    const items = Array.isArray(gb?.items) ? gb.items : [];

    const recs = items
      .map((item: any) => {
        const info = item?.volumeInfo || {};
        const title = String(info?.title || "").trim();
        const author = Array.isArray(info?.authors) ? info.authors.join(", ") : "";
        const desc = typeof info?.description === "string" ? info.description.trim() : "";

        if (!title || !desc) return null;

        // keep it from being huge
        const summary = desc.length > 700 ? desc.slice(0, 700).trim() + "…" : desc;

        return { title, author, summary };
      })
      .filter(Boolean)
      .slice(0, 10);

    return res.json({ recs });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to fetch recommendations" });
  }
});

/**
 * PUT /api/miniapp/books/:id
 * body: { title, author?, status, shortSummary?, totalPages?, currentPage? }
 */
router.put("/:id", async (req: any, res) => {
  try {
    const userId = req.userId as number;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = String(req.params.id || "").trim();
    if (!id || id === "undefined" || id === "null") {
      return res.status(400).json({ error: "Missing id" });
    }

    const title = String(req.body?.title || "").trim();
    const author = String(req.body?.author || "").trim();
    const shortSummary = clampShortSummary(req.body?.shortSummary);
    const status = normalizeStatus(req.body?.status);

    if (!title) return res.status(400).json({ error: "Title is required" });
    if (!status) return res.status(400).json({ error: "Invalid status" });

    let totalPages = toIntOrNull(req.body?.totalPages);
    let currentPage = toIntOrNull(req.body?.currentPage);

    const prog = normalizeProgress(status, totalPages, currentPage);
    totalPages = prog.totalPages;
    currentPage = prog.currentPage;

    // ✅ Only apply rating if it was actually provided
    const hasRating = Object.prototype.hasOwnProperty.call(req.body, "rating");
    const update: any = { title, author, shortSummary, status, totalPages, currentPage };

    if (hasRating) {
      update.rating = clampRating(req.body.rating) ?? 0;
    }

    const updated = await Book.findOneAndUpdate(
      { _id: id, userId },
      update,
      { new: true, runValidators: true }
    ).lean();

    if (!updated) return res.status(404).json({ error: "Book not found" });

    return res.json({ book: withId(updated) });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to update book" });
  }
});

/**
 * PATCH /api/miniapp/books/:id/rating
 * body: { rating: 0..5 }
 *
 * Updates ONLY the rating. 0 clears.
 */
router.patch("/:id/rating", async (req: any, res) => {
  try {
    const userId = req.userId as number;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = String(req.params.id || "").trim();
    if (!id || id === "undefined" || id === "null") {
      return res.status(400).json({ error: "Missing id" });
    }
    
        console.log("⭐ BOOK RATING PATCH HIT", {
      paramsId: req.params.id,
      parsedId: id,
      body: req.body,
      userId,
    });

    // ✅ Require the rating field
    if (req.body?.rating === undefined) {
      return res.status(400).json({ error: "Missing rating" });
    }

    const rating = clampRating(req.body.rating);

    const updated = await Book.findOneAndUpdate(
      { _id: id, userId },
      { $set: { rating } },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ error: "Book not found" });

    return res.json({ book: withId(updated) });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to update rating" });
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
    if (!id || id === "undefined" || id === "null") {
      return res.status(400).json({ error: "Missing id" });
    }

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
      return rawAuthor ? t * 0.7 + a * 0.3 : t;
    };

    const PASS_THRESHOLD = rawAuthor ? 0.25 : 0.35;
    const MIN_AUTHOR_IF_PROVIDED = rawAuthor ? 0.05 : 0;

    console.log("📚 Search input:", { rawTitle, rawAuthor });

    // ---------- 1) Google Books ----------
    try {
      let q = rawTitle;
      if (rawAuthor) q = `${rawTitle} ${rawAuthor}`;

      const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(
        q
      )}&maxResults=20&printType=books&langRestrict=en`;

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
          const snippet =
            typeof item?.searchInfo?.textSnippet === "string"
              ? item.searchInfo.textSnippet.trim()
              : "";
          const summary = desc || snippet;

          console.log({
            candidate: candTitle,
            author: candAuthors,
            titleScore: tScore.toFixed(3),
            authorScore: aScore.toFixed(3),
            totalScore: s.toFixed(3),
            threshold: PASS_THRESHOLD,
            hasSummary: !!summary,
            passes: s >= PASS_THRESHOLD && !!summary,
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
      let q = rawTitle;
      if (rawAuthor) q = `${rawTitle} ${rawAuthor}`;

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
            const candAuthor = Array.isArray(doc?.author_name)
              ? String(doc.author_name[0] || "").trim()
              : "";
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
              key,
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
          console.log(
            `❌ Best match score ${scored[0].s.toFixed(3)} below threshold ${PASS_THRESHOLD}`
          );
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