/**
 * open-nof1.ai - AI 加密货币自动交易系统
 * Binance USDT 永续合约 API 客户端封装
 */

import { createHmac } from "node:crypto";
import { createPinoLogger } from "@voltagent/logger";

type HttpMethod = "GET" | "POST" | "DELETE";

interface RequestOptions {
  signed?: boolean;
  recvWindow?: number;
  includeApiKey?: boolean;
}

interface ContractInfo {
  contract: string;
  symbol: string;
  orderSizeMin: number;
  orderSizeMax: number;
  stepSize: number;
  tickSize: number;
  quantoMultiplier: number;
  minNotional: number;
  pricePrecision: number;
  quantityPrecision: number;
  baseAsset: string;
  quoteAsset: string;
}

interface OrderSummary {
  id: string;
  status: "open" | "finished" | "cancelled";
  contract: string;
  size: string;
  left: string;
  price: string;
  fill_price?: string;
  executed_size?: string;
  clientOrderId?: string;
  reduceOnly?: boolean;
  side?: string;
  type?: string;
  timeInForce?: string;
  create_time?: number;
  update_time?: number;
}

const logger = createPinoLogger({
  name: "binance-client",
  level: "info",
});

const DEFAULT_STEP_SIZES: Record<string, number> = {
  BTC: 0.001,
  ETH: 0.01,
  SOL: 0.1,
  XRP: 1,
  BNB: 0.1,
  BCH: 0.01,
  DOGE: 100,
  ADA: 1,
};

function contractToSymbol(contract: string): string {
  if (!contract) return "";
  return contract.replace("_", "");
}

function symbolToContract(symbol: string): string {
  if (!symbol) return "";
  if (symbol.endsWith("USDT")) {
    return `${symbol.slice(0, -4)}_USDT`;
  }
  return symbol;
}

function precisionFromStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) {
    return 8;
  }
  const stepStr = step.toString();
  if (stepStr.includes("e-")) {
    const [, exponent] = stepStr.split("e-");
    return Number.parseInt(exponent, 10);
  }
  const dotIndex = stepStr.indexOf(".");
  if (dotIndex === -1) return 0;
  return stepStr.length - dotIndex - 1;
}

function formatNumber(value: number, precision: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const fixed = value.toFixed(Math.min(Math.max(precision, 0), 12));
  return fixed.replace(/\.?0+$/, "") || "0";
}

function floorToStep(value: number, step: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(step) || step <= 0) return value;
  const units = Math.floor((value + 1e-12) / step);
  return units * step;
}

function composeOrderId(symbol: string, orderId: number | string): string {
  return `${symbol}:${orderId}`;
}

function parseOrderId(id: string): { symbol: string; orderId: string } {
  if (!id) {
    throw new Error("Order id is required");
  }
  if (id.includes(":")) {
    const [symbol, orderId] = id.split(":");
    if (!symbol || !orderId) {
      throw new Error(`Invalid composite order id: ${id}`);
    }
    return { symbol, orderId };
  }
  throw new Error(
    `Binance order id must include symbol (expected format SYMBOL:orderId, received ${id})`
  );
}

function mapOrderStatus(status: string): "open" | "finished" | "cancelled" {
  switch (status) {
    case "FILLED":
      return "finished";
    case "CANCELED":
    case "REJECTED":
    case "EXPIRED":
      return "cancelled";
    case "PARTIALLY_FILLED":
    case "NEW":
    case "PENDING_CANCEL":
    default:
      return "open";
  }
}

function safeParseFloat(value: any, fallback = 0): number {
  const num =
    typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(num) ? num : fallback;
}

export class BinanceClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly contractInfoCache = new Map<string, ContractInfo>();

  constructor(apiKey: string, apiSecret: string, useTestnet: boolean) {
    if (!apiKey || !apiSecret) {
      throw new Error("Binance API key and secret are required");
    }

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = useTestnet
      ? "https://testnet.binancefuture.com"
      : "https://fapi.binance.com";

    logger.info(`Binance Futures client initialized (${useTestnet ? "testnet" : "mainnet"})`);
  }

  private async request<T>(
    method: HttpMethod,
    path: string,
    params: Record<string, string | number | undefined> = {},
    options: RequestOptions = {}
  ): Promise<T> {
    const filteredEntries = Object.entries(params).filter(
      ([, value]) => value !== undefined && value !== null && value !== ""
    );

    const searchParams = new URLSearchParams();
    for (const [key, value] of filteredEntries) {
      searchParams.append(key, String(value));
    }

    if (options.signed) {
      searchParams.append("timestamp", Date.now().toString());
      searchParams.append(
        "recvWindow",
        (options.recvWindow ?? 5000).toString()
      );
      const signature = createHmac("sha256", this.apiSecret)
        .update(searchParams.toString())
        .digest("hex");
      searchParams.append("signature", signature);
    }

    const headers: Record<string, string> = {};
    if (options.signed || options.includeApiKey) {
      headers["X-MBX-APIKEY"] = this.apiKey;
    }

    let url = `${this.baseUrl}${path}`;
    const init: RequestInit = { method, headers };

    if (method === "GET" || method === "DELETE") {
      const query = searchParams.toString();
      if (query) {
        url = `${url}?${query}`;
      }
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = searchParams.toString();
    }

    const response = await fetch(url, init);

    if (!response.ok) {
      let errorBody: any = null;
      try {
        errorBody = await response.json();
      } catch {
        // ignore
      }
      const message =
        errorBody?.msg ||
        errorBody?.message ||
        `Binance API error (${response.status} ${response.statusText})`;
      const err = new Error(message);
      (err as any).status = response.status;
      (err as any).body = errorBody;
      throw err;
    }

    return (await response.json()) as T;
  }

  private async getExchangeInfo(): Promise<Record<string, ContractInfo>> {
    if (this.contractInfoCache.size > 0) {
      return Object.fromEntries(
        Array.from(this.contractInfoCache.entries()).map(([contract, info]) => [
          contract,
          info,
        ])
      );
    }

    const data = await this.request<any>("GET", "/fapi/v1/exchangeInfo");

    for (const symbolInfo of data.symbols ?? []) {
      if (symbolInfo.contractType !== "PERPETUAL") continue;
      if (symbolInfo.quoteAsset !== "USDT") continue;

      const contract = symbolToContract(symbolInfo.symbol);
      const lotFilter = symbolInfo.filters.find(
        (f: any) => f.filterType === "LOT_SIZE"
      );
      const priceFilter = symbolInfo.filters.find(
        (f: any) => f.filterType === "PRICE_FILTER"
      );
      const notionalFilter = symbolInfo.filters.find(
        (f: any) => f.filterType === "MIN_NOTIONAL"
      );

      const stepSize = safeParseFloat(lotFilter?.stepSize, DEFAULT_STEP_SIZES[symbolInfo.baseAsset] || 0.001);
      const minQty = safeParseFloat(lotFilter?.minQty, stepSize);
      const maxQty = safeParseFloat(lotFilter?.maxQty, stepSize * 1000000);
      const tickSize = safeParseFloat(priceFilter?.tickSize, 0.01);
      const minNotional = safeParseFloat(notionalFilter?.notional, 5);

      const orderSizeMin = Math.max(1, Math.round(minQty / stepSize));
      const orderSizeMax = Math.max(orderSizeMin, Math.round(maxQty / stepSize));

      const info: ContractInfo = {
        contract,
        symbol: symbolInfo.symbol,
        orderSizeMin,
        orderSizeMax,
        stepSize,
        tickSize,
        quantoMultiplier: stepSize,
        minNotional,
        pricePrecision: symbolInfo.pricePrecision ?? precisionFromStep(tickSize),
        quantityPrecision:
          symbolInfo.quantityPrecision ?? precisionFromStep(stepSize),
        baseAsset: symbolInfo.baseAsset,
        quoteAsset: symbolInfo.quoteAsset,
      };

      this.contractInfoCache.set(contract, info);
    }

    return Object.fromEntries(this.contractInfoCache.entries());
  }

  private async ensureContractInfo(contract: string): Promise<ContractInfo> {
    if (this.contractInfoCache.has(contract)) {
      return this.contractInfoCache.get(contract)!;
    }
    await this.getExchangeInfo();
    const cached = this.contractInfoCache.get(contract);
    if (cached) {
      return cached;
    }
    const symbol = contractToSymbol(contract);
    const stepSize =
      DEFAULT_STEP_SIZES[contract.replace("_USDT", "")] || 0.001;

    const fallback: ContractInfo = {
      contract,
      symbol,
      orderSizeMin: 1,
      orderSizeMax: 1000000,
      stepSize,
      tickSize: 0.01,
      quantoMultiplier: stepSize,
      minNotional: 5,
      pricePrecision: precisionFromStep(0.01),
      quantityPrecision: precisionFromStep(stepSize),
      baseAsset: contract.replace("_USDT", ""),
      quoteAsset: "USDT",
    };

    this.contractInfoCache.set(contract, fallback);
    return fallback;
  }

  private quantityUnitsToString(units: number): string {
    const rounded = Math.round(units);
    return Number.isFinite(rounded) ? rounded.toString() : "0";
  }

  private async buildOrderSummary(
    resp: any,
    contract: string,
    info: ContractInfo
  ): Promise<OrderSummary> {
    const symbol = contractToSymbol(contract);
    const status = mapOrderStatus(resp.status);
    const origQty = safeParseFloat(resp.origQty);
    const executedQty = safeParseFloat(resp.executedQty);
    const remainingQty = Math.max(origQty - executedQty, 0);

    const sizeUnits = Math.round(origQty / info.stepSize);
    const executedUnits = Math.round(executedQty / info.stepSize);
    const remainingUnits = Math.max(sizeUnits - executedUnits, 0);

    return {
      id: composeOrderId(symbol, resp.orderId),
      status,
      contract,
      size: this.quantityUnitsToString(sizeUnits),
      left: this.quantityUnitsToString(remainingUnits),
      price: String(resp.price ?? "0"),
      fill_price: resp.avgPrice,
      executed_size: this.quantityUnitsToString(executedUnits),
      clientOrderId: resp.clientOrderId,
      reduceOnly: resp.reduceOnly ?? false,
      side: resp.side,
      type: resp.type,
      timeInForce: resp.timeInForce,
      create_time: resp.updateTime ?? resp.time,
      update_time: resp.updateTime ?? resp.time,
    };
  }

  async getFuturesTicker(contract: string) {
    const symbol = contractToSymbol(contract);
    try {
      const [price, premium] = await Promise.all([
        this.request<any>("GET", "/fapi/v1/ticker/price", { symbol }),
        this.request<any>("GET", "/fapi/v1/premiumIndex", { symbol }),
      ]);
      return {
        contract,
        last: price?.price ?? "0",
        markPrice: premium?.markPrice ?? price?.price ?? "0",
        indexPrice: premium?.indexPrice ?? "0",
        fundingRate: premium?.lastFundingRate ?? "0",
        time: premium?.time ?? Date.now(),
      };
    } catch (error) {
      logger.error(`获取 ${contract} 最新价格失败`, error as any);
      throw error;
    }
  }

  async getFuturesCandles(
    contract: string,
    interval: string = "5m",
    limit: number = 100
  ) {
    const symbol = contractToSymbol(contract);
    try {
      const data = await this.request<any[]>("GET", "/fapi/v1/klines", {
        symbol,
        interval,
        limit,
      });
      return data.map((item) => ({
        t: item[0],
        o: item[1],
        h: item[2],
        l: item[3],
        c: item[4],
        v: item[5],
        sum: item[7],
      }));
    } catch (error) {
      logger.error(`获取 ${contract} K线数据失败`, error as any);
      throw error;
    }
  }

  async getFuturesAccount() {
    try {
      const account = await this.request<any>(
        "GET",
        "/fapi/v2/account",
        {},
        { signed: true }
      );
      return {
        currency: "USDT",
        total: account.totalWalletBalance ?? "0",
        available: account.availableBalance ?? "0",
        positionMargin: account.totalPositionInitialMargin ?? account.totalCrossPositionInitialMargin ?? "0",
        orderMargin: account.totalOpenOrderInitialMargin ?? "0",
        unrealisedPnl: account.totalUnrealizedProfit ?? "0",
        realisedPnl: account.totalRealizedProfit ?? "0",
        marginBalance: account.totalMarginBalance ?? account.totalWalletBalance ?? "0",
        maxWithdrawAmount: account.maxWithdrawAmount ?? "0",
        assets: account.assets,
      };
    } catch (error) {
      logger.error("获取账户信息失败", error as any);
      throw error;
    }
  }

  async getPositions() {
    try {
      const positions = await this.request<any[]>(
        "GET",
        "/fapi/v2/positionRisk",
        {},
        { signed: true }
      );

      const results = [];
      for (const pos of positions) {
        if (pos.contractType && pos.contractType !== "PERPETUAL") continue;
        if (pos.marginType && pos.marginType !== "cross" && pos.marginType !== "isolated") {
          // still include
        }
        const contract = symbolToContract(pos.symbol);
        if (!contract.endsWith("_USDT")) continue;
        const info = await this.ensureContractInfo(contract);
        const positionAmt = safeParseFloat(pos.positionAmt, 0);
        const sizeUnits = Math.round(positionAmt / info.stepSize);

        results.push({
          contract,
          size: this.quantityUnitsToString(sizeUnits),
          entryPrice: pos.entryPrice ?? "0",
          markPrice: pos.markPrice ?? "0",
          leverage: pos.leverage ?? "1",
          liq_price: pos.liquidationPrice ?? "0",
          unrealisedPnl: pos.unRealizedProfit ?? "0",
          realisedPnl: pos.realizedProfit ?? "0",
          margin: pos.positionInitialMargin ?? "0",
          marginType: pos.marginType ?? "CROSSED",
          timestamp: pos.updateTime ?? Date.now(),
        });
      }
      return results;
    } catch (error) {
      logger.error("获取持仓信息失败", error as any);
      throw error;
    }
  }

  async placeOrder(params: {
    contract: string;
    size: number;
    price?: number;
    tif?: string;
    reduceOnly?: boolean;
  }): Promise<OrderSummary> {
    const { contract, size } = params;
    if (!size || !Number.isFinite(size)) {
      throw new Error("订单数量无效");
    }

    const info = await this.ensureContractInfo(contract);
    const symbol = contractToSymbol(contract);

    const side = size > 0 ? "BUY" : "SELL";
    const absUnits = Math.abs(Math.round(size));
    const quantity = absUnits * info.stepSize;

    if (absUnits < info.orderSizeMin) {
      throw new Error(
        `订单数量 ${absUnits} 小于最小限制 ${info.orderSizeMin}`
      );
    }

    const minNotional = info.minNotional;
    const price = params.price && params.price > 0 ? params.price : undefined;

    if (!price) {
      // For market order, approximate notional using mark price
      const ticker = await this.getFuturesTicker(contract);
      const mark = safeParseFloat(ticker.markPrice, 0);
      if (mark > 0 && quantity * mark < minNotional) {
        throw new Error(
          `下单金额 ${quantity * mark} 小于最小名义金额 ${minNotional}`
        );
      }
    }

    const orderType = price ? "LIMIT" : "MARKET";
    const priceToUse =
      price !== undefined
        ? formatNumber(
            floorToStep(price, info.tickSize),
            precisionFromStep(info.tickSize)
          )
        : undefined;

    const timeInForce =
      orderType === "LIMIT"
        ? (params.tif || "gtc").toUpperCase()
        : undefined;

    const payload: Record<string, string | number> = {
      symbol,
      side,
      type: orderType,
      quantity: formatNumber(
        floorToStep(quantity, info.stepSize),
        info.quantityPrecision
      ),
      newOrderRespType: "RESULT",
    };

    if (priceToUse) {
      payload.price = priceToUse;
    }
    if (timeInForce) {
      payload.timeInForce = timeInForce;
    }
    if (params.reduceOnly) {
      payload.reduceOnly = "true";
    }

    try {
      const result = await this.request<any>(
        "POST",
        "/fapi/v1/order",
        payload,
        { signed: true }
      );
      return this.buildOrderSummary(result, contract, info);
    } catch (error: any) {
      logger.error("下单失败", {
        message: error.message,
        body: error.body,
      });
      throw error;
    }
  }

  async getOrder(id: string): Promise<OrderSummary> {
    const { symbol, orderId } = parseOrderId(id);
    const contract = symbolToContract(symbol);
    const info = await this.ensureContractInfo(contract);
    const result = await this.request<any>(
      "GET",
      "/fapi/v1/order",
      { symbol, orderId },
      { signed: true }
    );
    return this.buildOrderSummary(result, contract, info);
  }

  async cancelOrder(id: string) {
    const { symbol, orderId } = parseOrderId(id);
    const contract = symbolToContract(symbol);
    const info = await this.ensureContractInfo(contract);
    const result = await this.request<any>(
      "DELETE",
      "/fapi/v1/order",
      { symbol, orderId },
      { signed: true }
    );
    return this.buildOrderSummary(result, contract, info);
  }

  async getOpenOrders(contract?: string) {
    const symbol = contract ? contractToSymbol(contract) : undefined;
    const orders = await this.request<any[]>(
      "GET",
      "/fapi/v1/openOrders",
      symbol ? { symbol } : {},
      { signed: true }
    );

    const summaries: OrderSummary[] = [];
    for (const order of orders) {
      const orderContract = symbolToContract(order.symbol);
      const info = await this.ensureContractInfo(orderContract);
      summaries.push(await this.buildOrderSummary(order, orderContract, info));
    }
    return summaries;
  }

  async setLeverage(contract: string, leverage: number) {
    const symbol = contractToSymbol(contract);
    try {
      const result = await this.request<any>(
        "POST",
        "/fapi/v1/leverage",
        { symbol, leverage },
        { signed: true }
      );
      return result;
    } catch (error) {
      logger.warn(`设置 ${contract} 杠杆失败`, error as any);
      return null;
    }
  }

  async getFundingRate(contract: string) {
    const symbol = contractToSymbol(contract);
    const result = await this.request<any[]>("GET", "/fapi/v1/fundingRate", {
      symbol,
      limit: 1,
    });
    return result?.[0];
  }

  async getContractInfo(contract: string): Promise<ContractInfo> {
    return this.ensureContractInfo(contract);
  }

  async getOrderBook(contract: string, limit: number = 10) {
    const symbol = contractToSymbol(contract);
    const depth = await this.request<any>("GET", "/fapi/v1/depth", {
      symbol,
      limit,
    });
    return {
      bids: depth.bids ?? [],
      asks: depth.asks ?? [],
      lastUpdateId: depth.lastUpdateId,
    };
  }
}

let binanceClientInstance: BinanceClient | null = null;

export function createBinanceClient(): BinanceClient {
  if (binanceClientInstance) {
    return binanceClientInstance;
  }

  const apiKey =
    process.env.BINANCE_API_KEY ||
    process.env.GATE_API_KEY || // backward compatibility
    "";
  const apiSecret =
    process.env.BINANCE_API_SECRET ||
    process.env.GATE_API_SECRET ||
    "";
  const useTestnet =
    process.env.BINANCE_USE_TESTNET === "true" ||
    process.env.GATE_USE_TESTNET === "true";

  if (!apiKey || !apiSecret) {
    throw new Error(
      "BINANCE_API_KEY 和 BINANCE_API_SECRET 必须在环境变量中设置"
    );
  }

  binanceClientInstance = new BinanceClient(apiKey, apiSecret, useTestnet);
  return binanceClientInstance;
}

export function resetBinanceClient() {
  binanceClientInstance = null;
}
