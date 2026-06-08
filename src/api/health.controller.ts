import { Controller, Get, Inject } from "@nestjs/common";
import type Database from "better-sqlite3";
import { API_PREFIX } from "./constants.js";
import { DB_PROVIDER } from "./providers.js";
import { getLastIndexedBlock, getChainHeadBlock } from "../db/state.js";

const HEALTHY_LAG_THRESHOLD = 50;
const DEGRADED_LAG_THRESHOLD = 500;

@Controller(API_PREFIX)
export class HealthController {
  private readonly startTime = Date.now();

  constructor(@Inject(DB_PROVIDER) private readonly db: Database.Database) {}

  @Get("/health")
  health() {
    const lastIndexedBlock = getLastIndexedBlock(this.db) ?? 0;
    const chainHeadBlock = getChainHeadBlock(this.db) ?? 0;
    const lag = chainHeadBlock - lastIndexedBlock;

    const status =
      lag < HEALTHY_LAG_THRESHOLD
        ? "healthy"
        : lag <= DEGRADED_LAG_THRESHOLD
          ? "degraded"
          : "unhealthy";

    return {
      status,
      last_indexed_block: lastIndexedBlock,
      chain_head_block: chainHeadBlock,
      lag,
      uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }
}
