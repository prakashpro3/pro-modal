// Load the .env into process.env. Honors ROUTER_ENV (set by the global CLI to
// point at ~/.automodel/.env); falls back to the default ./.env for `npm start`.
// Imported first in server.js as a side effect so vars exist before config loads.
import dotenv from "dotenv";
dotenv.config(process.env.ROUTER_ENV ? { path: process.env.ROUTER_ENV } : {});
