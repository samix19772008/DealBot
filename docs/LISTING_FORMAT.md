# Market posts, products, and packs

Keep the sales pitch in your Discord post. Clear headings, Markdown, custom emojis, mentions, and several products in one seller-authored message are supported. Buyers use **Apps → Request a Deal** to choose a detected product or pack, one of its payment methods, and a quantity. DealBot calculates the total from that offer; the buyer does not enter a replacement price.

Use `/help` for the short buying guide. On your own post, open **Apps → Preview Listing** to privately review the products, prices, pack sizes, stock, and warnings that were detected. The preview reads the current post, does not create a deal, and has pages of five products.

## Separate products with alternative prices

Descriptions and Discord decoration may surround clear product sections. For example:

```text
# Special Rank
- Money: 22$
- Golds: 5.32 Stack
- Redblocks: 135 Stack
- Sky1 Notchs: 2.16 Stack

# Emerald Rank
- Money: 5.5$
- Golds: 1.20 Stack
- Redblocks: 40 Stack
- Sky1 Notchs: 35

Open a ticket to buy!
```

Special Rank and Emerald Rank are separate choices. Their prices are not shared. Keep only the payment lines you accept for each product. These are separate alternatives, not currency exchange rates. The prices here are examples, not market valuations.

Discord custom currency emojis such as the server's `Money`, `gold`, `RedBlock`, `redstone_dust`, and `Sky1_Notch` can identify their corresponding supported payment methods. `redstone_dust` is recognized as Redblocks; it does not add another currency. Custom emoji names may also identify product headings, such as a bow or golden apple. Message, channel, role, and emoji IDs are never used as prices. Marketing mentions are not repeated as notifications by the bot.

## Packs and variants remain distinct

```text
# Bow
- Punch II = 9 Sky1 Notchs
- Punch I = 4 Sky1 Notchs

# Unbreaking II
- 3 Books = 2 Sky1 Notchs
- 9 Books = 5 Sky1 Notchs
Stock: 26
```

Each line is a separate offer. The buyer chooses between Punch I and Punch II, or between the 3-book and 9-book packs. Buying two packs of the 9-book offer means **18 books for 10 Sky 1 Notchs**. The 3-book pack's price is not substituted.

Explicit book, potion, stew, rod, XP, and golden-apple quantities are recognized in supported pack offers. An offer such as `90 Xp = 1 Sky1 Notchs` is distinct from `180 Xp = 2 Sky1 Notchs`. A bare quantity under a recognized Golden Apple heading can identify an apple pack. The deal records the detected offer and its source link. New requests also save the original message text locally in SQLite, preserving marketing descriptions and enchantment details for later review without sending the post to an external parsing service.

The buyer selects a whole number of products or packs from **1 to 999**. Positive advertised stock does not change this quantity limit or prove that the seller can fulfill the order.

## Shared armour-set prices

A seller can describe each component and its stock before giving prices for the complete set:

```text
# Selling Redpvp Armour Sets
# <:Helm:1460422629465919539>
- Protection IV and Unbreaking III
Stock: 86
# <:Chest:1460422475291562090>
- Protection IV and Unbreaking III
Stock: 56
# <:Leggings:1460422360988520610>
- Protection IV and Unbreaking III
Stock: 76
# <:boot:1460422694922096875>
- Protection IV, Unbreaking III, and Depth Strider III
Stock: 45
# <:diamond_sword:1135755525997482044>
- Sharpness IV, FireAspect II, and no knockback
Stock: 43
# Prices
- 1 Set : 32 <:redstone_dust:691841117012099164>
- 10 Sets : 4 <:gold:1416700594428575865>
```

These shared prices produce two offers under Redpvp Armour Sets: **1 Set for 32 Redblocks** and **10 Sets for 4 Golds**. Buying two of the 10-set offer means 20 sets for 8 Golds. Component stock is not carried into these offers or converted into a complete-set count; the seller must verify fulfillment. Decorative Prices or arrow headings do not become the product name. Use Preview Listing to check the detected packs before accepting orders.

## Stack notation

A game payment stack contains **64 items**. In post prices, the digits after a dot are a count of leftover items, not a decimal fraction of a stack:

| Post price | Exact payment for one offer |
| --- | --- |
| `Golds: 5.32 Stack` | 5 × 64 + 32 = 352 Golds |
| `Golds: 1.20 Stack` | 1 × 64 + 20 = 84 Golds |
| `Golds: 1.2 Stack` | 1 × 64 + 2 = 66 Golds |
| `Sky1 Notchs: 2.16 Stack` | 2 × 64 + 16 = 144 Sky 1 Notchs |
| `Redblocks: 20 stacks` | 20 stacks = 1,280 Redblocks |

Leftover counts must be from 0 to 63. For example, `1.64 Stack` is rejected rather than interpreted or rounded. Dot notation applies only when a game price explicitly says `Stack` or `stacks`. Game prices without stacks must be whole item counts. Money is USD and uses normal decimals, so `5.5$` means $5.50.

The calculated total must remain within the existing payment limits: at most $9,999,999,999.99 for Money, or 9,999,999,999 individual game items after stack multiplication. DealBot does not convert one payment method into another.

## Stock and source changes

`Stock: 0` blocks requests for offers in that section. Positive stock is displayed as advertised information. The bot does not reserve or decrement stock, infer inventory units, or guarantee availability. Sellers must check their inventory before accepting. Keep stock lines with the relevant product section so they are not associated with another section.

The buyer's selection is bound to their account and server, stored in SQLite, and expires after 15 minutes. Source access and private-thread membership are rechecked before a request is created. Editing or deleting the source post invalidates an open selection; buyers must reopen **Request a Deal** to review current terms.

Created requests retain the selected product, pack size, quantity, unit price, total, advertised stock, and source reference. Later edits do not rewrite those saved request terms. Existing version 1.4 single-product selections and old deal records remain compatible.

## Optional simple template

The earlier template still works when you want a short post, but decorated posts do not have to use it:

```text
Item: Menace Cape
Money: $2.00
Golds: 33
Redblocks: 20 stacks
Sky 1 Notchs: 20
```

Delete payment lines you do not accept. With only `Item: Menace Cape` and `Golds: 33`, the buyer sees Golds only; quantity 2 costs 66 Golds.

## Detection limits and review

Detection runs locally and does not require an external AI service or API key. It recognizes clear supported text relationships; it cannot reliably interpret every possible sentence, discount, or layout. Unclear or contradictory prices are omitted with warnings, and a post with no clear offers is rejected. Review **Preview Listing** and clarify the relevant price in the source when necessary. Give separate product sections distinct names, or use nested headings for different parent products. A crossed-out old price, repeated indistinguishable product names, multiple competing prices for one method, or a price range is not a reason for the bot to guess a cheaper amount.

Prices must appear in message text. Images can accompany the post, but image-only prices, embed-only prices, and bot-authored posts do not supply automatic request terms. Up to 100 detected products and 10,000 text characters are supported; detected product names are limited to 200 characters. Buyer menus paginate rather than losing offers beyond Discord's menu limit.

## Start and track a request

Use **Apps → Request a Deal** on the seller's post. `/deal` now opens a simple guide with **My Deals**; it has no manual seller or price options. The buyer selects only from the detected offers. After acceptance, follow the private conversation buttons, and use My Deals to open or hide an eligible active conversation.

DealBot records the request, conversation, and participant confirmations. It does not hold funds, verify payments, guarantee delivery, or replace the seller's payment and inventory checks.
