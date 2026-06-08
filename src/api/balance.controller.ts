import { Controller, Get, Inject, Param } from "@nestjs/common";
import { API_PREFIX } from "./constants.js";
import { DB_PROVIDER } from "./providers.js";
import type { Db } from "../db/connection.js";
import { getBalance } from "../db/balances.js";
import { getTokenDecimals, getTokenSymbol } from "../db/state.js";

@Controller(API_PREFIX)
export class BalanceController {
  constructor(@Inject(DB_PROVIDER) private readonly db: Db) {}

  @Get("/balance/:address")
  getBalance(@Param("address") address: string) {
    const row = getBalance(this.db, address);

    return {
      address,
      balance: row?.cleartext_balance?.toString() ?? "0",
      status: row?.balance_status ?? "unknown",
      pendingTransfers: row?.pending_transfers_count ?? 0,
      decimals: getTokenDecimals(this.db),
      symbol: getTokenSymbol(this.db),
    };
  }
}
