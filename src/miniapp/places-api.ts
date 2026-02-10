// src/miniapp/places-api.ts
import { Router, Request, Response } from "express";

const router = Router();

const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY || "";

// POST /api/miniapp/places/autocomplete
router.post("/autocomplete", async (req: Request, res: Response) => {
  try {
    const { input, sessionToken } = req.body;

    if (!input || typeof input !== "string" || !input.trim()) {
      return res.status(400).json({ error: "input is required" });
    }

    if (!GOOGLE_API_KEY) {
      return res.status(500).json({ error: "Google Places API key not configured" });
    }

    const url = "https://places.googleapis.com/v1/places:autocomplete";

    const body: any = {
      input: input.trim(),
      languageCode: "en",
    };

    if (sessionToken) {
      body.sessionToken = sessionToken;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_API_KEY,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Places autocomplete error:", response.status, text);
      return res.status(response.status).json({ error: "Google API error", detail: text });
    }

    const data = await response.json();

    const suggestions = (data.suggestions || [])
      .filter((s: any) => s.placePrediction)
      .map((s: any) => ({
        placeId: s.placePrediction.placeId,
        text: s.placePrediction.text?.text || "",
        mainText: s.placePrediction.structuredFormat?.mainText?.text || "",
        secondaryText: s.placePrediction.structuredFormat?.secondaryText?.text || "",
      }));

    return res.json({ suggestions });
  } catch (err: any) {
    console.error("Places autocomplete error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

// POST /api/miniapp/places/details
router.post("/details", async (req: Request, res: Response) => {
  try {
    const { placeId, sessionToken } = req.body;

    if (!placeId || typeof placeId !== "string") {
      return res.status(400).json({ error: "placeId is required" });
    }

    if (!GOOGLE_API_KEY) {
      return res.status(500).json({ error: "Google Places API key not configured" });
    }

    const fields = "displayName,formattedAddress,location,shortFormattedAddress";

    const url = `https://places.googleapis.com/v1/places/${placeId}?languageCode=en`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_API_KEY,
      "X-Goog-FieldMask": fields,
    };

    if (sessionToken) {
      headers["X-Goog-SessionToken"] = sessionToken;
    }

    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Places details error:", response.status, text);
      return res.status(response.status).json({ error: "Google API error", detail: text });
    }

    const data = await response.json();

    return res.json({
      place: {
        placeId,
        name: data.displayName?.text || "",
        address: data.formattedAddress || data.shortFormattedAddress || "",
        lat: data.location?.latitude ?? null,
        lng: data.location?.longitude ?? null,
      },
    });
  } catch (err: any) {
    console.error("Places details error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

export default router;
