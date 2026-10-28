/**
 * Structured JSON logger (pino) shared by the whole server.
 * Set LOG_LEVEL=debug to see extra detail (e.g. skipped LiveKit permission updates).
 */
import pino from "pino";

// `base: undefined` drops pid/hostname from every line to keep logs short.
export const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: undefined });
