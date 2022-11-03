import {
  ITaxCalculationStrategy,
  TaxCalculationContext,
  TransactionBaseService,
} from "../interfaces"
import { EntityManager } from "typeorm"
import {
  Discount,
  DiscountRuleType,
  GiftCard,
  LineItem,
  LineItemTaxLine,
  Region,
  ShippingMethod,
  ShippingMethodTaxLine,
} from "../models"
import { TaxProviderService, TotalsService } from "./index"
import { LineAllocationsMap } from "../types/totals"
import TaxInclusivePricingFeatureFlag from "../loaders/feature-flags/tax-inclusive-pricing"
import { FlagRouter } from "../utils/flag-router"
import { calculatePriceTaxAmount, isDefined } from "../utils"
import { MedusaError } from "medusa-core-utils"

type LineItemTotals = {
  unit_price: number
  quantity: number
  subtotal: number
  tax_total: number
  total: number
  original_total: number
  original_tax_total: number
  tax_lines: LineItemTaxLine[]
  discount_total: number
}

type ShippingMethodTotals = {
  price: number
  tax_total: number
  total: number
  subtotal: number
  original_total: number
  original_tax_total: number
  tax_lines: ShippingMethodTaxLine[]
}

type InjectedDependencies = {
  totalsService: TotalsService
  taxProviderService: TaxProviderService
  taxCalculationStrategy: ITaxCalculationStrategy
  featureFlagRouter: FlagRouter
}

export default class TotalsNewService extends TransactionBaseService {
  protected readonly manager_: EntityManager
  protected readonly transactionManager_: EntityManager | undefined

  protected readonly totalsService_: TotalsService
  protected readonly taxProviderService_: TaxProviderService
  protected readonly featureFlagRouter_: FlagRouter
  protected readonly taxCalculationStrategy_: ITaxCalculationStrategy

  constructor({
    totalsService,
    taxProviderService,
    featureFlagRouter,
    taxCalculationStrategy,
  }: InjectedDependencies) {
    super(arguments[0])

    this.totalsService_ = totalsService
    this.taxProviderService_ = taxProviderService
    this.featureFlagRouter_ = featureFlagRouter
    this.taxCalculationStrategy_ = taxCalculationStrategy
  }

  /**
   * Calcul and return the items totals for either the legacy calculation or the new calculation
   * @param items
   * @param includeTax
   * @param calculationContext
   * @param taxRate
   * @param useExistingTaxLines Force to use the tax lines of the line item instead of fetching them
   */
  async getLineItemsTotals(
    items: LineItem[],
    {
      includeTax,
      calculationContext,
      taxRate,
      useExistingTaxLines,
    }: {
      includeTax?: boolean
      calculationContext: TaxCalculationContext
      taxRate?: number | null
      useExistingTaxLines?: boolean
    }
  ): Promise<{ [lineItemId: string]: LineItemTotals }> {
    const manager = this.transactionManager_ ?? this.manager_
    let lineItemsTaxLinesMap: { [lineItemId: string]: LineItemTaxLine[] } = {}

    if (!taxRate && includeTax) {
      if (useExistingTaxLines) {
        items.forEach((item) => {
          lineItemsTaxLinesMap[item.id] = item.tax_lines ?? []
        })
      } else if (items.length) {
        const { lineItemsTaxLines } = await this.taxProviderService_
          .withTransaction(manager)
          .getTaxLinesMap(items, calculationContext)
        lineItemsTaxLinesMap = lineItemsTaxLines
      }
    }

    const calculationMethod = taxRate
      ? this.getLineItemTotalsLegacy.bind(this)
      : this.getLineItemTotals.bind(this)

    const itemsTotals: { [lineItemId: string]: LineItemTotals } = {}
    for (const item of items) {
      const lineItemAllocation =
        calculationContext.allocation_map[item.id] || {}

      itemsTotals[item.id] = await calculationMethod(item, {
        taxRate,
        lineItemAllocation,
        taxLines: lineItemsTaxLinesMap[item.id],
        calculationContext,
      })
    }

    return itemsTotals
  }

  /**
   * Calcul and return the totals for an item
   * @param item
   * @param includeTax
   * @param lineItemAllocation
   * @param taxLines Only needed to force the usage of the specified tax lines, often in the case where the item does not hold the tax lines
   * @param calculationContext
   */
  async getLineItemTotals(
    item: LineItem,
    {
      includeTax,
      lineItemAllocation,
      taxLines,
      calculationContext,
    }: {
      includeTax?: boolean
      lineItemAllocation: LineAllocationsMap[number]
      taxLines?: (LineItemTaxLine | ShippingMethodTaxLine)[]
      calculationContext: TaxCalculationContext
    }
  ): Promise<LineItemTotals> {
    let subtotal = item.unit_price * item.quantity
    if (
      this.featureFlagRouter_.isFeatureEnabled(
        TaxInclusivePricingFeatureFlag.key
      ) &&
      item.includes_tax
    ) {
      subtotal = 0 // in that case we need to know the tax rate to compute it later
    }

    const discount_total =
      (lineItemAllocation.discount?.unit_amount || 0) * item.quantity

    const totals: LineItemTotals = {
      unit_price: item.unit_price,
      quantity: item.quantity,
      subtotal,
      discount_total,
      total: subtotal - discount_total,
      original_total: subtotal,
      original_tax_total: 0,
      tax_total: 0,
      tax_lines: (taxLines ?? item.tax_lines ?? []) as LineItemTaxLine[],
    }

    // Force the tax lines to exist anyway
    if (includeTax && !totals.tax_lines.length) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Tax Lines must be joined to calculate taxes"
      )
    }

    if (totals.tax_lines.length > 0) {
      totals.tax_total = await this.taxCalculationStrategy_.calculate(
        [item],
        totals.tax_lines,
        calculationContext
      )
      const noDiscountContext = {
        ...calculationContext,
        allocation_map: {}, // Don't account for discounts
      }

      totals.original_tax_total = await this.taxCalculationStrategy_.calculate(
        [item],
        totals.tax_lines,
        noDiscountContext
      )

      if (
        this.featureFlagRouter_.isFeatureEnabled(
          TaxInclusivePricingFeatureFlag.key
        ) &&
        item.includes_tax
      ) {
        totals.subtotal +=
          totals.unit_price * totals.quantity - totals.original_tax_total
        totals.total += totals.subtotal
        totals.original_total += totals.subtotal
      }

      totals.total += totals.tax_total
      totals.original_total += totals.original_tax_total
    }

    return totals
  }

  /**
   * Calcul and return the legacy calculated totals using the tax rate
   * @param item
   * @param taxRate
   * @param lineItemAllocation
   * @param calculationContext
   */
  async getLineItemTotalsLegacy(
    item: LineItem,
    {
      taxRate,
      lineItemAllocation,
      calculationContext,
    }: {
      lineItemAllocation: LineAllocationsMap[number]
      calculationContext: TaxCalculationContext
      taxRate: number
    }
  ): Promise<LineItemTotals> {
    let subtotal = item.unit_price * item.quantity
    if (
      this.featureFlagRouter_.isFeatureEnabled(
        TaxInclusivePricingFeatureFlag.key
      ) &&
      item.includes_tax
    ) {
      subtotal = 0 // in that case we need to know the tax rate to compute it later
    }

    const discount_total =
      (lineItemAllocation.discount?.unit_amount || 0) * item.quantity

    const totals: LineItemTotals = {
      unit_price: item.unit_price,
      quantity: item.quantity,
      subtotal,
      discount_total,
      total: subtotal - discount_total,
      original_total: subtotal,
      original_tax_total: 0,
      tax_total: 0,
      tax_lines: item.tax_lines,
    }

    taxRate = taxRate / 100

    const includesTax =
      this.featureFlagRouter_.isFeatureEnabled(
        TaxInclusivePricingFeatureFlag.key
      ) && item.includes_tax
    const taxIncludedInPrice = !item.includes_tax
      ? 0
      : Math.round(
          calculatePriceTaxAmount({
            price: item.unit_price,
            taxRate: taxRate,
            includesTax,
          })
        )
    totals.subtotal = (item.unit_price - taxIncludedInPrice) * item.quantity
    totals.total = totals.subtotal

    totals.original_tax_total = totals.subtotal * taxRate
    totals.tax_total = (totals.subtotal - discount_total) * taxRate

    totals.total += totals.tax_total
    totals.original_total += totals.original_tax_total

    return totals
  }

  /**
   * Return the amount that can be refund on a line item
   * @param lineItem
   * @param calculationContext
   * @param taxRate
   */
  getLineItemRefund(
    lineItem: {
      id: string
      unit_price: number
      includes_tax: boolean
      quantity: number
      tax_lines: LineItemTaxLine[]
    },
    {
      calculationContext,
      taxRate,
    }: { calculationContext: TaxCalculationContext; taxRate?: number | null }
  ): number {
    /*
     * Used for backcompat with old tax system
     */
    if (taxRate != null) {
      return this.getLineItemRefundLegacy(lineItem, {
        calculationContext,
        taxRate,
      })
    }

    const includesTax =
      this.featureFlagRouter_.isFeatureEnabled(
        TaxInclusivePricingFeatureFlag.key
      ) && lineItem.includes_tax

    const discountAmount =
      (calculationContext.allocation_map[lineItem.id]?.discount?.unit_amount ||
        0) * lineItem.quantity

    if (!isDefined(lineItem.tax_lines)) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Cannot compute line item refund amount, tax lines are missing from the line item"
      )
    }

    const totalTaxRate = lineItem.tax_lines.reduce((acc, next) => {
      return acc + next.rate / 100
    }, 0)

    const taxAmountIncludedInPrice = !includesTax
      ? 0
      : Math.round(
          calculatePriceTaxAmount({
            price: lineItem.unit_price,
            taxRate: totalTaxRate,
            includesTax,
          })
        )

    const lineSubtotal =
      (lineItem.unit_price - taxAmountIncludedInPrice) * lineItem.quantity -
      discountAmount

    const taxTotal = lineItem.tax_lines.reduce((acc, next) => {
      return acc + Math.round(lineSubtotal * (next.rate / 100))
    }, 0)

    return lineSubtotal + taxTotal
  }

  /**
   * Calcul and return the gift cards totals
   * @param giftCardableAmount
   * @param giftCardTransactions
   * @param region
   * @param giftCards
   */
  async getGiftCardTotals(
    giftCardableAmount: number,
    {
      giftCardTransactions,
      region,
      giftCards,
    }: {
      region: Region
      giftCardTransactions?: {
        tax_rate: number
        is_taxable: boolean
        amount: number
      }[]
      giftCards?: GiftCard[]
    }
  ): Promise<{
    total: number
    tax_total: number
  }> {
    if (giftCardTransactions) {
      return this.getGiftCardTransactionsTotals({
        giftCardTransactions,
        region,
      })
    }

    const result = {
      total: 0,
      tax_total: 0,
    }

    if (!giftCards?.length) {
      return result
    }

    const giftAmount = giftCards.reduce((acc, next) => acc + next.balance, 0)
    result.total = Math.min(giftCardableAmount, giftAmount)

    if (region?.gift_cards_taxable) {
      result.tax_total = Math.round((result.total * region.tax_rate) / 100)
      return result
    }

    return result
  }

  /**
   * Calcul and return the gift cards totals based on their transactions
   * @param gift_card_transactions
   * @param region
   */
  getGiftCardTransactionsTotals({
    giftCardTransactions,
    region,
  }: {
    giftCardTransactions: {
      tax_rate: number
      is_taxable: boolean
      amount: number
    }[]
    region: { gift_cards_taxable: boolean; tax_rate: number }
  }): { total: number; tax_total: number } {
    return giftCardTransactions.reduce(
      (acc, next) => {
        let taxMultiplier = (next.tax_rate || 0) / 100

        // Previously we did not record whether a gift card was taxable or not.
        // All gift cards where is_taxable === null are from the old system,
        // where we defaulted to taxable gift cards.
        //
        // This is a backwards compatability fix for orders that were created
        // before we added the gift card tax rate.
        if (next.is_taxable === null && region?.gift_cards_taxable) {
          taxMultiplier = region.tax_rate / 100
        }

        return {
          total: acc.total + next.amount,
          tax_total: acc.tax_total + next.amount * taxMultiplier,
        }
      },
      {
        total: 0,
        tax_total: 0,
      }
    )
  }

  /**
   * Calcul and return the shipping methods totals for either the legacy calculation or the new calculation
   * @param shippingMethods
   * @param includeTax
   * @param discounts
   * @param taxRate
   * @param calculationContext
   * @param useExistingTaxLines Force to use the tax lines of the shipping method instead of fetching them
   */
  async getShippingMethodsTotals(
    shippingMethods: ShippingMethod[],
    {
      includeTax,
      discounts,
      taxRate,
      calculationContext,
      useExistingTaxLines,
    }: {
      includeTax?: boolean
      calculationContext: TaxCalculationContext
      discounts?: Discount[]
      taxRate?: number | null
      useExistingTaxLines?: boolean
    }
  ): Promise<{ [lineItemId: string]: ShippingMethodTotals }> {
    const manager = this.transactionManager_ ?? this.manager_
    let shippingMethodsTaxLinesMap: {
      [shippingMethodId: string]: ShippingMethodTaxLine[]
    } = {}

    if (!taxRate && includeTax) {
      if (useExistingTaxLines) {
        shippingMethods.forEach((sm) => {
          shippingMethodsTaxLinesMap[sm.id] = sm.tax_lines ?? []
        })
      } else if (shippingMethods.length) {
        const { shippingMethodsTaxLines } = await this.taxProviderService_
          .withTransaction(manager)
          .getTaxLinesMap([], calculationContext)
        shippingMethodsTaxLinesMap = shippingMethodsTaxLines
      }
    }

    const calculationMethod = taxRate
      ? this.getShippingMethodTotalsLegacy.bind(this)
      : this.getShippingMethodTotals.bind(this)

    const shippingMethodsTotals: {
      [lineItemId: string]: ShippingMethodTotals
    } = {}
    for (const shippingMethod of shippingMethods) {
      shippingMethodsTotals[shippingMethod.id] = await calculationMethod(
        shippingMethod,
        {
          includeTax,
          calculationContext,
          taxLines: shippingMethodsTaxLinesMap[shippingMethod.id],
          discounts,
        }
      )
    }

    return shippingMethodsTotals
  }

  /**
   * Calcul and return the shipping method totals
   * @param shippingMethod
   * @param includeTax
   * @param calculationContext
   * @param taxLines
   * @param discounts
   */
  async getShippingMethodTotals(
    shippingMethod: ShippingMethod,
    {
      includeTax,
      calculationContext,
      taxLines,
      discounts,
    }: {
      includeTax?: boolean
      calculationContext: TaxCalculationContext
      taxLines?: (ShippingMethodTaxLine | LineItemTaxLine)[]
      discounts?: Discount[]
    }
  ) {
    const totals: ShippingMethodTotals = {
      price: shippingMethod.price,
      original_total: shippingMethod.price,
      total: shippingMethod.price,
      subtotal: shippingMethod.price,
      original_tax_total: 0,
      tax_total: 0,
      tax_lines: (taxLines ??
        shippingMethod.tax_lines ??
        []) as ShippingMethodTaxLine[],
    }

    const calculationContext_: TaxCalculationContext = {
      ...calculationContext,
      shipping_methods: [shippingMethod],
    }

    // Force the tax lines to exist anyway
    if (includeTax && !totals.tax_lines.length) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Tax Lines must be joined to calculate taxes"
      )
    }

    const includesTax =
      this.featureFlagRouter_.isFeatureEnabled(
        TaxInclusivePricingFeatureFlag.key
      ) && shippingMethod.includes_tax

    totals.original_tax_total = await this.taxCalculationStrategy_.calculate(
      [],
      totals.tax_lines,
      calculationContext_
    )
    totals.tax_total = totals.original_tax_total

    if (includesTax) {
      totals.subtotal -= totals.tax_total
    } else {
      totals.original_total += totals.original_tax_total
      totals.total += totals.tax_total
    }

    const hasFreeShipping = discounts?.some(
      (d) => d.rule.type === DiscountRuleType.FREE_SHIPPING
    )

    if (hasFreeShipping) {
      totals.total = 0
      totals.subtotal = 0
      totals.tax_total = 0
    }

    return totals
  }

  /**
   * Calcul and return the shipping method totals legacy using teh tax rate
   * @param shippingMethod
   * @param calculationContext
   * @param taxLines
   * @param discounts
   */
  async getShippingMethodTotalsLegacy(
    shippingMethod: ShippingMethod,
    {
      calculationContext,
      discounts,
      taxRate,
    }: {
      calculationContext: TaxCalculationContext
      discounts?: Discount[]
      taxRate: number
    }
  ): Promise<ShippingMethodTotals> {
    const totals: ShippingMethodTotals = {
      price: shippingMethod.price,
      original_total: shippingMethod.price,
      total: shippingMethod.price,
      subtotal: shippingMethod.price,
      original_tax_total: 0,
      tax_total: 0,
      tax_lines: shippingMethod.tax_lines,
    }

    totals.original_tax_total = Math.round(totals.price * (taxRate / 100))
    totals.tax_total = Math.round(totals.price * (taxRate / 100))

    return totals
  }

  /**
   * @param lineItem
   * @param calculationContext
   * @param taxRate
   * @protected
   */
  getLineItemRefundLegacy(
    lineItem: {
      id: string
      unit_price: number
      includes_tax: boolean
      quantity: number
    },
    {
      calculationContext,
      taxRate,
    }: { calculationContext: TaxCalculationContext; taxRate: number }
  ): number {
    const includesTax =
      this.featureFlagRouter_.isFeatureEnabled(
        TaxInclusivePricingFeatureFlag.key
      ) && lineItem.includes_tax

    const taxAmountIncludedInPrice = !includesTax
      ? 0
      : Math.round(
          calculatePriceTaxAmount({
            price: lineItem.unit_price,
            taxRate: taxRate / 100,
            includesTax,
          })
        )

    const discountAmount =
      (calculationContext.allocation_map[lineItem.id]?.discount?.unit_amount ||
        0) * lineItem.quantity

    const lineSubtotal =
      (lineItem.unit_price - taxAmountIncludedInPrice) * lineItem.quantity -
      discountAmount

    return Math.round(lineSubtotal * (1 + taxRate / 100))
  }
}
