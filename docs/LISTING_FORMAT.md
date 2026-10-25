# Fixed-price market posts

Use one product per seller-authored Discord message. Run `/listing-format` for a private, copyable guide. The buyer opens **Apps → Request a Deal** on that message, chooses one advertised payment method, and enters a product quantity. DealBot calculates the total from the post; the buyer never enters a price or payment unit.

## Copyable template

```text
Item: Menace Cape
Money: $2.00
Golds: 33
Redblocks: 20 stacks
Sky 1 Notchs: 20
```

Delete any payment-method line you do not accept. Every remaining price is the cost of **one product**, and the methods are alternatives rather than exchange rates. At least one payment method is required.

For Golds only:

```text
Item: Menace Cape
Golds: 33
```

For Money only:

```text
Item: Menace Cape
Money: $2.00
```

These are illustrative prices, not market valuations.

## Format rules

- Use exactly one `Item:` line and one line for each accepted payment method. Labels are case-insensitive; the spelling and spaces shown above avoid mistakes.
- Use one product name, from 1 to 200 characters, without mentions or control characters. Do not include multiple products or price ranges in one message.
- Use positive numeric prices without thousands separators. `Money` is US dollars, optionally prefixed with `$`, with at most two decimal places.
- Use whole numbers for `Golds`, `Redblocks`, and `Sky 1 Notchs`. Omit the unit for individual items, or append `stacks` for groups of 64. `stack` and `each` are also accepted.
- Do not repeat a payment label. Do not add other fields, commentary, emojis, or Markdown decoration to the listing text. Blank lines are allowed. You may wrap the entire listing in one plain code block or a code block tagged `deal`.
- Images may accompany the formatted message, but prices must appear in the message text. Image-only posts, embed-only prices, and bot-authored posts cannot supply fixed listing terms.

The bot rejects unclear or unsupported text and shows format guidance. It does not guess prices from images, surrounding conversation, discounts, or crossed-out prices.

## Product quantity and payment units

The buyer chooses a whole product quantity from **1 to 999**. The seller's unit price and payment unit stay fixed:

| Advertised price for one product | Product quantity | Calculated total |
| --- | --- | --- |
| `Golds: 33` | 1 | 33 Golds |
| `Golds: 33` | 2 | 66 Golds |
| `Money: $2.00` | 2 | $4.00 |
| `Redblocks: 20 stacks` | 2 | 40 stacks of Redblocks, or 2,560 blocks |

The chosen quantity is the number of products being purchased. A payment stack always contains 64 items of the chosen game currency. DealBot does not convert one payment method into another. A calculated total must remain within the bot's existing payment limits: at most $9,999,999,999.99 for Money, or 9,999,999,999 individual game items after stack multiplication.

## Changes, expiry, and seller review

The private selection is bound to the buyer and server and expires after 15 minutes. It is stored in SQLite, so restarting the bot does not reset the binding or expiry. A submitted request rechecks access to the source channel and membership in a private source thread. Editing or deleting the listing invalidates an open selection; the buyer must reopen **Request a Deal** to see the current terms.

Once the deal request has been created, its source reference, product quantity, unit price, and total are recorded. Later edits to the listing do not change those agreed request terms. The seller still reviews and accepts or declines each request. This feature does not track available inventory or reserve stock, so a quantity within the allowed range does not prove that the seller can fulfill it.

## Manual negotiated offers

`/deal` is still available for a price negotiated directly with a seller. It accepts a manually entered total payment and does **not** enforce any market post's prices. If your server requires published prices for every purchase, tell buyers to use **Request a Deal** and sellers to review or decline manual offers that do not match the post.

Fixed pricing controls what the buyer can request through the listing flow. DealBot does not hold money, verify payments, guarantee delivery, or replace the seller's own payment and stock checks.
