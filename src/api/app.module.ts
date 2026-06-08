import { type DynamicModule, Module } from "@nestjs/common";
import type Database from "better-sqlite3";
import { DB_PROVIDER } from "./providers.js";
import { HealthController } from "./health.controller.js";
import { TransfersController } from "./transfers.controller.js";

@Module({})
export class AppModule {
  static forRoot(db: Database.Database): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, TransfersController],
      providers: [{ provide: DB_PROVIDER, useValue: db }],
    };
  }
}
