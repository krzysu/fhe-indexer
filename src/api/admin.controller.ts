import { Controller, Inject, Post, Query } from "@nestjs/common";
import { API_PREFIX } from "./constants.js";
import { DB_PROVIDER } from "./providers.js";
import type { Db } from "../db/connection.js";
import {
  getNoRightsTransfers,
  resetTransfersToPending,
} from "../db/transfers.js";
import { enqueueDecryptJob } from "../db/queue.js";
import { getContractAddress } from "../db/state.js";

@Controller(API_PREFIX)
export class AdminController {
  constructor(@Inject(DB_PROVIDER) private readonly db: Db) {}

  @Post("/admin/retry-no-rights")
  retryNoRights(@Query("address") address?: string) {
    const contractAddress = getContractAddress(this.db);
    if (!contractAddress) {
      return { retried: 0, error: "contract address not set" };
    }

    const rows = getNoRightsTransfers(this.db, address);
    if (rows.length === 0) {
      return { retried: 0 };
    }

    const ids = rows.map((r) => r.id);
    resetTransfersToPending(this.db, ids);

    for (const row of rows) {
      enqueueDecryptJob(this.db, row.id, row.encrypted_handle, contractAddress);
    }

    return { retried: rows.length };
  }
}
