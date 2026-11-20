import assert from "node:assert/strict";
import test from "node:test";
import {
  loadPublicShopCatalog, PUBLIC_SHOP_RETRY_MESSAGE, type PublicShopProduct,
} from "./public-shop-catalog";

const product: PublicShopProduct = {
  id: 4,
  name: "Basket",
  description: null,
  unit: "piece",
  sellingPriceZmw: "20.00",
};

test("shop catalog retries request fresh products and a fresh challenge", async () => {
  const challenges = ["challenge-first", "challenge-retry"];
  const requestOptions: RequestInit[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    requestOptions.push(init ?? {});
    return new Response(JSON.stringify({
      products: [product],
      challenge: challenges.shift(),
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  assert.deepEqual(await loadPublicShopCatalog(fetcher), {
    products: [product],
    challenge: "challenge-first",
  });
  assert.deepEqual(await loadPublicShopCatalog(fetcher), {
    products: [product],
    challenge: "challenge-retry",
  });
  assert.deepEqual(requestOptions, [
    { cache: "no-store" },
    { cache: "no-store" },
  ]);
});

test("shop catalog retry failures keep the safe temporary-unavailable message", async () => {
  const fetcher: typeof fetch = async () => new Response(
    JSON.stringify({ error: "internal storage details" }),
    { status: 503, headers: { "content-type": "application/json" } },
  );

  await assert.rejects(
    loadPublicShopCatalog(fetcher),
    { message: PUBLIC_SHOP_RETRY_MESSAGE },
  );
});

test("shop catalog rejects successful responses without a fresh challenge safely", async () => {
  const fetcher: typeof fetch = async () => new Response(
    JSON.stringify({ products: [product] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  await assert.rejects(
    loadPublicShopCatalog(fetcher),
    { message: PUBLIC_SHOP_RETRY_MESSAGE },
  );
});
