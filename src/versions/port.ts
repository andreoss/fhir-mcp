import { Context } from "effect"
import type { VersionModel } from "./version.js"

export class Catalog extends Context.Tag("Catalog")<
  Catalog,
  ReadonlyArray<VersionModel>
>() {}
