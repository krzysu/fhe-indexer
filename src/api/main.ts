import { NestFactory } from "@nestjs/core";
import type Database from "better-sqlite3";
import { AppModule } from "./app.module.js";

export async function createNestServer(db: Database.Database) {
  const app = await NestFactory.create(AppModule.forRoot(db));
  app.enableShutdownHooks();
  return app;
}
