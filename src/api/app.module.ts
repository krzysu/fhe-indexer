import { type DynamicModule, Module } from "@nestjs/common";
import type { Db } from "../db/connection.js";
import { DB_PROVIDER } from "./providers.js";
import { HealthController } from "./health.controller.js";
import { TransfersController } from "./transfers.controller.js";
import { AdminController } from "./admin.controller.js";
import { BalanceController } from "./balance.controller.js";

@Module({})
export class AppModule {
  static forRoot(db: Db): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        TransfersController,
        AdminController,
        BalanceController,
      ],
      providers: [{ provide: DB_PROVIDER, useValue: db }],
    };
  }
}
