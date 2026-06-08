import { NestFactory } from "@nestjs/core";
import type { Db } from "../db/connection.js";
import { AppModule } from "./app.module.js";

export async function createNestServer(db: Db) {
  const app = await NestFactory.create(AppModule.forRoot(db));
  app.enableShutdownHooks();
  return app;
}
