import {
  StoreGetProductTypesParams,
  StoreProductTypesListRes,
} from "@medusajs/medusa"
import qs from "qs"
import { ResponsePromise } from "../typings"
import BaseResource from "./base"

class ProductTypesResource extends BaseResource {
  /**
   * @description Retrieves a list of product types
   * @param {StoreGetProductTypesParams} query is optional. Can contain a limit and offset for the returned list
   * @return {ResponsePromise<StoreProductTypesListRes>}
   */
  list(
    query?: StoreGetProductTypesParams
  ): ResponsePromise<StoreProductTypesListRes> {
    let path = `/store/product-types`

    if (query) {
      const queryString = qs.stringify(query)
      path = `/store/product-types?${queryString}`
    }

    return this.client.request("GET", path)
  }
}

export default ProductTypesResource
