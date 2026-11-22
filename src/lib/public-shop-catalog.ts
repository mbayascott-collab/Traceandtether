export type PublicShopProduct = {
  id: number;
  name: string;
  description: string | null;
  imageUrl: string | null;
  unit: string;
  sellingPriceZmw: string;
};

export const PUBLIC_SHOP_RETRY_MESSAGE = "The shop is temporarily unavailable. Please try again shortly.";

export async function loadPublicShopCatalog(fetcher: typeof fetch = fetch) {
  try {
    const response = await fetcher("/api/shop/products", { cache: "no-store" });
    const data = await response.json() as { products?: unknown; challenge?: unknown };
    if (
      !response.ok
      || !Array.isArray(data.products)
      || typeof data.challenge !== "string"
      || !data.challenge
    ) {
      throw new Error(PUBLIC_SHOP_RETRY_MESSAGE);
    }
    return {
      products: data.products as PublicShopProduct[],
      challenge: data.challenge,
    };
  } catch {
    throw new Error(PUBLIC_SHOP_RETRY_MESSAGE);
  }
}
