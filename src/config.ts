import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  botToken: requireEnv("BOT_TOKEN"),
  mongoUri: requireEnv("MONGODB_URI"),
  env: process.env.NODE_ENV ?? "development",
};
