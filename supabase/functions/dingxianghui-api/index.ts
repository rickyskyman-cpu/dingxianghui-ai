/**
 * Deployable Edge Function for dingxianghui-api.
 * This file keeps the business routes from the last deployed build and applies
 * the security gates. It is not deployed by the change that added it.
 * Database credentials come from SUPABASE_DB_URL in the function environment.
 * Do not put that value in the repository.
 * All SQL is confined to schema dxh.
 */
import postgres from "npm:postgres@3.4.5";
import { handle } from "./http.ts";
import { createSqlDb } from "./sql_db.ts";

const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
if (!databaseUrl) throw new Error("SUPABASE_DB_URL is required");
const sql = postgres(databaseUrl, { prepare: false, max: 3, idle_timeout: 20 });
const db = createSqlDb(sql);

Deno.serve((req) => handle(req, { db, env: Deno.env.toObject() }));
