# Private eufy after-sales data contract

The runtime accepts one private, hash-valid JSON file through
`FIXAGENT_AFTER_SALES_DATA_FILE`. Do not put production data in this repository.
The Case worker gives the file path only to the deterministic MCP host and adds
that path to the Agent sandbox deny-read list.

The file uses `fixagent.after-sales-data.v0` and contains:

- `data_status`: `PROVIDED_REDACTED` for approved supplied data or `SIMULATED`
  only for test fixtures;
- `products`: manufacturer, brand, category, model, SKU, aliases, and
  disambiguation terms;
- `orders`: order number, SKU, quantity, amount/currency, purchase date,
  warranty expiry date, address, status, carrier, tracking number, ship date,
  country, and seller;
- `authorized_dealers`: exact ISO country, canonical seller name, and aliases;
- `content_hash`: SHA-256 of the canonicalized object without `content_hash`.

The Agent receives only masked order output. A screenshot is recorded as
unverified evidence until an order tool confirms it. Dealer authorization uses
exact country plus deterministic seller-name similarity. Repair, parts,
replacement, and refund requests produce a hash-verified draft and a simulated
pending-human-confirmation record; no production action is executed.

