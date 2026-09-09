/**
 * ============================================================================
 * PROPRIETARY SCORING ENGINE - SERVER SIDE ONLY
 * ============================================================================
 *
 * This module is the product. It holds every fitted coefficient, confidence
 * band, bucket boundary and advisory threshold that used to ship inside the
 * extension bundle where any user could read it from chrome://extensions.
 *
 * Nothing in this file may ever be imported by, inlined into, or reimplemented
 * in the extension or the admin dashboard. The extension sends observable
 * facts scraped from an Amazon page (rank, price, review count, badge units,
 * variation count) and renders whatever numbers come back. It cannot reproduce
 * them on its own, because the mapping from those facts to units and revenue
 * lives only here.
 *
 * Ported verbatim from the V29 client build so results are numerically
 * identical to what users see today:
 *   - dashboard.js estimate()          -> estimateItem()
 *   - dashboard.js opportunityChart()  -> opportunityScore()
 *   - dashboard.js analyze handler     -> analyzeMarket()
 *   - brand-dashboard aggregate()      -> aggregateBrands()
 *   - brand-dashboard renderOurBrand()  -> brandAdvisories()
 */

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------

/**
 * V19 log-linear demand models.
 *
 * Two fits: one for listings carrying an Amazon "bought in past month" badge
 * (whose stated minimum is a strong direct signal, hence the dominant 0.863
 * weight on it and the near-zero weight on rank), and one for listings without
 * it (where sales rank has to carry the estimate alone, at -0.288).
 */
const V19_BADGE = {
  intercept: 2.637617154,
  lnRank: -0.01072047,
  ln1pReviews: -0.13099998,
  ln1pBadge: 0.86298248,
  lnPrice: -0.19508055,
  lnFamily: 0.1185108,
} as const;

const V19_NO_BADGE = {
  intercept: 6.424250557,
  lnRank: -0.28777473,
  ln1pReviews: 0.23086161,
  lnPrice: -0.42218872,
  lnFamily: -0.70887953,
} as const;

/**
 * Confidence bands around the midpoint. The badge model is tighter because a
 * stated badge minimum anchors the low end; the no-badge model has to allow
 * for rank volatility in both directions.
 */
const BANDS = {
  badge: { low: 0.68, high: 1.45, confidence: "Medium" },
  noBadge: { low: 0.40, high: 2.10, confidence: "Low" },
} as const;

/**
 * Observed rank-to-monthly-units calibration pairs retained from the V19 fit.
 * Kept server side as reference data for future refits.
 */
export const CALIBRATION: ReadonlyArray<readonly [number, number]> = [
  [500, 803],
  [724, 611],
  [1000, 482],
  [2000, 268],
  [5000, 107],
  [10000, 54],
];

/** Multi-pack detection. A "12 pack" listing sells a twelfth of the units. */
const PACK_PATTERNS: RegExp[] = [
  /(\d[\d,]*)\s*(?:pack|pk)\b/g,
  /pack of\s*(\d[\d,]*)/g,
  /case pack(?: of)?\s*(\d[\d,]*)/g,
  /(\d[\d,]*)\s*sets?\b/g,
  /(\d[\d,]*)\s*binders?\b/g,
];

/** Bucket boundaries for the analysis dashboards. */
const PRICE_BANDS = [
  { label: "Under $25", max: 25 },
  { label: "$25-$50", max: 50 },
  { label: "$50-$100", max: 100 },
  { label: "$100-$200", max: 200 },
  { label: "$200+", max: Infinity },
] as const;

const UNIT_BANDS = [
  { label: "100-500", max: 500 },
  { label: "500-1K", max: 1000 },
  { label: "1K-2K", max: 2000 },
  { label: "2K-5K", max: 5000 },
  { label: "5K+", max: Infinity },
] as const;

const RANK_BANDS = [
  { label: "Top 100", max: 100 },
  { label: "101-500", max: 500 },
  { label: "501-1K", max: 1000 },
  { label: "1K-5K", max: 5000 },
  { label: "5K+", max: Infinity },
] as const;

/** Thresholds behind the competitive advisories on the brand dashboard. */
const ADVISORY = {
  /** Share gap below which we call the brand level with the leader. */
  shareGapTolerance: 0.02,
  /** Average price above this multiple of market is "premium". */
  premiumPriceMultiple: 1.20,
  /** Average price below this multiple of market is "underpriced". */
  lowPriceMultiple: 0.80,
  /** Rating deficit that counts as a real gap rather than noise. */
  ratingGapTolerance: 0.2,
  /** Revenue share above this multiple of review share means a thin moat. */
  thinMoatShareMultiple: 1.5,
  /** ...but only while absolute review volume is still small. */
  thinMoatReviewCeiling: 500,
  /** Leader ASIN count above this multiple of ours is an assortment gap. */
  assortmentGapMultiple: 2,
  /** FBA/AMZ unit coverage below this is a fulfilment risk. */
  fbaShareFloor: 0.7,
  /** Default "big brand" cut-off when the client sends none. */
  defaultBigThreshold: 0.05,
} as const;

/** Top-N brands shown individually before the rest collapse into "Other". */
const BRAND_SHARE_TOP_N = 6;
const TOP_LIST_LIMIT = 10;
const OPPORTUNITY_LIMIT = 50;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Matches the client's original num(): strips commas, takes the first run of
 * digits, returns null when there is nothing numeric. Kept bug-compatible so
 * estimates do not shift for existing users.
 */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = String(value ?? "").replace(/,/g, "").match(/[\d.]+/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function numOr(value: unknown, fallback: number): number {
  const parsed = num(value);
  return parsed === null ? fallback : parsed;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function packQuantity(item: RawItem): number {
  const text = `${item.name ?? ""} ${item.selectedVariation ?? ""}`.toLowerCase();
  const found: number[] = [];

  for (const pattern of PACK_PATTERNS) {
    // Patterns are module-level and /g, so lastIndex must be reset per use or
    // consecutive items would resume mid-string from the previous match.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      found.push(Number(match[1].replace(/,/g, "")));
    }
  }

  const usable = found.filter((v) => v > 0 && v < 1000);
  return usable.length ? Math.max(1, ...usable) : 1;
}

function bucket<T extends { readonly label: string; readonly max: number }>(
  bands: ReadonlyArray<T>,
  value: number,
): string {
  for (const band of bands) {
    if (value < band.max) return band.label;
  }
  return bands[bands.length - 1].label;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the extension is allowed to send: observable facts, nothing derived. */
export interface RawItem {
  asin?: string;
  name?: string;
  brand?: string;
  rank?: unknown;
  rankCategory?: string;
  subcategoryRank?: unknown;
  rankedSubcategory?: string;
  priceNumber?: unknown;
  price?: unknown;
  reviewCount?: unknown;
  review?: unknown;
  amazonBadgeMinimumUnits?: unknown;
  variationCount?: unknown;
  familySize?: unknown;
  parentAsin?: string;
  selectedVariation?: string;
  sponsored?: boolean;
  fulfillment?: string;
  seller?: string;
  buyBoxSeller?: string;
  itemLink?: string;
  imageLink?: string;
  [key: string]: unknown;
}

export interface ScoredItem {
  asin: string;
  rankNumber: number | null;
  reviewCountNumber: number;
  amazonBadgeMinimumUnits: number;
  priceNumber: number | null;
  packQuantity: number;
  familyKey: string;
  familySize: number;
  bsrEstimatedUnitsLow: number | "";
  bsrEstimatedUnitsMid: number | "";
  bsrEstimatedUnitsHigh: number | "";
  bsrEstimatedRevenueLow: number | "";
  bsrEstimatedRevenueMid: number | "";
  bsrEstimatedRevenueHigh: number | "";
  estimatedRevenue: number | "";
  estimateModel: string;
  estimateConfidence: string;
  estimateReason: string;
  opportunityScore: number;
}

// ---------------------------------------------------------------------------
// Per-item estimation
// ---------------------------------------------------------------------------

/**
 * Estimates monthly units and revenue for one listing.
 *
 * Rank and price are both required: without either, the model has no anchor
 * and we return an explicit "insufficient data" result rather than a
 * confident-looking guess.
 */
export function estimateItem(item: RawItem): ScoredItem {
  const rank = num(item.rank);
  const reviews = numOr(item.reviewCount, 0);
  const badge = numOr(item.amazonBadgeMinimumUnits, 0);
  const price = num(item.priceNumber) ?? num(item.price);
  const family = Math.max(
    1,
    num(item.variationCount) ?? num(item.familySize) ?? 1,
  );

  const asin = String(item.asin ?? "").toUpperCase();

  const base = {
    asin,
    rankNumber: rank,
    reviewCountNumber: reviews,
    amazonBadgeMinimumUnits: badge,
    priceNumber: price,
    packQuantity: packQuantity(item),
    familyKey: String(item.parentAsin || item.asin || ""),
    familySize: family,
  };

  if (!rank || !price) {
    return {
      ...base,
      bsrEstimatedUnitsLow: "",
      bsrEstimatedUnitsMid: "",
      bsrEstimatedUnitsHigh: "",
      bsrEstimatedRevenueLow: "",
      bsrEstimatedRevenueMid: "",
      bsrEstimatedRevenueHigh: "",
      estimatedRevenue: "",
      estimateModel: "V19 insufficient data",
      estimateConfidence: "None",
      estimateReason: !rank ? "Missing Main Rank" : "Missing Current Price",
      opportunityScore: 0,
    };
  }

  let units: number;
  let model: string;
  let band: typeof BANDS.badge | typeof BANDS.noBadge;

  if (badge > 0) {
    const c = V19_BADGE;
    units = Math.exp(
      c.intercept +
        c.lnRank * Math.log(rank) +
        c.ln1pReviews * Math.log1p(reviews) +
        c.ln1pBadge * Math.log1p(badge) +
        c.lnPrice * Math.log(price) +
        c.lnFamily * Math.log(family),
    );
    model = "V19 child badge model";
    band = BANDS.badge;
  } else {
    const c = V19_NO_BADGE;
    units = Math.exp(
      c.intercept +
        c.lnRank * Math.log(rank) +
        c.ln1pReviews * Math.log1p(reviews) +
        c.lnPrice * Math.log(price) +
        c.lnFamily * Math.log(family),
    );
    model = "V19 child no-badge model";
    band = BANDS.noBadge;
  }

  const unitsLow = Math.max(1, Math.round(units * band.low));
  const unitsMid = Math.max(1, Math.round(units));
  const unitsHigh = Math.round(units * band.high);

  return {
    ...base,
    bsrEstimatedUnitsLow: unitsLow,
    bsrEstimatedUnitsMid: unitsMid,
    bsrEstimatedUnitsHigh: unitsHigh,
    bsrEstimatedRevenueLow: round2(unitsLow * price),
    bsrEstimatedRevenueMid: round2(unitsMid * price),
    bsrEstimatedRevenueHigh: round2(unitsHigh * price),
    estimatedRevenue: round2(unitsMid * price),
    estimateModel: model,
    estimateConfidence: band.confidence,
    estimateReason:
      "Validated V19 Mid; child-level estimate; weekly rank retained for analysis",
    opportunityScore: opportunityScore(unitsMid, reviews),
  };
}

/**
 * Research Opportunity Score: demand per unit of review moat.
 *
 * High means a listing sells well without many reviews defending it, which is
 * the profile of a market a new entrant can take. Reviews floor at 1 so a
 * zero-review listing scores rather than dividing by zero.
 */
export function opportunityScore(units: number, reviews: number): number {
  return round2(units / (reviews || 1));
}

/**
 * Estimates a batch, de-duplicating by ASIN the way the client's
 * applyFamilyEstimates() did: first occurrence of an ASIN wins.
 */
export function estimateBatch(items: RawItem[]): ScoredItem[] {
  const byAsin = new Map<string, ScoredItem>();

  for (const item of items) {
    const key = String(item.asin ?? "").toUpperCase();
    if (!key || byAsin.has(key)) continue;
    byAsin.set(key, estimateItem(item));
  }

  return [...byAsin.values()];
}

// ---------------------------------------------------------------------------
// Market analysis (Deep Search dashboard)
// ---------------------------------------------------------------------------

export interface MarketAnalysis {
  kpis: Record<string, number | string>;
  charts: {
    priceBands: Record<string, number>;
    unitBands: Record<string, number>;
    ratings: Record<string, number>;
    rankBandValue: Record<string, number>;
    brandShare: Record<string, number>;
    brandValue: Array<[string, number]>;
    categories: Array<[string, number]>;
  };
  opportunities: Array<{
    asin: string;
    name: string;
    brand: string;
    opportunityScore: number;
    estimatedUnits: number;
    reviewCount: number;
    itemLink: string;
  }>;
}

/**
 * Builds every KPI and chart series for the analysis dashboard from a scored
 * batch. The client receives finished numbers and only draws them.
 */
export function analyzeMarket(
  raw: RawItem[],
  scored: ScoredItem[],
): MarketAnalysis {
  const rawByAsin = new Map(
    raw.map((r) => [String(r.asin ?? "").toUpperCase(), r]),
  );

  const brandCounts: Record<string, number> = {};
  const brandValue: Record<string, number> = {};
  const categories: Record<string, number> = {};

  const priceBands: Record<string, number> = {};
  const unitBands: Record<string, number> = {};
  const rankBandValue: Record<string, number> = {};
  const ratings: Record<string, number> = {
    "5 Stars": 0,
    "4 Stars": 0,
    "3 Stars": 0,
    "2 Stars": 0,
    "1 Star": 0,
  };

  for (const b of PRICE_BANDS) priceBands[b.label] = 0;
  for (const b of UNIT_BANDS) unitBands[b.label] = 0;
  for (const b of RANK_BANDS) rankBandValue[b.label] = 0;

  let totalUnits = 0;
  let totalValue = 0;
  let priceSum = 0;
  let reviewSum = 0;
  let sponsoredCount = 0;

  for (const item of scored) {
    const source = rawByAsin.get(item.asin) ?? {};

    const brand = String(source.brand ?? "").trim() || "Unknown";
    const revenue = Number(item.bsrEstimatedRevenueMid) || 0;
    const units = Number(item.bsrEstimatedUnitsMid) || 0;
    const price = item.priceNumber ?? 0;

    brandCounts[brand] = (brandCounts[brand] ?? 0) + 1;
    brandValue[brand] = (brandValue[brand] ?? 0) + revenue;

    const category = String(source.rankCategory ?? "").trim() || "Unknown";
    categories[category] = (categories[category] ?? 0) + 1;

    unitBands[bucket(UNIT_BANDS, units)] += 1;
    priceBands[bucket(PRICE_BANDS, price)] += 1;
    rankBandValue[bucket(RANK_BANDS, item.rankNumber ?? 999999)] += revenue;

    // parseFloat-then-round, matching the client: 4.5 lands in "5 Stars".
    const stars = Math.round(numOr(source.review, 0));
    const label = `${stars || 1} Star${stars === 1 || !stars ? "" : "s"}`;
    if (label in ratings) ratings[label] += 1;

    totalUnits += units;
    totalValue += revenue;
    priceSum += price;
    reviewSum += item.reviewCountNumber;
    if (source.sponsored) sponsoredCount += 1;
  }

  const count = scored.length || 1;

  // Top brands by value, with the long tail collapsed into a single slice.
  const sortedBrandValue = Object.entries(brandValue).sort((a, b) => b[1] - a[1]);
  const brandShare: Record<string, number> = Object.fromEntries(
    sortedBrandValue.slice(0, BRAND_SHARE_TOP_N),
  );
  const otherValue = sortedBrandValue
    .slice(BRAND_SHARE_TOP_N)
    .reduce((sum, [, v]) => sum + v, 0);
  if (otherValue > 0) brandShare.Other = otherValue;

  const opportunities = scored
    .filter((x) => x.opportunityScore > 0)
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
    .slice(0, OPPORTUNITY_LIMIT)
    .map((x) => {
      const source = rawByAsin.get(x.asin) ?? {};
      return {
        asin: x.asin,
        name: String(source.name ?? ""),
        brand: String(source.brand ?? ""),
        opportunityScore: x.opportunityScore,
        estimatedUnits: Number(x.bsrEstimatedUnitsMid) || 0,
        reviewCount: x.reviewCountNumber,
        itemLink: String(source.itemLink ?? ""),
      };
    });

  return {
    kpis: {
      totalProducts: scored.length,
      averagePrice: round2(priceSum / count),
      estimatedMarketValue: Math.round(totalValue),
      monthlyUnits: Math.round(totalUnits),
      averageReviews: Math.round(reviewSum / count),
      sponsoredPercent: round2((sponsoredCount / count) * 100),
      uniqueBrands: Object.keys(brandCounts).length,
    },
    charts: {
      priceBands,
      unitBands,
      ratings,
      rankBandValue,
      brandShare,
      brandValue: sortedBrandValue.slice(0, TOP_LIST_LIMIT),
      categories: Object.entries(categories)
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_LIST_LIMIT),
    },
    opportunities,
  };
}

// ---------------------------------------------------------------------------
// Brand market share (Market Intelligence dashboard)
// ---------------------------------------------------------------------------

export interface BrandRow {
  brand: string;
  brandKey: string;
  revenue: number;
  units: number;
  asinCount: number;
  share: number;
  avgPrice: number;
  avgRating: number;
  avgBsr: number;
  reviews: number;
  fbaShare: number;
  sponsoredRows: number;
  topAsin: string;
}

export interface BrandAnalysis {
  total: number;
  brands: BrandRow[];
  kpis: {
    totalRevenue: number;
    totalUnits: number;
    brandCount: number;
    bigBrandCount: number;
    asinCount: number;
    topBrand: string;
    topBrandShare: number;
    topBrandRevenue: number;
    top3Share: number;
    hhi: number;
    concentration: string;
  };
  advisories: Array<{ tone: "good" | "warn" | "bad"; title: string; message: string }>;
  insights: Array<{ title: string; message: string }>;
}

function brandKey(brand: unknown): string {
  return String(brand ?? "").replace(/\s+/g, " ").trim().toLowerCase() || "unknown";
}

function brandName(brand: unknown): string {
  const text = String(brand ?? "").trim() || "Unknown";
  // Short names are acronyms far more often than words: "3M", "LG", "HP".
  return text.length <= 4
    ? text.toUpperCase()
    : text.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

/**
 * Aggregates listing rows into per-brand competitive metrics.
 *
 * Average rating is review-weighted where possible: a 5.0 from two reviews
 * should not offset a 4.2 from nine hundred. It falls back to an unweighted
 * mean only when no row carries both a rating and a review count.
 */
export function aggregateBrands(rows: RawItem[]): {
  total: number;
  brands: BrandRow[];
} {
  interface Acc {
    brand: string;
    revenue: number;
    units: number;
    asins: Set<string>;
    rows: number;
    priceSum: number;
    priceN: number;
    ratingWeighted: number;
    ratingWeight: number;
    ratingSum: number;
    ratingN: number;
    reviews: number;
    bsrSum: number;
    bsrN: number;
    topAsin: string;
    topRevenue: number;
    fbaUnits: number;
    amzUnits: number;
    sponsoredRows: number;
  }

  const map = new Map<string, Acc>();
  let total = 0;

  for (const row of rows) {
    const revenue = numOr(row.estimatedRevenue ?? row.bsrEstimatedRevenueMid ?? row.revenue, 0);
    const units = numOr(row.estimatedUnits ?? row.bsrEstimatedUnitsMid ?? row.units, 0);
    total += revenue;

    const key = brandKey(row.brand);
    let acc = map.get(key);
    if (!acc) {
      acc = {
        brand: brandName(row.brand),
        revenue: 0,
        units: 0,
        asins: new Set(),
        rows: 0,
        priceSum: 0,
        priceN: 0,
        ratingWeighted: 0,
        ratingWeight: 0,
        ratingSum: 0,
        ratingN: 0,
        reviews: 0,
        bsrSum: 0,
        bsrN: 0,
        topAsin: "",
        topRevenue: -1,
        fbaUnits: 0,
        amzUnits: 0,
        sponsoredRows: 0,
      };
      map.set(key, acc);
    }

    acc.revenue += revenue;
    acc.units += units;
    acc.rows += 1;

    const asin = String(row.asin ?? "").trim();
    if (asin) acc.asins.add(asin);

    const price = numOr(row.priceNumber ?? row.price, 0);
    if (price > 0) {
      acc.priceSum += price;
      acc.priceN += 1;
    }

    const rating = numOr(row.review ?? row.rating, 0);
    const reviews = numOr(row.reviewCount, 0);
    if (rating > 0 && reviews > 0) {
      acc.ratingWeighted += rating * reviews;
      acc.ratingWeight += reviews;
    }
    if (rating > 0) {
      acc.ratingSum += rating;
      acc.ratingN += 1;
    }
    acc.reviews += reviews;

    const bsr = numOr(row.rank ?? row.bsr, 0);
    if (bsr > 0) {
      acc.bsrSum += bsr;
      acc.bsrN += 1;
    }

    const fulfillment = String(row.fulfillment ?? "").trim().toUpperCase();
    if (fulfillment === "FBA") acc.fbaUnits += units;
    if (fulfillment === "AMZ") acc.amzUnits += units;

    if (row.sponsored === true || String(row.sponsored ?? "").toLowerCase() === "yes") {
      acc.sponsoredRows += 1;
    }

    if (revenue > acc.topRevenue) {
      acc.topRevenue = revenue;
      acc.topAsin = asin;
    }
  }

  const brands: BrandRow[] = [...map.entries()]
    .map(([key, a]) => ({
      brand: a.brand,
      brandKey: key,
      revenue: round2(a.revenue),
      units: Math.round(a.units),
      asinCount: a.asins.size || a.rows,
      share: total > 0 ? a.revenue / total : 0,
      avgPrice: a.priceN ? round2(a.priceSum / a.priceN) : 0,
      avgRating: a.ratingWeight
        ? round2(a.ratingWeighted / a.ratingWeight)
        : (a.ratingN ? round2(a.ratingSum / a.ratingN) : 0),
      avgBsr: a.bsrN ? Math.round(a.bsrSum / a.bsrN) : 0,
      reviews: a.reviews,
      fbaShare: a.units > 0 ? (a.fbaUnits + a.amzUnits) / a.units : 0,
      sponsoredRows: a.sponsoredRows,
      topAsin: a.topAsin,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return { total: round2(total), brands };
}

/**
 * Competitive advisories comparing one brand against its market.
 *
 * Each rule fires either a warning or its "you are fine" counterpart, so the
 * panel always renders a complete checklist rather than an empty state.
 */
export function brandAdvisories(
  brands: BrandRow[],
  ourBrandKey: string | null,
): BrandAnalysis["advisories"] {
  const out: BrandAnalysis["advisories"] = [];
  if (!ourBrandKey) return out;

  const ours = brands.find((b) => b.brandKey === ourBrandKey);
  if (!ours) return out;

  const leader = brands[0] ?? ours;

  // Market baselines: unweighted mean price across brands, review-weighted
  // mean rating, and total reviews for share-of-voice.
  let priceSum = 0;
  let priceN = 0;
  let ratingWeighted = 0;
  let ratingWeight = 0;
  let totalReviews = 0;

  for (const b of brands) {
    if (b.avgPrice > 0) {
      priceSum += b.avgPrice;
      priceN += 1;
    }
    if (b.avgRating > 0 && b.reviews > 0) {
      ratingWeighted += b.avgRating * b.reviews;
      ratingWeight += b.reviews;
    }
    totalReviews += b.reviews;
  }

  const marketPrice = priceN ? priceSum / priceN : 0;
  const marketRating = ratingWeight ? ratingWeighted / ratingWeight : 0;

  const money = (v: number) =>
    v.toLocaleString("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });
  const percent = (v: number) =>
    v.toLocaleString("en-CA", { style: "percent", maximumFractionDigits: 1 });

  // 1. Share against the leader
  const shareGap = leader.share - ours.share;
  if (leader.brandKey !== ours.brandKey && shareGap > ADVISORY.shareGapTolerance) {
    out.push({
      tone: "warn",
      title: "Share gap vs. leader",
      message:
        `Leader is ${leader.brand} at ${percent(leader.share)}. Our Brand trails by ` +
        `${percent(shareGap)}. Review top ASIN content, pricing, and assortment depth.`,
    });
  } else {
    out.push({
      tone: "good",
      title: "Share position",
      message: "Our Brand is at or near the category leader based on selected revenue.",
    });
  }

  // 2. Price position
  if (
    marketPrice &&
    ours.avgPrice > marketPrice * ADVISORY.premiumPriceMultiple &&
    ours.avgRating < marketRating
  ) {
    out.push({
      tone: "bad",
      title: "Premium price without rating support",
      message:
        `Average price is ${money(ours.avgPrice)} vs market average ${money(marketPrice)}, ` +
        `while rating is below/near market. Consider value messaging, promo tests, or review quality improvement.`,
    });
  } else if (marketPrice && ours.avgPrice < marketPrice * ADVISORY.lowPriceMultiple) {
    out.push({
      tone: "warn",
      title: "Low price position",
      message:
        "Average price is materially below market. Check margin, bundle strategy, and whether a higher-value pack could lift revenue share.",
    });
  } else {
    out.push({
      tone: "good",
      title: "Price position",
      message: "Average price is within a reasonable range of market average.",
    });
  }

  // 3. Rating
  if (marketRating && ours.avgRating + ADVISORY.ratingGapTolerance < marketRating) {
    out.push({
      tone: "bad",
      title: "Rating gap",
      message:
        `Our Brand rating is ${ours.avgRating.toFixed(2)} vs market ${marketRating.toFixed(2)}. ` +
        `Prioritize review drivers: product quality, images, instructions, and post-purchase support.`,
    });
  } else {
    out.push({
      tone: "good",
      title: "Rating health",
      message: "Rating is competitive with the market.",
    });
  }

  // 4. Review moat
  const reviewShare = totalReviews > 0 ? ours.reviews / totalReviews : 0;
  if (
    ours.share > reviewShare * ADVISORY.thinMoatShareMultiple &&
    ours.reviews < ADVISORY.thinMoatReviewCeiling
  ) {
    out.push({
      tone: "warn",
      title: "Review moat is thin",
      message:
        "Revenue share is higher than review share. Competitors may be harder to displace unless review volume grows.",
    });
  } else {
    out.push({
      tone: "good",
      title: "Review base",
      message: "Review base looks aligned with current share.",
    });
  }

  // 5. Assortment
  if (
    leader.brandKey !== ours.brandKey &&
    leader.asinCount > ours.asinCount * ADVISORY.assortmentGapMultiple
  ) {
    out.push({
      tone: "warn",
      title: "Assortment gap",
      message:
        `Top brand has ${leader.asinCount} ASINs vs Our Brand ${ours.asinCount}. ` +
        `Consider coverage gaps in size, colour, pack count, or finish.`,
    });
  } else {
    out.push({
      tone: "good",
      title: "Portfolio coverage",
      message: "ASIN count is not materially behind the leader.",
    });
  }

  // 6. Fulfilment
  if (ours.fbaShare < ADVISORY.fbaShareFloor) {
    out.push({
      tone: "warn",
      title: "Fulfillment mix",
      message:
        `Less than ${Math.round(ADVISORY.fbaShareFloor * 100)}% of Our Brand units are FBA/AMZ in current data. ` +
        `Prime/FBA availability may be limiting conversion.`,
    });
  } else {
    out.push({
      tone: "good",
      title: "Fulfillment readiness",
      message: "FBA/AMZ coverage looks healthy.",
    });
  }

  // 7. Paid visibility
  if (ours.sponsoredRows === 0) {
    out.push({
      tone: "warn",
      title: "Sponsored visibility missing",
      message:
        "No sponsored rows detected for Our Brand in the current data. Check whether paid visibility is needed for defensive or growth keywords.",
    });
  } else {
    out.push({
      tone: "good",
      title: "Sponsored presence",
      message: "Sponsored rows are present for Our Brand in the current data.",
    });
  }

  return out;
}

/**
 * Herfindahl-Hirschman Index over brand revenue share.
 *
 * Sum of squared percentage shares. Standard antitrust reading: under 1500 is
 * competitive, 1500-2500 moderately concentrated, above 2500 concentrated.
 */
export function herfindahl(brands: BrandRow[]): number {
  return brands.reduce((sum, b) => sum + Math.pow(b.share * 100, 2), 0);
}

function concentrationLabel(hhi: number): string {
  if (hhi < 1500) return "Competitive";
  if (hhi < 2500) return "Moderately concentrated";
  return "Highly concentrated";
}

/** Full brand-share payload: aggregates, KPIs, advisories and insights. */
export function analyzeBrands(
  rows: RawItem[],
  ourBrand: string | null,
  bigThreshold: number = ADVISORY.defaultBigThreshold,
): BrandAnalysis {
  const { total, brands } = aggregateBrands(rows);
  const ourKey = ourBrand ? brandKey(ourBrand) : null;

  const threshold = Number.isFinite(bigThreshold) && bigThreshold > 0
    ? bigThreshold
    : ADVISORY.defaultBigThreshold;

  const bigBrands = brands.filter((b) => b.share >= threshold && b.revenue > 0);
  const top = brands[0];
  const top3Share = brands.slice(0, 3).reduce((s, b) => s + b.share, 0);
  const hhi = herfindahl(brands);

  const totalUnits = brands.reduce((s, b) => s + b.units, 0);
  const asinCount = brands.reduce((s, b) => s + b.asinCount, 0);

  const percent = (v: number) =>
    v.toLocaleString("en-CA", { style: "percent", maximumFractionDigits: 1 });
  const money = (v: number) =>
    v.toLocaleString("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });

  const insights: BrandAnalysis["insights"] = [];
  if (top) {
    insights.push({
      title: "Market leader",
      message:
        `${top.brand} leads with ${percent(top.share)} share, representing ${money(top.revenue)}.`,
    });
  }

  const ours = ourKey ? brands.find((b) => b.brandKey === ourKey) : undefined;
  if (ours) {
    insights.push({
      title: "Our Brand position",
      message:
        `${ours.brand} ranks #${brands.indexOf(ours) + 1} with ${percent(ours.share)} share ` +
        `and ${money(ours.revenue)} revenue.`,
    });
  }

  insights.push({
    title: "Concentration",
    message:
      `Top 3 brands account for ${percent(top3Share)} of selected revenue. ` +
      `${bigBrands.length} brands qualify as big brands at the current threshold. ` +
      `HHI ${Math.round(hhi)} (${concentrationLabel(hhi).toLowerCase()}).`,
  });

  const otherShare = Math.max(0, 1 - bigBrands.reduce((s, b) => s + b.share, 0));
  insights.push({
    title: "Other Brand opportunity",
    message:
      `Brands below the threshold represent ${percent(otherShare)} of revenue. ` +
      `This fragmentation can be targeted through SEO, pricing, bundle strategy and review-building.`,
  });

  return {
    total,
    brands,
    kpis: {
      totalRevenue: total,
      totalUnits,
      brandCount: brands.length,
      bigBrandCount: bigBrands.length,
      asinCount,
      topBrand: top?.brand ?? "-",
      topBrandShare: top?.share ?? 0,
      topBrandRevenue: top?.revenue ?? 0,
      top3Share,
      hhi: Math.round(hhi),
      concentration: concentrationLabel(hhi),
    },
    advisories: brandAdvisories(brands, ourKey),
    insights,
  };
}
