/**
 * Deprecated gateClient.ts shim.
 *
 * The project has migrated to Binance Futures. This file re-exports
 * the new Binance client APIs to maintain backward compatibility with
 * existing imports. Prefer using `createBinanceClient` directly.
 */

export {
  BinanceClient as GateClient,
  createBinanceClient as createGateClient,
  createBinanceClient,
  resetBinanceClient as resetGateClient,
  resetBinanceClient,
} from "./binanceClient";
