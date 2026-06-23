import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.AI_VISIBILITY_SCORE_SERVICE_DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "[ai-visibility-score-service] AI_VISIBILITY_SCORE_SERVICE_DATABASE_URL is required",
  );
}

// idle_timeout drops idle connections (30s) well before Neon's scale-to-zero suspend
// (~300s), so we never write a query onto a socket Neon already closed server-side
// (the `write CONNECTION_CLOSED` failure mode). connect_timeout gives the compute room
// to resume from a suspended state (~1-7s) on the first query after idle.
const client = postgres(connectionString, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 30,
});
export const db = drizzle(client, { schema });
export { client };
