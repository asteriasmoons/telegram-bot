const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

function pickModel() {
  // You can override with env without touching code later
  return process.env.GROQ_MODEL || "llama-3.1-8b-instant";
}

export async function generateJournalPrompt(): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("Missing GROQ_API_KEY");

  const model = pickModel();

  const body = {
    model,
    temperature: 0.9,
    max_tokens: 120,
    messages: [
      {
        role: "system",
        content:
          "You generate journaling prompts. Return exactly one prompt. No title, no preface, no bullet list. Keep it 1–2 sentences, actionable, and emotionally safe.",
      },
      {
        role: "user",
        content:
          "Write one journaling prompt that helps the user reflect gently and clearly. Avoid trauma-heavy content, self-harm content, sexual content, or medical/legal advice.",
      },
    ],
  };

  const resp = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Groq error ${resp.status}: ${text || resp.statusText}`);
  }

  const json: any = await resp.json();
  const content = String(json?.choices?.[0]?.message?.content || "").trim();

  // Basic sanity cleanup
  return content.replace(/^["'\s]+|["'\s]+$/g, "").trim();
}