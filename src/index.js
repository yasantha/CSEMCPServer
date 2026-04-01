import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.CSE_API_BASE_URL || "https://www.cse.lk/api";
const CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = Number(process.env.CSE_REQUEST_TIMEOUT_MS || 15_000);

const DEFAULT_HEADERS = {
  "User-Agent":
    process.env.CSE_USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Origin: process.env.CSE_ORIGIN || "https://www.cse.lk",
  Referer: process.env.CSE_REFERER || "https://www.cse.lk/",
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json, text/plain, */*"
};

const cache = new Map();

const cachedEndpoints = new Set([
  "tradeSummary",
  "allSectors",
  "dailyMarketSummery",
  "topGainers"
]);

function parseMaybeNumber(value) {
  if (typeof value !== "string") return value;
  const normalized = value.replace(/,/g, "").trim();
  if (!normalized) return value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : value;
}

function normalizeNumbers(input, keyPath = "") {
  const numericFieldPattern =
    /(price|open|high|low|last|close|change|changepercent|volume|turnover|pe|pb|flow|value|qty|quantity|amount|total|id)$/i;

  if (Array.isArray(input)) {
    return input.map((item, index) => normalizeNumbers(item, `${keyPath}[${index}]`));
  }
  if (input && typeof input === "object") {
    const normalized = {};
    for (const [key, value] of Object.entries(input)) {
      const nextPath = keyPath ? `${keyPath}.${key}` : key;
      normalized[key] = normalizeNumbers(value, nextPath);
    }
    return normalized;
  }

  if (typeof input !== "string") return input;
  const keyName = keyPath.split(".").at(-1) || "";
  if (!numericFieldPattern.test(keyName)) return input;
  return parseMaybeNumber(input);
}

function getCacheKey(endpoint, bodyObj) {
  const sorted = Object.keys(bodyObj)
    .sort()
    .reduce((acc, key) => {
      acc[key] = bodyObj[key];
      return acc;
    }, {});
  return `${endpoint}:${JSON.stringify(sorted)}`;
}

async function csePost(endpoint, bodyObj = {}) {
  const cacheKey = getCacheKey(endpoint, bodyObj);
  const useCache = cachedEndpoints.has(endpoint);
  const now = Date.now();

  if (useCache && cache.has(cacheKey)) {
    const hit = cache.get(cacheKey);
    if (now - hit.timestamp < CACHE_TTL_MS) {
      return hit.data;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${BASE_URL}/${endpoint}`, {
      method: "POST",
      headers: DEFAULT_HEADERS,
      body: new URLSearchParams(
        Object.entries(bodyObj)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, String(value)])
      ),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        `CSE API timeout for ${endpoint} after ${REQUEST_TIMEOUT_MS}ms`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `CSE API error for ${endpoint}: HTTP ${response.status}${body ? ` - ${body.slice(0, 300)}` : ""}`
    );
  }

  const raw = await response.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    const contentType = response.headers.get("content-type") || "unknown";
    throw new Error(
      `CSE API returned non-JSON payload for ${endpoint} (content-type: ${contentType}): ${raw.slice(0, 300)}`
    );
  }
  const normalized = normalizeNumbers(json);

  if (useCache) {
    cache.set(cacheKey, {
      timestamp: now,
      data: normalized
    });
  }

  return normalized;
}

async function getTradeSummary() {
  const data = await csePost("tradeSummary");
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.reqTradeSummery)) return data.reqTradeSummery;
  if (Array.isArray(data?.reqTradeSummary)) return data.reqTradeSummary;
  throw new Error("tradeSummary response did not include stock list");
}

async function resolveStockId({ stockId, symbol }) {
  if (stockId !== undefined && stockId !== null) return Number(stockId);
  if (!symbol) {
    throw new Error("Provide either stockId or symbol");
  }
  const summary = await getTradeSummary();
  const match = summary.find(
    (item) => String(item?.symbol || "").toUpperCase() === symbol.toUpperCase()
  );
  if (!match || match.id === undefined || match.id === null) {
    throw new Error(`Could not resolve stockId for symbol ${symbol}`);
  }
  return Number(match.id);
}

function asText(result) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ]
  };
}

const server = new McpServer({
  name: "cse-mcp-server",
  version: "0.1.0"
});

server.tool(
  "scan_market",
  "Returns all listed companies with current trading data from tradeSummary.",
  {
    symbol_filter: z.string().optional(),
    limit: z.number().int().positive().max(500).optional()
  },
  async ({ symbol_filter, limit }) => {
    const list = await getTradeSummary();
    let data = list;

    if (symbol_filter) {
      const q = symbol_filter.toUpperCase();
      data = data.filter((item) => String(item.symbol || "").toUpperCase().includes(q));
    }

    if (limit) {
      data = data.slice(0, limit);
    }

    return asText({ count: data.length, data });
  }
);

server.tool(
  "get_sectors",
  "Returns performance data for all sectors.",
  {},
  async () => asText(await csePost("allSectors"))
);

server.tool(
  "get_market_status",
  "Returns current market status (OPEN/CLOSED/SUSPENDED).",
  {},
  async () => asText(await csePost("marketStatus"))
);

server.tool(
  "get_market_summary",
  "Returns daily market summary metrics.",
  {},
  async () => asText(await csePost("dailyMarketSummery"))
);

server.tool(
  "get_top_gainers",
  "Returns top gaining stocks for the day.",
  {
    limit: z.number().int().positive().max(100).optional()
  },
  async ({ limit }) => {
    const rows = await csePost("topGainers");
    const out = Array.isArray(rows) ? rows.slice(0, limit || rows.length) : rows;
    return asText(out);
  }
);

server.tool(
  "get_order_book",
  "Returns bid/ask depth for a stock. Accepts stockId or symbol.",
  {
    stockId: z.number().int().positive().optional(),
    symbol: z.string().optional()
  },
  async ({ stockId, symbol }) => {
    const id = await resolveStockId({ stockId, symbol });
    return asText(await csePost("orderBook", { stockId: id }));
  }
);

server.tool(
  "get_stock_snapshot",
  "Returns todaySharePrice snapshot for one symbol.",
  {
    symbol: z.string()
  },
  async ({ symbol }) => asText(await csePost("todaySharePrice", { symbol }))
);

server.tool(
  "get_chart_data",
  "Returns historical chart data for a stock. Accepts stockId or symbol.",
  {
    stockId: z.number().int().positive().optional(),
    symbol: z.string().optional(),
    period: z.union([z.enum(["1", "2", "3", "5"]), z.number().int()]).optional()
  },
  async ({ stockId, symbol, period }) => {
    const id = await resolveStockId({ stockId, symbol });
    const normalizedPeriod = period === undefined ? "5" : String(period);
    if (!["1", "2", "3", "5"].includes(normalizedPeriod)) {
      throw new Error("period must be one of: 1, 2, 3, 5");
    }
    return asText(
      await csePost("companyChartDataByStock", {
        stockId: id,
        period: normalizedPeriod
      })
    );
  }
);

server.tool(
  "get_detailed_trades",
  "Returns detailed tick-level trade data. Optional symbol filter.",
  {
    symbol: z.string().optional()
  },
  async ({ symbol }) => asText(await csePost("detailedTrades", { symbol }))
);

server.tool(
  "get_company_profile",
  "Returns company profile and management information for a symbol.",
  {
    symbol: z.string()
  },
  async ({ symbol }) => asText(await csePost("companyProfile", { symbol }))
);

server.tool(
  "get_financial_reports",
  "Returns financial report metadata and CDN URLs for a symbol.",
  {
    symbol: z.string()
  },
  async ({ symbol }) => {
    const payload = await csePost("financials", { symbol });
    const withUrls = {
      ...payload,
      infoQuarterlyData: Array.isArray(payload?.infoQuarterlyData)
        ? payload.infoQuarterlyData.map((row) => ({
            ...row,
            url: row?.path ? `https://cdn.cse.lk/${String(row.path).replace(/^\/+/, "")}` : null
          }))
        : payload?.infoQuarterlyData,
      infoAnnualData: Array.isArray(payload?.infoAnnualData)
        ? payload.infoAnnualData.map((row) => ({
            ...row,
            url: row?.path ? `https://cdn.cse.lk/${String(row.path).replace(/^\/+/, "")}` : null
          }))
        : payload?.infoAnnualData
    };

    return asText(withUrls);
  }
);

server.tool(
  "get_noncompliance_list",
  "Returns non-compliance announcements/watch-list data.",
  {},
  async () => asText(await csePost("getNonComplianceAnnouncements"))
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Failed to start CSE MCP server:", error);
  process.exit(1);
});
