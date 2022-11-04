import { Router } from "express"
import "reflect-metadata"
import { Product, ProductType } from "../../../.."
import { PaginatedResponse } from "../../../../types/common"
import middlewares from "../../../middlewares"

const route = Router()

export default (app) => {
  app.use("/products", route)

  route.get("/", middlewares.wrap(require("./list-products").default))
  route.post("/search", middlewares.wrap(require("./search").default))
  route.get("/types", middlewares.wrap(require("./list-types").default))
  route.get("/:id", middlewares.wrap(require("./get-product").default))

  return app
}

export const defaultStoreProductsRelations = [
  "variants",
  "variants.prices",
  "variants.options",
  "options",
  "options.values",
  "images",
  "tags",
  "collection",
  "type",
]

export * from "./list-products"
export * from "./list-types"
export * from "./search"

export type StoreProductsRes = {
  product: Product
}

export type StorePostSearchRes = {
  hits: unknown[]
  [k: string]: unknown
}

export type StoreProductsListRes = PaginatedResponse & {
  products: Product[]
}

export type StoreProductsListTypesRes = {
  types: ProductType[]
}
