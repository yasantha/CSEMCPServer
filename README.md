# CSE MCP Server

MCP server for Colombo Stock Exchange public API endpoints documented in `res/API_REFERENCE.md`.

## Tools Implemented

- `scan_market`
- `get_sectors`
- `get_market_status`
- `get_market_summary`
- `get_top_gainers`
- `get_order_book`
- `get_stock_snapshot`
- `get_chart_data`
- `get_detailed_trades`
- `get_company_profile`
- `tradingView`
- `financials`
- `get_financial_reports`
- `get_noncompliance_list`

## Requirements

- Node.js 18+ (Node 20+ recommended)

## Install

```bash
npm install
```

## Run

```bash
npm start
```

The server uses stdio transport and is intended to be launched by an MCP client.

## Run With MCP Inspector

1. Install dependencies:

```bash
npm install
```

2. Start MCP Inspector and attach this server:

```bash
npx @modelcontextprotocol/inspector node src/index.js
```

3. In Inspector, open the `Tools` tab and click `List Tools`.

4. Run a quick smoke test:
   - `get_market_status` with `{}`  
   - `get_sectors` with `{}`  
   - `get_top_gainers` with `{}`

5. For symbol-based tools, try:
   - `get_stock_snapshot` with `{"symbol":"JKH.N0000"}`
   - `get_order_book` with `{"symbol":"JKH.N0000"}`

6. Stop inspector/server with `Ctrl + C` in the terminal.

## Example MCP Client Config

```json
{
  "mcpServers": {
    "cse": {
      "command": "node",
      "args": ["/absolute/path/to/CSEMCPServer/src/index.js"]
    }
  }
}
```

## Optional Environment Variables

- `CSE_API_BASE_URL` (default: `https://www.cse.lk/api`)
- `CSE_USER_AGENT`
- `CSE_ORIGIN`
- `CSE_REFERER`

## Notes

- Implements 30-second cache for:
  - `tradeSummary`
  - `allSectors`
  - `dailyMarketSummery`
  - `topGainers`
- Converts numeric-looking strings (including comma-separated values) to numbers.
- Resolves `symbol -> stockId` via `tradeSummary` for tools that accept either `symbol` or `stockId`.
