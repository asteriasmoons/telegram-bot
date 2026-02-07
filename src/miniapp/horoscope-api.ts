import { Router } from "express";

const router = Router();

const VALID_ZODIAC = new Set([
  "aries",
  "taurus",
  "gemini",
  "cancer",
  "leo",
  "virgo",
  "libra",
  "scorpio",
  "sagittarius",
  "capricorn",
  "aquarius",
  "pisces",
]);

// GET /api/horoscope/horoscope?zodiac=aries
router.get("/horoscope", async (req, res) => {
  try {
    const zodiac = String(req.query.zodiac || "").toLowerCase().trim();

    if (!VALID_ZODIAC.has(zodiac)) {
      return res.status(400).json({ error: "Invalid zodiac" });
    }

    const apiKey = process.env.API_NINJAS_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing API key" });
    }

    const url = `https://api.api-ninjas.com/v1/horoscope/?zodiac=${encodeURIComponent(zodiac)}`;

    const response = await fetch(url, {
      headers: {
        "X-Api-Key": apiKey,
      },
    });

    if (!response.ok) {
      return res.status(502).json({ error: "Provider error" });
    }

    const data = await response.json();
    res.json({ horoscope: data });

  } catch (err) {
    console.error("Horoscope API error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;