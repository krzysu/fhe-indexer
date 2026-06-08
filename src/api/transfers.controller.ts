import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { API_PREFIX } from "./constants.js";
import { DB_PROVIDER } from "./providers.js";
import type { Db } from "../db/connection.js";
import { getAllTransfers, getTransfersByAddress } from "../db/transfers.js";
import type { TransferRow } from "../db/transfers.js";

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MIN_PAGE = 1;
const MIN_LIMIT = 1;

@Controller(API_PREFIX)
export class TransfersController {
  constructor(@Inject(DB_PROVIDER) private readonly db: Db) {}

  @Get("/transfers")
  getAll(
    @Query("page") page = String(DEFAULT_PAGE),
    @Query("limit") limit = String(DEFAULT_LIMIT),
  ) {
    const pageNum = Math.max(MIN_PAGE, Number(page) || DEFAULT_PAGE);
    const limitNum = Math.min(
      MAX_LIMIT,
      Math.max(MIN_LIMIT, Number(limit) || DEFAULT_LIMIT),
    );

    const { rows, total } = getAllTransfers(this.db, pageNum, limitNum);

    return transfersResponse(rows, pageNum, limitNum, total);
  }

  @Get("/transfers/:address")
  getByAddress(
    @Param("address") address: string,
    @Query("page") page = String(DEFAULT_PAGE),
    @Query("limit") limit = String(DEFAULT_LIMIT),
  ) {
    const pageNum = Math.max(MIN_PAGE, Number(page) || DEFAULT_PAGE);
    const limitNum = Math.min(
      MAX_LIMIT,
      Math.max(MIN_LIMIT, Number(limit) || DEFAULT_LIMIT),
    );

    const { rows, total } = getTransfersByAddress(
      this.db,
      address,
      pageNum,
      limitNum,
    );

    return transfersResponse(rows, pageNum, limitNum, total);
  }
}

function transfersResponse(
  rows: TransferRow[],
  page: number,
  limit: number,
  total: number,
) {
  return {
    data: rows.map((r) => ({
      txHash: r.tx_hash,
      blockNumber: r.block_number,
      timestamp: r.block_timestamp,
      eventType: r.event_type,
      from: r.from_address,
      to: r.to_address,
      amount: r.cleartext_amount?.toString() ?? null,
      decryptStatus: r.decrypt_status,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}
